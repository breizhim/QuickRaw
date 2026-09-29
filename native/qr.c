// QuickRaw — cœur d'export compilé en WebAssembly (SIMD).
// Portage fidèle de js/pipeline.js (pixel) et js/jpeg-encoder.js (baseline 4:4:4) :
// les tables (courbe de tons, encodage sRGB, filtres) sont calculées par le même
// code JavaScript que l'aperçu et copiées dans la mémoire du module, pour que
// l'export reste identique à ce qui est affiché.
//
// Mémoire partagée entre les workers d'export (une instance par worker) :
//   - l'image pleine résolution (Uint16 RVB) n'est lue que ;
//   - chaque worker travaille dans son propre « slot » (paramètres, tables,
//     tampons, état de l'encodeur). Aucune variable globale modifiable et
//     aucune pile en mémoire : les instances ne se gênent pas.
//
// Compilation : voir native/build.sh

#include <stdint.h>

#define EXPORT(name) __attribute__((export_name(#name)))

typedef unsigned char u8;

// ---------- disposition d'un slot ----------
// params : double[128]
enum {
  P_MR, P_MG, P_MB, P_MONO, P_MONO_R, P_MONO_G, P_MONO_B, P_LA, P_K, P_SAT, P_VIB, P_HASHUE,
  P_LSAT = 12, P_LLUM = 24, P_LSHIFT = 36,
  P_SPLIT = 48, P_SS = 49, P_SH = 52, P_KS = 55, P_KH = 56,
  P_IDENT = 57, P_SX0, P_SY0, P_DUX, P_DUY, P_DVX, P_DVY,
  P_COUNT = 128
};
#define OFF_PARAMS 0                       // 128 doubles = 1024
#define OFF_GAIN   1024                    // float[4096] = 16384
#define OFF_ENC    (OFF_GAIN + 16384)      // u8[65536]
#define OFF_QY     (OFF_ENC + 65536)       // float[64] diviseurs Y
#define OFF_QC     (OFF_QY + 256)          // float[64] diviseurs C
#define OFF_HUF    (OFF_QC + 256)          // 4 tables × (256 codes + 256 longueurs) int32 = 8192
#define OFF_STATE  (OFF_HUF + 8192)        // état de l'encodeur (int32[16])
#define OFF_BLK    (OFF_STATE + 64)        // float[3*64] blocs Y, Cb, Cr + int32[64] coefficients
#define OFF_STRIP  (OFF_BLK + 1024)        // u8[W*8*3]  (puis tampon de sortie)

typedef struct {
  int32_t w, h;
  int32_t dcY, dcU, dcV;
  uint64_t bitBuf;  // bits en attente (alignés à droite)
  int32_t bitCnt;
  int32_t outPos;
  int32_t outCap;
} State;

#define LUT_N 4096
#define LUT_MAX 64.0

static const u8 ZIGZAG[64] = {
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42,
  3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60,
  21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
};

static const u8 DC_L_NR[17] = {0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0};
static const u8 DC_L_VAL[12] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
static const u8 AC_L_NR[17] = {0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d};
static const u8 AC_L_VAL[162] = {
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
};
static const u8 DC_C_NR[17] = {0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0};
static const u8 DC_C_VAL[12] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
static const u8 AC_C_NR[17] = {0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77};
static const u8 AC_C_VAL[162] = {
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
};

static inline double dmin(double a, double b) { return a < b ? a : b; }
static inline double dmax(double a, double b) { return a > b ? a : b; }

// cos / sin pour de petits angles (décalage de teinte ≤ ~1 rad) : séries de Taylor
static inline double qcos(double x) { double x2 = x * x; return 1 - x2 / 2 * (1 - x2 / 12 * (1 - x2 / 30 * (1 - x2 / 56))); }
static inline double qsin(double x) { double x2 = x * x; return x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72)))); }

// ---------- rendu d'un pixel (copie de pixel() de js/pipeline.js) ----------
// Paramètres recopiés en variables locales une fois par bande (évite que chaque
// écriture d'octet force le compilateur à relire les paramètres en mémoire).
typedef struct {
  double mr, mg, mb, K, sat, vib, la, m0, m1, m2, kS, kH;
  int mono, hasHue, split;
  const double *LS, *LL, *SH, *SS, *SHh;
} Px;

static inline Px load_px(const double *P) {
  Px x;
  x.mr = P[P_MR]; x.mg = P[P_MG]; x.mb = P[P_MB]; x.K = P[P_K]; x.sat = P[P_SAT]; x.vib = P[P_VIB];
  x.la = P[P_LA]; x.m0 = P[P_MONO_R]; x.m1 = P[P_MONO_G]; x.m2 = P[P_MONO_B]; x.kS = P[P_KS]; x.kH = P[P_KH];
  x.mono = P[P_MONO] != 0; x.hasHue = P[P_HASHUE] != 0; x.split = P[P_SPLIT] != 0;
  x.LS = P + P_LSAT; x.LL = P + P_LLUM; x.SH = P + P_LSHIFT; x.SS = P + P_SS; x.SHh = P + P_SH;
  return x;
}

