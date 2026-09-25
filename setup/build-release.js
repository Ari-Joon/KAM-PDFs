/* Builds the Windows zip for a release, after checking that nothing the app needs is missing.
 *
 *   node setup/build-release.js      ->  dist/KAM-PDFs-v<version>-windows.zip
 *
 * The zip is made from the last commit (git archive), not from the folder, so it holds exactly
 * what is on GitHub: nothing half-edited, nothing that was never committed, and paths that
 * unzip the same on Windows, Mac and Linux. The tests and screenshots are left out
 * (export-ignore in .gitattributes), and everything sits in one "KAM PDFs" folder, the way the
 * install steps in the README describe.
 *
 * Then it reads the zip back and checks it: every script, stylesheet and icon the two pages
 * load, everything the service worker caches for offline use, the files loaded later (the
 * fonts, the dictionary, fontkit, the OCR engine, the pdf.js worker), the installer, the
 * licences, and that the three places stating the version agree. Any gap stops the release.
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const TOP = 'KAM PDFs/';
const git = args => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 30 });
const show = f => git(['show', 'HEAD:' + f]).toString('utf8');
const problems = [];

// The zip is the last commit: anything not committed yet would silently be left out.
const dirty = git(['status', '--porcelain', '--untracked-files=no']).toString().trim();
if (dirty && !process.argv.includes('--allow-dirty')) {
  console.error('There are changes that are not committed, and the zip is made from the last commit:\n'
    + dirty + '\n\nCommit them first, or pass --allow-dirty to build from the last commit anyway.');
  process.exit(1);
}

/* ---------- the version ---------- */
const version = JSON.parse(show('version.json')).version;
const inCore = (show('core.js').match(/const KAM_VERSION = '([^']+)'/) || [])[1];
const inSw = (show('sw.js').match(/const VERSION = 'kam-pdfs-v([^']+)'/) || [])[1];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) problems.push(`version.json has no usable version: ${version}`);
if (inCore !== version) problems.push(`core.js says ${inCore}, version.json says ${version}`);
if (inSw !== version) problems.push(`sw.js caches as ${inSw}, version.json says ${version}: installed copies would keep the old files`);

/* ---------- build it ---------- */
const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `KAM-PDFs-v${version}-windows.zip`);
git(['archive', '--format=zip', '-9', '--prefix=' + TOP, '-o', out, 'HEAD']);

/* ---------- read back what is in it ---------- */
// The names in a zip's central directory, found from the record at its end.
function zipNames(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip directory');
    const n = buf.readUInt16LE(p + 28), x = buf.readUInt16LE(p + 30), c = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + n));
    p += 46 + n + x + c;
  }
  return names;
}
const zip = fs.readFileSync(out);
const entries = zipNames(zip);
const files = new Set(entries.filter(n => !n.endsWith('/')).map(n => n.slice(TOP.length)));
if (entries.some(n => !n.startsWith(TOP))) problems.push('some files are not inside the "KAM PDFs" folder');
const need = (f, why) => { if (!files.has(f)) problems.push(`missing ${f} (${why})`); };

/* ---------- what the pages load ---------- */
const local = u => u && !/^(https?:|data:|blob:|mailto:|#|\/\/)/.test(u);
for (const page of ['index.html', 'scan.html']) {
  need(page, 'a page of the app');
  const html = show(page);
  for (const m of html.matchAll(/<(?:script|img)\b[^>]*\bsrc="([^"]+)"/g)) if (local(m[1])) need(m[1].split(/[?#]/)[0], `loaded by ${page}`);
  for (const m of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)) if (local(m[1])) need(m[1].split(/[?#]/)[0], `linked from ${page}`);
}

/* ---------- what the service worker caches for offline use ---------- */
const list = (show('sw.js').match(/const FILES = \[([\s\S]*?)\];/) || [])[1];
if (!list) problems.push('sw.js: could not find its FILES list');
else for (const m of list.matchAll(/'([^']+)'/g)) need(m[1] === './' ? 'index.html' : m[1], 'cached by sw.js');
// and every script the main page loads is in that list, or it would be missing offline
if (list) {
  const cached = new Set([...list.matchAll(/'([^']+)'/g)].map(m => m[1]));
  for (const m of show('index.html').matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
    const f = m[1].split(/[?#]/)[0];
    if (local(f) && !cached.has(f)) problems.push(`index.html loads ${f}, but sw.js does not cache it: the installed app would break offline`);
  }
}

/* ---------- what the manifest names ---------- */
const manifest = JSON.parse(show('manifest.json'));
for (const i of manifest.icons || []) need(i.src.split(/[?#]/)[0], 'an icon in manifest.json');

/* ---------- files loaded later, when a feature is first used ---------- */
need('lib/pdf.worker.min.js', 'pdf.js draws pages with it');
need('lib/fontkit.umd.min.js', 'reads fonts for text editing');
need('dict/en.js', 'the spelling dictionary');
for (const f of ['tesseract.min.js', 'worker.min.js', 'tesseract-core-simd.wasm.js', 'eng.traineddata']) need('lib/ocr/' + f, 'OCR');
const families = [...new Set([...show('fonts.js').matchAll(/family = '([A-Za-z]+)'/g)].map(m => m[1]))];
if (families.length < 5) problems.push(`fonts.js: expected at least five font families, found ${families.join(', ')}`);
for (const fam of families) for (const style of ['Regular', 'Bold', 'Italic', 'BoldItalic']) need(`fonts/${fam}-${style}.js`, 'a bundled font');

/* ---------- installing, and the licences ---------- */
for (const f of ['Install KAM PDFs.bat', 'Remove shortcuts.bat', 'setup/install.ps1', 'logo.ico', 'version.json']) need(f, 'installing and updating');
for (const f of ['LICENSE', 'README.md', 'THIRD-PARTY-NOTICES.md', 'lib/LICENSE-Apache-2.0.txt', 'lib/LICENSE-fontkit.txt',
  'fonts/LICENSE-Liberation.txt', 'fonts/LICENSE-Carlito.txt', 'fonts/LICENSE-Caladea.txt', 'dict/SOURCES.txt']) need(f, 'a licence or notice');

/* ---------- and nothing that does not belong ---------- */
for (const f of files) if (/^(tests|screenshots|dist|\.claude)\//.test(f) || /^\.git/.test(f)) problems.push(`${f} should not be in the zip`);

if (problems.length) {
  fs.rmSync(out, { force: true });
  console.error('The release zip was NOT made:\n' + problems.map(p => '  - ' + p).join('\n'));
  process.exit(1);
}
const sha = crypto.createHash('sha256').update(zip).digest('hex');
const commit = git(['rev-parse', '--short', 'HEAD']).toString().trim();
console.log(`KAM PDFs ${version}, from commit ${commit}`);
console.log(`  ${path.relative(ROOT, out)}`);
console.log(`  ${files.size} files, ${(zip.length / 1048576).toFixed(1)} MB`);
console.log(`  sha256 ${sha}`);
console.log('  every file the app loads is in it, and the version agrees everywhere.');
