// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The page's own script (index.html) run in node against a built site, with stand-ins for the
// document, the canvases and the audio and with worker.js in worker threads: it speaks, jumps in
// what it said, sings a choir, jumps ahead of what is made, changes the room and a voice as it
// plays, has a part and then a singer heard alone by a click on the stage and the choir back, starts
// the crowd, sings the choir again, and downloads what it said and the choir (made through for it)
// as files. Fails on any error the page throws or
// reports. It draws nothing: what the figures look like is for a browser. Where the site keeps
// notes (models/site.json), serve.py is run over it with a directory of its own for them, and a
// note is written, read back with its clip, and taken back.
//
//     node page_smoke.mjs SITE [KEEP]
//
// SITE: the built site (lipservice.wasm, models/, build.json); the page's files are this directory's.
// KEEP: a directory there already, to leave the downloaded files in.

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker as Thread } from "node:worker_threads";

const web = dirname(fileURLToPath(import.meta.url));
const site = process.argv[2], keep = process.argv[3] ?? null;
if (!site) {
  console.error("usage: node page_smoke.mjs SITE [KEEP]");
  process.exit(2);
}
const SR = 24000;
const fail = (what) => { console.error(`FAIL ${what}`); process.exit(1); };
process.on("uncaughtException", (e) => fail(e.stack));
process.on("unhandledRejection", (e) => fail(e?.stack ?? e));

// anything asked of it is there, does nothing and counts as 0
const nothing = () => {
  const kept = new Map();
  return new Proxy(function () {}, {
    get: (_, k) => (k === Symbol.toPrimitive ? () => 0 : k === "then" ? undefined : kept.has(k) ? kept.get(k) : (kept.set(k, nothing()), kept.get(k))),
    set: (_, k, v) => (kept.set(k, v), true),
    apply: () => nothing(),
    construct: () => nothing(),
  });
};
// an object whose missing parts are nothing
const lenient = (o) => new Proxy(o, { get: (t, k) => (k in t || typeof k === "symbol" || k === "then" ? t[k] : (t[k] = nothing())) });

