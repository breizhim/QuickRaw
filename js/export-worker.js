// Worker d'export : rend et encode en JPEG une bande de l'image pleine
// résolution (lignes de blocs [s0, s1[). Plusieurs workers travaillent en
// parallèle sur la même image (SharedArrayBuffer) ; les bandes sont séparées
// par des marqueurs RST, ce qui permet de simplement les concaténer.
import { makeProcessor, exportMapping } from './pipeline.js';
import { JpegEncoder } from './jpeg-encoder.js';

self.onmessage = ({ data: msg }) => {
  try {
    const chunks = encodeBand(msg);
    self.postMessage({ done: true, chunks }, chunks.map((c) => c.buffer));
  } catch (e) {
    self.postMessage({ error: String(e && e.message || e) });
  }
};

function encodeBand({ data, SW, SH, params, base, geom, quality, s0, s1, totalStrips }) {
  const px = makeProcessor(params, base).pixel;
  const map = exportMapping(SW, SH, geom);
  const { outW, outH } = map;
  const enc = new JpegEncoder(outW, outH, { quality, headers: false });
  const strip = new Uint8Array(outW * 8 * 3);
  const sc = 1 / 65535;
  const identity = !geom.angle; // pas de rééchantillonnage si pas de rotation fine
  let lastReport = 0, done = 0;

  for (let s = s0; s < s1; s++) {
    const y0 = s * 8, rows = Math.min(8, outH - y0);
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
          const i = (yi * SW + xi) * 3;
          px(data[i] * sc, data[i + 1] * sc, data[i + 2] * sc, strip, o);
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
    if (s < totalStrips - 1) enc.restart(s);
    done++;
    const now = Date.now();
    if (now - lastReport > 150) { lastReport = now; self.postMessage({ progress: done }); done = 0; }
  }
  if (done) self.postMessage({ progress: done });
  return enc.finish(false);
}