static inline __attribute__((always_inline)) void pixel(const Px x, const float *restrict gain, const u8 *restrict enc,
                                                        double r, double g, double b, u8 *restrict out) {
  const double LR = 0.2126, LG = 0.7152, LB = 0.0722;
  r *= x.mr; g *= x.mg; b *= x.mb;
  if (x.mono) {
    double m = x.m0 * r + x.m1 * g + x.m2 * b, k1 = 1 - x.la;
    r = m + (r - m) * k1; g = m + (g - m) * k1; b = m + (b - m) * k1;
  }
  double Y = LR * r + LG * g + LB * b;
  if (Y <= 0) { out[0] = out[1] = out[2] = 0; return; }
  double f = __builtin_sqrt(Y > LUT_MAX ? LUT_MAX : Y) * x.K;
  int i = (int)f; double fr = f - i;
  double k = i >= LUT_N - 1 ? gain[LUT_N - 1] : gain[i] + ((double)gain[i + 1] - gain[i]) * fr;
  r *= k; g *= k; b *= k; Y *= k;
  double sat = x.sat, vib = x.vib;
  if (sat != 0 || vib != 0) {
    double mx = dmax(r, dmax(g, b)), mn = dmin(r, dmin(g, b));
    double s = mx > 1e-6 ? (mx - mn) / mx : 0;
    double fac = 1 + sat;
    fac *= vib >= 0 ? 1 + vib * (1 - s) * (1 - s) : 1 + vib * (1 - s * 0.5);
    if (fac < 0) fac = 0;
    r = Y + (r - Y) * fac; g = Y + (g - Y) * fac; b = Y + (b - Y) * fac;
  }
  if (x.hasHue) {
    double mx = dmax(r, dmax(g, b)), mn = dmin(r, dmin(g, b)), c = mx - mn;
    if (c > 1e-6) {
      double h;
      if (mx == r) h = (g - b) / c; else if (mx == g) h = (b - r) / c + 2; else h = (r - g) / c + 4;
      if (h < 0) h += 6;
      double t = h * 2; int i0 = (int)t; double fr2 = t - i0;
      int i1 = i0 + 1 >= 12 ? 0 : i0 + 1, j0 = i0 >= 12 ? 0 : i0;
      double s = c / mx;
      const double *LS = x.LS, *LL = x.LL, *SH = x.SH;
      double fs = LS[j0] + (LS[i1] - LS[j0]) * fr2;
      double fac = 1 + (fs - 1) * (1 - 0.5 * s);
      double fl = 1 + (LL[j0] + (LL[i1] - LL[j0]) * fr2 - 1) * s;
      r = (Y + (r - Y) * fac) * fl; g = (Y + (g - Y) * fac) * fl; b = (Y + (b - Y) * fac) * fl;
      Y *= fl;
      double th = SH[j0] + (SH[i1] - SH[j0]) * fr2;
      if (th > 1e-3 || th < -1e-3) {
        double m = (r + g + b) / 3, vr = r - m, vg = g - m, vb = b - m;
        double cs = qcos(th), sn = qsin(th) * 0.5773502691896258;
        r = m + vr * cs + (vb - vg) * sn;
        g = m + vg * cs + (vr - vb) * sn;
        b = m + vb * cs + (vg - vr) * sn;
        double y2 = LR * r + LG * g + LB * b;
        if (y2 > 1e-9) { double q = Y / y2; r *= q; g *= q; b *= q; }
      }
    }
  }
  if (x.split) {
    double t = Y >= 1 ? 1 : __builtin_sqrt(Y), wS = (1 - t) * (1 - t) * x.kS, wH = t * t * x.kH;
    r *= 1 + x.SS[0] * wS + x.SHh[0] * wH;
    g *= 1 + x.SS[1] * wS + x.SHh[1] * wH;
    b *= 1 + x.SS[2] * wS + x.SHh[2] * wH;
  }
  double mx = dmax(r, dmax(g, b));
  if (mx > 1 && Y < 1) {
    double t = (1 - Y) / (mx - Y);
    r = Y + (r - Y) * t; g = Y + (g - Y) * t; b = Y + (b - Y) * t;
  }
  double mn = dmin(r, dmin(g, b));
  if (mn < 0 && Y > 0) {
    double t = Y / (Y - mn);
    r = Y + (r - Y) * t; g = Y + (g - Y) * t; b = Y + (b - Y) * t;
  }
  out[0] = enc[r >= 1 ? 65535 : r <= 0 ? 0 : (int)(r * 65535 + 0.5)];
  out[1] = enc[g >= 1 ? 65535 : g <= 0 ? 0 : (int)(g * 65535 + 0.5)];
  out[2] = enc[b >= 1 ? 65535 : b <= 0 ? 0 : (int)(b * 65535 + 0.5)];
}


