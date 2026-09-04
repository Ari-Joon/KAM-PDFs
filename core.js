/* Free PDF Editor — core: state, loading, rendering, navigation */
'use strict';
const { PDFDocument, rgb, degrees, StandardFonts, BlendMode, LineCapStyle } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

/* Bumped with each release, and shown in the Help tab. Because it lives in the code that
   is actually running, it tells you which version you have rather than which is newest. */
const KAM_VERSION = '1.11.0';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const state = {
  doc: null,            // pdf-lib document: source of truth for page structure
  pdfjs: null,          // pdf.js document used for rendering (rebuilt after structural changes)
  bytes: null,          // bytes of the current structure (what pdf.js is showing)
  pageIds: [],          // stable id per page position (survives reorder)
  annots: {},           // pageId -> [annotation]
  cur: 0,
  selectedPages: new Set(),
  zoom: 1, fit: 'width',      // 'width' | 'page' | '' (manual)
  redo: [], dirty: false, clipboard: null,
  tool: 'select',
  selected: null,
  undo: [],             // unified undo stack
  thumbCache: new Map(),
  fileName: 'document.pdf',
  nextId: 1,
  renderTask: null,
  pageSize: { w: 0, h: 0 },
};

const defaults = { color: '#e11d48', fill: '#ffff00', fillOn: false, width: 2, size: 16, font: 'Helvetica', bold: false, opacity: 1 };

/* ---------- small utilities ---------- */
let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.style.display = 'none', ms);
}
function busy(on) { $('#busy').classList.toggle('show', on); }
function uid() { return state.nextId++; }
function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); }
function downloadBytes(bytes, name, type = 'application/pdf') {
  const blob = new Blob([bytes], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
function outName(suffix = '-edited') { return state.fileName.replace(/\.pdf$/i, '') + suffix + '.pdf'; }
function readFile(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(file); }); }
function readDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
function showModal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.add('show'); }
function hideModal() { $('#modal').classList.remove('show'); $('#modalBox').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') hideModal(); });
function targetPages() { // pages that sidebar actions apply to
  const s = [...state.selectedPages].filter(i => i < state.pageIds.length).sort((a, b) => a - b);
  return s.length ? s : [state.cur];
}

/* ---------- opening / rebuilding ---------- */
async function openBytes(bytes, name) {
  busy(true);
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    if (doc.isEncrypted) throw new Error('This PDF is password-protected. Remove the password first (e.g. open it and "Print to PDF").');
    if (doc.getPageCount() === 0) throw new Error('The PDF has no pages.');
    state.doc = doc; state.fileName = name || 'document.pdf';
    state.pageIds = doc.getPages().map(() => uid());
    state.annots = {}; state.undo = []; state.thumbCache.clear();
    state.cur = 0; state.selectedPages.clear(); state.selected = null;
    if (typeof resetSaveTarget === 'function') resetSaveTarget();
    await rebuild();
    $('#empty').classList.add('hide');
    loadFormFields(); loadMetadata();
    toast(`Opened ${state.fileName} (${doc.getPageCount()} pages)`);
  } catch (e) { console.error(e); toast('Could not open PDF: ' + e.message, 6000); }
  busy(false);
}

async function newBlank() {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  const bytes = await doc.save();
  await openBytes(bytes, 'untitled.pdf');
}

// Serialize the working document and reload it into pdf.js so the view matches.
async function rebuild() {
  const bytes = await state.doc.save();
  state.bytes = bytes;
  if (state.pdfjs) { try { state.pdfjs.destroy(); } catch (e) { } }
  state.pdfjs = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  if (state.cur >= state.pageIds.length) state.cur = Math.max(0, state.pageIds.length - 1);
  state.selected = null;
  await renderPage();
  renderThumbs();
  updatePager();
}

