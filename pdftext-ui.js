/* KAM PDFs - editing the text that is already in the PDF, and Find.
   Double-click a line of existing text: it is covered with a patch of the page's own
   background colour and replaced by an editable text box in the same place, size and colour. */
'use strict';
(() => {
  let hover = null, hoverPage = -1;

  /* ---------- helpers ---------- */
  const hex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  function median(list) {
    if (!list.length) return null;
    const ch = i => list.map(p => p[i]).sort((a, b) => a - b)[Math.floor(list.length / 2)];
    return [ch(0), ch(1), ch(2)];
  }
  function fontFor(r) {
    const lbl = r.fontLabel || '';
    if (/courier|mono|consolas|menlo/i.test(lbl) || /mono/.test(r.family)) return 'Courier';
    if (/times|georgia|garamond|cambria|book|roman|serif/i.test(lbl) && !/sans/i.test(lbl)) return 'TimesRoman';
    if (r.family === 'serif' && !/arial|helvetica|calibri|verdana|segoe|tahoma/i.test(lbl)) return 'TimesRoman';
    return 'Helvetica';
  }

  /* Read the page's own pixels around and inside the run: background = what surrounds it,
     text colour = the pixel inside that differs most from that background. */
  function sampleColours(r) {
    const fallback = { bg: '#ffffff', fg: '#000000' };
    const cv = $('#pageCanvas'); if (!cv.width || !state.pageSize.w) return fallback;
    const k = cv.width / state.pageSize.w;                    // canvas pixels per point
    const t = r.rot * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
    const toPx = (lx, ly) => [Math.round((r.x + lx * c - ly * sn) * k), Math.round((r.y + lx * sn + ly * c) * k)];
    const corners = [[-4, -4], [r.w + 4, -4], [r.w + 4, r.h + 4], [-4, r.h + 4]].map(p => toPx(...p));
    const minX = Math.max(0, Math.min(...corners.map(p => p[0]))), maxX = Math.min(cv.width - 1, Math.max(...corners.map(p => p[0])));
    const minY = Math.max(0, Math.min(...corners.map(p => p[1]))), maxY = Math.min(cv.height - 1, Math.max(...corners.map(p => p[1])));
    const W = maxX - minX + 1, H = maxY - minY + 1; if (W < 1 || H < 1) return fallback;
    let img; try { img = cv.getContext('2d').getImageData(minX, minY, W, H).data; } catch (e) { return fallback; }
    const at = (px, py) => (px < minX || px > maxX || py < minY || py > maxY) ? null : (i => [img[i], img[i + 1], img[i + 2]])(((py - minY) * W + (px - minX)) * 4);
    const bgs = [], step = Math.max(1, r.w / 24);
    for (let lx = -2; lx <= r.w + 2; lx += step) for (const ly of [-3, r.h + 3]) { const p = at(...toPx(lx, ly)); if (p) bgs.push(p); }
    let bg = median(bgs) || [255, 255, 255];
    if (bg.every(v => v > 242)) bg = [255, 255, 255];
    let fg = null, best = -1; const sx = Math.max(0.4, r.w / 80), sy = Math.max(0.4, r.h / 12);
    for (let lx = 0; lx <= r.w; lx += sx) for (let ly = 0; ly <= r.h; ly += sy) { const p = at(...toPx(lx, ly)); if (!p) continue; const d = dist(p, bg); if (d > best) { best = d; fg = p; } }
    if (!fg || best < 60) fg = bg[0] + bg[1] + bg[2] > 380 ? [0, 0, 0] : [255, 255, 255];
    return { bg: hex(bg), fg: hex(fg) };
  }

  /* ---------- hover (called from annot.js while the Select tool moves) ---------- */
  window.pdfTextHover = (x, y, allow) => {
    const pi = state.cur;
    let r = null;
    if (allow && !editing) {
      const e = KamPdfText.cached(pi);
      if (!e) { KamPdfText.index(pi).catch(() => { }); }
      else r = KamPdfText.runAt(pi, x, y);
    }
    if (r !== hover || hoverPage !== pi) {
      hover = r; hoverPage = pi; drawOverlay();
      if (r) $('#hint').textContent = 'Double-click to edit this text'; else updateProps();
    }
    return !!r;
  };

  /* ---------- double-click: turn a line of PDF text into an editable one ---------- */
  window.pdfTextEditAt = async (x, y) => {
    if (!state.doc) return false;
    const pi = state.cur;
    await KamPdfText.index(pi);
    const r = KamPdfText.runAt(pi, x, y);
    if (!r) return false;
    const { bg, fg } = sampleColours(r);
    pushAnnotUndo(state.pageIds[pi]);
    const pad = 1.5, t = r.rot * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
    const cover = { id: uid(), type: 'rect', x: r.x - pad * c + pad * sn, y: r.y - pad * sn - pad * c, w: r.w + 2 * pad, h: r.h + 2 * pad, rot: r.rot, stroke: null, fill: bg, width: 0, opacity: 1 };
    const txt = { id: uid(), type: 'text', x: 0, y: 0, w: 0, h: 0, rot: r.rot, text: r.text, size: r.size, font: fontFor(r), bold: /bold|black|heavy|semibold|demi/i.test(r.fontLabel), color: fg, opacity: 1 };
    const place = () => { txt.x = r.base[0] + 0.9 * txt.size * r.perp[0]; txt.y = r.base[1] + 0.9 * txt.size * r.perp[1]; measureText(txt); };
    place();
    // our font is not the PDF's font: if the line comes out wider than the original, shrink to fit the same space
    if (txt.w > r.w * 1.03 && r.w > 5) { txt.size = Math.max(4, Math.round(r.size * (r.w / txt.w) * 100) / 100); place(); }
    curAnnots().push(cover, txt);
    hover = null;
    drawOverlay();
    startTextEdit(txt);
    toast('Editing the page text. Delete it all to remove the line. Esc when done.', 3500);
    return true;
  };

  /* ---------- Find (Ctrl+F) ---------- */
  const find = { open: false, q: '', matches: [], cur: -1, docRef: null };
  let searchToken = 0;
  const bar = document.createElement('div'); bar.id = 'findBar'; bar.hidden = true;
  bar.innerHTML = `<input id="findInput" type="search" placeholder="Find in document" autocomplete="off" spellcheck="false">
    <span id="findCount" class="muted"></span>
    <button id="findPrev" title="Previous match (Shift+Enter)">▲</button><button id="findNext" title="Next match (Enter)">▼</button>
    <button id="findClose" title="Close (Esc)">✕</button>`;
  $('#viewer').appendChild(bar);
  const input = $('#findInput');

  function updateCount() {
    const n = find.matches.length;
    $('#findCount').textContent = n ? `${find.cur + 1} of ${n}` : (find.q ? 'No matches' : '');
  }
  async function showMatch() {
    const m = find.matches[find.cur]; if (!m) return;
    if (m.page !== state.cur) await goTo(m.page);
    updateCount(); drawOverlay();
  }
  function step(d) { if (!find.matches.length) return; find.cur = (find.cur + d + find.matches.length) % find.matches.length; showMatch(); }
  async function runSearch() {
    const q = input.value.trim(); find.q = q; find.matches = []; find.cur = -1; find.docRef = state.pdfjs;
    if (!q) { updateCount(); drawOverlay(); return; }
    $('#findCount').textContent = 'Searching…';
    const token = ++searchToken;
    const matches = await KamPdfText.search(q);
    if (token !== searchToken) return;
    find.matches = matches;
    find.cur = matches.findIndex(m => m.page >= state.cur); if (find.cur < 0 && matches.length) find.cur = 0;
    updateCount();
    if (find.cur >= 0) await showMatch(); else drawOverlay();
  }
  function openFind() {
    if (!state.doc) return toast('Open a PDF first');
    bar.hidden = false; bar.style.top = ($('#toolbar').offsetHeight + 10) + 'px'; find.open = true;
    input.focus(); input.select(); drawOverlay();
  }
  function closeFind() { bar.hidden = true; find.open = false; drawOverlay(); }
  let debounceT; input.addEventListener('input', () => { clearTimeout(debounceT); debounceT = setTimeout(runSearch, 220); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (find.q !== input.value.trim()) runSearch(); else step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    e.stopPropagation();
  });
  $('#findNext').onclick = () => step(1); $('#findPrev').onclick = () => step(-1); $('#findClose').onclick = closeFind;
  $('#btnFind').onclick = openFind;
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); } });

  /* ---------- overlay layer: hover box and match highlights (called from drawOverlay) ---------- */
  window.drawPdfTextLayer = (ctx, s) => {
    const dpr = window.devicePixelRatio || 1;
    if (find.docRef && find.docRef !== state.pdfjs) { find.matches = []; find.cur = -1; find.docRef = state.pdfjs; if (find.open) updateCount(); }
    if (find.open && find.matches.length) {
      find.matches.forEach((m, i) => {
        if (m.page !== state.cur) return;
        const r = m.run, ua = KamPdfText.uAt(r, m.start) - r.u0, ub = KamPdfText.uAt(r, m.end) - r.u0;
        ctx.save(); ctx.translate(r.x * s, r.y * s); ctx.rotate(r.rot * Math.PI / 180);
        ctx.fillStyle = i === find.cur ? 'rgba(245,180,0,.55)' : 'rgba(245,180,0,.28)';
        ctx.fillRect(ua * s, -1.5 * s, (ub - ua) * s, (r.h + 3) * s);
        if (i === find.cur) { ctx.strokeStyle = '#f5b400'; ctx.lineWidth = 1.5 * dpr; ctx.strokeRect(ua * s, -1.5 * s, (ub - ua) * s, (r.h + 3) * s); }
        ctx.restore();
      });
    }
    if (hover && hoverPage === state.cur && state.tool === 'select' && !editing) {
      const r = hover;
      ctx.save(); ctx.translate(r.x * s, r.y * s); ctx.rotate(r.rot * Math.PI / 180);
      ctx.fillStyle = 'rgba(59,130,246,.10)'; ctx.fillRect(-2 * s, -2 * s, (r.w + 4) * s, (r.h + 4) * s);
      ctx.strokeStyle = 'rgba(59,130,246,.9)'; ctx.lineWidth = dpr; ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.strokeRect(-2 * s, -2 * s, (r.w + 4) * s, (r.h + 4) * s);
      ctx.restore();
    }
  };
})();
