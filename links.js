/* KAM PDFs - links and bookmarks.
 *
 * A PDF's links, to a web page or to another place in the document, work here: hold Ctrl and
 * click one (a plain click still selects and edits, as everywhere else in the app), or on a touch
 * screen tap it and then the button that appears. Its bookmarks,
 * the outline long documents carry, are listed beside the pages: click one to go there. They can
 * be added, renamed and removed too, and are saved with the file.
 */
'use strict';
const KamLinks = (() => {
  const L = PDFLib, N = n => L.PDFName.of(n);

  /* ---------- where a destination points: { page, x, y }, in display points ---------- */
  // `dest` as pdf.js gives it: a name, or [page (reference or index), kind, ...numbers].
  async function resolve(dest) {
    const pdf = state.pdfjs; if (!pdf || dest == null) return null;
    let d = dest;
    try { if (typeof d === 'string') d = await pdf.getDestination(d); } catch (e) { return null; }
    if (!Array.isArray(d) || !d.length) return null;
    let page = null;
    try {
      if (Number.isInteger(d[0])) page = d[0];
      else if (d[0] && typeof d[0] === 'object') page = await pdf.getPageIndex(d[0]);
    } catch (e) { return null; }
    if (page === null || page < 0 || page >= state.pageIds.length) return null;
    const kind = d[1] && d[1].name, a = d.slice(2);
    let x = null, y = null;
    if (kind === 'XYZ') { x = a[0]; y = a[1]; }
    else if (kind === 'FitH' || kind === 'FitBH') y = a[0];
    else if (kind === 'FitR') { x = a[0]; y = a[3]; }
    const vp = (await pdf.getPage(page + 1)).getViewport({ scale: 1 });
    const [dx, dy] = vp.convertToViewportPoint(typeof x === 'number' ? x : vp.viewBox[0], typeof y === 'number' ? y : vp.viewBox[3]);
    return { page, x: typeof x === 'number' ? dx : null, y: typeof y === 'number' ? Math.max(0, dy) : 0 };
  }
  async function go(where) {
    if (!where) { toast('That points to a place that is not in this document any more.', 4000); return; }
    if (typeof commitTextEdit === 'function') commitTextEdit();
    KamView.setActive(where.page);
    KamView.scrollToPoint(where.page, where.y);
  }

  /* ---------- the links on a page ---------- */
  const cache = new Map();                   // page index -> { pdf, list }
  async function linksOf(i) {
    const pdf = state.pdfjs, hit = cache.get(i);
    if (hit && hit.pdf === pdf) return hit.list;
    const page = await pdf.getPage(i + 1), vp = page.getViewport({ scale: 1 });
    // pdf.js only gives `url` for addresses that are safe to open (web, mail); nothing else is used
    const list = (await page.getAnnotations()).filter(a => a.subtype === 'Link' && a.rect).map(a => {
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), X: Math.max(x1, x2), Y: Math.max(y1, y2), url: a.url || null, dest: a.dest != null ? a.dest : null, action: a.action || null };
    }).filter(l => l.url || l.dest !== null || l.action);
    if (pdf === state.pdfjs) cache.set(i, { pdf, list });
    return list;
  }
  function linkAt(i, x, y) {
    const hit = cache.get(i);
    if (!hit || hit.pdf !== state.pdfjs) { if (state.pdfjs && i < state.pageIds.length) linksOf(i).catch(() => { }); return null; }
    return hit.list.find(l => x >= l.x - 1 && x <= l.X + 1 && y >= l.y - 1 && y <= l.Y + 1) || null;
  }
  const ACTIONS = { NextPage: 'the next page', PrevPage: 'the previous page', FirstPage: 'the first page', LastPage: 'the last page' };
  const where = l => (l.url ? l.url.replace(/^mailto:/, 'email ') : l.action ? (ACTIONS[l.action] || 'somewhere') : 'another place in this document');
  async function follow(l) {
    if (l.url) {
      window.open(l.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (l.action) {
      const n = state.pageIds.length, c = state.cur;
      const t = { NextPage: c + 1, PrevPage: c - 1, FirstPage: 0, LastPage: n - 1 }[l.action];
      if (t !== undefined) go({ page: Math.max(0, Math.min(n - 1, t)), y: 0 });
      return;
    }
    go(await resolve(l.dest));
  }
  // what the pointer is over, for the hint and the outline drawn round it
  let hovered = null, hoveredPage = -1;
  function hover(i, x, y) {
    const l = x === null ? null : linkAt(i, x, y);
    if (l !== hovered || i !== hoveredPage) { hovered = l; hoveredPage = i; drawOverlay(); }
    return l ? `Ctrl+click to open ${where(l)}` : null;
  }
  // A touch screen has no Ctrl to hold: tapping a link offers a button that opens it, so a tap
  // meant to pick or edit the text there still does only that.
  let chip = null, chipTimer = 0;
  function hideOffer() { clearTimeout(chipTimer); if (chip) chip.hidden = true; }
  async function offer(i, x, y, cx, cy) {
    let l = null;
    if (i >= 0 && state.pdfjs && i < state.pageIds.length) {
      try { await linksOf(i); } catch (e) { }
      l = linkAt(i, x, y);
    }
    if (!l) { hideOffer(); return false; }
    if (!chip) {
      chip = document.createElement('button');
      chip.id = 'linkChip'; chip.type = 'button';
      chip.addEventListener('pointerdown', e => e.stopPropagation());
      document.body.appendChild(chip);
      const vp = document.getElementById('viewport');
      if (vp) vp.addEventListener('scroll', hideOffer, { passive: true });
    }
    chip.textContent = `Open ${where(l)}`;
    chip.onclick = () => { hideOffer(); follow(l); };
    chip.hidden = false;
    const r = chip.getBoundingClientRect();
    chip.style.left = Math.max(8, Math.min(innerWidth - r.width - 8, cx - r.width / 2)) + 'px';
    chip.style.top = (cy - r.height - 24 < 8 ? cy + 24 : cy - r.height - 24) + 'px';
    clearTimeout(chipTimer); chipTimer = setTimeout(hideOffer, 6000);
    return true;
  }
  function drawHover(ctx, s, i) {
    if (!hovered || i !== hoveredPage) return;
    const dpr = window.devicePixelRatio || 1, l = hovered;
    ctx.save(); ctx.strokeStyle = 'rgba(59,130,246,.85)'; ctx.lineWidth = dpr; ctx.setLineDash([2 * dpr, 2 * dpr]);
    ctx.strokeRect(l.x * s, l.y * s, (l.X - l.x) * s, (l.Y - l.y) * s); ctx.restore();
  }

  /* ---------- bookmarks, read from the document itself so they can be changed ---------- */
  const pageRefs = () => new Map(state.doc.getPages().map((p, k) => [p.ref.tag, k]));
  // A destination as pdf.js would give it, from what pdf-lib read: a name, or [index, kind, ...].
  function destOf(ctx, v, refs) {
    v = v instanceof L.PDFRef ? ctx.lookup(v) : v;
    if (v instanceof L.PDFName) return v.decodeText();
    if (v instanceof L.PDFString || v instanceof L.PDFHexString) return v.decodeText();
    if (v instanceof L.PDFArray && v.size()) {
      const first = v.get(0), page = first instanceof L.PDFRef ? refs.get(first.tag) : first instanceof L.PDFNumber ? first.asNumber() : undefined;
      if (page === undefined) return null;
      const kind = v.lookup(1);
      const rest = v.asArray().slice(2).map(x => (x instanceof L.PDFNumber ? x.asNumber() : null));
      return [page, { name: kind instanceof L.PDFName ? kind.decodeText() : 'XYZ' }, ...rest];
    }
    if (v instanceof L.PDFDict) return destOf(ctx, v.get(N('D')), refs);   // a named destination's dictionary
    return null;
  }
  function readOutline() {
    const doc = state.doc; if (!doc) return [];
    const ctx = doc.context, root = doc.catalog.lookup(N('Outlines'));
    if (!(root instanceof L.PDFDict)) return [];
    const refs = pageRefs(), seen = new Set();
    const read = (ref, depth) => {
      const out = [];
      while (ref instanceof L.PDFRef && !seen.has(ref.tag) && depth < 32 && seen.size < 20000) {
        seen.add(ref.tag);
        const d = ctx.lookup(ref); if (!(d instanceof L.PDFDict)) break;
        const t = d.lookup(N('Title')), count = d.lookup(N('Count')), f = d.lookup(N('F'));
        const item = { ref, title: (t && t.decodeText ? t.decodeText() : '').replace(/[\u0000-\u001F]/g, ' ').trim() || '(untitled)',
                       open: count instanceof L.PDFNumber && count.asNumber() > 0, style: f instanceof L.PDFNumber ? f.asNumber() : 0,
                       dest: null, url: null, kids: [] };
        if (d.get(N('Dest'))) item.dest = destOf(ctx, d.get(N('Dest')), refs);
        const a = d.lookup(N('A'));
        if (a instanceof L.PDFDict) {
          const S = a.lookup(N('S'));
          if (S === N('GoTo')) item.dest = destOf(ctx, a.get(N('D')), refs);
          else if (S === N('URI')) { const u = a.lookup(N('URI')); const s = u && u.decodeText ? u.decodeText() : ''; if (/^(https?:|mailto:)/i.test(s)) item.url = s; }
        }
        item.kids = read(d.get(N('First')), depth + 1);
        out.push(item);
        ref = d.get(N('Next'));
      }
      return out;
    };
    return read(root.get(N('First')), 0);
  }

  /* ---------- the Bookmarks list ---------- */
  const box = $('#outline');
  let side = 'pages';
  function showSide(mode) {
    side = mode;
    $$('.side-switch button').forEach(b => { const on = b.dataset.side === mode; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    $('#thumbs').hidden = mode !== 'pages';
    $('.side-actions').hidden = mode !== 'pages'; $('.side-tip').hidden = mode !== 'pages';
    box.hidden = mode !== 'outline'; $('.outline-actions').hidden = mode !== 'outline';
    if (mode === 'outline') render();
  }
  $$('.side-switch button').forEach(b => b.onclick = () => showSide(b.dataset.side));

  const count = list => list.reduce((n, it) => n + 1 + count(it.kids), 0);
  function render(renameRef) {
    const items = state.doc ? readOutline() : [];
    const n = count(items);
    $('#outlineCount').textContent = n ? `(${n})` : '';
    if (side !== 'outline') return;
    box.textContent = '';
    if (!state.doc) return;
    if (!items.length) {
      const p = document.createElement('div'); p.className = 'muted ol-empty';
      p.textContent = 'This PDF has no bookmarks yet. "Bookmark this page" adds one for the part of the page you are looking at.';
      box.append(p); return;
    }
    const build = (list, host) => {
      for (const it of list) {
        const row = document.createElement('div'); row.className = 'ol-row'; row.setAttribute('role', 'treeitem');
        const twist = document.createElement('button'); twist.className = 'ol-twist';
        let kids = null;
        if (it.kids.length) {
          kids = document.createElement('div'); kids.className = 'ol-kids'; kids.hidden = !it.open;
          twist.textContent = it.open ? '\u25BE' : '\u25B8'; twist.setAttribute('aria-label', it.open ? 'Fold' : 'Unfold');
          twist.onclick = () => { kids.hidden = !kids.hidden; twist.textContent = kids.hidden ? '\u25B8' : '\u25BE'; };
        } else twist.disabled = true;
        const title = document.createElement('button'); title.className = 'ol-title';
        // the title comes from the PDF: text only, never markup
        title.textContent = it.title; title.title = it.title + ' (double-click to rename)';
        if (it.style & 2) title.style.fontWeight = '700';
        if (it.style & 1) title.style.fontStyle = 'italic';
        title.onclick = async () => {
          if (it.url) { window.open(it.url, '_blank', 'noopener,noreferrer'); return; }
          go(await resolve(it.dest));
        };
        title.ondblclick = e => { e.preventDefault(); rename(it, title); };
        const del = document.createElement('button'); del.className = 'ol-del'; del.title = 'Remove this bookmark'; del.setAttribute('aria-label', 'Remove this bookmark');
        del.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg>';
        del.onclick = () => remove(it);
        row.append(twist, title, del);
        host.append(row);
        if (kids) { build(it.kids, kids); host.append(kids); }
        if (renameRef && it.ref === renameRef) setTimeout(() => rename(it, title), 0);
      }
    };
    build(items, box);
  }

  /* ---------- changing bookmarks: part of the document, so undo works as for page changes ---------- */
  function outlineRoot(create) {
    const doc = state.doc, ctx = doc.context;
    let ref = doc.catalog.get(N('Outlines')), root = ref && ctx.lookup(ref);
    if (!(root instanceof L.PDFDict) && create) { root = ctx.obj({ Type: 'Outlines', Count: 0 }); ref = ctx.register(root); doc.catalog.set(N('Outlines'), ref); }
    return root instanceof L.PDFDict ? { ref, root } : null;
  }
  // A dictionary's number of open descendants (what viewers use to show it folded or not).
  function recount(ctx, d) {
    let n = 0, ref = d.get(N('First'));
    const seen = new Set();
    while (ref instanceof L.PDFRef && !seen.has(ref.tag)) {
      seen.add(ref.tag);
      const k = ctx.lookup(ref); if (!(k instanceof L.PDFDict)) break;
      const sub = recount(ctx, k), c = k.lookup(N('Count'));
      n += 1 + (c instanceof L.PDFNumber && c.asNumber() > 0 ? sub : 0);
      ref = k.get(N('Next'));
    }
    if (d.has(N('First'))) {
      // a folded item keeps its count negative, which is how a PDF says it starts folded
      const c = d.lookup(N('Count')), folded = d.get(N('Type')) !== N('Outlines') && c instanceof L.PDFNumber && c.asNumber() < 0;
      d.set(N('Count'), L.PDFNumber.of(folded ? -n : n));
    } else d.delete(N('Count'));
    return n;
  }
  async function add() {
    if (!state.doc) return toast('Open a PDF first');
    const i = state.cur, vpEl = $('#viewport'), el = KamView.pageEl(i);
    const top = el ? Math.max(0, (vpEl.scrollTop - el.offsetTop) / state.zoom) : 0;
    // named after the first line of text in view, which is usually the heading of that part
    let name = `Page ${i + 1}`;
    try {
      const runs = (await KamPdfText.index(i)).runs.filter(r => r.text.trim().length >= 2 && r.y + r.h >= top - 2);
      runs.sort((a, b) => a.y - b.y);
      if (runs.length) name = runs[0].text.trim().slice(0, 80);
    } catch (e) { }
    const page = await state.pdfjs.getPage(i + 1), vp = page.getViewport({ scale: 1 });
    const [, yTop] = vp.convertToPdfPoint(0, top);
    let made = null;
    await structOp(async () => {
      const ctx = state.doc.context, { ref: rootRef, root } = outlineRoot(true);
      const pageRef = state.doc.getPage(i).ref;
      const item = ctx.obj({ Title: L.PDFHexString.fromText(name), Parent: rootRef, Dest: [pageRef, 'XYZ', null, Math.round(yTop), null] });
      const ref = ctx.register(item);
      // in page order among the bookmarks at the top level
      const refs = pageRefs();
      let after = null, cur = root.get(N('First'));
      const seen = new Set();
      while (cur instanceof L.PDFRef && !seen.has(cur.tag)) {
        seen.add(cur.tag);
        const d = ctx.lookup(cur), dest = d instanceof L.PDFDict ? destOf(ctx, d.get(N('Dest')) || (d.lookup(N('A')) instanceof L.PDFDict ? d.lookup(N('A')).get(N('D')) : null), refs) : null;
        if (Array.isArray(dest) && dest[0] > i) break;
        after = cur; cur = d.get(N('Next'));
      }
      const next = after ? ctx.lookup(after).get(N('Next')) : root.get(N('First'));
      if (after) { ctx.lookup(after).set(N('Next'), ref); item.set(N('Prev'), after); } else root.set(N('First'), ref);
      if (next instanceof L.PDFRef) { item.set(N('Next'), next); ctx.lookup(next).set(N('Prev'), ref); } else root.set(N('Last'), ref);
      recount(ctx, root);
      made = ref;
    });
    if (made) { showSide('outline'); render(made); }
  }
  function rename(it, el) {
    const input = document.createElement('input'); input.value = it.title; input.setAttribute('aria-label', 'Bookmark name');
    el.textContent = ''; el.append(input); input.focus(); input.select();
    let done = false;
    const finish = async keep => {
      if (done) return; done = true;
      const t = input.value.trim();
      if (!keep || !t || t === it.title) { render(); return; }
      await structOp(async () => { const d = state.doc.context.lookup(it.ref); if (d instanceof L.PDFDict) d.set(N('Title'), L.PDFHexString.fromText(t)); });
      render();
    };
    input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    input.onblur = () => finish(true);
    input.onclick = e => e.stopPropagation();
  }
  async function remove(it) {
    await structOp(async () => {
      const ctx = state.doc.context, d = ctx.lookup(it.ref); if (!(d instanceof L.PDFDict)) return;
      const prev = d.get(N('Prev')), next = d.get(N('Next')), parentRef = d.get(N('Parent')), parent = parentRef && ctx.lookup(parentRef);
      if (prev instanceof L.PDFRef) { const p = ctx.lookup(prev); if (next instanceof L.PDFRef) p.set(N('Next'), next); else p.delete(N('Next')); }
      if (next instanceof L.PDFRef) { const n = ctx.lookup(next); if (prev instanceof L.PDFRef) n.set(N('Prev'), prev); else n.delete(N('Prev')); }
      if (parent instanceof L.PDFDict) {
        if (parent.get(N('First')) === it.ref) { if (next instanceof L.PDFRef) parent.set(N('First'), next); else parent.delete(N('First')); }
        if (parent.get(N('Last')) === it.ref) { if (prev instanceof L.PDFRef) parent.set(N('Last'), prev); else parent.delete(N('Last')); }
      }
      const root = outlineRoot(false); if (root) recount(ctx, root.root);
      if (parent instanceof L.PDFDict && parent !== (root && root.root)) recount(ctx, parent);
    });
    render();
    toast(`Bookmark "${it.title.slice(0, 40)}" removed. Ctrl+Z brings it back.`, 4000);
  }
  $('#btnAddBookmark').onclick = add;

  function reset() { cache.clear(); hovered = null; hideOffer(); render(); }
  return { resolve, linksOf, linkAt, follow, hover, offer, drawHover, reset, render, readOutline, add, showSide };
})();
