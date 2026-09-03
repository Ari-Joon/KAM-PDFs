/* KAM PDFs - reading text off a scanned page.
   Scans are pictures: nothing to search, select or spell check. Tesseract runs entirely on
   your machine, and the words it finds are written into the saved PDF as an invisible layer
   sitting exactly over the picture, so the file becomes searchable in any viewer. */
'use strict';
const KamOcr = (() => {
  const BASE = 'lib/ocr/';
  let worker = null, loading = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement('script');
      s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('could not load ' + src));
      document.head.appendChild(s);
    });
  }

  async function ready(onStatus) {
    if (worker) return worker;
    if (loading) return loading;
    loading = (async () => {
      onStatus && onStatus('Loading the text recogniser…');
      await loadScript(BASE + 'tesseract.min.js');
      onStatus && onStatus('Starting the text recogniser…');
      worker = await Tesseract.createWorker('eng', 1, {
        workerPath: BASE + 'worker.min.js',
        corePath: BASE + 'tesseract-core-simd.wasm.js',
        langPath: BASE,
        gzip: false,                       // we ship the plain .traineddata
        workerBlobURL: false,
        logger: m => {
          if (!onStatus) return;
          if (m.status === 'recognizing text') onStatus(`Reading the page… ${Math.round((m.progress || 0) * 100)}%`);
          else if (m.status) onStatus(m.status.charAt(0).toUpperCase() + m.status.slice(1) + '…');
        },
      });
      return worker;
    })();
    try { return await loading; } catch (e) { loading = null; worker = null; throw e; }
  }

  /* Render one page big enough for Tesseract to read (it likes about 300 dpi). */
  async function pageBitmap(pi, dpi = 300) {
    const page = await state.pdfjs.getPage(pi + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(dpi / 72, 4000 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return { canvas: c, scale };
  }

  /* Recognise one page. Returns words in display points, the same space annotations use. */
  async function readPage(pi, onStatus) {
    const w = await ready(onStatus);
    const { canvas, scale } = await pageBitmap(pi);
    const { data } = await w.recognize(canvas, {}, { blocks: true, text: true });
    const words = [];
    const collect = block => {
      if (!block) return;
      if (Array.isArray(block.words)) {
        for (const wd of block.words) {
          const b = wd.bbox; if (!b || !wd.text || !wd.text.trim()) continue;
          if ((wd.confidence ?? 100) < 30) continue;
          words.push({
            text: wd.text, conf: wd.confidence ?? 0,
            x: b.x0 / scale, y: b.y0 / scale,
            w: (b.x1 - b.x0) / scale, h: (b.y1 - b.y0) / scale,
          });
        }
      }
      for (const k of ['blocks', 'paragraphs', 'lines']) if (Array.isArray(block[k])) block[k].forEach(collect);
    };
    if (Array.isArray(data.blocks)) data.blocks.forEach(collect);
    if (!words.length && Array.isArray(data.words)) {
      for (const wd of data.words) {
        const b = wd.bbox; if (!b || !wd.text.trim()) continue;
        words.push({ text: wd.text, conf: wd.confidence ?? 0, x: b.x0 / scale, y: b.y0 / scale, w: (b.x1 - b.x0) / scale, h: (b.y1 - b.y0) / scale });
      }
    }
    return { words, text: data.text || '' };
  }

  async function stop() { if (worker) { try { await worker.terminate(); } catch (e) { } worker = null; loading = null; } }

  return { readPage, stop, get running() { return !!worker; } };
})();
