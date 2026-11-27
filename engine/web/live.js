// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The crowd pad: a crowd singing a chord loop, as many voices as asked, each voice a note a chord.
// The workers the choir uses (choir.js) sing the notes as they are needed (worker.js "note"); here
// they are mixed from their seats through the room (room.js) and sent to the speaker a little
// ahead of it. What is set (set()) is heard as soon as it can be: a voice added comes in, one taken
// away fades out, the room and the level follow; the rest is heard from each voice's next note. How
// many voices the workers can keep up with is measured as they sing (stats()). Nothing here waits
// on a timer: the speaker's position (hear()) and the workers' messages drive it, so it keeps
// singing in a page the browser has put in the background. No DOM.

import { makeSeats, coprimeStep, taps, FADE, SR } from "./choir.js";
import { Room, TRACE, FULL_CHOIR, rng } from "./room.js";

export const MAX = 128; // voices
export const LV = 512; // frames (TRACE samples) of each voice's level kept
const LEAD = 0.1; // s the engine sets before a song's first sound (perform.js)
const AHEAD = 0.35; // s of sound mixed ahead of the speaker
const ASK = 1.2; // s past what is mixed that a chord's notes are asked for
const ENTER = 0.12; // s past what is mixed that a voice added comes in
const SWELL = 0.006; // s between voices added together, each coming in after the one before
const OVERLAP = 0.15; // s a note runs into the next
const OUT = 0.15; // s a voice taken away fades over
const FIRST = 0.25; // s of sound before the speaker starts
const MARGIN = 0.85; // the part of the workers' time counted on
const WINDOW = 3000; // ms the workers' speed is measured over
const RING = 1 << 17; // samples of the buses kept
const STEP = 20; // frames a note is made in at a time
// A voice's gain, over the root of how many sing: half the full choir the mastering is set for, as a
// crowd holds its fullest all the time, where a piece's singers pass through theirs.
const LEVEL = FULL_CHOIR / 2;
const BPM = 72; // the room's echo, at half a beat

// The chord loop in D, I vi IV V: each its name and [root, third, fifth] as pitch classes.
export const CHORDS = [["D", [2, 6, 9]], ["Bm", [11, 2, 6]], ["G", [7, 11, 2]], ["A", [9, 1, 4]]];
const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
export const noteName = (m) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
export const chordName = (b, shift) => {
  const [name] = CHORDS[b % 4], minor = name.endsWith("m");
  return NAMES[(((CHORDS[b % 4][1][0] + shift) % 12) + 12) % 12] + (minor ? "m" : "");
};

// What can be set, each from u in [0, 1] (a place on the pad): its value, and the value shown.
export const PARAMS = {
  voices: { label: "voices", value: (u) => Math.max(1, Math.round(2 ** (7 * u))), u: (v) => Math.log2(v) / 7, show: (v) => `${v}` },
  spread: { label: "spread", value: (u) => u, u: (v) => v, show: (v) => (v < 0.05 ? "unison" : `${Math.round(v * 100)}%`) },
  pitch: { label: "key", value: (u) => Math.round(14 * u - 7), u: (v) => (v + 7) / 14, show: (v) => `${chordName(0, v)} (${v > 0 ? "+" : ""}${v} st)` },
  vibrato: { label: "vibrato", value: (u) => 0.7 * u, u: (v) => v / 0.7, show: (v) => `${v.toFixed(2)} st` },
  breath: { label: "breath", value: (u) => 1.5 * u, u: (v) => v / 1.5, show: (v) => v.toFixed(2) },
  room: { label: "room", value: (u) => 2 * u, u: (v) => v / 2, show: (v) => `${Math.round(v * 100)}%` },
  tempo: { label: "chord length", value: (u) => 4 - 3 * u, u: (v) => (4 - v) / 3, show: (v) => `${v.toFixed(1)} s` },
  width: { label: "width", value: (u) => 0.1 + 0.85 * u, u: (v) => (v - 0.1) / 0.85, show: (v) => `${Math.round(v * 100)}%` },
};
export const DEFAULTS = { voices: 8, spread: 0.5, pitch: 0, vibrato: 0.25, breath: 0.6, room: 1, tempo: 3, width: 0.7 };

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// a voice's own ways, drawn once: its role among the chord's tones, register, tuning and timing
function traits(j) {
  const r = rng(`crowd ${j}`);
  return { sex: j % 2 ? "M" : "F", role: r.uniform(), alt: r.uniform(), reg: r.between(-1, 1), tune: r.normal(), time: r.normal(), hz: r.between(4.6, 6.2) };
}

