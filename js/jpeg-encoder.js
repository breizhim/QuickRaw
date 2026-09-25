// Encodeur JPEG baseline en JavaScript pur.
// - sous-échantillonnage 4:4:4 (aucune perte de chroma)
// - qualité 1..100 (100 = tables de quantification à 1)
// - écriture ligne de blocs par ligne de blocs via un callback, pour ne pas
//   avoir à garder l'image RGBA complète en mémoire (utile en pleine résolution)
// - segment APP1 EXIF optionnel
// Pourquoi ne pas utiliser canvas.toBlob ? Les navigateurs mobiles limitent la
// surface des canvas (≈16 Mpx sur iOS) : impossible d'exporter en pleine résolution.

const ZIGZAG = new Int32Array([
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42,
  3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60,
  21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
]);

const STD_Y_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_C_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

// Tables de Huffman standard (Annexe K)
const DC_L_NRCODES = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_L_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_L_NRCODES = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_L_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];
const DC_C_NRCODES = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_C_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_C_NRCODES = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_C_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

function buildHuffman(nrcodes, values) {
  // table[value] = [code, length]
  const codes = new Int32Array(256), lens = new Int32Array(256);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let j = 0; j < nrcodes[len]; j++) {
      codes[values[k]] = code; lens[values[k]] = len; k++; code++;
    }
    code <<= 1;
  }
  return { codes, lens };
}

const HT = {
  YDC: buildHuffman(DC_L_NRCODES, DC_L_VALUES), YAC: buildHuffman(AC_L_NRCODES, AC_L_VALUES),
  CDC: buildHuffman(DC_C_NRCODES, DC_C_VALUES), CAC: buildHuffman(AC_C_NRCODES, AC_C_VALUES),
};

const AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379];

function quantTables(quality) {
  quality = Math.max(1, Math.min(100, Math.round(quality)));
  const sf = quality < 50 ? Math.floor(5000 / quality) : Math.floor(200 - quality * 2);
  const make = (std) => {
    const q = new Uint8Array(64); // ordre naturel
    for (let i = 0; i < 64; i++) {
      let v = Math.floor((std[i] * sf + 50) / 100);
      q[i] = v < 1 ? 1 : v > 255 ? 255 : v;
    }
    return q;
  };
  const yq = make(STD_Y_Q), cq = make(STD_C_Q);
  // Diviseurs flottants pour la DCT AAN (inclut l'échelle AAN et le facteur 8)
  const fdiv = (q) => {
    const f = new Float64Array(64);
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const i = r * 8 + c;
      f[i] = 1.0 / (q[i] * AAN[r] * AAN[c] * 8.0);
    }
    return f;
  };
  return { yq, cq, yf: fdiv(yq), cf: fdiv(cq) };
}

// ---------- Flux de sortie ----------
class ByteWriter {
  constructor(cap = 1 << 22) { this.buf = new Uint8Array(cap); this.pos = 0; this.chunks = []; this.total = 0; }
  flush() {
    if (this.pos) { this.chunks.push(this.buf.slice(0, this.pos)); this.total += this.pos; this.pos = 0; }
  }
  byte(v) { if (this.pos >= this.buf.length) this.flush(); this.buf[this.pos++] = v; }
  word(v) { this.byte((v >> 8) & 0xff); this.byte(v & 0xff); }
  bytes(arr) { for (let i = 0; i < arr.length; i++) this.byte(arr[i]); }
}

export class JpegEncoder {
  /**
   * @param {number} width
   * @param {number} height
   * @param {{quality?:number, exif?:Uint8Array|null, headers?:boolean, restartInterval?:number}} opts
   *   headers=false : n'écrit que les données entropiques (encodage d'une bande en parallèle)
   *   restartInterval : nombre de MCU entre marqueurs RST (segment DRI)
   */
  constructor(width, height, opts = {}) {
    this.w = width; this.h = height;
    this.q = quantTables(opts.quality ?? 100);
    this.out = new ByteWriter(opts.headers === false ? 1 << 20 : 1 << 22);
    this.bitBuf = 0; this.bitCnt = 0;
    this.dcY = 0; this.dcU = 0; this.dcV = 0;
    this.blkY = new Float64Array(64); this.blkU = new Float64Array(64); this.blkV = new Float64Array(64);
    this.qout = new Int32Array(64);
    if (opts.headers !== false) this.writeHeaders(opts.exif || null, opts.restartInterval || 0);
  }

