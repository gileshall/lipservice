// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// room.js: its generator, its filters against scipy's, its convolver against a direct sum, the echo's
// timing, one voice held under the ceiling, and the room streamed in any pieces the same as in one.
// node room_test.mjs
import { rng, butter, Biquad, Convolver, Echo, Room, Held, ROOMS, BLOCK, TAIL, SR, hall } from "./room.js";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

// ---- rng
{
  const a = rng("x"), b = rng("x"), c = rng("y");
  const xs = Array.from({ length: 1000 }, () => a.uniform());
  check(xs.every((x, i) => x === b.uniform()) && xs.some((x) => x !== c.uniform()), "rng: a key gives its own sequence, the same each time");
  check(xs.every((x) => x >= 0 && x < 1) && Math.abs(xs.reduce((s, x) => s + x, 0) / 1000 - 0.5) < 0.05, "rng: uniform in [0, 1)");
  const r = rng("ints"), seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(r.int(-2, 2));
  check(seen.size === 5 && [...seen].every((v) => v >= -2 && v <= 2), `rng: int(lo, hi) takes both ends (${[...seen].sort()})`);
}

// ---- filters: scipy.signal.butter(order, fc / 12000, type), [b0, b1, b2, a1, a2]
const SCIPY = {
  "1 3000 low": [0.2928932188134525, 0.2928932188134525, 0, -0.4142135623730949, 0],
  "2 2500 low": [0.07223087532575319, 0.14446175065150638, 0.07223087532575319, -1.109228792618427, 0.39815229392143964],
  "2 2500 high": [0.6268452716349667, -1.2536905432699335, 0.6268452716349667, -1.109228792618427, 0.39815229392143964],
  "2 200 high": [0.9636527639641734, -1.9273055279283469, 0.9636527639641734, -1.9259839697318861, 0.9286270861248077],
  "2 5000 low": [0.22019470027295873, 0.44038940054591746, 0.22019470027295873, -0.30756635979220975, 0.18834516088404465],
  "2 30 high": [0.9944617889581948, -1.9889235779163896, 0.9944617889581948, -1.9888929058996532, 0.9889542499331266],
};
for (const [k, want] of Object.entries(SCIPY)) {
  const [o, fc, ty] = k.split(" ");
  const got = butter(+o, +fc, ty);
  check(maxDiff(got, want) < 1e-12, `butter ${k}: scipy's coefficients (${maxDiff(got, want).toExponential(1)})`);
}
{
  // a section from rest: y[n] = b0 x[n] + b1 x[n-1] + b2 x[n-2] - a1 y[n-1] - a2 y[n-2]
  const c = butter(2, 2500, "low"), f = new Biquad(c), r = rng("biquad");
  const x = Array.from({ length: 500 }, () => r.normal()), y = [];
  for (let n = 0; n < x.length; n++) y.push(c[0] * x[n] + c[1] * (x[n - 1] ?? 0) + c[2] * (x[n - 2] ?? 0) - c[3] * (y[n - 1] ?? 0) - c[4] * (y[n - 2] ?? 0));
  check(maxDiff(x.map((v) => f.step(v)), y) < 1e-12, "biquad: the difference equation from rest");
}

// ---- the convolver: blocks of BLOCK, against the direct sum
{
  const r = rng("conv"), m = 3 * BLOCK + 517, n = 5 * BLOCK;
  const ir = [Float64Array.from({ length: m }, () => r.normal()), Float64Array.from({ length: m - 900 }, () => r.normal())];
  const x = [Float64Array.from({ length: n }, () => r.normal()), Float64Array.from({ length: n }, () => r.normal())];
  const c = new Convolver(ir), y = [new Float64Array(n), new Float64Array(n)];
  const ol = new Float64Array(BLOCK), or = new Float64Array(BLOCK);
  for (let k = 0; k < n; k += BLOCK) {
    c.run(x[0].subarray(k, k + BLOCK), x[1].subarray(k, k + BLOCK), ol, or);
    y[0].set(ol, k); y[1].set(or, k);
  }
  let e = 0;
  for (let ch = 0; ch < 2; ch++) {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = Math.max(0, i - ir[ch].length + 1); j <= i; j++) s += x[ch][j] * ir[ch][i - j];
      e = Math.max(e, Math.abs(s - y[ch][i]));
    }
  }
  check(e < 1e-9, `convolver: each channel its own response, as the direct sum (${e.toExponential(1)})`);
}
{
  const [l, rr] = hall(3.5, 1.5, 0.8, 0.03, 1);
  const energy = (x) => x.reduce((s, v) => s + v * v, 0);
  check(l.length === Math.round(3.53 * SR) && l.slice(0, 720).every((v) => v === 0) && l[720] !== 0, "hall: silent through the predelay, then rings");
  check(Math.abs(energy(l) - 1) < 1e-9 && Math.abs(energy(rr) - 1) < 1e-9 && l.some((v, i) => v !== rr[i]), "hall: unit energy, the two sides apart");
}

// ---- the echo: half a beat each way, crossed, four repeats
{
  const e = new Echo(75), d = Math.round(60 / 75 / 2 * SR), o = [0, 0], y = [[], []];
  for (let i = 0; i < 5 * d + 100; i++) { e.step(i === 0 ? 1 : 0, 0, o); y[0].push(o[0]); y[1].push(o[1]); }
  const first = (x, from = 0) => x.findIndex((v, i) => i >= from && v !== 0);
  check(first(y[1]) === d && first(y[0]) === 2 * d, `echo: the left's first repeat on the right at ${first(y[1])} (half a beat, ${d}), back on the left at ${first(y[0])}`);
  const peak = (x, a) => Math.max(...x.slice(a, a + d).map(Math.abs));
  const p = [peak(y[1], d), peak(y[0], 2 * d), peak(y[1], 3 * d), peak(y[0], 4 * d)];
  check(p.every((v, k) => k === 0 || v < p[k - 1]) && y[0].slice(5 * d).every((v) => Math.abs(v) < 1e-3 * p[0]) && y[1].slice(4 * d, 5 * d).every((v) => Math.abs(v) < 1e-3 * p[0]), `echo: four repeats, each quieter, then gone (${p.map((v) => v.toFixed(3))})`);
}

