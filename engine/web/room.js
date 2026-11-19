// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The choir's room and mastering, as the sing-demos pieces are mixed,
// streamed: the seats' direct sound and early reflections come from the
// mixer (choir.js) as a dry bus and a send bus; here a ping-pong echo at half a beat, a hall on the
// send and the echo, then the mastering: a second hall on the 200 Hz to 5 kHz band, a 30 Hz
// high-pass, a compressor and a look-ahead limiter to -1.5 dBFS. Every setting is fixed; nothing is
// measured. The level is made where the parts enter the mix (choirs.js arrange): no gain is added
// here, and the compressor and limiter are nets that a piece at its level does not touch. No DOM:
// the page and node both use it.

export const SR = 24000;
export const BLOCK = 2048; // samples a convolution block
export const TAIL = 4; // seconds the room rings after the last sample of the mix

// the room amounts (barbershop-human ROOMS): the mix's echo and hall, and the mastering hall
export const ROOMS = {
  card: { echo: 0.10, wet: 0.20, rt: 1.5, rtHi: 0.8, mwet: 0.12, mrt: 2.0, mrtHi: 1.0 },
  drier: { echo: 0.05, wet: 0.10, rt: 1.2, rtHi: 0.7, mwet: 0.06, mrt: 1.5, mrtHi: 0.8 },
  driest: { echo: 0.02, wet: 0.05, rt: 1.0, rtHi: 0.6, mwet: 0.03, mrt: 1.2, mrtHi: 0.7 },
  bare: { echo: 0, wet: 0, rt: 0.25, rtHi: 0.25, mwet: 0, mrt: 0.25, mrtHi: 0.25 },
};

// Where a piece's loud passages sit in the mix, dBFS: the level its sound has over 400 ms, at the
// point 95% of its sounding time is under. A choir's highest samples run 12 to 17 dB over that, so
// at this level they stay under the ceiling and the limiter rests (thirteen pieces: it acted once,
// by 0.2 dB); 2 dB higher it acts up to 4 times a minute. It is also about where speech comes out.
export const LOUD = -18;
// The compressor starts 2 dB over the loud passages: it takes a swell no one planned, under 2.5 dB,
// for under a fiftieth of a piece's sounding time.
export const COMP = { thresh: LOUD + 4, ratio: 2, knee: 4, attack: 0.030, release: 0.400 };
const CEILING = 10 ** (-1.5 / 20);
// The full choir for a piece whose loud passages have not been measured (choirs_levels.js): all its
// singers at once at their fullest, the root of the sum of their gains' squares. Singers sing at
// about -11.5 dBFS and a seat's two sides share its power, so at this the loud passages come to LOUD
// within 4 dB (thirteen measured pieces).
export const FULL_CHOIR = 0.57;
const LIMIT_WINDOW = 0.012; // seconds

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

// ---------------------------------------------------------------- filters

// Butterworth sections by the bilinear transform with the cutoff prewarped, as scipy.signal.butter:
// [b0, b1, b2, a1, a2] (a0 = 1).
export function butter(order, fc, type, sr = SR) {
  const k = Math.tan(Math.PI * fc / sr);
  if (order === 1) {
    if (type !== "low") throw new Error(`butter: no first-order ${type}`);
    return [k / (1 + k), k / (1 + k), 0, (k - 1) / (k + 1), 0];
  }
  if (order !== 2) throw new Error(`butter: no order ${order}`);
  const n = 1 / (1 + Math.SQRT2 * k + k * k);
  const a1 = 2 * (k * k - 1) * n, a2 = (1 - Math.SQRT2 * k + k * k) * n;
  if (type === "low") return [k * k * n, 2 * k * k * n, k * k * n, a1, a2];
  if (type === "high") return [n, -2 * n, n, a1, a2];
  throw new Error(`butter: no type ${type}`);
}

