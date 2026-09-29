// Dématriçage parallèle dans la mémoire partagée du module WebAssembly
// (fonctions dm_* de native/qr.c). Chaque phase est répartie par bandes de
// lignes entre les workers ; on attend la fin de toutes les bandes avant la
// phase suivante (les phases 2 et 3 lisent les résultats des bandes voisines).
import { getModule, NSLOT, createMosaicMemory } from './qr-wasm.js';

export async function decodeFast(raw, meta, cal, rgbCam) {
  const module = await getModule();
  if (!module) throw new Error('module WebAssembly indisponible');
  const flip = meta?.flip | 0;
  const T = [performance.now()], lab = [];
  const mark = (l) => { T.push(performance.now()); lab.push(l); };
  const m = createMosaicMemory(raw, flip);
  mark('mémoire+copie');
  const { memory, layout, W, H } = m;
  const n = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, NSLOT));
  const workers = [];
  try {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
      workers.push(w);
    }
    let seq = 0;
    const call = (w, msg) => new Promise((resolve, reject) => {
      const id = ++seq;
      const on = ({ data }) => {
        if (data.id !== id) return;
        w.removeEventListener('message', on);
        data.error ? reject(new Error(data.error)) : resolve(data);
      };
      w.addEventListener('message', on);
      w.onerror = (e) => reject(new Error(e.message || 'Erreur du worker de dématriçage'));
      w.postMessage({ ...msg, id });
    });
    await Promise.all(workers.map((w) => call(w, { type: 'dm-init', module, memory })));
    mark('workers');
    const bands = (total) => workers.map((_, i) => [Math.floor(total * i / n), Math.floor(total * (i + 1) / n)]);
    // argsFor(a, b) : arguments de la fonction ; lo / hi : position des bornes de la tranche
    const phase = (fn, argsFor, total, lo, hi, chunk) => Promise.all(workers.map((w, i) => {
      const [a, b] = bands(total)[i];
      return call(w, { type: 'dm', fn, args: argsFor(a, b), lo, hi, a, b, chunk });
    }));
    const { cfa, black: bl, scale: sc } = cal;
    const P = layout.mosaic, I = layout.img, M = rgbCam;
    await phase('dm_scale', (a, b) => [P, W, a, b, cfa, bl[0], bl[1], bl[2], sc[0], sc[1], sc[2]], H, 2, 3, 32);
    mark('dm_scale');
    await phase('dm_green', (a, b) => [P, I, W, H, a, b, cfa, flip], H, 4, 5, 16);
    mark('dm_green');
    await phase('dm_rb', (a, b) => [P, I, W, H, a, b, cfa, flip], H, 4, 5, 16);
    mark('dm_rb');
    await phase('dm_color', (a, b) => [I, a, b, M[0][0], M[0][1], M[0][2], M[1][0], M[1][1], M[1][2], M[2][0], M[2][1], M[2][2]], W * H, 1, 2, 1 << 18);
    mark('dm_color');
  } finally {
    for (const w of workers) w.terminate();
  }
  console.info('Dématriçage : ' + lab.map((l, i) => `${l} ${Math.round(T[i + 1] - T[i])} ms`).join(', '));
  return { data: m.data, width: m.OW, height: m.OH, memory, layout };
}
