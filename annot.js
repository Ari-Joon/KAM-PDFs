/* Free PDF Editor — annotations: drawing, tools, editing */
'use strict';
/*
  Annotation coordinates are in PDF points, in the page's *displayed* frame
  (origin top-left, y down, rotation applied). Box annotations (text, rect,
  ellipse, image) have x,y = local top-left, w,h, and rot (clockwise degrees).
  Path annotations (pen, line, arrow) have pts.
*/
const overlay = $('#overlay');
const measureCtx = document.createElement('canvas').getContext('2d');
const imgCache = new Map();

function curPageId() { return state.pageIds[state.cur]; }
function curAnnots() { const id = curPageId(); if (!state.annots[id]) state.annots[id] = []; return state.annots[id]; }
function fontFamily(f) { return f === 'TimesRoman' ? '"Times New Roman",Times,serif' : f === 'Courier' ? '"Courier New",Courier,monospace' : 'Helvetica,Arial,sans-serif'; }
function fontCss(a, s) { return `${a.bold ? 'bold ' : ''}${a.size * s}px ${fontFamily(a.font)}`; }
// Break text into lines. With a fixed box width (a.boxW) words wrap automatically.
function wrapLines(a) {
  measureCtx.font = fontCss(a, 1);
  const out = [];
  for (const para of (a.text || '').split('\n')) {
    if (!a.boxW) { out.push(para); continue; }
    let line = '';
    for (const w of para.split(' ')) {
      const test = line ? line + ' ' + w : w;
      if (measureCtx.measureText(test).width <= a.boxW) { line = test; continue; }
      if (line) { out.push(line); line = ''; }
      if (measureCtx.measureText(w).width <= a.boxW) { line = w; continue; }
      let chunk = '';
      for (const ch of w) { if (chunk && measureCtx.measureText(chunk + ch).width > a.boxW) { out.push(chunk); chunk = ch; } else chunk += ch; }
      line = chunk;
    }
    out.push(line);
  }
  return out.length ? out : [''];
}
function measureText(a) {
  const lines = wrapLines(a); a.lines = lines;
  measureCtx.font = fontCss(a, 1);
  const natural = Math.max(10, ...lines.map(l => measureCtx.measureText(l || ' ').width));
  a.w = a.boxW ? Math.max(10, a.boxW) : natural;
  a.h = lines.length * a.size * 1.2;
}
function getImg(a) {
  let img = imgCache.get(a.src);
  if (!img) { img = new Image(); img.src = a.src; img.onload = () => { drawOverlay(); refreshThumb(state.cur); }; imgCache.set(a.src, img); }
  return img;
}
function arrowHead(a) {
  const n = a.pts.length; if (n < 2) return [];
  const [x0, y0] = a.pts[n - 2], [x1, y1] = a.pts[n - 1];
  const ang = Math.atan2(y1 - y0, x1 - x0), len = Math.max(10, a.width * 4);
  return [[x1 - len * Math.cos(ang - 0.5), y1 - len * Math.sin(ang - 0.5)], [x1 - len * Math.cos(ang + 0.5), y1 - len * Math.sin(ang + 0.5)]];
}

/* ---------- drawing ---------- */
function drawAnnots(ctx, pageId, s, selected, opts) {
  const spell = !opts || opts.spell !== false;
  const marks = !opts || opts.marks !== false;
  for (const a of (state.annots[pageId] || [])) { if (!a._editing && !a.hidden) drawAnnot(ctx, a, s, spell, marks); }
  if (selected) drawSelection(ctx, selected, s);
}
/* A deletion is a white patch, which on white paper is invisible: you cannot tell the area
   has been dealt with, and clicking there and pressing Delete quietly takes the patch away
   and brings the words back. So on screen it gets hatched. Never drawn into the file. */
