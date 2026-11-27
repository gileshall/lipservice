// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// render.js, wav.js and mix.js's offline wiring: who is heard, where each singer's sound lands on
// the line and that it is what the real speaker.js plays there sample for sample, how long the
// chain rings, the WAV's bytes, and the mix made in a stand-in OfflineAudioContext
// (offline_standin.mjs) against the same mix worked out by hand and against the live Mix's nodes.
//
//     node render_test.mjs

import { EFFECTS, effect } from "./score.js";
import { Mix, strips, offline, room, glide, at0 } from "./mix.js";
import { FADE, BUDGET, Gather, placed, tail, need, mixdown, cue, can } from "./render.js";
import { wav, read, scoreOf } from "./wav.js";
import { standin } from "./offline_standin.mjs";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e; } };
const rejected = async (p) => { try { await p; return null; } catch (e) { return e; } };
const db = (x) => 10 ** (x / 20);
const RATE = 24000, HEAD = RATE;

const off = standin();
const registered = await off.processors();
const window = { OfflineAudioContext: off.OfflineAudioContext, AudioBuffer: off.AudioBuffer, AudioWorkletNode: off.AudioWorkletNode };
const SPEAKER_JS = new URL("./speaker.js", import.meta.url);
const { SLOTS, LOOK } = globalThis.SPEAKER;

// a seeded sound: n samples, as loud as `amp`
const noise = (seed, n, amp = 0.5) => {
  let s = seed >>> 0;
  return Float32Array.from({ length: n }, () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32 * 2 - 1) * amp);
};
const singer = (over = {}) => ({ level: 0, pan: 0, mute: false, solo: false, part: null, ...over });
const scoreOf3 = (over = {}) => ({ title: "t", master: 0, chain: [effect("limiter")], singers: [singer(), singer(), singer()], ...over });

// ---- who is heard
{
  const st = strips(scoreOf3({ singers: [singer({ level: -6 }), singer({ mute: true, pan: 0.5 }), singer({ level: 3, pan: -1 })] }));
  check(st.length === SLOTS && Math.abs(st[0].gain - db(-6)) < 1e-12 && st[1].gain === 0 && st[1].pan === 0.5 && Math.abs(st[2].gain - db(3)) < 1e-12 && st[2].pan === -1 && st.slice(3).every((s) => s.gain === 0 && s.pan === 0), "each singer at its level and pan; a muted one at nothing; a slot with no singer silent");
  const solo = strips(scoreOf3({ singers: [singer({ solo: true }), singer(), singer({ solo: true, mute: true })] }));
  check(solo[0].gain === 1 && solo[1].gain === 0 && solo[2].gain === 0, "soloed: the others are not heard, and a soloed singer muted is not either");
}

