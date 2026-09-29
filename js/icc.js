// Profil ICC sRGB (version 2, classe « écran ») intégré aux JPEG exportés,
// pour que labos, logiciels et pilotes d'imprimante interprètent les couleurs
// sans ambiguïté. Généré ici plutôt que copié : primaires sRGB adaptées à D50
// (Bradford), courbe de transfert sRGB tabulée sur 1024 points.

function build() {
  const bytes = [];
  const u8 = (v) => bytes.push(v & 0xff);
  const u16 = (v) => { u8(v >> 8); u8(v); };
  const u32 = (v) => { u16(v >>> 16); u16(v & 0xffff); };
  const s15 = (v) => u32(Math.round(v * 65536) >>> 0);
  const sig = (s) => { for (const c of s) u8(c.charCodeAt(0)); };
  const pad = () => { while (bytes.length & 3) u8(0); };

  // données des balises (chacune alignée sur 4 octets)
  const tags = [];
  const tag = (name, write) => { pad(); const off = bytes.length; write(); tags.push([name, off, bytes.length - off]); };
  const xyz = (x, y, z) => () => { sig('XYZ '); u32(0); s15(x); s15(y); s15(z); };

  const desc = 'sRGB IEC61966-2.1 (QuickRaw)';
  tag('desc', () => {
    sig('desc'); u32(0);
    u32(desc.length + 1); sig(desc); u8(0); // ASCII
    u32(0); u32(0); // Unicode : absent
    u16(0); u8(0); for (let i = 0; i < 67; i++) u8(0); // ScriptCode : absent
  });
  tag('cprt', () => { sig('text'); u32(0); sig('No copyright, use freely'); u8(0); });
  tag('wtpt', xyz(0.9642, 1.0, 0.8249));
  tag('rXYZ', xyz(0.4360747, 0.2225045, 0.0139322));
  tag('gXYZ', xyz(0.3850649, 0.7168786, 0.0971045));
  tag('bXYZ', xyz(0.1430804, 0.0606169, 0.7141733));
  tag('rTRC', () => {
    const N = 1024;
    sig('curv'); u32(0); u32(N);
    for (let i = 0; i < N; i++) {
      const v = i / (N - 1), l = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      u16(Math.round(l * 65535));
    }
  });
  const trc = tags[tags.length - 1];
  tags.push(['gTRC', trc[1], trc[2]], ['bTRC', trc[1], trc[2]]); // courbe partagée
  pad();

  // en-tête (128 octets) + table des balises, placés devant les données
  const tableLen = 4 + tags.length * 12, shift = 128 + tableLen;
  const data = bytes.splice(0);
  const size = shift + data.length;
  u32(size); u32(0); u32(0x02100000); sig('mntr'); sig('RGB '); sig('XYZ ');
  for (let i = 0; i < 6; i++) u16(0); // date
  sig('acsp'); u32(0); u32(0); u32(0); u32(0); u32(0); u32(0); // plateforme, drapeaux, fabricant, modèle, attributs
  u32(0); // intention de rendu : perceptuelle
  s15(0.9642); s15(1.0); s15(0.8249); // illuminant D50
  u32(0); // créateur
  while (bytes.length < 128) u8(0);
  u32(tags.length);
  for (const [name, off, len] of tags) { sig(name); u32(off + shift); u32(len); }
  return new Uint8Array([...bytes, ...data]);
}

export const SRGB_ICC = build();
