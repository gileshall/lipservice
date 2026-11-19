// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A choir: songs sung at once, a voice each, seated on a stage and played through a room (room.js).
// The parts are spread over workers (worker.js, "choir-*" messages), which perform them as people
// sing (perform.js); this side seats and mixes what they make, puts the mix through the room, and
// says whether the making keeps ahead of a speaker (deck.js plays it). A choir can be made from any
// sample of its mix on. No DOM here: the page and node both use it.

import { Room, BLOCK, TRACE, TRACE_MAX, TAIL, rng } from "./room.js";
import { within, outside } from "./take.js";

export const SR = 24000;
export const FADE = 192; // as player.js: a part's start and end are faded, never cut
export const REFL_SUM = 1 + 0.25 + 0.18; // a seat's direct sound and its two reflections
export const WARM = 1.5; // s of the mix put through the room before the sample asked for, so the room rings as it would
const MARGIN = 0.7; // the part of a worker's measured speed counted on
const RECENT = 4000; // ms of a worker's singing its speed is measured over
const SHARE_MIN = 1000, SHARE_SPAN = 12000; // ms of the workers' time, from when their sound comes in, that their singing's share of it is known from, and is measured over

// How many workers sing `parts` parts, on a machine of `cores`: one a part, leaving a core for the
// page and the audio, to at most `cap`.
export function workersFor(parts, cores, cap = 4) {
  return Math.max(1, Math.min(parts, cores - 1, cap));
}

// choirkit.make_seats: n seats on risers facing the listener, rows of about 25 (row 0 nearest),
// odd rows staggered half a seat; pan from the angle, so no one sits hard left or right; further
// rows quieter, wetter and later. Sorted left to right, each with two early reflections.
export function makeSeats(n, panMax = 0.85, halfAngle = 52) {
  const rows = Math.max(1, Math.round(n / 25));
  const base = Math.floor(n / rows), extra = n % rows, rad = Math.PI / 180;
  const seats = [];
  for (let r = 0; r < rows; r++) {
    const c = base + (r < extra ? 1 : 0), odd = r % 2 === 1;
    for (let i = 0; i < c; i++) {
      const u = c > 1 ? Math.min(1, (i + (odd ? 0.5 : 0)) / Math.max(c - (odd ? 0 : 1), 1)) : 0.5;
      const a = -halfAngle + 2 * halfAngle * u;
      seats.push({ row: r, pan: panMax * Math.sin(a * rad) / Math.sin(halfAngle * rad), gain: 1 - 0.1 * r, send: 0.6 + 0.2 * r, delayMs: 3 * r });
    }
  }
  seats.sort((a, b) => a.pan - b.pan || a.row - b.row);
  const rnd = rng("seats");
  const clamp = (p) => Math.max(-0.95, Math.min(0.95, p));
  for (const s of seats) {
    s.itdMs = 0.35 * Math.abs(s.pan);
    s.refl = [
      { delayMs: rnd.between(7, 19), pan: clamp(-0.6 * s.pan + rnd.between(-0.3, 0.3)), gain: 0.25 },
      { delayMs: rnd.between(21, 37), pan: clamp(0.3 * s.pan + rnd.between(-0.5, 0.5)), gain: 0.18 },
    ];
  }
  return seats;
}

// choirkit.coprime_step: seat (step j) % n for the j-th singer puts neighbours in order far apart
export function coprimeStep(n, frac = 0.37) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  let s = Math.max(1, Math.round(frac * n));
  while (gcd(s, n) !== 1) s += 1;
  return s;
}

// choirkit.add_source: a source at `gain` from its seat as taps {ch, g, d} (channel, gain, delay in
// samples): the direct sound panned, the far ear later by the interaural time, the row's gain and
// distance, and the two reflections. The send bus takes the same taps times seat.send.
export function taps(gain, seat) {
  const ms = (x) => Math.round(x / 1000 * SR);
  const g = gain * seat.gain, dd = ms(seat.delayMs);
  const legs = [[seat.pan, g, dd, ms(seat.itdMs)], ...seat.refl.map((r) => [r.pan, g * r.gain, dd + ms(r.delayMs), ms(0.35 * Math.abs(r.pan))])];
  return legs.flatMap(([p, gg, d, itd]) => {
    const th = (p + 1) * Math.PI / 4;
    return [{ ch: 0, g: gg * Math.cos(th), d: p > 0 ? d + itd : d }, { ch: 1, g: gg * Math.sin(th), d: p > 0 ? d : d + itd }];
  });
}

