// Lecture et présentation de toutes les métadonnées (exifr + LibRaw).
import exifr from '../vendor/exifr/exifr.mjs';

// Noms des balises DNG / TIFF-EP qu'exifr ne connaît pas
const DNG_TAGS = {
  254: 'NewSubfileType', 330: 'SubIFDs', 33421: 'CFARepeatPatternDim', 33422: 'CFAPattern',
  37399: 'SensingMethod', 50706: 'DNGVersion', 50707: 'DNGBackwardVersion', 50708: 'UniqueCameraModel',
  50709: 'LocalizedCameraModel', 50710: 'CFAPlaneColor', 50711: 'CFALayout', 50712: 'LinearizationTable',
  50713: 'BlackLevelRepeatDim', 50714: 'BlackLevel', 50715: 'BlackLevelDeltaH', 50716: 'BlackLevelDeltaV',
  50717: 'WhiteLevel', 50718: 'DefaultScale', 50719: 'DefaultCropOrigin', 50720: 'DefaultCropSize',
  50721: 'ColorMatrix1', 50722: 'ColorMatrix2', 50723: 'CameraCalibration1', 50724: 'CameraCalibration2',
  50725: 'ReductionMatrix1', 50726: 'ReductionMatrix2', 50727: 'AnalogBalance', 50728: 'AsShotNeutral',
  50729: 'AsShotWhiteXY', 50730: 'BaselineExposure', 50731: 'BaselineNoise', 50732: 'BaselineSharpness',
  50733: 'BayerGreenSplit', 50734: 'LinearResponseLimit', 50735: 'CameraSerialNumber', 50736: 'LensInfo',
  50737: 'ChromaBlurRadius', 50738: 'AntiAliasStrength', 50739: 'ShadowScale', 50740: 'DNGPrivateData',
  50741: 'MakerNoteSafety', 50778: 'CalibrationIlluminant1', 50779: 'CalibrationIlluminant2',
  50780: 'BestQualityScale', 50781: 'RawDataUniqueID', 50827: 'OriginalRawFileName', 50828: 'OriginalRawFileData',
  50829: 'ActiveArea', 50830: 'MaskedAreas', 50831: 'AsShotICCProfile', 50832: 'AsShotPreProfileMatrix',
  50833: 'CurrentICCProfile', 50834: 'CurrentPreProfileMatrix', 50879: 'ColorimetricReference',
  50931: 'CameraCalibrationSignature', 50932: 'ProfileCalibrationSignature', 50933: 'ExtraCameraProfiles',
  50934: 'AsShotProfileName', 50935: 'NoiseReductionApplied', 50936: 'ProfileName', 50937: 'ProfileHueSatMapDims',
  50938: 'ProfileHueSatMapData1', 50939: 'ProfileHueSatMapData2', 50940: 'ProfileToneCurve',
  50941: 'ProfileEmbedPolicy', 50942: 'ProfileCopyright', 50964: 'ForwardMatrix1', 50965: 'ForwardMatrix2',
  50966: 'PreviewApplicationName', 50967: 'PreviewApplicationVersion', 50968: 'PreviewSettingsName',
  50969: 'PreviewSettingsDigest', 50970: 'PreviewColorSpace', 50971: 'PreviewDateTime', 50972: 'RawImageDigest',
  50973: 'OriginalRawFileDigest', 50974: 'SubTileBlockSize', 50975: 'RowInterleaveFactor',
  50981: 'ProfileLookTableDims', 50982: 'ProfileLookTableData', 51008: 'OpcodeList1', 51009: 'OpcodeList2',
  51022: 'OpcodeList3', 51041: 'NoiseProfile', 51089: 'OriginalDefaultFinalSize', 51090: 'OriginalBestQualityFinalSize',
  51091: 'OriginalDefaultCropSize', 51107: 'ProfileHueSatMapEncoding', 51108: 'ProfileLookTableEncoding',
  51109: 'BaselineExposureOffset', 51110: 'DefaultBlackRender', 51111: 'NewRawImageDigest', 51112: 'RawToPreviewGain',
  51125: 'DefaultUserCrop', 52525: 'ProfileGainTableMap', 52526: 'SemanticName', 52528: 'SemanticInstanceID',
  52536: 'MaskSubArea', 52543: 'RGBTables', 52529: 'CalibrationIlluminant3', 52530: 'CameraCalibration3',
  52531: 'ColorMatrix3', 52532: 'ForwardMatrix3', 52533: 'IlluminantData1', 52534: 'IlluminantData2',
  52535: 'IlluminantData3', 52537: 'ProfileDynamicRange', 52538: 'ProfileGroupName', 52544: 'ColumnInterleaveFactor',
  52545: 'ImageSequenceInfo', 52547: 'ImageStats', 52548: 'ProfileDynamicRange', 52550: 'JXLDistance',
  52551: 'JXLEffort', 52552: 'JXLDecodeSpeed',
};

