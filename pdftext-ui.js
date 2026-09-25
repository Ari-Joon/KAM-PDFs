/* KAM PDFs - working with the text that is already in the PDF: click to select, Delete to
   remove, double-click to edit in place, and Find.

   Most text goes through the text engine (content.js, textedit.js): edited in its own font,
   inside the page itself, and deleted by taking the words out of the page rather than painting
   over them. Text the engine cannot read exactly (the words of a scanned page after OCR, or
   text built in some unusual way) falls back to the older way: the line is covered with the
   page's own background colour and the replacement is typed over it. */
'use strict';
(() => {
  // What the pointer is over, or what was clicked: { page, kind: 'phrase' | 'run', item }.
  // A phrase is one of the engine's lines (item is from KamContent.current); a run is a line
  // of pdf.js's text, used where the engine has nothing.
  let hover = null, picked = null, clickSeq = 0;

  const hex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const gap = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
  const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
  function median(list) {
    if (!list.length) return null;
    const ch = i => list.map(p => p[i]).sort((a, b) => a - b)[Math.floor(list.length / 2)];
    return [ch(0), ch(1), ch(2)];
  }
  const boxOf = t => (t.kind === 'phrase' ? t.item.box : t.item);
  const same = (a, b) => !!a && !!b && a.page === b.page && a.kind === b.kind
    && (a.kind === 'phrase' ? a.item.ph.key === b.item.ph.key : a.item === b.item);

  /* ---------- what text is under the pointer ---------- */
  function inBox(b, x, y, pad) {
    const t = b.rot * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), dx = x - b.x, dy = y - b.y;
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    return lx >= -pad && ly >= -pad && lx <= b.w + pad && ly <= b.h + pad;
  }
  // Does a pdf.js line lie over text the engine can edit? Then it must not be handled the old
  // way, even between two of the engine's phrases.
  function runOverPhrase(pi, r) {
    const t = r.rot * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    for (const f of [0.08, 0.3, 0.5, 0.7, 0.92]) {
      const lx = r.w * f, ly = r.h / 2, x = r.x + lx * c - ly * s, y = r.y + lx * s + ly * c;
      const it = KamContent.phraseAt(pi, x, y, 0);
      if (it && it.ph.editable) return true;
    }
    return false;
  }
  function targetAt(pi, x, y) {
    const an = KamContent.cached(pi);
    // still reading the page (a few milliseconds after it is drawn): wait, rather than handle
    // the text the older way and then change our mind
    if (!an) { KamContent.analyse(pi).then(() => drawOverlay()).catch(() => { }); return null; }
    if (an.ok) {
      const it = KamContent.phraseAt(pi, x, y);
      if (it && it.ph.editable) return { page: pi, kind: 'phrase', item: it };
      if (!it && KamContent.phraseAt(pi, x, y, 5)) return null;           // just beside one
    }
    if (!KamPdfText.cached(pi)) { KamPdfText.index(pi).then(() => drawOverlay()).catch(() => { }); return null; }
    const r = KamPdfText.runAt(pi, x, y);
    if (!r || coveredRun(pi, r)) return null;
    if (an.ok && runOverPhrase(pi, r)) return null;
    return { page: pi, kind: 'run', item: r };
  }

  /* ---------- the older way, for text the engine cannot edit ----------
     Read the page's own pixels around a line: the background colour, the ink colour, and how
     far the ink actually reaches, so the cover hides descenders and accents too. */
  function fontFor(r) {
    const lbl = r.fontLabel || '';
    if (/courier|mono|consolas|menlo/i.test(lbl) || /mono/.test(r.family)) return 'Courier';
    if (/times|georgia|garamond|cambria|book|roman|minion|serif/i.test(lbl) && !/sans/i.test(lbl)) return 'TimesRoman';
    if (r.family === 'serif' && !/arial|helvetica|calibri|verdana|segoe|tahoma/i.test(lbl)) return 'TimesRoman';
    return 'Helvetica';
  }
  function analyse(r) {
    const plain = { bg: '#ffffff', fg: '#000000', top: -1.5, bottom: r.h + 1.5 };
    const cv = $('#pageCanvas'); if (!cv || !cv.width || !state.pageSize.w) return plain;
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
    if (bg.every(v => v > 240)) bg = [255, 255, 255];
    let fg = null, best = -1;
    const sx = Math.max(0.4, r.w / 90), sy = Math.max(0.35, r.h / 14);
    for (let lx = 0; lx <= r.w; lx += sx) for (let ly = 0; ly <= r.h; ly += sy) {
      const p = at(...toPx(lx, ly)); if (!p) continue;
      const d = gap(p, bg); if (d > best) { best = d; fg = p; }
    }
    if (!fg || best < 60) fg = lum(bg) > 140 ? [0, 0, 0] : [255, 255, 255];
    if (gap(bg, fg) < 40) { bg = lum(fg) > 140 ? [0, 0, 0] : [255, 255, 255]; }
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
  function coverFor(r, a) {
    const t = r.rot * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
    const padX = 0.6, top = a.top, h = a.bottom - a.top;
    return { id: uid(), type: 'rect',
             x: r.x - padX * c - top * sn, y: r.y - padX * sn + top * c,
             w: r.w + 2 * padX, h, rot: r.rot, stroke: null, fill: a.bg, width: 0, opacity: 1 };
  }
  /* A pdf.js line already sitting under something opaque of ours has been dealt with, and should
     stop offering itself: otherwise deleted text keeps lighting up and can be deleted again and
     again, as though it were never going away. */
  function coveredRun(pi, r) {
    const list = state.annots[state.pageIds[pi]] || [];
    const cx = r.x + (r.w / 2) * Math.cos(r.rot * Math.PI / 180) - (r.h / 2) * Math.sin(r.rot * Math.PI / 180);
    const cy = r.y + (r.w / 2) * Math.sin(r.rot * Math.PI / 180) + (r.h / 2) * Math.cos(r.rot * Math.PI / 180);
    for (const a of list) {
      if (a.hidden || a.pts || a.type !== 'rect' || !a.fill || a.blend) continue;
      if ((a.opacity == null ? 1 : a.opacity) < 0.85) continue;
      if (inBox(a, cx, cy, 1)) return true;
    }
    return false;
  }
  window.pdfTextRunCovered = coveredRun;

  /* ---------- selecting text with the mouse (to copy it) ---------- */
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
    clickSeq++;
    clearSel();
    if (picked) { picked = null; updateProps(); drawOverlay(); }
  }
  window.pdfTextClearPick = clearPick;

  /* ---------- hover, from annot.js as the Select tool moves ---------- */
  window.pdfTextHover = (x, y, allow) => {
    const pi = state.cur;
    const editingNow = (typeof editing !== 'undefined' && editing) || KamEdit.active();
    const t = allow && !editingNow ? targetAt(pi, x, y) : null;
    if (!same(t, hover)) {
      hover = t; drawOverlay();
      if (t && !picked) $('#hint').textContent = 'Click to select this text, double-click to edit it';
      else if (!picked && !editingNow) updateProps();
    }
    return !!t;
  };

  /* ---------- single click: pick a line so it can be deleted ---------- */
  window.pdfTextSelect = (x, y) => {
    const pi = state.cur, clicked = ++clickSeq;
    // clicked before the page's text has been read: pick it as soon as it has
    if (!KamContent.cached(pi) || !KamPdfText.cached(pi)) {
      Promise.all([KamContent.analyse(pi), KamPdfText.index(pi)]).then(() => {
        if (clicked === clickSeq && pi === state.cur && !picked && state.tool === 'select') window.pdfTextSelect(x, y);
      }).catch(() => { });
    }
    const t = targetAt(pi, x, y);
    if (t) { t.x = x; t.y = y; }
    picked = t;
    $('#hint').textContent = t ? 'Press Delete to remove this text, or double-click to edit it' : '';
    if (!t) updateProps();
    drawOverlay();
    return !!t;
  };

  /* ---------- Delete: take the picked line out of the document ---------- */
  window.pdfTextDeleteSelected = () => {
    if (!picked || picked.page !== state.cur) return false;
    // picked before the page's text had been read? It may be something the engine can do properly
    if (picked.kind === 'run' && picked.x !== undefined) {
      const again = targetAt(picked.page, picked.x, picked.y);
      if (again && again.kind === 'phrase') picked = again;
    }
    const t = picked, pageId = state.pageIds[state.cur];
    if (t.kind === 'phrase') {
      // The words are taken out of the page itself. Nothing is painted over them, so table
      // rules, shading and anything else near the line stay exactly as they were.
      const an = KamContent.cached(state.cur); if (!an || !an.ok) return false;
      pushAnnotUndo(pageId);
      const list = state.annots[pageId] || (state.annots[pageId] = []);
      let e = t.item.edit ? list.find(a => a.id === t.item.edit.id) : null;
      if (e) e.text = '';
      else { e = KamContent.newEdit(an, t.item.ph, ''); Object.assign(e, KamContent.boxFields(t.item.ph.box)); list.push(e); }
      picked = null; hover = null;
      drawOverlay(); refreshThumb(state.cur); updateProps();
      toast('Deleted from the page itself, so nothing around it moves. Ctrl+Z brings it back.', 5000);
      return true;
    }
    const r = t.item;
    pushAnnotUndo(pageId);
    const cover = coverFor(r, analyse(r));
    // A redaction rather than a patch of paint: when you press Delete you mean the words to be
    // gone, and a cover would leave them in the file for anyone to extract.
    cover.redact = true; cover.fill = '#ffffff'; cover.note = r.text;
    curAnnots().push(cover);
    picked = null; hover = null;
    drawOverlay(); refreshThumb(state.cur); updateProps();
    toast('Deleted. The words are removed from the file when you save. Ctrl+Z undoes it.', 5000);
    return true;
  };

  /* ---------- double-click: edit a line of the PDF's text ---------- */
  window.pdfTextEditAt = async (x, y) => {
    if (!state.doc) return false;
    const pi = state.cur;
    await KamContent.analyse(pi).catch(() => null);
    await KamPdfText.index(pi).catch(() => null);
    if (pi !== state.cur) return false;
    const t = targetAt(pi, x, y);
    if (!t) return false;
    hover = null; picked = null;
    if (t.kind === 'phrase') return KamEdit.start(pi, t.item, x, y);
    // the older way: cover the line and type over it, keeping its size and baseline
    const r = t.item, look = analyse(r);
    pushAnnotUndo(state.pageIds[pi]);
    const txt = { id: uid(), type: 'text', x: 0, y: 0, w: 0, h: 0, rot: r.rot, text: r.text,
                  size: r.size, font: fontFor(r), bold: /bold|black|heavy|semibold|demi/i.test(r.fontLabel),
                  color: look.fg, opacity: 1 };
    txt.x = r.base[0] + 0.9 * txt.size * r.perp[0];
    txt.y = r.base[1] + 0.9 * txt.size * r.perp[1];
    measureText(txt);
    curAnnots().push(coverFor(r, look), txt);
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
    <button id="findPrev" title="Previous match (Shift+Enter)" aria-label="Previous match"><svg class="ic" aria-hidden="true"><use href="#i-up"/></svg></button><button id="findNext" title="Next match (Enter)" aria-label="Next match"><svg class="ic" aria-hidden="true"><use href="#i-down"/></svg></button>
    <button id="findClose" title="Close (Esc)" aria-label="Close"><svg class="ic" aria-hidden="true"><use href="#i-close"/></svg></button>`;
  $('#viewer').appendChild(bar);
  const input = $('#findInput');

  function updateCount() {
    const n = find.matches.length;
    $('#findCount').textContent = n ? `${find.cur + 1} of ${n}` : (find.q ? 'No matches' : '');
  }
  async function showMatch() {
    const m = find.matches[find.cur]; if (!m) return;
    if (m.page !== state.cur) KamView.setActive(m.page);
    KamView.reveal(m.page, m.run.x + KamPdfText.uAt(m.run, m.start) - m.run.u0, m.run.y + m.run.h / 2);
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
  // an edit changes the text on its page: a search made before it would point at the old words
  document.addEventListener('kam:textchanged', () => { if (find.open && find.q) runSearch(); });

  /* ---------- the overlay: edits in progress, hover box, picked box, search matches ---------- */
  window.drawPdfTextLayer = (ctx, s, pi = state.cur) => {
    const dpr = window.devicePixelRatio || 1;
    if (find.docRef && find.docRef !== state.pdfjs) { find.matches = []; find.cur = -1; find.docRef = state.pdfjs; if (find.open) updateCount(); }
    // While the page picture is being redrawn after an edit, the edits are drawn here so the
    // new words are there straight away.
    if (typeof KamPatch !== 'undefined' && KamView.canvasSig(pi) !== KamPatch.sigFor(pi)) {
      const editingKey = KamEdit.sessionFor(pi);
      for (const it of KamContent.current(pi)) if (it.edit && it.lay && it.ph.key !== editingKey) KamContent.drawLayout(ctx, s, it.lay);
    }
    KamEdit.draw(ctx, s, pi);
    if (find.open && find.matches.length) {
      find.matches.forEach((m, i) => {
        if (m.page !== pi) return;
        const r = m.run, ua = KamPdfText.uAt(r, m.start) - r.u0, ub = KamPdfText.uAt(r, m.end) - r.u0;
        ctx.save(); ctx.translate(r.x * s, r.y * s); ctx.rotate(r.rot * Math.PI / 180);
        ctx.fillStyle = i === find.cur ? 'rgba(245,180,0,.55)' : 'rgba(245,180,0,.28)';
        ctx.fillRect(ua * s, -1.5 * s, (ub - ua) * s, (r.h + 3) * s);
        if (i === find.cur) { ctx.strokeStyle = '#f5b400'; ctx.lineWidth = 1.5 * dpr; ctx.strokeRect(ua * s, -1.5 * s, (ub - ua) * s, (r.h + 3) * s); }
        ctx.restore();
      });
    }
    const mark = (b, fill, stroke, dash) => {
      ctx.save(); ctx.translate(b.x * s, b.y * s); ctx.rotate(b.rot * Math.PI / 180);
      ctx.fillStyle = fill; ctx.fillRect(-2 * s, -2 * s, (b.w + 4) * s, (b.h + 4) * s);
      ctx.strokeStyle = stroke; ctx.lineWidth = (dash ? 1 : 1.6) * dpr; if (dash) ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.strokeRect(-2 * s, -2 * s, (b.w + 4) * s, (b.h + 4) * s);
      ctx.restore();
    };
    if (pi !== state.cur) return;
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
    const editingNow = (typeof editing !== 'undefined' && editing) || KamEdit.active();
    if (picked && picked.page === state.cur && !editingNow) mark(boxOf(picked), 'rgba(59,130,246,.20)', 'rgba(59,130,246,1)', false);
    else if (hover && hover.page === state.cur && state.tool === 'select' && !editingNow && !o) mark(boxOf(hover), 'rgba(59,130,246,.10)', 'rgba(59,130,246,.9)', true);
  };
})();
