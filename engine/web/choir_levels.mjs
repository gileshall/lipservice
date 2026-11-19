// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// Where each piece's loud passages sit as it is written, measured: every piece of choirs.js CHOIRS
// (or those named) made as the page makes it at its written gains, and the level of its mix ahead of
// the compressor read from the room's own trace. Writes choirs_levels.js, which arrange() sets each
// piece's level by. To be run again when the models, a piece or the seating change.
//
//     node choir_levels.mjs SITE [PIECE ...]
//
// SITE: the built site (lipservice.wasm and models/). Pieces not named keep the level they have.
// The loud passages: the mix's power over 400 ms about each 10 ms, in dB, at the point 95% of the
// piece's sounding time is under (sounding: within 45 dB of its loudest 10 ms).

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHOIRS, ROUTES, arrange } from "./choirs.js";
import { LEVELS, MADE } from "./choirs_levels.js";
import { nodeChoir, routeOf } from "./node_choir.mjs";
import { Trace, TRACE, LOUD } from "./room.js";

const [site, ...named] = process.argv.slice(2);
if (!site) { console.error("usage: node choir_levels.mjs SITE [PIECE ...]"); process.exit(2); }
const fail = (m) => { console.error(m); process.exit(1); };
process.on("uncaughtException", (e) => fail(e.stack ?? String(e)));
for (const n of named) if (!CHOIRS[n]) fail(`no choir ${n}`);
const list = JSON.parse(readFileSync(join(site, "models/voices.json"), "utf8"));

export function loud(power) {
  const db = (p) => 10 * Math.log10(Math.max(p, 1e-14)), n = power.length;
  let top = -Infinity;
  for (const p of power) top = Math.max(top, db(p));
  const W = 40, at = [];
  const sum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i] + power[i];
  for (let i = 0; i < n; i++) {
    if (db(power[i]) <= top - 45) continue;
    const a = Math.max(0, i - W / 2), b = Math.min(n, i + W / 2);
    at.push(db((sum[b] - sum[a]) / W));
  }
  if (!at.length) throw new Error("a piece with no sound");
  at.sort((x, y) => x - y);
  const q = 0.95 * (at.length - 1), lo = Math.floor(q);
  return at[lo] + (q - lo) * ((at[Math.min(lo + 1, at.length - 1)]) - at[lo]);
}

const route = routeOf(site);
const levels = { ...LEVELS[route] };
let choir = null, resolve = null, n = 0;
choir = await nodeChoir(site, { onSound: (j, y) => { n += y[0].length; }, onDone: () => resolve(), onError: fail });
let id = 0;
for (const name of named.length ? named : Object.keys(CHOIRS)) {
  const trace = new Trace();
  n = 0;
  const done = new Promise((r) => { resolve = r; });
  choir.start({ id: ++id, ...arrange({ ...CHOIRS[name], loud: LOUD }, { list, route }), trace });   // loud: LOUD is the piece as written
  await done;
  const F = Math.floor(n / TRACE), power = new Float64Array(F);
  for (let i = 0; i < F; i++) power[i] = trace.v.master[i] + trace.v.mhall[i];
  levels[name] = +loud(power).toFixed(1);
  console.log(`${name}: ${levels[name]} dBFS`);
}
for (const name of Object.keys(levels)) if (!CHOIRS[name]) delete levels[name];
const model = route === "hifi" ? "vox.lsw" : "vocoder.lsw";
const hash = createHash("sha256").update(readFileSync(join(site, "models", model))).digest("hex").slice(0, 16);
const all = { ...LEVELS, [route]: levels }, made = { ...MADE, [route]: `${model} ${hash}` };
const table = (r) => Object.keys(CHOIRS).filter((k) => k in all[r]).map((k) => `    ${JSON.stringify(k)}: ${all[r][k]},`).join("\n");
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "choirs_levels.js"),
  `// Written by choir_levels.mjs: where each piece's loud passages sit in the unmastered mix as it is
// written (dBFS; room.js LOUD says how it is told), sung by the voices and seed it is set with, on each
// route a site makes its sound by (choirs.js ROUTES): the two sing at different levels.
// arrange() (choirs.js) brings each to the room's LOUD by one gain. MADE: the model each route's
// were last measured with.
export const MADE = ${JSON.stringify(made)};
export const LEVELS = {
${ROUTES.map((r) => `  ${r}: {\n${table(r)}\n  },`).join("\n")}
};
`);
process.exit(0);
