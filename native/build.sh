#!/bin/sh
# Compile native/qr.c en WebAssembly (SIMD, mémoire partagée importée).
# Nécessite clang ≥ 16 avec la cible wasm32 et wasm-ld (paquets clang + lld).
set -e
cd "$(dirname "$0")"
clang --target=wasm32 -O3 -flto -msimd128 -matomics -mbulk-memory -mnontrapping-fptoint -msign-ext -mmutable-globals \
  -nostdlib -ffreestanding -fno-builtin-memset \
  -Wl,--no-entry -Wl,--import-memory -Wl,--shared-memory \
  -Wl,--max-memory=4294967296 -Wl,--initial-memory=1048576 \
  -Wl,-z,stack-size=4096 -Wl,--lto-O3 \
  -o ../vendor/qr/qr.wasm qr.c
ls -l ../vendor/qr/qr.wasm