// the factor of levels `k` ([[sample, factor]...]) at sample s, k[i] the last at or before it (i from
// a guess at or before the answer)
function levelAt(k, s, i = 0) {
  while (i + 1 < k.length && k[i + 1][0] <= s) i++;
  if (s <= k[i][0] || i + 1 === k.length) return [k[i][1], i];
  const [a, x] = k[i], [b, y] = k[i + 1];
  return [x + (y - x) * (s - a) / (b - a), i];
}

// The parts' samples, as they come, each from its seat at its own start, summed to four buses: dry
// left and right, and the room's send left and right. A part is opened with its start (s) and
// length (samples) before its samples count. Starts are counted from t0 (s), or, with none given,
// from the earliest once every part is open. Every part is faded in over its first FADE samples and
// out over its last. take() gives the buses as far as every part has reached. Each part keeps its
// level as it comes (lv: rms of its samples at its gain, every TRACE samples of its own, NaN where
// none came). A part's levels, [[s of its own, factor]...] in order, are what its gain is times as it
// goes: a straight line from each to the next, the first held before it and the last after. A mix
// picked up at its sample `from` (t0 given): its parts are opened at the sample of their own they
// come in at, and what they have before the mix's start is left out. A muted part gives no samples:
// it is opened at its end, so the mix keeps its length and the part the levels it had.
export class Mixer {
  // parts: [{gain, seat, lv, levels, mute}], lv a part's levels kept from an earlier mix of it, or none
  constructor(parts, { t0 = null, from = 0 } = {}) {
    if (from && t0 === null) throw new Error("mixer: picked up, it needs its t0");
    this.parts = parts.map(({ gain, seat, lv = null, levels = null, mute = false }, i) => {
      const t = taps(gain, seat);
      if (levels && !(levels.length && levels.every(([at, k], j) => at >= 0 && k >= 0 && Number.isFinite(k) && (!j || at > levels[j - 1][0])))) throw new Error(`mixer: part ${i}'s levels ${JSON.stringify(levels)}`);
      return { gain, env: levels && levels.map(([at, k]) => [Math.round(at * SR), k]), taps: t, send: seat.send, reach: Math.max(...t.map((x) => x.d)), q: [], at: 0, placed: 0, got: 0, from: 0, len: null, start: null, off: null, done: false, lv, sq: 0, mute };
    });
    this.t0 = t0;
    this.from = from;
    this.opened = 0;
    this.out = from; // the sample of the mix given next
    this.base = from; // the buses' first sample
    this.bus = [0, 1, 2, 3].map(() => new Float64Array(0));
    this.total = null; // samples in all, once every part is open
  }

  open(i, start, len, from = 0) {
    const p = this.parts[i];
    if (p.len !== null) throw new Error(`mixer: part ${i} opened twice`);
    if (!(len > 0)) throw new Error(`mixer: part ${i} of ${len} samples`);
    if (!(from >= 0 && from <= len) || from % TRACE) throw new Error(`mixer: part ${i} picked up at sample ${from} of ${len}`);
    if (p.mute && from !== len) throw new Error(`mixer: part ${i} is muted, and opened at sample ${from} of ${len}`);
    p.start = start;
    p.len = len;
    p.from = p.got = p.placed = from;
    if (p.lv?.length !== Math.ceil(len / TRACE)) p.lv = new Float32Array(Math.ceil(len / TRACE)).fill(NaN);
    if (this.t0 !== null) {
      if (start < this.t0) throw new Error(`mixer: part ${i} starts at ${start} s, before the mix's ${this.t0}`);
      p.off = Math.round((start - this.t0) * SR);
    }
    if (++this.opened === this.parts.length) {
      if (this.t0 === null) {
        this.t0 = Math.min(...this.parts.map((p) => p.start));
        for (const p of this.parts) p.off = Math.round((p.start - this.t0) * SR);
      }
      this.total = Math.max(...this.parts.map((p) => p.off + p.len + p.reach));
    }
  }

