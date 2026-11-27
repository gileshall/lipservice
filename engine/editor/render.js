// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The score as a sound file, made as Sing from the start plays it: each heard singer sung by the
// page's workers, its sound laid on the speaker's line where the speaker would lay it, and the
// line mixed by mix.js's strips and chain in an OfflineAudioContext, faster than it plays. No
// click, no loop. wav.js makes the file's bytes.
//
//   placed(head, m)          the sample of the line a singer's "open" (singer.js) starts on
//   can(window)              throws where the browser cannot make a sound file
//   new Gather({window, rate, head, singers: [{slot, job, name}], tail, budget})
//     told(m)                a worker's open, chunk, done or error for one of the jobs:
//                            {progress (0 to 1, null until every singer has opened), done}
//     span()                 {start, end, samples} once every singer has opened, else null
//     line()                 once all is sung: {start, end, takes: [{slot, buffer}]}, each buffer
//                            from the line's sample 0 (the speaker's line, HEAD before beat 0), the
//                            speaker's opening rise in its samples
//   tail(chain, rate)        samples the chain sounds on after the last of the singers
//   need(samples, frames)    bytes a sound file takes to make: `samples` of the singers', `frames`
//                            of the mix
//   mixdown({window, score, line, rate, speaker})
//                            {left, right, late, length}: the mix, both ears, at `rate`, from the
//                            line's start
//   cue(head, line, late, rate)   the file's frame beat 0 is heard on

import { offline } from "./mix.js";

export const FADE = 96; // speaker.js's: samples its sound rises over where it starts
const LOOK = 72; // speaker.js's: samples its limiter sees ahead
const MB = 2 ** 20;
// Bytes a sound file may take to make: about 3 minutes of 8 singers on a phone, 12 on a desk.
export const BUDGET = { phone: 400 * MB, desk: 1500 * MB };

export const placed = (head, m) => head - m.zero + m.first;

export function can(window) {
  if (typeof window.AudioBuffer !== "function") throw new Error("this browser cannot make a sound file: it has no AudioBuffer to build one in (Safari has one from 14.1)");
  if (typeof window.OfflineAudioContext !== "function") throw new Error("this browser cannot make a sound file: it has no OfflineAudioContext to mix one in");
}

export const need = (samples, frames) => samples * 4 + frames * (8 + 4 + 4); // the singers' Float32; the mix's two Float32 ears, the file, its Blob
const mb = (bytes) => `${Math.ceil(bytes / MB)} MB`;

// The singers' sound collected as the workers make it, each written in place in its own buffer as
// it comes. Keyed by job: a worker sings several singers at once, their chunks in turn. Each
// buffer starts at the line's sample 0, at most HEAD before its sound, so that every one is
// mixed from the same first sample and none starts between two.
export class Gather {
  constructor({ window, rate, head, singers, tail = 0, budget = Infinity }) {
    can(window);
    if (!singers.length) throw new Error("a sound file of no singer");
    Object.assign(this, { window, rate, head, tail, budget, opened: 0, made: null });
    this.jobs = new Map(singers.map((s) => [s.job, { ...s, from: 0, length: 0, got: 0, buffer: null, data: null, done: false }]));
    if (this.jobs.size !== singers.length || new Set(singers.map((s) => s.slot)).size !== singers.length) throw new Error("a sound file's singers are a job and a slot each");
  }

  told(m) {
    const s = this.jobs.get(m.id);
    if (!s) throw new Error(`job ${m.id} is not the sound file's`);
    if (m.type === "error") throw Object.assign(new Error(`${s.name}: ${m.message}`), { at: m.at ?? null, slot: s.slot });
    if (s.done) throw new Error(`${s.name}: ${m.type} after its sound was all given`);
    if (m.type === "open") {
      if (s.buffer) throw new Error(`${s.name}: opened twice`);
      const from = placed(this.head, m), length = m.last - m.first;
      if (from < 0) throw new Error(`${s.name} starts ${((m.zero - this.head) / this.rate).toFixed(2)} s before the speaker's line does`);
      if (!Number.isInteger(from) || !Number.isInteger(length) || length <= 0) throw new Error(`${s.name}: a take of ${length} samples from ${from}`);
      Object.assign(s, { from, length });
      if (++this.opened === this.jobs.size) {
        const { end, samples } = this.span(), bytes = need(samples, end + this.tail);
        if (bytes > this.budget) throw new Error(`this score's sound needs ${mb(bytes)} to make here, more than this page lets itself use (${mb(this.budget)})`);
      }
      try {
        s.buffer = new this.window.AudioBuffer({ numberOfChannels: 1, length: from + length, sampleRate: this.rate });
      } catch (e) {
        throw new Error(`${s.name}: no buffer for its ${(length / this.rate).toFixed(1)} s of sound: ${e.message}`);
      }
      s.data = s.buffer.getChannelData(0).subarray(from);
    } else if (m.type === "chunk") {
      if (!s.buffer) throw new Error(`${s.name}: sound before it said where it falls`);
      const n = m.samples.length;
      if (s.got + n > s.length) throw new Error(`${s.name}: ${s.got + n} samples for a take of ${s.length}`);
      s.data.set(m.samples, s.got);
      s.got += n;
    } else if (m.type === "done") {
      if (!s.buffer) throw new Error(`${s.name}: done before it said where it falls`);
      if (s.got !== s.length) throw new Error(`${s.name}: the engine gave ${s.got} samples of the ${s.length} asked for`);
      s.done = true;
    } else throw new Error(`${s.name}: the singer said ${m.type}`);
    return { progress: this.progress(), done: [...this.jobs.values()].every((x) => x.done) };
  }

