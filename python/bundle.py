# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""Makes the model folder as it is served, and the manifest the package and the page read.

    python bundle.py --hifi STAGE/models --fast STAGE/models --out ROOT

--hifi is a stage of the latent voice (vox.lsw), --fast one of the mel route (melvoc.lsw,
vocoder.lsw), both cut by route (tools/split.py): a base with no mel decoder, and a voice as
voices/ID.lsw with its parts ID.vox.lsw and ID.mel.lsw. The files both have must be the same
bytes. ROOT gets the files under the names the package asks for and manifest.json beside them,
laid out as it is served: uploading ROOT over the served folder replaces what is there.

The manifest: its format, the set (a hash of the files' hashes, so a change to any file shows),
the voices in the stage's order, and every file's size and SHA-256 with "site", the path a site's
page asks for it by. A file's first folder says who needs it: hifi/ and fast/ one quality, page/
the page and the package's choir() (the breaths), anything else everyone. A file with no "site" is the package's alone: choirs.json,
the page's choir presets (engine/web/choirs.js CHOIRS) as `node choir_wav.mjs --choirs` prints them.

A voice's name is the first word of its label in voices.json, lowercased; the rest of the label,
in parentheses, is its source. id, label and base are the stage's own name, label and base.
"""

import argparse
import filecmp
import hashlib
import json
import os
import re
import shutil
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "score-l-flow-mel"
# bundle name: the stage's
SHARED = {
    "base.lsw": f"bases/{BASE}.lsw",
    "g2p.lsw": "g2p.lsw",
    "lexicon.lsw": "lexicon.lsw",
    "breaks.lsw": "breaks.lsw",
    "motion/straight.lsw": "motion-straight.lsw",
    "motion/vibrato.lsw": "motion-vibrato.lsw",
    "motion/wide.lsw": "motion-wide.lsw",
}
OWN = {"hifi": ["vox.lsw"], "fast": ["melvoc.lsw", "vocoder.lsw"]}
# a quality's part of a voice, in the stage
PART = {"hifi": "vox", "fast": "mel"}
# what only a site's page loads
PAGE = {"page/breaths.json": "breaths.json", "page/breaths.bin": "breaths.bin"}
CHOIR_WAV = os.path.join(HERE, "..", "engine", "web", "choir_wav.mjs")


def _voices(stage):
    with open(os.path.join(stage, "voices.json"), encoding="utf-8") as f:
        vs = json.load(f)
    out = []
    for v in vs:
        m = re.fullmatch(r"(\w+) \((.+)\)", v["label"])
        if not m:
            raise ValueError(f"{stage}/voices.json: label {v['label']!r} is not NAME (SOURCE)")
        if v["base"] != BASE:
            raise ValueError(f"{stage}/voices.json: {v['label']} is on base {v['base']}, not {BASE}")
        out.append({"name": m[1].lower(), "sex": v["sex"], "source": m[2], "id": v["name"], "label": v["label"], "base": v["base"]})
    return out


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while b := f.read(1 << 20):
            h.update(b)
    return h.hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--hifi", required=True)
    p.add_argument("--fast", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    stages = {"hifi": a.hifi, "fast": a.fast}
    voices = {q: _voices(s) for q, s in stages.items()}
    if voices["hifi"] != voices["fast"]:
        raise ValueError("the two stages have different voices")

    plan = {}  # bundle name: its path in the stage
    for name, src in SHARED.items():
        if not filecmp.cmp(os.path.join(a.hifi, src), os.path.join(a.fast, src), shallow=False):
            raise ValueError(f"{src}: the two stages' differ")
        plan[name] = (a.hifi, src)
    # what both qualities read of a voice
    for v in voices["hifi"]:
        src = f"voices/{v['id']}.lsw"
        if not filecmp.cmp(os.path.join(a.hifi, src), os.path.join(a.fast, src), shallow=False):
            raise ValueError(f"{src}: the two stages' differ")
        plan[f"voices/{v['name']}.lsw"] = (a.hifi, src)
    for name, src in PAGE.items():
        if not filecmp.cmp(os.path.join(a.hifi, src), os.path.join(a.fast, src), shallow=False):
            raise ValueError(f"{src}: the two stages' differ")
        plan[name] = (a.hifi, src)
    for q, stage in stages.items():
        for f in OWN[q]:
            plan[f"{q}/{f}"] = (stage, f)
        for v in voices[q]:
            plan[f"{q}/voices/{v['name']}.lsw"] = (stage, f"voices/{v['id']}.{PART[q]}.lsw")

    files = {}
    for name, (stage, src) in sorted(plan.items()):
        full = os.path.join(stage, src)
        files[name] = {"size": os.path.getsize(full), "sha256": _sha(full), "site": f"models/{src}"}
    choirs = subprocess.run(["node", CHOIR_WAV, "--choirs"], stdout=subprocess.PIPE, check=True).stdout
    json.loads(choirs)
    files["choirs.json"] = {"size": len(choirs), "sha256": hashlib.sha256(choirs).hexdigest()}
    files = dict(sorted(files.items()))
    set_id = hashlib.sha256("".join(f"{n} {f['sha256']}\n" for n, f in files.items()).encode()).hexdigest()[:12]
    out = a.out
    manifest = {"format": 1, "set": set_id, "voices": voices["hifi"], "files": files}
    for name, (stage, src) in sorted(plan.items()):
        dst = os.path.join(out, *name.split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(os.path.join(stage, src), dst)
        if _sha(dst) != files[name]["sha256"]:
            raise OSError(f"{dst}: not the bytes that were hashed")
    with open(os.path.join(out, "choirs.json"), "wb") as f:
        f.write(choirs)
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    print(f"set {set_id}: {len(files)} files, {sum(f['size'] for f in files.values()) / 1e6:.1f} MB, in {out}")


if __name__ == "__main__":
    main()
