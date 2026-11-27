// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The choir's room and mastering, as the sing-demos pieces are mixed:
// the engine's (engine/src/room.rs, ls_room), which this side drives. The
// seats' direct sound and early reflections come from the mixer (choir.js) as a dry bus and a send
// bus; the room adds a ping-pong echo at half a beat, a hall on the send and the echo, then the
// mastering: a second hall on the 200 Hz to 5 kHz band, a 30 Hz high-pass, a compressor and a
// look-ahead limiter to -1.5 dBFS. Every setting is fixed; nothing is measured. The level is made
// where the parts enter the mix (choirs.js arrange): no gain is added here, and the compressor and
// limiter are nets that a piece at its level does not touch. The page and node both use it, through
// one engine (setEngine) with no models in it.

export const SR = 24000;
export const BLOCK = 2048; // samples a convolution block
export const TAIL = 4; // seconds the room rings after the last sample of the mix

// Where a piece's loud passages sit in the mix, dBFS: the level its sound has over 400 ms, at the
// point 95% of its sounding time is under. A choir's highest samples run 12 to 17 dB over that, so
// at this level they stay under the ceiling and the limiter rests (thirteen pieces: it acted once,
// by 0.2 dB); 2 dB higher it acts up to 4 times a minute. It is also about where speech comes out.
export const LOUD = -18;
// The compressor starts 2 dB over the loud passages: it takes a swell no one planned, under 2.5 dB,
// for under a fiftieth of a piece's sounding time.
export const COMP = { thresh: LOUD + 4, ratio: 2, knee: 4, attack: 0.030, release: 0.400 };
// The full choir for a piece whose loud passages have not been measured (choirs_levels.js): all its
// singers at once at their fullest, the root of the sum of their gains' squares. Singers sing at
// about -11.5 dBFS and a seat's two sides share its power, so at this the loud passages come to LOUD
// within 4 dB (thirteen measured pieces).
export const FULL_CHOIR = 0.57;

