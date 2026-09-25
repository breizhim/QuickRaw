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

export function readLevel(exif) {
  const cands = [exif?.ifd0?.DNGPrivateData, exif?.ifd0?.[50740], exif?.exif?.MakerNote, exif?.exif?.[37500], exif?.makerNote];
  const model = String(exif?.ifd0?.Model || '');
  for (const c of cands) {
    if (!c || !c.length) continue;
    try {
      const r = parseMakerNote(toU8(c), model);
      if (r) return r;
    } catch { /* bloc illisible : on essaie le suivant */ }
  }
  return null;
}

const toU8 = (c) => (c instanceof Uint8Array ? c : ArrayBuffer.isView(c) ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength) : new Uint8Array(c));
const ascii = (u, a, n) => String.fromCharCode(...u.subarray(a, a + n));

function parseMakerNote(u, model) {
  // DNG converti par Adobe : « Adobe\0 » « MakN » taille(4) ordre(2) offset d'origine(4) puis la maker note
  if (ascii(u, 0, 6) === 'Adobe\0' && ascii(u, 6, 4) === 'MakN') return parseMakerNote(u.subarray(20), model);
  let le, ifd, base = 0;
  if (ascii(u, 0, 6) === 'RICOH\0') { le = ascii(u, 6, 2) === 'II'; ifd = 8; }            // GR III / IIIx / IV
  else if (ascii(u, 0, 8) === 'PENTAX \0') { le = ascii(u, 8, 2) === 'II'; ifd = 10; }     // Pentax récents
  else if (ascii(u, 0, 4) === 'AOC\0') { le = ascii(u, 4, 2) === 'II'; ifd = 6; }          // Pentax (offsets approximatifs)
  else return null;
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const n = dv.getUint16(ifd, le);
  if (n === 0 || n > 1000) return null;
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (dv.getUint16(e, le) !== 0x022b) continue;
    const count = dv.getUint32(e + 4, le);
    const off = count <= 4 ? e + 8 : base + dv.getUint32(e + 8, le);
    if (off + count > u.length) return null;
    const b = u.subarray(off, off + count);
    let roll, pitch;
    if (/K-3 Mark III/.test(model)) {
      const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
      roll = -d.getInt16(3, le) / 2; pitch = -d.getInt16(5, le) / 2;
    } else {
      const s8 = (v) => (v > 127 ? v - 256 : v);
      roll = -s8(b[1]) / 2; pitch = -s8(b[2]) / 2;
    }
    const orient = b[0] & 0x0f; // 0 = n/a, 1..4 orientation, 9..12 « Off Level », 13/14 vers le haut/bas
    return { roll, pitch, orientation: orient, raw: Array.from(b.subarray(0, 8)) };
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
