// Pipeline de développement : partagé entre l'aperçu (thread principal)
// et l'export pleine résolution (engine-worker). Les deux utilisent
// exactement le même code pour que le JPG exporté corresponde à l'aperçu.
//
// Entrée : RVB linéaire (primaires sRGB, balance des blancs boîtier déjà
// appliquée par LibRaw), normalisé 0..1 (1 = saturation capteur).
// Sortie : RVB sRGB 8 bits.

export const DEFAULT_PARAMS = Object.freeze({
  temp: 0,        // -100..100  froid ↔ chaud
  tint: 0,        // -100..100  vert ↔ magenta
  exposure: 0,    // -5..5 EV
  contrast: 0,    // -100..100
  highlights: 0,  // -100..100
  shadows: 0,     // -100..100
  whites: 0,      // -100..100
  blacks: 0,      // -100..100
  vibrance: 0,    // -100..100
  saturation: 0,  // -100..100
  look: 'none',   // filtre : clé de LOOKS
  lookAmount: 100, // intensité du filtre, 0..100 %
});

// ---------- Filtres (profils de rendu) ----------
// Chaque filtre peut définir :
//  tone    : décalages ajoutés aux curseurs (contraste, noirs, hautes lumières…)
//  sat     : multiplicateur global de saturation
//  hueSat / hueLum / hueShift : par teinte, tous les 30° (0 rouge, 30 orange,
//            60 jaune, 90 jaune-vert, 120 vert, 150 vert-cyan, 180 cyan,
//            210 azur, 240 bleu, 270 violet, 300 magenta, 330 rose) —
//            multiplicateurs de saturation / luminance, décalage de teinte en degrés
//  mono    : mélangeur N&B [R, V, B] (simule un filtre coloré devant l'objectif)
//  split   : virage partiel { shadows: [r,v,b], highlights: [r,v,b], sS, sH }
export const LOOKS = {
  none: { name: 'Sans filtre', group: 'Couleur' },
  // Fujifilm Provia : le « standard » — fidèle, contraste et saturation modérés
  provia: {
    name: 'Provia', group: 'Couleur',
    tone: { contrast: 10, blacks: -3 },
    sat: 1.08,
    hueSat: [1.0, 0.97, 1.03, 1.04, 1.05, 1.04, 1.03, 1.04, 1.05, 1.0, 1.0, 1.0],
  },
  // Fujifilm Astia : douce, hautes lumières tendres, peaux flatteuses, ciels bleus
  astia: {
    name: 'Astia', group: 'Couleur',
    tone: { contrast: 4, highlights: -14, shadows: 8 },
    sat: 1.06,
    hueSat: [0.96, 0.88, 0.97, 1.03, 1.05, 1.06, 1.07, 1.09, 1.08, 1.0, 0.98, 0.97],
    hueLum: [1.0, 1.04, 1.02, 1.0, 1.0, 1.0, 1.0, 0.98, 0.97, 1.0, 1.0, 1.0],
  },
  // Adobe Vivid : plus de contraste et de saturation, tons chair protégés
  vivid: {
    name: 'Vivid', group: 'Couleur',
    tone: { contrast: 18, blacks: -6, highlights: -5 },
    sat: 1.2,
    hueSat: [1.0, 0.9, 0.97, 1.02, 1.05, 1.05, 1.05, 1.06, 1.06, 1.03, 1.0, 1.0],
    hueLum: [1, 1, 1, 1, 1, 1, 1, 0.98, 0.97, 1, 1, 1],
  },
  // Fujichrome Velvia : diapositive très contrastée et saturée — verts et
  // jaunes luxuriants, bleus profonds, rouges intenses, noirs denses
  velvia: {
    name: 'Velvia', group: 'Couleur',
    tone: { contrast: 32, blacks: -14, highlights: -8, shadows: -4 },
    sat: 1.32,
    hueSat: [1.06, 0.95, 1.14, 1.2, 1.2, 1.14, 1.1, 1.12, 1.14, 1.05, 1.02, 1.04],
    hueLum: [0.97, 1.0, 1.04, 1.0, 0.95, 0.94, 0.92, 0.88, 0.86, 0.92, 0.97, 0.97],
  },
  // Fujifilm Acros : N&B à grain fin, modelé riche, noirs profonds
  acros: {
    name: 'Acros', group: 'Noir & blanc',
    mono: [0.32, 0.58, 0.10],
    tone: { contrast: 22, blacks: -10, highlights: -6, shadows: 4 },
  },
  // Kodak Tri-X 400 : N&B classique du reportage, contrasté, filtre jaune
  trix: {
    name: 'Tri-X', group: 'Noir & blanc',
    mono: [0.40, 0.55, 0.05],
    tone: { contrast: 42, blacks: -18, whites: 10, highlights: -4 },
  },
  // Filtre rouge : ciels presque noirs, nuages éclatants, peaux lissées
  bwred: {
    name: 'N&B rouge', group: 'Noir & blanc',
    mono: [0.78, 0.24, -0.02],
    tone: { contrast: 30, blacks: -12, highlights: -8 },
  },
  // Sépia : virage brun chaud des tirages anciens, noirs légèrement relevés
  sepia: {
    name: 'Sépia', group: 'Noir & blanc',
    mono: [0.30, 0.59, 0.11],
    tone: { contrast: 8, blacks: 8, highlights: -10 },
    split: { shadows: [1.0, 0.7, 0.42], highlights: [1.0, 0.85, 0.62], sS: 1.5, sH: 1.3 },
  },
  // Cyberpunk jour : sarcelle et orange, verts virés au cyan, pointe de rose
  cyberday: {
    name: 'Cyberpunk jour', group: 'Créatif',
    tone: { contrast: 22, blacks: -8, highlights: -10 },
    sat: 1.25,
    hueShift: [-6, -10, -18, 40, 50, 25, 0, -8, -12, 0, 0, -4],
    hueSat: [1.05, 1.1, 1.0, 1.0, 1.05, 1.15, 1.2, 1.15, 1.05, 1.1, 1.15, 1.1],
    split: { shadows: [0.15, 0.8, 0.95], highlights: [1.0, 0.62, 0.72], sS: 0.4, sH: 0.28 },
  },
  // Cyberpunk nuit : néons magenta / cyan, ombres bleu-violet, noirs profonds
  cybernight: {
    name: 'Cyberpunk nuit', group: 'Créatif',
    tone: { contrast: 30, blacks: -18, highlights: -18, shadows: -4 },
    sat: 1.4,
    hueShift: [-25, -40, -55, 60, 60, 30, 0, 10, 20, 0, 0, -10],
    hueSat: [1.1, 1.1, 1.0, 1.0, 1.05, 1.1, 1.2, 1.15, 1.1, 1.15, 1.2, 1.15],
    hueLum: [0.95, 0.95, 0.95, 1.0, 0.95, 0.95, 1.0, 0.9, 0.85, 0.9, 1.0, 1.0],
    split: { shadows: [0.4, 0.2, 1.0], highlights: [1.0, 0.3, 0.85], sS: 0.55, sH: 0.24 },
  },
};

