// Export JPEG pleine résolution en parallèle : l'image est découpée en bandes
// horizontales (multiples de 8 lignes) encodées chacune par un worker ; les
// bandes sont séparées par des marqueurs RST (intervalle = une ligne de blocs).
import { exportMapping } from './pipeline.js';
import { JpegEncoder, buildExif } from './jpeg-encoder.js';
import { getModule, NSLOT } from './qr-wasm.js';

export async function exportJpeg({ full, params, base, geom, quality = 100, exif = {}, onProgress, glow = null }) {
  const { data, w: SW, h: SH } = full;
  const { outW, outH } = exportMapping(SW, SH, geom);
  const totalStrips = Math.ceil(outH / 8);
  const shared = typeof SharedArrayBuffer !== 'undefined' && data.buffer instanceof SharedArrayBuffer;
  const cores = navigator.hardwareConcurrency || 4;
  const n = shared ? Math.max(1, Math.min(cores, NSLOT, totalStrips)) : 1;
  // Module WebAssembly (SIMD) si l'image est dans sa mémoire ; sinon export JavaScript
  const module = full.memory ? await getModule() : null;
  const wasm = module ? { module, memory: full.memory, layout: full.layout } : null;

  // En-têtes (SOI, APP0, APP1 EXIF, DQT, SOF, DHT, DRI, SOS)
  const head = new JpegEncoder(outW, outH, {
    quality, exif: buildExif({ ...exif, width: outW, height: outH }), restartInterval: Math.ceil(outW / 8),
  }).takeBytes();

  let done = 0;
  const bands = [];
  for (let i = 0; i < n; i++) {
    const s0 = Math.floor(totalStrips * i / n), s1 = Math.floor(totalStrips * (i + 1) / n);
    bands.push(new Promise((resolve, reject) => {
      const wk = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
      wk.onmessage = ({ data: m }) => {
        if (m.progress) { done += m.progress; onProgress && onProgress(done / totalStrips); return; }
        wk.terminate();
        m.error ? reject(new Error(m.error)) : resolve(m.chunks);
      };
      wk.onerror = (e) => { wk.terminate(); reject(new Error(e.message || 'Erreur du worker d\'export')); };
      wk.postMessage({ data, SW, SH, params, base, geom, quality, s0, s1, totalStrips, glow,
        wasm: wasm && { ...wasm, slot: wasm.layout.slots + i * wasm.layout.slotSize } });
    }));
  }
  const bandChunks = await Promise.all(bands);
  const parts = [...head, ...bandChunks.flat(), new Uint8Array([0xff, 0xd9])];
  return { blob: new Blob(parts, { type: 'image/jpeg' }), parts, outW, outH, workers: n, engine: wasm ? 'wasm' : 'js' };
}