function drawRedactionMark(ctx, w, h, s) {
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
  ctx.strokeStyle = 'rgba(225,29,72,.30)'; ctx.lineWidth = Math.max(1, dpr);
  const step = Math.max(6 * dpr, 7 * s);
  for (let x = -h; x < w + h; x += step) { ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + h, 0); ctx.stroke(); }
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = 'rgba(225,29,72,.75)'; ctx.lineWidth = Math.max(1, dpr);
  ctx.setLineDash([4 * dpr, 3 * dpr]); ctx.strokeRect(0, 0, w, h);
  ctx.restore();
}
/* Red dotted underline beneath misspelled words. Screen only: it is never exported. */
function drawSpellMarks(ctx, a, s) {
  if (typeof KamSpell === 'undefined' || !KamSpell.ready) return;
  if (typeof spellUnderlineOn !== 'function' || !spellUnderlineOn()) return;
  ctx.save();
  ctx.strokeStyle = '#ef4444'; ctx.lineWidth = Math.max(1, 1.4 * s / 2); ctx.setLineDash([2 * s / 2, 2 * s / 2]);
  ctx.font = fontCss(a, s);
  const lh = a.size * 1.2 * s;
  (a.lines || a.text.split('\n')).forEach((line, i) => {
    const y = i * lh + a.size * 1.06 * s;
    for (const t of KamSpell.tokens(line)) {
      if (!KamSpell.isMisspelled(t.word)) continue;
      const x1 = ctx.measureText(line.slice(0, t.start)).width;
      const x2 = ctx.measureText(line.slice(0, t.end)).width;
      ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
    }
  });
  ctx.restore();
}
function drawAnnot(ctx, a, s, spell, marks) {
  ctx.save();
  ctx.globalAlpha = a.opacity == null ? 1 : a.opacity;
  if (a.blend === 'multiply') ctx.globalCompositeOperation = 'multiply';
  if (a.pts) {
    ctx.strokeStyle = a.color; ctx.lineWidth = a.width * s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    a.pts.forEach((p, i) => i ? ctx.lineTo(p[0] * s, p[1] * s) : ctx.moveTo(p[0] * s, p[1] * s));
    if (a.pts.length === 1) ctx.lineTo(a.pts[0][0] * s + 0.1, a.pts[0][1] * s);
    if (a.type === 'arrow') { const tip = a.pts[a.pts.length - 1]; for (const h of arrowHead(a)) { ctx.moveTo(tip[0] * s, tip[1] * s); ctx.lineTo(h[0] * s, h[1] * s); } }
    ctx.stroke();
  } else {
    ctx.translate(a.x * s, a.y * s); ctx.rotate(a.rot * Math.PI / 180);
    const w = a.w * s, h = a.h * s;
    if (a.type === 'text') {
      ctx.fillStyle = a.color; ctx.font = fontCss(a, s); ctx.textBaseline = 'alphabetic';
      const lh = a.size * 1.2 * s;
      (a.lines || a.text.split('\n')).forEach((line, i) => ctx.fillText(line, 0, i * lh + a.size * 0.9 * s));
      if (spell) drawSpellMarks(ctx, a, s);
    } else if (a.type === 'rect') {
      if (a.fill) { ctx.fillStyle = a.fill; ctx.fillRect(0, 0, w, h); }
      if (a.stroke) { ctx.strokeStyle = a.stroke; ctx.lineWidth = a.width * s; ctx.strokeRect(0, 0, w, h); }
      if (marks && a.redact) drawRedactionMark(ctx, w, h, s);
    } else if (a.type === 'ellipse') {
      ctx.beginPath(); ctx.ellipse(w / 2, h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
      if (a.fill) { ctx.fillStyle = a.fill; ctx.fill(); }
      if (a.stroke) { ctx.strokeStyle = a.stroke; ctx.lineWidth = a.width * s; ctx.stroke(); }
    } else if (a.type === 'image') {
      const img = getImg(a); if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, w, h);
    }
  }
  ctx.restore();
}
function drawSelection(ctx, a, s) {
  const dpr = window.devicePixelRatio || 1;
  ctx.save(); ctx.strokeStyle = '#f5b400'; ctx.lineWidth = 1 * dpr; ctx.setLineDash([4 * dpr, 3 * dpr]);
  if (a.pts) {
    const b = bounds(a); ctx.strokeRect(b.x * s - 3 * dpr, b.y * s - 3 * dpr, b.w * s + 6 * dpr, b.h * s + 6 * dpr);
  } else {
    ctx.translate(a.x * s, a.y * s); ctx.rotate(a.rot * Math.PI / 180);
    ctx.strokeRect(-2 * dpr, -2 * dpr, a.w * s + 4 * dpr, a.h * s + 4 * dpr);
    ctx.setLineDash([]); ctx.fillStyle = '#f5b400';
    ctx.fillRect(a.w * s - 4 * dpr, a.h * s - 4 * dpr, 8 * dpr, 8 * dpr);
  }
  ctx.restore();
}
function bounds(a) {
  const xs = a.pts.map(p => p[0]), ys = a.pts.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
function drawOverlay() {
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!state.pageIds.length) return;
  const s = state.zoom * (window.devicePixelRatio || 1);
  if (typeof drawPdfTextLayer === 'function') drawPdfTextLayer(ctx, s);
  drawAnnots(ctx, curPageId(), s, state.selected);
  if (typeof refreshLayers === 'function') refreshLayers();
  if (drag && drag.mode === 'textbox') {
    const dpr = window.devicePixelRatio || 1, [sx, sy] = drag.start, [cx, cy] = drag.cur;
    ctx.save(); ctx.strokeStyle = '#f5b400'; ctx.lineWidth = dpr; ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.strokeRect(Math.min(sx, cx) * s, Math.min(sy, cy) * s, Math.abs(cx - sx) * s, Math.max(defaults.size * 1.2, Math.abs(cy - sy)) * s);
    ctx.restore();
  }
}

