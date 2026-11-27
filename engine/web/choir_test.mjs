// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The choir's seats and mixing, the tape, the deck's start rule, jumps and changes, and the
// conductor, against the real player.js and room.js (the engine's mixer and room, in the wasm) and
// scripted workers on a virtual clock; no models, no browser. node choir_test.mjs LIPSERVICE.wasm
import { readFileSync } from "node:fs";
import { Choir, Mixer, FADE, SR, REFL_SUM, WARM, makeSeats, coprimeStep, taps, workersFor } from "./choir.js";
import { Engine } from "./lipservice.js";
import { Room, BLOCK, TAIL, TRACE, setEngine } from "./room.js";
import { Take, add, within } from "./take.js";
import { asked } from "./perform.js";
import { Deck, XF, LATE } from "./deck.js";
import { Conductor } from "./conduct.js";

if (!process.argv[2]) { console.error("usage: node choir_test.mjs LIPSERVICE.wasm"); process.exit(2); }
setEngine(await Engine.create(readFileSync(process.argv[2])));

// player.js as the browser runs it: its port, process() and messages
let Player = null;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => this.posted.push(m), onmessage: null }; this.posted = []; } };
globalThis.registerProcessor = (_, c) => { Player = c; };
await import("./player.js");

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const maxJump = (y) => { let m = 0; for (let i = 1; i < y.length; i++) m = Math.max(m, Math.abs(y[i] - y[i - 1])); return m; };
const maxAbs = (y) => y.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const wave = (p, i) => 0.4 * Math.sin(0.013 * (p + 1) * i) + 0.1 * (p % 2 ? 1 : -1); // part p's sample i, within +-0.5
const cat = (xs) => { const y = new Float32Array(xs.reduce((a, x) => a + x.length, 0)); let k = 0; for (const x of xs) { y.set(x, k); k += x.length; } return y; };

// ---- seats

// choirkit.make_seats(n, pan_max=0.85): [row, pan (to 4 places), gain, send, delay_ms], left to right
const PY4 = [[0, -0.85, 1, 0.6, 0], [0, -0.3214, 1, 0.6, 0], [0, 0.3214, 1, 0.6, 0], [0, 0.85, 1, 0.6, 0]];
const PY60_PAN = [-0.85, -0.8295, -0.8068, -0.7863, -0.7604, -0.7402, -0.7111, -0.6914, -0.659, -0.6401, -0.6043, -0.5864, -0.5472, -0.5306, -0.488, -0.4729, -0.4268, -0.4134, -0.364, -0.3524, -0.2998, -0.2901, -0.2344, -0.2267, -0.1681, -0.1625, -0.1011, -0.0978, -0.0338, -0.0326, 0.0326, 0.0338, 0.0978, 0.1011, 0.1625, 0.1681, 0.2267, 0.2344, 0.2901, 0.2998, 0.3524, 0.364, 0.4134, 0.4268, 0.4729, 0.488, 0.5306, 0.5472, 0.5864, 0.6043, 0.6401, 0.659, 0.6914, 0.7111, 0.7402, 0.7604, 0.7863, 0.8068, 0.8295, 0.85];
const PY60_ROW = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
{
  const s4 = makeSeats(4);
  check(s4.every((s, i) => s.row === PY4[i][0] && Math.abs(s.pan - PY4[i][1]) < 5e-5 && s.gain === PY4[i][2] && s.send === PY4[i][3] && s.delayMs === PY4[i][4]), "seats: four, as choirkit.make_seats");
  const s60 = makeSeats(60);
  check(s60.every((s, i) => s.row === PY60_ROW[i] && Math.abs(s.pan - PY60_PAN[i]) < 5e-5 && Math.abs(s.gain - (1 - 0.1 * s.row)) < 1e-12 && Math.abs(s.send - (0.6 + 0.2 * s.row)) < 1e-12 && s.delayMs === 3 * s.row), "seats: sixty on two rows, staggered, the back row quieter, wetter and later, as choirkit.make_seats");
  check(s60.every((s) => s.itdMs === 0.35 * Math.abs(s.pan) && s.refl.length === 2 && s.refl[0].gain === 0.25 && s.refl[1].gain === 0.18
    && s.refl[0].delayMs >= 7 && s.refl[0].delayMs <= 19 && s.refl[1].delayMs >= 21 && s.refl[1].delayMs <= 37 && s.refl.every((r) => Math.abs(r.pan) <= 0.95)), "seats: the far ear later by the pan, two reflections in choirkit's ranges");
  check(JSON.stringify(makeSeats(16, 0.32)) === JSON.stringify(makeSeats(16, 0.32)) && Math.max(...makeSeats(16, 0.32).map((s) => Math.abs(s.pan))) === 0.32, "seats: the same each time, pan to at most panMax");
  check([4, 5, 8, 16, 25, 60, 100].map((n) => coprimeStep(n)).join() === "1,2,3,7,9,23,37", "coprimeStep: as choirkit.coprime_step");
}
{
  const seat = { pan: 0.5, gain: 0.9, send: 0.8, delayMs: 3, itdMs: 0.175, refl: [{ delayMs: 10, pan: -0.3, gain: 0.25 }, { delayMs: 30, pan: 0, gain: 0.18 }] };
  const t = taps(2, seat);
  const legs = [0, 2, 4].map((k) => [t[k], t[k + 1]]);
  check(t.length === 6 && t.every((x, i) => x.ch === i % 2), "taps: the direct sound and two reflections, left and right each");
  check(legs.every(([l, r], k) => Math.abs(l.g * l.g + r.g * r.g - (2 * 0.9 * [1, 0.25, 0.18][k]) ** 2) < 1e-12), "taps: each leg's power is its gain, panned by equal power");
  check(legs[0][0].d === 72 + 4 && legs[0][1].d === 72 && legs[0][1].g > legs[0][0].g, "taps: a seat on the right is louder there and the left ear hears it later");
  check(legs[1][0].d === 72 + 240 && legs[1][1].d === 72 + 240 + 3 && legs[2][0].d === legs[2][1].d && Math.abs(legs[2][0].g - legs[2][1].g) < 1e-15, "taps: a reflection from the left is later on the right; one from the middle is the same on both");
}

// ---- Mixer

