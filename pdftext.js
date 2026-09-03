/* KAM PDFs - index of the text already in the PDF.
   pdf.js gives every glyph run with its position; we convert those to the same display
   coordinates the annotations use (origin top-left, y down, page rotation applied), group
   them into lines, and offer hit-testing and search. Powers double-click-to-edit and Find. */
'use strict';
const KamPdfText = (() => {
  let docRef = null;
  const pages = new Map();           // page index -> { runs }

  function reset() { pages.clear(); docRef = null; }
  function cached(pi) { if (docRef !== state.pdfjs) reset(); return pages.get(pi) || null; }

  async function index(pi) {
    if (docRef !== state.pdfjs) { pages.clear(); docRef = state.pdfjs; }
    if (pages.has(pi)) return pages.get(pi);
    const pdf = state.pdfjs;
    const page = await pdf.getPage(pi + 1);
    if (pdf !== state.pdfjs) return { runs: [] };
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();

    // one entry per glyph run, in display space
    const raw = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim() || !it.transform) continue;
      const [a, b, c, d, e, f] = it.transform;
      const len = Math.hypot(a, b) || 1;
      const size = Math.hypot(c, d) || it.height || 10;
      const [x0, y0] = vp.convertToViewportPoint(e, f);
      const [x1, y1] = vp.convertToViewportPoint(e + it.width * a / len, f + it.width * b / len);
      const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 0.01;
      const dir = [dx / L, dy / L], perp = [dir[1], -dir[0]];         // perp points "up" the glyphs
      const st = tc.styles[it.fontName] || {};
      let fontLabel = '';
      try { if (page.commonObjs.has(it.fontName)) fontLabel = page.commonObjs.get(it.fontName).name || ''; } catch (err) { }
      raw.push({
        str: it.str, dir, perp, rot: Math.atan2(dy, dx) * 180 / Math.PI, size,
        u0: x0 * dir[0] + y0 * dir[1], u1: x1 * dir[0] + y1 * dir[1], v: x0 * perp[0] + y0 * perp[1],
        family: st.fontFamily || 'sans-serif', fontLabel,
      });
    }

    // Group runs that share a baseline into lines, in reading order. perp points up the
    // glyphs, so a line higher on the page has the larger v: sort by descending v.
    raw.sort((p, q) => (Math.round(p.rot) - Math.round(q.rot)) || (q.v - p.v) || (p.u0 - q.u0));
    const runs = []; let cur = null;
    for (const it of raw) {
      const tol = 0.45 * Math.max(it.size, cur ? cur.size : 0);
      const sameLine = cur && Math.abs(it.rot - cur.rot) < 1.5 && Math.abs(it.v - cur.v) < tol;
      const gap = cur ? it.u0 - cur.u1 : 0;
      if (sameLine && gap > -0.5 * cur.size && gap < 1.6 * cur.size) {
        if (gap > 0.15 * cur.size && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
        cur.parts.push({ start: cur.text.length, end: cur.text.length + it.str.length, u0: it.u0, u1: it.u1 });
        cur.text += it.str; cur.u1 = Math.max(cur.u1, it.u1); cur.size = Math.max(cur.size, it.size);
        if (!cur.fontLabel) cur.fontLabel = it.fontLabel;
      } else {
        cur = { rot: it.rot, dir: it.dir, perp: it.perp, v: it.v, u0: it.u0, u1: it.u1, size: it.size, text: it.str,
                family: it.family, fontLabel: it.fontLabel, parts: [{ start: 0, end: it.str.length, u0: it.u0, u1: it.u1 }] };
        runs.push(cur);
      }
    }
    runs.forEach((r, i) => { r.idx = i; });
    for (const r of runs) {
      // baseline start, then the box in annotation convention (top-left, w, h, rot)
      const asc = 0.78 * r.size;
      r.base = [r.u0 * r.dir[0] + r.v * r.perp[0], r.u0 * r.dir[1] + r.v * r.perp[1]];
      r.x = r.base[0] + asc * r.perp[0]; r.y = r.base[1] + asc * r.perp[1];
      r.w = r.u1 - r.u0; r.h = r.size;
      r.text = r.text.replace(/\s+$/, '');
    }
    // A scan has no text of its own; if it has been through OCR, use those words instead so
    // search and click-to-select work there too.
    if (!runs.length && typeof ocrLinesFor === 'function') {
      for (const l of ocrLinesFor(pi)) {
        const first = l.words[0];
        const line = { rot: 0, dir: [1, 0], perp: [0, -1], v: -first.y, u0: first.x, u1: first.x, size: l.h, h: l.h,
                       w: 0, x: first.x, y: first.y, text: '', family: 'sans-serif', fontLabel: '', ocr: true,
                       base: [first.x, first.y + l.h], parts: [] };
        for (const w of l.words) {
          if (line.text) line.text += ' ';
          line.parts.push({ start: line.text.length, end: line.text.length + w.text.length, u0: w.x, u1: w.x + w.w });
          line.text += w.text;
          line.u1 = Math.max(line.u1, w.x + w.w);
        }
        line.w = line.u1 - line.u0;
        runs.push(line);
      }
      runs.forEach((r, i) => { r.idx = i; });
    }
    const entry = { runs };
    pages.set(pi, entry);
    return entry;
  }

  function local(r, mx, my) {
    const t = r.rot * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), dx = mx - r.x, dy = my - r.y;
    return [dx * c + dy * s, -dx * s + dy * c];
  }
  function runAt(pi, mx, my) {
    const e = cached(pi); if (!e) return null;
    let best = null, bestArea = Infinity;
    for (const r of e.runs) {
      const [lx, ly] = local(r, mx, my);
      if (lx >= -2 && ly >= -2 && lx <= r.w + 2 && ly <= r.h + 2) { const area = r.w * r.h; if (area < bestArea) { best = r; bestArea = area; } }
    }
    return best;
  }
  // position along the baseline of a character offset, using per-item widths
  function uAt(r, ci) {
    for (const p of r.parts) {
      if (ci <= p.end) { const f = p.end > p.start ? (ci - p.start) / (p.end - p.start) : 0; return p.u0 + Math.max(0, Math.min(1, f)) * (p.u1 - p.u0); }
    }
    return r.u1;
  }

  async function search(q) {
    const needle = q.toLowerCase(); const out = [];
    if (!needle) return out;
    for (let pi = 0; pi < state.pageIds.length; pi++) {
      const { runs } = await index(pi);
      for (const r of runs) {
        const hay = r.text.toLowerCase(); let i = hay.indexOf(needle);
        while (i >= 0) { out.push({ page: pi, run: r, start: i, end: i + needle.length }); i = hay.indexOf(needle, i + needle.length); }
      }
    }
    return out;
  }

  /* Which character of a run sits under a point, for click-and-drag selection. */
  function charAt(r, mx, my) {
    const [lx] = local(r, mx, my);
    const u = r.u0 + lx;
    const parts = r.parts;
    if (u <= parts[0].u0) return 0;
    for (const p of parts) {
      if (u <= p.u1) {
        const span = p.u1 - p.u0 || 1;
        const f = Math.max(0, Math.min(1, (u - p.u0) / span));
        return p.start + Math.round(f * (p.end - p.start));
      }
    }
    return r.text.length;
  }
  /* The run nearest a point, so a drag can run past the end of a line. */
  function nearestRun(pi, mx, my) {
    const e = cached(pi); if (!e || !e.runs.length) return null;
    let best = null, bd = Infinity;
    for (const r of e.runs) {
      const [lx, ly] = local(r, mx, my);
      const dx = lx < 0 ? -lx : lx > r.w ? lx - r.w : 0;
      const dy = ly < 0 ? -ly : ly > r.h ? ly - r.h : 0;
      const d = dy * 4 + dx;                     // prefer the right line, then along it
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }
  const runsOf = pi => (cached(pi) || { runs: [] }).runs;

  return { index, cached, runAt, uAt, local, search, reset, charAt, nearestRun, runsOf };
})();
