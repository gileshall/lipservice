// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The editor's speaker, on the browser's audio thread (an AudioWorklet module). Two processors.
//
// "speaker": every singer's sound on one line of time, an output a singer and one for the click,
// all moved by one count of samples, so the singers cannot part. The page hands it each singer's
// sound as a take (a stretch of the line, filled as the singer makes it); it plays what it has,
// waits where a singer it waits for has none yet, goes round a loop, jumps, and fades one take
// into the next where a singer is sung anew while it plays.
//
//   in:  {type: "take", slot, id, from, length, now}  a singer's sound to come: `length` samples
//                                       from the line's sample `from`. `now`: in place of what the
//                                       slot has at once; else faded into where it is ready
//        {type: "chunk", slot, id, samples}           the next of that take
//        {type: "done", slot, id}                     all of it given
//        {type: "drop", slot}                         the slot sounds no more
//        {type: "play", n, pos, loop, end, wait}      sound from `pos`, round `loop` ({from, to})
//                                       or to `end`; the slots in `wait` are waited for. `n`
//                                       comes back in what the speaker says of this playing
//        {type: "end", at}   {type: "beats", list: [{at, accent}]}
//        {type: "seek", pos} {type: "stop"}
//   out: {type: "at", pos, frame, running, stalls, rounds}   every EVERY samples of the clock
//        {type: "swapped", slot, id}    the take `id` is what the slot sounds now
//        {type: "ended"}                the line's end reached
//        {type: "error", message}
//
// "limiter": what comes in held under a ceiling, both ears by the same gain: it sees a peak
// LOOK samples before it sounds and is down to it when it does. Late by LOOK - 1 samples.

const SLOTS = 16; // singers; output SLOTS is the click
const EVERY = 1024;
const FADE = 96; // samples a start, a wait, a jump and a stop fade over
const CROSS = 240; // samples one take of a singer fades into the next over
const AHEAD = 4800; // samples every singer waited for has ready before the sound starts
const LEAST = 256; // with fewer ready than this the sound waits
const JOIN = 48; // samples each side of a loop's join fade over
const LOOK = 72;
const CLICK_HZ = [1760, 1320], CLICK_LEN = 600;

class Speaker extends AudioWorkletProcessor {
  constructor() {
    super();
    this.slots = Array.from({ length: SLOTS }, () => ({ cur: null, next: null, x: -1, joined: false, g: 0, leaving: false }));
    Object.assign(this, { on: false, running: false, stopping: false, pos: 0, loop: null, end: Infinity, jump: null, g: 0, rise: JOIN, rounds: 0, stalls: 0, since: 0, beats: [], bi: 0 });
    // 25 ms of a tone dying away, higher on a bar's first beat; a third of full scale
    this.click = CLICK_HZ.map((hz) => Float32Array.from({ length: CLICK_LEN }, (_, i) => 0.33 * Math.min(1, i / 12) * Math.exp(-i / 110) * Math.sin(2 * Math.PI * hz * i / sampleRate)));
    this.port.onmessage = ({ data: m }) => {
      try {
        this.told(m);
      } catch (e) {
        this.port.postMessage({ type: "error", message: e.message });
      }
    };
  }