const SECTION_NAMES = {
  ifd0: 'IFD0 (TIFF / image principale)', ifd1: 'IFD1 (vignette)', exif: 'EXIF', gps: 'GPS',
  interop: 'Interopérabilité', xmp: 'XMP', iptc: 'IPTC', icc: 'Profil ICC', jfif: 'JFIF', ihdr: 'PNG IHDR',
  makerNote: 'MakerNote', userComment: 'Commentaire', thumbnail: 'Vignette',
};

export async function readExif(input) {
  try {
    const out = await exifr.parse(input, {
      tiff: true, ifd0: true, ifd1: true, exif: true, gps: true, interop: true,
      makerNote: true, userComment: true, xmp: true, icc: true, iptc: true, jfif: true, ihdr: true,
      mergeOutput: false, sanitize: true, reviveValues: true, translateKeys: true, translateValues: true,
      multiSegment: true,
    });
    return out ? detach(out) : null;
  } catch (e) {
    console.warn('exifr :', e);
    return null;
  }
}

// exifr renvoie des vues sur le tampon du fichier ; celui-ci est ensuite
// transféré au worker LibRaw (et détaché) : on copie ces vues.
function detach(o, depth = 0) {
  if (ArrayBuffer.isView(o)) return o.slice();
  if (!o || typeof o !== 'object' || o instanceof Date || depth > 6) return o;
  for (const k of Object.keys(o)) o[k] = detach(o[k], depth + 1);
  return o;
}

export function formatValue(v, depth = 0) {
  if (v === null || v === undefined) return '—';
  if (v instanceof Date) return isNaN(v) ? String(v) : v.toLocaleString('fr-FR');
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
    const a = v instanceof ArrayBuffer ? new Uint8Array(v) : v;
    if (a.length <= 24 && !(a instanceof Uint8Array)) return Array.from(a, fmtNum).join(', ');
    if (a.length <= 16) return Array.from(a, fmtNum).join(', ');
    return `[${a.length} ${a instanceof Uint8Array ? 'octets' : 'valeurs'}] ` +
      Array.from(a.slice(0, 12), (x) => fmtNum(x)).join(', ') + '…';
  }
  if (Array.isArray(v)) {
    if (v.length > 64) return `[${v.length} valeurs] ` + v.slice(0, 16).map((x) => formatValue(x, depth + 1)).join(', ') + '…';
    return v.map((x) => formatValue(x, depth + 1)).join(', ');
  }
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'object') {
    if (depth > 2) return '{…}';
    try { return JSON.stringify(v, (k, x) => (ArrayBuffer.isView(x) ? `[${x.length}]` : x)); } catch { return String(v); }
  }
  return String(v);
}
const fmtNum = (x) => (typeof x === 'number' && !Number.isInteger(x) ? +x.toPrecision(6) + '' : String(x));

// Aplatissement d'un objet (LibRaw) en paires clé/valeur
function flatten(obj, prefix = '', out = [], depth = 0) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) && !(v instanceof Date) && depth < 4) {
      flatten(v, key, out, depth + 1);
    } else if (Array.isArray(v) && v.length && typeof v[0] === 'object' && !Array.isArray(v[0]) && depth < 4) {
      v.forEach((x, i) => flatten(x, `${key}[${i}]`, out, depth + 1));
    } else {
      out.push([key, v]);
    }
  }
  return out;
}

export function exposureText(t) {
  if (!t) return '';
  return t >= 1 ? `${+t.toFixed(1)} s` : `1/${Math.round(1 / t)} s`;
}

