// Linéarisation des sorties LibRaw.
// NB : libraw-wasm ignore le réglage `gamm` : la sortie 16 bits est toujours
// encodée avec la courbe par défaut de LibRaw (BT.709, 0,45 / 4,5). On la
// linéarise ici (table inverse), toute l'appli travaillant en linéaire.
export const INV709 = (() => {
  const t = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) {
    const v = i / 65535;
    const l = v < 0.081 ? v / 4.5 : Math.pow((v + 0.099296826809442) / 1.099296826809442, 1 / 0.45);
    t[i] = Math.min(65535, Math.round(l * 65535));
  }
  return t;
})();
export function linearize709(d) { for (let i = 0; i < d.length; i++) d[i] = INV709[d[i]]; return d; }

export const rgbCam3 = (meta) => {
  const m = meta?.color_data?.rgb_cam;
  return m && m.length >= 3 ? [0, 1, 2].map((i) => [0, 1, 2].map((j) => +m[i][j] || 0)) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
};

// Aperçu demi-taille → RVB linéaire (primaires sRGB) : courbe inverse + matrice caméra
export function halfToLinear(half, meta) {
  const M = rgbCam3(meta), n = half.width * half.height, d = half.data, out = new Uint16Array(n * 3);
  const cl = (v) => (v <= 0 ? 0 : v >= 65535 ? 65535 : (v + 0.5) | 0);
  for (let i = 0, k = 0; i < n; i++, k += 3) {
    const r = INV709[d[k]], g = INV709[d[k + 1]], b = INV709[d[k + 2]];
    out[k] = cl(M[0][0] * r + M[0][1] * g + M[0][2] * b);
    out[k + 1] = cl(M[1][0] * r + M[1][1] * g + M[1][2] * b);
    out[k + 2] = cl(M[2][0] * r + M[2][1] * g + M[2][2] * b);
  }
  return { data: out, width: half.width, height: half.height, rgbCam: M };
}

