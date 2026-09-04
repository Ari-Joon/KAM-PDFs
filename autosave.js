/* KAM PDFs - a working copy, so a crash or a closed window does not cost you the afternoon.
   The document and everything you have added are kept in this browser's own storage on this
   computer. Nothing is uploaded, and Forget removes it. */
'use strict';
const KamDraft = (() => {
  const DB = 'kam-pdfs', STORE = 'draft', KEY = 'current';
  const MAX_BYTES = 80 * 1024 * 1024;
  let dbp = null;

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
  async function put(value) {
    const db = await open(); if (!db) return false;
    return new Promise(res => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = () => res(true); tx.onerror = () => res(false); tx.onabort = () => res(false);
    });
  }
  async function get() {
    const db = await open(); if (!db) return null;
    return new Promise(res => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(KEY);
      rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(null);
    });
  }
  async function clear() {
    const db = await open(); if (!db) return;
    await new Promise(res => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = res; tx.onerror = res; tx.onabort = res;
    });
  }
  return { put, get, clear };
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

  async function saveNow() {
    if (!on || saving || !state.doc || !state.bytes) return;
    if (state.bytes.byteLength > MAXB) { setState('Document too large to keep a working copy'); return; }
    saving = true;
    try {
      const bytes = state.bytes.slice().buffer;
      const annots = state.pageIds.map(id => state.annots[id] || []);
      const ocr = state.pageIds.map(id => (state.ocr && state.ocr[id]) || []);
      const okd = await KamDraft.put({ fileName: state.fileName, bytes, annots, ocr, cur: state.cur, savedAt: Date.now(), v: 1 });
      if (okd) { lastSaved = Date.now(); setState('Working copy kept ' + when(lastSaved)); }
    } catch (e) { console.warn('could not keep a working copy', e); }
    saving = false;
  }
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
      state.pageIds.forEach((id, i) => {
        const list = (draft.annots && draft.annots[i]) || [];
        state.annots[id] = list;
        for (const a of list) if (a.id > maxId) maxId = a.id;
        if (state.ocr) state.ocr[id] = (draft.ocr && draft.ocr[i]) || [];
      });
      state.nextId = Math.max(state.nextId, maxId + 1);
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
      b.onclick = () => { if (state.doc && !confirm('Replace what is open with your last session?')) return; restore(draft); };
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
