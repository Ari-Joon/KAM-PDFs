/* KAM PDFs - a working copy, so a crash or a closed window does not cost you the afternoon.
   The document and everything you have added are kept in this browser's own storage on this
   computer. Nothing is uploaded, and Forget removes it. */
'use strict';
/* The copy is kept in three parts: the document's bytes, the pictures you added, and a small
   record of everything else (your marks, the page you were on). Only the record changes with
   every edit; the bytes are written again only when the pages themselves change, and the
   pictures only when you add one. Writing a 46 MB scan back to disk three seconds after every
   pen stroke was most of what made large documents feel slow. All the parts that change go
   in one transaction, so a copy is never half old and half new. */
const KamDraft = (() => {
  const DB = 'kam-pdfs', STORE = 'draft', KEY = 'current', BYTES = 'bytes', IMAGES = 'images';
  let dbp = null, wroteBytes = null, wroteImages = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE); };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    }).catch(e => { console.warn('draft storage unavailable', e); return null; });
    return dbp;
  }
  async function write(entries) {
    const db = await open(); if (!db) return false;
    return new Promise(res => {
      const tx = db.transaction(STORE, 'readwrite'), st = tx.objectStore(STORE);
      for (const [k, v] of entries) st.put(v, k);
      tx.oncomplete = () => res(true); tx.onerror = () => res(false); tx.onabort = () => res(false);
    });
  }
  async function read(keys) {
    const db = await open(); if (!db) return keys.map(() => null);
    return new Promise(res => {
      const tx = db.transaction(STORE, 'readonly'), st = tx.objectStore(STORE), out = [];
      keys.forEach((k, i) => { const rq = st.get(k); rq.onsuccess = () => { out[i] = rq.result || null; }; });
      tx.oncomplete = () => res(out); tx.onerror = () => res(keys.map(() => null));
    });
  }
  // `bytes` is the document as it stands (only written when it is not the one written last
  // time); `images` the pictures; `record` everything else.
  async function save({ bytes, images, imagesSig, record }) {
    const entries = [];
    if (bytes !== wroteBytes) entries.push([BYTES, bytes.slice().buffer]);
    if (imagesSig !== wroteImages) entries.push([IMAGES, images]);
    entries.push([KEY, record]);
    const ok = await write(entries);
    if (ok) { wroteBytes = bytes; wroteImages = imagesSig; }
    return ok;
  }
  // The whole copy, put back together (a copy from before it was kept in parts has its bytes in
  // the record itself).
  async function get() {
    const [record, bytes, images] = await read([KEY, BYTES, IMAGES]);
    if (!record) return null;
    return { ...record, bytes: record.bytes || bytes, images: record.images || images || {} };
  }
  async function clear() {
    const db = await open(); if (!db) return;
    wroteBytes = null; wroteImages = null;
    await new Promise(res => {
      const tx = db.transaction(STORE, 'readwrite'), st = tx.objectStore(STORE);
      for (const k of [KEY, BYTES, IMAGES]) st.delete(k);
      tx.oncomplete = res; tx.onerror = res; tx.onabort = res;
    });
  }
  return { save, get, clear };
})();