// ---- the singers' sound gathered on the line
const open = (id, zero, length, first = 0) => ({ type: "open", id, zero, first, last: first + length, frames: 0 });
{
  const g = new Gather({ window, rate: RATE, head: HEAD, singers: [{ slot: 0, job: 11, name: "Finn" }, { slot: 2, job: 12, name: "Cora" }] });
  check(g.told(open(11, 4000, 1000)).progress === null && g.span() === null, "how far it is is not known until every singer has said how long it is");
  const r = g.told(open(12, 3000, 3000));
  check(r.progress === 0 && !r.done && placed(HEAD, open(0, 4000, 1)) === 20000 && JSON.stringify(g.span()) === JSON.stringify({ start: 20000, end: 24000, samples: 21000 + 24000 }), "placed as the live page places it: the head less the singer's beat 0; the line from the first sample of any to the last; each held from the line's sample 0");
  g.told({ type: "chunk", id: 12, samples: new Float32Array(1500).fill(0.5) });
  check(g.told({ type: "chunk", id: 11, samples: new Float32Array(500).fill(0.5) }).progress === 0.5, "the part made of all of it");
  const long = threw(() => g.told({ type: "chunk", id: 11, samples: new Float32Array(501) }));
  check(long && long.message === "Finn: 1001 samples for a take of 1000", "more sound than was said is refused, by name");
  const short = threw(() => g.told({ type: "done", id: 12 }));
  check(short && short.message === "Cora: the engine gave 1500 samples of the 3000 asked for", "as is less");
  const err = threw(() => g.told({ type: "error", id: 12, message: "beat 3: \"la\" has no vowel", at: 1440 }));
  check(err && err.message === "Cora: beat 3: \"la\" has no vowel" && err.at === 1440 && err.slot === 2, "a singer's error names it and keeps the tick and the slot, for the page to show the note");
  check(/not the sound file's/.test(threw(() => g.told({ type: "chunk", id: 99, samples: new Float32Array(1) }))?.message), "a job not its own is refused");
  check(/before the speaker's line does/.test(threw(() => new Gather({ window, rate: RATE, head: HEAD, singers: [{ slot: 0, job: 1, name: "A" }] }).told(open(1, HEAD + 2400, 10)))?.message), "a singer that would start before the line is refused");
  check(/not all sung yet: Finn, Cora/.test(threw(() => g.line())?.message), "the line is not given before all is sung");
  const big = new Gather({ window, rate: RATE, head: HEAD, singers: [{ slot: 0, job: 1, name: "A" }, { slot: 1, job: 2, name: "B" }], tail: RATE, budget: 10 * 2 ** 20 });
  big.told(open(1, 4000, 60 * RATE));
  const over = threw(() => big.told(open(2, 4000, 60 * RATE)));
  check(over && over.message === `this score's sound needs ${Math.ceil(need(2 * (20000 + 60 * RATE), 20000 + 61 * RATE) / 2 ** 20)} MB to make here, more than this page lets itself use (10 MB)`, `a sound file over the budget is refused once its size is known: "${over?.message}"`);
  check(BUDGET.phone < BUDGET.desk && need(3 * 180 * RATE, 180 * RATE) < BUDGET.phone, "three singers for three minutes fit a phone's budget");
}

// ---- the line is what speaker.js plays from beat 0, sample for sample
{
  const takes = [{ slot: 0, job: 1, zero: 4000, n: 30000 }, { slot: 2, job: 2, zero: 7000, n: 25000 }, { slot: 5, job: 3, zero: 3000, n: 41000 }];
  const sound = takes.map((t) => noise(t.job, t.n, 0.6));
  const g = new Gather({ window, rate: RATE, head: HEAD, singers: takes.map((t) => ({ slot: t.slot, job: t.job, name: `s${t.slot}` })) });
  for (const t of takes) g.told(open(t.job, t.zero, t.n));
  // their chunks in turn, of odd sizes, as workers send them
  const at = takes.map(() => 0);
  for (let k = 0; at.some((a, i) => a < takes[i].n); k++) {
    const i = k % 3, n = Math.min(37 + (k * 101) % 900, takes[i].n - at[i]);
    if (n <= 0) continue;
    g.told({ type: "chunk", id: takes[i].job, samples: sound[i].slice(at[i], at[i] + n) });
    at[i] += n;
  }
  const last = takes.map((t) => g.told({ type: "done", id: t.job }));
  check(last[2].done && last[2].progress === 1 && !last[0].done, "done when every singer is");
  const line = g.line();
  check(line === g.line(), "the line is made once: its rise is not put on twice");
  // the speaker given the same
  const said = [], sp = off.processor("speaker", said), tell = (m) => sp.port.onmessage({ data: m });
  takes.forEach((t, i) => {
    tell({ type: "take", slot: t.slot, id: t.job, from: placed(HEAD, open(0, t.zero, t.n)), length: t.n, now: true });
    tell({ type: "chunk", slot: t.slot, id: t.job, samples: sound[i] });
    tell({ type: "done", slot: t.slot, id: t.job });
  });
  tell({ type: "play", n: 1, pos: line.start, loop: null, end: line.end, wait: takes.map((t) => t.slot) });
  const heard = Array.from({ length: SLOTS }, () => []);
  for (let b = 0; !said.some((m) => m.type === "ended") && b < 1000; b++) {
    const o = Array.from({ length: SLOTS + 1 }, () => [new Float32Array(128)]);
    sp.process([], o);
    for (let k = 0; k < SLOTS; k++) heard[k].push(...o[k][0]);
  }
  let off_ = 0, firstOff = null;
  for (const t of line.takes) {
    const x = t.buffer.getChannelData(0);
    for (let i = 0; i < line.end - line.start; i++) {
      const want = line.start + i < x.length ? x[line.start + i] : 0;
      if (heard[t.slot][i] !== want) { off_++; firstOff ??= `slot ${t.slot} sample ${i}: ${heard[t.slot][i]} for ${want}`; }
    }
  }
  check(off_ === 0 && sp.stalls === 0 && said.some((m) => m.type === "ended"), `every slot's sound as speaker.js plays it, its rise from nothing included, not one sample other${firstOff ? `: ${firstOff}` : ""}`);
  const t0 = line.takes.find((t) => t.slot === 2), raw = sound[1], x0 = t0.buffer.getChannelData(0).subarray(line.start);
  check(line.start === 17000 && t0.buffer.getChannelData(0).subarray(0, line.start).every((v) => v === 0) && x0[0] !== raw[0] && Math.abs(x0[0] - raw[0] / FADE) < 1e-7 && x0[FADE + 5] === raw[FADE + 5], "the line rises from nothing over its first samples, as the speaker's start does, and no further; silence before it");
  check(FADE === globalThis.SPEAKER.FADE && LOOK === 72, "the speaker's numbers mirrored here are speaker.js's");
}

// ---- how long the chain rings on
{
  const e = (kind, over = {}) => ({ ...effect(kind), ...over });
  const about = (got, secs, more = 0) => Math.abs(got - (secs * RATE + more)) <= 1; // a sample either way: seconds added in another order
  check(tail([], RATE) === 2400, "with no effect, a tenth of a second");
  check(about(tail([e("reverb", { seconds: 2, predelay: 50 })], RATE), 0.1 + 0.05 + 4), "a room: its predelay and twice its seconds");
  check(about(tail([e("echo", { ms: 500, feedback: 0.5 })], RATE), 0.1 + 0.5 * (1 + Math.log(1e-6) / Math.log(0.5))) && tail([e("echo", { ms: 500, feedback: 0 })], RATE) === Math.ceil(0.6 * RATE), "an echo: until its feedback has it down to a millionth; once, with none");
  check(tail([e("limiter")], RATE) === 2400 + LOOK - 1 && about(tail([e("compressor")], RATE), 0.106) && tail([e("gain"), e("filter"), e("eq")], RATE) === 2400, "the limiter and the compressor their lateness; gain, filter and eq nothing");
  check(about(tail([e("reverb", { seconds: 1 }), e("echo", { on: false }), e("limiter")], RATE), 0.1 + 0.02 + 2, LOOK - 1), "in series, the effects that are on, added");
}

// ---- the WAV's bytes
{
  const l = new Float32Array([0, 0.5, -0.5, 1.2, -1.5, 1 / 65534 * 0.99, 0.25, 0, 0, 0]), r = new Float32Array([0, -0.25, 0.1, 0, 0, 0, 0, 3e-5, 0, 0]);
  const made = wav({ channels: [l, r], rate: RATE, title: "Row", cue: 2 });
  const b = made.bytes, v = new DataView(b.buffer), tag = (at) => String.fromCharCode(...b.subarray(at, at + 4));
  check(tag(0) === "RIFF" && v.getUint32(4, true) === b.length - 8 && tag(8) === "WAVE" && tag(12) === "fmt " && v.getUint32(16, true) === 16 && v.getUint16(20, true) === 1 && v.getUint16(22, true) === 2 && v.getUint32(24, true) === RATE && v.getUint32(28, true) === RATE * 4 && v.getUint16(32, true) === 4 && v.getUint16(34, true) === 16, "RIFF WAVE, and fmt: PCM, two ears, 24000 a second, 4 bytes a frame, 16 bits");
  check(tag(36) === "cue " && v.getUint32(40, true) === 28 && v.getUint32(44, true) === 1 && v.getUint32(48, true) === 1 && v.getUint32(52, true) === 2 && tag(56) === "data" && v.getUint32(68, true) === 2, "one cue point, at beat 0's frame");
  check(tag(72) === "LIST" && tag(80) === "INFO" && tag(84) === "INAM" && v.getUint32(88, true) === 4 && tag(92) === "Row\0" && tag(96) === "ISFT" && v.getUint32(100, true) === 18 && String.fromCharCode(...b.subarray(104, 122)) === "lipservice editor\0", "LIST INFO: the title, and what made it");
  const d = 122 + 8;
  check(tag(122) === "data" && v.getUint32(126, true) === 4 * 8 && made.frames === 8 && b.length === d + 32, "the end cut where both ears are zero after it: a quiet sample that rounds to zero is cut, one that does not is kept");
  const s = (i, c) => v.getInt16(d + 4 * i + 2 * c, true);
  check(s(1, 0) === 16384 && s(2, 0) === -16383 && s(1, 1) === -8192 && s(2, 1) === 3277 && s(3, 0) === 32767 && s(4, 0) === -32767 && s(5, 0) === 0 && s(7, 1) === 1, "each sample rounded to 16 bits, both ears in turn; past full scale held at it");
  check(made.clipped === 2 && !made.ringing, "the samples past full scale counted; not ringing at the end");
  check(wav({ channels: [new Float32Array([0.1, 0.2]), new Float32Array(2)], rate: RATE, cue: 0 }).ringing, "a sound not died away by its last frame is said to be ringing");
  const back = read(b);
  check(back.rate === RATE && back.bits === 16 && back.frames === 8 && back.channels.length === 2 && back.channels[0][3] === 32767 && back.channels[1][2] === 3277 && back.title === "Row" && back.software === "lipservice editor" && back.cue === 2 && back.score === null && back.chunks.join() === "fmt ,cue ,LIST,data", "read back: all of it");
  // a title and a score of odd lengths, padded to even
  const odd = wav({ channels: [l, r], rate: RATE, title: "Rows", cue: 0, score: "lipservice score 1\ntitle Rows\né" });
  const ob = read(odd.bytes);
  check(ob.title === "Rows" && ob.score === "lipservice score 1\ntitle Rows\né" && scoreOf(odd.bytes) === ob.score && odd.bytes.length % 2 === 0 && ob.chunks.join() === "fmt ,cue ,LIST,lsco,data", "a title of odd length and the score inside, each padded to even, read back");
  check(scoreOf(b) === null, "a file with no score in it has none");
  const untitled = read(wav({ channels: [l, r], rate: RATE, cue: 0 }).bytes);
  check(untitled.title === null && untitled.software === "lipservice editor", "no title, no INAM");
  check(/silence/.test(threw(() => wav({ channels: [new Float32Array(4), new Float32Array(4)], rate: RATE, cue: 0 }))?.message) && /not a number/.test(threw(() => wav({ channels: [new Float32Array([NaN]), new Float32Array(1)], rate: RATE, cue: 0 }))?.message) && /outside/.test(threw(() => wav({ channels: [l, r], rate: RATE, cue: 8 }))?.message), "silence, a sample that is not a number, and beat 0 past the end are refused");
  check(/not a WAV/.test(threw(() => read(new TextEncoder().encode("lipservice score 1\n")))?.message) && /says it is \d+ bytes and is 140/.test(threw(() => read(b.slice(0, 140)))?.message) && /16-bit PCM/.test(threw(() => { const x = b.slice(); new DataView(x.buffer).setUint16(34, 24, true); return read(x); })?.message), "read refuses what is not a WAV, one cut short, and samples it does not read");
}

// ---- the mix of a sound file, on the stand-in, against the same worked out by hand
const mixed = async (score, takes) => {
  const g = new Gather({ window, rate: RATE, head: HEAD, singers: takes.map((t, i) => ({ slot: t.slot, job: i + 1, name: `s${t.slot}` })) });
  takes.forEach((t, i) => g.told(open(i + 1, t.zero, t.sound.length)));
  takes.forEach((t, i) => { g.told({ type: "chunk", id: i + 1, samples: t.sound }); g.told({ type: "done", id: i + 1 }); });
  const line = g.line();
  return { line, out: await mixdown({ window, score, line, rate: RATE, speaker: SPEAKER_JS }) };
};
// the stereo sum on the bus, by the spec's equal-power law for a mono sound
const bus = (score, line, n) => {
  const st = strips(score), L = new Float64Array(n), R = new Float64Array(n);
  for (const t of line.takes) {
    const x = t.buffer.getChannelData(0).subarray(line.start), a = (Math.fround(st[t.slot].pan) + 1) / 2 * Math.PI / 2, g = Math.fround(st[t.slot].gain);
    for (let i = 0; i < x.length; i++) { L[i] += x[i] * g * Math.cos(a); R[i] += x[i] * g * Math.sin(a); }
  }
  return [L, R];
};
{
  const score = scoreOf3({ master: -3, chain: [{ ...effect("limiter"), ceiling: -6, release: 50 }], singers: [singer({ level: -2, pan: -0.4 }), singer({ level: 3, pan: 0.7 }), singer({ mute: true })] });
  const takes = [{ slot: 0, zero: 4000, sound: noise(1, 20000, 0.5) }, { slot: 1, zero: 6000, sound: noise(2, 24000, 0.5) }, { slot: 2, zero: 5000, sound: noise(3, 20000, 0.9) }];
  const { line, out } = await mixed(score, takes);
  check(out.length === line.end - line.start + tail(score.chain, RATE) && out.left.length === out.length && Math.abs(out.late - (LOOK - 1) / RATE) < 1e-12, "as long as the line and the chain's ring, as late as the limiter");
  const [L, R] = bus(score, line, out.length);
  const lim = off.processor("limiter"), want = [new Float64Array(out.length), new Float64Array(out.length)], m = Math.fround(db(-3));
  for (let i = 0; i < out.length; i += 128) {
    const o = [new Float32Array(128), new Float32Array(128)];
    lim.process([[Float32Array.from(L.subarray(i, i + 128)), Float32Array.from(R.subarray(i, i + 128))]], [o], { ceiling: [Math.fround(db(-6))], release: [Math.fround(0.05)] });
    for (let c = 0; c < 2; c++) for (let s = 0; s < 128 && i + s < out.length; s++) want[c][i + s] = o[c][s] * m;
  }
  let worst = 0;
  for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out.left[i] - want[0][i]), Math.abs(out.right[i] - want[1][i]));
  check(worst < 2e-6 && out.left[LOOK - 1] !== 0, `from its first sample, each singer at its level and pan, the muted one not heard, the limiter, then the master: as worked out by hand, nothing gliding there (off by ${worst.toExponential(1)} at most)`);
  check(Math.max(...out.left.map(Math.abs), ...out.right.map(Math.abs)) <= db(-6) * db(-3) + 1e-6, "the limiter holds it under its ceiling");
  check(cue(HEAD, line, out.late, RATE) === HEAD - line.start + LOOK - 1, "beat 0 in the file: the head from the line's start, as late as the chain holds it");
}