  writeHeaders(exif, restartInterval = 0) {
    const o = this.out;
    o.word(0xffd8); // SOI
    // APP0 JFIF
    o.word(0xffe0); o.word(16); o.bytes([0x4a, 0x46, 0x49, 0x46, 0]); o.byte(1); o.byte(1);
    o.byte(0); o.word(1); o.word(1); o.byte(0); o.byte(0);
    if (exif) { // APP1 EXIF
      o.word(0xffe1); o.word(exif.length + 2); o.bytes(exif);
    }
    // DQT
    o.word(0xffdb); o.word(132);
    o.byte(0); for (let i = 0; i < 64; i++) o.byte(this.q.yq[ZIG_INV[i]]);
    o.byte(1); for (let i = 0; i < 64; i++) o.byte(this.q.cq[ZIG_INV[i]]);
    // SOF0
    o.word(0xffc0); o.word(17); o.byte(8); o.word(this.h); o.word(this.w); o.byte(3);
    o.byte(1); o.byte(0x11); o.byte(0);
    o.byte(2); o.byte(0x11); o.byte(1);
    o.byte(3); o.byte(0x11); o.byte(1);
    // DHT
    o.word(0xffc4); o.word(0x01a2);
    const dht = (cls, nr, vals) => { o.byte(cls); for (let i = 1; i <= 16; i++) o.byte(nr[i]); o.bytes(vals); };
    dht(0x00, DC_L_NRCODES, DC_L_VALUES); dht(0x10, AC_L_NRCODES, AC_L_VALUES);
    dht(0x01, DC_C_NRCODES, DC_C_VALUES); dht(0x11, AC_C_NRCODES, AC_C_VALUES);
    // DRI
    if (restartInterval) { o.word(0xffdd); o.word(4); o.word(restartInterval); }
    // SOS
    o.word(0xffda); o.word(12); o.byte(3);
    o.byte(1); o.byte(0x00); o.byte(2); o.byte(0x11); o.byte(3); o.byte(0x11);
    o.byte(0); o.byte(0x3f); o.byte(0);
  }

