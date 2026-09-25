/* KAM PDFs test suite.
 *
 *   node tests/run.js            run everything
 *   node tests/run.js find text  run only tests whose name contains "find" or "text"
 *
 * Needs Node 18+ and Google Chrome. It serves the project itself, drives headless Chrome
 * over the DevTools protocol, and checks what the app actually produces rather than what it
 * reports. Where it matters, the saved PDF is re-rendered and compared with the screen.
 *
 * If Python with pypdfium2 is available, the form-field test is also checked against PDFium,
 * the engine Chrome and most viewers use. Without it that check is skipped, not failed:
 * a bug once hid precisely because pdf.js was used to grade pdf.js.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), http = require('http'), path = require('path'), os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8791, CDP = 9401;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(p => fs.existsSync(p));

const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.traineddata': 'application/octet-stream' };

/* ---------- tiny test registry ---------- */
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
class Failed extends Error { }
function ok(cond, what) { if (!cond) throw new Failed(what); }
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Failed(`${what}\n      expected ${b}\n      actual   ${a}`);
}
function near(actual, expected, tol, what) {
  if (Math.abs(actual - expected) > tol) throw new Failed(`${what}: expected ~${expected} (±${tol}), got ${actual}`);
}

/* ---------- static server ---------- */
function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rq) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { rq.writeHead(404); return rq.end('no'); }
      rq.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(rq);
    });
    srv.listen(PORT, () => res(srv));
  });
}

/* ---------- chrome over CDP ---------- */
async function browser() {
  const dir = path.join(os.tmpdir(), 'kam-tests-profile');
  fs.rmSync(dir, { recursive: true, force: true });
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=1400,950', `--remote-debugging-port=${CDP}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 60; i++) {
    try {
      targets = await new Promise((res, rej) => http.get(`http://localhost:${CDP}/json`, r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
      }).on('error', rej));
      break;
    } catch (e) { await sleep(250); }
  }
  if (!targets) throw new Error('Chrome did not start');
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {}; const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0]);
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error('page error: ' + (d.exception?.description || d.text || '').split('\n')[0]);
    }
    return r.result.result.value;
  };
  const waitFor = async (expr, ms = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (await evaluate(expr)) return true; } catch (e) { } await sleep(200); }
    throw new Failed('timed out waiting for: ' + expr);
  };
  return {
    evaluate, waitFor, errors,
    reload: async () => {
      errors.length = 0;
      await send('Page.navigate', { url: `http://localhost:${PORT}/index.html?t=${Date.now()}` });
      // every script has run once the last ones (the command search, the viewer) are there
      await waitFor(`typeof state !== 'undefined' && typeof pdfTextEditAt === 'function' && typeof KamSpell !== 'undefined' && typeof KamPalette !== 'undefined' && typeof KamView !== 'undefined'`);
    },
    // Print an HTML page to PDF with Chrome itself, the way "Save as PDF" makes documents:
    // real fonts, embedded as subsets, every letter placed on its own. Returns base64.
    printHtml: async html => {
      const f = path.join(os.tmpdir(), 'kam-test-print.html');
      fs.writeFileSync(f, html);
      await send('Page.navigate', { url: 'file:///' + f.replace(/\\/g, '/') });
      for (let i = 0; i < 80; i++) {
        try { if (await evaluate(`document.readyState === 'complete' && document.fonts.status === 'loaded' && location.protocol === 'file:'`)) break; } catch (e) { }
        await sleep(100);
      }
      const r = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
      return r.result.data;
    },
    close: () => { try { ws.close(); } catch (e) { } proc.kill(); },
  };
}

/* ---------- helpers used by the tests ---------- */
// Build a PDF inside the page and open it. `body` is pdf-lib code with `doc`, `f` (Helvetica),
// `fb` (bold), `ft` (Times) and `rgb` in scope.
const makeDoc = body => `(async () => {
  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const fb = await doc.embedFont(StandardFonts.HelveticaBold);
  const ft = await doc.embedFont(StandardFonts.TimesRoman);
  ${body}
  const b = await doc.save();
  await openBytes(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), 'test.pdf');
  return state.pageIds.length;
})()`;

const settled = `state.pageIds.length > 0 && !state.renderTask`;

// Drag on the page overlay, in display points.
const dragOn = (x1, y1, x2, y2) => `(() => {
  const ov = document.getElementById('overlay'), rc = ov.getBoundingClientRect(), z = state.zoom;
  ov.setPointerCapture = () => {};
  const P = (t,x,y) => new PointerEvent(t, { clientX: rc.left + x*z, clientY: rc.top + y*z, button:0, bubbles:true, pointerId:1 });
  ov.dispatchEvent(P('pointerdown', ${x1}, ${y1}));
  ov.dispatchEvent(P('pointermove', ${(x1 + x2) / 2}, ${(y1 + y2) / 2}));
  ov.dispatchEvent(P('pointermove', ${x2}, ${y2}));
  ov.dispatchEvent(P('pointerup', ${x2}, ${y2}));
  return 1; })()`;

// Export, then render the saved PDF and the screen at the same scale and count differing pixels.
const exportVsScreen = (pageIndex = 0, scale = 2) => `(async () => {
  const bytes = await exportBytes();
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const p2 = await pdf.getPage(${pageIndex + 1}); const vp = p2.getViewport({ scale: ${scale} });
  const A = document.createElement('canvas'); A.width = vp.width; A.height = vp.height;
  await p2.render({ canvasContext: A.getContext('2d'), viewport: vp }).promise;
  const p1 = await state.pdfjs.getPage(${pageIndex + 1});
  const B = document.createElement('canvas'); B.width = vp.width; B.height = vp.height;
  const ctx = B.getContext('2d');
  await p1.render({ canvasContext: ctx, viewport: p1.getViewport({ scale: ${scale} }) }).promise;
  drawAnnots(ctx, state.pageIds[${pageIndex}], ${scale}, null, { spell: false });
  const a = A.getContext('2d').getImageData(0,0,A.width,A.height).data;
  const b = ctx.getImageData(0,0,B.width,B.height).data;
  let bad = 0;
  for (let i = 0; i < a.length; i += 4)
    if (Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2]) > 90) bad++;
  return { differing: bad, total: a.length / 4, bytes: bytes.length };
})()`;

const exportBase64 = `(async () => {
  const bytes = await exportBytes();
  let s = ''; const u = new Uint8Array(bytes), C = 0x8000;
  for (let i = 0; i < u.length; i += C) s += String.fromCharCode.apply(null, u.subarray(i, i + C));
  return btoa(s);
})()`;

// Extract the text of every page of a base64 PDF, using pdf.js in the page.
const textOf = b64 => `(async () => {
  const s = atob(${JSON.stringify(b64)}); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  const pdf = await pdfjsLib.getDocument({ data: u }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    out.push(tc.items.map(x => x.str).join(' ').replace(/\\s+/g, ' ').trim());
  }
  return out;
})()`;

// Type into the line being edited (the hidden input textedit.js uses), then press a key.
const typeInto = (fn, key) => `(() => {
  const t = document.getElementById('phraseInput'); (${fn})(t); t.dispatchEvent(new Event('input'));
  ${key ? `t.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));` : ''}
  return t.value; })()`;

// The fonts page 1 of a base64 PDF draws with, by their PostScript names, sorted.
const fontsOfSaved = b64 => `(async () => {
  const s = atob(${JSON.stringify(b64)}); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  const d = await PDFLib.PDFDocument.load(u);
  const fonts = d.getPage(0).node.Resources().lookup(PDFLib.PDFName.of('Font'));
  return fonts.keys().map(k => fonts.lookup(k).lookup(PDFLib.PDFName.of('BaseFont')).decodeText().replace(/^[A-Z]{6}[+]/, '')).sort();
})()`;

// Page 1 of a saved PDF against the original page, at 2x: how many pixels changed inside a
// box (display points) and outside it, and how many are red inside it in the saved one.
const comparePages = (b64, [x0, y0, x1, y1]) => `(async () => {
  const s = atob(${JSON.stringify(b64)}); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  const saved = await (await pdfjsLib.getDocument({ data: u }).promise).getPage(1);
  const orig = await state.pdfjs.getPage(1);
  const draw = async p => { const vp = p.getViewport({ scale: 2 }); const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); await p.render({ canvasContext: g, viewport: vp }).promise;
    return { d: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height }; };
  const A = await draw(orig), B = await draw(saved);
  let inside = 0, outside = 0, redInside = 0;
  for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
    const i = (y * A.w + x) * 4, inBox = x >= ${x0 * 2} && x <= ${x1 * 2} && y >= ${y0 * 2} && y <= ${y1 * 2};
    if (inBox && B.d[i] > 150 && B.d[i + 1] < 90 && B.d[i + 2] < 90) redInside++;
    if (Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2]) < 30) continue;
    if (inBox) inside++; else outside++;
  }
  return { inside, outside, redInside };
})()`;

// What the screen draws for page 1 (edits included) against the saved file, at 2x.
const screenVsSaved = (b64, pageIndex = 0) => `(async () => {
  const s = atob(${JSON.stringify(b64)}); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  const saved = await (await pdfjsLib.getDocument({ data: u }).promise).getPage(${pageIndex + 1});
  const shown = await KamView.pdfPage(${pageIndex});
  const draw = async p => { const vp = p.getViewport({ scale: 2 }); const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); await p.render({ canvasContext: g, viewport: vp }).promise;
    drawAnnots(g, state.pageIds[${pageIndex}], 2, null, { spell: false, marks: false });
    return g.getImageData(0, 0, c.width, c.height).data; };
  const A = await draw(shown), B = await draw(saved);
  let differing = 0;
  for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 60) differing++;
  return { differing, total: A.length / 4 };
})()`;

// Every stream in a saved PDF, decompressed, as text: for checking something is really gone.
function streamsOf(buf) {
  const zlib = require('zlib'), out = [buf.toString('latin1')];
  for (const m of buf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    try { out.push(zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1')); } catch (e) { }
  }
  return out;
}

/* ---------- the tests ---------- */

test('opens a document and reports its pages', async b => {
  await b.reload();
  const n = await b.evaluate(makeDoc(`
    for (let i = 1; i <= 3; i++) { const p = doc.addPage([595, 842]); p.drawText('Page ' + i, { x: 50, y: 780, size: 20, font: fb }); }`));
  eq(n, 3, 'page count after opening');
  await b.waitFor(settled);
  eq(await b.evaluate(`state.pageIds.length`), 3, 'pages tracked in state');
});

test('page operations reorder, duplicate and delete', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`
    for (let i = 1; i <= 3; i++) { const p = doc.addPage([595, 842]); p.drawText('Page ' + i, { x: 50, y: 780, size: 30, font: fb }); }`));
  await b.waitFor(settled);
  const textOfPage = i => b.evaluate(`state.pdfjs.getPage(${i + 1}).then(p => p.getTextContent()).then(t => t.items.map(x => x.str).join('').trim())`);

  await b.evaluate(`movePage(2, 0)`); await b.waitFor(settled);
  eq(await textOfPage(0), 'Page 3', 'third page moved to the front');

  await b.evaluate(`duplicatePages([0])`); await b.waitFor(`state.pageIds.length === 4`);
  eq(await textOfPage(1), 'Page 3', 'duplicate sits next to its original');

  await b.evaluate(`deletePages([0])`); await b.waitFor(`state.pageIds.length === 3`);
  eq(await b.evaluate(`state.pageIds.length`), 3, 'page removed');

  // pages past the end and unparseable pieces are ignored
  eq(await b.evaluate(`parseRange('1-2, 5, 9-7, junk', 6)`), [0, 1, 4], 'page range parsing');
});

test('every annotation type saves exactly as it looks', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`
    const p = doc.addPage([595, 842]);
    p.drawText('Fidelity check', { x: 50, y: 780, size: 20, font: fb });
    for (let i = 0; i < 8; i++) p.drawText('Body line ' + i, { x: 50, y: 700 - i * 24, size: 12, font: f });`));
  await b.waitFor(settled);
  await b.evaluate(`(() => {
    const id = state.pageIds[0]; const L = state.annots[id] = [];
    const T = (x, y, t, e) => { const a = Object.assign({ id: uid(), type:'text', x, y, w:0, h:0, rot:0, text:t, size:16, font:'Helvetica', bold:false, color:'#e11d48', opacity:1 }, e); measureText(a); return a; };
    L.push(T(60, 120, 'Hello\\nWorld'));
    L.push(T(300, 300, 'Angled', { rot: 25, color: '#15803d' }));
    L.push({ id: uid(), type:'rect', x:60, y:200, w:150, h:60, rot:0, stroke:'#e11d48', fill:null, width:3, opacity:1 });
    L.push({ id: uid(), type:'rect', x:60, y:280, w:200, h:20, rot:0, stroke:null, fill:'#ffff00', width:0, opacity:0.45, blend:'multiply' });
    L.push({ id: uid(), type:'rect', x:60, y:330, w:180, h:18, rot:0, stroke:null, fill:'#ffffff', width:0, opacity:1 });
    L.push({ id: uid(), type:'ellipse', x:320, y:150, w:120, h:80, rot:0, stroke:'#00aa00', fill:'#ccffcc', width:2, opacity:1 });
    L.push({ id: uid(), type:'pen', pts:[[60,400],[90,370],[120,430],[150,380],[190,440]], color:'#ff00ff', width:4, opacity:1 });
    L.push({ id: uid(), type:'arrow', pts:[[300,420],[460,360]], color:'#0000ff', width:3, opacity:1 });
    L.push({ id: uid(), type:'line', pts:[[300,470],[470,470]], color:'#000000', width:2, opacity:1 });
    drawOverlay(); return L.length;
  })()`);
  const r = await b.evaluate(exportVsScreen(0, 2));
  ok(r.differing / r.total < 0.0005, `saved page differs from the screen: ${r.differing} of ${r.total} pixels`);
});

