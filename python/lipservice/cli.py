# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""The command line:

    lipservice say "Hello there."
    lipservice say "Hello there." -o hello.wav --voice ben
    lipservice sing song.txt --voice cora --motion vibrato
    lipservice say "Hello there." --device BuiltInSpeakerDevice
    lipservice voices
    lipservice devices
    lipservice fetch
    lipservice mcp --out ~/sounds

Without -o the sound is played; with it, written as a WAV file. --device plays it through one of
`lipservice devices`, by its id. `mcp` is the MCP server (mcp.py).
"""

import argparse
import os
import sys
import time

from . import MOTIONS, QUALITIES, Error, __version__, _models, devices, say, sing, voices


def _text(arg):
    return sys.stdin.read() if arg == "-" else arg


def _file(arg):
    if arg == "-":
        return sys.stdin.read()
    with open(arg, encoding="utf-8") as f:
        return f.read()


def _common(p):
    p.add_argument("-o", "--out", metavar="FILE.wav", help="write a WAV file in place of playing")
    p.add_argument("--device", metavar="ID", help="play through this output, one of `lipservice devices`")
    p.add_argument("--voice", default="ada", help="one of `lipservice voices` (ada)")
    p.add_argument("--quality", default="hifi", choices=QUALITIES)
    p.add_argument("--shift", type=float, default=0.0, metavar="SEMITONES")
    p.add_argument("--seed", type=int, default=0)


def _parser():
    p = argparse.ArgumentParser(prog="lipservice", description="Speech and singing on a CPU.")
    p.add_argument("--version", action="version", version=f"lipservice {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("say", help="say a text")
    s.add_argument("text", help="the text, or - to read it from stdin")
    _common(s)
    s.add_argument("--rate", type=float, default=1.0, help="speed, times")
    s.add_argument("--ssml", action="store_true", help="the text is SSML")

    g = sub.add_parser("sing", help="sing a song")
    g.add_argument("song", metavar="SONG.txt", help="the song's score, or - to read it from stdin")
    _common(g)
    g.add_argument("--vibrato", type=float, default=0.25, metavar="SEMITONES")
    g.add_argument("--vibrato-hz", type=float, default=5.5)
    g.add_argument("--vibrato-delay", type=float, default=0.25, metavar="SECONDS")
    g.add_argument("--motion", choices=MOTIONS, help="a trained singer's pitch motion in place of the vibrato")
    g.add_argument("--motion-scale", type=float, default=1.0)
    g.add_argument("--glide", type=int, default=9, metavar="FRAMES")
    g.add_argument("--dynamics", type=float, default=0.0)
    g.add_argument("--breathiness", type=float, default=1.0)
    g.add_argument("--diction", action="store_true", help="every vowel stressed")

    sub.add_parser("voices", help="list the voices")
    sub.add_parser("devices", help="list this machine's sound outputs: id, name, and * on the default")

    m = sub.add_parser("mcp", help="serve say and sing to a model, over the Model Context Protocol on stdin and stdout")
    m.add_argument("--out", metavar="DIR", default=os.environ.get("LIPSERVICE_OUT") or None,
                   help="the folder sound is written to when a call names no device and no full path (LIPSERVICE_OUT); without one such a call is refused")

    f = sub.add_parser("fetch", help="fetch the models ahead of the first use")
    f.add_argument("--quality", default="hifi", choices=QUALITIES + ("all",))
    return p


def _give(clip, took, out, device):
    print(f"lipservice: {clip.made}: {clip.seconds:.2f} s of sound in {took:.2f} s", file=sys.stderr)
    if out:
        clip.save(out)
    if device or not out:
        clip.play(device)


def _run(a):
    if a.command == "voices":
        for v in voices():
            print(f"{v['name']}\t{v['sex']}\t{v['source']}")
    elif a.command == "devices":
        for d in devices():
            print(f"{d['id']}\t{d['name']}\t{'*' if d['default'] else ''}")
    elif a.command == "mcp":
        from . import mcp

        mcp.serve(a.out)
    elif a.command == "fetch":
        want = QUALITIES if a.quality == "all" else (a.quality,)
        # page/ is a site's page's alone
        shared = [n for n in _models.manifest()["files"] if n.split("/")[0] not in (*QUALITIES, "page")]
        for n in shared + [n for n in _models.manifest()["files"] if n.split("/")[0] in want]:
            _models.path(n)
        print(f"lipservice: the models are in {_models.home()}", file=sys.stderr)
    elif a.command == "say":
        t = time.perf_counter()
        clip = say(_text(a.text), a.voice, quality=a.quality, rate=a.rate, shift=a.shift, seed=a.seed, ssml=a.ssml)
        _give(clip, time.perf_counter() - t, a.out, a.device)
    else:
        t = time.perf_counter()
        clip = sing(_file(a.song), a.voice, quality=a.quality, shift=a.shift, seed=a.seed, vibrato=a.vibrato, vibrato_hz=a.vibrato_hz, vibrato_delay=a.vibrato_delay,
                    motion=a.motion, motion_scale=a.motion_scale, glide=a.glide, dynamics=a.dynamics, breathiness=a.breathiness, diction=a.diction)
        _give(clip, time.perf_counter() - t, a.out, a.device)


def main(argv=None):
    a = _parser().parse_args(argv)
    try:
        _run(a)
    except (Error, ValueError, OSError, RuntimeError) as e:
        sys.exit(f"lipservice: {e}")
