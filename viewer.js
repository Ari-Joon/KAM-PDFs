/* KAM PDFs - the page viewer: every page in one scrolling column, the way any PDF reader works.
 *
 * Only the pages near what you can see are drawn; the rest are placeholders of the right size,
 * so a 300-page file scrolls as lightly as a 3-page one, and memory stays flat however long
 * the document is. The page you are working on (state.cur) is the one you last clicked, or
 * the one filling most of the window when you scroll; its canvases carry the ids pageCanvas
 * and overlay, and the text editor lives inside it.
 */
'use strict';
const KamView = (() => {
  const vp = $('#viewport'), host = $('#pages');
  const PAD = 20, GAP = 14;
  // The largest bitmap one page is drawn into. Past this the page is scaled up by the browser
  // instead: slightly soft at extreme zoom, where drawing it for real would ask for gigabytes
  // (an A0 drawing at 800% is half a billion pixels) and simply come out blank.
  const MAX_PIXELS = 16777216;
  const KEEP_SCREENS = 3;      // pages further away than this are released
  const DRAW_SCREENS = 1;      // pages this close are drawn ahead of time

  let sizes = [];              // display size of each page at 100%, in points
  let els = [];                // the page elements
  const drawn = new Map();     // page index -> { scale, canvas, ov, zoom }
  let queue = new Set(), running = 0, generation = 0;
  let idleWaiters = [];

  const dpr = () => window.devicePixelRatio || 1;

  /* ---------- sizes and layout ---------- */
  // A first guess from pdf-lib, which is instant for any number of pages; pdf.js has the final
  // word when a page is actually drawn, and the placeholder is corrected then if needed.
  function measure() {
    sizes = state.doc ? state.doc.getPages().map(p => {
      const box = p.getCropBox ? p.getCropBox() : p.getSize();
      const rot = ((p.getRotation().angle % 360) + 360) % 360;
      return rot === 90 || rot === 270 ? { w: box.height, h: box.width } : { w: box.width, h: box.height };
    }) : [];
  }
  function layout() {
    const z = state.zoom;
    els.forEach((el, i) => { el.style.width = sizes[i].w * z + 'px'; el.style.height = sizes[i].h * z + 'px'; });
  }
  function fitZoom() {
    if (!state.fit || !sizes.length) return;
    const s = sizes[Math.min(state.cur, sizes.length - 1)] || sizes[0];
    const availW = vp.clientWidth - 2 * PAD - 2, availH = vp.clientHeight - 2 * PAD;
    if (availW < 80) return;
    const z = state.fit === 'page' ? Math.min(availW / s.w, availH / s.h) : availW / s.w;
    state.zoom = Math.max(0.1, Math.min(8, z));
  }

  /* ---------- which pages are near the window ---------- */
  function pageAtY(y) {            // y in the viewport's scrolled content
    let lo = 0, hi = els.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (els[mid].offsetTop <= y) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }
  function range(screens) {
    if (!els.length) return [0, -1];
    const top = vp.scrollTop - vp.clientHeight * screens, bottom = vp.scrollTop + vp.clientHeight * (1 + screens);
    return [pageAtY(Math.max(0, top)), pageAtY(bottom)];
  }
  // the page filling the most of the window
  function mostVisible() {
    const [a, b] = range(0);
    let best = a, area = -1;
    for (let i = a; i <= b; i++) {
      const t = els[i].offsetTop - vp.scrollTop, h = els[i].offsetHeight;
      const seen = Math.min(vp.clientHeight, t + h) - Math.max(0, t);
      if (seen > area + 1) { area = seen; best = i; }
    }
    return best;
  }

  /* ---------- drawing pages ---------- */
  function setBusy() {
    const busyNow = running > 0 || [...queue].some(i => { const [a, b] = range(0); return i >= a && i <= b; });
    state.renderTask = busyNow ? (state.renderTask || {}) : null;
    if (!busyNow) { const w = idleWaiters; idleWaiters = []; w.forEach(f => f()); }
  }
  function whenIdle() { return new Promise(res => { idleWaiters.push(res); setBusy(); }); }

  function ensureLayers(i) {
    let d = drawn.get(i);
    if (d) return d;
    const canvas = document.createElement('canvas'); canvas.className = 'pdf';
    const ov = document.createElement('canvas'); ov.className = 'ov';
    els[i].append(canvas, ov);
    d = { canvas, ov, scale: 0, zoom: 0 };
    drawn.set(i, d);
    if (i === state.cur) markActive(i);
    return d;
  }
  function release(i) {
    const d = drawn.get(i); if (!d) return;
    if (i === state.cur) return;                          // the page you are on always stays
    d.canvas.remove(); d.ov.remove(); drawn.delete(i);
  }

  function schedule() {
    if (!state.pdfjs || !els.length) { setBusy(); return; }
    const [a, b] = range(DRAW_SCREENS), [ka, kb] = range(KEEP_SCREENS);
    for (const i of [...drawn.keys()]) if (i < ka || i > kb) release(i);
    for (const i of [...queue]) if (i < a || i > b) queue.delete(i);
    for (let i = a; i <= b; i++) {
      const d = drawn.get(i);
      if (!d || d.zoom !== state.zoom || d.stale) queue.add(i);
    }
    if (drawn.get(state.cur) === undefined && state.cur < els.length) queue.add(state.cur);
    pump();
    setBusy();
  }
  function nextInQueue() {
    // nearest to the middle of the window first
    const mid = vp.scrollTop + vp.clientHeight / 2;
    let best = null, bd = Infinity;
    for (const i of queue) {
      const el = els[i]; if (!el) { queue.delete(i); continue; }
      const dist = Math.abs(el.offsetTop + el.offsetHeight / 2 - mid) - (i === state.cur ? 1e9 : 0);
      if (dist < bd) { bd = dist; best = i; }
    }
    return best;
  }
  function pump() {
    while (running < 2 && queue.size) {
      const i = nextInQueue(); if (i === null) break;
      queue.delete(i);
      running++;
      drawPage(i, generation).catch(e => { if (!String(e && e.name).includes('Cancel')) console.warn('page draw failed', e); })
        .finally(() => { running--; pump(); setBusy(); });
    }
  }
  // The pdf.js page to draw for page i. A page with edits to its own text is drawn from a
  // patched copy of itself (see pagecopy in the text engine); every other page comes straight
  // from the document.
  async function pdfPage(i) {
    if (typeof KamPatch !== 'undefined') { const p = await KamPatch.pageFor(i); if (p) return p; }
    return state.pdfjs.getPage(i + 1);
  }
  const sigOf = i => (typeof KamPatch !== 'undefined' ? KamPatch.sigFor(i) : '');
  async function drawPage(i, gen) {
    const pdf = state.pdfjs;
    const sig = sigOf(i);                      // the text edits this picture is drawn with
    let page = null, patchFailed = false;
    if (sig) { page = await KamPatch.pageFor(i).catch(() => null); patchFailed = !page; }
    if (!page) page = await state.pdfjs.getPage(i + 1);
    if (gen !== generation || pdf !== state.pdfjs) return;
    const base = page.getViewport({ scale: 1 });
    if (Math.abs(base.width - sizes[i].w) > 0.5 || Math.abs(base.height - sizes[i].h) > 0.5) {
      // the page's real size differs from the first guess (a crop box pdf.js trims further)
      const keep = anchor();
      sizes[i] = { w: base.width, h: base.height }; layout(); restore(keep);
    }
    const want = state.zoom * dpr();
    const scale = Math.min(want, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
    const v = page.getViewport({ scale });
    // Draw off screen, then swap: the old picture stays up until the new one is ready, so
    // zooming never flashes a blank page.
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.floor(v.width)); off.height = Math.max(1, Math.floor(v.height));
    const task = page.render({ canvasContext: off.getContext('2d'), viewport: v });
    try { await task.promise; } catch (e) { if (e && e.name === 'RenderingCancelledException') return; throw e; }
    if (gen !== generation || pdf !== state.pdfjs || !els[i]) return;
    const d = ensureLayers(i);
    off.className = 'pdf';
    if (d.canvas.id) off.id = d.canvas.id;
    d.canvas.replaceWith(off); d.canvas = off;
    d.ov.width = off.width; d.ov.height = off.height;
    const textChanged = d.sig !== undefined && d.sig !== sig;
    d.scale = scale; d.zoom = state.zoom; d.stale = false; d.sig = sig; d.patchFailed = patchFailed;
    drawPageOverlay(i);
    if (textChanged) document.dispatchEvent(new CustomEvent('kam:textchanged', { detail: i }));
    // Read the text of the page you are on straight away (it takes a few milliseconds once the
    // page is drawn), so the first click on a word already knows exactly what it is.
    if (i === state.cur && typeof KamContent !== 'undefined') setTimeout(() => { if (i < state.pageIds.length) KamContent.analyse(i).catch(() => null); }, 30);
    if (i === state.cur && typeof positionTextEditor === 'function') positionTextEditor();
    if (i === state.cur && typeof KamEdit !== 'undefined') KamEdit.position();
  }

  /* ---------- the page you are working on ---------- */
  function markActive(i) {
    for (const id of ['pageCanvas', 'overlay', 'pageWrap']) { const e = document.getElementById(id); if (e) e.removeAttribute('id'); }
    const el = els[i]; if (!el) return;
    el.id = 'pageWrap';
    el.classList.add('active');
    const d = drawn.get(i);
    if (d) { d.canvas.id = 'pageCanvas'; d.ov.id = 'overlay'; }
    const ed = $('#textEditor'); if (ed && ed.parentNode !== el) el.appendChild(ed);
  }
  function setActive(i, quiet) {
    if (!els.length) return;
    i = Math.max(0, Math.min(els.length - 1, i));
    if (i === state.cur && document.getElementById('overlay')) return;
    if (typeof commitTextEdit === 'function') commitTextEdit();
    const prev = els[state.cur]; if (prev) prev.classList.remove('active');
    state.cur = i; state.selected = null;
    state.pageSize = { ...sizes[i] };
    ensureLayers(i);
    markActive(i);
    if (!drawn.get(i).zoom) schedule();
    if (!quiet) {
      if (typeof pdfTextClearPick === 'function') pdfTextClearPick();
      updatePager(); updateThumbClasses(); updateProps();
      const t = $(`.thumb[data-i="${i}"]`); if (t) t.scrollIntoView({ block: 'nearest' });
      if (typeof refreshLayers === 'function') refreshLayers(true);
      drawOverlay();
    }
  }

  /* ---------- scrolling and zoom ---------- */
  // Where the reader is looking, kept across a change of zoom or layout.
  function anchor(clientX, clientY) {
    const r = vp.getBoundingClientRect();
    const ax = clientX === undefined ? vp.clientWidth / 2 : clientX - r.left;
    const ay = clientY === undefined ? vp.clientHeight / 2 : clientY - r.top;
    const y = vp.scrollTop + ay, i = pageAtY(y), el = els[i];
    if (!el) return null;
    return { i, ax, ay, px: (vp.scrollLeft + ax - el.offsetLeft) / (el.offsetWidth || 1), py: (y - el.offsetTop) / (el.offsetHeight || 1) };
  }
  function restore(a) {
    if (!a || !els[a.i]) return;
    const el = els[a.i];
    vp.scrollLeft = el.offsetLeft + a.px * el.offsetWidth - a.ax;
    vp.scrollTop = el.offsetTop + a.py * el.offsetHeight - a.ay;
  }
  function zoomTo(z, fit, clientX, clientY) {
    const keep = anchor(clientX, clientY);
    state.fit = fit || '';
    if (fit) fitZoom(); else state.zoom = Math.max(0.1, Math.min(8, z));
    layout();
    restore(keep);
    for (const d of drawn.values()) d.stale = true;       // redrawn sharp at the new size; the old one stretches meanwhile
    $('#zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
    drawOverlay();
    schedule();
    return whenIdle();
  }
  function scrollToPage(i, where = 'top') {
    const el = els[i]; if (!el) return;
    vp.scrollTop = where === 'top' ? el.offsetTop - PAD / 2 : el.offsetTop + el.offsetHeight / 2 - vp.clientHeight / 2;
  }
  // Bring a point of a page into view (a search match, say), centred if it is off screen.
  function reveal(i, x, y) {
    const el = els[i]; if (!el) return;
    const px = el.offsetLeft + x * state.zoom, py = el.offsetTop + y * state.zoom;
    const inX = px > vp.scrollLeft + 30 && px < vp.scrollLeft + vp.clientWidth - 30;
    const inY = py > vp.scrollTop + 40 && py < vp.scrollTop + vp.clientHeight - 40;
    if (!inY) vp.scrollTop = py - vp.clientHeight / 2;
    if (!inX) vp.scrollLeft = px - vp.clientWidth / 2;
  }
  async function goTo(i, where) {
    if (!els.length) return;
    i = Math.max(0, Math.min(els.length - 1, i));
    setActive(i);
    if (where !== 'stay') scrollToPage(i, where);
    schedule();
    await whenIdle();
  }

  let scrollRaf = 0, userScrolled = false;
  vp.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      schedule();
      // the page filling the window becomes the one you are on, unless you are mid-edit
      if (!userScrolled || typeof editing !== 'undefined' && editing) return;
      if (typeof drag !== 'undefined' && drag) return;
      const m = mostVisible();
      if (m !== state.cur) setActive(m);
    });
  }, { passive: true });
  // Only scrolling the reader did moves the current page, not a scroll we made ourselves.
  for (const ev of ['wheel', 'touchmove', 'keydown', 'pointerdown']) vp.addEventListener(ev, () => { userScrolled = true; }, { passive: true });

  vp.addEventListener('wheel', e => {
    if (!e.ctrlKey || !state.pdfjs) return;
    e.preventDefault();
    zoomTo(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), '', e.clientX, e.clientY);
  }, { passive: false });

  // The window or a side panel changed size: a fitted page is refitted.
  let lastW = 0, lastH = 0, resizeTimer = 0;
  new ResizeObserver(() => {
    if (vp.clientWidth === lastW && vp.clientHeight === lastH) return;
    lastW = vp.clientWidth; lastH = vp.clientHeight;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.fit && state.pdfjs) zoomTo(0, state.fit); else schedule(); }, 120);
  }).observe(vp);

  /* ---------- a document arrives, or its pages change ---------- */
  async function load() {
    const keep = els.length ? anchor() : null, keepCur = state.cur;
    generation++;
    queue.clear();
    for (const d of drawn.values()) { d.canvas.remove(); d.ov.remove(); }
    drawn.clear();
    measure();
    host.textContent = '';
    const ed = $('#textEditor');
    els = sizes.map((s, i) => {
      const el = document.createElement('div');
      el.className = 'page'; el.dataset.i = i;
      host.appendChild(el);
      return el;
    });
    if (ed) (els[0] || host).appendChild(ed);
    if (state.cur >= els.length) state.cur = Math.max(0, els.length - 1);
    fitZoom();
    layout();
    $('#zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
    userScrolled = false;
    if (keep && keep.i < els.length) restore(keep); else scrollToPage(state.cur);
    if (els.length) { state.cur = -1; setActive(Math.min(keepCur, els.length - 1), true); }
    state.pageSize = els.length ? { ...sizes[state.cur] } : { w: 0, h: 0 };
    schedule();
    await whenIdle();
  }
  // Draw again from scratch (pages whose content changed, e.g. text edited in place).
  function invalidate(i) {
    if (i === undefined) { for (const d of drawn.values()) d.stale = true; }
    else { const d = drawn.get(i); if (d) d.stale = true; }
    schedule();
    return whenIdle();
  }

  /* ---------- overlays ---------- */
  function drawPageOverlay(i) {
    const d = drawn.get(i); if (!d || !d.ov.width) return;
    // text edited, deleted, undone or hidden since this picture was drawn: draw it again
    if (d.zoom && !d.stale && (d.sig || '') !== sigOf(i)) { d.stale = true; schedule(); }
    const ctx = d.ov.getContext('2d');
    ctx.clearRect(0, 0, d.ov.width, d.ov.height);
    const s = d.ov.width / sizes[i].w;
    if (typeof drawPdfTextLayer === 'function') drawPdfTextLayer(ctx, s, i);
    drawAnnots(ctx, state.pageIds[i], s, i === state.cur ? state.selected : null);
    if (i === state.cur && typeof drawActiveExtras === 'function') drawActiveExtras(ctx, s);
  }
  function drawOverlays() { for (const i of drawn.keys()) drawPageOverlay(i); }
  const scaleOf = i => { const d = drawn.get(i); return d && d.ov.width ? d.ov.width / sizes[i].w : state.zoom * dpr(); };
  // the middle of what you can see, in the current page's points: where pasted things land
  function visibleCentre() {
    const el = els[state.cur]; if (!el) return [state.pageSize.w / 2, state.pageSize.h / 2];
    const x = (vp.scrollLeft + vp.clientWidth / 2 - el.offsetLeft) / state.zoom;
    const y = (vp.scrollTop + vp.clientHeight / 2 - el.offsetTop) / state.zoom;
    return [Math.max(20, Math.min(sizes[state.cur].w - 20, x)), Math.max(20, Math.min(sizes[state.cur].h - 20, y))];
  }
  window.visibleCentre = visibleCentre;

  /* ---------- thumbnails ---------- */
  const thumbsBox = $('#thumbs');
  const THUMB_W = 140;
  let thumbQueue = new Set(), thumbRunning = false;
  const thumbObserver = new IntersectionObserver(entries => {
    for (const en of entries) {
      const i = +en.target.dataset.i;
      if (en.isIntersecting) { thumbQueue.add(i); }
      else {
        thumbQueue.delete(i);
        // far out of view: let the bitmap go; it is drawn again, quickly, from the cache
        const c = en.target.querySelector('canvas');
        if (c && c.width > 1) { c.width = 1; c.height = 1; c.dataset.drawn = ''; }
      }
    }
    pumpThumbs();
  }, { root: thumbsBox, rootMargin: '400px 0px' });
  function thumbKey(i) { return state.pageIds[i] + ':' + state.doc.getPage(i).getRotation().angle + ':' + sigOf(i); }
  async function pageBitmap(i) {
    const key = thumbKey(i);
    let bmp = state.thumbCache.get(key);
    if (bmp) { state.thumbCache.delete(key); state.thumbCache.set(key, bmp); return bmp; }   // recently used goes last
    const pdf = state.pdfjs, page = await pdfPage(i);
    if (pdf !== state.pdfjs) return null;
    const vp1 = page.getViewport({ scale: 1 });
    const sc = THUMB_W * dpr() / vp1.width, v = page.getViewport({ scale: sc });
    const c = document.createElement('canvas'); c.width = Math.floor(v.width); c.height = Math.floor(v.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
    bmp = c; bmp._scale = sc;
    state.thumbCache.set(key, bmp);
    while (state.thumbCache.size > 120) state.thumbCache.delete(state.thumbCache.keys().next().value);
    return bmp;
  }
  async function drawThumb(i) {
    const c = $(`.thumb[data-i="${i}"] canvas`); if (!c || !state.pdfjs || i >= state.pageIds.length) return;
    const bmp = await pageBitmap(i); if (!bmp || !c.isConnected) return;
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
    drawAnnots(ctx, state.pageIds[i], bmp._scale, null, { spell: false, marks: false });
    c.dataset.drawn = '1';
  }
  async function pumpThumbs() {
    if (thumbRunning) return; thumbRunning = true;
    try {
      while (thumbQueue.size) {
        const i = thumbQueue.values().next().value; thumbQueue.delete(i);
        try { await drawThumb(i); } catch (e) { if (state.pdfjs) console.warn(e); }
      }
    } finally { thumbRunning = false; }
  }
  function buildThumbs() {
    thumbObserver.disconnect(); thumbQueue.clear();
    const cont = thumbsBox; cont.innerHTML = '';
    const n = state.pageIds.length;
    $('#pageCountLabel').textContent = n ? `(${n})` : '';
    for (let i = 0; i < n; i++) {
      const div = document.createElement('div'); div.className = 'thumb'; div.draggable = true; div.dataset.i = i;
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      c.style.aspectRatio = `${sizes[i] ? sizes[i].w : 595} / ${sizes[i] ? sizes[i].h : 842}`;
      div.appendChild(c);
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
      thumbObserver.observe(div);
    }
    updateThumbClasses();
  }
  let thumbRefresh = new Set(), thumbRefreshTimer = 0;
  function refreshThumb(i) {
    thumbRefresh.add(i);
    clearTimeout(thumbRefreshTimer);
    thumbRefreshTimer = setTimeout(() => {
      for (const k of thumbRefresh) { const c = $(`.thumb[data-i="${k}"] canvas`); if (c && c.dataset.drawn) thumbQueue.add(k); }
      thumbRefresh.clear(); pumpThumbs();
    }, 200);
  }

  return {
    load, invalidate, zoomTo, goTo, setActive, scrollToPage, reveal, whenIdle, schedule,
    drawOverlays, drawPageOverlay, scaleOf, buildThumbs, refreshThumb, pdfPage,
    size: i => sizes[i], pageEl: i => els[i], get count() { return els.length; },
    isDrawn: i => drawn.has(i) && !!drawn.get(i).zoom,
    // the edits the page picture shows ('' if it could not be drawn with them: the overlay then
    // draws them instead)
    canvasSig: i => { const d = drawn.get(i); return d && d.zoom ? (d.patchFailed ? '' : (d.sig || '')) : undefined; },
    thumbsIdle: () => !thumbRunning && !thumbQueue.size,
  };
})();
