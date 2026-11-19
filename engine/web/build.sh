#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

# Builds the engine for the browser and assembles a static site to serve as it is:
#   build.sh OUT-DIR VOCODER.lsw MELVOC.lsw G2P.lsw LEXICON.lsw BREAKS.lsw VOICES.tsv CHOIR-DIR
#   build.sh OUT-DIR --vox VOX.lsw G2P.lsw LEXICON.lsw BREAKS.lsw VOICES.tsv CHOIR-DIR
# MELVOC.lsw is the mel route, which speech goes through; songs go through VOCODER.lsw.
# With --vox, speech and songs go through the latent voice instead, and every
# voice carries its parts of it.
# BREAKS.lsw phrases speech; every voice then needs its share of gaps.
# VOICES.tsv: a voice a line, FILE<tab>LABEL<tab>SEX (F or M)[<tab>BASE[<tab>GROUP]], BASE the file a
# voice written against a base needs, shipped once however many voices share
# it, GROUP a heading the page lists the voice under (only with a BASE). CHOIR-DIR: the choir's pitch
# motion models and breaths, motion-*.lsw and breaths.{bin,json}. Needs a Rust
# toolchain with the wasm32-unknown-unknown target (CARGO may name its cargo; WASM_RUSTFLAGS adds
# flags, as Homebrew's rust and rust-wasm, which ship no rust-lld, need:
# "--sysroot /opt/homebrew/opt/rust-wasm -C linker=/opt/homebrew/opt/lld/bin/wasm-ld").
# The engine's tests run as wasm too, under wasmtime, from engine/:
#   RUSTFLAGS="-C target-feature=+simd128" CARGO_TARGET_WASM32_WASIP1_RUNNER="wasmtime run --dir $PWD::$PWD --" \
#     cargo test --release --target wasm32-wasip1
set -euo pipefail
[ $# -eq 8 ] || { sed -n '2,18p' "$0" >&2; exit 2; }
out=$1 voc=$2 melvoc=$3 g2p=$4 lex=$5 brk=$6 list=$7 choir=$8
here=$(cd "$(dirname "$0")" && pwd)
target=${CARGO_TARGET_DIR:-$here/../wasm/target}
(cd "$here/../wasm" && RUSTFLAGS="-C target-feature=+simd128 ${WASM_RUSTFLAGS:-}" ${CARGO:-cargo} build --release --target wasm32-unknown-unknown --target-dir "$target")
rm -rf "$out"
mkdir -p "$out/models/voices"
cp "$here/index.html" "$here/worker.js" "$here/player.js" "$here/passages.js" "$here/lipservice.js" "$here/choir.js" "$here/choirs.js" "$here/choirs_demos.js" "$here/choirs_levels.js" "$here/routes.js" "$here/bundle.js" "$here/voices_ranges.js" "$here/perform.js" "$here/room.js" \
  "$here/live.js" "$here/take.js" "$here/spectro.js" "$here/paint.js" "$here/timeline.js" "$here/stage.js" "$here/chain.js" "$here/pace.js" "$here/scope.js" "$here/pad.js" "$here/deck.js" "$here/conduct.js" "$here/notes.js" "$here/files.js" "$out/"
cp "$target/wasm32-unknown-unknown/release/lipservice_wasm.wasm" "$out/lipservice.wasm"
if [ "$voc" = --vox ]; then
  cp "$melvoc" "$out/models/vox.lsw"
  printf '{"vox": true}\n' > "$out/models/site.json"
else
  cp "$voc" "$out/models/vocoder.lsw"
  cp "$melvoc" "$out/models/melvoc.lsw"
  printf '{"vox": false}\n' > "$out/models/site.json"
fi
cp "$g2p" "$out/models/g2p.lsw"
cp "$lex" "$out/models/lexicon.lsw"
cp "$brk" "$out/models/breaks.lsw"
cp "$choir/motion-straight.lsw" "$choir/motion-vibrato.lsw" "$choir/motion-wide.lsw" "$choir/breaths.bin" "$choir/breaths.json" "$out/models/"
first=1
{
  printf '['
  while IFS=$'\t' read -r file label sex base group; do
    [ -n "$file" ] || continue
    [ "$sex" = F ] || [ "$sex" = M ] || { echo "$file: sex $sex, not F or M" >&2; exit 1; }
    name=$(basename "$file" .lsw)
    cp "$file" "$out/models/voices/$name.lsw"
    [ $first -eq 1 ] || printf ','
    first=0
    printf '\n {"name": "%s", "label": "%s", "sex": "%s"' "$name" "$label" "$sex"
    if [ -n "$base" ]; then
      bname=$(basename "$base" .lsw)
      mkdir -p "$out/models/bases"
      [ -f "$out/models/bases/$bname.lsw" ] || cp "$base" "$out/models/bases/$bname.lsw"
      printf ', "base": "%s"' "$bname"
    fi
    [ -z "$group" ] || printf ', "group": "%s"' "$group"
    printf '}'
  done < "$list"
  printf '\n]\n'
} > "$out/models/voices.json"
echo "$out: $(ls "$out/models/voices" | wc -l | tr -d ' ') voices"
