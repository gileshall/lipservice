// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The editor's singer (singer.js) run in node against a built site, as the page runs it: the
// examples are sung through the site's engine and breaths, and what the engine refuses is said
// by its beat. It checks that the sound is made and how much of it; what it
// sounds like is for a listener.
//
//     node sing_smoke.mjs SITE [--site] [OUT-DIR]
//
// SITE: the built site (lipservice.wasm, models/). The page's files (lipservice.js, perform.js,
// room.js) are the repo's, engine/web; with --site they are the site's own copies, which is what
// a browser on that site is given. OUT-DIR: where to leave each part sung as a wav (16-bit mono,
// 24 kHz), if given.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import * as P from "./part.js";
import { song } from "./song.js";
import { EXAMPLES } from "./examples/make.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), own = args.includes("--site");
const [site, outDir] = args.filter((a) => a !== "--site");
if (!site) {
  console.error("usage: node sing_smoke.mjs SITE [--site] [OUT-DIR]");
  process.exit(2);
}
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };

const worker = new Worker(join(here, "node_singer.mjs"), { workerData: { site, web: own ? site : join(here, "../web") } });
const waiting = new Map(); // id: what its messages go to
let ready = null;
const voices = new Promise((yes, no) => { ready = { yes, no }; });
worker.on("message", (m) => {
  if (m.type === "ready") return ready.yes(m);
  if (m.id === null) return ready.no(new Error(m.message));
  waiting.get(m.id)(m);
});
worker.on("error", (e) => { console.error(`FAIL the singer: ${e.stack}`); process.exit(1); });

let ids = 0;
// A part sung: {open, samples, done}, or {error}.
function sing(part, stretch = {}) {
  const id = ++ids;
  return new Promise((yes) => {
    const chunks = [];
    let open = null;
    waiting.set(id, (m) => {
      if (m.type === "open") open = m;
      else if (m.type === "chunk") chunks.push(m.samples);
      else if (m.type === "error") yes({ error: m });
      else if (m.type === "done") {
        const samples = new Float32Array(chunks.reduce((a, c) => a + c.length, 0));
        let at = 0;
        for (const c of chunks) { samples.set(c, at); at += c.length; }
        yes({ open, samples, done: m });
      }
    });
    worker.postMessage({ type: "sing", id, part, step: 20, ...stretch });
  });
}