export const DEFAULT_GEOM = Object.freeze({
  rot90: 0,       // quarts de tour horaires (0..3)
  flipH: false,   // miroir horizontal (appliqué après rot90)
  angle: 0,       // redressage fin, degrés, positif = horaire
  crop: { x: 0, y: 0, w: 1, h: 1 }, // normalisé dans le cadre orienté
});

// ---------- sRGB ----------
export function srgbEncode(l) {
  if (l <= 0.0031308) return 12.92 * l;
  return 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}
export function srgbDecode(v) {
  if (v <= 0.04045) return v / 12.92;
  return Math.pow((v + 0.055) / 1.055, 2.4);
}

const LR = 0.2126, LG = 0.7152, LB = 0.0722;
export const lumaOf = (r, g, b) => LR * r + LG * g + LB * b;

// Coefficients de balance des blancs relative (approximation perceptive).
const TEMP_K = 0.45, TINT_K = 0.3;
export function wbMultipliers(temp, tint) {
  const t = temp / 100, n = tint / 100;
  let r = Math.exp(TEMP_K * t), b = Math.exp(-TEMP_K * t), g = Math.exp(-TINT_K * n);
  const k = lumaOf(r, g, b); // conserve la luminance d'un gris
  return [r / k, g / k, b / k];
}
// Inverse : multiplicateurs souhaités → (temp, tint)
export function wbFromMultipliers(mr, mg, mb) {
  const t = Math.log(mr / mb) / (2 * TEMP_K);
  const n = -Math.log(mg / Math.sqrt(mr * mb)) / TINT_K;
  return { temp: t * 100, tint: n * 100 };
}

