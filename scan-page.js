/* KAM PDFs - the phone scanner page. Its own file so the page can forbid inline scripts. */
'use strict';
const $ = s => document.querySelector(s);
const pages = [];          // {blob, url, w, h, sent}
let conn = null, peer = null, connectedCode = '';
let toastT; function toast(m, ms = 2500) { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => t.style.display = 'none', ms); }
function setStatus(text, cls) { const s = $('#status'); s.textContent = text; s.className = 'pill ' + (cls || ''); }

/* ---------- pages ---------- */
function renderPages() {
  const cont = $('#pages'); cont.innerHTML = '';
  $('#pagesEmpty').style.display = pages.length ? 'none' : '';
  pages.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'page' + (p.sent ? ' sent' : '');
    d.innerHTML = `<img src="${p.url}" alt=""><span class="n">${i + 1}</span><button class="x" title="Remove" aria-label="Remove"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button><div class="mv"><button data-d="-1">‹</button><button data-d="1">›</button></div>`;
    d.querySelector('.x').onclick = () => { URL.revokeObjectURL(p.url); pages.splice(i, 1); renderPages(); };
    d.querySelectorAll('.mv button').forEach(b => b.onclick = () => { const j = i + (+b.dataset.d); if (j < 0 || j >= pages.length) return; [pages[i], pages[j]] = [pages[j], pages[i]]; renderPages(); });
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
      onDone: ({ blob, canvas }) => { pages.push({ blob, url: URL.createObjectURL(blob), w: canvas.width, h: canvas.height, sent: false }); res(); },
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
    conn.on('data', d => { if (d && d.type === 'ack') ackResolve && ackResolve(d.i); });
    conn.on('close', () => { setStatus('Disconnected · tap to reconnect', 'err'); renderPages(); });
    conn.on('error', e => { setStatus('Connection error · tap to retry', 'err'); console.error(e); });
  });
  peer.on('error', e => { console.error(e); setStatus('Connection error · tap to retry', 'err'); toast(e.type === 'peer-unavailable' ? 'No computer found with that code. Open Scan in KAM PDFs first.' : 'Connection problem: ' + e.type, 4500); });
}
let ackResolve = null;
async function sendAll() {
  if (!conn || !conn.open) return toast('Not connected to the computer');
  const todo = pages.filter(p => !p.sent); if (!todo.length) return toast('All pages already sent');
  $('#btnSend').disabled = true; const prog = $('#prog'); prog.style.display = 'block';
  for (let k = 0; k < todo.length; k++) {
    const p = todo[k]; const buf = await p.blob.arrayBuffer();
    const i = pages.indexOf(p);
    const ack = new Promise(res => { ackResolve = res; });
    conn.send({ type: 'page', i, n: todo.length, k, w: p.w, h: p.h, data: buf });
    setStatus(`Sending ${k + 1} of ${todo.length}…`, 'ok');
    await Promise.race([ack, new Promise(r => setTimeout(r, 30000))]);
    p.sent = true; prog.firstElementChild.style.width = Math.round((k + 1) / todo.length * 100) + '%';
  }
  setStatus('Connected to computer', 'ok'); toast(`Sent ${todo.length} page${todo.length > 1 ? 's' : ''} to your computer`);
  setTimeout(() => { prog.style.display = 'none'; prog.firstElementChild.style.width = '0'; }, 800);
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
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => { });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !pages.length) location.reload(); hadController = false; });
}