  progress() {
    if (this.opened < this.jobs.size) return null;
    let got = 0, length = 0;
    for (const s of this.jobs.values()) [got, length] = [got + s.got, length + s.length];
    return got / length;
  }

  // the line: from the earliest sample of any singer, where Sing from beat 0 starts the speaker,
  // to the latest, where it ends
  span() {
    if (this.opened < this.jobs.size) return null;
    const all = [...this.jobs.values()];
    return { start: Math.min(...all.map((s) => s.from)), end: Math.max(...all.map((s) => s.from + s.length)), samples: all.reduce((n, s) => n + s.from + s.length, 0) };
  }

  // The takes on the line. The speaker rises from nothing where it starts, by 1/FADE a sample
  // added up as it adds it, so the line's first samples are scaled as it scales them.
  line() {
    if (this.made) return this.made;
    const all = [...this.jobs.values()];
    const left = all.filter((s) => !s.done);
    if (left.length) throw new Error(`not all sung yet: ${left.map((s) => s.name).join(", ")}`);
    const { start, end } = this.span(), d = 1 / FADE;
    let g = 0;
    for (let p = start; g < 1 && p < end; p++) {
      g = Math.min(1, g + d);
      for (const s of all) if (p >= s.from && p < s.from + s.length) s.data[p - s.from] *= g;
    }
    this.made = { start, end, takes: all.map((s) => ({ slot: s.slot, buffer: s.buffer })) };
    for (const s of all) s.data = null;
    return this.made;
  }
}

// How long the chain sounds on after the singers stop, in samples: each effect that is on in
// turn. A room falls to a thousandth in its seconds, so twice that is a millionth; an echo
// repeats until its feedback has it down to a millionth. Then a tenth of a second for the
// filters' ring.
export function tail(chain, rate) {
  let secs = 0.1, samples = 0;
  for (const e of chain) {
    if (!e.on) continue;
    if (e.kind === "reverb") secs += e.predelay / 1000 + 2 * e.seconds;
    else if (e.kind === "echo") secs += (e.ms / 1000) * (1 + (e.feedback > 0 ? Math.log(1e-6) / Math.log(e.feedback) : 0));
    else if (e.kind === "limiter") samples += LOOK - 1;
    else if (e.kind === "compressor") secs += 0.006;
  }
  return Math.ceil(secs * rate) + samples;
}

// The line mixed: the browser's own nodes, as live, faster than they play. Mixed from the line's
// sample 0, and given from its start: the chain is at rest through the silence before it.
export async function mixdown({ window, score, line, rate, speaker }) {
  const length = line.end + tail(score.chain, rate), secs = `${(length / rate).toFixed(1)} s`;
  let audio;
  try {
    audio = new window.OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: rate });
  } catch (e) {
    throw new Error(`no room to mix ${secs} of sound: ${e.message}`);
  }
  if (score.chain.some((e) => e.on && e.kind === "limiter")) {
    if (!audio.audioWorklet) throw new Error("this browser cannot put the limiter in a sound file: its offline audio has no AudioWorklet");
    await audio.audioWorklet.addModule(speaker);
  }
  const { late } = offline(window, audio, score, line.takes);
  let out;
  try {
    out = await audio.startRendering();
  } catch (e) {
    throw new Error(`mixing ${secs} of sound failed: ${e.message}`);
  }
  return { left: out.getChannelData(0).subarray(line.start), right: out.getChannelData(1).subarray(line.start), late, length: length - line.start };
}

// Beat 0 in the file: the line's sample of it, from the line's start, as late as the chain holds
// the sound back.
export const cue = (head, line, late, rate) => head - line.start + Math.round(late * rate);
