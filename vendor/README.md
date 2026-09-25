# Dépendances embarquées

Copiées telles quelles (sans les source maps) pour que le site fonctionne
hors ligne et sur un hébergement statique, sans CDN.

| Dossier | Paquet | Version | Licence |
|---|---|---|---|
| `libraw/` | [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) (LibRaw compilé en WebAssembly) | 1.6.0 | ISC (enveloppe) — [LibRaw](https://www.libraw.org/) : LGPL 2.1 / CDDL 1.0 |
| `exifr/` | [exifr](https://github.com/MikeKovarik/exifr) (build `full.esm.mjs`) | 7.1.3 | MIT (voir `exifr/LICENSE`) |

Mise à jour : `npm pack libraw-wasm exifr`, puis recopier
`dist/{index.js,worker.js,libraw.js,libraw.wasm}` et `dist/full.esm.mjs`.
