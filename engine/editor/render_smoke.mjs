// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// Save sound run in node against a built site, as the page runs it: each example score's heard
// singers sung by the real singer.js in worker threads (node_singer.mjs), gathered on the line
// (render.js), checked against what the real speaker.js plays from the same sound, mixed by
// mix.js's nodes in the stand-in OfflineAudioContext (offline_standin.mjs) and made a WAV
// (wav.js). It checks that the file is made, where its beat 0 is and how long it is; what it
// sounds like is for a listener. The stand-in's nodes are the spec's arithmetic, not a browser's:
// a filter, an eq or a compressor in a chain is refused, and the room and echo are its own.
//
//     node render_smoke.mjs SITE [--site] [OUT-DIR]
//
// SITE: the built site (lipservice.wasm, models/). The page's files (lipservice.js, perform.js,
// room.js) are the repo's, engine/web; with --site they are the site's own copies. OUT-DIR: where
// to leave each score's sound file, if given.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import * as S from "./score.js";
import { strips } from "./mix.js";
import { BUDGET, Gather, tail, mixdown, cue } from "./render.js";
import { wav, read } from "./wav.js";
import { standin } from "./offline_standin.mjs";
import { EXAMPLES, SCORES } from "./examples/make.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), own = args.includes("--site");
const [site, outDir] = args.filter((a) => a !== "--site");
if (!site) {
  console.error("usage: node render_smoke.mjs SITE [--site] [OUT-DIR]");
  process.exit(2);
}
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
if (outDir) mkdirSync(outDir, { recursive: true });

const RATE = 24000, HEAD = RATE, WORKERS = 2; // the page's: its speaker's line has beat 0 at HEAD
const off = standin();
await off.processors();
const window = { OfflineAudioContext: off.OfflineAudioContext, AudioBuffer: off.AudioBuffer, AudioWorkletNode: off.AudioWorkletNode };
const { SLOTS } = globalThis.SPEAKER;

// the page's pool: a singer's worker by its place
const routed = new Map(), stopped = new Set(); // job: what its messages go to; jobs let go of
const pool = await Promise.all(Array.from({ length: WORKERS }, () => new Promise((yes, no) => {
  const w = new Worker(join(here, "node_singer.mjs"), { workerData: { site, web: own ? site : join(here, "../web") } });
  w.on("message", (m) => {
    if (m.type === "ready") return yes(w);
    if (m.type === "warned") return console.log(`     warned: ${m.message}`);
    if (m.id === null) return no(new Error(m.message));
    if (stopped.has(m.id)) return; // what a job let go of had sent before it heard
    const to = routed.get(m.id);
    if (!to) throw new Error(`a word for job ${m.id}, which nothing asked for`);
    to(m);
  });
  w.on("error", (e) => { console.error(`FAIL the singer: ${e.stack}`); process.exit(1); });
})));
let jobs = 0;