test('marks over a form field survive saving (v1.8.1 regression)', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`
    const p = doc.addPage([420, 300]);
    p.drawText('PLAINTEXT-A', { x: 30, y: 250, size: 16, font: f });
    const form = doc.getForm();
    const tf = form.createTextField('secret'); tf.setText('FIELDTEXT-B');
    tf.addToPage(p, { x: 30, y: 180, width: 220, height: 26 });
    form.updateFieldAppearances();`));
  await b.waitFor(settled);
  eq(await b.evaluate(`state.doc.getForm().getFields().length`), 1, 'document has a form field');

  // whiteout over the plain text only: the field must stay editable
  await b.evaluate(`(() => { const id = state.pageIds[0]; state.annots[id] = [
    { id: uid(), type:'rect', x:25, y:34, w:260, h:26, rot:0, stroke:null, fill:'#ffffff', width:0, opacity:1 }];
    drawOverlay(); return 1; })()`);
  eq(await b.evaluate(`annotsCoverAFormField()`), false, 'a mark away from the field should not force flattening');
  let b64 = await b.evaluate(exportBase64);
  let doc = await b.evaluate(`(async () => { const s = atob(${JSON.stringify(b64)}); const u = new Uint8Array(s.length);
    for (let i=0;i<s.length;i++) u[i]=s.charCodeAt(i);
    const d = await PDFLib.PDFDocument.load(u, { ignoreEncryption: true });
    return d.getForm().getFields().length; })()`);
  eq(doc, 1, 'field kept editable when nothing covers it');

  // now cover the field too: it must be flattened, and its text must not show through
  await b.evaluate(`(() => { curAnnots().push(
    { id: uid(), type:'rect', x:25, y:88, w:260, h:34, rot:0, stroke:null, fill:'#ffffff', width:0, opacity:1 });
    drawOverlay(); return 1; })()`);
  eq(await b.evaluate(`annotsCoverAFormField()`), true, 'covering a field should be detected');
  b64 = await b.evaluate(exportBase64);
  doc = await b.evaluate(`(async () => { const s = atob(${JSON.stringify(b64)}); const u = new Uint8Array(s.length);
    for (let i=0;i<s.length;i++) u[i]=s.charCodeAt(i);
    const d = await PDFLib.PDFDocument.load(u, { ignoreEncryption: true });
    return d.getForm().getFields().length; })()`);
  eq(doc, 0, 'field flattened once it is covered');

  // A whiteout hides, it does not delete: the words are still in the file. That is the
  // documented behaviour, and the reason the Redact tool exists.
  const pages = await b.evaluate(textOf(b64));
  ok(pages[0].includes('FIELDTEXT-B'), 'a whiteout is expected to leave the text extractable');

  // and confirm with a second engine, which is how this bug was found in the first place
  const fium = pdfiumInk(Buffer.from(b64, 'base64'));
  if (fium === null) console.log('      (PDFium check skipped: install pypdfium2 to enable it)');
  else ok(fium === 0, `PDFium still renders ${fium} ink pixels behind the whiteout`);
});

test('existing text is edited in place, in its own font, and the old words are gone', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`
    const p = doc.addPage([595, 842]);
    p.drawText('Quarterly report', { x: 48, y: 746, size: 26, font: fb, color: rgb(0.1,0.1,0.12) });
    p.drawText('Total due: 1,399.20', { x: 48, y: 642, size: 14, font: ft, color: rgb(0.8,0.1,0.1) });`));
  await b.waitFor(settled);
  // the page's own text is read as soon as the page is drawn
  await b.waitFor(`KamContent.cached(0) && KamContent.cached(0).ok`);
  eq(await b.evaluate(`(it => it && it.text)(KamContent.phraseAt(0, 100, 196))`), 'Total due: 1,399.20', 'found the line under the cursor');

  eq(await b.evaluate(`pdfTextEditAt(100, 196)`), true, 'double-click starts editing');
  eq(await b.evaluate(`KamEdit.active()`), true, 'the line is open for typing');
  eq(await b.evaluate(`curAnnots().length`), 0, 'nothing is added until the edit is done');
  await b.evaluate(typeInto(`t => { const k = t.value.indexOf('399'); t.setRangeText('4', k, k + 1, 'end'); }`, 'Enter'));
  eq(await b.evaluate(`KamEdit.active()`), false, 'Enter finishes the edit');
  eq(await b.evaluate(`curAnnots().filter(a => a.type === 'textedit').map(a => [a.src.text, a.text])`),
    [['Total due: 1,399.20', 'Total due: 1,499.20']], 'the edit is recorded against the original line');
  await b.waitFor(settled);

  const b64 = await b.evaluate(exportBase64);
  const pages = await b.evaluate(textOf(b64));
  ok(pages[0].includes('Total due: 1,499.20'), `edited value missing from the saved file: ${pages[0]}`);
  ok(!pages[0].includes('1,399.20'), 'the old value is still in the saved file');
  // every letter was available in the page's own Times, so no other font was brought in
  eq(await b.evaluate(fontsOfSaved(b64)), ['Helvetica-Bold', 'Times-Roman'], 'the saved page uses only its original fonts');

  // Nothing but the changed digit moves: outside the line the saved page is the original,
  // pixel for pixel, and the red is still red.
  const px = await b.evaluate(comparePages(b64, [48, 186, 200, 206]));
  eq(px.outside, 0, 'pixels changed outside the edited line');
  ok(px.inside > 10, `the edited digit should look different, ${px.inside} pixels do`);
  ok(px.redInside > 40, `the edited line lost its colour: ${px.redInside} red pixels`);
  // and the screen shows exactly what was saved
  const scr = await b.evaluate(screenVsSaved(b64));
  ok(scr.differing / scr.total < 0.0002, `the screen and the saved file differ: ${scr.differing} pixels`);
});

test('existing text can be selected, copied and deleted', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`
    const p = doc.addPage([420, 300]);
    p.drawText('First line of the document', { x: 30, y: 250, size: 14, font: f });
    p.drawText('Second line follows below', { x: 30, y: 220, size: 14, font: f });
    p.drawText('Third and final line here', { x: 30, y: 190, size: 14, font: f });`));
  await b.waitFor(settled);
  await b.evaluate(`KamPdfText.index(0)`);
  await b.evaluate(`KamContent.analyse(0).then(() => 1)`);
  await b.evaluate(`setTool('select')`);

  eq(await b.evaluate(`KamPdfText.runsOf(0).map(r => r.text)`),
    ['First line of the document', 'Second line follows below', 'Third and final line here'],
    'lines indexed in reading order');

  await b.evaluate(dragOn(31, 45, 200, 108));
  eq(await b.evaluate(`pdfTextSelectedText()`),
    'First line of the document\nSecond line follows below\nThird and final line here',
    'dragging selects across lines');

  // the clipboard is unavailable in headless Chrome, so check the write path with a stub
  const copied = await b.evaluate(`(async () => {
    const real = navigator.clipboard && navigator.clipboard.writeText;
    let got = null;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: t => { got = t; return Promise.resolve(); } } });
    const okc = await pdfTextCopy();
    if (real) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: real } });
    return JSON.stringify({ okc, got });
  })()`);
  const c = JSON.parse(copied);
  ok(c.okc === true, 'copy reported failure');
  ok(c.got && c.got.startsWith('First line'), 'the wrong text reached the clipboard');

  // click a line, press Delete, and it goes
  await b.evaluate(`pdfTextClearPick(); pdfTextSelect(60, 78); 1`);
  const before = await b.evaluate(`curAnnots().length`);
  eq(await b.evaluate(`pdfTextDeleteSelected()`), true, 'Delete removes the picked line');
  eq(await b.evaluate(`curAnnots().length`), before + 1, 'the deletion is recorded');
});

test('find locates text across pages', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`
    for (let i = 1; i <= 2; i++) {
      const p = doc.addPage([595, 842]);
      p.drawText('The quick brown fox on page ' + i, { x: 48, y: 700, size: 12, font: f });
      p.drawText('Another quick line', { x: 48, y: 660, size: 12, font: f });
    }`));
  await b.waitFor(settled);
  eq(await b.evaluate(`KamPdfText.search('quick').then(m => m.length)`), 4, 'matches found');
  const pagesOf = await b.evaluate(`KamPdfText.search('quick').then(m => m.map(x => x.page))`);
  eq(pagesOf, [0, 0, 1, 1], 'matches ordered by page');
  eq(await b.evaluate(`KamPdfText.search('NOTHINGHERE').then(m => m.length)`), 0, 'unknown text should find nothing');
});

test('a search highlight sits on the word it found, in a proportional font', async b => {
  await b.reload();
  // one drawText per line, so pdf.js reports each line as a single item with a single width
  await b.evaluate(makeDoc(`
    const p = doc.addPage([595, 842]);
    p.drawText('The SpongeBob SquarePants Movie (2004)', { x: 48, y: 700, size: 20, font: fb });
    p.drawText('Wide Ws and thin ils: WWWWWW iiiiii WWWWWW', { x: 48, y: 640, size: 14, font: f });
    window.__fonts = { fb, f };`));
  await b.waitFor(settled);

  // pdf-lib knows the exact glyph widths of the standard fonts, so it is the answer key
  const r = JSON.parse(await b.evaluate(`(async () => {
    await KamPdfText.index(0);
    const out = [];
    for (const [q, font, size] of [['Bob', 'fb', 20], ['(2004)', 'fb', 20], ['iiiiii', 'f', 14], ['WWWWWW', 'f', 14]]) {
      const m = (await KamPdfText.search(q))[0];
      const run = m.run, fnt = window.__fonts[font];
      const want0 = fnt.widthOfTextAtSize(run.text.slice(0, m.start), size);
      const want1 = fnt.widthOfTextAtSize(run.text.slice(0, m.end), size);
      // what the old even-spacing guess gave, so the test can show it would have caught that
      const span = run.u1 - run.u0, even = m.start / run.text.length * span;
      out.push({ q, size, start: KamPdfText.uAt(run, m.start) - run.u0, want0, end: KamPdfText.uAt(run, m.end) - run.u0, want1, even });
    }
    return JSON.stringify(out); })()`));
  // The app measures in whichever sans or serif face the computer has, scaled to pdf.js's line
  // width, while the PDF uses the real Helvetica. Close, not identical, so the allowance is a
  // fraction of the type size: the highlight must sit on the word, not to a hundredth of a point.
  for (const m of r) {
    near(m.start, m.want0, 0.15 * m.size, `highlight for "${m.q}" starts on the word`);
    near(m.end, m.want1, 0.15 * m.size, `highlight for "${m.q}" ends on the word`);
  }
  // and the probe is one the old code fails: spacing characters evenly misses by more than the
  // allowance above, so this test would have caught the bug it exists for
  const probe = r.find(m => m.q === 'iiiiii');
  ok(Math.abs(probe.even - probe.want0) > 0.15 * probe.size,
    `even spacing should miss "iiiiii" by more than the allowance, missed by ${Math.abs(probe.even - probe.want0).toFixed(1)}pt`);
});

test('spell checking flags real mistakes only', async b => {
  await b.reload();
  ok(await b.evaluate(`KamSpell.load()`), 'dictionary failed to load');
  eq(await b.evaluate(`['recieve','seperate','definately','teh','accomodation'].filter(w => !KamSpell.isMisspelled(w))`),
    [], 'these misspellings should all be flagged');
  eq(await b.evaluate(`['receive','separate','colour','licence','organisation','analyse','invoice'].filter(w => KamSpell.isMisspelled(w))`),
    [], 'these correct words should not be flagged');
  eq(await b.evaluate(`['PDF','NHS','2026',"landlord's",'well-known'].filter(w => KamSpell.isMisspelled(w))`),
    [], 'acronyms, numbers, possessives and compounds should be left alone');
  eq(await b.evaluate(`KamSpell.suggest('recieve', 1)`), ['receive'], 'closest correction offered first');
  eq(await b.evaluate(`KamSpell.suggest('definately', 1)`), ['definitely'], 'closest correction offered first');
});

test('redaction removes the text from the file', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`
    const p1 = doc.addPage([420, 300]);
    p1.drawText('KEEPME-TOP heading', { x: 30, y: 250, size: 13, font: f });
    p1.drawText('SECRETNUMBER-303068241', { x: 30, y: 200, size: 13, font: f });
    const p2 = doc.addPage([420, 300]);
    p2.drawText('PAGETWO-UNTOUCHED', { x: 30, y: 250, size: 13, font: f });`));
  await b.waitFor(settled);
  await b.evaluate(`(() => { const id = state.pageIds[0]; state.annots[id] = [
    { id: uid(), type:'rect', x:26, y:86, w:230, h:26, rot:0, stroke:null, fill:'#000000', width:0, opacity:1, redact:true }];
    drawOverlay(); return 1; })()`);

  const b64 = await b.evaluate(exportBase64);
  const pages = await b.evaluate(textOf(b64));
  ok(!pages[0].includes('SECRETNUMBER'), 'redacted text can still be extracted from page 1');
  ok(!pages[0].includes('303068241'), 'redacted number can still be extracted');
  eq(pages[1], 'PAGETWO-UNTOUCHED', 'an untouched page should keep its real text');

  // and it must not survive anywhere in the bytes, compressed or not
  const buf = Buffer.from(b64, 'base64');
  ok(!buf.includes('SECRETNUMBER'), 'secret found in the raw bytes');
  const zlib = require('zlib');
  let leaked = false;
  for (const m of buf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    try {
      const out = zlib.inflateSync(Buffer.from(m[1], 'latin1'));
      if (out.includes('SECRETNUMBER') || out.includes('303068241')) leaked = true;
    } catch (e) { }
  }
  ok(!leaked, 'secret found inside a compressed stream');
});

test('OCR makes a scanned page searchable', async b => {
  await b.reload();
  await b.evaluate(`(async () => {
    const c = document.createElement('canvas'); c.width = 1240; c.height = 400;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0,0,c.width,c.height);
    g.fillStyle = '#111'; g.font = 'bold 54px Arial'; g.fillText('INVOICE NUMBER 4471', 60, 110);
    g.font = '40px Arial'; g.fillText('Payable to Northwind Trading', 60, 220);
    const { PDFDocument } = PDFLib; const doc = await PDFDocument.create();
    const png = await doc.embedPng(await (await fetch(c.toDataURL('image/png'))).arrayBuffer());
    const pg = doc.addPage([620, 200]);
    pg.drawImage(png, { x: 0, y: 0, width: 620, height: 200 });
    const b = await doc.save();
    await openBytes(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), 'scan.pdf');
    return 1;
  })()`);
  await b.waitFor(settled);
  eq(await b.evaluate(`state.pdfjs.getPage(1).then(p => p.getTextContent()).then(t => t.items.length)`), 0, 'a scan should start with no text');

  await b.evaluate(`document.getElementById('btnOcrPage').click(); 1`);
  await b.waitFor(`!document.getElementById('btnOcrPage').disabled && (ocrWordsFor(0).length > 0 || /failed/i.test(document.getElementById('ocrState').textContent))`, 240000);
  const words = await b.evaluate(`ocrWordsFor(0).length`);
  ok(words > 4, `expected several recognised words, got ${words}`);
  const text = await b.evaluate(`ocrTextFor(0)`);
  ok(/INVOICE\s+NUMBER\s+4471/i.test(text), `recognised text reads wrong: ${JSON.stringify(text)}`);
  ok(/Payable\s+to\s+Northwind/i.test(text), `line read out of order: ${JSON.stringify(text)}`);

  await b.evaluate(`KamPdfText.reset()`);
  ok(await b.evaluate(`KamPdfText.search('northwind').then(m => m.length)`) > 0, 'search should find recognised words');

  const b64 = await b.evaluate(exportBase64);
  const pages = await b.evaluate(textOf(b64));
  ok(/Northwind/i.test(pages[0]), `saved scan is not searchable: ${JSON.stringify(pages[0])}`);
});

