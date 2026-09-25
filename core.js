/* Free PDF Editor — core: state, loading, rendering, navigation */
'use strict';
const { PDFDocument, rgb, degrees, StandardFonts, BlendMode, LineCapStyle } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

/* Bumped with each release, and shown in the Help tab. Because it lives in the code that
   is actually running, it tells you which version you have rather than which is newest. */
const KAM_VERSION = '1.16.1';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const state = {
  doc: null,            // pdf-lib document: source of truth for page structure
  pdfjs: null,          // pdf.js document used for rendering (rebuilt after structural changes)
  bytes: null,          // bytes of the current structure (what pdf.js is showing)
  pageIds: [],          // stable id per page position (survives reorder)
  annots: {},           // pageId -> [annotation]
  images: {},           // picture id -> { src, fmt, iw, ih }: pictures kept once, marks point at them
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
// "report-edited.pdf" saved again stays "report-edited.pdf", not "report-edited-edited.pdf"
function outName(suffix = '-edited') {
  const base = state.fileName.replace(/\.pdf$/i, '');
  return (suffix === '-edited' ? base.replace(/-edited$/i, '') : base) + suffix + '.pdf';
}
function readFile(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(file); }); }
function readDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
let modalCloseHook = null;
function showModal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.add('show'); }
function hideModal() {
  $('#modal').classList.remove('show'); $('#modalBox').innerHTML = '';
  const h = modalCloseHook; modalCloseHook = null; if (h) h();
}
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') hideModal(); });
const modalOpen = () => $('#modal').classList.contains('show');

/* A dialog with real choices, where confirm() only has OK and Cancel, and whose Cancel
   sometimes meant "throw my work away". Resolves with the key of the button pressed, or
   'cancel' for Escape or a click outside. Built with textContent, never HTML, because the
   message often quotes a file name. */
function choose({ title, message, buttons }) {
  return new Promise(resolve => {
    const box = $('#modalBox'); box.innerHTML = '';
    const h = document.createElement('h3'); h.textContent = title; box.appendChild(h);
    if (message) { const p = document.createElement('p'); p.className = 'choice-msg'; p.textContent = message; box.appendChild(p); }
    const row = document.createElement('div'); row.className = 'row choice-row';
    let done = false;
    const finish = key => {
      if (done) return; done = true;
      document.removeEventListener('keydown', onKey, true);
      modalCloseHook = null; hideModal(); resolve(key);
    };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish('cancel'); } };
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label; el.dataset.key = b.key;
      if (b.primary) el.className = 'primary';
      el.onclick = () => finish(b.key);
      row.appendChild(el);
    }
    box.appendChild(row);
    document.addEventListener('keydown', onKey, true);
    modalCloseHook = () => finish('cancel');
    $('#modal').classList.add('show');
    const first = row.querySelector('.primary') || row.firstChild;
    setTimeout(() => first && first.focus(), 0);
  });
}

/* Before anything replaces the open document: if it has changes that are not saved, ask.
   Returns true when it is fine to go ahead. Opening a file used to just do it, and three
   seconds later the working copy was overwritten too, so the work could not be got back. */
async function keepOrDiscard(what) {
  if (!state.doc || !state.dirty) return true;
  const c = await choose({
    title: `Save changes to “${state.fileName}”?`,
    message: `You have changes that are not saved. If you ${what} without saving, they will be lost.`,
    buttons: [{ key: 'save', label: 'Save', primary: true }, { key: 'discard', label: "Don't save" }, { key: 'cancel', label: 'Cancel' }],
  });
  if (c === 'discard') return true;
  if (c === 'save') { await savePdf(false); return !state.dirty; }
  return false;
}
function targetPages() { // pages that sidebar actions apply to
  const s = [...state.selectedPages].filter(i => i < state.pageIds.length).sort((a, b) => a - b);
  return s.length ? s : [state.cur];
}