// ---------- rendu SIMD : 4 pixels à la fois (mêmes formules que pixel()) ----------
#include <wasm_simd128.h>
typedef v128_t F4;
#define F(x) wasm_f32x4_splat((float)(x))
#define ADD wasm_f32x4_add
#define SUB wasm_f32x4_sub
#define MUL wasm_f32x4_mul
#define DIV wasm_f32x4_div
#define MIN wasm_f32x4_pmin
#define MAX wasm_f32x4_pmax
#define SEL(m, a, b) wasm_v128_bitselect(a, b, m)   // m ? a : b

static inline F4 gather_f(const float *restrict t, v128_t idx) {
  return wasm_f32x4_make(t[wasm_i32x4_extract_lane(idx, 0)], t[wasm_i32x4_extract_lane(idx, 1)],
                         t[wasm_i32x4_extract_lane(idx, 2)], t[wasm_i32x4_extract_lane(idx, 3)]);
}
static inline F4 gather_d(const double *restrict t, v128_t idx) {
  return wasm_f32x4_make((float)t[wasm_i32x4_extract_lane(idx, 0)], (float)t[wasm_i32x4_extract_lane(idx, 1)],
                         (float)t[wasm_i32x4_extract_lane(idx, 2)], (float)t[wasm_i32x4_extract_lane(idx, 3)]);
}

