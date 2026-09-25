import LibRaw from '../vendor/libraw/index.js';
import {
  DEFAULT_PARAMS, DEFAULT_GEOM, makeProcessor, processRGBA, orientedSize,
  inscribedCrop, cropInside, srgbDecode,
} from './pipeline.js';
import { renderedStats, suggestSettings, detectStraighten, SCOPE_GAIN } from './analysis.js';
import { readExif, buildSections, renderSections, sectionsToJSON } from './metadata.js';

const $ = (s) => document.querySelector(s);
const isMobile = matchMedia('(hover: none)').matches || Math.min(screen.width, screen.height) < 700;
const PREVIEW_MAX = isMobile ? 1600 : 2048;

// ---------------------------------------------------------------- état
const state = {
  file: null, exif: null, raw: null,
  SW: 0, SH: 0,               // taille pleine résolution (orientation LibRaw)
  base: { exposure: 0 },      // exposition de base (BaselineExposure DNG)
  preview: null,              // { data: Float32Array, w, h }
  params: { ...DEFAULT_PARAMS },
  geom: structuredClone(DEFAULT_GEOM),
  aspect: null,               // null = libre, sinon rapport l/h en pixels
  aspectKey: 'free', portrait: false,
  autoCrop: true,             // recadrage piloté automatiquement (non modifié à la main)
  analysis: null,             // résultat de suggestSettings
  straight: null,             // { angle, confidence }
  clipWarn: false, showBefore: false,
  tab: 'adjust',
  sections: null,
};

// ---------------------------------------------------------------- moteur (worker)
const engine = (() => {
  const w = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
  let id = 0; const pending = new Map(); let onProgress = null;
  w.onmessage = ({ data }) => {
    if (data.type === 'progress') { onProgress && onProgress(data.value); return; }
    const p = pending.get(data.id); if (!p) return;
    pending.delete(data.id);
    data.ok ? p.resolve(data) : p.reject(new Error(data.error));
  };
  w.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'Erreur du worker')); pending.clear(); };
  const call = (msg, transfer = [], progress = null) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject }); onProgress = progress;
    w.postMessage({ ...msg, id: i }, transfer);
  });
  return { call };
})();

// ---------------------------------------------------------------- UI utilitaires
function busy(text, progress = null) {
  const el = $('#busy');
  if (text === false) { el.hidden = true; return; }
  el.hidden = false; $('#busyText').textContent = text;
  const pb = $('#busyProgress');
  if (progress === null) pb.hidden = true;
  else { pb.hidden = false; pb.firstElementChild.style.width = `${Math.round(progress * 100)}%`; }
}
let toastTimer;
function toast(msg, error = false, ms = 4000) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false; t.classList.toggle('error', error);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const fmtSigned = (v, d = 0) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d).replace('.', ',');

// ---------------------------------------------------------------- ouverture
const STD_MAGIC = [[0xff, 0xd8, 0xff], [0x89, 0x50, 0x4e, 0x47], [0x52, 0x49, 0x46, 0x46], [0x47, 0x49, 0x46]];

async function openFile(file) {
  if (!file) return;
  if (!window.crossOriginIsolated) {
    toast("Le décodeur RAW nécessite une page « cross-origin isolated ». Rechargez la page (ou servez-la via HTTPS / tools/serve.mjs).", true, 9000);
  }
  try {
    busy('Lecture des métadonnées…');
    await nextFrame();
    const buf = await file.arrayBuffer();
    // (avant LibRaw, qui transfère — et donc détache — le tampon vers son worker)
    const exif = await readExif(buf);
    const head = new Uint8Array(buf, 0, 8);
    const isStd = STD_MAGIC.some((m) => m.every((b, i) => head[i] === b));
    let data, width, height, raw = null;

    if (isStd) {
      busy('Décodage de l\'image…');
      ({ data, width, height } = await decodeStandard(file));
    } else {
      busy('Décodage du RAW (LibRaw)…');
      const lr = new LibRaw();
      try {
        await lr.open(new Uint8Array(buf), {
          outputBps: 16, gamm: [1, 1], noAutoBright: true, useCameraWb: true,
          outputColor: 1, userQual: 3, highlight: 0,
        });
        raw = await lr.metadata(true);
        busy('Dématriçage…');
        const img = await lr.imageData();
        if (!img || !img.data) throw new Error('Décodage impossible');
        ({ width, height } = img);
        data = toRGB16(img);
      } finally { lr.dispose(); }
    }

    busy('Préparation de l\'aperçu…');
    const res = await engine.call({ type: 'load', data, width, height, previewMax: PREVIEW_MAX }, [data.buffer]);
    Object.assign(state, {
      file, exif, raw, SW: width, SH: height, preview: res.preview,
      params: { ...DEFAULT_PARAMS }, geom: structuredClone(DEFAULT_GEOM), aspect: null, autoCrop: true, portrait: height > width,
      base: { exposure: raw?.color_data?.dng_levels?.baseline_exposure || 0 },
      sections: null, clipWarn: false,
    });
    before.canvas = null;

    busy('Analyse colorimétrique…');
    await nextFrame();
    const p = state.preview;
    state.analysis = suggestSettings(p.data, p.w * p.h, { iso: raw?.iso_speed });
    // L'analyse est faite sans exposition de base : on la retranche de la suggestion
    if (state.base.exposure) state.analysis.auto.exposure = round2(state.analysis.auto.exposure - state.base.exposure);
    fixExposureSuggestion();
    state.straight = detectStraighten(p.data, p.w, p.h);
    addStraightSuggestion();

    showEditor();
    setupProcCanvas();
    renderSuggestions();
    syncSliders();
    setAspectChip('free');
    scheduleRender(true);
    $('#infoLine').textContent = infoText();
    busy(false);
  } catch (e) {
    console.error(e);
    busy(false);
    toast(`Impossible d'ouvrir ce fichier : ${e.message || e}`, true, 8000);
  }
}