/* ---------- opening / rebuilding ---------- */
/* Asks for the password of a protected PDF, in the app's own dialog (never stored). Resolves to
   what was typed, or null for Cancel. `tries` is how many passwords have already been wrong. */
function askPassword(name) {
  return tries => new Promise(resolve => {
    const wasBusy = $('#busy').classList.contains('show'); busy(false);
    const box = $('#modalBox'); box.innerHTML = '';
    const h = document.createElement('h3'); h.textContent = 'This PDF is locked with a password';
    const p = document.createElement('p'); p.className = 'choice-msg';
    p.textContent = tries ? 'That password is not right. Check it and try again.' : `Enter the password to open “${name}”. It is only used here, on this computer, and is not kept.`;
    const input = document.createElement('input'); input.type = 'password'; input.id = 'pdfPassword'; input.autocomplete = 'off'; input.style.width = '100%';
    const row = document.createElement('div'); row.className = 'row choice-row';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    const ok = document.createElement('button'); ok.textContent = 'Open'; ok.className = 'primary';
    row.append(cancel, ok); box.append(h, p, input, row);
    let done = false;
    const finish = v => { if (done) return; done = true; modalCloseHook = null; hideModal(); if (wasBusy) busy(true); resolve(v); };
    ok.onclick = () => finish(input.value);
    cancel.onclick = () => finish(null);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(input.value); } if (e.key === 'Escape') { e.preventDefault(); finish(null); } e.stopPropagation(); });
    modalCloseHook = () => finish(null);
    $('#modal').classList.add('show');
    setTimeout(() => input.focus(), 0);
  });
}

async function openBytes(bytes, name) {
  busy(true);
  try {
    // a password-protected PDF is unlocked here (crypt.js), asking for its password if it needs one
    const { doc, locked } = await KamCrypt.open(bytes, askPassword(name || 'this PDF'));
    if (doc.getPageCount() === 0) throw new Error('The PDF has no pages.');
    state.doc = doc; state.fileName = name || 'document.pdf';
    state.pageIds = doc.getPages().map(() => uid());
    state.annots = {}; state.images = {}; state.undo = []; state.redo = []; state.thumbCache.clear();
    if (state.ocr) state.ocr = {};
    state.cur = 0; state.selectedPages.clear(); state.selected = null;
    // a document fresh off the disk has nothing unsaved, whatever the last one had
    state.rev = state.savedRev = newRev(); state.dirty = false;
    if (typeof pdfTextClearPick === 'function') pdfTextClearPick();
    if (typeof resetSaveTarget === 'function') resetSaveTarget();
    await rebuild();
    $('#empty').classList.add('hide');
    loadFormFields(); loadMetadata();
    if (locked === 'user') toast(`Unlocked ${state.fileName}. The copy you save will open without a password.`, 6000);
    else if (locked === 'owner') toast(`${state.fileName} was protected against changes. It opens for editing here, and the copy you save is not protected.`, 7000);
    else toast(`Opened ${state.fileName} (${doc.getPageCount()} pages)`);
  } catch (e) {
    if (e && e.cancelled) toast(`${name || 'The PDF'} was not opened: it needs its password.`, 5000);
    else { console.error(e); toast('Could not open PDF: ' + e.message, 6000); }
  }
  busy(false);
}

async function newBlank() {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  const bytes = await doc.save();
  await openBytes(bytes, 'untitled.pdf');
}

/* One pdf.js worker for every document: the one being edited, and the one-page copies with
   text edits applied. Starting a worker per document loaded all of pdf.js again each time. */
function sharedPdfWorker() {
  if (!sharedPdfWorker.w || sharedPdfWorker.w.destroyed) sharedPdfWorker.w = new pdfjsLib.PDFWorker();
  return sharedPdfWorker.w;
}

