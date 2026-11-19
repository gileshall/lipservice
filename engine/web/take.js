// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A take, kept as a tape: its sound wherever it has been made, to be played from any made sample
// (deck.js) and drawn (one channel, or the mean of two; each frame's extent, the pitch, what was said
// or sung and when). Speech and a song are made from the start on; a choir can be made from any
// sample, so a tape may have gaps, and one made again another way starts as the old one's picture
// with nothing to play. Frames are HOP samples (10 ms). No DOM.

import { parse, LEAD } from "./perform.js";

export const SR = 24000;
export const HOP = 240;

const grow = (a, n, fill = 0) => {
  if (n <= a.length) return a;
  const b = new a.constructor(Math.max(n, 2 * a.length));
  b.fill(fill, a.length);
  b.set(a);
  return b;
};

const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function midiOf(name) {
  const m = name.match(/^([A-G])([#b]?)(-?\d)$/);
  if (!m) throw new Error(`${name}: not a note`);
  return 12 * (+m[3] + 1) + PITCH[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}

// Spans: [a, b) in order, none touching. add() joins [a, b) to them; within() is the one s is in;
// outside() counts the samples of [a, b) in none.
export function add(spans, a, b) {
  if (b <= a) return;
  let i = 0;
  while (i < spans.length && spans[i][1] < a) i++;
  let j = i;
  while (j < spans.length && spans[j][0] <= b) { a = Math.min(a, spans[j][0]); b = Math.max(b, spans[j][1]); j++; }
  spans.splice(i, j - i, [a, b]);
}
export const within = (spans, s) => spans.find(([a, b]) => s >= a && s < b) ?? null;
export const outside = (spans, a, b) => spans.reduce((n, [s, e]) => n - Math.max(0, Math.min(b, e) - Math.max(a, s)), Math.max(0, b - a));

export class Take {
  // kind: "say", "sing" or "choir"; t0: when it was asked for (ms)
  constructor(kind, t0) {
    this.kind = kind;
    this.t0 = t0;
    this.y = new Float32Array(SR * 10); // for the figures: the one channel, or the mean of the two
    this.ch = null; // a stereo take's two channels
    this.n = 0; // one past the last sample written
    this.spans = []; // made: what can be played
    this.shown = []; // drawn though not made: what an earlier making of it left
    this.dirty = []; // written since the spectrogram last asked
    this.stamp = 0; // counts the writes
    this.head = null; // where its making writes next, null with none at work
    this.length = null; // samples it will have, once known
    this.closed = false; // its length is final
    this.ext = new Float32Array(2 * 1024); // each frame's least and most sample
    this.f0 = new Float32Array(1024).fill(NaN); // Hz a frame, NaN unvoiced or not known
    this.parts = []; // speech: each part's plan in samples
    this.notes = []; // song: its written notes {a, b, midi, word}
    this.lanes = null; // choir: each part's {name, sex, mute, off, lv, breaths, cents, lag}
    this.trace = null; // choir: the room's trace
    this.first = null; // ms to the first sound made
    this.busy = 0; // ms of work, as the workers count it
  }

  has(s) { return within(this.spans, s) !== null; }
  shows(s) { return this.has(s) || within(this.shown, s) !== null; }
  // the end of the made span s is in; s itself where none is
  end(s) { return within(this.spans, s)?.[1] ?? s; }
  // the start of the made span that ends at s or holds the sample before it; s where none does
  begin(s) { return within(this.spans, s - 1)?.[0] ?? s; }
  // the start of the first made span after s, or null
  next(s) { return this.spans.find(([a]) => a > s)?.[0] ?? null; }

  // Samples at `at`, and a second channel for a stereo take. seam {a, u, b, e}: where this making
  // joins what is made already, it is blended in over [a, u) and out over [b, e) (b null: no end
  // to join), so a making picked up beside another never steps.
  write(at, l, r = null, seam = null) {
    const n = l.length, end = at + n;
    if (!n) return;
    if (!Number.isInteger(at) || at < 0) throw new Error(`take: written at sample ${at}`);
    if ((r !== null) !== (this.ch !== null) && this.spans.length) throw new Error("take: one channel or two, not both");
    if (r && r.length !== n) throw new Error("take: the channels differ in length");
    this.y = grow(this.y, end);
    if (r) this.ch = (this.ch ?? [new Float32Array(this.y.length), new Float32Array(this.y.length)]).map((c) => grow(c, this.y.length));
    const to = r ? this.ch : [this.y], src = r ? [l, r] : [l];
    if (seam) {
      const mix = (a, b, up) => {
        for (let s = Math.max(a, at); s < Math.min(b, end); s++) {
          const w = up ? (s - a) / (b - a) : 1 - (s - a) / (b - a);
          for (let c = 0; c < src.length; c++) src[c][s - at] = w * src[c][s - at] + (1 - w) * to[c][s];
        }
      };
      mix(seam.a, seam.u, true);
      if (seam.b !== null) mix(seam.b, seam.e, false);
    }
    for (let c = 0; c < src.length; c++) to[c].set(src[c], at);
    if (r) for (let i = 0; i < n; i++) this.y[at + i] = (l[i] + r[i]) / 2;
    this.n = Math.max(this.n, end);
    this.ext = grow(this.ext, 2 * Math.ceil(this.n / HOP) + 2);
    for (let f = Math.floor(at / HOP); f * HOP < end; f++) {
      let lo = Infinity, hi = -Infinity;
      for (let i = f * HOP; i < Math.min(this.n, (f + 1) * HOP); i++) {
        const v = this.y[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      this.ext[2 * f] = lo;
      this.ext[2 * f + 1] = hi;
    }
    add(this.spans, at, end);
    add(this.dirty, at, end);
    this.stamp += 1;
  }

  // the next samples of a take made from its start on
  push(l, r = null) {
    this.write(this.n, l, r);
  }

  // its length is final: `length`, or what it has
  close(length = this.n) {
    this.length = length;
    this.closed = true;
    if (this.n > length) { // what an earlier making left past its end
      this.n = length;
      this.shown = this.shown.filter(([a]) => a < length).map(([a, b]) => [a, Math.min(b, length)]);
    }
  }

  // [left, right] of [a, b), copies to send; right null for one channel
  cut(a, b) {
    if (this.end(a) < b) throw new Error(`take: samples ${a} to ${b} are not all made`);
    return this.ch ? [this.ch[0].slice(a, b), this.ch[1].slice(a, b)] : [this.y.slice(a, b), null];
  }

  // what was written since this was last asked, as [a, b) spans
  drain() {
    const d = this.dirty;
    this.dirty = [];
    return d;
  }

  // This take to be made again another way: its picture kept, nothing of it to play.
  stale() {
    const t = new Take(this.kind, this.t0);
    t.y = this.y.slice();
    t.n = this.n;
    t.ext = this.ext.slice();
    t.shown = this.shown.map((x) => [...x]);
    for (const [a, b] of this.spans) add(t.shown, a, b);
    t.dirty = this.dirty.map((x) => [...x]);
    t.length = this.length;
    t.lanes = this.lanes?.map((l) => ({ ...l, lv: l.lv.slice() })) ?? null;
    t.trace = this.trace?.copy() ?? null;
    if (t.trace) t.trace.given = (f) => t.shows(f * HOP);
    return t;
  }

  // speech: a part's plan (worker.js "plan"), starting at sample `at`
  plan(p, at) {
    const tokens = [];
    let s = at;
    p.tokens.forEach((sym, i) => {
      const b = s + p.dur[i] * HOP;
      tokens.push({ sym, a: s, b, phrased: false });
      s = b;
    });
    for (const i of p.phrased) tokens[i].phrased = true;
    this.parts.push({
      at, end: s, tokens,
      words: p.words.map(([text, a, b]) => ({ text, a: tokens[a].a, b: tokens[b - 1].b })),
      rises: p.rises.map(([a, b]) => ({ a: tokens[a].a, b: tokens[Math.min(b, tokens.length) - 1].b })),
    });
    if (p.part === p.parts - 1) this.length = s;
  }

  // the pitch of a part (k) from its frame `from`
  pitch(k, from, hz) {
    const base = (k < 0 ? 0 : this.parts[k].at) / HOP + from;
    this.f0 = grow(this.f0, Math.ceil(base) + hz.length + 1, NaN);
    for (let i = 0; i < hz.length; i++) this.f0[Math.round(base + i)] = hz[i];
  }

  // song: its notes as written, shifted `shift` semitones, and its length in frames
  song(text, shift, frames) {
    const s = parse(text), spb = 60 / s.bpm;
    for (const ph of s.phrases) {
      let beat = ph.start;
      for (const w of ph.words) {
        let first = true;
        for (const g of w.groups) for (const x of g) {
          const a = Math.round((LEAD + beat * spb) * SR);
          beat += x.beats;
          this.notes.push({ a, b: Math.round((LEAD + beat * spb) * SR), midi: midiOf(x.pitch) + shift, word: first ? w.word : null });
          first = false;
        }
      }
    }
    this.length = frames * HOP;
  }

}
