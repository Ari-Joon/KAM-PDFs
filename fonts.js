/* KAM PDFs - fonts for editing the text that is already in a PDF.
 *
 * Changed words should come out in the document's own typeface, not in whatever the editor
 * happens to have. So, in order of preference, a character is drawn with:
 *   1. the font embedded in the PDF itself, when that font has the character (pdf.js hands
 *      us its program, and fontkit reads the outlines and widths out of it);
 *   2. a bundled font made to the same measurements as the original: Carlito for Calibri,
 *      Caladea for Cambria, Liberation Sans, Serif and Mono for Arial/Helvetica, Times and
 *      Courier. Same widths, so a changed line keeps its length;
 *   3. the nearest bundled font by kind (serif, sans or mono) and weight, for anything else.
 * fontkit is only loaded the first time text is edited, and each bundled font only when a
 * character actually needs it.
 */
'use strict';
const KamFonts = (() => {
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('could not load ' + src));
      document.head.appendChild(s);
    });
  }

  let fkReady = null;
  function ready() {
    if (window.fontkit) return Promise.resolve(window.fontkit);
    if (!fkReady) {
      fkReady = loadScript('lib/fontkit.umd.min.js').then(() => {
        if (!window.fontkit) throw new Error('fontkit did not load');
        return window.fontkit;
      });
      fkReady.catch(() => { fkReady = null; });
    }
    return fkReady;
  }
  const isReady = () => !!window.fontkit;

  /* ---------- the fonts that come with the app ---------- */
  const bundledCache = new Map();          // key -> Promise<{ key, bytes, fk }>
  const bundledNow = new Map();            // key -> { key, bytes, fk } once loaded
  function bundled(key) {
    let p = bundledCache.get(key);
    if (!p) {
      p = (async () => {
        const fontkit = await ready();
        const store = window.KAM_FONTS || {};
        if (!store[key]) await loadScript(`fonts/${key}.js`);
        const b64 = (window.KAM_FONTS || {})[key];
        if (!b64) throw new Error('font ' + key + ' is missing');
        const bin = atob(b64), bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        delete window.KAM_FONTS[key];                  // the base64 copy is no longer needed
        const f = { key, bytes, fk: fontkit.create(bytes) };
        padSubsets(f.fk);
        bundledNow.set(key, f);
        return f;
      })();
      p.catch(() => bundledCache.delete(key));
      bundledCache.set(key, p);
    }
    return p;
  }

  /* fontkit cuts a font down to the letters used when it is saved into a PDF. For a small cut it
     writes the glyph index in its short form, which can only point at even positions, but it
     copies each glyph's bytes as they are, and Carlito's glyphs are often an odd number of bytes
     long. Every glyph after the first odd one then pointed a byte out, and PDFium (Chrome, Edge,
     most viewers) drew those letters blank, while pdf.js happened to cope. Padding each glyph to
     an even length, which TrueType allows, puts every one back where the index says it is. */
  function padSubsets(fk) {
    let proto;
    try { proto = Object.getPrototypeOf(fk.createSubset()); } catch (e) { return; }
    if (!proto || proto.__kamPadded || typeof proto._addGlyph !== 'function') return;
    const add = proto._addGlyph;
    proto._addGlyph = function (gid) {
      const r = add.call(this, gid);
      const i = this.glyf.length - 1, buf = this.glyf[i];
      if (buf && buf.length % 2) {
        const B = buf.constructor, even = typeof B.alloc === 'function' ? B.alloc(buf.length + 1) : new Uint8Array(buf.length + 1);
        if (typeof buf.copy === 'function') buf.copy(even); else even.set(buf);
        this.glyf[i] = even;
        this.offset += 1;
      }
      return r;
    };
    proto.__kamPadded = true;
  }

  /* What a PDF font is, from its name and the flags pdf.js worked out. */
  function describe(font) {
    const raw = String((font && font.name) || '').replace(/^[A-Z]{6}\+/, '');
    const name = raw.toLowerCase().replace(/[\s_]/g, '');
    const bold = /bold|black|heavy|semibold|demi|extrabold|ultrabold|[-,](bd|bdit|bdi)$|^cmbx|^cmb\d/.test(name) || !!(font && (font.bold || font.black));
    const italic = /italic|oblique|kursiv|slanted|[-,](it|bdit|bdi)$|^cmti|^cmbxti|^cmsl/.test(name) || !!(font && font.italic);
    let family;
    if (/calibri|carlito/.test(name)) family = 'Carlito';
    else if (/cambria|caladea/.test(name)) family = 'Caladea';
    else if (/courier|cousine|liberationmono|consolas|mono|menlo|monaco|lucidaconsole|typewriter|cmtt/.test(name) || (font && font.isMonospace)) family = 'LiberationMono';
    else if (/times|tinos|liberationserif|nimbusrom|georgia|garamond|bookantiqua|palatino|minion|century|bodoni|baskerville|caslon|didot|cmr|cmbx|cmti|lmroman|serif|roman|dejavuserif|charter|constantia|goudy|bookman|sabon/.test(name) && !/sans/.test(name)) family = 'LiberationSerif';
    else if (/arial|helvetica|arimo|liberationsans|nimbussans|verdana|tahoma|segoe|trebuchet|franklin|gill|futura|candara|corbel|lato|roboto|opensans|sourcesans|notosans|dejavusans|ubuntu|myriad|frutiger|univers|avenir|sans/.test(name)) family = 'LiberationSans';
    else family = font && font.isSerifFont ? 'LiberationSerif' : 'LiberationSans';
    return { name: raw, family, bold, italic };
  }
  function styleKey(bold, italic) { return bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular'; }
  // The bundled font that stands in for this PDF font.
  function fallbackKey(font) { const d = describe(font); return `${d.family}-${styleKey(d.bold, d.italic)}`; }
  // If a character is not in the matching font either, the plain sans of the same weight.
  function lastResortKey(font) { const d = describe(font); return `LiberationSans-${styleKey(d.bold, d.italic)}`; }

  /* ---------- the PDF's own fonts ---------- */
  // pdf.js keeps each font's program (converted to OpenType) when the document is opened with
  // fontExtraProperties; fontkit reads glyph outlines and widths out of it.
  const pdfCache = new WeakMap();
  function forPdf(font) {
    if (!font || !window.fontkit || font.missingFile || font.isType3Font || !font.data || !font.data.length) return null;
    if (pdfCache.has(font)) return pdfCache.get(font);
    let fk = null;
    try { fk = window.fontkit.create(font.data instanceof Uint8Array ? font.data : new Uint8Array(font.data)); }
    catch (e) { console.warn('could not read the font ' + font.name, e); }
    pdfCache.set(font, fk);
    return fk;
  }

  /* ---------- outlines ---------- */
  const paths = new WeakMap();                 // fontkit font -> Map(glyph id -> Path2D)
  function pathOf(fk, glyph) {
    if (!fk || !glyph) return null;
    let m = paths.get(fk); if (!m) { m = new Map(); paths.set(fk, m); }
    let p = m.get(glyph.id);
    if (p === undefined) {
      p = null;
      try { const d = glyph.path.toSVG(); if (d) p = new Path2D(d); } catch (e) { }
      m.set(glyph.id, p);
    }
    return p;
  }
  function glyphFor(fk, cp) {
    if (!fk) return null;
    try { if (!fk.hasGlyphForCodePoint(cp)) return null; const g = fk.glyphForCodePoint(cp); return g && g.id ? g : null; }
    catch (e) { return null; }
  }

  /* ---------- the fonts you can choose for your own text ----------
     Helvetica, Times and Courier are the PDF standard fonts: saved as they are when they can
     write every letter, and otherwise as Liberation Sans, Serif or Mono, which have the same
     measurements and far more letters. Carlito and Caladea stand in for Calibri and Cambria.
     On screen the chosen font is drawn from the same file that is saved. */
  const CHOICES = { Helvetica: 'LiberationSans', TimesRoman: 'LiberationSerif', Courier: 'LiberationMono', Carlito: 'Carlito', Caladea: 'Caladea' };
  const keyFor = (font, bold, italic) => `${CHOICES[font] || 'LiberationSans'}-${styleKey(bold, italic)}`;
  const faces = new Map(), facesLoaded = new Set();
  // A CSS family for one of the bundled fonts, loaded as a web font from its own bytes.
  function face(key) {
    let p = faces.get(key);
    if (!p) {
      p = bundled(key).then(async b => {
        const [fam, style] = key.split('-');
        const f = new FontFace('KAM ' + fam, b.bytes, { weight: /Bold/.test(style) ? '700' : '400', style: /Italic/.test(style) ? 'italic' : 'normal' });
        await f.load(); document.fonts.add(f);
        facesLoaded.add(key);
        return 'KAM ' + fam;
      });
      p.catch(() => faces.delete(key));
      faces.set(key, p);
    }
    return p;
  }
  const faceReady = key => facesLoaded.has(key);
  // Which characters of a text a font cannot write.
  function missingFrom(fk, text) {
    const out = new Set();
    for (const ch of text) { if (/\s/.test(ch)) continue; if (!glyphFor(fk, ch.codePointAt(0))) out.add(ch); }
    return [...out];
  }
  // What the standard fonts can write: Latin-1 and the handful of Windows extras.
  const WIN_ANSI_EXTRA = '\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178';
  const winAnsi = ch => { const c = ch.codePointAt(0); return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch); };
  // The characters of your own text that cannot be saved in the font you chose: not a standard
  // font letter, and not in the bundled font that stands in for it either.
  async function unsaveable(font, bold, text) {
    const std = font === 'Helvetica' || font === 'TimesRoman' || font === 'Courier';
    const need = [...new Set(text)].filter(ch => !/\s/.test(ch) && !(std && winAnsi(ch)));
    if (!need.length) return [];
    const b = await bundled(keyFor(font, bold));
    return missingFrom(b.fk, need.join(''));
  }

  return { ready, isReady, bundled, bundledNow: k => bundledNow.get(k) || null, describe, fallbackKey, lastResortKey, forPdf, pathOf, glyphFor,
           keyFor, face, faceReady, missingFrom, unsaveable, CHOICES };
})();
