// Décodage des fichiers (RAW via LibRaw, JPEG/PNG via le navigateur) et
// champs EXIF à recopier dans le JPG exporté. Partagé par l'éditeur et le lot.
import LibRaw from '../vendor/libraw/index.js';
import { srgbDecode } from './pipeline.js';

export const RAW_SETTINGS = {
  outputBps: 16, gamm: [1, 1], noAutoBright: true, useCameraWb: true,
  outputColor: 1, userQual: 3, highlight: 0,
};

const STD_MAGIC = [[0xff, 0xd8, 0xff], [0x89, 0x50, 0x4e, 0x47], [0x52, 0x49, 0x46, 0x46], [0x47, 0x49, 0x46]];
export function isStandardImage(buf) {
  const head = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  return STD_MAGIC.some((m) => m.every((b, i) => head[i] === b));
}

import { INV709, linearize709 } from './linear.js';
export { linearize709 };

// Dématriçage pleine résolution par LibRaw (AHD, mono-cœur) : chemin de repli.
// `buf` est transféré (détaché) vers LibRaw.
export async function decodeFull(buf, { withMeta = false } = {}) {
  const lr = new LibRaw();
  try {
    await lr.open(new Uint8Array(buf), RAW_SETTINGS);
    const raw = withMeta ? await lr.metadata(true) : null;
    const img = await lr.imageData();
    if (!img || !img.data) throw new Error('Décodage impossible');
    const data = toRGB16(img);
    if (img.bits === 16) linearize709(data);
    return { data, width: img.width, height: img.height, raw };
  } finally { lr.dispose(); }
}

// Lecture rapide : aperçu demi-taille (couleurs capteur, sans dématriçage) +
// données brutes du capteur, avec une seule instance LibRaw.
export async function openRaw(buf) {
  const lr = new LibRaw();
  try {
    await lr.open(new Uint8Array(buf), { ...RAW_SETTINGS, halfSize: true, outputColor: 0 });
    const pre = await lr.metadata(false); // dimensions réelles (le traitement demi-taille les remplace ensuite)
    const half = await lr.imageData();
    if (!half || !half.data) throw new Error('Décodage impossible');
    const meta = await lr.metadata(true);
    let raw = null;
    try {
      raw = await lr.rawImageData();
      if (raw) { raw.width = pre.width; raw.height = pre.height; }
    } catch { /* format sans données brutes exploitables */ }
    return { half, meta, raw };
  } finally { lr.dispose(); }
}

export { halfToLinear, rgbCam3 } from './linear.js';

// Calage des noirs et multiplicateurs par canal : chaque pixel de l'aperçu
// demi-taille de LibRaw dépend exactement d'un bloc 2×2 du capteur, ce qui
// permet de retrouver par régression les paramètres réels (y compris ceux que
// la bibliothèque n'expose pas, comme les noirs des DNG). Échoue proprement
// (ok = false) pour les capteurs non Bayer ou si la relation n'est pas exacte.
export function calibrate(half, raw, meta) {
  const fail = (why) => ({ ok: false, why });
  if (!raw || !raw.data || half.colors !== 3) return fail('données brutes indisponibles');
  if (meta?.is_foveon || (meta?.colors && meta.colors !== 3)) return fail('capteur non Bayer');
  const { raw_width: RW, top_margin: T, left_margin: L, width: VW, height: VH } = raw;
  if (!RW || raw.data.length < RW * (raw.raw_height || 0)) return fail('format brut inattendu');
  const W = half.width, H = half.height, hd = half.data, rd = raw.data;
  if (Math.abs(2 * W - VW) > 1 || Math.abs(2 * H - VH) > 1) return fail('dimensions incohérentes');
  const lin = (o) => INV709[o];
  const fit = (c, subs) => { // régression lin = s·(v − b)
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (let y = 4; y < H - 4; y += 5) for (let x = 4; x < W - 4; x += 5) {
      const o = hd[(y * W + x) * 3 + c]; if (o < 1500 || o > 63000) continue;
      let v = 0; for (const k of subs) v += rd[(2 * y + (k >> 1) + T) * RW + 2 * x + (k & 1) + L]; v /= subs.length;
      const l = lin(o); n++; sx += v; sy += l; sxx += v * v; sxy += v * l; syy += l * l;
    }
    if (n < 500) return null;
    const s = (n * sxy - sx * sy) / (n * sxx - sx * sx), b = (sx - sy / s) / n;
    const r = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    return { s, b, r };
  };
  const best = (c) => { let bst = null; for (let k = 0; k < 4; k++) { const f = fit(c, [k]); if (f && (!bst || f.r > bst.r)) bst = { ...f, k }; } return bst; };
  const R = best(0), B = best(2);
  if (!R || !B || R.k === B.k || R.k + B.k !== 3) return fail('motif CFA non reconnu');
  const gs = [0, 1, 2, 3].filter((k) => k !== R.k && k !== B.k);
  const G = fit(1, gs);
  if (!G) return fail('pas assez de pixels exploitables');
  const ok = R.r > 0.99995 && B.r > 0.99995 && G.r > 0.9999 && R.s > 0 && G.s > 0 && B.s > 0;
  let cfa = 0;
  cfa |= 0 << (R.k * 2); cfa |= 2 << (B.k * 2); for (const k of gs) cfa |= 1 << (k * 2);
  return { ok, why: ok ? '' : `calage imprécis (${R.r.toFixed(6)}, ${G.r.toFixed(6)}, ${B.r.toFixed(6)})`,
    cfa, black: [R.b, G.b, B.b], scale: [R.s, G.s, B.s], corr: [R.r, G.r, B.r] };
}

