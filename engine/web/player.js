// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The page's speaker, an AudioWorklet: plays each utterance's chunks back to back, sample for
// sample, its gain slewing over FADE samples so that nothing clicks: up at the start, down to
// reach 0 on the last sample, down at a stop, and down where the chunks fall behind (a stall),
// back up when they catch up. Until the end is known, the last FADE samples are kept for that.
// Stereo: a chunk with `right` is its two channels, one without is the same on both.
// An utterance's sound can be changed ahead of where it plays: a splice gives its sound from one of
// its samples on, in place of what was queued from there (and of its end, if that was said).
//   port in:  {type: "chunk", id, samples, right?}, {type: "end", id} (no more chunks), {type: "stop", id},
//             {type: "splice", id, at, samples, right?}: the utterance's sound from its sample `at` on
//   port out: {type: "ended", id, stalls, stopped} once an utterance is over, and every EVERY samples
//             played {type: "at", id, n, frame, stalls}: n samples of the utterance played by the
//             context's sample `frame`

const FADE = 192; // 8 ms at 24 kHz
const EVERY = 1024;
const now = () => (typeof currentFrame === "number" ? currentFrame : 0);

class Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; // [{id, samples, right}], read from q[0] at this.at
    this.at = 0;
    this.endId = 0; // utterances up to this have all their chunks in
    this.stopId = 0; // utterances up to this are stopped
    this.k = 0; // gain k / FADE
    this.stalls = 0;
    this.short = false;
    this.n = 0; // samples of the front utterance played
    this.doneId = 0; // utterances up to this are over
    this.port.onmessage = ({ data: m }) => {
      if (m.type === "chunk" || m.type === "splice") {
        if (m.right && m.right.length !== m.samples.length) throw new Error("player: the channels differ in length");
        if (m.id <= this.stopId || m.id <= this.doneId) return;
        if (m.type === "splice") this.splice(m);
        else this.q.push({ id: m.id, samples: m.samples, right: m.right ?? m.samples });
      } else if (m.type === "end") {
        this.endId = Math.max(this.endId, m.id);
        if (!this.q.length || this.q[0].id > m.id) this.over(m.id, false);
      } else if (m.type === "stop") {
        this.stopId = Math.max(this.stopId, m.id);
        if (!this.q.length || this.q[0].id > m.id) this.over(m.id, true);
      } else {
        throw new Error(`player: no message ${m.type}`);
      }
    };
  }

  // The utterance's sound from its sample m.at on is m.samples: what was queued from there is
  // dropped, and what of the new is already played is skipped. Its end, if said, is to be said again.
  splice(m) {
    const q = this.q, front = q.length > 0 && q[0].id === m.id;
    let p = front || !q.length ? this.n : 0; // the utterance's sample the queue holds next
    let i = q.findIndex((c) => c.id >= m.id);
    if (i < 0) i = q.length;
    let skip = null;
    while (i < q.length && q[i].id === m.id) {
      const c = q[i], off = front && i === 0 ? this.at : 0, n = c.samples.length - off;
      if (m.at >= p + n) { p += n; i++; continue; }
      let k = i;
      while (k < q.length && q[k].id === m.id) k++;
      if (m.at > p) { // this chunk keeps what it has before m.at
        q.splice(i, k - i, { id: c.id, samples: c.samples.subarray(0, off + m.at - p), right: c.right.subarray(0, off + m.at - p) });
        i += 1;
        skip = 0;
      } else {
        q.splice(i, k - i);
        if (off) this.at = 0;
        skip = p - m.at;
      }
      break;
    }
    if (skip === null) {
      if (m.at > p) throw new Error(`player: a splice at sample ${m.at} of an utterance that reaches ${p}`);
      skip = p - m.at;
    }
    if (m.id <= this.endId) this.endId = m.id - 1;
    if (skip >= m.samples.length) return;
    const right = m.right ?? m.samples;
    q.splice(i, 0, { id: m.id, samples: skip ? m.samples.subarray(skip) : m.samples, right: skip ? right.subarray(skip) : right });
  }

  over(id, stopped) {
    this.doneId = Math.max(this.doneId, id);
    this.port.postMessage({ type: "at", id, n: this.n, frame: now(), stalls: this.stalls });
    this.port.postMessage({ type: "ended", id, stalls: this.stalls, stopped });
    this.n = 0;
    this.stalls = 0;
    this.short = false;
    this.k = 0;
  }

  // samples left of the front utterance, counted until past FADE
  left() {
    const id = this.q[0].id;
    let n = this.q[0].samples.length - this.at;
    for (let j = 1; j < this.q.length && n <= FADE && this.q[j].id === id; j++) n += this.q[j].samples.length;
    return n;
  }

  process(_, outputs) {
    const [out, outR] = outputs[0];
    for (let i = 0; i < out.length; i++) {
      if (!this.q.length) {
        out[i] = outR[i] = 0;
        continue;
      }
      const id = this.q[0].id;
      const stopping = id <= this.stopId, ending = id <= this.endId;
      const r = this.left();
      if (!stopping && !ending && this.k === 0 && r <= FADE) {
        out[i] = outR[i] = 0; // too little to fade up and back down: wait for more
        continue;
      }
      const down = stopping || r <= this.k;
      if (down && !stopping && !ending && !this.short) this.stalls += 1;
      this.short = down && !stopping && !ending;
      this.k = down ? Math.max(0, this.k - 1) : Math.min(FADE, this.k + 1);
      out[i] = (this.q[0].samples[this.at] * this.k) / FADE;
      outR[i] = (this.q[0].right[this.at] * this.k) / FADE;
      this.at += 1;
      if (++this.n % EVERY === 0) this.port.postMessage({ type: "at", id, n: this.n, frame: now() + i, stalls: this.stalls });
      if (this.at === this.q[0].samples.length) {
        this.q.shift();
        this.at = 0;
      }
      const same = this.q.length && this.q[0].id === id;
      if (stopping && (this.k === 0 || !same)) {
        while (this.q.length && this.q[0].id <= this.stopId) this.q.shift();
        this.at = 0;
        this.over(id, true);
      } else if (ending && !same) {
        this.over(id, false);
      }
    }
    return true;
  }
}

registerProcessor("player", Player);
