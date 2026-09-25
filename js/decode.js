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

// Dématriçage pleine résolution. `buf` est transféré (détaché) vers LibRaw.
export async function decodeFull(buf, { withMeta = false } = {}) {
  const lr = new LibRaw();
  try {
    await lr.open(new Uint8Array(buf), RAW_SETTINGS);
    const raw = withMeta ? await lr.metadata(true) : null;
    const img = await lr.imageData();
    if (!img || !img.data) throw new Error('Décodage impossible');
    return { data: toRGB16(img), width: img.width, height: img.height, raw };
  } finally { lr.dispose(); }
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
