// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// perform.js against the engine's own perform (engine/src/part.rs): every part of every choir of
// choirs.js, performed by the page's code on the site's wasm and by the native engine, must come
// out as the same song text, the same breaths at the same samples, the same lag and shift.
//
//     node part_check.mjs SITE LIPSERVICE [--stirred] [CHOIR...]
//
// --stirred: each part as another singer would sing it instead (another seed, its timing moved by up
// to 3 frames, its start by up to 20 ms, a breath before two phrases in three), which few of the
// choirs ask for.
// SITE: the built site (lipservice.wasm and models/), built from the source LIPSERVICE (the
// native engine, engine/target/release/lipservice) was. Exits 1 at any difference.

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { CHOIRS, arrange } from "./choirs.js";
import { routeOf } from "./node_choir.mjs";
import { Engine } from "./lipservice.js";
import { library, perform } from "./perform.js";

const [site, bin, ...rest] = process.argv.slice(2);
const stirred = rest.includes("--stirred"), only = rest.filter((a) => a !== "--stirred");
if (!bin) {
  console.error("usage: node part_check.mjs SITE LIPSERVICE [--stirred] [CHOIR...]");
  process.exit(2);
}
for (const c of only) if (!CHOIRS[c]) throw new Error(`no choir ${c}`);
const file = (p) => join(site, p);
const bytes = (p) => new Uint8Array(readFileSync(file(p)));
const json = (p) => JSON.parse(readFileSync(file(p), "utf8"));

const route = routeOf(site), sound = route === "hifi" ? "models/vox.lsw" : "models/vocoder.lsw";
const engine = await Engine.create(bytes("lipservice.wasm"));
if (route === "hifi") engine.vox(bytes(sound));
else engine.vocoder(bytes(sound));
engine.phonemizer(bytes("models/g2p.lsw"), bytes("models/lexicon.lsw"));
const list = json("models/voices.json");
const memo = (load) => {
  const m = new Map();
  return (k) => (m.has(k) ? m : m.set(k, load(k))).get(k);
};
const base = memo((name) => engine.base(bytes(`models/bases/${name}.lsw`)));
const voice = memo((name) => {
  const v = list.find((v) => v.name === name);
  if (!v) throw new Error(`no voice ${name}`);
  // a voice's part of the latent voice may be a file of its own (the voice list's "parts"); singing needs no other
  const vox = route === "hifi" && (v.parts ?? []).includes("vox") ? bytes(`models/voices/${name}.vox.lsw`) : undefined;
  return engine.voice(bytes(`models/voices/${name}.lsw`), v.base ? base(v.base) : -1, { vox });
});
const motion = memo((name) => engine.motion(bytes(`models/motion-${name}.lsw`)));
const lib = library(json("models/breaths.json").clips);

const dir = mkdtempSync(join(tmpdir(), "part-check-"));
const native = (args) => new Promise((resolve, reject) => {
  execFile(bin, args, { maxBuffer: 1 << 24 }, (e, stdout, stderr) => (e ? reject(new Error(stderr.trim() || e.message)) : resolve(stdout)));
});

// worker.js clocked(): a part performed together is opened on its song with the together line
function clocked(text) {
  const lines = text.split("\n"), k = lines.findIndex((l) => l.trim().split(/\s+/)[0] === "bpm");
  if (k < 0) throw new Error("the song has no bpm line");
  lines.splice(k + 1, 0, "together");
  return lines.join("\n");
}

// one part both ways: what differs, or the breaths it takes
async function check(p, k) {
  const js = perform(p, p.breath > 0 ? lib : null, (text, shift) => {
    const s = engine.singer(voice(p.voice), p.together ? clocked(text) : text, { ...p, shift, motion: p.motion ? motion(p.motion) : -1 });
    return { singer: s, rests: s.rests };
  });
  js.singer.close();
  const song = join(dir, `${k}.txt`), out = join(dir, `${k}.out.txt`);
  writeFileSync(song, p.song);
  const v = list.find((v) => v.name === p.voice);
  const num = { seed: p.seed, at: p.at, jitter: p.jitter, detune: p.detune, spread: p.spread, give: p.give ?? undefined, shift: p.shift, vibrato: p.vibrato, "vibrato-hz": p.vibratoHz, "vibrato-delay": p.vibratoDelay, glide: p.glide, dynamics: p.dynamics, breathiness: p.breathiness };
  const args = ["perform", file(`models/voices/${p.voice}.lsw`), file(sound), file("models/g2p.lsw"), file("models/lexicon.lsw"), join(dir, "none.wav"), song, "--dry", "--performed", out];
  if (v.base) args.push("--base", file(`models/bases/${v.base}.lsw`));
  if (route === "hifi" && (v.parts ?? []).includes("vox")) args.push("--vox-part", file(`models/voices/${p.voice}.vox.lsw`));
  for (const [name, x] of Object.entries(num)) if (x !== undefined) args.push(`--${name}`, String(x));
  if (p.diction) args.push("--diction");
  if (p.together) args.push("--together");
  if (p.motion) args.push("--motion", file(`models/motion-${p.motion}.lsw`), "--motion-scale", String(p.motionScale ?? 1));
  if (p.breath > 0) args.push("--breaths", file("models/breaths.json"), "--breath", String(p.breath), "--sex", p.sex);
  const said = Object.fromEntries((await native(args)).trim().split("\n").map((l) => [l.split(" ")[0], l.split(" ").slice(1)]));
  const text = readFileSync(out, "utf8");
  if (text !== js.text) {
    const a = text.split("\n"), b = js.text.split("\n"), i = a.findIndex((l, i) => l !== b[i]);
    return `the song, line ${i + 1}: natively "${a[i]}", on the page "${b[i]}"`;
  }
  const mine = js.breaths.map((b) => `${b.clip.id}@${b.at}`).join(" ");
  if (said.breaths.join(" ") !== mine) return `the breaths: natively ${said.breaths.join(" ")}, on the page ${mine}`;
  if (Number(said.lag[0]) !== js.lag) return `the lag: natively ${said.lag[0]}, on the page ${js.lag}`;
  if (Number(said.shift[0]) !== js.shift) return `the shift: natively ${said.shift[0]}, on the page ${js.shift}`;
  return js.breaths.length;
}

const jobs = [];
for (const [name, c] of Object.entries(CHOIRS)) {
  if (only.length && !only.includes(name)) continue;
  for (const p of arrange(c, { list, route }).parts) jobs.push({ name, p: stirred ? { ...p, seed: p.seed + 101, jitter: 3, spread: 0.02, breath: 0.67 } : p });
}
let next = 0, bad = 0, breaths = 0, moved = 0, taken = 0;
await Promise.all(Array.from({ length: Math.max(1, cpus().length - 2) }, async () => {
  while (next < jobs.length) {
    const k = next++, { name, p } = jobs[k];
    let diff;
    try {
      diff = await check(p, k);
    } catch (e) {
      diff = e.message;
    }
    if (typeof diff === "string") {
      bad++;
      console.log(`${name}, ${p.name}: ${diff}`);
    } else {
      taken += diff;
    }
    if (p.breath > 0) breaths++;
    if (p.jitter > 0) moved++;
  }
}));
rmSync(dir, { recursive: true });
console.log(`${jobs.length} parts of ${new Set(jobs.map((j) => j.name)).size} choirs (${breaths} breathing, ${taken} breaths; ${moved} with their timing moved): ${bad ? `${bad} differ` : "the same both ways"}`);
process.exit(bad ? 1 : 0);
