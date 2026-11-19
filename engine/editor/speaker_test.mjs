// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// speaker.js run as a browser's audio thread runs it, 128 samples a block: the singers' takes
// come out sample for sample where the line has them, the sound waits for a singer that has none,
// goes round a loop, jumps, fades a singer's next take in, lets a late singer join, clicks on the
// beats; and the limiter holds its ceiling.
//
//     node speaker_test.mjs

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };

const registered = new Map();
let making = null;
globalThis.sampleRate = 24000;
globalThis.currentFrame = 0;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage: (m) => making.push(m) }; } };
globalThis.registerProcessor = (name, made) => registered.set(name, made);
await import("./speaker.js");
const { SLOTS, EVERY, FADE, CROSS, AHEAD, JOIN, LOOK } = globalThis.SPEAKER;

// a speaker, what it has said, and its next blocks of sound: [slot][sample]
function speaker() {
  const said = [];
  making = said;
  const p = new (registered.get("speaker"))();
  const tell = (m) => p.port.onmessage({ data: m });
  const render = (blocks) => {
    const out = Array.from({ length: SLOTS + 1 }, () => []);
    for (let b = 0; b < blocks; b++) {
      const o = Array.from({ length: SLOTS + 1 }, () => [new Float32Array(128)]);
      p.process([], o);
      globalThis.currentFrame += 128;
      o.forEach((ch, k) => out[k].push(...ch[0]));
    }
    return out;
  };
  return { p, said, tell, render };
}
// a take's sound: sample i of slot k is a number that names both
const wave = (k, n, from = 0) => Float32Array.from({ length: n }, (_, i) => ((k + 1) * 1000 + ((from + i) % 997)) / 20000);
const near = (a, b) => Math.abs(a - b) < 1e-6;
const give = (s, slot, id, samples) => s.tell({ type: "chunk", slot, id, samples });

// ---- two singers from the line's start
{
  const s = speaker();
  s.tell({ type: "take", slot: 0, id: 1, from: 100, length: 20000, now: true });
  s.tell({ type: "take", slot: 1, id: 2, from: 0, length: 20000, now: true });
  s.tell({ type: "play", pos: 0, loop: null, end: 20100, wait: [0, 1] });
  give(s, 0, 1, wave(0, 20000));
  let out = s.render(4);
  check(out.every((ch) => ch.every((v) => v === 0)) && !s.p.running && s.p.pos === 0, "with one singer's sound and not the other's, nothing sounds and the line stays");
  give(s, 1, 2, wave(1, AHEAD - 1));
  check(s.render(1)[1].every((v) => v === 0), "nor with a sample under the fifth of a second it waits for");
  give(s, 1, 2, wave(1, 20000 - AHEAD + 1, AHEAD - 1));
  out = s.render(8);
  const w0 = wave(0, 20000), w1 = wave(1, 20000);
  check(near(out[1][FADE], w1[FADE]) && near(out[1][1023], w1[1023]) && out[1][0] < w1[0] && out[1][0] >= 0, "then it sounds, faded up, each sample in its place");
  check(out[0].slice(0, 100).every((v) => v === 0) && near(out[0][100], w0[0]) && near(out[0][1023], w0[923]), "a take that starts later on the line is silent until its start");
  check(s.said.some((m) => m.type === "at" && m.running && m.pos > 0 && m.frame > 0 && m.frame % 128 === 0), "it says where it is, and that it runs");
  s.tell({ type: "done", slot: 0, id: 1 });
  s.tell({ type: "done", slot: 1, id: 2 });
  s.render(Math.ceil(20100 / 128));
  check(s.said.some((m) => m.type === "ended") && !s.p.on && s.p.slots.every((x) => !x.cur), "at the line's end it says so, and holds nothing");
}

// ---- a singer that falls behind
{
  const s = speaker();
  s.tell({ type: "take", slot: 0, id: 1, from: 0, length: 48000, now: true });
  s.tell({ type: "play", pos: 0, loop: null, end: 48000, wait: [0] });
  give(s, 0, 1, wave(0, 6000));
  const out = s.render(60);
  const stop = out[0].findLastIndex((v) => v !== 0);
  check(!s.p.running && s.p.stalls === 1 && s.p.pos > 5600 && s.p.pos <= 6000 && stop < s.p.pos, `out of sound, it fades and waits (at ${s.p.pos} of 6000), having skipped none`);
  const held = s.p.pos;
  give(s, 0, 1, wave(0, 42000, 6000));
  const more = s.render(2);
  check(s.p.running && near(more[0][FADE + 1], wave(0, 48000)[held + FADE + 1]), "and goes on from where it stopped when there is more");
}