// The note a voice sings on a chord: at no spread every voice the root, the women about E4 and the
// men an octave down; as the spread grows more of them take the third or the fifth and their
// registers part, up to five semitones either way. role: 0 root, 1 third, 2 fifth.
export function noteOf(t, chord, spread, shift) {
  const role = t.role < 0.85 * spread ? (t.alt < 0.5 ? 1 : 2) : 0;
  const center = (t.sex === "F" ? 64 : 52) + 5 * spread * t.reg + shift;
  const pc = (((chord[role] + shift) % 12) + 12) % 12;
  let m = Math.round(center);
  const d = (((pc - m) % 12) + 12) % 12;
  m += d > 6 ? d - 12 : d;
  return { midi: m, role };
}

export class Crowd {
  // choir: the Choir whose workers it shares; voices: the voice list (voices.json);
  // toPlayer(m, transfer): the speaker's port; onError(message): it failed and has stopped
  constructor({ choir, voices, toPlayer, onError, cap = 6, now = () => performance.now() }) {
    this.choir = choir;
    this.toPlayer = toPlayer;
    this.onError = onError;
    this.now = now;
    this.w = choir.workers(MAX, cap);
    // a worker's voices: one woman's and one man's, each worker its own as far as they go
    const fem = voices.filter((v) => v.sex === "F"), mal = voices.filter((v) => v.sex === "M");
    if (!fem.length || !mal.length) throw new Error("the crowd needs a woman's voice and a man's");
    this.voiceOf = (j) => { const vs = j % 2 ? mal : fem; return vs[(j % this.w) % vs.length]; };
    this.traits = Array.from({ length: MAX }, (_, j) => traits(j));
    const step = coprimeStep(MAX);
    this.seatOf = (j) => (step * j) % MAX; // neighbours in order sit far apart
    this.P = { ...DEFAULTS };
    this.id = null;
    choir.guest = this;
  }

  // the voices each worker will sing, loaded ahead
  prepare() {
    this.choir.load(Array.from({ length: this.w }, (_, k) => ({
      voices: [...new Set(this.traits.map((_, j) => j).filter((j) => j % this.w === k).map((j) => this.voiceOf(j).name))],
      motions: [], breaths: false,
    })));
  }

  owns(m) {
    return m.type.startsWith("note-") || (m.type === "error" && this.id !== null && m.id === this.id);
  }

  start(id) {
    if (this.id !== null) throw new Error("the crowd is already singing");
    this.id = id;
    this.room = new Room({ room: "card", bpm: BPM, trace: true });
    this.room.wet = this.P.room;
    this.seats = makeSeats(MAX, this.P.width);
    this.seatW = this.P.width;
    this.notes = new Map(); // key: a note asked for
    this.key = 0;
    this.bars = []; // chords asked for, not yet over: {b, t, len}
    this.next = { b: 0, t: Math.round(0.3 * SR) };
    this.rel = 0; // samples mixed into the room
    this.sent = 0; // samples sent to the speaker
    this.heard = 0; // samples the speaker has played
    this.stalls = 0;
    this.n = 0; // voices singing
    this.bus = [0, 1, 2, 3].map(() => new Float64Array(RING)); // dry l, r, send l, r
    this.g = LEVEL;
    this.lv = new Float32Array(MAX * LV); // each voice's power, a frame of the mix each
    this.sang = Array.from({ length: MAX }, () => []); // each voice's last notes: {start, end, role, midi}
    this.held = [];
    this.heldN = 0;
    this.started = false;
    this.busy = new Float64Array(this.w); // ms each worker has spent on this crowd's notes
    this.busy0 = new Array(this.w).fill(null);
    this.made = new Float64Array(this.w); // samples each worker has made
    this.ratio = null; // a note's samples over its chord's
    this.hist = [];
    this.t0 = this.now();
    this.first = null;
    this.set({});
  }

