// Traitement par lot : plusieurs RAW/DNG → filtre + suggestions automatiques
// (ou réglages de la photo ouverte) → JPG qualité 100 % pleine résolution.
// Sorties : dossier (File System Access, ordinateur), archive ZIP découpée en
// parties, ou partage (feuille de partage mobile → « Enregistrer dans Photos »).
import { engine } from './engine.js';
import { isStandardImage, decodeFull, decodeStandard, exportExifFields, baselineExposure } from './decode.js';
import { readExif } from './metadata.js';
import { suggestSettings, detectStraighten } from './analysis.js';
import { DEFAULT_PARAMS, DEFAULT_GEOM, LOOKS, makeProcessor, processRGBA, inscribedCrop } from './pipeline.js';
import { exportJpeg } from './exporter.js';
import { readLevel, levelAngle } from './level.js';
import { ZipBuilder, crc32 } from './zip.js';

const $ = (s) => document.querySelector(s);
const isMobile = matchMedia('(hover: none)').matches || Math.min(screen.width, screen.height) < 700;
const MB = 1048576;
// Taille max d'une partie : sur mobile on reste raisonnable (mémoire), et on
// attend que l'utilisateur ait récupéré la partie avant de continuer.
const ZIP_PART = isMobile ? 300 * MB : 1800 * MB;
const SHARE_PART = { count: 10, bytes: 200 * MB };

const canFolder = typeof window.showDirectoryPicker === 'function';
const canShareFiles = (() => {
  try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(4)], 't.jpg', { type: 'image/jpeg' })] })); }
  catch { return false; }
})();