// ---- round a loop, with the click
{
  const s = speaker();
  const loop = { from: 2000, to: 8000 };
  s.tell({ type: "take", slot: 3, id: 7, from: 2000, length: 6000, now: true });
  give(s, 3, 7, wave(3, 6000));
  s.tell({ type: "done", slot: 3, id: 7 });
  s.tell({ type: "beats", list: [{ at: 2000, accent: true }, { at: 5000, accent: false }] });
  s.tell({ type: "play", pos: 2000, loop, end: Infinity, wait: [3] });
  const out = s.render(Math.ceil(13000 / 128)), w = wave(3, 6000);
  check(near(out[3][3000], w[3000]) && near(out[3][6000 + 3000], w[3000]) && near(out[3][12000 + 500], w[500]) && s.p.rounds === 2, "the loop's stretch comes round again and again, sample for sample");
  check(out[3][5999] === 0 || Math.abs(out[3][5999]) < Math.abs(w[5999]) / JOIN * 2, "faded down into the join");
  check(Math.abs(out[3][6000 + JOIN + 5] - w[JOIN + 5]) < 1e-6 && Math.abs(out[3][6000 + 2]) < Math.abs(w[2]), "and up out of it");
  const click = out[SLOTS];
  check(click[30] !== 0 && click[3000 + 30] !== 0 && click[6000 + 30] !== 0 && click[9000 + 30] !== 0 && click[1500] === 0, "the click sounds on each beat, each time round");
  check(Math.abs(click[110] - click[6000 + 110]) < 1e-6 && Math.abs(click[110] - click[3110]) > 1e-4, "a bar's first beat by its own tone");
  check(out[0].every((v) => v === 0), "a slot with no singer is silent");
}

// ---- a jump, and a stop
{
  const s = speaker();
  s.tell({ type: "take", slot: 0, id: 1, from: 0, length: 48000, now: true });
  give(s, 0, 1, wave(0, 48000));
  s.tell({ type: "done", slot: 0, id: 1 });
  s.tell({ type: "play", pos: 0, loop: null, end: 48000, wait: [0] });
  s.render(10);
  s.tell({ type: "seek", pos: 30000 });
  const a = s.render(1), b = s.render(2), w = wave(0, 48000);
  check(a[0][127] === 0 && a[0][0] !== 0 && near(b[0][FADE + 1], w[30000 + FADE + 1]) && s.p.pos === 30000 + 256, "a jump: faded down, then the sound of the new place faded up");
  s.tell({ type: "stop" });
  const c = s.render(2);
  check(c[0][0] !== 0 && c[0][127] === 0 && c[0].slice(128).every((v) => v === 0) && !s.p.on && !s.p.slots[0].cur, "a stop: faded out, and nothing held");
}

// ---- a singer sung anew while it sounds
{
  const s = speaker();
  s.tell({ type: "take", slot: 0, id: 1, from: 0, length: 48000, now: true });
  give(s, 0, 1, wave(0, 48000));
  s.tell({ type: "done", slot: 0, id: 1 });
  s.tell({ type: "play", pos: 0, loop: null, end: 48000, wait: [0] });
  s.render(10);
  s.tell({ type: "take", slot: 0, id: 2, from: 4000, length: 44000, now: false });
  const before = s.render(10);
  check(near(before[0][700], wave(0, 48000)[1280 + 700]) && s.p.slots[0].cur.id === 1, "the take that sounds goes on while the next has nothing");
  give(s, 0, 2, wave(5, 44000));
  const during = s.render(4), w1 = wave(0, 48000), w2 = wave(5, 44000);
  const at = 2560, mid = Math.floor(CROSS / 2);
  check(near(during[0][mid], w1[at + mid]) && s.p.slots[0].cur.id === 1 && s.p.pos < 4000, "and until the line reaches the next one's start");
  const on = s.render(16);
  const p0 = 2560 + 512; // the line at on[0]
  const swapped = s.said.find((m) => m.type === "swapped");
  check(swapped && swapped.slot === 0 && swapped.id === 2 && s.p.slots[0].cur.id === 2 && !s.p.slots[0].next, "then the next is faded in, and the speaker says so");
  const i = 4000 - p0 + CROSS + 200;
  check(near(on[0][i], w2[p0 + i - 4000]) && near(on[0][4000 - p0 - 5], w1[4000 - 5]), "the old sound before the fade, the new after");
  const m = 4000 - p0 + Math.ceil((128 - ((4000 - p0) % 128)) % 128) + mid;
  check(on[0][m] > Math.min(w1[p0 + m], w2[p0 + m - 4000]) - 1e-6 && on[0][m] < Math.max(w1[p0 + m], w2[p0 + m - 4000]) + 1e-6, "between the two within it");
}