// a part's level at s of its own: straight from one of its levels to the next, held outside them
function levelOf(k, t) {
  if (!k || t <= k[0][0]) return k ? k[0][1] : 1;
  for (let i = 1; i < k.length; i++) if (t < k[i][0]) return k[i - 1][1] + (k[i][1] - k[i - 1][1]) * (t - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
  return k.at(-1)[1];
}
// The mix in one go: each part from its start, through its taps, faded in and out, at its levels,
// summed in float64.
function reference(parts, specs) {
  const t0 = Math.min(...specs.map((s) => s.start));
  const tp = specs.map((s) => taps(s.gain, s.seat));
  const off = specs.map((s) => Math.round((s.start - t0) * SR));
  const total = Math.max(...parts.map((x, p) => off[p] + x.length + Math.max(...tp[p].map((q) => q.d))));
  const bus = [0, 1, 2, 3].map(() => new Float64Array(total));
  parts.forEach((x, p) => {
    for (const { ch, g, d } of tp[p]) {
      for (let s = 0; s < x.length; s++) {
        let v = x[s];
        if (s < FADE) v *= s / FADE;
        if (s >= x.length - FADE) v *= (x.length - 1 - s) / FADE;
        v *= levelOf(specs[p].levels, s / SR);
        bus[ch][off[p] + d + s] += g * v;
        bus[2 + ch][off[p] + d + s] += g * specs[p].seat.send * v;
      }
    }
  });
  return bus.map((b) => Float32Array.from(b));
}
// The mixer fed the parts in chunks of `cuts`, round robin, each part opened just before its first
// chunk, taking what it gives after every push.
function mixAll(parts, specs, cuts) {
  const m = new Mixer(specs), out = [[], [], [], []];
  const pos = parts.map(() => 0);
  const take = () => { for (let y; (y = m.take()); ) y.forEach((b, c) => out[c].push(b)); };
  for (let more = true; more; ) {
    more = false;
    parts.forEach((x, i) => {
      if (pos[i] >= x.length) return;
      more = true;
      if (pos[i] === 0) m.open(i, specs[i].start, x.length);
      const n = Math.min(cuts[i % cuts.length], x.length - pos[i]);
      m.push(i, x.slice(pos[i], pos[i] + n));
      pos[i] += n;
      if (pos[i] === x.length) m.end(i);
      take();
    });
  }
  take();
  return { y: out.map(cat), m };
}
const near = (a, b, tol) => a.length === b.length && a.every((x, c) => maxDiff(x, b[c]) <= tol);
{
  const seats = makeSeats(6, 0.85);
  const parts = [5000, 3100, 7000, 192, 40, 4097].map((n, p) => Float32Array.from({ length: n }, (_, i) => wave(p, i)));
  const specs = parts.map((_, p) => ({ gain: 1 / (6 * REFL_SUM), seat: seats[p], start: [0.5, 0.5, 0.52, 0.6, 0.55, 0.501][p] }));
  const ref = reference(parts, specs), whole = mixAll(parts, specs, [100000]).y;
  check(near(whole, ref, 1.2e-7), `mixer: the parts from their starts, seats and fades, as the mix in one go (${ref[0].length} samples, ${Math.max(...whole.map((x, c) => maxDiff(x, ref[c]))).toExponential(1)})`);
  for (const cuts of [[2400], [1], [7, 1000, 31], [192], [193, 191]]) {
    const { y, m } = mixAll(parts, specs, cuts);
    check(near(y, ref, 1.2e-7) && m.finished, `mixer: chunks of ${cuts} give the same mix`);
  }
}
{
  // a part's levels: its gain times a factor that moves in straight lines over its own time
  const seats = makeSeats(3, 0.85);
  const parts = [9000, 6000, 7000].map((n, p) => Float32Array.from({ length: n }, (_, i) => wave(p, i)));
  const levels = [[[0.05, 1], [0.1, 0.25], [0.2, 0.25], [0.3, 2]], null, [[0, 0.5]]];
  const specs = parts.map((_, p) => ({ gain: 1 / (3 * REFL_SUM), levels: levels[p], seat: seats[p], start: [0.5, 0.52, 0.6][p] }));
  const ref = reference(parts, specs), flat = reference(parts, specs.map((s) => ({ ...s, levels: null })));
  check(!near(ref, flat, 1e-3), "levels: the mix they are checked against is not the mix without them");
  for (const cuts of [[100000], [1], [7, 1000, 31], [2400]]) {
    const { y, m } = mixAll(parts, specs, cuts);
    check(near(y, ref, 1.2e-7) && m.finished, `levels: chunks of ${cuts} give each part at its levels`);
  }
  const { m } = mixAll([new Float32Array(4800).fill(0.5)], [{ gain: 2, levels: [[0, 1], [0.2, 0]], seat: seats[0], start: 0 }], [700]);
  check(Array.from(m.parts[0].lv).every((v, j) => Math.abs(v - 2 * 0.5 * levelOf([[0, 1], [0.2, 0]], (j + 0.5) * TRACE / SR)) < 1e-6), "levels: a part's trace is its level as mixed");
  for (const bad of [[], [[0.2, 1], [0.1, 1]], [[0, -1]], [[0, NaN]], [[-1, 1]], [[0.1, 1], [0.1, 0.5]]]) {
    let threw = false;
    try { new Mixer([{ gain: 1, levels: bad, seat: seats[0] }]); } catch { threw = true; }
    check(threw, `levels: ${JSON.stringify(bad)} are refused`);
  }
}
{
  const seat = makeSeats(1)[0], one = { gain: 1, seat, start: 0 };
  const { y } = mixAll([new Float32Array(3000).fill(0.5)], [one], [500]);
  check(y.every((b) => b[0] === 0 && b.at(-1) === 0), "mixer: every bus starts and ends at 0");
  const steps = taps(1, seat).reduce((a, t) => a + Math.abs(t.g), 0) * 0.5 / FADE;
  check(maxJump(y[0]) <= steps + 1e-7, `mixer: no step beyond the fades' slopes (${maxJump(y[0]).toExponential(2)})`);
}
{
  // at a gain of 1/(N REFL_SUM), N parts at full scale stay within it on every bus
  const n = 8, seats = makeSeats(n);
  const parts = Array.from({ length: n }, () => new Float32Array(5000).fill(1));
  const { y } = mixAll(parts, parts.map((_, p) => ({ gain: 1 / (n * REFL_SUM), seat: seats[p], start: 0 })), [333]);
  check(y.every((b) => maxAbs(b) <= 1), `mixer: ${n} parts at full scale sum to at most full scale (${y.map((b) => maxAbs(b).toFixed(3))})`);
}
{
  const seats = makeSeats(2), m = new Mixer([{ gain: 1, seat: seats[0] }, { gain: 1, seat: seats[1] }]);
  m.open(0, 1, 5000);
  m.push(0, new Float32Array(5000).fill(0.5));
  check(m.take() === null, "mixer: gives nothing until every part is open");
  m.open(1, 1.1, 400);
  m.push(1, new Float32Array(100).fill(0.5));
  const a = m.take();
  check(a && a[0].length === 2400 + 100, `mixer: gives as far as the part furthest behind has reached (${a?.[0].length})`);
  m.end(0);
  check(m.take() === null, "mixer: a part that has ended holds nothing back, one still going does");
  m.push(1, new Float32Array(300).fill(0.5));
  m.end(1);
  let n = a[0].length;
  for (let y; (y = m.take()); ) n += y[0].length;
  const reach = (i) => Math.max(...taps(1, seats[i]).map((t) => t.d));
  check(n === Math.max(5000 + reach(0), 2400 + 400 + reach(1)) && m.finished, `mixer: all of it in the end, to the last reflection (${n})`);
  const threw = (f) => { try { f(); return false; } catch { return true; } };
  const fresh = () => { const x = new Mixer([{ gain: 1, seat: seats[0] }]); x.open(0, 0, 10); return x; };
  check(threw(() => m.push(0, new Float32Array(1))), "mixer: a part cannot go on after it ended");
  check(threw(() => new Mixer([{ gain: 1, seat: seats[0] }]).push(0, new Float32Array(1))), "mixer: a part must be opened first");
  check(threw(() => fresh().open(0, 0, 10)), "mixer: a part opens once");
  check(threw(() => fresh().push(0, new Float32Array(11))), "mixer: a part cannot run past its length");
  check(threw(() => { const x = fresh(); x.push(0, new Float32Array(9)); x.end(0); }), "mixer: a part cannot end short of its length");
}

{ // a mix picked up at one of its samples: the parts come in at their own, and it is the whole mix from there on
  const seats = makeSeats(4, 0.85);
  const parts = [9600, 7200, 12000, 4800].map((n, p) => Float32Array.from({ length: n }, (_, i) => wave(p, i)));
  const specs = parts.map((_, p) => ({ gain: 1 / (4 * REFL_SUM), seat: seats[p], start: [0.5, 0.52, 0.6, 0.9][p] }));
  const ref = reference(parts, specs), t0 = 0.5;
  for (const from of [0, 2400, 6000, 11520, 16800]) {
    const m = new Mixer(specs, { t0, from }), out = [[], [], [], []];
    const pos = parts.map((x, i) => Math.max(0, Math.min(x.length, Math.floor((from - Math.round((specs[i].start - t0) * SR)) / TRACE) * TRACE)));
    parts.forEach((x, i) => m.open(i, specs[i].start, x.length, pos[i]));
    for (let more = true; more; ) {
      more = false;
      parts.forEach((x, i) => {
        if (m.parts[i].done) return;
        more = true;
        if (pos[i] === x.length) { m.end(i); return; }
        const n = Math.min(700, x.length - pos[i]);
        m.push(i, x.slice(pos[i], pos[i] + n));
        pos[i] += n;
        for (let y; (y = m.take()); ) y.forEach((b, c) => out[c].push(b));
      });
    }
    for (let y; (y = m.take()); ) y.forEach((b, c) => out[c].push(b));
    const y = out.map(cat), want = ref.map((b) => b.subarray(from));
    // a reflection of a sample before the pick-up that lands after it is not in the mix: the room's run-up covers it
    const reach = Math.max(...m.parts.map((q) => q.reach));
    const d = Math.max(...y.map((b, c) => maxDiff(b.subarray(reach), want[c].subarray(reach))));
    check(y[0].length === want[0].length && d <= 1.2e-7 && m.finished, `mixer: picked up at sample ${from}, the mix from there on (${y[0].length} samples, ${d.toExponential(1)} past the reflections)`);
  }
  const m = new Mixer(specs, { t0, from: 2400 });
  let threw = false;
  try { m.open(0, 0.5, 9600, 100); } catch { threw = true; }
  check(threw, "mixer: a part is picked up at a whole number of trace frames");
}

check(workersFor(4, 8) === 4 && workersFor(8, 8) === 4 && workersFor(8, 4) === 3 && workersFor(4, 2) === 1 && workersFor(2, 16) === 2 && workersFor(8, 1) === 1, "workers: a part each to the cores less one, at most 4");

// ---- the speaker in stereo, and spliced
const playerOf = () => { const p = new Player(); return p; };
const run = (p, quanta) => { const L = [], R = []; for (let k = 0; k < quanta; k++) { const a = new Float32Array(128), b = new Float32Array(128); p.process([], [[a, b]]); L.push(...a); R.push(...b); } return [L, R]; };
{
  const p = playerOf();
  const l = Float32Array.from({ length: 1000 }, (_, i) => 0.5 * Math.sin(i / 10)), r = l.map((v) => -v);
  p.port.onmessage({ data: { type: "chunk", id: 1, samples: l, right: r } });
  p.port.onmessage({ data: { type: "chunk", id: 1, samples: l } });
  p.port.onmessage({ data: { type: "end", id: 1 } });
  const [L, R] = run(p, 20);
  check(L.slice(FADE, 1000).every((v, i) => v === l[FADE + i] && R[FADE + i] === r[FADE + i]), "player: a chunk with right plays its two channels");
  check(L.slice(1000, 2000 - FADE).every((v, i) => v === R[1000 + i] && v === l[i]), "player: a chunk without plays the same on both");
  let threw = false;
  try { p.port.onmessage({ data: { type: "chunk", id: 2, samples: l, right: r.subarray(1) } }); } catch { threw = true; }
  check(threw, "player: the channels must match in length");
}
{
  const a = Float32Array.from({ length: 6000 }, (_, i) => 0.25 + 0.0001 * i), b = Float32Array.from({ length: 3000 }, (_, i) => -0.25 - 0.0001 * i);
  const ended = (p) => p.posted.filter((m) => m.type === "ended");
  { // ahead of where it plays, across chunks: the old up to the splice, the new from it
    const p = playerOf();
    p.port.onmessage({ data: { type: "chunk", id: 1, samples: a.slice(0, 2000) } });
    p.port.onmessage({ data: { type: "chunk", id: 1, samples: a.slice(2000) } });
    const [h0] = run(p, 8); // 1024 played
    p.port.onmessage({ data: { type: "splice", id: 1, at: 2500, samples: b.slice() } });
    p.port.onmessage({ data: { type: "end", id: 1 } });
    const [h1] = run(p, 50), h = [...h0, ...h1];
    check(h.slice(FADE, 2500).every((v, i) => v === a[FADE + i]) && h.slice(2500, 5500 - FADE).every((v, i) => v === b[i]) && ended(p).length === 1 && ended(p)[0].stalls === 0, "splice: the old sound up to it and the new from it, sample for sample, and no stall");
    check(h.slice(5500).every((v) => v === 0), "splice: what was queued past it is dropped");
  }
  { // inside the chunk being played
    const p = playerOf();
    p.port.onmessage({ data: { type: "chunk", id: 1, samples: a.slice() } });
    const [h0] = run(p, 8);
    p.port.onmessage({ data: { type: "splice", id: 1, at: 1100, samples: b.slice() } });
    p.port.onmessage({ data: { type: "end", id: 1 } });
    const h = [...h0, ...run(p, 40)[0]];
    check(h.slice(FADE, 1100).every((v, i) => v === a[FADE + i]) && h.slice(1100, 4100 - FADE).every((v, i) => v === b[i]), "splice: inside the chunk that is playing");
  }
  { // too late: what of the new is already played is skipped
    const p = playerOf();
    p.port.onmessage({ data: { type: "chunk", id: 1, samples: a.slice() } });
    const [h0] = run(p, 8);
    p.port.onmessage({ data: { type: "splice", id: 1, at: 1000, samples: b.slice() } });
    p.port.onmessage({ data: { type: "end", id: 1 } });
    const h = [...h0, ...run(p, 40)[0]];
    check(h.slice(FADE, 1024).every((v, i) => v === a[FADE + i]) && h.slice(1024, 4000 - FADE).every((v, i) => v === b[24 + i]) && ended(p).length === 1, "splice: one that comes late plays from where the speaker is");
  }
  { // at the end of what is queued, after the end was said: it goes on, and ends when told again
    const p = playerOf();
    p.port.onmessage({ data: { type: "chunk", id: 1, samples: a.slice(0, 2000) } });
    p.port.onmessage({ data: { type: "end", id: 1 } });
    const [h0] = run(p, 4);
    p.port.onmessage({ data: { type: "splice", id: 1, at: 2000, samples: b.slice() } });
    const [h1] = run(p, 60);
    check(ended(p).length === 0, "splice: an utterance spliced after its end was said is open again");
    p.port.onmessage({ data: { type: "end", id: 1 } });
    const h = [...h0, ...h1, ...run(p, 4)[0]];
    check(h.slice(FADE, 2000).every((v, i) => v === a[FADE + i]) && h.slice(2000, 5000 - FADE).every((v, i) => v === b[i]) && ended(p).length === 1, "splice: at the end of what is queued it carries on");
    p.port.onmessage({ data: { type: "splice", id: 1, at: 0, samples: b.slice() } });
    check(p.q.length === 0, "splice: nothing for an utterance that is over");
  }
  {
    const p = playerOf();
    p.port.onmessage({ data: { type: "chunk", id: 1, samples: a.slice(0, 2000) } });
    let threw = false;
    try { p.port.onmessage({ data: { type: "splice", id: 1, at: 2001, samples: b.slice() } }); } catch { threw = true; }
    check(threw, "splice: not past the end of what is queued");
  }
}

// ---- the tape
{
  const t = new Take("choir", 0);
  const ramp = (n, v) => new Float32Array(n).fill(v);
  t.write(0, ramp(1000, 0.5), ramp(1000, 0.25));
  t.write(3000, ramp(2000, 0.5), ramp(2000, 0.25));
  check(JSON.stringify(t.spans) === "[[0,1000],[3000,5000]]" && t.n === 5000 && t.has(999) && !t.has(1000) && t.end(10) === 1000 && t.end(1000) === 1000 && t.end(2000) === 2000 && t.begin(1000) === 0 && t.begin(2000) === 2000 && t.next(1000) === 3000 && t.next(3000) === null, `tape: what is made, in spans ${JSON.stringify(t.spans)}`);
  let threw = false;
  try { t.cut(500, 1500); } catch { threw = true; }
  check(threw && t.cut(3000, 3010)[0].length === 10, "tape: only what is made is given to play");
  // a making picked up at 800 and run to 3200: faded in over [800, 1000) and out over [3000, 3200)
  t.write(800, ramp(2400, -0.5), ramp(2400, -0.25), { a: 800, u: 1000, b: 3000, e: 3200 });
  const l = t.ch[0];
  check(JSON.stringify(t.spans) === "[[0,5000]]" && l[799] === 0.5 && l[800] === 0.5 && Math.abs(l[900]) < 1e-6 && l[1000] === -0.5 && l[2999] === -0.5 && l[3000] === -0.5 && Math.abs(l[3100]) < 1e-6 && l[3200] === 0.5 && maxJump(l.subarray(0, 5000)) <= 1 / 200 + 1e-6, `tape: a making beside sound made before is faded into it at both ends (step ${maxJump(l.subarray(0, 5000)).toExponential(1)})`);
  check(Math.abs(t.y[900] - (l[900] + t.ch[1][900]) / 2) < 1e-7 && t.ext[2 * 2] === 0.375 && t.ext[2 * 2 + 1] === 0.375, "tape: the figures' channel is the mean of the two");
  check(JSON.stringify(t.drain()) === "[[0,5000]]" && t.drain().length === 0, "tape: what was written is said once");
  t.close(5000);
  const s = t.stale();
  check(s.spans.length === 0 && JSON.stringify(s.shown) === "[[0,5000]]" && s.shows(10) && !s.has(10) && s.y[900] === t.y[900] && s.y !== t.y && !s.closed && s.length === 5000, "tape: made again, it keeps its picture and has nothing to play");
  s.write(960, ramp(480, 0.1), ramp(480, 0.1));
  check(t.ch[0][1000] === -0.5 && s.has(1000) && s.cut(960, 970)[0][0] === Math.fround(0.1), "tape: the new making leaves the old tape as it was");
}

// ---- a choir over scripted workers, on a virtual clock

// A scripted worker: opens its parts openMs after it is told, each picked up at the frame the mix's
// first sample (m.from, counted from m.t0) falls in, then makes their chunks (the first a little
// short, the rest `step` frames) one round at a time, a round taking step / rate ms of busy time for
// all its parts, and says them as each round ends, then done. slowAt: from this many ms on, rounds
// take slowBy times longer. lag: a round ends this many times its busy time after the last. keeps: as worker.js, what a part has sung is kept while the part is
// asked for as it was, and given again in no time; a round with nothing to sing takes none. A muted
// part is opened at its end.
class Sim {
  constructor(world, k, rate, { slowAt = Infinity, slowBy = 1, lag = 1, openMs = 20, keeps = false } = {}) {
    Object.assign(this, { world, k, rate, slowAt, slowBy, lag, openMs, keeps, posted: [], stopped: 0, kept: new Map(), sang: 0 });
  }
  postMessage(m) {
    this.posted.push(m);
    if (m.type === "stop") { this.stopped = Math.max(this.stopped, m.id); return; }
    if (m.type === "choir-reach") { this.reach = { id: m.id, to: m.to }; this.wake?.(); return; }
    if (m.type !== "choir") return;
    const w = this.world, t0 = w.t + this.openMs;
    const parts = m.parts.map((p) => {
      const f = p.mute ? p.frames : Math.max(0, Math.min(p.frames, Math.floor((m.from - Math.round((p.at - m.t0) * SR)) / 240)));
      return { part: p.part, frames: p.frames, from: f * 240, at: f * 240, sent: 0, live: true, spans: [], off: Math.round((p.at - m.t0) * SR) };
    });
    const keys = m.parts.map(asked);
    for (const k of [...this.kept.keys()]) if (!keys.includes(k)) this.kept.delete(k);
    if (this.keeps) parts.forEach((p, i) => { if (!this.kept.has(keys[i])) this.kept.set(keys[i], []); p.spans = this.kept.get(keys[i]); });
    const open = { type: "choir-open", id: m.id, parts: parts.map((p) => p.part), at: m.parts.map((p) => p.at), lens: parts.map((p) => p.frames * 240), from: parts.map((p) => p.from), sung: parts.map(() => ({ breaths: [], cents: 0, lag: 0 })), kept: parts.map((p) => p.spans.map((s) => [...s])) };
    w.at(t0, () => { if (m.id > this.stopped) this.say(open); });
    let t = t0, busy = 0, made = 0, first = true;
    const round = () => {
      if (m.id <= this.stopped) return;
      const sings = (p) => p.live && p.at < p.frames * 240 && !within(p.spans, p.at);
      // as worker.js: with its part furthest behind at its reach, it waits to be told further
      const behind = Math.min(...parts.filter(sings).map((p) => p.off + p.at));
      if (parts.some(sings) && this.reach?.id === m.id && behind >= this.reach.to) {
        this.wake = () => { this.wake = null; t = Math.max(t, w.t); round(); };
        return;
      }
      const fst = first && parts.some(sings);
      const ms = parts.some(sings) ? m.step * 10 / this.rate * (t >= this.slowAt ? this.slowBy : 1) : 0;
      t += ms * this.lag; busy += ms;
      const due = t, b = busy;
      if (fst) first = false;
      w.at(due, () => {
        if (m.id <= this.stopped) return;
        const size = (p) => Math.min(within(p.spans, p.at)?.[1] ?? Infinity, p.at + (fst ? m.step - 3 : m.step) * 240, p.frames * 240) - p.at;
        const ks = parts.map((p) => (p.live ? size(p) : 0)), sg = parts.map(sings);
        made += ks.reduce((a, k, i) => a + (sg[i] ? k : 0), 0);
        for (const [i, p] of parts.entries()) {
          if (!p.live) continue;
          const k = ks[i];
          if (k <= 0) { p.live = false; this.say({ type: "choir-end", id: m.id, part: p.part }); continue; }
          this.say({ type: "choir-chunk", id: m.id, part: p.part, samples: Float32Array.from({ length: k }, (_, i) => wave(p.part, p.at + i)), busy: b, made });
          if (sg[i]) { this.sang += k; if (this.keeps) add(p.spans, p.at, p.at + k); }
          p.at += k; p.sent += k;
        }
        if (parts.some((p) => p.live)) round();
        else this.say({ type: "choir-done", id: m.id, busy: b, secs: parts.reduce((a, p) => a + p.sent, 0) / SR });
      });
    };
    w.at(t0, round);
  }
  say(m) { this.world.choir.message(this.k, m); }
}

// The world: events by time, the speaker taking a quantum of 128 samples every 128 / SR s, its
// words handed to the deck. w.said[id]: what the speaker was sent for an utterance, splices applied.
function world({ rates, cores = 8, lead = null }) {
  const w = { t: 0, ev: [], quanta: 0, heard: [[], []], sent: [], said: {}, begun: [], ended: [], held: [], jobs: [], swaps: [], stats: null };
  w.at = (t, f) => { w.ev.push({ t, f }); w.ev.sort((a, b) => a.t - b.t); };
  const sink = new Player();
  let nid = 0, told = 0;
  w.sink = sink;
  w.sims = rates.map((r, k) => new Sim(w, k, r.rate ?? r, typeof r === "object" ? r : {}));
  w.flush = () => { while (told < sink.posted.length) w.deck.hear(sink.posted[told++]); };
  w.deck = new Deck({
    send: (m) => {
      w.sent.push(m);
      if (m.type === "chunk" || m.type === "splice") {
        const s = (w.said[m.id] ??= [[], []]), at = m.type === "splice" ? m.at : s[0].length;
        if (m.type === "splice") w.splices = (w.splices ?? 0) + 1;
        [m.samples, m.right ?? m.samples].forEach((x, c) => { s[c].length = Math.min(s[c].length, at); for (let i = 0; i < x.length; i++) s[c][at + i] = x[i]; });
      }
      globalThis.currentFrame = w.quanta * 128;
      sink.port.onmessage({ data: m });
    },
    clock: () => w.quanta * 128, nextId: () => ++nid, now: () => w.t,
    ahead: (t, c) => w.cond.ahead(t, c),
    onBegin: (u) => w.begun.push({ id: u.id, base: u.base, ms: w.t, heard: w.heard[0].length }),
    onEnd: (m) => w.ended.push(m),
    onHold: () => w.held.push(w.t),
    onSwap: (t) => w.swaps.push({ take: t, ms: w.t }),
  });
  w.choir = new Choir({
    main: w.sims[0], cores, now: () => w.t,
    spawn: () => w.sims[w.choir.pool.length],
    onSound: (j, y, at) => w.cond.sound(j, y, at), onOpen: (j) => w.cond.opened(j), onDone: (j, s) => w.cond.done(j, s), onError: (e) => w.cond.error(e),
  });
  w.cond = new Conductor({ choir: w.choir, deck: w.deck, nextId: () => ++nid, now: () => w.t, lead, onDone: (t, s) => { w.stats = s; w.jobs.push(s); }, onError: (e) => { w.error = e; } });
  w.run = (untilMs, { until = () => false } = {}) => {
    const dt = 128 / SR * 1000;
    for (; w.t <= untilMs; ) {
      const tq = ++w.quanta * dt;
      while (w.ev.length && w.ev[0].t <= tq) {
        const e = w.ev.shift(); w.t = Math.max(w.t, e.t); e.f();
        w.flush();
      }
      w.t = tq;
      globalThis.currentFrame = w.quanta * 128;
      const l = new Float32Array(128), r = new Float32Array(128);
      sink.process([], [[l, r]]);
      w.heard[0].push(...l); w.heard[1].push(...r);
      w.flush();
      if (until()) break;
    }
  };
  w.choirs = () => w.sims.flatMap((s) => s.posted.filter((m) => m.type === "choir"));
  return w;
}
const ROOM = "driest", BPM = 75;
// n parts of `frames` each (or frames(i)), at at(i) s, seats spread over a stage
const PARTS = (n, frames, at = () => 0, room = ROOM) => {
  const seats = makeSeats(n, 0.85);
  return {
    parts: Array.from({ length: n }, (_, i) => ({ name: `p${i}`, voice: "v", song: "", seed: i, frames: typeof frames === "function" ? frames(i) : frames, at: at(i), gain: 1 / (n * REFL_SUM), seat: i })),
    seats, room, bpm: BPM,
  };
};
// the whole choir as it should be: the parts mixed in one go, through the room; a muted part is there, silent
function expected(job) {
  const parts = job.parts.map((p, i) => Float32Array.from({ length: p.frames * 240 }, (_, s) => wave(i, s)));
  const bus = reference(parts, job.parts.map((p) => ({ gain: p.mute ? 0 : p.gain, seat: job.seats[p.seat], start: p.at })));
  const r = new Room({ room: job.room, bpm: job.bpm });
  const a = r.push([bus[0], bus[1]], [bus[2], bus[3]]), b = r.end();
  return [0, 1].map((c) => cat([a, b].filter((x) => x).map((x) => x[c])));
}
const roomDelay = new Room({ room: ROOM, bpm: BPM }).delay;
const tape = (t) => t.ch.map((c) => c.subarray(0, t.n));
const diff2 = (a, b, from = 0, to = a[0].length) => Math.max(maxDiff(a[0].subarray(from, to), b[0].subarray(from, to)), maxDiff(a[1].subarray(from, to), b[1].subarray(from, to)));
// an utterance as heard: what the speaker played from its first sound, against what it was sent,
// the same sample for sample between its fades
function played(w, what, k = 0) {
  const u = w.begun[k], s = w.said[u.id], h = w.heard;
  // where it starts in what was heard: after the fade of whatever played before it
  const at = (lag) => { for (let i = 2 * FADE; i < 2 * FADE + 256; i++) if (h[0][lag + i] !== Math.fround(s[0][i])) return false; return true; };
  let lag = u.heard;
  while (lag < u.heard + 8192 && !at(lag)) lag++;
  let same = lag < u.heard + 8192;
  for (let c = 0; c < 2 && same; c++) for (let i = 2 * FADE; i < s[c].length - 2 * FADE; i++) if (h[c][lag + i] !== Math.fround(s[c][i])) { same = false; break; }
  check(same, `${what}: the speaker plays what it is sent, sample for sample, between its fades`);
}
// no step in what the speaker plays beyond the takes' own and a fade's
function noStep(w, what, sounds) {
  const ys = sounds.flat();
  const bound = Math.max(...ys.map(maxJump)) + Math.max(...ys.map(maxAbs)) * (1 / FADE + (sounds.length > 1 ? 2 / XF : 0)) + 1e-6;
  const got = Math.max(maxJump(w.heard[0]), maxJump(w.heard[1]));
  check(got <= bound, `${what}: no step in what is played beyond the sound's own and a fade's (${got.toExponential(2)} against ${bound.toExponential(2)})`);
}

{ // reined: paused, a making stops a lead past the speaker; played again it runs to the end; wanted whole it is made whole
  const job = PARTS(4, 6000, (i) => [0, 0.25, 1, 0.5][i]); // a minute
  const w = world({ rates: [8, 8, 8, 8], lead: 5 });
  const t = w.cond.sing(job);
  w.run(2000);
  const free = t.end(0);
  check(free > 8 * SR && w.deck.active, `reined: played, the making runs free (${(free / SR).toFixed(1)} s made in 2 s)`);
  w.deck.stop();
  w.cond.rein();
  const at = w.deck.pos;
  w.run(12000);
  const held = t.end(0), sang = w.sims.reduce((a, s) => a + s.sang, 0);
  check(held >= free && held < Math.max(free, at + 5 * SR) + 2 * SR && held < t.length / 2, `reined: paused at ${(at / SR).toFixed(2)} s, the making stops ${((held - at) / SR).toFixed(1)} s past it`);
  w.run(20000);
  check(t.end(0) === held && w.sims.reduce((a, s) => a + s.sang, 0) === sang && w.cond.job !== null, "reined: and nothing more is sung while it stays paused");
  w.deck.pos = at + 20 * SR; // the listener moves on, still paused
  w.cond.rein();
  w.run(26000);
  const moved = t.end(0);
  check(moved >= at + 24 * SR && moved < at + 27 * SR, `reined: its place moved 20 s on, the making follows to ${((moved - at) / SR).toFixed(1)} s past where it paused`);
  w.cond.seek(at);
  w.run(120000, { until: () => w.ended.length > 0 });
  check(w.ended.length === 1 && w.ended[0].stalls === 0 && w.held.length === 0 && t.closed && t.end(0) >= t.length, `reined: played again it runs to its end with no stall ${JSON.stringify(w.ended)}`);
  const want = expected(job), got = tape(t), d = diff2(got, want);
  check(got[0].length === want[0].length && d < 1e-5, `reined: the tape is the parts mixed in one go and put through the room (${d.toExponential(1)})`);
  const v = world({ rates: [8, 8, 8, 8], lead: 5 });
  const u = v.cond.sing(job);
  v.run(1500);
  v.deck.stop();
  v.cond.rein();
  v.run(8000);
  const short = u.end(0);
  v.cond.fill();
  v.run(40000);
  check(short < u.length && u.closed && u.end(0) >= u.length && !v.deck.active, `reined: paused ${(short / SR).toFixed(1)} s in hand of ${(u.length / SR).toFixed(1)}; wanted whole, it is made whole`);
}

{ // fast: made much faster than played, parts opened at different times and starting at different points
  const job = PARTS(4, 500, (i) => [0, 0.25, 1, 0.5][i]);
  const w = world({ rates: [10, { rate: 10, openMs: 90 }, { rate: 10, openMs: 300 }, { rate: 10, openMs: 35 }] });
  const t = w.cond.sing(job);
  w.run(20000, { until: () => w.ended.length > 0 });
  const e = w.ended;
  check(e.length === 1 && !e[0].stopped && e[0].stalls === 0, `fast: played to the end, no stall ${JSON.stringify(e)}`);
  check(w.begun.length === 1 && w.begun[0].ms < 600 && w.deck.run.begun === w.begun[0].ms, `fast: the speaker starts ${w.begun[0]?.ms.toFixed(0)} ms in, the last worker opening at 300`);
  check(w.stats && w.stats.whole && w.stats.parts === 4 && w.stats.workers === 4 && Math.abs(w.stats.secs - 20) < 1e-9 && Math.abs(w.stats.mix * SR - (t.total + TAIL * SR)) < 1e-6 && t.total === Math.max(...job.parts.map((p) => p.at * SR + 500 * 240 + Math.max(...taps(p.gain, job.seats[p.seat]).map((x) => x.d)))), `fast: stats ${JSON.stringify(w.stats)}`);
  const want = expected(job), got = tape(t);
  const d = diff2(got, want);
  check(got[0].length === want[0].length && t.length === got[0].length && t.closed && JSON.stringify(t.spans) === `[[0,${t.length}]]` && d < 1e-5, `fast: the tape is the parts mixed in one go and put through the room (${got[0].length} samples, ${d.toExponential(1)})`);
  check(w.said[w.begun[0].id][0].length === t.length && maxDiff(w.said[w.begun[0].id][0], got[0]) === 0, "fast: the speaker is sent the tape");
  played(w, "fast");
  noStep(w, "fast", [tape(t)]);
  check(w.stats.perCompute > 9 && w.stats.perCompute < 10.5, `fast: seconds of singing per second of compute, over all parts (${w.stats.perCompute.toFixed(2)})`);
  check(t.lanes.length === 4 && t.lanes.every((l, i) => l.off === Math.round(job.parts[i].at * SR) && l.lv.length === 500 && l.lv.every((v) => v > 0)) && t.trace.at("out", 100) > 0 && Number.isNaN(t.trace.at("out", t.length / 240 + 5)), "fast: each part's level and the room's trace kept with the tape");
  // sung again as it was: played from the tape, nothing made
  const asked = w.choirs().length;
  w.cond.sing(job);
  w.run(w.t + 20000, { until: () => w.ended.length > 1 });
  check(w.choirs().length === asked && w.ended.length === 2 && w.ended[1].stalls === 0 && w.begun[1].base === 0, "again: the same choir is played from the tape, no worker asked");
  played(w, "again", 1);
  // a jump in the tape: played from there to the end
  const T = 40000;
  w.cond.seek(T);
  w.run(w.t + 20000, { until: () => w.ended.length > 2 });
  const s3 = w.said[w.begun[2].id];
  check(w.choirs().length === asked && w.begun[2].base === T && s3[0].length === t.length - T && maxDiff(Float32Array.from(s3[0]), got[0].subarray(T)) === 0 && w.ended.length === 3, "jump: in a tape that is made, the speaker is set down there at once and plays to the end");
  played(w, "jump", 2);
  noStep(w, "jump", [tape(t)]);
}
{ // one worker, four parts: the rate is the worker's, shared by its parts
  const w = world({ rates: [12], cores: 2 });
  w.cond.sing(PARTS(4, 400));
  w.run(30000, { until: () => w.ended.length > 0 });
  const e = w.ended;
  check(w.stats.workers === 1 && e.length === 1 && e[0].stalls === 0 && !e[0].stopped, `one worker: ${w.stats.workers} worker, no stall`);
}
{ // slow (0.6 of real time): holds back until the rest will be made in time, then no stall
  const rate = 0.6, frames = 1000, w = world({ rates: [rate, rate] });
  w.cond.sing(PARTS(2, frames));
  w.run(60000, { until: () => w.ended.length > 0 });
  const e = w.ended;
  check(e.length === 1 && e[0].stalls === 0, `slow: no stall though made slower than played ${JSON.stringify(e)}`);
  // started once a part is far enough on that the rest, at 0.7 of its speed, is made before it is
  // played (less the room's delay); a round, 20 frames, is 333 ms
  const len = frames * 240, D = BLOCK + roomDelay, round = 20 * 10 / rate;
  const need = len - 0.7 * rate * (len - D);
  const want = 20 + Math.ceil((need + 3 * 240) / (20 * 240)) * round;
  const got = w.begun[0]?.ms;
  check(got >= want - round && got <= want + 2 * round, `slow: waits ${got?.toFixed(0)} ms to start, the rest being made in time from about ${want.toFixed(0)} ms`);
}
{ // a worker that slows down after the start (to 0.2 of real time): the speaker runs dry once, is
  // taken up, and is set down again where it stopped once the rest will be made in time
  const w = world({ rates: [8, { rate: 8, slowAt: 400, slowBy: 40 }] });
  const t = w.cond.sing(PARTS(2, 1500));
  w.run(150000, { until: () => w.ended.length > 0 });
  const e = w.ended, [a, b] = w.begun, sa = w.said[a.id][0], sb = b ? w.said[b.id][0] : [];
  check(w.begun.length === 2 && w.held.length === 1 && w.deck.run.holds === 1 && e.length === 1 && e[0].id === b.id && e[0].stalls === 0 && !e[0].stopped,
    `dry: taken up once and set down again, then played to the end with no stall (${w.begun.length} begun, ${w.held.length} held, ${JSON.stringify(e)})`);
  const got = tape(t)[0];
  check(b && b.base === sa.length && sa.length + sb.length === t.length && maxDiff(Float32Array.from([...sa, ...sb]), got) === 0, `dry: set down at sample ${b?.base}, where it stopped: the two together are the tape`);
  // what is in hand is all the rest needs at 0.8 of the pace kept while watched, 0.2 of real time
  const rest = (t.length - b.base) / SR, wait = (b.ms - w.held[0]) / 1000, want = rest * (1 - 0.8 * 0.2) / 0.2;
  check(wait > 0.75 * want && wait < 1.1 * want, `dry: waited ${wait.toFixed(1)} s for the ${rest.toFixed(1)} s left, made at 0.2 of real time (about ${want.toFixed(0)} s)`);
  noStep(w, "dry", [tape(t)]);
}
{ // workers whose sound comes in three times slower than they sing it (2 of real time sung, 0.67 in
  // hand): the start waits for the rest to be made in time, and the speaker never runs dry
  const rate = 2, lag = 3, frames = 1500, w = world({ rates: [{ rate, lag }, { rate, lag }] });
  w.cond.sing(PARTS(2, frames));
  w.run(90000, { until: () => w.ended.length > 0 });
  const e = w.ended, share = w.choir.share();
  check(e.length === 1 && e[0].stalls === 0 && !e[0].stopped && w.held.length === 0 && w.begun.length === 1, `lag: no stall and the speaker never taken up ${JSON.stringify(e)}, ${w.held.length} held`);
  check(Math.abs(share - 1 / lag) < 0.01, `lag: the singing is ${share?.toFixed(3)} of the workers' time as their sound comes in`);
  // the rest, at 0.7 of rate / lag, is made before it is played
  const len = frames * 240, need = len * (1 - 0.7 * rate / lag) / (rate / lag) / SR * 1000, got = w.begun[0]?.ms;
  check(got > 0.9 * need && got < 1.15 * need, `lag: waits ${got?.toFixed(0)} ms to start, the rest being made in time from about ${need.toFixed(0)} ms`);
}
{ // stop: every worker is told, nothing more reaches the speaker, the speaker fades out
  const w = world({ rates: [4, 4, 4, 4] });
  const t = w.cond.sing(PARTS(4, 1500));
  w.run(3000);
  const before = w.sent.length, id = w.cond.job.id;
  w.cond.stop();
  w.run(w.t + 2000);
  check(w.sims.every((s) => s.posted.some((m) => m.type === "stop" && m.id === id)), "stop: every worker is told");
  check(w.sent.length === before + 1 && w.sent.at(-1).type === "stop", "stop: later chunks from the workers do not reach the speaker");
  const e = w.sink.posted.filter((m) => m.type === "ended");
  check(e.length === 1 && e[0].stopped && !w.deck.active && w.cond.job === null && t.head === null, `stop: the speaker ends stopped ${JSON.stringify(e)}`);
  const tail = w.heard.map((c) => c.slice(-Math.round(2 * SR * 0.5)));
  check(tail.every((c) => c.every((v) => v === 0)), "stop: silent after the fade");
  noStep(w, "stop", [tape(t)]);
  // and a new choir plays
  w.cond.sing(PARTS(4, 200));
  w.run(w.t + 20000, { until: () => w.ended.length > 0 });
  check(w.ended.length === 1 && !w.ended[0].stopped, "stop: the next choir plays to the end");
}
{ // an error from a worker stops the others and says why
  const w = world({ rates: [4, 4] });
  w.cond.sing(PARTS(2, 500));
  w.run(500);
  const id = w.cond.job.id;
  w.choir.message(1, { type: "error", id, message: "Alto: boom" });
  check(w.error === "Alto: boom" && w.sims.every((s) => s.stopped === id) && !w.deck.active && w.cond.job === null, "error: reported, every worker stopped, the speaker too");
}
{ // a message the choir does not know fails it
  const w = world({ rates: [4, 4] });
  w.cond.sing(PARTS(2, 500));
  w.run(500);
  const id = w.cond.job.id;
  w.choir.message(0, { type: "choir-what", id });
  check(w.error === "choir: no message choir-what" && w.sims.every((s) => s.stopped === id), `unknown message: fails the choir (${w.error})`);
}
{ // parts that end at different times (a round): the mix has no step where one leaves
  const job = PARTS(4, (i) => 300 + 40 * i);
  const w = world({ rates: [10, 10, 10, 10] });
  const t = w.cond.sing(job);
  w.run(20000, { until: () => w.ended.length > 0 });
  check(w.ended.length === 1 && Math.abs(w.stats.secs - (300 * 4 + 40 * 6) / 100) < 1e-9, `staggered ends: all parts made ${JSON.stringify(w.stats)}`);
  const want = expected(job), got = tape(t);
  check(got[0].length === want[0].length && diff2(got, want) < 1e-5, "staggered ends: the mix in one go, through the room");
  played(w, "staggered ends");
  noStep(w, "staggered ends", [tape(t)]);
}
{ // start: what it is given is checked
  const w = world({ rates: [4] });
  const job = PARTS(2, 100);
  const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
  check(/no seat 9/.test(threw(() => w.choir.start({ id: 1, ...job, parts: job.parts.map((p, i) => ({ ...p, seat: i ? 9 : 0 })) }))), "start: a part needs a seat");
  check(/needs a part/.test(threw(() => w.choir.start({ id: 1, ...job, parts: [] }))), "start: a choir needs a part");
  check(/not muted/.test(threw(() => w.choir.start({ id: 1, ...job, parts: job.parts.map((p) => ({ ...p, mute: true })) }))), "start: a choir needs a part that is not muted");
  const mx = new Mixer(job.parts.map((p, i) => ({ gain: p.gain, seat: job.seats[p.seat], mute: i === 1 })), { t0: 0 });
  check(/part 1 is muted, and opened at sample 0/.test(threw(() => mx.open(1, 0, 24000, 0))) && threw(() => mx.open(0, 0, 24000, 0)) === null, "mixer: a muted part is opened at its end, or not at all");
  check(/from sample 100/.test(threw(() => w.choir.start({ id: 1, ...job, from: 100 }))) && /from sample 240 to 240/.test(threw(() => w.choir.start({ id: 1, ...job, from: 240, until: 240 }))), "start: from a whole trace frame, to somewhere after it");
}
{ // prepare: each worker told its voices, pitch motions and whether it breathes; workers made as needed
  const made = [];
  const main = { postMessage: (m) => made.push(["main", m]) };
  const c = new Choir({ main, cores: 8, spawn: () => ({ postMessage: (m) => made.push([`h${made.length}`, m]) }), onSound() {}, onDone() {}, onError() {} });
  const v = "abacabac", mo = ["vibrato", null, "straight", "vibrato", "vibrato", null, null, "vibrato"], br = [0, 0, 0.9, 0, 0, 0, 0, 0];
  c.prepare([...v].map((x, i) => ({ voice: x, motion: mo[i], breath: br[i] })));
  const loads = made.filter(([, m]) => m.type === "choir-load").map(([, m]) => m);
  check(c.pool.length === 4 && loads.map((m) => m.voices.join("")).join() === "a,b,a,c", `prepare: four workers, each its voices (${loads.map((m) => m.voices.join(""))})`);
  check(loads.map((m) => m.motions.join("+")).join() === "vibrato,,straight,vibrato" && loads.map((m) => m.breaths).join() === "false,false,true,false", `prepare: each its motions and breaths (${loads.map((m) => `${m.motions.join("+")} ${m.breaths}`)})`);
}

// ---- a choir picked up in the middle

{ // a choir made from a sample on: its room run from WARM s before, the sound from there to the end
  const job = PARTS(4, 1200, (i) => [0, 0.1, 0.3, 0.2][i]), want = expected(job);
  for (const room of ["bare", ROOM]) {
    const jb = { ...job, room }, wantR = room === ROOM ? want : expected(jb);
    const w = world({ rates: [10, 10, 10, 10] }), got = [];
    w.choir.onSound = (j, y, at) => got.push({ at, y: [y[0].slice(), y[1].slice()] });
    w.choir.onOpen = () => {}; w.choir.onDone = (j, s) => { w.stats = s; };
    const from = 120000;
    w.choir.start({ id: 1, ...jb, from });
    w.run(20000, { until: () => w.stats });
    const y = [0, 1].map((c) => cat(got.map((g) => g.y[c])));
    const d = diff2(y, wantR.map((x) => x.subarray(from)));
    const asked = w.choirs()[0];
    check(got[0].at === from && got.every((g, i) => !i || g.at === got[i - 1].at + got[i - 1].y[0].length) && y[0].length === wantR[0].length - from && asked.from === from - WARM * SR && Math.abs(w.stats.mix - (wantR[0].length - asked.from) / SR) < 1e-9 && d < (room === "bare" ? 2e-3 : 2e-2), `picked up (${room}): the choir from sample ${from} on, within ${d.toExponential(1)} of the whole`);
  }
  // to a sample: the workers are stopped there
  const w = world({ rates: [10, 10, 10, 10] }), got = [];
  w.choir.onSound = (j, y, at) => got.push([at, at + y[0].length]);
  w.choir.onOpen = () => {}; w.choir.onDone = (j, s) => { w.stats = s; };
  w.choir.start({ id: 3, ...job, from: 48000, until: 100000 });
  w.run(20000, { until: () => w.stats });
  check(got[0][0] === 48000 && got.at(-1)[1] === 100000 && !w.stats.whole && w.choir.job === null && w.sims.every((s) => s.stopped === 3), `picked up: made to the sample asked, then the workers are stopped ${JSON.stringify(w.stats)}`);
}
{ // a jump ahead of the making: made from there; back into the gap: made up to the sound in hand and joined to it
  const job = PARTS(4, 2500), want = expected(job);
  const w = world({ rates: [3, 3, 3, 3] });
  const t = w.cond.sing(job);
  w.run(1500);
  const head = t.head, first = w.cond.job.id, T = 360000;
  check(w.begun.length === 1 && head > 24000 && head < T, `jump ahead: the choir is playing, made to ${head}`);
  w.cond.seek(T);
  check(w.sims.every((s) => s.stopped === first) && w.cond.job.from <= T && w.cond.job.from > T - 480 && w.cond.job.until === null && w.deck.want === T, "jump ahead: the making is stopped and one begun where the speaker is to be");
  w.run(w.t + 3000);
  check(w.begun.length === 2 && w.begun[1].base === T && w.begun[1].ms - w.begun[0].ms < 2500 && t.spans.length === 2 && t.spans[0][1] === head && t.spans[1][0] === w.cond.job.from, `jump ahead: the speaker is set down there ${(w.begun[1].ms - 1500).toFixed(0)} ms on; the tape has a gap ${JSON.stringify(t.spans)}`);
  const second = w.cond.job.id, B = t.spans[1][0];
  w.cond.seek(2400);
  check(w.begun.length === 3 && w.begun[2].base === 2400, "jump back: sound in hand plays at once");
  const j = w.cond.job;
  check(w.sims.every((s) => s.stopped === second) && j.from === Math.floor((head - XF) / 240) * 240 && j.until === B + XF && j.seam.a === j.from && j.seam.u === head && j.seam.b === B, `jump back: a making from the end of the sound in hand to the next (${j.from} to ${j.until})`);
  w.run(w.t + 60000, { until: () => w.ended.length > 0 });
  check(w.ended.length === 1 && w.ended[0].stalls === 0 && !w.ended[0].stopped && JSON.stringify(t.spans) === `[[0,${t.length}]]` && w.cond.job === null, `jump back: played to the end with no stall, the tape whole ${JSON.stringify(t.spans)} ${JSON.stringify(w.ended)}`);
  const got = tape(t), d = diff2(got, want), d0 = diff2(got, want, 0, head - XF - 240);
  check(got[0].length === want[0].length && d0 < 1e-5 && d < 2e-2, `jump back: the tape is the whole choir, the makings picked up within ${d.toExponential(1)} of it`);
  played(w, "jump back", 2);
  noStep(w, "jump", [tape(t)]);
}
{ // what is sung changes as it plays: made again from just ahead of the speaker, the old faded into the new
  const A = PARTS(4, 2500), B = { ...A, parts: A.parts.map((p) => ({ ...p, gain: p.gain * 0.5 })), room: "bare" };
  const wantA = expected(A), wantB = expected(B);
  const w = world({ rates: [6, 6, 6, 6] });
  const ta = w.cond.sing(A);
  w.run(4000);
  const first = w.cond.job.id, p = w.deck.played(), lat = w.cond.lat;
  check(lat > 0 && w.cond.pace.part === lat && w.cond.pace.mix === null && w.cond.expect(1) === lat && w.cond.expect(0) === 250 && w.cond.toSing(B, ta) === 0 && w.cond.toSing(B) === 1 && w.cond.toSing({ ...A, parts: A.parts.map((q, i) => (i === 2 ? { ...q, seed: 9 } : q)) }, ta) === 1, `change: the wait for a making's first sound goes by the parts its busiest worker sings (${lat.toFixed(0)} ms for one)`);
  w.cond.change(B);
  const tb = w.cond.cur, j = w.cond.job;
  const lead = Math.ceil((Math.ceil(p) + Math.round(1.3 * 250 / 1000 * SR)) / 240) * 240;
  check(tb !== ta && w.deck.take === ta && w.deck.next.take === tb && w.sims.every((s) => s.stopped === first) && j.from === lead && tb.spans.length === 0 && JSON.stringify(tb.shown) === JSON.stringify(ta.spans), `change: the old plays on, the new is made from ahead of the speaker by the wait expected and a third (${j.from}, the speaker at ${Math.round(p)})`);
  w.run(w.t + 60000, { until: () => w.ended.length > 0 });
  const sp = w.sent.filter((m) => m.type === "splice");
  check(w.swaps.length === 1 && w.swaps[0].take === tb && sp.length === 1 && w.ended.length === 1 && w.ended[0].stalls === 0 && w.begun.length === 1, `change: one cut, ${(w.swaps[0].ms - 4000).toFixed(0)} ms after the change, and no stall ${JSON.stringify(w.ended)}`);
  const c = sp[0].at, s = w.said[w.begun[0].id].map((x) => Float32Array.from(x));
  const dA = diff2(s, wantA, 0, c), dB = diff2(s, wantB, c + XF, wantB[0].length);
  check(c >= j.from && s[0].length === wantB[0].length && dA < 1e-5 && dB < 2e-2, `change: the old choir to sample ${c}, the new from ${XF} samples on (within ${dA.toExponential(1)} and ${dB.toExponential(1)})`);
  played(w, "change");
  noStep(w, "change", [wantA, wantB]);
  // back before the change: that is made the new way too
  w.cond.seek(0);
  w.run(w.t + 60000, { until: () => w.ended.length > 1 });
  const d = diff2(tape(tb), wantB);
  check(w.ended.length === 2 && w.ended[1].stalls === 0 && JSON.stringify(tb.spans) === `[[0,${tb.length}]]` && tb.shown.length === 1 && d < 2e-2, `change: back at the start it is made the new way (within ${d.toExponential(1)})`);
  // changed with nothing playing: nothing is made until it is played
  const asked = w.choirs().length;
  w.cond.change(A);
  check(w.choirs().length === asked && w.cond.cur !== tb && w.deck.take === w.cond.cur && !w.deck.active && w.cond.cur.spans.length === 0, "change: with nothing playing, nothing is made");
  w.cond.seek(240000);
  w.run(w.t + 60000, { until: () => w.ended.length > 2 });
  const tc = w.cond.cur, dC = diff2(tape(tc), wantA, 240000 + XF, wantA[0].length);
  check(w.ended.length === 3 && w.begun.at(-1).base === 240000 && dC < 2e-2 && tc.spans.length === 1 && tc.spans[0][0] === 240000, `change: played from a jump, it is made from there (within ${dC.toExponential(1)})`);
}

{ // wanted whole: what the speaker left unmade is made, each gap in its turn, with nothing playing
  const job = PARTS(4, 2500), want = expected(job);
  const w = world({ rates: [3, 3, 3, 3] });
  const t = w.cond.sing(job);
  w.run(1500);
  const head = t.head, T = 360000;
  w.cond.seek(T);
  w.run(w.t + 3000);
  w.cond.stop();
  w.run(w.t + 500);
  const B = t.spans[1][0], E = t.spans[1][1], asked = w.choirs().length, begun = w.begun.length;
  check(t.spans.length === 2 && E < t.length && w.cond.job === null && !w.deck.active, `whole: a tape with a gap and no end ${JSON.stringify(t.spans)} of ${t.length}, nothing playing or being made`);
  w.cond.fill();
  const j = w.cond.job;
  check(w.cond.whole && j && j.from === Math.floor((head - XF) / 240) * 240 && j.until === B + XF && j.seam.u === head && j.seam.b === B, `whole: asked for, the first gap is made, from the sound before it to the sound after (${j?.from} to ${j?.until})`);
  w.run(w.t + 60000, { until: () => w.cond.job !== null && w.cond.job !== j });
  const k = w.cond.job;
  check(k && k.from === Math.floor((E - XF) / 240) * 240 && k.until === null && t.spans.length === 1 && t.spans[0][1] === E, `whole: then the next, to the end (from ${k?.from})`);
  w.run(w.t + 60000, { until: () => w.cond.job === null });
  const d = diff2(tape(t), want);
  check(!w.cond.whole && JSON.stringify(t.spans) === `[[0,${t.length}]]` && w.choirs().length === asked + 2 * 4 && d < 2e-2, `whole: the tape is the whole choir in two makings more (within ${d.toExponential(1)}), and no more is asked`);
  check(w.begun.length === begun && !w.deck.active, "whole: nothing was played for it");
  w.cond.fill();
  check(!w.cond.whole && w.cond.job === null, "whole: asked of a whole tape, nothing is made");
  // kept through a change of what is sung; over at a stop
  const other = { ...job, room: "bare" };
  w.cond.fill();
  w.cond.change(other);
  check(w.cond.whole === false && w.cond.job === null, "whole: a change after it was met makes nothing");
  w.cond.fill();
  const c = w.cond.cur;
  check(w.cond.whole && w.cond.job?.from === 0 && w.cond.job.until === null, "whole: asked of a tape with nothing made, it is made from the start");
  w.run(w.t + 1000);
  w.cond.change(job);
  const c2 = w.cond.cur;
  check(c2 !== c && w.cond.whole && w.cond.job?.take === c2 && w.cond.job.from === 0, "whole: what is sung changes as it is made, and the new is made whole instead");
  w.run(w.t + 1000);
  w.cond.stop();
  check(!w.cond.whole && w.cond.job === null && c2.spans.length === 1 && c2.spans[0][1] < c2.length, "whole: a stop ends it");
  w.cond.fill();
  w.run(w.t + 60000, { until: () => w.cond.job === null });
  const d2 = diff2(tape(c2), want);
  check(JSON.stringify(c2.spans) === `[[0,${c2.length}]]` && d2 < 2e-2 && w.error === undefined, `whole: asked again, the rest is made (within ${d2.toExponential(1)})`);
}
{ // wanted whole as it plays: the speaker's wants first, then what it left
  const job = PARTS(4, 2500), want = expected(job);
  const w = world({ rates: [3, 3, 3, 3] });
  const t = w.cond.sing(job);
  w.run(1500);
  const head = t.head, T = 360000;
  w.cond.seek(T);
  w.run(w.t + 1000);
  const j = w.cond.job;
  w.cond.fill();
  check(w.cond.whole && w.cond.job === j && j.from > head, "whole, playing: the making ahead of the speaker is left at work");
  w.run(w.t + 60000, { until: () => w.cond.job !== j });
  const k = w.cond.job;
  check(w.deck.active && k && k.seam.u === head && k.until === t.spans[1][0] + XF, `whole, playing: its end made, the gap behind the speaker is (from ${k?.from})`);
  w.run(w.t + 60000, { until: () => w.ended.length > 0 });
  const d = diff2(tape(t), want);
  check(w.ended.length === 1 && w.ended[0].stalls === 0 && !w.cond.whole && w.cond.job === null && JSON.stringify(t.spans) === `[[0,${t.length}]]` && d < 2e-2, `whole, playing: played to the end with no stall, the tape whole (within ${d.toExponential(1)})`);
  // a jump into a gap while another is being made for the tape: the speaker comes first
  const w2 = world({ rates: [3, 3, 3, 3] });
  const t2 = w2.cond.sing(job);
  w2.run(1000);
  w2.cond.seek(240000);
  w2.run(w2.t + 1000);
  w2.cond.seek(480000);
  w2.run(w2.t + 6000);
  const gaps = t2.spans.length, far = w2.cond.job;
  w2.cond.fill();
  w2.run(w2.t + 60000, { until: () => w2.cond.job !== null && w2.cond.job !== far });
  const g = w2.cond.job, u = t2.spans[1][1];
  w2.cond.seek(u - 2400);
  w2.run(w2.t + 300);
  check(gaps === 3 && far === null && g.seam.u === t2.spans[0][1] && w2.cond.job !== g && w2.cond.job.seam.u === u, `whole, playing: a jump to the end of other sound stops the gap's making for the speaker's (${JSON.stringify(t2.spans)})`);
  w2.run(w2.t + 90000, { until: () => w2.ended.length > 0 && w2.cond.job === null });
  const d3 = diff2(tape(t2), want);
  check(w2.ended.at(-1).stalls === 0 && !w2.cond.whole && JSON.stringify(t2.spans) === `[[0,${t2.length}]]` && d3 < 2e-2, `whole, playing: and the tape is whole in the end (within ${d3.toExponential(1)})`);
}

{ // workers that keep what they sang: a change to the room and levels alone sings nothing again; a change to one part sings that part
  const A = PARTS(4, 2500), B = { ...A, parts: A.parts.map((p) => ({ ...p, gain: p.gain * 0.5 })), room: "bare" };
  const C = { ...B, parts: B.parts.map((p, i) => (i === 2 ? { ...p, seed: 9 } : p)) };
  const wantA = expected(A), wantB = expected(B);
  const w = world({ rates: [6, 6, 6, 6].map((rate) => ({ rate, keeps: true })) });
  const ta = w.cond.sing(A);
  w.run(3000);
  const sang = () => w.sims.map((s) => s.sang), s0 = sang(), per = w.cond.pace.part;
  w.cond.change(B);
  const tb = w.cond.cur, jb = w.cond.job, t1 = w.t;
  w.run(w.t + 1000);
  const s1 = sang(), made = ta.spans[0][1];
  check(w.swaps.length === 1 && w.swaps[0].take === tb && w.swaps[0].ms - t1 < 600 && w.choir.job?.picked === 0 && w.cond.pace.mix !== null && w.cond.pace.mix < 100 && w.cond.pace.part === per && s1.every((n, k) => n - s0[k] <= Math.max(0, tb.head - made) + 6 * 24 * 1000), `kept: a change of room and levels is cut to ${(w.swaps[0].ms - t1).toFixed(0)} ms on, its first sound ${w.cond.pace.mix?.toFixed(0)} ms after it was asked, the singers picked up only where they had not sung`);
  w.run(w.t + 60000, { until: () => w.ended.length > 0 });
  const sp = w.sent.filter((m) => m.type === "splice"), c = sp[0].at, s = w.said[w.begun[0].id].map((x) => Float32Array.from(x));
  const dA = diff2(s, wantA, 0, c), dB = diff2(s, wantB, c + XF, wantB[0].length), all = 4 * 2500 * 240;
  check(w.ended[0].stalls === 0 && sp.length === 1 && c >= jb.from && dA < 1e-5 && dB < 2e-2 && sang().reduce((x, y) => x + y, 0) === all, `kept: the old choir to sample ${c}, the new from there, no stall, and every part sung once in all (${sang()})`);
  noStep(w, "kept", [wantA, wantB]);
  // back at the start in the new room: nothing is sung
  const t3 = w.t;
  w.cond.seek(0);
  w.run(w.t + 300);
  check(w.begun.length === 2 && w.begun[1].base === 0 && w.begun[1].ms - t3 < 200 && sang().reduce((x, y) => x + y, 0) === all, `kept: a jump back to where the new room is not made plays ${(w.begun[1]?.ms - t3).toFixed(0)} ms on, nothing sung`);
  w.run(w.t + 2000);
  // one part changes: its worker sings it alone
  const s2 = sang(), t2 = w.t, n = w.swaps.length;
  check(w.cond.toSing(C, w.cond.cur) === 1, "kept: one part changed is one part to sing");
  w.cond.change(C);
  w.run(w.t + 1500);
  const s3 = sang();
  check(w.swaps.length === n + 1 && w.choir.job?.picked === 1 && s3[2] > s2[2] && [0, 1, 3].every((k) => s3[k] === s2[k]), `kept: a part changed is sung by its worker alone (${s3.map((x, k) => x - s2[k])}), cut to ${(w.swaps.at(-1).ms - t2).toFixed(0)} ms on`);
}

{ // a solo: the others muted. Their workers sing nothing and keep what they sang; the one heard is given where it was sung and sung where it was not; released, the choir is back
  const A = PARTS(4, 2500), S = { ...A, parts: A.parts.map((p, i) => (i === 2 ? p : { ...p, mute: true })) };
  const wantA = expected(A), wantS = expected(S);
  const w = world({ rates: [6, 6, 6, 6].map((rate) => ({ rate, keeps: true })) });
  const ta = w.cond.sing(A);
  w.run(2000);
  const sang = () => w.sims.map((s) => s.sang), s0 = sang(), t1 = w.t, made = ta.spans[0][1];
  check(w.cond.toSing(S, ta) === 0 && w.cond.toSing(S) === 1 && w.cond.toSing(A, Object.assign(ta.stale(), { settings: S, workers: 4 })) === 0, "solo: muted parts are none to sing, and the same parts with or without them");
  w.cond.change(S);
  const ts = w.cond.cur;
  w.run(w.t + 1000);
  const j1 = w.choir.job ?? null, c1 = w.sent.filter((m) => m.type === "splice")[0]?.at;
  check(w.swaps.length === 1 && w.swaps[0].take === ts && w.swaps[0].ms - t1 < 600 && j1?.picked === 0 && [0, 1, 3].every((k) => sang()[k] === s0[k]), `solo: cut to ${(w.swaps[0]?.ms - t1).toFixed(0)} ms on, nothing sung for it where the part was sung already, the others' workers singing nothing (${sang().map((x, k) => x - s0[k])})`);
  check(ts.length === ta.length && ts.total === ta.total && ts.lanes.every((l, i) => l.lv.length === 2500 && l.lv[100] > 0 && l.lv[100] === ta.lanes[i].lv[100]), "solo: the take keeps its length, and each part the levels it had");
  // ahead of what any part had sung: the one heard is sung there, alone
  const T = 432000, t2 = w.t;
  check(T > made + 48000, `solo: sample ${T} is past what the choir had sung (${made})`);
  w.cond.seek(T);
  w.run(w.t + 1500);
  const s2 = sang();
  check(w.begun.length === 2 && w.begun[1].base === T && w.begun[1].ms - t2 < 1000 && s2[2] > s0[2] && [0, 1, 3].every((k) => s2[k] === s0[k]), `solo: a jump ahead plays ${(w.begun[1]?.ms - t2).toFixed(0)} ms on, sung by the one worker (${s2.map((x, k) => x - s0[k])})`);
  // released there: the others are sung from where the speaker is, the solo playing on until they are ready
  const t3 = w.t, p3 = w.deck.played();
  w.cond.change(A);
  const tr = w.cond.cur;
  w.run(w.t + 60000, { until: () => w.ended.length > 0 });
  const sw = w.swaps.at(-1), s3 = sang(), all = 4 * 2500 * 240;
  check(w.swaps.length === 2 && sw.take === tr && w.ended.length === 1 && w.ended[0].stalls === 0 && !w.ended[0].stopped && [0, 1, 3].every((k) => s3[k] > s2[k]) && s3.every((n) => n <= all / 4), `solo: released, the choir is cut back to ${(sw.ms - t3).toFixed(0)} ms on, the others sung from there, no stall and no sample sung twice`);
  const u = w.begun[1], s = w.said[u.id].map((x) => Float32Array.from(x)), c2 = w.sent.filter((m) => m.type === "splice" && m.id === u.id).at(-1).at;
  const dS = diff2(s, wantS.map((x) => x.subarray(T)), XF, c2), dA = diff2(s, wantA.map((x) => x.subarray(T)), c2 + XF, wantA[0].length - T);
  check(T + c2 > p3 && s[0].length === wantA[0].length - T && dS < 2e-2 && dA < 2e-2, `solo: the one part alone to sample ${T + c2}, the choir from there (within ${dS.toExponential(1)} and ${dA.toExponential(1)})`);
  check(c1 > 0 && diff2(w.said[w.begun[0].id].map((x) => Float32Array.from(x)), wantA, 0, c1) < 1e-5, "solo: the choir until the solo was cut to");
  noStep(w, "solo", [wantA, wantS]);
}

console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