// ---- one voice held under the ceiling: a tone with three loud stretches, the loudest past full scale
{
  const r = rng("held"), n = 3 * SR, ceiling = 10 ** (-1.5 / 20), reach = Math.round(0.05 * SR);
  const x = Float32Array.from({ length: n }, (_, i) => {
    const t = i / SR, loud = (t > 0.5 && t < 0.52) ? 1.3 : (t > 1.2 && t < 1.6) ? 0.95 : (t > 2.3 && t < 2.301) ? 1.6 : 0.5;
    return loud * Math.sin(2 * Math.PI * 233 * t) + 0.01 * r.normal();
  });
  const run = (cuts) => {
    const h = new Held(), out = [];
    let a = 0;
    for (const c of [...cuts, n]) { out.push(h.push(x.subarray(a, c))); a = c; }
    out.push(h.end());
    const y = new Float32Array(out.reduce((s, o) => s + o.length, 0));
    let k = 0;
    for (const o of out) { y.set(o, k); k += o.length; }
    return y;
  };
  const y = run([]);
  let top = 0, over = 0;
  for (let i = 0; i < n; i++) { top = Math.max(top, Math.abs(y[i])); if (Math.abs(x[i]) > 1) over++; }
  const far = (i) => { for (let j = Math.max(0, i - reach); j < Math.min(n, i + reach); j++) if (Math.abs(x[j]) > 0.8) return false; return true; };
  let same = 0, quiet = 0;
  for (let i = 0; i < n; i += 7) if (far(i)) { quiet++; if (y[i] === x[i]) same++; }
  check(y.length === n && over > 0 && top <= ceiling + 1e-6, `held: ${over} samples past full scale in, none over the ceiling out (the highest ${top.toFixed(4)}), as long as it came`);
  check(quiet > 1000 && same === quiet, `held: away from what is over the ceiling every sample is as it came, in its place (${same} of ${quiet})`);
  const pieces = run([1, 439, 440, 441, 5000, 5001, 30000]);
  check(pieces.length === n && pieces.every((v, i) => v === y[i]), "held: in any pieces, the same as in one, bit for bit");
  const short = new Held(), s = [short.push(x.subarray(0, 100)), short.end()];
  check(s[0].length === 0 && s[1].length === 100, "held: a sound shorter than the limiter's delay comes whole at the end");
}

// ---- the room, streamed
function through(room, buses, cuts) {
  const r = new Room({ room, bpm: 75 }), outs = [];
  for (let k = 0, j = 0; k < buses[0].length; j++) {
    const m = Math.min(cuts[j % cuts.length], buses[0].length - k);
    const y = r.push([buses[0].subarray(k, k + m), buses[1].subarray(k, k + m)], [buses[2].subarray(k, k + m), buses[3].subarray(k, k + m)]);
    if (y) outs.push(y);
    k += m;
  }
  const z = r.end();
  if (z) outs.push(z);
  const n = outs.reduce((a, o) => a + o[0].length, 0), y = [new Float32Array(n), new Float32Array(n)];
  let k = 0;
  for (const [a, b] of outs) { y[0].set(a, k); y[1].set(b, k); k += a.length; }
  return { y, delay: r.delay };
}
{
  const r = rng("room"), n = 3 * SR + 1234;
  const env = (i) => Math.sin(Math.PI * i / n) ** 2;
  const buses = [0, 1, 2, 3].map((c) => Float32Array.from({ length: n }, (_, i) => env(i) * (0.05 * Math.sin(0.03 * (c + 1) * i) + 0.01 * r.normal())));
  for (const room of Object.keys(ROOMS)) {
    const whole = through(room, buses, [n]).y;
    check(whole[0].length === n + Math.round(TAIL * SR), `room ${room}: the mix and ${TAIL} s of ring after it (${whole[0].length} samples)`);
    const ok = [[1], [7, 1000, 31], [BLOCK], [BLOCK + 1, BLOCK - 1]].every((cuts) => {
      const y = through(room, buses, cuts).y;
      return y[0].length === whole[0].length && y.every((c, k) => c.every((v, i) => v === whole[k][i]));
    });
    check(ok, `room ${room}: in any pieces, the same as in one, bit for bit`);
  }
  // in time with its input: an impulse on the dry bus comes out at its own sample, not the room's delay later
  for (const room of ["bare", "card"]) {
    const imp = [0, 1, 2, 3].map(() => new Float32Array(SR)), at = 5000;
    imp[0][at] = 0.01; imp[1][at] = 0.01;
    const { y } = through(room, imp, [SR]);
    let m = 0;
    for (let i = 1; i < y[0].length; i++) if (Math.abs(y[0][i]) > Math.abs(y[0][m])) m = i;
    check(Math.abs(m - at) <= 2, `room ${room}: a click on the dry bus at ${at} peaks at ${m}`);
  }
  const quiet = through("bare", [0, 1, 2, 3].map(() => new Float32Array(SR)), [500]).y;
  check(quiet.every((c) => c.every((v) => v === 0)), "room: silence in, silence out");
}

console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