/* ---------- hit testing ---------- */
function localPt(a, mx, my) {
  const r = a.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), dx = mx - a.x, dy = my - a.y;
  return [dx * c + dy * s, -dx * s + dy * c];
}
function distSeg(px, py, [x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function hitAnnot(a, mx, my) {
  if (a.pts) {
    const tol = Math.max(6 / state.zoom, a.width);
    if (a.pts.length === 1) return Math.hypot(mx - a.pts[0][0], my - a.pts[0][1]) < tol;
    for (let i = 0; i < a.pts.length - 1; i++) if (distSeg(mx, my, a.pts[i], a.pts[i + 1]) < tol) return true;
    return false;
  }
  const [lx, ly] = localPt(a, mx, my), pad = 3 / state.zoom;
  return lx >= -pad && ly >= -pad && lx <= a.w + pad && ly <= a.h + pad;
}
function hitHandle(a, mx, my) {
  if (!a || a.pts) return false;
  const [lx, ly] = localPt(a, mx, my), hs = 7 / state.zoom;
  return Math.abs(lx - a.w) < hs && Math.abs(ly - a.h) < hs;
}
/* Deletions are skipped by ordinary clicks. They sit exactly where the words used to be, so
   clicking one and pressing Delete would quietly take the deletion away and bring the text
   back, which reads as Delete simply not working. Alt+click, or the Layers tab, still reaches
   them when you genuinely want one gone. */
function hitTest(mx, my, wanted, includeDeletions) {
  const list = curAnnots();
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (a.hidden || (wanted && a.type !== wanted)) continue;
    if (a.redact && !includeDeletions) continue;
    if (hitAnnot(a, mx, my)) return a;
  }
  return null;
}
function deletionAt(mx, my) {
  const list = curAnnots();
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (!a.hidden && a.redact && hitAnnot(a, mx, my)) return a;
  }
  return null;
}
/* An opaque mark of ours sitting over this point, e.g. a whiteout or a redaction. */
function coverAt(mx, my) {
  const list = curAnnots();
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (a.hidden || a.pts || a.type !== 'rect' || !a.fill || a.blend) continue;
    if ((a.opacity == null ? 1 : a.opacity) > 0.85 && hitAnnot(a, mx, my)) return a;
  }
  return null;
}

