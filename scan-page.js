/* KAM PDFs - the phone scanner page. Its own file so the page can forbid inline scripts. */
'use strict';
const $ = s => document.querySelector(s);
const pages = [];          // {id, blob, url, w, h, sent}
let conn = null, peer = null, connectedCode = '';
let toastT; function toast(m, ms = 2500) { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => t.style.display = 'none', ms); }
function setStatus(text, cls) { const s = $('#status'); s.textContent = text; s.className = 'pill ' + (cls || ''); }
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- pages kept on the phone ----------
   Every page you take is kept in this browser's storage on the phone until you remove it, so
   a reload, a phone call or the browser being closed in the background no longer throws the
   photos away. */
const Store = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const rq = indexedDB.open('kam-scan', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('pages');
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  }).catch(() => null));
  async function run(mode, fn) {
    const db = await open(); if (!db) return null;
    return new Promise(res => { const tx = db.transaction('pages', mode); const out = fn(tx.objectStore('pages')); tx.oncomplete = () => res(out && out.result !== undefined ? out.result : true); tx.onerror = () => res(null); });
  }
  return {
    // the whole list, in order: put after any change
    save: () => run('readwrite', st => { st.clear(); pages.forEach((p, order) => st.put({ blob: p.blob, w: p.w, h: p.h, sent: p.sent, order }, p.id)); }),
    load: async () => {
      const db = await open(); if (!db) return [];
      return new Promise(res => {
        const out = [], tx = db.transaction('pages', 'readonly'), rq = tx.objectStore('pages').openCursor();
        rq.onsuccess = () => { const c = rq.result; if (c) { out.push({ id: c.key, ...c.value }); c.continue(); } };
        tx.oncomplete = () => res(out.sort((a, b) => a.order - b.order)); tx.onerror = () => res([]);
      });
    },
  };
})();

/* ---------- pages ---------- */
function renderPages() {
  const cont = $('#pages'); cont.innerHTML = '';
  $('#pagesEmpty').style.display = pages.length ? 'none' : '';
  pages.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'page' + (p.sent ? ' sent' : '');
    d.innerHTML = `<img src="${p.url}" alt=""><span class="n">${i + 1}</span><button class="x" title="Remove" aria-label="Remove"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button><div class="mv"><button data-d="-1">‹</button><button data-d="1">›</button></div>`;
    d.querySelector('.x').onclick = () => { URL.revokeObjectURL(p.url); pages.splice(i, 1); Store.save(); renderPages(); };
    d.querySelectorAll('.mv button').forEach(b => b.onclick = () => { const j = i + (+b.dataset.d); if (j < 0 || j >= pages.length) return; [pages[i], pages[j]] = [pages[j], pages[i]]; Store.save(); renderPages(); });
    cont.appendChild(d);
  });
  const has = pages.length > 0;
  $('#btnSend').disabled = !(has && conn && conn.open); $('#btnPdf').disabled = !has; $('#btnShare').disabled = !(has && navigator.share);
  $('#btnSend').textContent = has ? `Send ${pages.length} page${pages.length > 1 ? 's' : ''} to computer` : 'Send to computer';
}

/* ---------- capture -> editor queue ---------- */
let queue = [];
async function enqueue(files) { queue.push(...files); if (queue.length === files.length) runQueue(); }
async function runQueue() {
  while (queue.length) {
    const f = queue.shift();
    $('#home').style.display = 'none'; $('#editor').hidden = false; $('#foot').style.display = 'none';
    await new Promise(res => KamScanUI.open(f, {
      mount: $('#editor'), mode: 'color',
      onDone: ({ blob, canvas }) => { pages.push({ id: newId(), blob, url: URL.createObjectURL(blob), w: canvas.width, h: canvas.height, sent: false }); Store.save(); res(); },
      onCancel: () => res(),
    }));
  }
  $('#editor').hidden = true; $('#home').style.display = 'contents'; $('#foot').style.display = '';
  renderPages();
}
$('#camIn').addEventListener('change', e => { enqueue([...e.target.files]); e.target.value = ''; });
$('#galIn').addEventListener('change', e => { enqueue([...e.target.files]); e.target.value = ''; });

/* ---------- pairing with the computer (WebRTC, direct device to device) ---------- */
function connect(code) {
  code = (code || '').trim().toUpperCase(); if (code.length !== 6) return toast('Enter the 6-character code');
  if (peer) { try { peer.destroy(); } catch (e) { } }
  setStatus('Connecting…');
  peer = new Peer({ debug: 1 });
  peer.on('open', () => {
    conn = peer.connect('kam-pdfs-' + code, { reliable: true });
    const timer = setTimeout(() => { if (!conn.open) { setStatus('Could not reach computer · tap to retry', 'err'); toast('No computer found with that code. Is the Scan dialog open in KAM PDFs?', 4000); } }, 15000);
    conn.on('open', () => { clearTimeout(timer); connectedCode = code; setStatus('Connected to computer', 'ok'); toast('Connected. Take photos, then send.'); $('#pair').hidden = true; try { localStorage.setItem('kam-scan-code', code); } catch (e) { } renderPages(); });
    conn.on('data', d => { if (d && (d.type === 'ack' || d.type === 'nack') && answer) answer(d); });
    conn.on('close', () => { setStatus('Disconnected · tap to reconnect', 'err'); if (answer) answer({ type: 'closed' }); renderPages(); });
    conn.on('error', e => { setStatus('Connection error · tap to retry', 'err'); console.error(e); });
  });
  peer.on('error', e => { console.error(e); setStatus('Connection error · tap to retry', 'err'); toast(e.type === 'peer-unavailable' ? 'No computer found with that code. Open Scan in KAM PDFs first.' : 'Connection problem: ' + e.type, 4500); });
}
/* A page counts as sent only when the computer says it has it. It used to be marked sent after
   30 seconds whatever had happened, so a page lost on the way looked delivered, and was never
   sent again. Now a page that is not confirmed stays unsent, and sending stops to say so; the
   computer ignores a page it already has, so sending again never makes a duplicate. */
