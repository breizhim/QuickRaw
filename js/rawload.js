// Chargement d'un RAW : aperçu immédiat + image pleine résolution en arrière-plan.
//  - LibRaw ne fait que l'aperçu demi-taille et la décompression (une seule passe)
//  - le dématriçage pleine résolution est fait par notre module WebAssembly,
//    sur tous les cœurs (demosaic.js), avec des paramètres calés sur LibRaw
//  - repli sur le dématriçage LibRaw (AHD, mono-cœur) si le capteur n'est pas
//    Bayer, si le calage n'est pas exact ou si le module est indisponible
import { engine } from './engine.js';
import { openRaw, rgbCam3, calibrate, decodeFull } from './decode.js';
import { decodeFast } from './demosaic.js';

export async function loadRaw(buf) {
  const t0 = performance.now();
  let spare = buf.slice(0); // copie pour un éventuel repli (LibRaw détache le tampon)
  const t1 = performance.now();
  const { half, meta, raw } = await openRaw(buf);
  const t2 = performance.now();
  const rgbCam = rgbCam3(meta);
  const t3 = performance.now();
  const cal = calibrate(half, raw, meta);
  console.info(`Lecture : copie ${Math.round(t1 - t0)} ms, LibRaw demi-taille ${Math.round(t2 - t1)} ms, calage ${Math.round(performance.now() - t3)} ms`);
  const fullP = (async () => {
    if (cal.ok) {
      try {
        const t = performance.now();
        const f = await decodeFast(raw, meta, cal, rgbCam);
        spare = null;
        return { ...f, engine: 'wasm', ms: performance.now() - t };
      } catch (e) { console.warn('Dématriçage rapide impossible, repli LibRaw :', e); }
    } else console.info('Dématriçage rapide non applicable (' + cal.why + '), repli LibRaw.');
    const t = performance.now();
    const f = await decodeFull(spare);
    spare = null;
    const sh = await engine.call({ type: 'share', data: f.data, width: f.width, height: f.height }, [f.data.buffer]);
    return { data: sh.data, width: f.width, height: f.height, memory: sh.memory, layout: sh.layout, engine: 'libraw', ms: performance.now() - t };
  })();
  // aperçu : linéarisé et réduit par le worker moteur (hors du fil principal)
  const previewFor = (previewMax) => engine.call({ type: 'previewRaw', half: { data: half.data, width: half.width, height: half.height }, rgbCam, previewMax });
  return { previewFor, half: { width: half.width, height: half.height }, meta, cal, fullP };
}
