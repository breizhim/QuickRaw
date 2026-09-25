// Worker « moteur » : conserve l'image pleine résolution (linéaire 16 bits),
// fabrique l'aperçu réduit et réalise l'export JPEG pleine résolution.
import { makeProcessor, exportMapping } from './pipeline.js';
import { JpegEncoder, buildExif } from './jpeg-encoder.js';

let full = null; // { data: Uint16Array (RVB), w, h }

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'load') {
      full = { data: msg.data, w: msg.width, h: msg.height };
      const prev = makePreview(full, msg.previewMax);
      self.postMessage({ id: msg.id, ok: true, preview: prev }, [prev.data.buffer]);
    } else if (msg.type === 'export') {
      const blob = exportJpeg(msg);
      self.postMessage({ id: msg.id, ok: true, blob });
    }
  } catch (e) {
    self.postMessage({ id: msg.id, ok: false, error: String(e && e.message || e) });
  }
};

// Réduction par moyenne de boîtes (facteur entier) → Float32 linéaire 0..1
function makePreview({ data, w, h }, maxDim) {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / maxDim));
  const pw = Math.floor(w / f), ph = Math.floor(h / f);
  const out = new Float32Array(pw * ph * 3);
  const norm = 1 / (65535 * f * f);
  const acc = new Float64Array(pw * 3);
  for (let y = 0; y < ph; y++) {
    acc.fill(0);
    for (let j = 0; j < f; j++) {
      let s = ((y * f + j) * w) * 3;
      for (let x = 0; x < pw; x++) {
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < f; i++, s += 3) { r += data[s]; g += data[s + 1]; b += data[s + 2]; }
        acc[x * 3] += r; acc[x * 3 + 1] += g; acc[x * 3 + 2] += b;
      }
    }
    const o = y * pw * 3;
    for (let k = 0; k < pw * 3; k++) out[o + k] = acc[k] * norm;
  }
  return { data: out, w: pw, h: ph };
}

function exportJpeg({ params, base, geom, quality, exif }) {
  if (!full) throw new Error('Aucune image chargée');
  const { data, w: SW, h: SH } = full;
  const proc = makeProcessor(params, base);
  const px = proc.pixel;
  const map = exportMapping(SW, SH, geom);
  const { outW, outH } = map;
  const exifBytes = buildExif({ ...exif, width: outW, height: outH });
  const enc = new JpegEncoder(outW, outH, { quality, exif: exifBytes });
  const strip = new Uint8Array(outW * 8 * 3);
  const sc = 1 / 65535;
  const identity = !geom.angle; // pas de rééchantillonnage si pas de rotation fine
  let lastReport = 0;

  for (let y0 = 0; y0 < outH; y0 += 8) {
    const rows = Math.min(8, outH - y0);
    for (let r = 0; r < rows; r++) {
      const { sx, sy, dx, dy } = map.row(y0 + r);
      let o = r * outW * 3;
      for (let u = 0; u < outW; u++, o += 3) {
        let X = sx + dx * u - 0.5, Y = sy + dy * u - 0.5;
        if (identity) {
          // correspondance exacte pixel à pixel (quarts de tour / miroir / recadrage)
          let xi = Math.round(X), yi = Math.round(Y);
          xi = xi < 0 ? 0 : xi >= SW ? SW - 1 : xi;
          yi = yi < 0 ? 0 : yi >= SH ? SH - 1 : yi;
          const s = (yi * SW + xi) * 3;
          px(data[s] * sc, data[s + 1] * sc, data[s + 2] * sc, strip, o);
        } else {
          // bilinéaire
          if (X < 0) X = 0; else if (X > SW - 1) X = SW - 1;
          if (Y < 0) Y = 0; else if (Y > SH - 1) Y = SH - 1;
          const xi = X | 0, yi = Y | 0, fx = X - xi, fy = Y - yi;
          const x1 = xi + 1 < SW ? xi + 1 : xi, y1 = yi + 1 < SH ? yi + 1 : yi;
          const a = (yi * SW + xi) * 3, b = (yi * SW + x1) * 3, c = (y1 * SW + xi) * 3, d = (y1 * SW + x1) * 3;
          const w00 = (1 - fx) * (1 - fy) * sc, w10 = fx * (1 - fy) * sc, w01 = (1 - fx) * fy * sc, w11 = fx * fy * sc;
          px(
            data[a] * w00 + data[b] * w10 + data[c] * w01 + data[d] * w11,
            data[a + 1] * w00 + data[b + 1] * w10 + data[c + 1] * w01 + data[d + 1] * w11,
            data[a + 2] * w00 + data[b + 2] * w10 + data[c + 2] * w01 + data[d + 2] * w11,
            strip, o);
        }
      }
    }
    enc.encodeStrip(strip, rows);
    const now = Date.now();
    if (now - lastReport > 150) { lastReport = now; self.postMessage({ type: 'progress', value: (y0 + rows) / outH }); }
  }
  const chunks = enc.finish();
  return new Blob(chunks, { type: 'image/jpeg' });
}
