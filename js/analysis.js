// Analyse colorimétrique, suggestions de réglages et redressage automatique.
import { srgbEncode, srgbDecode, lumaOf, wbFromMultipliers, orientedSize } from './pipeline.js';

// ---------- Statistiques sur l'image rendue (RGBA 8 bits) ----------
export const SCOPE_GAIN = 1.2; // zoom du vectorscope (les cibles à 75 % restent dans le cercle)
export function renderedStats(rgba, n, step = 1) {
  const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256), hl = new Uint32Array(256);
  const hue = new Float64Array(72); // 5° par case, pondéré par saturation
  const scope = new Uint32Array(128 * 128); // vectorscope (Cb/Cr)
  let clipHi = [0, 0, 0], clipLo = 0, count = 0, sumSat = 0, sumL = 0;
  for (let i = 0; i < n; i += step) {
    const o = i * 4, r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    hr[r]++; hg[g]++; hb[b]++;
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.5) | 0;
    hl[l]++; sumL += l;
    if (r >= 254) clipHi[0]++; if (g >= 254) clipHi[1]++; if (b >= 254) clipHi[2]++;
    if (r <= 1 && g <= 1 && b <= 1) clipLo++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
    const s = mx ? c / mx : 0; sumSat += s;
    if (c > 8) {
      let h;
      if (mx === r) h = ((g - b) / c) % 6; else if (mx === g) h = (b - r) / c + 2; else h = (r - g) / c + 4;
      h = (h * 60 + 360) % 360;
      hue[(h / 5) | 0] += s * (c / 255);
    }
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b, cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
    let sx = (64 + cb * SCOPE_GAIN / 2) | 0, sy = (64 - cr * SCOPE_GAIN / 2) | 0;
    sx = sx < 0 ? 0 : sx > 127 ? 127 : sx; sy = sy < 0 ? 0 : sy > 127 ? 127 : sy;
    scope[sy * 128 + sx]++;
    count++;
  }
  return {
    hist: { r: hr, g: hg, b: hb, l: hl }, hue, scope, count,
    clipHi: clipHi.map((v) => v / count), clipLo: clipLo / count,
    meanSat: sumSat / count, meanL: sumL / count / 255,
    median: percentile(hl, count, 0.5) / 255,
  };
}

function percentile(hist, total, p) {
  const target = total * p; let acc = 0;
  for (let i = 0; i < hist.length; i++) { acc += hist[i]; if (acc >= target) return i; }
  return hist.length - 1;
}