// one section over a stream, as scipy.signal.lfilter from rest
export class Biquad {
  constructor([b0, b1, b2, a1, a2]) {
    Object.assign(this, { b0, b1, b2, a1, a2, x1: 0, x2: 0, y1: 0, y2: 0 });
  }
  step(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// ---------------------------------------------------------------- halls

// A stereo impulse response: a channel's own noise
// low-passed at 2.5 kHz decaying by 60 dB in rt s, plus half of it high-passed there decaying in rtHi
// s, behind predelay s of silence, at unit energy.
export function hall(seconds, rt, rtHi, predelay, seed) {
  const n = Math.round(seconds * SR), pre = Math.round(predelay * SR);
  const r = rng(`hall ${seed}`);
  return [0, 1].map(() => {
    const lo = new Biquad(butter(2, 2500, "low")), hi = new Biquad(butter(2, 2500, "high"));
    const y = new Float64Array(pre + n);
    let e = 0;
    for (let i = 0; i < n; i++) {
      const z = r.normal(), t = i / SR;
      const v = lo.step(z) * Math.exp(-6.91 * t / rt) + 0.5 * hi.step(z) * Math.exp(-6.91 * t / rtHi);
      y[pre + i] = v;
      e += v * v;
    }
    const g = 1 / Math.sqrt(e);
    for (let i = 0; i < y.length; i++) y[i] *= g;
    return y;
  });
}

// ---------------------------------------------------------------- convolution

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

// Two channels each through its own impulse response, block by block (uniformly partitioned
// overlap-save). The two real channels share one complex FFT, as real and imaginary parts.
export class Convolver {
  constructor([irL, irR], b = BLOCK) {
    const n = 2 * b, bins = b + 1;
    this.b = b; this.n = n; this.bins = bins;
    this.fft = new FFT(n);
    this.p = Math.ceil(Math.max(irL.length, irR.length) / b);
    this.re = new Float64Array(n); this.im = new Float64Array(n);
    this.h = [new Float64Array(this.p * bins * 2), new Float64Array(this.p * bins * 2)];
    for (let q = 0; q < this.p; q++) {
      this.re.fill(0); this.im.fill(0);
      for (let i = 0; i < b; i++) {
        this.re[i] = irL[q * b + i] ?? 0;
        this.im[i] = irR[q * b + i] ?? 0;
      }
      this.fft.run(this.re, this.im, false);
      this.split(this.h[0], this.h[1], q * bins * 2);
    }
    this.x = [new Float64Array(this.p * bins * 2), new Float64Array(this.p * bins * 2)]; // past input spectra
    this.head = 0;
    this.prev = [new Float64Array(b), new Float64Array(b)];
    this.acc = [new Float64Array(bins * 2), new Float64Array(bins * 2)];
  }

  // the half spectra of the two real signals in re (left) and im (right), to a and b at o
  split(a, bb, o) {
    const { re, im, n } = this;
    for (let k = 0; k < this.bins; k++) {
      const zr = re[k], zi = im[k], wr = re[(n - k) % n], wi = im[(n - k) % n];
      a[o + 2 * k] = (zr + wr) / 2; a[o + 2 * k + 1] = (zi - wi) / 2;
      bb[o + 2 * k] = (zi + wi) / 2; bb[o + 2 * k + 1] = (wr - zr) / 2;
    }
  }

  // b samples of each channel in, b out
  run(xl, xr, yl, yr) {
    const { b, n, bins, re, im, p } = this;
    for (let i = 0; i < b; i++) {
      re[i] = this.prev[0][i]; im[i] = this.prev[1][i];
      re[b + i] = xl[i]; im[b + i] = xr[i];
    }
    this.prev[0].set(xl); this.prev[1].set(xr);
    this.fft.run(re, im, false);
    const slot = this.head * bins * 2;
    this.split(this.x[0], this.x[1], slot);
    for (let c = 0; c < 2; c++) {
      const acc = this.acc[c], h = this.h[c], x = this.x[c];
      acc.fill(0);
      for (let q = 0; q < p; q++) {
        const xo = ((this.head - q + p) % p) * bins * 2, ho = q * bins * 2;
        for (let k = 0; k < 2 * bins; k += 2) {
          const ar = x[xo + k], ai = x[xo + k + 1], br = h[ho + k], bi = h[ho + k + 1];
          acc[k] += ar * br - ai * bi;
          acc[k + 1] += ar * bi + ai * br;
        }
      }
    }
    this.head = (this.head + 1) % p;
    const [A, B] = this.acc;
    for (let k = 0; k < bins; k++) {
      const ar = A[2 * k], ai = A[2 * k + 1], br = B[2 * k], bi = B[2 * k + 1];
      re[k] = ar - bi; im[k] = ai + br;
      if (k > 0 && k < b) { re[n - k] = ar + bi; im[n - k] = br - ai; }
    }
    this.fft.run(re, im, true);
    for (let i = 0; i < b; i++) {
      yl[i] = re[b + i] / n;
      yr[i] = im[b + i] / n;
    }
  }
}

// ---------------------------------------------------------------- echo, compressor, limiter

// The ping-pong: four repeats at half a beat, each a third down in power, low-passed at 3 kHz once
// more, and crossed to the other side.
export class Echo {
  constructor(bpm) {
    this.d = Math.round(60 / bpm / 2 * SR);
    this.g = Math.sqrt(1 / 3);
    this.lp = Array.from({ length: 4 }, () => [new Biquad(butter(1, 3000, "low")), new Biquad(butter(1, 3000, "low"))]);
    this.line = Array.from({ length: 4 }, () => [new Float64Array(this.d), new Float64Array(this.d)]);
    this.at = 0;
  }
  step(l, r, out) {
    let el = 0, er = 0;
    for (let k = 0; k < 4; k++) {
      const [ll, rr] = this.line[k], [fl, fr] = this.lp[k];
      const a = fl.step(l) * this.g, b = fr.step(r) * this.g;
      const dl = ll[this.at], dr = rr[this.at];
      ll[this.at] = a; rr[this.at] = b;
      l = dr; r = dl; // crossed
      el += l; er += r;
    }
    this.at = (this.at + 1) % this.d;
    out[0] = el; out[1] = er;
  }
}

// The compressor, streamed: the two channels' mean power over 10 ms about each millisecond's
// point, a soft-knee gain reduction, smoothed (30 ms attack, 400 ms release) at 1 kHz and read
// between the points. Gives each sample DELAY samples after it comes in.
export class Compressor {
  constructor() {
    this.hop = SR / 1000;
    this.half = 5 * this.hop; // the 10 ms window's half
    this.delay = this.hop + this.half - 1;
    this.size = 1024;
    this.q = new Float64Array(this.size); // mean square, by sample
    this.x = [new Float64Array(this.size), new Float64Array(this.size)];
    this.gains = []; // by point, from point `first`
    this.first = 0;
    this.s = 0;
    this.i = 0;
    this.aAtt = Math.exp(-1 / (COMP.attack * 1000));
    this.aRel = Math.exp(-1 / (COMP.release * 1000));
  }
  step(l, r, out) {
    const { size, hop, half } = this, i = this.i;
    this.x[0][i % size] = l; this.x[1][i % size] = r;
    this.q[i % size] = (l * l + r * r) / 2;
    const c = i - (half - 1); // the point whose window this sample completes
    if (c >= 0 && c % hop === 0) {
      let p = 0;
      for (let j = c - half; j < c + half; j++) if (j >= 0) p += this.q[j % size];
      const lvl = 10 * Math.log10(Math.max(p / (2 * half), 1e-12)), over = lvl - COMP.thresh, k = COMP.knee;
      const gr = over <= -k / 2 ? 0 : over >= k / 2 ? over * (1 - 1 / COMP.ratio) : (over + k / 2) ** 2 / (2 * k) * (1 - 1 / COMP.ratio);
      const a = gr > this.s ? this.aAtt : this.aRel;
      this.s = a * this.s + (1 - a) * gr;
      this.gains.push(10 ** (-this.s / 20));
    }
    const n = i - this.delay;
    this.i += 1;
    if (n < 0) { out[0] = 0; out[1] = 0; return; }
    const m = Math.floor(n / hop), f = n / hop - m;
    const g0 = this.gains[m - this.first], g1 = this.gains[m + 1 - this.first];
    const g = g0 + (g1 - g0) * f;
    this.gain = g; // the gain of the sample given
    out[0] = this.x[0][n % size] * g; out[1] = this.x[1][n % size] * g;
    if (m - this.first > 4096) { // drop the points behind
      this.gains = this.gains.slice(m - this.first);
      this.first = m;
    }
  }
}

// The limiter at the stream's own rate: each sample's gain is what the highest point near it
// needs (the signal read at quarter samples, linked over the channels), held at its least over 24 ms
// about it, averaged over 12 ms, and never above its own need. Gives each sample DELAY samples late.
const TAPS = 8; // the quarter-sample reader's half length
const READ = [0.25, 0.5, 0.75].map((f) => Float64Array.from({ length: 2 * TAPS }, (_, k) => {
  const x = f - (k - TAPS + 1); // tap k reads sample n - TAPS + 1 + k for the point n + f
  const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
  const u = x / TAPS; // Blackman over |x| < TAPS
  return sinc * (0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u));
}));
export class Limiter {
  constructor() {
    this.w = Math.round(LIMIT_WINDOW * SR) | 1;
    this.hw = (this.w - 1) / 2;
    this.span = this.w - 1; // the least-of window's half
    this.delay = TAPS + this.span + this.hw;
    this.size = 2048;
    this.x = [new Float64Array(this.size), new Float64Array(this.size)];
    this.g = new Float64Array(this.size).fill(1);
    this.vPrev = 0;
    this.dq = new Int32Array(this.size); this.dv = new Float64Array(this.size); // the least-of deque: index, gain
    this.dh = 0; this.dt = 0;
    this.avg = new Float64Array(this.w).fill(1); // the last w held gains; those before the start are 1
    this.sum = this.hw; // the hw before the start
    this.navg = this.hw;
    this.i = 0;
  }
  step(l, r, out) {
    const { size } = this, i = this.i;
    this.x[0][i % size] = l; this.x[1][i % size] = r;
    const n = i - TAPS; // the sample whose quarter points are known now
    if (n >= 0) {
      let v = 0; // the highest quarter point between n and n + 1
      for (const h of READ) {
        let a = 0, b = 0;
        for (let k = 0; k < 2 * TAPS; k++) {
          const j = n - TAPS + 1 + k;
          if (j < 0) continue;
          a += this.x[0][j % size] * h[k]; b += this.x[1][j % size] * h[k];
        }
        v = Math.max(v, Math.abs(a), Math.abs(b));
      }
      const pk = Math.max(Math.abs(this.x[0][n % size]), Math.abs(this.x[1][n % size]), this.vPrev, v);
      this.vPrev = v;
      const g = Math.min(1, CEILING / Math.max(pk, 1e-9));
      this.g[n % size] = g;
      // least over [m - span, m + span] for m = n - span
      while (this.dt > this.dh && this.dv[(this.dt - 1) % size] >= g) this.dt--;
      this.dq[this.dt % size] = n; this.dv[this.dt % size] = g; this.dt++;
      const m = n - this.span;
      while (this.dq[this.dh % size] < m - this.span) this.dh++;
      if (m >= 0) {
        const held = this.dv[this.dh % size];
        this.sum += held - (this.navg >= this.w ? this.avg[this.navg % this.w] : 0);
        this.avg[this.navg % this.w] = held;
        this.navg++;
      }
    }
    const o = i - this.delay; // = m - hw: its average is complete
    this.i += 1;
    if (o < 0) { out[0] = 0; out[1] = 0; return; }
    const s = Math.min(this.sum / this.w, this.g[o % size]);
    this.gain = s; // the gain of the sample given
    out[0] = this.x[0][o % size] * s; out[1] = this.x[1][o % size] * s;
  }
}

// One voice's sound held under the ceiling on its way to the speaker (speech, and a song sung alone:
// what no room masters), each sample in its own place: what push() gives runs the limiter's delay
// behind what it is given, and end() gives the rest.
export class Held {
  constructor() {
    this.lim = new Limiter();
    this.skip = this.lim.delay;
    this.o = [0, 0];
  }
  push(c) {
    const y = new Float32Array(c.length);
    let k = 0;
    for (let i = 0; i < c.length; i++) {
      this.lim.step(c[i], c[i], this.o);
      if (this.skip > 0) this.skip--;
      else y[k++] = this.o[0];
    }
    return k === y.length ? y : y.slice(0, k);
  }
  end() {
    return this.push(new Float32Array(this.lim.delay));
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
const RING = 1 << 15;
export class Trace {
  constructor() {
    this.v = Object.fromEntries([...STAGES, "comp", "lim"].map((k) => [k, new Float32Array(RING)]));
    this.frames = 0; // frames whose output has all been given
    this.given = null;
  }
  // stage k at frame f, NaN if f is not given yet or no longer kept
  at(k, f) {
    if (this.given) return f >= 0 && f < RING && this.given(f) ? this.v[k][f] : NaN;
    if (!(f >= 0 && f < this.frames && f > this.frames - RING + 64)) return NaN;
    return this.v[k][f % RING];
  }
  open(f) { for (const k in this.v) this.v[k][f % RING] = 0; }
  // a copy, for a take made again from this one
  copy() {
    const t = new Trace();
    for (const k in this.v) t.v[k].set(this.v[k]);
    t.frames = this.frames;
    return t;
  }
  add(k, t, x) { this.v[k][Math.floor(t / TRACE) % RING] += x / TRACE; }
  most(k, t, db) {
    const a = this.v[k], i = Math.floor(t / TRACE) % RING;
    if (db > a[i]) a[i] = db;
  }
}
const db = (g) => -20 * Math.log10(Math.max(g, 1e-9));

// push(dry, send) with [left, right] of any length; returns the finished output there is, as
// [left, right] (Float32Array) or null; end() returns the rest and TAIL s of the room's ring.
// With `trace` (true, or a Trace to write), .trace is the room's Trace. .wet scales the echo and both
// halls (1: as set). A room picked up in the middle of a piece: `at` is the sample of the piece its
// first is (a whole number of TRACE), and it traces from `from` on, what comes before being its
// run-up.
export const TRACE_MAX = RING * TRACE; // samples a trace with `given` holds
export class Room {
  constructor({ room, bpm, seed = 1, trace = false, at = 0, from = at }) {
    const r = ROOMS[room];
    if (!r) throw new Error(`no room ${room}`);
    if (!(bpm > 0)) throw new Error(`room: bpm ${bpm}`);
    this.r = r;
    this.echo = new Echo(bpm);
    this.hall = r.wet ? new Convolver(hall(3.5, r.rt, r.rtHi, 0.03, seed)) : null;
    this.mhall = r.mwet ? new Convolver(hall(5.5, r.mrt, r.mrtHi, 0.04, seed + 6)) : null;
    this.send = [new Biquad(butter(2, 200, "high")), new Biquad(butter(2, 200, "high"))];
    this.sendLp = [new Biquad(butter(2, 5000, "low")), new Biquad(butter(2, 5000, "low"))];
    this.hp = [new Biquad(butter(2, 30, "high")), new Biquad(butter(2, 30, "high"))];
    this.comp = new Compressor();
    this.lim = new Limiter();
    this.delay = this.comp.delay + this.lim.delay;
    this.pend = [[], [], [], []]; // dry l, r, send l, r not yet a block
    this.pendN = 0;
    this.in = 0; // samples of mix in
    this.out = 0; // samples given
    this.fed = 0; // samples of mix through the chain
    this.skip = this.delay;
    this.wet = 1;
    this.trace = trace === true ? new Trace() : trace || null;
    if (at % TRACE || from % TRACE || from < at) throw new Error(`room: from sample ${at}, traced from ${from}`);
    this.t0 = at;
    this.tfrom = from;
    const b = BLOCK;
    this.buf = Array.from({ length: 12 }, () => new Float64Array(b));
  }

  push([dl, dr], [sl, sr]) {
    if (dl.length !== dr.length || sl.length !== dl.length || sr.length !== dl.length) throw new Error("room: the buses differ in length");
    this.pend[0].push(dl); this.pend[1].push(dr); this.pend[2].push(sl); this.pend[3].push(sr);
    this.pendN += dl.length;
    this.in += dl.length;
    const outs = [];
    while (this.pendN >= BLOCK) outs.push(this.block());
    return join(outs);
  }

  // the rest of the mix, then the ring, to TAIL s past the mix's end
  end() {
    const want = this.in + Math.round(TAIL * SR), outs = [];
    while (this.out < want) {
      const n = this.pendN;
      if (n < BLOCK) for (let c = 0; c < 4; c++) this.pend[c].push(new Float64Array(BLOCK - n));
      this.pendN = BLOCK;
      outs.push(this.block(want));
    }
    return join(outs);
  }

  // one block of the pending input through the room; the first DELAY samples out are dropped
  block(limit = Infinity) {
    const b = BLOCK, [dl, dr, sl, sr, el, er, hl, hr, ml, mr, xl, xr] = this.buf;
    for (let c = 0; c < 4; c++) take(this.pend[c], b, this.buf[c]);
    this.pendN -= b;
    const r = this.r, e = [0, 0], T = this.trace;
    const ec = r.echo * this.wet, we = r.wet * this.wet, mw = r.mwet * this.wet;
    for (let i = 0; i < b; i++) {
      this.echo.step(sl[i], sr[i], e);
      el[i] = e[0]; er[i] = e[1];
      xl[i] = sl[i] + 0.5 * e[0]; xr[i] = sr[i] + 0.5 * e[1];
    }
    if (this.hall) this.hall.run(xl, xr, hl, hr);
    else { hl.fill(0); hr.fill(0); }
    for (let i = 0; i < b; i++) {
      ml[i] = dl[i] + ec * el[i] + we * hl[i];
      mr[i] = dr[i] + ec * er[i] + we * hr[i];
      const j = this.t0 + this.fed + i;
      if (T && j >= this.tfrom) {
        if (j % TRACE === 0) T.open(j / TRACE);
        T.add("dry", j, (dl[i] * dl[i] + dr[i] * dr[i]) / 2);
        T.add("echo", j, ec * ec * (el[i] * el[i] + er[i] * er[i]) / 2);
        T.add("hall", j, we * we * (hl[i] * hl[i] + hr[i] * hr[i]) / 2);
        T.add("master", j, (ml[i] * ml[i] + mr[i] * mr[i]) / 2);
      }
      xl[i] = this.sendLp[0].step(this.send[0].step(ml[i]));
      xr[i] = this.sendLp[1].step(this.send[1].step(mr[i]));
    }
    if (this.mhall) this.mhall.run(xl, xr, hl, hr);
    else { hl.fill(0); hr.fill(0); }
    const out = [new Float32Array(b), new Float32Array(b)], o = [0, 0];
    let k = 0;
    for (let i = 0; i < b; i++) {
      const a = this.hp[0].step(ml[i] + mw * hl[i]), c = this.hp[1].step(mr[i] + mw * hr[i]);
      this.comp.step(a, c, o);
      this.lim.step(o[0], o[1], o);
      const j = this.t0 + this.fed + i;
      if (T && j >= this.tfrom) T.add("mhall", j, mw * mw * (hl[i] * hl[i] + hr[i] * hr[i]) / 2);
      if (T && j - this.comp.delay >= this.tfrom) T.most("comp", j - this.comp.delay, db(this.comp.gain));
      if (T && j - this.delay >= this.tfrom) T.most("lim", j - this.delay, db(this.lim.gain));
      if (this.skip > 0) { this.skip--; continue; }
      if (this.out >= limit) break;
      out[0][k] = o[0]; out[1][k] = o[1];
      if (T && this.t0 + this.out >= this.tfrom) T.add("out", this.t0 + this.out, (o[0] * o[0] + o[1] * o[1]) / 2);
      k++; this.out++;
    }
    this.fed += b;
    if (T) T.frames = Math.floor((this.t0 + this.out) / TRACE);
    return [out[0].subarray(0, k), out[1].subarray(0, k)];
  }
}

// n samples from the front of a queue of arrays into dst
function take(q, n, dst) {
  let k = 0;
  while (k < n) {
    const a = q[0], m = Math.min(a.length, n - k);
    for (let i = 0; i < m; i++) dst[k + i] = a[i];
    k += m;
    if (m === a.length) q.shift();
    else q[0] = a.subarray(m);
  }
}

function join(outs) {
  const n = outs.reduce((a, o) => a + o[0].length, 0);
  if (!n) return null;
  const y = [new Float32Array(n), new Float32Array(n)];
  let k = 0;
  for (const [l, r] of outs) { y[0].set(l, k); y[1].set(r, k); k += l.length; }
  return y;
}
