/* Free PDF Editor — page operations, forms, metadata, export */
'use strict';

async function structOp(fn, { clearThumbs = false } = {}) {
  if (!state.doc) { toast('Open a PDF first'); return; }
  commitTextEdit();
  pushStructUndo();
  busy(true);
  try { await fn(); if (clearThumbs) state.thumbCache.clear(); await rebuild(); }
  catch (e) { console.error(e); state.undo.pop(); toast('Operation failed: ' + e.message, 5000); }
  busy(false);
}

/* ---------- rotating (also rotates the page's annotations) ---------- */
function rotateAnnots90(pageId, dispW, dispH) {
  const rot = ([x, y]) => [dispH - y, x];
  for (const a of (state.annots[pageId] || [])) {
    if (a.pts) a.pts = a.pts.map(rot);
    else { [a.x, a.y] = rot([a.x, a.y]); a.rot = (a.rot + 90) % 360; }
  }
}
async function rotatePages(indices, dir) {
  await structOp(async () => {
    for (const i of indices) {
      const page = state.doc.getPage(i);
      const vp = (await state.pdfjs.getPage(i + 1)).getViewport({ scale: 1 });
      let w = vp.width, h = vp.height;
      const steps = dir > 0 ? 1 : 3;
      for (let k = 0; k < steps; k++) { rotateAnnots90(state.pageIds[i], w, h); [w, h] = [h, w]; }
      page.setRotation(degrees((((page.getRotation().angle + dir * 90) % 360) + 360) % 360));
    }
  });
}

/* ---------- delete / duplicate / blank / move ---------- */
async function deletePages(indices) {
  if (indices.length >= state.pageIds.length) return toast('Cannot delete every page.');
  await structOp(async () => {
    for (const i of [...indices].sort((a, b) => b - a)) {
      state.doc.removePage(i); delete state.annots[state.pageIds[i]]; state.pageIds.splice(i, 1);
    }
    state.selectedPages.clear();
  });
}
async function duplicatePages(indices) {
  await structOp(async () => {
    for (const i of [...indices].sort((a, b) => b - a)) {
      const [p] = await state.doc.copyPages(state.doc, [i]);
      state.doc.insertPage(i + 1, p);
      const id = uid(); state.pageIds.splice(i + 1, 0, id);
      state.annots[id] = JSON.parse(JSON.stringify(state.annots[state.pageIds[i]] || [])).map(a => ({ ...a, id: uid() }));
    }
    state.selectedPages.clear();
  });
}
async function insertBlankAfter(i) {
  await structOp(async () => {
    const { width, height } = state.doc.getPage(i).getSize();
    state.doc.insertPage(i + 1, [width, height]);
    state.pageIds.splice(i + 1, 0, uid());
    state.cur = i + 1; state.selectedPages.clear();
  });
}
async function movePage(from, to) {
  await structOp(async () => {
    const page = state.doc.getPage(from);
    state.doc.removePage(from);
    state.doc.insertPage(to, page);
    const [id] = state.pageIds.splice(from, 1); state.pageIds.splice(to, 0, id);
    state.cur = to; state.selectedPages.clear(); state.selectedPages.add(to);
  });
}
$$('.side-actions button').forEach(b => b.onclick = () => {
  if (!state.doc) return toast('Open a PDF first');
  const pages = targetPages();
  switch (b.dataset.act) {
    case 'rotL': return rotatePages(pages, -1);
    case 'rotR': return rotatePages(pages, 1);
    case 'dup': return duplicatePages(pages);
    case 'blank': return insertBlankAfter(pages[pages.length - 1]);
    case 'extract': return extractPages(pages);
    case 'del': if (confirm(`Delete ${pages.length} page(s)?`)) return deletePages(pages);
  }
});