/* ---------- main page rendering ---------- */
async function renderPage() {
  const canvas = $('#pageCanvas'), overlay = $('#overlay'), wrap = $('#pageWrap');
  if (!state.pdfjs || !state.pageIds.length) { wrap.style.width = wrap.style.height = '0px'; return; }
  const pdf = state.pdfjs;
  const page = await pdf.getPage(state.cur + 1);
  if (pdf !== state.pdfjs) return;
  const base = page.getViewport({ scale: 1 });
  state.pageSize = { w: base.width, h: base.height };
  if (state.fit) {
    const availW = $('#viewport').clientWidth - 40, availH = $('#viewport').clientHeight - 40;
    const z = state.fit === 'page' ? Math.min(availW / base.width, availH / base.height) : availW / base.width;
    state.zoom = availW > 100 ? Math.max(0.1, Math.min(8, z)) : 1;
  }
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: state.zoom * dpr });
  const cssW = vp.width / dpr, cssH = vp.height / dpr;
  canvas.width = overlay.width = Math.floor(vp.width); canvas.height = overlay.height = Math.floor(vp.height);
  for (const c of [canvas, overlay]) { c.style.width = cssW + 'px'; c.style.height = cssH + 'px'; }
  wrap.style.width = cssW + 'px'; wrap.style.height = cssH + 'px';
  if (state.renderTask) { try { state.renderTask.cancel(); } catch (e) { } }
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
  state.renderTask = task;
  try { await task.promise; } catch (e) { if (e && e.name !== 'RenderingCancelledException') console.error(e); }
  if (state.renderTask === task) state.renderTask = null;
  $('#zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
  drawOverlay();
  positionTextEditor();
}

/* ---------- thumbnails ---------- */
let thumbQueue = [], thumbBusy = false;
function renderThumbs() {
  const cont = $('#thumbs'); cont.innerHTML = ''; thumbQueue = [];
  const n = state.pageIds.length;
  $('#pageCountLabel').textContent = n ? `(${n})` : '';
  for (let i = 0; i < n; i++) {
    const div = document.createElement('div'); div.className = 'thumb'; div.draggable = true; div.dataset.i = i;
    const c = document.createElement('canvas'); c.width = 140; c.height = 180; div.appendChild(c);
    const num = document.createElement('div'); num.className = 'num'; num.textContent = i + 1; div.appendChild(num);
    div.addEventListener('click', e => {
      if (e.ctrlKey || e.metaKey) { state.selectedPages.has(i) ? state.selectedPages.delete(i) : state.selectedPages.add(i); }
      else if (e.shiftKey) { const a = Math.min(i, state.cur), b = Math.max(i, state.cur); for (let k = a; k <= b; k++) state.selectedPages.add(k); }
      else { state.selectedPages.clear(); state.selectedPages.add(i); goTo(i); }
      updateThumbClasses();
    });
    div.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; });
    div.addEventListener('dragover', e => { e.preventDefault(); div.classList.add('dragover'); });
    div.addEventListener('dragleave', () => div.classList.remove('dragover'));
    div.addEventListener('drop', e => {
      e.preventDefault(); div.classList.remove('dragover');
      const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (!isNaN(from) && from !== i) movePage(from, i);
    });
    cont.appendChild(div);
    thumbQueue.push({ i, c });
  }
  updateThumbClasses();
  pumpThumbs();
}
function updateThumbClasses() {
  $$('.thumb').forEach(d => {
    const i = +d.dataset.i;
    d.classList.toggle('current', i === state.cur);
    d.classList.toggle('selected', state.selectedPages.has(i));
  });
}
async function pumpThumbs() {
  if (thumbBusy) return; thumbBusy = true;
  while (thumbQueue.length) {
    const { i, c } = thumbQueue.shift();
    if (!c.isConnected) continue;
    try { await renderThumb(i, c); } catch (e) { console.warn(e); }
  }
  thumbBusy = false;
}
async function renderThumb(i, c) {
  const pdf = state.pdfjs; if (!pdf || i >= state.pageIds.length) return;
  const key = state.pageIds[i] + ':' + state.doc.getPage(i).getRotation().angle;
  let off = state.thumbCache.get(key);
  if (!off) {
    const page = await pdf.getPage(i + 1);
    if (pdf !== state.pdfjs) return;
    const vp1 = page.getViewport({ scale: 1 });
    const sc = 280 / vp1.width;
    const vp = page.getViewport({ scale: sc });
    off = document.createElement('canvas'); off.width = Math.floor(vp.width); off.height = Math.floor(vp.height);
    await page.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
    off._scale = sc;
    if (state.thumbCache.size > 400) state.thumbCache.delete(state.thumbCache.keys().next().value);
    state.thumbCache.set(key, off);
  }
  c.width = off.width; c.height = off.height;
  const ctx = c.getContext('2d'); ctx.drawImage(off, 0, 0);
  drawAnnots(ctx, state.pageIds[i], off._scale, null, { spell: false });
}
let thumbRefreshTimer;
function refreshThumb(i) {
  clearTimeout(thumbRefreshTimer);
  thumbRefreshTimer = setTimeout(() => {
    const d = $(`.thumb[data-i="${i}"] canvas`); if (d) renderThumb(i, d);
  }, 200);
}