static inline __attribute__((always_inline)) void pixel4(const Px x, const float *restrict gain, const u8 *restrict enc,
                                                         F4 r, F4 g, F4 b, u8 *restrict out) {
  const F4 LR = F(0.2126), LG = F(0.7152), LB = F(0.0722), ONE = F(1), ZERO = F(0);
  r = MUL(r, F(x.mr)); g = MUL(g, F(x.mg)); b = MUL(b, F(x.mb));
  if (x.mono) {
    F4 m = ADD(ADD(MUL(F(x.m0), r), MUL(F(x.m1), g)), MUL(F(x.m2), b)), k1 = F(1 - x.la);
    r = ADD(m, MUL(SUB(r, m), k1)); g = ADD(m, MUL(SUB(g, m), k1)); b = ADD(m, MUL(SUB(b, m), k1));
  }
  F4 Y = ADD(ADD(MUL(LR, r), MUL(LG, g)), MUL(LB, b));
  v128_t black = wasm_f32x4_le(Y, ZERO);
  // courbe de tons (LUT de gain)
  F4 f = MUL(wasm_f32x4_sqrt(MIN(MAX(Y, ZERO), F(LUT_MAX))), F(x.K));
  v128_t i0 = wasm_i32x4_trunc_sat_f32x4(f);
  i0 = wasm_i32x4_min(i0, wasm_i32x4_splat(LUT_N - 2));
  F4 fr = MIN(SUB(f, wasm_f32x4_convert_i32x4(i0)), ONE);
  F4 g0 = gather_f(gain, i0), g1 = gather_f(gain, wasm_i32x4_add(i0, wasm_i32x4_splat(1)));
  F4 k = ADD(g0, MUL(SUB(g1, g0), fr));
  r = MUL(r, k); g = MUL(g, k); b = MUL(b, k); Y = MUL(Y, k);
  // saturation / vibrance
  if (x.sat != 0 || x.vib != 0) {
    F4 mx = MAX(r, MAX(g, b)), mn = MIN(r, MIN(g, b));
    F4 s = SEL(wasm_f32x4_gt(mx, F(1e-6)), DIV(SUB(mx, mn), mx), ZERO);
    F4 fac = F(1 + x.sat);
    F4 is = SUB(ONE, s);
    fac = MUL(fac, x.vib >= 0 ? ADD(ONE, MUL(F(x.vib), MUL(is, is))) : ADD(ONE, MUL(F(x.vib), SUB(ONE, MUL(s, F(0.5))))));
    fac = MAX(fac, ZERO);
    r = ADD(Y, MUL(SUB(r, Y), fac)); g = ADD(Y, MUL(SUB(g, Y), fac)); b = ADD(Y, MUL(SUB(b, Y), fac));
  }
  // filtre : saturation, luminance et décalage selon la teinte
  if (x.hasHue) {
    F4 mx = MAX(r, MAX(g, b)), mn = MIN(r, MIN(g, b)), c = SUB(mx, mn);
    v128_t ok = wasm_f32x4_gt(c, F(1e-6));
    F4 cs = SEL(ok, c, ONE), ms = SEL(ok, mx, ONE);
    F4 ic = DIV(ONE, cs);
    F4 hr = MUL(SUB(g, b), ic), hg = ADD(MUL(SUB(b, r), ic), F(2)), hb = ADD(MUL(SUB(r, g), ic), F(4));
    F4 h = SEL(wasm_f32x4_eq(mx, r), hr, SEL(wasm_f32x4_eq(mx, g), hg, hb));
    h = SEL(wasm_f32x4_lt(h, ZERO), ADD(h, F(6)), h);
    F4 t = MUL(h, F(2));
    v128_t j0 = wasm_i32x4_trunc_sat_f32x4(t);
    F4 fr2 = SUB(t, wasm_f32x4_convert_i32x4(j0));
    j0 = wasm_i32x4_min(wasm_i32x4_max(j0, wasm_i32x4_splat(0)), wasm_i32x4_splat(11));
    v128_t j1 = wasm_i32x4_add(j0, wasm_i32x4_splat(1));
    j1 = SEL(wasm_i32x4_ge(j1, wasm_i32x4_splat(12)), wasm_i32x4_splat(0), j1);
    F4 s = DIV(c, ms);
    F4 a0 = gather_d(x.LS, j0), a1 = gather_d(x.LS, j1);
    F4 fs = ADD(a0, MUL(SUB(a1, a0), fr2));
    F4 fac = ADD(ONE, MUL(SUB(fs, ONE), SUB(ONE, MUL(F(0.5), s))));
    F4 l0 = gather_d(x.LL, j0), l1 = gather_d(x.LL, j1);
    F4 fl = ADD(ONE, MUL(SUB(ADD(l0, MUL(SUB(l1, l0), fr2)), ONE), s));
    F4 nr = MUL(ADD(Y, MUL(SUB(r, Y), fac)), fl), ng = MUL(ADD(Y, MUL(SUB(g, Y), fac)), fl), nb = MUL(ADD(Y, MUL(SUB(b, Y), fac)), fl);
    F4 nY = MUL(Y, fl);
    F4 s0 = gather_d(x.SH, j0), s1 = gather_d(x.SH, j1);
    F4 th = ADD(s0, MUL(SUB(s1, s0), fr2));
    // rotation autour de l'axe des gris (Rodrigues), luminance conservée
    F4 th2 = MUL(th, th);
    F4 co = SUB(ONE, MUL(MUL(th2, F(0.5)), SUB(ONE, MUL(MUL(th2, F(1.0 / 12)), SUB(ONE, MUL(MUL(th2, F(1.0 / 30)), SUB(ONE, MUL(th2, F(1.0 / 56)))))))));
    F4 si = MUL(th, SUB(ONE, MUL(MUL(th2, F(1.0 / 6)), SUB(ONE, MUL(MUL(th2, F(1.0 / 20)), SUB(ONE, MUL(MUL(th2, F(1.0 / 42)), SUB(ONE, MUL(th2, F(1.0 / 72))))))))));
    si = MUL(si, F(0.5773502691896258));
    F4 m = MUL(ADD(ADD(nr, ng), nb), F(1.0 / 3)), vr = SUB(nr, m), vg = SUB(ng, m), vb = SUB(nb, m);
    F4 rr = ADD(ADD(m, MUL(vr, co)), MUL(SUB(vb, vg), si));
    F4 rg = ADD(ADD(m, MUL(vg, co)), MUL(SUB(vr, vb), si));
    F4 rb = ADD(ADD(m, MUL(vb, co)), MUL(SUB(vg, vr), si));
    F4 y2 = ADD(ADD(MUL(LR, rr), MUL(LG, rg)), MUL(LB, rb));
    v128_t yok = wasm_f32x4_gt(y2, F(1e-9));
    F4 q = DIV(nY, SEL(yok, y2, ONE));
    rr = SEL(yok, MUL(rr, q), rr); rg = SEL(yok, MUL(rg, q), rg); rb = SEL(yok, MUL(rb, q), rb);
    v128_t rot = wasm_v128_or(wasm_f32x4_gt(th, F(1e-3)), wasm_f32x4_lt(th, F(-1e-3)));
    nr = SEL(rot, rr, nr); ng = SEL(rot, rg, ng); nb = SEL(rot, rb, nb);
    r = SEL(ok, nr, r); g = SEL(ok, ng, g); b = SEL(ok, nb, b); Y = SEL(ok, nY, Y);
  }
  // virage partiel
  if (x.split) {
    F4 t = MIN(wasm_f32x4_sqrt(MAX(Y, ZERO)), ONE);
    F4 it = SUB(ONE, t);
    F4 wS = MUL(MUL(it, it), F(x.kS)), wH = MUL(MUL(t, t), F(x.kH));
    r = MUL(r, ADD(ONE, ADD(MUL(F(x.SS[0]), wS), MUL(F(x.SHh[0]), wH))));
    g = MUL(g, ADD(ONE, ADD(MUL(F(x.SS[1]), wS), MUL(F(x.SHh[1]), wH))));
    b = MUL(b, ADD(ONE, ADD(MUL(F(x.SS[2]), wS), MUL(F(x.SHh[2]), wH))));
  }
  // compression de gamut
  {
    F4 mx = MAX(r, MAX(g, b));
    v128_t m1 = wasm_v128_and(wasm_f32x4_gt(mx, ONE), wasm_f32x4_lt(Y, ONE));
    F4 t = DIV(SUB(ONE, Y), SEL(m1, SUB(mx, Y), ONE));
    r = SEL(m1, ADD(Y, MUL(SUB(r, Y), t)), r); g = SEL(m1, ADD(Y, MUL(SUB(g, Y), t)), g); b = SEL(m1, ADD(Y, MUL(SUB(b, Y), t)), b);
    F4 mn = MIN(r, MIN(g, b));
    v128_t m2 = wasm_v128_and(wasm_f32x4_lt(mn, ZERO), wasm_f32x4_gt(Y, ZERO));
    F4 t2 = DIV(Y, SEL(m2, SUB(Y, mn), ONE));
    r = SEL(m2, ADD(Y, MUL(SUB(r, Y), t2)), r); g = SEL(m2, ADD(Y, MUL(SUB(g, Y), t2)), g); b = SEL(m2, ADD(Y, MUL(SUB(b, Y), t2)), b);
  }
  // encodage sRGB 8 bits (LUT 16 bits)
  const F4 S = F(65535);
  v128_t ir = wasm_i32x4_trunc_sat_f32x4(ADD(MUL(MIN(MAX(r, ZERO), ONE), S), F(0.5)));
  v128_t ig = wasm_i32x4_trunc_sat_f32x4(ADD(MUL(MIN(MAX(g, ZERO), ONE), S), F(0.5)));
  v128_t ib = wasm_i32x4_trunc_sat_f32x4(ADD(MUL(MIN(MAX(b, ZERO), ONE), S), F(0.5)));
  ir = wasm_i32x4_min(ir, wasm_i32x4_splat(65535)); ig = wasm_i32x4_min(ig, wasm_i32x4_splat(65535)); ib = wasm_i32x4_min(ib, wasm_i32x4_splat(65535));
  ir = SEL(black, wasm_i32x4_splat(0), ir); ig = SEL(black, wasm_i32x4_splat(0), ig); ib = SEL(black, wasm_i32x4_splat(0), ib);
#define PUT(L) out[L * 3] = enc[wasm_i32x4_extract_lane(ir, L)]; out[L * 3 + 1] = enc[wasm_i32x4_extract_lane(ig, L)]; out[L * 3 + 2] = enc[wasm_i32x4_extract_lane(ib, L)];
  PUT(0) PUT(1) PUT(2) PUT(3)
#undef PUT
}

