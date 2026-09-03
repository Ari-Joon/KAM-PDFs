/* KAM PDFs - the OCR button, and folding recognised words into search and export. */
'use strict';
(() => {
  state.ocr = {};                                  // pageId -> [{ text, x, y, w, h }]
  let busyOcr = false;

  const setStatus = m => { const el = $('#ocrState'); if (el) el.textContent = m || ''; };

  function summarise() {
    const done = Object.keys(state.ocr).filter(k => (state.ocr[k] || []).length).length;
    setStatus(done ? `${done} page${done === 1 ? '' : 's'} recognised` : '');
  }

  async function ocrPages(indices) {
    if (busyOcr) return toast('Text recognition is already running');
    busyOcr = true;
    const btnPage = $('#btnOcrPage'), btnAll = $('#btnOcrAll');
    btnPage.disabled = btnAll.disabled = true;
    let total = 0;
    try {
      for (let n = 0; n < indices.length; n++) {
        const pi = indices[n];
        const prefix = indices.length > 1 ? `Page ${pi + 1} of ${state.pageIds.length}: ` : '';
        const { words } = await KamOcr.readPage(pi, s => setStatus(prefix + s));
        state.ocr[state.pageIds[pi]] = words;
        total += words.length;
        state.dirty = true;
      }
      summarise();
      toast(total ? `Recognised ${total} words. The saved PDF will be searchable.` : 'No readable text found on that page.', 5000);
      drawOverlay();
    } catch (e) {
      console.error(e);
      setStatus('Text recognition failed');
      toast('Text recognition failed: ' + e.message, 6000);
    }
    btnPage.disabled = btnAll.disabled = false;
    busyOcr = false;
  }

  $('#btnOcrPage').onclick = () => { if (!state.doc) return toast('Open a PDF first'); ocrPages([state.cur]); };
  $('#btnOcrAll').onclick = () => {
    if (!state.doc) return toast('Open a PDF first');
    const n = state.pageIds.length;
    if (n > 5 && !confirm(`Read all ${n} pages? This can take a while.`)) return;
    ocrPages([...Array(n).keys()]);
  };

  /* Recognised words feed the in-app search and "Extract text" as well, so a scan behaves
     like an ordinary document straight away. */
  window.ocrWordsFor = pageIndex => state.ocr[state.pageIds[pageIndex]] || [];
  /* Group words into lines by where their middles sit, then read each line left to right.
     Comparing to the previous word alone gets the order wrong when a line wobbles slightly. */
  window.ocrLinesFor = pageIndex => {
    const ws = ocrWordsFor(pageIndex); if (!ws.length) return [];
    const lines = [];
    for (const w of [...ws].sort((a, b) => a.y - b.y)) {
      const mid = w.y + w.h / 2;
      const line = lines.find(l => Math.abs(l.mid - mid) < Math.max(l.h, w.h) * 0.6);
      if (line) { line.words.push(w); line.h = Math.max(line.h, w.h); line.mid = (line.mid + mid) / 2; }
      else lines.push({ mid, h: w.h, words: [w] });
    }
    for (const l of lines) l.words.sort((a, b) => a.x - b.x);
    return lines;
  };
  window.ocrTextFor = pageIndex =>
    ocrLinesFor(pageIndex).map(l => l.words.map(w => w.text).join(' ')).join('\n');
  window.ocrHasAny = () => Object.values(state.ocr).some(v => v && v.length);
})();