// Serialize the working document and reload it into pdf.js so the view matches.
async function rebuild() {
  const bytes = await state.doc.save();
  state.bytes = bytes;
  // Let go of the previous copy a little later rather than at once: a save, a thumbnail or a
  // search already under way may still be reading it, and pulling it from under them made
  // them fail with "Cannot read properties of null".
  const old = state.pdfjs;
  if (old) setTimeout(() => { try { old.destroy(); } catch (e) { } }, 15000);
  // fontExtraProperties keeps each font's program and character maps, which the text engine
  // (content.js) needs to edit text in the document's own fonts
  state.pdfjs = await pdfjsLib.getDocument({ data: bytes.slice(), fontExtraProperties: true, worker: sharedPdfWorker() }).promise;
  if (state.cur >= state.pageIds.length) state.cur = Math.max(0, state.pageIds.length - 1);
  state.selected = null;
  if (typeof KamContent !== 'undefined') KamContent.reset();
  if (typeof KamPatch !== 'undefined') KamPatch.reset();
  if (typeof KamLinks !== 'undefined') KamLinks.reset();
  await KamView.load();
  renderThumbs();
  updatePager();
  if (typeof noteChange === 'function') noteChange();
}

/* ---------- drawing pages: see viewer.js ----------
   These names stay because the rest of the app calls them. */
async function renderPage() { try { await KamView.invalidate(); } catch (e) { console.error(e); } }
function renderThumbs() { KamView.buildThumbs(); }
function refreshThumb(i) { KamView.refreshThumb(i); }
function updateThumbClasses() {
  $$('.thumb').forEach(d => {
    const i = +d.dataset.i;
    d.classList.toggle('current', i === state.cur);
    d.classList.toggle('selected', state.selectedPages.has(i));
  });
}

/* ---------- navigation & zoom ---------- */
function updatePager() {
  $('#pageNum').value = state.pageIds.length ? state.cur + 1 : 0;
  $('#pageTotal').textContent = '/ ' + state.pageIds.length;
}
async function goTo(i) {
  if (!state.pageIds.length) return;
  commitTextEdit();
  await KamView.goTo(i);
}
function setZoom(z, fit = '') {
  commitTextEdit();
  return KamView.zoomTo(z, fit);
}
$('#btnZoomIn').onclick = () => setZoom(state.zoom * 1.25);
$('#btnZoomOut').onclick = () => setZoom(state.zoom / 1.25);
$('#btnFit').onclick = () => setZoom(1, 'width');
$('#btnFitPage').onclick = () => setZoom(1, 'page');
$('#btnPrev').onclick = () => goTo(state.cur - 1);
$('#btnNext').onclick = () => goTo(state.cur + 1);
$('#pageNum').addEventListener('change', e => goTo(parseInt(e.target.value, 10) - 1));
window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- file inputs & drag/drop ---------- */
$('#btnOpen').onclick = $('#btnOpen2').onclick = () => $('#fileInput').click();
$('#btnNew').onclick = $('#btnNew2').onclick = async () => { if (await keepOrDiscard('start a new document')) await newBlank(); };
$('#fileInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (!(await keepOrDiscard('open another file'))) return;
  await openBytes(await readFile(f), f.name);
});
async function handleDroppedFiles(files) {
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const imgs = files.filter(f => f.type.startsWith('image/'));
  if (pdfs.length) {
    if (!state.doc) { await openBytes(await readFile(pdfs[0]), pdfs[0].name); if (pdfs.length > 1) await mergeFiles(pdfs.slice(1)); }
    else {
      const names = pdfs.length === 1 ? `“${pdfs[0].name}”` : `${pdfs.length} PDFs`;
      const c = await choose({
        title: `Add ${names} to this document?`,
        message: `The pages can go at the end of “${state.fileName}”, or you can open ${pdfs.length === 1 ? 'it' : 'the first one'} on its own instead.`,
        buttons: [{ key: 'add', label: 'Add pages', primary: true }, { key: 'open', label: 'Open instead' }, { key: 'cancel', label: 'Cancel' }],
      });
      if (c === 'add') await mergeFiles(pdfs);
      else if (c === 'open' && await keepOrDiscard('open another file')) await openBytes(await readFile(pdfs[0]), pdfs[0].name);
    }
  }
  if (imgs.length) { if (!state.doc) { await newBlank(); await addImagePages(imgs); await deletePages([0]); state.undo = []; } else await addImagePages(imgs); }
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
  setUpdateButton('idle');
}

