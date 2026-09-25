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
        bundledNow.set(key, f);
        return f;
      })();
      p.catch(() => bundledCache.delete(key));
      bundledCache.set(key, p);
    }
    return p;
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

  return { ready, isReady, bundled, bundledNow: k => bundledNow.get(k) || null, describe, fallbackKey, lastResortKey, forPdf, pathOf, glyphFor };
})();
