/* KAM PDFs - your signatures and initials, kept in one place.
 *
 * Signatures you draw, or take from a photo or scan of your own on paper, are kept on this
 * computer only (the browser's own storage), each with a name if you give it one. The
 * Signatures section of the Document panel lists them: click one to put it on the page, put
 * it on every page (initialling a contract), name it, or remove it.
 *
 * A picture of a signature on paper is cleaned up before it is kept: the paper is evened out
 * (a photo is lighter in one corner than another), made see-through, the ink kept in its own
 * colour with soft edges, and the picture cropped to the ink.
 */
'use strict';
const KamSigs = (() => {
  const KEY = 'kam-signatures', MAX = 12;
  // Signatures were kept as bare pictures before they had names: read either.
  function list() {
    let raw = [];
    try { raw = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { }
    if (!Array.isArray(raw)) raw = [];
    return raw.map(x => (typeof x === 'string' ? { src: x, name: '' } : x))
      .filter(x => x && typeof x.src === 'string' && /^data:image\/(png|jpeg);base64,/.test(x.src));
  }
  function write(all) {
    try { localStorage.setItem(KEY, JSON.stringify(all.slice(0, MAX))); return true; }
    catch (e) { toast('Could not keep the signature: this browser’s storage for KAM PDFs is full.', 5000); return false; }
  }
  function add(src, name = '') {
    const all = list().filter(s => s.src !== src);
    all.unshift({ src, name });
    if (all.length > MAX) toast(`Only the ${MAX} newest signatures are kept.`, 4000);
    const ok = write(all); render(); return ok;
  }
  function remove(i) { const all = list(); all.splice(i, 1); write(all); render(); }
  function removeSrc(src) { write(list().filter(s => s.src !== src)); render(); }
  function rename(i, name) { const all = list(); if (!all[i]) return; all[i].name = String(name).slice(0, 40); write(all); }
  async function sizeOf(src) {
    const im = new Image(); im.src = src;
    try { await im.decode(); } catch (e) { }
    return [im.naturalWidth || 300, im.naturalHeight || 100];
  }

  /* ---------- on the page ---------- */
  async function place(i) {
    if (!state.doc) return toast('Open a PDF first');
    const s = list()[i]; if (!s) return;
    const [iw, ih] = await sizeOf(s.src);
    placeImage({ src: s.src, fmt: 'png', iw, ih }, 0.3);
    toast('Drag it where it goes, and by a corner to size it.', 3500);
  }
  // On every page, low on the right where initials usually go, at the same place on each. One
  // Ctrl+Z takes them all off again.
  async function everyPage(i) {
    if (!state.doc) return toast('Open a PDF first');
    const s = list()[i]; if (!s) return;
    const [iw, ih] = await sizeOf(s.src);
    pushUndo(snapshotAnnots(state.pageIds));
    const img = registerImage({ src: s.src, fmt: 'png', iw, ih });
    state.pageIds.forEach((pid, k) => {
      const sz = KamView.size(k) || state.pageSize, W = sz.w, H = sz.h;
      let w = Math.min(120, W * 0.2), h = w * ih / iw;
      if (h > 46) { h = 46; w = h * iw / ih; }
      const list = state.annots[pid] || (state.annots[pid] = []);
      list.push({ id: uid(), type: 'image', x: W - w - W * 0.07, y: H - h - H * 0.05, w, h, rot: 0, img, opacity: 1 });
    });
    state.selected = null; updateProps(); drawOverlay();
    state.pageIds.forEach((_, k) => refreshThumb(k));
    toast(`Put on all ${state.pageIds.length} pages, low on the right. Ctrl+Z takes them all off.`, 5000);
  }

  // Today's date, written out so it reads the same everywhere (18 October 2026), as a text box
  // under the signature just put on the page, or in the middle of what you can see.
  function today() {
    if (!state.doc) return toast('Open a PDF first');
    const text = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    const { w: W, h: H } = state.pageSize, sel = state.selected;
    pushAnnotUndo(curPageId());
    const a = { id: uid(), type: 'text', x: 0, y: 0, w: 0, h: 0, rot: 0, text, size: 12, font: defaults.font, bold: false, italic: false, align: 'left', color: '#111111', opacity: 1 };
    measureText(a);
    if (sel && sel.type === 'image' && !sel.rot && curAnnots().includes(sel)) {
      a.x = sel.x; a.y = sel.y + sel.h + 4 + a.h <= H ? sel.y + sel.h + 4 : sel.y - a.h - 4;
    } else {
      const c = typeof visibleCentre === 'function' ? visibleCentre() : [W / 2, H / 2];
      a.x = c[0] - a.w / 2; a.y = c[1] - a.h / 2;
    }
    a.x = Math.max(4, Math.min(W - a.w - 4, a.x)); a.y = Math.max(4, Math.min(H - a.h - 4, a.y));
    curAnnots().push(a);
    if (state.tool !== 'select') setTool('select');
    state.selected = a; updateProps(); drawOverlay(); refreshThumb(state.cur);
    toast('Drag it where it goes. Double-click it to change it.', 3500);
  }

  /* ---------- a picture of a signature on paper ---------- */
  async function fromPicture(file) {
    const url = await readDataUrl(file);
    const im = new Image(); im.src = url; await im.decode();
    const k = Math.min(1, 1400 / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.max(1, Math.round(im.naturalWidth * k)), h = Math.max(1, Math.round(im.naturalHeight * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(im, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h), px = d.data, lum = new Float32Array(w * h);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) lum[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    // the paper's own brightness, block by block, so a shadow across a photo is not taken for ink
    const B = Math.max(16, Math.round(Math.max(w, h) / 24)), bw = Math.ceil(w / B), bh = Math.ceil(h / B), paper = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const vals = [];
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y += 2) for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x += 2) vals.push(lum[y * w + x]);
      vals.sort((a, b) => a - b);
      paper[by * bw + bx] = Math.max(40, vals[Math.floor(vals.length * 0.9)] || 255);
    }
    const paperAt = (x, y) => {                                 // smoothly between the blocks
      const fx = Math.max(0, Math.min(bw - 1, x / B - 0.5)), fy = Math.max(0, Math.min(bh - 1, y / B - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(bw - 1, x0 + 1), y1 = Math.min(bh - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
      const p = (xx, yy) => paper[yy * bw + xx];
      return (p(x0, y0) * (1 - ax) + p(x1, y0) * ax) * (1 - ay) + (p(x0, y1) * (1 - ax) + p(x1, y1) * ax) * ay;
    };
    const norm = new Uint8Array(w * h), hist = new Array(256).fill(0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const j = y * w + x, v = Math.max(0, Math.min(255, Math.round(lum[j] / paperAt(x, y) * 255)));
      norm[j] = v; hist[v]++;
    }
    // where ink starts: Otsu's split of the evened-out brightness, never in the paper itself
    let T = otsu(hist, w * h); T = Math.min(T, 215);
    const soft = Math.max(10, T * 0.18);
    let x0 = w, y0 = h, x1 = -1, y1 = -1, ink = 0;
    for (let j = 0; j < norm.length; j++) {
      const a = Math.max(0, Math.min(1, (T - norm[j]) / soft));
      px[j * 4 + 3] = Math.round(a * 255);
      if (a > 0.5) { ink++; const x = j % w, y = (j / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0 || ink < 30) throw new Error('No signature was found in that picture. Try a photo with the signature large and in focus, on plain paper.');
    if (ink > 0.45 * w * h) throw new Error('That picture is mostly dark: photograph the signature on plain white paper.');
    g.putImageData(d, 0, 0);
    const pad = 4, out = document.createElement('canvas');
    out.width = x1 - x0 + 1 + 2 * pad; out.height = y1 - y0 + 1 + 2 * pad;
    out.getContext('2d').drawImage(c, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }
  function otsu(hist, total) {
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = -1, T = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; T = t; }
    }
    return T;
  }
  async function addPicture(file) {
    try { const src = await fromPicture(file); add(src, ''); toast('Kept. Click it to put it on the page.', 3500); return src; }
    catch (e) { toast(e.message || 'Could not read that picture.', 6000); return null; }
  }

  /* ---------- the Signatures section ---------- */
  function svgIcon(name) {
    const NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg'), u = document.createElementNS(NS, 'use');
    s.setAttribute('class', 'ic'); s.setAttribute('aria-hidden', 'true'); u.setAttribute('href', '#i-' + name); s.appendChild(u);
    return s;
  }
  function render() {
    const host = document.getElementById('sigList'); if (!host) return;
    host.textContent = '';
    const all = list();
    if (!all.length) {
      const p = document.createElement('div'); p.className = 'muted sig-none';
      p.textContent = 'No signatures yet. Draw one, or use a picture of yours.';
      host.appendChild(p);
      return;
    }
    all.forEach((s, i) => {
      const item = document.createElement('div'); item.className = 'sig-item';
      const pick = document.createElement('button'); pick.className = 'sig-pick'; pick.title = 'Put it on this page';
      const img = document.createElement('img'); img.src = s.src; img.alt = s.name ? `Signature: ${s.name}` : 'Saved signature';
      pick.appendChild(img); pick.onclick = () => place(i);
      const name = document.createElement('input'); name.className = 'sig-name'; name.value = s.name || '';
      name.placeholder = 'Add a name'; name.setAttribute('aria-label', 'Name for this signature'); name.maxLength = 40;
      name.addEventListener('change', () => rename(i, name.value.trim()));
      name.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
      const every = document.createElement('button'); every.className = 'sig-every'; every.title = 'Put it on every page, low on the right';
      every.append(svgIcon('pages'), document.createTextNode(' Every page')); every.onclick = () => everyPage(i);
      const del = document.createElement('button'); del.className = 'sig-remove'; del.title = 'Remove it from this computer'; del.setAttribute('aria-label', 'Remove this signature');
      del.appendChild(svgIcon('trash')); del.onclick = () => remove(i);
      item.append(pick, del, name, every);
      host.appendChild(item);
    });
  }
  // from the Sign dialog, a picture goes straight onto the page as well as into the list
  let placeNext = false;
  function pictureThenPlace() { placeNext = true; $('#sigPictureInput').click(); }
  $('#btnSigDraw').onclick = () => { if (!state.doc) return toast('Open a PDF first'); $('#btnSign').click(); };
  $('#btnSigPicture').onclick = () => { placeNext = false; $('#sigPictureInput').click(); };
  $('#btnSigDate').onclick = today;
  $('#sigPictureInput').addEventListener('change', async e => {
    const f = e.target.files[0], then = placeNext; e.target.value = ''; placeNext = false;
    if (!f) return;
    const src = await addPicture(f);
    if (src && then && state.doc) place(0);
  });
  render();

  return { list, add, remove, removeSrc, rename, place, everyPage, today, fromPicture, addPicture, pictureThenPlace, render };
})();
