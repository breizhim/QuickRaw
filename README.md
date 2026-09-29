# QuickRaw

Développement de fichiers **RAW / DNG directement dans le navigateur** — rien n'est
envoyé sur un serveur, tout est traité sur l'appareil (ordinateur ou mobile).

## Fonctionnalités

- **Lecture RAW** : DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW… via LibRaw
  compilé en WebAssembly (dématriçage AHD, balance des blancs boîtier, sortie
  linéaire 16 bits). Les JPEG/PNG sont aussi acceptés.
- **Analyse colorimétrique** : histogramme RVB + luminance avec témoins
  d'écrêtage, spectre des teintes, vectorscope (avec ligne des tons chair),
  statistiques (médiane, plage tonale, écrêtage par canal, dominante colorée).
- **Suggestions de réglages** calculées sur les données linéaires : balance des
  blancs (pixels quasi neutres), exposition (médiane / protection des hautes
  lumières), hautes lumières, ombres, blancs, noirs, contraste, vibrance,
  saturation, redressement. Chaque suggestion s'applique séparément, ou toutes
  d'un coup (« Tout appliquer »), puis s'affine avec les curseurs.
- **Filtres** (le filtre courant s'affiche dans le panneau ; un appui ouvre la
  fenêtre des filtres avec un aperçu de chacun, classés par catégorie ;
  intensité réglable) :
  - *Couleur* : Provia (standard fidèle), Astia (douce, peaux flatteuses),
    Vivid (esprit Adobe Vivid), Velvia (diapositive saturée et contrastée) ;
  - *Film* : Classic Chrome (reportage sourd), Classic Negative (ombres
    sarcelle, contraste dur), Nostalgic Neg. (ambre, ombres douces), Portra 400
    (tons chair chauds, contraste bas), Kodachrome 64 (rouges profonds, ciels
    denses), CineStill 800T (tungstène froid avec **halo rouge** autour des
    hautes lumières) ;
  - *Ricoh GR* : Positive Film, Negative Film, Hard Monotone (équivalents des
    modes Image Control du boîtier) ;
  - *Noir & blanc* : Acros (modelé fin), Tri-X (reportage contrasté, filtre
    jaune), N&B rouge (ciels sombres, nuages éclatants), Sépia (virage brun),
    N&B contrasté (esprit Provoke / Moriyama, avec vignettage) ;
  - *Créatif* : Bleach bypass, Cyberpunk jour (sarcelle / orange, verts virés
    au cyan) et Cyberpunk nuit (néons magenta / cyan, ombres bleu-violet).
  Les filtres combinent décalages de tons, saturation / luminance / décalage par
  teinte, mélangeur N&B, virage partiel, vignettage et halo. Les suggestions
  sont recalculées selon le filtre pour ne pas cumuler ses effets. Pas de grain
  artificiel.
- **Mode du boîtier (Ricoh GR)** : le mode Image Control choisi à la prise de
  vue (Monotone, Noir dur, Positive Film, Bleach bypass, Rétro…) est lu dans
  les maker notes du DNG (tag 0x004F) ; le filtre équivalent est sélectionné à
  l'ouverture et proposé en suggestion. En lot, option « Selon le mode du
  boîtier ».
- **Rendu boîtier** : bouton qui affiche (et exporte) le JPEG pleine
  résolution intégré au RAW, c'est-à-dire exactement le rendu de l'appareil,
  avec recadrage / rotation / réglages par-dessus. Fichier exporté suffixé
  `-boitier`.
