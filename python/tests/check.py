# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""Checks an installed lipservice against the engine's own command line: the same samples.

    python python/tests/check.py --engine engine/target/release/lipservice --bundle BUNDLE

Run it with the Python the wheel is installed in (it is kept out of python/ so that `import
lipservice` is the installed one, not the source beside it). BUNDLE is what bundle.py made. Each case is said
or sung by the package and by the engine's CLI from the same files, and the two WAV files must be
the same bytes. Then the package's own promises: a call from another thread, both qualities in one
process, and each refusal as its own error.
"""

import argparse
import os
import subprocess
import tempfile
import threading

SONG = "bpm 100\ntwinkle C4:1 C4:1\ntwinkle G4:1 G4:1\nlittle A4:1 A4:1\nstar G4:2\n"
TWO = "The first paragraph is short.\n\nThe second one follows it, after a pause. Is that right?"


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--engine", required=True)
    p.add_argument("--bundle", required=True)
    a = p.parse_args()
    b = os.path.abspath(a.bundle)
    os.environ["LIPSERVICE_MODELS"] = b
    import lipservice as lip

    def cli(kind, quality, voice, out, what, *flags):
        sound = {"say": {"hifi": "hifi/vox.lsw", "fast": "fast/melvoc.lsw"}, "sing": {"hifi": "hifi/vox.lsw", "fast": "fast/vocoder.lsw"}}[kind][quality]
        # the engine's own command line loads no mel route to sing through the vocoder, so takes no mel part there
        part = [] if (kind, quality) == ("sing", "fast") else ["--vox-part" if quality == "hifi" else "--mel-part", f"{b}/{quality}/voices/{voice}.lsw"]
        args = [a.engine, kind, f"{b}/voices/{voice}.lsw", f"{b}/{sound}", f"{b}/g2p.lsw", f"{b}/lexicon.lsw", out, what, "--base", f"{b}/base.lsw", *part, *flags]
        subprocess.run(args, check=True, capture_output=True)

    with tempfile.TemporaryDirectory() as d:
        song = os.path.join(d, "song.txt")
        with open(song, "w") as f:
            f.write(SONG)
        n = 0
        for q in lip.QUALITIES:
            cases = [
                (f"say, ada, {q}", lambda q=q: lip.say("Hello there, this is a clean install.", quality=q), ("say", q, "ada", "Hello there, this is a clean install.", "--breaks", f"{b}/breaks.lsw")),
                (f"say, two paragraphs, ben, {q}", lambda q=q: lip.say(TWO, "ben", quality=q, seed=7, rate=1.1, shift=-1.0),
                 ("say", q, "ben", TWO, "--breaks", f"{b}/breaks.lsw", "--stream", "50", "--seed", "7", "--rate", "1.1", "--shift", "-1")),
                (f"sing, cora, {q}", lambda q=q: lip.sing(SONG, "cora", quality=q), ("sing", q, "cora", song)),
                (f"sing, hal, wide, {q}", lambda q=q: lip.sing(SONG, "hal", quality=q, shift=-12.0, motion="wide", seed=3, vibrato_delay=0.1, glide=12, dynamics=0.5, breathiness=1.2, diction=True),
                 ("sing", q, "hal", song, "--shift", "-12", "--motion", f"{b}/motion/wide.lsw", "--seed", "3", "--vibrato-delay", "0.1", "--glide", "12", "--dynamics", "0.5", "--breathiness", "1.2", "--diction")),
            ]
            for name, make, (kind, quality, voice, what, *flags) in cases:
                ours, theirs = os.path.join(d, "ours.wav"), os.path.join(d, "theirs.wav")
                clip = make()
                clip.save(ours)
                cli(kind, quality, voice, theirs, what, *flags)
                with open(ours, "rb") as f, open(theirs, "rb") as g:
                    if f.read() != g.read():
                        raise SystemExit(f"{name}: the package's samples are not the engine's")
                print(f"same as the engine: {name}, {clip.seconds:.2f} s")
                n += 1

    got = {}
    ts = [threading.Thread(target=lambda q=q: got.update({q: lip.say("From another thread.", "eve", quality=q)})) for q in lip.QUALITIES]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    for q in lip.QUALITIES:
        if got[q].samples != lip.say("From another thread.", "eve", quality=q).samples:
            raise SystemExit(f"{q}: another thread's samples differ")
    print("same from another thread, both qualities in one process")

    refusals = [
        (ValueError, lambda: lip.say("x", "zed")),
        (ValueError, lambda: lip.say("x", quality="best")),
        (ValueError, lambda: lip.say("x", seed=-1)),
        (ValueError, lambda: lip.sing(SONG, motion="wobble")),
        (ValueError, lambda: lip.sing(SONG, glide=0)),
        (lip.Error, lambda: lip.sing("bpm 90\nla H9:1\n")),
        (lip.Error, lambda: lip.say("<speak>", ssml=True)),
    ]
    for want, f in refusals:
        try:
            f()
        except want as e:
            print(f"refused: {e}")
        else:
            raise SystemExit(f"not refused: expected {want.__name__}")
    print(f"ok: {n} cases the same as the engine, {len(refusals)} refusals")


if __name__ == "__main__":
    main()