const round2 = (v) => Math.round(v * 100) / 100;

function fixExposureSuggestion() {
  const s = state.analysis.suggestions.find((x) => x.id === 'exp');
  const ev = state.analysis.auto.exposure;
  if (s) {
    if (Math.abs(ev) < 0.1) { state.analysis.suggestions = state.analysis.suggestions.filter((x) => x !== s); state.analysis.auto.exposure = 0; }
    else { s.set = { exposure: ev }; s.text = s.text.replace(/Exposition [^ ]+ IL/, `Exposition ${fmtSigned(ev, 2)} IL`); }
  }
}

function addStraightSuggestion() {
  const st = state.straight;
  if (st && Math.abs(st.angle) >= 0.2 && Math.abs(st.angle) <= 15 && st.confidence > 6) {
    state.analysis.suggestions.push({
      id: 'straight', title: 'Horizon / verticales', icon: '📐',
      text: `Les lignes dominantes sont inclinées de ${fmtSigned(-st.angle, 1)}°. Redresser de ${fmtSigned(st.angle, 1)}°.`,
      geom: { angle: st.angle },
    });
  }
}

function toRGB16(img) {
  const { width: w, height: h, colors, bits } = img;
  let d = img.data;
  if (bits === 8) { const o = new Uint16Array(d.length); const lut = linLut8(); for (let i = 0; i < d.length; i++) o[i] = lut[d[i]]; d = o; }
  if (!(d instanceof Uint16Array)) d = new Uint16Array(d.buffer, d.byteOffset, d.byteLength / 2);
  if (colors === 3) return d;
  const out = new Uint16Array(w * h * 3);
  for (let i = 0, n = w * h; i < n; i++) {
    const v = d[i * colors];
    out[i * 3] = v; out[i * 3 + 1] = colors > 1 ? d[i * colors + 1] : v; out[i * 3 + 2] = colors > 2 ? d[i * colors + 2] : v;
  }
  return out;
}
function linLut8() { const t = new Uint16Array(256); for (let i = 0; i < 256; i++) t[i] = Math.round(srgbDecode(i / 255) * 65535); return t; }

// JPEG / PNG / WebP : décodage navigateur puis linéarisation
async function decodeStandard(file) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const n = c.width * c.height, out = new Uint16Array(n * 3), lut = linLut8();
  for (let i = 0; i < n; i++) { out[i * 3] = lut[px[i * 4]]; out[i * 3 + 1] = lut[px[i * 4 + 1]]; out[i * 3 + 2] = lut[px[i * 4 + 2]]; }
  bmp.close?.();
  return { data: out, width: c.width, height: c.height };
}

function infoText() {
  const r = state.raw;
  const parts = [];
  if (r) {
    parts.push(`${r.camera_make} ${r.camera_model}`.trim());
    if (r.shutter) parts.push(r.shutter >= 1 ? `${+r.shutter.toFixed(1)}s` : `1/${Math.round(1 / r.shutter)}`);
    if (r.aperture) parts.push(`f/${+r.aperture.toFixed(1)}`);
    if (r.iso_speed) parts.push(`ISO ${r.iso_speed}`);
    if (r.focal_len) parts.push(`${Math.round(r.focal_len)} mm`);
  }
  parts.push(`${state.SW}×${state.SH}`);
  return parts.join(' · ');
}

function showEditor() {
  $('#dropzone').hidden = true;
  $('#canvas').hidden = false;
  $('#viewerTools').hidden = false;
  $('#infoLine').hidden = false;
  $('#panel').hidden = false;
  $('#metaBtn').disabled = false;
  $('#exportBtn').disabled = false;
  $('#clipBtn').setAttribute('aria-pressed', 'false');
}

// ---------------------------------------------------------------- rendu de l'aperçu
const proc = { canvas: null, ctx: null, img: null };
const before = { canvas: null };

function setupProcCanvas() {
  const { w, h } = state.preview;
  proc.canvas = document.createElement('canvas');
  proc.canvas.width = w; proc.canvas.height = h;
  proc.ctx = proc.canvas.getContext('2d');
  proc.img = proc.ctx.createImageData(w, h);
}

function renderProcessed() {
  const { data, w, h } = state.preview;
  const pr = makeProcessor(state.params, state.base);
  processRGBA(pr, data, proc.img.data, w * h, state.clipWarn);
  proc.ctx.putImageData(proc.img, 0, 0);
}

function beforeCanvas() {
  if (before.canvas) return before.canvas;
  const { data, w, h } = state.preview;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); const img = ctx.createImageData(w, h);
  processRGBA(makeProcessor(DEFAULT_PARAMS, state.base), data, img.data, w * h);
  ctx.putImageData(img, 0, 0);
  return (before.canvas = c);
}

let renderQueued = false, statsTimer = null, needProcess = false;
function scheduleRender(process = false) {
  needProcess = needProcess || process;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!state.preview) return;
    if (needProcess) {
      needProcess = false;
      renderProcessed();
      clearTimeout(statsTimer);
      statsTimer = setTimeout(updateStats, 90);
    }
    drawView();
  });
}