// an echo and a room, worked out by hand: an echo's delay feeds itself; a room is its impulse
// convolved, sample by sample
{
  const echo = { ...effect("echo"), ms: 250, feedback: 0.2, mix: 0.3 }, rev = { ...effect("reverb"), seconds: 0.2, predelay: 125, damp: 6000, mix: 0.25 };
  const score = { title: "", master: 0, chain: [echo, rev], singers: [singer()] };
  const { line, out } = await mixed(score, [{ slot: 0, zero: 4000, sound: noise(9, 3000, 0.3) }]);
  const n = out.length, [L, R] = bus(score, line, n), D = 6000, P = 3000;
  const ir = room(new off.OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: RATE }), 0.2, 6000);
  const fx = (x, c) => {
    const d = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n), h = ir.getChannelData(c);
    const [dry, wet] = [Math.fround(Math.cos(0.3 * Math.PI / 2)), Math.fround(Math.sin(0.3 * Math.PI / 2))];
    for (let t = 0; t < n; t++) {
      d[t] = t >= D ? x[t - D] + Math.fround(0.2) * d[t - D] : 0;
      y[t] = dry * x[t] + wet * d[t];
    }
    const [rd, rw] = [Math.fround(Math.cos(0.25 * Math.PI / 2)), Math.fround(Math.sin(0.25 * Math.PI / 2))];
    for (let t = 0; t < n; t++) {
      let s = 0;
      for (let k = 0; k < h.length && k <= t - P; k++) s += h[k] * y[t - P - k];
      z[t] = rd * y[t] + rw * s;
    }
    return z;
  };
  const want = [fx(L, 0), fx(R, 1)];
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(out.left[i] - want[0][i]), Math.abs(out.right[i] - want[1][i]));
  check(worst < 1e-5 && out.late === 0, `an echo and a room as worked out by hand (off by ${worst.toExponential(1)} at most), each ear its own room`);
}

