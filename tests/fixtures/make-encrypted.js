/* Build password-protected PDFs for the tests, in every revision of the PDF standard security
 * handler, the way real writers make them:
 *
 *   r2-owner       40-bit RC4, no password to open (owner password only: restrictions)
 *   r3-user        128-bit RC4, needs the password "kam-user" (or the owner's, "kam-owner")
 *   r4-aes-objstm  128-bit AES, needs "kam-user"; its objects packed in an object stream and
 *                  its cross-reference in a stream, as Acrobat and Word write them
 *   r6-aes256      256-bit AES, needs "pässwörd" (a password that is not plain ASCII)
 *   r6-owner       256-bit AES, no password to open; object stream too
 *
 * Each has one page reading "Secret line <name>" and a title, "Title of <name>", so a test can
 * tell that both streams and strings were decrypted.
 *
 *   node tests/fixtures/make-encrypted.js [folder]      (default: this folder)
 */
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path'), zlib = require('zlib');

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const md5 = (...p) => { const h = crypto.createHash('md5'); for (const x of p) h.update(x); return h.digest(); };
const sha = (alg, ...p) => { const h = crypto.createHash(alg); for (const x of p) h.update(x); return h.digest(); };
const padded = pw => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
function rc4(key, data) {
  const S = new Uint8Array(256); for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; [S[i], S[j]] = [S[j], S[i]]; }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + S[i]) & 255; [S[i], S[j]] = [S[j], S[i]]; out[k] = data[k] ^ S[(S[i] + S[j]) & 255]; }
  return out;
}
const aes = (bits, key, iv, data, pad = true, mode = 'cbc') => { const c = crypto.createCipheriv(`aes-${bits}-${mode}`, key, mode === 'ecb' ? null : iv); c.setAutoPadding(pad); return Buffer.concat([c.update(data), c.final()]); };

/* ---------- keys, revisions 2 to 4 ---------- */
function setup234({ R, n, user, owner, P, id, meta = true }) {
  let h = md5(padded(owner)); if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  const ok = h.subarray(0, n);
  let O = rc4(ok, padded(user)); if (R >= 3) for (let i = 1; i <= 19; i++) O = rc4(Buffer.from(ok.map(b => b ^ i)), O);
  const Pb = Buffer.alloc(4); Pb.writeInt32LE(P);
  let k = md5(padded(user), O, Pb, id, R >= 4 && !meta ? Buffer.from([255, 255, 255, 255]) : Buffer.alloc(0));
  if (R >= 3) for (let i = 0; i < 50; i++) k = md5(k.subarray(0, n));
  const key = k.subarray(0, n);
  let U;
  if (R === 2) U = rc4(key, PAD);
  else { U = rc4(key, md5(PAD, id)); for (let i = 1; i <= 19; i++) U = rc4(Buffer.from(key.map(b => b ^ i)), U); U = Buffer.concat([U, Buffer.alloc(16)]); }
  return { key, O, U };
}
/* ---------- keys, revision 6 (algorithm 2.B) ---------- */
function hash6(pw, salt, udata) {
  let k = sha('sha256', pw, salt, udata), e = Buffer.from([0]);
  for (let i = 0; i < 64 || e[e.length - 1] > i - 32; i++) {
    const k1 = Buffer.concat(Array(64).fill(Buffer.concat([pw, k, udata])));
    e = aes(128, k.subarray(0, 16), k.subarray(16, 32), k1, false);
    let sum = 0; for (let j = 0; j < 16; j++) sum += e[j];
    k = sha(['sha256', 'sha384', 'sha512'][sum % 3], e);
  }
  return k.subarray(0, 32);
}
function setup6({ user, owner, P }) {
  const key = crypto.randomBytes(32), u = Buffer.from(user.normalize('NFKC'), 'utf8'), o = Buffer.from(owner.normalize('NFKC'), 'utf8');
  const uv = crypto.randomBytes(8), uk = crypto.randomBytes(8);
  const U = Buffer.concat([hash6(u, uv, Buffer.alloc(0)), uv, uk]);
  const UE = aes(256, hash6(u, uk, Buffer.alloc(0)), Buffer.alloc(16), key, false);
  const ov = crypto.randomBytes(8), ok = crypto.randomBytes(8);
  const O = Buffer.concat([hash6(o, ov, U), ov, ok]);
  const OE = aes(256, hash6(o, ok, U), Buffer.alloc(16), key, false);
  const perms = Buffer.alloc(16); perms.writeInt32LE(P, 0); perms.fill(255, 4, 8); perms.write('Tadb', 8, 'latin1'); crypto.randomBytes(4).copy(perms, 12);
  return { key, O, U, OE, UE, Perms: aes(256, key, null, perms, false, 'ecb') };
}