  push(i, samples) {
    const p = this.parts[i];
    if (p.len === null) throw new Error(`mixer: part ${i} is not open`);
    if (p.done) throw new Error(`mixer: part ${i} has ended`);
    if (p.got + samples.length > p.len) throw new Error(`mixer: part ${i} past its ${p.len} samples`);
    for (let i = 0; i < samples.length; i++) {
      p.sq += samples[i] * samples[i];
      if ((p.got + i + 1) % TRACE === 0) { p.lv[(p.got + i + 1) / TRACE - 1] = p.gain * (p.env ? levelAt(p.env, p.got + i + 1 - TRACE / 2)[0] : 1) * Math.sqrt(p.sq / TRACE); p.sq = 0; }
    }
    // what a part picked up has before the mix's start is not placed
    const lead = Math.min(samples.length, Math.max(0, this.from - p.off - p.got));
    if (lead) p.placed += lead;
    if (lead < samples.length) p.q.push(lead ? samples.subarray(lead) : samples);
    p.got += samples.length;
  }

  end(i) {
    const p = this.parts[i];
    if (p.got !== p.len) throw new Error(`mixer: part ${i} ended at ${p.got} samples of ${p.len}`);
    p.done = true;
  }

  get finished() {
    return this.total !== null && this.parts.every((p) => p.done) && this.out >= this.total;
  }

  // the buses writable to `to` (a sample of the mix)
  room(to) {
    const n = this.bus[0].length;
    if (to - this.base <= n) return;
    const keep = this.out - this.base;
    if (keep > 0) { // what is given is dropped first
      for (const b of this.bus) { b.copyWithin(0, keep); b.fill(0, n - keep); }
      this.base = this.out;
    }
    if (to - this.base > n) {
      const m = Math.max(2 * n, to - this.base + 8192);
      this.bus = this.bus.map((b) => { const c = new Float64Array(m); c.set(b); return c; });
    }
  }

  // part p's samples from placed to `upto` (its own samples) onto the buses
  place(p, upto) {
    while (p.placed < upto) {
      const c = p.q[0], k = Math.min(c.length - p.at, upto - p.placed);
      const s0 = p.placed, a = p.at;
      let lev = null;
      if (p.env) {
        lev = new Float32Array(k);
        for (let j = 0, i = 0; j < k; j++) [lev[j], i] = levelAt(p.env, s0 + j, i);
      }
      for (const { ch, g, d } of p.taps) {
        const dry = this.bus[ch], wet = this.bus[2 + ch], gs = g * p.send;
        const o = p.off + d - this.base;
        for (let j = 0; j < k; j++) {
          const s = s0 + j;
          let x = c[a + j];
          if (s < FADE) x *= s / FADE;
          if (s >= p.len - FADE) x *= (p.len - 1 - s) / FADE;
          if (lev) x *= lev[j];
          dry[o + s] += g * x;
          wet[o + s] += gs * x;
        }
      }
      p.placed += k;
      p.at += k;
      if (p.at === c.length) { p.q.shift(); p.at = 0; }
    }
  }

  // [dry l, dry r, send l, send r] as far as every part has reached, or null
  take() {
    if (this.total === null) return null;
    let lim = this.total;
    for (const p of this.parts) if (!p.done) lim = Math.min(lim, p.off + p.got);
    if (lim <= this.out) return null;
    this.room(Math.max(...this.parts.map((p) => p.off + Math.min(p.got, Math.max(0, lim - p.off)) + p.reach)));
    for (const p of this.parts) this.place(p, Math.min(p.got, Math.max(0, lim - p.off)));
    const a = this.out - this.base, b = lim - this.base;
    const y = this.bus.map((x) => Float32Array.from(x.subarray(a, b)));
    this.out = lim;
    return y;
  }
}