/* ---------- merge & images ---------- */
async function mergeFiles(files) {
  await structOp(async () => {
    for (const f of files) {
      const src = await PDFDocument.load(await readFile(f), { ignoreEncryption: true });
      if (src.isEncrypted) { toast(`${f.name} is password-protected and was skipped`, 5000); continue; }
      const pages = await state.doc.copyPages(src, src.getPageIndices());
      for (const p of pages) { state.doc.addPage(p); state.pageIds.push(uid()); }
    }
  });
}
$('#btnMerge').onclick = () => { if (!state.doc) return toast('Open a PDF first, then merge others into it'); $('#mergeInput').click(); };
$('#mergeInput').addEventListener('change', async e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) await mergeFiles(fs); });

async function addImagePages(files) {
  await structOp(async () => {
    for (const f of files) {
      const { src, fmt, iw, ih } = await fileToImageAnnot(f);
      const bytes = await (await fetch(src)).arrayBuffer();
      const img = fmt === 'jpg' ? await state.doc.embedJpg(bytes) : await state.doc.embedPng(bytes);
      const scale = Math.min(1, 842 / Math.max(iw, ih));
      const w = iw * scale, h = ih * scale;
      const page = state.doc.addPage([w, h]);
      page.drawImage(img, { x: 0, y: 0, width: w, height: h });
      state.pageIds.push(uid());
    }
    state.cur = state.pageIds.length - 1;
  });
}
$('#btnAddImages').onclick = () => $('#imgInput').click();
$('#imgInput').addEventListener('change', async e => {
  const fs = [...e.target.files]; e.target.value = ''; if (!fs.length) return;
  if (!state.doc) { await newBlank(); await addImagePages(fs); await deletePages([0]); state.undo = []; }
  else await addImagePages(fs);
});

/* ---------- extract / split ---------- */
function parseRange(str, n) {
  const out = new Set();
  for (const part of str.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/); if (!m) continue;
    const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= n) out.add(i - 1);
  }
  return [...out].sort((a, b) => a - b);
}
async function extractPages(indices) {
  if (!indices.length) return toast('No pages selected');
  busy(true);
  try {
    const burned = await burnedDoc();
    const out = await PDFDocument.create();
    const pages = await out.copyPages(burned, indices);
    pages.forEach(p => out.addPage(p));
    downloadBytes(await out.save(), outName('-pages-' + indices.map(i => i + 1).join('_').slice(0, 40)));
    toast(`Extracted ${indices.length} page(s)`);
  } catch (e) { console.error(e); toast('Extract failed: ' + e.message); }
  busy(false);
}
$('#btnExtract').onclick = () => {
  if (!state.doc) return toast('Open a PDF first');
  const idx = parseRange($('#extractRange').value, state.pageIds.length);
  if (!idx.length) return toast('Enter a page range like 1-3, 7');
  extractPages(idx);
};

/* ---------- watermark & page numbers (added as editable text annotations) ---------- */
async function forEachPageSize(fn) {
  for (let i = 0; i < state.pageIds.length; i++) {
    const vp = (await state.pdfjs.getPage(i + 1)).getViewport({ scale: 1 });
    fn(i, vp.width, vp.height);
  }
}
$('#btnWatermark').onclick = async () => {
  if (!state.doc) return toast('Open a PDF first');
  const text = $('#wmText').value.trim(); if (!text) return toast('Enter watermark text');
  const opacity = Math.min(1, Math.max(0.05, parseFloat($('#wmOpacity').value) || 0.3));
  commitTextEdit(); pushUndo(snapshotAnnots(state.pageIds));
  await forEachPageSize((i, W, H) => {
    const a = { id: uid(), type: 'text', text, size: 0, font: 'Helvetica', bold: true, color: '#888888', opacity, rot: -45, x: 0, y: 0, w: 0, h: 0 };
    a.size = Math.max(12, Math.floor(Math.hypot(W, H) / (text.length * 0.75)));
    measureText(a);
    const th = a.rot * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
    a.x = W / 2 - (a.w / 2 * c - a.h / 2 * s); a.y = H / 2 - (a.w / 2 * s + a.h / 2 * c);
    (state.annots[state.pageIds[i]] = state.annots[state.pageIds[i]] || []).push(a);
  });
  drawOverlay(); renderThumbs(); toast('Watermark added to all pages (select & delete to remove)');
};
$('#btnPageNums').onclick = async () => {
  if (!state.doc) return toast('Open a PDF first');
  const fmt = $('#pnFormat').value || '{n}', top = $('#pnPos').value === 'top', total = state.pageIds.length;
  commitTextEdit(); pushUndo(snapshotAnnots(state.pageIds));
  await forEachPageSize((i, W, H) => {
    const a = { id: uid(), type: 'text', text: fmt.replace('{n}', i + 1).replace('{total}', total), size: 11, font: 'Helvetica', bold: false, color: '#000000', opacity: 1, rot: 0, x: 0, y: 0, w: 0, h: 0 };
    measureText(a); a.x = (W - a.w) / 2; a.y = top ? 20 : H - 20 - a.h;
    (state.annots[state.pageIds[i]] = state.annots[state.pageIds[i]] || []).push(a);
  });
  drawOverlay(); renderThumbs(); toast('Page numbers added');
};