function wav(samples) {
  const b = Buffer.alloc(44 + 2 * samples.length);
  b.write("RIFF", 0); b.writeUInt32LE(36 + 2 * samples.length, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(2 * samples.length, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + 2 * i);
  return b;
}

const first = await voices, { voices: list, route } = first;
const offered = JSON.parse(readFileSync(join(site, "models/site.json"), "utf8"));
check((offered.routes ? offered.routes[0] : offered.vox ? "hifi" : "fast") === route, `the singer sings by the site's first route, ${route}`);
check(list.length > 0 && list.every((v) => v.name && (v.sex === "F" || v.sex === "M")), `the singer is ready with the site's ${list.length} voices`);

// every example but the one that is not to be sung
for (const name of Object.keys(EXAMPLES).filter((n) => n !== "unfinished")) {
  const part = EXAMPLES[name](), sung = song(part);
  const r = await sing(part);
  if (r.error) {
    check(false, `${name}: ${r.error.message}`);
    continue;
  }
  const { open, samples, done } = r;
  const secs = samples.length / 24000, loud = samples.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
  const rms = Math.sqrt(samples.reduce((a, v) => a + v * v, 0) / samples.length);
  // the song's own length: the beats the engine was given at its tempo, 0.2 s of lead and end,
  // and the first word's opening consonants, which the engine sets before beat 0
  const beats = open.song.beats;
  const want = beats * 60 / sung.bpm + 0.2, onset = secs - want;
  console.log(`     ${name}: ${open.frames} frames, ${secs.toFixed(2)} s of sound made in ${(done.ms / 1000).toFixed(2)} s, ${open.breaths.length} breaths, the singer ${(open.lag * 1000).toFixed(0)} ms late, peak ${loud.toFixed(3)}, rms ${rms.toFixed(4)}, the limiter on for ${(100 * done.held / samples.length).toFixed(2)}% of it`);
  check(samples.length === open.frames * 240 && Math.abs(secs - done.secs) < 1e-9, `${name}: every frame's samples came (${open.frames} frames, ${samples.length} samples)`);
  check(onset > -0.005 && onset < 0.25, `${name}: the song is as long as its notes and its first word's opening (${secs.toFixed(2)} s for ${want.toFixed(2)} s of notes, ${(onset * 1000).toFixed(0)} ms of opening)`);
  check(samples.every(Number.isFinite) && loud > 0.02 && loud <= 1, `${name}: the sound is numbers, not silence, and under full scale`);
  check(done.held < samples.length / 100, `${name}: the limiter is a net, on for under a hundredth of the sound (${(100 * done.held / samples.length).toFixed(2)}%)`);
  // beat 0 is after the engine's 10 frames and the first word's opening consonants: none where it
  // opens on a vowel ("Amazing")
  check(open.text.startsWith(`%bpm ${sung.bpm}\n`) && open.song.bpm === sung.bpm && open.lead === 10 + Math.round(onset * 100) && open.lead >= 10 && open.lead <= 35 && (name !== "grace" || open.lead === 10), `${name}: the song the engine was given is at the part's tempo, its beat 0 ${open.lead} frames in`);
  // the engine's own word on where a beat falls: each rest it reports starts on the beat the note
  // before it ends on, which is the lead and that many beats in
  {
    const starts = open.song.items.filter((x) => x.kind === "rest" && x.beat > 0).map((x) => x.beat);
    const fpb = 100 * 60 / sung.bpm, inner = open.rests.slice(open.rests.length - starts.length);
    const off = starts.map((b, i) => inner[i][0] - open.lead - Math.round(b * fpb));
    console.log(`     ${name}: ${starts.length} rests inside the song; each starts ${JSON.stringify(off)} frames from where the lead of ${open.lead} frames puts its beat`);
    check(starts.length === 0 || off.every((d) => d === 0), `${name}: the engine's rests start on the beats the lead puts them at`);
  }
  check(open.zero === Math.round((open.lead / 100 - open.lag) * 24000) && open.first === 0 && open.last === samples.length, `${name}: the part's beat 0 is at sample ${open.zero} of the sound, the lead less the singer's lateness`);
  const marked = [...sung.wants].filter(([, b]) => b).length, barred = [...sung.wants].filter(([, b]) => !b).length;
  check(open.breaths.length >= marked && open.breaths.length <= sung.phrases.length - barred, `${name}: ${open.breaths.length} breaths for ${sung.phrases.length} phrases, ${marked} marked taken and ${barred} marked not`);
  check(open.breaths.every(([at, n]) => at >= 0 && at + n <= samples.length), `${name}: each breath is inside the sound`);
  if (outDir) {
    writeFileSync(join(outDir, `${name}.wav`), wav(samples));
    console.log(`     ${join(outDir, `${name}.wav`)}`);
  }
}

// the same part sung twice is the same sound
{
  const [a, b] = [await sing(EXAMPLES.mary()), await sing(EXAMPLES.mary())];
  check(!a.error && !b.error && a.samples.length === b.samples.length && a.samples.every((v, i) => v === b.samples[i]), "Mary sung twice is the same samples");
  // on the clock all singers share: as long, its beat 0 where it was, its consonants its own no more
  const [t, u] = [await sing(EXAMPLES.mary(), { together: true }), await sing(EXAMPLES.mary(), { together: true })];
  const apart = t.error ? 0 : t.samples.reduce((n, v, i) => n + (v !== a.samples[i] ? 1 : 0), 0);
  console.log(`     Mary on the one clock: ${t.error ? t.error.message : `${(100 * apart / t.samples.length).toFixed(1)}% of the samples are other than hers alone`}`);
  check(!t.error && t.open.frames === a.open.frames && t.open.zero === a.open.zero && !/^together$/m.test(t.open.text), "Mary on the one clock is as long, her beat 0 where it was, and the song said of her has no line the page's parse does not know");
  check(!t.error && apart > 0 && !u.error && t.samples.every((v, i) => v === u.samples[i]), "her sound is other than alone, and the same each time");
}

// a stretch of the part is the same sound as that stretch of the whole
{
  const part = EXAMPLES.mary(), whole = await sing(part);
  for (const [from, to, early] of [[8 * 480, 12 * 480, 0], [0, 6 * 480, 0], [20 * 480 + 77, 36 * 480, 0], [8 * 480, 12 * 480, 2400], [0, 6 * 480, 100000], [16 * 480, undefined, 2400], [undefined, 6 * 480, 2400]]) {
    const r = await sing(part, { from, to, early });
    if (r.error) { check(false, `Mary from tick ${from} to ${to}: ${r.error.message}`); continue; }
    const { open, samples } = r, at = (tick) => open.zero + Math.round(tick / 480 * 60 / 96 * 24000);
    let worst = 0, energy = 0;
    for (let i = 0; i < samples.length; i++) { worst = Math.max(worst, Math.abs(samples[i] - whole.samples[open.first + i])); energy += samples[i] ** 2; }
    console.log(`     Mary from tick ${from} to ${to}: samples ${open.first} to ${open.last}, off the whole's by ${worst.toExponential(2)} at most, rms ${Math.sqrt(energy / samples.length).toFixed(4)}`);
    const sooner = from === undefined ? 0 : Math.min(early, at(from));
    check(open.early === sooner && open.first === (from === undefined ? 0 : at(from) - sooner) && open.last === (to === undefined ? whole.samples.length : Math.min(whole.samples.length, at(to) - sooner)) && samples.length === open.last - open.first && open.zero === whole.open.zero, `Mary from tick ${from} to ${to}, ${early} samples early: the samples its ticks fall on, ${samples.length} of them, ${open.early} sooner`);
    check(worst < 0.02, `Mary from tick ${from} to ${to}: the sound the whole has there`);
  }
  const none = await sing(part, { from: 40 * 480, to: 44 * 480 });
  check(none.error && none.error.message === "beat 40 to 44: the part has no sound there", "a stretch past the part's end is refused");
  const after = await sing(part, { from: 40 * 480, early: 2400 });
  check(after.error && after.error.message === "beat 40: the part has no sound there", "as is a start past its end");
}

// what the engine refuses is said by its beat
{
  const p = EXAMPLES.mary();
  p.notes = p.notes.map((n, i) => (i === 4 ? { ...n, lyric: "little" } : i === 5 ? { ...n, lyric: "_" } : n));
  const r = await sing(p);
  check(r.error && r.error.at === 8 * 480 && /^beat 8: "little" is written in 1 syllable and sung in 2 \(/.test(r.error.message), `a word written in one syllable and sung in two is refused at its beat: ${r.error?.message}`);
  const q = { ...EXAMPLES.mary(), singer: { ...EXAMPLES.mary().singer, voice: "nobody" } };
  const e = await sing(q);
  check(e.error && e.error.message.startsWith("the singer's voice is not on this site: choose one of ") && !/\d/.test(e.error.message), "a voice the site has not is refused by name");
  const u = await sing(EXAMPLES.unfinished());
  check(u.error && u.error.message.startsWith("beat 0: the note C3 has no words") && u.error.at === 0, "a part that cannot be sung yet is refused with what is in the way");
  // a breath marked where no rest is written: taken, out of the note before, where that note can
  // give the time; refused by its beat where it cannot, as is one marked inside a word
  const slow = { ...P.blank(P.singer("6147")), tempo: [{ at: 0, bpm: 60 }], marks: [{ at: 6 * 960, breath: true }, { at: 2 * 960, breath: false }] };
  slow.notes = ["la", "la", "la", "la"].map((lyric, i) => ({ at: (2 + 2 * i) * 960, ticks: 2 * 960, pitch: "A4", cents: 0, velocity: 64, release: 64, lyric }));
  const f = await sing(slow);
  check(!f.error && f.open.breaths.length === 1 && f.open.text.includes("\n%rest ") && f.open.breaths[0][0] > 5 * 24000 && f.open.breaths[0][0] < 6.2 * 24000, `a breath marked on a word with no rest before it is taken there, and the one before the first note is not${f.error ? `: ${f.error.message}` : ""}`);
  const m = EXAMPLES.mary();
  m.marks = [{ at: 6 * 480, breath: true }];
  const g = await sing(m);
  check(g.error && g.error.at === 6 * 480 && g.error.message.startsWith("beat 6: the breath marked does not fit"), `a breath marked where the note before cannot give the time is refused at its beat${g.error ? "" : ": it was sung"}`);
  m.marks = [{ at: 5 * 480, breath: true }];
  const h = await sing(m);
  check(h.error && h.error.message === "beat 5: the mark is in no rest and on no word's first note", "as is one marked inside a word");
}

// ---- several at once, as a score's singers are sung
{
  const same = (x, y) => x.samples.length === y.samples.length && x.samples.every((v, i) => v === y.samples[i]);
  const parts = [EXAMPLES.mary(), EXAMPLES.twinkle(), EXAMPLES.row()];
  const alone = [];
  for (const part of parts) alone.push(await sing(part));
  const order = [];
  const t = performance.now();
  const at = ids;
  const many = await Promise.all(parts.map((part, i) => {
    const was = sing(part), id = at + i + 1, heard = waiting.get(id);
    waiting.set(id, (m) => { if (m.type === "chunk") order.push(i); heard(m); });
    return was;
  }));
  const ms = performance.now() - t, secs = many.reduce((a, x) => a + x.samples.length / 24000, 0);
  check(many.every((x, i) => !x.error && same(x, alone[i])), "three parts sung at once in one worker: each sample for sample what it is sung alone");
  const turns = order.filter((v, i) => i > 0 && order[i - 1] !== v).length;
  check(turns > order.length / 2, `their chunks come in turn (${turns} changes of singer in ${order.length} chunks)`);
  console.log(`     ${secs.toFixed(1)} s of sound for three singers made in ${(ms / 1000).toFixed(1)} s in one worker`);
  // one stopped, the other finished
  const keep = sing(parts[0]), drop = sing(parts[1]);
  worker.postMessage({ type: "stop", ids: [ids] });
  const gone = await Promise.race([drop.then(() => "sung"), keep.then((x) => (same(x, alone[0]) ? "the other whole" : "the other wrong"))]);
  check(gone === "the other whole", "one of two stopped: the other is sung whole, and the stopped one says no more");
}

// ---- the site's other routes, and one it has not
{
  const { routesOf } = await import(join(own ? site : join(here, "../web"), "routes.js"));
  const made = (by) => new Promise((yes) => {
    const w = new Worker(join(here, "node_singer.mjs"), { workerData: { site, web: own ? site : join(here, "../web"), route: by } });
    const chunks = [];
    let was = null;
    w.on("message", async (m) => {
      if (m.type === "ready") {
        was = m;
        w.postMessage({ type: "sing", id: 1, part: EXAMPLES.mary(), step: 20 });
      } else if (m.type === "chunk") chunks.push(m.samples);
      else if (m.type === "error" || m.type === "done") {
        await w.terminate();
        yes({ ready: was, error: m.type === "error" ? m : null, done: m, n: chunks.reduce((a, c) => a + c.length, 0), peak: chunks.reduce((a, c) => c.reduce((x, v) => Math.max(x, Math.abs(v)), a), 0) });
      }
    });
  });
  const routes = routesOf(offered);
  check(JSON.stringify(first.routes) === JSON.stringify(routes), `the singer says the site's routes: ${routes.join(", ")}`);
  for (const by of routes.slice(1)) {
    const x = await made(by);
    check(!x.error && x.ready.route === by && x.n > 0 && x.done.held < x.n / 100 && x.peak < 1, `asked for the ${by} route, Mary is sung by it: peak ${x.peak.toFixed(3)}, the limiter on for ${(100 * x.done.held / x.n).toFixed(2)}% of it`);
  }
  const none = await made("slow");
  check(none.error && none.ready === null && none.error.message === `this site has no slow sound (it has ${routes.join(" and ")})`, "a route the site has not is refused by name");
}

await worker.terminate();
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