/* The update button in the top bar: a quiet arrow that checks when clicked, spinning while
   it does, which turns into a gold "Update to x.y.z" once a newer version exists. It stays
   gold after "Not now", so the update is always one click away without the bar nagging. */
let updateLabelTimer = null;
function setUpdateButton(stateName, text) {
  const b = $('#btnUpdates'); if (!b) return;
  clearTimeout(updateLabelTimer);
  b.classList.toggle('checking', stateName === 'checking');
  b.classList.toggle('available', stateName === 'available');
  const label = b.querySelector('.upd-label');
  label.textContent = stateName === 'available' ? 'Update to ' + pendingUpdate.version
    : stateName === 'updating' ? 'Updating…' : (text || '');
  const tip = stateName === 'available' ? 'KAM PDFs ' + pendingUpdate.version + ' is available — click for details'
    : 'Check for updates. You have v' + KAM_VERSION + '.';
  b.title = tip; b.setAttribute('aria-label', tip);
  // An answer to a check you asked for stands for a moment, then the quiet icon comes back.
  if (stateName === 'said') updateLabelTimer = setTimeout(() => setUpdateButton(pendingUpdate ? 'available' : 'idle'), 4000);
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
  // The Windows zip, so a copy that lives in a folder can fetch it in one click.
  const zip = (j.assets || []).find(a => /-windows\.zip$/i.test(a.name || ''));
  return { version: v, notes: String(j.name || '').replace(/^KAM PDFs v[\d.]+\s*-\s*/i, ''), url: j.html_url || KAM_RELEASES,
           download: zip ? zip.browser_download_url : null };
}

function showUpdateBar(info) {
  pendingUpdate = info;
  setUpdateButton('available');
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
  if (!auto) setUpdateButton('checking');
  try {
    if (!navigator.onLine) {
      if (!auto) { toast('You are offline, so there is nothing to check against yet.', 4000); setUpdateButton('said', 'Offline'); }
      return;
    }
    const info = await latestRelease();
    try { localStorage.setItem('kam-update-checked', String(Date.now())); } catch (e) { }
    if (versionIsNewer(info.version, KAM_VERSION)) {
      let skipped = null; try { skipped = localStorage.getItem('kam-skip-version'); } catch (e) { }
      if (auto && skipped === info.version) {
        // They said not now: no bar, but the button still says there is something to get.
        pendingUpdate = info;
        setUpdateButton('available');
        return;
      }
      showUpdateBar(info);
    } else {
      pendingUpdate = null;
      hideUpdateBar();
      if (!auto) { toast('You are on the latest version (v' + KAM_VERSION + ').', 4000); setUpdateButton('said', 'Up to date'); }
      else setUpdateButton('idle');
    }
  } catch (e) {
    console.warn('update check failed', e);
    if (!auto) { toast('Could not check for updates: ' + e.message, 5000); setUpdateButton('said', "Couldn't check"); }
  } finally {
    if (!auto && btn) { btn.disabled = false; btn.textContent = 'Check for updates'; }
  }
}

// The button: with a version waiting it brings the bar back, even after "Not now";
// otherwise it checks there and then.
function onUpdateButton() {
  if (pendingUpdate) showUpdateBar(pendingUpdate);
  else checkForUpdate(false);
}

