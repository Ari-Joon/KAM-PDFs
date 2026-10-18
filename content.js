/* KAM PDFs - the text engine: editing the words a PDF already has, in place.
 *
 * Covering a line with a patch of paper and typing over it in some other font is what made
 * edited PDFs look wrong: the new words were a different face, a different weight, a hair off
 * the line, and the patch hid table rules and shading. This does what a proper PDF editor does
 * instead, working on the page's own drawing instructions (its content stream):
 *
 *   - Read the content stream alongside pdf.js's reading of the same page. pdf.js knows the
 *     fonts (widths, encodings, which character each code is); our own reader knows where every
 *     text instruction sits in the file. The two are matched instruction by instruction, and
 *     only used if every character code agrees, so a page we cannot read exactly is simply
 *     left to the old way of editing.
 *   - Group the glyphs into phrases: runs of text on one line, which is what you edit.
 *   - An edit is kept as a mark (type 'textedit') holding the new wording. Only the characters
 *     that changed are touched. Unchanged characters stay exactly as they are in the file;
 *     characters after the change move along to make room. New characters use the PDF's own
 *     font where it has them, and a bundled font of the same measurements where it does not
 *     (see fonts.js).
 *   - When the page is drawn or saved, the edits are written into the content stream itself:
 *     removed glyphs become equal amounts of empty space, so nothing else on the line moves,
 *     and new text is written right beside the text it replaces, in the same text object, so
 *     it has the same colour, transparency and clipping as its neighbours.
 * What you see while editing is drawn from the same layout that is written to the file, and
 * the page itself is drawn from a patched copy (KamPatch below), so the screen and the saved
 * file agree.
 */