// Construit la liste des sections {title, rows:[[k,v]]}
export function buildSections(file, exif, raw, extra = {}) {
  const sections = [];
  const s = [];
  const push = (k, v) => { if (v !== undefined && v !== null && v !== '' && v !== 0) s.push([k, v]); };
  push('Fichier', file?.name);
  push('Taille', file ? `${(file.size / 1048576).toFixed(2)} Mo` : '');
  if (raw) {
    push('Appareil', `${raw.camera_make || ''} ${raw.camera_model || ''}`.trim());
    push('Objectif', raw.lens?.Lens || raw.lens?.makernotes?.Lens || exif?.exif?.LensModel);
    push('Date de prise de vue', exif?.exif?.DateTimeOriginal || raw.timestamp);
    push('Exposition', exposureText(raw.shutter));
    push('Ouverture', raw.aperture ? `f/${+raw.aperture.toFixed(1)}` : '');
    push('ISO', raw.iso_speed);
    push('Focale', raw.focal_len ? `${+raw.focal_len.toFixed(1)} mm` : '');
    push('Dimensions (développées)', extra.size);
    push('Dimensions capteur', raw.raw_width ? `${raw.raw_width} × ${raw.raw_height}` : '');
    push('Version DNG', raw.dng_version ? dngVersion(raw.dng_version) : '');
    push('Motif du capteur', raw.cdesc);
    push('Orientation (flip)', raw.flip);
    push('Logiciel', raw.software);
    push('Auteur', raw.artist);
    push('Description', raw.desc);
    const bl = raw.color_data?.dng_levels?.baseline_exposure;
    if (bl) push('Exposition de base DNG', `${bl > 0 ? '+' : ''}${bl} IL`);
    const cm = raw.color_data?.cam_mul;
    if (cm) push('Balance des blancs boîtier (R, V, B, V2)', cm.map((x) => +(+x).toFixed(4)).join(', '));
  } else if (extra.size) push('Dimensions', extra.size);
  const gps = exif?.gps;
  if (gps && typeof gps.latitude === 'number') {
    const lat = gps.latitude.toFixed(6), lon = gps.longitude.toFixed(6);
    s.push(['Position GPS', { html: `<a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}" target="_blank" rel="noopener">${lat}, ${lon}</a>` }]);
  }
  sections.push({ title: 'Résumé', rows: s, open: true });

  if (exif) {
    for (const [block, data] of Object.entries(exif)) {
      if (!data || typeof data !== 'object') continue;
      const rows = [];
      if (ArrayBuffer.isView(data)) { rows.push(['(données brutes)', data]); }
      else {
        for (const [k, v] of Object.entries(data)) {
          const name = /^\d+$/.test(k) ? (DNG_TAGS[k] ? `${DNG_TAGS[k]} (${k})` : `Tag ${k} (0x${(+k).toString(16)})`) : k;
          if (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) && !(v instanceof Date)) {
            for (const [k2, v2] of flatten(v, name)) rows.push([k2, v2]);
          } else rows.push([name, v]);
        }
      }
      if (rows.length) sections.push({ title: SECTION_NAMES[block] || block, rows });
    }
  } else {
    sections.push({ title: 'EXIF', rows: [['Info', 'Structure EXIF non lisible par exifr pour ce format — voir la section LibRaw.']] });
  }

  if (raw) {
    const rows = flatten(raw).filter(([k]) => !/^(thumb_format)$/.test(k));
    sections.push({ title: 'LibRaw (données techniques du RAW)', rows });
  }
  return sections;
}

function dngVersion(v) {
  // LibRaw encode 1.4.0.0 comme 0x01040000
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderSections(container, sections, filter = '') {
  const f = filter.trim().toLowerCase();
  container.innerHTML = '';
  let shown = 0;
  for (const sec of sections) {
    const rows = sec.rows.filter(([k, v]) => {
      if (!f) return true;
      const txt = v && v.html ? v.html : formatValue(v);
      return k.toLowerCase().includes(f) || txt.toLowerCase().includes(f);
    });
    if (!rows.length) continue;
    shown += rows.length;
    const det = document.createElement('details');
    det.className = 'meta-section';
    det.open = !!(sec.open || f);
    det.innerHTML = `<summary>${esc(sec.title)}<span class="count">${rows.length}</span></summary>`;
    const table = document.createElement('table');
    table.className = 'meta';
    table.innerHTML = rows.map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td>${v && v.html ? v.html : esc(formatValue(v))}</td></tr>`).join('');
    det.appendChild(table);
    container.appendChild(det);
  }
  if (!shown) container.innerHTML = '<p class="hint">Aucune métadonnée ne correspond.</p>';
}

export function sectionsToJSON(sections) {
  const o = {};
  for (const sec of sections) {
    o[sec.title] = Object.fromEntries(sec.rows.map(([k, v]) => [k, v && v.html ? v.html.replace(/<[^>]+>/g, '') : formatValue(v)]));
  }
  return JSON.stringify(o, null, 2);
}