// ---------- Courbe de tons (domaine encodé sRGB) ----------
// x : valeur encodée (peut dépasser 1 si l'exposition pousse au-delà du blanc)
function toneLevels(x, p) {
  // Blancs / noirs : déplacement des points blanc et noir
  const B = -p.blacks / 100 * 0.06;
  const W = 1 - p.whites / 100 * 0.22;
  x = (x - B) / (W - B);
  // Ombres / hautes lumières : bosses localisées dans les tons
  if (x > 0 && x < 1) {
    const sh = x * (1 - x) * (1 - x) * 6.75;   // pic à 1/3
    const hl = x * x * (1 - x) * 6.75;         // pic à 2/3
    x += p.shadows / 100 * 0.16 * sh + p.highlights / 100 * 0.16 * hl;
  }
  // Contraste : courbe en S autour d'un pivot
  const c = p.contrast / 100;
  if (c !== 0 && x > 0 && x < 1) {
    const piv = 0.45, g = c >= 0 ? 1 + 1.2 * c : 1 / (1 - 0.7 * c);
    x = x < piv ? piv * Math.pow(x / piv, g) : 1 - (1 - piv) * Math.pow((1 - x) / (1 - piv), g);
  }
  return x;
}

const LUT_N = 4096;
const LUT_MAX = 64; // luminance linéaire max couverte (6 IL au-dessus du blanc)