// Runs choirs over a pool of workers: `main` (the page's own worker, whose messages the page hands
// to message(0, m)) and helpers made by spawn(), which are light workers (no speech model).
//   onOpen(job): every part is open: job.mixer, job.room, job.sung, how each part was performed,
//   job.kept, the samples of each its worker has kept and need not sing, and job.picked, the most
//   parts one worker has to sing where the mix starts (worker.js choir-open)
//   onSound(job, [left, right], at): the room's next sound, its first sample the mix's sample `at`
//   onDone(job, stats): all the sound asked for has been given; onError(message): a worker failed,
//   the choir is stopped
//   onLoaded(ms): what prepare() asked for is loaded, in ms
// A guest ({owns(m), message(k, m)}, the crowd pad) shares the workers: what it owns goes to it.
export class Choir {
  constructor({ main, spawn, onSound, onDone, onError, onLoaded = () => {}, onOpen = () => {}, cores, cap = 4, now = () => performance.now() }) {
    this.pool = [main];
    this.spawn = spawn;
    this.onSound = onSound;
    this.onDone = onDone;
    this.onError = onError;
    this.onLoaded = onLoaded;
    this.onOpen = onOpen;
    this.guest = null;
    this.loading = 0; // workers yet to say what they were asked to load is loaded
    this.loadMs = 0;
    this.cores = cores;
    this.cap = cap;
    this.now = now;
    this.job = null;
    // The workers' time as their sound comes in here against the time they spent singing it: each
    // step sung, [ms since that worker's last sound came in, ms it sang], any job's, the last
    // SHARE_SPAN ms of them, and their sums. A worker's sound comes in slower than it sings by what
    // else the worker does and by how long this side takes to take it.
    this.steps = [];
    this.spent = [0, 0];
  }

  // The share of the workers' time that their singing is, as it comes in here: 1 at most, null
  // until SHARE_MIN ms of it are known.
  share() {
    const [wall, busy] = this.spent;
    return wall >= SHARE_MIN ? Math.min(1, busy / wall) : null;
  }

  // Worker k's speed in the job as its sound comes in here, samples a ms: what it has sung over its
  // last RECENT ms of singing, at the workers' share(). Null until it has sung and the share is known.
  speed(k) {
    const j = this.job, s = j.sang[k], share = this.share();
    const [b0, m0] = s[0], [b1, m1] = s.at(-1);
    return share !== null && b1 > b0 && m1 > m0 ? (m1 - m0) / (b1 - b0) * share : null;
  }

  // the workers for `n` parts, made as needed
  workers(n, cap = this.cap) {
    const w = workersFor(n, this.cores, cap);
    while (this.pool.length < w) {
      const k = this.pool.length;
      const h = this.spawn();
      h.onmessage = ({ data: m }) => this.message(k, m);
      this.pool.push(h);
    }
    return w;
  }

  // The parts' voices, pitch motion and breaths to each worker that will sing them: loaded ahead of
  // start().
  prepare(parts) {
    const w = this.workers(parts.length);
    this.load(Array.from({ length: w }, (_, k) => {
      const mine = parts.filter((_, i) => i % w === k);
      return {
        voices: [...new Set(mine.map((p) => p.voice))],
        motions: [...new Set(mine.map((p) => p.motion).filter((m) => m))],
        breaths: mine.some((p) => p.breath > 0),
      };
    }));
  }

  // what each worker (lists[k]: {voices, motions, breaths}) is to load; onLoaded once all have
  load(lists) {
    this.loading += lists.length;
    lists.forEach((x, k) => this.pool[k].postMessage({ type: "choir-load", ...x }));
  }