test('deleting a line removes it but keeps the rest of the page', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`
    const p = doc.addPage([420, 300]);
    p.drawText('DELETEME-secret line', { x: 30, y: 250, size: 14, font: f });   // display y ~50
    p.drawText('KEEPME-first survivor', { x: 30, y: 210, size: 14, font: f });  // display y ~90
    p.drawText('KEEPME-second survivor', { x: 30, y: 170, size: 14, font: f }); // display y ~130`));
  await b.waitFor(settled);
  await b.evaluate(`KamPdfText.index(0)`);
  await b.evaluate(`KamContent.analyse(0).then(() => 1)`);
  await b.evaluate(`setTool('select')`);

  eq(await b.evaluate(`(r => r && r.text)(KamPdfText.runAt(0, 60, 46))`), 'DELETEME-secret line', 'found the line to delete');
  await b.evaluate(`pdfTextSelect(60, 46)`);
  eq(await b.evaluate(`pdfTextDeleteSelected()`), true, 'Delete should remove the picked line');

  // it must not offer itself again: this is what made deleting feel endless
  eq(await b.evaluate(`pdfTextSelect(60, 46)`), false, 'a deleted line should not be selectable again');
  eq(await b.evaluate(`pdfTextDeleteSelected()`), false, 'a deleted line should not be deletable twice');
  eq(await b.evaluate(`curAnnots().length`), 1, 'covers should not pile up on the same words');
  eq(await b.evaluate(`pdfTextHover(60, 46, true)`), false, 'a deleted line should not light up on hover');

  const b64 = await b.evaluate(exportBase64);
  const pages = await b.evaluate(textOf(b64));
  ok(!pages[0].includes('DELETEME'), 'the deleted words are still in the saved file');
  ok(pages[0].includes('KEEPME-first survivor'), 'the rest of the page lost its text');
  ok(pages[0].includes('KEEPME-second survivor'), 'the rest of the page lost its text');

  // and not hiding in a compressed stream either, as text or as the character codes pdf-lib
  // wrote it with, nor in the page's old content stream left behind unused
  const leaked = streamsOf(Buffer.from(b64, 'base64')).some(t => t.includes('DELETEME') || /44454C4554454D45/i.test(t));
  ok(!leaked, 'deleted words found inside the saved file');
});

test('deleted text vanishes from the page and the file, and comes back with undo', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`
    const p = doc.addPage([420, 300]);
    p.drawRectangle({ x: 20, y: 236, width: 300, height: 30, color: rgb(0.99, 0.91, 0.85) });   // shading behind the line
    p.drawLine({ start: { x: 20, y: 244 }, end: { x: 380, y: 244 }, thickness: 1, color: rgb(0, 0, 0) });   // a rule through it
    p.drawText('DELETEME line', { x: 30, y: 250, size: 14, font: f });
    p.drawText('KEEP this one', { x: 30, y: 200, size: 14, font: f });`));
  await b.waitFor(settled);
  await b.waitFor(`KamContent.cached(0) && KamContent.cached(0).ok`);
  await b.evaluate(`setTool('select')`);
  await b.evaluate(`pdfTextSelect(60, 46)`);
  eq(await b.evaluate(`pdfTextDeleteSelected()`), true, 'the line was deleted');
  eq(await b.evaluate(`curAnnots().map(a => [a.type, a.text])`), [['textedit', '']], 'recorded as a deletion of the words themselves');
  await b.waitFor(settled);
  await b.waitFor(`KamView.canvasSig(0) === KamPatch.sigFor(0)`);

  // The words are taken out of the page, so there is no patch of paper: the shading and the
  // rule behind them are untouched, on screen and in the file.
  const b64 = await b.evaluate(exportBase64);
  const pages = await b.evaluate(textOf(b64));
  ok(!pages[0].includes('DELETEME'), 'the deleted words are still in the file');
  ok(pages[0].includes('KEEP this one'), 'the other line was lost');
  const px = await b.evaluate(comparePages(b64, [26, 36, 140, 56]));
  eq(px.outside, 0, 'pixels changed away from the deleted words');
  const shade = await b.evaluate(`(async () => {
    const s = atob(${JSON.stringify(b64)}); const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    const p = await (await pdfjsLib.getDocument({ data: u }).promise).getPage(1); const vp = p.getViewport({ scale: 2 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; const g = c.getContext('2d');
    await p.render({ canvasContext: g, viewport: vp }).promise;
    const at = (x, y) => Array.from(g.getImageData(x * 2, y * 2, 1, 1).data.slice(0, 3));
    return { shading: at(100, 40), rule: at(100, 56) };
  })()`);
  ok(shade.shading[0] > 240 && shade.shading[2] < 230, `the shading behind the deleted words is gone: ${shade.shading}`);
  ok(shade.rule[0] < 80, `the rule through the deleted words is gone: ${shade.rule}`);
  const scr = await b.evaluate(screenVsSaved(b64));
  ok(scr.differing / scr.total < 0.0002, `the screen and the saved file differ: ${scr.differing} pixels`);

  // listed in Layers, and Ctrl+Z brings the words back
  ok(/Deleted text/.test(await b.evaluate(`document.getElementById('layerList').textContent`)), 'the deletion is listed in Layers');
  await b.evaluate(`undo()`);
  await b.waitFor(`KamView.canvasSig(0) === KamPatch.sigFor(0) && KamPatch.sigFor(0) === ''`);
  eq(await b.evaluate(`KamPdfText.index(0).then(e => e.runs.map(r => r.text))`), ['DELETEME line', 'KEEP this one'], 'undo brings the words back');
});

test('text the engine cannot rewrite is still deleted, the older way', async b => {
  await b.reload();
  // a font chosen through a graphics state (gs) rather than Tf: pdf.js draws it, but the text
  // engine does not rewrite it, so deleting falls back to a redaction patch, marked on screen
  await b.evaluate(`(async () => {
    const { PDFDocument, StandardFonts, PDFNumber } = PDFLib;
    const doc = await PDFDocument.create(), f = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([420, 300]);
    p.drawText('x', { x: -50, y: -50, size: 1, font: f });                 // puts the font in the page resources
    const gsName = p.node.newExtGState('GSF', doc.context.obj({ Type: 'ExtGState', Font: [f.ref, PDFNumber.of(14)] }));
    p.pushOperators(PDFLib.pushGraphicsState(), PDFLib.setGraphicsState(gsName), PDFLib.beginText(),
      PDFLib.moveText(30, 250), PDFLib.showText(f.encodeText('DELETEME line')), PDFLib.endText(), PDFLib.popGraphicsState());
    const bytes = await doc.save();
    await openBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 'gsfont.pdf');
    return 1; })()`);
  await b.waitFor(settled);
  await b.waitFor(`KamContent.cached(0)`);
  await b.evaluate(`KamPdfText.index(0)`);
  await b.evaluate(`setTool('select')`);
  eq(await b.evaluate(`pdfTextSelect(60, 46)`), true, 'the line can be picked');
  eq(await b.evaluate(`pdfTextDeleteSelected()`), true, 'the line was deleted');
  eq(await b.evaluate(`curAnnots().map(a => a.type + (a.redact ? ':redact' : ''))`), ['rect:redact'], 'deleted with a redaction');
  // On white paper a white patch is invisible, which is how a deletion gets clicked and undone
  // by accident. On screen it must be marked; in the file it must not be.
  const diff = await b.evaluate(`(async () => {
    const p = await state.pdfjs.getPage(1); const vp = p.getViewport({ scale: 2 });
    const mk = async marks => {
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      const ctx = c.getContext('2d');
      await p.render({ canvasContext: ctx, viewport: p.getViewport({ scale: 2 }) }).promise;
      drawAnnots(ctx, state.pageIds[0], 2, null, { spell: false, marks });
      return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    const shown = await mk(true), plain = await mk(false);
    let differing = 0;
    for (let i = 0; i < shown.length; i += 4)
      if (Math.abs(shown[i] - plain[i]) + Math.abs(shown[i+1] - plain[i+1]) + Math.abs(shown[i+2] - plain[i+2]) > 40) differing++;
    return differing;
  })()`);
  ok(diff > 200, `a deletion should be clearly marked on screen, only ${diff} pixels differ`);
  const b64 = await b.evaluate(exportBase64);
  const pages = await b.evaluate(textOf(b64));
  ok(!pages[0].includes('DELETEME'), 'the deleted words are still in the file');
});

/* ---------- the text engine: editing a PDF's own words in its own fonts ---------- */

// Open a base64 PDF in the app.
const openBase64 = (b64, name) => `(async () => {
  const s = atob(${JSON.stringify(b64)}); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  await openBytes(u.buffer, ${JSON.stringify(name)}); return state.pageIds.length; })()`;

// Edit a phrase the way the mouse does: double-click near its start, retype it, press Enter.
const editPhrase = (starts, text, page = 0) => `(async () => {
  await KamContent.analyse(${page});
  const it = KamContent.current(${page}).find(c => c.text.startsWith(${JSON.stringify(starts)}));
  if (!it) throw new Error('no phrase starts with ' + ${JSON.stringify(starts)});
  if (state.cur !== ${page}) KamView.setActive(${page});
  const b = it.box, t = b.rot * Math.PI / 180, lx = Math.min(b.w / 2, 4), ly = b.h / 2;
  const x = b.x + lx * Math.cos(t) - ly * Math.sin(t), y = b.y + lx * Math.sin(t) + ly * Math.cos(t);
  if (!(await pdfTextEditAt(x, y))) throw new Error('could not start editing ' + ${JSON.stringify(starts)});
  const ta = document.getElementById('phraseInput');
  ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input'));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await KamView.whenIdle();
  return (state.annots[state.pageIds[${page}]] || []).filter(a => a.type === 'textedit').length;
})()`;

// The boxes (display points) of the phrases starting with these words, before editing.
const boxesOf = starts => `(async () => {
  const an = await KamContent.analyse(0);
  return ${JSON.stringify(starts)}.map(s => { const p = an.phrases.find(p => p.text.startsWith(s)); const b = p.box;
    return [b.x - 2, b.y - 2, b.x + Math.max(b.w, 400) + 2, b.y + b.h + 2]; });
})()`;

// Page 1 of a saved PDF against the original page, at 2x, outside a list of boxes.
const changedOutside = (b64, boxes) => `(async () => {
  const s = atob(${JSON.stringify(b64)}); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  const saved = await (await pdfjsLib.getDocument({ data: u }).promise).getPage(1);
  const orig = await state.pdfjs.getPage(1);
  const draw = async p => { const vp = p.getViewport({ scale: 2 }); const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); await p.render({ canvasContext: g, viewport: vp }).promise;
    return { d: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height }; };
  const A = await draw(orig), B = await draw(saved), boxes = ${JSON.stringify(boxes)};
  let outside = 0;
  for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
    const i = (y * A.w + x) * 4;
    if (Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2]) < 30) continue;
    if (!boxes.some(([x0, y0, x1, y1]) => x >= x0 * 2 && x <= x1 * 2 && y >= y0 * 2 && y <= y1 * 2)) outside++;
  }
  return outside;
})()`;

const INVOICE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 18mm; }
  body { font: 11pt Calibri, Carlito, Arial, sans-serif; color: #111; }
  h1 { font: bold 22pt Cambria, Caladea, Georgia, serif; color: #1f3864; margin: 0 0 8pt; }
  .times { font-family: 'Times New Roman', 'Liberation Serif', serif; }
  .red { color: #c00000; }
  table { border-collapse: collapse; margin-top: 8pt; } td { border: 0.5pt solid #999; padding: 3pt 8pt; }
</style></head><body>
<h1>Quarterly Invoice Summary</h1>
<p>Invoice number: <b>INV-2024-0117</b> &nbsp; Date: 14 March 2024</p>
<p>Total due: <span class="red"><b>£1,399.20</b></span> by 30 April 2024.</p>
<p class="times">Times line: The quick brown fox jumps over the lazy dog.</p>
<table><tr><td>Item</td><td>Qty</td><td>Price</td></tr><tr><td>Widgets</td><td>12</td><td>£96.00</td></tr></table>
</body></html>`;

test('a document printed from a browser is edited in its own fonts, and nothing else moves', async b => {
  const pdf64 = await b.printHtml(INVOICE_HTML);
  await b.reload();
  await b.evaluate(openBase64(pdf64, 'printed.pdf'));
  await b.waitFor(settled);
  const an = await b.evaluate(`KamContent.analyse(0).then(an => ({ ok: an.ok, reason: an.reason, phrases: an.phrases.map(p => p.text) }))`);
  ok(an.ok, 'the printed page could not be read: ' + an.reason);
  ok(an.phrases.includes('Total due: £1,399.20 by 30 April 2024.'), 'a line with a bold red amount is one phrase: ' + JSON.stringify(an.phrases));
  ok(an.phrases.includes('Widgets') && an.phrases.includes('£96.00'), 'table cells are phrases of their own');
  const fontsBefore = await b.evaluate(`(async () => { const d = state.doc; const fonts = d.getPage(0).node.Resources().lookup(PDFLib.PDFName.of('Font'));
    return fonts.keys().map(k => fonts.lookup(k).lookup(PDFLib.PDFName.of('BaseFont')).decodeText().replace(/^[A-Z]{6}[+]/, '')).sort(); })()`);
  const boxes = await b.evaluate(boxesOf(['Total due', 'Times line', '£96.00']));

  eq(await b.evaluate(editPhrase('Total due', 'Total due: £1,499.20 by 30 April 2024.')), 1, 'first edit recorded');
  eq(await b.evaluate(editPhrase('Times line', 'Times line: The very quick brown fox jumps over the lazy dog.')), 2, 'second edit recorded');
  eq(await b.evaluate(editPhrase('£96.00', '')), 3, 'deletion recorded');
  await b.waitFor(settled);

  const saved = await b.evaluate(exportBase64);
  const text = (await b.evaluate(textOf(saved)))[0];
  ok(/Total due: ?£1,499\.20 by 30 April/.test(text), `the new amount reads wrong: ${text}`);
  ok(!text.includes('1,399.20'), 'the old amount is still in the file');
  ok(/The very quick brown fox jumps over the lazy dog/.test(text.replace(/\s+/g, ' ')), `the added word reads wrong: ${text}`);
  ok(!text.includes('96.00') && text.includes('Widgets'), 'the deleted cell is still there, or its row went with it');
  // every new letter was already in the document's fonts, so no font was added
  eq(await b.evaluate(fontsOfSaved(saved)), fontsBefore, 'the saved page uses only its original fonts');
  // nothing moves outside the edited lines: headings, other lines, the table's borders
  eq(await b.evaluate(changedOutside(saved, boxes)), 0, 'pixels changed outside the edited lines');
  const scr = await b.evaluate(screenVsSaved(saved));
  ok(scr.differing / scr.total < 0.0002, `the screen and the saved file differ: ${scr.differing} pixels`);
  // and a second engine reads the same words
  const fium = pdfiumText(Buffer.from(saved, 'base64'));
  if (fium === null) console.log('      (PDFium check skipped: install pypdfium2 to enable it)');
  else {
    ok(/Total due: £1,499\.20 by 30 April 2024\./.test(fium), `PDFium reads the amount wrong: ${fium}`);
    ok(/The very quick brown fox jumps over the lazy dog\./.test(fium), `PDFium reads the line wrong: ${fium}`);
    ok(!fium.includes('1,399.20') && !fium.includes('96.00'), 'PDFium still finds the old words');
  }
});

test('letters the font does not have come from a matching font, and read back correctly', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 200]).drawText('Office: Main Street 12', { x: 30, y: 150, size: 16, font: f });`));
  await b.waitFor(settled);
  // Helvetica as PDFs carry it can only write Western European letters: the rest must come from
  // the bundled font made to Helvetica's measurements
  eq(await b.evaluate(editPhrase('Office', 'Office: ulica Żółta 12, Kraków')), 1, 'edit recorded');
  await b.waitFor(settled);
  const saved = await b.evaluate(exportBase64);
  const text = (await b.evaluate(textOf(saved)))[0];
  ok(text.replace(/\s+/g, ' ').includes('Office: ulica Żółta 12, Kraków'), `the new letters read wrong: ${text}`);
  const fonts = await b.evaluate(fontsOfSaved(saved));
  ok(fonts.includes('Helvetica'), 'the original font was dropped');
  ok(fonts.some(f => /LiberationSans/.test(f)), `no matching font was brought in for the new letters: ${fonts}`);
  const scr = await b.evaluate(screenVsSaved(saved));
  ok(scr.differing / scr.total < 0.0003, `the screen and the saved file differ: ${scr.differing} pixels`);
  const fium = pdfiumText(Buffer.from(saved, 'base64'));
  if (fium !== null) ok(fium.includes('ulica Żółta 12, Kraków'), `PDFium reads the new letters wrong: ${fium}`);
});

