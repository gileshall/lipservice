# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""The engine: its C ABI (engine/wasm/src/lib.rs) as a shared library, through ctypes.

The library keeps its state a thread, so an Engine owns one thread and everything it does runs
there; calls from any thread are safe and are served in turn. One Engine holds one quality's models:
the latent voice ("hifi"), or the mel route and the vocoder ("fast").
"""

import concurrent.futures
import ctypes
import os
import queue
import sys
import threading
from ctypes import CFUNCTYPE, c_char_p, c_float, c_int32, c_size_t, c_uint32, c_void_p

RATE = 24000
LIBRARIES = {"darwin": "liblipservice.dylib", "linux": "liblipservice.so", "win32": "lipservice.dll"}

_BYTES = [c_char_p, c_size_t]
# the engine's request to move bytes: a URL and a file path (pointer, length each); 0 or not
GET = CFUNCTYPE(c_int32, c_void_p, c_size_t, c_void_p, c_size_t)
_SIGNATURES = {
    "ls_error": ([], c_void_p),
    "ls_error_len": ([], c_size_t),
    "ls_out": ([], c_void_p),
    "ls_base": (_BYTES, c_int32),
    "ls_voice_parts": (_BYTES + [c_int32] + _BYTES + _BYTES, c_int32),
    "ls_vocoder": (_BYTES, c_int32),
    "ls_vox": (_BYTES, c_int32),
    "ls_melvoc": (_BYTES, c_int32),
    "ls_breaks": (_BYTES, c_int32),
    "ls_motion": (_BYTES, c_int32),
    "ls_phonemizer": (_BYTES + _BYTES, c_int32),
    "ls_say": ([c_int32] + _BYTES + [c_uint32, c_float, c_float, c_uint32], c_int32),
    "ls_step": ([c_size_t], c_int32),
    "ls_sing_open": ([c_int32] + _BYTES + [c_float, c_uint32, c_float, c_float, c_float, c_uint32, c_float, c_float, c_uint32, c_int32, c_float], c_int32),
    "ls_sing_step": ([c_int32, c_size_t], c_int32),
    "ls_sing_close": ([c_int32], c_int32),
    "ls_home_manifest": ([GET], c_int32),
    "ls_home_path": (_BYTES + [GET], c_int32),
    "ls_home_dir": ([GET], c_int32),
    "ls_home_out": ([], c_void_p),
    "ls_home_fail": (_BYTES, None),
}
# frames (10 ms each) a step: a second of sound
_STEP = 100

_lib = None
_lib_lock = threading.Lock()


class Error(Exception):
    """The engine's own refusal, in its words."""


def _library():
    global _lib
    with _lib_lock:
        if _lib is None:
            if sys.platform not in LIBRARIES:
                raise OSError(f"lipservice has no engine for {sys.platform}: {', '.join(LIBRARIES)}")
            lib = ctypes.CDLL(os.path.join(os.path.dirname(os.path.abspath(__file__)), "_native", LIBRARIES[sys.platform]))
            for name, (args, res) in _SIGNATURES.items():
                f = getattr(lib, name)
                f.argtypes, f.restype = args, res
            _lib = lib
    return _lib


def _seed(seed):
    if not (isinstance(seed, int) and 0 <= seed < 2**32):
        raise ValueError(f"seed {seed!r}: a whole number from 0 to {2**32 - 1}")
    return seed


class Engine:
    def __init__(self):
        self._x = _library()
        self._jobs = queue.SimpleQueue()
        threading.Thread(target=self._work, name="lipservice", daemon=True).start()

    def _work(self):
        while True:
            job, done = self._jobs.get()
            try:
                done.set_result(job())
            except BaseException as e:  # handed to the caller, who raises it
                done.set_exception(e)

    def _do(self, job):
        done = concurrent.futures.Future()
        self._jobs.put((job, done))
        return done.result()

    # the rest runs on the engine's thread

    def _check(self, r):
        if r < 0:
            raise Error(ctypes.string_at(self._x.ls_error(), self._x.ls_error_len()).decode())
        return r

    def _out(self, n):
        return ctypes.string_at(self._x.ls_out(), 4 * n)

    def load(self, kind, data, *more):
        """A model file's bytes into the engine: kind is base, vox, vocoder, melvoc, breaks or
        motion. The index of a base or motion."""
        f = getattr(self._x, f"ls_{kind}")
        return self._do(lambda: self._check(f(data, len(data), *more)))

    def voice(self, data, base, *, vox=b"", mel=b""):
        """A voice into the engine, on its base: the file both qualities read, with the part the
        latent voice reads (vox) or the part the mel route reads (mel). Its index."""
        return self._do(lambda: self._check(self._x.ls_voice_parts(data, len(data), base, vox or None, len(vox), mel or None, len(mel))))

    def phonemizer(self, g2p, lexicon):
        self._do(lambda: self._check(self._x.ls_phonemizer(g2p, len(g2p), lexicon, len(lexicon))))

    def say(self, voice, text, *, ssml, rate, shift, seed):
        """Text said: float32 samples, little-endian."""
        b, seed = text.encode(), _seed(seed)

        def job():
            self._check(self._x.ls_say(voice, b, len(b), 1 if ssml else 0, rate, shift, seed))
            out = bytearray()
            while n := self._check(self._x.ls_step(_STEP)):
                out += self._out(n)
            return bytes(out)

        return self._do(job)

    def sing(self, voice, song, *, shift, seed, vibrato, vibrato_hz, vibrato_delay, glide, dynamics, breathiness, diction, motion, motion_scale):
        """A song sung (engine/src/sing.rs gives the format): float32 samples, little-endian."""
        b, seed = song.encode(), _seed(seed)
        if not (isinstance(glide, int) and 1 <= glide < 2**32):
            raise ValueError(f"glide {glide!r}: a whole number of frames, at least 1")

        def job():
            h = self._check(self._x.ls_sing_open(voice, b, len(b), shift, seed, vibrato, vibrato_hz, vibrato_delay, glide, dynamics, breathiness, 1 if diction else 0, motion, motion_scale))
            try:
                out = bytearray()
                while n := self._check(self._x.ls_sing_step(h, _STEP)):
                    out += self._out(n)
                return bytes(out)
            finally:
                self._check(self._x.ls_sing_close(h))

        return self._do(job)
