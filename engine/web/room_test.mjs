// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// room.js: its generator, and the room (the engine's: its filters, halls and echo are tested in
// engine/src/room.rs) streamed in any pieces the same as in one, a click where it was, silence silent.
// node room_test.mjs LIPSERVICE.wasm
import { readFileSync } from "node:fs";
import { Engine } from "./lipservice.js";
import { rng, Room, BLOCK, TAIL, SR, setEngine } from "./room.js";

if (!process.argv[2]) { console.error("usage: node room_test.mjs LIPSERVICE.wasm"); process.exit(2); }
const e = await Engine.create(readFileSync(process.argv[2]));
setEngine(e);
const ROOMS = e.rooms();

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
  for (const room of ROOMS) {
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