'use strict';
const KamContent = (() => {
  const L = PDFLib, N = n => L.PDFName.of(n);

  /* ---------- matrices: PDF's [a b c d e f], points as row vectors ---------- */
  const ID = [1, 0, 0, 1, 0, 0];
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  const pt = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const vec = (m, x, y) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
  const tr = (x, y) => [1, 0, 0, 1, x, y];
  function inv(m) {
    const d = m[0] * m[3] - m[1] * m[2]; if (!d) return null;
    return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
  }

  /* ---------- reading content streams ---------- */
  function streamBytes(s) {
    if (!s) return new Uint8Array(0);
    if (s instanceof L.PDFRawStream) return L.decodePDFRawStream(s).decode();
    if (typeof s.getUnencodedContents === 'function') return s.getUnencodedContents();
    return new Uint8Array(0);
  }
  const lookup = (ctx, v) => (v instanceof L.PDFRef ? ctx.lookup(v) : v);
  const dictOf = (ctx, v) => { const o = lookup(ctx, v); return o instanceof L.PDFDict ? o : null; };
  function concat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  // All of a page's content streams, one after another. They are joined with a newline, as a
  // viewer reads them, so a word cannot run on from the end of one into the next.
  function pageContent(ctx, node) {
    const c = lookup(ctx, node.get(N('Contents')));
    const list = c instanceof L.PDFArray ? c.asArray().map(x => lookup(ctx, x)) : c ? [c] : [];
    const parts = [];
    for (const s of list) if (s instanceof L.PDFStream) { parts.push(streamBytes(s)); parts.push(NL); }
    return concat(parts);
  }
  const NL = new Uint8Array([10]);
  function fingerprint(b) {
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36) + '.' + b.length.toString(36);
  }

  /* ---------- the tokenizer ---------- */
  const WS = new Uint8Array(256); for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
  const DL = new Uint8Array(256); for (const c of [40, 41, 60, 62, 91, 93, 123, 125, 47, 37]) DL[c] = 1;
  const hexv = c => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1);
  const NUM = /^([+-]*)(\d*\.?\d*)(?:[eE]([+-]?\d+))?$/;

  class Lexer {
    constructor(b) { this.b = b; this.p = 0; }
    skip() {
      const b = this.b, n = b.length; let p = this.p;
      for (;;) {
        while (p < n && WS[b[p]]) p++;
        if (p < n && b[p] === 37) { while (p < n && b[p] !== 10 && b[p] !== 13) p++; continue; }
        break;
      }
      this.p = p;
    }
    // { t, v, s, e }: t is num name str [ ] << >> op kw junk; s..e is where it sits in the bytes
    next() {
      this.skip();
      const b = this.b, n = b.length; let p = this.p;
      if (p >= n) return null;
      const s = p, c = b[p];
      if (c === 40) return this.literal();
      if (c === 60) {
        if (b[p + 1] === 60) { this.p = p + 2; return { t: '<<', s, e: p + 2 }; }
        return this.hex();
      }
      if (c === 62) {
        if (b[p + 1] === 62) { this.p = p + 2; return { t: '>>', s, e: p + 2 }; }
        this.p = p + 1; return { t: 'junk', s, e: p + 1 };
      }
      if (c === 91) { this.p = p + 1; return { t: '[', s, e: p + 1 }; }
      if (c === 93) { this.p = p + 1; return { t: ']', s, e: p + 1 }; }
      if (c === 47) {
        p++; let name = '';
        while (p < n && !WS[b[p]] && !DL[b[p]]) {
          if (b[p] === 35 && p + 2 < n && hexv(b[p + 1]) >= 0 && hexv(b[p + 2]) >= 0) { name += String.fromCharCode(hexv(b[p + 1]) * 16 + hexv(b[p + 2])); p += 3; }
          else name += String.fromCharCode(b[p++]);
        }
        this.p = p; return { t: 'name', v: name, s, e: p };
      }
      if (DL[c]) { this.p = p + 1; return { t: 'junk', s, e: p + 1 }; }       // ) { } out of place
      let w = '';
      while (p < n && !WS[b[p]] && !DL[b[p]]) w += String.fromCharCode(b[p++]);
      this.p = p;
      const m = NUM.exec(w);
      if (m && /\d/.test(m[2])) {
        let v = parseFloat(m[2]); if (m[3]) v *= Math.pow(10, +m[3]);
        if (m[1].includes('-')) v = -v;
        return { t: 'num', v, s, e: p };
      }
      if (w === 'true' || w === 'false' || w === 'null') return { t: 'kw', v: w === 'null' ? null : w === 'true', s, e: p };
      return { t: 'op', v: w, s, e: p };
    }
    // (string) with escapes, byte for byte as pdf.js reads it
    literal() {
      const b = this.b, n = b.length, s = this.p, out = [];
      let p = s + 1, depth = 1;
      while (p < n) {
        let c = b[p++];
        if (c === 92) {
          if (p >= n) break;
          c = b[p++];
          if (c === 110) out.push(10); else if (c === 114) out.push(13); else if (c === 116) out.push(9);
          else if (c === 98) out.push(8); else if (c === 102) out.push(12);
          else if (c === 13) { if (b[p] === 10) p++; }
          else if (c === 10) { /* line continuation */ }
          else if (c >= 48 && c <= 55) {
            let v = c - 48;
            if (p < n && b[p] >= 48 && b[p] <= 55) { v = v * 8 + b[p++] - 48; if (p < n && b[p] >= 48 && b[p] <= 55) v = v * 8 + b[p++] - 48; }
            out.push(v & 255);
          } else out.push(c);
        } else if (c === 40) { depth++; out.push(c); }
        else if (c === 41) { if (--depth === 0) break; out.push(c); }
        else out.push(c);
      }
      this.p = p;
      return { t: 'str', v: Uint8Array.from(out), s, e: p };
    }
    hex() {
      const b = this.b, n = b.length, s = this.p, out = [];
      let p = s + 1, hi = -1;
      while (p < n) {
        const c = b[p++];
        if (c === 62) break;
        const v = hexv(c); if (v < 0) continue;
        if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
      }
      if (hi >= 0) out.push(hi * 16);
      this.p = p;
      return { t: 'str', v: Uint8Array.from(out), s, e: p, hex: true };
    }
  }
  // A whole operand: arrays and dictionaries are read to their end.
  function value(lx, tok, depth = 0) {
    switch (tok.t) {
      case 'num': return tok.v;
      case 'name': return { name: tok.v };
      case 'str': return { str: tok.v };
      case 'kw': return tok.v;
      case '[': {
        const arr = [];
        for (;;) { const t = lx.next(); if (!t || t.t === ']') break; if (t.t === 'op') { arr.push({ op: t.v }); continue; } arr.push(value(lx, t, depth + 1)); }
        return arr;
      }
      case '<<': {
        const d = {};
        for (;;) {
          const k = lx.next(); if (!k || k.t === '>>') break;
          if (k.t !== 'name') continue;
          const v = lx.next(); if (!v || v.t === '>>') break;
          d[k.v] = value(lx, v, depth + 1);
        }
        return { dict: d };
      }
      default: return { junk: true };
    }
  }
  // Step over the bytes of an inline image (BI ... ID <data> EI), finding its end the way pdf.js does.
  function skipInlineImage(lx, d) {
    const b = lx.b, n = b.length; let p = lx.p;
    if (WS[b[p]]) p++;
    const f = d.F || d.Filter, fn = (Array.isArray(f) ? f[0] : f) || {}, name = fn.name || '';
    const endAfter = q => { let r = q; while (r < n && WS[b[r]]) r++; return b[r] === 69 && b[r + 1] === 73 && (r + 2 >= n || WS[b[r + 2]] || DL[b[r + 2]]) ? r + 2 : -1; };
    let end = -1;
    const len = typeof d.L === 'number' ? d.L : typeof d.Length === 'number' ? d.Length : -1;
    if (len > 0 && p + len <= n) end = endAfter(p + len);
    if (end < 0 && (name === 'DCTDecode' || name === 'DCT')) {
      for (let q = p; q + 1 < n && end < 0; q++) if (b[q] === 0xFF && b[q + 1] === 0xD9) end = endAfter(q + 2);
    }
    if (end < 0 && (name === 'ASCIIHexDecode' || name === 'AHx')) { const q = b.indexOf(62, p); if (q >= 0) end = endAfter(q + 1); }
    if (end < 0 && (name === 'ASCII85Decode' || name === 'A85')) {
      for (let q = p; q + 1 < n && end < 0; q++) if (b[q] === 126 && b[q + 1] === 62) end = endAfter(q + 2);
    }
    if (end < 0) {
      for (let q = p; q + 1 < n; q++) {
        if (b[q] !== 69 || b[q + 1] !== 73 || !(q === p || WS[b[q - 1]]) || !(q + 2 >= n || WS[b[q + 2]])) continue;
        let plain = true;
        for (let r = q + 2; r < Math.min(n, q + 12); r++) { const c = b[r]; if (c > 0x7f || (c < 0x20 && !WS[c])) { plain = false; break; } }
        if (plain) { end = q + 2; break; }
      }
    }
    lx.p = end < 0 ? n : end;
  }

  /* ---------- fonts, as pdf.js decoded them ---------- */
  // Split a string's bytes into character codes, exactly as pdf.js does for this font.
  function splitCodes(font, b) {
    const out = [], cm = font && font.composite && font.cMap;
    if (!cm) { for (let i = 0; i < b.length; i++) out.push({ code: b[i], s: i, n: 1 }); return out; }
    const cs = cm.codespaceRanges || [];
    let i = 0;
    while (i < b.length) {
      let c = 0, done = false;
      for (let n = 0; n < cs.length && !done; n++) {
        c = ((c << 8) | (i + n < b.length ? b[i + n] : 0)) >>> 0;
        const r = cs[n] || [];
        for (let k = 0; k < r.length; k += 2) if (c >= r[k] && c <= r[k + 1]) { out.push({ code: c, s: i, n: n + 1 }); i += n + 1; done = true; break; }
      }
      if (!done) { out.push({ code: 0, s: i, n: 1 }); i += 1; }
    }
    return out;
  }
  function codeBytes(font, code) {
    if (!(font.composite && font.cMap)) return code >= 0 && code < 256 ? [code] : null;
    const cs = font.cMap.codespaceRanges || [];
    for (let n = 0; n < cs.length; n++) {
      const r = cs[n] || [];
      for (let k = 0; k < r.length; k += 2) if (code >= r[k] && code <= r[k + 1]) {
        const out = []; for (let i = n; i >= 0; i--) out.push((code >>> (8 * i)) & 255);
        return out;
      }
    }
    return null;
  }
  function widthOf(font, code) {
    let wc = code;
    const cm = font.composite && font.cMap;
    if (cm && cm._map && cm._map.length) {
      const v = cm._map[code];
      if (typeof v === 'number') wc = v;
      else if (typeof v === 'string') wc = v.length === 1 ? v.charCodeAt(0) : (v.charCodeAt(0) << 8) | v.charCodeAt(1);
    }
    const w = font.widths ? font.widths[wc] : undefined;
    return typeof w === 'number' ? w : (font.defaultWidth || 0);
  }
  const fm0 = font => ((font && font.fontMatrix) || [0.001])[0] || 0.001;
  // Which code draws a given character in this font, if any: the font's own character map run
  // backwards, keeping only codes the font really has a glyph for.
  const invCache = new WeakMap();
  function inverseOf(font) {
    let m = invCache.get(font);
    if (m) return m;
    m = new Map();
    const has = code => font.missingFile || !font.toFontChar || font.toFontChar[code] !== undefined;
    const add = (code, u) => {
      if (!u || typeof u !== 'string') return;
      const prev = m.get(u);
      if (prev === undefined || (!has(prev) && has(code))) m.set(u, code);
    };
    const tu = font.toUnicode;
    if (tu && tu._map) tu._map.forEach((u, code) => add(code, typeof u === 'number' ? String.fromCodePoint(u) : u));
    else if (tu && typeof tu.firstChar === 'number') for (let c = tu.firstChar; c <= Math.min(tu.lastChar, 0xffff); c++) add(c, String.fromCharCode(c));
    invCache.set(font, m);
    return m;
  }
  const isMark = cp => (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x20d0 && cp <= 0x20ff);
  // Can the PDF's own font draw this character? { code, bytes, w0, space } or null.
  function encodeOrig(font, cp, seen) {
    if (!font || font.vertical) return null;
    const ch = String.fromCodePoint(cp);
    let code = seen && seen.get(ch);
    if (code === undefined) {
      if (font.isType3Font) return null;              // only codes already drawn on the page
      code = inverseOf(font).get(ch);
      if (code === undefined) return null;
      if (!font.missingFile && font.toFontChar && font.toFontChar[code] === undefined) return null;
    }
    const bytes = codeBytes(font, code); if (!bytes) return null;
    const w0 = widthOf(font, code) * fm0(font);
    if (!(w0 > 0) && cp !== 32 && !isMark(cp)) return null;     // no width: not really in this font
    return { code, bytes, w0, space: bytes.length === 1 && code === 32 };
  }

  /* ---------- what pdf.js drew: its text operations, in order ---------- */
  function rgbOf(a) {
    if (!a) return null;
    if (typeof a[0] === 'string' && a[0][0] === '#') { const n = parseInt(a[0].slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    if (typeof a[0] === 'number') return [a[0], a[1], a[2]];
    return null;
  }
  function pdfjsShows(ol) {
    const O = pdfjsLib.OPS, fn = ol.fnArray, args = ol.argsArray, out = [];
    let st = { font: null, size: 0, fill: [0, 0, 0], stroke: [0, 0, 0], lw: 1 };
    const stack = [];
    for (let i = 0; i < fn.length; i++) {
      const f = fn[i], a = args[i];
      if (f === O.showText) { out.push({ font: st.font, size: st.size, glyphs: a[0], fill: st.fill, stroke: st.stroke, lw: st.lw }); continue; }
      switch (f) {
        case O.save: case O.paintFormXObjectBegin: case O.beginGroup: stack.push({ ...st }); break;
        case O.restore: case O.paintFormXObjectEnd: case O.endGroup: if (stack.length) st = stack.pop(); break;
        case O.setFont: st.font = a[0]; st.size = a[1]; break;
        case O.setGState:
          for (const [k, v] of (a[0] || [])) { if (k === 'Font') { st.font = v[0]; st.size = v[1]; } else if (k === 'LW') st.lw = v; }
          break;
        case O.setFillRGBColor: st.fill = rgbOf(a); break;
        case O.setStrokeRGBColor: st.stroke = rgbOf(a); break;
        case O.setFillColorN: st.fill = null; break;
        case O.setLineWidth: st.lw = a[0]; break;
        case O.beginAnnotation: i = fn.length; break;          // the page's own content ends here
      }
    }
    return out;
  }

  /* ---------- reading a page: our interpreter, checked against pdf.js ---------- */
  function readPage(ctx, pageNode, shows, fontOf, VT) {
    const an = { ok: false, reason: '', containers: [], ops: [], glyphs: [], VT };
    let si = 0, failed = '';
    const fail = m => { if (!failed) failed = m; };
    const nameMap = new Map();

    const pageBytes = pageContent(ctx, pageNode);
    const pageRes = dictOf(ctx, pageNode.Resources ? pageNode.Resources() : pageNode.get(N('Resources')));
    an.containers.push({ kind: 'page', path: 'p', parent: -1, bytes: pageBytes, fp: fingerprint(pageBytes), res: pageRes });

    const gs0 = { ctm: ID, res: null, size: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Tr: 0, Ts: 0, gsFont: false };
    run(0, pageBytes, pageRes, gs0, 0, []);
    if (!failed && si !== shows.length) fail(`pdf.js drew ${shows.length} text operations, we read ${si}`);
    an.ok = !failed; an.reason = failed;
    an.fp = an.containers.map(c => c.fp).join('|');
    return an;

    function run(ci, bytes, res, gsIn, depth, seen) {
      const lx = new Lexer(bytes);
      let gs = { ...gsIn }; const stack = [];
      let Tm = ID, Tlm = ID, acc = 0, accY = 0;
      const operands = []; let opStart = -1, local = 0, doCount = 0;
      const lineTo = m => { Tlm = m; Tm = m; acc = 0; accY = 0; };
      for (;;) {
        if (failed) return;
        const tok = lx.next();
        if (!tok) break;
        if (tok.t !== 'op') { if (opStart < 0) opStart = tok.s; operands.push(value(lx, tok)); continue; }
        const a = operands, s = opStart >= 0 ? opStart : tok.s, name = tok.v;
        const num = k => (typeof a[k] === 'number' ? a[k] : 0);
        switch (name) {
          case 'q': stack.push(gs); gs = { ...gs }; break;
          case 'Q': if (stack.length) gs = stack.pop(); break;
          case 'cm': if (a.length >= 6) gs.ctm = mul([num(0), num(1), num(2), num(3), num(4), num(5)], gs.ctm); break;
          case 'BT': lineTo(ID); break;
          case 'ET': break;
          case 'Tc': gs.Tc = num(0); break;
          case 'Tw': gs.Tw = num(0); break;
          case 'Tz': gs.Th = num(0) / 100; break;
          case 'TL': gs.TL = num(0); break;
          case 'Tf': gs.res = a[0] && a[0].name !== undefined ? a[0].name : null; gs.size = num(1); gs.gsFont = false; break;
          case 'Tr': gs.Tr = num(0); break;
          case 'Ts': gs.Ts = num(0); break;
          case 'Td': lineTo(mul(tr(num(0), num(1)), Tlm)); break;
          case 'TD': gs.TL = -num(1); lineTo(mul(tr(num(0), num(1)), Tlm)); break;
          case 'Tm': if (a.length >= 6) lineTo([num(0), num(1), num(2), num(3), num(4), num(5)]); break;
          case 'T*': lineTo(mul(tr(0, -gs.TL), Tlm)); break;
          case 'Tj': case 'TJ': case "'": case '"': {
            let aw = 0, ac = 0;
            if (name === "'") lineTo(mul(tr(0, -gs.TL), Tlm));
            if (name === '"') { aw = num(0); ac = num(1); gs.Tw = aw; gs.Tc = ac; lineTo(mul(tr(0, -gs.TL), Tlm)); }
            const last = a[a.length - 1];
            const elems = name === 'TJ' ? (Array.isArray(last) ? last : []) : [last];
            show(ci, local++, name, elems, s, tok.e, aw, ac);
            break;
          }
          case 'gs': {
            const eg = res && dictOf(ctx, res.get(N('ExtGState')));
            const d = eg && a[0] && a[0].name !== undefined ? dictOf(ctx, eg.get(N(a[0].name))) : null;
            const f = d && d.lookup(N('Font'));
            if (f instanceof L.PDFArray) { gs.res = null; gs.gsFont = true; const sz = f.lookup(1); gs.size = sz instanceof L.PDFNumber ? sz.asNumber() : 0; }
            break;
          }
          case 'Do': {
            const nm = a[a.length - 1]; const di = doCount++;
            if (!nm || nm.name === undefined || !res) break;
            const xo = dictOf(ctx, res.get(N('XObject')));
            const ref = xo && xo.get(N(nm.name)), st = ref && lookup(ctx, ref);
            if (!(st instanceof L.PDFStream) || st.dict.get(N('Subtype')) !== N('Form')) break;
            if (depth >= 12 || (ref instanceof L.PDFRef && seen.includes(ref))) break;
            let fb; try { fb = streamBytes(st); } catch (e) { fail('a form on the page could not be read'); break; }
            const mArr = st.dict.lookup(N('Matrix'));
            const m = mArr instanceof L.PDFArray && mArr.size() === 6 ? mArr.asArray().map(x => (x instanceof L.PDFNumber ? x.asNumber() : 0)) : ID;
            const fres = dictOf(ctx, st.dict.get(N('Resources'))) || res;
            const k = an.containers.length;
            an.containers.push({ kind: 'form', path: an.containers[ci].path + '.' + di, parent: ci, name: nm.name, bytes: fb, fp: fingerprint(fb), res: fres, doS: s, doE: tok.e });
            run(k, fb, fres, { ...gs, ctm: mul(m, gs.ctm) }, depth + 1, ref instanceof L.PDFRef ? seen.concat([ref]) : seen);
            break;
          }
          case 'BI': {
            const d = {};
            for (;;) {
              const k = lx.next(); if (!k || (k.t === 'op' && k.v === 'ID')) break;
              if (k.t === 'name') { const v = lx.next(); if (!v) break; d[k.v] = value(lx, v); }
            }
            skipInlineImage(lx, d);
            break;
          }
        }
        operands.length = 0; opStart = -1;
      }

      function show(ci2, localIdx, kind, elems, s, e, aw, ac) {
        const pj = shows[si++];
        if (!pj) { fail('there is more text than pdf.js drew'); return; }
        const font = fontOf(pj.font);
        if (!font) { fail('a font pdf.js did not load'); return; }
        const key = ci2 + '|' + (gs.gsFont ? '#gs' : gs.res);
        const known = nameMap.get(key);
        if (known && known !== pj.font) { fail('fonts do not line up'); return; }
        nameMap.set(key, pj.font);
        if (Math.abs(Math.abs(gs.size) - Math.abs(pj.size)) > 1e-4 * Math.max(1, Math.abs(gs.size))) { fail('font sizes do not line up'); return; }
        const cont = an.containers[ci2];
        const op = {
          id: an.ops.length, key: cont.path + '/' + localIdx, c: ci2, s, e, kind, res: gs.res, gsFont: gs.gsFont, font: pj.font,
          size: gs.size, Tc: gs.Tc, Tw: gs.Tw, Th: gs.Th, Tr: gs.Tr, Ts: gs.Ts, ctm: gs.ctm, Tlm, aw, ac,
          fill: pj.fill, stroke: pj.stroke, lw: pj.lw, vertical: !!font.vertical, items: [], glyphs: [],
        };
        an.ops.push(op);
        const glyphs = pj.glyphs || [];
        let gi = 0; const f0 = fm0(font);
        const x0 = acc;
        op.acc0 = x0;                                        // where it starts, along the line
        for (const el of elems) {
          if (typeof el === 'number') {
            const tx = -el / 1000 * gs.size * gs.Th;
            if (font.vertical) accY += -el / 1000 * gs.size; else { acc += tx; Tm = mul(tr(tx, 0), Tm); }
            op.items.push({ num: el });
            continue;
          }
          if (!el || !el.str) continue;
          for (const cd of splitCodes(font, el.str)) {
            while (typeof glyphs[gi] === 'number') gi++;
            const g = glyphs[gi++];
            if (!g || g.originalCharCode !== cd.code) { fail('character codes do not line up'); return; }
            const w0 = (g.width || 0) * f0;
            const tx = (w0 * gs.size + gs.Tc + (g.isSpace ? gs.Tw : 0)) * gs.Th;
            const gl = {
              id: an.glyphs.length, key: op.key + '#' + op.glyphs.length, op: op.id, k: op.glyphs.length,
              code: cd.code, bytes: el.str.slice(cd.s, cd.s + cd.n), uni: g.unicode || '', fontChar: g.fontChar || '',
              w0, space: !!g.isSpace, inFont: !!g.isInFont, Tm, x: acc - x0, tx,
            };
            an.glyphs.push(gl); op.glyphs.push(gl.id); op.items.push({ g: gl.id });
            if (font.vertical) {
              const vm = g.vmetric || font.defaultVMetrics || [-1000];
              accY += (vm[0] * f0 * gs.size - gs.Tc - (g.isSpace ? gs.Tw : 0));
              Tm = mul(tr(0, vm[0] * f0 * gs.size), Tm);
            } else { acc += tx; Tm = mul(tr(tx, 0), Tm); }
          }
        }
        while (typeof glyphs[gi] === 'number') gi++;
        if (gi !== glyphs.length) { fail('pdf.js drew more characters than we read'); return; }
        op.accEnd = acc; op.accYEnd = accY; op.Tm1 = Tm;
      }
    }
  }

  /* ---------- where each glyph is on the page, in display points ---------- */
  function place(an, fontOf) {
    const VT = an.VT;
    for (const g of an.glyphs) {
      const op = an.ops[g.op], font = fontOf(op.font);
      const TC = mul(mul(g.Tm, op.ctm), VT);                 // text space -> display
      const ax = vec(TC, 1, 0), ay = vec(TC, 0, 1);
      const kx = Math.hypot(ax[0], ax[1]) || 1e-9, ky = Math.hypot(ay[0], ay[1]) || 1e-9;
      const sgn = g.tx < 0 ? -1 : 1;
      g.dir = [sgn * ax[0] / kx, sgn * ax[1] / kx];
      const up = [ay[0] / ky * Math.sign(op.size || 1), ay[1] / ky * Math.sign(op.size || 1)];
      g.kx = kx;                                             // display points per text-space unit along the line
      const o = pt(TC, 0, 0);
      g.u0 = o[0] * g.dir[0] + o[1] * g.dir[1];
      g.u1 = g.u0 + Math.abs(g.tx) * kx;
      // "up" as seen by the reader: perpendicular to the line, towards the top of the letters
      const perp = [g.dir[1], -g.dir[0]];
      g.mirrored = up[0] * perp[0] + up[1] * perp[1] < 0.5;
      g.v = o[0] * perp[0] + o[1] * perp[1];
      g.size = Math.abs(op.size) * ky;
      g.rise = op.Ts * ky;
      const asc = font && typeof font.ascent === 'number' && font.ascent > 0.3 && font.ascent < 1.5 ? font.ascent : 0.8;
      const desc = font && typeof font.descent === 'number' && font.descent < 0 && font.descent > -0.6 ? font.descent : -0.2;
      g.top = g.v + g.rise + asc * g.size; g.bot = g.v + g.rise + desc * g.size;
      g.angle = Math.atan2(g.dir[1], g.dir[0]) * 180 / Math.PI;
      g.visible = !(op.Tr === 3 || op.Tr === 7) && g.size > 0.3 && op.Th !== 0;
      g.editable = g.visible && !g.mirrored && !op.vertical && !op.gsFont && op.res !== null && Math.abs(op.size * op.Th) > 1e-6
        && !(op.Tr >= 4) && Math.abs(op.accYEnd || 0) < 1e-6;
    }
  }

  /* ---------- phrases: the runs of text you edit ---------- */
  const LIGS = { '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st' };
  function uniText(u) {
    return String(u || '')
      .replace(/[\uFB00-\uFB06]/g, c => LIGS[c])
      .replace(/[\t\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
      .replace(/\u00AD/g, '-')
      .replace(/[\u0000-\u0008\u000A-\u001F\u007F\u200B-\u200F\u2028-\u202E\u2060-\u2064\uFEFF]/g, '');
  }
  function buildPhrases(an) {
    const vis = an.glyphs.filter(g => g.visible && !g.mirrored && !an.ops[g.op].vertical);
    const buckets = new Map();
    for (const g of vis) { const k = Math.round(g.angle * 2) / 2; let b = buckets.get(k); if (!b) buckets.set(k, b = []); b.push(g); }
    const phrases = [];
    for (const list of buckets.values()) {
      list.sort((p, q) => q.v - p.v);
      // lines: glyphs sharing a baseline
      const lines = []; let cur = null;
      for (const g of list) {
        if (cur && Math.abs(g.v - cur.v) <= 0.3 * Math.min(g.size, cur.size) + 0.01) { cur.gs.push(g); cur.v = (cur.v * (cur.gs.length - 1) + g.v) / cur.gs.length; cur.size = Math.max(cur.size, g.size); }
        else { cur = { v: g.v, size: g.size, gs: [g] }; lines.push(cur); }
      }
      for (const line of lines) {
        line.gs.sort((p, q) => p.u0 - q.u0 || p.id - q.id);
        // Overprinted copies (text printed twice, a shade apart, to look bold) belong to the
        // glyph they copy: they go wherever it goes and add nothing to the wording.
        const main = [];
        for (const g of line.gs) {
          const prev = main.length ? main[main.length - 1] : null;
          const twin = prev && uniText(prev.uni) === uniText(g.uni) && Math.abs(g.u0 - prev.u0) < 0.2 * g.size && Math.abs(g.v - prev.v) < 0.2 * g.size;
          if (twin) { (prev.shadows = prev.shadows || []).push(g.id); g.shadowOf = prev.id; continue; }
          main.push(g);
        }
        // A phrase ends at a gap wider than a word space can be: a tab, a table column, a list
        // bullet's indent. Editing then moves only the words of the same phrase along. The
        // widest word space a justified line uses is well under 0.75 em; a tab is rarely less.
        // (Word writes a tab as an ordinary space followed by a jump: a space that travels three
        // times its own width is a tab too.)
        let ph = null;
        for (const g of main) {
          const gap = ph ? g.u0 - ph.u1 : 0;
          const size = ph ? Math.max(ph.size, g.size) : g.size;
          const prev = ph && ph.gs[ph.gs.length - 1];
          const tab = prev && /^\s$/.test(uniText(prev.uni)) && g.u0 - prev.u0 > Math.max(3 * (prev.u1 - prev.u0), 0.5 * size);
          if (!ph || tab || gap > 0.75 * size || gap < -0.5 * size) { ph = { gs: [g], u1: g.u1, size: g.size }; phrases.push(ph); }
          else { ph.gs.push(g); ph.u1 = Math.max(ph.u1, g.u1); ph.size = Math.max(ph.size, g.size); }
        }
      }
    }
    // text, character positions and the box of each phrase
    const out = [];
    for (const raw of phrases) {
      const gs = raw.gs, first = gs[0];
      const chars = []; let text = '';
      for (let i = 0; i < gs.length; i++) {
        const g = gs[i], t = uniText(g.uni), prev = gs[i - 1];
        if (prev) {
          const gap = g.u0 - prev.u1;
          if (gap > 0.15 * Math.min(g.size, prev.size) && !/ $/.test(text) && !/^ /.test(t)) { chars.push({ g: null, u0: prev.u1, u1: g.u0, gs: text.length, ge: text.length + 1 }); text += ' '; }
        }
        const start = text.length, n = t.length;
        if (!n) { if (chars.length) { const owner = chars[chars.length - 1].g; if (owner !== null) (an.glyphs[owner].shadows = an.glyphs[owner].shadows || []).push(g.id); } else g.orphan = true; continue; }
        for (let k = 0; k < n; k++) {
          const a0 = g.u0 + (g.u1 - g.u0) * k / n, a1 = g.u0 + (g.u1 - g.u0) * (k + 1) / n;
          chars.push({ g: g.id, u0: a0, u1: a1, gs: start, ge: start + n });
        }
        text += t;
      }
      if (!text.trim()) continue;
      const ids = gs.map(g => g.id);
      const all = [...new Set(gs.flatMap(g => [g.id, ...(g.shadows || [])]))];
      const top = Math.max(...gs.map(g => g.top)), bot = Math.min(...gs.map(g => g.bot));
      const u0 = Math.min(...gs.map(g => g.u0)), u1 = Math.max(...gs.map(g => g.u1));
      const dir = first.dir, perp = [dir[1], -dir[0]];
      const sizes = gs.map(g => g.size).sort((a, b) => a - b), size = sizes[Math.floor(sizes.length / 2)];
      // how wide a space is on this line, measured, so new spaces match (justified text too)
      const sp = [];
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i]; if (text[i] !== ' ') continue;
        if (c.g === null) sp.push(c.u1 - c.u0);
        else { const nx = chars[i + 1]; sp.push(nx ? nx.u0 - c.u0 : c.u1 - c.u0); }
      }
      sp.sort((a, b) => a - b);
      const bad = [...text].filter(ch => /[\uE000-\uF8FF\uFFFD\u0000-\u001F]/.test(ch)).length;
      // right-to-left scripts are stored in the order they are drawn, not read: retyping them
      // here would scramble the words, so they are left to the older way
      const rtl = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(text);
      const editable = gs.every(g => g.editable) && bad <= text.length * 0.3 && !rtl;
      out.push({
        key: first.key, gkeys: ids.map(id => an.glyphs[id].key), glyphs: ids, all, text, chars,
        dir, perp, angle: Math.atan2(dir[1], dir[0]) * 180 / Math.PI, u0, u1, top, bot, v: first.v, size,
        spaceAdv: sp.length ? sp[Math.floor(sp.length / 2)] : 0, editable,
        box: boxOf(dir, perp, u0, u1, top, bot),
      });
    }
    alignments(an, out);
    an.phrases = out;
    an.byKey = new Map(out.map(p => [p.key, p]));
    paragraphs(an, out);
  }
  /* How each line is aligned, judged from the lines around it: a word processor would keep a
     right-aligned amount lined up on the right, a centred title centred, and a justified line
     reaching both margins, and so should an edit. Lines of a paragraph or cells of a column are
     neighbours: the same slant, similar size, close above or below, overlapping sideways. */
  function alignments(an, list) {
    const ink = p => {
      const gs = p.glyphs.map(id => an.glyphs[id]).filter(g => /\S/.test(uniText(g.uni)));
      return gs.length ? [Math.min(...gs.map(g => g.u0)), Math.max(...gs.map(g => g.u1))] : [p.u0, p.u1];
    };
    for (const p of list) [p.s, p.e] = ink(p);
    const rightWith = new Map();
    for (const p of list) {
      const tol = 0.6 + 0.02 * p.size;
      let left = false, right = false, centre = false, both = false;
      const rw = [];
      for (const q of list) {
        if (q === p || Math.abs(q.angle - p.angle) > 0.5 || q.size < 0.5 * p.size || q.size > 2 * p.size) continue;
        const dv = Math.abs(q.v - p.v);
        if (dv < 0.5 * p.size || dv > 3 * Math.max(p.size, q.size)) continue;
        if (q.e < p.s || q.s > p.e) continue;                    // not in the same column
        const ds = Math.abs(q.s - p.s) < tol, de = Math.abs(q.e - p.e) < tol, dc = Math.abs((q.s + q.e) / 2 - (p.s + p.e) / 2) < tol;
        if (ds && de) both = true;
        else if (ds) left = true;
        else if (de) { right = true; rw.push(q); }
        else if (dc) centre = true;
      }
      const words = /\S\s+\S/.test(p.text.trim());
      p.align = both && words ? 'justify' : right && !left ? 'right' : centre && !left && !right ? 'center' : 'left';
      rightWith.set(p, rw);
    }
    // the indented first line of a justified paragraph lines up only on the right, but with lines
    // that are justified: it is justified too, not right-aligned
    for (const p of list) {
      if (p.align === 'right' && /\S\s+\S/.test(p.text.trim()) && rightWith.get(p).some(q => q.align === 'justify')) p.align = 'justify';
    }
  }
  // A box in the same shape the marks use: top-left corner, width, height, rotation.
  function boxOf(dir, perp, u0, u1, top, bot) {
    return { x: dir[0] * u0 + perp[0] * top, y: dir[1] * u0 + perp[1] * top, w: u1 - u0, h: top - bot, rot: Math.atan2(dir[1], dir[0]) * 180 / Math.PI };
  }

  /* ---------- reading a page, cached ---------- */
  const cache = new Map();          // page id -> { pdf, promise, an }
  function fontGetter(page) {
    const objs = page.commonObjs, memo = new Map();
    return id => {
      if (!id) return null;
      if (memo.has(id)) return memo.get(id);
      let f = null; try { if (objs.has(id)) f = objs.get(id); } catch (e) { }
      memo.set(id, f);
      return f;
    };
  }
  function analyse(i) {
    const id = state.pageIds[i], pdf = state.pdfjs;
    if (id === undefined || !pdf) return Promise.resolve({ ok: false, reason: 'no page', phrases: [] });
    const hit = cache.get(id);
    if (hit && hit.pdf === pdf) return hit.promise;
    const entry = { pdf, an: null, promise: null };
    entry.promise = (async () => {
      let an;
      try {
        const page = await pdf.getPage(i + 1);
        const ol = await page.getOperatorList();
        const vp = page.getViewport({ scale: 1 });
        const fontOf = fontGetter(page);
        an = readPage(state.doc.context, state.doc.getPage(i).node, pdfjsShows(ol), fontOf, vp.transform);
        an.fontOf = fontOf; an.page = i; an.pageId = id; an.pageW = vp.width; an.pageH = vp.height;
        if (an.ok) { place(an, fontOf); buildPhrases(an); } else an.phrases = [];
      } catch (e) {
        console.warn('text engine: could not read page ' + (i + 1), e);
        an = { ok: false, reason: String(e && e.message || e), phrases: [] };
      }
      if (!an.ok && an.reason) console.info(`text engine: page ${i + 1} is edited the simple way (${an.reason})`);
      entry.an = an;
      return an;
    })();
    cache.set(id, entry);
    while (cache.size > 24) cache.delete(cache.keys().next().value);
    return entry.promise;
  }
  function cached(i) {
    const e = cache.get(state.pageIds[i]);
    return e && e.pdf === state.pdfjs ? e.an : null;
  }
  function reset() { cache.clear(); layoutCache.clear(); }

  /* ---------- laying out an edit ---------- */
  const editsOf = i => (state.annots[state.pageIds[i]] || []).filter(a => a.type === 'textedit');
  function phraseOfEdit(an, e) {
    const ph = an && an.byKey && an.byKey.get(e.src.key);
    if (!ph || e.src.fp !== an.fp || ph.gkeys.length !== e.src.glyphs.length) return null;
    for (let k = 0; k < ph.gkeys.length; k++) if (ph.gkeys[k] !== e.src.glyphs[k]) return null;
    return ph;
  }
  // The font a glyph of the original is drawn with on screen: the PDF's own when pdf.js has its
  // program, otherwise the bundled stand-in (which is what pdf.js itself does for fonts that are
  // not embedded).
  function drawFontFor(font) {
    const own = KamFonts.forPdf(font);
    if (own) return { fk: own, own: true };
    const key = KamFonts.fallbackKey(font), b = KamFonts.bundledNow(key);
    return b ? { fk: b.fk, own: false } : { need: key };
  }

  /* The heart of it: what the page looks like with a phrase's wording changed to `text`.
     Synchronous, using the fonts that are loaded; anything still missing is listed in `needs`
     so the caller can load it and ask again. */
  function layout(an, ph, text, opt) {
    const glyphs = an.glyphs, old = ph.text;
    const res = { ok: true, removed: new Set(), shift: new Map(), ins: [], draws: [], chars: [], needs: [], missing: [], du: 0 };
    const need = k => { if (!res.needs.includes(k)) res.needs.push(k); };
    text = String(text).replace(/[\r\n]+/g, ' ');

    // 1. what changed: the common beginning and end are kept as they are
    let p = 0; while (p < old.length && p < text.length && old[p] === text[p]) p++;
    let s = 0; while (s < old.length - p && s < text.length - p && old[old.length - 1 - s] === text[text.length - 1 - s]) s++;
    if (p > 0 && /[\uD800-\uDBFF]/.test(old[p - 1])) p--;
    if (s > 0 && /[\uDC00-\uDFFF]/.test(old[old.length - s])) s--;
    // never split a glyph that stands for several letters (a ligature)
    if (p > 0) { const c = ph.chars[p - 1]; if (c.g !== null && c.ge > p) p = c.gs; }
    let q = old.length - s;
    if (q < old.length) { const c = ph.chars[q]; if (c.g !== null && c.gs < q) { q = c.ge; s = old.length - q; } }
    if (p + s > Math.min(old.length, text.length)) s = Math.min(old.length, text.length) - p;
    q = old.length - s;

    // 2. the glyph whose style new letters take, and whether they go before it in the file or
    // after it: either way they sit in the file where they sit on the page, so text copied out
    // of the PDF reads in the right order
    const near = (from, step) => { for (let i = from; i >= 0 && i < ph.chars.length; i += step) if (ph.chars[i].g !== null) return ph.chars[i].g; return null; };
    const inMid = (id, a, b) => { for (let i = a; i < b; i++) if (ph.chars[i].g === id) return true; return false; };
    function refFor(a, b) {
      let id = a < b ? near(a, 1) : null, bef = true;
      if (id === null || (b > a && !inMid(id, a, b))) { id = a > 0 ? near(a - 1, -1) : null; bef = false; }
      if (id === null) { id = near(b, 1); bef = true; }
      if (id === null) { id = ph.glyphs[0]; bef = true; }
      return { id, bef };
    }
    // the characters this phrase already draws in a font, by code: reused exactly
    const seenFor = fontId => {
      const m = new Map();
      for (const id of ph.glyphs) { const g = glyphs[id]; if (an.ops[g.op].font === fontId) { const t = uniText(g.uni); if (t.length === 1 && !m.has(t)) m.set(t, g.code); } }
      return m;
    };
    // A word is drawn in one font. If the PDF's font lacks a letter of a word being typed, the
    // whole word comes from the matching bundled font, not just that letter: patched letter by
    // letter it looked odd, and read back out of the file in pieces.
    {
      const r0 = glyphs[refFor(p, q).id], f0 = an.fontOf(an.ops[r0.op].font), seen0 = seenFor(an.ops[r0.op].font);
      const lacks = ch => !/\s/.test(ch) && !encodeOrig(f0, ch.codePointAt(0), seen0);
      if ([...text.slice(p, text.length - s)].some(lacks)) {
        while (p > 0 && !/\s/.test(old[p - 1])) p--;
        while (s > 0 && !/\s/.test(old[old.length - s])) s--;
        q = old.length - s;
      }
    }
    const mid = text.slice(p, text.length - s);
    const { id: refId, bef: before } = refFor(p, q);
    const ref = glyphs[refId], rop = an.ops[ref.op], rfont = an.fontOf(rop.font);

    // the glyphs that go
    const gone = new Set();
    const addGone = id => { gone.add(id); for (const sh of (glyphs[id].shadows || [])) gone.add(sh); };
    for (let i = p; i < q; i++) if (ph.chars[i].g !== null) addGone(ph.chars[i].g);
    if (!text.length) for (const id of ph.all) gone.add(id);

    // 3. where the new letters start, and how much room the old ones took
    const x0 = p < q ? ph.chars[p].u0 : p > 0 ? ph.chars[p - 1].u1 : ph.chars.length ? ph.chars[0].u0 : ph.u0;
    const oldEnd = q < old.length ? ph.chars[q].u0 : (p < q ? ph.chars[old.length - 1].u1 : x0);

    // 4. lay out the new letters in the reference glyph's style. Letter spacing is the one that
    // prevails among the letters being replaced, not the reference glyph's own: Word, for one,
    // kerns a pair like "TA" by giving just those two letters their own tight spacing, and every
    // new letter squeezed up like that made the word visibly short.
    const tcOf = ids => {
      const count = new Map();
      for (const id of ids) { const v = an.ops[glyphs[id].op].Tc; count.set(v, (count.get(v) || 0) + 1); }
      let best = rop.Tc, n = 0; for (const [v, c] of count) if (c > n) { best = v; n = c; }
      return best;
    };
    const st = { Tc: tcOf(gone.size ? [...gone] : [refId]), Tw: rop.Tw };
    const Tfs = rop.size, Th = rop.Th, kr = ref.kx;
    const toDisp = t => t * kr;                                  // text-space length -> display points
    const seen = seenFor(rop.font);
    const pieces = []; let piece = null;
    const push = (kind, key, item) => {
      if (!piece || piece.kind !== kind || piece.key !== key) { piece = { kind, key, items: [] }; pieces.push(piece); }
      piece.items.push(item);
    };
    const spaceNat = encodeOrig(rfont, 32, seen);
    const spaceWant = ph.spaceAdv > 0 ? ph.spaceAdv : spaceNat ? toDisp((spaceNat.w0 * Tfs + st.Tc + (spaceNat.space ? st.Tw : 0)) * Th) : 0.25 * ref.size;
    // Word gaps in the new wording: which gap comes before each character, and how many there
    // are. A gap is a run of spaces with words on both sides.
    const gapsBefore = new Array(text.length).fill(0);
    let G = 0;
    { let word = false, inGap = false;
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text[i])) { if (word) inGap = true; }
        else { if (inGap) { G++; inGap = false; } word = true; }
        gapsBefore[i] = G;
      } }
    // does the run of spaces starting at i sit between two words?
    const countedGap = i => /\S/.test(text.slice(0, i)) && text.slice(i).search(/\S/) > 0;
    let x = 0, cut = 0;                                          // text-space offset from the start of the new letters
    let midChars = [];
    // a space is as wide as the line's own spaces, measured, so justified text stays even (less
    // `cut` on a justified line, below)
    const putSpace = gap => {
      const want = spaceWant / kr - (gap ? cut / kr : 0);
      if (spaceNat) {
        const nat = (spaceNat.w0 * Tfs + st.Tc + (spaceNat.space ? st.Tw : 0)) * Th;
        push('orig', '', { bytes: spaceNat.bytes, ch: ' ', x, tx: nat });
        if (Math.abs(want - nat) > 1e-6) push('orig', '', { move: want - nat });
      } else push('orig', '', { move: want });
      x += want;
    };
    // a letter in the PDF's own font, where the word can be written in it
    const putOwn = (ch, enc) => {
      const tx = (enc.w0 * Tfs + st.Tc + (enc.space ? st.Tw : 0)) * Th;
      push('orig', '', { bytes: enc.bytes, code: enc.code, ch, x, tx });
      x += tx;
    };
    // otherwise the bundled font of the same measurements, or failing that plain sans
    const putBundled = (ch, cp) => {
      let key = KamFonts.fallbackKey(rfont), b = KamFonts.bundledNow(key), gl = b && KamFonts.glyphFor(b.fk, cp);
      if (b && !gl) { key = KamFonts.lastResortKey(rfont); b = KamFonts.bundledNow(key); gl = b && KamFonts.glyphFor(b.fk, cp); }
      if (!b) { need(key); const tx = 0.5 * Tfs * Th; push('fb', key, { ch, x, tx, pending: true }); x += tx; }
      else if (!gl) res.missing.push(ch);                         // takes no room; the caret still steps over it
      else {
        const tx = (gl.advanceWidth / b.fk.unitsPerEm * Tfs + st.Tc) * Th;
        push('fb', key, { ch, x, tx, fk: b.fk, glyph: gl });
        x += tx;
      }
    };
    const layMid = () => {
      pieces.length = 0; piece = null; x = 0; midChars = [];
      let at = p;                                                // index in the new wording
      for (const word of mid.match(/\s+|\S+/g) || []) {
        const encs = /^\s/.test(word) ? null : [...word].map(ch => encodeOrig(rfont, ch.codePointAt(0), seen));
        const own = encs && encs.every(Boolean);
        let k = 0, first = true;
        for (const ch of word) {
          const a = x;
          if (!encs) { putSpace(first && countedGap(at)); first = false; }
          else if (own) putOwn(ch, encs[k]);
          else putBundled(ch, ch.codePointAt(0));
          k++; at += ch.length;
          for (let n = 0; n < ch.length; n++) midChars.push([a, x]);
        }
      }
    };
    layMid();

    // 5. where everything goes. The new letters take their width where the old ones took
    // oldEnd - x0, and the difference is made up the way the line is aligned: a left-aligned
    // line's rest moves along; a right-aligned line's beginning moves back; a centred line does
    // half of each; a justified line's word gaps, all of them, take up the difference so that it
    // still reaches both margins (within reason: gaps are not squeezed shut or pulled wide open).
    const grow0 = x0 + toDisp(x) - oldEnd;
    const align = Math.abs(grow0) > 1e-3 ? (opt && opt.align) || ph.align || 'left' : 'left';
    let per = 0;                                                 // taken off each word gap, justified lines
    if (align === 'justify' && G > 0) { per = Math.max(-2 * spaceWant, Math.min(0.6 * spaceWant, grow0 / G)); cut = per; if (per) layMid(); }
    const dn = text.length - old.length;                         // old index + dn = new index, after the change
    const preMove = i => (align === 'right' ? -grow0 : align === 'center' ? -grow0 / 2 : -per * gapsBefore[i]);
    const sufMove = i => (align === 'right' ? 0 : align === 'center' ? grow0 / 2 : grow0 - per * (gapsBefore[i + dn] || 0));
    const sMid = p < text.length ? preMove(p) : align === 'right' ? -grow0 : align === 'center' ? -grow0 / 2 : -per * G;
    res.du = q < old.length ? sufMove(q) : 0;
    const moveOf = new Map();                                    // glyph -> how far it moves, in display points
    const moveGlyph = (id, m) => { if (Math.abs(m) > 1e-3) for (const g of [id, ...(glyphs[id].shadows || [])]) moveOf.set(g, m); };
    for (let i = 0; i < p; i++) { const id = ph.chars[i].g; if (id !== null && !gone.has(id)) moveGlyph(id, preMove(i)); }
    for (let i = q; i < old.length; i++) { const id = ph.chars[i].g; if (id !== null && !gone.has(id)) moveGlyph(id, sufMove(i)); }
    for (const [id, m] of moveOf) { const g = glyphs[id]; res.shift.set(id, m / g.kx * (g.dir[0] * ph.dir[0] + g.dir[1] * ph.dir[1] < 0 ? -1 : 1) * (g.tx < 0 ? -1 : 1)); }
    res.removed = gone;
    const tStart = (x0 + sMid - ref.u0) / kr;                    // where the new letters start, along the reference glyph's line
    const Tm0 = mul(tr(tStart * (ref.tx < 0 ? -1 : 1), 0), ref.Tm);

    // 6. positions of every character of the new wording, for the caret
    for (let i = 0; i < p; i++) { const m = preMove(i); res.chars.push([ph.chars[i].u0 + m, ph.chars[i].u1 + m]); }
    for (const [a, b] of midChars) res.chars.push([x0 + sMid + toDisp(a), x0 + sMid + toDisp(b)]);
    for (let i = q; i < old.length; i++) { const m = sufMove(i); res.chars.push([ph.chars[i].u0 + m, ph.chars[i].u1 + m]); }

    // 7. what to draw on screen: kept glyphs, moved glyphs, and the new ones
    const VT = an.VT;
    for (const id of ph.all) {
      if (gone.has(id)) continue;
      const g = glyphs[id], op = an.ops[g.op], font = an.fontOf(op.font);
      const d = moveOf.get(id) || 0;
      const df = drawFontFor(font); if (df.need) { need(df.need); continue; }
      let glyph = null;
      if (df.own && g.fontChar) glyph = KamFonts.glyphFor(df.fk, g.fontChar.codePointAt(0));
      if (!glyph) { const t = uniText(g.uni); if (t) glyph = KamFonts.glyphFor(df.fk, t.codePointAt(0)); }
      if (!glyph) continue;
      const E = mul(mul(mul([op.size * op.Th, 0, 0, op.size, 0, op.Ts], g.Tm), op.ctm), VT);
      res.draws.push({ fk: df.fk, glyph, E: d ? mul(E, tr(ph.dir[0] * d, ph.dir[1] * d)) : E, op });
    }
    const base = mul(mul(Tm0, rop.ctm), VT);
    for (const pc of pieces) for (const it of pc.items) {
      if (it.move !== undefined || it.pending) continue;
      let fk, glyph;
      if (pc.kind === 'fb') { fk = it.fk; glyph = it.glyph; }
      else {
        const df = drawFontFor(rfont); if (df.need) { need(df.need); continue; }
        fk = df.fk;
        if (df.own) { const fc = rfont.toFontChar && rfont.toFontChar[it.code]; if (fc !== undefined) glyph = KamFonts.glyphFor(fk, fc); }
        if (!glyph) glyph = KamFonts.glyphFor(fk, it.ch.codePointAt(0));
      }
      if (!glyph) continue;
      const E = mul([Tfs * Th, 0, 0, Tfs, 0, rop.Ts], mul(tr(it.x, 0), base));
      res.draws.push({ fk, glyph, E, op: rop });
    }

    // 7. what to write into the file, beside the reference glyph's text operation
    if (pieces.some(pc => pc.items.some(it => it.bytes || it.ch))) res.ins.push({ op: rop.id, at: { g: refId, before }, Tm: Tm0, pieces, st });

    // 8. the box around the result
    const us = res.chars.length ? res.chars.flatMap(c => c) : [ph.u0, ph.u1];
    const u0 = Math.min(...us, text.length ? Infinity : ph.u0), u1 = Math.max(...us, text.length ? -Infinity : ph.u0);
    res.u0 = isFinite(u0) ? u0 : ph.u0; res.u1 = isFinite(u1) ? u1 : ph.u0;
    res.box = boxOf(ph.dir, ph.perp, res.u0, Math.max(res.u1, res.u0 + 0.5), ph.top, ph.bot);
    res.ref = refId; res.text = text;
    return res;
  }
  // The same, once every font it needs has been loaded.
  async function layoutReady(an, ph, text) {
    await KamFonts.ready();
    for (let tries = 0; tries < 4; tries++) {
      const lay = layout(an, ph, text);
      if (!lay.needs.length) return lay;
      await Promise.all(lay.needs.map(k => KamFonts.bundled(k).catch(e => console.warn(e))));
    }
    return layout(an, ph, text);
  }
  // Layouts of the edits already made, for drawing and for finding them with the mouse.
  const layoutCache = new Map();
  let fontkitAsked = false;
  function layoutOf(an, ph, e) {
    const k = `${an.fp}|${ph.key}|${e.text}`;
    let lay = layoutCache.get(k);
    if (!lay || lay.needs.length || lay.early) {
      lay = layout(an, ph, e.text);
      if (!KamFonts.isReady()) {
        // measured before the font reader is here: good enough for a moment, redone once it is
        lay.early = true;
        if (!fontkitAsked) { fontkitAsked = true; KamFonts.ready().then(() => { layoutCache.clear(); drawOverlay(); }).catch(() => null); }
      }
      layoutCache.set(k, lay);
      if (lay.needs.length) Promise.all(lay.needs.map(key => KamFonts.bundled(key).catch(() => null))).then(() => { layoutCache.delete(k); drawOverlay(); });
      while (layoutCache.size > 200) layoutCache.delete(layoutCache.keys().next().value);
    }
    return lay;
  }
  // A new edit mark for a phrase: what it replaces (so it can find it again, and say so in the
  // Layers list) and the new wording.
  function newEdit(an, ph, text) {
    return { id: uid(), type: 'textedit', text, src: { key: ph.key, glyphs: ph.gkeys.slice(), text: ph.text, fp: an.fp }, x: 0, y: 0, w: 0, h: 0, rot: 0, opacity: 1 };
  }
  const boxFields = b => ({ x: b.x, y: b.y, w: b.w, h: b.h, rot: b.rot });

  /* ---------- paragraphs: lines that belong together, so an edit flows from one into the next ----------
     A paragraph is a run of lines in one column with the same text frame (font size, scale and
     slant, in the same content stream), a steady line spacing, and a common left edge (the first
     line may be indented), right edge or centre. Lines that end early are where paragraphs end:
     if the next line's first word would have fitted on a line, it was broken on purpose. And a
     column of short lines (amounts, names, an address) is not a paragraph: every line but the
     last holds at least four words, and the column is at least fifteen letters wide. */
  const SPC = /\s/;
  const hiS = c => c >= 0xD800 && c <= 0xDBFF, loS = c => c >= 0xDC00 && c <= 0xDFFF;
  const wordCount = t => (t.trim().match(/\S+/g) || []).length;
  function inkStart(ph) { for (let i = 0; i < ph.text.length; i++) if (!SPC.test(ph.text[i])) return i; return -1; }
  // Text inserted at any point of a line can be placed from any of its glyphs only if they
  // share one frame: the same stream, transformation, text scale and size.
  function frameOf(an, ph) {
    const r = v => Math.round(v * 1000) / 1000;
    let key = null;
    for (const id of ph.glyphs) {
      const g = an.glyphs[id], op = an.ops[g.op];
      const k = [op.c, op.ctm.map(r).join(' '), g.Tm.slice(0, 4).map(r).join(' '), r(Math.abs(op.size)), r(op.Th)].join('|');
      if (key === null) key = k; else if (k !== key) return null;
    }
    return key;
  }
  // The width of a space in the paragraph's most used style, without word spacing (which is
  // how justified lines are stretched).
  function naturalSpace(an, lines) {
    const n = new Map();
    for (const ph of lines) for (const id of ph.glyphs) { const o = an.glyphs[id].op; n.set(o, (n.get(o) || 0) + 1); }
    let best = -1, c = 0; for (const [o, k] of n) if (k > c) { best = o; c = k; }
    if (best >= 0) {
      const op = an.ops[best], e = encodeOrig(an.fontOf(op.font), 32), g = an.glyphs[op.glyphs[0]];
      if (e && g) return Math.max(0.05 * lines[0].size, (e.w0 * Math.abs(op.size) + op.Tc) * op.Th * g.kx);
    }
    const sp = lines.map(p => p.spaceAdv).filter(v => v > 0).sort((a, b) => a - b);
    return sp.length ? sp[0] : 0.28 * lines[0].size;
  }
  // characters a paragraph already draws in a font, by code: new letters reuse them exactly
  function seenOf(an, lines) {
    const memo = new Map();
    return fontId => {
      let m = memo.get(fontId); if (m) return m;
      m = new Map();
      for (const ph of lines) for (const id of ph.glyphs) { const g = an.glyphs[id]; if (an.ops[g.op].font === fontId) { const t = uniText(g.uni); if (t.length === 1 && !m.has(t)) m.set(t, g.code); } }
      memo.set(fontId, m);
      return m;
    };
  }
  function finishPara(an, P) {
    const ls = P.lines, n = ls.length;
    P.size = ls[0].size; P.dir = ls[0].dir; P.perp = ls[0].perp; P.angle = ls[0].angle;
    P.spaceW = naturalSpace(an, ls);
    P.seen = seenOf(an, ls);
    P.origText = ls.map(l => l.text).join(' ');
    if (!(P.step > 0)) P.step = n > 1 ? (ls[0].v - ls[n - 1].v) / (n - 1) : 1.2 * P.size;
    if (P.Lc === undefined) P.Lc = n > 1 ? ls[1].left : ls[0].left;
    if (P.Lmin === undefined) P.Lmin = Math.min(...ls.map(l => l.left));
    if (P.axis === undefined) P.axis = ls.reduce((a, l) => a + (l.s + l.e) / 2, 0) / n;
    if (!P.kind) P.kind = P.align === 'right' ? 'right' : P.align === 'center' ? 'center' : 'left';
    return P;
  }
  function paragraphs(an, list) {
    an.paras = []; an.paraOf = new Map();
    const lines = [], isLine = new Set();
    for (const p of list) {
      const f = inkStart(p); if (f < 0) continue;
      p.left = p.chars[f].u0;
      if (!p.editable) continue;
      p.frame = frameOf(an, p); if (!p.frame) continue;
      let e = f; while (e < p.text.length && !SPC.test(p.text[e])) e++;
      p.firstW = p.chars[e - 1].u1 - p.chars[f].u0;
      p.nWords = wordCount(p.text);
      lines.push(p); isLine.add(p);
    }
    // the next line down in the same column, whatever it is
    const below = new Map();
    for (const p of lines) {
      let best = null;
      for (const q of list) {
        if (q === p || Math.abs(q.angle - p.angle) > 0.5 || q.v > p.v - 0.5 * p.size || q.e <= p.s || q.s >= p.e) continue;
        if (!best || q.v > best.v) best = q;
      }
      if (best) below.set(p, best);
    }
    const used = new Set();
    for (const p of lines.slice().sort((a, b) => b.v - a.v || a.left - b.left)) {
      if (used.has(p)) continue;
      used.add(p);
      const chain = [p], size = p.size, tol = 0.6 + 0.04 * size;
      let kind = null, step = 0, Lc = 0;
      for (let cur = p; ;) {
        const q = below.get(cur);
        if (!q || used.has(q) || !isLine.has(q) || q.frame !== p.frame) break;
        const st = cur.v - q.v;
        if (st < 0.95 * size || st > 1.9 * size || (chain.length > 1 && Math.abs(st - step) > 0.12 * size)) break;
        const dl = q.left - cur.left, de = q.e - cur.e, dc = (q.s + q.e) / 2 - (cur.s + cur.e) / 2;
        if (chain.length === 1) {
          if (Math.abs(dl) <= tol) kind = 'left';
          else if (Math.abs(de) <= tol) kind = 'right';
          else if (Math.abs(dc) <= tol) kind = 'center';
          else if (Math.abs(dl) <= 8 * size) kind = 'left';        // the first line indented, or hanging
          else break;
          step = st; Lc = q.left;
        } else {
          if (kind === 'left' && Math.abs(q.left - Lc) > tol) break;
          if (kind === 'right' && Math.abs(de) > tol) break;
          if (kind === 'center' && Math.abs(dc) > tol) break;
          step = (step * (chain.length - 1) + st) / chain.length;
        }
        chain.push(q); used.add(q); cur = q;
      }
      if (chain.length < 2) continue;
      // the column's right edge: as far as any line of it reaches, nearby
      let R = Math.max(...chain.map(l => l.e));
      if (kind === 'left') {
        const top = chain[0].v + 30 * size, bot = chain[chain.length - 1].v - 30 * size;
        for (const q of lines) if (q.frame === p.frame && q.left >= Lc - tol && q.left <= Lc + 8 * size && q.v <= top && q.v >= bot) R = Math.max(R, q.e);
      }
      const sp = naturalSpace(an, chain), slack = Math.max(1, 0.25 * size), widest = Math.max(...chain.map(l => l.e - l.left));
      const endedEarly = i => {
        const l = chain[i], nx = chain[i + 1];
        return kind === 'left' ? l.e + sp + nx.firstW <= R - slack : (l.e - l.left) + sp + nx.firstW <= widest - slack;
      };
      let a = 0;
      const emit = b => {
        const ls = chain.slice(a, b); a = b;
        if (ls.length < 2 || ls.slice(0, -1).some(l => l.nWords < 4)) return;
        const width = kind === 'left' ? R - Math.min(...ls.map(l => l.left)) : Math.max(...ls.map(l => l.e - l.left));
        if (width < 15 * size) return;
        // Justified: every full line ends at the same place, and their word gaps are stretched
        // to get there. (Two lines of ragged text can end together by chance.) Its full lines
        // then mark the margin exactly.
        const full = ls.slice(0, -1), ends = full.map(l => l.e);
        const justified = kind === 'left' && Math.max(...ends) - Math.min(...ends) <= tol && full.some(l => l.spaceAdv > 1.12 * sp);
        const P = finishPara(an, {
          lines: ls, kind, step, R: justified ? Math.max(...ends) : kind === 'left' ? R : Math.max(...ls.map(l => l.e)),
          align: justified ? 'justify' : kind,
        });
        an.paras.push(P);
        for (const l of ls) an.paraOf.set(l.key, P);
      };
      for (let i = 0; i + 1 < chain.length; i++) if (endedEarly(i)) emit(i + 1);
      emit(chain.length);
    }
  }
  // Is there room for a line of the paragraph at baseline v: no letter of anything else there,
  // and inside the page?
  function roomFor(an, P, v) {
    const asc = Math.max(...P.lines.map(l => l.top - l.v)), desc = Math.max(...P.lines.map(l => l.v - l.bot));
    const lo = v - desc, hi = v + asc, u0 = P.Lmin, u1 = P.R, d = P.dir, pp = P.perp;
    const mine = new Set(P.lines.flatMap(l => l.all));
    for (const g of an.glyphs) {
      if (!g.visible || mine.has(g.id)) continue;
      let gu0 = g.u0, gu1 = g.u1, gb = g.bot, gt = g.top;
      if (Math.abs(g.angle - P.angle) > 1) {                  // turned another way: its middle, in this frame
        const gp = [g.dir[1], -g.dir[0]], cu = (g.u0 + g.u1) / 2, cv = (g.top + g.bot) / 2;
        const X = g.dir[0] * cu + gp[0] * cv, Y = g.dir[1] * cu + gp[1] * cv;
        gu0 = gu1 = X * d[0] + Y * d[1]; gb = gt = X * pp[0] + Y * pp[1];
      }
      if (gt <= lo || gb >= hi || gu1 <= u0 || gu0 >= u1) continue;
      return false;
    }
    const m = 0.5 * P.size;
    for (const u of [u0, u1]) for (const w of [lo, hi]) {
      const x = d[0] * u + pp[0] * w, y = d[1] * u + pp[1] * w;
      if (x < m || y < m || x > an.pageW - m || y > an.pageH - m) return false;
    }
    return true;
  }
  // The width of a new letter in the style it takes, in the PDF's font or the bundled one.
  function freshAdvance(an, P, it, cp, need) {
    const sg = an.glyphs[it.style], op = an.ops[sg.op], font = an.fontOf(op.font), Tfs = op.size;
    if (!it.fb) {
      const e = encodeOrig(font, cp, P.seen(op.font));
      if (e) return { w: Math.abs((e.w0 * Tfs + op.Tc + (e.space ? op.Tw : 0)) * op.Th) * sg.kx, enc: e };
    }
    let key = KamFonts.fallbackKey(font), b = KamFonts.bundledNow(key), gl = b && KamFonts.glyphFor(b.fk, cp);
    if (b && !gl) { key = KamFonts.lastResortKey(font); b = KamFonts.bundledNow(key); gl = b && KamFonts.glyphFor(b.fk, cp); }
    if (!b) { need(key); return { w: 0.5 * sg.size, pending: true }; }
    if (!gl) return { w: 0, missing: true };
    return { w: Math.abs((gl.advanceWidth / b.fk.unitsPerEm * Tfs + op.Tc) * op.Th) * sg.kx, fb: { key, fk: b.fk, glyph: gl } };
  }

  /* What a paragraph looks like with its wording changed to `text`: the words are set again
     from the first line that changed, filling each line to the column's edge and pulling words
     up from the next line when there is room; once a line ends where it used to, the rest stays
     as it was. Words that move keep their own glyphs, font, colour and letter spacing. If the
     paragraph needs another line it goes below, where that space is empty of other text; if it
     is not, the end runs past the margin and `overflow` says so. */
  function layoutPara(an, P, text) {
    const G = an.glyphs, lines = P.lines, n = lines.length;
    text = String(text).replace(/[\r\n]+/g, ' ');
    const res = { para: P, text, slots: [], stops: [], needs: [], missing: [], overflow: false, box: null };
    const need = k => { if (!res.needs.includes(k)) res.needs.push(k); };
    // 1. the paragraph as it was: each character, with the line and glyph it comes from
    const O = [], lineAt = [];
    lines.forEach((ph, li) => {
      if (li > 0) O.push({ ch: ' ', g: null, line: -1, ci: -1, brk: li });
      lineAt[li] = O.length;
      for (let ci = 0; ci < ph.text.length; ci++) O.push({ ch: ph.text[ci], g: ph.chars[ci].g, line: li, ci });
    });
    // 2. what changed. Word by word (the longest run of words the two have in common, in
    // order), then letter by letter inside each stretch that changed: two edits far apart in a
    // paragraph are two small changes, and every word between them stays exactly as it was,
    // with its own glyphs, font and place in the file.
    const otext = O.map(o => o.ch).join('');
    O.forEach((o, k) => { o.oi = k; });
    const tokenize = t => { const out = []; const re = /\s+|\S+/g; let m; while ((m = re.exec(t))) out.push({ t: m[0], a: m.index, b: m.index + m[0].length }); return out; };
    const tO = tokenize(otext), tN = tokenize(text);
    let h = 0; while (h < tO.length && h < tN.length && tO[h].t === tN[h].t) h++;
    let e = 0; while (e < tO.length - h && e < tN.length - h && tO[tO.length - 1 - e].t === tN[tN.length - 1 - e].t) e++;
    const mO = tO.length - h - e, mN = tN.length - h - e;
    const regions = [];                                       // [O from, O to, text from, text to], in characters
    const region = (i0, i1, j0, j1) => {
      const oa = i0 < tO.length ? tO[i0].a : O.length, ob = i1 > i0 ? tO[i1 - 1].b : oa;
      const na = j0 < tN.length ? tN[j0].a : text.length, nb = j1 > j0 ? tN[j1 - 1].b : na;
      if (ob > oa || nb > na) regions.push([oa, ob, na, nb]);
    };
    if (mO * mN > 2e6) region(h, h + mO, h, h + mN);         // an enormous change: one stretch
    else {
      const L = []; for (let i = 0; i <= mO; i++) L.push(new Uint16Array(mN + 1));
      for (let i = mO - 1; i >= 0; i--) for (let j = mN - 1; j >= 0; j--)
        L[i][j] = tO[h + i].t === tN[h + j].t ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      let i = 0, j = 0;
      while (i < mO || j < mN) {
        if (i < mO && j < mN && tO[h + i].t === tN[h + j].t && L[i][j] === L[i + 1][j + 1] + 1) { i++; j++; continue; }
        const i0 = i, j0 = j;
        while ((i < mO || j < mN) && !(i < mO && j < mN && tO[h + i].t === tN[h + j].t && L[i][j] === L[i + 1][j + 1] + 1)) {
          if (j < mN && (i >= mO || L[i][j + 1] >= L[i + 1][j])) j++; else i++;
        }
        region(h + i0, h + i, h + j0, h + j);
      }
    }
    const tied = (a, b) => !!a && !!b && a.g !== null && a.g === b.g;
    const C = []; let at = 0, firstO = -1, lastO = -1;
    for (const [oa0, ob0, na0, nb0] of regions) {
      let oa = oa0, ob = ob0, na = na0, nb = nb0;
      // the common beginning and end of the stretch stay, but never half a ligature or of a
      // pair of surrogates
      let p = 0; while (oa + p < ob && na + p < nb && O[oa + p].ch === text[na + p]) p++;
      let q = 0; while (q < ob - oa - p && q < nb - na - p && O[ob - 1 - q].ch === text[nb - 1 - q]) q++;
      while (p > 0 && oa + p < O.length && tied(O[oa + p - 1], O[oa + p])) p--;
      while (q > 0 && ob - q - 1 >= 0 && tied(O[ob - q - 1], O[ob - q])) q--;
      if (p > 0 && hiS(text.charCodeAt(na + p - 1))) p--;
      if (q > 0 && loS(text.charCodeAt(nb - q))) q--;
      for (let k = at; k < oa + p; k++) C.push(O[k]);
      for (let k = na + p; k < nb - q; k++) C.push({ ch: text[k], g: null, line: -1, ci: -1, fresh: true });
      at = ob - q;
      if (oa + p < ob - q || na + p < nb - q) { if (firstO < 0) firstO = oa + p; lastO = ob - q; }
    }
    for (let k = at; k < O.length; k++) C.push(O[k]);
    const changed = firstO >= 0;
    // new letters take the style of the letter before them (or, at the very start, after)
    for (let k = 0; k < C.length; k++) {
      const c = C[k]; if (!c.fresh) continue;
      let st = null, after = true;
      for (let i = k - 1; i >= 0 && st === null; i--) if (!C[i].fresh && C[i].g !== null && !SPC.test(C[i].ch)) st = C[i].g;
      if (st === null) { after = false; for (let i = k + 1; i < C.length && st === null; i++) if (!C[i].fresh && C[i].g !== null && !SPC.test(C[i].ch)) st = C[i].g; }
      c.style = st === null ? lines[0].glyphs[0] : st; c.after = after;
    }
    // a word that needs a letter its font does not have is set wholly in the matching bundled
    // font, its old letters too: patched letter by letter it looked odd
    for (let i = 0; i < C.length;) {
      if (SPC.test(C[i].ch)) { i++; continue; }
      let j = i; while (j < C.length && !SPC.test(C[j].ch)) j++;
      let lacks = false;
      for (let k = i; k < j && !lacks; k++) {
        const c = C[k]; if (!c.fresh || loS(text.charCodeAt(k))) continue;
        const op = an.ops[G[c.style].op];
        if (!encodeOrig(an.fontOf(op.font), text.codePointAt(k), P.seen(op.font))) lacks = true;
      }
      if (lacks) for (let k = i; k < j; k++) {
        const c = C[k];
        C[k] = { ch: c.ch, g: null, line: -1, ci: -1, style: c.fresh ? c.style : c.g, after: c.fresh ? c.after : false, fresh: true, fb: true };
      }
      i = j;
    }
    // 3. the words, and how wide each is: letters still in a run of their old line keep their
    // old spacing (kerning included), new letters are measured
    const toks = [], offs = new Array(C.length);
    for (let i = 0; i < C.length;) { if (SPC.test(C[i].ch)) { i++; continue; } let j = i; while (j < C.length && !SPC.test(C[j].ch)) j++; toks.push({ a: i, b: j }); i = j; }
    for (const t of toks) {
      let x = 0;
      for (let i = t.a; i < t.b;) {
        const c = C[i];
        if (!c.fresh) {
          const ph = lines[c.line]; let j = i;
          while (j + 1 < t.b && !C[j + 1].fresh && C[j + 1].line === c.line && C[j + 1].ci === C[j].ci + 1) j++;
          const base = ph.chars[c.ci].u0;
          for (let k = i; k <= j; k++) { const q = ph.chars[C[k].ci]; offs[k] = [x + q.u0 - base, x + q.u1 - base]; }
          x += ph.chars[C[j].ci].u1 - base; i = j + 1;
        } else {
          const cp = text.codePointAt(i), two = cp > 0xffff;
          const m = freshAdvance(an, P, c, cp, need);
          if (m.missing) res.missing.push(String.fromCodePoint(cp));
          c.m = m; offs[i] = [x, x + m.w];
          if (two && i + 1 < t.b) offs[i + 1] = [x + m.w, x + m.w];
          x += m.w; i += two ? 2 : 1;
        }
      }
      t.w = x;
      const c0 = C[t.a], c1 = C[t.b - 1];
      t.line = !c0.fresh && !c1.fresh && c0.line === c1.line && t.b - t.a === c1.ci - c0.ci + 1 ? c0.line : -1;
    }
    const gapN = (t, u) => Math.max(1, toks[u].a - toks[t].b);
    const origCount = lines.map(ph => wordCount(ph.text));
    // the line's own words, exactly as they were, with nothing new between them?
    const same = (list, j) => {
      if (j >= n || list.length !== origCount[j] || !list.length) return false;
      for (const ti of list) if (toks[ti].line !== j) return false;
      for (let i = toks[list[0]].a; i < toks[list[list.length - 1]].b; i++) if (C[i].fresh || C[i].line !== j) return false;
      return true;
    };
    // 4. which words go on which line
    const k0 = !changed ? n : firstO >= O.length ? n - 1 : O[firstO].line >= 0 ? O[firstO].line : O[firstO].brk - 1;
    const left = j => (j < n ? lines[j].left : P.Lc);
    const avail = j => (P.kind === 'left' ? P.R - left(j) : P.R - P.Lmin);
    const assign = gapF => {
      const slots = []; let t = 0;
      for (let j = 0; j < Math.min(k0, n); j++) {
        const list = []; while (t < toks.length && toks[t].line === j && C[toks[t].b - 1].oi < firstO) list.push(t++);
        slots.push(list);
      }
      // the line above the change takes words from below, if the first word of the next line
      // changed: an unchanged one did not fit there before
      if (k0 > 0 && k0 < n) {
        const firstEnd = lineAt[k0] + ((lines[k0].text.match(/^\s*\S+/) || [''])[0]).length;
        if (firstO <= firstEnd) {
          const j = k0 - 1, list = slots[j];
          let end = list.length ? lines[j].e : left(j);
          while (t < toks.length) {
            const w = toks[t].w + (list.length ? gapF * P.spaceW * gapN(list[list.length - 1], t) : 0);
            if (end + w > left(j) + avail(j) + 0.5) break;
            list.push(t++); end += w;
          }
        }
      }
      let j = Math.min(k0, n), overflow = false;
      for (; t < toks.length; j++) {
        if (j >= n && !roomFor(an, P, lines[n - 1].v - (j - n + 1) * P.step)) { overflow = true; break; }
        const list = []; let w = 0;
        while (t < toks.length) {
          if (j < n && same(list, j)) break;                      // the line as it was: its break stands
          const tw = toks[t].w + (list.length ? gapF * P.spaceW * gapN(list[list.length - 1], t) : 0);
          if (list.length && w + tw > avail(j) + 0.5) break;
          list.push(t++); w += tw;
        }
        slots.push(list);
        // from the start of the next line on, everything is as it was: those lines stay
        const c0 = t < toks.length ? C[toks[t].a] : null;
        if (j + 1 < n && c0 && toks[t].line === j + 1 && c0.oi >= lastO && c0.ci === inkStart(lines[j + 1])) {
          for (let k = j + 1; k < n; k++) { const l = []; for (let c = 0; c < origCount[k]; c++) l.push(t++); slots.push(l); }
          j = n; break;
        }
      }
      for (; j < n; j++) slots.push([]);                          // lines left with nothing
      return { slots, t, overflow };
    };
    let A = assign(1);
    if (A.overflow) { const B = assign(0.8); if (!B.overflow) A = B; }
    if (A.overflow) { res.overflow = true; const last = A.slots[A.slots.length - 1]; while (A.t < toks.length) last.push(A.t++); }
    // 5. each line laid out: as it was, edited within itself (the one-line layout), or set anew
    const fromLines = list => { const f = new Set(); for (const ti of list) for (let i = toks[ti].a; i < toks[ti].b; i++) if (!C[i].fresh) f.add(C[i].line); return f; };
    const home = new Map();
    A.slots.forEach((list, j) => { for (const l of fromLines(list)) { let h = home.get(l); if (!h) home.set(l, h = new Set()); h.add(j); } });
    const inLine = (list, j) => { for (const l of fromLines(list)) if (l !== j) return false; const h = home.get(j); return !h || (h.size === 1 && h.has(j)); };
    const lastFull = A.slots.map(l => l.length > 0).lastIndexOf(true);
    const lastLine = lines[n - 1];
    A.slots.forEach((list, j) => {
      const virtual = j >= n, ph = virtual ? null : lines[j];
      const v = virtual ? lastLine.v - (j - n + 1) * P.step : ph.v;
      const sl = {
        j, ph, virtual, v, top: virtual ? v + (lastLine.top - lastLine.v) : ph.top, bot: virtual ? v + (lastLine.bot - lastLine.v) : ph.bot,
        align: P.align === 'justify' ? (j === lastFull ? 'left' : 'justify') : P.align, left: left(j), toks: list,
        changed: false, inline: false, lay: null, text: '', range: [0, 0], box: null,
      };
      if (list.length) { sl.range = [toks[list[0]].a, toks[list[list.length - 1]].b]; sl.text = text.slice(sl.range[0], sl.range[1]); }
      const sameRole = P.align !== 'justify' || (j === lastFull) === (j === n - 1);
      if (!virtual && (same(list, j) || (!list.length && !ph.text.trim())) && sameRole) sl.lay = layoutOf(an, ph, { text: ph.text });
      else {
        // edited within itself: the one-line layout, unless it cannot keep the line inside the
        // margin (it only squeezes a justified line's gaps so far), then the line is set anew
        if (!virtual && inLine(list, j) && sameRole) {
          const lay = layout(an, ph, sl.text, { align: sl.align });
          if (P.kind !== 'left' || lay.u1 <= P.R + 0.75) { sl.lay = lay; sl.inline = true; }
        }
        if (!sl.lay) sl.lay = layoutSlot(an, P, C, offs, toks, sl, text, need);
        sl.changed = true;
      }
      for (const k of sl.lay.needs || []) need(k);
      for (const m of sl.lay.missing || []) res.missing.push(m);
      if (list.length || virtual) sl.box = sl.lay.box;
      if (virtual) sl.vph = { key: lastLine.key + '+' + (j - n + 1), text: sl.text, box: sl.box, editable: true, virtual: true,
        dir: P.dir, perp: P.perp, top: sl.top, bot: sl.bot, v, size: P.size, align: sl.align, glyphs: [], all: [], chars: [], gkeys: [] };
      res.slots.push(sl);
    });
    // 6. where every character is, for the caret
    const pos = new Array(text.length);
    for (const sl of res.slots) {
      if (!sl.toks.length) continue;
      const [a, b] = sl.range;
      if (sl.inline) { for (let k = 0; k < b - a; k++) { const c = sl.lay.chars[k]; if (c) pos[a + k] = { slot: sl.j, u0: c[0], u1: c[1] }; } }
      else if (!sl.changed) { for (let i = a; i < b; i++) { const c = C[i], q = c.ci >= 0 ? sl.ph.chars[c.ci] : null; if (q) pos[i] = { slot: sl.j, u0: q.u0, u1: q.u1 }; } }
      else for (let i = a; i < b; i++) { const q = sl.lay.pos.get(i); if (q) pos[i] = { slot: sl.j, u0: q[0], u1: q[1] }; }
    }
    const firstSlot = res.slots.find(sl => sl.toks.length) || res.slots[0];
    for (let i = 0; i < text.length; i++) if (!pos[i]) {
      const pv = i > 0 ? pos[i - 1] : null;
      pos[i] = pv ? { slot: pv.slot, u0: pv.u1, u1: pv.u1, brk: true } : { slot: firstSlot.j, u0: firstSlot.left, u1: firstSlot.left, brk: true };
    }
    for (let i = 0; i <= text.length; i++) {
      if (i === 0) { res.stops.push(text.length ? { slot: pos[0].slot, u: pos[0].u0 } : { slot: firstSlot.j, u: firstSlot.left }); continue; }
      const pv = pos[i - 1];
      res.stops.push(pv.brk && i < text.length && !pos[i].brk ? { slot: pos[i].slot, u: pos[i].u0 } : { slot: pv.slot, u: pv.u1 });
    }
    res.pos = pos;
    // 7. the box round all of it
    let u0 = Infinity, u1 = -Infinity, top = -Infinity, bot = Infinity;
    for (const sl of res.slots) {
      if (!sl.box) continue;
      u0 = Math.min(u0, sl.lay.u0); u1 = Math.max(u1, sl.lay.u1); top = Math.max(top, sl.top); bot = Math.min(bot, sl.bot);
    }
    if (!isFinite(u0)) { u0 = P.Lmin; u1 = P.Lmin + 1; top = lines[0].top; bot = lines[0].bot; }
    res.u0 = u0; res.u1 = u1;
    res.box = boxOf(P.dir, P.perp, u0, Math.max(u1, u0 + 0.5), top, bot);
    res.lays = res.slots.filter(sl => sl.changed).map(sl => sl.lay);
    res.ref = lines[0].glyphs[0];
    return res;
  }

  /* One line of a paragraph set anew: its own words that stay are kept and moved along, words
     from other lines are written here in their own style (each in its own text operation, so
     its font, colour and spacing come with it), and new letters take the style beside them. */
  function layoutSlot(an, P, C, offs, toks, sl, text, need) {
    const G = an.glyphs, VT = an.VT, d = P.dir, pp = P.perp, ph = sl.ph;
    const res = { ok: true, removed: new Set(), shift: new Map(), ins: [], draws: [], pos: new Map(), needs: [], missing: [], chars: [] };
    const list = sl.toks.map(ti => toks[ti]);
    // the gaps: a gap the line had between two of its own words keeps its width
    const gaps = [];
    for (let k = 0; k + 1 < list.length; k++) {
      const A = list[k], B = list[k + 1], last = C[A.b - 1], first = C[B.a];
      let orig = !!ph && !last.fresh && !first.fresh && last.line === sl.j && first.line === sl.j && first.ci === last.ci + (B.a - A.b) + 1;
      for (let i = A.b; i < B.a && orig; i++) if (C[i].fresh || C[i].line !== sl.j) orig = false;
      gaps.push({ w: orig ? ph.chars[first.ci].u0 - ph.chars[last.ci].u1 : Math.max(1, B.a - A.b) * P.spaceW, orig });
    }
    const wordsW = list.reduce((x, t) => x + t.w, 0);
    const avail = P.kind === 'left' ? P.R - sl.left : P.R - P.Lmin;
    let gapW;
    if (sl.align === 'justify' && gaps.length) {
      // every gap the same, reaching the margin; a line too loose for that is left ragged
      const each = (avail - wordsW) / gaps.length;
      gapW = each > 4 * P.spaceW ? (k => gaps[k].w) : (k => Math.max(each, 0.75 * P.spaceW));
    } else {
      const natural = wordsW + gaps.reduce((x, g) => x + g.w, 0);
      const per = natural > avail && gaps.length ? Math.max((avail - natural) / gaps.length, -0.25 * P.spaceW) : 0;
      gapW = k => gaps[k].w + per;
    }
    let W = wordsW; for (let k = 0; k < gaps.length; k++) W += gapW(k);
    let x = sl.align === 'right' ? P.R - W : sl.align === 'center' ? P.axis - W / 2 : sl.left;
    list.forEach((t, k) => {
      for (let i = t.a; i < t.b; i++) if (offs[i]) res.pos.set(i, [x + offs[i][0], x + offs[i][1]]);
      x += t.w;
      if (k + 1 < list.length) {
        const g = gapW(k), B = list[k + 1], nWs = B.a - t.b;
        for (let i = t.b; i < B.a; i++) res.pos.set(i, [x + g * (i - t.b) / nWs, x + g * (i - t.b + 1) / nWs]);
        x += g;
      }
    });
    // the line's own glyphs that stay, moved along; the rest of them go
    const moveOf = new Map();
    if (ph) {
      const keep = new Set();
      for (let i = sl.range[0]; i < sl.range[1]; i++) {
        const c = C[i]; if (c.fresh || c.g === null || c.line !== sl.j || keep.has(c.g)) continue;
        const q = res.pos.get(i); if (!q) continue;
        const du = q[0] - ph.chars[c.ci].u0;
        for (const id of [c.g, ...(G[c.g].shadows || [])]) { keep.add(id); if (Math.abs(du) > 1e-3) moveOf.set(id, du); }
      }
      for (const id of ph.all) if (!keep.has(id)) res.removed.add(id);
      for (const [id, du] of moveOf) { const g = G[id]; res.shift.set(id, du / g.kx * (g.dir[0] * d[0] + g.dir[1] * d[1] < 0 ? -1 : 1) * (g.tx < 0 ? -1 : 1)); }
    }
    // everything else on the line is written in, one run per text operation
    const runs = [];
    list.forEach((t, k) => {
      let run = null;
      for (let i = t.a; i < t.b; i++) {
        const c = C[i];
        if (ph && !c.fresh && c.g !== null && c.line === sl.j) { run = null; continue; }
        if (loS(text.charCodeAt(i)) && run) { run.items.push(i); continue; }
        const opId = G[c.fresh ? c.style : c.g].op;
        if (!run || run.op !== opId) { run = { op: opId, items: [], lead: i === t.a && k > 0 ? k : 0 }; runs.push(run); }
        run.items.push(i);
      }
    });
    for (const run of runs) {
      const op = an.ops[run.op], font = an.fontOf(op.font), Tfs = op.size, Th = op.Th, seen = P.seen(op.font);
      const moved = run.items.map(i => C[i]).find(c => !c.fresh);
      const c0 = C[run.items[0]];
      const anchor = moved ? moved.g : c0.style, before = moved ? true : !c0.after;
      const a = G[anchor], aop = an.ops[a.op];
      // a space in front, where the run starts a word after a gap, so the words read apart
      const spEnc = run.lead ? encodeOrig(font, 32, seen) : null;
      const startU = spEnc ? res.pos.get(list[run.lead - 1].b)[0] : res.pos.get(run.items[0])[0];
      const X = d[0] * startU + pp[0] * sl.v, Y = d[1] * startU + pp[1] * sl.v;
      const q = pt(inv(mul(mul(a.Tm, aop.ctm), VT)), X, Y);
      const Tm0 = mul(tr(q[0], q[1]), a.Tm);
      const kx = a.kx, adv = (w0, space) => (w0 * Tfs + op.Tc + (space ? op.Tw : 0)) * Th;
      const pieces = []; let piece = null, cur = 0;
      const push = (kind, key, item) => { if (!piece || piece.kind !== kind || piece.key !== key) { piece = { kind, key, items: [] }; pieces.push(piece); } piece.items.push(item); };
      const place = (kind, key, xt, item, tx) => { if (Math.abs(xt - cur) > 1e-6) push(kind, key, { move: xt - cur }); item.x = xt; item.tx = tx; push(kind, key, item); cur = xt + tx; };
      if (spEnc) place('orig', '', 0, { bytes: spEnc.bytes, ch: ' ', code: spEnc.code }, adv(spEnc.w0, spEnc.space));
      let lastG = null;
      for (const i of run.items) {
        const c = C[i]; if (loS(text.charCodeAt(i))) continue;
        const xt = (res.pos.get(i)[0] - startU) / kx;
        if (!c.fresh) {
          if (c.g === lastG) continue;                            // the second letter of a ligature
          lastG = c.g; const g = G[c.g];
          place('orig', '', xt, { bytes: g.bytes, ch: uniText(g.uni) || ' ', code: g.code, fontChar: g.fontChar }, adv(g.w0, g.space));
        } else {
          const m = c.m; if (!m || m.pending || m.missing) continue;
          const ch = String.fromCodePoint(text.codePointAt(i));
          if (m.fb) place('fb', m.fb.key, xt, { ch, fk: m.fb.fk, glyph: m.fb.glyph }, (m.fb.glyph.advanceWidth / m.fb.fk.unitsPerEm * Tfs + op.Tc) * Th);
          else place('orig', '', xt, { bytes: m.enc.bytes, code: m.enc.code, ch }, adv(m.enc.w0, m.enc.space));
        }
      }
      if (!pieces.some(pc => pc.items.some(it => it.bytes || it.ch))) continue;
      res.ins.push({ op: run.op, at: { g: anchor, before }, Tm: Tm0, pieces, st: { Tc: op.Tc, Tw: op.Tw } });
      const base = mul(mul(Tm0, op.ctm), VT);
      for (const pc of pieces) for (const it of pc.items) {
        if (it.move !== undefined || (it.ch === ' ' && pc.kind === 'orig')) continue;
        let fk, glyph = null;
        if (pc.kind === 'fb') { fk = it.fk; glyph = it.glyph; }
        else {
          const df = drawFontFor(font); if (df.need) { need(df.need); continue; }
          fk = df.fk;
          if (df.own) {
            if (it.fontChar) glyph = KamFonts.glyphFor(fk, it.fontChar.codePointAt(0));
            else if (it.code !== undefined && font.toFontChar && font.toFontChar[it.code] !== undefined) glyph = KamFonts.glyphFor(fk, font.toFontChar[it.code]);
          }
          if (!glyph && it.ch) glyph = KamFonts.glyphFor(fk, it.ch.codePointAt(0));
        }
        if (!glyph) continue;
        res.draws.push({ fk, glyph, E: mul([Tfs * Th, 0, 0, Tfs, 0, op.Ts], mul(tr(it.x, 0), base)), op });
      }
    }
    // the kept glyphs, on screen
    if (ph) for (const id of ph.all) {
      if (res.removed.has(id)) continue;
      const g = G[id], op = an.ops[g.op], font = an.fontOf(op.font), du = moveOf.get(id) || 0;
      const df = drawFontFor(font); if (df.need) { need(df.need); continue; }
      let glyph = null;
      if (df.own && g.fontChar) glyph = KamFonts.glyphFor(df.fk, g.fontChar.codePointAt(0));
      if (!glyph) { const t = uniText(g.uni); if (t) glyph = KamFonts.glyphFor(df.fk, t.codePointAt(0)); }
      if (!glyph) continue;
      const E = mul(mul(mul([op.size * op.Th, 0, 0, op.size, 0, op.Ts], g.Tm), op.ctm), VT);
      res.draws.push({ fk: df.fk, glyph, E: du ? mul(E, tr(d[0] * du, d[1] * du)) : E, op });
    }
    let u0 = Infinity, u1 = -Infinity;
    for (const [, q] of res.pos) { u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[1]); }
    if (!isFinite(u0)) u0 = u1 = sl.left;
    res.u0 = u0; res.u1 = u1;
    res.box = boxOf(d, pp, u0, Math.max(u1, u0 + 0.5), sl.top, sl.bot);
    res.ref = ph ? ph.glyphs[0] : P.lines[0].glyphs[0];
    res.text = sl.text;
    return res;
  }
  async function paraLayoutReady(an, P, text) {
    await KamFonts.ready();
    for (let tries = 0; tries < 4; tries++) {
      const r = layoutPara(an, P, text);
      if (!r.needs.length) return r;
      await Promise.all(r.needs.map(k => KamFonts.bundled(k).catch(e => console.warn(e))));
    }
    return layoutPara(an, P, text);
  }
  // The layout of a paragraph edit already made, for drawing and for finding it with the mouse.
  function paraLayoutOf(an, P, e) {
    const k = `${an.fp}|P|${P.lines[0].key}|${P.lines.length}|${e.text}`;
    let r = layoutCache.get(k);
    if (!r || r.needs.length || r.early) {
      r = layoutPara(an, P, e.text);
      if (!KamFonts.isReady()) {
        r.early = true;
        if (!fontkitAsked) { fontkitAsked = true; KamFonts.ready().then(() => { layoutCache.clear(); drawOverlay(); }).catch(() => null); }
      }
      layoutCache.set(k, r);
      if (r.needs.length) Promise.all(r.needs.map(key => KamFonts.bundled(key).catch(() => null))).then(() => { layoutCache.delete(k); drawOverlay(); });
      while (layoutCache.size > 200) layoutCache.delete(layoutCache.keys().next().value);
    }
    return r;
  }
  // The lines a paragraph edit is about, if they are all still on the page as they were.
  function paraOfEdit(an, e) {
    const sp = e && e.src && e.src.para;
    if (!sp || !an || !an.byKey || e.src.fp !== an.fp) return null;
    const phs = [];
    for (const l of sp.lines) {
      const ph = an.byKey.get(l.key);
      if (!ph || ph.gkeys.length !== l.glyphs.length) return null;
      for (let k = 0; k < l.glyphs.length; k++) if (ph.gkeys[k] !== l.glyphs[k]) return null;
      phs.push(ph);
    }
    const P0 = an.paraOf && an.paraOf.get(phs[0].key);
    if (P0 && P0.lines.length === phs.length && P0.lines.every((l, i) => l === phs[i])) return P0;
    return finishPara(an, { lines: phs, R: sp.R, step: sp.step, align: sp.align, kind: sp.kind, Lc: sp.Lc, Lmin: sp.Lmin, axis: sp.axis });
  }
  function newParaEdit(an, P, text) {
    const first = P.lines[0];
    return {
      id: uid(), type: 'textedit', text,
      src: { key: first.key, glyphs: first.gkeys.slice(), text: P.origText, fp: an.fp,
             para: { lines: P.lines.map(l => ({ key: l.key, glyphs: l.gkeys.slice() })), R: P.R, step: P.step, align: P.align, kind: P.kind, Lc: P.Lc, Lmin: P.Lmin, axis: P.axis } },
      x: 0, y: 0, w: 0, h: 0, rot: 0, opacity: 1,
    };
  }
  // What double-clicking a line edits: the line on its own, or the whole paragraph it is part of.
  // A paragraph is edited as one piece of text, with what single lines of it were changed to
  // before (those edits become part of the paragraph's).
  function unitOf(i, item) {
    const an = cached(i); if (!an || !an.ok || !item || !item.ph) return null;
    const e = item.edit;
    if (e && e.src && e.src.para) { const P = paraOfEdit(an, e); return P ? { kind: 'para', para: P, edit: e, text: e.text, oldEdits: [] } : null; }
    if (item.ph.virtual) return null;
    const P = an.paraOf && an.paraOf.get(item.ph.key);
    if (!P) return { kind: 'line', ph: item.ph, edit: e, text: e ? e.text : item.ph.text };
    const eds = editsOf(i).filter(x => !x.hidden && !(x.src && x.src.para));
    if (editsOf(i).some(x => x.src && x.src.para && x.src.para.lines.some(l => P.lines.some(ph => ph.key === l.key)))) return { kind: 'line', ph: item.ph, edit: e, text: e ? e.text : item.ph.text };
    const parts = [], old = [];
    for (const ph of P.lines) {
      const x = eds.find(y => y.src.key === ph.key && phraseOfEdit(an, y) === ph);
      if (x) old.push(x);
      parts.push(x ? x.text : ph.text);
    }
    return { kind: 'para', para: P, edit: null, text: parts.join(' '), oldEdits: old };
  }

  /* ---------- the phrases as they are now: original, or edited ---------- */
  // What is on the page at the moment, for the mouse: every phrase, with an edited one showing
  // its new wording and box. Deleted phrases are gone.
  function current(i) {
    const an = cached(i); if (!an || !an.ok) return [];
    const eds = editsOf(i).filter(e => !e.hidden);
    const byKey = new Map(), inPara = new Map();
    for (const e of eds) {
      if (!(e.src && e.src.para)) { byKey.set(e.src.key, e); continue; }
      const P = paraOfEdit(an, e); if (!P) continue;
      const r = paraLayoutOf(an, P, e);
      for (const sl of r.slots) if (sl.ph) inPara.set(sl.ph.key, { e, r, sl });
    }
    const out = [];
    for (const ph of an.phrases) {
      const x = inPara.get(ph.key);
      if (x) {
        if (x.sl.toks.length) out.push({ ph, edit: x.e, text: x.sl.text, box: x.sl.box, lay: x.sl.changed ? x.sl.lay : null });
        const ls = x.r.para.lines;
        if (ph === ls[ls.length - 1]) for (const sl of x.r.slots) if (sl.virtual && sl.toks.length) out.push({ ph: sl.vph, edit: x.e, text: sl.text, box: sl.box, lay: sl.lay });
        continue;
      }
      const e = byKey.get(ph.key);
      if (e && phraseOfEdit(an, e) === ph) {
        if (!e.text.length) continue;
        const lay = layoutOf(an, ph, e);
        out.push({ ph, edit: e, text: e.text, box: lay.box, lay });
      } else out.push({ ph, edit: null, text: ph.text, box: ph.box, lay: null });
    }
    return out;
  }
  function local(b, x, y) {
    const t = b.rot * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), dx = x - b.x, dy = y - b.y;
    return [dx * c + dy * s, -dx * s + dy * c];
  }
  function phraseAt(i, x, y, pad = 1.5) {
    let best = null, area = Infinity;
    for (const it of current(i)) {
      const b = it.box, [lx, ly] = local(b, x, y);
      if (lx >= -pad && ly >= -pad && lx <= b.w + pad && ly <= b.h + pad && b.w * b.h < area) { best = it; area = b.w * b.h; }
    }
    return best;
  }

  /* ---------- drawing a layout on the screen ---------- */
  const css = c => (c ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : '#000');
  function drawLayout(ctx, s, lay) {
    ctx.save();
    for (const d of lay.draws) {
      const path = KamFonts.pathOf(d.fk, d.glyph); if (!path) continue;
      const u = 1 / d.fk.unitsPerEm, M = mul(mul([u, 0, 0, u, 0, 0], d.E), [s, 0, 0, s, 0, 0]);
      ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      const mode = d.op.Tr % 4;
      if (mode === 0 || mode === 2) { ctx.fillStyle = css(d.op.fill); ctx.fill(path); }
      if (mode === 1 || mode === 2) { ctx.strokeStyle = css(d.op.stroke); ctx.lineWidth = Math.max(0.5, (d.op.lw || 1)) / Math.max(1e-6, Math.hypot(M[0], M[1]) / s); ctx.stroke(path); }
    }
    ctx.restore();
  }

  /* ---------- writing edits into a document ---------- */
  const fmt = n => { if (!isFinite(n)) return '0'; const r = Math.round(n * 10000) / 10000; return (Object.is(r, -0) ? 0 : r).toString(); };
  const fmtM = m => m.map(fmt).join(' ');
  const hex = b => '<' + Array.from(b, v => (v < 16 ? '0' : '') + v.toString(16).toUpperCase()).join('') + '>';
  function nameTok(n) {
    let out = '/';
    for (const ch of n) {
      const c = ch.charCodeAt(0);
      out += c < 33 || c > 126 || c === 35 || DL[c] ? '#' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase() : ch;
    }
    return out;
  }
  const enc = s => new TextEncoder().encode(s);

  // One text operation, rewritten: some glyphs gone (their room kept as empty space), some
  // moved along, the rest untouched, and the text position afterwards exactly as before. New
  // letters are put in at the place of the ones they replace, splitting the operation there, so
  // the file holds the words in the order they are read. `insText(ins, pos)` writes one
  // insertion; pos is where the original text had got to at that point, along its line.
  function rewriteOp(an, op, act, insText) {
    const k = 1000 / (op.size * op.Th);
    const splits = new Map();
    for (const ins of act.ins) {
      let at = op.items.findIndex(it => it.g === ins.at.g);
      at = at < 0 ? op.items.length : at + (ins.at.before ? 0 : 1);
      let list = splits.get(at); if (!list) splits.set(at, list = []); list.push(ins);
    }
    let s = op.kind === "'" ? 'T* ' : op.kind === '"' ? `${fmt(op.aw)} Tw ${fmt(op.ac)} Tc T* ` : '';
    let out = [], n = 0, pos = op.acc0 || 0;
    const flushNum = () => { if (Math.abs(n) > 1e-7) out.push({ num: n }); n = 0; };
    const flushTJ = () => {
      flushNum();
      if (out.length) s += (s && !/\s$/.test(s) ? ' ' : '') + '[' + out.map(x => (x.bytes ? hex(x.bytes) : fmt(x.num))).join(' ') + '] TJ';
      out = [];
    };
    for (let i = 0; i <= op.items.length; i++) {
      const here = splits.get(i);
      if (here) { flushTJ(); for (const ins of here) s += insText(ins, pos); }
      if (i === op.items.length) break;
      const it = op.items[i];
      if (it.num !== undefined) { n += it.num; pos -= it.num / 1000 * op.size * op.Th; continue; }
      const g = an.glyphs[it.g];
      pos += g.tx;
      if (act.remove.has(g.id)) { n -= g.tx * k; continue; }
      const d = act.shift.get(g.id) || 0;
      if (d) n -= d * k;
      flushNum();
      const last = out[out.length - 1];
      if (last && last.bytes) last.bytes = [...last.bytes, ...g.bytes]; else out.push({ bytes: [...g.bytes] });
      if (d) n += d * k;
    }
    flushTJ();
    return s;
  }
  // New letters, written in the same text object as the letters they replace: same colour,
  // transparency, clipping and text settings. The font is switched only for letters the PDF's
  // font does not have, and everything is put back afterwards, the text position to `pos`, so
  // the rest of the text object carries on exactly as it would have.
  function insertion(op, ins, fbName, pos) {
    const k = 1000 / (op.size * op.Th), size = fmt(op.size), own = nameTok(op.res);
    // the letter spacing the new letters were laid out with, if it is not the one in force here
    const tc = ins.st && Math.abs(ins.st.Tc - op.Tc) > 1e-9 ? ins.st.Tc : null;
    let s = `\n${fmtM(ins.Tm)} Tm\n` + (tc !== null ? `${fmt(tc)} Tc\n` : ''), cur = '';
    for (const pc of ins.pieces) {
      const font = pc.kind === 'fb' ? pc.key : '';
      if (font !== cur) { s += `${font ? fbName(pc.key) : own} ${size} Tf\n`; cur = font; }
      const parts = [];
      for (const it of pc.items) {
        if (it.move !== undefined) { parts.push(fmt(-it.move * k)); continue; }
        if (it.pending) continue;
        parts.push(pc.kind === 'fb' ? it.hex : hex(it.bytes));
      }
      if (parts.length) s += '[' + parts.join(' ') + '] TJ\n';
    }
    if (cur) s += `${own} ${size} Tf\n`;
    if (tc !== null) s += `${fmt(op.Tc)} Tc\n`;
    s += `${fmtM(op.Tlm)} Tm\n`;
    if (Math.abs(pos) > 1e-9) s += `[${fmt(-pos * k)}] TJ\n`;
    return s;
  }

  // The forms (and the page) of the target document that match the analysis's containers.
  function resolveContainers(doc, pageIndex, an) {
    const ctx = doc.context, node = doc.getPage(pageIndex).node;
    const out = [];
    for (const c of an.containers) {
      if (c.kind === 'page') {
        const bytes = pageContent(ctx, node);
        out.push({ kind: 'page', bytes, ok: fingerprint(bytes) === c.fp, res: dictOf(ctx, node.Resources()) });
        continue;
      }
      const parent = out[c.parent];
      const xo = parent && parent.res && dictOf(ctx, parent.res.get(N('XObject')));
      const ref = xo && xo.get(N(c.name)), st = ref && lookup(ctx, ref);
      if (!(st instanceof L.PDFStream)) { out.push({ kind: 'form', ok: false }); continue; }
      let bytes; try { bytes = streamBytes(st); } catch (e) { out.push({ kind: 'form', ok: false }); continue; }
      out.push({ kind: 'form', ok: fingerprint(bytes) === c.fp, bytes, stream: st, res: dictOf(ctx, st.dict.get(N('Resources'))) || parent.res });
    }
    return out;
  }

  /* Write edits into page `pageIndex` of `doc` (a copy of the page for the screen, or the
     document being saved). `edits` are textedit marks; { key, removeOnly: true } removes a
     phrase without writing anything (while it is being retyped). Returns how many edits were
     applied. */
  async function applyEdits(doc, pageIndex, an, edits) {
    if (!an || !an.ok || !edits.length) return 0;
    await KamFonts.ready();
    const lays = [];
    for (const e of edits) {
      if (!e.removeOnly && e.src && e.src.para) {
        const P = paraOfEdit(an, e);
        if (!P) { console.warn('a paragraph edit no longer matches its page and was skipped', e); continue; }
        lays.push(...(await paraLayoutReady(an, P, e.text)).lays);
        continue;
      }
      const ph = e.removeOnly ? an.byKey.get(e.key) : phraseOfEdit(an, e);
      if (!ph) { console.warn('an edit no longer matches its page and was skipped', e); continue; }
      lays.push(await layoutReady(an, ph, e.removeOnly ? '' : e.text));
    }
    if (!lays.length) return 0;
    const ctx = doc.context, page = doc.getPage(pageIndex);
    const conts = resolveContainers(doc, pageIndex, an);
    // gather what happens to each text operation
    const acts = new Map();
    const actOf = id => { let a = acts.get(id); if (!a) acts.set(id, a = { remove: new Set(), shift: new Map(), ins: [] }); return a; };
    for (const lay of lays) {
      for (const id of lay.removed) actOf(an.glyphs[id].op).remove.add(id);
      for (const [id, d] of lay.shift) actOf(an.glyphs[id].op).shift.set(id, d);
      for (const ins of lay.ins) actOf(ins.op).ins.push(ins);
    }
    // containers touched, and their parents up to the page
    const touched = new Set();
    for (const id of acts.keys()) { let c = an.ops[id].c; while (c >= 0 && !touched.has(c)) { touched.add(c); c = an.containers[c].parent; } }
    for (const c of touched) if (!conts[c] || !conts[c].ok) throw new Error('the page changed since it was read');
    // bundled fonts for letters the PDF's fonts do not have
    doc.registerFontkit(window.fontkit);
    const fbFonts = new Map();
    for (const lay of lays) for (const ins of lay.ins) for (const pc of ins.pieces) {
      if (pc.kind !== 'fb') continue;
      let f = fbFonts.get(pc.key);
      if (!f) { const b = await KamFonts.bundled(pc.key); f = { pdf: await doc.embedFont(b.bytes, { subset: true }), names: new Map() }; fbFonts.set(pc.key, f); }
      for (const it of pc.items) if (it.ch && !it.pending) it.hex = f.pdf.encodeText(it.ch).toString();
    }
    const fontNameIn = (res, key) => {
      const f = fbFonts.get(key);
      if (f.names.has(res)) return f.names.get(res);
      let fd = res.lookup(N('Font'));
      if (!(fd instanceof L.PDFDict)) { fd = ctx.obj({}); res.set(N('Font'), fd); }
      let nm, n = 1; do { nm = `KAM${key.replace(/[^A-Za-z]/g, '').slice(0, 12)}${n++}`; } while (fd.has(N(nm)));
      fd.set(N(nm), f.pdf.ref);
      f.names.set(res, nameTok(nm));
      return nameTok(nm);
    };
    // rewrite, deepest first, so a form's new copy exists before its parent points at it
    const extra = new Map();          // container -> { dos: [[s, e, text]], xobjects: [[name, ref]] }
    const order = [...touched].sort((a, b) => b - a);
    for (const ci of order) {
      const c = an.containers[ci], tc = conts[ci];
      let res = tc.res;
      let newRes = null;
      if (c.kind === 'form') {
        // a form may be shared with other pages or drawn more than once: edit a copy of it
        newRes = res ? res.clone(ctx) : ctx.obj({});
        const f = newRes.lookup(N('Font')); if (f instanceof L.PDFDict) newRes.set(N('Font'), f.clone(ctx));
        const x = newRes.lookup(N('XObject')); if (x instanceof L.PDFDict) newRes.set(N('XObject'), x.clone(ctx));
        res = newRes;
      } else if (!res) { res = ctx.obj({}); page.node.set(N('Resources'), res); }
      const fbName = key => fontNameIn(res, key);
      const edits = [];               // [start, end, replacement text]
      for (const [id, a] of acts) {
        const op = an.ops[id]; if (op.c !== ci) continue;
        edits.push([op.s, op.e, rewriteOp(an, op, a, (ins, pos) => insertion(op, ins, fbName, pos))]);
      }
      const ex = extra.get(ci);
      if (ex) {
        for (const d of ex.dos) edits.push(d);
        let xo = res.lookup(N('XObject')); if (!(xo instanceof L.PDFDict)) { xo = ctx.obj({}); res.set(N('XObject'), xo); }
        for (const [nm, ref] of ex.xobjects) xo.set(N(nm), ref);
      }
      edits.sort((a, b) => a[0] - b[0]);
      const parts = []; let at = 0;
      for (const [s0, e0, t] of edits) { parts.push(tc.bytes.subarray(at, s0), enc(t)); at = e0; }
      parts.push(tc.bytes.subarray(at));
      const body = concat(parts);
      if (c.kind === 'page') {
        // wrapped in q/Q: whatever the original left behind (a scale, a flip) must not reach
        // what is drawn after it, such as your own marks when the file is saved
        const s = ctx.flateStream(concat([enc('q\n'), body, enc('\nQ\n')]));
        page.node.set(N('Contents'), ctx.obj([ctx.register(s)]));
      } else {
        const lit = {};
        for (const [k, v] of tc.stream.dict.entries()) { const kn = k.decodeText(); if (kn !== 'Length' && kn !== 'Filter' && kn !== 'DecodeParms') lit[kn] = v; }
        lit.Resources = newRes;
        const ref = ctx.register(ctx.flateStream(body, lit));
        const parentRes = conts[c.parent].res;
        let nm, n = 1; const pxo = parentRes && parentRes.lookup(N('XObject'));
        do { nm = `KAMFm${n++}`; } while (pxo instanceof L.PDFDict && pxo.has(N(nm)));
        let pe = extra.get(c.parent); if (!pe) extra.set(c.parent, pe = { dos: [], xobjects: [] });
        pe.dos.push([c.doS, c.doE, `${nameTok(nm)} Do`]);
        pe.xobjects.push([nm, ref]);
      }
    }
    return lays.length;
  }

  /* Drop every object in a document that nothing refers to any more. Rewriting a page leaves
     its old content stream behind, unreferenced but still written out by pdf-lib, and with it
     every word that was edited away or deleted. A deleted word has to be gone from the file,
     not merely unused, so after text edits the leftovers are swept out before saving. (It also
     clears out old revisions a file has kept from being saved over and over.) */
  function pruneUnreachable(doc) {
    const ctx = doc.context, seen = new Set(), stack = [];
    const t = ctx.trailerInfo || {};
    for (const v of [t.Root, t.Info, t.Encrypt, t.ID]) if (v) stack.push(v);
    while (stack.length) {
      const v = stack.pop();
      if (v instanceof L.PDFRef) { if (seen.has(v.tag)) continue; seen.add(v.tag); const o = ctx.lookup(v); if (o) stack.push(o); }
      else if (v instanceof L.PDFStream) stack.push(v.dict);
      else if (v instanceof L.PDFDict) { for (const [, x] of v.entries()) stack.push(x); }
      else if (v instanceof L.PDFArray) { for (const x of v.asArray()) stack.push(x); }
    }
    let n = 0;
    for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) { ctx.delete(ref); n++; }
    return n;
  }

  return { analyse, cached, reset, current, phraseAt, layout, layoutReady, layoutOf, phraseOfEdit, drawLayout, applyEdits, editsOf, uniText,
           newEdit, boxFields, pruneUnreachable, unitOf, layoutPara, paraLayoutReady, paraLayoutOf, paraOfEdit, newParaEdit, _internal: { Lexer, readPage, pdfjsShows, fingerprint, pageContent, mul, inv, pt } };
})();

