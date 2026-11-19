# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""Runs every example in the docs against an installed lipservice.

    python docs.py README.md SCORE.md AGENTS.md ...

Run it with the Python the wheel is installed in, from anywhere but python/ (which holds the
source package, with no library in it). It reads each file's fenced blocks:

    ```score [FILE]   a song. It is sung, and its length must be its beats' plus the lead and
                      the tail. With FILE, it is also written there for later commands.
                      A line "Refused: `MESSAGE`" right after the block says the engine must
                      refuse it, in those words.
    ```python         run; a file's blocks share their names, in order.
    ```bash           each `lipservice ...` line is run; others (pip, git) are not.

Nothing is played: play() and the players the command line calls are replaced by ones that only
count. Everything runs in an empty folder, and songs are sung on the fast quality. Every example
that does not do what its page says is listed, and the exit status is then 1.
"""

import os
import re
import shlex
import subprocess
import sys
import tempfile

import lipservice as lip

FENCE = re.compile(r"^```(\w+)?[ \t]*([^\n`]*)\n(.*?)^```[ \t]*\n(?:Refused: `([^`\n]+)`)?", re.M | re.S)
# seconds a song runs past its beats: the lead-in, the tail, and frames rounded
EXTRA = (0.15, 0.35)


class Wrong(Exception):
    """An example that does not do what its page says."""


def beats(score):
    """A score's bpm and its beats, as written."""
    bpm, total = None, 0.0
    for line in score.splitlines():
        f = line.split()
        if not f or f[0].startswith("#") or f[0] == "vibrato":
            continue
        if f[0] == "bpm":
            bpm = float(f[1])
        elif f[0] == "rest":
            total += float(f[1])
        else:
            total += sum(float(n.split(":")[1]) for g in f[1:] for n in g.split("+"))
    return bpm, total


def check_score(score, name, refused):
    if name:
        with open(name, "w", encoding="utf-8") as f:
            f.write(score)
    try:
        clip = lip.sing(score, quality="fast")
    except lip.Error as e:
        if not refused:
            raise Wrong(f"refused: {e}") from None
        if str(e) != refused:
            raise Wrong(f"refused with `{e}`, where the page has `{refused}`") from None
        return f"refused as written: {refused}"
    if refused:
        raise Wrong("sung, where the page says it is refused")
    bpm, total = beats(score)
    extra = clip.seconds - total * 60 / bpm
    if not EXTRA[0] <= extra <= EXTRA[1]:
        raise Wrong(f"{clip.seconds:.2f} s for {total:g} beats at {bpm:g}, {extra:.2f} s over")
    return f"sung, {clip.seconds:.2f} s for {total:g} beats at {bpm:g}"


def check_python(block, where, names):
    try:
        exec(compile(block, where, "exec"), names)
    except Exception as e:
        raise Wrong(f"{type(e).__name__}: {e}") from None
    return "ran"


def check_bash(block, env):
    ran = []
    for line in block.splitlines():
        words = shlex.split(line, comments=True)
        if not words or words[0] != "lipservice":
            continue
        r = subprocess.run([os.path.join(os.path.dirname(sys.executable), "lipservice"), *words[1:]], env=env, capture_output=True, text=True)
        if r.returncode:
            raise Wrong(f"{line}: {r.stderr.strip()}")
        ran.append(line)
    return f"{len(ran)} commands" if ran else "nothing to run"


def main():
    files = [os.path.abspath(f) for f in sys.argv[1:]]
    if not files:
        sys.exit(__doc__)
    played, wrong = [], 0
    lip.Clip.play = lambda self, device=None: played.append(self)
    for path in files:
        with open(path, encoding="utf-8") as f:
            text = f.read()
        print(os.path.relpath(path, os.path.commonpath(files) if len(files) > 1 else os.path.dirname(path)))
        with tempfile.TemporaryDirectory() as d:
            os.chdir(d)
            # players that only count, ahead of the machine's own
            os.mkdir("bin")
            for p in ("afplay", "aplay"):
                with open(os.path.join("bin", p), "w") as f:
                    f.write(f"#!/bin/sh\necho {p} >> '{d}/played'\n")
                os.chmod(os.path.join("bin", p), 0o755)
            env = {**os.environ, "PATH": os.path.join(d, "bin") + os.pathsep + os.environ["PATH"]}
            names = {}
            for m in FENCE.finditer(text):
                lang, rest, body, refused = m.group(1), m.group(2).strip(), m.group(3), m.group(4)
                if lang not in ("score", "python", "bash"):
                    continue
                where = f"{os.path.basename(path)}:{text.count(chr(10), 0, m.start()) + 1}"
                try:
                    if lang == "score":
                        said = check_score(body, rest, refused)
                    elif lang == "python":
                        said = check_python(body, where, names)
                    else:
                        said = check_bash(body, env)
                except Wrong as e:
                    wrong += 1
                    said = f"WRONG: {e}"
                print(f"  {where}  {lang}: {said}")
            cli = open("played").read().split() if os.path.exists("played") else []
            wavs = sorted(f for f in os.listdir(d) if f.endswith(".wav"))
            os.chdir("/")
        print(f"  wrote {', '.join(wavs) or 'no files'}; would have played {len(cli)} from the command line")
    print(f"{f'{wrong} WRONG' if wrong else 'ok'}: {len(files)} files; play() called {len(played)} times and nothing played")
    sys.exit(1 if wrong else 0)


if __name__ == "__main__":
    main()