/* ---------- text extraction ---------- */
$('#btnExtractText').onclick = async () => {
  if (!state.doc) return toast('Open a PDF first');
  busy(true);
  try {
    const page = await state.pdfjs.getPage(state.cur + 1);
    const tc = await page.getTextContent();
    let text = '';
    for (const it of tc.items) { text += it.str; if (it.hasEOL) text += '\n'; }
    showModal(`<h3>Text of page ${state.cur + 1}</h3><textarea id="extractedText"></textarea>
      <div class="row" style="margin-top:8px"><button id="copyText">Copy</button><button id="closeText">Close</button></div>`);
    $('#extractedText').value = text.trim() || '(No selectable text found. This page may be a scanned image.)';
    $('#copyText').onclick = () => { navigator.clipboard.writeText($('#extractedText').value); toast('Copied'); };
    $('#closeText').onclick = hideModal;
  } catch (e) { toast('Could not extract text: ' + e.message); }
  busy(false);
};

/* ---------- metadata ---------- */
function loadMetadata() {
  const d = state.doc; if (!d) return;
  const g = fn => { try { return fn() || ''; } catch (e) { return ''; } };
  $('#mTitle').value = g(() => d.getTitle()); $('#mAuthor').value = g(() => d.getAuthor());
  $('#mSubject').value = g(() => d.getSubject()); $('#mKeywords').value = g(() => d.getKeywords());
}
$('#btnMeta').onclick = () => structOp(async () => {
  const d = state.doc;
  d.setTitle($('#mTitle').value); d.setAuthor($('#mAuthor').value); d.setSubject($('#mSubject').value);
  d.setKeywords($('#mKeywords').value.split(',').map(s => s.trim()).filter(Boolean));
  d.setModificationDate(new Date());
  toast('Metadata updated');
});