(() => {
  let on = true;
  try { const v = localStorage.getItem('kam-autosave'); if (v !== null) on = v === '1'; } catch (e) { }
  const cb = $('#autosaveOn'); if (cb) cb.checked = on;
  let timer = null, lastSaved = 0, saving = false;

  const setState = m => { const el = $('#autosaveState'); if (el) el.textContent = m || ''; };
  const when = ts => {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' minutes ago';
    return new Date(ts).toLocaleString();
  };

  // Returns whether a copy was actually written, so callers that are about to reload the page
  // (updating, for one) can tell the difference between "kept" and "quietly did nothing".
  async function saveNow() {
    if (!on || saving || !state.doc || !state.bytes) return false;
    if (state.bytes.byteLength > MAXB) { setState('Document too large to keep a working copy'); return false; }
    saving = true;
    let okd = false;
    try {
      const annots = state.pageIds.map(id => state.annots[id] || []);
      const ocr = state.pageIds.map(id => (state.ocr && state.ocr[id]) || []);
      // only the pictures still used somewhere (undo can bring a deleted one back, but not
      // once the window is closed)
      const used = new Set(); for (const list of annots) for (const a of list) if (a.img) used.add(a.img);
      const images = {}; for (const id of used) if (state.images[id]) images[id] = state.images[id];
      okd = await KamDraft.save({ bytes: state.bytes, images, imagesSig: [...used].sort().join(','),
        record: { fileName: state.fileName, annots, ocr, cur: state.cur, savedAt: Date.now(), v: 2 } });
      if (okd) { lastSaved = Date.now(); setState('Working copy kept ' + when(lastSaved)); }
    } catch (e) { console.warn('could not keep a working copy', e); }
    saving = false;
    return !!okd;
  }
  window.saveDraftNow = saveNow;
  const MAXB = 80 * 1024 * 1024;

  window.noteChange = () => {
    if (!on || !state.doc) return;
    clearTimeout(timer);
    timer = setTimeout(saveNow, 3000);
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

  async function restore(draft) {
    if (!draft) return;
    busy(true);
    try {
      await openBytes(draft.bytes, draft.fileName || 'restored.pdf');
      if (!state.doc) throw new Error('the working copy could not be opened');
      let maxId = 0;
      state.images = { ...(draft.images || {}) };
      for (const id in state.images) { const n = parseInt(String(id).replace(/^img/, ''), 10); if (n > maxId) maxId = n; }
      state.pageIds.forEach((id, i) => {
        const list = (draft.annots && draft.annots[i]) || [];
        state.annots[id] = list;
        for (const a of list) if (a.id > maxId) maxId = a.id;
        if (state.ocr) state.ocr[id] = (draft.ocr && draft.ocr[i]) || [];
      });
      state.nextId = Math.max(state.nextId, maxId + 1);
      for (const id of state.pageIds) for (const a of state.annots[id]) adoptImage(a);    // a copy made before pictures were kept apart
      markChanged();                  // a restored session has changes the file on disk does not
      state.cur = Math.min(draft.cur || 0, state.pageIds.length - 1);
      await goTo(state.cur);
      renderThumbs();
      if (typeof refreshLayers === 'function') refreshLayers(true);
      toast('Your last session is back, including everything you had added.', 5000);
    } catch (e) { console.error(e); toast('Could not restore the working copy: ' + e.message, 6000); }
    busy(false);
  }

  async function offerRestore() {
    const draft = await KamDraft.get();
    const btns = [$('#btnRestore'), $('#btnRestoreEmpty')].filter(Boolean);
    if (!draft) { btns.forEach(b => b.hidden = true); setState(on ? 'Nothing kept yet' : 'Turned off'); return; }
    setState(`Working copy of "${draft.fileName}" from ${when(draft.savedAt)}`);
    btns.forEach(b => {
      b.hidden = false;
      b.textContent = b.id === 'btnRestoreEmpty' ? `Restore "${draft.fileName}"` : 'Restore last session';
      b.onclick = async () => { if (await keepOrDiscard('restore your last session')) restore(draft); };
    });
  }

  if (cb) cb.addEventListener('change', () => {
    on = cb.checked;
    try { localStorage.setItem('kam-autosave', on ? '1' : '0'); } catch (e) { }
    if (on) { saveNow(); toast('A working copy will be kept on this computer.'); }
    else { KamDraft.clear(); setState('Turned off'); [$('#btnRestore'), $('#btnRestoreEmpty')].forEach(b => b && (b.hidden = true)); toast('Turned off, and the stored copy was removed.'); }
  });
  $('#btnForget').onclick = async () => {
    await KamDraft.clear();
    [$('#btnRestore'), $('#btnRestoreEmpty')].forEach(b => b && (b.hidden = true));
    setState('Nothing kept');
    toast('The stored working copy has been removed from this computer.');
  };
  offerRestore();
})();