// ---- the sound file's nodes are the live mix's, less the speaker, the meters and the click
{
  const chain = Object.keys(EFFECTS).map((k) => ({ ...effect(k), on: true }));
  chain.push({ ...effect("gain"), on: false });
  const score = { title: "", master: -2.5, chain, singers: [singer({ level: -4, pan: 0.3 }), singer({ mute: true }), singer({ level: 2, pan: -0.8 })] };
  const A = new off.OfflineAudioContext({ numberOfChannels: 2, length: 128, sampleRate: RATE }), B = new off.OfflineAudioContext({ numberOfChannels: 2, length: 128, sampleRate: RATE });
  await A.audioWorklet.addModule(SPEAKER_JS);
  await B.audioWorklet.addModule(SPEAKER_JS);
  const mix = new Mix(window, A);
  mix.set(score, 0.4);
  const buf = () => new off.AudioBuffer({ numberOfChannels: 1, length: 10, sampleRate: RATE });
  const o = offline(window, B, score, [{ slot: 0, buffer: buf() }, { slot: 2, buffer: buf() }]);
  const kinds = (fx) => fx.map((f) => f.kind).join();
  check(kinds(mix.fx) === kinds(o.chain.fx) && kinds(o.chain.fx) === Object.keys(EFFECTS).join(), "the same effects, in the same order, the one off left out");
  const params = (node) => [...Object.entries(node).filter(([, p]) => p instanceof off.Param), ...(node.parameters ? [...node.parameters] : [])];
  const last = (p, how) => p.calls.filter((c) => c[0] === how).at(-1)?.[1];
  let same = true, puts = true, why = "";
  mix.fx.forEach((f, i) => {
    const g = o.chain.fx[i];
    f.nodes.forEach((node, j) => {
      const other = g.nodes[j];
      if (node.kind !== other.kind || node.type !== other.type || node.normalize !== other.normalize) { same = false; why ||= `${f.kind} node ${j}`; }
      for (const [k, p] of params(node)) {
        const q = other.parameters?.get(k) ?? other[k];
        if (last(p, "setTargetAtTime") !== last(q, "setValueAtTime")) { same = false; why ||= `${f.kind} ${k}`; }
        if (q.calls.some((c) => c[0] !== "setValueAtTime" || c[2] !== 0) || p.calls.some((c) => c[0] === "setValueAtTime")) puts = false;
      }
      // what each node is joined to, as places in the chain
      const where = (fx, master, n) => { if (n === master) return "master"; for (let a = 0; a < fx.length; a++) { const b = fx[a].nodes.indexOf(n); if (b >= 0) return `${a}.${b}`; } return n.kind; };
      const joins = (fx, master, n) => n.to.map(([t, out, inp]) => `${where(fx, master, t)}:${out}:${inp}`).join();
      if (joins(mix.fx, mix.master, node) !== joins(o.chain.fx, o.chain.out, other)) { same = false; why ||= `${f.kind} node ${j}'s joins`; }
    });
  });
  check(same, `every effect's nodes the same kinds, joined the same way, at the same values${why ? `: not ${why}` : ""}`);
  check(puts, "live they glide to their values; in the sound file each is put there at time 0");
  const room1 = mix.fx.find((f) => f.kind === "reverb").nodes[5].buffer, room2 = o.chain.fx.find((f) => f.kind === "reverb").nodes[5].buffer;
  check(room1.getChannelData(0).every((x, i) => x === room2.getChannelData(0)[i]) && room1.getChannelData(1).every((x, i) => x === room2.getChannelData(1)[i]), "the same room, sample for sample");
  check(mix.bus.to[0][0] === mix.fx[0].in && o.chain.in.to[0][0] === o.chain.fx[0].in && o.chain.fx.at(-1).out.to[0][0] === o.chain.out && last(o.chain.out.gain, "setValueAtTime") === last(mix.master.gain, "setTargetAtTime") && o.chain.out.to.length === 1 && o.chain.out.to[0][0] === B.destination, "the bus into the chain, the chain into the master at the same level, the master to the output");
  const src = B.made.filter((n) => n.kind === "source");
  const strip = (s) => [last(s.to[0][0].gain, "setValueAtTime"), last(s.to[0][0].to[0][0].pan, "setValueAtTime"), s.to[0][0].to[0][0].to[0][0] === o.chain.in];
  check(JSON.stringify(src.map(strip)) === JSON.stringify([0, 2].map((i) => [last(mix.strips[i].level.gain, "setTargetAtTime"), last(mix.strips[i].pan.pan, "setTargetAtTime"), true])) && src.every((s) => s.at === 0), "each singer's level and pan as live, into the bus; each from the first sample");
  check(!B.made.some((n) => ["analyser", "split", "speaker"].includes(n.kind)) && B.made.filter((n) => n.kind === "gain").length === A.made.filter((n) => n.kind === "gain").length - SLOTS - 1 + 2, "no speaker, no meters, no click");
  check(glide(1)({ setTargetAtTime: (...a) => a }, 0.5).join() === "0.5,1,0.012" && at0({ setValueAtTime: (...a) => a }, 0.5).join() === "0.5,0", "a value glides there live, and is put there at once in a file");
}