/* ---------- form fields ---------- */
function loadFormFields() {
  const cont = $('#formFields'); cont.innerHTML = '';
  let fields = [];
  try { fields = state.doc.getForm().getFields(); } catch (e) { }
  $('#formActions').style.display = fields.length ? '' : 'none';
  if (!fields.length) { cont.innerHTML = '<div class="muted">No fillable form fields in this document.</div>'; return; }
  const P = PDFLib;
  for (const f of fields) {
    const name = f.getName(); const wrap = document.createElement('div'); wrap.className = 'field';
    const lab = document.createElement('label'); lab.textContent = name; wrap.appendChild(lab);
    let el;
    try {
      if (f instanceof P.PDFTextField) { el = document.createElement(f.isMultiline() ? 'textarea' : 'input'); el.value = f.getText() || ''; el.dataset.kind = 'text'; }
      else if (f instanceof P.PDFCheckBox) { el = document.createElement('input'); el.type = 'checkbox'; el.checked = f.isChecked(); el.dataset.kind = 'check'; el.style.width = 'auto'; }
      else if (f instanceof P.PDFRadioGroup || f instanceof P.PDFDropdown) {
        el = document.createElement('select'); el.dataset.kind = f instanceof P.PDFRadioGroup ? 'radio' : 'dropdown';
        const sel = f.getSelected(); const cur = Array.isArray(sel) ? sel[0] : sel;
        const blank = document.createElement('option'); blank.value = ''; blank.textContent = '—'; el.appendChild(blank);
        for (const o of f.getOptions()) { const op = document.createElement('option'); op.value = op.textContent = o; if (o === cur) op.selected = true; el.appendChild(op); }
      } else if (f instanceof P.PDFOptionList) {
        el = document.createElement('select'); el.multiple = true; el.dataset.kind = 'list'; const sel = f.getSelected();
        for (const o of f.getOptions()) { const op = document.createElement('option'); op.value = op.textContent = o; op.selected = sel.includes(o); el.appendChild(op); }
      } else { const d = document.createElement('div'); d.className = 'muted'; d.textContent = '(' + f.constructor.name.replace('PDF', '') + ' — not editable here)'; wrap.appendChild(d); cont.appendChild(wrap); continue; }
    } catch (e) { continue; }
    el.dataset.name = name; wrap.appendChild(el); cont.appendChild(wrap);
  }
}
$('#btnApplyForm').onclick = () => structOp(async () => {
  const form = state.doc.getForm(); const errors = [];
  for (const el of $$('#formFields [data-name]')) {
    try {
      const f = form.getField(el.dataset.name);
      switch (el.dataset.kind) {
        case 'text': f.setText(el.value); break;
        case 'check': el.checked ? f.check() : f.uncheck(); break;
        case 'radio': if (el.value) f.select(el.value); break;
        case 'dropdown': if (el.value) f.select(el.value); break;
        case 'list': f.select([...el.selectedOptions].map(o => o.value)); break;
      }
    } catch (e) { errors.push(el.dataset.name); }
  }
  try { form.updateFieldAppearances(); } catch (e) { }
  if (errors.length) toast('Could not set: ' + errors.join(', '), 5000); else toast('Form values applied');
}, { clearThumbs: true });

/* ---------- export: burn annotations into a copy ---------- */
/* The built-in fonts cover WinAnsi only, but PDFs are full of curly quotes, real dashes and
   ligatures. Map those to something the font can draw so saved text matches what you typed. */
const NEAREST = {
  '‘': "'", '’': "'", '‚': ',', '‛': "'", '′': "'", 'ʼ': "'", '´': "'",
  '“': '"', '”': '"', '„': '"', '″': '"', '«': '"', '»': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '　': ' ',
  '​': '', '‌': '', '‍': '', '­': '', '﻿': '',
  '…': '...', '•': '-', '·': '-', '⁃': '-', '●': '-', '▪': '-',
  'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'œ': 'oe', 'Œ': 'OE',
  '⁄': '/', '∕': '/', '˜': '~', 'Ł': 'L', 'ł': 'l',
};
const NEAREST_RE = new RegExp('[' + Object.keys(NEAREST).join('') + ']', 'g');
function sanitizeForFont(text, font) {
  let out = '';
  for (const ch of text.replace(NEAREST_RE, c => NEAREST[c])) {
    if (ch === '\n') { out += ch; continue; }
    try { font.encodeText(ch); out += ch; } catch (e) { out += '?'; }
  }
  return out;
}
/* Axis-aligned box for one of our annotations, in display points. */
function annotBox(a) {
  if (a.pts) { const b = bounds(a); return { x: b.x, y: b.y, X: b.x + b.w, Y: b.y + b.h }; }
  const t = a.rot * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const pts = [[0, 0], [a.w, 0], [a.w, a.h], [0, a.h]].map(([lx, ly]) => [a.x + lx * c - ly * s, a.y + lx * s + ly * c]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), X: Math.max(...xs), Y: Math.max(...ys) };
}

/* Form fields are drawn on top of the page by every PDF viewer, so anything we put over a
   field would slide underneath it in the saved file even though it looks right on screen.
   When that happens the fields have to be flattened into the page first. */