  writeBits(code, len) {
    // accumulateur 32 bits ; on vide octet par octet (avec bourrage 0xFF00)
    this.bitBuf = (this.bitBuf << len) | (code & ((1 << len) - 1));
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      const b = (this.bitBuf >>> (this.bitCnt - 8)) & 0xff;
      this.out.byte(b); if (b === 0xff) this.out.byte(0);
      this.bitCnt -= 8;
    }
    this.bitBuf &= (1 << this.bitCnt) - 1;
  }

  // DCT flottante AAN (d'après jfdctflt de l'IJG) + quantification
  fdctQuant(data, fdiv, out) {
    for (let p = 0; p < 64; p += 8) {
      const d0 = data[p], d1 = data[p + 1], d2 = data[p + 2], d3 = data[p + 3];
      const d4 = data[p + 4], d5 = data[p + 5], d6 = data[p + 6], d7 = data[p + 7];
      const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6;
      const t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;
      let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
      data[p] = t10 + t11; data[p + 4] = t10 - t11;
      const z1 = (t12 + t13) * 0.707106781;
      data[p + 2] = t13 + z1; data[p + 6] = t13 - z1;
      t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
      const z5 = (t10 - t12) * 0.382683433, z2 = 0.541196100 * t10 + z5;
      const z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
      const z11 = t7 + z3, z13 = t7 - z3;
      data[p + 5] = z13 + z2; data[p + 3] = z13 - z2;
      data[p + 1] = z11 + z4; data[p + 7] = z11 - z4;
    }
    for (let p = 0; p < 8; p++) {
      const d0 = data[p], d1 = data[p + 8], d2 = data[p + 16], d3 = data[p + 24];
      const d4 = data[p + 32], d5 = data[p + 40], d6 = data[p + 48], d7 = data[p + 56];
      const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6;
      const t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;
      let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
      data[p] = t10 + t11; data[p + 32] = t10 - t11;
      const z1 = (t12 + t13) * 0.707106781;
      data[p + 16] = t13 + z1; data[p + 48] = t13 - z1;
      t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
      const z5 = (t10 - t12) * 0.382683433, z2 = 0.541196100 * t10 + z5;
      const z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
      const z11 = t7 + z3, z13 = t7 - z3;
      data[p + 40] = z13 + z2; data[p + 24] = z13 - z2;
      data[p + 8] = z11 + z4; data[p + 56] = z11 - z4;
    }
    for (let i = 0; i < 64; i++) {
      let v = Math.round(data[i] * fdiv[i]);
      if (v > 2047) v = 2047; else if (v < -2048) v = -2048;
      out[ZIGZAG[i]] = v;
    }
  }

  encodeBlock(data, fdiv, dcPrev, dcT, acT) {
    const q = this.qout;
    this.fdctQuant(data, fdiv, q);
    // DC
    const diff = q[0] - dcPrev;
    this.writeCoef(diff, dcT, -1);
    // AC
    let run = 0;
    let last = 63; while (last > 0 && q[last] === 0) last--;
    for (let i = 1; i <= last; i++) {
      const v = q[i];
      if (v === 0) { run++; continue; }
      while (run >= 16) { this.writeBits(acT.codes[0xf0], acT.lens[0xf0]); run -= 16; }
      this.writeCoef(v, acT, run);
      run = 0;
    }
    if (last < 63) this.writeBits(acT.codes[0], acT.lens[0]); // EOB
    return q[0];
  }

  writeCoef(v, table, run) {
    const a = v < 0 ? -v : v;
    let nb = 0; for (let t = a; t; t >>= 1) nb++;
    const sym = run < 0 ? nb : (run << 4) | nb;
    this.writeBits(table.codes[sym], table.lens[sym]);
    if (nb) this.writeBits(v < 0 ? v + (1 << nb) - 1 : v, nb);
  }

  /**
   * Encode une bande de 8 lignes (ou moins pour la dernière).
   * @param {Uint8Array} rgb  pixels RVB (3 octets/pixel), `rows` lignes de largeur w
   * @param {number} rows     nombre de lignes valides (1..8)
   */
  encodeStrip(rgb, rows) {
    const w = this.w, Y = this.blkY, U = this.blkU, V = this.blkV;
    const q = this.q;
    for (let bx = 0; bx < w; bx += 8) {
      for (let r = 0; r < 8; r++) {
        const yy = r < rows ? r : rows - 1;
        for (let c = 0; c < 8; c++) {
          const xx = bx + c < w ? bx + c : w - 1;
          const s = (yy * w + xx) * 3;
          const R = rgb[s], G = rgb[s + 1], B = rgb[s + 2];
          const k = r * 8 + c;
          Y[k] = 0.299 * R + 0.587 * G + 0.114 * B - 128;
          U[k] = -0.168736 * R - 0.331264 * G + 0.5 * B;
          V[k] = 0.5 * R - 0.418688 * G - 0.081312 * B;
        }
      }
      this.dcY = this.encodeBlock(Y, q.yf, this.dcY, HT.YDC, HT.YAC);
      this.dcU = this.encodeBlock(U, q.cf, this.dcU, HT.CDC, HT.CAC);
      this.dcV = this.encodeBlock(V, q.cf, this.dcV, HT.CDC, HT.CAC);
    }
  }

  padBits() {
    if (this.bitCnt > 0) this.writeBits((1 << (8 - this.bitCnt)) - 1, 8 - this.bitCnt); // bourrage à 1
  }

  // Marqueur de reprise RSTn : aligne sur l'octet et remet à zéro les prédicteurs DC
  restart(n) {
    this.padBits();
    this.out.byte(0xff); this.out.byte(0xd0 + (n & 7));
    this.dcY = this.dcU = this.dcV = 0;
  }

  finish(eoi = true) {
    this.padBits();
    if (eoi) this.out.word(0xffd9); // EOI
    this.out.flush();
    return this.out.chunks;
  }

  // Octets écrits jusqu'ici (en-têtes seuls si aucune bande encodée)
  takeBytes() { this.out.flush(); const c = this.out.chunks; this.out.chunks = []; return c; }
}

const ZIG_INV = (() => { const z = new Int32Array(64); for (let i = 0; i < 64; i++) z[ZIGZAG[i]] = i; return z; })();

