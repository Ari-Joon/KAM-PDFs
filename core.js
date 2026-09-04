/* Free PDF Editor — core: state, loading, rendering, navigation */
'use strict';
const { PDFDocument, rgb, degrees, StandardFonts, BlendMode, LineCapStyle } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

/* Bumped with each release, and shown in the Help tab. Because it lives in the code that
   is actually running, it tells you which version you have rather than which is newest. */
const KAM_VERSION = '1.13.0';

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
  if (typeof noteChange === 'function') noteChange();
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
  drawAnnots(ctx, state.pageIds[i], off._scale, null, { spell: false, marks: false });
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

/* ---------- version, and updating in place ----------
   Two questions, kept separate: is there a newer release (version.json on the site, or
   GitHub's own release list if that is unreachable), and can this copy replace itself
   (only if it is served over http and has a service worker; a copy unzipped into a folder
   has to be replaced by hand). */
const KAM_REPO = 'Ari-Joon/KAM-PDFs';
const KAM_RELEASES = 'https://github.com/' + KAM_REPO + '/releases/latest';
const CHECK_EVERY = 6 * 60 * 60 * 1000;
let pendingUpdate = null;

function showVersion() {
  const el = $('#appVersion'); if (el) el.textContent = 'v' + KAM_VERSION;
}
// 1.10.0 is older than 1.9.0 if you compare as text, so compare number by number.
function versionIsNewer(a, b) {
  const A = String(a).split('.'), B = String(b).split('.');
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = parseInt(A[i], 10) || 0, y = parseInt(B[i], 10) || 0;
    if (x !== y) return x > y;
  }
  return false;
}
const canReplaceItself = () => 'serviceWorker' in navigator && location.protocol.startsWith('http');

async function latestRelease() {
  // The site's own file first: same origin, no rate limit, and it still answers if GitHub's
  // API is blocked on this network.
  if (location.protocol.startsWith('http')) {
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        if (j && j.version) return { version: String(j.version), notes: j.notes || '', url: j.url || KAM_RELEASES };
      }
    } catch (e) { /* fall through to GitHub */ }
  }
  const r = await fetch('https://api.github.com/repos/' + KAM_REPO + '/releases/latest',
    { cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('GitHub replied ' + r.status);
  const j = await r.json();
  const v = String(j.tag_name || '').replace(/^v/i, '');
  if (!v) throw new Error('no version in the reply');
  return { version: v, notes: String(j.name || '').replace(/^KAM PDFs v[\d.]+\s*-\s*/i, ''), url: j.html_url || KAM_RELEASES };
}

function showUpdateBar(info) {
  pendingUpdate = info;
  const bar = $('#updateBar'); if (!bar) return;
  $('#updateMsg').textContent = 'KAM PDFs ' + info.version + ' is available'
    + (info.notes ? ' — ' + info.notes : '') + '. It is free, as always.';
  $('#updateNotes').href = info.url;
  $('#btnUpdateNow').textContent = canReplaceItself() ? 'Update now' : 'Get the update';
  $('#btnUpdateNow').disabled = false;
  bar.hidden = false;
}
function hideUpdateBar() { const b = $('#updateBar'); if (b) b.hidden = true; }

async function checkForUpdate(auto) {
  const btn = $('#btnUpdate');
  if (!auto && btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  try {
    if (!navigator.onLine) { if (!auto) toast('You are offline, so there is nothing to check against yet.', 4000); return; }
    const info = await latestRelease();
    try { localStorage.setItem('kam-update-checked', String(Date.now())); } catch (e) { }
    if (versionIsNewer(info.version, KAM_VERSION)) {
      let skipped = null; try { skipped = localStorage.getItem('kam-skip-version'); } catch (e) { }
      if (auto && skipped === info.version) return;   // they said not now, and nothing newer has landed since
      showUpdateBar(info);
    } else {
      hideUpdateBar();
      if (!auto) toast('You are on the latest version (v' + KAM_VERSION + ').', 4000);
    }
  } catch (e) {
    console.warn('update check failed', e);
    if (!auto) toast('Could not check for updates: ' + e.message, 5000);
  } finally {
    if (!auto && btn) { btn.disabled = false; btn.textContent = 'Check for updates'; }
  }
}

async function applyUpdate() {
  const b = $('#btnUpdateNow');
  const url = (pendingUpdate && pendingUpdate.url) || KAM_RELEASES;
  if (!canReplaceItself()) {
    // Running from a folder on disk: it cannot rewrite its own files, so send them to the download.
    window.open(url, '_blank', 'noopener');
    toast('Download the new zip and unzip it over your KAM PDFs folder. Your settings and working copy are kept.', 9000);
    return;
  }
  if (!navigator.onLine) { toast('You are offline. Reconnect and try again.', 4000); return; }
  // Reloading throws away anything unsaved, so keep a working copy first and say so if we cannot.
  if (state.doc && state.dirty) {
    let kept = false;
    if (typeof saveDraftNow === 'function') { try { kept = await saveDraftNow(); } catch (e) { } }
    if (!kept && !confirm('Updating reloads KAM PDFs, and this document has changes that are not saved.\n\nSave the PDF first, or press OK to update anyway.')) return;
  }
  if (b) { b.disabled = true; b.textContent = 'Updating…'; }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      await reg.update();
      if (reg.waiting) reg.waiting.postMessage({ type: 'skipWaiting' });
    }
    // Clear the offline copy, or the reload would just serve the old files back.
    if (window.caches) { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); }
    location.reload();
  } catch (e) {
    console.error(e);
    toast('Could not update: ' + e.message + '. You can download it instead.', 6000);
    if (b) { b.disabled = false; b.textContent = 'Update now'; }
  }
}

function laterOnUpdate() {
  if (pendingUpdate) { try { localStorage.setItem('kam-skip-version', pendingUpdate.version); } catch (e) { } }
  hideUpdateBar();
  toast('Hidden until the next version. "Check for updates" in the Document tab brings it back.', 5000);
}

function maybeAutoCheck() {
  if (!navigator.onLine) return;
  let last = 0; try { last = parseInt(localStorage.getItem('kam-update-checked'), 10) || 0; } catch (e) { }
  if (Date.now() - last < CHECK_EVERY) return;
  checkForUpdate(true);
}

showVersion();
$('#btnUpdate').onclick = () => checkForUpdate(false);
$('#btnUpdateNow').onclick = applyUpdate;
$('#btnUpdateLater').onclick = laterOnUpdate;
// Let the app finish opening before going near the network.
setTimeout(maybeAutoCheck, 4000);
window.addEventListener('online', () => setTimeout(maybeAutoCheck, 2000));
document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeAutoCheck(); });

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
function pushUndo(entry) { state.undo.push(entry); if (state.undo.length > 25) state.undo.shift(); state.redo = []; state.dirty = true; if (typeof noteChange === 'function') noteChange(); }
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