  // parts: [{name, voice, sex, song, shift, seed, at, gain, levels (or none), seat, motion, motionScale, vibrato,
  // vibratoHz, vibratoDelay, glide, dynamics, breathiness, diction, jitter, detune, spread, breath, mute}]
  // (perform.js, lipservice.js singer()), seat
  // an index into seats (makeSeats()); room: a key of room.js ROOMS, its echo at the song's bpm.
  // A part with mute set keeps its place in the piece and is not heard: the others are sung alone.
  // The mix's sample 0 is the earliest a part can start, however it is performed, so the same piece
  // sung another way keeps its clock. from, until: the samples of the mix wanted, from (a whole
  // number of TRACE) up to until, or to the end of the room's ring; the room is run from WARM s
  // before. trace: a Trace for the room to write; lv: each part's levels from an earlier making.
  start({ id, parts, seats, room, bpm, step = 20, from = 0, until = null, trace = false, lv = [] }) {
    if (this.job) throw new Error("a choir is already running");
    if (!parts.length) throw new Error("a choir needs a part");
    if (parts.every((p) => p.mute)) throw new Error("a choir needs a part that is not muted");
    for (const p of parts) if (!seats[p.seat]) throw new Error(`${p.name}: no seat ${p.seat}`);
    if (!(from >= 0) || from % TRACE || (until !== null && until <= from)) throw new Error(`a choir from sample ${from} to ${until}`);
    const w = this.workers(parts.length);
    const groups = Array.from({ length: w }, () => []);
    parts.forEach((p, i) => groups[i % w].push({ ...p, part: i }));
    const t0 = Math.min(...parts.map((p) => p.at - (p.jitter ?? 0) / 100 - (p.spread ?? 0)));
    const at = Math.max(0, from - Math.round(WARM * SR / TRACE) * TRACE);
    this.job = {
      id, w, step, n: parts.length, t0, from, until, at, pos: at,
      mixer: new Mixer(parts.map((p, i) => ({ gain: p.gain, levels: p.levels, seat: seats[p.seat], lv: lv[i], mute: p.mute === true })), { t0, from: at }),
      room: new Room({ room, bpm, trace, at, from }), sung: new Array(parts.length).fill(null),
      kept: new Array(parts.length).fill(null), picked: null,
      of: groups.map((g) => g.map((p) => p.part)), // a worker's parts
      busy: new Array(w).fill(0), made: new Array(w).fill(0), done: new Array(w).fill(null),
      sang: Array.from({ length: w }, () => [[0, 0]]), // a worker's [ms sung, samples sung] as it went, from RECENT ms of singing back
      came: new Array(w).fill(null), // when its last sound came in
      flushed: false, t0ms: this.now(),
    };
    groups.forEach((g, k) => this.pool[k].postMessage({ type: "choir", id, step, t0, from: at, parts: g }));
  }

  // The job's workers sing their parts up to sample `to` of the mix and wait there to be told
  // further (Infinity: to the end, as a job starts). Told again only for half a second's move.
  reach(to) {
    const j = this.job;
    if (!j) return;
    const was = j.reach ?? Infinity;
    if (to === was || (Number.isFinite(to) && Number.isFinite(was) && Math.abs(to - was) < SR / 2)) return;
    j.reach = to;
    for (let k = 0; k < j.w; k++) this.pool[k].postMessage({ type: "choir-reach", id: j.id, to });
  }

  // Stops the job (id) on every worker; whoever owns the speaker stops that.
  stop(id) {
    for (const w of this.pool) w.postMessage({ type: "stop", id });
    if (this.job && this.job.id <= id) this.job = null;
  }

  fail(message) {
    const id = this.job.id;
    this.stop(id);
    this.onError(message);
  }

  // a worker's message; anything that goes wrong in it fails the choir
  message(k, m) {
    try {
      this.handle(k, m);
    } catch (e) {
      if (this.job) this.fail(e.message);
      else this.onError(e.message);
    }
  }

  handle(k, m) {
    if (this.guest && this.guest.owns(m)) {
      this.guest.message(k, m);
      return;
    }
    if (m.type === "choir-loaded") {
      this.loadMs = Math.max(this.loadMs, m.ms);
      if (--this.loading === 0) {
        this.onLoaded(this.loadMs);
        this.loadMs = 0;
      }
      return;
    }
    if (m.type === "error" && m.id === null) { // a helper that did not load
      this.onError(m.message);
      return;
    }
    const j = this.job;
    if (!j || m.id !== j.id) return;
    if (m.type === "error") {
      this.fail(m.message);
    } else if (m.type === "choir-open") {
      m.parts.forEach((p, i) => { j.mixer.open(p, m.at[i], m.lens[i], m.from[i]); j.sung[p] = m.sung[i]; j.kept[p] = m.kept[i]; });
      if (j.mixer.total !== null) {
        const sings = (i) => { const p = j.mixer.parts[i]; return p.from < p.len && !within(j.kept[i], p.from); };
        j.picked = Math.max(...j.of.map((ps) => ps.filter(sings).length));
        if (j.room.trace?.given && j.mixer.total + TAIL * SR > TRACE_MAX) throw new Error(`a choir of ${(j.mixer.total / SR).toFixed(0)} s is too long to trace`);
        this.onOpen(j);
      }
      this.pump();
    } else if (m.type === "choir-chunk") {
      j.mixer.push(m.part, m.samples);
      const now = this.now(), s = j.sang[k];
      if (m.made > j.made[k]) { // a step sung, not kept sound or a singer picked up
        if (j.came[k] !== null) {
          const wall = Math.max(0, now - j.came[k] - (m.idle ?? 0)); // less what it waited at its reach
          this.steps.push([wall, m.busy - j.busy[k]]);
          this.spent = [this.spent[0] + wall, this.spent[1] + m.busy - j.busy[k]];
          while (this.steps.length > 1 && this.spent[0] - this.steps[0][0] >= SHARE_SPAN) {
            const [wall, busy] = this.steps.shift();
            this.spent = [this.spent[0] - wall, this.spent[1] - busy];
          }
        }
        s.push([m.busy, m.made]);
        while (s.length > 2 && m.busy - s[1][0] >= RECENT) s.shift();
      }
      j.came[k] = now;
      j.busy[k] = m.busy;
      j.made[k] = m.made;
      this.pump();
    } else if (m.type === "choir-end") {
      j.mixer.end(m.part);
      this.pump();
    } else if (m.type === "choir-done") {
      j.done[k] = { busy: m.busy, secs: m.secs };
      this.pump();
    } else {
      throw new Error(`choir: no message ${m.type}`);
    }
  }