// ---------- EXIF ----------
// champs : { make, model, software, dateTime ('YYYY:MM:DD HH:MM:SS'), exposureTime (s),
//           fNumber, iso, focalLength, lensModel, artist, description, width, height }
export function buildExif(f) {
  const ifd0 = [], exif = [];
  const ascii = (s) => { const a = [...new TextEncoder().encode(String(s))]; a.push(0); return a; };
  const rat = (v) => {
    if (!isFinite(v) || v <= 0) return null;
    if (v < 1) return [1, Math.round(1 / v)];
    let den = 1; while (Math.abs(v * den - Math.round(v * den)) > 1e-6 && den < 100000) den *= 10;
    return [Math.round(v * den), den];
  };
  if (f.description) ifd0.push([0x010e, 2, ascii(f.description)]);
  if (f.make) ifd0.push([0x010f, 2, ascii(f.make)]);
  if (f.model) ifd0.push([0x0110, 2, ascii(f.model)]);
  ifd0.push([0x0112, 3, [1]]); // orientation normale (déjà appliquée aux pixels)
  ifd0.push([0x0131, 2, ascii(f.software || 'QuickRaw')]);
  if (f.dateTime) ifd0.push([0x0132, 2, ascii(f.dateTime)]);
  if (f.artist) ifd0.push([0x013b, 2, ascii(f.artist)]);
  const et = rat(f.exposureTime); if (et) exif.push([0x829a, 5, [et]]);
  const fn = rat(f.fNumber); if (fn) exif.push([0x829d, 5, [fn]]);
  if (f.iso > 0) exif.push([0x8827, 3, [Math.min(65535, Math.round(f.iso))]]);
  exif.push([0x9000, 7, [0x30, 0x32, 0x33, 0x32]]); // ExifVersion 0232
  if (f.dateTime) { exif.push([0x9003, 2, ascii(f.dateTime)]); exif.push([0x9004, 2, ascii(f.dateTime)]); }
  const fl = rat(f.focalLength); if (fl) exif.push([0x920a, 5, [fl]]);
  exif.push([0xa001, 3, [1]]); // ColorSpace sRGB
  if (f.width) exif.push([0xa002, 4, [f.width]]);
  if (f.height) exif.push([0xa003, 4, [f.height]]);
  if (f.lensModel) exif.push([0xa434, 2, ascii(f.lensModel)]);
  ifd0.push([0x8769, 4, [0]]); // pointeur Exif IFD (corrigé plus bas)
  ifd0.sort((a, b) => a[0] - b[0]); exif.sort((a, b) => a[0] - b[0]);

  const typeSize = { 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
  const bytes = [];
  const w16 = (v, at) => { if (at === undefined) bytes.push(v & 0xff, (v >> 8) & 0xff); else { bytes[at] = v & 0xff; bytes[at + 1] = (v >> 8) & 0xff; } };
  const w32 = (v, at) => {
    const b = [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    if (at === undefined) bytes.push(...b); else for (let i = 0; i < 4; i++) bytes[at + i] = b[i];
  };
  const ifdSize = (ents) => 2 + ents.length * 12 + 4 + ents.reduce((s, e) => {
    const n = e[1] === 5 ? e[2].length * 8 : e[2].length * typeSize[e[1]];
    return s + (n > 4 ? n + (n & 1) : 0);
  }, 0);
  const writeIfd = (ents, start) => {
    let extra = start + 2 + ents.length * 12 + 4;
    const pending = [];
    w16(ents.length);
    for (const [tag, type, vals] of ents) {
      const count = vals.length;
      const n = type === 5 ? count * 8 : count * typeSize[type];
      w16(tag); w16(type); w32(count);
      const data = [];
      for (const v of vals) {
        if (type === 5) { data.push(...le32(v[0]), ...le32(v[1])); }
        else if (type === 3) data.push(v & 0xff, (v >> 8) & 0xff);
        else if (type === 4) data.push(...le32(v));
        else data.push(v);
      }
      if (n <= 4) { while (data.length < 4) data.push(0); bytes.push(...data); }
      else { w32(extra); pending.push(data); extra += n + (n & 1); }
    }
    w32(0); // pas d'IFD suivant
    for (const d of pending) { bytes.push(...d); if (d.length & 1) bytes.push(0); }
  };
  // "Exif\0\0" + en-tête TIFF little-endian
  bytes.push(0x45, 0x78, 0x69, 0x66, 0, 0);
  const T = 6;
  bytes.push(0x49, 0x49); w16(42); w32(8);
  const ifd0Start = 8;
  const exifStart = ifd0Start + ifdSize(ifd0);
  // corrige le pointeur Exif avant écriture
  ifd0.find((e) => e[0] === 0x8769)[2] = [exifStart];
  writeIfd(ifd0, ifd0Start);
  writeIfd(exif, exifStart);
  void T;
  return new Uint8Array(bytes);
}
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
