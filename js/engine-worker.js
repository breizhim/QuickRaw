// Worker « moteur » : tâches lourdes hors du thread principal.
//  - preview : réduction de l'image (moyenne de boîtes) → Float32 linéaire 0..1
//  - share   : copie de l'image pleine résolution dans un SharedArrayBuffer,
//              lu en parallèle par les workers d'export
self.onmessage = ({ data: msg }) => {
  try {
    if (msg.type === 'preview') {
      const prev = makePreview(msg.data, msg.width, msg.height, msg.previewMax);
      self.postMessage({ id: msg.id, ok: true, preview: prev }, [prev.data.buffer]);
    } else if (msg.type === 'share') {
      let data = msg.data;
      if (typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated) {
        const shared = new Uint16Array(new SharedArrayBuffer(data.byteLength));
        shared.set(data);
        data = shared;
      }
      self.postMessage({ id: msg.id, ok: true, data });
    }
  } catch (e) {
    self.postMessage({ id: msg.id, ok: false, error: String(e && e.message || e) });
  }
};

function makePreview(data, w, h, maxDim) {
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