/* ---------- pages drawn with their edits applied ----------
   A page with edited text is drawn from a one-page copy of itself with the edits written into
   its content stream, exactly as they will be saved. Kept for a handful of pages at a time. */
const KamPatch = (() => {
  const cache = new Map();               // page id -> { sig, pdf, page, base }
  const building = new Map();            // page id -> { sig, promise }
  function sigFor(i) {
    const id = state.pageIds[i]; if (id === undefined) return '';
    const eds = (state.annots[id] || []).filter(a => a.type === 'textedit' && !a.hidden);
    const sess = typeof KamEdit !== 'undefined' ? KamEdit.sessionFor(i) : null;
    if (!eds.length && !sess) return '';
    return JSON.stringify([eds.map(e => [e.id, e.text, e.src.key]), sess]);
  }
  function drop(entry) { if (entry && entry.pdf) { const p = entry.pdf; setTimeout(() => { try { p.destroy(); } catch (e) { } }, 15000); } }
  async function build(i, sig) {
    const base = state.pdfjs, an = await KamContent.analyse(i);
    if (!an.ok || base !== state.pdfjs) return null;
    const id = state.pageIds[i];
    const edits = (state.annots[id] || []).filter(a => a.type === 'textedit' && !a.hidden);
    const sess = typeof KamEdit !== 'undefined' ? KamEdit.sessionFor(i) : null;
    const inSession = e => !!sess && (sess.includes(e.src.key) || (!!e.src.para && e.src.para.lines.some(l => sess.includes(l.key))));
    const list = edits.filter(e => !inSession(e));
    if (sess) for (const key of sess) list.push({ removeOnly: true, key });
    const out = await PDFLib.PDFDocument.create({ updateMetadata: false });
    const [p] = await out.copyPages(state.doc, [i]);
    out.addPage(p);
    await KamContent.applyEdits(out, 0, an, list);
    const bytes = await out.save({ useObjectStreams: false });
    const pdf = await pdfjsLib.getDocument({ data: bytes, worker: sharedPdfWorker() }).promise;
    const page = await pdf.getPage(1);
    return { sig, pdf, page, base };
  }
  async function pageFor(i) {
    const sig = sigFor(i); if (!sig) return null;
    const id = state.pageIds[i], hit = cache.get(id);
    if (hit && hit.sig === sig && hit.base === state.pdfjs) return hit.page;
    let b = building.get(id);
    if (!b || b.sig !== sig || b.base !== state.pdfjs) {
      b = { sig, base: state.pdfjs, promise: build(i, sig) };
      building.set(id, b);
    }
    let entry;
    try { entry = await b.promise; }
    catch (e) { console.warn('could not draw the edited page', e); entry = null; }
    finally { if (building.get(id) === b) building.delete(id); }
    if (!entry) return null;
    if (sigFor(i) === entry.sig && entry.base === state.pdfjs) {
      const old = cache.get(id); if (old && old !== entry) drop(old);
      cache.set(id, entry);
      while (cache.size > 8) { const k = cache.keys().next().value; drop(cache.get(k)); cache.delete(k); }
    }
    return entry.page;
  }
  function reset() { for (const e of cache.values()) drop(e); cache.clear(); building.clear(); }
  return { sigFor, pageFor, reset };
})();