  stop() {
    if (this.id === null) return;
    for (const w of this.choir.pool.slice(0, this.w)) w.postMessage({ type: "stop", id: this.id });
    this.room.close();
    this.id = null;
    this.notes = null;
  }

  fail(message) {
    this.stop();
    this.onError(message);
  }

  set(changes) {
    for (const k of Object.keys(changes)) if (!(k in this.P)) throw new Error(`the crowd has no ${k}`);
    Object.assign(this.P, changes);
    if (this.id === null) return;
    if (this.P.width !== this.seatW) {
      this.seats = makeSeats(MAX, this.P.width);
      this.seatW = this.P.width;
    }
    this.guard(() => {
      const n = this.P.voices;
      if (n > this.n) for (let j = this.n; j < n; j++) this.enter(j, j - this.n);
      else for (let j = n; j < this.n; j++) this.leave(j);
      this.n = n;
      this.pump();
    });
  }

  // the speaker has played n samples, stalling `stalls` times
  hear(n, stalls) {
    if (this.id === null) return;
    this.heard = n;
    this.stalls = stalls;
    this.guard(() => this.pump());
  }

  // anything that goes wrong in f fails the crowd
  guard(f) {
    try {
      f();
    } catch (e) {
      this.fail(e.message);
    }
  }

  // a voice comes in ENTER s past what is mixed (the i-th of those added at once i SWELLs later),
  // through every chord asked for
  enter(j, i) {
    const e = this.rel + Math.round((ENTER + i * SWELL) * SR);
    for (const bar of this.bars) if (bar.t + bar.len > e) this.ask(j, bar, e > bar.t ? e : null);
  }

  // a voice fades out from what is mixed next; its notes not yet begun by then are dropped
  leave(j) {
    const r = this.rel;
    for (const x of this.notes.values()) {
      if (x.j !== j || x.out !== null) continue;
      if (x.start >= r) this.drop(x);
      else x.out = r;
    }
    const end = r + Math.round(OUT * SR);
    this.sang[j] = this.sang[j].filter((x) => x.start < r).map((x) => ({ ...x, end: Math.min(x.end, end) }));
  }

  // a note no longer needed; its worker stops singing it
  drop(x) {
    this.notes.delete(x.key);
    if (!x.done) this.choir.pool[x.k].postMessage({ type: "note-stop", id: this.id, key: x.key });
  }

  // voice j's note on a chord, sounding from `from` (a voice coming in) or the chord's start
  // nudged by the voice's timing
  ask(j, bar, from = null) {
    const t = this.traits[j], P = this.P, s = P.spread, w = this.ways(j);
    let at = from ?? bar.t + Math.round(w.time * SR);
    at = Math.max(at, this.rel + Math.round((LEAD + 0.02) * SR)); // never before what is mixed
    const end = bar.t + bar.len;
    if (end - at < 0.25 * SR) return; // too little of the chord left to come in on
    const { midi, role } = noteOf(t, CHORDS[bar.b % 4][1], s, P.pitch);
    const key = ++this.key, k = j % this.w, seat = this.seats[this.seatOf(j)];
    const start = at - Math.round(LEAD * SR);
    this.notes.set(key, {
      key, j, k, role, midi, start, len: null, buf: null, got: 0, done: false, out: null,
      taps: taps(1, seat), send: seat.send, span: from === null ? bar.len : null,
    });
    const sang = this.sang[j];
    sang.push({ start: at, end: end + Math.round(OVERLAP * SR), role, midi });
    if (sang.length > 4) sang.shift();
    this.choir.pool[k].postMessage({
      type: "note", id: this.id, key, voice: this.voiceOf(j).name, at: start / SR, step: STEP,
      song: `%bpm 60\n${t.sex === "F" ? "ah" : "oh"} ${noteName(midi)}:${((end - at) / SR + OVERLAP).toFixed(3)}\n`,
      shift: w.cents / 100, seed: j * 1009 + bar.b, vibrato: P.vibrato, vibratoHz: t.hz, breathiness: P.breath,
    });
  }

