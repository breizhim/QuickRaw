// Lecture du niveau électronique (inclinaison mesurée par l'appareil au moment
// de la prise de vue) dans les maker notes Pentax / Ricoh — Ricoh GR III,
// GR IIIx, GR IV, Pentax K-5 et suivants…
// Tag 0x022B « LevelInfo » (cf. ExifTool, Pentax.pm) : octets signés,
//   [1] RollAngle  : -val/2 = degrés de rotation horaire de l'appareil
//   [2] PitchAngle : -val/2 = degrés d'inclinaison vers le haut
// K-3 Mark III : int16s aux octets 3 (roulis) et 5 (tangage), même échelle.
//
// Les maker notes se trouvent dans l'EXIF (0x927C) des JPEG/PEF, ou dans le
// bloc DNGPrivateData (0xC634) des DNG : « RICOH\0II… » (DNG de l'appareil)
// ou « Adobe\0MakN… » (DNG converti par Adobe).

// Lit une balise des maker notes Pentax / Ricoh : { type, count, bytes, le } ou null
export function readMakerTag(exif, wanted) {
  const cands = [exif?.ifd0?.DNGPrivateData, exif?.ifd0?.[50740], exif?.exif?.MakerNote, exif?.exif?.[37500], exif?.makerNote];
  for (const c of cands) {
    if (!c || !c.length) continue;
    try {
      const r = findTag(toU8(c), wanted);
      if (r) return r;
    } catch { /* bloc illisible : on essaie le suivant */ }
  }
  return null;
}

export function readLevel(exif) {
  const t = readMakerTag(exif, 0x022b);
  if (!t) return null;
  const b = t.bytes, model = String(exif?.ifd0?.Model || '');
  let roll, pitch;
  if (/K-3 Mark III/.test(model)) {
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    roll = -d.getInt16(3, t.le) / 2; pitch = -d.getInt16(5, t.le) / 2;
  } else {
    const s8 = (v) => (v > 127 ? v - 256 : v);
    roll = -s8(b[1]) / 2; pitch = -s8(b[2]) / 2;
  }
  const orient = b[0] & 0x0f; // 0 = n/a, 1..4 orientation, 9..12 « Off Level », 13/14 vers le haut/bas
  return { roll, pitch, orientation: orient, raw: Array.from(b.subarray(0, 8)) };
}

// Mode « Image Control » du boîtier (tag 0x004F, ImageTone chez ExifTool)
const IMAGE_TONES = {
  0: 'Natural', 1: 'Bright', 2: 'Portrait', 3: 'Landscape', 4: 'Vibrant', 5: 'Monochrome', 6: 'Muted',
  7: 'Reversal Film', 8: 'Bleach Bypass', 9: 'Radiant', 10: 'Cross Processing', 11: 'Flat',
  256: 'Standard', 257: 'Vivid', 258: 'Monotone', 259: 'Soft Monotone', 260: 'Hard Monotone',
  261: 'Hi-contrast B&W', 262: 'Positive Film', 263: 'Bleach Bypass 2', 264: 'Retro', 265: 'HDR Tone',
  266: 'Cross Processing 2', 267: 'Negative Film', 32768: 'Standard', 32769: 'Hard', 32770: 'Soft', 33024: 'Monochrome',
};
// Filtre QuickRaw le plus proche de chaque mode (null = pas d'équivalent : sans filtre)
const TONE_TO_LOOK = {
  257: 'vivid', 258: 'acros', 259: 'acros', 260: 'grhard', 261: 'provoke', 262: 'grpositive', 263: 'bleach',
  264: 'nostalgic', 267: 'grnegative', 4: 'vivid', 5: 'acros', 7: 'velvia', 8: 'bleach', 6: 'classicchrome',
  33024: 'acros', 32769: 'provoke',
};
export function readCameraMode(exif) {
  const t = readMakerTag(exif, 0x004f);
  if (!t || t.bytes.length < 2) return null;
  const d = new DataView(t.bytes.buffer, t.bytes.byteOffset, t.bytes.byteLength), code = d.getUint16(0, t.le);
  if (!(code in IMAGE_TONES)) return null;
  return { code, name: IMAGE_TONES[code], look: TONE_TO_LOOK[code] || null };
}

const toU8 = (c) => (c instanceof Uint8Array ? c : ArrayBuffer.isView(c) ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength) : new Uint8Array(c));
const ascii = (u, a, n) => String.fromCharCode(...u.subarray(a, a + n));
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function findTag(u, wanted) {
  // DNG converti par Adobe : « Adobe\0 » « MakN » taille(4) ordre(2) offset d'origine(4) puis la maker note
  if (ascii(u, 0, 6) === 'Adobe\0' && ascii(u, 6, 4) === 'MakN') return findTag(u.subarray(20), wanted);
  let le, ifd;
  const base = 0;
  if (ascii(u, 0, 6) === 'RICOH\0') { le = ascii(u, 6, 2) === 'II'; ifd = 8; }            // GR III / IIIx / IV
  else if (ascii(u, 0, 8) === 'PENTAX \0') { le = ascii(u, 8, 2) === 'II'; ifd = 10; }     // Pentax récents
  else if (ascii(u, 0, 4) === 'AOC\0') { le = ascii(u, 4, 2) === 'II'; ifd = 6; }          // Pentax (offsets approximatifs)
  else return null;
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const n = dv.getUint16(ifd, le);
  if (n === 0 || n > 1000) return null;
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (dv.getUint16(e, le) !== wanted) continue;
    const type = dv.getUint16(e + 2, le), count = dv.getUint32(e + 4, le), size = count * (TYPE_SIZE[type] || 1);
    const off = size <= 4 ? e + 8 : base + dv.getUint32(e + 8, le);
    if (off + size > u.length) return null;
    return { type, count, le, bytes: u.subarray(off, off + size) };
  }
  return null;
}

// Angle de redressage (degrés, positif = rotation horaire de l'image) déduit
// du niveau, ou null si la mesure est absente / inexploitable.
// Appareil tourné de r° dans le sens horaire → l'image doit tourner de r° horaire.
export function levelAngle(level) {
  if (!level) return null;
  const o = level.orientation;
  const measured = (o >= 1 && o <= 4) || (o >= 9 && o <= 12); // 0 = n/a, 13/14 = visée vers le haut / bas
  if (!measured || !Number.isFinite(level.roll) || Math.abs(level.roll) > 45) return null;
  return level.roll;
}

export function describeLevel(level) {
  if (!level) return null;
  const f = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1).replace('.', ',')}°`;
  if (levelAngle(level) === null) return 'présent mais non renseigné par l\'appareil';
  return `roulis ${f(level.roll)} (horaire), tangage ${f(level.pitch)}`;
}
