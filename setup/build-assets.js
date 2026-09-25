/* Packs the fonts and the spelling dictionary as small script files.
 *
 *   node setup/build-assets.js <folder with the .ttf files>
 *
 * Why scripts and not the plain files: a copy of KAM PDFs unzipped into a folder runs from
 * file://, and there Chrome refuses to fetch() anything, even the app's own files next to it.
 * Script tags still load. So each font becomes a script that hands its bytes over as base64,
 * and the dictionary a script that hands over its text; the same files work on the web too.
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const src = process.argv[2];

// family -> which licence covers it (the licence texts sit next to the fonts)
const LICENCE = { Liberation: 'LICENSE-Liberation.txt', Carlito: 'LICENSE-Carlito.txt', Caladea: 'LICENSE-Caladea.txt' };

if (src) {
  for (const f of fs.readdirSync(src).filter(f => /\.ttf$/i.test(f))) {
    const name = f.replace(/\.ttf$/i, '');
    const fam = Object.keys(LICENCE).find(k => name.startsWith(k));
    if (!fam) continue;
    const b64 = fs.readFileSync(path.join(src, f)).toString('base64');
    const out = `/* ${name}, SIL Open Font License 1.1 (see ${LICENCE[fam]}). Packed as a script so it also loads from a folder copy. */\n`
      + `(window.KAM_FONTS = window.KAM_FONTS || {})[${JSON.stringify(name)}] = '${b64}';\n`;
    fs.writeFileSync(path.join(ROOT, 'fonts', name + '.js'), out);
    console.log(`  fonts/${name}.js`.padEnd(40), Math.round(out.length / 1024), 'KB');
  }
}

const dictTxt = path.join(ROOT, 'dict', 'en.txt');
if (fs.existsSync(dictTxt)) {
  const text = fs.readFileSync(dictTxt, 'utf8');
  fs.writeFileSync(path.join(ROOT, 'dict', 'en.js'),
    '/* The spelling dictionary, packed as a script so it also loads from a folder copy. */\n'
    + 'window.KAM_DICT = ' + JSON.stringify(text) + ';\n');
  console.log('  dict/en.js'.padEnd(40), Math.round(fs.statSync(path.join(ROOT, 'dict', 'en.js')).size / 1024), 'KB');
}
