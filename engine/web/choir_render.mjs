// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The choir as the page makes it, in node: worker.js in worker threads (one with the speech model,
// the page's own, and light helpers), choir.js mixing, the conductor and the deck (conduct.js,
// deck.js) keeping it made and played, player.js played in real time on a clock. Reports the speed
// and the time to first sound, cold (workers and voices not loaded) and warm, and writes the mix as
// it was heard (16-bit stereo) and each part as made (32-bit float), 24 kHz wavs. With --moves, the
// choir is then played as a listener might: a jump ahead of what is made, a change of room as it
// plays, a jump back, one singer changed; how long each took to be heard is reported and what was
// heard is written.
//
//     node choir_render.mjs SITE OUT-DIR [--moves] [PRESET...]
//
// SITE: the built site (lipservice.wasm and models/); the page's files are this directory's.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { routeOf } from "./node_choir.mjs";

const web = dirname(fileURLToPath(import.meta.url));
const [site, outDir, ...rest] = process.argv.slice(2);
if (!site || !outDir) {
  console.error("usage: node choir_render.mjs SITE OUT-DIR [--moves] [PRESET...]");
  process.exit(2);
}
const moves = rest.includes("--moves"), only = rest.filter((a) => a !== "--moves");
const { Choir, SR } = await import(join(web, "choir.js"));
const { Deck } = await import(join(web, "deck.js"));
const { Conductor } = await import(join(web, "conduct.js"));
const { CHOIRS, arrange } = await import(join(web, "choirs.js"));
const { readFileSync } = await import("node:fs");
const voices = JSON.parse(readFileSync(join(site, "models/voices.json"), "utf8"));

// player.js as the browser runs it
let Player = null;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => this.posted.push(m), onmessage: null }; this.posted = []; } };
globalThis.registerProcessor = (_, c) => { Player = c; };
await import(join(web, "player.js"));

// the speaker: the player taking a quantum of 128 samples every 128 / SR s of the wall clock; what
// it says ("at", "ended") goes to onWord
class Speaker {
  constructor() {
    this.player = new Player();
    this.t0 = performance.now();
    this.done = 0;
    this.heard = [];
    this.told = 0;
    this.onWord = () => {};
    this.timer = setInterval(() => this.tick(), 1);
  }
  // the audio clock, in samples
  clock() { return ((performance.now() - this.t0) / 1000) * SR; }
  pump() {
    const due = Math.floor(this.clock() / 128);
    for (; this.done < due; this.done++) {
      const o = [new Float32Array(128), new Float32Array(128)];
      globalThis.currentFrame = this.done * 128;
      this.player.process([], [o]);
      this.heard.push(o);
    }
  }
  // its words come in a turn of their own, as a port's do, never inside a send
  tick() {
    this.pump();
    while (this.told < this.player.posted.length) this.onWord(this.player.posted[this.told++]);
  }
  send(m) {
    this.pump();
    globalThis.currentFrame = this.done * 128;
    this.player.port.onmessage({ data: m });
  }
  get ended() { return this.player.posted.filter((m) => m.type === "ended"); }
  // the quantum a wall time `t` falls in
  at(t) {
    return Math.floor(((t - this.t0) / 1000) * SR / 128);
  }
  // what was heard from the wall time `t`, [left, right], and the ms from `t` to its first sound
  since(t) {
    const q = this.heard.slice(this.at(t));
    const y = [0, 1].map((c) => {
      const x = new Float32Array(q.length * 128);
      q.forEach((o, i) => x.set(o[c], i * 128));
      return x;
    });
    const k = y[0].findIndex((v, i) => v !== 0 || y[1][i] !== 0);
    return { y, first: k < 0 ? null : (this.at(t) * 128 + k) / SR * 1000 - (t - this.t0) };
  }
  close() { clearInterval(this.timer); }
}

class NodeWorker {
  constructor(light) {
    this.w = new Worker(join(web, "node_worker.mjs"), { workerData: { web, site, light, route: routeOf(site) } });
    this.onmessage = null;
    this.w.on("message", (data) => this.onmessage?.({ data }));
    this.w.on("error", (e) => { console.error(e); process.exit(1); });
  }
  postMessage(m, transfer) { this.w.postMessage(m, transfer); }
  terminate() { return this.w.terminate(); }
}