// ---------- encodeur JPEG ----------
static void build_huffman(const u8 *nr, const u8 *val, int32_t *codes, int32_t *lens) {
  int code = 0, k = 0;
  for (int len = 1; len <= 16; len++) {
    for (int j = 0; j < nr[len]; j++) { codes[val[k]] = code; lens[val[k]] = len; k++; code++; }
    code <<= 1;
  }
}

static inline void put_byte(State *st, u8 *out, u8 v) { out[st->outPos++] = v; }

static inline void flush_bytes(State *st, u8 *restrict out) {
  // vide les octets complets (bourrage 0xFF 0x00)
  while (st->bitCnt >= 8) {
    u8 b = (u8)(st->bitBuf >> (st->bitCnt - 8));
    out[st->outPos++] = b;
    if (b == 0xff) out[st->outPos++] = 0;
    st->bitCnt -= 8;
  }
}

static inline void write_bits(State *st, u8 *restrict out, uint32_t code, int len) {
  st->bitBuf = (st->bitBuf << len) | (code & ((1u << len) - 1));
  st->bitCnt += len;
  if (st->bitCnt >= 32) flush_bytes(st, out);
}

// Écrit le code de Huffman du symbole puis les bits de la valeur, en une fois
static inline void write_coef(State *st, u8 *restrict out, int v, const int32_t *codes, const int32_t *lens, int run) {
  int a = v < 0 ? -v : v;
  int nb = a ? 32 - __builtin_clz((unsigned)a) : 0;
  int sym = run < 0 ? nb : (run << 4) | nb;
  uint32_t bits = (uint32_t)(v < 0 ? v + (1 << nb) - 1 : v) & ((1u << nb) - 1);
  int L = lens[sym];
  write_bits(st, out, ((uint32_t)codes[sym] << nb) | bits, L + nb); // L + nb ≤ 27
}