const fmtMB = (b) => `${(b / MB).toFixed(b < 10 * MB ? 1 : 0).replace('.', ',')} Mo`;
const fmtDur = (s) => (s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`);
const round2 = (v) => Math.round(v * 100) / 100;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initBatch({ getCurrent, toast }) {
  const dlg = $('#batchDialog');
  let files = [];
  let running = false, cancelled = false;

  // ---------- configuration ----------
  const sel = $('#bLook');
  let group = null, og = null;
  for (const [k, lk] of Object.entries(LOOKS)) {
    if (lk.group !== group) { group = lk.group; og = document.createElement('optgroup'); og.label = group; sel.appendChild(og); }
    const o = document.createElement('option'); o.value = k; o.textContent = lk.name; og.appendChild(o);
  }
  const amt = $('#bLookAmount');
  const syncAmount = () => { $('#bLookAmountOut').textContent = `${amt.value} %`; $('#bLookAmountRow').hidden = sel.value === 'none'; };
  sel.addEventListener('change', syncAmount);
  amt.addEventListener('input', syncAmount);

  // Sorties disponibles selon l'appareil
  $('#bOutFolder').hidden = !canFolder;
  $('#bOutShare').hidden = !canShareFiles;
  $('#bZipHint').textContent = isMobile
    ? `découpée en parties de ${fmtMB(ZIP_PART)} max. ; le traitement attend que chaque partie soit téléchargée`
    : `découpée en parties de ${fmtMB(ZIP_PART)} max.`;

  $('#bFiles').addEventListener('change', (e) => { setFiles([...e.target.files]); e.target.value = ''; });

  function setFiles(list) {
    files = list.filter((f) => f.size > 0);
    const total = files.reduce((s, f) => s + f.size, 0);
    $('#bCount').textContent = files.length
      ? `${files.length} photo${files.length > 1 ? 's' : ''} sélectionnée${files.length > 1 ? 's' : ''} (${fmtMB(total)})`
      : 'Aucune photo sélectionnée';
    $('#bStart').disabled = !files.length;
    const est = files.length * (isMobile ? 15 : 6);
    $('#bEstimate').textContent = files.length ? `Durée estimée : environ ${fmtDur(est)}${isMobile ? ' — gardez la page ouverte, écran allumé.' : '.'}` : '';
  }

  function open(preselected = []) {
    if (running) { dlg.showModal(); return; }
    const cur = getCurrent();
    const syncRadio = $('#bModeSync');
    syncRadio.disabled = !cur;
    $('#bModeSyncLabel').classList.toggle('disabled', !cur);
    if (!cur && syncRadio.checked) $('#bModeAuto').checked = true;
    sel.value = cur?.params.look || 'none';
    amt.value = cur?.params.lookAmount ?? 100;
    syncAmount();
    const out = document.querySelector('input[name=bOut]:checked');
    if (!out || out.closest('label').hidden) {
      (canFolder && !isMobile ? $('#bOutFolder input') : canShareFiles && isMobile ? $('#bOutShare input') : $('#bOutZip input')).checked = true;
    }
    $('#bConfig').hidden = false; $('#bRun').hidden = true;
    setFiles(preselected);
    dlg.showModal();
  }

  $('#bStart').addEventListener('click', async () => {
    const mode = document.querySelector('input[name=bMode]:checked').value;
    const output = document.querySelector('input[name=bOut]:checked').value;
    let dir = null;
    if (output === 'folder') {
      // doit être appelé directement dans le geste utilisateur
      try { dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'quickraw-lot' }); }
      catch (e) { if (e.name !== 'AbortError') toast('Accès au dossier refusé : ' + e.message, true); return; }
    }
    const cur = getCurrent();
    run({
      files: [...files], output, dir,
      look: sel.value, lookAmount: +amt.value,
      mode: mode === 'sync' && cur ? 'sync' : 'auto', syncParams: cur ? { ...cur.params } : null,
      straighten: $('#bStraight').checked,
    });
  });

  $('#bCancel').addEventListener('click', () => {
    if (!running) { dlg.close(); return; }
    cancelled = true;
    $('#bCancel').disabled = true;
    $('#bStatus').textContent = 'Annulation après la photo en cours…';
    if (waitingPart) waitingPart(); // débloque une éventuelle attente de téléchargement
  });
  dlg.addEventListener('cancel', (e) => { if (running) e.preventDefault(); }); // Échap ne coupe pas le lot

  // ---------- exécution ----------
  let waitingPart = null;
  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch { /* facultatif */ }
  }
  document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') keepAwake(); });
  window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });

  async function run(opts) {
    running = true; cancelled = false;
    $('#bConfig').hidden = true; $('#bRun').hidden = false;
    $('#bCancel').disabled = false; $('#bCancel').textContent = 'Annuler';
    $('#bParts').innerHTML = '';
    const list = $('#bList');
    list.innerHTML = '';
    const rows = opts.files.map((f) => {
      const li = document.createElement('li');
      li.innerHTML = `<canvas width="72" height="48"></canvas><div class="b-name">${esc(f.name)}</div><div class="b-state">En attente</div>`;
      list.appendChild(li);
      return { li, canvas: li.querySelector('canvas'), state: li.querySelector('.b-state') };
    });
    await keepAwake();

    const t0 = performance.now();
    let done = 0, ok = 0, failed = 0, totalBytes = 0, partNo = 0;
    let zip = opts.output === 'zip' ? new ZipBuilder() : null;
    let shareFiles = [], shareBytes = 0;
    const usedNames = new Set();
    const progress = (frac) => {
      const n = opts.files.length, p = (done + frac) / n;
      $('#bBar').style.width = `${Math.round(p * 100)}%`;
      const el = (performance.now() - t0) / 1000;
      const eta = done + frac > 0.3 ? el / (done + frac) * (n - done - frac) : null;
      $('#bStatus').textContent = `${Math.min(done + 1, n)} / ${n}` + (eta ? ` — reste environ ${fmtDur(eta)}` : '');
    };

    // Une partie (ZIP ou lot à partager) est prête : proposer de la récupérer
    const flushPart = async (final) => {
      if (zip && zip.count) {
        partNo++;
        const blob = zip.finish(), count = zip.count;
        zip = final ? null : new ZipBuilder();
        const name = `QuickRaw-lot${partNo > 1 || !final ? '-' + partNo : ''}.zip`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.className = 'btn primary'; a.href = url; a.download = name;
        a.textContent = `⬇ ${name} — ${count} photo${count > 1 ? 's' : ''}, ${fmtMB(blob.size)}`;
        $('#bParts').appendChild(a);
        const pause = isMobile && !final;
        if (!isMobile) a.click(); // ordinateur : téléchargement automatique
        if (pause) await waitFor(a, 'Partie prête : téléchargez-la pour continuer.');
        setTimeout(() => URL.revokeObjectURL(url), 120000);
      }
      if (shareFiles.length) {
        partNo++;
        const batch = shareFiles; shareFiles = []; shareBytes = 0;
        const b = document.createElement('button');
        b.className = 'btn primary';
        b.textContent = `Partager / Enregistrer ${batch.length} photo${batch.length > 1 ? 's' : ''} (${fmtMB(batch.reduce((s, f) => s + f.size, 0))})`;
        $('#bParts').appendChild(b);
        b.addEventListener('click', async () => {
          try { await navigator.share({ files: batch, title: 'QuickRaw' }); b.textContent = '✓ ' + b.textContent; b.disabled = true; }
          catch (e) { if (e.name !== 'AbortError') toast('Partage impossible : ' + e.message, true); }
        });
        // le partage exige un geste de l'utilisateur : on attend toujours
        await waitFor(b, final ? 'Terminé : partagez les dernières photos.' : 'Partagez ces photos pour continuer.', !final);
      }
    };
    const waitFor = (el, msg, block = true) => new Promise((resolve) => {
      $('#bStatus').textContent = msg;
      el.classList.add('pulse');
      const go = () => { el.classList.remove('pulse'); waitingPart = null; resolve(); };
      if (!block) { resolve(); el.addEventListener('click', () => el.classList.remove('pulse'), { once: true }); return; }
      waitingPart = go;
      el.addEventListener('click', () => setTimeout(go, 300), { once: true });
    });

    for (let i = 0; i < opts.files.length; i++) {
      if (cancelled) break;
      const file = opts.files[i], row = rows[i];
      row.li.classList.add('active');
      row.li.scrollIntoView({ block: 'nearest' });
      const t1 = performance.now();
      try {
        progress(0);
        row.state.textContent = 'Décodage…';
        const buf = await file.arrayBuffer();
        const exif = await readExif(buf);
        let dec;
        if (isStandardImage(buf)) dec = { ...(await decodeStandard(file)), raw: null };
        else dec = await decodeFull(buf, { withMeta: true });
        progress(0.45);

        row.state.textContent = 'Analyse…';
        const { width: W, height: H } = dec;
        const sp = await engine.call({ type: 'sharePreview', data: dec.data, width: W, height: H, previewMax: 1200 }, [dec.data.buffer]);
        dec.data = null;
        const prev = sp.preview, base = { exposure: baselineExposure(dec.raw) };
        let params;
        if (opts.mode === 'sync') params = { ...opts.syncParams, look: opts.look, lookAmount: opts.lookAmount };
        else {
          const a = suggestSettings(prev.data, prev.w * prev.h, { w: prev.w, h: prev.h, iso: dec.raw?.iso_speed, look: opts.look, lookAmount: opts.lookAmount }).auto;
          a.exposure = round2(a.exposure - base.exposure);
          if (Math.abs(a.exposure) < 0.1) a.exposure = 0;
          params = { ...DEFAULT_PARAMS, ...a, look: opts.look, lookAmount: opts.lookAmount };
        }
        const geom = structuredClone(DEFAULT_GEOM);
        let note = '';
        if (opts.straighten) {
          // niveau électronique de l'appareil en priorité, sinon analyse de l'image
          const lv = levelAngle(readLevel(exif));
          let ang = null, src = '';
          if (lv !== null) { ang = Math.abs(lv) >= 0.2 ? lv : null; src = ' (niveau)'; }
          else {
            const st = detectStraighten(prev.data, prev.w, prev.h);
            if (st.confidence > 6 && Math.abs(st.angle) >= 0.2 && Math.abs(st.angle) <= 15) ang = st.angle;
          }
          if (ang !== null) {
            geom.angle = ang; geom.crop = inscribedCrop(W, H, ang, W / H);
            note = ` · redressé ${ang > 0 ? '+' : ''}${ang.toFixed(1).replace('.', ',')}°${src}`;
          }
        }
        drawThumb(row.canvas, prev, params, base);

        row.state.textContent = 'Export JPG…';
        const res = await exportJpeg({
          full: { data: sp.data, w: W, h: H }, params, base, geom, quality: 100,
          exif: exportExifFields(dec.raw, exif),
          onProgress: (v) => { row.state.textContent = `Export JPG… ${Math.round(v * 100)} %`; progress(0.5 + v * 0.45); },
        });
        const name = uniqueName(file.name.replace(/\.[^.]+$/, '') + '.jpg', usedNames);
        const size = res.blob.size;

        if (opts.output === 'folder') {
          row.state.textContent = 'Écriture…';
          const fh = await opts.dir.getFileHandle(await freeName(opts.dir, name), { create: true });
          const w = await fh.createWritable();
          await w.write(res.blob); await w.close();
        } else if (opts.output === 'zip') {
          row.state.textContent = 'Ajout à l\'archive…';
          await new Promise((r) => setTimeout(r, 0));
          zip.add(name, res.parts, crc32(res.parts));
        } else {
          shareFiles.push(new File([res.blob], name, { type: 'image/jpeg' }));
          shareBytes += size;
        }
        ok++; totalBytes += size;
        row.li.classList.add('ok');
        row.state.textContent = `✓ ${res.outW}×${res.outH} · ${fmtMB(size)} · ${((performance.now() - t1) / 1000).toFixed(0)} s${note}`;
      } catch (e) {
        console.error(e);
        failed++;
        row.li.classList.add('err');
        row.state.textContent = `✗ ${e.message || e}`;
      }
      row.li.classList.remove('active');
      done++;
      progress(0);
      // partie pleine ?
      if (zip && zip.size >= ZIP_PART && i < opts.files.length - 1) await flushPart(false);
      if (shareFiles.length && (shareFiles.length >= SHARE_PART.count || shareBytes >= SHARE_PART.bytes) && i < opts.files.length - 1) await flushPart(false);
    }

    await flushPart(true);
    try { await wakeLock?.release(); } catch { /* */ }
    wakeLock = null;
    running = false;
    $('#bBar').style.width = '100%';
    const secs = (performance.now() - t0) / 1000;
    const where = opts.output === 'folder' && opts.dir.name ? ` dans le dossier « ${opts.dir.name} »` : '';
    $('#bStatus').textContent = (cancelled ? 'Annulé. ' : 'Terminé. ')
      + `${ok} photo${ok > 1 ? 's' : ''} exportée${ok > 1 ? 's' : ''}${where} (${fmtMB(totalBytes)}, ${fmtDur(secs)})`
      + (failed ? ` — ${failed} en échec.` : '.');
    $('#bCancel').disabled = false; $('#bCancel').textContent = 'Fermer';
  }

  return { open };
}

function uniqueName(name, used) {
  let n = name, i = 2;
  const dot = name.lastIndexOf('.'), base = name.slice(0, dot), ext = name.slice(dot);
  while (used.has(n.toLowerCase())) n = `${base}-${i++}${ext}`;
  used.add(n.toLowerCase());
  return n;
}

// Dossier : ne pas écraser un fichier existant
async function freeName(dir, name) {
  const dot = name.lastIndexOf('.'), base = name.slice(0, dot), ext = name.slice(dot);
  for (let i = 1; i < 1000; i++) {
    const n = i === 1 ? name : `${base}-${i}${ext}`;
    try { await dir.getFileHandle(n); } catch { return n; } // n'existe pas
  }
  return `${base}-${Date.now()}${ext}`;
}

// Vignette de la photo traitée (à partir de l'aperçu réduit)
function drawThumb(canvas, prev, params, base) {
  const tw = 144, f = Math.max(1, Math.floor(prev.w / tw));
  const w = Math.floor(prev.w / f), h = Math.floor(prev.h / f);
  const src = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((y * f) * prev.w + x * f) * 3, o = (y * w + x) * 3;
    src[o] = prev.data[i]; src[o + 1] = prev.data[i + 1]; src[o + 2] = prev.data[i + 2];
  }
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d'), img = ctx.createImageData(w, h);
  processRGBA(makeProcessor(params, base), src, img.data, w * h);
  ctx.putImageData(img, 0, 0);
}