test('a line set with kerning, letter and word spacing keeps its spacing when words are added', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`
    const p = doc.addPage([500, 200]);
    const name = p.node.newFontDictionary('F', f.ref);
    const L = PDFLib, T = s => f.encodeText(s);
    p.pushOperators(L.beginText(), L.setFontAndSize(name, 16), L.setCharacterSpacing(0.5), L.setWordSpacing(2),
      L.moveText(40, 120), L.PDFOperator.of(L.PDFOperatorNames.ShowTextAdjusted, [doc.context.obj([T('Hello'), 120, T(' brave new'), -40, T(' world')])]),
      L.endText());`));
  await b.waitFor(settled);
  const before = await b.evaluate(`KamContent.analyse(0).then(an => an.phrases.map(p => [p.text, +p.spaceAdv.toFixed(3)]))`);
  eq(before[0][0], 'Hello brave new world', 'the line is read as one phrase');
  const boxes = await b.evaluate(boxesOf(['Hello']));
  eq(await b.evaluate(editPhrase('Hello', 'Hello brave new big world')), 1, 'edit recorded');
  await b.waitFor(settled);
  const saved = await b.evaluate(exportBase64);
  const text = (await b.evaluate(textOf(saved)))[0].replace(/\s+/g, ' ');
  eq(text, 'Hello brave new big world', 'the words read in order');
  // "Hello brave new " is untouched, and "world" moved along by exactly the room "big " takes:
  // three letters and a space with the line's own letter and word spacing
  const ink = await b.evaluate(`(async () => {
    const s = atob(${JSON.stringify(saved)}); const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    const edges = async p => { const vp = p.getViewport({ scale: 4 }); const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); await p.render({ canvasContext: g, viewport: vp }).promise;
      const d = g.getImageData(0, 0, c.width, c.height).data; let right = 0;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4] < 128 && x > right) right = x;
      return right / 4; };
    return { before: await edges(await state.pdfjs.getPage(1)), after: await edges(await (await pdfjsLib.getDocument({ data: u }).promise).getPage(1)) };
  })()`);
  const f16 = await b.evaluate(`(async () => { const d = await PDFLib.PDFDocument.create(); const f = await d.embedFont(PDFLib.StandardFonts.Helvetica); return f.widthOfTextAtSize('big', 16) + f.widthOfTextAtSize(' ', 16); })()`);
  const want = f16 + 4 * 0.5 + 2;          // 'b' 'i' 'g' ' ' each get 0.5 of letter spacing, the space 2 of word spacing
  near(ink.after - ink.before, want, 0.35, 'the end of the line moved by the width of the added word');
  const px = await b.evaluate(comparePages(saved, [40 + 118, 60, 480, 90]));
  eq(px.outside, 0, '"Hello brave new" should not have moved at all');
});

test('text inside a form object on the page can be edited too', async b => {
  await b.reload();
  await b.evaluate(`(async () => {
    const { PDFDocument, StandardFonts } = PDFLib;
    const src = await PDFDocument.create(), sf = await src.embedFont(StandardFonts.Helvetica);
    src.addPage([400, 200]).drawText('Inside a form object', { x: 30, y: 150, size: 16, font: sf });
    const doc = await PDFDocument.create();
    const [emb] = await doc.embedPdf(await src.save());
    const p = doc.addPage([400, 200]); p.drawPage(emb, { x: 0, y: 0 });
    p.drawPage(emb, { x: 0, y: -80 });                  // drawn twice: only the one edited may change
    const b = await doc.save();
    await openBytes(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), 'form.pdf'); return 1; })()`);
  await b.waitFor(settled);
  eq(await b.evaluate(`KamContent.analyse(0).then(an => an.ok && an.phrases.map(p => p.text))`), ['Inside a form object', 'Inside a form object'], 'both copies are read');
  eq(await b.evaluate(editPhrase('Inside', 'Within a form object')), 1, 'edit recorded');
  await b.waitFor(settled);
  const saved = await b.evaluate(exportBase64);
  const text = (await b.evaluate(textOf(saved)))[0];
  ok(text.includes('Within a form object') && text.includes('Inside a form object'), `one copy should change and the other stay: ${text}`);
  const scr = await b.evaluate(screenVsSaved(saved));
  ok(scr.differing / scr.total < 0.0002, `the screen and the saved file differ: ${scr.differing} pixels`);
});

test('text on a turned page is edited where it is', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`
    const p = doc.addPage([420, 300]);
    p.drawText('Sideways heading', { x: 30, y: 250, size: 18, font: fb });
    p.setRotation(degrees(90));`));
  await b.waitFor(settled);
  eq(await b.evaluate(`KamContent.analyse(0).then(an => an.phrases.map(p => [p.text, Math.round(p.angle)]))`), [['Sideways heading', 90]], 'read along the turned line');
  eq(await b.evaluate(editPhrase('Sideways', 'Sideways title')), 1, 'edit recorded');
  await b.waitFor(settled);
  const saved = await b.evaluate(exportBase64);
  ok((await b.evaluate(textOf(saved)))[0].includes('Sideways title'), 'the edit is in the file');
  const scr = await b.evaluate(screenVsSaved(saved));
  ok(scr.differing / scr.total < 0.0002, `the screen and the saved file differ: ${scr.differing} pixels`);
});

test('text edits can be hidden, retyped, taken back, and survive the window closing', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]).drawText('Account holder: Jane Smith', { x: 30, y: 250, size: 14, font: f });`));
  await b.waitFor(settled);
  eq(await b.evaluate(editPhrase('Account', 'Account holder: Janet Smith')), 1, 'edit recorded');
  const read = `KamPdfText.index(0).then(e => e.runs.map(r => r.text).join('|'))`;
  await b.waitFor(`KamView.canvasSig(0) === KamPatch.sigFor(0)`);
  eq(await b.evaluate(read), 'Account holder: Janet Smith', 'the page reads the new words');

  // hide it in Layers: the original words come back; show it again
  await b.evaluate(`document.querySelector('#layerList .layer-btn[data-act="eye"]').click(); 1`);
  await b.waitFor(`KamView.canvasSig(0) === KamPatch.sigFor(0)`);
  eq(await b.evaluate(read), 'Account holder: Jane Smith', 'hiding an edit shows the original');
  await b.evaluate(`document.querySelector('#layerList .layer-btn[data-act="eye"]').click(); 1`);
  await b.waitFor(`KamView.canvasSig(0) === KamPatch.sigFor(0)`);
  eq(await b.evaluate(read), 'Account holder: Janet Smith', 'showing it again brings the edit back');

  // retyping an edited line changes the same edit, and typing the original back removes it
  eq(await b.evaluate(editPhrase('Account', 'Account holder: Janet Smithson')), 1, 'still one edit');
  eq(await b.evaluate(`curAnnots()[0].text`), 'Account holder: Janet Smithson', 'the edit was updated');

  // the working copy keeps it
  await b.evaluate(`document.getElementById('autosaveOn').checked = true; 1`);
  await b.evaluate(`KamDraft.clear()`);
  await b.evaluate(`noteChange()`);
  await b.waitFor(`KamDraft.get().then(d => !!d && d.annots && d.annots[0] && d.annots[0].length === 1)`, 20000);
  await b.reload();
  await b.waitFor(`!document.getElementById('btnRestoreEmpty').hidden`, 10000);
  await b.evaluate(`document.getElementById('btnRestoreEmpty').click()`);
  await b.waitFor(`!!state.doc && !state.renderTask && curAnnots().length === 1`, 20000);
  await b.waitFor(`KamView.canvasSig(0) === KamPatch.sigFor(0) && KamPatch.sigFor(0) !== ''`);
  eq(await b.evaluate(read), 'Account holder: Janet Smithson', 'the edit came back with the working copy');
  await b.evaluate(`document.getElementById('btnForget').click()`);

  eq(await b.evaluate(editPhrase('Account', 'Account holder: Jane Smith')), 0, 'typing the original back removes the edit');
});

test('layers panel lists, hides, reorders and deletes marks', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]).drawText('Base text', { x: 30, y: 250, size: 14, font: f });`));
  await b.waitFor(settled);
  await b.evaluate(`(() => { const id = state.pageIds[0]; state.annots[id] = [
      { id: uid(), type:'rect', x:25, y:36, w:200, h:24, rot:0, stroke:null, fill:'#ffffff', width:0, opacity:1 },
      Object.assign({ id: uid(), type:'text', x:30, y:40, w:0, h:0, rot:0, text:'On top', size:14, font:'Helvetica', bold:false, color:'#000000', opacity:1 }, {}),
    ]; measureText(state.annots[id][1]); drawOverlay(); refreshLayers(true); return 1; })()`);

  // newest first, matching what sits on top of the page
  eq(await b.evaluate(`[...document.querySelectorAll('#layerList .layer .layer-name b')].map(e => e.textContent)`),
    ['Text', 'Cover'], 'layers listed newest first');

  // hiding a layer takes it off the page and out of the saved file
  await b.evaluate(`[...document.querySelectorAll('#layerList .layer')][0].querySelector('[data-act="eye"]').click()`);
  eq(await b.evaluate(`curAnnots().filter(a => a.hidden).length`), 1, 'layer marked hidden');
  let b64 = await b.evaluate(exportBase64);
  let pages = await b.evaluate(textOf(b64));
  ok(!pages[0].includes('On top'), 'a hidden layer should not be saved');

  // unhide, then send it to the back
  await b.evaluate(`[...document.querySelectorAll('#layerList .layer')][0].querySelector('[data-act="eye"]').click()`);
  eq(await b.evaluate(`curAnnots().filter(a => a.hidden).length`), 0, 'layer shown again');
  await b.evaluate(`[...document.querySelectorAll('#layerList .layer')][0].querySelector('[data-act="down"]').click()`);
  eq(await b.evaluate(`curAnnots().map(a => a.type)`), ['text', 'rect'], 'layer sent behind the cover');
  b64 = await b.evaluate(exportBase64);
  pages = await b.evaluate(textOf(b64));
  ok(pages[0].includes('On top'), 'a visible layer should be saved again');

  // delete it
  await b.evaluate(`[...document.querySelectorAll('#layerList .layer')].find(r => r.textContent.includes('Text')).querySelector('[data-act="del"]').click()`);
  eq(await b.evaluate(`curAnnots().length`), 1, 'layer deleted');
  await b.evaluate(`undo()`);
  eq(await b.evaluate(`curAnnots().length`), 2, 'undo brings a deleted layer back');
});

