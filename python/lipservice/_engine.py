# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""The engine: its C ABI (engine/wasm/src/lib.rs) as a shared library, through ctypes.

The library keeps its state a thread, so an Engine owns one thread and everything it does runs
there; calls from any thread are safe and are served in turn. One Engine holds one quality's models:
the latent voice ("hifi"), or the mel route and the vocoder ("fast").
"""

import array
import concurrent.futures
import ctypes
import json
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
    "ls_sing_open": ([c_int32] + _BYTES + [c_float, c_uint32, c_float, c_float, c_float, c_uint32, c_float, c_float] + _BYTES + [c_int32, c_float], c_int32),
    "ls_sing_step": ([c_int32, c_size_t], c_int32),
    "ls_sing_close": ([c_int32], c_int32),
    "ls_alone": ([c_uint32], c_int32),
    "ls_alone_push": ([c_int32] + _BYTES, c_int32),
    "ls_alone_end": ([c_int32], c_int32),
    "ls_alone_close": ([c_int32], c_int32),
    "ls_info": ([], c_void_p),
    "ls_breaths": (_BYTES + _BYTES, c_int32),
    "ls_choir": (_BYTES, c_int32),
    "ls_choir_want": (_BYTES, c_int32),
    "ls_song": (_BYTES, c_int32),
    "ls_levels": (_BYTES, c_int32),
    "ls_choir_info": ([], c_int32),
    "ls_rooms": ([], c_int32),
    "ls_say_timing": ([], c_int32),
    "ls_sing_timing": ([c_int32], c_int32),
    "ls_home_manifest": ([GET], c_int32),
    "ls_home_update": ([GET], c_int32),
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


def rooms():
    """The rooms a choir may be sung in, as the engine has them."""
    lib = _library()
    n = lib.ls_rooms()
    if n < 0:
        raise Error(ctypes.string_at(lib.ls_error(), lib.ls_error_len()).decode())
    return tuple(json.loads(ctypes.string_at(lib.ls_info(), n)))


def _seed(seed):
    if not (isinstance(seed, int) and 0 <= seed < 2**32):
        raise ValueError(f"seed {seed!r}: a whole number from 0 to {2**32 - 1}")
    return seed


class Stream:
    """Sound a chunk at a time, made as it is asked for: an iterator of bytes, each the next
    stretch of float32 samples (little-endian, mono, at RATE). Joined, the chunks are the clip the
    whole call gives. Other calls of the same quality are served between its chunks. close() ends
    it before its end; it closes itself as a context manager, and when it is let go."""

    def __init__(self, engine, step, close):
        self._engine, self._step, self._close = engine, step, close

    def __iter__(self):
        return self

    def __next__(self):
        # a step may give nothing yet (what one voice alone holds back): the next has it
        while self._step is not None:
            chunk = self._engine._do(self._step)
            if chunk is None:
                self.close()
            elif chunk:
                return chunk
        raise StopIteration

    def close(self):
        if self._step is not None:
            self._step = None
            self._engine._do(self._close)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def __del__(self):
        self.close()


class Engine:
    def __init__(self):
        self._x = _library()
        # a text being said a chunk at a time: the engine says one thing at a time (ls_say has no
        # handle), so nothing else is said until that one is done or closed
        self._saying = False
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

    def _info(self, n):
        return json.loads(ctypes.string_at(self._x.ls_info(), self._check(n)))

    def _out(self, n):
        return ctypes.string_at(self._x.ls_out(), 4 * n)

    def _alone(self, sung, chunks):
        """The chunks as one voice heard alone goes out (engine/src/alone.rs): a song let down to
        speech's level, then held under the ceiling."""
        h = self._check(self._x.ls_alone(1 if sung else 0))
        try:
            out = bytearray()
            for c in chunks:
                out += self._out(self._check(self._x.ls_alone_push(h, c, len(c))))
            out += self._out(self._check(self._x.ls_alone_end(h)))
            return bytes(out)
        finally:
            self._check(self._x.ls_alone_close(h))

    def load(self, kind, data, *more):
        """A model file's bytes into the engine: kind is base, vox, vocoder, melvoc, breaks or
        motion. The index of a base or motion."""
        f = getattr(self._x, f"ls_{kind}")
        return self._do(lambda: self._check(f(data, len(data), *more)))

    def voice(self, data, base, *, vox=b"", mel=b""):
        """A voice into the engine, on its base: the file both qualities read, with the part the
        latent voice reads (vox) or the part the mel route reads (mel). Its index."""
        return self._do(lambda: self._check(self._x.ls_voice_parts(data, len(data), base, vox or None, len(vox), mel or None, len(mel))))

    def breaths(self, index, sound):
        """The breaths a choir's singers take: the index's bytes (breaths.json) and the sound's
        (breaths.bin). How many clips."""
        return self._do(lambda: self._check(self._x.ls_breaths(index, len(index), sound, len(sound))))

    def levels(self, data):
        """A clip's loudness a frame (ls_levels): rms, from its float32 samples' bytes."""
        return self._do(lambda: self._info(self._x.ls_levels(data, len(data) // 4)))

    def song(self, text):
        """A song's text read (engine/src/song.rs): the song as data. No model is needed."""
        b = text.encode()
        return self._do(lambda: self._info(self._x.ls_song(b, len(b))))

    def choir_want(self, ask):
        """What a choir's ask (engine/src/piece.rs) needs loaded: its title, its voices by their
        names in the models, and its motions. Refuses a piece that cannot be sung as written."""
        b = json.dumps(ask).encode()
        return self._do(lambda: self._info(self._x.ls_choir_want(b, len(b))))

    def choir(self, ask):
        """A choir sung whole (ls_choir takes `ask`, a dict): float32 samples, little-endian,
        left and right in turn; and how each part was sung."""
        b = json.dumps(ask).encode()

        def job():
            n = self._check(self._x.ls_choir(b, len(b)))
            sung = self._info(self._x.ls_choir_info())
            both = array.array("f")
            both.frombytes(self._out(2 * n))
            out = array.array("f")
            out.frombytes(bytes(8 * n))
            out[0::2], out[1::2] = both[:n], both[n:]
            return out.tobytes(), sung

        return self._do(job)

    def phonemizer(self, g2p, lexicon):
        self._do(lambda: self._check(self._x.ls_phonemizer(g2p, len(g2p), lexicon, len(lexicon))))

    def _streamed(self, alone, step, done):
        """A Stream of what `step` gives (a count of samples at ls_out, 0 at the end) as one voice
        alone goes out through `alone` (ls_alone's handle); `done` runs at its end, however it
        ends. On the engine's thread."""
        ended = [False]

        def one():
            if ended[0]:
                return None
            n = self._check(step())
            if n:
                c = self._out(n)
                return self._out(self._check(self._x.ls_alone_push(alone, c, len(c))))
            ended[0] = True
            return self._out(self._check(self._x.ls_alone_end(alone)))

        def close():
            try:
                self._check(self._x.ls_alone_close(alone))
            finally:
                done()

        return Stream(self, one, close)

    def _unsaid(self):
        if self._saying:
            raise Error("a text is being said a chunk at a time by this quality's engine, which says one thing at a time: read that stream to its end or close it first")

    def say(self, voice, text, *, ssml, rate, shift, seed):
        """Text said, as one voice alone goes out: float32 samples, little-endian, and what was
        said when (ls_say_timing)."""
        b, seed = text.encode(), _seed(seed)

        def job():
            self._unsaid()
            self._check(self._x.ls_say(voice, b, len(b), 1 if ssml else 0, rate, shift, seed))

            def chunks():
                while n := self._check(self._x.ls_step(_STEP)):
                    yield self._out(n)

            data = self._alone(False, chunks())
            return data, self._info(self._x.ls_say_timing())

        return self._do(job)

    def say_stream(self, voice, text, *, frames, ssml, rate, shift, seed):
        """say, a chunk at a time: a Stream of the text said, `frames` frames (10 ms each) made at
        each step. Until it is read to its end or closed nothing else is said by this engine."""
        b, seed = text.encode(), _seed(seed)

        def start():
            self._unsaid()
            self._check(self._x.ls_say(voice, b, len(b), 1 if ssml else 0, rate, shift, seed))
            alone = self._check(self._x.ls_alone(0))
            self._saying = True

            def done():
                self._saying = False

            return self._streamed(alone, lambda: self._x.ls_step(frames), done)

        return self._do(start)

    def sing_stream(self, voice, song, *, frames, shift, seed, vibrato, vibrato_hz, vibrato_delay, glide, dynamics, breathiness, diction, who, motion, motion_scale):
        """sing, a chunk at a time: a Stream of the song sung, `frames` frames (10 ms each) made
        at each step. The song is read and planned here, whole; its sound is made as it is asked for."""
        b, seed = song.encode(), _seed(seed)
        d = json.dumps({"who": who, "diction": diction}).encode()
        if not (isinstance(glide, int) and 1 <= glide < 2**32):
            raise ValueError(f"glide {glide!r}: a whole number of frames, at least 1")

        def start():
            h = self._check(self._x.ls_sing_open(voice, b, len(b), shift, seed, vibrato, vibrato_hz, vibrato_delay, glide, dynamics, breathiness, d, len(d), motion, motion_scale))
            try:
                alone = self._check(self._x.ls_alone(1))
            except BaseException:
                self._check(self._x.ls_sing_close(h))
                raise
            return self._streamed(alone, lambda: self._x.ls_sing_step(h, frames), lambda: self._check(self._x.ls_sing_close(h)))

        return self._do(start)

    def sing(self, voice, song, *, shift, seed, vibrato, vibrato_hz, vibrato_delay, glide, dynamics, breathiness, diction, who, motion, motion_scale):
        """A song sung alone (engine/src/sing.rs gives the format), as one voice alone goes out:
        float32 samples, little-endian, and what was sung when (ls_sing_timing)."""
        b, seed = song.encode(), _seed(seed)
        d = json.dumps({"who": who, "diction": diction}).encode()
        if not (isinstance(glide, int) and 1 <= glide < 2**32):
            raise ValueError(f"glide {glide!r}: a whole number of frames, at least 1")

        def job():
            h = self._check(self._x.ls_sing_open(voice, b, len(b), shift, seed, vibrato, vibrato_hz, vibrato_delay, glide, dynamics, breathiness, d, len(d), motion, motion_scale))
            try:

                def chunks():
                    while n := self._check(self._x.ls_sing_step(h, _STEP)):
                        yield self._out(n)

                data = self._alone(True, chunks())
                return data, self._info(self._x.ls_sing_timing(h))
            finally:
                self._check(self._x.ls_sing_close(h))

        return self._do(job)