  told(m) {
    const slot = m.slot === undefined ? null : this.slots[m.slot];
    if (m.slot !== undefined && !slot) throw new Error(`the speaker has no slot ${m.slot}`);
    const take = () => [slot.cur, slot.next].find((t) => t && t.id === m.id);
    if (m.type === "take") {
      if (!(Number.isInteger(m.from) && m.from >= 0 && Number.isInteger(m.length) && m.length > 0)) throw new Error(`a take of ${m.length} samples from ${m.from}`);
      const t = { id: m.id, from: m.from, data: new Float32Array(m.length), got: 0, done: false };
      if (m.now || !slot.cur) Object.assign(slot, { cur: t, next: null, x: -1, leaving: false });
      else Object.assign(slot, { next: t, x: -1 });
    } else if (m.type === "chunk") {
      const t = take();
      if (!t) return; // a take since replaced
      if (t.got + m.samples.length > t.data.length) throw new Error(`slot ${m.slot}: ${t.got + m.samples.length} samples for a take of ${t.data.length}`);
      t.data.set(m.samples, t.got);
      t.got += m.samples.length;
    } else if (m.type === "done") {
      const t = take();
      if (t) t.done = true;
    } else if (m.type === "drop") {
      if (slot.joined && this.running) slot.leaving = true;
      else Object.assign(slot, { cur: null, next: null, x: -1, joined: false, g: 0, leaving: false });
    } else if (m.type === "play") {
      Object.assign(this, { n: m.n, on: true, running: false, stopping: false, pos: m.pos, loop: m.loop, end: m.end, jump: null, g: 0, rise: JOIN, rounds: 0, stalls: 0, since: 0 });
      this.slots.forEach((s, i) => Object.assign(s, { joined: m.wait.includes(i), g: m.wait.includes(i) ? 1 : 0, leaving: false }));
      this.seekBeat();
    } else if (m.type === "end") {
      this.end = m.at;
    } else if (m.type === "beats") {
      this.beats = m.list;
      this.seekBeat();
    } else if (m.type === "seek") {
      if (this.running) this.jump = m.pos;
      else this.land(m.pos);
    } else if (m.type === "stop") {
      if (this.running) this.stopping = true;
      else this.clear();
    } else throw new Error(`the speaker is told to ${m.type}`);
  }

  clear() {
    for (const s of this.slots) Object.assign(s, { cur: null, next: null, x: -1, joined: false, g: 0, leaving: false });
    Object.assign(this, { on: false, running: false, stopping: false, jump: null, g: 0 });
  }

  land(pos) {
    Object.assign(this, { pos, jump: null, rounds: 0, rise: JOIN });
    this.seekBeat();
  }

  // the first beat whose click has not all gone by
  seekBeat() {
    this.bi = this.beats.findIndex((b) => b.at + CLICK_LEN > this.pos);
    if (this.bi < 0) this.bi = this.beats.length;
  }

  // Whether take `t` has the `n` samples from `a` on, as the line is played (round the loop, or
  // to its end). Before a take's start, and after the end of one all given, is silence it has.
  covers(t, a, n) {
    if (t.done) return true;
    const have = t.from + t.got;
    if (!this.loop) return Math.min(a + n, this.end) <= have;
    const first = Math.min(n, this.loop.to - a);
    if (a + first > have) return false;
    return n - first <= 0 || Math.min(this.loop.from + n - first, this.loop.to) <= have;
  }

  // every singer waited for has `need` samples from here
  ready(need) {
    return this.slots.every((s) => !s.joined || s.leaving || (s.cur && this.covers(s.cur, this.pos, need)));
  }

  process(_, outputs) {
    const n = outputs[0][0].length;
    if (this.on) this.block(outputs, n);
    this.since += n;
    if (this.since >= EVERY) {
      this.since = 0;
      this.port.postMessage({ type: "at", n: this.n, pos: this.pos, frame: currentFrame + n, running: this.running, stalls: this.stalls, rounds: this.rounds, on: this.on });
    }
    return true;
  }

