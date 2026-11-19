# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""Lip Service: speech and singing on a CPU.

    import lipservice as lip

    lip.say("Hello there.").save("hello.wav")
    lip.sing("bpm 90\\nTwinkle C4:1 C4:1\\ntwinkle G4:1 G4:1\\n", voice="cora").play()

Sixteen voices (voices()), two qualities: "hifi", the default, and "fast". The models are fetched the
first time they are needed and kept. Everything is made on this machine. devices() lists its sound
outputs, and play(device=ID) plays through one of them.
"""

import array
import base64
import html
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
from importlib.metadata import version

from . import _audio, _models
from ._engine import RATE, Engine, Error

__version__ = version("lipservice")
__all__ = ["say", "sing", "voices", "devices", "Clip", "Error", "RATE", "QUALITIES", "MOTIONS"]

QUALITIES = ("hifi", "fast")
MOTIONS = ("straight", "vibrato", "wide")


class Clip:
    """Sound made: mono, 24 kHz. samples is an array of floats; made says what made it."""

    rate = RATE

    def __init__(self, data, made):
        self._data, self.made = data, made

    @property
    def samples(self):
        a = array.array("f")
        a.frombytes(self._data)
        return a

    @property
    def seconds(self):
        return len(self._data) / 4 / RATE

    def wav(self):
        """The clip as a WAV file's bytes: 32-bit float, every sample as computed, nothing clipped."""
        if not math.isfinite(sum(self.samples)):
            raise Error(f"{self.made}: a sample is not a number")
        n = len(self._data)
        head = struct.pack("<4sI4s4sIHHIIHHH4sII4sI", b"RIFF", 50 + n, b"WAVE", b"fmt ", 18, 3, 1, RATE, RATE * 4, 4, 32, 0, b"fact", 4, n // 4, b"data", n)
        return head + self._data

    def save(self, path):
        with open(path, "wb") as f:
            f.write(self.wav())
        return path

    def play(self, device=None):
        """Plays it and waits. device is the id of one of devices(); with none, the system's own
        player plays it where the system plays sound: afplay on macOS, aplay on Linux, Windows'
        own sound call."""
        if device is not None:
            _audio.Player(self, device).wait()
            return
        if sys.platform == "win32":
            import winsound

            winsound.PlaySound(self.wav(), winsound.SND_MEMORY)
            return
        players = {"darwin": ["afplay"], "linux": ["aplay", "-q"]}
        if sys.platform not in players:
            raise OSError(f"no player for {sys.platform}: write a WAV file instead (out in the MCP server, -o on the command line, save() in Python)")
        player = players[sys.platform]
        if not shutil.which(player[0]):
            raise OSError(f"{player[0]} is not on this machine to play it with: write a WAV file instead (out in the MCP server, -o on the command line, save() in Python)")
        with tempfile.TemporaryDirectory() as d:
            subprocess.run([*player, self.save(os.path.join(d, "clip.wav"))], check=True)

    def __repr__(self):
        return f"<Clip {self.seconds:.2f} s, {self.made}>"

    def _repr_html_(self):
        return f'<audio controls src="data:audio/wav;base64,{base64.b64encode(self.wav()).decode()}"></audio><div>{html.escape(repr(self))}</div>'


class _Quality:
    """One quality's engine with its models in it, and the voices and motions loaded so far."""

    def __init__(self, name):
        self.name, self.engine, self.lock = name, Engine(), threading.Lock()
        self.voices, self.motions = {}, {}
        e = self.engine
        if name == "hifi":
            e.load("vox", _models.read("hifi/vox.lsw"))
        else:
            e.load("vocoder", _models.read("fast/vocoder.lsw"))
            e.load("melvoc", _models.read("fast/melvoc.lsw"))
        self.base = e.load("base", _models.read("base.lsw"))
        e.phonemizer(_models.read("g2p.lsw"), _models.read("lexicon.lsw"))
        e.load("breaks", _models.read("breaks.lsw"))

    def voice(self, name):
        with self.lock:
            if name not in self.voices:
                # the file both qualities read, and this quality's part of the voice
                part = {"vox" if self.name == "hifi" else "mel": _models.read(f"{self.name}/voices/{name}.lsw")}
                self.voices[name] = self.engine.voice(_models.read(f"voices/{name}.lsw"), self.base, **part)
            return self.voices[name]

    def motion(self, name):
        with self.lock:
            if name not in self.motions:
                self.motions[name] = self.engine.load("motion", _models.read(f"motion/{name}.lsw"))
            return self.motions[name]


_qualities = {}
_lock = threading.Lock()


def _quality(name):
    if name not in QUALITIES:
        raise ValueError(f"quality {name!r}: {' or '.join(QUALITIES)}")
    with _lock:
        if name not in _qualities:
            _qualities[name] = _Quality(name)
        return _qualities[name]


def devices():
    """This machine's sound outputs: id (what play() takes), name, and default (True for one)."""
    return _audio.devices()


def voices():
    """The voices: name, sex ("F" or "M") and the recordings each was made from."""
    return [{k: v[k] for k in ("name", "sex", "source")} for v in _models.manifest()["voices"]]


def _voice(name):
    names = [v["name"] for v in _models.manifest()["voices"]]
    n = str(name).lower()
    if n not in names:
        raise ValueError(f"no voice {name!r}: {', '.join(names)}")
    return n


def say(text, voice="ada", *, quality="hifi", rate=1.0, shift=0.0, seed=0, ssml=False):
    """Text said by a voice.

    rate: its speed, times. shift: semitones from the voice's own register. seed: the same seed
    says it the same way. ssml: the text is SSML. Paragraphs are said one at a time with a pause
    between.
    """
    v = _voice(voice)
    q = _quality(quality)
    data = q.engine.say(q.voice(v), text, ssml=ssml, rate=rate, shift=shift, seed=seed)
    return Clip(data, f"say, {v}, {quality}")


def sing(song, voice="ada", *, quality="hifi", shift=0.0, seed=0, vibrato=0.25, vibrato_hz=5.5, vibrato_delay=0.25, motion=None, motion_scale=1.0,
         glide=9, dynamics=0.0, breathiness=1.0, diction=False):
    """A song sung by a voice. The song is a score as text:

        bpm 90
        Twinkle C4:1 C4:1
        twinkle G4:1 G4:1
        rest 1
        star F4:0.5+E4:0.5

    a word a line with a NOTE:BEATS for each syllable (C4, F#3, Bb2 or a MIDI number; + joins
    notes within a syllable, its vowel moving through them), `rest BEATS`, `bpm N`, and lines
    starting # as comments. The notes are sung where they are written: shift=-12 puts a song
    written for a woman in a man's range.

    shift: semitones, the whole song. vibrato: its peak in semitones, vibrato_hz its speed,
    vibrato_delay the seconds into a vowel it starts. motion: a trained singer's pitch motion in
    place of the vibrato ("straight", "vibrato" or "wide"; the seed picks the singer), motion_scale
    times its size. glide: the frames (10 ms) the pitch takes between notes. dynamics: how far
    loudness and brightness follow the notes. breathiness: the sung vowels' breath noise, times.
    diction: every vowel stressed.
    """
    v = _voice(voice)
    if motion is not None and motion not in MOTIONS:
        raise ValueError(f"motion {motion!r}: {', '.join(MOTIONS)}")
    q = _quality(quality)
    data = q.engine.sing(q.voice(v), song, shift=shift, seed=seed, vibrato=vibrato, vibrato_hz=vibrato_hz, vibrato_delay=vibrato_delay, glide=glide, dynamics=dynamics,
                         breathiness=breathiness, diction=diction, motion=-1 if motion is None else q.motion(motion), motion_scale=motion_scale)
    return Clip(data, f"sing, {v}, {quality}")