export function toRGB16(img) {
  const { width: w, height: h, colors, bits } = img;
  let d = img.data;
  if (bits === 8) { const o = new Uint16Array(d.length); const lut = linLut8(); for (let i = 0; i < d.length; i++) o[i] = lut[d[i]]; d = o; }
  if (!(d instanceof Uint16Array)) d = new Uint16Array(d.buffer, d.byteOffset, d.byteLength / 2);
  if (colors === 3) return d;
  const out = new Uint16Array(w * h * 3);
  for (let i = 0, n = w * h; i < n; i++) {
    const v = d[i * colors];
    out[i * 3] = v; out[i * 3 + 1] = colors > 1 ? d[i * colors + 1] : v; out[i * 3 + 2] = colors > 2 ? d[i * colors + 2] : v;
  }
  return out;
}
function linLut8() { const t = new Uint16Array(256); for (let i = 0; i < 256; i++) t[i] = Math.round(srgbDecode(i / 255) * 65535); return t; }

// JPEG / PNG / WebP : décodage navigateur puis linéarisation
export async function decodeStandard(file) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const n = c.width * c.height, out = new Uint16Array(n * 3), lut = linLut8();
  for (let i = 0; i < n; i++) { out[i * 3] = lut[px[i * 4]]; out[i * 3 + 1] = lut[px[i * 4 + 1]]; out[i * 3 + 2] = lut[px[i * 4 + 2]]; }
  bmp.close?.();
  return { data: out, width: c.width, height: c.height };
}

function exifDate(raw, exif) {
  const d = exif?.exif?.DateTimeOriginal || (raw?.timestamp instanceof Date ? raw.timestamp : null);
  if (!(d instanceof Date) || isNaN(d)) return undefined;
  // exifr interprète la date EXIF comme locale : on la ré-écrit à l'identique
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Exposition de base (BaselineExposure) : n'existe que dans les DNG.
// Pour les autres RAW, LibRaw renvoie une valeur sentinelle (-999).
export function baselineExposure(raw) {
  const v = raw?.color_data?.dng_levels?.baseline_exposure;
  return raw?.dng_version && Number.isFinite(v) && Math.abs(v) <= 10 ? v : 0;
}

// Champs EXIF recopiés dans le JPG exporté
export function exportExifFields(raw, exif) {
  const r = raw || {};
  return {
    make: r.camera_make || exif?.ifd0?.Make, model: r.camera_model || exif?.ifd0?.Model,
    software: 'QuickRaw', dateTime: exifDate(raw, exif), exposureTime: r.shutter || exif?.exif?.ExposureTime,
    fNumber: r.aperture || exif?.exif?.FNumber, iso: r.iso_speed || exif?.exif?.ISO,
    focalLength: r.focal_len || exif?.exif?.FocalLength, lensModel: r.lens?.Lens || exif?.exif?.LensModel,
    artist: r.artist || exif?.ifd0?.Artist, description: r.desc,
  };
}