async function annotsCoverAFormField() {
  for (let i = 0; i < state.pageIds.length; i++) {
    const list = (state.annots[state.pageIds[i]] || []).filter(a => !(a.type === 'text' && !a.text.trim()));
    if (!list.length) continue;
    let page, widgets;
    try {
      page = await state.pdfjs.getPage(i + 1);
      widgets = (await page.getAnnotations()).filter(w => w.subtype === 'Widget' && w.rect);
    } catch (e) { continue; }
    if (!widgets.length) continue;
    const vp = page.getViewport({ scale: 1 });
    const boxes = widgets.map(w => {
      const [x1, y1] = vp.convertToViewportPoint(w.rect[0], w.rect[1]);
      const [x2, y2] = vp.convertToViewportPoint(w.rect[2], w.rect[3]);
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), X: Math.max(x1, x2), Y: Math.max(y1, y2) };
    });
    for (const a of list) {
      const b = annotBox(a);
      if (boxes.some(w => b.x < w.X && b.X > w.x && b.y < w.Y && b.Y > w.y)) return true;
    }
  }
  return false;
}

async function burnedDoc() {
  const doc = await PDFDocument.load(state.bytes, { ignoreEncryption: true, updateMetadata: false });
  // Must happen before anything of ours is drawn, so our marks end up on top.
  if ($('#flattenForm').checked || await annotsCoverAFormField()) {
    try {
      const form = doc.getForm();
      if (form.getFields().length) {
        try { form.updateFieldAppearances(); } catch (e) { }
        form.flatten();
        if (!$('#flattenForm').checked) toast('Form fields were merged into the page so your marks stay on top.', 5000);
      }
    } catch (e) { console.warn('flatten failed', e); }
  }
  const fonts = {}, imgs = {};
  const fontNames = { Helvetica: ['Helvetica', 'HelveticaBold'], TimesRoman: ['TimesRoman', 'TimesRomanBold'], Courier: ['Courier', 'CourierBold'] };
  const getFont = async a => { const k = a.font + (a.bold ? 'B' : ''); if (!fonts[k]) fonts[k] = await doc.embedFont(StandardFonts[fontNames[a.font][a.bold ? 1 : 0]]); return fonts[k]; };
  const getImage = async a => { if (!imgs[a.src]) { const b = await (await fetch(a.src)).arrayBuffer(); imgs[a.src] = a.fmt === 'jpg' ? await doc.embedJpg(b) : await doc.embedPng(b); } return imgs[a.src]; };
  for (let i = 0; i < state.pageIds.length; i++) {
    const list = (state.annots[state.pageIds[i]] || []).filter(a => !(a.type === 'text' && !a.text.trim()));
    if (!list.length) continue;
    const page = doc.getPage(i);
    const vp = (await state.pdfjs.getPage(i + 1)).getViewport({ scale: 1 });
    const R = vp.rotation;
    const toU = (x, y) => { const [ux, uy] = vp.convertToPdfPoint(x, y); return { x: ux, y: uy }; };
    for (const a of list) {
      const op = a.opacity == null ? 1 : a.opacity;
      if (a.pts) {
        const color = hexToRgb(a.color);
        const segs = [];
        for (let k = 0; k < a.pts.length - 1; k++) segs.push([a.pts[k], a.pts[k + 1]]);
        if (a.pts.length === 1) segs.push([a.pts[0], [a.pts[0][0] + 0.1, a.pts[0][1]]]);
        if (a.type === 'arrow') { const tip = a.pts[a.pts.length - 1]; for (const h of arrowHead(a)) segs.push([tip, h]); }
        for (const [p, q] of segs) page.drawLine({ start: toU(p[0], p[1]), end: toU(q[0], q[1]), thickness: a.width, color, opacity: op, lineCap: LineCapStyle.Round });
        continue;
      }
      const th = a.rot * Math.PI / 180, sin = Math.sin(th), cos = Math.cos(th);
      const rotate = degrees(R - a.rot);
      const bl = toU(a.x - a.h * sin, a.y + a.h * cos);   // local bottom-left corner
      if (a.type === 'rect') {
        page.drawRectangle({ x: bl.x, y: bl.y, width: a.w, height: a.h, rotate, color: a.fill ? hexToRgb(a.fill) : undefined, borderColor: a.stroke ? hexToRgb(a.stroke) : undefined, borderWidth: a.stroke ? a.width : 0, opacity: op, borderOpacity: op, blendMode: a.blend === 'multiply' ? BlendMode.Multiply : undefined });
      } else if (a.type === 'ellipse') {
        const c = toU(a.x + (a.w / 2) * cos - (a.h / 2) * sin, a.y + (a.w / 2) * sin + (a.h / 2) * cos);
        page.drawEllipse({ x: c.x, y: c.y, xScale: a.w / 2, yScale: a.h / 2, rotate, color: a.fill ? hexToRgb(a.fill) : undefined, borderColor: a.stroke ? hexToRgb(a.stroke) : undefined, borderWidth: a.stroke ? a.width : 0, opacity: op, borderOpacity: op });
      } else if (a.type === 'text') {
        const font = await getFont(a);
        const base = toU(a.x - a.size * 0.9 * sin, a.y + a.size * 0.9 * cos);
        page.drawText(sanitizeForFont((a.lines || [a.text]).join('\n'), font), { x: base.x, y: base.y, size: a.size, font, color: hexToRgb(a.color), opacity: op, rotate, lineHeight: a.size * 1.2 });
      } else if (a.type === 'image') {
        const img = await getImage(a);
        page.drawImage(img, { x: bl.x, y: bl.y, width: a.w, height: a.h, rotate, opacity: op });
      }
    }
  }
  return doc;
}
async function exportBytes() {
  const doc = await burnedDoc();   // handles flattening itself, before drawing
  return doc.save();
}
/* Where the last save went, so Save writes over the same file instead of leaving you with
   "document-edited (3).pdf" and no idea which one is current. */