// ---------------------------------------------------------------- vue (canvas principal)
const cv = $('#canvas');
const cx = cv.getContext('2d');
let view = null; // { s, ox, oy, OW, OH } : écran = (P - centre région) * s + centre canvas

function orientedDims() { return orientedSize(state.SW, state.SH, state.geom.rot90); }

function drawView() {
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width * dpr)), H = Math.max(1, Math.round(rect.height * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const [OW, OH] = orientedDims();
  const g = state.geom, c = g.crop;
  const cropMode = state.tab === 'crop';
  const pad = (cropMode ? 28 : 10) * dpr;
  let rx, ry, rw, rh;
  if (cropMode) { rx = 0; ry = 0; rw = OW; rh = OH; }
  else { rx = c.x * OW; ry = c.y * OH; rw = c.w * OW; rh = c.h * OH; }
  const s = Math.min((W - 2 * pad) / rw, (H - 2 * pad) / rh);
  view = { s, rcx: rx + rw / 2, rcy: ry + rh / 2, W, H, OW, OH, dpr };

  cx.setTransform(1, 0, 0, 1, 0, 0);
  cx.fillStyle = '#0b0c0d'; cx.fillRect(0, 0, W, H);
  cx.save();
  // repère « cadre orienté » → écran
  cx.setTransform(s, 0, 0, s, W / 2 - view.rcx * s, H / 2 - view.rcy * s);
  if (!cropMode) { cx.beginPath(); cx.rect(rx, ry, rw, rh); cx.clip(); }
  cx.translate(OW / 2, OH / 2);
  cx.rotate(g.angle * Math.PI / 180);
  cx.scale(g.flipH ? -1 : 1, 1);
  cx.rotate(g.rot90 * Math.PI / 2);
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
  const src = state.showBefore ? beforeCanvas() : proc.canvas;
  cx.drawImage(src, -state.SW / 2, -state.SH / 2, state.SW, state.SH);
  cx.restore();

  if (cropMode) drawCropOverlay();
}

const toScreen = (x, y) => [(x - view.rcx) * view.s + view.W / 2, (y - view.rcy) * view.s + view.H / 2];
const toFrame = (X, Y) => [(X - view.W / 2) / view.s + view.rcx, (Y - view.H / 2) / view.s + view.rcy];

function drawCropOverlay() {
  const { OW, OH, dpr } = view, c = state.geom.crop;
  const [x0, y0] = toScreen(c.x * OW, c.y * OH), [x1, y1] = toScreen((c.x + c.w) * OW, (c.y + c.h) * OH);
  cx.save();
  cx.fillStyle = 'rgba(0,0,0,.58)';
  cx.beginPath(); cx.rect(0, 0, view.W, view.H); cx.rect(x0, y0, x1 - x0, y1 - y0); cx.fill('evenodd');
  // grille des tiers (plus fine pendant le redressement)
  const n = dragging === 'angle' ? 8 : 3;
  cx.strokeStyle = 'rgba(255,255,255,.35)'; cx.lineWidth = 1 * dpr;
  cx.beginPath();
  for (let i = 1; i < n; i++) {
    const X = x0 + (x1 - x0) * i / n, Y = y0 + (y1 - y0) * i / n;
    cx.moveTo(X, y0); cx.lineTo(X, y1); cx.moveTo(x0, Y); cx.lineTo(x1, Y);
  }
  cx.stroke();
  cx.strokeStyle = '#fff'; cx.lineWidth = 1.5 * dpr; cx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  // poignées
  const L = 18 * dpr; cx.lineWidth = 4 * dpr; cx.lineCap = 'square';
  cx.beginPath();
  for (const [X, Y, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
    cx.moveTo(X, Y + sy * L); cx.lineTo(X, Y); cx.lineTo(X + sx * L, Y);
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, l = 10 * dpr;
  cx.moveTo(mx - l, y0); cx.lineTo(mx + l, y0); cx.moveTo(mx - l, y1); cx.lineTo(mx + l, y1);
  cx.moveTo(x0, my - l); cx.lineTo(x0, my + l); cx.moveTo(x1, my - l); cx.lineTo(x1, my + l);
  cx.stroke();
  // dimensions en pixels de sortie
  const pw = Math.round(c.w * OW), ph = Math.round(c.h * OH);
  cx.font = `${12 * dpr}px system-ui, sans-serif`;
  const txt = `${pw} × ${ph}`;
  const tw = cx.measureText(txt).width + 12 * dpr;
  cx.fillStyle = 'rgba(0,0,0,.65)'; cx.fillRect(x0, Math.max(0, y0 - 22 * dpr), tw, 20 * dpr);
  cx.fillStyle = '#fff'; cx.fillText(txt, x0 + 6 * dpr, Math.max(0, y0 - 22 * dpr) + 14 * dpr);
  cx.restore();
}

new ResizeObserver(() => state.preview && scheduleRender()).observe(cv);

// ---------------------------------------------------------------- recadrage interactif
let dragging = null, dragStart = null;

function hitTest(X, Y) {
  const { OW, OH, dpr } = view, c = state.geom.crop;
  const [x0, y0] = toScreen(c.x * OW, c.y * OH), [x1, y1] = toScreen((c.x + c.w) * OW, (c.y + c.h) * OH);
  const R = 26 * dpr;
  const nearL = Math.abs(X - x0) < R, nearR = Math.abs(X - x1) < R, nearT = Math.abs(Y - y0) < R, nearB = Math.abs(Y - y1) < R;
  const inX = X > x0 - R && X < x1 + R, inY = Y > y0 - R && Y < y1 + R;
  if (nearT && nearL) return 'nw'; if (nearT && nearR) return 'ne';
  if (nearB && nearL) return 'sw'; if (nearB && nearR) return 'se';
  if (nearT && inX) return 'n'; if (nearB && inX) return 's';
  if (nearL && inY) return 'w'; if (nearR && inY) return 'e';
  if (X > x0 && X < x1 && Y > y0 && Y < y1) return 'move';
  return null;
}

const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };

cv.addEventListener('pointerdown', (e) => {
  if (state.tab !== 'crop' || !view) return;
  const dpr = view.dpr, r = cv.getBoundingClientRect();
  const X = (e.clientX - r.left) * dpr, Y = (e.clientY - r.top) * dpr;
  const h = hitTest(X, Y);
  if (!h) return;
  cv.setPointerCapture(e.pointerId);
  dragging = h;
  const [OW, OH] = orientedDims(), c = state.geom.crop;
  dragStart = { X, Y, px: { x: c.x * OW, y: c.y * OH, w: c.w * OW, h: c.h * OH } };
  e.preventDefault();
});

cv.addEventListener('pointermove', (e) => {
  if (state.tab !== 'crop' || !view) return;
  const dpr = view.dpr, r = cv.getBoundingClientRect();
  const X = (e.clientX - r.left) * dpr, Y = (e.clientY - r.top) * dpr;
  if (!dragging) { cv.style.cursor = CURSORS[hitTest(X, Y)] || 'default'; return; }
  if (dragging === 'angle') return;
  const [OW, OH] = orientedDims();
  const dx = (X - dragStart.X) / view.s, dy = (Y - dragStart.Y) / view.s;
  const p = { ...dragStart.px };
  const minS = Math.max(16, Math.min(OW, OH) * 0.03);
  if (dragging === 'move') { p.x += dx; p.y += dy; }
  else {
    let l = p.x, t = p.y, rr = p.x + p.w, b = p.y + p.h;
    if (dragging.includes('w')) l = Math.min(rr - minS, l + dx);
    if (dragging.includes('e')) rr = Math.max(l + minS, rr + dx);
    if (dragging.includes('n')) t = Math.min(b - minS, t + dy);
    if (dragging.includes('s')) b = Math.max(t + minS, b + dy);
    let w = rr - l, h = b - t;
    const ar = state.aspect;
    if (ar) {
      if (dragging.length === 2) { // coin : dimension dominante
        if (w / h > ar) h = w / ar; else w = h * ar;
        if (dragging.includes('w')) l = rr - w; else rr = l + w;
        if (dragging.includes('n')) t = b - h; else b = t + h;
      } else if (dragging === 'n' || dragging === 's') { // bord : l'autre dimension suit, centrée
        const cxm = (l + rr) / 2; w = h * ar; l = cxm - w / 2; rr = cxm + w / 2;
      } else {
        const cym = (t + b) / 2; h = w / ar; t = cym - h / 2; b = cym + h / 2;
      }
    }
    p.x = l; p.y = t; p.w = rr - l; p.h = b - t;
  }
  const cand = { x: p.x / OW, y: p.y / OH, w: p.w / OW, h: p.h / OH };
  state.geom.crop = constrainCrop(state.geom.crop, cand, dragging === 'move');
  state.autoCrop = false;
  scheduleRender();
});

const endDrag = () => { if (dragging && dragging !== 'angle') { dragging = null; scheduleRender(); } };
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);

// Garde le recadrage valide : dans le cadre et dans l'image tournée.
function constrainCrop(cur, cand, move) {
  const [OW, OH] = orientedDims(), a = state.geom.angle;
  const ok = (c) => c.x >= -1e-9 && c.y >= -1e-9 && c.x + c.w <= 1 + 1e-9 && c.y + c.h <= 1 + 1e-9 && cropInside(OW, OH, a, c);
  if (ok(cand)) return cand;
  if (move) { // glisser le long des bords : chaque axe séparément
    const r = bisect(cur, { ...cur, x: cand.x }, ok);
    return bisect(r, { ...r, y: cand.y }, ok);
  }
  return bisect(cur, cand, ok);
}
function bisect(good, bad, ok) {
  if (!ok(good)) return good;
  let lo = 0, hi = 1;
  const lerp = (t) => ({ x: good.x + (bad.x - good.x) * t, y: good.y + (bad.y - good.y) * t, w: good.w + (bad.w - good.w) * t, h: good.h + (bad.h - good.h) * t });
  for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; if (ok(lerp(m))) lo = m; else hi = m; }
  return lerp(lo);
}