// Construit le processeur de pixels pour un jeu de paramètres.
// `base` : { exposure } offset d'exposition de base (ex. BaselineExposure DNG).
export function makeProcessor(params, base = {}) {
  const user = { ...DEFAULT_PARAMS, ...params };
  const look = LOOKS[user.look] && LOOKS[user.look].tone ? LOOKS[user.look] : null;
  const la = look ? Math.max(0, Math.min(100, user.lookAmount)) / 100 : 0;
  // Le filtre s'ajoute aux curseurs de tons
  const p = { ...user };
  if (look) for (const [k, v] of Object.entries(look.tone)) p[k] = user[k] + v * la;
  const ONES = Array(12).fill(1), ZEROS = Array(12).fill(0);
  const lookSat = look ? (look.hueSat || ONES).map((m) => 1 + ((look.sat || 1) * m - 1) * la) : null;
  const lookLum = look ? (look.hueLum || ONES).map((m) => 1 + (m - 1) * la) : null;
  const lookShift = look && look.hueShift ? look.hueShift.map((d) => d * la * Math.PI / 180) : ZEROS;
  const hasHue = !!look && !look.mono;
  // Mélangeur N&B (poids normalisés)
  let mono = null;
  if (look && look.mono) { const t = look.mono[0] + look.mono[1] + look.mono[2]; mono = look.mono.map((v) => v / t); }
  // Virage partiel : gains normalisés (un gris garde sa luminance)
  let split = null;
  if (look && look.split) {
    const norm = (c) => { const y = lumaOf(c[0], c[1], c[2]); return c.map((v) => v / y - 1); };
    split = { s: norm(look.split.shadows), h: norm(look.split.highlights), kS: look.split.sS * la, kH: look.split.sH * la };
  }
  const INV_SQRT3 = 1 / Math.sqrt(3);
  const [wr, wg, wb] = wbMultipliers(p.temp, p.tint);
  const expMul = Math.pow(2, p.exposure + (base.exposure || 0));
  const mr = wr * expMul, mg = wg * expMul, mb = wb * expMul;

  // Point blanc capteur après exposition → épaule de compression
  // (Reinhard étendu) pour préserver les hautes lumières sans empêcher le blanc pur.
  const knee = 0.8;
  const whiteEnc = toneLevels(srgbEncode(expMul), p);
  const m = Math.max((whiteEnc - knee) / (1 - knee), 1);
  const m2 = m * m;
  const shoulder = (x) => {
    if (x <= knee || m <= 1) return x;
    const u = (x - knee) / (1 - knee);
    return knee + (1 - knee) * (u * (1 + u / m2) / (1 + u));
  };

  // LUT : luminance linéaire (après expo) → rapport de gain
  // index = sqrt(L / LUT_MAX) * (N-1) pour plus de précision dans les ombres
  const gain = new Float32Array(LUT_N);
  for (let i = 0; i < LUT_N; i++) {
    const t = i / (LUT_N - 1);
    const L = t * t * LUT_MAX;
    let d = shoulder(toneLevels(srgbEncode(L), p));
    d = d < 0 ? 0 : d > 1 ? 1 : d;
    const out = srgbDecode(d);
    gain[i] = i === 0 ? 0 : out / L;
  }
  gain[0] = gain[1]; // pente à l'origine

  // LUT d'encodage sRGB 16 bits → 8 bits
  const enc = ENC_LUT;
  const sat = p.saturation / 100, vib = p.vibrance / 100;
  const K = (LUT_N - 1) / Math.sqrt(LUT_MAX);

  // Traite un pixel linéaire ; écrit 3 octets dans out[o..o+2].
  function pixel(r, g, b, out, o) {
    r *= mr; g *= mg; b *= mb;
    if (mono) { // N&B : mélange des canaux, dosé par l'intensité
      const m = mono[0] * r + mono[1] * g + mono[2] * b, k1 = 1 - la;
      r = m + (r - m) * k1; g = m + (g - m) * k1; b = m + (b - m) * k1;
    }
    let Y = LR * r + LG * g + LB * b;
    if (Y <= 0) { out[o] = out[o + 1] = out[o + 2] = 0; return; }
    let f = Math.sqrt(Y > LUT_MAX ? LUT_MAX : Y) * K;
    const i = f | 0, fr = f - i;
    const k = i >= LUT_N - 1 ? gain[LUT_N - 1] : gain[i] + (gain[i + 1] - gain[i]) * fr;
    r *= k; g *= k; b *= k; Y *= k;
    // Saturation / vibrance (autour de la luminance)
    if (sat !== 0 || vib !== 0) {
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const s = mx > 1e-6 ? (mx - mn) / mx : 0;
      let fac = 1 + sat;
      fac *= vib >= 0 ? 1 + vib * (1 - s) * (1 - s) : 1 + vib * (1 - s * 0.5);
      if (fac < 0) fac = 0;
      r = Y + (r - Y) * fac; g = Y + (g - Y) * fac; b = Y + (b - Y) * fac;
    }
    // Filtre : saturation, luminance et décalage selon la teinte
    if (hasHue) {
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const c = mx - mn;
      if (c > 1e-6) {
        let h;
        if (mx === r) h = (g - b) / c; else if (mx === g) h = (b - r) / c + 2; else h = (r - g) / c + 4;
        h = h < 0 ? h + 6 : h;                   // 0..6
        const t = h * 2, i0 = t | 0, fr = t - i0; // 12 cases de 30°
        const i1 = i0 + 1 >= 12 ? 0 : i0 + 1, j0 = i0 >= 12 ? 0 : i0;
        const s = c / mx;
        const fs = lookSat[j0] + (lookSat[i1] - lookSat[j0]) * fr;
        const fac = 1 + (fs - 1) * (1 - 0.5 * s); // ménage les couleurs déjà saturées
        const fl = 1 + (lookLum[j0] + (lookLum[i1] - lookLum[j0]) * fr - 1) * s;
        r = (Y + (r - Y) * fac) * fl; g = (Y + (g - Y) * fac) * fl; b = (Y + (b - Y) * fac) * fl;
        Y *= fl;
        const th = lookShift[j0] + (lookShift[i1] - lookShift[j0]) * fr;
        if (th > 1e-3 || th < -1e-3) {
          // rotation autour de l'axe des gris (Rodrigues), luminance conservée
          const m = (r + g + b) / 3, vr = r - m, vg = g - m, vb = b - m;
          const cs = Math.cos(th), sn = Math.sin(th) * INV_SQRT3;
          r = m + vr * cs + (vb - vg) * sn;
          g = m + vg * cs + (vr - vb) * sn;
          b = m + vb * cs + (vg - vr) * sn;
          const y2 = LR * r + LG * g + LB * b;
          if (y2 > 1e-9) { const q = Y / y2; r *= q; g *= q; b *= q; }
        }
      }
    }
    // Virage partiel (ombres / hautes lumières)
    if (split) {
      const t = Y >= 1 ? 1 : Math.sqrt(Y), wS = (1 - t) * (1 - t) * split.kS, wH = t * t * split.kH;
      r *= 1 + split.s[0] * wS + split.h[0] * wH;
      g *= 1 + split.s[1] * wS + split.h[1] * wH;
      b *= 1 + split.s[2] * wS + split.h[2] * wH;
    }
    // Compression de gamut : ramène vers la luminance au lieu d'écrêter
    let mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (mx > 1 && Y < 1) {
      const t = (1 - Y) / (mx - Y);
      r = Y + (r - Y) * t; g = Y + (g - Y) * t; b = Y + (b - Y) * t;
    }
    let mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if (mn < 0 && Y > 0) {
      const t = Y / (Y - mn);
      r = Y + (r - Y) * t; g = Y + (g - Y) * t; b = Y + (b - Y) * t;
    }
    out[o] = enc[r >= 1 ? 65535 : r <= 0 ? 0 : (r * 65535 + 0.5) | 0];
    out[o + 1] = enc[g >= 1 ? 65535 : g <= 0 ? 0 : (g * 65535 + 0.5) | 0];
    out[o + 2] = enc[b >= 1 ? 65535 : b <= 0 ? 0 : (b * 65535 + 0.5) | 0];
  }

  return { pixel, params: p };
}