/* ---------- navigation & zoom ---------- */
function updatePager() {
  $('#pageNum').value = state.pageIds.length ? state.cur + 1 : 0;
  $('#pageTotal').textContent = '/ ' + state.pageIds.length;
}
async function goTo(i) {
  if (!state.pageIds.length) return;
  i = Math.max(0, Math.min(state.pageIds.length - 1, i));
  commitTextEdit();
  state.cur = i; state.selected = null;
  updatePager(); updateThumbClasses(); updateProps();
  const t = $(`.thumb[data-i="${i}"]`); if (t) t.scrollIntoView({ block: 'nearest' });
  if (typeof refreshLayers === 'function') refreshLayers(true);
  await renderPage();
}
function setZoom(z, fit = '') {
  state.fit = fit;
  if (!fit) state.zoom = Math.max(0.1, Math.min(8, z));
  commitTextEdit();
  renderPage();
}
$('#btnZoomIn').onclick = () => setZoom(state.zoom * 1.25);
$('#btnZoomOut').onclick = () => setZoom(state.zoom / 1.25);
$('#btnFit').onclick = () => setZoom(1, 'width');
$('#btnFitPage').onclick = () => setZoom(1, 'page');
$('#btnPrev').onclick = () => goTo(state.cur - 1);
$('#btnNext').onclick = () => goTo(state.cur + 1);
$('#pageNum').addEventListener('change', e => goTo(parseInt(e.target.value, 10) - 1));
$('#viewport').addEventListener('wheel', e => {
  if (!e.ctrlKey) return; e.preventDefault();
  setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.fit) renderPage(); }, 150); });
window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- file inputs & drag/drop ---------- */
$('#btnOpen').onclick = $('#btnOpen2').onclick = () => $('#fileInput').click();
$('#btnNew').onclick = $('#btnNew2').onclick = () => newBlank();
$('#fileInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) await openBytes(await readFile(f), f.name);
});
async function handleDroppedFiles(files) {
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const imgs = files.filter(f => f.type.startsWith('image/'));
  if (pdfs.length) {
    if (!state.doc) { await openBytes(await readFile(pdfs[0]), pdfs[0].name); if (pdfs.length > 1) await mergeFiles(pdfs.slice(1)); }
    else if (confirm('Append the dropped PDF(s) to the current document?\n(Cancel to open instead and discard current edits.)')) await mergeFiles(pdfs);
    else await openBytes(await readFile(pdfs[0]), pdfs[0].name);
  }
  if (imgs.length) { if (!state.doc) { await newBlank(); await addImagePages(imgs); await deletePages([0]); } else await addImagePages(imgs); }
}
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#drop').classList.add('show'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('show'); } });
window.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', e => {
  dragDepth = 0; $('#drop').classList.remove('show');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault(); handleDroppedFiles([...e.dataTransfer.files]);
});

