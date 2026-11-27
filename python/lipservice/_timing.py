# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""What a clip's voices did when, for pictures and other rigs: timing as plain data, the same for
say(), sing() and choir(), and frames(), which reads it a video frame at a time.

A timing is a dict, JSON as it stands:

    format     1
    rate       samples a second (24000)
    length     samples in the clip
    frame      samples a pitch or level entry covers (240: 10 ms)
    bpm        the song's tempo, or None for speech
    beat_zero  the sample written beat 0 falls on, or None for speech
    parts      a voice each (a choir's singers; say() and sing() have one):
      name, voice  the part's name (a choir's) and its voice
      start, length  the samples of the clip it covers
      pan          its seat, -1 left to 1 right (0 alone)
      phones       [[start, end, symbol]]: ARPAbet, a vowel's stress digit on it
      words        [[start, end, text]]
      notes        [[start, end, midi, word]]: a sung note's vowel, its pitch as sung
      breaths      [[start, end]]: each breath taken in
      pitch        Hz an entry from the part's start, 0 where unvoiced
      level        loudness an entry from the part's start (rms), None where none came
      text, lag, shift  a choir's part: its song as sung, the s it starts late by, its shift

Every start and end is a sample of the clip, end not in.
"""

import json
import math

FORMAT = 1
FRAME = 240

# The mouth a phone opens to and how far the lips round on it, 0 to 1: vowels by height (open AA
# to close IY and UW), lips shut on B, M and P, teeth on lip for F and V. A diphthong takes its first
# vowel's opening; AW and OY round as they close.
MOUTH = {
    "AA": (0.9, 0.0), "AE": (0.8, 0.0), "AH": (0.65, 0.0), "AO": (0.8, 0.6), "AW": (0.85, 0.5), "AY": (0.8, 0.0),
    "EH": (0.6, 0.0), "ER": (0.35, 0.3), "EY": (0.55, 0.0), "IH": (0.4, 0.0), "IY": (0.3, 0.0), "OW": (0.6, 0.8),
    "OY": (0.7, 0.6), "UH": (0.4, 0.6), "UW": (0.3, 1.0),
    "B": (0.0, 0.0), "M": (0.0, 0.0), "P": (0.0, 0.0), "F": (0.15, 0.0), "V": (0.15, 0.0), "TH": (0.25, 0.0), "DH": (0.25, 0.0),
    "W": (0.2, 0.9), "R": (0.3, 0.3), "SH": (0.3, 0.5), "ZH": (0.3, 0.5), "CH": (0.3, 0.5), "JH": (0.3, 0.5),
}
# any other consonant
CONSONANT = (0.3, 0.0)


def mouth(symbol):
    """A phone's (open, round)."""
    return MOUTH.get(symbol.rstrip("012"), CONSONANT)


def part(name, voice, start, length, pan, t, breaths=(), level=None):
    """A part's timing from the engine's (phones, words, notes, pitch), its spans already samples
    of the clip."""
    return {
        "name": name, "voice": voice, "start": start, "length": length, "pan": pan,
        "phones": t["phones"], "words": t["words"], "notes": t["notes"], "breaths": [list(b) for b in breaths],
        "pitch": t["pitch"], "level": level if level is not None else [],
    }


def clip(rate, length, parts, bpm=None, beat_zero=None):
    return {"format": FORMAT, "rate": rate, "length": length, "frame": FRAME, "bpm": bpm, "beat_zero": beat_zero, "parts": parts}


def save(timing, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(timing, f)
    return path


def load(path):
    with open(path, encoding="utf-8") as f:
        t = json.load(f)
    if t.get("format") != FORMAT:
        raise ValueError(f"{path}: timing format {t.get('format')!r}, this package reads {FORMAT}")
    return t


def _over(spans, a, b, value):
    """The mean of value(span) over samples [a, b), 0 where no span is."""
    total = 0.0
    for s in spans:
        lo, hi = max(a, s[0]), min(b, s[1])
        if hi > lo:
            total += (hi - lo) * value(s)
    return total / (b - a)


def _series(xs, start, a, b, voiced=False):
    """The mean of a FRAME-a-entry series over samples [a, b) of the clip (its first entry at
    `start`), None entries and, with voiced, 0s left out; 0 where none is."""
    lo, hi = max(0, (a - start) // FRAME), min(len(xs), -(-(b - start) // FRAME))
    got = [x for x in xs[lo:hi] if x is not None and (x > 0 or not voiced)]
    return sum(got) / len(got) if got else 0.0


def _air(breaths, last, m):
    """How full the lungs are at sample m: breaths [[start, end]] in order, `last` the part's end."""
    for k, (s, e) in enumerate(breaths):
        if m < s:
            break
        if m < e:
            return (m - s) / (e - s)
        nxt = breaths[k + 1][0] if k + 1 < len(breaths) else last
        if m < nxt:
            return 1 - (m - e) / (nxt - e)
    return 0.0


def frames(timing, fps):
    """The timing a video frame at a time, frame k covering seconds [k, k + 1) / fps: for the clip,
    beat (the written beat at the frame's middle, its fraction the phase; None for speech), and for
    each part, as lists a frame each:
        mouth_open, mouth_round  0 to 1, the mean over the frame of its phones' (MOUTH)
        singing    the share of the frame a phone of it sounds in
        breath     0 to 1 through each breath taken in, at the frame's middle; 0 between
        air        how full the lungs are, 0 to 1 at the frame's middle: rising with each breath in, and
                   from its end falling to 0 at the next breath's start (or the part's end); 0
                   before the first breath
        level      its loudness over the frame (rms)
        pitch      Hz over the frame's voiced part, 0 where unvoiced
    """
    if not (fps > 0 and math.isfinite(fps)):
        raise ValueError(f"fps {fps!r}: more than 0")
    rate, length = timing["rate"], timing["length"]
    n = math.ceil(length / rate * fps)
    edges = [round(k * rate / fps) for k in range(n + 1)]
    mids = [(edges[k] + edges[k + 1]) / 2 for k in range(n)]
    out = {"fps": fps, "frames": n, "beat": None, "parts": []}
    if timing.get("bpm"):
        per = rate * 60 / timing["bpm"]
        out["beat"] = [(m - timing["beat_zero"]) / per for m in mids]
    for p in timing["parts"]:
        mo, ro, si, br, ai, le, pi = [], [], [], [], [], [], []
        bs = sorted(p["breaths"])
        for k in range(n):
            a, b = edges[k], max(edges[k + 1], edges[k] + 1)
            mo.append(_over(p["phones"], a, b, lambda s: mouth(s[2])[0]))
            ro.append(_over(p["phones"], a, b, lambda s: mouth(s[2])[1]))
            si.append(_over(p["phones"], a, b, lambda s: 1.0))
            m = mids[k]
            br.append(next(((m - s) / (e - s) for s, e in bs if s <= m < e), 0.0))
            ai.append(_air(bs, p["start"] + p["length"], m))
            le.append(_series(p["level"], p["start"], a, b))
            pi.append(_series(p["pitch"], p["start"], a, b, voiced=True))
        out["parts"].append({"name": p["name"], "voice": p["voice"], "mouth_open": mo, "mouth_round": ro, "singing": si, "breath": br, "air": ai, "level": le, "pitch": pi})
    return out