// ---- what the browser may not have, and a mix that fails
{
  check(/no AudioBuffer/.test(threw(() => can({ OfflineAudioContext: off.OfflineAudioContext }))?.message) && /no OfflineAudioContext/.test(threw(() => can({ AudioBuffer: off.AudioBuffer }))?.message) && !threw(() => can(window)), "a browser with no AudioBuffer or OfflineAudioContext is told so");
  const line = { start: 0, end: 100, takes: [] };
  const failing = { ...window, OfflineAudioContext: class extends off.OfflineAudioContext { startRendering() { return Promise.reject(new Error("out of memory")); } } };
  const e = await rejected(mixdown({ window: failing, score: { master: 0, chain: [], singers: [] }, line, rate: RATE, speaker: SPEAKER_JS }));
  check(e && e.message === `mixing ${((100 + 2400) / RATE).toFixed(1)} s of sound failed: out of memory`, `a mix that fails says how long it was: "${e?.message}"`);
  const noWorklet = { ...window, OfflineAudioContext: class extends off.OfflineAudioContext { constructor(o) { super(o); this.audioWorklet = undefined; } } };
  const f = await rejected(mixdown({ window: noWorklet, score: { master: 0, chain: [effect("limiter")], singers: [] }, line, rate: RATE, speaker: SPEAKER_JS }));
  check(f && /cannot put the limiter in a sound file/.test(f.message), "a browser that cannot run the limiter offline says so, and does not leave it out");
  const biquad = await rejected(mixdown({ window, score: { master: 0, chain: [effect("filter")], singers: [] }, line, rate: RATE, speaker: SPEAKER_JS }));
  check(biquad && /makes no biquad's sound/.test(biquad.message), "the stand-in refuses to make a filter's sound rather than make another's");
}

// ---- the stand-in inside another's: the processors its registerProcessor gave, its own AudioWorkletNode for a live context
{
  class Live { constructor(context, name) { Object.assign(this, { context, name }); } }
  class Through { static get parameterDescriptors() { return [{ name: "ceiling", defaultValue: 1 }, { name: "release", defaultValue: 0.1 }]; } process([x], [y]) { y[0].set(x[0]); y[1].set(x[1]); return true; } }
  const hosted = standin({ processors: new Map([["limiter", Through]]), live: Live });
  const w = { OfflineAudioContext: hosted.OfflineAudioContext, AudioBuffer: hosted.AudioBuffer, AudioWorkletNode: hosted.AudioWorkletNode };
  const other = new w.AudioWorkletNode({ live: true }, "speaker");
  const g = new Gather({ window: w, rate: RATE, head: HEAD, singers: [{ slot: 0, job: 1, name: "A" }] });
  g.told(open(1, 4000, 300));
  g.told({ type: "chunk", id: 1, samples: new Float32Array(300).fill(0.5) });
  g.told({ type: "done", id: 1 });
  const out = await mixdown({ window: w, score: { master: 0, chain: [effect("limiter")], singers: [singer()] }, line: g.line(), rate: RATE, speaker: SPEAKER_JS });
  check(other instanceof Live && other.name === "speaker" && Math.abs(out.left[200] - 0.5 * Math.SQRT1_2) < 1e-6 && out.left[300] === 0, "a stand-in given another's processors renders the limiter by them, and a node of a live context is that one's");
}

console.log(fails ? `\n${fails} failed` : "\nall ok");
process.exit(fails ? 1 : 0);