// DCT flottante AAN (jfdctflt de l'IJG) + quantification → coefficients en zigzag
static void fdct_quant(float *d, const float *qdiv, int32_t *q) {
  for (int p = 0; p < 64; p += 8) {
    float t0 = d[p] + d[p + 7], t7 = d[p] - d[p + 7], t1 = d[p + 1] + d[p + 6], t6 = d[p + 1] - d[p + 6];
    float t2 = d[p + 2] + d[p + 5], t5 = d[p + 2] - d[p + 5], t3 = d[p + 3] + d[p + 4], t4 = d[p + 3] - d[p + 4];
    float t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
    d[p] = t10 + t11; d[p + 4] = t10 - t11;
    float z1 = (t12 + t13) * 0.707106781f;
    d[p + 2] = t13 + z1; d[p + 6] = t13 - z1;
    t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
    float z5 = (t10 - t12) * 0.382683433f, z2 = 0.541196100f * t10 + z5;
    float z4 = 1.306562965f * t12 + z5, z3 = t11 * 0.707106781f;
    float z11 = t7 + z3, z13 = t7 - z3;
    d[p + 5] = z13 + z2; d[p + 3] = z13 - z2; d[p + 1] = z11 + z4; d[p + 7] = z11 - z4;
  }
  for (int p = 0; p < 8; p++) {
    float t0 = d[p] + d[p + 56], t7 = d[p] - d[p + 56], t1 = d[p + 8] + d[p + 48], t6 = d[p + 8] - d[p + 48];
    float t2 = d[p + 16] + d[p + 40], t5 = d[p + 16] - d[p + 40], t3 = d[p + 24] + d[p + 32], t4 = d[p + 24] - d[p + 32];
    float t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
    d[p] = t10 + t11; d[p + 32] = t10 - t11;
    float z1 = (t12 + t13) * 0.707106781f;
    d[p + 16] = t13 + z1; d[p + 48] = t13 - z1;
    t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
    float z5 = (t10 - t12) * 0.382683433f, z2 = 0.541196100f * t10 + z5;
    float z4 = 1.306562965f * t12 + z5, z3 = t11 * 0.707106781f;
    float z11 = t7 + z3, z13 = t7 - z3;
    d[p + 40] = z13 + z2; d[p + 24] = z13 - z2; d[p + 8] = z11 + z4; d[p + 56] = z11 - z4;
  }
  for (int i = 0; i < 64; i++) {
    float v = d[i] * qdiv[i];
    int iv = (int)__builtin_floorf(v + 0.5f);
    if (iv > 2047) iv = 2047; else if (iv < -2048) iv = -2048;
    q[ZIGZAG[i]] = iv;
  }
}

static int encode_block(State *st, u8 *out, float *d, const float *qdiv, int32_t *q, int dcPrev,
                        const int32_t *dcC, const int32_t *dcL, const int32_t *acC, const int32_t *acL) {
  fdct_quant(d, qdiv, q);
  write_coef(st, out, q[0] - dcPrev, dcC, dcL, -1);
  int last = 63;
  while (last > 0 && q[last] == 0) last--;
  int run = 0;
  for (int i = 1; i <= last; i++) {
    int v = q[i];
    if (v == 0) { run++; continue; }
    while (run >= 16) { write_bits(st, out, acC[0xf0], acL[0xf0]); run -= 16; }
    write_coef(st, out, v, acC, acL, run);
    run = 0;
  }
  if (last < 63) write_bits(st, out, acC[0], acL[0]);
  return q[0];
}

// Taille d'un slot pour une largeur de sortie donnée
EXPORT(slot_size) int slot_size(int outW) {
  int s = OFF_STRIP + outW * 8 * 3 + outW * 8 * 3 * 2 + 4096;
  return (s + 65535) & ~65535;
}
EXPORT(params_offset) int params_offset(void) { return OFF_PARAMS; }
EXPORT(gain_offset) int gain_offset(void) { return OFF_GAIN; }
EXPORT(enc_offset) int enc_offset(void) { return OFF_ENC; }

static const double AAN[8] = {1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379};
static const u8 STD_Y_Q[64] = {
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99};
static const u8 STD_C_Q[64] = {
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99};

// Prépare l'encodeur d'une bande (tables de quantification / Huffman, état)
EXPORT(enc_init) void enc_init(u8 *slot, int outW, int outH, int quality) {
  State *st = (State *)(slot + OFF_STATE);
  st->w = outW; st->h = outH; st->dcY = st->dcU = st->dcV = 0;
  st->bitBuf = 0; st->bitCnt = 0; st->outPos = 0;
  if (quality < 1) quality = 1; if (quality > 100) quality = 100;
  int sf = quality < 50 ? 5000 / quality : 200 - quality * 2;
  float *qy = (float *)(slot + OFF_QY), *qc = (float *)(slot + OFF_QC);
  for (int r = 0; r < 8; r++) for (int c = 0; c < 8; c++) {
    int i = r * 8 + c;
    int vy = (STD_Y_Q[i] * sf + 50) / 100, vc = (STD_C_Q[i] * sf + 50) / 100;
    vy = vy < 1 ? 1 : vy > 255 ? 255 : vy; vc = vc < 1 ? 1 : vc > 255 ? 255 : vc;
    qy[i] = (float)(1.0 / (vy * AAN[r] * AAN[c] * 8.0));
    qc[i] = (float)(1.0 / (vc * AAN[r] * AAN[c] * 8.0));
  }
  int32_t *H = (int32_t *)(slot + OFF_HUF);
  for (int i = 0; i < 4 * 512; i++) H[i] = 0;
  build_huffman(DC_L_NR, DC_L_VAL, H, H + 256);
  build_huffman(AC_L_NR, AC_L_VAL, H + 512, H + 768);
  build_huffman(DC_C_NR, DC_C_VAL, H + 1024, H + 1280);
  build_huffman(AC_C_NR, AC_C_VAL, H + 1536, H + 1792);
}