/* ---------- tools & properties ---------- */
const propVis = {
  select: [], text: ['color', 'size', 'font', 'bold', 'opacity'], pen: ['color', 'width', 'opacity'],
  line: ['color', 'width', 'opacity'], arrow: ['color', 'width', 'opacity'],
  rect: ['color', 'fill', 'width', 'opacity'], ellipse: ['color', 'fill', 'width', 'opacity'],
  highlight: ['color', 'opacity'], whiteout: [], redact: [], image: ['opacity'],
};
const hints = {
  select: 'Click an annotation to select it. Drag to move, corner square to resize, double-click text to edit.',
  text: 'Click to place text, or drag to draw a fixed-width box that wraps automatically. Enter starts a new line.', pen: 'Draw freehand.', highlight: 'Drag over text to highlight.',
  rect: 'Drag to draw a rectangle.', ellipse: 'Drag to draw an ellipse.', line: 'Drag to draw a line.',
  arrow: 'Drag to draw an arrow.', whiteout: 'Drag to cover an area with white.',
  redact: 'Drag over anything that must not be readable. When you save, the text underneath is removed from the file, not just hidden.',
};
function setTool(t) {
  commitTextEdit();
  state.tool = t; state.selected = null;
  $$('#tools button[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  overlay.style.cursor = ''; overlay.className = t === 'select' ? '' : t === 'text' ? 'cur-text' : 'cur-cross';
  updateProps(); drawOverlay();
}
$$('#tools button[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));

function updateProps() {
  const a = state.selected;
  let vis;
  if (a) {
    vis = propVis[a.pts ? (a.type === 'pen' ? 'pen' : 'line') : a.redact ? 'redact' : a.type === 'rect' && a.blend ? 'highlight' : a.type === 'rect' && !a.stroke && a.fill === '#ffffff' ? 'whiteout' : a.type] || [];
    if (a.type === 'text') { $('#pColor').value = a.color; $('#pSize').value = a.size; $('#pFont').value = a.font; $('#pBold').checked = !!a.bold; }
    else if (a.pts) { $('#pColor').value = a.color; $('#pWidth').value = a.width; }
    else if (a.type === 'rect' || a.type === 'ellipse') {
      if (a.blend) { $('#pColor').value = a.fill; }
      else { $('#pColor').value = a.stroke || defaults.color; $('#pFillOn').checked = !!a.fill; $('#pFill').value = a.fill || defaults.fill; $('#pWidth').value = a.width; }
    }
    $('#pOpacity').value = a.opacity == null ? 1 : a.opacity;
  } else {
    vis = propVis[state.tool] || [];
    $('#pColor').value = state.tool === 'highlight' ? defaults.fill : defaults.color;
    $('#pFillOn').checked = defaults.fillOn; $('#pFill').value = defaults.fill; $('#pWidth').value = defaults.width;
    $('#pSize').value = defaults.size; $('#pFont').value = defaults.font; $('#pBold').checked = defaults.bold;
    $('#pOpacity').value = state.tool === 'highlight' ? 0.45 : defaults.opacity;
  }
  $$('#props label').forEach(l => l.classList.toggle('on', vis.includes(l.dataset.p)));
  $('#btnDelAnnot').style.display = a ? '' : 'none';
  $('#hint').textContent = a ? '' : (hints[state.tool] || '');
}
function onPropChange() {
  const a = state.selected;
  const color = $('#pColor').value, fillOn = $('#pFillOn').checked, fill = $('#pFill').value;
  const width = parseFloat($('#pWidth').value) || 2, size = parseFloat($('#pSize').value) || 16;
  const font = $('#pFont').value, bold = $('#pBold').checked, opacity = parseFloat($('#pOpacity').value);
  if (a) {
    pushAnnotUndo(curPageId());
    a.opacity = opacity;
    if (a.type === 'text') { a.color = color; a.size = size; a.font = font; a.bold = bold; measureText(a); }
    else if (a.pts) { a.color = color; a.width = width; }
    else if (a.type === 'rect' || a.type === 'ellipse') {
      if (a.blend) a.fill = color; else { a.stroke = color; a.fill = fillOn ? fill : null; a.width = width; }
    }
    drawOverlay(); refreshThumb(state.cur);
  } else {
    if (state.tool === 'highlight') { defaults.fill = color; } else { defaults.color = color; defaults.fill = fill; }
    defaults.fillOn = fillOn; defaults.width = width; defaults.size = size; defaults.font = font; defaults.bold = bold; defaults.opacity = opacity;
    if (editing) { editing.color = color; editing.size = size; editing.font = font; editing.bold = bold; editing.opacity = opacity; positionTextEditor(); }
  }
}
['#pColor', '#pFillOn', '#pFill', '#pWidth', '#pSize', '#pFont', '#pBold', '#pOpacity'].forEach(s => $(s).addEventListener('input', onPropChange));
$('#btnDelAnnot').onclick = deleteSelected;
function deleteSelected() {
  const a = state.selected; if (!a) return;
  pushAnnotUndo(curPageId());
  const list = curAnnots(); list.splice(list.indexOf(a), 1);
  state.selected = null; drawOverlay(); refreshThumb(state.cur); updateProps();
  // Say so out loud: removing a deletion puts the original words back, and doing that by
  // accident is how "delete" ends up looking as though it never worked.
  if (a.redact) toast('Deletion removed, so the text underneath is back. Ctrl+Z to undo.', 5000);
}

/* ---------- pointer handling ---------- */
let drag = null;
function evtPt(e) { const r = overlay.getBoundingClientRect(); return [(e.clientX - r.left) / state.zoom, (e.clientY - r.top) / state.zoom]; }
function newBox(type, x, y) {
  const base = { id: uid(), type, x, y, w: 0, h: 0, rot: 0, opacity: defaults.opacity };
  if (type === 'highlight') return Object.assign(base, { type: 'rect', fill: defaults.fill, stroke: null, width: 0, opacity: parseFloat($('#pOpacity').value) || 0.45, blend: 'multiply' });
  if (type === 'whiteout') return Object.assign(base, { type: 'rect', fill: '#ffffff', stroke: null, width: 0, opacity: 1 });
  if (type === 'redact') return Object.assign(base, { type: 'rect', fill: '#000000', stroke: null, width: 0, opacity: 1, redact: true });
  return Object.assign(base, { stroke: defaults.color, fill: defaults.fillOn ? defaults.fill : null, width: defaults.width });
}
overlay.addEventListener('pointerdown', e => {
  if (!state.pageIds.length || e.button !== 0) return;
  e.preventDefault(); // keep focus from jumping away from the text editor
  if (editing) { commitTextEdit(); if (state.tool === 'text') return; }
  const [x, y] = evtPt(e); const t = state.tool;
  overlay.setPointerCapture(e.pointerId);
  if (t === 'select') {
    if (state.selected && hitHandle(state.selected, x, y)) { pushAnnotUndo(curPageId()); drag = { mode: 'resize', a: state.selected, orig: { ...state.selected } }; return; }
    const a = hitTest(x, y, null, e.altKey);
    state.selected = a; updateProps();
    if (!a && deletionAt(x, y)) toast('This area was deleted. Alt+click it, or use the Layers tab, to bring it back.', 4500);
    if (a) {
      if (typeof pdfTextClearPick === 'function') pdfTextClearPick();
      pushAnnotUndo(curPageId());
      drag = { mode: 'move', a, start: [x, y], orig: a.pts ? a.pts.map(p => [...p]) : { x: a.x, y: a.y } };
    } else if (typeof pdfTextDragStart === 'function' && pdfTextDragStart(x, y)) {
      // over the PDF's own text: a drag selects it, a plain click picks the line
      drag = { mode: 'seltext', start: [x, y], moved: false };
    } else if (typeof pdfTextSelect === 'function') {
      pdfTextSelect(x, y);
    }
    drawOverlay();
    return;
  }
  if (t === 'text') {
    const hit = hitTest(x, y);
    if (hit && hit.type === 'text') { startTextEdit(hit); return; }
    drag = { mode: 'textbox', start: [x, y], cur: [x, y] }; return;
  }
  pushAnnotUndo(curPageId());
  if (t === 'pen' || t === 'line' || t === 'arrow') {
    const a = { id: uid(), type: t, pts: [[x, y]], color: defaults.color, width: defaults.width, opacity: defaults.opacity };
    if (t !== 'pen') a.pts.push([x, y]);
    curAnnots().push(a); drag = { mode: t === 'pen' ? 'draw' : 'line', a }; return;
  }
  const a = newBox(t, x, y); curAnnots().push(a); drag = { mode: 'shape', a, start: [x, y] };
});
overlay.addEventListener('pointermove', e => {
  if (!drag) {
    if (state.tool === 'select') {
      const [x, y] = evtPt(e); const onHandle = hitHandle(state.selected, x, y), hit = !onHandle && hitTest(x, y, null, e.altKey);
      let cur = onHandle ? 'nwse-resize' : hit ? 'move' : deletionAt(x, y) ? 'not-allowed' : 'default';
      if (typeof pdfTextHover === 'function' && pdfTextHover(x, y, !onHandle && !hit)) cur = 'text';
      overlay.style.cursor = cur;
    }
    return;
  }
  const [x, y] = evtPt(e); const a = drag.a;
  if (drag.mode === 'draw') { const l = a.pts[a.pts.length - 1]; if (Math.hypot(x - l[0], y - l[1]) > 0.7) a.pts.push([x, y]); }
  else if (drag.mode === 'line') {
    let [ex, ey] = [x, y];
    if (e.shiftKey) {                                  // hold Shift for a straight or 45 degree line
      const [sx, sy] = a.pts[0], dx = ex - sx, dy = ey - sy;
      const step = Math.PI / 4, ang = Math.round(Math.atan2(dy, dx) / step) * step, len = Math.hypot(dx, dy);
      ex = sx + Math.cos(ang) * len; ey = sy + Math.sin(ang) * len;
    }
    a.pts[1] = [ex, ey];
  }
  else if (drag.mode === 'shape') {
    const [sx, sy] = drag.start;
    let w = Math.abs(x - sx), h = Math.abs(y - sy);
    if (e.shiftKey) { const s = Math.min(w, h); w = h = s; }   // Shift for a square or circle
    a.x = x < sx ? sx - w : sx; a.y = y < sy ? sy - h : sy; a.w = w; a.h = h;
  }
  else if (drag.mode === 'textbox') { drag.cur = [x, y]; }
  else if (drag.mode === 'seltext') {
    if (Math.hypot(x - drag.start[0], y - drag.start[1]) > 1.5) drag.moved = true;
    if (drag.moved) pdfTextDragMove(x, y);
  }
  else if (drag.mode === 'move') {
    const dx = x - drag.start[0], dy = y - drag.start[1];
    if (a.pts) a.pts = drag.orig.map(p => [p[0] + dx, p[1] + dy]); else { a.x = drag.orig.x + dx; a.y = drag.orig.y + dy; }
  } else if (drag.mode === 'resize') {
    const [lx, ly] = localPt(a, x, y);
    if (a.type === 'text') { a.boxW = Math.max(30, lx); measureText(a); }
    else if (a.type === 'image' && !e.shiftKey) { const nw = Math.max(4, lx); a.w = nw; a.h = nw * drag.orig.h / drag.orig.w; }
    else { a.w = Math.max(4, lx); a.h = Math.max(4, ly); }
  }
  drawOverlay();
});
function endDrag(e) {
  if (!drag) return;
  if (drag.mode === 'seltext') {
    const moved = drag.moved, start = drag.start; drag = null;
    if (moved) pdfTextDragEnd();
    else { pdfTextClearPick(); pdfTextSelect(start[0], start[1]); }
    drawOverlay();
    return;
  }
  if (drag.mode === 'textbox') {
    const [sx, sy] = drag.start, [cx, cy] = drag.cur; drag = null;
    const wBox = Math.abs(cx - sx), fixed = wBox > 25;
    pushAnnotUndo(curPageId());
    const a = { id: uid(), type: 'text', x: fixed ? Math.min(sx, cx) : sx, y: fixed ? Math.min(sy, cy) : sy - defaults.size * 0.6, w: 0, h: 0, rot: 0, text: '', size: defaults.size, font: defaults.font, bold: defaults.bold, color: defaults.color, opacity: defaults.opacity, boxW: fixed ? wBox : 0 };
    measureText(a); curAnnots().push(a); drawOverlay(); startTextEdit(a); return;
  }
  const a = drag.a, list = curAnnots();
  if ((drag.mode === 'shape' && (a.w < 2 || a.h < 2)) || (drag.mode === 'line' && Math.hypot(a.pts[1][0] - a.pts[0][0], a.pts[1][1] - a.pts[0][1]) < 2)) {
    list.splice(list.indexOf(a), 1); state.undo.pop();
  }
  drag = null; drawOverlay(); refreshThumb(state.cur);
}
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);
/* Double-click should always give you somewhere to type. In order: a text box of yours, then
   the PDF's own text, then a fresh text box. Without the last step a whiteout swallowed the
   double-click and there was no way to write in the space you had just cleared. */
overlay.addEventListener('dblclick', async e => {
  if (state.tool !== 'select') return;
  const [x, y] = evtPt(e);
  const mine = hitTest(x, y, 'text');
  if (mine) { startTextEdit(mine); return; }
  if (!coverAt(x, y) && typeof pdfTextEditAt === 'function' && await pdfTextEditAt(x, y)) return;
  pushAnnotUndo(curPageId());
  const a = { id: uid(), type: 'text', x, y: y - defaults.size * 0.6, w: 0, h: 0, rot: 0, text: '',
              size: defaults.size, font: defaults.font, bold: defaults.bold, color: defaults.color, opacity: defaults.opacity };
  measureText(a); curAnnots().push(a); drawOverlay(); startTextEdit(a);
});

/* ---------- inline text editing ---------- */
let editing = null;
const ed = $('#textEditor');
function startTextEdit(a) {
  commitTextEdit();
  editing = a; a._editing = true; state.selected = null;
  pushAnnotUndo(curPageId());
  ed.value = a.text; ed.style.display = 'block';
  positionTextEditor(); drawOverlay(); updateProps();
  $$('#props label').forEach(l => l.classList.toggle('on', propVis.text.includes(l.dataset.p)));
  $('#pColor').value = a.color; $('#pSize').value = a.size; $('#pFont').value = a.font; $('#pBold').checked = !!a.bold; $('#pOpacity').value = a.opacity;
  const focusEd = () => { ed.focus(); ed.setSelectionRange(ed.value.length, ed.value.length); };
  focusEd(); setTimeout(focusEd, 0);
}
function positionTextEditor() {
  if (!editing) return;
  const a = editing, z = state.zoom;
  measureText(a);
  ed.style.left = a.x * z + 'px'; ed.style.top = a.y * z + 'px';
  ed.style.font = fontCss(a, z); ed.style.color = a.color; ed.style.opacity = a.opacity;
  ed.style.transform = `rotate(${a.rot}deg)`;
  ed.style.whiteSpace = a.boxW ? 'pre-wrap' : 'pre';
  ed.style.width = (a.boxW ? a.boxW * z + 3 : a.w * z + 12) + 'px'; ed.style.height = (a.h * z + 3) + 'px';
}
ed.addEventListener('input', () => { if (!editing) return; editing.text = ed.value; positionTextEditor(); });
ed.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); commitTextEdit(); } e.stopPropagation(); });
ed.addEventListener('blur', () => commitTextEdit());
function commitTextEdit() {
  if (!editing) return;
  const a = editing; editing = null; delete a._editing;
  a.text = ed.value; ed.style.display = 'none';
  const list = curAnnots();
  if (!a.text.trim()) { const i = list.indexOf(a); if (i >= 0) list.splice(i, 1); }
  else measureText(a);
  drawOverlay(); refreshThumb(state.cur); updateProps();
}

