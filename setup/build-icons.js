/* Builds every icon KAM PDFs ships, from the two SVG masters.
 *
 *   node setup/build-icons.js
 *
 * Why two masters: the full logo carries the KAM wordmark, which needs about 96 pixels
 * before it is legible. Below that it turns to mush, which is what made the taskbar and
 * header icons look bad. logo-mark.svg is the same mark with the wordmark dropped and the
 * shapes opened up, and it is what gets used at small sizes.
 *
 * Needs Node 18+ and Google Chrome; Chrome does the rasterising, so there is nothing to
 * install. The .ico is assembled here rather than resampled from one bitmap, so each size
 * inside it is drawn from the right master.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), http = require('http'), path = require('path'), os = require('os');

const ROOT = path.resolve(__dirname, '..');
const CDP = 9407;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(p => fs.existsSync(p));

// size -> which master to draw it from. 96 is where the wordmark starts to hold together.
const MARK = 'logo-mark.svg', FULL = 'logo.svg';
const masterFor = s => (s < 96 ? MARK : FULL);

const PNGS = [
  ['icons/icon-16.png', 16], ['icons/icon-24.png', 24], ['icons/icon-32.png', 32],
  ['icons/icon-48.png', 48], ['icons/icon-64.png', 64], ['icons/icon-96.png', 96],
  ['icons/icon-128.png', 128], ['icons/icon-192.png', 192], ['icons/icon-256.png', 256],
  ['icons/icon-512.png', 512],
];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function chrome() {
  const dir = path.join(os.tmpdir(), 'kam-icons-profile');
  fs.rmSync(dir, { recursive: true, force: true });
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--force-device-scale-factor=1',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 60 && !targets; i++) {
    try {
      targets = await new Promise((res, rej) => http.get(`http://localhost:${CDP}/json`, r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
      }).on('error', rej));
    } catch (e) { await sleep(250); }
  }
  if (!targets) throw new Error('Chrome did not start');
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {};
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  return {
    async evaluate(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      const d = r.result.exceptionDetails;
      if (d) throw new Error((d.exception && d.exception.description) || d.text);
      return r.result.result.value;
    },
    close() { try { ws.close(); } catch (e) { } proc.kill(); },
  };
}

// Rasterise one SVG at one size. Chrome renders the SVG at its natural size and scales,
// which is what every consumer of these files will do too.
const drawExpr = (svg, size) => `(async () => {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = ${size};
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, ${size}, ${size});
  return c.toDataURL('image/png').split(',')[1];
})()`;

/* ---------- ICO assembly ----------
   An .ico is a small header, one 16-byte directory entry per image, then the images
   themselves. Windows has taken PNG-compressed entries since Vista, so each size can be a
   PNG drawn from whichever master suits it. */
function buildIco(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + 16 * pngs.length;
  pngs.forEach(({ size, data }, i) => {
    const o = 16 * i;
    dir[o] = size >= 256 ? 0 : size;        // 0 means 256
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0; dir[o + 3] = 0;         // palette, reserved
    dir.writeUInt16LE(1, o + 4);            // colour planes
    dir.writeUInt16LE(32, o + 6);           // bits per pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...pngs.map(p => p.data)]);
}

(async () => {
  if (!CHROME) { console.error('Google Chrome was not found.'); process.exit(1); }
  const svg = {
    [MARK]: fs.readFileSync(path.join(ROOT, MARK), 'utf8'),
    [FULL]: fs.readFileSync(path.join(ROOT, FULL), 'utf8'),
  };
  const b = await chrome();
  try {
    fs.mkdirSync(path.join(ROOT, 'icons'), { recursive: true });
    const made = {};
    for (const [rel, size] of PNGS) {
      const master = masterFor(size);
      const b64 = await b.evaluate(drawExpr(svg[master], size));
      const data = Buffer.from(b64, 'base64');
      fs.writeFileSync(path.join(ROOT, rel), data);
      made[size] = data;
      console.log(`  ${rel.padEnd(22)} ${String(size).padStart(3)}px  from ${master}  ${data.length} bytes`);
    }
    for (const size of ICO_SIZES) {
      if (made[size]) continue;
      const b64 = await b.evaluate(drawExpr(svg[masterFor(size)], size));
      made[size] = Buffer.from(b64, 'base64');
    }
    const ico = buildIco(ICO_SIZES.map(size => ({ size, data: made[size] })));
    fs.writeFileSync(path.join(ROOT, 'logo.ico'), ico);
    console.log(`  logo.ico               ${ICO_SIZES.join(', ')}  ${ico.length} bytes`);
  } finally { b.close(); }
  console.log('Done.');
})().catch(e => { console.error(e); process.exit(1); });