// Ajuste le recadrage après un changement d'angle/format
function refitCrop() {
  const [OW, OH] = orientedDims(), g = state.geom;
  const cur = g.crop;
  const ar = state.aspect || (state.autoCrop ? OW / OH : (cur.w * OW) / (cur.h * OH));
  const ins = inscribedCrop(OW, OH, g.angle, ar);
  if (state.autoCrop) { g.crop = ins; return; }
  if (cropInside(OW, OH, g.angle, cur)) return;
  // rapprocher le recadrage courant du rectangle inscrit jusqu'à ce qu'il soit valide
  g.crop = bisect(ins, cur, (c) => cropInside(OW, OH, g.angle, c));
}

// ---------------------------------------------------------------- curseurs
const SLIDERS = [
  { group: 'Balance des blancs' },
  { key: 'temp', label: 'Température', min: -100, max: 100, step: 1, cls: 'track-temp' },
  { key: 'tint', label: 'Teinte', min: -100, max: 100, step: 1, cls: 'track-tint' },
  { group: 'Lumière' },
  { key: 'exposure', label: 'Exposition', min: -5, max: 5, step: 0.05, fmt: (v) => `${fmtSigned(v, 2)} IL` },
  { key: 'contrast', label: 'Contraste', min: -100, max: 100, step: 1 },
  { key: 'highlights', label: 'Hautes lumières', min: -100, max: 100, step: 1 },
  { key: 'shadows', label: 'Ombres', min: -100, max: 100, step: 1 },
  { key: 'whites', label: 'Blancs', min: -100, max: 100, step: 1 },
  { key: 'blacks', label: 'Noirs', min: -100, max: 100, step: 1 },
  { group: 'Couleur' },
  { key: 'vibrance', label: 'Vibrance', min: -100, max: 100, step: 1 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, cls: 'track-sat' },
];

