/* KAM PDFs - opening password-protected PDFs.
 *
 * Statements, payslips and council letters often come "protected": most only with an owner
 * password, which restricts printing or editing but lets anyone read the file, and some with a
 * password you need to open it at all. pdf.js can show both, but pdf-lib cannot read them, so
 * they could not be edited. This unlocks them here, on your computer, with the PDF standard
 * security handler in every revision (40- and 128-bit RC4, 128- and 256-bit AES):
 *   - a file with no open password opens straight away;
 *   - a file that needs one asks for it (the owner password works too);
 *   - the document is decrypted as it is read, and edited and saved like any other. The copy
 *     you save is not password-protected, and the app says so.
 * MD5 and RC4 are written out below; AES and SHA-2 come from the browser's own Web Crypto.
 */
'use strict';
const KamCrypt = (() => {
  const L = PDFLib, N = n => L.PDFName.of(n);
  const subtle = () => { if (!window.crypto || !crypto.subtle) throw new Error('this browser cannot decrypt PDFs here'); return crypto.subtle; };

  /* ---------- small tools ---------- */
  const concat = (...parts) => {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const same = (a, b, n = a.length) => { if (a.length < n || b.length < n) return false; for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
  const bytesOf = v => (v && typeof v.asBytes === 'function' ? v.asBytes() : new Uint8Array(0));
  const hexOf = b => Array.from(b, v => (v < 16 ? '0' : '') + v.toString(16)).join('');

  /* ---------- MD5 (RFC 1321) ---------- */
  const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const MD5_K = new Int32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0);
  function md5(data) {
    const len = data.length, blocks = ((len + 8) >>> 6) + 1, w = new Int32Array(blocks * 16);
    for (let i = 0; i < len; i++) w[i >> 2] |= data[i] << ((i & 3) * 8);
    w[len >> 2] |= 0x80 << ((len & 3) * 8);
    w[blocks * 16 - 2] = (len * 8) | 0; w[blocks * 16 - 1] = Math.floor(len / 0x20000000);
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    for (let o = 0; o < w.length; o += 16) {
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
        else { f = c ^ (b | ~d); g = (7 * i) & 15; }
        const s = MD5_S[(i >> 4) * 4 + (i & 3)], x = (a + f + MD5_K[i] + w[o + g]) | 0;
        a = d; d = c; c = b; b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
      }
      a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
    }
    const out = new Uint8Array(16);
    [a0, b0, c0, d0].forEach((v, i) => { for (let j = 0; j < 4; j++) out[i * 4 + j] = (v >>> (8 * j)) & 255; });
    return out;
  }

  /* ---------- RC4 ---------- */
  function rc4(key, data) {
    const S = new Uint8Array(256); for (let i = 0; i < 256; i++) S[i] = i;
    for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; const t = S[i]; S[i] = S[j]; S[j] = t; }
    const out = new Uint8Array(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k++) {
      i = (i + 1) & 255; j = (j + S[i]) & 255; const t = S[i]; S[i] = S[j]; S[j] = t;
      out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
    }
    return out;
  }

  /* ---------- AES and SHA-2, from Web Crypto ---------- */
  const keys = new Map();
  async function aesKey(raw, use) {
    const k = hexOf(raw) + use;
    let p = keys.get(k);
    if (!p) { p = subtle().importKey('raw', raw, 'AES-CBC', false, [use]); keys.set(k, p); if (keys.size > 64) keys.delete(keys.keys().next().value); }
    return p;
  }
  // CBC with no padding. Web Crypto always pads, so: encrypt, and drop the padding block it adds.
  async function aesEncryptRaw(key, iv, data) {
    const out = new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv }, await aesKey(key, 'encrypt'), data));
    return out.subarray(0, data.length);
  }
  // Decrypting with no padding: add one more block that decrypts to a full block of padding, so
  // Web Crypto has padding to take off, and nothing of the data is lost.
  async function aesDecryptRaw(key, iv, data) {
    if (!data.length || data.length % 16) return null;
    const last = data.subarray(data.length - 16), pad = new Uint8Array(16).fill(16).map((v, i) => v ^ last[i]);
    const extra = (await aesEncryptRaw(key, new Uint8Array(16), pad)).subarray(0, 16);
    return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv }, await aesKey(key, 'decrypt'), concat(data, extra)));
  }
  // A string or stream as PDFs store it: 16 bytes of IV, then CBC with the usual padding (which a
  // few writers get wrong: then the raw blocks are kept, and any padding that looks right removed).
  async function aesDecrypt(key, data) {
    if (data.length < 32 || data.length % 16) return data.length === 16 ? new Uint8Array(0) : data;
    const iv = data.subarray(0, 16), body = data.subarray(16);
    try { return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv }, await aesKey(key, 'decrypt'), body)); }
    catch (e) {
      const raw = await aesDecryptRaw(key, iv, body); if (!raw) return data;
      const n = raw[raw.length - 1];
      return n >= 1 && n <= 16 && raw.subarray(raw.length - n).every(v => v === n) ? raw.subarray(0, raw.length - n) : raw;
    }
  }
  const sha = async (alg, data) => new Uint8Array(await subtle().digest(alg, data));

  /* ---------- the standard security handler ---------- */
  const PAD = Uint8Array.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A'.match(/../g).map(h => parseInt(h, 16)));
  // Passwords up to revision 4 are Latin-1 bytes, padded to 32; from revision 5, UTF-8.
  const padded = pw => { const b = Uint8Array.from([...pw].map(c => c.charCodeAt(0) & 255)).subarray(0, 32); return concat(b, PAD.subarray(0, 32 - b.length)); };
  const utf8 = pw => new TextEncoder().encode(pw.normalize('NFKC')).subarray(0, 127);
  const int32le = v => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v | 0, true); return b; };

  // Algorithm 2: the file key from a (padded) user password.
  function key234(enc, pw) {
    const n = enc.n;
    let h = md5(concat(pw, enc.O.subarray(0, 32), int32le(enc.P), enc.id, enc.R >= 4 && !enc.meta ? new Uint8Array([255, 255, 255, 255]) : new Uint8Array(0)));
    if (enc.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
    return h.subarray(0, n);
  }
  // Algorithms 4 and 5: is it the user password? The file key if so.
  function user234(enc, pw) {
    const key = key234(enc, pw);
    let u;
    if (enc.R === 2) u = rc4(key, PAD);
    else { u = rc4(key, md5(concat(PAD, enc.id))); for (let i = 1; i <= 19; i++) u = rc4(key.map(b => b ^ i), u); }
    return same(u, enc.U, enc.R === 2 ? 32 : 16) ? key : null;
  }
  // Algorithm 7: the owner password unlocks the user password, which gives the key.
  function owner234(enc, pw) {
    let h = md5(padded(pw));
    if (enc.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, enc.n));
    const k = h.subarray(0, enc.n);
    let u = enc.O.subarray(0, 32);
    if (enc.R === 2) u = rc4(k, u);
    else for (let i = 19; i >= 0; i--) u = rc4(k.map(b => b ^ i), u);
    return user234(enc, u);
  }
  // Algorithm 2.B (revision 6), or plain SHA-256 (revision 5).
  async function hash6(enc, pw, salt, udata) {
    let k = await sha('SHA-256', concat(pw, salt, udata));
    if (enc.R === 5) return k;
    let e = new Uint8Array([0]);
    for (let i = 0; i < 64 || e[e.length - 1] > i - 32; i++) {
      const one = concat(pw, k, udata), k1 = new Uint8Array(one.length * 64);
      for (let j = 0; j < 64; j++) k1.set(one, j * one.length);
      e = await aesEncryptRaw(k.subarray(0, 16), k.subarray(16, 32), k1);
      let sum = 0; for (let j = 0; j < 16; j++) sum += e[j];
      k = await sha(['SHA-256', 'SHA-384', 'SHA-512'][sum % 3], e);
    }
    return k.subarray(0, 32);
  }
  async function user56(enc, pw) {
    const p = utf8(pw);
    if (!same(await hash6(enc, p, enc.U.subarray(32, 40), new Uint8Array(0)), enc.U, 32)) return null;
    return aesDecryptRaw(await hash6(enc, p, enc.U.subarray(40, 48), new Uint8Array(0)), new Uint8Array(16), enc.UE);
  }
  async function owner56(enc, pw) {
    const p = utf8(pw), u = enc.U.subarray(0, 48);
    if (!same(await hash6(enc, p, enc.O.subarray(32, 40), u), enc.O, 32)) return null;
    return aesDecryptRaw(await hash6(enc, p, enc.O.subarray(40, 48), u), new Uint8Array(16), enc.OE);
  }
  // Try a password as the user password, then as the owner's. The file key, or null.
  async function unlock(enc, pw) {
    if (enc.R <= 4) return user234(enc, padded(pw)) || owner234(enc, pw);
    return (await user56(enc, pw)) || (await owner56(enc, pw));
  }

  /* ---------- what the file says about its protection ---------- */
  function describe(doc) {
    const ctx = doc.context, t = ctx.trailerInfo, dict = ctx.lookup(t.Encrypt);
    if (!(dict instanceof L.PDFDict)) throw new Error('its protection could not be read');
    const name = k => { const v = dict.lookup(N(k)); return v instanceof L.PDFName ? v.decodeText() : null; };
    const num = (k, d) => { const v = dict.lookup(N(k)); return v instanceof L.PDFNumber ? v.asNumber() : d; };
    if (name('Filter') !== 'Standard') throw new Error(`it is protected with a certificate (${name('Filter') || 'unknown'}), not a password, which this app cannot open`);
    const V = num('V', 0), R = num('R', 2);
    const idArr = t.ID instanceof L.PDFArray ? t.ID : ctx.lookup(t.ID);
    const id = idArr instanceof L.PDFArray && idArr.size() ? bytesOf(idArr.lookup(0)) : new Uint8Array(0);
    const cfOf = which => {                              // crypt filter for streams or strings
      if (V < 4) return 'V2';
      const f = name(which) || 'Identity'; if (f === 'Identity') return 'None';
      const cf = dict.lookup(N('CF')), d = cf instanceof L.PDFDict ? cf.lookup(N(f)) : null;
      const m = d instanceof L.PDFDict ? d.lookup(N('CFM')) : null;
      return m instanceof L.PDFName ? m.decodeText() : 'None';
    };
    const meta = dict.lookup(N('EncryptMetadata'));
    const enc = {
      V, R, P: num('P', -1), id, O: bytesOf(dict.lookup(N('O'))), U: bytesOf(dict.lookup(N('U'))),
      OE: bytesOf(dict.lookup(N('OE'))), UE: bytesOf(dict.lookup(N('UE'))),
      meta: !(meta instanceof L.PDFBool) || meta.asBoolean(),
      stm: cfOf('StmF'), str: cfOf('StrF'),
    };
    enc.n = R === 2 ? 5 : R >= 5 ? 32 : V >= 4 ? 16 : Math.max(5, Math.min(16, num('Length', 40) / 8));
    if (R < 2 || R > 6 || !['V2', 'AESV2', 'AESV3', 'None'].includes(enc.stm) || !['V2', 'AESV2', 'AESV3', 'None'].includes(enc.str))
      throw new Error(`it uses a kind of protection this app does not know (revision ${R})`);
    return enc;
  }

  /* ---------- decrypting ---------- */
  // What undoes the protection of one string or stream of object (num, gen).
  function decrypter(enc, key) {
    return async (kind, num, gen, data) => {
      const cfm = kind === 'stream' ? enc.stm : enc.str;
      if (cfm === 'None') return data;
      if (cfm === 'AESV3') return aesDecrypt(key, data);
      const ref = new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
      const k = md5(concat(key, ref, cfm === 'AESV2' ? new Uint8Array([0x73, 0x41, 0x6C, 0x54]) : new Uint8Array(0))).subarray(0, Math.min(key.length + 5, 16));
      return cfm === 'AESV2' ? aesDecrypt(k, data) : rc4(k, data);
    };
  }
  // Every string and stream in the document, except the few the standard leaves in the clear.
  async function decryptAll(doc, dec, encRef, fromStreams) {
    const ctx = doc.context;
    const walk = async (obj, num, gen) => {
      if (obj instanceof L.PDFString || obj instanceof L.PDFHexString) return L.PDFHexString.of(hexOf(await dec('string', num, gen, obj.asBytes())));
      if (obj instanceof L.PDFArray) { for (let i = 0; i < obj.size(); i++) { const v = obj.get(i), w = await walk(v, num, gen); if (w !== v) obj.set(i, w); } return obj; }
      if (obj instanceof L.PDFDict) {
        // a signature's /Contents is the one string left unencrypted
        const sig = obj.get(N('Type')) === N('Sig') || obj.has(N('ByteRange'));
        for (const [k, v] of obj.entries()) {
          if (sig && k === N('Contents')) continue;
          const w = await walk(v, num, gen); if (w !== v) obj.set(k, w);
        }
        return obj;
      }
      return obj;
    };
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (encRef && ref.tag === encRef.tag) continue;
      if (fromStreams.has(ref.tag)) continue;           // came out of an object stream, which was decrypted whole
      const num = ref.objectNumber, gen = ref.generationNumber;
      if (obj instanceof L.PDFRawStream) {
        const type = obj.dict.get(N('Type'));
        if (type === N('XRef')) continue;
        await walk(obj.dict, num, gen);
        if (type === N('Metadata') && !dec.meta) continue;
        obj.contents = await dec('stream', num, gen, obj.contents);
      } else await walk(obj, num, gen);
    }
  }

  /* Read a PDF with pdf-lib, decrypting it if it is protected. Object streams (many objects packed
     into one compressed stream) are themselves encrypted, so they are decrypted as the file is
     read, before pdf-lib unpacks them; the hooks that do this only touch this one document. */
  async function parse(bytes, mode, dec) {
    const parser = L.PDFParser.forBytesWithOptions(bytes, 100, false, false);
    const ctx = parser.context, fromStreams = new Set();
    let lastRef = null, inStream = false;
    const header = parser.parseIndirectObjectHeader;
    parser.parseIndirectObjectHeader = function () { const r = header.call(this); lastRef = r; return r; };
    const assign = ctx.assign;
    ctx.assign = function (ref, obj) { if (inStream) fromStreams.add(ref.tag); else fromStreams.delete(ref.tag); return assign.call(this, ref, obj); };
    const forStream = L.PDFObjectStreamParser.forStream;
    L.PDFObjectStreamParser.forStream = function (raw, tick) {
      if (!raw || !raw.dict || raw.dict.context !== ctx) return forStream.call(this, raw, tick);
      if (mode === 'peek') return { parseIntoContext: async () => { } };     // only the trailer is wanted
      const at = lastRef;
      return {
        parseIntoContext: async () => {
          if (at) raw.contents = await dec('stream', at.objectNumber, at.generationNumber, raw.contents);
          inStream = true;
          try { await forStream.call(L.PDFObjectStreamParser, raw, tick).parseIntoContext(); } finally { inStream = false; }
        },
      };
    };
    try { await parser.parseDocument(); } finally { L.PDFObjectStreamParser.forStream = forStream; }
    ctx.assign = assign;
    return { doc: new L.PDFDocument(ctx, true, false), fromStreams };
  }

  /* Open PDF bytes with pdf-lib. `ask(tries)` is asked for a password when one is needed, and
     returns it, or null to give up. Resolves to { doc, locked }: locked says how the file was
     protected ('owner' or 'user'), or is false. */
  async function open(input, ask) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let doc, first = null;
    try { doc = await L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }); }
    catch (e) { first = e; }
    if (!doc) {
      // a protected file with object streams cannot even be read without its key: read just
      // enough of it to see how it is protected
      let peek;
      try { peek = (await parse(bytes, 'peek')).doc; } catch (e) { throw first; }
      if (!peek.isEncrypted) throw first;
      doc = peek;
    }
    if (!doc.isEncrypted) return { doc, locked: false };
    const enc = describe(doc), encRef = doc.context.trailerInfo.Encrypt;
    let key = await unlock(enc, ''), locked = 'owner';
    for (let tries = 0; !key; tries++) {
      locked = 'user';
      const pw = await ask(tries);
      if (pw === null || pw === undefined) throw Object.assign(new Error('it needs a password to open'), { cancelled: true });
      key = await unlock(enc, pw);
    }
    const dec = decrypter(enc, key); dec.meta = enc.meta;
    const { doc: plain, fromStreams } = await parse(bytes, 'decrypt', dec);
    await decryptAll(plain, dec, encRef instanceof L.PDFRef ? encRef : null, fromStreams);
    // no longer protected: drop the protection, so it is saved as an ordinary PDF
    if (encRef instanceof L.PDFRef) plain.context.delete(encRef);
    plain.context.trailerInfo.Encrypt = undefined;
    plain.isEncrypted = false;
    return { doc: plain, locked };
  }

  return { open, md5, rc4, _internal: { hash6, aesDecryptRaw, aesEncryptRaw, describe } };
})();