// Where this copy lives, for a copy running from a folder: "C:\Users\me\Documents\KAM PDFs".
function folderOfThisCopy() {
  if (location.protocol !== 'file:') return '';
  const p = decodeURIComponent(location.pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\/[^/]*$/, '');
  return navigator.platform && /win/i.test(navigator.platform) ? p.replace(/\//g, '\\') : p;
}

async function applyUpdate() {
  const b = $('#btnUpdateNow');
  const url = (pendingUpdate && pendingUpdate.url) || KAM_RELEASES;
  if (!canReplaceItself()) {
    // Running from a folder on disk: a web page cannot rewrite its own files, so fetch the new
    // zip for them in one click, and say exactly where it goes.
    const zip = pendingUpdate && pendingUpdate.download;
    if (zip) {
      const a = document.createElement('a');
      a.href = zip; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    } else {
      window.open(url, '_blank', 'noopener');
    }
    const here = folderOfThisCopy();
    toast((zip ? 'Downloading KAM PDFs ' + pendingUpdate.version + '. ' : 'Download the new zip, then ')
      + 'Unzip it where you unzipped this one and let it replace the files'
      + (here ? ' (this copy is in ' + here + ')' : '')
      + '. Your settings and working copy are kept.', 12000);
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
  setUpdateButton('updating');
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
    setUpdateButton('available');
  }
}

function laterOnUpdate() {
  if (pendingUpdate) { try { localStorage.setItem('kam-skip-version', pendingUpdate.version); } catch (e) { } }
  hideUpdateBar();
  toast('Hidden until the next version. The gold update button at the top brings it back.', 5000);
}

/* One automatic check per launch, a few seconds after it opens, and never while it stays
   open: an update matters, but not enough to keep going back to the network. Opened offline,
   the one check waits for the connection. Reopening the app all day does not ask all day
   either, because a check in the last six hours stands for this one. "Check for updates"
   and the update button ask whenever they are clicked. */
let checkedThisLaunch = false;
function maybeAutoCheck() {
  if (checkedThisLaunch || !navigator.onLine) return;
  checkedThisLaunch = true;
  let last = 0; try { last = parseInt(localStorage.getItem('kam-update-checked'), 10) || 0; } catch (e) { }
  if (Date.now() - last < CHECK_EVERY) return;
  checkForUpdate(true);
}

showVersion();
$('#btnUpdate').onclick = () => checkForUpdate(false);
$('#btnUpdates').onclick = onUpdateButton;
$('#btnUpdateNow').onclick = applyUpdate;
$('#btnUpdateLater').onclick = laterOnUpdate;
// Let the app finish opening before going near the network.
setTimeout(maybeAutoCheck, 4000);
// Opened offline: the one check waits for the connection.
window.addEventListener('online', () => setTimeout(maybeAutoCheck, 2000));

/* ---------- light / dark theme ---------- */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  // which icon shows is decided in CSS from data-theme, so the drawn icon is not clobbered
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

/* ---------- undo ----------
   Every change gets a revision number, and saving remembers which one is on disk. "Unsaved"
   then means "not the revision that was saved", so undoing back to exactly what you saved
   clears the dot again, and undoing past a save brings it back. A plain true/false flag got
   both of those wrong. */
let revCounter = 0;
function newRev() { return ++revCounter; }
state.rev = state.savedRev = newRev();
function syncDirty() { state.dirty = !!state.doc && state.rev !== state.savedRev; }
function markChanged() { state.rev = newRev(); syncDirty(); if (typeof noteChange === 'function') noteChange(); }
function pushUndo(entry) {
  entry.rev = state.rev;
  state.undo.push(entry); if (state.undo.length > 25) state.undo.shift();
  state.redo = [];
  keepUndoWithinBudget();
  markChanged();
}
/* Page changes that cannot simply be done backwards (deleting pages, merging) keep a copy of the
   whole document for undo. Those copies are held to a budget: past it, the oldest steps are let
   go, so a long session with a large scan cannot run the computer out of memory. The most
   recent step is always kept. */
const UNDO_BUDGET = 200 * 1024 * 1024;
function keepUndoWithinBudget() {
  const size = () => {
    const seen = new Set(); let n = 0;
    for (const e of [...state.undo, ...state.redo]) if (e.bytes && !seen.has(e.bytes)) { seen.add(e.bytes); n += e.bytes.byteLength; }
    return n;
  };
  let dropped = false;
  while (size() > UNDO_BUDGET) {
    const i = state.undo.findIndex(e => e.bytes);
    if (i < 0 || i === state.undo.length - 1) break;
    state.undo.splice(0, i + 1); dropped = true;
  }
  if (dropped) toast('The oldest steps can no longer be undone: keeping them would take too much memory for a document this size.', 5000);
}
// Take back an undo entry that turned out not to be needed (a shape too small to keep, a
// page operation that failed), as though it had never been pushed.
function dropLastUndo() {
  const e = state.undo.pop();
  if (e) { state.rev = e.rev; syncDirty(); }
}
function snapshotAnnots(pageIds) {
  const pages = {}; for (const id of pageIds) pages[id] = JSON.stringify(state.annots[id] || []);
  return { kind: 'annot', pages };
}
function pushAnnotUndo(pageId) { pushUndo(snapshotAnnots([pageId])); }
function structSnapshot() {
  return { kind: 'struct', bytes: state.bytes, pageIds: [...state.pageIds], annots: JSON.parse(JSON.stringify(state.annots)), cur: state.cur };
}
function pushStructUndo() { pushUndo(structSnapshot()); }
async function restoreStruct(e) {
  busy(true);
  try {
    state.doc = await PDFDocument.load(e.bytes, { ignoreEncryption: true, updateMetadata: false });
    state.pageIds = e.pageIds; state.annots = e.annots; state.cur = e.cur;
    state.selectedPages.clear(); state.thumbCache.clear();
    await rebuild(); loadFormFields(); loadMetadata();
  } catch (err) { console.error(err); toast('Could not restore that step: ' + err.message); }
  busy(false);
}
// The mirror image of an entry: what to push on the other stack so the step can be reversed.
function counterpart(e) {
  let c;
  if (e.kind === 'annot') c = snapshotAnnots(Object.keys(e.pages));
  else if (e.kind === 'turn') c = { kind: 'turn', indices: e.indices, dir: -e.dir, pages: snapshotAnnots(e.indices.map(i => state.pageIds[i])).pages, cur: state.cur };
  else if (e.kind === 'move') c = { kind: 'move', from: e.to, to: e.from, cur: state.cur };
  else c = structSnapshot();
  c.rev = state.rev;
  return c;
}
async function applyEntry(e) {
  if (e.kind === 'annot') {
    for (const id in e.pages) state.annots[id] = JSON.parse(e.pages[id]);
    state.selected = null; drawOverlay(); refreshThumb(state.cur); updateProps();
  } else if (e.kind === 'turn' || e.kind === 'move') {
    // done backwards rather than restored from a copy (see rotatePages in ops.js)
    busy(true);
    try {
      if (e.kind === 'turn') await rotateNow(e.indices, e.dir); else moveNow(e.from, e.to);
      if (e.pages) for (const id in e.pages) state.annots[id] = JSON.parse(e.pages[id]);   // the marks exactly as they were
      state.cur = Math.min(e.cur, state.pageIds.length - 1); state.selectedPages.clear();
      await rebuild();
    } catch (err) { console.error(err); toast('Could not undo that step: ' + err.message); }
    busy(false);
  } else await restoreStruct(e);
  state.rev = e.rev; syncDirty();
  if (typeof noteChange === 'function') noteChange();
}
async function undo() {
  commitTextEdit();
  const e = state.undo.pop(); if (!e) { toast('Nothing to undo'); return; }
  state.redo.push(counterpart(e));
  await applyEntry(e);
}
async function redo() {
  commitTextEdit();
  const e = state.redo.pop(); if (!e) { toast('Nothing to redo'); return; }
  state.undo.push(counterpart(e));
  await applyEntry(e);
}
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;


/* ---------- install as an app (when served over https) ---------- */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('#btnInstall').hidden = false; });
$('#btnInstall').onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('#btnInstall').hidden = true; };
window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; toast('KAM PDFs installed. Find it in your Start menu.'); });