function buildSliders() {
  const root = $('#sliders');
  for (const d of SLIDERS) {
    if (d.group) { const h = document.createElement('h2'); h.textContent = d.group; root.appendChild(h); continue; }
    const el = document.createElement('div');
    el.className = 'slider';
    el.innerHTML = `<div class="slider-head"><label for="s-${d.key}">${d.label}<span class="sugg-mark"></span></label><output></output></div>
      <input type="range" id="s-${d.key}" min="${d.min}" max="${d.max}" step="${d.step}" value="0" class="${d.cls || ''}">`;
    const input = el.querySelector('input'), out = el.querySelector('output');
    d.input = input; d.out = out; d.mark = el.querySelector('.sugg-mark');
    input.addEventListener('input', () => { state.params[d.key] = +input.value; updateSliderText(d); scheduleRender(true); renderSuggestions(); });
    // double-clic / double-tape sur l'intitulé : remise à zéro
    const head = el.querySelector('.slider-head');
    let lastTap = 0;
    const reset = () => { state.params[d.key] = 0; syncSliders(); scheduleRender(true); renderSuggestions(); };
    head.addEventListener('dblclick', reset);
    head.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') { const t = Date.now(); if (t - lastTap < 350) reset(); lastTap = t; } });
    root.appendChild(el);
  }
}
function updateSliderText(d) {
  const v = state.params[d.key];
  d.out.textContent = d.fmt ? d.fmt(v) : fmtSigned(v);
  d.out.classList.toggle('changed', v !== 0);
  const sug = state.analysis?.auto?.[d.key];
  d.mark.textContent = sug && sug !== v ? ` suggéré ${d.fmt ? fmtSigned(sug, 2) : fmtSigned(sug)}` : '';
}
function syncSliders() {
  for (const d of SLIDERS) if (d.key) { d.input.value = state.params[d.key]; updateSliderText(d); }
}

// ---------------------------------------------------------------- suggestions
function isApplied(s) {
  if (s.set) return Object.entries(s.set).every(([k, v]) => Math.abs(state.params[k] - v) < 1e-6);
  if (s.geom) return Math.abs(state.geom.angle - s.geom.angle) < 0.01;
  return true;
}
function applySuggestion(s) {
  if (s.set) Object.assign(state.params, s.set);
  if (s.geom) setAngle(s.geom.angle);
  syncSliders(); scheduleRender(true); renderSuggestions();
}
function renderSuggestions() {
  const ul = $('#suggestList');
  const list = state.analysis?.suggestions || [];
  ul.innerHTML = '';
  if (!list.length) { ul.innerHTML = '<li class="empty">L\'image est déjà bien équilibrée : aucune correction nécessaire.</li>'; return; }
  for (const s of list) {
    const li = document.createElement('li');
    const applied = isApplied(s);
    li.innerHTML = `<span class="ico">${s.icon}</span><span class="txt"><b></b></span>`;
    li.querySelector('b').textContent = s.title;
    li.querySelector('.txt').append(s.text);
    if (s.set || s.geom) {
      const b = document.createElement('button');
      b.className = 'btn small'; b.textContent = applied ? '✓' : 'Appliquer'; b.disabled = applied;
      b.addEventListener('click', () => applySuggestion(s));
      li.appendChild(b);
      if (applied) li.querySelector('.txt').classList.add('applied');
    }
    ul.appendChild(li);
  }
}
$('#autoBtn').addEventListener('click', () => {
  if (!state.analysis) return;
  for (const s of state.analysis.suggestions) { if (s.set) Object.assign(state.params, s.set); if (s.geom) setAngle(s.geom.angle); }
  syncSliders(); scheduleRender(true); renderSuggestions();
  toast('Suggestions appliquées. Ajustez librement les curseurs.');
});
$('#resetBtn').addEventListener('click', () => {
  state.params = { ...DEFAULT_PARAMS }; syncSliders(); scheduleRender(true); renderSuggestions();
});

// ---------------------------------------------------------------- analyse / histogrammes
function updateStats() {
  if (!proc.img) return;
  const { w, h } = state.preview;
  const st = renderedStats(proc.img.data, w * h, (w * h) > 1.5e6 ? 2 : 1);
  drawHistogram($('#histoSmall'), st);
  if (state.tab === 'analyse') {
    drawHistogram($('#histoBig'), st);
    drawHue($('#hueCanvas'), st.hue);
    drawScope($('#scopeCanvas'), st.scope);
    drawStatsTable(st);
  }
  state.lastStats = st;
}