// Adresse du tampon de sortie (octets produits par le dernier appel)
EXPORT(out_offset) int out_offset(u8 *slot) {
  State *st = (State *)(slot + OFF_STATE);
  return OFF_STRIP + st->w * 8 * 3;
}

// Rend et encode une bande de 8 lignes de sortie (y0 = première ligne).
// restart ≥ 0 : ajoute ensuite le marqueur RST(restart & 7).
// Renvoie le nombre d'octets écrits dans le tampon de sortie.
EXPORT(enc_strip) int enc_strip(u8 *slot, const uint16_t *img, int SW, int SH, int y0, int rows, int restart) {
  State *st = (State *)(slot + OFF_STATE);
  const double *P = (const double *)(slot + OFF_PARAMS);
  const float *gain = (const float *)(slot + OFF_GAIN);
  const u8 *enc = slot + OFF_ENC;
  u8 *strip = slot + OFF_STRIP;
  u8 *out = strip + st->w * 8 * 3;
  const int W = st->w;
  const double sc = 1.0 / 65535;
  const Px px = load_px(P);
  const double SX0 = P[P_SX0], SY0 = P[P_SY0], DUX = P[P_DUX], DUY = P[P_DUY], DVX = P[P_DVX], DVY = P[P_DVY];
  // P[100] / P[101] : sauter le rendu / l'encodage (profilage uniquement)
  const int ident = P[P_IDENT] != 0, skipPix = P[100] != 0, skipEnc = P[101] != 0;
  st->outPos = 0;

  // 1) rendu des pixels de la bande
  if (!skipPix) for (int r = 0; r < rows; r++) {
    int v = y0 + r;
    double sx = SX0 + DVX * v, sy = SY0 + DVY * v;
    double dx = DUX, dy = DUY;
    u8 *restrict o = strip + r * W * 3;
    const F4 SC = F(1.0 / 65535);
    if (ident) {
      // sans rotation fine : correspondance pixel à pixel, pas entier constant
      int xi0 = (int)__builtin_floor(sx), yi0 = (int)__builtin_floor(sy); // = round(sx - 0.5)
      int sxs = (int)dx, sys = (int)dy;                                   // -1, 0 ou 1
      int u = 0;
#define NN(uu) ({ int xi = xi0 + sxs * (uu), yi = yi0 + sys * (uu); \
        xi = xi < 0 ? 0 : xi >= SW ? SW - 1 : xi; yi = yi < 0 ? 0 : yi >= SH ? SH - 1 : yi; \
        img + ((long)yi * SW + xi) * 3; })
      for (; u + 4 <= W; u += 4, o += 12) {
        const uint16_t *p0 = NN(u), *p1 = NN(u + 1), *p2 = NN(u + 2), *p3 = NN(u + 3);
        pixel4(px, gain, enc, MUL(wasm_f32x4_make(p0[0], p1[0], p2[0], p3[0]), SC),
               MUL(wasm_f32x4_make(p0[1], p1[1], p2[1], p3[1]), SC), MUL(wasm_f32x4_make(p0[2], p1[2], p2[2], p3[2]), SC), o);
      }
#undef NN
      for (; u < W; u++, o += 3) {
        int xi = xi0 + sxs * u, yi = yi0 + sys * u;
        xi = xi < 0 ? 0 : xi >= SW ? SW - 1 : xi;
        yi = yi < 0 ? 0 : yi >= SH ? SH - 1 : yi;
        const uint16_t *s = img + ((long)yi * SW + xi) * 3;
        pixel(px, gain, enc, s[0] * sc, s[1] * sc, s[2] * sc, o);
      }
    } else {
      // redressement : interpolation bilinéaire, 4 pixels à la fois
      // (variables séparées par voie : aucun tableau local, donc aucune pile en mémoire)
#define BIL(uu, R, G, B) { \
        double X = sx + dx * (uu) - 0.5, Yc = sy + dy * (uu) - 0.5; \
        if (X < 0) X = 0; else if (X > SW - 1) X = SW - 1; \
        if (Yc < 0) Yc = 0; else if (Yc > SH - 1) Yc = SH - 1; \
        int xi = (int)X, yi = (int)Yc; float fx = (float)(X - xi), fy = (float)(Yc - yi); \
        int x1 = xi + 1 < SW ? xi + 1 : xi, y1 = yi + 1 < SH ? yi + 1 : yi; \
        const uint16_t *pa = img + ((long)yi * SW + xi) * 3, *pb = img + ((long)yi * SW + x1) * 3; \
        const uint16_t *pc = img + ((long)y1 * SW + xi) * 3, *pd = img + ((long)y1 * SW + x1) * 3; \
        float w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy; \
        R = pa[0] * w00 + pb[0] * w10 + pc[0] * w01 + pd[0] * w11; \
        G = pa[1] * w00 + pb[1] * w10 + pc[1] * w01 + pd[1] * w11; \
        B = pa[2] * w00 + pb[2] * w10 + pc[2] * w01 + pd[2] * w11; }
      int u = 0;
      for (; u + 4 <= W; u += 4, o += 12) {
        float r0, g0, b0, r1, g1, b1, r2, g2, b2, r3, g3, b3;
        BIL(u, r0, g0, b0) BIL(u + 1, r1, g1, b1) BIL(u + 2, r2, g2, b2) BIL(u + 3, r3, g3, b3)
        pixel4(px, gain, enc, MUL(wasm_f32x4_make(r0, r1, r2, r3), SC),
               MUL(wasm_f32x4_make(g0, g1, g2, g3), SC), MUL(wasm_f32x4_make(b0, b1, b2, b3), SC), o);
      }
      for (; u < W; u++, o += 3) {
        float r0, g0, b0;
        BIL(u, r0, g0, b0)
        pixel(px, gain, enc, r0 * sc, g0 * sc, b0 * sc, o);
      }