// a wav of channels [c0, c1, ...], each a list of chunks: 16-bit, or 32-bit float for a part, whose
// singer is made at full scale and may pass 1
function wav(path, channels, float = false) {
  const flat = channels.map((cs) => {
    const x = new Float32Array(cs.reduce((a, c) => a + c.length, 0));
    let k = 0;
    for (const c of cs) { x.set(c, k); k += c.length; }
    return x;
  });
  const nc = flat.length, n = flat[0].length, b = float ? 4 : 2;
  if (flat.some((x) => x.length !== n)) throw new Error(`${path}: the channels differ in length`);
  const buf = Buffer.alloc(44 + b * n * nc);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + b * n * nc, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(float ? 3 : 1, 20); buf.writeUInt16LE(nc, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(b * SR * nc, 28); buf.writeUInt16LE(b * nc, 32); buf.writeUInt16LE(8 * b, 34);
  buf.write("data", 36); buf.writeUInt32LE(b * n * nc, 40);
  let k = 44;
  for (let i = 0; i < n; i++) {
    for (const x of flat) {
      if (float) {
        if (!Number.isFinite(x[i])) throw new Error(`${path}: a sample, ${x[i]}, is not finite`);
        buf.writeFloatLE(x[i], k);
      } else {
        if (!(Math.abs(x[i]) <= 1)) throw new Error(`${path}: a sample, ${x[i]}, does not fit 16 bits`);
        buf.writeInt16LE(Math.round(x[i] * 32767), k);
      }
      k += b;
    }
  }
  writeFileSync(path, buf);
  return n / SR;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const cores = cpus().length;
mkdirSync(outDir, { recursive: true });
let id = 0;

for (const name of only.length ? only : Object.keys(CHOIRS)) {
  const preset = CHOIRS[name];
  if (!preset) throw new Error(`no choir ${name}`);
  const job = arrange(preset, { list: voices, route: routeOf(site) });
  const parts = job.parts;
  console.log(`\n${name}: ${parts.length} voices (${parts.map((p) => `${p.name} ${p.voice}`).join(", ")}), ${cores} cores`);

  // the page's own worker, loaded before anything is pressed
  const main = new NodeWorker(false);
  const speaker = new Speaker();
  let onEnd = () => {}, onSwap = () => {}, onBegin = () => {}, last = null;
  const fail = (message) => { console.error(`choir failed: ${message}`); process.exit(1); };
  const deck = new Deck({
    send: (m) => speaker.send(m), clock: () => speaker.clock(), nextId: () => ++id,
    ahead: (t, c) => cond.ahead(t, c),
    onBegin: (u) => onBegin(u), onEnd: (m) => onEnd(m), onSwap: (t, c) => onSwap(t, c),
  });
  speaker.onWord = (m) => deck.hear(m);
  const choir = new Choir({
    main, cores, cap: +(process.env.CHOIR_WORKERS ?? 4), spawn: () => new NodeWorker(true),
    onSound: (j, y, at) => cond.sound(j, y, at), onOpen: (j) => cond.opened(j), onDone: (j, st) => cond.done(j, st),
    onError: (message) => cond.error(message),
  });
  const cond = new Conductor({ choir, deck, nextId: () => ++id, onDone: (t, st) => { last = st; }, onError: fail });
  const rawParts = parts.map(() => []);
  const message = choir.message.bind(choir);
  choir.message = (k, m) => { if (m.type === "choir-chunk") rawParts[m.part].push(m.samples.slice()); message(k, m); };
  await new Promise((resolve) => {
    main.onmessage = ({ data }) => { if (data.type === "ready") resolve(data); else if (data.type === "error") { console.error(data.message); process.exit(1); } else choir.message(0, data); };
  });
  main.onmessage = ({ data }) => choir.message(0, data);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // the choir made anew and played to its end
  const run = async (label) => {
    cond.forget();
    rawParts.forEach((r) => { r.length = 0; });
    const ended = new Promise((r) => { onEnd = r; });
    const t = performance.now();
    const take = cond.sing(job);
    const e = await ended, stats = last;
    const { first } = speaker.since(t);
    console.log(`${label}: first sound out of the speaker ${first.toFixed(0)} ms after the press (made ${take.first.toFixed(0)} ms after it); `
      + `${stats.mix.toFixed(1)} s of choir, ${stats.secs.toFixed(1)} s of singing from ${stats.parts} voices made in ${stats.wall.toFixed(2)} s on ${stats.workers} workers; `
      + `${stats.speed.toFixed(1)}x counting every voice, ${stats.perCompute.toFixed(1)}x per second of compute (${stats.busy.toFixed(2)} s), `
      + `${stats.realtime.toFixed(1)}x real time for the choir; playback stalls ${e.stalls}, stopped ${e.stopped}`);
    return { stats, first, ended: e, t, take };
  };

  const cold = await run("cold (workers and voices not loaded)");
  await sleep(300);
  const warm = await run("warm (loaded)");
  if (cold.ended.stalls || warm.ended.stalls) console.log("PLAYBACK STALLED");

  // the warm run's mix as the speaker played it, from its first sound, and each part as made
  const { y: heard } = speaker.since(warm.t);
  const stream = warm.take.ch.map((c) => c.subarray(0, warm.take.length));
  const total = stream[0].length;
  // the speaker multiplies by a ramp above 0, so both streams have their first sample that is not 0 together
  const nz = (l, r) => l.findIndex((v, i) => v !== 0 || r[i] !== 0);
  const lag = nz(heard[0], heard[1]) - nz(stream[0], stream[1]);
  const played = heard.map((x) => x.subarray(lag, lag + total));
  // the speaker adds only its edge fades; between them it plays the mix as given
  let differ = 0;
  for (let c = 0; c < 2; c++) for (let i = 192 * 2; i < total - 192 * 2; i++) if (played[c][i] !== stream[c][i]) differ++;
  console.log(`played mix against the room's stream, between the edge fades: ${differ} samples differ of ${2 * (total - 384)}`);

  const base = slug(name);
  console.log(`wrote ${join(outDir, `${base}-mix.wav`)}: ${wav(join(outDir, `${base}-mix.wav`), played.map((x) => [x])).toFixed(2)} s, stereo`);
  parts.forEach((p, i) => {
    const file = join(outDir, `${base}-${i + 1}-${slug(p.name)}-${p.voice}.wav`);
    console.log(`wrote ${file}: ${wav(file, [rawParts[i]], true).toFixed(2)} s, 32-bit float`);
  });

  if (moves) {
    // as a listener might: 3 s in, a jump to 0.6 of the way; 3 s on, another room; 3 s on, back to
    // 5 s in, where the first making stopped short; 4 s of that and stop; then set down in the middle
    cond.forget();
    const t = performance.now(), log = [];
    const begun = () => new Promise((r) => { onBegin = () => r(performance.now()); });
    const hearing = async (secs) => { const p0 = deck.played(); while (deck.played() < p0 + secs * SR) await sleep(10); };
    let b = begun();
    const take = cond.sing(job);
    log.push(`pressed: sound ${((await b) - t).toFixed(0)} ms on`);
    await hearing(3);
    const T = Math.floor(0.6 * take.length), had = take.has(T), t1 = performance.now();
    b = begun();
    cond.seek(T);
    log.push(`a jump to ${(T / SR).toFixed(1)} s (${had ? "made already" : `not made: the making was at ${(take.end(0) / SR).toFixed(1)} s`}): sound ${((await b) - t1).toFixed(0)} ms on`);
    await hearing(3);
    const other = job.room === "bare" ? "driest" : "bare", t2 = performance.now(), at = deck.played();
    const swapped = new Promise((r) => { onSwap = (_, c) => r([performance.now(), c]); });
    cond.change({ ...job, room: other });
    const from = cond.job.from;
    const [t3, c] = await swapped;
    log.push(`the room changed from ${job.room} to ${other}, the speaker at ${(at / SR).toFixed(2)} s: sung again from ${(from / SR).toFixed(2)} s (ready ${(t3 - t2).toFixed(0)} ms on), the change heard at ${(c / SR).toFixed(2)} s, ${(1000 * (c - at) / SR).toFixed(0)} ms after it was asked`);
    await hearing(3);
    const t4 = performance.now(), nt = cond.cur, had5 = nt.has(5 * SR);
    b = begun();
    cond.seek(5 * SR);
    log.push(`a jump back to 5.0 s (${had5 ? "made" : "not made"} in the new room): sound ${((await b) - t4).toFixed(0)} ms on`);
    await hearing(4);
    // one singer sings it another way: the rest are kept
    const t7 = performance.now(), at7 = deck.played(), k = Math.min(2, parts.length - 1);
    const swapped2 = new Promise((r) => { onSwap = (_, c) => r([performance.now(), c]); });
    cond.change({ ...cond.cur.settings, parts: cond.cur.settings.parts.map((p, i) => (i === k ? { ...p, seed: p.seed + 100 } : p)) });
    const [t8, c2] = await swapped2;
    log.push(`${parts[k].name} sings it another way, the speaker at ${(at7 / SR).toFixed(2)} s: ready ${(t8 - t7).toFixed(0)} ms on, the change heard at ${(c2 / SR).toFixed(2)} s, ${(1000 * (c2 - at7) / SR).toFixed(0)} ms after it was asked`);
    await hearing(2);
    const stalls = deck.run.stalls;
    cond.stop();
    await sleep(100);
    // stopped, then set down in the middle: how much of the next 1.5 s is sound
    const mid = Math.floor(0.5 * nt.length), hadMid = nt.has(mid), t5 = performance.now();
    b = begun();
    cond.seek(mid);
    const t6 = await b;
    await sleep(1500);
    log.push(`stopped, then a jump to ${(mid / SR).toFixed(1)} s (${hadMid ? "made" : "not made"}): sound ${(t6 - t5).toFixed(0)} ms on; 1.5 s later the speaker is ${((deck.played() - mid) / SR).toFixed(2)} s in, ${deck.run.stalls} stalls, ${((nt.end(mid) - mid) / SR).toFixed(2)} s made from there`);
    cond.stop();
    await sleep(100);
    for (const l of log) console.log(`moves: ${l}`);
    console.log(`moves: stalls in the last stretch ${stalls}; the tape made ${JSON.stringify(cond.cur.spans.map(([a, z]) => [+(a / SR).toFixed(2), +(z / SR).toFixed(2)]))} s`);
    const { y } = speaker.since(t);
    console.log(`wrote ${join(outDir, `${slug(name)}-moves.wav`)}: ${wav(join(outDir, `${slug(name)}-moves.wav`), y.map((x) => [x])).toFixed(2)} s, stereo, as heard from the press`);
  }

  speaker.close();
  await main.terminate();
  await Promise.all(choir.pool.slice(1).map((w) => w.terminate()));
}
process.exit(0);