function drawHistogram(c, st) {
  const ctx = c.getContext('2d'), W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  const chans = [[st.hist.r, '#ff3b3b'], [st.hist.g, '#3bd35a'], [st.hist.b, '#3b7bff']];
  let max = 1;
  for (const [h] of chans) for (let i = 2; i < 254; i++) if (h[i] > max) max = h[i];
  const y = (v) => H - Math.min(1, Math.sqrt(v / max)) * (H - 6);
  ctx.globalCompositeOperation = 'lighter';
  for (const [h, col] of chans) {
    ctx.fillStyle = col; ctx.globalAlpha = 0.75;
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) ctx.lineTo(i / 255 * W, y(h[i]));
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(235,235,235,.8)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < 256; i++) { const X = i / 255 * W, Y = y(st.hist.l[i]); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }
  ctx.stroke();
  // repères des quarts
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1;
  ctx.beginPath(); for (let i = 1; i < 4; i++) { ctx.moveTo(W * i / 4, 0); ctx.lineTo(W * i / 4, H); } ctx.stroke();
  // indicateurs d'écrêtage
  const hi = Math.max(...st.clipHi), lo = st.clipLo;
  const tri = (x, dir, on, col) => { ctx.fillStyle = on ? col : 'rgba(255,255,255,.15)'; ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x + dir * 14, 4); ctx.lineTo(x, 18); ctx.fill(); };
  tri(4, 1, lo > 0.002, '#4d8bff'); tri(W - 4, -1, hi > 0.002, '#ff4d6a');
}

function drawHue(c, hue) {
  const ctx = c.getContext('2d'), W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  let max = 1e-9; for (const v of hue) if (v > max) max = v;
  const bw = W / hue.length;
  for (let i = 0; i < hue.length; i++) {
    const h = Math.sqrt(hue[i] / max) * (H - 18);
    ctx.fillStyle = `hsl(${i * 5 + 2.5}, 90%, 55%)`;
    ctx.fillRect(i * bw + 0.5, H - 12 - h, bw - 1, h);
  }
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60}, 90%, 50%)`);
  ctx.fillStyle = grad; ctx.fillRect(0, H - 8, W, 8);
}

function drawScope(c, scope) {
  const ctx = c.getContext('2d'), W = c.width, H = c.height;
  const img = ctx.createImageData(128, 128);
  let max = 1; for (const v of scope) if (v > max) max = v;
  const lm = Math.log(1 + max);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const v = scope[y * 128 + x]; if (!v) continue;
    const a = Math.log(1 + v) / lm;
    const cb = (x - 64) * 2 / SCOPE_GAIN, cr = (64 - y) * 2 / SCOPE_GAIN;
    const r = 128 + 1.402 * cr, g = 128 - 0.344136 * cb - 0.714136 * cr, b = 128 + 1.772 * cb;
    const o = (y * 128 + x) * 4, k = 0.5 + a;
    img.data[o] = Math.min(255, r * k); img.data[o + 1] = Math.min(255, g * k); img.data[o + 2] = Math.min(255, b * k);
    img.data[o + 3] = Math.min(255, 60 + a * 255);
  }
  const t = document.createElement('canvas'); t.width = 128; t.height = 128; t.getContext('2d').putImageData(img, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(W / 2, H / 2, W / 2 - 1, 0, 7); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(W / 2, H / 2, W / 4, 0, 7); ctx.stroke();
  // ligne des tons chair (~123°)
  ctx.strokeStyle = 'rgba(255,200,150,.35)'; ctx.beginPath(); ctx.moveTo(W / 2, H / 2);
  const ang = 123 * Math.PI / 180; ctx.lineTo(W / 2 + Math.cos(ang) * W / 2, H / 2 - Math.sin(ang) * H / 2); ctx.stroke();
  ctx.imageSmoothingEnabled = true; ctx.drawImage(t, 0, 0, W, H);
  // cibles primaires/secondaires
  ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [lab, r, g, b] of [['R', 191, 0, 0], ['J', 191, 191, 0], ['V', 0, 191, 0], ['C', 0, 191, 191], ['B', 0, 0, 191], ['M', 191, 0, 191]]) {
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b, cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
    const X = (64 + cb * SCOPE_GAIN / 2) / 128 * W, Y = (64 - cr * SCOPE_GAIN / 2) / 128 * H;
    ctx.strokeStyle = `rgba(${r * 1.33},${g * 1.33},${b * 1.33},.7)`; ctx.strokeRect(X - 9, Y - 9, 18, 18);
    ctx.fillStyle = `rgba(${r * 1.33},${g * 1.33},${b * 1.33},.9)`; ctx.fillText(lab, X, Y);
  }
}

function drawStatsTable(st) {
  const pct = (v) => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)} %`;
  // dominante : moyenne Cb/Cr
  let scb = 0, scr = 0, n = 0;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) { const v = st.scope[y * 128 + x]; scb += (x - 64) * v; scr += (64 - y) * v; n += v; }
  scb /= n; scr /= n;
  const mag = Math.hypot(scb, scr);
  let cast = 'neutre';
  if (mag > 1.5) {
    const a = (Math.atan2(scr, scb) * 180 / Math.PI + 360) % 360;
    const names = [[0, 'bleu-magenta'], [45, 'magenta'], [90, 'rouge'], [135, 'orangé / jaune'], [180, 'jaune-vert'], [225, 'vert'], [270, 'cyan / vert'], [315, 'bleu']];
    let best = names[0][1], bd = 999;
    for (const [ang, nm] of names) { const d = Math.min(Math.abs(a - ang), 360 - Math.abs(a - ang)); if (d < bd) { bd = d; best = nm; } }
    cast = `${best} (${mag < 4 ? 'légère' : mag < 8 ? 'marquée' : 'forte'})`;
  }
  const hl = st.hist.l; let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) { acc += hl[i]; if (acc > st.count * 0.005) { lo = i; break; } }
  acc = 0; for (let i = 255; i >= 0; i--) { acc += hl[i]; if (acc > st.count * 0.005) { hi = i; break; } }
  const [OW, OH] = orientedDims(), c = state.geom.crop;
  const rows = [
    ['Taille d\'export', `${Math.round(c.w * OW)} × ${Math.round(c.h * OH)} px`],
    ['Luminance moyenne', pct(st.meanL)],
    ['Luminance médiane', pct(st.median)],
    ['Plage tonale utilisée (0,5–99,5 %)', `${lo} → ${hi}`],
    ['Hautes lumières écrêtées R / V / B', st.clipHi.map(pct).join(' / ')],
    ['Noirs bouchés', pct(st.clipLo)],
    ['Saturation moyenne', pct(st.meanSat)],
    ['Dominante colorée', cast],
  ];
  $('#statsTable').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
}