#undef BIL
    }
  }

  // 2) encodage JPEG des blocs 8×8
  if (skipEnc) return 0;
  float *BY = (float *)(slot + OFF_BLK), *BU = BY + 64, *BV = BY + 128;
  int32_t *q = (int32_t *)(BY + 192);
  const float *qy = (const float *)(slot + OFF_QY), *qc = (const float *)(slot + OFF_QC);
  const int32_t *H = (const int32_t *)(slot + OFF_HUF);
  for (int bx = 0; bx < W; bx += 8) {
    if (rows == 8 && bx + 8 <= W) {
      for (int r = 0; r < 8; r++) {
        const u8 *s = strip + (r * W + bx) * 3;
        for (int c = 0; c < 8; c++, s += 3) {
          float R = s[0], G = s[1], B = s[2];
          int k = r * 8 + c;
          BY[k] = 0.299f * R + 0.587f * G + 0.114f * B - 128;
          BU[k] = -0.168736f * R - 0.331264f * G + 0.5f * B;
          BV[k] = 0.5f * R - 0.418688f * G - 0.081312f * B;
        }
      }
    } else for (int r = 0; r < 8; r++) {
      int yy = r < rows ? r : rows - 1;
      for (int c = 0; c < 8; c++) {
        int xx = bx + c < W ? bx + c : W - 1;
        const u8 *s = strip + (yy * W + xx) * 3;
        float R = s[0], G = s[1], B = s[2];
        int k = r * 8 + c;
        BY[k] = 0.299f * R + 0.587f * G + 0.114f * B - 128;
        BU[k] = -0.168736f * R - 0.331264f * G + 0.5f * B;
        BV[k] = 0.5f * R - 0.418688f * G - 0.081312f * B;
      }
    }
    st->dcY = encode_block(st, out, BY, qy, q, st->dcY, H, H + 256, H + 512, H + 768);
    st->dcU = encode_block(st, out, BU, qc, q, st->dcU, H + 1024, H + 1280, H + 1536, H + 1792);
    st->dcV = encode_block(st, out, BV, qc, q, st->dcV, H + 1024, H + 1280, H + 1536, H + 1792);
  }
  if (restart >= 0) {
    flush_bytes(st, out);
    if (st->bitCnt > 0) write_bits(st, out, (1u << (8 - st->bitCnt)) - 1, 8 - st->bitCnt);
    flush_bytes(st, out);
    put_byte(st, out, 0xff); put_byte(st, out, 0xd0 + (restart & 7));
    st->dcY = st->dcU = st->dcV = 0;
  } else flush_bytes(st, out);
  return st->outPos;
}

// Fin de bande : vide les bits restants (bourrage à 1). Renvoie les octets écrits.
EXPORT(enc_finish) int enc_finish(u8 *slot) {
  State *st = (State *)(slot + OFF_STATE);
  u8 *out = slot + OFF_STRIP + st->w * 8 * 3;
  st->outPos = 0;
  flush_bytes(st, out);
  if (st->bitCnt > 0) write_bits(st, out, (1u << (8 - st->bitCnt)) - 1, 8 - st->bitCnt);
  flush_bytes(st, out);
  return st->outPos;
}
