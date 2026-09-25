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
- **Filtres** (bandeau de vignettes, intensité réglable) :
  - *Couleur* : Provia (standard fidèle), Astia (douce, peaux flatteuses),
    Vivid (esprit Adobe Vivid), Velvia (diapositive saturée et contrastée) ;
  - *Noir & blanc* : Acros (modelé fin), Tri-X (reportage contrasté, filtre
    jaune), N&B rouge (ciels sombres, nuages éclatants), Sépia (virage brun) ;
  - *Créatif* : Cyberpunk jour (sarcelle / orange, verts virés au cyan) et
    Cyberpunk nuit (néons magenta / cyan, ombres bleu-violet).
  Les filtres combinent décalages de tons, saturation / luminance / décalage par
  teinte, mélangeur N&B et virage partiel. Les suggestions sont recalculées selon
  le filtre pour ne pas cumuler ses effets.
- **Réglages** : température, teinte, exposition, contraste, hautes lumières,
  ombres, blancs, noirs, vibrance, saturation. Double-clic / double-tape sur un
  intitulé pour le remettre à zéro. Bouton *Avant / Après* (maintenir, ou touche
  `\`) et affichage de l'écrêtage.
- **Recadrage et rotation** : cadre en paysage ou en portrait, formats libre /
  original / 1:1 / 3:2 / 4:3 / 5:4 / 16:9 (2:3, 3:4… en portrait), rotation 90°, miroir, redressement fin ±45° ; le cadre
  reste toujours dans l'image redressée.
- **Redressage automatique** : détection des lignes horizontales / verticales
  dominantes (tenseur de structure + histogramme d'orientations).
- **Ouverture rapide** : un premier décodage en demi-taille (sans dématriçage)
  permet d'éditer tout de suite ; le dématriçage AHD pleine résolution se fait
  en arrière-plan (indicateur en haut à droite de l'image).
- **Export JPG qualité 100 %, pleine résolution** (aucune mise à l'échelle) :
  encodeur JPEG en JavaScript (4:4:4, tables de quantification à 1), parallélisé
  sur tous les cœurs (bandes séparées par des marqueurs RST, image partagée via
  `SharedArrayBuffer`), sans passer par un canvas (limité en taille sur mobile). Les
  principales données EXIF (appareil, objectif, date, vitesse, ouverture, ISO,
  focale) sont recopiées. Sur mobile, bouton *Partager / Enregistrer*.
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
| `js/jpeg-encoder.js` | Encodeur JPEG baseline + écriture EXIF |
| `js/metadata.js` | Lecture (exifr + LibRaw) et affichage des métadonnées |
| `coi-sw.js` | Service worker COOP/COEP |
| `vendor/` | LibRaw-WASM et exifr (voir `vendor/README.md`) |

## Limites

- Les très gros fichiers (> 50 Mpx) demandent beaucoup de mémoire ; sur les
  téléphones anciens le décodage peut échouer.
- Le rendu couleur utilise la matrice de l'appareil fournie par LibRaw (sRGB),
  pas les profils DCP/Adobe embarqués dans les DNG.