// ---------------------------------------------------------------- onglets
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  state.tab = t.dataset.tab;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.tab-body').forEach((b) => (b.hidden = b.dataset.body !== state.tab));
  if (state.tab === 'analyse') updateStats();
  scheduleRender();
}));

// ---------------------------------------------------------------- géométrie (UI)
function setAngle(a) {
  state.geom.angle = Math.max(-45, Math.min(45, a));
  $('#angleRange').value = state.geom.angle;
  $('#angleOut').textContent = `${fmtSigned(state.geom.angle, 1)}°`;
  refitCrop();
  scheduleRender();
}
const angleRange = $('#angleRange');
angleRange.addEventListener('input', () => { dragging = 'angle'; setAngle(+angleRange.value); renderSuggestions(); });
angleRange.addEventListener('change', () => { dragging = null; scheduleRender(); });
$('#angleSlider .slider-head').addEventListener('dblclick', () => { setAngle(0); renderSuggestions(); });

// Format : clé du bouton actif + orientation du cadre (paysage / portrait)
function computeAspect() {
  const [OW, OH] = orientedDims(), k = state.aspectKey;
  if (k === 'free') return null;
  const r = k === 'orig' ? Math.max(OW, OH) / Math.min(OW, OH) : +k;
  return state.portrait ? 1 / r : r;
}
function setAspectChip(val) {
  if (val !== undefined) state.aspectKey = val;
  document.querySelectorAll('#aspectChips .chip[data-aspect]').forEach((c) => {
    c.classList.toggle('active', c.dataset.aspect === state.aspectKey);
    if (c.dataset.l) c.textContent = state.portrait ? c.dataset.p : c.dataset.l;
  });
  document.querySelectorAll('#orientChips .chip').forEach((c) =>
    c.classList.toggle('active', (c.dataset.orient === 'portrait') === state.portrait));
}
document.querySelectorAll('#aspectChips .chip[data-aspect]').forEach((chip) => chip.addEventListener('click', () => {
  setAspectChip(chip.dataset.aspect);
  state.aspect = computeAspect();
  state.autoCrop = true; refitCrop();
  scheduleRender(); updateStats();
}));
document.querySelectorAll('#orientChips .chip').forEach((chip) => chip.addEventListener('click', () => {
  const portrait = chip.dataset.orient === 'portrait';
  if (portrait === state.portrait) return;
  state.portrait = portrait;
  if (state.aspectKey === 'free') {
    // format libre : on inverse les proportions du cadre actuel
    const [OW, OH] = orientedDims(), c = state.geom.crop;
    state.aspect = (c.h * OH) / (c.w * OW);
    state.autoCrop = true; refitCrop();
    state.aspect = null; state.autoCrop = false;
  } else {
    state.aspect = computeAspect();
    state.autoCrop = true; refitCrop();
  }
  setAspectChip();
  scheduleRender(); updateStats();
}));
function rotate90(dir) {
  const g = state.geom;
  g.rot90 = (g.rot90 + (dir > 0 ? 1 : 3)) % 4;
  state.portrait = !state.portrait; // le cadre tourne avec l'image
  state.aspect = computeAspect(); setAspectChip();
  state.autoCrop = true; refitCrop(); scheduleRender(); updateStats();
}
$('#rotL').addEventListener('click', () => rotate90(-1));
$('#rotR').addEventListener('click', () => rotate90(1));
$('#flipH').addEventListener('click', () => {
  const g = state.geom; g.flipH = !g.flipH;
  g.crop = { ...g.crop, x: 1 - g.crop.x - g.crop.w };
  $('#flipH').classList.toggle('active', g.flipH);
  setAngle(-g.angle);
});
$('#cropReset').addEventListener('click', () => {
  state.geom = structuredClone(DEFAULT_GEOM); state.aspect = null; state.autoCrop = true;
  state.portrait = state.SH > state.SW;
  setAspectChip('free'); $('#flipH').classList.remove('active'); setAngle(0); renderSuggestions();
});
$('#autoStraight').addEventListener('click', () => {
  const st = state.straight;
  if (!st) return;
  const a = state.geom.flipH ? -st.angle : st.angle;
  if (st.confidence < 4 || Math.abs(st.angle) > 20) {
    $('#straightInfo').textContent = 'Aucune ligne dominante fiable n\'a été trouvée : utilisez le curseur.';
    return;
  }
  setAngle(a);
  renderSuggestions();
  $('#straightInfo').textContent = Math.abs(a) < 0.05
    ? 'L\'image est déjà droite.'
    : `Redressé de ${fmtSigned(a, 2)}° d'après les lignes horizontales / verticales dominantes (fiabilité ${Math.min(100, Math.round(st.confidence * 3))} %).`;
});