  // how voice j sings at the spread set: cents off the note, s off the chord's start, its
  // vibrato's rate
  ways(j) {
    const t = this.traits[j], s = this.P.spread;
    return { cents: clamp(s * 18 * t.tune, -40, 40), time: clamp(s * 0.06 * t.time, -0.15, 0.15), hz: t.hz };
  }

  message(k, m) {
    if (this.id === null || m.id !== this.id) return; // a stopped crowd's
    this.guard(() => this.handle(k, m));
  }

  handle(k, m) {
    if (m.type === "error") throw new Error(m.message);
    this.busy0[k] ??= m.busy; // the worker's time on notes before this crowd
    this.busy[k] = m.busy - this.busy0[k];
    if (m.type === "note-chunk") this.made[k] += m.samples.length;
    const x = this.notes.get(m.key);
    if (!x) return; // a note dropped, or mixed out, as its voice left
    if (m.type === "note-open") {
      x.len = m.len;
      x.buf = new Float32Array(m.len);
      if (x.span) this.ratio = this.ratio === null ? m.len / x.span : 0.9 * this.ratio + 0.1 * m.len / x.span;
    } else if (m.type === "note-chunk") {
      if (x.got + m.samples.length > x.len) throw new Error(`crowd: note ${x.key} past its ${x.len} samples`);
      x.buf.set(m.samples, x.got);
      x.got += m.samples.length;
    } else if (m.type === "note-end") {
      if (x.got !== x.len) throw new Error(`crowd: note ${x.key} ended at ${x.got} samples of ${x.len}`);
      x.done = true;
    } else {
      throw new Error(`crowd: no message ${m.type}`);
    }
    this.pump();
  }

  // asks for each chord's notes ASK s ahead of what is mixed, then mixes as far as every note has
  // reached, to AHEAD s past the speaker
  pump() {
    while (this.next.t < this.rel + ASK * SR) {
      const bar = { b: this.next.b, t: this.next.t, len: Math.round(this.P.tempo * SR) };
      this.bars.push(bar);
      for (let j = 0; j < this.n; j++) this.ask(j, bar);
      this.next = { b: bar.b + 1, t: bar.t + bar.len };
    }
    while (this.bars.length && this.bars[0].t + this.bars[0].len < this.heard - SR) this.bars.shift();
    let h = this.heard + Math.round(AHEAD * SR);
    for (const x of this.notes.values()) {
      if (x.start >= h) continue;
      if (x.len === null) h = Math.min(h, x.start);
      else if (!x.done) h = Math.min(h, x.start + x.got);
    }
    if (h > this.rel) this.mix(h);
    this.hist.push({ t: this.now(), busy: this.busy.reduce((a, b) => a + b, 0), made: this.made.reduce((a, b) => a + b, 0), rel: this.rel, n: this.n });
    while (this.hist.length > 2 && this.hist[1].t < this.now() - WINDOW) this.hist.shift();
  }

