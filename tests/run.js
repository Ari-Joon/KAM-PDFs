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
      await waitFor(`typeof state !== 'undefined' && typeof pdfTextEditAt === 'function' && typeof KamSpell !== 'undefined'`);
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

test('existing text can be edited in place', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`
    const p = doc.addPage([595, 842]);
    p.drawText('Quarterly report', { x: 48, y: 746, size: 26, font: fb, color: rgb(0.1,0.1,0.12) });
    p.drawText('Total due: 1,399.20', { x: 48, y: 642, size: 14, font: ft, color: rgb(0.8,0.1,0.1) });`));
  await b.waitFor(settled);
  await b.evaluate(`KamPdfText.index(0)`);

  const run = await b.evaluate(`(r => r && ({ text: r.text, size: +r.size.toFixed(1) }))(KamPdfText.runAt(0, 100, 196))`);
  eq(run.text, 'Total due: 1,399.20', 'found the line under the cursor');

  eq(await b.evaluate(`pdfTextEditAt(100, 196)`), true, 'double-click starts editing');
  const picked = await b.evaluate(`JSON.stringify((l => { const a = l[l.length-1]; return { text: a.text, size: a.size, font: a.font, colour: a.color, x: Math.round(a.x) }; })(curAnnots()))`);
  const p = JSON.parse(picked);
  eq(p.text, 'Total due: 1,399.20', 'original text picked up');
  eq(p.size, 14, 'original size kept');
  eq(p.font, 'TimesRoman', 'serif font recognised');
  eq(p.x, 48, 'starts at the original x');
  ok(/^#c[0-9a-f]{5}$/.test(p.colour) || p.colour.startsWith('#c'), `red ink picked up, got ${p.colour}`);

  await b.evaluate(`(() => { const t = document.getElementById('textEditor'); t.value = 'Total due: 1,499.20'; t.dispatchEvent(new Event('input')); commitTextEdit(); return 1; })()`);
  const b64 = await b.evaluate(exportBase64);
  const pages = await b.evaluate(textOf(b64));
  ok(pages[0].includes('1,499.20'), 'edited value is in the saved file');
  // Editing covers the original and writes new text over it, so the old words are still in
  // the file. Redact is the tool that actually removes them; the README says so.
  ok(pages[0].includes('1,399.20'), 'editing is expected to leave the original text extractable');
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

  // click a line, press Delete, and it should be covered
  await b.evaluate(`pdfTextClearPick(); pdfTextSelect(60, 78); 1`);
  const before = await b.evaluate(`curAnnots().length`);
  eq(await b.evaluate(`pdfTextDeleteSelected()`), true, 'Delete removes the picked line');
  eq(await b.evaluate(`curAnnots().length`), before + 1, 'a cover was added');
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

  // and not hiding in a compressed stream either
  const buf = Buffer.from(b64, 'base64');
  const zlib = require('zlib');
  let leaked = buf.includes('DELETEME');
  for (const m of buf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    try { if (zlib.inflateSync(Buffer.from(m[1], 'latin1')).includes('DELETEME')) leaked = true; } catch (e) { }
  }
  ok(!leaked, 'deleted words found inside the saved file');
});

test('a deletion is visible on screen but not in the file', async b => {
  await b.reload();
  await b.evaluate(makeDoc(`doc.addPage([420, 300]).drawText('DELETEME line', { x: 30, y: 250, size: 14, font: f });`));
  await b.waitFor(settled);
  await b.evaluate(`KamPdfText.index(0)`);
  await b.evaluate(`setTool('select')`);
  await b.evaluate(`pdfTextSelect(60, 46)`);
  eq(await b.evaluate(`pdfTextDeleteSelected()`), true, 'the line was deleted');

  // On white paper a white patch is invisible, which is how a deletion gets clicked and
  // undone by accident. On screen it must be marked; in the file it must not be.
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

  // the saved file must show clean paper there, with no hatching baked in
  const b64 = await b.evaluate(exportBase64);
  const pages = await b.evaluate(textOf(b64));
  ok(!pages[0].includes('DELETEME'), 'the deleted words are still in the file');
  const clean = await b.evaluate(`(async () => {
    const s = atob(${JSON.stringify(b64)}); const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    const pdf = await pdfjsLib.getDocument({ data: u }).promise;
    const p = await pdf.getPage(1); const vp = p.getViewport({ scale: 2 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    // the strip where the line used to be should be plain paper
    const d = ctx.getImageData(50, 60, 300, 40).data;
    let ink = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i+1] < 200) ink++;
    return ink;
  })()`);
  ok(clean < 40, `the deleted area should be clean paper in the file, found ${clean} marked pixels`);
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