  block(outputs, n) {
    // each singer's takes: the next one in where the one sounding has run out, or faded in where
    // it is ready; and a singer not waited for joins once it has sound here
    this.slots.forEach((s, i) => {
      if (s.next && s.x < 0) {
        if (!s.cur || !this.covers(s.cur, this.pos, LEAST)) {
          Object.assign(s, { cur: s.next, next: null });
          this.port.postMessage({ type: "swapped", n: this.n, slot: i, id: s.cur.id });
        } else if (this.pos >= s.next.from && this.covers(s.next, this.pos, CROSS + n + LEAST)) s.x = 0;
      }
      if (s.cur && !s.joined && this.pos >= s.cur.from && this.covers(s.cur, this.pos, AHEAD)) s.joined = true;
    });
    if (this.jump !== null && this.g === 0) this.land(this.jump);
    const go = !this.stopping && this.jump === null && this.ready(this.running ? LEAST : AHEAD);
    if (this.running && !go && !this.stopping && this.jump === null) {
      this.running = false;
      this.stalls++;
    } else if (!this.running && go) this.running = true;
    const target = go ? 1 : 0, d = 1 / FADE;
    for (let i = 0; i < n; i++) {
      if (this.g < target) this.g = Math.min(1, this.g + d);
      else if (this.g > target) this.g = Math.max(0, this.g - d);
      if (this.g === 0) break;
      const pos = this.pos;
      let e = this.g;
      if (this.loop && this.loop.to - pos <= JOIN) e *= (this.loop.to - pos) / JOIN;
      if (this.rise < JOIN) e *= ++this.rise / JOIN;
      for (let k = 0; k < SLOTS; k++) {
        const s = this.slots[k];
        if (!s.cur || !(s.joined || s.g > 0)) continue;
        const want = s.joined && !s.leaving ? 1 : 0;
        if (s.g < want) s.g = Math.min(1, s.g + d);
        else if (s.g > want) s.g = Math.max(0, s.g - d);
        const j = pos - s.cur.from;
        let v = j >= 0 && j < s.cur.got ? s.cur.data[j] : 0;
        if (s.x >= 0) {
          const j2 = pos - s.next.from, w = j2 >= 0 && j2 < s.next.got ? s.next.data[j2] : 0, mix = ++s.x / CROSS;
          v += (w - v) * mix;
          if (s.x >= CROSS) {
            Object.assign(s, { cur: s.next, next: null, x: -1 });
            this.port.postMessage({ type: "swapped", n: this.n, slot: k, id: s.cur.id });
          }
        }
        outputs[k][0][i] = v * e * s.g;
        if (s.leaving && s.g === 0) Object.assign(s, { cur: null, next: null, x: -1, joined: false, leaving: false });
      }
      while (this.bi < this.beats.length && this.beats[this.bi].at + CLICK_LEN <= pos) this.bi++;
      const b = this.beats[this.bi];
      if (b && b.at <= pos) outputs[SLOTS][0][i] = this.click[b.accent ? 0 : 1][pos - b.at] * e;
      this.pos++;
      if (this.loop && this.pos >= this.loop.to) {
        this.pos = this.loop.from;
        this.rounds++;
        this.rise = 0;
        this.seekBeat();
      } else if (!this.loop && this.pos >= this.end) {
        this.clear();
        this.port.postMessage({ type: "ended", n: this.n });
        return;
      }
    }
    if (this.stopping && this.g === 0) this.clear();
  }
}

class Limiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "ceiling", defaultValue: 0.89, minValue: 0.01, maxValue: 1, automationRate: "k-rate" },
      { name: "release", defaultValue: 0.08, minValue: 0.001, maxValue: 2, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.x = [new Float32Array(LOOK), new Float32Array(LOOK)];
    this.need = new Float32Array(LOOK).fill(1); // the gain each of the last LOOK samples asks for
    this.held = new Float64Array(LOOK).fill(1); // the last LOOK of the least of those, let rise slowly
    this.r = 1;
    this.i = 0;
  }

  process(inputs, outputs, params) {
    const [l, r] = [inputs[0][0], inputs[0][1] ?? inputs[0][0]], out = outputs[0], n = out[0].length;
    const c = params.ceiling[0], k = Math.exp(-1 / (params.release[0] * sampleRate));
    let sum = 0;
    for (let j = 0; j < LOOK; j++) sum += this.held[j];
    for (let s = 0; s < n; s++) {
      const a = l ? l[s] : 0, b = r ? r[s] : 0, i = this.i, peak = Math.max(Math.abs(a), Math.abs(b));
      this.x[0][i] = a;
      this.x[1][i] = b;
      this.need[i] = peak > c ? c / peak : 1;
      let least = 1;
      for (let j = 0; j < LOOK; j++) if (this.need[j] < least) least = this.need[j];
      this.r = Math.min(least, 1 - (1 - this.r) * k);
      sum += this.r - this.held[i];
      this.held[i] = this.r;
      // the sample of LOOK - 1 ago, by the mean of the gains held since it came
      const old = (i + 1) % LOOK, g = Math.min(1, sum / LOOK);
      out[0][s] = this.x[0][old] * g;
      if (out[1]) out[1][s] = this.x[1][old] * g;
      this.i = old;
    }
    return true;
  }
}

// the numbers the page and the tests go by
globalThis.SPEAKER = { SLOTS, EVERY, FADE, CROSS, AHEAD, LEAST, JOIN, LOOK };
registerProcessor("speaker", Speaker);
registerProcessor("limiter", Limiter);