test('a cover does not block typing over it', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]).drawText('Original line here', { x: 30, y: 250, size: 14, font: f });`));
  await b.waitFor(settled);
  await b.evaluate(`(() => { const id = state.pageIds[0]; state.annots[id] = [
    { id: uid(), type:'rect', x:25, y:36, w:230, h:24, rot:0, stroke:null, fill:'#ffffff', width:0, opacity:1 }];
    drawOverlay(); setTool('select'); return 1; })()`);

  // double-clicking inside the whiteout must give somewhere to type, not be swallowed
  await b.evaluate(`(() => {
    const ov = document.getElementById('overlay'), rc = ov.getBoundingClientRect(), z = state.zoom;
    ov.dispatchEvent(new MouseEvent('dblclick', { clientX: rc.left + 200*z, clientY: rc.top + 46*z, bubbles: true }));
    return 1; })()`);
  await b.waitFor(`!!editing`, 5000);
  await b.evaluate(`(() => { const t = document.getElementById('textEditor'); t.value = 'TYPED OVER'; t.dispatchEvent(new Event('input')); commitTextEdit(); return 1; })()`);

  const order = await b.evaluate(`curAnnots().map(a => a.type)`);
  eq(order, ['rect', 'text'], 'new text should sit above the cover');
  const b64 = await b.evaluate(exportBase64);
  const pages = await b.evaluate(textOf(b64));
  ok(pages[0].includes('TYPED OVER'), 'text typed over a cover is missing from the saved file');
});

test('layers can be dragged into a new order', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]).drawText('Base', { x: 30, y: 250, size: 14, font: f });`));
  await b.waitFor(settled);
  await b.evaluate(`(() => { const id = state.pageIds[0]; state.annots[id] = [
      { id: uid(), type:'rect', x:30, y:40, w:60, h:20, rot:0, stroke:'#ff0000', fill:null, width:2, opacity:1 },
      { id: uid(), type:'rect', x:30, y:80, w:60, h:20, rot:0, stroke:'#00ff00', fill:null, width:2, opacity:1 },
      { id: uid(), type:'rect', x:30, y:120, w:60, h:20, rot:0, stroke:'#0000ff', fill:null, width:2, opacity:1 },
    ]; drawOverlay(); refreshLayers(true); return 1; })()`);
  eq(await b.evaluate(`curAnnots().map(a => a.stroke)`), ['#ff0000', '#00ff00', '#0000ff'], 'starting order');

  // rows are newest first, so row 0 is the last item: drag it to the bottom row
  await b.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#layerList .layer')];
    const dt = new DataTransfer();
    rows[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    rows[2].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    return 1; })()`);
  eq(await b.evaluate(`curAnnots().map(a => a.stroke)`), ['#0000ff', '#ff0000', '#00ff00'], 'the dragged layer moved to the back');
  await b.evaluate(`undo()`);
  eq(await b.evaluate(`curAnnots().map(a => a.stroke)`), ['#ff0000', '#00ff00', '#0000ff'], 'undo restores the order');
});

test('a working copy survives the window closing', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`
    doc.addPage([420, 300]).drawText('Original page', { x: 30, y: 250, size: 14, font: f });
    doc.addPage([420, 300]).drawText('Second page', { x: 30, y: 250, size: 14, font: f });`));
  await b.waitFor(settled);
  await b.evaluate(`(() => { pushAnnotUndo(state.pageIds[0]);
    const a = { id: uid(), type:'text', x:40, y:120, w:0, h:0, rot:0, text:'MY WORK', size:14, font:'Helvetica', bold:false, color:'#e11d48', opacity:1 };
    measureText(a); curAnnots().push(a); drawOverlay(); return 1; })()`);
  await b.evaluate(`document.getElementById('autosaveOn').checked = true; 1`);

  // start from nothing kept, so an earlier test's copy cannot be mistaken for this one
  await b.evaluate(`KamDraft.clear()`);
  await b.evaluate(`noteChange()`);
  await b.waitFor(`KamDraft.get().then(d => !!d && d.annots && d.annots.length === 2 && d.annots[0].length > 0)`, 20000);
  const kept = await b.evaluate(`KamDraft.get().then(d => JSON.stringify({ name: d.fileName, pages: d.annots.length, text: d.annots[0][0].text, hasBytes: d.bytes.byteLength > 100 }))`);
  const k = JSON.parse(kept);
  eq(k.pages, 2, 'both pages kept');
  eq(k.text, 'MY WORK', 'the mark was kept');
  ok(k.hasBytes, 'the document itself was kept');

  // now start over, as though the window had been closed, and restore
  await b.reload();
  eq(await b.evaluate(`!!state.doc`), false, 'a fresh start has no document');
  await b.waitFor(`!document.getElementById('btnRestoreEmpty').hidden`, 10000);
  await b.evaluate(`document.getElementById('btnRestoreEmpty').click()`);
  // the document opens before the marks are put back, so wait for the whole restore
  await b.waitFor(`!!state.doc && state.pageIds.length === 2 && !state.renderTask && curAnnots().length > 0`, 20000);
  eq(await b.evaluate(`curAnnots().map(a => a.text)`), ['MY WORK'], 'the work came back');
  eq(await b.evaluate(`state.nextId > curAnnots()[0].id`), true, 'new marks will not reuse a restored id');

  // and Forget really removes it
  await b.evaluate(`document.getElementById('btnForget').click()`);
  await b.waitFor(`KamDraft.get().then(d => d === null)`, 10000);
  eq(await b.evaluate(`KamDraft.get().then(d => d === null)`), true, 'Forget clears the stored copy');
});

test('shift constrains shapes and lines', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  const dragShift = (tool, x1, y1, x2, y2) => `(() => {
    setTool('${tool}');
    const ov = document.getElementById('overlay'), rc = ov.getBoundingClientRect(), z = state.zoom;
    ov.setPointerCapture = () => {};
    const P = (t,x,y) => new PointerEvent(t, { clientX: rc.left + x*z, clientY: rc.top + y*z, button:0, bubbles:true, pointerId:1, shiftKey:true });
    ov.dispatchEvent(P('pointerdown', ${x1}, ${y1}));
    ov.dispatchEvent(P('pointermove', ${x2}, ${y2}));
    ov.dispatchEvent(P('pointerup', ${x2}, ${y2}));
    return 1; })()`;
  await b.evaluate(dragShift('rect', 40, 40, 200, 100));
  const r = await b.evaluate(`(a => JSON.stringify({ w: Math.round(a.w), h: Math.round(a.h) }))(curAnnots()[0])`);
  const box = JSON.parse(r);
  eq(box.w, box.h, 'shift should make a square');

  await b.evaluate(dragShift('line', 40, 200, 200, 210));
  const l = await b.evaluate(`(a => Math.round(Math.abs(a.pts[1][1] - a.pts[0][1])))(curAnnots()[1])`);
  eq(l, 0, 'shift should hold the line level');
});

test('undo and redo step through changes', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]).drawText('Base', { x: 30, y: 250, size: 14, font: f });`));
  await b.waitFor(settled);
  await b.evaluate(`(() => { pushAnnotUndo(state.pageIds[0]);
    curAnnots().push({ id: uid(), type:'rect', x:30, y:60, w:80, h:20, rot:0, stroke:'#ff0000', fill:null, width:2, opacity:1 });
    drawOverlay(); return 1; })()`);
  eq(await b.evaluate(`curAnnots().length`), 1, 'annotation added');
  await b.evaluate(`undo()`);
  eq(await b.evaluate(`curAnnots().length`), 0, 'undo removed it');
  await b.evaluate(`redo()`);
  eq(await b.evaluate(`curAnnots().length`), 1, 'redo brought it back');
});

test('the scanner finds the page in a photo', async b => {
  await b.reload();
  const r = await b.evaluate(`(() => {
    const W = 1200, H = 1600, c = document.createElement('canvas');
    c.width = W; c.height = H; const g = c.getContext('2d');
    g.fillStyle = '#4a4640'; g.fillRect(0, 0, W, H);
    const truth = [[210,260],[1010,200],[1080,1380],[150,1300]];
    g.fillStyle = '#f2efe8'; g.beginPath(); g.moveTo(...truth[0]);
    truth.slice(1).forEach(p => g.lineTo(...p)); g.closePath(); g.fill();
    const found = KamScan.detectCorners(c);
    if (!found) return JSON.stringify({ found: false });
    return JSON.stringify({ found: true, err: found.map((p, i) => Math.round(Math.hypot(p[0]-truth[i][0], p[1]-truth[i][1]))) });
  })()`);
  const d = JSON.parse(r);
  ok(d.found, 'the page was not detected in the photo');
  ok(Math.max(...d.err) < 25, `corners off by ${JSON.stringify(d.err)} pixels`);
});

// Whether the bar is actually on screen, not merely whether the flag was set: an earlier bug in
// this project survived because a test graded the thing that set the value.
const barShows = `(() => { const u = document.getElementById('updateBar');
  return u.offsetHeight > 0 && u.offsetWidth > 0 && getComputedStyle(u).display !== 'none'; })()`;

test('a newer version is noticed and offered in the bar', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);

  // 1.10.0 is older than 1.9.0 if you compare the strings, which is the usual way to get this wrong
  eq(await b.evaluate(`[versionIsNewer('1.10.0','1.9.0'), versionIsNewer('1.9.0','1.10.0'),
    versionIsNewer('1.12.0','1.12.0'), versionIsNewer('2.0.0','1.99.9'), versionIsNewer('1.12.1','1.12')]`),
    [true, false, false, true, true], 'versions compare number by number');

  const forget = `(() => { try { localStorage.removeItem('kam-skip-version'); localStorage.removeItem('kam-update-checked'); } catch (e) {} return 1; })()`;
  await b.evaluate(forget);

  // against the real version.json, which describes this very build, nothing is offered
  await b.evaluate(`checkForUpdate(true)`);
  eq(await b.evaluate(barShows), false, 'no bar when the site matches this build');

  // now let the site claim a newer one
  const claims = v => `(() => { window.fetch = async u => (String(u).includes('version.json')
      ? { ok: true, json: async () => ({ version: '${v}', notes: 'faster everything', url: 'https://example.invalid/rel' }) }
      : { ok: false, status: 404 });
    return 1; })()`;
  await b.evaluate(claims('9.9.9'));
  await b.evaluate(forget);
  await b.evaluate(`checkForUpdate(true)`);
  eq(await b.evaluate(barShows), true, 'the bar appears');
  const msg = await b.evaluate(`document.getElementById('updateMsg').textContent`);
  ok(msg.includes('9.9.9'), `the bar names the version, said: ${msg}`);
  ok(msg.includes('faster everything'), 'the bar says what changed');
  eq(await b.evaluate(`document.getElementById('updateNotes').href`), 'https://example.invalid/rel', 'the link points at that release');

  // it goes where it was asked to go: under the tools, above the page. offsetTop is used
  // rather than a bounding box because the bar slides in, and a box read mid-animation lies.
  const geo = JSON.parse(await b.evaluate(`(() => {
    const t = document.getElementById('toolbar'), u = document.getElementById('updateBar'), v = document.getElementById('viewport');
    const bg = getComputedStyle(u).backgroundImage;
    return JSON.stringify({
      underTools: u.offsetTop >= t.offsetTop + t.offsetHeight,
      overPage: u.offsetTop + u.offsetHeight <= v.offsetTop,
      wide: u.offsetWidth > 300,
      green: bg.includes('rgb(0, 96, 57)'),
    });
  })()`));
  ok(geo.underTools, 'the bar sits below the tool row');
  ok(geo.overPage, 'and above the page itself');
  ok(geo.wide, 'and spans the window');
  ok(geo.green, 'and it is the racing green');

  // "Not now" hides it and is remembered, but only for that version
  await b.evaluate(`document.getElementById('btnUpdateLater').click()`);
  eq(await b.evaluate(barShows), false, 'Not now hides the bar');
  await b.evaluate(`localStorage.removeItem('kam-update-checked'); 1`);
  await b.evaluate(`checkForUpdate(true)`);
  eq(await b.evaluate(barShows), false, 'the same version does not nag again');
  await b.evaluate(claims('9.9.10'));
  await b.evaluate(`localStorage.removeItem('kam-update-checked'); 1`);
  await b.evaluate(`checkForUpdate(true)`);
  eq(await b.evaluate(barShows), true, 'but a newer one is still offered');

  // GitHub answers if the site's own file cannot be reached
  await b.evaluate(`(() => { window.fetch = async u => (String(u).includes('api.github.com')
      ? { ok: true, json: async () => ({ tag_name: 'v8.1.0', name: 'KAM PDFs v8.1.0 - a nice change', html_url: 'https://example.invalid/gh' }) }
      : { ok: false, status: 500 });
    return 1; })()`);
  const gh = JSON.parse(await b.evaluate(`latestRelease().then(r => JSON.stringify(r))`));
  eq(gh.version, '8.1.0', 'the tag is read without its v');
  eq(gh.notes, 'a nice change', 'the release title is trimmed to what changed');
});

// The update button in the top bar, measured on screen like the bar is.
const updateButton = `(() => { const u = document.getElementById('btnUpdates'), cs = getComputedStyle(u);
  return JSON.stringify({ shows: u.offsetWidth > 0 && u.offsetHeight > 0 && cs.display !== 'none',
    gold: u.classList.contains('available'), label: u.querySelector('.upd-label').textContent,
    labelShows: u.querySelector('.upd-label').offsetWidth > 0, tip: u.title,
    getIcon: u.querySelector('.ic-get').getBoundingClientRect().width > 0,
    inTopBar: !!u.closest('#topbar') }); })()`;

test('the update button is always there, and turns gold when a version is waiting', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  const forget = `(() => { try { localStorage.removeItem('kam-skip-version'); localStorage.removeItem('kam-update-checked'); } catch (e) {} return 1; })()`;
  await b.evaluate(forget);

  // with nothing newer it is a quiet icon in the top bar, not a label
  let u = JSON.parse(await b.evaluate(updateButton));
  ok(u.shows && u.inTopBar, 'the update button is on screen, in the top bar');
  ok(!u.gold && !u.labelShows, 'and quiet while there is nothing to get');
  ok(u.tip.includes('Check for updates'), `it says what it does, said: ${u.tip}`);

  // a check you asked for answers on the button itself
  await b.evaluate(`checkForUpdate(false)`);
  u = JSON.parse(await b.evaluate(updateButton));
  eq(u.label, 'Up to date', 'a check against this very build says so');
  ok(u.labelShows, 'and the answer is on screen');

  // a newer version turns it gold and names it
  await b.evaluate(`(() => { window.fetch = async x => (String(x).includes('version.json')
      ? { ok: true, json: async () => ({ version: '9.9.9', notes: 'faster everything', url: 'https://example.invalid/rel' }) }
      : { ok: false, status: 404 });
    return 1; })()`);
  await b.evaluate(forget);
  await b.evaluate(`checkForUpdate(true)`);
  u = JSON.parse(await b.evaluate(updateButton));
  ok(u.gold, 'a waiting version turns the button gold');
  eq(u.label, 'Update to 9.9.9', 'and it names the version');
  ok(u.labelShows && u.getIcon, 'with the download arrow showing');
  eq(await b.evaluate(barShows), true, 'and the bar is up as well');

  // "Not now" puts the bar away but not the button, which brings it straight back
  await b.evaluate(`document.getElementById('btnUpdateLater').click()`);
  eq(await b.evaluate(barShows), false, 'Not now hides the bar');
  ok(JSON.parse(await b.evaluate(updateButton)).gold, 'but the button stays gold');
  await b.evaluate(`localStorage.removeItem('kam-update-checked'); checkForUpdate(true)`);
  eq(await b.evaluate(barShows), false, 'a later automatic check does not bring the bar back for that version');
  ok(JSON.parse(await b.evaluate(updateButton)).gold, 'and the button is still gold after it');
  await b.evaluate(`document.getElementById('btnUpdates').click()`);
  eq(await b.evaluate(barShows), true, 'clicking the button shows the bar again');
});

test('it checks once when it opens, and not again while it stays open', async b => {
  await b.reload();
  await b.evaluate(`(() => { window.__asked = 0; window.fetch = async x => { window.__asked++;
      return { ok: true, json: async () => ({ version: '1.0.0', notes: '', url: 'https://example.invalid' }) }; };
    return 1; })()`);
  // a fresh launch, with no check in the last six hours
  await b.evaluate(`checkedThisLaunch = false; localStorage.setItem('kam-update-checked', String(Date.now() - 7 * 3600e3)); maybeAutoCheck(); 1`);
  await b.waitFor(`window.__asked > 0`);
  eq(await b.evaluate(`window.__asked`), 1, 'it asks once when it opens');
  // nothing later in the same launch asks again: not coming back online, not any other nudge,
  // however long ago the last check was
  await b.evaluate(`localStorage.setItem('kam-update-checked', String(Date.now() - 7 * 3600e3));
    maybeAutoCheck(); window.dispatchEvent(new Event('online')); 1`);
  await sleep(2500);
  eq(await b.evaluate(`window.__asked`), 1, 'and not again while it stays open');
  // reopened soon after a launch that asked, it does not ask at all
  await b.evaluate(`window.__asked = 0; checkedThisLaunch = false;
    localStorage.setItem('kam-update-checked', String(Date.now() - 1 * 3600e3)); maybeAutoCheck(); 1`);
  await sleep(300);
  eq(await b.evaluate(`window.__asked`), 0, 'reopened an hour after a check, it does not ask');
});

test('a copy in a folder is handed the zip for its release', async b => {
  await b.reload();
  await b.evaluate(`(() => { window.fetch = async x => (String(x).includes('api.github.com')
      ? { ok: true, json: async () => ({ tag_name: 'v8.1.0', name: 'KAM PDFs v8.1.0 - a nice change',
          html_url: 'https://example.invalid/gh', assets: [
            { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.invalid/sums' },
            { name: 'KAM-PDFs-v8.1.0-windows.zip', browser_download_url: 'https://example.invalid/KAM-PDFs-v8.1.0-windows.zip' }] }) }
      : { ok: false, status: 500 });
    return 1; })()`);
  const gh = JSON.parse(await b.evaluate(`latestRelease().then(r => JSON.stringify(r))`));
  eq(gh.download, 'https://example.invalid/KAM-PDFs-v8.1.0-windows.zip', 'the Windows zip is picked out of the release');
});