const ENC_LUT = (() => {
  const t = new Uint8Array(65536);
  for (let i = 0; i < 65536; i++) t[i] = Math.round(srgbEncode(i / 65535) * 255);
  return t;
})();

// Traite un tampon linéaire RVB (Float32 0..1) vers RGBA 8 bits.
export function processRGBA(proc, src, dst, n) {
  const px = proc.pixel;
  for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
    px(src[s], src[s + 1], src[s + 2], dst, d);
    dst[d + 3] = 255;
  }
}

// ---------- Géométrie ----------
// Taille du cadre orienté (après quarts de tour)
export function orientedSize(w, h, rot90) {
  return rot90 % 2 ? [h, w] : [w, h];
}

// Plus grand rectangle d'aspect `aspect` (w/h, en pixels) inscrit dans
// l'image W×H tournée de `deg`, centré. Renvoie un recadrage normalisé.
export function inscribedCrop(W, H, deg, aspect) {
  const a = Math.abs(deg) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const ar = aspect || W / H;
  let w = Math.min(W / (c + s / ar), H / (s + c / ar));
  let h = w / ar;
  return { x: (W - w) / 2 / W, y: (H - h) / 2 / H, w: w / W, h: h / H };
}

// Vérifie qu'un recadrage (normalisé, cadre W×H) reste dans l'image tournée.
export function cropInside(W, H, deg, crop, eps = 1e-6) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const xs = [crop.x * W, (crop.x + crop.w) * W], ys = [crop.y * H, (crop.y + crop.h) * H];
  for (const X of xs) for (const Y of ys) {
    const dx = X - W / 2, dy = Y - H / 2;
    const ox = c * dx + s * dy, oy = -s * dx + c * dy;
    if (Math.abs(ox) > W / 2 * (1 + eps) + 0.01 || Math.abs(oy) > H / 2 * (1 + eps) + 0.01) return false;
  }
  return true;
}

// Transformation inverse sortie → source pour l'export.
// Renvoie une fonction (u, v) => [sx, sy] (coordonnées continues source,
// centres de pixels en +0.5) et les dimensions de sortie.
export function exportMapping(SW, SH, geom) {
  const g = { ...DEFAULT_GEOM, ...geom };
  const [OW, OH] = orientedSize(SW, SH, g.rot90);
  const x0 = Math.round(g.crop.x * OW), y0 = Math.round(g.crop.y * OH);
  const outW = Math.max(1, Math.min(OW - x0, Math.round(g.crop.w * OW)));
  const outH = Math.max(1, Math.min(OH - y0, Math.round(g.crop.h * OH)));
  const a = g.angle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const k = ((g.rot90 % 4) + 4) % 4;
  return {
    outW, outH,
    // Pour une ligne v : renvoie origine et pas (affine) en coordonnées source
    row(v) {
      const map = (u) => {
        const X = x0 + u + 0.5, Y = y0 + v + 0.5;
        const dx = X - OW / 2, dy = Y - OH / 2;
        let ox = c * dx + s * dy + OW / 2, oy = -s * dx + c * dy + OH / 2;
        if (g.flipH) ox = OW - ox;
        switch (k) {
          case 1: return [oy, SH - ox];
          case 2: return [SW - ox, SH - oy];
          case 3: return [SW - oy, ox];
          default: return [ox, oy];
        }
      };
      const p0 = map(0), p1 = map(1);
      return { sx: p0[0], sy: p0[1], dx: p1[0] - p0[0], dy: p1[1] - p0[1] };
    },
  };
}