let answer = null;
async function sendAll() {
  if (!conn || !conn.open) return toast('Not connected to the computer');
  const todo = pages.filter(p => !p.sent); if (!todo.length) return toast('All pages already sent');
  $('#btnSend').disabled = true; const prog = $('#prog'); prog.style.display = 'block';
  let sent = 0, problem = '';
  for (let k = 0; k < todo.length; k++) {
    const p = todo[k]; const buf = await p.blob.arrayBuffer();
    const reply = new Promise(res => { answer = d => { if (d.type === 'closed' || d.id === p.id) { answer = null; res(d); } }; });
    conn.send({ type: 'page', id: p.id, i: pages.indexOf(p), n: todo.length, k, w: p.w, h: p.h, data: buf });
    setStatus(`Sending ${k + 1} of ${todo.length}…`, 'ok');
    const d = await Promise.race([reply, new Promise(r => setTimeout(() => r({ type: 'timeout' }), window.KAM_SEND_WAIT || 45000))]);
    answer = null;
    if (d.type !== 'ack') {
      problem = d.type === 'nack' ? `The computer could not add page ${pages.indexOf(p) + 1}${d.reason ? ' (' + d.reason + ')' : ''}.`
        : d.type === 'closed' ? 'The connection to the computer dropped.' : `Page ${pages.indexOf(p) + 1} did not arrive.`;
      break;
    }
    p.sent = true; sent++; Store.save(); renderPages();
    prog.firstElementChild.style.width = Math.round((k + 1) / todo.length * 100) + '%';
  }
  setTimeout(() => { prog.style.display = 'none'; prog.firstElementChild.style.width = '0'; }, 800);
  if (problem) {
    setStatus(conn && conn.open ? 'Connected to computer' : 'Disconnected · tap to reconnect', conn && conn.open ? 'ok' : 'err');
    toast(`${problem} ${sent ? `${sent} page${sent > 1 ? 's were' : ' was'} sent; the rest are` : 'The pages are'} still here: tap Send to try again.`, 6000);
  } else {
    setStatus('Connected to computer', 'ok');
    toast(`Sent ${sent} page${sent > 1 ? 's' : ''} to your computer`);
  }
  renderPages();
}
$('#btnSend').onclick = sendAll;
$('#status').onclick = () => { $('#pair').hidden = false; $('#codeIn').value = connectedCode || $('#codeIn').value; setTimeout(() => $('#codeIn').focus(), 50); };
$('#btnPair').onclick = () => connect($('#codeIn').value);
$('#codeIn').addEventListener('keydown', e => { if (e.key === 'Enter') connect($('#codeIn').value); });
$('#btnPairClose').onclick = () => $('#pair').hidden = true;

/* ---------- PDF on the phone ---------- */
async function buildPdf() {
  const { PDFDocument } = PDFLib; const doc = await PDFDocument.create();
  for (const p of pages) {
    const img = await doc.embedJpg(await p.blob.arrayBuffer());
    const sc = 842 / Math.max(p.w, p.h); const w = p.w * sc, h = p.h * sc;
    doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  doc.setTitle('Scan'); doc.setProducer('KAM PDFs');
  return new Blob([await doc.save()], { type: 'application/pdf' });
}
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
$('#btnPdf').onclick = async () => {
  toast('Building PDF…'); const blob = await buildPdf();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `Scan ${stamp()}.pdf`; document.body.appendChild(a); a.click(); a.remove();
  toast('PDF saved to your downloads');
};
$('#btnShare').onclick = async () => {
  const blob = await buildPdf(); const file = new File([blob], `Scan ${stamp()}.pdf`, { type: 'application/pdf' });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: 'Scan' }); else await navigator.share({ title: 'Scan', text: 'Scanned with KAM PDFs' }); }
  catch (e) { if (e.name !== 'AbortError') toast('Sharing not available here. Use Save PDF instead.'); }
};

/* ---------- start ---------- */
const hashCode = location.hash.replace('#', '').trim();
if (hashCode.length === 6) connect(hashCode);
else { try { const c = localStorage.getItem('kam-scan-code'); if (c) $('#codeIn').value = c; } catch (e) { } }
renderPages();
// the pages taken before this page was last closed or reloaded
Store.load().then(kept => {
  if (!kept.length) return;
  for (const p of kept) pages.push({ id: p.id, blob: p.blob, url: URL.createObjectURL(p.blob), w: p.w, h: p.h, sent: !!p.sent });
  renderPages();
  const unsent = kept.filter(p => !p.sent).length;
  toast(unsent ? `${unsent} page${unsent > 1 ? 's' : ''} from before ${unsent > 1 ? 'are' : 'is'} still here, ready to send.` : 'Your pages from before are still here.', 4000);
});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => { });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !pages.length) location.reload(); hadController = false; });
}
