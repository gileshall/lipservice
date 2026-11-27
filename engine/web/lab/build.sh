#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

# The diction lab as a folder to serve as it is:
#   build.sh OUT-DIR LIPSERVICE.wasm MODELS-URL
# LIPSERVICE.wasm: the engine's browser build (engine/web/build.sh says how it is built).
# MODELS-URL: where the page fetches the models, a folder in the package's layout (manifest.json,
# base.lsw, ...), ending in /: a URL (https://models.lipservice.dev/, which must allow the page's
# origin), or a path from OUT-DIR (models/, a bundle linked there by whoever serves it). The page
# is then OUT-DIR/ and OUT-DIR/lab/, served by any static server:
#   python3 -m http.server 7794 --bind 127.0.0.1 --directory OUT-DIR
set -euo pipefail
[ $# -eq 3 ] || { sed -n '2,9p' "$0" >&2; exit 2; }
out=$1 wasm=$2 models=$3
here=$(cd "$(dirname "$0")" && pwd)
case $models in
  *[[:space:]\"\\]*) echo "$models: not a URL the page can be given" >&2; exit 1 ;;
  */) ;;
  *) echo "$models: the models' folder ends in /" >&2; exit 1 ;;
esac
# in place: a server already serving OUT-DIR goes on serving it
mkdir -p "$out"
rm -rf "$out/lab" "$out/lipservice.js" "$out/lipservice.wasm"
mkdir -p "$out/lab"
printf 'export const MODELS = "%s";\n' "$models" > "$out/lab/models.js"
brand=$here/../../../docs/release/brand/logo
cp "$here/lab.css" "$here/lab.js" "$here/model.js" "$here/bench.js" "$here/sounds.js" "$here/tour.js" "$here/render.js" "$here/worker.js" "$out/lab/"
# the brand's own files: the site's cut of Outfit, the favicon, and the lockup drawn into the page
# (its lips the one group, coloured by .lips; lipservice.dev/src/layout.mjs)
cp "$here/../../../lipservice.dev/src/assets/outfit.woff2" "$brand/favicon.svg" "$out/lab/"
[ "$(grep -c '<g transform=' "$brand/lockup.svg")" = 1 ] || { echo "lockup.svg: expected the mark in one group" >&2; exit 1; }
grep -q '<!--lockup-->' "$here/index.html" || { echo "index.html: no <!--lockup--> to draw the lockup at" >&2; exit 1; }
lockup=$(sed -e 's/<svg /<svg class="lockup" aria-hidden="true" focusable="false" /' -e 's/<g transform=/<g class="lips" transform=/' -e 's/viewBox="0 -1000 6160 1260"/viewBox="0 -640 6160 880"/' "$brand/lockup.svg")
case $lockup in *'class="lips"'*'viewBox="0 -640 6160 880"'*|*'viewBox="0 -640 6160 880"'*'class="lips"'*) ;; *) echo "lockup.svg: not the lockup this page draws" >&2; exit 1 ;; esac
LOCKUP=$lockup perl -pe 's/<!--lockup-->/$ENV{LOCKUP}/' "$here/index.html" > "$out/lab/index.html"
# the page at OUT-DIR itself too, for a site that serves the folder under a name of its own
grep -q 'src="./lab.js"' "$here/index.html" && grep -q 'href="./lab.css"' "$here/index.html" && grep -q 'href="./favicon.svg"' "$here/index.html" || { echo "index.html: its script, stylesheet or icon is not at ./" >&2; exit 1; }
sed -e 's#src="./lab.js"#src="./lab/lab.js"#' -e 's#href="./lab.css"#href="./lab/lab.css"#' -e 's#href="./favicon.svg"#href="./lab/favicon.svg"#' "$out/lab/index.html" > "$out/index.html"
cp "$here/../lipservice.js" "$out/"
cp "$wasm" "$out/lipservice.wasm"
echo "$out: the lab at lab/, its models from $models"