/* ---------- version, and forcing an update ---------- */
function showVersion() {
  const el = $('#appVersion'); if (el) el.textContent = 'v' + KAM_VERSION;
}
async function checkForUpdate() {
  const btn = $('#btnUpdate'); if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  try {
    if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) {
      toast('This copy runs from a file, so it updates when you replace the folder.', 5000);
    } else {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) { toast('No update service registered. Reload the page.', 4000); }
      else {
        await reg.update();
        if (reg.installing || reg.waiting) {
          toast('A newer version is downloading. Reloading…', 4000);
          if (reg.waiting) reg.waiting.postMessage({ type: 'skipWaiting' });
          setTimeout(() => location.reload(), 1200);
        } else {
          toast('You are on the latest version (v' + KAM_VERSION + ').', 4000);
        }
      }
    }
  } catch (e) { console.error(e); toast('Could not check for updates: ' + e.message, 5000); }
  if (btn) { btn.disabled = false; btn.textContent = 'Check for updates'; }
}
showVersion();
$('#btnUpdate').onclick = checkForUpdate;

/* ---------- light / dark theme ---------- */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  $('#btnTheme').textContent = t === 'light' ? '🌙' : '☀';
  $('#btnTheme').title = t === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
  const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.content = t === 'light' ? '#ffffff' : '#1e1f24';
  try { localStorage.setItem('kam-theme', t); } catch (e) { }
}
applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
$('#btnTheme').onclick = () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');

/* ---------- tabs ---------- */
$$('.tabs button').forEach(b => b.onclick = () => {
  $$('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
});

/* ---------- undo ---------- */
function pushUndo(entry) { state.undo.push(entry); if (state.undo.length > 25) state.undo.shift(); state.redo = []; state.dirty = true; }
function snapshotAnnots(pageIds) {
  const pages = {}; for (const id of pageIds) pages[id] = JSON.stringify(state.annots[id] || []);
  return { kind: 'annot', pages };
}
function pushAnnotUndo(pageId) { pushUndo(snapshotAnnots([pageId])); }
function pushStructUndo() {
  pushUndo({ kind: 'struct', bytes: state.bytes, pageIds: [...state.pageIds], annots: JSON.parse(JSON.stringify(state.annots)), cur: state.cur });
}
async function undo() {
  commitTextEdit();
  const e = state.undo.pop(); if (!e) { toast('Nothing to undo'); return; }
  if (e.kind === 'annot') {
    state.redo.push(snapshotAnnots(Object.keys(e.pages)));
    for (const id in e.pages) state.annots[id] = JSON.parse(e.pages[id]);
    state.selected = null; drawOverlay(); refreshThumb(state.cur); updateProps();
  } else {
    busy(true);
    try {
      state.doc = await PDFDocument.load(e.bytes, { ignoreEncryption: true, updateMetadata: false });
      state.pageIds = e.pageIds; state.annots = e.annots; state.cur = e.cur;
      state.selectedPages.clear(); state.thumbCache.clear();
      await rebuild(); loadFormFields(); loadMetadata();
    } catch (err) { console.error(err); toast('Undo failed: ' + err.message); }
    busy(false);
  }
}
function redo() {
  commitTextEdit();
  const e = state.redo.pop(); if (!e) { toast('Nothing to redo'); return; }
  state.undo.push(snapshotAnnots(Object.keys(e.pages)));
  for (const id in e.pages) state.annots[id] = JSON.parse(e.pages[id]);
  state.selected = null; drawOverlay(); refreshThumb(state.cur); updateProps();
}
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;


/* ---------- install as an app (when served over https) ---------- */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('#btnInstall').hidden = false; });
$('#btnInstall').onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('#btnInstall').hidden = true; };
window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; toast('KAM PDFs installed. Find it in your Start menu.'); });