  // mix [rel, h) through the room to the speaker
  mix(h) {
    const a = this.rel, n = h - a, B = this.bus, M = RING - 1;
    const v = new Float32Array(n);
    // the frames begun in [a, h): each voice's level there starts from nothing
    for (let f = Math.ceil(a / TRACE); f * TRACE < h; f++) for (let j = 0; j < MAX; j++) this.lv[j * LV + (f % LV)] = 0;
    for (const x of this.notes.values()) {
      if (x.len === null) continue;
      const s0 = Math.max(a, x.start), s1 = Math.min(h, x.start + x.len);
      if (s1 <= s0) continue;
      const m = s1 - s0, out = x.out ?? Infinity, lv = this.lv, base = x.j * LV;
      for (let s = s0; s < s1; s++) {
        const i = s - x.start;
        let y = x.buf[i];
        if (i < FADE) y *= i / FADE;
        if (i >= x.len - FADE) y *= (x.len - 1 - i) / FADE;
        if (s >= out) y *= Math.max(0, 1 - (s - out) / (OUT * SR));
        v[s - s0] = y;
        lv[base + (Math.floor(s / TRACE) % LV)] += (y * y) / TRACE;
      }
      for (const { ch, g, d } of x.taps) {
        const dry = B[ch], wet = B[2 + ch], gs = g * x.send;
        for (let i = 0, o = s0 + d; i < m; i++, o++) {
          dry[o & M] += g * v[i];
          wet[o & M] += gs * v[i];
        }
      }
    }
    for (const x of this.notes.values()) {
      const over = x.out !== null ? x.out + OUT * SR : x.done ? x.start + x.len : Infinity;
      if (over <= h) this.drop(x);
    }
    const y = [0, 1, 2, 3].map(() => new Float32Array(n));
    const want = LEVEL / Math.sqrt(Math.max(1, this.n)), k = 1 - Math.exp(-1 / (0.05 * SR)); // the level follows in 50 ms
    for (let i = 0, s = a; i < n; i++, s++) {
      this.g += k * (want - this.g);
      for (let c = 0; c < 4; c++) {
        y[c][i] = B[c][s & M] * this.g;
        B[c][s & M] = 0;
      }
    }
    this.rel = h;
    this.room.wet += clamp(this.P.room - this.room.wet, -0.15, 0.15);
    const o = this.room.push([y[0], y[1]], [y[2], y[3]]);
    if (o) this.out(o);
  }

  out(o) {
    if (!this.started) {
      this.held.push(o);
      this.heldN += o[0].length;
      if (this.heldN < FIRST * SR) return;
      this.started = true;
      this.first = this.now() - this.t0;
      for (const p of this.held) this.send(p);
      this.held = [];
      return;
    }
    this.send(o);
  }

  send([l, r]) {
    this.sent += l.length;
    this.toPlayer({ type: "chunk", id: this.id, samples: l, right: r }, [l.buffer, r.buffer]);
  }

  // voice j's level (rms) at frame f of the mix, NaN where it is not kept
  level(j, f) {
    if (!(f >= 0 && f * TRACE < this.rel && f > this.rel / TRACE - LV)) return NaN;
    return Math.sqrt(this.lv[j * LV + (f % LV)]);
  }

  // what voice j sings at sample s of the mix, or null
  singing(j, s) {
    for (const x of this.sang[j]) if (s >= x.start && s < x.end) return x;
    return null;
  }

  // the chord sounding at sample s, as its number in the loop
  chordAt(s) {
    let b = null;
    for (const bar of this.bars) if (bar.t <= s) b = bar.b;
    return b;
  }

  // How fast the workers sing, over the last WINDOW ms: cost, s of work a s of a note; perVoice,
  // s of note a voice needs a s; capacity, the voices the workers keep up with; load, the part of
  // the workers' time spent singing; ahead, s of sound the speaker has in hand.
  stats() {
    const h = this.hist, a = h[0], b = h.at(-1);
    const dt = b && a ? b.t - a.t : 0, dm = b && a ? b.made - a.made : 0, db = b && a ? b.busy - a.busy : 0;
    const cost = dm > 0 ? (db / 1000) / (dm / SR) : null;
    const perVoice = this.ratio;
    return {
      voices: this.n, workers: this.w, cost, perVoice,
      capacity: cost && perVoice ? (this.w * MARGIN) / (cost * perVoice) : null,
      load: dt > 500 ? db / (this.w * dt) : null,
      ahead: (this.sent - this.heard) / SR, mixed: this.rel / SR, heard: this.heard / SR, sent: this.sent / SR,
      stalls: this.stalls, first: this.first, started: this.started,
    };
  }
}