/* ---------- images & signature ---------- */
async function fileToImageAnnot(file) {
  const url = await readDataUrl(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  let src = url, fmt = 'png';
  if (file.type === 'image/jpeg') fmt = 'jpg';
  else if (file.type !== 'image/png') { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); src = c.toDataURL('image/png'); }
  return { src, fmt, iw: img.naturalWidth, ih: img.naturalHeight };
}
function placeImage({ src, fmt, iw, ih }, maxFrac = 0.4) {
  const { w: W, h: H } = state.pageSize;
  let w = Math.min(iw * 0.75, W * maxFrac); let h = w * ih / iw;
  if (h > H * maxFrac) { h = H * maxFrac; w = h * iw / ih; }
  pushAnnotUndo(curPageId());
  const a = { id: uid(), type: 'image', x: (W - w) / 2, y: (H - h) / 2, w, h, rot: 0, src, fmt, opacity: 1 };
  curAnnots().push(a); setTool('select'); state.selected = a; updateProps(); drawOverlay(); refreshThumb(state.cur);
}
$('#btnImage').onclick = () => { if (!state.doc) return toast('Open a PDF first'); $('#imgAnnotInput').click(); };
$('#imgAnnotInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { placeImage(await fileToImageAnnot(f)); } catch (err) { toast('Could not load image'); }
});
/* Signatures you keep, so you draw yours once rather than every time. Stored on this
   computer only, in the browser's own storage. */