// ---- the document
const ids = new Map(), said = [], files = []; // files: each download handed over, {name, bytes}
class El {
  constructor(tag) {
    Object.assign(this, { tag, children: [], hidden: false, disabled: false, checked: false, className: "", rows: 0, label: "", clientWidth: 900, clientHeight: 150, width: 0, height: 0, on: {}, text: "", val: null });
    this.style = lenient({ setProperty() {} });
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  set id(v) { this.name = v; ids.set(v, this); }
  get id() { return this.name; }
  get textContent() { return this.text; }
  set textContent(v) { this.text = String(v); if (this.name === "status") said.push([this.text, false]); }
  get value() { return this.val ?? (this.tag === "select" ? this.querySelector("option")?.value ?? "" : ""); }
  set value(v) { this.val = String(v); }
  append(...xs) { for (const x of xs) if (x instanceof El) this.children.push(x); }
  replaceChildren(...xs) { this.children = []; this.append(...xs); }
  querySelector(tag) {
    for (const c of this.children) {
      if (c.tag === tag) return c;
      const d = c.querySelector(tag);
      if (d) return d;
    }
    return null;
  }
  addEventListener(name, f) { (this.on[name] ??= []).push(f); }
  fire(name, e = {}) { for (const f of this.on[name] ?? []) f(e); }
  remove() {}
  // a link to a blob with a name to keep it by, clicked: a download
  click() {
    if (this.tag !== "a" || !this.download) fail(`a click on ${this.tag}`);
    const got = { name: this.download, bytes: null };
    files.push(got);
    fetchBlob(this.href).then((b) => { got.bytes = b; }, (e) => fail(e.stack));
  }
  setAttribute() {}
  setPointerCapture() {}
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  getContext() {
    return (this.g ??= lenient({
      measureText: (s) => ({ width: 7 * String(s).length }),
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(4 * w * h) }),
    }));
  }
}
const html = readFileSync(join(web, "index.html"), "utf8");
const $ = (id) => ids.get(id) ?? Object.assign(new El("div"), { id });
for (const m of html.matchAll(/<(input|select|textarea|button|canvas)\b([^>]*)>/g)) {
  const id = m[2].match(/\bid="([^"]+)"/)?.[1];
  if (!id) continue;
  const e = Object.assign(new El(m[1]), { id });
  const v = m[2].match(/\bvalue="([^"]*)"/);
  if (v) e.value = v[1];
  e.disabled = /\bdisabled\b/.test(m[2]);
  e.hidden = /\bhidden\b/.test(m[2]);
}
// the status line's class says whether it is an error
Object.defineProperty($("status"), "className", { set(v) { if (v === "err") said.at(-1)[1] = true; }, get() { return ""; } });
const keys = {}; // the document's listeners, by event
globalThis.document = { getElementById: $, createElement: (tag) => new El(tag), addEventListener(name, f) { (keys[name] ??= []).push(f); }, visibilityState: "visible", documentElement: {}, body: new El("body") };
// a key pressed and let go, with the page (or `target`) in focus
const press = (k, mods = {}, target = { tagName: "BODY" }) => {
  const e = { key: k, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, target, preventDefault() {}, ...mods };
  for (const name of ["keydown", "keyup"]) for (const f of keys[name] ?? []) f(e);
};
const fetchBlob = async (url) => new Uint8Array(await (await import("node:buffer")).resolveObjectURL(url).arrayBuffer());
globalThis.window = globalThis;
// the page's address: ROUTE in the environment asks for a sound as ?route= does (routes.js)
globalThis.location = { search: process.env.ROUTE ? `?route=${process.env.ROUTE}` : "", href: "http://page/" };
globalThis.devicePixelRatio = 1;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "#888" });
globalThis.matchMedia = () => ({ addEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 16);

// ---- the workers
globalThis.Worker = class {
  constructor(url) {
    const query = new URL(url, "http://page/").searchParams;
    this.w = new Thread(join(web, "node_worker.mjs"), { workerData: { web, site, light: query.has("light"), route: query.get("route") } });
    this.onmessage = null;
    this.w.on("message", (data) => this.onmessage?.({ data }));
    this.w.on("error", (e) => fail(e.stack));
  }
  postMessage(m, transfer) { this.w.postMessage(m, transfer); }
};

// ---- the audio: player.js taking a quantum of 128 samples every 128 / SR s of the wall clock
let Player = null;
globalThis.AudioWorkletProcessor = class { constructor() { this.posted = []; this.port = { postMessage: (m) => this.posted.push(m), onmessage: null }; } };
globalThis.registerProcessor = (_, c) => { Player = c; };
await import(pathToFileURL(join(web, "player.js")).href);
const heard = []; // every quantum played: its peak
globalThis.AudioContext = class {
  constructor({ sampleRate }) {
    Object.assign(this, { sampleRate, t0: performance.now(), state: "running", destination: {}, outputLatency: 0, audioWorklet: { addModule: async () => {} } });
    return lenient(this);
  }
  get currentTime() { return (performance.now() - this.t0) / 1000; }
  resume() { return Promise.resolve(); }
};
globalThis.AudioWorkletNode = class {
  constructor(ctx) {
    const p = new Player();
    let done = 0, told = 0;
    const run = () => {
      for (const due = Math.floor(ctx.currentTime * SR / 128); done < due; done++) {
        const o = [new Float32Array(128), new Float32Array(128)];
        globalThis.currentFrame = done * 128;
        p.process([], [o]);
        heard.push(Math.max(...o[0].map(Math.abs), ...o[1].map(Math.abs)));
      }
    };
    this.port = { onmessage: null, postMessage: (m) => setImmediate(() => { run(); globalThis.currentFrame = done * 128; p.port.onmessage({ data: m }); }) };
    setInterval(() => { run(); while (told < p.posted.length) this.port.onmessage?.({ data: p.posted[told++] }); }, 2);
  }
  connect() {}
};

// ---- the notes: serve.py over the site, the page's fetches sent to it
const keeps = JSON.parse(readFileSync(join(site, "models/site.json"), "utf8")).notes === true;
const notesDir = mkdtempSync(join(tmpdir(), "page-smoke-notes-"));
if (keeps) {
  const port = await new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const py = spawn("python3", ["-I", join(web, "serve.py"), site, String(port), notesDir], { stdio: ["ignore", "inherit", "inherit"] });
  py.on("exit", (code) => fail(`serve.py ended (${code})`));
  process.on("exit", () => py.kill());
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) => real(`http://127.0.0.1:${port}/${url}`, init);
  for (let i = 0; ; i++) {
    try { await globalThis.fetch("notes"); break; } catch (e) { if (i > 100) fail(`serve.py does not answer: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---- the page
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/from "\.\/([^"]+)"/g, (_, f) => `from "${pathToFileURL(join(web, f)).href}"`);
const file = join(mkdtempSync(join(tmpdir(), "page-smoke-")), "page.mjs");
writeFileSync(file, script);
await import(pathToFileURL(file).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, f, ms = 60000) => {
  for (const t = performance.now(); !f(); await sleep(20)) if (performance.now() - t > ms) fail(`${what}: not within ${ms} ms; the page says "${said.at(-1)?.[0]}"`);
};
let shown = 0;
const step = (what) => {
  for (; shown < said.length; shown++) {
    console.log(`     page: ${said[shown][0]}`);
    if (said[shown][1]) fail(`${what}: the page reports an error`);
  }
  console.log(`ok   ${what}`);
};
// sound from now on: the loudest sample played in the next ms
const loud = async (ms) => { const k = heard.length; await sleep(ms); return Math.max(0, ...heard.slice(k)); };
// waits for sound played from now on, with something still playing; says how long it took
const sounds = async (what) => {
  const k = heard.length, t = performance.now();
  await until(what, () => heard.length > k && heard.slice(k).some((v) => v > 0), 30000);
  if (!playing()) fail(`${what}: nothing is playing`);
  return `${what} (sound ${Math.round(performance.now() - t)} ms on)`;
};
// the same, for a change that leaves the old sound playing: waits for the page to say it is made
const changed = async (what) => {
  const k = said.length, t = performance.now();
  await until(what, () => said.slice(k).some(([x]) => /of choir/.test(x)), 120000);
  if (!playing() || !((await loud(300)) > 0)) fail(`${what}: nothing is playing`);
  return `${what} (made again in ${Math.round(performance.now() - t)} ms)`;
};
// a click on the time line at the fraction u of its width
const click = (u) => { const cv = $("time"); cv.fire("pointerdown", { clientX: u * cv.clientWidth, pointerId: 1 }); cv.fire("pointerup", {}); };
const playing = () => !$("stop").disabled;
// a click on a format's button, and the file the page hands over for it: its name is what the page
// says it wrote, its length what the page says
const download = async (what, format, ms = 60000) => {
  const k = files.length, b = $(`file-${format}`);
  if (b.disabled) fail(`${what}: the ${format} button is off`);
  b.onclick();
  await until(what, () => files.length > k && files[k].bytes !== null, ms);
  const f = files[k], line = said.findLast(([x]) => x.startsWith("Wrote "))?.[0], m = line?.match(/^Wrote (\S+): (\d+):(\d\d)\.(\d), /);
  if (files.length !== k + 1 || !m || m[1] !== f.name || !f.name.endsWith(`.${format}`)) fail(`${what}: ${files.length - k} files, "${f.name}", the page says "${line}"`);
  if (keep) writeFileSync(join(keep, f.name), f.bytes);
  return { ...f, secs: 60 * m[2] + +m[3] + m[4] / 10 };
};
const starts = (bytes, ...head) => head.every((v, i) => bytes[i] === (typeof v === "string" ? v.charCodeAt(0) : v));

await until("the engine loads", () => !$("go").disabled, 120000);
step("loaded");

$("go").onclick();
await until("speech begins", () => heard.some((v) => v > 0));
await until("speech plays to its end", () => !playing());
step("speaks, to the end");
{
  const f = await download("what was said as a WAV", "wav"), n = (f.bytes.length - 68) / 3;
  if (!starts(f.bytes, ..."RIFF") || !Number.isInteger(n) || Math.abs(n / SR - f.secs) > 0.11 || !/^[a-z0-9-]+\.wav$/.test(f.name)) fail(`the WAV: ${f.name}, ${f.bytes.length} bytes for ${f.secs} s`);
  step(`what was said is downloaded as ${f.name}, ${f.bytes.length} bytes`);
}
$("zoom").onclick(); // the whole take across
await sleep(100); // a frame, to draw it so
click(0.5);
const spoke = await sounds("a click in what was said plays from there");
await until("the rest of the speech plays", () => !playing());
step(`${spoke}, to the end`);
{ // the space bar sets the speaker down (at the start, from the end) and takes it up where it is
  press(" ");
  const again = await sounds("the space bar plays what was said again");
  press(" ");
  await until("the space bar pauses", () => !playing(), 3000);
  if (!/^Paused at /.test(said.at(-1)[0])) fail(`the space bar: the page says "${said.at(-1)[0]}"`);
  await sleep(500);
  if ((await loud(300)) > 0) fail("the space bar: paused, it still sounds");
  const at = said.at(-1)[0];
  press("ArrowRight"); // paused, the place moves and nothing plays
  if ((await loud(400)) > 0 || !/^Paused at /.test(said.at(-1)[0]) || said.at(-1)[0] === at) fail(`an arrow while paused: the page says "${said.at(-1)[0]}" after "${at}"`);
  press("ArrowLeft");
  if ((await loud(200)) > 0 || said.at(-1)[0] !== at) fail(`an arrow back while paused: the page says "${said.at(-1)[0]}", not "${at}"`);
  press(" ", {}, { tagName: "INPUT", type: "range" }); // a slider in focus: the space bar is still the speaker's
  await sounds("the space bar plays on");
  press("ArrowRight"); // two seconds on
  await sounds("an arrow moves the speaker on");
  await until("the speech plays to its end again", () => !playing());
  step(`${again}, pauses, keeps its place moved by the arrows, and plays on`);
}

$("t-sing").onclick();
$("go").onclick();
{ // asked for as it is being made: written when it is
  const k = said.length;
  const f = await download("a song still being made as an MP3", "mp3"), frames = f.bytes.length / 288;
  if (!said.slice(k).some(([x]) => x === "The MP3 will be written once the song is made.")) fail("the song's MP3: the page does not say it waits");
  if (!starts(f.bytes, 0xff, 0xf3) || !Number.isInteger(frames) || Math.abs((frames * 576 - 1057) / SR - f.secs) > 0.13) fail(`the song's MP3: ${f.name}, ${f.bytes.length} bytes for ${f.secs} s`);
  step(`a song asked for as it is made is downloaded once it is, as ${f.name}, ${f.bytes.length} bytes for ${f.secs} s`);
}
await until("the song plays to its end", () => !playing());
step("sings a song, to the end");
// a knob of how it sings, by its place among its box's
const knob = (box, k) => $(box).children[k].querySelector("input");
$("sing-motion").value = "vibrato";
$("sing-diction").checked = true;
knob("sing-how", 0).value = 1.5; // vibrato and drift
knob("sing-how", 2).value = 1.3; // dynamics
$("go").onclick();
step(await sounds("sings it as one of the singers does"));
await until("the song plays to its end again", () => !playing());
step("to the end");

$("t-choir").onclick();
$("go").onclick();
step(await sounds("a choir sings"));
await sleep(1500);
click(0.6);
await sleep(50); // the speaker's fade
step(await sounds("a click ahead plays from there"));
await sleep(1500);
$("choir-room").value = $("choir-room").value === "bare" ? "driest" : "bare";
$("choir-room").onchange();
step(await changed("the room changes as it plays"));
const sel = $("choir-parts").children[0].querySelector("select"), opts = [];
(function walk(e) { for (const c of e.children) { if (c.tag === "option") opts.push(c.value); walk(c); } })(sel);
sel.value = opts.find((v) => v !== sel.value);
sel.onchange();
step(await changed("a voice changes as it plays"));
knob("choir-how", 0).value = 0.5; // vibrato and drift
knob("choir-how", 0).onchange();
step(await changed("a knob turns as it plays"));
// heard alone: a part by its name in the stage's key, a singer by a click where the stage draws it
const voicesOf = () => said.findLast(([x]) => /of choir/.test(x))[0].match(/from (\d+ of \d+|\d+) voices/)?.[1]; // as the last making said
const { CHOIRS } = await import(pathToFileURL(join(web, "choirs.js")).href);
const { makeSeats } = await import(pathToFileURL(join(web, "choir.js")).href);
const { Stage, layout } = await import(pathToFileURL(join(web, "stage.js")).href);
const piece = CHOIRS[Object.keys(CHOIRS).find((n) => $("choir-source").textContent.startsWith(`${n}. `))];
const singers = piece.parts.length, key = $("k-stage").children;
if (!key.length || !key[0].who?.length) fail("the stage's key names no part");
if (key[0].who.length === singers) fail("the stage's key has one part: no part to hear alone");
key[0].onclick({});
step(await changed("a part is heard alone as it plays"));
if (voicesOf() !== `${key[0].who.length} of ${singers}`) fail(`a part alone: the page says "${said.at(-1)[0]}"`);
const seats = makeSeats(singers, piece.pan), last = singers - 1, { cx, cy, R } = layout($("stage").clientWidth);
const [sx, sy] = Stage.prototype.place(seats[piece.parts[last].seat ?? last], Math.max(...seats.map((x) => x.row)) + 1, Math.max(...seats.map((x) => Math.abs(x.pan)), 1e-3), cx, cy, R);
$("stage").fire("pointerdown", { clientX: sx, clientY: sy });
step(await changed("a click on a singer has that one alone"));
if (voicesOf() !== `1 of ${singers}` || $("stage-card").hidden) fail(`a singer alone: the page says "${said.at(-1)[0]}", its card ${$("stage-card").hidden ? "hidden" : "shown"}`);
$("stage").fire("pointerdown", { clientX: cx, clientY: cy });
step(await changed("a click on the empty stage brings the choir back"));
if (voicesOf() !== `${singers}` || !$("stage-card").hidden) fail(`the choir back: the page says "${said.at(-1)[0]}"`);
click(0.1);
await sleep(50);
step(await sounds("a click back plays from there"));
await sleep(1000);
$("stop").onclick();
if ((await loud(600)) > 0 && heard.at(-1) > 0) fail("stop is silence");
if (playing()) fail("stop leaves nothing playing");
step("stops");
click(0.3);
step(await sounds("a click after a stop plays from there"));

if (keeps) {
  const list = () => $("note-list").children;
  // the speaker set down where it was clicked (sounds() would take the fade of what played before for it)
  const k = said.length;
  click(0.5);
  await until("a click to note at", () => said.slice(k).some(([x]) => /first sound/.test(x)), 30000);
  await sleep(1500);
  $("note-add").onclick();
  if ($("note-form").hidden) fail("a note: nothing to write it in");
  { // in the note's box: alt-arrows move the mark, shift-space takes the speaker up and sets it down
    const box = $("note-text"), at = $("note-at").textContent;
    press("ArrowRight", { altKey: true, shiftKey: true }, box);
    const on = $("note-at").textContent;
    press("ArrowLeft", { altKey: true, shiftKey: true }, box);
    if (on === at || $("note-at").textContent !== at) fail(`a note's mark: ${at}, a second on ${on}, back ${$("note-at").textContent}`);
    press(" ", { shiftKey: true }, box);
    await until("shift-space in a note pauses", () => /^Paused at /.test(said.at(-1)[0]), 3000);
    await sleep(500);
    if ((await loud(300)) > 0) fail("shift-space in a note: paused, it still sounds");
    press(" ", {}, box); // a space written, nothing played
    if ((await loud(400)) > 0) fail("a space written in a note set the speaker down");
    press("Enter", { shiftKey: true }, box);
    await sounds("shift-Enter in a note plays from before its mark");
  }
  $("note-text").value = "a smoke test's note";
  $("note-form").onsubmit({ preventDefault() {} });
  await until("a note is listed", () => list().length === 1, 5000);
  const line = JSON.parse(readFileSync(join(notesDir, "notes.jsonl"), "utf8").trim());
  if (line.text !== "a smoke test's note" || !line.recipe.parts?.length || !line.build) fail(`a note: kept as ${JSON.stringify(line).slice(0, 300)}`);
  if (!line.clip || !existsSync(join(notesDir, "clips", line.clip.file))) fail("a note: no clip kept");
  const bytes = readFileSync(join(notesDir, "clips", line.clip.file)).length;
  list()[0].children[3].onclick();
  await until("a note taken back is off the list", () => list().length === 0, 5000);
  step(`a note is kept at ${line.at.toFixed(2)} s with ${(bytes / 1024).toFixed(0)} KB of clip from ${line.clip.from.toFixed(2)} s, and taken back`);
  $("stop").onclick();
  await sleep(300);
}

$("t-crowd").onclick();
$("pad-start").onclick();
step(await sounds("the crowd sings"));
await sleep(1000);
$("stop").onclick();
await sleep(300);

$("t-choir").onclick();
$("go").onclick();
step(await sounds("the choir sings again"));
await sleep(1000);
$("stop").onclick();
await sleep(200);

// a choir with nothing of it made, played from a jump ahead: a file of it has the rest made first
$("choir-room").value = $("choir-room").value === "bare" ? "driest" : "bare";
$("choir-room").onchange();
$("go").onclick();
step(await sounds("the choir sings another way"));
click(0.7);
await sleep(50);
step(await sounds("a click ahead plays from there"));
$("file-flac").onclick();
$("file-flac").onclick();
if (said.at(-1)[0] !== "No file will be written." || files.some((f) => f.name.endsWith(".flac"))) fail(`a file asked for and then not: the page says "${said.at(-1)[0]}"`);
{
  const k = said.length;
  const f = await download("a choir not made through as an MP3", "mp3", 240000), frames = f.bytes.length / 480;
  if (!said.slice(k).some(([x]) => /^Making the rest of the choir to write the MP3: \d+% of it is made\.$/.test(x))) fail("the MP3: the page does not say the rest is being made");
  if (!starts(f.bytes, 0xff, 0xf3) || !Number.isInteger(frames) || Math.abs((frames * 576 - 1057) / SR - f.secs) > 0.13) fail(`the MP3: ${f.name}, ${f.bytes.length} bytes for ${f.secs} s`);
  step(`the rest of the choir is made and it is downloaded as ${f.name}, ${f.bytes.length} bytes for ${f.secs} s`);
  const g = await download("the choir as a FLAC", "flac", 20000), w = await download("the choir as a WAV", "wav", 20000);
  const n = (w.bytes.length - 68) / 6; // two channels of three bytes
  if (!starts(g.bytes, ..."fLaC") || !starts(w.bytes, ..."RIFF") || g.secs !== f.secs || w.secs !== f.secs || !Number.isInteger(n) || Math.abs(n / SR - w.secs) > 0.11 || g.bytes.length >= w.bytes.length) fail(`the FLAC and the WAV: ${g.bytes.length} and ${w.bytes.length} bytes for ${w.secs} s`);
  step(`and as ${g.name} (${g.bytes.length} bytes) and ${w.name} (${w.bytes.length} bytes)`);
}
$("stop").onclick();
await sleep(200);
step("all done");
process.exit(0);
