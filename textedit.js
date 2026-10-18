/* KAM PDFs - retyping the PDF's own text, in its own font, right where it is.
 *
 * Double-click a line and it becomes editable in place. A line that is part of a paragraph
 * brings the whole paragraph with it, so words flow from one line into the next as you type,
 * the way a word processor would. What you see while typing is drawn from the same layout that
 * is written into the file (content.js): the PDF's own glyph outlines at their own positions,
 * new letters in the same font (or its bundled twin), and the rest of the text moving along.
 * The typing itself goes into a hidden text box, so the keyboard, selection, clipboard, undo
 * and input methods all behave as usual.
 */
'use strict';
const KamEdit = (() => {
  let S = null, blink = 0, raf = 0;
  const ta = document.createElement('textarea');
  ta.id = 'phraseInput'; ta.rows = 1; ta.wrap = 'off'; ta.spellcheck = false;
  ta.setAttribute('autocomplete', 'off'); ta.setAttribute('autocorrect', 'off'); ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('aria-label', 'Edit this text');

  // the keys of the lines being retyped: one line, or every line of a paragraph
  const sessionFor = i => (S && S.page === i && state.pageIds[i] === S.pageId ? S.keys : null);
  const active = () => !!S;
  const isPara = () => !!S && S.unit.kind === 'para';
  const clean = t => t.replace(/[\r\n]/g, ' ');

  function relayout() {
    if (!S) return;
    const text = clean(ta.value);
    const lay = S.unit.kind === 'para' ? KamContent.layoutPara(S.an, S.unit.para, text) : KamContent.layout(S.an, S.unit.ph, text);
    S.lay = lay; S.text = text; S.geo = geometry(lay);
    if (lay.needs.length) {
      Promise.all(lay.needs.map(k => KamFonts.bundled(k).catch(() => null))).then(() => { if (S) { relayout(); redraw(); } });
    }
    if (lay.missing.length && !S.warned) {
      S.warned = true;
      toast(`“${[...new Set(lay.missing)].join(' ')}” is not in this font, nor in the fonts that come with KAM PDFs, so it cannot be shown here.`, 6000);
    }
    if (lay.overflow && !S.warnedRoom) {
      S.warnedRoom = true;
      toast('There is no room below this paragraph for another line, so its end runs past the margin. Shorten it, or make room under it.', 7000);
    }
  }
  // Where the caret can stand (stops), the band of each line (slots), what to draw and the box
  // round it all: the same shape for one line and for a paragraph.
  function geometry(lay) {
    if (S.unit.kind === 'para') {
      return { stops: lay.stops, slots: lay.slots.map(sl => ({ top: sl.top, bot: sl.bot })), lays: lay.slots.filter(sl => sl.toks.length).map(sl => sl.lay), box: lay.box };
    }
    const ph = S.unit.ph, ch = lay.chars, st = [];
    if (!ch.length) st.push({ slot: 0, u: lay.u0 });
    else { st.push({ slot: 0, u: ch[0][0] }); for (const c of ch) st.push({ slot: 0, u: c[1] }); }
    return { stops: st, slots: [{ top: ph.top, bot: ph.bot }], lays: [lay], box: lay.box };
  }
  function redraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (S && typeof KamView !== 'undefined') KamView.drawPageOverlay(S.page); });
  }
  // the place in the text nearest a point: on the line under it (or the nearest line)
  function indexAt(x, y) {
    const d = S.dir, p = S.perp, u = x * d[0] + y * d[1], v = x * p[0] + y * p[1], { stops, slots } = S.geo;
    let line = stops[0].slot, bd = Infinity;
    const used = new Set(stops.map(s => s.slot));
    for (const j of used) { const sl = slots[j]; const dd = v > sl.top ? v - sl.top : v < sl.bot ? sl.bot - v : 0; if (dd < bd) { bd = dd; line = j; } }
    let best = 0; bd = Infinity;
    stops.forEach((s, k) => { if (s.slot !== line) return; const dd = Math.abs(s.u - u); if (dd < bd) { bd = dd; best = k; } });
    return best;
  }
  function inside(pi, x, y, pad = 4) {
    if (!S || pi !== S.page) return false;
    const b = S.geo.box, t = b.rot * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), dx = x - b.x, dy = y - b.y;
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    return lx >= -pad && ly >= -pad && lx <= b.w + pad && ly <= b.h + pad;
  }

  async function start(pi, item, x, y) {
    if (typeof commitTextEdit === 'function') commitTextEdit();
    const an = KamContent.cached(pi);
    if (!an || !an.ok || !item || !item.ph || !item.ph.editable) return false;
    const unit = KamContent.unitOf(pi, item);
    if (!unit) return false;
    try { await KamFonts.ready(); }
    catch (e) { toast('The font reader did not load, so this text cannot be edited in its own font.', 5000); return false; }
    // everything the text needs to be drawn, loaded before the first letter
    try {
      if (unit.kind === 'para') await KamContent.paraLayoutReady(an, unit.para, unit.text);
      else await KamContent.layoutReady(an, unit.ph, unit.text);
    } catch (e) { console.warn(e); return false; }
    if (KamContent.cached(pi) !== an || pi >= state.pageIds.length) return false;       // the page changed meanwhile
    if (typeof commitTextEdit === 'function') commitTextEdit();
    const lines = unit.kind === 'para' ? unit.para.lines : [unit.ph];
    S = { page: pi, pageId: state.pageIds[pi], an, unit, keys: lines.map(l => l.key), dir: lines[0].dir, perp: lines[0].perp,
          start: unit.text, text: unit.text, lay: null, geo: null, caretOn: true, dragFrom: null };
    ta.value = unit.text;
    relayout();
    // the matching fonts for letters the PDF's own fonts do not have, fetched quietly now so
    // typing one does not wait
    const fonts = new Set(lines.flatMap(ph => ph.glyphs.map(id => an.fontOf(an.ops[an.glyphs[id].op].font))));
    for (const f of fonts) KamFonts.bundled(KamFonts.fallbackKey(f)).catch(() => null);
    const host = KamView.pageEl(pi); if (host) host.appendChild(ta);
    position();
    ta.focus({ preventScroll: true });
    const k = x === undefined ? unit.text.length : indexAt(x, y);
    ta.setSelectionRange(k, k);
    clearInterval(blink);
    blink = setInterval(() => { if (!S) return; S.caretOn = !S.caretOn; redraw(); }, 530);
    KamView.invalidate(pi);                    // the page underneath, redrawn without this text
    drawOverlay();
    if (typeof updateProps === 'function') updateProps();          // the property row says what this is
    $('#hint').textContent = unit.kind === 'para'
      ? 'Words flow from line to line as you type. Enter or Esc to finish.'
      : 'Editing in the page’s own font. Enter or Esc to finish.';
    return true;
  }
  // A phone's keyboard takes the bottom of the screen when it opens: keep the text in view.
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => {
    if (!S) return;
    const b = S.geo.box; KamView.reveal(S.page, b.x + b.w / 2, b.y + b.h / 2);
  });
  // The hidden text box sits on the text, so a spelling or input-method window opens there.
  function position() {
    if (!S) return;
    const b = S.geo.box, z = state.zoom, lh = Math.max(6, (S.geo.slots[0].top - S.geo.slots[0].bot) * z);
    ta.style.left = (b.x * z) + 'px'; ta.style.top = (b.y * z) + 'px';
    ta.style.height = lh + 'px'; ta.style.fontSize = Math.max(6, lh * 0.75) + 'px';
  }

  function commit() {
    if (!S) return;
    const s = S; S = null;
    clearInterval(blink); blink = 0;
    const text = clean(ta.value);
    if (document.activeElement === ta) ta.blur();
    ta.remove();
    if (text !== s.start && state.pageIds.includes(s.pageId)) {
      pushAnnotUndo(s.pageId);
      const list = state.annots[s.pageId] || (state.annots[s.pageId] = []);
      const u = s.unit;
      let e = u.edit ? list.find(a => a.id === u.edit.id) : null;
      if (u.kind === 'para') {
        // edits made to single lines of this paragraph before are part of the paragraph's now
        for (const x of u.oldEdits) { const k = list.indexOf(x); if (k >= 0) list.splice(k, 1); }
        if (text === u.para.origText) { if (e) list.splice(list.indexOf(e), 1); e = null; }       // back to how it was
        else if (e) e.text = text;
        else { e = KamContent.newParaEdit(s.an, u.para, text); list.push(e); }
        if (e) Object.assign(e, KamContent.boxFields(KamContent.layoutPara(s.an, u.para, text).box));
      } else {
        if (text === u.ph.text) { if (e) list.splice(list.indexOf(e), 1); e = null; }
        else if (e) e.text = text;
        else { e = KamContent.newEdit(s.an, u.ph, text); list.push(e); }
        if (e) Object.assign(e, KamContent.boxFields(KamContent.layout(s.an, u.ph, text).box));
      }
    }
    const pi = state.pageIds.indexOf(s.pageId);
    if (pi >= 0) { KamView.invalidate(pi); refreshThumb(pi); }
    drawOverlay();
    if (typeof updateProps === 'function') updateProps();
  }

  /* ---------- the keyboard ---------- */
  function setSel(a, b) { if (a <= b) ta.setSelectionRange(a, b, 'forward'); else ta.setSelectionRange(b, a, 'backward'); }
  // In a paragraph, Up and Down go to the line above or below, Home and End to the ends of the
  // line: the hidden text box is one long line, so it cannot know.
  function lineKey(e) {
    const { stops } = S.geo;
    const focus = ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd;
    const anchor = ta.selectionDirection === 'backward' ? ta.selectionEnd : ta.selectionStart;
    const cur = stops[Math.min(focus, stops.length - 1)];
    const on = j => stops.map((st, i) => [st, i]).filter(([st]) => st.slot === j);
    let k = focus;
    if (e.key === 'Home') k = on(cur.slot)[0][1];
    else if (e.key === 'End') { const l = on(cur.slot); k = l[l.length - 1][1]; }
    else {
      const order = [...new Set(stops.map(st => st.slot))];
      const at = order.indexOf(cur.slot) + (e.key === 'ArrowUp' ? -1 : 1);
      if (at < 0) k = 0;
      else if (at >= order.length) k = stops.length - 1;
      else { let bd = Infinity; for (const [st, i] of on(order[at])) { const dd = Math.abs(st.u - cur.u); if (dd < bd) { bd = dd; k = i; } } }
    }
    if (e.shiftKey) setSel(anchor, k); else ta.setSelectionRange(k, k);
  }
  ta.addEventListener('keydown', e => {
    if (!S) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); commit(); e.stopPropagation(); return; }
    S.caretOn = true;
    // Save, print and open still work from here; everything else belongs to the text
    if (mod && ['s', 'p', 'o'].includes(e.key.toLowerCase())) { commit(); return; }
    if (S.unit.kind === 'para' && !mod && !e.altKey && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); lineKey(e); redraw(); e.stopPropagation(); return;
    }
    e.stopPropagation();
  });
  ta.addEventListener('input', () => { if (!S) return; relayout(); S.caretOn = true; position(); redraw(); });
  ta.addEventListener('blur', () => { if (S) setTimeout(() => { if (S && document.activeElement !== ta) commit(); }, 0); });
  document.addEventListener('selectionchange', () => { if (S && document.activeElement === ta) { S.caretOn = true; redraw(); } });

  /* ---------- the mouse, while text is being edited ---------- */
  function pointerDown(pi, x, y, e) {
    if (!inside(pi, x, y)) return false;
    const k = indexAt(x, y);
    if (e && e.shiftKey) { const a = ta.selectionDirection === 'backward' ? ta.selectionEnd : ta.selectionStart; setSel(a, k); S.dragFrom = a; }
    else { ta.setSelectionRange(k, k); S.dragFrom = k; }
    S.caretOn = true;
    ta.focus({ preventScroll: true });
    redraw();
    return true;
  }
  function pointerMove(x, y) { if (!S || S.dragFrom === null) return; setSel(S.dragFrom, indexAt(x, y)); redraw(); }
  function pointerUp() { if (S) S.dragFrom = null; }
  function selectWordAt(x, y) {
    if (!S) return;
    const k = indexAt(x, y), t = ta.value, w = /[\p{L}\p{N}_'’\-]/u;
    let a = k, b = k;
    while (a > 0 && w.test(t[a - 1])) a--;
    while (b < t.length && w.test(t[b])) b++;
    ta.setSelectionRange(a, b); redraw();
  }

  /* ---------- drawing the text being edited ---------- */
  function draw(ctx, s, pi) {
    if (!S || pi !== S.page) return;
    const { stops, slots, lays, box: b } = S.geo, d = S.dir, p = S.perp, dpr = window.devicePixelRatio || 1;
    const P = (u, v) => [(d[0] * u + p[0] * v) * s, (d[1] * u + p[1] * v) * s];
    ctx.save();
    ctx.translate(b.x * s, b.y * s); ctx.rotate(b.rot * Math.PI / 180);
    ctx.strokeStyle = 'rgba(59,130,246,.75)'; ctx.lineWidth = dpr; ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.strokeRect(-3 * dpr, -2 * dpr, b.w * s + 6 * dpr, b.h * s + 4 * dpr);
    ctx.restore();
    const a = Math.min(ta.selectionStart, ta.selectionEnd), z = Math.max(ta.selectionStart, ta.selectionEnd);
    const at = k => stops[Math.max(0, Math.min(stops.length - 1, k))];
    if (a !== z) {
      // the selection, a band on each line it touches
      const spans = new Map();
      for (let k = a; k <= z; k++) { const st = at(k), sp = spans.get(st.slot); if (!sp) spans.set(st.slot, [st.u, st.u]); else { sp[0] = Math.min(sp[0], st.u); sp[1] = Math.max(sp[1], st.u); } }
      ctx.save(); ctx.fillStyle = 'rgba(59,130,246,.32)';
      for (const [j, [u0, u1]] of spans) {
        if (u1 - u0 < 0.05) continue;
        const sl = slots[j], q = [P(u0, sl.bot), P(u1, sl.bot), P(u1, sl.top), P(u0, sl.top)];
        ctx.beginPath(); ctx.moveTo(...q[0]); for (const c of q.slice(1)) ctx.lineTo(...c); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
    for (const lay of lays) KamContent.drawLayout(ctx, s, lay);
    if (a === z && S.caretOn && document.activeElement === ta) {
      const op = S.an.ops[S.an.glyphs[S.lay.ref].op], c = op && op.fill;
      const st = at(a), sl = slots[st.slot];
      ctx.save();
      ctx.strokeStyle = c ? `rgb(${c[0]},${c[1]},${c[2]})` : '#111'; ctx.lineWidth = Math.max(1, 1.25 * dpr);
      const p0 = P(st.u, sl.bot), p1 = P(st.u, sl.top);
      ctx.beginPath(); ctx.moveTo(...p0); ctx.lineTo(...p1); ctx.stroke();
      ctx.restore();
    }
  }

  return { start, commit, active, isPara, sessionFor, draw, inside, pointerDown, pointerMove, pointerUp, selectWordAt, position };
})();
