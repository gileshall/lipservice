// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A choir made as the page makes it, as fast as it goes, and written as a wav (24 kHz stereo,
// 32-bit float): choirs.js arranges it, the workers sing it, choir.js seats and mixes it and puts
// it through the room.
//
//     node choir_wav.mjs SITE OUT.wav ASK.json
//     node choir_wav.mjs --choirs        (choirs.js CHOIRS, as JSON)
//
// SITE: the built site (lipservice.wasm and models/); the page's files are this directory's.
// ASK.json: {"choir": a name of choirs.js CHOIRS, or a choir as CHOIRS holds one, and any of
// "seed", "voices", "songs", "room", "motion", "how" as arrange() takes them}.
// Prints one line of JSON: the seconds written, the seconds it took, and each part's name, voice
// and breaths.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SR } from "./choir.js";
import { CHOIRS, arrange } from "./choirs.js";
import { nodeChoir, routeOf } from "./node_choir.mjs";
import { Engine } from "./lipservice.js";
import { setEngine } from "./room.js";

const [site, out, askPath] = process.argv.slice(2);
if (site === "--choirs" && !out) {
  process.stdout.write(JSON.stringify(CHOIRS), () => process.exit(0));
  await new Promise(() => {});
}
if (!askPath) {
  console.error("usage: node choir_wav.mjs SITE OUT.wav ASK.json | --choirs");
  process.exit(2);
}
const fail = (message) => { console.error(message); process.exit(1); };
process.on("uncaughtException", (e) => fail(e.message));
const { choir: asked, ...opts } = JSON.parse(readFileSync(askPath, "utf8"));
for (const k of Object.keys(opts)) if (!["seed", "voices", "songs", "room", "motion", "how"].includes(k)) throw new Error(`${askPath}: no ${k}`);
const preset = typeof asked === "string" ? CHOIRS[asked] : asked;
if (!preset) throw new Error(`no choir ${asked}`);
setEngine(await Engine.create(readFileSync(join(site, "lipservice.wasm")))); // arranged by the engine
const job = arrange(preset, { list: JSON.parse(readFileSync(join(site, "models/voices.json"), "utf8")), route: routeOf(site), ...opts });

const chunks = [[], []], t0 = performance.now();
let n = 0, sung = null;
const choir = await nodeChoir(site, {
  onOpen: (j) => { sung = j.sung; },
  onSound: (j, y, at) => {
    if (at !== n) fail(`sound at ${at}, not ${n}`);
    chunks[0].push(y[0].slice());
    chunks[1].push(y[1].slice());
    n += y[0].length;
  },
  onDone: () => {
    const buf = Buffer.alloc(44 + 8 * n);
    buf.write("RIFF", 0); buf.writeUInt32LE(36 + 8 * n, 4); buf.write("WAVE", 8);
    buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(8 * SR, 28); buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34);
    buf.write("data", 36); buf.writeUInt32LE(8 * n, 40);
    let k = 44;
    for (let c = 0; c < chunks[0].length; c++) {
      const l = chunks[0][c], r = chunks[1][c];
      for (let i = 0; i < l.length; i++) {
        if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) fail(`${out}: a sample is not finite`);
        buf.writeFloatLE(l[i], k);
        buf.writeFloatLE(r[i], k + 4);
        k += 8;
      }
    }
    writeFileSync(out, buf);
    console.log(JSON.stringify({
      seconds: n / SR, took: (performance.now() - t0) / 1000,
      parts: job.parts.map((p, i) => ({ name: p.name, voice: p.voice, breaths: sung[i].breaths.length })),
    }));
    process.exit(0);
  },
  onError: fail,
});
choir.start({ id: 1, ...job });