let saveTarget = null;
window.resetSaveTarget = () => { saveTarget = null; };
async function savePdf(saveAs) {
  if (!state.doc) return toast('Open a PDF first');
  commitTextEdit();
  const canPick = typeof window.showSaveFilePicker === 'function';
  let handle = saveAs ? null : saveTarget;
  try {
    if (canPick && !handle) {
      handle = await window.showSaveFilePicker({
        suggestedName: outName(),
        types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }],
      });
    }
  } catch (e) { if (e && e.name === 'AbortError') return; console.warn(e); handle = null; }
  busy(true);
  try {
    const bytes = await exportBytes();
    if (handle) {
      const w = await handle.createWritable();
      await w.write(bytes); await w.close();
      saveTarget = handle; state.dirty = false;
      toast('Saved ' + handle.name);
    } else {
      downloadBytes(bytes, outName()); state.dirty = false;
      toast('Saved ' + outName());
    }
  } catch (e) { console.error(e); toast('Save failed: ' + e.message, 6000); }
  busy(false);
}
$('#btnSave').onclick = $('#btnSave2').onclick = () => savePdf(false);
$('#btnSaveAs').onclick = () => savePdf(true);
$('#btnPrint').onclick = async () => {
  if (!state.doc) return toast('Open a PDF first');
  commitTextEdit(); busy(true);
  try {
    const url = URL.createObjectURL(new Blob([await exportBytes()], { type: 'application/pdf' }));
    const w = window.open(url, '_blank');
    if (!w) toast('Popup blocked. Allow popups to print.'); else toast('Opened in a new tab. Use the print button there.');
  } catch (e) { toast('Print failed: ' + e.message); }
  busy(false);
};
$('#btnPng').onclick = async () => {
  if (!state.doc) return toast('Open a PDF first');
  commitTextEdit();
  const page = await state.pdfjs.getPage(state.cur + 1);
  const vp = page.getViewport({ scale: 2 });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
  const ctx = c.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  drawAnnots(ctx, curPageId(), 2, null, { spell: false });
  c.toBlob(b => { downloadBytes(b, state.fileName.replace(/\.pdf$/i, '') + `-page${state.cur + 1}.png`, 'image/png'); }, 'image/png');
};
