// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A choir as the page sings it (choir_wav.mjs) against the engine's (engine/src/choir.rs, ls_choir):
// the same ask (choir_wav.mjs's ASK.json), the same samples to rounding (ROUND: the halls' noise is
// drawn by another libm's exp and log), its breaths in them. Exits 1 at any difference past that.
//     ROUTE=hifi|fast node choir_check.mjs SITE LIPSERVICE.wasm OUTDIR ASK.json...
// SITE: the built site the page's choir is sung on; LIPSERVICE.wasm: the engine's build to check,
// given the site's models. OUTDIR keeps the page's wav and the engine's float32 of each.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "./lipservice.js";
import { CHOIRS } from "./choirs.js";

const [site, wasm, outDir, ...asks] = process.argv.slice(2);
if (!asks.length) { console.error("usage: ROUTE=hifi|fast node choir_check.mjs SITE LIPSERVICE.wasm OUTDIR ASK.json..."); process.exit(2); }
const route = process.env.ROUTE;
if (!["hifi", "fast"].includes(route)) throw new Error(`ROUTE ${route}: hifi or fast`);
const web = dirname(fileURLToPath(import.meta.url));
const ROUND = 1e-6;
const e = await Engine.create(readFileSync(wasm));
const file = (p) => new Uint8Array(readFileSync(join(site, p)));
if (route === "hifi") e.vox(file("models/vox.lsw")); else e.vocoder(file("models/vocoder.lsw"));
e.phonemizer(file("models/g2p.lsw"), file("models/lexicon.lsw"));
const list = JSON.parse(readFileSync(join(site, "models/voices.json"), "utf8"));
const bj = readFileSync(join(site, "models/breaths.json")), bb = readFileSync(join(site, "models/breaths.bin"));
e.check(e.with(new Uint8Array(bj), (p, n) => e.with(new Uint8Array(bb), (q, m) => e.x.ls_breaths(p, n, q, m))));
const bases = {}, voices = {}, motions = {};
let fails = 0;
for (const askPath of asks) {
const ask = JSON.parse(readFileSync(askPath, "utf8"));
const tag = askPath.split("/").pop().replace(/\.json$/, "") + "-" + route;
const jsOut = join(outDir, `${tag}-page.wav`);
const t0 = performance.now();
execFileSync("node", ["choir_wav.mjs", site, jsOut, askPath], { cwd: web, env: { ...process.env, ROUTE: route }, stdio: ["ignore", "ignore", "inherit"] });
const tPage = performance.now() - t0;

const preset = typeof ask.choir === "string" ? CHOIRS[ask.choir] : ask.choir;
const used = new Set(preset.parts.map((p, i) => ask.voices?.[i] ?? p.voice));
for (const name of used) {
  if (voices[name] !== undefined) continue;
  const v = list.find((v) => v.name === name);
  const b = v.base ? (bases[v.base] ??= e.base(file(`models/bases/${v.base}.lsw`))) : -1;
  const part = (p, used) => ((v.parts ?? []).includes(p) && used ? file(`models/voices/${name}.${p}.lsw`) : undefined);
  voices[name] = e.voice(file(`models/voices/${name}.lsw`), b, { vox: part("vox", route === "hifi") });
}
for (const m of new Set([preset.style.motion, ...preset.parts.map((p) => p.motion), ask.motion].filter((m) => m && m !== "none" && motions[m] === undefined))) motions[m] = e.motion(file(`models/motion-${m}.lsw`));
const { choir, voices: byPart, ...rest } = ask;
if ("motion" in ask && ask.motion === null) rest.motion = "none"; // the page's null, the engine's none
const req = JSON.stringify({ choir: preset, list: list.map(({ name, sex }) => ({ name, sex })), voices, motions, ...(byPart ? { voices_by_part: byPart } : {}), ...rest });
const t1 = performance.now();
const n = e.check(e.with(new TextEncoder().encode(req), (p, k) => e.x.ls_choir(p, k)));
const tEngine = performance.now() - t1;
const z = e.samples(2 * n), L = z.subarray(0, n), R = z.subarray(n);
const info = JSON.parse(new TextDecoder().decode(new Uint8Array(e.x.memory.buffer, e.x.ls_info(), e.check(e.x.ls_choir_info()))));

// the page's wav: 32-bit float stereo
const w = readFileSync(jsOut);
let o = 12, data = null;
while (o < w.length) { const id = w.toString("ascii", o, o + 4), sz = w.readUInt32LE(o + 4); if (id === "data") { data = w.subarray(o + 8, o + 8 + sz); break; } o += 8 + sz + (sz & 1); }
const f = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
const m = f.length / 2;
let most = 0, apart = 0;
if (m === n) for (let i = 0; i < n; i++) for (const [a, b] of [[f[2 * i], L[i]], [f[2 * i + 1], R[i]]]) { const d = Math.abs(a - b); if (d) apart++; most = Math.max(most, d); }
const ok = m === n && most < ROUND;
if (!ok) fails++;
console.log(`${ok ? (most ? "same to rounding" : "same") : "DIFF"} ${tag}: ${m} / ${n} samples a channel, ${apart} apart, most ${most}; ${info.parts.reduce((a, p) => a + p.breaths.length, 0)} breaths; page ${Math.round(tPage)} ms, engine ${Math.round(tEngine)} ms`);
const out = Buffer.alloc(8 * n); for (let i = 0; i < n; i++) { out.writeFloatLE(L[i], 8 * i); out.writeFloatLE(R[i], 8 * i + 4); }
writeFileSync(join(outDir, `${tag}-engine.f32`), out);
}
process.exit(fails ? 1 : 0);
