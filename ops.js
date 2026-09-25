/* Free PDF Editor — page operations, forms, metadata, export */
'use strict';

// `undo`, if given, is the step that takes it back (see rotatePages): cheaper to keep than a
// copy of the whole document, which is what is kept otherwise.
async function structOp(fn, { clearThumbs = false, undo = null } = {}) {
  if (!state.doc) { toast('Open a PDF first'); return; }
  commitTextEdit();
  if (undo) pushUndo(typeof undo === 'function' ? undo() : undo); else pushStructUndo();
  busy(true);
  try { await fn(); if (clearThumbs) state.thumbCache.clear(); await rebuild(); }
  catch (e) { console.error(e); dropLastUndo(); toast('Operation failed: ' + e.message, 5000); }
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
async function rotateNow(indices, dir) {
  for (const i of indices) {
    const page = state.doc.getPage(i);
    const vp = (await state.pdfjs.getPage(i + 1)).getViewport({ scale: 1 });
    let w = vp.width, h = vp.height;
    const steps = dir > 0 ? 1 : 3;
    for (let k = 0; k < steps; k++) { rotateAnnots90(state.pageIds[i], w, h); [w, h] = [h, w]; }
    page.setRotation(degrees((((page.getRotation().angle + dir * 90) % 360) + 360) % 360));
  }
}
/* Undoing a turn is turning back, and undoing a move is moving back: kept as that, not as a copy
   of the document. Three turns of a 46 MB scan used to hold 132 MB for undo. The marks on the
   turned pages are kept too (a few bytes), so they come back exactly where they were. */
const turnStep = (indices, dir) => ({ kind: 'turn', indices: [...indices], dir, pages: snapshotAnnots(indices.map(i => state.pageIds[i])).pages, cur: state.cur });
async function rotatePages(indices, dir) {
  await structOp(() => rotateNow(indices, dir), { undo: () => turnStep(indices, -dir) });
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
function moveNow(from, to) {
  const page = state.doc.getPage(from);
  state.doc.removePage(from);
  state.doc.insertPage(to, page);
  const [id] = state.pageIds.splice(from, 1); state.pageIds.splice(to, 0, id);
  state.cur = to; state.selectedPages.clear(); state.selectedPages.add(to);
}
async function movePage(from, to) {
  await structOp(async () => moveNow(from, to), { undo: () => ({ kind: 'move', from: to, to: from, cur: state.cur }) });
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
/* Copying pages brings their fill-in boxes along, but not the form's list of fields, so the
   boxes arrived as orphans: the Form tab could not see them, and flattening could not reach
   them, which left them painted on top of anything drawn over them in the saved file. Put
   each copied field into this document's form, renamed if the name is already taken. */
function adoptFormFields(src, pages) {
  const L = PDFLib, ctx = state.doc.context, N = n => L.PDFName.of(n);
  const tops = new Set();
  for (const p of pages) {
    const annots = p.node.Annots(); if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i), w = ctx.lookup(ref);
      if (!(w instanceof L.PDFDict) || w.get(N('Subtype')) !== N('Widget')) continue;
      let fieldRef = ref, field = w;
      for (let guard = 0; guard < 64; guard++) {
        const pr = field.get(N('Parent')); if (!(pr instanceof L.PDFRef)) break;
        const parent = ctx.lookup(pr); if (!(parent instanceof L.PDFDict)) break;
        fieldRef = pr; field = parent;
      }
      if (fieldRef instanceof L.PDFRef && field.get(N('T'))) tops.add(fieldRef);
    }
  }
  if (!tops.size) return 0;
  const form = state.doc.getForm(), acro = form.acroForm;
  const taken = new Set(form.getFields().map(f => f.getName().split('.')[0]));
  for (const ref of tops) {
    const f = ctx.lookup(ref), t = f.lookup(N('T'));
    let name = t && t.decodeText ? t.decodeText() : '';
    if (taken.has(name)) {
      let k = 2; while (taken.has(`${name}_${k}`)) k++;
      name = `${name}_${k}`; f.set(N('T'), L.PDFHexString.fromText(name));
    }
    taken.add(name);
    acro.addField(ref);
  }
  // the defaults the fields' own appearances were written against: fonts, and the default look
  try {
    const srcAcro = src.catalog.getAcroForm();
    if (srcAcro) {
      const copier = L.PDFObjectCopier.for(src.context, ctx);
      const sd = srcAcro.dict;
      if (!acro.dict.get(N('DA')) && sd.get(N('DA'))) acro.dict.set(N('DA'), copier.copy(sd.lookup(N('DA'))));
      const sDR = sd.lookup(N('DR'));
      if (sDR instanceof L.PDFDict) {
        let dDR = acro.dict.lookup(N('DR'));
        if (!(dDR instanceof L.PDFDict)) { dDR = ctx.obj({}); acro.dict.set(N('DR'), dDR); }
        const sFonts = sDR.lookup(N('Font'));
        if (sFonts instanceof L.PDFDict) {
          let dFonts = dDR.lookup(N('Font'));
          if (!(dFonts instanceof L.PDFDict)) { dFonts = ctx.obj({}); dDR.set(N('Font'), dFonts); }
          for (const [k, v] of sFonts.entries()) if (!dFonts.get(k)) dFonts.set(k, copier.copy(v));
        }
      }
      if (sd.get(N('NeedAppearances'))) acro.dict.set(N('NeedAppearances'), sd.get(N('NeedAppearances')));
    }
  } catch (e) { console.warn('form defaults not copied', e); }
  return tops.size;
}
async function mergeFiles(files) {
  let adopted = 0;
  await structOp(async () => {
    for (const f of files) {
      const src = await PDFDocument.load(await readFile(f), { ignoreEncryption: true });
      if (src.isEncrypted) { toast(`${f.name} is password-protected and was skipped`, 5000); continue; }
      const pages = await state.doc.copyPages(src, src.getPageIndices());
      for (const p of pages) { state.doc.addPage(p); state.pageIds.push(uid()); }
      try { adopted += adoptFormFields(src, pages); } catch (e) { console.warn('could not adopt form fields', e); }
    }
  });
  if (adopted) { loadFormFields(); toast(`Added ${adopted} fill-in field${adopted === 1 ? '' : 's'} from the new pages. They are in the Form tab.`, 5000); }
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
    const page = await KamView.pdfPage(state.cur);      // the words as they are now, edits included
    const tc = await page.getTextContent();
    let text = '';
    for (const it of tc.items) { text += it.str; if (it.hasEOL) text += '\n'; }
    if (!text.trim() && typeof ocrTextFor === 'function') text = ocrTextFor(state.cur);
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
    const list = (state.annots[state.pageIds[i]] || []).filter(a => !a.hidden && a.type !== 'textedit' && !(a.type === 'text' && !a.text.trim()));
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

/* A fill-in box that belongs to no field in the form: viewers still paint it on top of the
   page, but flattening the form never reaches it. Paint its current look into the page and
   remove the box, the same way flattening treats real fields. */
function flattenLeftoverWidgets(doc) {
  const L = PDFLib, ctx = doc.context, N = n => L.PDFName.of(n);
  let n = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots(); if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const w = ctx.lookup(annots.get(i));
      if (!(w instanceof L.PDFDict) || w.get(N('Subtype')) !== N('Widget')) continue;
      const flags = w.lookup(N('F')), hidden = flags instanceof L.PDFNumber && (flags.asNumber() & 2);
      const ap = w.lookup(N('AP')); let look = ap instanceof L.PDFDict ? ap.get(N('N')) : null;
      const lookObj = look && ctx.lookup(look);
      if (lookObj instanceof L.PDFDict && !(lookObj instanceof L.PDFStream)) {        // on/off states
        const as = w.get(N('AS')); look = as ? lookObj.get(as) : null;
      }
      const rect = w.lookup(N('Rect'));
      if (look instanceof L.PDFStream) look = ctx.register(look);          // written inline, not by reference
      if (!hidden && look instanceof L.PDFRef && rect instanceof L.PDFArray) {
        const r = rect.asRectangle(), key = page.node.newXObject('FlatWidget', look);
        page.pushOperators(L.pushGraphicsState(), L.translate(r.x, r.y), L.drawObject(key), L.popGraphicsState());
      }
      annots.remove(i); n++;
    }
  }
  return n;
}

