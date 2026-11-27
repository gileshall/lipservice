# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""Checks an installed lipservice against the engine's own command line: the same samples.

    python python/tests/check.py --engine engine/target/release/lipservice --bundle BUNDLE [--jobs N]

Run it with the Python the wheel is installed in (it is kept out of python/ so that `import
lipservice` is the installed one, not the source beside it). BUNDLE is what bundle.py made. Each case is said
or sung by the package and by the engine's CLI from the same files, and the two WAV files must be
the same bytes. Then the package's own promises: a call from another thread, both qualities in one
process, a choir in stereo with how it was sung, the same for the same seed, the timing each clip
carries and frames() of it, and each refusal as its own error.

The check is in parts, each run in a Python of its own, --jobs of them at a time (every core without
it); a part's line is printed as it ends. --only NAME runs one part here.
"""

import argparse
import concurrent.futures
import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time

SONG = "%bpm 100\ntwinkle C4:1 C4:1\ntwinkle G4:1 G4:1\nlittle A4:1 A4:1\nstar G4:2\n"
TWO = "The first paragraph is short.\n\nThe second one follows it, after a pause. Is that right?"
# a short choir as lipservice.dev holds one: two singers, a breath asked for in each rest, one swell
DUET = {
    "room": "drier",
    "pan": 0.5,
    "style": {"glide": 9, "dynamics": 1, "breathiness": 0.5, "diction": ["for=low word=low -> L OW ~UW:100"], "motion": "vibrato", "jitter": 2, "detune": 3, "spread": 0, "breath": 1},
    "parts": [
        {"name": "High", "voice": "6345", "song": "%bpm 96\n%rest 1\nsinging G4:1 A4:1\nout B4:2\n%rest 1\nhigh D5:2\n%rest 0.5\n", "levels": [[1, 1], [4, 1.4]]},
        {"name": "Low", "voice": "2428", "song": "%bpm 96\n%rest 1\nsinging D4:1 F#4:1\nout G4:2\n%rest 1\nlow B3:2\n%rest 0.5\n", "seat": 1},
    ],
}


def parts(lip, engine, b, d):
    """Every part of the check by name, in the order told: {name: a function that raises SystemExit or returns}.
    d is a folder of the part's own."""
    line = [sys.executable, "-m", "lipservice"]
    piece, wav, js = (os.path.join(d, x) for x in ("piece.json", "piece.wav", "piece.json.timing"))

    def beside(args, make, **how):
        """The command line run while the package makes its own: (the clip, the finished process)."""
        p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **({"stdin": subprocess.PIPE} if "input" in how else {}))
        clip = make()
        out, err = p.communicate(how.get("input"))
        return clip, subprocess.CompletedProcess(args, p.returncode, out, err)

    def ran(r):
        if r.returncode:
            raise SystemExit(f"{' '.join(r.args[:3])}: exit {r.returncode}: {r.stderr}")

    def same_bytes(clip, what):
        with open(wav, "rb") as f:
            if f.read() != clip.wav() or lip.load_timing(js) != json.loads(json.dumps(clip.timing)):
                raise SystemExit(f"{what}: not the package's bytes and timing")

    def song():
        f = os.path.join(d, "song.txt")
        with open(f, "w") as g:
            g.write(SONG)
        return f

    def named():
        ids = {v["id"]: v["name"] for v in lip._models.manifest()["voices"]}
        n = {**DUET, "parts": [{**p, "voice": ids[p["voice"]]} for p in DUET["parts"]]}
        with open(piece, "w") as f:
            json.dump({"choir": n, "seed": 4}, f)
        return n

    def cli(kind, quality, voice, out, what, *flags):
        sound = {"say": {"hifi": "hifi/vox.lsw", "fast": "fast/melvoc.lsw"}, "sing": {"hifi": "hifi/vox.lsw", "fast": "fast/vocoder.lsw"}}[kind][quality]
        # the engine's own command line loads no mel route to sing through the vocoder, so takes no mel part there
        part = [] if (kind, quality) == ("sing", "fast") else ["--vox-part" if quality == "hifi" else "--mel-part", f"{b}/{quality}/voices/{voice}.lsw"]
        return [engine, kind, f"{b}/voices/{voice}.lsw", f"{b}/{sound}", f"{b}/g2p.lsw", f"{b}/lexicon.lsw", out, what, "--alone", "--base", f"{b}/base.lsw", *part, *flags]

    def same(make, kind, quality, voice, what, *flags):
        def run():
            ours, theirs = os.path.join(d, "ours.wav"), os.path.join(d, "theirs.wav")
            rules = os.path.join(d, "rules.txt")
            with open(rules, "w") as f:
                f.write("for=hal,low word=star -> S T AA ~AH:100 R\n")
            at = {"SONG": song(), "RULES": rules}
            clip, r = beside(cli(kind, quality, voice, theirs, at.get(what, what), *[at.get(x, x) for x in flags]), make)
            ran(r)
            clip.save(ours)
            with open(ours, "rb") as f, open(theirs, "rb") as g:
                if f.read() != g.read():
                    raise SystemExit("the package's samples are not the engine's")
            return f"{clip.seconds:.2f} s"
        return run

    def thread():
        got = {}
        ts = [threading.Thread(target=lambda q=q: got.update({q: lip.say("From another thread.", "eve", quality=q)})) for q in lip.QUALITIES]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        for q in lip.QUALITIES:
            if got[q].samples != lip.say("From another thread.", "eve", quality=q).samples:
                raise SystemExit(f"{q}: another thread's samples differ")

    def choir(q):
        def run():
            c = lip.choir(DUET, quality=q, seed=4)
            left, right = c.samples
            if c.channels != 2 or len(left) != len(right) or left == right:
                raise SystemExit("not two channels of their own")
            if not 4.5 < c.seconds < 12:
                raise SystemExit(f"{c.seconds:.2f} s")
            sung = c.timing["parts"]
            if [p["voice"] for p in sung] != ["cora", "ben"] or not all(p["start"] >= 0 and p["length"] > 0 and p["text"].startswith("%bpm") for p in sung):
                raise SystemExit(f"its timing {sung}")
            if lip.choir(DUET, quality=q, seed=4)._data != c._data:
                raise SystemExit("the same seed sang it another way")
            other = lip.choir({"choir": DUET, "seed": 4, "voices": ["eve"]}, quality=q, motion="none", sway=0.5)
            if other._data == c._data or other.timing["parts"][0]["voice"] != "eve":
                raise SystemExit("another voice and manner sang the same")
            h = c.wav()[:44]
            if struct.unpack("<HH", h[20:24]) != (3, 2):
                raise SystemExit("its WAV is not float stereo")
            return f"{c.seconds:.2f} s stereo, {sum(len(p['breaths']) for p in sung)} breaths, the same again for its seed"
        return run

    def timed(clip, words, notes):
        t = clip.timing
        if t["length"] * clip.channels != len(clip._data) // 4 or t["rate"] != lip.RATE:
            raise SystemExit(f"{clip.made}: its timing's length is not the clip's")
        for p in t["parts"]:
            said = [w[2] for w in p["words"]]
            spans = p["phones"] + p["words"] + [n[:2] for n in p["notes"]] + p["breaths"]
            if not all(0 <= a < b <= t["length"] for a, b, *_ in spans) or any(b[0] < a[1] for a, b in zip(p["phones"], p["phones"][1:])):
                raise SystemExit(f"{clip.made}: a span outside the clip, or phones out of order")
            if words is not None and said != words or notes is not None and len(p["notes"]) != notes:
                raise SystemExit(f"{clip.made}: words {said}, {len(p['notes'])} notes")
            if not any(x > 0 for x in p["pitch"]) or len(p["level"]) * 240 < p["length"] - 240:
                raise SystemExit(f"{clip.made}: no pitch, or its level short")
        f = lip.frames(t, 25)
        if f["frames"] != -(-t["length"] * 25 // lip.RATE) or not all(len(x) == f["frames"] for p in f["parts"] for x in p.values() if isinstance(x, list)):
            raise SystemExit(f"{clip.made}: frames of another length")
        if not all(0 <= x <= 1 for p in f["parts"] for k in ("mouth_open", "mouth_round", "singing", "breath", "air") for x in p[k]):
            raise SystemExit(f"{clip.made}: a mouth, singing, breath or air outside 0 to 1")
        return f

    def timing_say():
        c = lip.say("The kettle is on.\n\nThe bread is done.", "eve")
        timed(c, ["the", "kettle", "is", "on", "the", "bread", "is", "done"], 0)
        if c.timing["bpm"] is not None or lip.frames(c.timing, 30)["beat"] is not None:
            raise SystemExit("a tempo for speech")
        if lip.load_timing(c.save_timing(os.path.join(d, "t.json"))) != c.timing:
            raise SystemExit("its timing saved and read back is not the same")

    def timing_sing():
        c = lip.sing(SONG, "cora")
        f = timed(c, ["twinkle", "twinkle", "little", "star"], 7)
        if c.timing["bpm"] != 100 or not -1 < f["beat"][0] < 0 < f["beat"][-1]:
            raise SystemExit(f"its beat {c.timing['bpm']}, {f['beat'][0]} to {f['beat'][-1]}")

    def timing_choir():
        c = lip.choir(DUET, seed=4)
        f = timed(c, None, 4)
        if not any(x > 0 for p in f["parts"] for x in p["breath"]) or [round(p["pan"], 3) for p in c.timing["parts"]] == [0, 0]:
            raise SystemExit("no breath in its frames, or no seats in its timing")
        air = f["parts"][0]["air"]
        if not any(b - a < 0 for a, b in zip(air, air[1:])) or max(air) < 0.9:
            raise SystemExit("its air never fills, or never falls")

    def by_name():
        n = named()
        c, r = beside([*line, "choir", piece, "--quality", "fast", "--room", "card", "-o", wav, "--timing", js], lambda: lip.choir(n, quality="fast", seed=4, room="card"))
        ran(r)
        if c._data != lip.choir(DUET, quality="fast", seed=4, room="card")._data:
            raise SystemExit("voices by name sang another way than by id")
        same_bytes(c, "the command line's choir")

    def listed():
        if not lip.choirs():
            raise SystemExit("no choirs of the site's")
        for l in (line, [engine]):
            if subprocess.run([*l, "choirs"], check=True, capture_output=True, text=True).stdout.splitlines() != lip.choirs():
                raise SystemExit(f"{l[-1]} choirs: not the package's")
            r = subprocess.run([*l, "choir", "No Such Song", "-o", wav], capture_output=True, text=True)
            if r.returncode != 1 or "no choir 'No Such Song'" not in r.stderr:
                raise SystemExit(f"{l[-1]} choir, a name there is not: {r.stderr}")

    # the engine's command line for people, the models found by name: the package's bytes and timing
    def rust(make, *args):
        def run():
            n = named()
            at = {"PIECE": piece, "SONG": song()}
            clip, r = beside([engine, *[at.get(x, x) for x in args], "-o", wav, "--timing", js], lambda: make(n))
            ran(r)
            same_bytes(clip, "the engine's command line")
        return run

    # every way a choir is sung may be asked, by each command line, and a piece read from stdin
    def manner(l):
        def run():
            n = named()
            how = {"sway": 0.5, "vibrato": 1.5, "loose": 0.25, "glide": 14, "dynamics": 2.0, "breath": 1.0, "breathiness": 0.3}
            flags = [x for k, v in how.items() for x in (f"--{k}", str(v))]
            with open(piece) as f:
                text = f.read()
            clip, r = beside([*l, "choir", "-", "--quality", "fast", "--seed", "11", "--room", "bare", "--motion", "wide", "--voices", "eve", *flags, "-o", wav, "--timing", js],
                             lambda: lip.choir(n, quality="fast", seed=11, room="bare", motion="wide", voices=["eve"], **how), input=text)
            ran(r)
            if clip._data == lip.choir(n, quality="fast", seed=4, room="card")._data:
                raise SystemExit("every manner asked for sang the same")
            same_bytes(clip, "choir -, every manner flagged")
            r = subprocess.run([*l, "choir", piece, "--quality", "fast", "--glide", "soon", "-o", wav], capture_output=True, text=True)
            if r.returncode == 0:
                raise SystemExit("choir --glide soon: not refused")
            # fetch, with the models in a folder: every file a quality reads is there, the breaths and the choirs among them
            ran(subprocess.run([*l, "fetch", "--quality", "all"], capture_output=True, text=True))
        return run

    def refused():
        refusals = [
            (ValueError, lambda: lip.say("x", "zed")),
            (ValueError, lambda: lip.say("x", quality="best")),
            (ValueError, lambda: lip.say("x", seed=-1)),
            (ValueError, lambda: lip.sing(SONG, motion="wobble")),
            (ValueError, lambda: lip.sing(SONG, glide=0)),
            (lip.Error, lambda: lip.sing("%bpm 90\nla H9:1\n")),
            (lip.Error, lambda: lip.say("<speak>", ssml=True)),
            (lip.Error, lambda: lip.choir("No Such Song")),
            (lip.Error, lambda: lip.choir(DUET, motion="wobble")),
            (lip.Error, lambda: lip.choir(DUET, voices=["ada", "ben", "cora"])),
            (lip.Error, lambda: lip.choir(DUET, voices=["zed"])),
            (lip.Error, lambda: lip.choir({"room": "card"})),
            (lip.Error, lambda: lip.loads('{"choir": "Shenandoah", "tempo": 2}')),
            (lip.Error, lambda: lip.choir(DUET, room="cathedral")),
        ]
        for want, f in refusals:
            try:
                f()
            except want as e:
                print(f"refused: {e}")
            else:
                raise SystemExit(f"not refused: expected {want.__name__}")
        return f"{len(refusals)} refusals"

    all_ = {}
    for q in lip.QUALITIES:
        all_[f"same as the engine: say, ada, {q}"] = same(lambda q=q: lip.say("Hello there, this is a clean install.", quality=q), "say", q, "ada", "Hello there, this is a clean install.", "--breaks", f"{b}/breaks.lsw")
        all_[f"same as the engine: say, two paragraphs, ben, {q}"] = same(lambda q=q: lip.say(TWO, "ben", quality=q, seed=7, rate=1.1, shift=-1.0),
                                                                          "say", q, "ben", TWO, "--breaks", f"{b}/breaks.lsw", "--stream", "50", "--seed", "7", "--rate", "1.1", "--shift", "-1")
        all_[f"same as the engine: sing, cora, {q}"] = same(lambda q=q: lip.sing(SONG, "cora", quality=q), "sing", q, "cora", "SONG")
        all_[f"same as the engine: sing, hal, wide, {q}"] = same(
            lambda q=q: lip.sing(SONG, "hal", quality=q, shift=-12.0, motion="wide", seed=3, vibrato_delay=0.1, glide=12, dynamics=0.5, breathiness=1.2, diction=["for=hal,low word=star -> S T AA ~AH:100 R"]),
            "sing", q, "hal", "SONG", "--shift", "-12", "--motion", f"{b}/motion/wide.lsw", "--seed", "3", "--vibrato-delay", "0.1", "--glide", "12", "--dynamics", "0.5", "--breathiness", "1.2", "--rules", "RULES", "--for", "hal")
    all_["same from another thread, both qualities in one process"] = thread
    for q in lip.QUALITIES:
        all_[f"choir, {q}"] = choir(q)
    all_["timing: say, its frames, saved and read back"] = timing_say
    all_["timing: sing, its frames and beat"] = timing_sing
    all_["timing: choir, its frames, breath and air"] = timing_choir
    all_["the command line's choir and --timing, voices by name: the package's own bytes"] = by_name
    all_["both command lines: choirs, and a choir there is not"] = listed
    for q in lip.QUALITIES:
        all_[f"the engine's command line: choir, a piece, {q}"] = rust(lambda n, q=q: lip.choir(n, quality=q, seed=4, room="card", loose=0.5), "choir", "PIECE", "--quality", q, "--room", "card", "--loose", "0.5")
        all_[f"the engine's command line: choir, Ah, Poor Bird, {q}"] = rust(lambda n, q=q: lip.choir("Ah, Poor Bird", quality=q, voices=[None, "ben"], motion="none"), "choir", "Ah, Poor Bird", "--quality", q, "--voices", ",ben", "--motion", "none")
        all_[f"the engine's command line: sing, {q}"] = rust(lambda n, q=q: lip.sing(SONG, "hal", quality=q, shift=-12.0, motion="wide", seed=3), "sing", "SONG", "--quality", q, "--voice", "hal", "--shift", "-12", "--motion", "wide", "--seed", "3")
        all_[f"the engine's command line: say, {q}"] = rust(lambda n, q=q: lip.say(TWO, "ben", quality=q, seed=7, rate=1.1), "say", TWO, "--quality", q, "--voice", "ben", "--seed", "7", "--rate", "1.1")
    all_["the engine's command line: a piece from stdin with every manner flagged; fetch"] = manner([engine])
    all_["the package's command line: a piece from stdin with every manner flagged; fetch"] = manner(line)
    all_["refusals"] = refused
    return all_


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--engine", required=True)
    p.add_argument("--bundle", required=True)
    p.add_argument("--jobs", type=int, default=os.cpu_count())
    p.add_argument("--only", metavar="NAME")
    a = p.parse_args()
    b = os.path.abspath(a.bundle)
    os.environ["LIPSERVICE_MODELS"] = b
    import lipservice as lip

    with tempfile.TemporaryDirectory() as d:
        all_ = parts(lip, os.path.abspath(a.engine), b, d)
        if a.only is not None:
            if a.only not in all_:
                raise SystemExit(f"no part {a.only!r}")
            said = all_[a.only]()
            print(f"{a.only}{': ' + said if said else ''}")
            return

    def one(name):
        t = time.monotonic()
        r = subprocess.run([sys.executable, "-u", os.path.abspath(__file__), "--engine", a.engine, "--bundle", b, "--only", name], capture_output=True, text=True)
        return name, r, time.monotonic() - t

    failed, k, start = [], 0, time.monotonic()
    print(f"{time.strftime('%H:%M:%S')} {len(all_)} parts, {a.jobs} at a time", flush=True)
    with concurrent.futures.ThreadPoolExecutor(a.jobs) as pool:
        for f in concurrent.futures.as_completed([pool.submit(one, name) for name in all_]):
            name, r, took = f.result()
            k += 1
            mark = f"{time.strftime('%H:%M:%S')} [{k}/{len(all_)}] {took:.0f} s"
            if r.returncode:
                failed.append(name)
                print(f"{mark} FAILED {name}\n{r.stdout}{r.stderr}", flush=True)
            else:
                print(f"{mark} {r.stdout.rstrip()}", flush=True)
    if failed:
        raise SystemExit(f"FAILED: {len(failed)} of {len(all_)} parts: {'; '.join(failed)}")
    n = sum(name.startswith("same as the engine: ") for name in all_)
    print(f"ok: {n} cases the same as the engine, {len(all_)} parts, {time.monotonic() - start:.0f} s")


if __name__ == "__main__":
    main()
