// Export accéléré : module WebAssembly (native/qr.c → vendor/qr/qr.wasm).
// L'image pleine résolution vit directement dans la mémoire partagée du module,
// que tous les workers d'export lisent sans copie :
//   [0, 1 Mo)            données du module (tables constantes)
//   [1 Mo, +8 slots)     un espace de travail par worker (paramètres, tampons)
//   [img, img + W×H×6)   image RVB 16 bits
export const NSLOT = 8;
const BASE = 1 << 20;
const OFF_STRIP = 1024 + 16384 + 65536 + 256 + 256 + 8192 + 64 + 1024 + 65536; // = native/qr.c
export const slotSize = (w) => ((OFF_STRIP + w * 72 + 4096) + 65535) & ~65535;

export function layoutFor(SW, SH, mosaicPixels = 0) {
  const ss = slotSize(Math.max(SW, SH)); // la sortie peut être tournée de 90°
  const img = BASE + NSLOT * ss;
  const mosaic = img + SW * SH * 6;      // plan brut du capteur (dématriçage), facultatif
  return { slots: BASE, slotSize: ss, img, mosaic, bytes: mosaic + mosaicPixels * 2 };
}

// Mémoire pour le dématriçage : image de sortie orientée + plan brut (zone visible)
export function createMosaicMemory(raw, flip) {
  const { raw_width: RW, top_margin: T, left_margin: L, width: W, height: H } = raw;
  const [OW, OH] = flip & 4 ? [H, W] : [W, H];
  const layout = layoutFor(OW, OH, W * H);
  const pages = Math.ceil(layout.bytes / 65536);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const plane = new Uint16Array(memory.buffer, layout.mosaic, W * H);
  for (let y = 0; y < H; y++) plane.set(raw.data.subarray((y + T) * RW + L, (y + T) * RW + L + W), y * W);
  return { memory, layout, W, H, OW, OH, data: new Uint16Array(memory.buffer, layout.img, OW * OH * 3) };
}

// Copie l'image dans une mémoire WebAssembly partagée. Renvoie null si impossible.
export function createSharedImage(data, SW, SH) {
  try {
    const layout = layoutFor(SW, SH);
    const pages = Math.ceil(layout.bytes / 65536);
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
    const view = new Uint16Array(memory.buffer, layout.img, SW * SH * 3);
    view.set(data);
    return { memory, layout, data: view };
  } catch (e) {
    console.warn('Mémoire WebAssembly indisponible, export JavaScript :', e);
    return null;
  }
}

let modP = null;
export function getModule() {
  if (!modP) {
    const url = new URL('../vendor/qr/qr.wasm', import.meta.url);
    modP = (WebAssembly.compileStreaming ? WebAssembly.compileStreaming(fetch(url)) : fetch(url).then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b)))
      .catch((e) => { console.warn('Module WebAssembly indisponible, export JavaScript :', e); return null; });
  }
  return modP;
}

// Côté worker : instancie le module sur la mémoire partagée et prépare le slot
export function setupSlot(module, memory, slot, spec, encLut, map, identity, quality, glow = null) {
  const { exports: X } = new WebAssembly.Instance(module, { env: { memory } });
  const P = new Float64Array(memory.buffer, slot, 128);
  P.fill(0);
  P[0] = spec.mr; P[1] = spec.mg; P[2] = spec.mb;
  if (spec.mono) { P[3] = 1; P[4] = spec.mono[0]; P[5] = spec.mono[1]; P[6] = spec.mono[2]; }
  P[7] = spec.la; P[8] = spec.K; P[9] = spec.sat; P[10] = spec.vib; P[11] = spec.hasHue ? 1 : 0;
  if (spec.hasHue) for (let i = 0; i < 12; i++) { P[12 + i] = spec.lookSat[i]; P[24 + i] = spec.lookLum[i]; P[36 + i] = spec.lookShift[i]; }
  if (spec.split) {
    P[48] = 1;
    for (let i = 0; i < 3; i++) { P[49 + i] = spec.split.s[i]; P[52 + i] = spec.split.h[i]; }
    P[55] = spec.split.kS; P[56] = spec.split.kH;
  }
  const r0 = map.row(0), r1 = map.row(1);
  P[57] = identity ? 1 : 0; P[58] = r0.sx; P[59] = r0.sy; P[60] = r0.dx; P[61] = r0.dy;
  P[62] = r1.sx - r0.sx; P[63] = r1.sy - r0.sy;
  P[64] = spec.vigAmt || 0; P[65] = map.outW; P[66] = map.outH;
  if (glow && spec.hal) {
    P[67] = 1; P[68] = glow.mw; P[69] = glow.mh; P[70] = spec.hal.color[0]; P[71] = spec.hal.color[1]; P[72] = spec.hal.color[2];
    new Float32Array(memory.buffer, slot + X.glow_offset(), glow.mw * glow.mh).set(glow.map);
  }
  new Float32Array(memory.buffer, slot + X.gain_offset(), 4096).set(spec.gain);
  new Uint8Array(memory.buffer, slot + X.enc_offset(), 65536).set(encLut);
  X.enc_init(slot, map.outW, map.outH, quality);
  return X;
}
