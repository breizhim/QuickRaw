// Écriture d'archives ZIP « stockées » (sans compression : les JPG le sont déjà).
// Les octets ne sont jamais recopiés dans un gros tampon : l'archive est un Blob
// composé des morceaux (en-têtes + données), ce qui limite la mémoire.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(chunks) {
  let c = 0xffffffff;
  for (const a of chunks) for (let i = 0; i < a.length; i++) c = CRC_TABLE[(c ^ a[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export class ZipBuilder {
  constructor() { this.parts = []; this.central = []; this.offset = 0; this.names = new Set(); this.entries = 0; }

  get size() { return this.offset; }
  get count() { return this.entries; }

  // Évite les doublons de nom dans l'archive
  uniqueName(name) {
    let n = name, i = 2;
    const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    while (this.names.has(n.toLowerCase())) n = `${base}-${i++}${ext}`;
    this.names.add(n.toLowerCase());
    return n;
  }

  /** @param {string} name  @param {Uint8Array[]} chunks  @param {number} [crc] */
  add(name, chunks, crc = crc32(chunks)) {
    name = this.uniqueName(name);
    const nameBytes = new TextEncoder().encode(name);
    const size = chunks.reduce((s, c) => s + c.length, 0);
    const { time, date } = dosDateTime();
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); // UTF-8
    lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
    this.parts.push(new Uint8Array(lh.buffer), nameBytes, new Blob(chunks));
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true); cd.setUint16(12, time, true); cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, size, true); cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true); cd.setUint32(42, this.offset, true);
    this.central.push(new Uint8Array(cd.buffer), nameBytes);
    this.offset += 30 + nameBytes.length + size;
    this.entries++;
    return name;
  }

  finish() {
    const cdSize = this.central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.count, true); end.setUint16(10, this.count, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }
}