test('updating clears the offline copy and reloads', async b => {
  await b.reload();
  await b.evaluate(`(() => { window.fetch = async u => (String(u).includes('version.json')
      ? { ok: true, json: async () => ({ version: '9.9.9', notes: 'x', url: 'https://example.invalid/rel' }) }
      : { ok: false, status: 404 });
    try { localStorage.removeItem('kam-skip-version'); localStorage.removeItem('kam-update-checked'); } catch (e) {}
    return 1; })()`);
  await b.evaluate(`checkForUpdate(true)`);
  eq(await b.evaluate(barShows), true, 'the bar is showing');

  // leave a stale cache behind, so we can tell whether updating really clears it
  await b.evaluate(`caches.open('kam-pdfs-vOLD').then(c => c.put('/stale', new Response('old')))`);
  ok(await b.evaluate(`caches.keys().then(k => k.includes('kam-pdfs-vOLD'))`), 'the stale cache was planted');

  await b.evaluate(`(() => { document.getElementById('btnUpdateNow').click(); return 1; })()`);
  await b.waitFor(`performance.getEntriesByType('navigation')[0].type === 'reload' && typeof state !== 'undefined'`, 20000);
  eq(await b.evaluate(`caches.keys().then(k => k.includes('kam-pdfs-vOLD'))`), false, 'the old offline copy is gone');
  eq(await b.evaluate(barShows), false, 'and the bar is not left over after the reload');
});

test('the side panels can be dragged, collapsed and put back', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  await b.evaluate(`(() => { try { localStorage.removeItem('kam-w-sidebar'); localStorage.removeItem('kam-w-rightpanel'); } catch (e) {}
    KamPanels.set('sidebar', 200, false); KamPanels.set('rightpanel', 270, false); return 1; })()`);

  // drag a divider the way a mouse would, and check the panel really moved rather than just
  // the number that was stored
  const dragSplit = (which, dx) => `(() => {
    const sp = document.getElementById('split-' + '${which}');
    sp.setPointerCapture = () => {}; sp.releasePointerCapture = () => {};
    const r = sp.getBoundingClientRect(), y = r.top + 30, x = r.left + 3;
    const P = (t, px) => new PointerEvent(t, { clientX: px, clientY: y, button: 0, bubbles: true, pointerId: 7 });
    sp.dispatchEvent(P('pointerdown', x));
    sp.dispatchEvent(P('pointermove', x + ${dx}));
    sp.dispatchEvent(P('pointerup', x + ${dx}));
    return 1; })()`;
  const widthOf = name => b.evaluate(`document.getElementById('${name}').offsetWidth`);

  await b.evaluate(dragSplit('sidebar', 120));
  await b.waitFor(`document.getElementById('sidebar').offsetWidth > 300`, 4000);
  const wideSide = await widthOf('sidebar');
  near(wideSide, 320, 6, 'the pages panel followed the divider');
  eq(await b.evaluate(`localStorage.getItem('kam-w-sidebar')`), String(wideSide), 'and the width was remembered');

  // the right panel grows when its divider goes the other way
  await b.evaluate(dragSplit('rightpanel', -70));
  await b.waitFor(`document.getElementById('rightpanel').offsetWidth > 320`, 4000);
  near(await widthOf('rightpanel'), 340, 6, 'the document panel followed its divider');

  // dragged well past the minimum, a panel folds away instead of jamming
  await b.evaluate(dragSplit('sidebar', -400));
  await b.waitFor(`document.getElementById('sidebar').offsetWidth === 0`, 4000);
  eq(await b.evaluate(`localStorage.getItem('kam-w-sidebar')`), 'collapsed', 'the collapse was remembered');
  eq(await b.evaluate(`!!document.getElementById('split-sidebar').classList.contains('collapsed')`), true,
    'the divider shows there is something folded away');

  // double-clicking a collapsed divider brings the panel back
  await b.evaluate(`document.getElementById('split-sidebar').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await b.waitFor(`document.getElementById('sidebar').offsetWidth > 100`, 4000);
  ok(await widthOf('sidebar') > 100, 'double-click brought the panel back');

  // and on a normal divider it resets to the width it shipped with
  await b.evaluate(dragSplit('sidebar', 90));
  await b.evaluate(`document.getElementById('split-sidebar').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await b.waitFor(`document.getElementById('sidebar').offsetWidth === 200`, 4000);
  eq(await widthOf('sidebar'), 200, 'double-click resets to the default width');

  // the keyboard can do all of it too, because a drag-only divider excludes people
  await b.evaluate(`document.getElementById('split-rightpanel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`);
  await b.waitFor(`document.getElementById('rightpanel').offsetWidth === 270`, 4000);
  await b.evaluate(`document.getElementById('split-rightpanel').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`);
  await b.waitFor(`document.getElementById('rightpanel').offsetWidth === 286`, 4000);
  eq(await widthOf('rightpanel'), 286, 'an arrow key widens the panel by one step');

  // sizes survive the window closing
  await b.evaluate(`KamPanels.set('sidebar', 300, false)`);
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  await b.waitFor(`document.getElementById('sidebar').offsetWidth === 300`, 5000);
  eq(await widthOf('sidebar'), 300, 'the width came back after a reload');
  await b.evaluate(`KamPanels.reset()`);
});

test('the tool row can be moved below the page', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  await b.evaluate(`try { localStorage.removeItem('kam-toolbar-dock'); } catch (e) {} KamPanels.setDock('top'); 1`);

  const order = `(() => {
    const t = document.getElementById('toolbar'), v = document.getElementById('viewport');
    return t.getBoundingClientRect().top < v.getBoundingClientRect().top ? 'above' : 'below';
  })()`;
  eq(await b.evaluate(order), 'above', 'the tools start above the page');

  // drag the grip into the lower half of the viewer
  await b.evaluate(`(() => {
    const g = document.getElementById('toolbarGrip'), v = document.getElementById('viewer');
    g.setPointerCapture = () => {}; g.releasePointerCapture = () => {};
    const r = v.getBoundingClientRect(), gr = g.getBoundingClientRect();
    const P = (t, y) => new PointerEvent(t, { clientX: gr.left + 5, clientY: y, button: 0, bubbles: true, pointerId: 8 });
    g.dispatchEvent(P('pointerdown', gr.top + 5));
    g.dispatchEvent(P('pointermove', r.top + r.height * 0.8));
    g.dispatchEvent(P('pointerup', r.top + r.height * 0.8));
    return 1; })()`);
  await b.waitFor(`${order} === 'below'`, 4000);
  eq(await b.evaluate(order), 'below', 'the tools moved under the page');
  eq(await b.evaluate(`localStorage.getItem('kam-toolbar-dock')`), 'bottom', 'and that was remembered');

  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  eq(await b.evaluate(order), 'below', 'still below after a reload');
  await b.evaluate(`KamPanels.reset()`);
  eq(await b.evaluate(order), 'above', 'Reset layout puts everything back');
});

test('the buttons use the drawn icon set, not emoji', async b => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // Emoji arrive at a different size, weight and colour on every machine, and some of them
  // in full colour, which is what made the tool row look thrown together.
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
  const offenders = [];
  for (const m of html.matchAll(/<button[\s\S]*?<\/button>/g)) {
    const label = m[0].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '');
    if (emoji.test(label)) offenders.push(label.trim().slice(0, 30));
  }
  eq(offenders, [], 'these buttons still carry an emoji');
  // Nowhere else draws one either. The Layers rows, the find bar, the scan dialog and the
  // signature box all still did after the toolbar was fixed; it took screenshots to notice.
  for (const f of ['layers.js', 'annot.js', 'pdftext-ui.js', 'scan-desktop.js', 'scan-ui.js', 'scan.html']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const hit = src.match(emoji) || src.match(/[\u25B2\u25BC\u25B8\u25C2\u25C9\u25CC\u27F2\u27F3]/u);
    eq(hit ? hit[0] : null, null, `${f} still draws an emoji or symbol glyph`);
  }

  // every icon a button asks for has to exist, or it renders as nothing at all
  const defined = new Set([...html.matchAll(/<symbol id="(i-[\w-]+)"/g)].map(x => x[1]));
  const used = [...new Set([...html.matchAll(/<use href="#(i-[\w-]+)"/g)].map(x => x[1]))];
  eq(used.filter(u => !defined.has(u)), [], 'icons used but never drawn');
  ok(used.length >= 20, `expected a full icon set, found ${used.length}`);

  // and they should actually paint: an icon with no size is an icon nobody sees. The tools only
  // appear once a document is open, and icons inside a closed menu are rightly not drawn.
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  const box = JSON.parse(await b.evaluate(`(() => {
    const ics = [...document.querySelectorAll('#tools .ic')].filter(i => !i.closest('.menu'));
    const bad = ics.filter(i => i.getBoundingClientRect().width < 8 || i.getBoundingClientRect().height < 8);
    return JSON.stringify({ count: ics.length, bad: bad.length,
      stroke: ics.length ? getComputedStyle(ics[0]).stroke : '' });
  })()`));
  ok(box.count >= 10, `expected icons in the tool row, found ${box.count}`);
  eq(box.bad, 0, 'some tool icons render with no size');
  ok(box.stroke && box.stroke !== 'none', 'tool icons should take the button colour');
});

test('with nothing open, only what you can do is on screen', async b => {
  await b.reload();
  const seen = sel => `(() => { const e = document.querySelector('${sel}'); return !!e && e.offsetWidth > 0 && e.offsetHeight > 0; })()`;
  eq(await b.evaluate(`document.body.classList.contains('no-doc')`), true, 'the app starts in its no-document state');
  for (const sel of ['#toolbar', '#sidebar', '#rightpanel', '#pager', '#btnSave', '#btnUndo'])
    eq(await b.evaluate(seen(sel)), false, `${sel} should wait until a document is open`);
  for (const sel of ['#btnOpen2', '#taskCombine', '#taskImages', '#btnScan2', '#btnFile', '#btnCommand'])
    eq(await b.evaluate(seen(sel)), true, `${sel} should be offered on the welcome screen`);
  eq(await b.evaluate(`['btnMerge', 'btnSaveAs', 'btnPng', 'btnPrint'].map(id => document.getElementById(id).disabled)`),
    [true, true, true, true], 'File menu items that need a document are disabled rather than silently doing nothing');

  // help is still reachable with nothing open
  await b.evaluate(`document.getElementById('btnHelpEmpty').click(); 1`);
  eq(await b.evaluate(seen('#tab-help')), true, 'Help opens without a document');

  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  eq(await b.evaluate(`document.body.classList.contains('no-doc')`), false, 'opening a document leaves the welcome state');
  for (const sel of ['#toolbar', '#sidebar', '#rightpanel', '#pager', '#btnSave'])
    eq(await b.evaluate(seen(sel)), true, `${sel} appears once a document is open`);
  eq(await b.evaluate(`document.getElementById('btnMerge').disabled`), false, 'and the menu items come alive');
});

test('the Combine card joins several PDFs into one', async b => {
  await b.reload();
  // the card hands the chosen files to the same path a drop uses, which works with nothing open
  const pages = await b.evaluate(`(async () => {
    const { PDFDocument } = PDFLib;
    const mk = async n => { const d = await PDFDocument.create(); for (let i = 0; i < n; i++) d.addPage([300, 200]);
      return new File([await d.save()], 'part' + n + '.pdf', { type: 'application/pdf' }); };
    await handleDroppedFiles([await mk(2), await mk(3)]);
    return state.pageIds.length; })()`);
  eq(pages, 5, 'a 2-page and a 3-page PDF combine into 5 pages');
});

test('any command can be found by typing its name', async b => {
  await b.reload();
  eq(await b.evaluate(`KamPalette.audit()`), [], 'commands pointing at controls that do not exist');

  const isOpen = `!document.getElementById('palette').hidden`;
  const type = q => `(() => { const i = document.getElementById('paletteInput'); i.value = ${JSON.stringify(q)};
    i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`;
  const press = k => `(() => { document.getElementById('paletteInput').dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true })); return 1; })()`;
  const top = `(() => { const r = document.querySelector('#paletteList .pal-item.on');
    return r ? { label: r.querySelector('.pal-label').textContent, disabled: r.getAttribute('aria-disabled') } : null; })()`;

  await b.evaluate(`document.activeElement.blur(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); 1`);
  eq(await b.evaluate(isOpen), true, 'Ctrl+K opens the command search');
  eq(await b.evaluate(`document.activeElement.id`), 'paletteInput', 'with the cursor already in it');

  // with nothing open, document commands are still listed, marked, and do not run
  await b.evaluate(type('watermark'));
  const w0 = await b.evaluate(top);
  ok(w0 && /watermark/i.test(w0.label), 'watermark is found: ' + JSON.stringify(w0));
  eq(w0.disabled, 'true', 'but marked as needing a document');
  await b.evaluate(press('Escape'));
  eq(await b.evaluate(isOpen), false, 'Escape closes it');

  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);

  // a word that is not in the label still finds the command: circle means the ellipse tool
  await b.evaluate(`KamPalette.open(); 1`);
  await b.evaluate(type('circle'));
  eq((await b.evaluate(top)).label, 'Ellipse', 'typing circle finds the ellipse tool');
  await b.evaluate(press('Enter'));
  await b.waitFor(`state.tool === 'ellipse'`, 3000);
  eq(await b.evaluate(isOpen), false, 'running a command closes the search');
  eq(await b.evaluate(`document.getElementById('btnShapes').classList.contains('active')`), true, 'and the Shapes button shows a shape is in use');

  // a command that lives in a folded section opens that section and puts you in the box
  await b.evaluate(`document.querySelector('details.sec[data-sec="stamp"]').open = false; 1`);
  await b.evaluate(`KamPalette.open(); 1`);
  await b.evaluate(type('watermark'));
  await b.evaluate(press('Enter'));
  await b.waitFor(`document.activeElement && document.activeElement.id === 'wmText'`, 3000);
  eq(await b.evaluate(`document.querySelector('details.sec[data-sec="stamp"]').open`), true, 'the watermark section was opened');

  // arrow keys move through the matches
  await b.evaluate(`KamPalette.open(); 1`);
  await b.evaluate(type('rotate'));
  const r1 = (await b.evaluate(top)).label;
  await b.evaluate(press('ArrowDown'));
  const r2 = (await b.evaluate(top)).label;
  ok(/rotate/i.test(r1) && /rotate/i.test(r2) && r1 !== r2, `arrow down moves to the next match: ${r1}, then ${r2}`);
  eq(await b.evaluate(`KamPalette.results('zzqx')`), [], 'nonsense finds nothing');
  await b.evaluate(`KamPalette.close(); 1`);
});