  // whether every worker with singing still to do has said how fast it sings
  measured() {
    const j = this.job, mx = j.mixer;
    return mx.total !== null && j.of.every((ps, k) => this.speed(k) !== null || ps.every((i) => mx.parts[i].done || !outside(j.kept[i], mx.parts[i].got, mx.parts[i].len)));
  }

  // Whether a speaker at sample c of the mix now never runs dry: for every worker, the singing left
  // to bring its parts to any point u of the mix (what it has kept takes none), at MARGIN of its
  // speed(), is done before the speaker reaches u (less the room's delay). The singing to reach u is
  // piecewise linear in u, so the points where it bends are the only ones to check. Nothing past the
  // job's `until` is wanted.
  keepsUp(c = this.job.from) {
    const j = this.job, mx = j.mixer;
    if (mx.total === null) return false;
    const D = BLOCK + j.room.delay, last = j.until === null ? Infinity : j.until + D;
    for (let k = 0; k < j.w; k++) {
      const live = j.of[k].filter((i) => !mx.parts[i].done);
      if (!live.length) continue;
      const sp = this.speed(k), speed = sp === null ? null : sp * MARGIN; // samples a ms
      const bends = live.flatMap((i) => { const p = mx.parts[i]; return [p.got, p.len, ...j.kept[i].flat()].map((s) => p.off + s); });
      for (const u0 of [c + D, ...bends]) {
        const u = Math.min(u0, last);
        const need = live.reduce((a, i) => { const p = mx.parts[i]; return a + outside(j.kept[i], p.got, Math.min(u - p.off, p.len)); }, 0);
        if (need && (speed === null || need / speed > Math.max(0, u - D - c) / SR * 1000)) return false;
      }
    }
    return true;
  }

  // the room's next sound: what of it is wanted is given
  out(y) {
    const j = this.job;
    if (!y) return;
    const a = j.pos, n = y[0].length;
    j.pos += n;
    const lo = Math.max(a, j.from), hi = Math.min(a + n, j.until ?? Infinity);
    if (hi > lo) this.onSound(j, [y[0].subarray(lo - a, hi - a), y[1].subarray(lo - a, hi - a)], lo);
  }

  pump() {
    const j = this.job;
    for (let y; (y = j.mixer.take()); ) this.out(j.room.push([y[0], y[1]], [y[2], y[3]]));
    if (!j.flushed && j.mixer.finished) {
      j.flushed = true;
      if (j.room.in) this.out(j.room.end()); // a choir picked up past its end has no ring to give
    }
    const whole = j.flushed && j.done.every((d) => d), cut = j.until !== null && j.pos >= j.until;
    if (!whole && !cut) return;
    // made: seconds of singing; busy: the workers' time on it, as far as they have said
    const secs = j.mixer.parts.reduce((a, p) => a + p.got - p.from, 0) / SR;
    const busy = (whole ? j.done.reduce((a, d) => a + d.busy, 0) : j.busy.reduce((a, b) => a + b, 0)) / 1000;
    const wall = (this.now() - j.t0ms) / 1000, mix = (j.pos - j.at) / SR;
    if (whole) this.job = null;
    else this.stop(j.id);
    this.onDone(j, { parts: j.n, workers: j.w, mix, secs, wall, busy, whole, speed: secs / wall, perCompute: secs / busy, realtime: mix / wall });
  }
}