// A score's sound file, as Save sound makes it: every heard singer sung from the start, on the
// one clock where more than one has notes, muted ones counted as the live page counts them.
async function render(score) {
  const t0 = performance.now(), st = strips(score);
  const withNotes = score.singers.filter((s) => s.part.notes.length).length;
  const todo = score.singers.map((s, i) => i).filter((i) => score.singers[i].part.notes.length && st[i].gain > 0);
  if (!todo.length) throw new Error("nothing would be heard: every singer with notes is muted or not soloed");
  const singers = todo.map((i) => ({ slot: i, job: ++jobs, name: score.singers[i].part.title || `singer ${i + 1}` }));
  const gather = new Gather({ window, rate: RATE, head: HEAD, singers, tail: tail(score.chain, RATE), budget: BUDGET.desk });
  const raw = new Map(singers.map((s) => [s.job, { slot: s.slot, open: null, chunks: [] }]));
  await new Promise((yes, no) => {
    for (const s of singers) {
      routed.set(s.job, (m) => {
        try {
          const r = raw.get(m.id);
          if (m.type === "open") r.open = m;
          if (m.type === "chunk") r.chunks.push(m.samples.slice());
          if (gather.told(m).done) yes();
        } catch (e) {
          no(e);
        }
      });
      pool[s.slot % WORKERS].postMessage({ type: "sing", id: s.job, part: score.singers[s.slot].part, step: 20, together: withNotes > 1 });
    }
  }).catch((e) => {
    for (const s of singers) {
      stopped.add(s.job);
      pool[s.slot % WORKERS].postMessage({ type: "stop", ids: [s.job] });
    }
    throw e;
  }).finally(() => { for (const s of singers) routed.delete(s.job); });
  const line = gather.line(), sung = (performance.now() - t0) / 1000;
  // the line against the real speaker given the same takes
  const said = [], sp = off.processor("speaker", said), tell = (m) => sp.port.onmessage({ data: m });
  for (const [job, r] of raw) {
    const from = HEAD - r.open.zero + r.open.first, length = r.open.last - r.open.first;
    tell({ type: "take", slot: r.slot, id: job, from, length, now: true });
    for (const c of r.chunks) tell({ type: "chunk", slot: r.slot, id: job, samples: c });
    tell({ type: "done", slot: r.slot, id: job });
  }
  tell({ type: "play", n: 1, pos: line.start, loop: null, end: line.end, wait: [...raw.values()].map((r) => r.slot) });
  let other = 0, at = 0;
  while (!said.some((m) => m.type === "ended")) {
    const o = Array.from({ length: SLOTS + 1 }, () => [new Float32Array(128)]);
    sp.process([], o);
    for (const t of line.takes) {
      const x = t.buffer.getChannelData(0);
      for (let i = 0; i < 128 && at + i < line.end - line.start; i++) if (o[t.slot][0][i] !== (line.start + at + i < x.length ? x[line.start + at + i] : 0)) other++;
    }
    at += 128;
  }
  const out = await mixdown({ window, score, line, rate: RATE, speaker: new URL("./speaker.js", import.meta.url) });
  const made = wav({ channels: [out.left, out.right], rate: RATE, title: score.title, cue: cue(HEAD, line, out.late, RATE), score: S.write(score) });
  return { line, out, made, other, stalls: sp.stalls, heard: todo, together: withNotes > 1, sung, secs: (performance.now() - t0) / 1000 };
}

const scores = [
  ...Object.keys(EXAMPLES).filter((n) => n !== "unfinished").map((n) => [n, S.of(EXAMPLES[n]())]),
  ...Object.entries(SCORES).map(([n, make]) => [n, make()]),
];
{
  const r = SCORES.round();
  r.singers[1].mute = true;
  scores.push(["round-cora-muted", r]);
}
for (const [name, score] of scores) {
  let r;
  try {
    r = await render(score);
  } catch (e) {
    check(false, `${name}: ${e.message}`);
    continue;
  }
  const { line, out, made, other } = r, back = read(made.bytes);
  console.log(`     ${name}: ${r.heard.length} of ${score.singers.length} singers sung${r.together ? " on one clock" : ""} in ${r.sung.toFixed(1)} s, the file made in ${r.secs.toFixed(1)} s: ${made.frames} frames (${(made.frames / RATE).toFixed(2)} s) of the ${out.length} mixed, beat 0 at frame ${back.cue}`);
  check(other === 0 && r.stalls === 0, `${name}: the line is what speaker.js plays from beat 0, every singer sample for sample`);
  check(back.rate === RATE && back.frames === made.frames && back.title === score.title && back.score === S.write(score) && back.cue === HEAD - line.start + Math.round(out.late * RATE), `${name}: the file reads back: 24 kHz, its title, its score, beat 0 where the head is`);
  check(made.frames > line.end - line.start - RATE && !made.ringing, `${name}: the sound runs to the line's end and dies away before the file's`);
  if (name === "round-cora-muted") check(r.heard.join() === "0,2" && r.together, "a muted singer is not sung, and the others are sung on the one clock as they are live");
  if (outDir) {
    const file = join(outDir, `${name}.wav`);
    writeFileSync(file, made.bytes);
    console.log(`     ${file}`);
  }
}
{
  const e = await render(S.of(EXAMPLES.unfinished())).then(() => null, (x) => x);
  check(e && e.at === 0 && e.slot === 0 && /^singer 1: beat 0: the note C3 has no words/.test(e.message), `a singer that cannot be sung is refused by name and by its note: ${e?.message}`);
}

for (const w of pool) await w.terminate();
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