function savedSignatures() {
  try { return JSON.parse(localStorage.getItem('kam-signatures') || '[]'); } catch (e) { return []; }
}
function storeSignature(src) {
  const all = savedSignatures().filter(s => s !== src);
  all.unshift(src);
  try { localStorage.setItem('kam-signatures', JSON.stringify(all.slice(0, 6))); } catch (e) { toast('Could not save the signature (storage full)'); }
}
function forgetSignature(src) {
  try { localStorage.setItem('kam-signatures', JSON.stringify(savedSignatures().filter(s => s !== src))); } catch (e) { }
}
$('#btnSign').onclick = () => {
  if (!state.doc) return toast('Open a PDF first');
  const saved = savedSignatures();
  const gallery = saved.length
    ? `<div class="muted" style="margin-bottom:6px">Your saved signatures. Click one to place it.</div>
       <div class="sig-saved">${saved.map((s, i) => `<div class="sig-card"><img src="${s}" data-i="${i}" alt="saved signature"><button class="sig-del" data-i="${i}" title="Forget this signature">✕</button></div>`).join('')}</div>`
    : '';
  showModal(`<h3>Signature</h3>${gallery}
    <div class="muted" style="margin-bottom:6px">${saved.length ? 'Or draw a new one:' : 'Draw your signature:'}</div>
    <canvas id="sigPad" width="600" height="220"></canvas>
    <div class="row" style="margin-top:10px"><label>Color <input type="color" id="sigColor" value="#1e3a8a"></label>
    <button id="sigClear">Clear</button><label><input type="checkbox" id="sigKeep" checked> Remember this signature</label>
    <span style="flex:1"></span><button id="sigCancel">Cancel</button><button id="sigUse" class="primary">Use signature</button></div>`);
  $$('#modalBox .sig-card img').forEach(img => img.onclick = async () => {
    const src = savedSignatures()[+img.dataset.i]; if (!src) return;
    const probe = new Image(); probe.src = src;
    await new Promise(r => { if (probe.complete) r(); else probe.onload = r; });
    hideModal();
    placeImage({ src, fmt: 'png', iw: probe.naturalWidth || 300, ih: probe.naturalHeight || 100 }, 0.3);
  });
  $$('#modalBox .sig-del').forEach(btn => btn.onclick = e => {
    e.stopPropagation();
    forgetSignature(savedSignatures()[+btn.dataset.i]);
    btn.closest('.sig-card').remove();
  });
  const pad = $('#sigPad'), ctx = pad.getContext('2d'); let down = false, last = null, drawn = false;
  ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const pt = e => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
  pad.onpointerdown = e => { down = true; last = pt(e); pad.setPointerCapture(e.pointerId); };
  pad.onpointermove = e => { if (!down) return; const p = pt(e); ctx.strokeStyle = $('#sigColor').value; ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); last = p; drawn = true; };
  pad.onpointerup = () => down = false;
  $('#sigClear').onclick = () => { ctx.clearRect(0, 0, pad.width, pad.height); drawn = false; };
  $('#sigCancel').onclick = hideModal;
  $('#sigUse').onclick = () => {
    if (!drawn) return toast('Draw something first');
    // crop to ink bounds
    const d = ctx.getImageData(0, 0, pad.width, pad.height).data; let x0 = pad.width, y0 = pad.height, x1 = 0, y1 = 0;
    for (let y = 0; y < pad.height; y++) for (let x = 0; x < pad.width; x++) if (d[(y * pad.width + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const c = document.createElement('canvas'); c.width = x1 - x0 + 9; c.height = y1 - y0 + 9;
    c.getContext('2d').drawImage(pad, x0 - 4, y0 - 4, c.width, c.height, 0, 0, c.width, c.height);
    const src = c.toDataURL('image/png');
    if ($('#sigKeep') && $('#sigKeep').checked) storeSignature(src);
    hideModal();
    placeImage({ src, fmt: 'png', iw: c.width, ih: c.height }, 0.3);
  };
};

/* ---------- keyboard ---------- */
function pasteAnnot(a) {
  a.id = uid(); delete a._editing;
  if (a.pts) a.pts = a.pts.map(p => [p[0] + 15, p[1] + 15]); else { a.x += 15; a.y += 15; }
  pushAnnotUndo(curPageId()); curAnnots().push(a);
  if (state.tool !== 'select') setTool('select');
  state.selected = a; updateProps(); drawOverlay(); refreshThumb(state.cur);
}
let lastNudge = 0;
function nudge(key, d) {
  const a = state.selected, dx = key === 'ArrowLeft' ? -d : key === 'ArrowRight' ? d : 0, dy = key === 'ArrowUp' ? -d : key === 'ArrowDown' ? d : 0;
  if (Date.now() - lastNudge > 800) pushAnnotUndo(curPageId()); lastNudge = Date.now();
  if (a.pts) a.pts = a.pts.map(p => [p[0] + dx, p[1] + dy]); else { a.x += dx; a.y += dy; }
  drawOverlay(); refreshThumb(state.cur);
}
document.addEventListener('keydown', e => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 's') { e.preventDefault(); savePdf(e.shiftKey); return; }
  if (mod && k === 'o') { e.preventDefault(); $('#fileInput').click(); return; }
  if (mod && k === 'p') { e.preventDefault(); $('#btnPrint').click(); return; }
  if (typing) return;
  if (mod && k === 'z' && e.shiftKey) { e.preventDefault(); redo(); return; }
  if (mod && k === 'z') { e.preventDefault(); undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'c' && state.selected) { state.clipboard = JSON.stringify(state.selected); toast('Copied'); return; }
  if (mod && k === 'c' && typeof pdfTextHasSelection === 'function' && pdfTextHasSelection()) { e.preventDefault(); pdfTextCopy(); return; }
  if (mod && k === 'v' && state.clipboard) { e.preventDefault(); pasteAnnot(JSON.parse(state.clipboard)); return; }
  if (mod && k === 'd' && state.selected) { e.preventDefault(); pasteAnnot(JSON.parse(JSON.stringify(state.selected))); return; }
  if (e.key === 'Escape') { state.selected = null; if (typeof pdfTextClearPick === 'function') pdfTextClearPick(); setTool('select'); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selected) { e.preventDefault(); deleteSelected(); return; }
    if (typeof pdfTextDeleteSelected === 'function' && pdfTextDeleteSelected()) e.preventDefault();
    return;
  }
  if (e.key.startsWith('Arrow') && state.selected) { e.preventDefault(); nudge(e.key, e.shiftKey ? 10 : 1); return; }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { goTo(state.cur - 1); return; }
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { goTo(state.cur + 1); return; }
  const map = { v: 'select', t: 'text', p: 'pen', h: 'highlight', r: 'rect', e: 'ellipse', l: 'line', a: 'arrow', w: 'whiteout', x: 'redact' };
  if (!mod && !e.altKey && map[k]) setTool(map[k]);
});
// Paste an image from the clipboard straight onto the page.
document.addEventListener('paste', async e => {
  if (!state.doc || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  const item = [...((e.clipboardData && e.clipboardData.items) || [])].find(i => i.type.startsWith('image/'));
  if (!item) return; e.preventDefault();
  try { placeImage(await fileToImageAnnot(item.getAsFile())); toast('Image pasted onto the page'); } catch (err) { toast('Could not paste image'); }
});
setTool('select');
