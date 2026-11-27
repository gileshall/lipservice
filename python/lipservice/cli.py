# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""The command line:

    lipservice say "Hello there."
    lipservice say "Hello there." -o hello.wav --voice ben
    lipservice sing song.txt --voice cora --motion vibrato
    lipservice choir "Barbershop tag" -o tag.wav --timing tag.json
    lipservice choir piece.json --room drier
    lipservice say "Hello there." --device BuiltInSpeakerDevice
    lipservice voices
    lipservice choirs
    lipservice devices
    lipservice fetch
    lipservice mcp --out ~/sounds

Without -o the sound is played; with it, written as a WAV file. --device plays it through one of
`lipservice devices`, by its id. --timing writes what the voices did when, as JSON. `choir` sings a
piece for several voices: one of `lipservice choirs` by name, or a JSON file. `mcp` is the MCP
server (mcp.py).
"""

import argparse
import os
import sys
import time

from . import HOW, MOTIONS, QUALITIES, ROOMS, Error, __version__, _models, choir, choirs, devices, load, loads, say, sing, voices


def _text(arg):
    return sys.stdin.read() if arg == "-" else arg


def _file(arg):
    if arg == "-":
        return sys.stdin.read()
    with open(arg, encoding="utf-8") as f:
        return f.read()


def _where(p):
    p.add_argument("-o", "--out", metavar="FILE.wav", help="write a WAV file in place of playing")
    p.add_argument("--device", metavar="ID", help="play through this output, one of `lipservice devices`")
    p.add_argument("--timing", metavar="FILE.json", help="write what each voice did when: phones, words, notes, breaths, pitch and loudness")
    p.add_argument("--quality", default="hifi", choices=QUALITIES)


def _common(p):
    _where(p)
    p.add_argument("--voice", default="ada", help="one of `lipservice voices` (ada)")
    p.add_argument("--shift", type=float, default=0.0, metavar="SEMITONES")
    p.add_argument("--seed", type=int, default=0)


def _voices(arg):
    """--voices cora,,ben: a voice a part, an empty place the part's own."""
    return [v.strip() or None for v in arg.split(",")]


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
    g.add_argument("--rules", metavar="RULES.txt", help="diction rules, a line each, read before the song's own")
    g.add_argument("--tag", action="append", default=[], metavar="NAME", help="a name the singer goes by, for a rule's for=")

    c = sub.add_parser("choir", help="sing a piece for several voices, seated and in a room, in stereo")
    c.add_argument("piece", metavar="PIECE", help="one of `lipservice choirs`, a piece's JSON file, or - to read one from stdin")
    _where(c)
    c.add_argument("--seed", type=int, help="the singers' draws (the piece's own)")
    c.add_argument("--room", choices=ROOMS, help="the room it is sung in (the piece's own)")
    c.add_argument("--motion", choices=MOTIONS + ("none",), help="a trained singer's pitch motion for every part, or none for the plain vibrato (the piece's own)")
    c.add_argument("--voices", type=_voices, metavar="NAME,NAME,...", help="a voice a part, in the piece's order; an empty place keeps the part's own")
    for k, (lo, hi) in HOW.items():
        c.add_argument(f"--{k}", type=type(lo), metavar=f"{lo:g}..{hi:g}")

    sub.add_parser("voices", help="list the voices")
    sub.add_parser("choirs", help="list the choirs `lipservice choir` sings by name")
    sub.add_parser("devices", help="list this machine's sound outputs: id, name, and * on the default")

    m = sub.add_parser("mcp", help="serve say and sing to a model, over the Model Context Protocol on stdin and stdout")
    m.add_argument("--out", metavar="DIR", default=os.environ.get("LIPSERVICE_OUT") or None,
                   help="the folder sound is written to when a call names no device and no full path (LIPSERVICE_OUT); without one such a call is refused")

    f = sub.add_parser("fetch", help="read the list of models from the server again, and fetch what a quality needs")
    f.add_argument("--quality", default="hifi", choices=QUALITIES + ("all",))
    return p


def _give(clip, took, a):
    out, device = a.out, a.device
    print(f"lipservice: {clip.made}: {clip.seconds:.2f} s of sound in {took:.2f} s", file=sys.stderr)
    if out:
        clip.save(out)
    if a.timing:
        clip.save_timing(a.timing)
    if device or not out:
        clip.play(device)


def _run(a):
    if a.command == "voices":
        for v in voices():
            print(f"{v['name']}\t{v['sex']}\t{v['source']}")
    elif a.command == "choirs":
        for n in choirs():
            print(n)
    elif a.command == "devices":
        for d in devices():
            print(f"{d['id']}\t{d['name']}\t{'*' if d['default'] else ''}")
    elif a.command == "mcp":
        from . import mcp

        mcp.serve(a.out)
    elif a.command == "fetch":
        want = QUALITIES if a.quality == "all" else (a.quality,)
        # page/ holds the breaths a choir's singers take
        files = _models.update()["files"]
        shared = [n for n in files if n.split("/")[0] not in QUALITIES]
        for n in shared + [n for n in files if n.split("/")[0] in want]:
            _models.path(n)
        print(f"lipservice: the models are in {_models.home()}", file=sys.stderr)
    elif a.command == "say":
        t = time.perf_counter()
        clip = say(_text(a.text), a.voice, quality=a.quality, rate=a.rate, shift=a.shift, seed=a.seed, ssml=a.ssml)
        _give(clip, time.perf_counter() - t, a)
    elif a.command == "choir":
        t = time.perf_counter()
        if a.piece == "-":
            piece = loads(sys.stdin.read())
        elif a.piece in choirs():
            piece = a.piece
        elif os.path.isfile(a.piece):
            piece = load(a.piece)
        else:
            raise ValueError(f"no choir {a.piece!r}: it is not one of `lipservice choirs`, and there is no such file")
        clip = choir(piece, quality=a.quality, seed=a.seed, room=a.room, motion=a.motion, voices=a.voices, **{k: getattr(a, k) for k in HOW})
        _give(clip, time.perf_counter() - t, a)
    else:
        t = time.perf_counter()
        clip = sing(_file(a.song), a.voice, quality=a.quality, shift=a.shift, seed=a.seed, vibrato=a.vibrato, vibrato_hz=a.vibrato_hz, vibrato_delay=a.vibrato_delay,
                    motion=a.motion, motion_scale=a.motion_scale, glide=a.glide, dynamics=a.dynamics, breathiness=a.breathiness, diction=_file(a.rules) if a.rules else None, tags=a.tag)
        _give(clip, time.perf_counter() - t, a)


def main(argv=None):
    a = _parser().parse_args(argv)
    try:
        _run(a)
    except (Error, ValueError, OSError, RuntimeError) as e:
        sys.exit(f"lipservice: {e}")
