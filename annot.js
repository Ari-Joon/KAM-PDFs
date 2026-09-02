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
function drawAnnots(ctx, pageId, s, selected) {
  for (const a of (state.annots[pageId] || [])) { if (!a._editing) drawAnnot(ctx, a, s); }
  if (selected) drawSelection(ctx, selected, s);
}
function drawAnnot(ctx, a, s) {
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
    } else if (a.type === 'rect') {
      if (a.fill) { ctx.fillStyle = a.fill; ctx.fillRect(0, 0, w, h); }
      if (a.stroke) { ctx.strokeStyle = a.stroke; ctx.lineWidth = a.width * s; ctx.strokeRect(0, 0, w, h); }
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
  drawAnnots(ctx, curPageId(), s, state.selected);
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
function hitTest(mx, my) {
  const list = curAnnots();
  for (let i = list.length - 1; i >= 0; i--) if (hitAnnot(list[i], mx, my)) return list[i];
  return null;
}

/* ---------- tools & properties ---------- */
const propVis = {
  select: [], text: ['color', 'size', 'font', 'bold', 'opacity'], pen: ['color', 'width', 'opacity'],
  line: ['color', 'width', 'opacity'], arrow: ['color', 'width', 'opacity'],
  rect: ['color', 'fill', 'width', 'opacity'], ellipse: ['color', 'fill', 'width', 'opacity'],
  highlight: ['color', 'opacity'], whiteout: [], image: ['opacity'],
};
const hints = {
  select: 'Click an annotation to select it. Drag to move, corner square to resize, double-click text to edit.',
  text: 'Click to place text, or drag to draw a fixed-width box that wraps automatically. Enter starts a new line.', pen: 'Draw freehand.', highlight: 'Drag over text to highlight.',
  rect: 'Drag to draw a rectangle.', ellipse: 'Drag to draw an ellipse.', line: 'Drag to draw a line.',
  arrow: 'Drag to draw an arrow.', whiteout: 'Drag to cover an area with white.',
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
    vis = propVis[a.pts ? (a.type === 'pen' ? 'pen' : 'line') : a.type === 'rect' && a.blend ? 'highlight' : a.type === 'rect' && !a.stroke && a.fill === '#ffffff' ? 'whiteout' : a.type] || [];
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
}

/* ---------- pointer handling ---------- */
let drag = null;
function evtPt(e) { const r = overlay.getBoundingClientRect(); return [(e.clientX - r.left) / state.zoom, (e.clientY - r.top) / state.zoom]; }
function newBox(type, x, y) {
  const base = { id: uid(), type, x, y, w: 0, h: 0, rot: 0, opacity: defaults.opacity };
  if (type === 'highlight') return Object.assign(base, { type: 'rect', fill: defaults.fill, stroke: null, width: 0, opacity: parseFloat($('#pOpacity').value) || 0.45, blend: 'multiply' });
  if (type === 'whiteout') return Object.assign(base, { type: 'rect', fill: '#ffffff', stroke: null, width: 0, opacity: 1 });
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
    const a = hitTest(x, y);
    state.selected = a; updateProps(); drawOverlay();
    if (a) { pushAnnotUndo(curPageId()); drag = { mode: 'move', a, start: [x, y], orig: a.pts ? a.pts.map(p => [...p]) : { x: a.x, y: a.y } }; }
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
    if (state.tool === 'select') { const [x, y] = evtPt(e); overlay.style.cursor = hitHandle(state.selected, x, y) ? 'nwse-resize' : hitTest(x, y) ? 'move' : 'default'; }
    return;
  }
  const [x, y] = evtPt(e); const a = drag.a;
  if (drag.mode === 'draw') { const l = a.pts[a.pts.length - 1]; if (Math.hypot(x - l[0], y - l[1]) > 0.7) a.pts.push([x, y]); }
  else if (drag.mode === 'line') { a.pts[1] = [x, y]; }
  else if (drag.mode === 'shape') { const [sx, sy] = drag.start; a.x = Math.min(sx, x); a.y = Math.min(sy, y); a.w = Math.abs(x - sx); a.h = Math.abs(y - sy); }
  else if (drag.mode === 'textbox') { drag.cur = [x, y]; }
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
overlay.addEventListener('dblclick', e => {
  if (state.tool !== 'select') return;
  const [x, y] = evtPt(e); const a = hitTest(x, y);
  if (a && a.type === 'text') startTextEdit(a);
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
$('#btnSign').onclick = () => {
  if (!state.doc) return toast('Open a PDF first');
  showModal(`<h3>Draw your signature</h3><canvas id="sigPad" width="600" height="220"></canvas>
    <div class="row" style="margin-top:10px"><label>Color <input type="color" id="sigColor" value="#1e3a8a"></label>
    <button id="sigClear">Clear</button><span style="flex:1"></span><button id="sigCancel">Cancel</button><button id="sigUse" class="primary">Use signature</button></div>`);
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
    hideModal();
    placeImage({ src: c.toDataURL('image/png'), fmt: 'png', iw: c.width, ih: c.height }, 0.3);
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
  if (mod && k === 's') { e.preventDefault(); savePdf(); return; }
  if (mod && k === 'o') { e.preventDefault(); $('#fileInput').click(); return; }
  if (mod && k === 'p') { e.preventDefault(); $('#btnPrint').click(); return; }
  if (typing) return;
  if (mod && k === 'z' && e.shiftKey) { e.preventDefault(); redo(); return; }
  if (mod && k === 'z') { e.preventDefault(); undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'c' && state.selected) { state.clipboard = JSON.stringify(state.selected); toast('Copied'); return; }
  if (mod && k === 'v' && state.clipboard) { e.preventDefault(); pasteAnnot(JSON.parse(state.clipboard)); return; }
  if (mod && k === 'd' && state.selected) { e.preventDefault(); pasteAnnot(JSON.parse(JSON.stringify(state.selected))); return; }
  if (e.key === 'Escape') { state.selected = null; setTool('select'); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (state.selected) { e.preventDefault(); deleteSelected(); } return; }
  if (e.key.startsWith('Arrow') && state.selected) { e.preventDefault(); nudge(e.key, e.shiftKey ? 10 : 1); return; }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { goTo(state.cur - 1); return; }
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { goTo(state.cur + 1); return; }
  const map = { v: 'select', t: 'text', p: 'pen', h: 'highlight', r: 'rect', e: 'ellipse', l: 'line', a: 'arrow', w: 'whiteout' };
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
