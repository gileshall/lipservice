# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""say_stream and sing_stream against say and sing: the chunks joined are the clip, for each size
of chunk and both qualities; songs are sung between a stream's chunks; one text is said at a time;
what cannot be sung is refused at the call.

    python python/tests/streams.py

Run it with the Python the wheel is installed in, as check.py is, with LIPSERVICE_MODELS naming a
bundle or the models already kept.
"""

import time

import lipservice as lip

SONG = "%bpm 100\ntwinkle C4:1 C4:1\ntwinkle G4:1 G4:1\nlittle A4:1 A4:1\nstar G4:2\n"
TEXT = "The first paragraph is short.\n\nThe second one follows it, after a pause. Is that right?"

for q in lip.QUALITIES:
    t = time.time()
    sung = lip.sing(SONG, "cora", quality=q, seed=4, dynamics=1.0)._data
    said = lip.say(TEXT, "ben", quality=q, seed=7)._data
    print(f"{q}: sing {len(sung) // 4 / lip.RATE:.2f} s, say {len(said) // 4 / lip.RATE:.2f} s, whole, in {time.time() - t:.2f} s")
    for chunk in (1.0, 0.25, 0.01, 3.7):
        t = time.time()
        s = lip.sing_stream(SONG, "cora", chunk=chunk, quality=q, seed=4, dynamics=1.0)
        first = next(s)
        at = time.time() - t
        parts = [first, *s]
        assert b"".join(parts) == sung, f"{q}, sing, chunks of {chunk} s: not the clip"
        t = time.time()
        with lip.say_stream(TEXT, "ben", chunk=chunk, quality=q, seed=7) as s:
            first = next(s)
            said_at = time.time() - t
            spoken = [first, *s]
        assert b"".join(spoken) == said, f"{q}, say, chunks of {chunk} s: not the clip"
        print(f"{q}, chunks of {chunk} s: sing {len(parts)} chunks, the first ({len(parts[0]) // 4} samples) after {at:.3f} s; say {len(spoken)} chunks, the first ({len(spoken[0]) // 4} samples) after {said_at:.3f} s")
    # two songs at once, a clip sung whole between their chunks, and a text said between them too
    a, b = lip.sing_stream(SONG, "cora", chunk=0.5, quality=q, seed=4, dynamics=1.0), lip.sing_stream(SONG, "ben", chunk=0.3, quality=q, shift=-12)
    got_a, got_b = [next(a)], [next(b)]
    assert lip.sing(SONG, "cora", quality=q, seed=4, dynamics=1.0)._data == sung
    assert lip.say(TEXT, "ben", quality=q, seed=7)._data == said
    got_a += list(a)
    got_b += list(b)
    assert b"".join(got_a) == sung and b"".join(got_b) == lip.sing(SONG, "ben", quality=q, shift=-12)._data, f"{q}: two songs at once are not the two clips"
    # one thing said at a time: a second is refused until the first is done or closed, songs go on
    s = lip.say_stream(TEXT, "ben", chunk=0.2, quality=q, seed=7)
    head = next(s)
    for again in (lambda: lip.say("No.", quality=q), lambda: lip.say_stream("No.", quality=q)):
        try:
            again()
        except lip.Error as e:
            assert "one thing at a time" in str(e), e
        else:
            raise AssertionError(f"{q}: said while a text was being said a chunk at a time")
    assert lip.sing(SONG, "cora", quality=q, seed=4, dynamics=1.0)._data == sung
    assert head + b"".join(s) == said, f"{q}: the stream after a refusal is not the clip"
    # closed early, the next is said; and a closed stream gives no more
    s = lip.say_stream(TEXT, "ben", chunk=0.2, quality=q, seed=7)
    next(s)
    s.close()
    assert list(s) == [] and lip.say(TEXT, "ben", quality=q, seed=7)._data == said
    s = lip.sing_stream(SONG, "cora", chunk=0.2, quality=q)
    next(s)
    del s
    # what cannot be sung or asked is refused at the call
    for bad, kind in ((lambda: lip.sing_stream("%bpm 100\ntwinkle\n", quality=q), lip.Error), (lambda: lip.sing_stream(SONG, chunk=0, quality=q), ValueError), (lambda: lip.say_stream("Hi.", "nobody", quality=q), ValueError)):
        try:
            bad()
        except kind:
            pass
        else:
            raise AssertionError(f"{q}: not refused")
print("streams: ok")
