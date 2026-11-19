// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// Every choir preset opened as the page opens it, in node, and nothing sung: each part's words
// known to the engine, its notes planned, its breaths fitted to its rests. Says how long each is,
// how many breaths its singers take, and how low and high each sex sings.
//
//     node choir_open.mjs SITE [PRESET...]
//
// SITE: the built site (lipservice.wasm and models/); the page's files are this directory's.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SR } from "./choir.js";
import { CHOIRS, arrange } from "./choirs.js";
import { parse } from "./perform.js";
import { nodeChoir, routeOf } from "./node_choir.mjs";

const [site, ...only] = process.argv.slice(2);
if (!site) {
  console.error("usage: node choir_open.mjs SITE [PRESET...]");
  process.exit(2);
}
const voices = JSON.parse(readFileSync(join(site, "models/voices.json"), "utf8"));

let opened = () => {}, failed = () => {};
const choir = await nodeChoir(site, { onOpen: (j) => opened(j), onError: (message) => failed(message) });

// the notes a part sings, as midi, its shift counted
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midi = (s) => {
  const m = /^([A-G])([#b]?)(-?\d+)$/.exec(s);
  return m ? NOTE[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12 * (+m[3] + 1) : +s;
};
const sung = (p) => parse(p.song).phrases.flatMap((ph) => ph.words.flatMap((w) => w.groups.flat().map((x) => midi(x.pitch) + p.shift)));

let id = 0, bad = 0;
for (const name of only.length ? only : Object.keys(CHOIRS)) {
  if (!CHOIRS[name]) throw new Error(`no choir ${name}`);
  const job = arrange(CHOIRS[name], { list: voices, route: routeOf(site) });
  const range = (x) => {
    const ns = job.parts.filter((p) => p.sex === x).flatMap(sung);
    if (ns.some((n) => !Number.isFinite(n))) throw new Error(`${name}: a note that is not one`);
    return ns.length ? `${Math.min(...ns).toFixed(1)} to ${Math.max(...ns).toFixed(1)}` : "none";
  };
  const t = performance.now();
  try {
    const j = await new Promise((resolve, reject) => {
      opened = resolve;
      failed = (m) => reject(new Error(m));
      choir.start({ id: ++id, ...job, from: 0, until: null, trace: true, lv: [] });
    });
    const breaths = j.sung.map((s) => s.breaths.length);
    console.log(`ok    ${name}: ${job.parts.length} parts, ${(j.mixer.total / SR).toFixed(0)} s, ${breaths.reduce((a, b) => a + b, 0)} breaths (${Math.min(...breaths)} to ${Math.max(...breaths)} a part), `
      + `women ${range("F")}, men ${range("M")}, opened in ${((performance.now() - t) / 1000).toFixed(1)} s on ${j.w} workers`);
    choir.stop(id);
  } catch (e) {
    bad += 1;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}
process.exit(bad ? 1 : 0);