// ---------- Suggestions (sur les données linéaires source) ----------
// src : Float32Array RVB linéaire, n pixels. geom/angle éventuellement fournis.
export function suggestSettings(src, n, info = {}) {
  const step = Math.max(1, Math.floor(n / 400000));
  // 1) Balance des blancs : moyenne des pixels quasi neutres, tons moyens
  let sr = 0, sg = 0, sb = 0, cnt = 0, ar = 0, ag = 0, ab = 0, acnt = 0;
  for (let i = 0; i < n; i += step) {
    const r = src[i * 3], g = src[i * 3 + 1], b = src[i * 3 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx >= 0.98 || mx < 0.01) continue; // écrêté ou trop sombre
    ar += r; ag += g; ab += b; acnt++;
    if ((mx - mn) / mx < 0.3) { sr += r; sg += g; sb += b; cnt++; }
  }
  let wb = null;
  const total = Math.ceil(n / step);
  if (cnt > total * 0.02 && sr > 0 && sb > 0) wb = [sg / sr, 1, sg / sb];
  else if (acnt > 0 && ar > 0 && ab > 0) wb = [Math.sqrt(ag / ar), 1, Math.sqrt(ag / ab)]; // monde gris atténué
  let temp = 0, tint = 0;
  if (wb) {
    const t = wbFromMultipliers(wb[0], wb[1], wb[2]);
    temp = clamp(Math.round(t.temp * 0.7), -100, 100); // prudence : garder un peu d'ambiance
    tint = clamp(Math.round(t.tint * 0.7), -100, 100);
  }

  // 2) Distribution de luminance (log) → exposition
  const bins = 1024, H = new Uint32Array(bins); let m = 0;
  const lumAt = (L) => Math.min(bins - 1, Math.max(0, Math.round((Math.log2(Math.max(L, 1e-6)) + 16) / 16 * (bins - 1))));
  for (let i = 0; i < n; i += step) {
    const L = lumaOf(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
    H[lumAt(L)]++; m++;
  }
  const pl = (p) => Math.pow(2, percentile(H, m, p) / (bins - 1) * 16 - 16);
  const med = pl(0.5), p99 = pl(0.995);
  let ev = Math.log2(srgbDecode(0.44) / Math.max(med, 1e-5));
  // éviter de brûler : garder le 99,5e centile sous ~2× le blanc
  ev = Math.min(ev, Math.log2(2.0 / Math.max(p99, 1e-5)));
  ev = clamp(Math.round(ev * 20) / 20, -4, 4);
  if (Math.abs(ev) < 0.1) ev = 0;

  // 3) Distribution encodée après exposition suggérée
  const E = new Uint32Array(256); let me = 0, s1 = 0, s2 = 0;
  const mul = Math.pow(2, ev);
  for (let i = 0; i < n; i += step) {
    const x = srgbEncode(Math.min(1, lumaOf(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]) * mul));
    E[Math.round(x * 255)]++; me++; s1 += x; s2 += x * x;
  }
  const pe = (p) => percentile(E, me, p) / 255;
  const frac = (a, b) => { let s = 0; for (let i = a; i <= b; i++) s += E[i]; return s / me; };
  const mean = s1 / me, std = Math.sqrt(Math.max(0, s2 / me - mean * mean));
  const hiFrac = frac(245, 255), loFrac = frac(0, 25), clipFrac = frac(254, 255), blkFrac = frac(0, 1);
  const p005 = pe(0.005), p995 = pe(0.995);

  let highlights = 0, shadows = 0, whites = 0, blacks = 0, contrast = 0;
  if (hiFrac > 0.01) highlights = -Math.round(clamp(hiFrac * 1500, 15, 80));
  if (loFrac > 0.08) shadows = Math.round(clamp((loFrac - 0.05) * 250, 10, 70));
  if (p995 < 0.9) whites = Math.round(clamp((0.96 - p995) * 250, 5, 60));
  else if (clipFrac > 0.02) whites = -Math.round(clamp(clipFrac * 800, 5, 50));
  if (p005 > 0.05) blacks = -Math.round(clamp((p005 - 0.02) * 400, 5, 60));
  else if (blkFrac > 0.02) blacks = Math.round(clamp(blkFrac * 800, 5, 40));
  if (std < 0.2) contrast = Math.round(clamp((0.24 - std) * 350, 5, 45));
  else if (std > 0.32) contrast = -Math.round(clamp((std - 0.3) * 300, 5, 40));

  // 4) Saturation moyenne (encodée)
  let ss = 0, sc = 0;
  for (let i = 0; i < n; i += step * 2) {
    const r = src[i * 3], g = src[i * 3 + 1], b = src[i * 3 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 0.005) { ss += (srgbEncode(Math.min(1, mx * mul)) - srgbEncode(Math.min(1, mn * mul))) / srgbEncode(Math.min(1, mx * mul)); sc++; }
  }
  const msat = sc ? ss / sc : 0;
  let vibrance = 0, saturation = 0;
  if (msat < 0.25) vibrance = Math.round(clamp((0.32 - msat) * 200, 5, 40));
  else if (msat > 0.55) saturation = -Math.round(clamp((msat - 0.5) * 100, 5, 25));

  // ---------- Construction des suggestions lisibles ----------
  const S = [];
  const fmt = (v) => (v > 0 ? '+' : '') + v;
  if (Math.abs(temp) >= 4 || Math.abs(tint) >= 4) {
    const dir = temp > 0 ? 'une dominante froide (bleutée)' : 'une dominante chaude (orangée)';
    const tdir = tint > 0 ? ' et verte' : tint < 0 ? ' et magenta' : '';
    S.push({ id: 'wb', title: 'Balance des blancs', icon: '🌡️',
      text: `Les zones neutres présentent ${Math.abs(temp) >= 4 ? dir : 'une légère dérive'}${Math.abs(tint) >= 4 ? tdir : ''}. Température ${fmt(temp)}, teinte ${fmt(tint)}.`,
      set: { temp, tint } });
  }
  if (ev !== 0) {
    S.push({ id: 'exp', title: 'Exposition', icon: '☀️',
      text: `Luminance médiane à ${(srgbEncode(Math.min(1, med)) * 100).toFixed(0)} % : ${ev > 0 ? 'image sous-exposée' : 'image sur-exposée'}. Exposition ${fmt(ev.toFixed(2))} IL.`,
      set: { exposure: ev } });
  }
  if (highlights) S.push({ id: 'hl', title: 'Hautes lumières', icon: '⛅',
    text: `${(hiFrac * 100).toFixed(1)} % des pixels sont proches du blanc. Récupérer les détails : ${fmt(highlights)}.`, set: { highlights } });
  if (shadows) S.push({ id: 'sh', title: 'Ombres', icon: '🌑',
    text: `${(loFrac * 100).toFixed(0)} % de l'image est dans les ombres profondes. Déboucher : ${fmt(shadows)}.`, set: { shadows } });
  if (whites) S.push({ id: 'wh', title: 'Blancs', icon: '⬜',
    text: whites > 0 ? `L'histogramme n'atteint pas le blanc (${(p995 * 100).toFixed(0)} %). Étendre : ${fmt(whites)}.` : `${(clipFrac * 100).toFixed(1)} % de blancs écrêtés. Réduire : ${fmt(whites)}.`, set: { whites } });
  if (blacks) S.push({ id: 'bk', title: 'Noirs', icon: '⬛',
    text: blacks < 0 ? `Noirs délavés (point le plus sombre à ${(p005 * 100).toFixed(0)} %). Densifier : ${fmt(blacks)}.` : `${(blkFrac * 100).toFixed(1)} % de noirs bouchés. Relever : ${fmt(blacks)}.`, set: { blacks } });
  if (contrast) S.push({ id: 'ct', title: 'Contraste', icon: '◐',
    text: `Écart-type des tons : ${(std * 100).toFixed(0)} % (${contrast > 0 ? 'image plate' : 'image très contrastée'}). Contraste ${fmt(contrast)}.`, set: { contrast } });
  if (vibrance) S.push({ id: 'vb', title: 'Vibrance', icon: '🎨',
    text: `Saturation moyenne faible (${(msat * 100).toFixed(0)} %). Vibrance ${fmt(vibrance)} (protège les couleurs déjà saturées).`, set: { vibrance } });
  if (saturation) S.push({ id: 'st', title: 'Saturation', icon: '🎨',
    text: `Couleurs très saturées (${(msat * 100).toFixed(0)} %). Saturation ${fmt(saturation)}.`, set: { saturation } });
  if (info.iso >= 3200) S.push({ id: 'iso', title: 'Bruit', icon: 'ℹ️',
    text: `ISO ${info.iso} : éviter de trop déboucher les ombres, le bruit y est plus visible.`, set: null });

  const auto = { temp, tint, exposure: ev, highlights, shadows, whites, blacks, contrast, vibrance, saturation };
  return { suggestions: S, auto, stats: { median: med, p99, std, msat, hiFrac, loFrac } };
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------- Redressage automatique ----------
// Estime l'angle (degrés, positif = rotation horaire à appliquer) qui rend
// horizontales/verticales les lignes dominantes. Tenseur de structure + histogramme
// d'orientations pondéré par la cohérence.
export function detectStraighten(src, w, h, maxDim = 900) {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / maxDim));
  const W = Math.floor(w / f), Hh = Math.floor(h / f);
  let g = new Float32Array(W * Hh);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
      const o = ((y * f + j) * w + x * f + i) * 3;
      s += lumaOf(src[o], src[o + 1], src[o + 2]);
    }
    g[y * W + x] = srgbEncode(Math.min(1, s / (f * f) * 2));
  }
  const n = W * Hh;
  g = boxBlur(boxBlur(g, W, Hh, 1), W, Hh, 1); // pré-lissage : réduit le biais d'orientation de Sobel
  const jxx = new Float32Array(n), jyy = new Float32Array(n), jxy = new Float32Array(n);
  for (let y = 1; y < Hh - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const gx = (g[i - W + 1] + 2 * g[i + 1] + g[i + W + 1]) - (g[i - W - 1] + 2 * g[i - 1] + g[i + W - 1]);
    const gy = (g[i + W - 1] + 2 * g[i + W] + g[i + W + 1]) - (g[i - W - 1] + 2 * g[i - W] + g[i - W + 1]);
    jxx[i] = gx * gx; jyy[i] = gy * gy; jxy[i] = gx * gy;
  }
  const bxx = boxBlur(jxx, W, Hh, 3), byy = boxBlur(jyy, W, Hh, 3), bxy = boxBlur(jxy, W, Hh, 3);
  const RANGE = 20, BIN = 0.1, NB = Math.round(2 * RANGE / BIN) + 1;
  const hist = new Float64Array(NB);
  // seuil d'énergie : ne garder que les contours marqués
  const energies = [];
  for (let i = 0; i < n; i += 7) energies.push(bxx[i] + byy[i]);
  energies.sort((a, b) => a - b);
  const thr = energies[Math.floor(energies.length * 0.85)] || 0;
  for (let y = 4; y < Hh - 4; y++) for (let x = 4; x < W - 4; x++) {
    const i = y * W + x;
    const a = bxx[i], b = byy[i], c = bxy[i];
    const e = a + b;
    if (e <= thr || e <= 1e-6) continue;
    const coh = Math.sqrt((a - b) * (a - b) + 4 * c * c) / e;
    if (coh < 0.75) continue;
    // direction du gradient dominant ; la ligne lui est perpendiculaire
    const theta = 0.5 * Math.atan2(2 * c, a - b) * 180 / Math.PI; // -90..90
    let d = ((theta % 90) + 90) % 90; if (d > 45) d -= 90;       // écart à l'axe le plus proche
    if (d < -RANGE || d > RANGE) continue;
    const wgt = Math.sqrt(e) * coh * coh;
    const pos = (d + RANGE) / BIN, k = Math.floor(pos), fr = pos - k;
    if (k >= 0 && k < NB) hist[k] += wgt * (1 - fr);
    if (k + 1 < NB) hist[k + 1] += wgt * fr;
  }
  // lissage gaussien σ≈0.3°
  const sm = new Float64Array(NB), R = 9, sig = 3;
  for (let i = 0; i < NB; i++) {
    let s = 0;
    for (let k = -R; k <= R; k++) { const j = i + k; if (j >= 0 && j < NB) s += hist[j] * Math.exp(-(k * k) / (2 * sig * sig)); }
    sm[i] = s;
  }
  let best = 0, bi = 0, tot = 0;
  for (let i = 0; i < NB; i++) { tot += sm[i]; if (sm[i] > best) { best = sm[i]; bi = i; } }
  // interpolation parabolique du pic
  let off = 0;
  if (bi > 0 && bi < NB - 1) { const a = sm[bi - 1], b = sm[bi], c = sm[bi + 1]; const den = a - 2 * b + c; if (den) off = 0.5 * (a - c) / den; }
  const d = (bi + off) * BIN - RANGE;
  const confidence = tot ? best / (tot / NB) : 0; // rapport pic / moyenne
  // Une ligne à +d° (sens horaire à l'écran, y vers le bas) se corrige en tournant de -d°.
  return { angle: Math.round(-d * 100) / 100, confidence };
}

function boxBlur(a, w, h, r) {
  const t = new Float32Array(a.length), o = new Float32Array(a.length), k = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0; const row = y * w;
    for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      t[row + x] = s / k;
      s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      o[y * w + x] = s / k;
      s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
    }
  }
  return o;
}

export { orientedSize };
