/* KAM PDFs - opening a PDF straight from Windows: "Open with > KAM PDFs" on a file, or a
 * double-click once KAM PDFs is the app for PDFs.
 *
 * There are two ways in. KAM PDFs installed from the website is handed the file itself by the
 * browser (the launch queue), so Save can write the changes back into that same file. A copy
 * run from a folder is handed it by setup/open-pdf.ps1, which writes the PDF into a short-lived
 * script in local app data: a page opened from a folder may not read the computer's files by
 * itself, and nothing here changes that.
 */
'use strict';
const KamLaunch = (() => {
  async function open(file, handle) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast(`${file.name} is not a PDF, so KAM PDFs cannot open it.`, 5000); return false; }
    // Opening from Windows skips the welcome screen, and with it the button that restores work
    // kept from last time. If that work was never saved, ask now, before it could be replaced.
    if (!state.doc && typeof KamDraft !== 'undefined') {
      const draft = await KamDraft.get().catch(() => null);
      if (draft && draft.dirty) {
        const c = await choose({
          title: 'Restore your last session?',
          message: `KAM PDFs kept changes to “${draft.fileName}” that were not saved. Pick them up again, or open “${file.name}”? The kept changes stay until you change the file you open.`,
          buttons: [{ key: 'open', label: 'Open the new file', primary: true }, { key: 'restore', label: 'Restore last session' }],
        });
        if (c === 'restore') { await KamDraft.restoreKept(); return false; }
      }
    }
    if (!(await keepOrDiscard(`open ${file.name}`))) return false;
    await openBytes(await readFile(file), file.name);
    // the browser gave us the file itself: Save puts the changes back into it
    if (handle && state.doc && state.fileName === file.name && typeof setSaveTarget === 'function') setSaveTarget(handle);
    return true;
  }

  // Several files at once are handled like several files dropped on the window.
  async function openAll(entries) {
    if (!entries.length) return;
    if (entries.length === 1) return open(entries[0].file, entries[0].handle);
    return handleDroppedFiles(entries.map(e => e.file));
  }

  /* ---------- installed from the website: the browser hands the file over ---------- */
  if ('launchQueue' in window && window.launchQueue && typeof window.launchQueue.setConsumer === 'function') {
    window.launchQueue.setConsumer(async params => {
      const entries = [];
      for (const h of (params && params.files) || []) {
        if (!h || h.kind !== 'file') continue;
        try { entries.push({ file: await h.getFile(), handle: h }); } catch (e) { console.warn('could not read a file handed over by Windows', e); }
      }
      await openAll(entries);
    });
  }

  /* ---------- run from a folder: setup/open-pdf.ps1 left the file in a script ---------- */
  function bytesOf(b64) {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
    const bin = atob(b64), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function fromFolderLauncher() {
    const u = new URLSearchParams(location.search).get('open');
    if (!u || location.protocol !== 'file:') return;
    history.replaceState(null, '', location.href.split('?')[0]);      // a reload does not open it again
    // only what open-pdf.ps1 writes: one script, named by a random id, in local app data
    if (!/^file:\/\/\/[^?#]*\/KAM%20PDFs\/open\/[0-9a-f]{32}\.js$/i.test(u)) return;
    const s = document.createElement('script');
    s.src = u;
    s.onload = () => {
      const o = window.KAM_OPEN; delete window.KAM_OPEN; s.remove();
      if (!o || typeof o.data !== 'string') return;
      const name = typeof o.name === 'string' && o.name ? o.name : 'document.pdf';
      open(new File([bytesOf(o.data)], name, { type: 'application/pdf' }));
    };
    s.onerror = () => { s.remove(); toast('The PDF could not be handed over from Windows. Open it with the Open button instead.', 6000); };
    document.head.appendChild(s);
  }
  fromFolderLauncher();

  return { open, openAll };
})();