// A seeded generator: xmur3 of a string into mulberry32. uniform() in [0, 1), normal() by Box-Muller.
export function rng(key) {
  let h = 1779033703 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  let a = (h ^= h >>> 16) >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    uniform,
    between: (lo, hi) => lo + (hi - lo) * uniform(),
    int: (lo, hi) => lo + Math.floor(uniform() * (hi - lo + 1)), // lo..hi, both in
    choice: (xs) => xs[Math.floor(uniform() * xs.length)],
    normal: () => {
      const u = 1 - uniform(), v = uniform();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

// ---------------------------------------------------------------- the spectrogram's FFT

// An in-place radix-2 complex FFT of n points, unscaled.
export class FFT {
  constructor(n) {
    if (n & (n - 1)) throw new Error(`fft: ${n} is not a power of 2`);
    this.n = n;
    this.rev = new Uint32Array(n);
    for (let i = 0, bits = Math.log2(n); i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = Float64Array.from({ length: n / 2 }, (_, i) => Math.cos(2 * Math.PI * i / n));
    this.sin = Float64Array.from({ length: n / 2 }, (_, i) => Math.sin(2 * Math.PI * i / n));
  }
  run(re, im, inverse) {
    const n = this.n, rev = this.rev, c = this.cos, s = this.sin, sg = inverse ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = c[k], wi = sg * s[k], a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- the room

// A room's trace: for each TRACE samples (10 ms) of its output, the mean power there of each stage
// (dry: the seats; echo, hall: their returns; master: their mix; mhall: the mastering hall's return;
// out: what is given), and the most gain
// reduction, in dB, the compressor (comp) and the limiter (lim) gave a sample there. The last RING
// frames are kept. A trace that rooms picked up at different places write (a take's) has `given`
// set: whether frame f is there.
export const TRACE = 240;
export const STAGES = ["dry", "echo", "hall", "master", "mhall", "out"];
const STAGES_ALL = [...STAGES, "comp", "lim"]; // the engine's order (room.rs STAGES)
const RING = 1 << 15;
export class Trace {
  constructor() {
    this.v = Object.fromEntries(STAGES_ALL.map((k) => [k, new Float32Array(RING)]));
    this.frames = 0; // frames whose output has all been given
    this.given = null;
  }
  // stage k at frame f, NaN if f is not given yet or no longer kept
  at(k, f) {
    if (this.given) return f >= 0 && f < RING && this.given(f) ? this.v[k][f] : NaN;
    if (!(f >= 0 && f < this.frames && f > this.frames - RING + 64)) return NaN;
    return this.v[k][f % RING];
  }
  // a copy, for a take made again from this one
  copy() {
    const t = new Trace();
    for (const k in this.v) t.v[k].set(this.v[k]);
    t.frames = this.frames;
    return t;
  }
}

// The engine the room and the mixer run in on this thread: lipservice.js's Engine, with no models.
let mixing = null;
export function setEngine(engine) {
  mixing = engine;
}
export function engine() {
  if (!mixing) throw new Error("room.js: no engine to mix in: setEngine(await Engine.create(wasm)) first");
  return mixing;
}

// push(dry, send) with [left, right] of any length; returns the finished output there is, as
// [left, right] (Float32Array) or null; end() returns the rest and TAIL s of the room's ring;
// close() lets the engine's room go. With `trace` (true, or a Trace to write), .trace is the room's
// Trace. .wet scales the echo and both halls (1: as set). A room picked up in the middle of a piece:
// `at` is the sample of the piece its first is (a whole number of TRACE), and it traces from `from`
// on, what comes before being its run-up. `room`: a name of the engine's rooms (ls_rooms).
export const TRACE_MAX = RING * TRACE; // samples a trace with `given` holds
export class Room {
  constructor({ room, bpm, seed = 1, trace = false, at = 0, from = at }) {
    const e = (this.e = engine());
    this.trace = trace === true ? new Trace() : trace || null;
    this.h = e.check(e.with(new TextEncoder().encode(room), (p, n) => e.x.ls_room(p, n, bpm, seed, this.trace ? 1 : 0, at, from)));
    this.delay = e.check(e.x.ls_room_delay(this.h));
    this.in = 0; // samples of mix in
    this.copied = from / TRACE; // frames of the trace brought over
    this.w = 1;
  }

  get wet() {
    return this.w;
  }
  set wet(w) {
    this.e.check(this.e.x.ls_room_wet(this.h, w));
    this.w = w;
  }

  push([dl, dr], [sl, sr]) {
    if (dl.length !== dr.length || sl.length !== dl.length || sr.length !== dl.length) throw new Error("room: the buses differ in length");
    const n = dl.length, flat = new Float32Array(4 * n);
    flat.set(dl, 0); flat.set(dr, n); flat.set(sl, 2 * n); flat.set(sr, 3 * n);
    const e = this.e, m = e.check(e.with(new Uint8Array(flat.buffer), (p, k) => e.x.ls_room_push(this.h, p, k)));
    this.in += n;
    return this.given(m);
  }

  // the rest of the mix, then the ring, to TAIL s past the mix's end
  end() {
    return this.given(this.e.check(this.e.x.ls_room_end(this.h)));
  }

  close() {
    if (this.h === null) throw new Error("room: closed twice");
    this.e.check(this.e.x.ls_room_close(this.h));
    this.h = null;
  }

  // the m samples a side the engine gave, and the frames of its trace now finished
  given(m) {
    const e = this.e, y = m ? [e.samples(m), new Float32Array(e.x.memory.buffer, e.x.ls_out() + 4 * m, m).slice()] : null;
    const T = this.trace;
    if (T) {
      const frames = e.check(e.x.ls_room_frames(this.h)), k = e.check(e.x.ls_room_trace(this.h, this.copied)), a = frames - k;
      const z = new Float32Array(e.x.memory.buffer, e.x.ls_out(), STAGES_ALL.length * k);
      STAGES_ALL.forEach((name, c) => {
        const v = T.v[name];
        for (let i = 0; i < k; i++) v[(a + i) % RING] = z[c * k + i];
      });
      this.copied = frames;
      T.frames = frames;
    }
    return y;
  }
}
