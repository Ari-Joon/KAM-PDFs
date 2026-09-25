/* KAM PDFs - retyping the PDF's own text, in its own font, right where it is.
 *
 * Double-click a line and it becomes editable in place. What you see while typing is drawn
 * from the same layout that is written into the file (content.js): the PDF's own glyph
 * outlines at their own positions, new letters in the same font (or its bundled twin), and
 * the rest of the line moving along as you type. The typing itself goes into a hidden text
 * box, so the keyboard, selection, clipboard, undo and input methods all behave as usual.
 */
'use strict';
const KamEdit = (() => {
  let S = null, blink = 0, raf = 0;
  const ta = document.createElement('textarea');
  ta.id = 'phraseInput'; ta.rows = 1; ta.wrap = 'off'; ta.spellcheck = false;
  ta.setAttribute('autocomplete', 'off'); ta.setAttribute('autocorrect', 'off'); ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('aria-label', 'Edit this text');

  const sessionFor = i => (S && S.page === i && state.pageIds[i] === S.pageId ? S.ph.key : null);
  const active = () => !!S;
  const clean = t => t.replace(/[\r\n]/g, ' ');

  function relayout() {
    if (!S) return;
    const text = clean(ta.value);
    const lay = KamContent.layout(S.an, S.ph, text);
    S.lay = lay; S.text = text;
    if (lay.needs.length) {
      Promise.all(lay.needs.map(k => KamFonts.bundled(k).catch(() => null))).then(() => { if (S) { relayout(); redraw(); } });
    }
    if (lay.missing.length && !S.warned) {
      S.warned = true;
      toast(`“${[...new Set(lay.missing)].join(' ')}” is not in this font, nor in the fonts that come with KAM PDFs, so it cannot be shown here.`, 6000);
    }
  }
  function redraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (S && typeof KamView !== 'undefined') KamView.drawPageOverlay(S.page); });
  }
  // Where the caret can stand: before the first letter, then after each one.
  function stops() {
    const ch = S.lay.chars;
    if (!ch.length) return [S.lay.u0];
    const out = [ch[0][0]];
    for (const c of ch) out.push(c[1]);
    return out;
  }
  function indexAt(x, y) {
    const d = S.ph.dir, u = x * d[0] + y * d[1], st = stops();
    let best = 0, bd = Infinity;
    st.forEach((v, k) => { const dd = Math.abs(v - u); if (dd < bd) { bd = dd; best = k; } });
    return best;
  }
  function inside(pi, x, y, pad = 4) {
    if (!S || pi !== S.page) return false;
    const b = S.lay.box, t = b.rot * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), dx = x - b.x, dy = y - b.y;
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    return lx >= -pad && ly >= -pad && lx <= b.w + pad && ly <= b.h + pad;
  }

  async function start(pi, item, x, y) {
    if (typeof commitTextEdit === 'function') commitTextEdit();
    const an = KamContent.cached(pi);
    if (!an || !an.ok || !item || !item.ph || !item.ph.editable) return false;
    try { await KamFonts.ready(); }
    catch (e) { toast('The font reader did not load, so this text cannot be edited in its own font.', 5000); return false; }
    const text = item.edit ? item.edit.text : item.ph.text;
    // everything the line needs to be drawn, loaded before the first letter
    try { await KamContent.layoutReady(an, item.ph, text); } catch (e) { console.warn(e); return false; }
    if (KamContent.cached(pi) !== an || pi >= state.pageIds.length) return false;       // the page changed meanwhile
    if (typeof commitTextEdit === 'function') commitTextEdit();
    S = { page: pi, pageId: state.pageIds[pi], an, ph: item.ph, edit: item.edit, start: text, text, lay: null, caretOn: true, dragFrom: null };
    ta.value = text;
    relayout();
    // the matching fonts for letters the PDF's own font does not have, fetched quietly now
    // so typing one does not wait
    const fonts = new Set(item.ph.glyphs.map(id => an.fontOf(an.ops[an.glyphs[id].op].font)));
    for (const f of fonts) KamFonts.bundled(KamFonts.fallbackKey(f)).catch(() => null);
    const host = KamView.pageEl(pi); if (host) host.appendChild(ta);
    position();
    ta.focus({ preventScroll: true });
    const k = x === undefined ? text.length : indexAt(x, y);
    ta.setSelectionRange(k, k);
    clearInterval(blink);
    blink = setInterval(() => { if (!S) return; S.caretOn = !S.caretOn; redraw(); }, 530);
    KamView.invalidate(pi);                    // the page underneath, redrawn without this line
    drawOverlay();
    if (typeof touchGrab === 'function') touchGrab();
    $('#hint').textContent = 'Editing the page’s own text, in its own font. Enter or Esc when you are done.';
    return true;
  }
  // A phone's keyboard takes the bottom of the screen when it opens: keep the line in view.
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => {
    if (!S) return;
    const b = S.lay.box; KamView.reveal(S.page, b.x + b.w / 2, b.y + b.h / 2);
  });
  // The hidden text box sits on the line, so a spelling or input-method window opens there.
  function position() {
    if (!S) return;
    const b = S.lay.box, z = state.zoom;
    ta.style.left = (b.x * z) + 'px'; ta.style.top = (b.y * z) + 'px';
    ta.style.height = Math.max(6, b.h * z) + 'px'; ta.style.fontSize = Math.max(6, b.h * z * 0.75) + 'px';
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
      let e = s.edit ? list.find(a => a.id === s.edit.id) : null;
      if (text === s.ph.text) { if (e) list.splice(list.indexOf(e), 1); e = null; }     // back to how it was
      else if (e) e.text = text;
      else { e = KamContent.newEdit(s.an, s.ph, text); list.push(e); }
      if (e) Object.assign(e, KamContent.boxFields(KamContent.layout(s.an, s.ph, text).box));
    }
    const pi = state.pageIds.indexOf(s.pageId);
    if (pi >= 0) { KamView.invalidate(pi); refreshThumb(pi); }
    drawOverlay();
    if (typeof updateProps === 'function') updateProps();
  }

  ta.addEventListener('keydown', e => {
    if (!S) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); commit(); e.stopPropagation(); return; }
    S.caretOn = true;
    // Save and print still work from here; everything else belongs to the text
    if (mod && ['s', 'p', 'o'].includes(e.key.toLowerCase())) { commit(); return; }
    e.stopPropagation();
  });
  ta.addEventListener('input', () => { if (!S) return; relayout(); S.caretOn = true; position(); redraw(); });
  ta.addEventListener('blur', () => { if (S) setTimeout(() => { if (S && document.activeElement !== ta) commit(); }, 0); });
  document.addEventListener('selectionchange', () => { if (S && document.activeElement === ta) { S.caretOn = true; redraw(); } });

  /* ---------- the mouse, while a line is being edited ---------- */
  function setSel(a, b) { if (a <= b) ta.setSelectionRange(a, b, 'forward'); else ta.setSelectionRange(b, a, 'backward'); }
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

  /* ---------- drawing the line being edited ---------- */
  function draw(ctx, s, pi) {
    if (!S || pi !== S.page) return;
    const lay = S.lay, ph = S.ph, d = ph.dir, p = ph.perp, dpr = window.devicePixelRatio || 1;
    const P = (u, v) => [(d[0] * u + p[0] * v) * s, (d[1] * u + p[1] * v) * s];
    const b = lay.box;
    ctx.save();
    ctx.translate(b.x * s, b.y * s); ctx.rotate(b.rot * Math.PI / 180);
    ctx.strokeStyle = 'rgba(59,130,246,.75)'; ctx.lineWidth = dpr; ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.strokeRect(-3 * dpr, -2 * dpr, b.w * s + 6 * dpr, b.h * s + 4 * dpr);
    ctx.restore();
    const st = stops(), a = Math.min(ta.selectionStart, ta.selectionEnd), z = Math.max(ta.selectionStart, ta.selectionEnd);
    const at = k => st[Math.max(0, Math.min(st.length - 1, k))];
    if (a !== z) {
      ctx.save(); ctx.fillStyle = 'rgba(59,130,246,.32)'; ctx.beginPath();
      const q = [P(at(a), ph.bot), P(at(z), ph.bot), P(at(z), ph.top), P(at(a), ph.top)];
      ctx.moveTo(...q[0]); for (const c of q.slice(1)) ctx.lineTo(...c); ctx.closePath(); ctx.fill(); ctx.restore();
    }
    KamContent.drawLayout(ctx, s, lay);
    if (a === z && S.caretOn && document.activeElement === ta) {
      const op = S.an.ops[S.an.glyphs[lay.ref].op], c = op && op.fill;
      ctx.save();
      ctx.strokeStyle = c ? `rgb(${c[0]},${c[1]},${c[2]})` : '#111'; ctx.lineWidth = Math.max(1, 1.25 * dpr);
      const u = at(a), p0 = P(u, ph.bot), p1 = P(u, ph.top);
      ctx.beginPath(); ctx.moveTo(...p0); ctx.lineTo(...p1); ctx.stroke();
      ctx.restore();
    }
  }

  return { start, commit, active, sessionFor, draw, inside, pointerDown, pointerMove, pointerUp, selectWordAt, position };
})();