// ---------------------------------------------------------------- avant/après, écrêtage
const beforeBtn = $('#beforeBtn');
const setBefore = (v) => { if (state.showBefore !== v) { state.showBefore = v; beforeBtn.classList.toggle('active', v); scheduleRender(); } };
beforeBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); beforeBtn.setPointerCapture(e.pointerId); setBefore(true); });
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => beforeBtn.addEventListener(ev, () => setBefore(false)));
beforeBtn.addEventListener('contextmenu', (e) => e.preventDefault());
$('#clipBtn').addEventListener('click', () => {
  state.clipWarn = !state.clipWarn;
  $('#clipBtn').setAttribute('aria-pressed', String(state.clipWarn));
  scheduleRender(true);
});
window.addEventListener('keydown', (e) => {
  if (e.key === '\\' && !e.repeat && state.preview) setBefore(true);
});
window.addEventListener('keyup', (e) => { if (e.key === '\\') setBefore(false); });

// ---------------------------------------------------------------- métadonnées
$('#metaBtn').addEventListener('click', () => {
  if (!state.sections) state.sections = buildSections(state.file, state.exif, state.raw, { size: `${state.SW} × ${state.SH}` });
  $('#metaSearch').value = '';
  renderSections($('#metaBody'), state.sections);
  $('#metaDialog').showModal();
});
$('#metaSearch').addEventListener('input', (e) => renderSections($('#metaBody'), state.sections, e.target.value));
$('#metaCopy').addEventListener('click', async () => {
  const json = sectionsToJSON(state.sections);
  try { await navigator.clipboard.writeText(json); toast('Métadonnées copiées (JSON).'); }
  catch {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = baseName() + '-metadata.json'; a.click();
  }
});

// ---------------------------------------------------------------- export
const baseName = () => (state.file?.name || 'image').replace(/\.[^.]+$/, '');
let lastExportUrl = null, lastExportFile = null;

function exifDate() {
  const d = state.exif?.exif?.DateTimeOriginal || (state.raw?.timestamp instanceof Date ? state.raw.timestamp : null);
  if (!(d instanceof Date) || isNaN(d)) return undefined;
  // exifr interprète la date EXIF comme locale : on la ré-écrit à l'identique
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

$('#exportBtn').addEventListener('click', async () => {
  if (!state.preview) return;
  const r = state.raw || {};
  const exif = {
    make: r.camera_make || state.exif?.ifd0?.Make, model: r.camera_model || state.exif?.ifd0?.Model,
    software: 'QuickRaw', dateTime: exifDate(), exposureTime: r.shutter, fNumber: r.aperture,
    iso: r.iso_speed, focalLength: r.focal_len, lensModel: r.lens?.Lens || state.exif?.exif?.LensModel,
    artist: r.artist, description: r.desc,
  };
  try {
    busy('Export JPG pleine résolution…', 0);
    const t0 = performance.now();
    const res = await engine.call(
      { type: 'export', params: state.params, base: state.base, geom: state.geom, quality: 100, exif },
      [], (v) => busy(`Export JPG pleine résolution… ${Math.round(v * 100)} %`, v));
    busy(false);
    const blob = res.blob;
    if (lastExportUrl) URL.revokeObjectURL(lastExportUrl);
    lastExportUrl = URL.createObjectURL(blob);
    const name = baseName() + '.jpg';
    lastExportFile = new File([blob], name, { type: 'image/jpeg' });
    const [OW, OH] = orientedDims(), c = state.geom.crop;
    $('#exportInfo').textContent = `${name} — ${Math.round(c.w * OW)} × ${Math.round(c.h * OH)} px, qualité 100 %, ${(blob.size / 1048576).toFixed(1)} Mo (${((performance.now() - t0) / 1000).toFixed(1)} s).`;
    const dl = $('#exportDownload'); dl.href = lastExportUrl; dl.download = name;
    $('#exportShare').hidden = !(navigator.canShare && navigator.canShare({ files: [lastExportFile] }));
    $('#exportDialog').showModal();
  } catch (e) {
    console.error(e); busy(false);
    toast(`Échec de l'export : ${e.message || e}`, true, 8000);
  }
});
$('#exportShare').addEventListener('click', async () => {
  try { await navigator.share({ files: [lastExportFile], title: lastExportFile.name }); }
  catch (e) { if (e.name !== 'AbortError') toast('Partage impossible : ' + e.message, true); }
});

// ---------------------------------------------------------------- entrées fichier
for (const id of ['#fileInput', '#fileInput2']) {
  $(id).addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; openFile(f); });
}
const viewer = $('#viewer'), dz = $('#dropzone');
viewer.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
viewer.addEventListener('dragleave', () => dz.classList.remove('drag'));
viewer.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); openFile(e.dataTransfer.files[0]); });

if (!window.crossOriginIsolated) {
  const w = $('#coiWarn');
  w.hidden = false;
  w.textContent = location.protocol === 'file:'
    ? 'Ouvrez la page via un serveur web (ex. « node tools/serve.mjs ») : le décodeur RAW ne fonctionne pas en file://.'
    : 'Activation du décodeur RAW… si ce message persiste, rechargez la page.';
}

buildSliders();
window.quickraw = { state, openFile, get view() { return view; } }; // pratique pour le débogage
