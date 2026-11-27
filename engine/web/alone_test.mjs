// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// One voice alone on its way out (engine.alone, engine/src/alone.rs): held under the ceiling in any
// pieces the same as in one. (It was room.js's Limiter sample for sample; that copy is gone, the
// engine's room.rs Limiter the one left.)
// node alone_test.mjs LIPSERVICE.wasm
import { readFileSync } from "node:fs";
import { Engine } from "./lipservice.js";
import { rng, SR } from "./room.js";

const [wasm] = process.argv.slice(2);
if (!wasm) { console.error("usage: node alone_test.mjs LIPSERVICE.wasm"); process.exit(2); }
const engine = await Engine.create(readFileSync(wasm));
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const join = (out) => {
  const y = new Float32Array(out.reduce((s, o) => s + o.length, 0));
  let k = 0;
  for (const o of out) { y.set(o, k); k += o.length; }
  return y;
};

// a tone with three loud stretches, the loudest past full scale
const r = rng("held"), n = 3 * SR, ceiling = 10 ** (-1.5 / 20), reach = Math.round(0.05 * SR);
const x = Float32Array.from({ length: n }, (_, i) => {
  const t = i / SR, loud = (t > 0.5 && t < 0.52) ? 1.3 : (t > 1.2 && t < 1.6) ? 0.95 : (t > 2.3 && t < 2.301) ? 1.6 : 0.5;
  return loud * Math.sin(2 * Math.PI * 233 * t) + 0.01 * r.normal();
});
const run = (cuts, sung = false) => {
  const a = engine.alone(sung), out = [];
  try {
    let k = 0;
    for (const c of [...cuts, n]) { out.push(a.push(x.subarray(k, c))); k = c; }
    out.push(a.end());
  } finally {
    a.close();
  }
  return join(out);
};
const y = run([]);
let top = 0, over = 0;
for (let i = 0; i < n; i++) { top = Math.max(top, Math.abs(y[i])); if (Math.abs(x[i]) > 1) over++; }
const far = (i) => { for (let j = Math.max(0, i - reach); j < Math.min(n, i + reach); j++) if (Math.abs(x[j]) > 0.8) return false; return true; };
let same = 0, quiet = 0;
for (let i = 0; i < n; i += 7) if (far(i)) { quiet++; if (y[i] === x[i]) same++; }
check(y.length === n && over > 0 && top <= ceiling + 1e-6, `speech: ${over} samples past full scale in, none over the ceiling out (the highest ${top.toFixed(4)}), as long as it came`);
check(quiet > 1000 && same === quiet, `speech: away from what is over the ceiling every sample is as it came, in its place (${same} of ${quiet})`);
const pieces = run([1, 439, 440, 441, 5000, 5001, 30000]);
check(pieces.length === n && pieces.every((v, i) => v === y[i]), "in any pieces, the same as in one, bit for bit");
const short = engine.alone(false);
const s = [short.push(x.subarray(0, 100)), short.end()];
short.close();
check(s[0].length === 0 && s[1].length === 100, "a sound shorter than the limiter's delay comes whole at the end");

// a song: let down by what the loaded sound sings through; with none loaded there is none to sing
let refused = false;
try { engine.alone(true); } catch (e) { refused = /nothing to sing through/.test(e.message); }
check(refused, "a song with nothing loaded to sing through is refused");
const a = engine.alone(false);
a.end();
let twice = false;
try { a.end(); } catch (e) { twice = /ended twice/.test(e.message); }
a.close();
check(twice, "ended twice is refused");
process.exit(fails ? 1 : 0);