/* ---------- a small PDF writer ---------- */
function build(file, { R, user = '', owner = 'kam-owner', objstm = false, name }) {
  const P = -1028, id = crypto.randomBytes(16);
  let s, encDict, cfm;
  if (R <= 4) {
    const n = R === 2 ? 5 : 16;
    s = setup234({ R, n, user, owner, P, id });
    cfm = R === 4 ? 'AESV2' : 'RC4';
    encDict = R === 4
      ? `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O <${s.O.toString('hex')}> /U <${s.U.toString('hex')}> /P ${P} >>`
      : `<< /Filter /Standard /V ${R === 2 ? 1 : 2} /R ${R} /Length ${n * 8} /O <${s.O.toString('hex')}> /U <${s.U.toString('hex')}> /P ${P} >>`;
  } else {
    s = setup6({ user, owner, P }); cfm = 'AESV3';
    encDict = `<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF /O <${s.O.toString('hex')}> /U <${s.U.toString('hex')}> /OE <${s.OE.toString('hex')}> /UE <${s.UE.toString('hex')}> /Perms <${s.Perms.toString('hex')}> /P ${P} >>`;
  }
  // encrypt a string or stream belonging to object num
  const enc = (num, data) => {
    if (cfm === 'AESV3') { const iv = crypto.randomBytes(16); return Buffer.concat([iv, aes(256, s.key, iv, data)]); }
    const ref = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0]);
    const k = md5(s.key, ref, cfm === 'AESV2' ? Buffer.from('sAlT', 'latin1') : Buffer.alloc(0)).subarray(0, Math.min(s.key.length + 5, 16));
    if (cfm === 'AESV2') { const iv = crypto.randomBytes(16); return Buffer.concat([iv, aes(128, k, iv, data)]); }
    return rc4(k, data);
  };
  const str = (num, text, inStream) => `<${(inStream ? Buffer.from(text, 'latin1') : enc(num, Buffer.from(text, 'latin1'))).toString('hex')}>`;
  const content = zlib.deflateSync(Buffer.from(`BT /F1 18 Tf 30 250 Td (Secret line ${name}) Tj ET\n`, 'latin1'));
  const encStream = num => enc(num, content);

  // objects 1 catalog, 2 pages, 3 page, 4 contents, 5 font, 6 info, 7 encrypt
  const dicts = {
    1: () => '<< /Type /Catalog /Pages 2 0 R >>',
    2: () => '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    5: () => '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    6: inStream => `<< /Title ${str(6, 'Title of ' + name, inStream)} /Author ${str(6, 'KAM tests', inStream)} >>`,
  };
  const out = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = out[0].length;
  const offsets = {};
  const put = (num, body) => { offsets[num] = pos; const b = Buffer.concat([Buffer.from(`${num} 0 obj\n`), body, Buffer.from('\nendobj\n')]); out.push(b); pos += b.length; };
  const stream = (dict, data) => Buffer.concat([Buffer.from(dict.replace('>>', `/Length ${data.length} >>`) + '\nstream\n'), data, Buffer.from('\nendstream')]);
  const idHex = id.toString('hex');
  put(4, stream('<< /Filter /FlateDecode >>', encStream(4)));
  put(7, Buffer.from(encDict));
  if (!objstm) {
    for (const k of [1, 2, 3, 5, 6]) put(k, Buffer.from(dicts[k](false)));
    let x = `xref\n0 8\n0000000000 65535 f \n`;
    for (let k = 1; k <= 7; k++) x += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
    x += `trailer\n<< /Size 8 /Root 1 0 R /Info 6 0 R /Encrypt 7 0 R /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${pos}\n%%EOF\n`;
    out.push(Buffer.from(x));
  } else {
    // objects 1, 2, 3, 5, 6 packed into object stream 8 (their strings in the clear: the stream
    // as a whole is encrypted), and the cross-reference as stream 9
    const inside = [1, 2, 3, 5, 6];
    let head = '', body = '';
    for (const k of inside) { head += `${k} ${body.length} `; body += dicts[k](true) + '\n'; }
    const raw = Buffer.from(head + body, 'latin1');
    put(8, stream(`<< /Type /ObjStm /N ${inside.length} /First ${head.length} /Filter /FlateDecode >>`, enc(8, zlib.deflateSync(raw))));
    offsets[9] = pos;
    const rows = [];
    for (let k = 0; k <= 9; k++) {
      const row = Buffer.alloc(7);
      if (k === 0) { row[0] = 0; row.writeUInt32BE(0, 1); row.writeUInt16BE(65535, 5); }
      else if (inside.includes(k)) { row[0] = 2; row.writeUInt32BE(8, 1); row.writeUInt16BE(inside.indexOf(k), 5); }
      else { row[0] = 1; row.writeUInt32BE(offsets[k], 1); row.writeUInt16BE(0, 5); }
      rows.push(row);
    }
    const xs = Buffer.concat(rows);
    put(9, stream(`<< /Type /XRef /Size 10 /W [1 4 2] /Root 1 0 R /Info 6 0 R /Encrypt 7 0 R /ID [<${idHex}> <${idHex}>] >>`, xs));
    out.push(Buffer.from(`startxref\n${offsets[9]}\n%%EOF\n`));
  }
  fs.writeFileSync(file, Buffer.concat(out));
  return file;
}

const FIXTURES = [
  ['r2-owner', { R: 2, user: '', owner: 'kam-owner' }],
  ['r3-user', { R: 3, user: 'kam-user', owner: 'kam-owner' }],
  ['r4-aes-objstm', { R: 4, user: 'kam-user', owner: 'kam-owner', objstm: true }],
  ['r6-aes256', { R: 6, user: 'pässwörd', owner: 'kam-owner' }],
  ['r6-owner', { R: 6, user: '', owner: 'kam-owner', objstm: true }],
];
if (require.main === module) {
  const dir = process.argv[2] || __dirname;
  for (const [name, o] of FIXTURES) console.log('wrote', build(path.join(dir, `enc-${name}.pdf`), { ...o, name }));
}
module.exports = { build, FIXTURES };
