/* KAM PDFs - working with the text that is already in the PDF: click to select, Delete to
   remove, double-click to edit in place, and Find. The original line is covered with a patch
   of the page's own background colour; the replacement keeps the original size and baseline. */
'use strict';
(() => {
  let hover = null, hoverPage = -1;     // line under the cursor
  let picked = null, pickedPage = -1;   // line clicked, awaiting Delete or a double-click

  const hex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const gap = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
  const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
  function median(list) {
    if (!list.length) return null;
    const ch = i => list.map(p => p[i]).sort((a, b) => a - b)[Math.floor(list.length / 2)];
    return [ch(0), ch(1), ch(2)];
  }
  function fontFor(r) {
    const lbl = r.fontLabel || '';
    if (/courier|mono|consolas|menlo/i.test(lbl) || /mono/.test(r.family)) return 'Courier';
    if (/times|georgia|garamond|cambria|book|roman|minion|serif/i.test(lbl) && !/sans/i.test(lbl)) return 'TimesRoman';
    if (r.family === 'serif' && !/arial|helvetica|calibri|verdana|segoe|tahoma/i.test(lbl)) return 'TimesRoman';
    return 'Helvetica';
  }

  /* Read the page's own pixels around a line: the background colour, the ink colour, and how
     far the ink actually reaches. Measuring the ink matters because font metrics are only a
     guess: a descender or an accent left uncovered shows through as a ghost under the new text. */
  function analyse(r) {
    const plain = { bg: '#ffffff', fg: '#000000', top: -1.5, bottom: r.h + 1.5 };
    const cv = $('#pageCanvas'); if (!cv.width || !state.pageSize.w) return plain;
    const k = cv.width / state.pageSize.w;
    const t = r.rot * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
    const toPx = (lx, ly) => [Math.round((r.x + lx * c - ly * sn) * k), Math.round((r.y + lx * sn + ly * c) * k)];
    const box = [[-5, -5], [r.w + 5, -5], [r.w + 5, r.h + 5], [-5, r.h + 5]].map(p => toPx(...p));
    const minX = Math.max(0, Math.min(...box.map(p => p[0]))), maxX = Math.min(cv.width - 1, Math.max(...box.map(p => p[0])));
    const minY = Math.max(0, Math.min(...box.map(p => p[1]))), maxY = Math.min(cv.height - 1, Math.max(...box.map(p => p[1])));
    const W = maxX - minX + 1, H = maxY - minY + 1; if (W < 2 || H < 2) return plain;
    let img; try { img = cv.getContext('2d').getImageData(minX, minY, W, H).data; } catch (e) { return plain; }
    const at = (px, py) => (px < minX || px > maxX || py < minY || py > maxY) ? null
      : (i => [img[i], img[i + 1], img[i + 2]])(((py - minY) * W + (px - minX)) * 4);

    const bgs = [], step = Math.max(1, r.w / 24);
    for (let lx = -3; lx <= r.w + 3; lx += step) for (const ly of [-4, r.h + 4]) { const p = at(...toPx(lx, ly)); if (p) bgs.push(p); }
    let bg = median(bgs) || [255, 255, 255];
    if (bg.every(v => v > 240)) bg = [255, 255, 255];              // near-white paper: use pure white

    let fg = null, best = -1;
    const sx = Math.max(0.4, r.w / 90), sy = Math.max(0.35, r.h / 14);
    for (let lx = 0; lx <= r.w; lx += sx) for (let ly = 0; ly <= r.h; ly += sy) {
      const p = at(...toPx(lx, ly)); if (!p) continue;
      const d = gap(p, bg); if (d > best) { best = d; fg = p; }
    }
    if (!fg || best < 60) fg = lum(bg) > 140 ? [0, 0, 0] : [255, 255, 255];
    // a cover the same colour as the ink would hide nothing useful: fall back to the paper
    if (gap(bg, fg) < 40) { bg = lum(fg) > 140 ? [0, 0, 0] : [255, 255, 255]; }

    // walk out from the middle of the line while there is still ink, stopping at clear rows so
    // we never reach into the line above or below
    const cols = []; for (let i = 0; i <= 40; i++) cols.push(r.w * i / 40);
    const inked = ly => cols.some(lx => { const p = at(...toPx(lx, ly)); return p && gap(p, bg) > 45; });
    const walk = dir => {
      let last = r.h / 2, blanks = 0;
      for (let d = 0.3; d <= 0.55 * r.h + 2; d += 0.3) {
        const ly = r.h / 2 + dir * d;
        if (inked(ly)) { last = ly; blanks = 0; } else if (++blanks >= 3) break;
      }
      return last;
    };
    const top = Math.max(-0.5 * r.h - 1, Math.min(0, walk(-1) - 1));
    const bottom = Math.min(1.5 * r.h + 1, Math.max(r.h, walk(1) + 1));
    return { bg: hex(bg), fg: hex(fg), top, bottom };
  }

  /* The patch that hides a line of original text, sized to the ink we measured. */
  function coverFor(r, a) {
    const t = r.rot * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
    const padX = 0.6, top = a.top, h = a.bottom - a.top;
    return { id: uid(), type: 'rect',
             x: r.x - padX * c - top * sn, y: r.y - padX * sn + top * c,
             w: r.w + 2 * padX, h, rot: r.rot, stroke: null, fill: a.bg, width: 0, opacity: 1 };
  }

  /* ---------- selecting text with the mouse ---------- */
  let sel = null;   // { page, aRun, aChar, bRun, bChar }
  function clearSel() { if (sel) { sel = null; drawOverlay(); } }
  function ordered() {
    if (!sel) return null;
    const a = { r: sel.aRun, c: sel.aChar }, b = { r: sel.bRun, c: sel.bChar };
    return (a.r < b.r || (a.r === b.r && a.c <= b.c)) ? [a, b] : [b, a];
  }
  function selectedText() {
    const o = ordered(); if (!o) return '';
    const runs = KamPdfText.runsOf(sel.page); const [a, b] = o;
    if (a.r === b.r) return (runs[a.r] || { text: '' }).text.slice(a.c, b.c);
    const out = [];
    for (let i = a.r; i <= b.r && i < runs.length; i++) {
      const t = runs[i].text;
      out.push(i === a.r ? t.slice(a.c) : i === b.r ? t.slice(0, b.c) : t);
    }
    return out.join('\n');
  }
  window.pdfTextDragStart = (x, y) => {
    const pi = state.cur;
    if (typeof deletionAt === 'function' && deletionAt(x, y)) return false;   // nothing to select in a deleted area
    if (!KamPdfText.cached(pi)) { KamPdfText.index(pi).then(() => drawOverlay()).catch(() => { }); return false; }
    const r = KamPdfText.runAt(pi, x, y);
    if (!r || coveredRun(pi, r)) { clearSel(); return false; }
    sel = { page: pi, aRun: r.idx, aChar: KamPdfText.charAt(r, x, y), bRun: r.idx, bChar: KamPdfText.charAt(r, x, y) };
    return true;
  };
  window.pdfTextDragMove = (x, y) => {
    if (!sel) return;
    const r = KamPdfText.runAt(sel.page, x, y) || KamPdfText.nearestRun(sel.page, x, y);
    if (!r) return;
    sel.bRun = r.idx; sel.bChar = KamPdfText.charAt(r, x, y);
  };
  window.pdfTextDragEnd = () => {
    if (!sel) return false;
    const txt = selectedText();
    if (!txt.trim()) { sel = null; return false; }
    $('#hint').textContent = `${txt.length} characters selected · Ctrl+C to copy`;
    return true;
  };
  window.pdfTextCopy = async () => {
    const txt = selectedText();
    if (!txt.trim()) return false;
    try { await navigator.clipboard.writeText(txt); }
    catch (e) {
      // older browsers, or a page without clipboard permission
      const ta = document.createElement('textarea');
      ta.value = txt; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (err) { }
      ta.remove();
      if (!ok) { toast('Could not reach the clipboard'); return false; }
    }
    toast(`Copied ${txt.length} characters`);
    return true;
  };
  window.pdfTextHasSelection = () => !!(sel && selectedText().trim());
  window.pdfTextSelectedText = () => selectedText();

  function clearPick() {
    clearSel();
    if (picked) { picked = null; pickedPage = -1; updateProps(); drawOverlay(); }
  }
  window.pdfTextClearPick = clearPick;

  /* ---------- hover, called from annot.js as the Select tool moves ---------- */
  window.pdfTextHover = (x, y, allow) => {
    const pi = state.cur;
    let r = null;
    if (allow && !editing) {
      const e = KamPdfText.cached(pi);
      if (!e) KamPdfText.index(pi).then(() => drawOverlay()).catch(() => { });
      else { r = KamPdfText.runAt(pi, x, y); if (r && coveredRun(pi, r)) r = null; }
    }
    if (r !== hover || hoverPage !== pi) {
      hover = r; hoverPage = pi; drawOverlay();
      if (r && !picked) $('#hint').textContent = 'Click to select this text, double-click to edit it';
      else if (!picked) updateProps();
    }
    return !!r;
  };

  /* ---------- single click: pick a line so it can be deleted ---------- */
  window.pdfTextSelect = (x, y) => {
    const pi = state.cur;
    const e = KamPdfText.cached(pi);
    if (!e) { KamPdfText.index(pi).then(() => drawOverlay()).catch(() => { }); clearPick(); return false; }
    let r = KamPdfText.runAt(pi, x, y);
    if (r && coveredRun(pi, r)) r = null;               // already removed: nothing to pick
    picked = r; pickedPage = pi;
    $('#hint').textContent = r ? 'Press Delete to remove this text, or double-click to edit it' : '';
    if (!r) updateProps();
    drawOverlay();
    return !!r;
  };

  /* Is this line already sitting under something opaque of ours? If so it has been dealt
     with, and it should stop offering itself for selection: otherwise deleted text keeps
     lighting up and can be deleted over and over, as though it were never going away. */
  function coveredRun(pi, r) {
    const list = state.annots[state.pageIds[pi]] || [];
    const cx = r.x + (r.w / 2) * Math.cos(r.rot * Math.PI / 180) - (r.h / 2) * Math.sin(r.rot * Math.PI / 180);
    const cy = r.y + (r.w / 2) * Math.sin(r.rot * Math.PI / 180) + (r.h / 2) * Math.cos(r.rot * Math.PI / 180);
    for (const a of list) {
      if (a.hidden || a.pts || a.type !== 'rect' || !a.fill || a.blend) continue;
      if ((a.opacity == null ? 1 : a.opacity) < 0.85) continue;
      const t = a.rot * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
      const dx = cx - a.x, dy = cy - a.y;
      const lx = dx * c + dy * s, ly = -dx * s + dy * c;
      if (lx >= -1 && ly >= -1 && lx <= a.w + 1 && ly <= a.h + 1) return true;
    }
    return false;
  }
  window.pdfTextRunCovered = coveredRun;

  /* ---------- Delete: take the picked line out of the document for good ---------- */
  window.pdfTextDeleteSelected = () => {
    if (!picked || pickedPage !== state.cur) return false;
    const r = picked;
    pushAnnotUndo(state.pageIds[state.cur]);
    const cover = coverFor(r, analyse(r));
    // A redaction, not a patch of paint: when you press Delete you mean the words to be gone,
    // and a cover would leave them sitting in the file for anyone to extract.
    cover.redact = true; cover.fill = '#ffffff';
    curAnnots().push(cover);
    picked = null; hover = null;
    drawOverlay(); refreshThumb(state.cur); updateProps();
    toast('Deleted. The words are removed from the file when you save. Ctrl+Z undoes it.', 5000);
    return true;
  };

  /* ---------- double-click: make a line of PDF text editable ---------- */
  window.pdfTextEditAt = async (x, y) => {
    if (!state.doc) return false;
    const pi = state.cur;
    await KamPdfText.index(pi);
    const r = KamPdfText.runAt(pi, x, y);
    if (!r) return false;
    const look = analyse(r);
    pushAnnotUndo(state.pageIds[pi]);
    const txt = { id: uid(), type: 'text', x: 0, y: 0, w: 0, h: 0, rot: r.rot, text: r.text,
                  size: r.size, font: fontFor(r), bold: /bold|black|heavy|semibold|demi/i.test(r.fontLabel),
                  color: look.fg, opacity: 1 };
    // Keep the original size and baseline exactly: that is what makes it sit level with the
    // text around it. Our font may render a little wider or narrower, which is far less
    // noticeable than a change of size.
    txt.x = r.base[0] + 0.9 * txt.size * r.perp[0];
    txt.y = r.base[1] + 0.9 * txt.size * r.perp[1];
    measureText(txt);
    curAnnots().push(coverFor(r, look), txt);
    hover = null; picked = null;
    drawOverlay();
    startTextEdit(txt);
    toast('Editing the page text. Empty the box to delete the line. Esc when done.', 3500);
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
    const matches = (await KamPdfText.search(q)).filter(m => !coveredRun(m.page, m.run));
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

  /* ---------- overlay: hover box, picked box, search matches ---------- */
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
    const mark = (r, fill, stroke, dash) => {
      ctx.save(); ctx.translate(r.x * s, r.y * s); ctx.rotate(r.rot * Math.PI / 180);
      ctx.fillStyle = fill; ctx.fillRect(-2 * s, -2 * s, (r.w + 4) * s, (r.h + 4) * s);
      ctx.strokeStyle = stroke; ctx.lineWidth = (dash ? 1 : 1.6) * dpr; if (dash) ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.strokeRect(-2 * s, -2 * s, (r.w + 4) * s, (r.h + 4) * s);
      ctx.restore();
    };
    const o = ordered();
    if (o && sel.page === state.cur) {
      const runs = KamPdfText.runsOf(sel.page), [a, b] = o;
      ctx.save(); ctx.fillStyle = 'rgba(59,130,246,.32)';
      for (let i = a.r; i <= b.r && i < runs.length; i++) {
        const r = runs[i];
        const c0 = i === a.r ? a.c : 0, c1 = i === b.r ? b.c : r.text.length;
        if (c1 <= c0) continue;
        const ua = KamPdfText.uAt(r, c0) - r.u0, ub = KamPdfText.uAt(r, c1) - r.u0;
        ctx.save(); ctx.translate(r.x * s, r.y * s); ctx.rotate(r.rot * Math.PI / 180);
        ctx.fillRect(ua * s, -1 * s, (ub - ua) * s, (r.h + 2) * s);
        ctx.restore();
      }
      ctx.restore();
    }
    if (picked && pickedPage === state.cur && !editing) mark(picked, 'rgba(59,130,246,.20)', 'rgba(59,130,246,1)', false);
    else if (hover && hoverPage === state.cur && state.tool === 'select' && !editing && !o) mark(hover, 'rgba(59,130,246,.10)', 'rgba(59,130,246,.9)', true);
  };
})();