/* Render a whole page, with everything we have added, to a bitmap. Used for redaction:
   the page is rebuilt from this image, so the words underneath are gone from the file
   rather than merely hidden. */
async function rasterisePage(i, dpi = 180) {
  const page = await KamView.pdfPage(i);             // with any edits to its own text
  const base = page.getViewport({ scale: 1 });
  const scale = dpi / 72;
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  // make sure any inserted pictures have finished loading before they are baked in
  const list = state.annots[state.pageIds[i]] || [];
  await Promise.all(list.filter(a => a.type === 'image').map(a => new Promise(res => {
    const im = getImg(a); if (im.complete) return res();
    im.addEventListener('load', res, { once: true }); im.addEventListener('error', res, { once: true });
  })));
  drawAnnots(ctx, state.pageIds[i], scale, null, { spell: false, marks: false });
  return { canvas: c, w: base.width, h: base.height };
}

async function burnedDoc() {
  const doc = await PDFDocument.load(state.bytes, { ignoreEncryption: true, updateMetadata: false });
  // Text edited in place goes into the pages' own content first, before forms are flattened or
  // anything of ours is drawn on top: the words are rewritten where they are, in their own
  // font (content.js).
  let skipped = 0, applied = 0;
  for (let i = 0; i < state.pageIds.length; i++) {
    const eds = (state.annots[state.pageIds[i]] || []).filter(a => a.type === 'textedit' && !a.hidden);
    if (!eds.length) continue;
    const an = await KamContent.analyse(i);
    const done = an.ok ? await KamContent.applyEdits(doc, i, an, eds) : 0;
    skipped += eds.length - done; applied += done;
  }
  if (skipped) toast(`${skipped} text edit${skipped === 1 ? '' : 's'} could not be written, because the page has changed underneath ${skipped === 1 ? 'it' : 'them'}.`, 6000);
  // the pages' old content, with the words that were changed or deleted, must not stay in the file
  if (applied) KamContent.pruneUnreachable(doc);
  const redacted = [];
  for (let i = 0; i < state.pageIds.length; i++)
    if ((state.annots[state.pageIds[i]] || []).some(a => a.redact && !a.hidden)) redacted.push(i);
  const fieldCount = (() => { try { return doc.getForm().getFields().length; } catch (e) { return 0; } })();
  // Must happen before anything of ours is drawn, so our marks end up on top.
  if ($('#flattenForm').checked || (fieldCount && redacted.length) || await annotsCoverAFormField()) {
    let flat = 0;
    try {
      const form = doc.getForm();
      if (form.getFields().length) {
        try { form.updateFieldAppearances(); } catch (e) { }
        flat = form.getFields().length;
        form.flatten();
      }
    } catch (e) { console.warn('flatten failed', e); }
    // and any box that belongs to no field at all, which flattening the form cannot see
    try { flat += flattenLeftoverWidgets(doc); } catch (e) { console.warn('leftover widgets not flattened', e); }
    if (flat && !$('#flattenForm').checked) toast('Form fields were merged into the page so your marks stay on top.', 5000);
  }
  const fonts = {}, imgs = {}, bundledFonts = {}, lost = new Set();
  const fontNames = { Helvetica: ['Helvetica', 'HelveticaBold'], TimesRoman: ['TimesRoman', 'TimesRomanBold'], Courier: ['Courier', 'CourierBold'] };
  const stdFont = async a => { const k = a.font + (a.bold ? 'B' : ''); if (!fonts[k]) fonts[k] = await doc.embedFont(StandardFonts[fontNames[a.font][a.bold ? 1 : 0]]); return fonts[k]; };
  const canWrite = (font, text) => { try { font.encodeText(text.replace(/\n/g, '')); return true; } catch (e) { return false; } };
  /* The font for text of ours. A standard font when it can write every letter, which adds
     nothing to the file; otherwise the bundled font of the same design and measurements, with
     only the letters used (fonts.js). The standard fonts only know Western European letters,
     so Polish, Czech, Greek or Russian used to come out of the saved file as question marks.
     Letters no font here has at all are left out, and saving says which. */
  async function fontFor(a, text) {
    text = text.normalize('NFC').replace(/[\u200B-\u200F\u2060\uFEFF]/g, '');     // invisible marks no font draws
    if (fontNames[a.font]) { const f = await stdFont(a); if (canWrite(f, text)) return { font: f, text }; }
    const key = KamFonts.keyFor(a.font, a.bold);
    if (!bundledFonts[key]) {
      await KamFonts.ready(); doc.registerFontkit(window.fontkit);
      const b = await KamFonts.bundled(key);
      bundledFonts[key] = { pdf: await doc.embedFont(b.bytes, { subset: true, features: { liga: false } }), fk: b.fk };
    }
    const bf = bundledFonts[key], gone = KamFonts.missingFrom(bf.fk, text);
    if (gone.length) { gone.forEach(c => lost.add(c)); text = [...text].filter(c => !gone.includes(c)).join(''); }
    return { font: bf.pdf, text };
  }
  // each picture once in the file, however many marks show it
  const getImage = async a => {
    const im = imageOf(a), key = a.img || im.src;
    if (!imgs[key]) { const b = await (await fetch(im.src)).arrayBuffer(); imgs[key] = im.fmt === 'jpg' ? await doc.embedJpg(b) : await doc.embedPng(b); }
    return imgs[key];
  };
  /* Words read off a scan go in as invisible text over the picture, which is what makes a
     scanned PDF searchable and selectable in any viewer. */
  async function addOcrLayer(page, i, toU, R) {
    const words = (typeof ocrWordsFor === 'function' ? ocrWordsFor(i) : []) || [];
    if (!words.length) return;
    for (const w of words) {
      const { font, text } = await fontFor({ font: 'Helvetica', bold: false }, w.text);
      const txt = text.trim();
      if (!txt) continue;
      let size = Math.max(1, w.h * 0.82);
      // keep the hidden word inside its box, so selecting it in a viewer lands where the
      // picture shows the word
      try { const nat = font.widthOfTextAtSize(txt, size); if (nat > w.w && nat > 0) size *= w.w / nat; } catch (e) { }
      const at = toU(w.x, w.y + w.h * 0.86);            // baseline near the bottom of the box
      page.drawText(txt, { x: at.x, y: at.y, size: Math.max(0.5, size), font, opacity: 0, rotate: degrees(R) });
    }
  }

  /* A redacted page is rebuilt from a picture, which would otherwise throw away the text of
     the whole page. Put back an invisible copy of every word that was not redacted, so the
     rest of the page stays searchable and selectable while the removed words stay gone.
     The new page is the display size with no rotation, so y simply flips. */
  async function keepSurvivingText(page, i, pageH) {
    let runs;
    try { runs = (await KamPdfText.index(i)).runs; } catch (e) { return; }
    if (!runs || !runs.length) return;
    const boxes = (state.annots[state.pageIds[i]] || [])
      .filter(a => a.redact && !a.hidden).map(annotBox);
    const clear = (x0, x1, y0, y1) => !boxes.some(b => x0 < b.X + 1 && x1 > b.x - 1 && y0 < b.Y + 1 && y1 > b.y - 1);
    for (const r of runs) {
      if (Math.abs(r.rot) > 0.5) continue;              // only straight lines, which is nearly all of them
      for (const m of r.text.matchAll(/\S+/g)) {
        const s = m.index, e = s + m[0].length;
        const x0 = KamPdfText.uAt(r, s), x1 = KamPdfText.uAt(r, e);
        if (x1 - x0 < 0.2) continue;
        if (!clear(x0, x1, r.y, r.y + r.h)) continue;   // this word was redacted: leave it out
        const { font, text: word } = await fontFor({ font: 'Helvetica', bold: false }, m[0]);
        if (!word.trim()) continue;
        let size = Math.max(1, r.size);
        try { const nat = font.widthOfTextAtSize(word, size); if (nat > x1 - x0 && nat > 0) size *= (x1 - x0) / nat; } catch (err) { }
        page.drawText(word, { x: x0, y: pageH - r.base[1], size: Math.max(0.5, size), font, opacity: 0 });
      }
    }
  }

  for (let i = 0; i < state.pageIds.length; i++) {
    if (redacted.includes(i)) continue;                 // rebuilt from a bitmap further down
    const list = (state.annots[state.pageIds[i]] || []).filter(a => !a.hidden && a.type !== 'textedit' && !(a.type === 'text' && !a.text.trim()));
    const ocrWords = (typeof ocrWordsFor === 'function' ? ocrWordsFor(i) : []) || [];
    if (!list.length && !ocrWords.length) continue;
    const page = doc.getPage(i);
    const vp = (await state.pdfjs.getPage(i + 1)).getViewport({ scale: 1 });
    const R = vp.rotation;
    const toU = (x, y) => { const [ux, uy] = vp.convertToPdfPoint(x, y); return { x: ux, y: uy }; };
    await addOcrLayer(page, i, toU, R);
    for (const a of list) {
      const op = a.opacity == null ? 1 : a.opacity;
      if (a.pts) {
        /* One path, stroked once, exactly as the screen draws it. Drawing it as hundreds of
           separate little lines made every joint a double coat of paint, so a half-transparent
           pen came out of the saved file nearly solid. */
        const L = PDFLib, P = a.pts.length === 1 ? [a.pts[0], [a.pts[0][0] + 0.1, a.pts[0][1]]] : a.pts;
        const ops = [L.pushGraphicsState()];
        if (op < 1) ops.push(L.setGraphicsState(page.node.newExtGState('GS', doc.context.obj({ Type: 'ExtGState', CA: op, ca: op }))));
        ops.push(L.setStrokingColor(hexToRgb(a.color)), L.setLineWidth(a.width),
                 L.setLineCap(L.LineCapStyle.Round), L.setLineJoin(L.LineJoinStyle.Round));
        P.forEach((p, k) => { const u = toU(p[0], p[1]); ops.push(k ? L.lineTo(u.x, u.y) : L.moveTo(u.x, u.y)); });
        if (a.type === 'arrow') {
          const t = a.pts[a.pts.length - 1], tip = toU(t[0], t[1]);
          for (const h of arrowHead(a)) { const e = toU(h[0], h[1]); ops.push(L.moveTo(tip.x, tip.y), L.lineTo(e.x, e.y)); }
        }
        ops.push(L.stroke(), L.popGraphicsState());
        page.pushOperators(...ops);
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
        const { font, text } = await fontFor(a, (a.lines || [a.text]).join('\n'));
        const base = toU(a.x - a.size * 0.9 * sin, a.y + a.size * 0.9 * cos);
        page.drawText(text, { x: base.x, y: base.y, size: a.size, font, color: hexToRgb(a.color), opacity: op, rotate, lineHeight: a.size * 1.2 });
      } else if (a.type === 'image') {
        const img = await getImage(a);
        page.drawImage(img, { x: bl.x, y: bl.y, width: a.w, height: a.h, rotate, opacity: op });
      }
    }
  }

  const sayLost = () => { if (lost.size) toast(`${[...lost].join(' ')} could not be saved: none of the fonts in KAM PDFs has ${lost.size === 1 ? 'it' : 'them'}. The rest of your text is saved.`, 7000); };
  if (!redacted.length) { sayLost(); return doc; }

  /* Redacted pages are rebuilt from a picture of themselves, so the words behind the black
     boxes are not in the file at all. Then everything is copied into a fresh document: only
     what the new pages reference comes across, which leaves the original page contents behind. */
  for (const i of redacted) {
    const { canvas, w, h } = await rasterisePage(i);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
    const img = await doc.embedJpg(await blob.arrayBuffer());
    doc.removePage(i);
    const page = doc.insertPage(i, [w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    await keepSurvivingText(page, i, h);
  }
  const clean = await PDFDocument.create();
  const copied = await clean.copyPages(doc, doc.getPageIndices());
  copied.forEach(p => clean.addPage(p));
  try {
    const t = doc.getTitle(), a = doc.getAuthor(), s = doc.getSubject(), k = doc.getKeywords();
    if (t) clean.setTitle(t); if (a) clean.setAuthor(a); if (s) clean.setSubject(s);
    if (k) clean.setKeywords(k.split(/,\s*/).filter(Boolean));
  } catch (e) { }
  clean.setProducer('KAM PDFs'); clean.setModificationDate(new Date());
  sayLost();
  return clean;
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
      saveTarget = handle; state.savedRev = state.rev; state.dirty = false;
      toast('Saved ' + handle.name);
    } else {
      downloadBytes(bytes, outName()); state.savedRev = state.rev; state.dirty = false;
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
  const page = await KamView.pdfPage(state.cur);
  const vp = page.getViewport({ scale: 2 });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
  const ctx = c.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  drawAnnots(ctx, curPageId(), 2, null, { spell: false, marks: false });
  c.toBlob(b => { downloadBytes(b, state.fileName.replace(/\.pdf$/i, '') + `-page${state.cur + 1}.png`, 'image/png'); }, 'image/png');
};