test('the File and Shapes menus open, choose, and get out of the way', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  const shown = id => `(() => { const e = document.getElementById('${id}'); return !e.hidden && e.offsetHeight > 0; })()`;

  await b.evaluate(`document.getElementById('btnFile').click(); 1`);
  eq(await b.evaluate(shown('fileMenu')), true, 'File opens its menu');
  eq(await b.evaluate(`document.getElementById('btnFile').getAttribute('aria-expanded')`), 'true', 'and says so to screen readers');
  await b.evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); 1`);
  eq(await b.evaluate(shown('fileMenu')), false, 'clicking elsewhere closes it');

  // Escape closes a menu without also throwing away the tool you had
  await b.evaluate(`setTool('pen'); document.getElementById('btnShapes').click(); 1`);
  eq(await b.evaluate(shown('shapeMenu')), true, 'Shapes opens its menu');
  await b.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
  eq(await b.evaluate(shown('shapeMenu')), false, 'Escape closes it');
  eq(await b.evaluate(`state.tool`), 'pen', 'and the pen is still the tool');

  // choosing a shape picks the tool, closes the menu, and the button takes that shape's icon
  await b.evaluate(`document.getElementById('btnShapes').click(); document.querySelector('#shapeMenu [data-tool="arrow"]').click(); 1`);
  eq(await b.evaluate(`state.tool`), 'arrow', 'the arrow tool is chosen');
  eq(await b.evaluate(shown('shapeMenu')), false, 'the menu closed behind it');
  eq(await b.evaluate(`document.querySelector('#shapesIcon use').getAttribute('href')`), '#i-arrow', 'the button shows the arrow');
  eq(await b.evaluate(`document.getElementById('btnShapes').classList.contains('active')`), true, 'and is lit as the active tool');

  // the keyboard shortcut does the same, and a tool that is not a shape turns the button off
  await b.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })); 1`);
  eq(await b.evaluate(`document.querySelector('#shapesIcon use').getAttribute('href')`), '#i-ellipse', 'E switches the Shapes button to the ellipse');
  await b.evaluate(`setTool('text'); 1`);
  eq(await b.evaluate(`document.getElementById('btnShapes').classList.contains('active')`), false, 'another tool turns Shapes off');
});

test('document options fold into sections, and unsaved work is marked', async b => {
  await b.reload();
  await b.evaluate(`Object.keys(localStorage).filter(k => k.startsWith('kam-sec-')).forEach(k => localStorage.removeItem(k)); 1`);
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  const openSecs = `[...document.querySelectorAll('details.sec')].filter(d => d.open).map(d => d.dataset.sec)`;
  eq(await b.evaluate(`document.querySelectorAll('details.sec').length`), 6, 'six sections instead of one long page');
  eq(await b.evaluate(openSecs), ['export'], 'only Save & export starts open');

  // a section you open stays open
  await b.evaluate(`document.querySelector('details.sec[data-sec="details"]').open = true; 1`);
  await b.waitFor(`localStorage.getItem('kam-sec-details') === '1'`, 3000);
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  eq(await b.evaluate(openSecs), ['export', 'details'], 'the section you opened is still open after a reload');

  // unsaved changes show on the Save button and in the window title
  const look = `({ dot: document.getElementById('btnSave').classList.contains('dirty'), title: document.title })`;
  let d = await b.evaluate(look);
  eq(d.dot, false, 'nothing to save yet');
  eq(d.title, 'test.pdf - KAM PDFs', 'the title names the file');
  await b.evaluate(`(() => { pushAnnotUndo(state.pageIds[0]);
    curAnnots().push({ id: uid(), type: 'rect', x: 20, y: 20, w: 40, h: 30, rot: 0, stroke: '#000000', fill: null, width: 2, opacity: 1 });
    drawOverlay(); return 1; })()`);
  d = await b.evaluate(look);
  eq(d.dot, true, 'a change puts a dot on Save');
  ok(d.title.startsWith('• '), 'and in the window title: ' + d.title);
  // saving is what clears the flag; this checks the screen follows the flag, not the download
  await b.evaluate(`state.dirty = false; 1`);
  d = await b.evaluate(look);
  eq(d.dot, false, 'when the work is saved, the dot goes');
  ok(!d.title.startsWith('• '), 'from the title too');
});

test('a first tip appears once, and then stays gone', async b => {
  await b.reload();
  await b.evaluate(`localStorage.removeItem('kam-coach-seen'); 1`);
  await b.reload();
  eq(await b.evaluate(`document.getElementById('coach').hidden`), true, 'no tip before a document is open');
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  eq(await b.evaluate(`!document.getElementById('coach').hidden && document.getElementById('coach').offsetHeight > 0`), true,
    'the tip shows with the first document');
  await b.evaluate(`document.getElementById('coachClose').click(); 1`);
  eq(await b.evaluate(`document.getElementById('coach').hidden`), true, 'Got it hides it');
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  eq(await b.evaluate(`document.getElementById('coach').hidden`), true, 'and it does not come back');
});

/* ---------- 2.0: every page in one scrolling column ---------- */
const manyPages = (n, w = 595, h = 842) => makeDoc(`
  for (let p = 0; p < ${n}; p++) { const pg = doc.addPage([${w}, ${h}]);
    pg.drawText('Page ' + (p + 1), { x: 50, y: ${h} - 70, size: 28, font: fb });
    for (let l = 0; l < 20; l++) pg.drawText('Line ' + l + ' of page ' + (p + 1), { x: 50, y: ${h} - 120 - l * 22, size: 12, font: f }); }`);
const drawnPages = `[...document.querySelectorAll('.page canvas.pdf')].map(c => +c.parentNode.dataset.i).sort((a, b) => a - b)`;
// scroll the way a reader does: a wheel movement, then the column moves
const scrollToPageTop = i => `(async () => { const vp = document.getElementById('viewport');
  vp.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, bubbles: true }));
  vp.scrollTop = KamView.pageEl(${i}).offsetTop - 10;
  await new Promise(r => setTimeout(r, 250)); await KamView.whenIdle(); return state.cur; })()`;

test('pages scroll in one column, and only the ones near the window are drawn', async b => {
  await b.reload();
  await b.evaluate(manyPages(60));
  await b.waitFor(settled);
  await b.evaluate(`setZoom(1, 'width')`); await b.waitFor(settled);
  eq(await b.evaluate(`document.querySelectorAll('#pages .page').length`), 60, 'every page has its place in the column');
  const first = await b.evaluate(drawnPages);
  ok(first.length >= 1 && first.length <= 6 && first[0] === 0, 'only the first few pages are drawn at the start: ' + first);

  eq(await b.evaluate(scrollToPageTop(30)), 30, 'scrolling to page 31 makes it the current page');
  eq(await b.evaluate(`document.getElementById('pageNum').value`), '31', 'the page number follows the scrolling');
  const mid = await b.evaluate(drawnPages);
  ok(mid.includes(30) && !mid.includes(0), `pages near the window are drawn, far ones let go: ${mid}`);
  ok(mid.length <= 10, `memory stays flat: ${mid.length} pages drawn`);
  eq(await b.evaluate(`document.getElementById('overlay').parentNode.dataset.i`), '30', 'the overlay you draw on moved with you');
  const thumbs = await b.evaluate(`document.querySelectorAll('.thumb canvas[data-drawn="1"]').length`);
  ok(thumbs < 30, `thumbnails are drawn as they come into view, not all at once (${thumbs} of 60)`);
});

test('clicking a page makes it the one you work on', async b => {
  await b.reload();
  await b.evaluate(manyPages(3));
  await b.waitFor(settled);
  await b.evaluate(`setZoom(0.5)`); await b.waitFor(settled);
  eq(await b.evaluate(`state.cur`), 0, 'the first page to begin with');
  // press on the second page, as a mouse would
  await b.evaluate(`(() => { const o = document.querySelector('.page[data-i="1"] canvas.ov'), r = o.getBoundingClientRect();
    o.setPointerCapture = () => {};
    o.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 20, clientY: r.top + 20, button: 0, bubbles: true, pointerId: 1 }));
    o.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 20, clientY: r.top + 20, button: 0, bubbles: true, pointerId: 1 })); return 1; })()`);
  eq(await b.evaluate(`state.cur`), 1, 'the page you clicked is now the current page');
  await b.evaluate(`setTool('rect')`);
  await b.evaluate(dragOn(40, 40, 200, 140));
  eq(await b.evaluate(`[0, 1, 2].map(i => (state.annots[state.pageIds[i]] || []).length)`), [0, 1, 0], 'a rectangle drawn there lands on that page');
});

test('zooming keeps the point under the cursor still, and never shows a blank page', async b => {
  await b.reload();
  await b.evaluate(manyPages(3));
  await b.waitFor(settled);
  // wide enough to scroll sideways, so the point can be held still in both directions
  await b.evaluate(`setZoom(2)`); await b.waitFor(settled);
  await b.evaluate(`(() => { const vp = document.getElementById('viewport'); vp.scrollLeft = 200; vp.scrollTop = 150; return 1; })()`);
  // a point on the page, and the screen position it is at
  const r = JSON.parse(await b.evaluate(`(() => { const v = document.getElementById('viewport').getBoundingClientRect();
    return JSON.stringify({ x: v.left + v.width * 0.6, y: v.top + v.height * 0.5 }); })()`));
  const under = `(() => { const o = document.getElementById('overlay').getBoundingClientRect();
    return [(${r.x} - o.left) / state.zoom, (${r.y} - o.top) / state.zoom]; })()`;
  const before = await b.evaluate(under);
  // zoom in with Ctrl and the mouse wheel over that spot, then look at the page at once,
  // before the sharper picture has had time to arrive
  const inkNow = await b.evaluate(`(() => { const vp = document.getElementById('viewport');
    for (let k = 0; k < 4; k++) vp.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: ${r.x}, clientY: ${r.y}, bubbles: true, cancelable: true }));
    const c = document.getElementById('pageCanvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0; for (let i = 0; i < d.length; i += 16) if (d[i] < 128) ink++;
    return ink; })()`);
  ok(inkNow > 50, 'the page is still showing while it is redrawn at the new size');
  await b.waitFor(settled);
  const after = await b.evaluate(under);
  ok(await b.evaluate(`state.zoom`) > 2.6, 'it zoomed in');
  near(after[0], before[0], 1.5, 'the same point stays under the cursor (across)');
  near(after[1], before[1], 1.5, 'the same point stays under the cursor (down)');
});

test('a very large page still draws at high zoom', async b => {
  await b.reload();
  await b.evaluate(manyPages(1, 2384, 3370));          // A0: plans and posters
  await b.waitFor(settled);
  await b.evaluate(`setZoom(8)`); await b.waitFor(settled);
  const r = JSON.parse(await b.evaluate(`(() => { const c = document.getElementById('pageCanvas'), g = c.getContext('2d');
    const d = g.getImageData(0, 0, Math.min(c.width, 1200), Math.min(c.height, 600)).data;
    let ink = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) ink++;
    return JSON.stringify({ px: c.width * c.height, ink }); })()`));
  ok(r.px <= 16777216 * 1.01, `the page is drawn into a bitmap of a sensible size (${Math.round(r.px / 1e6)} megapixels)`);
  ok(r.ink > 100, 'and it is not blank');
});

/* ---------- 2.0: work is never thrown away, and nothing in a PDF can run ---------- */
// Hand the page a file the way the file picker does, without the picker.
const pickFile = (inputId, bytesExpr, name) => `(async () => {
  const bytes = await (${bytesExpr});
  const dt = new DataTransfer(); dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'application/pdf' }));
  const input = document.getElementById('${inputId}'); input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 1; })()`;
const pdfBytes = label => `(async () => { const { PDFDocument, StandardFonts } = PDFLib; const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica); d.addPage([420, 300]).drawText(${JSON.stringify(label)}, { x: 30, y: 250, size: 18, font: f }); return d.save(); })()`;
const dialogTitle = `(() => { const m = document.getElementById('modal'); return m.classList.contains('show') ? document.querySelector('#modalBox h3').textContent : null; })()`;
const clickChoice = label => `(() => { const b = [...document.querySelectorAll('#modalBox button')].find(b => b.textContent === ${JSON.stringify(label)}); if (!b) throw new Error('no button ' + ${JSON.stringify(label)}); b.click(); return 1; })()`;
const makeDirty = `(() => { pushAnnotUndo(curPageId());
  const a = { id: uid(), type: 'text', x: 40, y: 120, w: 0, h: 0, rot: 0, text: 'AN HOUR OF WORK', size: 14, font: 'Helvetica', bold: false, color: '#e11d48', opacity: 1 };
  measureText(a); curAnnots().push(a); drawOverlay(); return 1; })()`;
// saving without a file picker or a real download, so the tests stay on this machine
const stubSaving = `(() => { window.showSaveFilePicker = undefined; window.__downloads = []; window.downloadBytes = (b, n) => { window.__downloads.push(n); }; return 1; })()`;

test('opening another file asks before throwing work away', async b => {
  await b.reload();
  await b.evaluate(stubSaving);
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  await b.evaluate(makeDirty);
  eq(await b.evaluate(`state.dirty`), true, 'the document has unsaved work');

  await b.evaluate(pickFile('fileInput', pdfBytes('Document B'), 'B.pdf'));
  await b.waitFor(`${dialogTitle} !== null`, 5000);
  ok(/Save changes/.test(await b.evaluate(dialogTitle)), 'it asks about the unsaved changes first');
  await b.evaluate(clickChoice('Cancel'));
  await b.waitFor(`${dialogTitle} === null`, 3000);
  eq(await b.evaluate(`[state.fileName, curAnnots().some(a => a.text === 'AN HOUR OF WORK'), state.dirty]`), ['test.pdf', true, true],
    'Cancel keeps the document and the work in it');

  await b.evaluate(pickFile('fileInput', pdfBytes('Document B'), 'B.pdf'));
  await b.waitFor(`${dialogTitle} !== null`, 5000);
  await b.evaluate(clickChoice("Don't save"));
  await b.waitFor(`state.fileName === 'B.pdf' && !state.renderTask && !document.getElementById('busy').classList.contains('show')`, 8000);
  eq(await b.evaluate(`[state.dirty, document.title.startsWith('•')]`), [false, false], 'the new file opens clean, with no unsaved mark');

  await b.evaluate(makeDirty);
  await b.evaluate(pickFile('fileInput', pdfBytes('Document C'), 'C.pdf'));
  await b.waitFor(`${dialogTitle} !== null`, 5000);
  await b.evaluate(clickChoice('Save'));
  try { await b.waitFor(`state.fileName === 'C.pdf' && !state.renderTask`, 8000); }
  catch (e) {
    throw new Failed('did not open C after saving: ' + JSON.stringify(await b.evaluate(`({ file: state.fileName, dirty: state.dirty, dl: window.__downloads,
      dialog: ${dialogTitle}, toast: document.getElementById('toast').textContent, busy: document.getElementById('busy').className })`)) + ' errors: ' + b.errors.join(' | '));
  }
  eq(await b.evaluate(`window.__downloads`), ['B-edited.pdf'], 'Save wrote the work out before the next file opened');
});