// ---- a singer that runs out with its next waiting; one that joins; one dropped
{
  const s = speaker();
  s.tell({ type: "take", slot: 0, id: 1, from: 0, length: 48000, now: true });
  s.tell({ type: "take", slot: 1, id: 5, from: 0, length: 48000, now: true });
  give(s, 0, 1, wave(0, 9000));
  give(s, 1, 5, wave(1, 48000));
  s.tell({ type: "done", slot: 1, id: 5 });
  s.tell({ type: "play", pos: 0, loop: null, end: 48000, wait: [0, 1] });
  s.render(20);
  s.tell({ type: "take", slot: 0, id: 2, from: 6000, length: 42000, now: false });
  s.render(60);
  check(s.p.slots[0].cur.id === 2 && !s.p.running && s.p.pos <= 9000 && s.p.pos > 8600, "the old take run out, the next is the slot's, and all wait for it");
  give(s, 0, 2, wave(6, 42000));
  s.tell({ type: "done", slot: 0, id: 2 });
  const out = s.render(4);
  check(s.p.running && near(out[0][300], wave(6, 42000)[s.p.pos - 512 + 300 - 6000]) && near(out[1][300], wave(1, 48000)[s.p.pos - 512 + 300]), "then both go on together");
  // a third singer comes in while they sound
  s.tell({ type: "take", slot: 2, id: 9, from: 12000, length: 36000, now: true });
  const lone = s.render(8);
  check(s.p.running && lone[2].every((v) => v === 0) && lone[1].some((v) => v !== 0), "a singer added while the others sound does not make them wait");
  give(s, 2, 9, wave(2, 36000));
  const from = s.p.pos, joined = s.render(Math.ceil((12000 - from) / 128) + 6), j = 12000 - from + FADE + 300;
  check(s.p.slots[2].joined && near(joined[2][j], wave(2, 36000)[from + j - 12000]) && joined[2].slice(0, 12000 - from).every((v) => v === 0), "it joins where its sound starts");
  s.tell({ type: "drop", slot: 1 });
  const gone = s.render(3);
  check(gone[1][0] !== 0 && gone[1][127] === 0 && !s.p.slots[1].cur && s.p.running && gone[2][300] !== 0, "a singer dropped fades out; the rest go on");
}

// ---- what the speaker refuses
{
  const s = speaker();
  s.tell({ type: "take", slot: 0, id: 1, from: 0, length: 100, now: true });
  give(s, 0, 1, new Float32Array(101));
  s.tell({ type: "take", slot: 40, id: 1, from: 0, length: 100, now: true });
  s.tell({ type: "dance" });
  check(s.said.filter((m) => m.type === "error").length === 3 && /101 samples for a take of 100/.test(s.said[0].message) && /no slot 40/.test(s.said[1].message) && /told to dance/.test(s.said[2].message), "more sound than a take holds, a slot there is none of, a word it does not know: each said");
  give(s, 0, 99, new Float32Array(10));
  check(s.said.length === 3, "sound for a take since replaced is let go");
  check(EVERY === 1024, "it says where it is every 1024 samples");
}

// ---- the limiter
{
  making = [];
  const lim = new (registered.get("limiter"))();
  const run = (l, r, ceiling = 0.5, release = 0.05) => {
    const out = [[], []];
    for (let i = 0; i < l.length; i += 128) {
      const o = [new Float32Array(128), new Float32Array(128)];
      lim.process([[l.subarray(i, i + 128), r.subarray(i, i + 128)]], [o], { ceiling: [ceiling], release: [release] });
      out[0].push(...o[0]);
      out[1].push(...o[1]);
    }
    return out;
  };
  const n = 128 * 200, quiet = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(i / 7));
  const q = run(quiet, quiet);
  check(q[0].slice(LOOK).every((v, i) => Math.abs(v - quiet[i + 1]) < 1e-6), `under the ceiling it is the sound itself, ${LOOK - 1} samples late`);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  const loud = Float32Array.from({ length: n }, (_, i) => (i % 5000 < 1500 ? 1.9 * rnd() : 0.2 * Math.sin(i / 9))), other = Float32Array.from({ length: n }, (_, i) => (i % 7000 === 3000 ? -3 : 0.1 * rnd()));
  const o = run(loud, other);
  const top = Math.max(...o[0].map(Math.abs), ...o[1].map(Math.abs));
  check(top <= 0.5 + 1e-6 && top > 0.45, `over it, no sample of either ear passes the ceiling (the most: ${top.toFixed(6)} of 0.5)`);
  const tail = run(quiet, quiet).slice(0, 1)[0];
  check(Math.abs(tail[n - 1] - quiet[n - LOOK]) < 1e-3, "and it lets go again once the sound is under it");
}

console.log(fails ? `\n${fails} failed` : "\nall ok");
process.exit(fails ? 1 : 0);