- **Réglages** : température, teinte, exposition, contraste, hautes lumières,
  ombres, blancs, noirs, vibrance, saturation, vignettage. Double-clic / double-tape sur un
  intitulé pour le remettre à zéro. Bouton *Avant / Après* (maintenir, ou touche
  `\`) et affichage de l'écrêtage.
- **Recadrage et rotation** : cadre en paysage ou en portrait, formats libre /
  original / 1:1 / 3:2 / 4:3 / 5:4 / 16:9 (2:3, 3:4… en portrait), rotation 90°, miroir, redressement fin ±45° ; le cadre
  reste toujours dans l'image redressée.
- **Redressage automatique** : utilise en priorité le **niveau électronique**
  enregistré par l'appareil (maker notes Pentax / Ricoh GR III, GR IIIx, GR IV,
  tag LevelInfo 0x022B) quand il est renseigné ; sinon détection des lignes
  horizontales / verticales dominantes (tenseur de structure + histogramme
  d'orientations).
- **Ouverture rapide** : LibRaw ne fait que l'aperçu demi-taille et la
  décompression ; le **dématriçage pleine résolution** (capteurs Bayer) est fait
  par le module WebAssembly sur tous les cœurs, en arrière-plan (indicateur en
  haut à droite de l'image) : environ 2× plus rapide que LibRaw. Les noirs et
  multiplicateurs sont **calés automatiquement** sur l'aperçu de LibRaw (y
  compris les noirs des DNG, que la bibliothèque n'expose pas) ; si le capteur
  n'est pas Bayer (X-Trans, monochrome…) ou si le calage n'est pas exact,
  l'appli revient au dématriçage AHD de LibRaw.
- **Export JPG qualité 100 %, pleine résolution** (aucune mise à l'échelle) :
  moteur **WebAssembly SIMD** écrit en C (`native/qr.c` : rendu des réglages et
  filtres 4 pixels à la fois + encodeur JPEG baseline 4:4:4, tables de
  quantification à 1), environ 3× plus rapide que la version JavaScript, qui
  reste utilisée en secours. Parallélisé sur tous les cœurs (bandes séparées par
  des marqueurs RST, image dans la mémoire partagée du module), sans passer par
  un canvas (limité en taille sur mobile). Les
  principales données EXIF (appareil, objectif, date, vitesse, ouverture, ISO,
  focale) sont recopiées. Sur mobile, bouton *Partager / Enregistrer*.
- **Traitement par lot** (bouton *Lot*, ou sélection / glisser-déposer de
  plusieurs fichiers) : filtre + suggestions automatiques photo par photo, ou
  réglages de la photo ouverte appliqués à toute la série ; redressage
  automatique en option. Sorties : dossier (Chrome / Edge sur ordinateur, chaque
  JPG écrit dès qu'il est prêt), archive ZIP (découpée en parties ; sur mobile
  le traitement attend que chaque partie soit récupérée pour limiter la
  mémoire), ou partage par groupes de 10 (« Enregistrer dans Photos » sur
  téléphone). L'écran est maintenu allumé pendant le traitement.
- **Toutes les métadonnées** : bouton *Métadonnées* (IFD0, EXIF, GPS, XMP, IPTC,
  ICC, balises DNG, données techniques LibRaw…), avec filtre et copie JSON.
- **Mobile** : mise en page adaptée (panneau sous l'image en portrait, à droite
  en paysage / bureau), commandes tactiles, zones de sécurité iOS.

## Lancer en local

LibRaw-WASM utilise des threads (`SharedArrayBuffer`), la page doit donc être
*cross-origin isolated* (en-têtes COOP/COEP). Un petit serveur est fourni :

```sh
node tools/serve.mjs          # http://localhost:8080/
```

Ouvrir `index.html` directement (`file://`) ne fonctionne pas.

## Recompiler le module d'export

`vendor/qr/qr.wasm` est versionné : aucune compilation n'est nécessaire pour
héberger le site. Après une modification de `native/qr.c` (ou des formules de
`js/pipeline.js`, que le C reproduit) :

```sh
native/build.sh   # clang ≥ 16 avec la cible wasm32 + wasm-ld (paquets clang et lld)
```

## Hébergement

Le site est 100 % statique (aucune étape de build). Sur un hébergeur qui ne permet
pas de définir les en-têtes (ex. **GitHub Pages**), le service worker
`coi-sw.js` les ajoute automatiquement : la page se recharge une fois au premier
chargement. HTTPS est requis (sauf `localhost`).

## Organisation

| Fichier | Rôle |
|---|---|
| `index.html`, `css/style.css` | Interface |
| `js/app.js` | Logique de l'interface, vue, recadrage interactif, histogrammes |
| `js/pipeline.js` | Pipeline de développement (partagé aperçu / export) et géométrie |
| `js/analysis.js` | Statistiques, suggestions, redressage automatique |
| `js/engine-worker.js` | Aperçu réduit, copie de l'image en mémoire partagée |
| `js/exporter.js`, `js/export-worker.js` | Export JPEG parallèle par bandes |
| `js/batch.js`, `js/zip.js` | Traitement par lot, archives ZIP |
| `js/decode.js`, `js/engine.js` | Décodage des fichiers, calage, accès au worker moteur |
| `js/rawload.js`, `js/demosaic.js`, `js/linear.js` | Chargement RAW, dématriçage parallèle, linéarisation |
| `js/jpeg-encoder.js` | Encodeur JPEG baseline + écriture EXIF |
| `js/metadata.js` | Lecture (exifr + LibRaw) et affichage des métadonnées |
| `coi-sw.js` | Service worker COOP/COEP |
| `native/qr.c`, `native/build.sh` | Cœur d'export en C → `vendor/qr/qr.wasm` |
| `js/qr-wasm.js` | Chargement du module, mémoire partagée, paramètres |
| `vendor/` | LibRaw-WASM, exifr, module d'export compilé (voir `vendor/README.md`) |

## Note technique : sortie de LibRaw-WASM

`libraw-wasm` 1.6.0 ignore l'option `gamm` : ses sorties 16 bits sont toujours
encodées avec la courbe BT.709 par défaut de LibRaw. QuickRaw les linéarise
(`js/linear.js`) avant tout traitement.

## Limites

- Les très gros fichiers (> 50 Mpx) demandent beaucoup de mémoire ; sur les
  téléphones anciens le décodage peut échouer.
- Le rendu couleur utilise la matrice de l'appareil fournie par LibRaw (sRGB),
  pas les profils DCP/Adobe embarqués dans les DNG.