test('dropping a PDF on an open document never discards work by accident', async b => {
  await b.reload();
  await b.evaluate(stubSaving);
  await b.evaluate(makeDoc(`doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  await b.evaluate(makeDirty);
  const drop = `(async () => { const f = new File([await ${pdfBytes('Dropped')}], 'dropped.pdf', { type: 'application/pdf' });
    window.__drop = handleDroppedFiles([f]); return 1; })()`;

  await b.evaluate(drop);
  await b.waitFor(`${dialogTitle} !== null`, 5000);
  ok(/Add “dropped.pdf”/.test(await b.evaluate(dialogTitle)), 'it asks what to do with the dropped file');
  await b.evaluate(clickChoice('Cancel'));
  await b.evaluate(`window.__drop`);
  eq(await b.evaluate(`[state.fileName, state.pageIds.length, state.dirty]`), ['test.pdf', 1, true], 'Cancel changes nothing at all');

  await b.evaluate(drop);
  await b.waitFor(`${dialogTitle} !== null`, 5000);
  await b.evaluate(clickChoice('Open instead'));
  await b.waitFor(`${dialogTitle} !== null && /Save changes/.test(${dialogTitle})`, 5000);
  await b.evaluate(clickChoice('Cancel'));
  await b.evaluate(`window.__drop`);
  eq(await b.evaluate(`state.fileName`), 'test.pdf', 'opening instead still asks about unsaved work, and Cancel keeps it');

  await b.evaluate(drop);
  await b.waitFor(`${dialogTitle} !== null`, 5000);
  await b.evaluate(clickChoice('Add pages'));
  await b.evaluate(`window.__drop`);
  await b.waitFor(`state.pageIds.length === 2 && !state.renderTask`, 8000);
  eq(await b.evaluate(`curAnnots().some(a => a.text === 'AN HOUR OF WORK') || state.annots[state.pageIds[0]].some(a => a.text === 'AN HOUR OF WORK')`), true, 'Add pages keeps the work');
});

test('text inside a PDF can never run as code in the app', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([595, 842]).drawText('<img src=x onerror=__p=1>', { x: 50, y: 700, size: 18, font: f });`));
  await b.waitFor(settled);
  await b.evaluate(`window.__p = 0; KamPdfText.index(0)`);
  await b.evaluate(`KamContent.analyse(0).then(() => 1)`);
  // the ordinary way to remove a line: click it, press Delete, then look at the Layers tab
  await b.evaluate(`(() => { const r = KamPdfText.runsOf(0).find(r => r.text.includes('onerror'));
    pdfTextSelect(r.x + 5, r.y + r.h / 2); pdfTextDeleteSelected();
    document.querySelector('.tabs button[data-tab="layers"]').click(); return 1; })()`);
  await sleep(600);
  eq(await b.evaluate(`window.__p`), 0, 'the text did not run');
  ok((await b.evaluate(`document.querySelector('#layerList .layer-name').textContent`)).includes('<img src=x onerror=__p=1>'),
    'it is shown as the plain text it is');
  // and a second lock behind the first: the page refuses inline script outright
  ok(/script-src 'self'/.test(await b.evaluate(`document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`)), 'a content security policy is in place');
  eq(await b.evaluate(`new Promise(r => { window.__q = 0; document.body.insertAdjacentHTML('beforeend', '<img src="nothing-here.png" onerror="window.__q=1">'); setTimeout(() => r(window.__q), 500); })`),
    0, 'an injected inline handler is refused');
  b.errors.length = 0;
});

test('a half-transparent pen saves exactly as it looks', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([595, 842]);`));
  await b.waitFor(settled);
  await b.evaluate(`(() => { const pts = []; for (let i = 0; i <= 300; i++) { const t = i / 300; pts.push([60 + t * 470, 200 + 60 * Math.sin(t * Math.PI * 6)]); }
    curAnnots().push({ id: uid(), type: 'pen', pts, color: '#1d4ed8', width: 14, opacity: 0.5 });
    curAnnots().push({ id: uid(), type: 'arrow', pts: [[80, 420], [420, 520]], color: '#e11d48', width: 8, opacity: 0.4 }); return 1; })()`);
  const r = await b.evaluate(exportVsScreen(0, 2));
  ok(r.differing / r.total < 0.002, `the saved strokes differ from the screen on ${(100 * r.differing / r.total).toFixed(2)}% of the page`);
});

test('fill-in fields in a combined PDF are adopted, and stay under your marks', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([595, 842]).drawText('Cover page', { x: 50, y: 780, size: 20, font: f });`));
  await b.waitFor(settled);
  const r = await b.evaluate(`(async () => {
    const { PDFDocument, rgb } = PDFLib;
    const formDoc = await PDFDocument.create(), fp = formDoc.addPage([595, 842]);
    const tf = formDoc.getForm().createTextField('applicant.name'); tf.setText('OLD ANSWER');
    tf.addToPage(fp, { x: 60, y: 600, width: 300, height: 40, backgroundColor: rgb(0.8, 0.9, 1) });
    await mergeFiles([new File([await formDoc.save()], 'form.pdf', { type: 'application/pdf' })]);
    const fields = state.doc.getForm().getFields().map(f => f.getName());
    await deletePages([0]);                              // the form page is now the first page
    curAnnots().push({ id: uid(), type: 'rect', x: 55, y: 842 - 645, w: 310, h: 50, rot: 0, fill: '#ffffff', stroke: null, width: 0, opacity: 1 });
    const t = { id: uid(), type: 'text', x: 64, y: 842 - 632, w: 0, h: 0, rot: 0, text: 'MY CORRECTION', size: 18, font: 'Helvetica', bold: true, color: '#e11d48', opacity: 1 };
    measureText(t); curAnnots().push(t);
    return { fields, formTab: document.querySelectorAll('#formFields [data-name]').length }; })()`);
  eq(r.fields, ['applicant.name'], 'the combined field joined this document\'s form');
  ok(r.formTab >= 1, 'and the Form tab can see it');
  const b64 = await b.evaluate(exportBase64);
  const look = pdfiumColours(Buffer.from(b64, 'base64'), 0, [62, 842 - 638, 358, 842 - 602]);
  if (look === null) { console.log('        (PDFium check skipped: pypdfium2 or Pillow not installed)'); return; }
  ok(look.red > 20, `PDFium shows the correction written over the field (red pixels: ${look.red})`);
  ok(look.fieldBlue < 20, `and the old field is no longer painted on top of it (field-blue pixels: ${look.fieldBlue})`);
});

test('undo back to what was saved clears the unsaved mark, and page changes can be redone', async b => {
  await b.reload();
  await b.evaluate(stubSaving);
  await b.evaluate(makeDoc(`doc.addPage([420, 300]); doc.addPage([420, 300]);`));
  await b.waitFor(settled);
  await b.evaluate(makeDirty);
  await b.evaluate(`savePdf(false)`);
  eq(await b.evaluate(`state.dirty`), false, 'saved');
  await b.evaluate(`undo()`);
  eq(await b.evaluate(`state.dirty`), true, 'undoing past the save brings the unsaved mark back');
  await b.evaluate(`redo()`);
  eq(await b.evaluate(`state.dirty`), false, 'redoing back to exactly what was saved clears it again');

  const angle = `state.doc.getPage(1).getRotation().angle`;
  await b.evaluate(`rotatePages([1], 1)`); await b.waitFor(settled);
  eq(await b.evaluate(angle), 90, 'page turned');
  await b.evaluate(`undo()`); await b.waitFor(settled);
  eq(await b.evaluate(angle), 0, 'undo turned it back');
  await b.evaluate(`redo()`); await b.waitFor(settled);
  eq(await b.evaluate(angle), 90, 'and redo turned it again');
  eq(await b.evaluate(`(() => { state.fileName = 'report-edited.pdf'; return outName(); })()`), 'report-edited.pdf', 'saving again does not grow the name');
});

test('paste uses whatever was copied last, here or anywhere else', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([595, 842]);`));
  await b.waitFor(settled);
  // a mark copied earlier in the app
  await b.evaluate(`(() => { const a = { id: uid(), type: 'rect', x: 40, y: 40, w: 60, h: 40, rot: 0, stroke: '#000000', fill: null, width: 2, opacity: 1 };
    curAnnots().push(a); state.clipboard = JSON.stringify(a); state.clipboardOnSystem = true; return 1; })()`);
  const paste = data => `(async () => { const dt = new DataTransfer();
    ${data}
    document.activeElement.blur();
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 300)); return curAnnots().map(a => a.type); })()`;
  // then a picture copied from another program
  const withImage = await b.evaluate(paste(`const c = document.createElement('canvas'); c.width = 40; c.height = 30; c.getContext('2d').fillRect(0, 0, 40, 30);
    const blob = await new Promise(r => c.toBlob(r, 'image/png')); dt.items.add(new File([blob], 'x.png', { type: 'image/png' }));`));
  eq(withImage, ['rect', 'image'], 'the picture from elsewhere was pasted, not the old mark');
  const withMark = await b.evaluate(paste(`dt.setData('text/plain', 'KAM PDFs mark');`));
  eq(withMark, ['rect', 'image', 'rect'], 'copying a mark here and pasting brings the mark');
  const withText = await b.evaluate(paste(`dt.setData('text/plain', 'Text from an email');`));
  eq(withText, ['rect', 'image', 'rect', 'text'], 'plain text from elsewhere arrives as a text box');
  eq(await b.evaluate(`curAnnots().at(-1).text`), 'Text from an email', 'with the text in it');
});

test('the released version number is stated in one place only', async () => {
  const core = fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8');
  const app = (core.match(/KAM_VERSION\s*=\s*'([^']+)'/) || [])[1];
  ok(app, 'core.js does not state a version');

  // version.json is what an installed copy asks in order to learn that a newer one exists.
  // Forget to bump it and the release is invisible to everyone already running the app.
  const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
  eq(site.version, app, 'version.json does not match the version in core.js');
  ok(/^https:\/\//.test(site.url || ''), 'version.json needs a download url');

  // and the service worker cache has to change, or browsers keep serving the old files
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  eq((sw.match(/VERSION\s*=\s*'kam-pdfs-v([^']+)'/) || [])[1], app, 'sw.js cache name does not match the version');
});

/* ---------- optional second-engine check ---------- */
function pdfiumInk(buf) {
  const tmp = path.join(os.tmpdir(), 'kam-pdfium-check.pdf');
  fs.writeFileSync(tmp, buf);
  const script = `
import sys
try:
    import pypdfium2 as pdfium
    from PIL import Image
except Exception:
    print("SKIP"); sys.exit(0)
d = pdfium.PdfDocument(sys.argv[1])
try: d.init_forms()
except Exception: pass
img = d[0].render(scale=3, may_draw_forms=True).to_pil().convert("L")
print(sum(1 for p in img.getdata() if p < 160))
`;
  const sp = path.join(os.tmpdir(), 'kam-pdfium-check.py');
  fs.writeFileSync(sp, script);
  for (const py of ['python', 'python3']) {
    const r = spawnSync(py, [sp, tmp], { encoding: 'utf8' });
    if (r.status === 0) {
      const out = (r.stdout || '').trim();
      return out === 'SKIP' ? null : parseInt(out, 10);
    }
  }
  return null;
}

/* All the text PDFium reads from a PDF, pages joined by newlines. null when PDFium is missing. */
function pdfiumText(buf) {
  const tmp = path.join(os.tmpdir(), 'kam-pdfium-text.pdf');
  fs.writeFileSync(tmp, buf);
  const script = `
import sys
try:
    import pypdfium2 as pdfium
except Exception:
    print("SKIP"); sys.exit(0)
d = pdfium.PdfDocument(sys.argv[1])
out = []
for i in range(len(d)):
    out.append(d[i].get_textpage().get_text_range())
sys.stdout.buffer.write(("\\n".join(out)).encode("utf-8"))
`;
  const sp = path.join(os.tmpdir(), 'kam-pdfium-text.py');
  fs.writeFileSync(sp, script);
  for (const py of ['python', 'python3']) {
    const r = spawnSync(py, [sp, tmp], { encoding: 'utf8' });
    if (r.status === 0) {
      const out = (r.stdout || '');
      return out.trim() === 'SKIP' ? null : out.replace(/\r\n?/g, '\n');
    }
  }
  return null;
}

/* PDFium's view of one region of a saved page: how many pixels are the red of a correction,
   and how many are the pale blue a text field is painted with. null when PDFium is missing. */
function pdfiumColours(buf, pageIndex, [x0, y0, x1, y1]) {
  const tmp = path.join(os.tmpdir(), 'kam-pdfium-colours.pdf');
  fs.writeFileSync(tmp, buf);
  const script = `
import sys
try:
    import pypdfium2 as pdfium
except Exception:
    print("SKIP"); sys.exit(0)
d = pdfium.PdfDocument(sys.argv[1])
try: d.init_forms()
except Exception: pass
img = d[${pageIndex}].render(scale=1, may_draw_forms=True).to_pil().convert("RGB")
red = blue = 0
for x in range(${x0}, ${x1}, 2):
    for y in range(${y0}, ${y1}, 2):
        r, g, b = img.getpixel((x, y))
        if r > 180 and g < 90 and b < 120: red += 1
        if b > 230 and r < 235 and g > 200: blue += 1
print(red, blue)
`;
  const sp = path.join(os.tmpdir(), 'kam-pdfium-colours.py');
  fs.writeFileSync(sp, script);
  for (const py of ['python', 'python3']) {
    const r = spawnSync(py, [sp, tmp], { encoding: 'utf8' });
    if (r.status === 0) {
      const out = (r.stdout || '').trim();
      if (out === 'SKIP') return null;
      const [red, fieldBlue] = out.split(/\s+/).map(Number);
      return { red, fieldBlue };
    }
  }
  return null;
}

/* ---------- runner ---------- */
(async () => {
  if (!CHROME) { console.error('Could not find Google Chrome. Install it, or edit CHROME in tests/run.js.'); process.exit(2); }
  const srv = await serve();
  const b = await browser();
  const chosen = tests.filter(t => !only.length || only.some(o => t.name.toLowerCase().includes(o.toLowerCase())));
  let passed = 0; const failed = [];
  console.log(`\nKAM PDFs - running ${chosen.length} test${chosen.length === 1 ? '' : 's'}\n`);
  for (const t of chosen) {
    const t0 = Date.now();
    try {
      await t.fn(b);
      if (b.errors.length) throw new Failed('page reported an error: ' + b.errors[0]);
      passed++;
      console.log(`  PASS  ${t.name}  (${Date.now() - t0}ms)`);
    } catch (e) {
      failed.push(t.name);
      console.log(`  FAIL  ${t.name}`);
      console.log(`        ${e.message.replace(/\n/g, '\n        ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed.length} failed\n`);
  b.close(); srv.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('the suite could not run:', e); process.exit(2); });
