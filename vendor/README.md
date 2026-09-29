# Dépendances embarquées

Copiées telles quelles (sans les source maps) pour que le site fonctionne
hors ligne et sur un hébergement statique, sans CDN.

| Dossier | Paquet | Version | Licence |
|---|---|---|---|
| `libraw/` | [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) (LibRaw compilé en WebAssembly) | 1.6.0 | ISC (enveloppe) — [LibRaw](https://www.libraw.org/) : LGPL 2.1 / CDDL 1.0 |
| `qr/` | module d'export QuickRaw, compilé depuis `native/qr.c` (`native/build.sh`) | — | celle du projet |
| `exifr/` | [exifr](https://github.com/MikeKovarik/exifr) (build `full.esm.mjs`) | 7.1.3 | MIT (voir `exifr/LICENSE`) |
| `jpeg-js/` | [jpeg-js](https://github.com/jpeg-js/jpeg-js) (décodeur `lib/decoder.js` enveloppé en module ES, secours quand le canvas iOS est trop petit) | 0.4.4 | BSD-3-Clause (voir `jpeg-js/LICENSE`) |

Mise à jour : `npm pack libraw-wasm exifr`, puis recopier
`dist/{index.js,worker.js,libraw.js,libraw.wasm}` et `dist/full.esm.mjs`.
