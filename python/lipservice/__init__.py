# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""Lip Service: speech and singing on a CPU.

    import lipservice as lip

    lip.say("Hello there.").save("hello.wav")
    lip.sing("%bpm 90\\nTwinkle C4:1 C4:1\\ntwinkle G4:1 G4:1\\n", voice="cora").play()
    for chunk in lip.sing_stream(song, voice="cora"):  # the sound as it is made
        sink.write(chunk)

Sixteen voices (voices()), two qualities: "hifi", the default, and "fast". The models are fetched the
first time they are needed and kept. Everything is made on this machine. devices() lists its sound
outputs, and play(device=ID) plays through one of them. choir() sings a piece for several voices as
lipservice.dev's choirs do, seated and in a room, in stereo; choirs() names the site's pieces.
"""

import array
import base64
import html
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
from importlib.metadata import version

from . import _audio, _models, _timing
from ._engine import RATE, Engine, Error, Stream, rooms

__version__ = version("lipservice")
__all__ = ["say", "sing", "say_stream", "sing_stream", "Stream", "read", "choir", "choirs", "load", "loads", "frames", "load_timing", "voices", "devices", "Clip", "Error", "RATE", "QUALITIES", "MOTIONS", "ROOMS", "HOW"]

QUALITIES = ("hifi", "fast")
MOTIONS = ("straight", "vibrato", "wide")
# the rooms a choir is sung in
ROOMS = rooms()
# how a choir sings where that is not the piece's own way, as choir() takes it: each one's lowest
# and highest, as lipservice.dev's knobs have them; None, the default, is the piece's own
HOW = {
    "sway": (0.0, 2.0),  # the singers' vibrato and drift against their own size (the piece's own: 1)
    "vibrato": (0.0, 2.0),  # the vibrato alone against its own size
    "loose": (0.0, 2.0),  # how far off the beat and the pitch each singer is (the piece's own: 1)
    "glide": (1, 30),  # frames (10 ms) the pitch takes between notes
    "dynamics": (0.0, 2.5),  # how far loudness and brightness follow the notes
    "breath": (0.0, 1.0),  # the chance of a breath in each rest
    "breathiness": (0.0, 1.5),  # breath noise in the sung vowels, times
}


class Clip:
    """Sound made at 24 kHz: mono from say() and sing(), stereo from choir() (channels). samples is
    an array of floats, or for stereo [left, right], two of them; made says what made it. timing is
    what its voices did when, as plain data (lipservice._timing gives its fields: phones, words,
    notes, breaths, pitch and loudness by part, in samples of the clip); frames() reads it a video
    frame at a time, and save_timing() writes it as JSON beside the sound."""

    rate = RATE

    def __init__(self, data, made, channels=1, timing=None):
        self._data, self.made, self.channels, self.timing = data, made, channels, timing

    @property
    def samples(self):
        a = array.array("f")
        a.frombytes(self._data)
        if self.channels == 1:
            return a
        return [a[c :: self.channels] for c in range(self.channels)]

    @property
    def seconds(self):
        return len(self._data) / 4 / self.channels / RATE

    def wav(self):
        """The clip as a WAV file's bytes: 32-bit float, every sample as computed, nothing clipped."""
        a = array.array("f")
        a.frombytes(self._data)
        if not math.isfinite(sum(a)):
            raise Error(f"{self.made}: a sample is not a number")
        n, ch = len(self._data), self.channels
        head = struct.pack("<4sI4s4sIHHIIHHH4sII4sI", b"RIFF", 50 + n, b"WAVE", b"fmt ", 18, 3, ch, RATE, RATE * 4 * ch, 4 * ch, 32, 0, b"fact", 4, n // 4 // ch, b"data", n)
        return head + self._data

    def save(self, path):
        with open(path, "wb") as f:
            f.write(self.wav())
        return path

    def save_timing(self, path):
        """The clip's timing as a JSON file (load_timing() reads it)."""
        return _timing.save(self.timing, path)

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
        return f"<Clip {self.seconds:.2f} s{', stereo' if self.channels == 2 else ''}, {self.made}>"

    def _repr_html_(self):
        return f'<audio controls src="data:audio/wav;base64,{base64.b64encode(self.wav()).decode()}"></audio><div>{html.escape(repr(self))}</div>'


class _Quality:
    """One quality's engine with its models in it, and the voices and motions loaded so far."""

    def __init__(self, name):
        self.name, self.engine, self.lock = name, Engine(), threading.Lock()
        self.voices, self.motions, self.breathing = {}, {}, False
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

    def breaths(self):
        with self.lock:
            if not self.breathing:
                self.engine.breaths(_models.read("page/breaths.json"), _models.read("page/breaths.bin"))
                self.breathing = True


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
    data, t = q.engine.say(q.voice(v), text, ssml=ssml, rate=rate, shift=shift, seed=seed)
    clip = Clip(data, f"say, {v}, {quality}")
    clip.timing = _timing.clip(t["rate"], t["length"], [_timing.part("", v, 0, t["length"], 0.0, t, level=q.engine.levels(data))])
    return clip


def _diction(diction, tags, voice):
    """The engine's diction: its rules as lines, and who sings."""
    if diction is None:
        lines = []
    elif isinstance(diction, str):
        lines = diction.splitlines()
    elif isinstance(diction, (list, tuple)) and all(isinstance(x, str) for x in diction):
        lines = list(diction)
    else:
        raise ValueError(f'diction {diction!r}: rules as lines, a list or a text of them')
    lines = [x.strip() for x in lines]
    lines = [x.removeprefix("%diction ").strip() for x in lines if x and not x.startswith("#")]
    if isinstance(tags, str) or not all(isinstance(t, str) for t in tags):
        raise ValueError(f"tags {tags!r}: names, a list")
    return lines, {"voice": voice, "tags": list(tags)}


def sing(song, voice="ada", *, quality="hifi", shift=0.0, seed=0, vibrato=0.25, vibrato_hz=5.5, vibrato_delay=0.25, motion=None, motion_scale=1.0,
         glide=9, dynamics=0.0, breathiness=1.0, diction=None, tags=()):
    """A song sung by a voice. The song is a score as text:

        %bpm 90
        Twinkle C4:1 C4:1
        twinkle G4:1 G4:1
        %rest 1
        star F4:0.5+E4:0.5

    a word a line with a NOTE:BEATS for each syllable (C4, F#3, Bb2 or a MIDI number; + joins
    notes within a syllable, its vowel moving through them). A line that starts with % is an
    instruction: `%bpm N` the tempo, once and before the first word; `%rest BEATS` silence;
    `%vibrato SIZE ...` the vibrato's size from there on; `%diction RULE` a rule of the song's
    diction and `%together`, both before the first word. Every other line is a word, so rest and
    bpm are words to sing. Lines starting # are comments. A word may write its own sounds,
    `night{N,AA,~AY:200,T} D4:3`. SCORE.md in the repository is the format's spec; read() reads
    a song without singing it. The notes are sung where they are written: shift=-12 puts a song
    written for a woman in a man's range.

    shift: semitones, the whole song. vibrato: its peak in semitones, vibrato_hz its speed,
    vibrato_delay the seconds into a vowel it starts. motion: a trained singer's pitch motion in
    place of the vibrato ("straight", "vibrato" or "wide"; the seed picks the singer), motion_scale
    times its size. glide: the frames (10 ms) the pitch takes between notes. dynamics: how far
    loudness and brightness follow the notes. breathiness: the sung vowels' breath noise, times.
    diction: rules for how words' sounds are sung where that is a choice, a line each (a list, or
    a text of lines), read before the song's own %diction lines. With none, the song is sung as
    every song is: each vowel stressed, a held "eye" held open.

        spoken                            vowels as in speech, not a singer's
        ER held>=240 -> AH ~ER            a held "er" sung open, its R late
        word=mild -> M AY AH L D          a word as written, here in two syllables
        for=alto B,D,G -> dip=0           for those tagged alto only

    A rule is [for=WHO] [word=WORD] [SOUND when..] -> WHAT, or [for=WHO] spoken, or sung (back
    from spoken); engine/src/diction.rs has it all.
    tags: names this singer goes by besides the voice's, for a rule's for=.
    """
    v = _voice(voice)
    if motion is not None and motion not in MOTIONS:
        raise ValueError(f"motion {motion!r}: {', '.join(MOTIONS)}")
    lines, who = _diction(diction, tags, v)
    q = _quality(quality)
    data, t = q.engine.sing(q.voice(v), song, shift=shift, seed=seed, vibrato=vibrato, vibrato_hz=vibrato_hz, vibrato_delay=vibrato_delay, glide=glide, dynamics=dynamics,
                         breathiness=breathiness, diction=lines, who=who, motion=-1 if motion is None else q.motion(motion), motion_scale=motion_scale)
    clip = Clip(data, f"sing, {v}, {quality}")
    clip.timing = _timing.clip(t["rate"], t["length"], [_timing.part("", v, 0, t["length"], 0.0, t, level=q.engine.levels(data))], bpm=t["bpm"], beat_zero=t["beat_zero"])
    return clip


def read(song):
    """A song's text read as the engine reads it, without singing it: a dict of bpm, beats (in
    all), lead (the beats before the first word), together, diction ([{line, text}], its rules),
    items (in order, each {line, kind: "rest" or "word", beat, beats} and a word's word, braces
    and notes, a syllable each: [[{note, beats_text, midi, beats}]]) and vibrato ([{line, beat,
    sizes}]). A line is its number in the text from 1. A text that is no song is refused (Error),
    the line's number first. Whether its words have the syllables its notes give them is the
    singer's to say: sing() refuses that."""
    global _plain
    with _lock:
        if _plain is None:
            _plain = Engine()
    return _plain.song(song)


def _frames(chunk):
    """The frames (10 ms each) a chunk of `chunk` seconds is made in."""
    if not (isinstance(chunk, (int, float)) and math.isfinite(chunk) and chunk >= 0.01):
        raise ValueError(f"chunk {chunk!r}: seconds of sound a chunk, 0.01 or more")
    return round(chunk * 100)


def say_stream(text, voice="ada", *, chunk=1.0, quality="hifi", rate=1.0, shift=0.0, seed=0, ssml=False):
    """say(), a chunk at a time: a Stream, an iterator of bytes, each about `chunk` seconds of the
    text said (float32 samples, little-endian, mono, at RATE), made as it is asked for. Joined they
    are say()'s samples. A small chunk gives the first sound sooner.

    Until the stream is read to its end or closed (close(), or `with`), nothing else is said in
    this quality: a say() or another say_stream() then is refused. Songs are sung meanwhile.
    """
    v = _voice(voice)
    q = _quality(quality)
    return q.engine.say_stream(q.voice(v), text, frames=_frames(chunk), ssml=ssml, rate=rate, shift=shift, seed=seed)


def sing_stream(song, voice="ada", *, chunk=1.0, quality="hifi", shift=0.0, seed=0, vibrato=0.25, vibrato_hz=5.5, vibrato_delay=0.25, motion=None, motion_scale=1.0,
                glide=9, dynamics=0.0, breathiness=1.0, diction=None, tags=()):
    """sing(), a chunk at a time: a Stream, an iterator of bytes, each about `chunk` seconds of the
    song sung (float32 samples, little-endian, mono, at RATE), made as it is asked for. Joined they
    are sing()'s samples. The song is read and planned whole before the call returns, so one that
    cannot be sung is refused here; any number of songs are sung at once, their chunks in turn.
    """
    v = _voice(voice)
    if motion is not None and motion not in MOTIONS:
        raise ValueError(f"motion {motion!r}: {', '.join(MOTIONS)}")
    lines, who = _diction(diction, tags, v)
    q = _quality(quality)
    return q.engine.sing_stream(q.voice(v), song, frames=_frames(chunk), shift=shift, seed=seed, vibrato=vibrato, vibrato_hz=vibrato_hz, vibrato_delay=vibrato_delay, glide=glide,
                                dynamics=dynamics, breathiness=breathiness, diction=lines, who=who, motion=-1 if motion is None else q.motion(motion), motion_scale=motion_scale)


# ---------------------------------------------------------------- choirs

_presets = None
_presets_lock = threading.Lock()


def choirs():
    """The names of lipservice.dev's choirs, which choir() sings by name."""
    return list(_choirs())


def _choirs():
    global _presets
    with _presets_lock:
        if _presets is None:
            _presets = json.loads(_models.read("choirs.json"))
    return _presets


_plain = None


def _asked(piece, **over):
    """The engine's ask for a piece (engine/src/piece.rs has it whole): the piece, the voices
    there are, the site's pieces if it names one, and how it is sung where that is said."""
    ask = {"piece": piece, "list": [{"name": v["id"], "sex": v["sex"], "label": v["name"]} for v in _models.manifest()["voices"]]}
    if isinstance(piece.get("choir") if isinstance(piece, dict) else piece, str):
        ask["choirs"] = _choirs()
    ask.update({k: v for k, v in over.items() if v is not None})
    return ask


def loads(text):
    """A piece from its JSON text: a choir as lipservice.dev holds one ({room, pan, style, parts,
    ...}), or {"choir": a choir or a name of choirs(), and any of seed, voices, songs, room, motion
    and how}, as the editor's and the site's files have them. What choir() takes. One the engine
    cannot arrange is refused."""
    global _plain
    piece = json.loads(text)
    with _lock:
        if _plain is None:
            _plain = Engine()
    _plain.choir_want(_asked(piece))
    return piece


def load(path):
    """A piece from a JSON file (loads())."""
    with open(path, encoding="utf-8") as f:
        try:
            return loads(f.read())
        except (ValueError, Error) as e:
            raise type(e)(f"{path}: {e}") from None


def choir(piece, *, quality="hifi", seed=None, voices=None, songs=None, room=None, motion=None, sway=None, vibrato=None, loose=None, glide=None, dynamics=None, breath=None, breathiness=None):
    """A piece for several voices sung as lipservice.dev sings its choirs, in stereo: each singer
    performed as a person sings (a little off the beat and the pitch, breaths taken in the rests),
    seated left to right, and the whole put through a room.

    piece: a name of choirs(), a choir, or what load() gives. A choir is a dict:

        {"room": "card",
         "style": {"glide": 9, "dynamics": 1.0, "breathiness": 0.6},
         "parts": [{"name": "High", "voice": "cora", "song": "%bpm 90\nla C5:2\n"},
                   {"name": "Low", "voice": "ben", "song": "%bpm 90\nla E4:2\n"}]}

    its room (ROOMS), how it is sung (glide, dynamics and breathiness as sing() has them; more in
    HOW; "diction": rules as sing() takes them, a list of lines, for every singer or with for= a
    part's name, its voice or one of its tags), and a part a singer: a name, a voice and a song
    (and "tags", names it goes by, and "diction", rules of its own). Every part is written where a woman
    sings it, and a man's is sung an octave down. Every other argument is None for the piece's
    own: seed (the singers' draws), voices and songs (by part, a voice's name or a song in
    place of the part's; None in the list keeps it), room (ROOMS), motion (MOTIONS, or "none" for
    the machine vibrato), and how it is sung (HOW: sway, vibrato, loose, glide, dynamics, breath,
    breathiness).
    """
    how = {k: v for k, v in (("sway", sway), ("vibrato", vibrato), ("loose", loose), ("glide", glide), ("dynamics", dynamics), ("breath", breath), ("breathiness", breathiness)) if v is not None}
    ask = _asked(piece, seed=seed, voices_by_part=voices, songs=songs, room=room, motion=motion, how=how or None)
    q = _quality(quality)
    want = q.engine.choir_want(ask)
    if "choirs" in ask:
        ask["choirs"] = {want["title"]: ask["choirs"][want["title"]]}
    names = {v["id"]: v["name"] for v in _models.manifest()["voices"]}
    ask["voices"] = {i: q.voice(names[i]) for i in want["voices"]}
    ask["motions"] = {m: q.motion(m) for m in want["motions"]}
    q.breaths()
    data, sung = q.engine.choir(ask)
    parts = []
    for p in sung["parts"]:
        a = p["start"]
        tp = _timing.part(p["name"], names[p["voice"]], a, p["len"], p["pan"], p, [(a + at, a + at + n) for at, n in p["breaths"]], level=p["level"])
        tp.update(text=p["text"], lag=p["lag"], shift=p["shift"])
        parts.append(tp)
    timing = _timing.clip(sung["rate"], sung["length"], parts, bpm=sung["bpm"], beat_zero=sung["beat_zero"])
    return Clip(data, f"choir, {want['title']}, {quality}", channels=2, timing=timing)


def frames(timing, fps):
    """A clip's timing a video frame at a time, for pictures and other rigs: mouth open and round,
    singing, breath, level and pitch by part, and the beat (lipservice._timing.frames)."""
    return _timing.frames(timing, fps)


def load_timing(path):
    """A timing save_timing() wrote."""
    return _timing.load(path)
