// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The page's script (page.js) run in node with stand-ins for the document, the canvas and the
// window: Mary is opened from a MIDI file, saved as a part and as a MIDI file and both read back;
// notes are drawn, dragged, lengthened and given words with the mouse and the keys; the vibrato
// is drawn; the panel's fields change the part; a file with two tracks asks which; each example
// in the menu is chosen. Fails on any error the page throws or says. It draws nothing: what the
// page looks like is for a browser.
//
//     node page_smoke.mjs

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as P from "./part.js";
import * as M from "./midi.js";
import * as S from "./score.js";
import * as Clip from "./clip.js";
import * as T from "./theory.js";
import * as Shape from "./shape.js";
import * as Make from "./make.js";
import * as Ways from "./ways.js";
import { typed as wordsOf } from "./edit.js";
import { boot } from "./page.js";
import { FADE, BUDGET } from "./render.js";
import * as W from "./wav.js";
import * as SH from "./share.js";
import { standin } from "./offline_standin.mjs";
import { EXAMPLES, SCORES } from "./examples/make.mjs";
import { MENU } from "./examples/menu.js";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) { fails++; console.log(`     status: ${JSON.stringify(els.get("status").textContent)}`); } };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const here = (name) => fileURLToPath(new URL(name, import.meta.url));

// ---- the document: every element the page asks for by id, as index.html has them
const html = readFileSync(here("index.html"), "utf8");
const idsInPage = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const calls = { fill: 0, text: 0, bars: [], rects: null }; // bars: the ruler's bar numbers as drawn, [text, x]; rects, where a list: [fillStyle, x, y, w, h]
const context = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : k === "measureText" ? (s) => ({ width: 6 * String(s).length }) : (...a) => {
    if (k === "fillRect") { calls.fill++; calls.rects?.push([t.fillStyle, ...a]); }
    if (k === "fillText") { calls.text++; if (typeof a[0] !== "string" || !Number.isFinite(a[1]) || !Number.isFinite(a[2])) throw new Error(`fillText(${a.join(", ")})`); if (a[2] === 9) calls.bars.push([a[0], a[1]]); }
    if (["moveTo", "lineTo", "rect", "fillRect", "strokeRect", "arc"].includes(k) && a.some((v) => !Number.isFinite(v))) throw new Error(`${String(k)}(${a.join(", ")})`);
  }),
  set: (t, k, v) => ((t[k] = v), true),
});
class El {
  constructor(tag, id = null) {
    Object.assign(this, { tagName: tag.toUpperCase(), id, on: {}, style: {}, children: [], value: "", checked: false, disabled: false, hidden: false, textContent: "", className: "", attrs: {}, files: [], open: false, clientWidth: 1200, clientHeight: 700 });
  }
  addEventListener(kind, f) { (this.on[kind] ??= []).push(f); }
  fire(kind, e = {}) {
    const event = { type: kind, target: this, preventDefault() {}, timeStamp: (clock += 1000), ...e };
    for (const f of this.on[kind] ?? []) f(event);
    return event;
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  replaceChildren(...els) { this.children = els; for (const el of els) el.parent = this; }
  append(...els) { this.children.push(...els); for (const el of els) el.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  // every element under this one of a class
  all(cls) { return this.children.flatMap((c) => [...(String(c.className).split(" ").includes(cls) ? [c] : []), ...c.all(cls)]); }
  getContext() { return context; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 24 * this.children.length }; }
  scrollIntoView() {}
  contains(el) { return el === this || this.children.some((c) => c.contains(el)); }
  focus() { const was = document.activeElement; document.activeElement = this; if (was && was !== this) was.fire("blur"); }
  select() {}
  blur() { this.blurred = (this.blurred ?? 0) + 1; }
  click() { this.fire("click"); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  setPointerCapture() {}
  releasePointerCapture() {}
}
let clock = 0;
const els = new Map(idsInPage.map((id) => [id, new El(/id="canvas"/.test(`id="${id}"`) ? "canvas" : (html.match(new RegExp(`<(\\w+)[^>]*\\bid="${id}"`)) ?? [])[1] ?? "div", id)]));
// and their titles, as the page has them
for (const [id, el] of els) el.title = (html.match(new RegExp(`<\\w+\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? "").match(/\btitle="([^"]*)"/)?.[1] ?? "";
const downloads = [];
const document = {
  activeElement: null,
  title: "",
  getElementById: (id) => els.get(id) ?? null,
  createElement: (tag) => {
    const el = new El(tag);
    if (tag === "a") el.click = () => downloads.push({ name: el.download, data: blobs.get(el.href) });
    return el;
  },
  on: {},
  addEventListener(kind, f) { (this.on[kind] ??= []).push(f); },
};
// the page's custom properties, as a browser computes them from editor.css's :root
const sheet = readFileSync(here("editor.css"), "utf8");
const rootProps = new Map([...sheet.slice(0, sheet.indexOf("}")).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
document.documentElement = new El("html");
document.body = new El("body");
const frames = [], blobs = new Map(), store = new Map(), fetched = [], sized = [], replaced = [];
let bundled = null; // a site that names a bundle: {named (its site.json's bundle), files: {address: text}}
const window = {
  getComputedStyle: (el) => {
    if (el !== document.documentElement) throw new Error("getComputedStyle of an element other than the page's root");
    return { getPropertyValue: (k) => rootProps.get(k) ?? "" };
  },
  devicePixelRatio: 2,
  navigator: { userAgent: "a desk's browser", platform: "MacIntel" },
  requestAnimationFrame: (f) => frames.push(f),
  ResizeObserver: class { constructor(f) { sized.push(f); } observe() {} },
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  URL: { createObjectURL: (b) => { const u = `blob:${blobs.size}`; blobs.set(u, b.parts[0]); return u; }, revokeObjectURL() {} },
  Blob: class { constructor(parts) { this.parts = parts; } },
  // the voices, or a file beside the page
  fetch: async (url) => {
    fetched.push(String(url));
    if (String(url) === `${MODELS}voices.json`) return { ok: true, json: async () => [{ name: "6147", label: "A woman", sex: "F" }, { name: "2428", label: "A man", sex: "M" }] };
    if (String(url) === `${MODELS}site.json`) return { ok: true, json: async () => ({ routes: ["hifi", "fast"], notes: true, ...(bundled ? { bundle: bundled.named } : {}) }) };
    if (bundled && String(url) in bundled.files) {
      const b = Buffer.from(bundled.files[String(url)]);
      return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    }
    if (!existsSync(fileURLToPath(url))) return { ok: false, status: 404 };
    const b = readFileSync(fileURLToPath(url));
    return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  },
  // its listeners kept, so that a check can fire one (blur)
  on: {},
  addEventListener(kind, f) { (this.on[kind] ??= []).push(f); },
  // the page's address: a link's score is in its hash, taken out once read (replaced: each address put)
  location: { origin: "https://lipservice.test", pathname: "/editor/", search: "?x=1", hash: "" },
  history: { replaceState: (state, title, url) => { replaced.push(url); window.location.hash = ""; } },
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (t) => clearTimeout(t),
  performance: { now: () => performance.now() },
  Worker: class {
    constructor(url, options) { Object.assign(this, { url: String(url), options, posted: [], onmessage: null, gone: false }); workers.push(this); }
    postMessage(m) { if (this.gone) throw new Error("a word to a worker let go of"); this.posted.push(m); }
    terminate() { this.gone = true; }
  },
  // the sound's context, its clock moved by render() below; its nodes keep what they are joined to
  AudioContext: class {
    constructor(options) {
      Object.assign(this, { options, sampleRate: options.sampleRate, currentTime: 3, outputLatency: 0.01, state: "running", destination: { kind: "destination" }, modules: [], made: [] });
      this.audioWorklet = { addModule: async (url) => { this.modules.push(String(url)); await import("./speaker.js"); } };
      speakers.push(this);
      const param = (value) => ({ value, set: [], setTargetAtTime(v) { this.value = v; this.set.push(v); } });
      const node = (kind, more = {}) => () => {
        const n = { kind, to: [], connect(to, output = 0) { this.to.push([to, output]); }, disconnect() { this.to = []; }, ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, typeof v === "number" ? param(v) : v])) };
        this.made.push(n);
        return n;
      };
      Object.assign(this, {
        createGain: node("gain", { gain: 1 }), createStereoPanner: node("pan", { pan: 0 }), createChannelSplitter: node("split"),
        createAnalyser: node("analyser", { getFloatTimeDomainData: (a) => a.fill(0.5) }), createBiquadFilter: node("biquad", { frequency: 350, gain: 0, Q: 1 }),
        createDynamicsCompressor: node("compressor", { threshold: -24, ratio: 12, knee: 30, attack: 0.003, release: 0.25 }),
        createDelay: node("delay", { delayTime: 0 }), createConvolver: node("convolver"),
        createBuffer: (channels, n, rate) => { const data = Array.from({ length: channels }, () => new Float32Array(n)); return { length: n, sampleRate: rate, getChannelData: (c) => data[c] }; },
      });
    }
    resume() { return Promise.resolve(); }
  },
  // speaker.js's processors as a browser's audio thread has them, a word either way given at once
  AudioWorkletNode: class {
    constructor(context, name, options) {
      Object.assign(this, { context, kind: name, name, options, told: [], to: [] });
      this.port = { onmessage: null, postMessage: (m) => { this.told.push(m); this.processor.port.onmessage({ data: m }); } };
      making = this;
      this.processor = new (registered.get(name))();
      this.parameters = new Map((registered.get(name).parameterDescriptors ?? []).map((d) => [d.name, { value: d.defaultValue, setTargetAtTime(v) { this.value = v; } }]));
      nodes.push(this);
      context.made.push(this);
    }
    connect(to, output = 0) { this.to.push([to, output]); }
    disconnect() { this.to = []; }
  },
};
let making = null;
const registered = new Map(), nodes = [];
globalThis.currentFrame = 0;
globalThis.sampleRate = 24000;
globalThis.AudioWorkletProcessor = class {
  constructor() { const node = making; this.port = { onmessage: null, postMessage: (m) => node.port.onmessage?.({ data: m }) }; }
};
globalThis.registerProcessor = (name, made) => registered.set(name, made);
// The speaker's next `secs` of sound, a block of 128 samples at a time as a browser asks for it:
// [output][sample], an output a singer and the last the click.
const render = (secs) => {
  const sp = speakers[0], node = nodes.find((n) => n.name === "speaker"), out = Array.from({ length: 17 }, () => []);
  for (let k = 0; k < Math.round(secs * 24000 / 128); k++) {
    const o = Array.from({ length: 17 }, () => [new Float32Array(128)]);
    globalThis.currentFrame = Math.round(sp.currentTime * 24000);
    node.processor.process([], o);
    o.forEach((ch, i) => out[i].push(...ch[0]));
    sp.currentTime = (globalThis.currentFrame + 128) / 24000;
  }
  return out;
};
const settle = () => new Promise((r) => setTimeout(r, 0));
const workers = [], speakers = [];
const $ = (id) => els.get(id);
// the frames asked for, and those they ask for in turn, a few rounds of them
const draw = () => { for (let round = 0; round < 4 && frames.length; round++) for (const f of frames.splice(0)) f(); };
const said = () => $("status").textContent;
// what a pull field shows, whether it can be pulled, and a text typed into it
const shownIn = (id) => page.fields[id].el.children[1].textContent;
const able = (id) => page.fields[id].el.attrs["aria-disabled"] === "false";
const type = (id, text) => page.fields[id].typed(text);
// the singers' tabs, then the mixer's
const tabEls = () => { const [mx, ...rest] = $("tabs").children.filter((c) => c.attrs.role === "tab"); return [...rest, mx]; };
const failed = () => $("status").className === "bad";
const keydown = (key, more = {}) => { for (const f of document.on.keydown) f({ key, target: $("canvas"), preventDefault() {}, ...more }); };
// A command chosen from the menu bar: the menu's name pressed, then each row by its label, into
// its smaller menus. The rows of the last menu opened, by label: {checked, greyed}, where it stays
// open (a greyed row); null where the row was taken and the menu closed.
const menuPick = (...labels) => {
  const title = $("menus").children.find((t) => t.textContent === labels[0]);
  if (!title) throw new Error(`no menu ${labels[0]} in the bar`);
  title.fire("pointerdown", { button: 0 });
  const root = document.body.children.at(-1);
  let box = root, row = null;
  const label = (r) => r.children?.[0]?.textContent;
  for (const name of labels.slice(1)) {
    row = box.children.find((r) => label(r) === name);
    if (!row) throw new Error(`no ${name} in ${labels.join(" > ")}: ${box.children.map(label).join(", ")}`);
    row.fire("click");
    box = row.children.find((c) => String(c.className).split(" ").includes("cmd-menu")) ?? box;
  }
  if (!document.body.children.includes(root)) return null;
  const rows = Object.fromEntries(box.children.filter((r) => r.attrs?.role?.startsWith("menuitem")).map((r) => [label(r), { checked: r.attrs["aria-checked"] ?? null, greyed: r.attrs["aria-disabled"] === "true" }]));
  document.on.pointerdown?.forEach((f) => f({ target: document.body }));
  return rows;
};

// ---- the page
// the site's page files are the repo's; its models are at another origin
const WEB = new URL("../web/", import.meta.url).href, MODELS = "https://models.test/m/";
const page = boot({ document, window, web: WEB, models: MODELS });
await page.sounds;
await Promise.resolve();
await new Promise((r) => setTimeout(r, 0));
draw();
const { view } = page;
check(equal(page.ed.part, P.blank(P.singer("6147"))) && !failed(), "the page starts with a part of no notes");
check($("text").value === P.write(page.ed.part) && $("s-voice").value === "6147" && $("s-diction").checked === true && $("s-motion").value === "vibrato" && $("undo").disabled && !able("n-at") && shownIn("s-glide") === "9" && shownIn("s-breath") === "0.85" && shownIn("tempo") === "120 bpm", "the panel shows the part, the singer, and no note");
check(equal($("snap").children.map((o) => o.textContent), ["1 beat", "1/2", "1/3", "1/4", "1/6", "1/8", "1/12", "1/16", "tick"]) && $("snap").value === "240", "the snap's choices for a grid of 960, a quarter of a beat chosen");
check(fetched[0] === `${MODELS}site.json` && fetched[1] === `${MODELS}voices.json` && equal($("s-voice").children.map((o) => o.value), ["6147", "2428"]) && tabEls()[0].children[1].textContent === "A woman", "the voices there are, asked of the stage");
check(calls.fill > 20 && calls.text > 3, "the roll is drawn");
// the menu bar: a menu a name, the rows under the notes in View, the velocity and vibrato folded
{
  check(equal($("menus").children.map((t) => t.textContent), ["File", "Edit", "Notes", "Singers", "View", "Sing", "Help"]) && $("menus").attrs.role === "menubar", "the menu bar: File, Edit, Notes, Singers, View, Sing, Help");
  const lanes = menuPick("View", "Rows under the notes");
  check(equal(lanes, { Words: { checked: "true", greyed: false }, Velocity: { checked: "false", greyed: false }, Vibrato: { checked: "false", greyed: false } }) && !document.body.children.some((c) => c.className === "cmd-menu"), "the words under the notes, the velocity and vibrato rows folded; a press outside closes the menu");
  const r0 = 700 - 30 - 16 - 16 - 30; // the roll's height with both folded
  calls.text = 0;
  page.paint();
  check(menuPick("View", "Rows under the notes", "Velocity") === null && menuPick("View", "Rows under the notes", "Vibrato") === null && equal(page.layout.lanes, { words: true, velocity: true, vibrato: true }) && equal(JSON.parse(store.get("lipservice editor: the layout")).lanes, page.layout.lanes) && r0 > 0, "each unfolded from the View menu, and kept for the next visit");
  check(menuPick("View", "Rows under the notes").Vibrato.checked === "true", "and checked there now");
}

// ---- Mary opened, saved both ways, and read back
const open = async (name, bytes) => {
  $("file").files = [{ name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }];
  for (const f of $("file").on.change) await f();
  draw();
};
const maryBytes = new Uint8Array(readFileSync(here("../plugin/songs/mary-pedal.mid")));
await open("mary-pedal.mid", maryBytes);
check(!failed() && said() === "mary-pedal.mid: the file's events: 26 notes, 26 syllables, 69 points of vibrato", "mary-pedal.mid opened, and what was taken said");
const asEvents = M.read(maryBytes, { singer: P.singer("6147") }).part;
check(equal(page.ed.part, asEvents) && !page.ed.changed, "the part is the file's");
check($("words").value.startsWith("Ma-ry had a lit-tle lamb,\nlit-tle lamb,") && $("snap").value === "120" && $("snap").children.length === 9, "its words in the panel; the snap's choices now a grid of 480's");
check(view.wide * 480 === 52 && view.left === 0 && view.tall >= 16, "opened to read: a beat 52 pixels wide, from the start, the rows tall enough for words");
keydown("f");
check(view.x(36 * 480) < 1200 - 56 && view.left === 0, "F: all of it in sight");
// the singer named in its tab: the part's title
tabEls()[0].fire("dblclick");
{
  const input = tabEls()[0].children.find((c) => c.tagName === "INPUT");
  input.value = "Mary Had a Little Lamb";
  input.fire("keydown", { key: "Enter" });
}
check(page.ed.part.title === "Mary Had a Little Lamb" && tabEls()[0].children[1].textContent === "Mary Had a Little Lamb", "a tab double clicked takes the singer's name, which is its part's title");
menuPick("File", "Save this singer's part as a MIDI file");
menuPick("File", "Save this singer's part");
check(downloads.length === 2 && downloads[0].name === "mary-had-a-little-lamb.mid" && downloads[1].name === "mary-had-a-little-lamb.part" && !failed(), "saved as a MIDI file and as a part, named for its title");
const [mid, text] = [downloads[0].data, downloads[1].data];
check(equal(P.read(text), page.ed.part) && text === readFileSync(here("examples/mary.part"), "utf8").replace("seed 3", "seed 0"), "the part saved is the part, as examples/mary.part has it but for the singer's seed");
const back = M.read(mid);
check(back.how === "inside" && equal(back.part, page.ed.part), "the MIDI file saved holds the part: read back, nothing lost");
const a = M.events(maryBytes).read, b = M.events(mid).read;
const trim = (r) => ({ ...r, name: "", lyrics: r.lyrics.map(([t, s]) => [t, s.trimEnd()]) });
check(equal(trim(a), trim(b)), "and says what mary-pedal.mid said: the same tempo, meter, notes, velocities, lyrics and wheel, tick for tick");
await open("mary.mid", mid);
check(said().startsWith("mary.mid: the part inside, as lipservice wrote it: 26 notes") && page.ed.part.title === "Mary Had a Little Lamb", "opened again: the part inside");
await open("mary.part", new TextEncoder().encode(text));
check(said() === "mary.part: a part, 26 notes" && equal(page.ed.part, back.part) && !page.ed.changed, "and the part's text opened: the same part");
check(store.get("lipservice editor: the score") === S.write(page.score()) && equal(S.read(store.get("lipservice editor: the score")).singers[0].part, page.ed.part), "the score is kept for the next visit");

// ---- the mouse on the roll
const X = (beats) => 56 + view.x(beats * page.ed.part.grid), Y = (key) => 30 + view.y(key) + view.tall / 2;
const mouse = (kind, x, y, more = {}) => { $("canvas").fire(`pointer${kind}`, { clientX: x, clientY: y, pointerId: 1, ...more }); draw(); };
const click = (x, y, more = {}) => { mouse("down", x, y, more); mouse("up", x, y, more); };
const brief = () => page.ed.part.notes.map((n) => `${P.beat(n.at, page.ed.part.grid)}+${P.beat(n.ticks, page.ed.part.grid)} ${P.pitch(n)}`);
view.zoom(3, 0);
click(X(4.5), Y(64));
check(page.ed.selected.size === 1 && [...page.ed.selected][0] === page.ed.part.notes[0] && shownIn("n-pitch") === "E4" && shownIn("n-at") === "4" && $("n-lyric").value === "Ma-" && able("n-at"), "a click chooses a note, and the panel shows it");
mouse("down", X(4.5), Y(64));
mouse("move", X(4.76), Y(65));
mouse("move", X(5.26), Y(67));
mouse("up", X(5.26), Y(67));
check(brief()[0] === "4.75+1 G4" && page.ed.past.length && shownIn("n-pitch") === "G4", "a note dragged goes with the mouse, by the snap's step, as one change");
keydown("z", { metaKey: true });
check(brief()[0] === "4+1 E4", "undone by the keys");
mouse("down", X(4.99), Y(64));
mouse("move", X(5.6), Y(64));
mouse("up", X(5.6), Y(64));
check(brief()[0] === "4+1.5 E4", "its end dragged lengthens it");
keydown("z", { metaKey: true });
// a note drawn by a double click, where there is none
const before = page.ed.part.notes.length;
const twice = (x, y) => { const t = clock + 2000; mouse("down", x, y, { timeStamp: t }); mouse("up", x, y, { timeStamp: t + 60 }); mouse("down", x, y, { timeStamp: t + 210 }); };
click(X(0.3), Y(72));
check(page.ed.selected.size === 0, "a click on the empty roll lets go of the notes");
twice(X(1.3), Y(72));
mouse("move", X(3.01), Y(72));
mouse("up", X(3.01), Y(72));
check(page.ed.part.notes.length === before + 1 && brief()[0] === "1.25+1.75 C5" && page.ed.selected.size === 1, "a double click draws a note, dragged out to its length");
keydown("Enter");
check($("lyric").style.display === "block" && document.activeElement === $("lyric"), "Enter opens the note's syllable to type");
$("lyric").value = "Oh";
$("lyric").fire("keydown", { key: "Enter" });
check(page.ed.part.notes[0].lyric === "Oh" && $("lyric").style.display === "none", "typed and entered");
keydown("ArrowUp");
keydown("ArrowRight", { altKey: true });
keydown("ArrowLeft");
check(brief()[0] === "1+2 C#5", "the arrows move it and lengthen it");
keydown("b");
check(equal(page.ed.part.marks, [{ at: 480, breath: true }]), "B marks a breath before it");
keydown("Backspace");
check(page.ed.part.notes.length === before, "and delete removes it");
// a box drawn on the empty roll chooses the notes in it
mouse("down", X(3.5), Y(69));
mouse("move", X(7.5), Y(61));
mouse("up", X(7.5), Y(61));
check(equal([...page.ed.selected].map((n) => n.lyric), ["Ma-", "ry", "a"]), "a box chooses the notes it touches");
// velocities
mouse("down", X(4.2), 700 - 92 - 64 + 4 + (64 - 8) / 2);
mouse("up", X(4.2), 700 - 92 - 64 + 4 + (64 - 8) / 2);
check(equal(page.ed.part.notes.slice(0, 4).map((n) => n.velocity), [64, 64, 96, 64]), "a press in the velocity row sets the chosen notes' velocities");
// words typed along the notes
click(X(4.2), 700 - 92 - 64 - 15);
check($("lyric").style.display === "block" && $("lyric").value === "Ma-", "a click under a note opens its syllable");
for (const [typed, shown] of [["Hel-", "ry"], ["lo ", "had"], ["there_ my ", "tle"]]) {
  $("lyric").value = typed;
  $("lyric").fire("input");
  check($("lyric").value === shown, `${JSON.stringify(typed)} typed: on to the note after, which has ${JSON.stringify(shown)}`);
}
$("lyric").fire("keydown", { key: "Escape" });
check(equal(page.ed.part.notes.slice(0, 6).map((n) => n.lyric), ["Hel-", "lo", "there", "_", "my", "tle"]), "the words are under the notes, a hyphen and a space each a note on");
$("lyric").value = "";
// the vibrato drawn
const pts = page.ed.part.lanes.vibrato.length, laneY = 700 - 92;
mouse("down", X(1), laneY + 46);
mouse("move", X(2), laneY + 10);
mouse("up", X(2), laneY + 10);
check(page.ed.part.lanes.vibrato.length === pts + 1 && page.ed.part.lanes.vibrato[1].at === 960 && page.ed.part.lanes.vibrato[1].value > 1.5, "a press in the vibrato row makes a point, dragged to its place");
keydown("l");
check(page.ed.part.lanes.vibrato[1].line, "L has it reached by a line");
keydown("Delete");
check(page.ed.part.lanes.vibrato.length === pts, "delete removes the point chosen");

// ---- the panel
type("s-shift", "-12");
$("s-motion").value = "-";
$("s-motion").fire("change");
$("s-diction").checked = false;
$("s-diction").fire("change");
check(page.ed.part.singer.shift === -12 && page.ed.part.singer.motion === null && page.ed.part.singer.diction === false && $("s-said").textContent === "", "the singer's fields set the singer");
type("s-breath", "3");
check($("s-said").textContent.includes("3: 0 to 1") && $("s-said").className === "said bad" && page.ed.part.singer.breath === 0.85 && shownIn("s-breath") === "0.85", "a chance of 3 is refused beside the field, and the field shows what stands");
click(X(6.5), Y(60));
type("n-pitch", "C4+14");
type("n-release", "30");
type("n-beats", "0.333333");
check(equal(page.ed.part.notes.filter((n) => n.cents).map((n) => [n.pitch, n.cents, n.release, n.ticks]), [["C4", 14, 30, 160]]), "the note's fields set its cents, its release and its length");
type("n-at", "6.1234");
check($("n-said").textContent.includes("on no tick of a grid of 480"), "a start on no tick is refused beside the field");
$("words").value = "la la la";
$("words-apply").click();
check(equal(page.ed.part.notes.slice(0, 3).map((n) => n.lyric), ["la", "la", "la"]) && $("words-said").textContent === "", "words laid from the first note");
$("text").value = P.write(EXAMPLES.every()).replace("glide 12", "glide 0");
$("text-apply").click();
check($("text-said").textContent.startsWith("line 9: glide 0") && page.ed.part.title !== "Every line of a part: étude, 100%", "a text with a fault is refused, its line named");
$("text").value = P.write(EXAMPLES.every());
$("text-apply").click();
check(equal(page.ed.part, EXAMPLES.every()) && page.ed.changed && $("text-said").textContent === "", "a part's text read is the part");
draw();

// ---- a file whose notes are on two tracks asks which
{
  const text = (s) => [...new TextEncoder().encode(s)];
  const chunk = (kind, body) => [...text(kind), 0, 0, body.length >> 8, body.length & 255, ...body];
  const track = (events) => chunk("MTrk", [...events.flat(), 0, 0xff, 0x2f, 0]);
  const bytes = new Uint8Array([...chunk("MThd", [0, 1, 0, 2, 0, 96]), ...track([[0, 0xff, 3, 4, ...text("Tune")], [0, 0x90, 60, 90], [96, 0x80, 60, 0]]), ...track([[0, 0x91, 48, 70], [96, 0x81, 48, 0]])]);
  await open("two.mid", bytes);
  check($("which").open && equal($("which-list").children.map((b) => b.textContent), ["all 2, a singer each", "track 0 \"Tune\", channel 1: 1 notes, 0 lyrics", "track 1, channel 2: 1 notes, 0 lyrics"]) && page.ed.part.title !== "Tune", "a file with notes on two tracks asks which, or all, and nothing is read yet");
  $("which-list").children[0].click();
  draw();
  check(!$("which").open && said() === "two.mid: 2 singers, a track each" && equal(page.desk.value.rows.map((r) => [r.ed.part.title, r.ed.part.notes.length, r.ed.part.singer.voice]), [["Tune", 1, "6147"], ["track 1", 1, "2428"]]) && tabEls().length === 3 && page.desk.value.title === "two", "all of them: a singer a track, each a voice of the site's, a tab each and the mixer's");
  $("undo").click();
  await open("two.mid", bytes);
  $("which-list").children[1].click();
  draw();
  check(!$("which").open && page.ed.part.title === "Tune" && page.ed.part.notes.length === 1 && equal(page.ed.part.singer, EXAMPLES.every().singer) && said().includes("left: 1 notes of other tracks and channels"), "the one chosen is read, with the singer the editor had");
  await open("notes.txt", new TextEncoder().encode("just some words\n"));
  check(failed() && said().startsWith("notes.txt: not a lipservice part this reads") && page.ed.part.title === "Tune", "a file that is neither is refused by name, and the part stays");
  await open("bad.bin", new Uint8Array([0xff, 0xfe, 0x00]));
  check(failed() && said() === "bad.bin: neither a MIDI file nor text", "as are bytes that are not text");
}
menuPick("File", "New score");
draw();
check(page.ed.part.notes.length === 0 && equal(page.ed.part.singer, EXAMPLES.every().singer) && !$("undo").disabled && page.desk.value.rows.length === 1 && !failed(), "a new score keeps the singer, and can be undone");

// ---- the examples in the menu
{
  const menu = $("examples");
  check(equal(menu.children.map((o) => [o.value, o.textContent]), [["", "Examples"], ...MENU.map((x) => [x.file, x.label])]) && menu.value === "", "the menu has the examples by name, none chosen");
  const pick = async (file) => {
    menu.value = file;
    for (const f of menu.on.change) await f({ target: menu });
    draw();
  };
  for (const { file } of MENU) {
    const singer = page.ed.part.singer, before = page.ed.part;
    await pick(file);
    const bytes = new Uint8Array(readFileSync(here(`examples/${file}`)));
    const want = file.endsWith(".mid") ? M.read(bytes, { singer }).part : file.endsWith(".score") ? SCORES[file.replace(".score", "")]().singers[0].part : EXAMPLES[file.replace(".part", "")]();
    if (file.endsWith(".score")) check(equal(page.score(), SCORES.round()) && tabEls().length === 4, `${file} is the score: its three singers a tab each, its mix`);
    check(!failed() && said().startsWith(`${file}: `) && equal(page.ed.part, want) && !page.ed.changed && menu.value === "" && document.activeElement === $("canvas"), `${file} chosen is the part, the menu back at its name and the keys the roll's`);
    $("undo").click();
    check(equal(page.ed.part, before), `${file}: and undone, the part there was`);
    $("redo").click();
  }
  check(fetched.at(-1) === new URL(`./examples/${MENU.at(-1).file}`, import.meta.url).href, "each asked for beside the page's script");
  // another part opened has no loop; O with none marked marks it round the notes
  page.set.loop.on = true;
  page.set.loop.to = 960;
  page.place(960);
  await pick("mary.part");
  check(equal(page.set.loop, { on: false, from: 0, to: 0 }) && $("loop").attrs["aria-pressed"] === "false" && page.cursor() === 0, "a part opened has no loop, and Sing starts at its start");
  keydown("o");
  check(equal(page.set.loop, { on: true, from: 4 * 480, to: 36 * 480 }) && said() === "Sing goes round beats 4 to 36", "O with no loop marked marks it round all the notes");
  keydown("o");
  page.ed.select(page.ed.part.notes.slice(2, 5));
  page.set.loop.to = 0;
  keydown("o");
  check(equal(page.set.loop, { on: true, from: 6 * 480, to: 9 * 480 }), "or round the notes chosen");
  keydown("o");
  const held = page.ed.part;
  await pick("nothing.part");
  check(failed() && said() === "nothing.part: HTTP 404" && page.ed.part === held, "one that is not there is said, and the part stays");
}

// ---- several singers: a tab each, one time, one step back
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pickExample = async (file) => {
  $("examples").value = file;
  for (const f of $("examples").on.change) await f({ target: $("examples") });
  draw();
};
{
  await pickExample("round.score");
  const names = () => tabEls().slice(0, -1).map((t) => t.children[1].textContent);
  check(equal(names(), ["Finn", "Cora", "Ben"]) && tabEls()[0].attrs["aria-selected"] === "true" && $("tabs").children[0] === tabEls().at(-1) && tabEls().at(-1).children[1].textContent === "Mixer", "a score opened: the mixer's tab first, its singers' tabs by name, the first singer in sight");
  tabEls()[1].click();
  check(page.ed === page.desk.value.rows[1].ed && tabEls()[1].attrs["aria-selected"] === "true" && $("s-voice").value === "6345" && $("text").value === P.write(page.ed.part), "a tab clicked: that singer's notes and settings");
  keydown("3");
  check(page.ed === page.desk.value.rows[2].ed, "a digit goes to that singer");
  type("tempo", "90");
  check(page.desk.value.rows.every((r) => equal(r.ed.part.tempo, [{ at: 0, bpm: 90 }])) && shownIn("tempo") === "90 bpm", "the tempo typed is every singer's");
  $("undo").click();
  check(page.desk.value.rows.every((r) => equal(r.ed.part.tempo, [{ at: 0, bpm: 100 }])), "and one step back takes it from them all");
  // a pull on a singer's number: it follows the mouse, and is one step
  const el = page.fields["s-shift"].el, steps0 = page.ed.past.length;
  el.fire("pointerdown", { clientX: 100, clientY: 10, button: 0 });
  el.fire("pointermove", { clientX: 101, clientY: 10 });
  check(page.ed.part.singer.shift === 0, "a press on a number that barely moves changes nothing");
  el.fire("pointermove", { clientX: 155, clientY: 10 });
  const mid = page.ed.part.singer.shift;
  el.fire("pointermove", { clientX: 128, clientY: 10 });
  el.fire("pointerup", { clientX: 128, clientY: 10 });
  check(mid === 12 && page.ed.part.singer.shift === 6 && shownIn("s-shift") === "6 st" && page.ed.past.length === steps0 + 1, "pulled right it rises with the mouse, back it falls: one change when let go");
  el.fire("pointerdown", { clientX: 100, clientY: 10, button: 0, altKey: true });
  el.fire("pointerup", { clientX: 100, clientY: 10, altKey: true });
  check(page.ed.part.singer.shift === 0, "alt and a click puts it back as a singer is made");
  el.fire("keydown", { key: "ArrowUp", target: el });
  el.fire("keydown", { key: "ArrowDown", target: el, shiftKey: true });
  check(page.ed.part.singer.shift === 0.99, "the arrows step it, shift finely");
  type("s-shift", "0");
  // another singer, and one out
  const plus = $("tabs").children.find((c) => c.textContent === "+");
  plus.fire("click", {});
  check(page.desk.value.rows.length === 4 && page.ed === page.desk.value.rows[3].ed && page.ed.part.notes.length === 0 && equal(page.ed.part.tempo, page.desk.value.rows[0].ed.part.tempo) && page.ed.part.singer.voice === "6147" && names()[3] === "A woman", "+ adds a singer with no notes, in the others' time, with a voice none of them has");
  plus.fire("click", { shiftKey: true });
  check(page.desk.value.rows.length === 5 && equal(page.ed.part.notes, page.desk.value.rows[3].ed.part.notes), "shift and + copies the singer in sight");
  tabEls()[4].children.at(-1).fire("click", {});
  tabEls()[3].children.at(-1).fire("click", {});
  check(page.desk.value.rows.length === 3 && said().endsWith("is out of the score: Undo brings it back"), "a tab's x takes its singer out");
  $("undo").click();
  check(page.desk.value.rows.length === 4, "and Undo brings it back");
  $("undo").click();
  $("undo").click();
  $("undo").click();
  check(page.desk.value.rows.length === 3 && equal(page.score(), SCORES.round()), "step by step back to the score as it was opened");
  menuPick("File", "Save the score");
  check(downloads.at(-1).name === "row-row-row-your-boat-a-round-for-three.score" && equal(S.read(downloads.at(-1).data), SCORES.round()) && document.title === "Row, Row, Row Your Boat: a round for three", "Save writes the score: every singer and the mix");
}

// ---- the layout: a score opened to read, not squeezed whole; a singer's notes behind the others'
// hidden at its dot; another singer's note gone to from a right click; the panel, its sections,
// the rows under the roll folded, and the Keys help over the page
{
  await pickExample("round.score");
  const rows = () => page.desk.value.rows, g = page.ed.part.grid, roll = () => 700 - 30 - 30 - 64 - 92;
  const inRoll = (notes) => notes.every((n) => view.y(P.key(n.pitch)) >= 0 && view.y(P.key(n.pitch)) + view.tall <= roll());
  check(view.wide * g === 52 && view.left === 0 && view.tall >= 16 && inRoll(page.ed.part.notes.filter((n) => n.at < view.tick(1200 - 56))), "a score opens to read: a beat 52 pixels wide from the start, the rows tall enough for words, the singer's notes in sight in the roll");
  const cora = rootProps.get("--singer-2"), drawn = () => { calls.rects = []; page.paint(); const r = calls.rects; calls.rects = null; return r.filter((x) => x[0] === cora).length; };
  check(drawn() > 0, "Cora's notes drawn behind Finn's");
  const dot = tabEls()[1].children[0];
  dot.fire("click", { stopPropagation() {} });
  check(drawn() === 0 && page.ed === rows()[0].ed && tabEls()[1].children[0].style.background === "transparent" && said() === "Cora's notes are not shown behind the others'", "her tab's dot pressed: hidden, the dot hollow, Finn still in sight");
  const behind = menuPick("View", "Each singer's notes behind");
  check(equal(behind, { Finn: { checked: "true", greyed: true }, Cora: { checked: "false", greyed: false }, Ben: { checked: "true", greyed: false } }), "the View menu lists each singer, Cora unchecked, Finn greyed as he is in sight");
  check(menuPick("View", "Each singer's notes behind", "Cora") === null && drawn() > 0, "and Cora checked there shows her again");
  // a right click on Ben's note, where Finn has none: Ben in sight, his note chosen
  const ben = rows()[2].ed.part.notes.find((n) => n.at >= 8 * g && !rows()[0].ed.part.notes.some((m) => m.at <= n.at && m.at + m.ticks > n.at && m.pitch === n.pitch));
  const bx = 56 + view.x(ben.at) + 2, by = 30 + view.y(P.key(ben.pitch)) + view.tall / 2;
  $("canvas").fire("contextmenu", { clientX: bx, clientY: by, button: 2 });
  const go = document.body.children.at(-1).children.find((r) => r.children?.[0]?.textContent === "Go to this note's singer, the note chosen");
  check(Boolean(go) && go.attrs["aria-disabled"] === "false", "a right click on another singer's note offers to go to it");
  go.fire("click");
  check(page.ed === rows()[2].ed && page.ed.selected.size === 1 && page.ed.selected.has(ben), "chosen: Ben in sight, that note chosen");
  keydown("F", { shiftKey: true });
  check(view.x(ben.at) >= 0 && view.x(ben.at + ben.ticks) <= 1200 - 56 && inRoll([ben]) && view.tall > 16, "shift F zooms to the chosen notes");
  page.ed.select([]);
  page.show(0);
  // the panel: P hides it and shows it, kept for the next visit
  keydown("p");
  check($("side").hidden && $("side-toggle").attrs["aria-pressed"] === "false" && JSON.parse(store.get("lipservice editor: the layout")).panel === false, "P hides the panel, kept for the next visit");
  keydown("p");
  check(!$("side").hidden, "and shows it again");
  // a section folded and unfolded at its heading, what it holds said beside it while folded
  check($("fold-key").hidden && $("key-sum").textContent !== "" && $("fold-key-head").attrs["aria-expanded"] === "false", `the key's section starts folded, its key said beside it: ${$("key-sum").textContent}`);
  $("fold-key-head").fire("click");
  check(!$("fold-key").hidden && $("key-sum").textContent === "" && $("fold-key-head").attrs["aria-expanded"] === "true" && JSON.parse(store.get("lipservice editor: the layout")).folds.key === true, "pressed, it unfolds, kept for the next visit");
  $("fold-key-head").fire("click");
  check(!$("n-none").hidden && $("n-rows").hidden, "no note chosen: the note's section says how to choose one, its fields out of sight");
  page.ed.select([page.ed.part.notes[0]]);
  page.show(0);
  check($("n-none").hidden && !$("n-rows").hidden, "one chosen: its fields");
  page.ed.select([]);
  // the Keys help over the page, the roll's keys left alone while it is open
  check(menuPick("Help", "Keys and mouse") === null && $("keys-help").open && $("keys").children.length > 0, "Help, Keys and mouse: the Keys help over the page");
  const left = view.left, wide = view.wide;
  keydown("f");
  check(view.wide === wide && view.left === left, "a key under it does not reach the roll");
  $("keys-close").click();
  check(!$("keys-help").open, "Close closes it");
  // the rows under the roll: one folded at its name in the gutter, unfolded anywhere along its strip
  const at = (x, y) => { $("canvas").fire("pointerdown", { clientX: x, clientY: y, pointerId: 1, button: 0 }); $("canvas").fire("pointerup", { clientX: x, clientY: y, pointerId: 1, button: 0 }); };
  at(8, 700 - 92 - 64 + 12);
  check(page.layout.lanes.velocity === false, "the velocity row folded at its name");
  at(600, 700 - 92 - 16 + 8);
  check(page.layout.lanes.velocity === true && page.ed.selected.size === 0, "and unfolded at a press along its strip, nothing chosen by it");
}

// ---- the commands: the Keys help made from them, the clipboard, a menu at a right click, the
// palette, the ways to choose notes, and the rough edges mended
{
  await pickExample("mary.part");
  const g = 480, notes = () => page.ed.part.notes, chosen = () => notes().filter((n) => page.ed.selected.has(n));
  const meta = (key, more = {}) => keydown(key, { metaKey: true, ...more });
  const undos = () => (page.ed.past.length);
  // the Keys help
  const kbds = new Set($("keys").all("cmd-keys").flatMap((s) => s.children.map((k) => k.textContent)));
  const want = ["cmd S", "cmd O", "cmd Z", "cmd shift Z", "cmd Y", "cmd A", "cmd C", "cmd X", "cmd V", "cmd shift V", "cmd D", "cmd K", "space", "M", "1", "9", "[", "]", "O", "K", "delete", "backspace", "left", "right", "alt left", "alt right", "up", "down", "shift up", "shift down", "Enter", "Escape", "Tab", "shift Tab", "B", "L", "Home", "G", "D", "F", "=", "+", "-"];
  check($("keys").children[0].textContent === "The editor needs a mouse and a keyboard. It does not work by touch." && $("keys").children[1].className === "cmd-help" && want.every((k) => kbds.has(k)), "the Keys help is made from the commands: every key that works, cmd on a Mac");
  check($("keys").all("cmd-help-row").some((r) => r.children[1].textContent === "a note: drag out a copy of the chosen notes") && !/<kbd>/.test(html), "and the mouse's lines beside them; none written by hand in the page");
  // the system clipboard, a stand-in that can refuse
  const board = { text: null, refuse: null };
  window.navigator.clipboard = {
    writeText: async (t) => { if (board.refuse) throw new Error(board.refuse); board.text = t; },
    readText: async () => { if (board.refuse) throw new Error(board.refuse); return board.text; },
  };
  const pasteEvent = (text) => document.on.paste.at(-1)({ type: "paste", target: $("canvas"), clipboardData: { getData: (k) => (k === "text/plain" ? text : "") }, preventDefault() {} });
  // copy: cmd C puts the chosen notes on the clipboard as a part's text
  page.ed.select(notes().slice(0, 3));
  meta("c");
  await settle();
  check(board.text === Clip.copy(page.ed.part, notes().slice(0, 3)) && said() === "3 notes copied" && !failed(), "cmd C: the chosen notes on the clipboard, as a part's text");
  // paste: cmd V, then the browser's paste event, at the place Sing starts
  page.place(40 * g);
  const n0 = notes().length, u0 = undos();
  meta("v");
  pasteEvent(board.text);
  await sleep(5);
  check(notes().length === n0 + 3 && equal(chosen().map((n) => [n.at / g, n.pitch, n.lyric]), [[40, "E4", "Ma-"], [41, "D4", "ry"], [42, "C4", "had"]]) && undos() === u0 + 1 && said() === "3 notes pasted at beat 40", "cmd V: pasted where Sing starts, once, the pasted notes chosen, one step");
  meta("z");
  check(notes().length === n0, "and one Undo takes it back");
  // where the browser sends no paste event, the clipboard is read
  meta("v");
  await sleep(5);
  check(notes().length === n0 + 3 && said() === "3 notes pasted at beat 40", "cmd V with no paste event: the clipboard read, and pasted");
  meta("z");
  // where the browser will not let the page read it, nothing is pasted (the page keeps no
  // clipboard of its own to stand in for it), and why is said
  board.refuse = "NotAllowedError: not allowed";
  const r0 = undos();
  meta("v");
  await sleep(5);
  check(notes().length === n0 && undos() === r0 && failed() && said() === "nothing is pasted: the browser would not let the page read the clipboard (NotAllowedError: not allowed)", "refused the clipboard: nothing pasted, and why said");
  {
    const was = window.navigator.clipboard;
    window.navigator.clipboard = undefined;
    meta("V", { shiftKey: true });
    check(notes().length === n0 && failed() && said() === "nothing is pasted: the browser would not let the page read the clipboard (this browser gives the page no clipboard here (it has one at an https address, 127.0.0.1 or localhost))", "a browser with no clipboard here: nothing pasted, said");
    page.ed.select(notes().slice(0, 3));
    meta("c");
    check(failed() && said() === "nothing is copied: this browser gives the page no clipboard here (it has one at an https address, 127.0.0.1 or localhost)", "and nothing copied, said");
    meta("x");
    check(notes().length === n0 && undos() === r0 && failed() && said().startsWith("nothing is cut: "), "nor cut: the notes stay");
    window.navigator.clipboard = was;
  }
  board.refuse = "NotAllowedError: write";
  page.ed.select(notes().slice(0, 2));
  meta("x");
  await settle();
  check(notes().length === n0 - 2 && failed() && said() === "the 2 notes cut are not on the clipboard: the browser would not put them there (NotAllowedError: write). Undo brings them back", "a cut the browser will not take: said, and Undo's to bring back");
  meta("z");
  board.refuse = null;
  pasteEvent("just some words");
  check(failed() && said() === "the clipboard holds no lipservice notes; words go in the Words box" && notes().length === n0, "words on the clipboard are refused, and nothing changes");
  // shift cmd V pastes over the notes there
  page.place(4 * g);
  meta("V", { shiftKey: true });
  await sleep(5);
  check(notes().length === n0 && equal(notes().slice(0, 3).map((n) => [n.at / g, n.pitch]), [[4, "E4"], [5, "D4"], [6, "C4"]]) && said().startsWith("3 notes pasted over the notes there at beat 4"), "shift cmd V: over the notes there, which go");
  meta("z");
  // cut, one step
  page.ed.select(notes().slice(3, 5));
  const cut = Clip.copy(page.ed.part, notes().slice(3, 5));
  meta("x");
  await settle();
  check(notes().length === n0 - 2 && said() === "2 notes cut: Undo brings them back" && board.text === cut, "cmd X: the notes cut, on the clipboard");
  meta("z");
  check(notes().length === n0, "and Undo brings them back");
  // duplicate: after themselves, the copy chosen
  page.ed.select(notes().slice(0, 3));
  const dup = Clip.duplicate(page.ed.part, notes().slice(0, 3), Number($("snap").value));
  meta("d");
  check(equal(notes(), dup.part.notes) && chosen().length === 3 && chosen()[0].at === 7 * g && said() === "3 notes again at beat 7", "cmd D: the chosen notes again right after themselves, chosen");
  meta("z");
  // a refusal said by name: copy with nothing chosen; select all with the mixer in sight
  keydown("Escape");
  meta("c");
  check(said() === "Copy: no note is chosen" && page.ed.selected.size === 0, "cmd C with nothing chosen: said");
  page.showMixer();
  meta("a");
  check(page.ed.selected.size === 0 && said() === "Choose every note: the mixer is in sight: choose a singer's tab", "cmd A with the mixer in sight chooses nothing");
  page.show(0);
  meta("a");
  check(page.ed.selected.size === n0, "with a singer in sight, every note");
  // alt and a drag: a copy of the chosen notes dragged out, the notes left
  page.ed.select([notes()[0]]);
  const was = notes().slice();
  mouse("down", X(4.5), Y(64), { altKey: true });
  mouse("move", X(6.5), Y(66), { altKey: true });
  mouse("move", X(8.5), Y(66), { altKey: true });
  mouse("up", X(8.5), Y(66), { altKey: true });
  check(notes().length === n0 + 1 && was.every((n) => notes().includes(n)) && equal(chosen().map((n) => [n.at / g, n.pitch, n.lyric]), [[8, "F#4", "Ma-"]]) && said() === "1 note copied to beat 8\nthe pasted notes end inside a word: \"Ma-\" at beat 8 runs on into the next syllable", "alt and a drag: a copy dragged out, chosen, the note left where it was");
  meta("z");
  check(notes().length === n0 && equal(notes(), was), "the whole drag one step of Undo");
  // shift and a click on a chosen note takes it out, and drags nothing
  page.ed.select(notes().slice(0, 2));
  const part0 = page.ed.part;
  mouse("down", X(5.5), Y(62), { shiftKey: true });
  mouse("move", X(7.5), Y(65), { shiftKey: true });
  mouse("up", X(7.5), Y(65), { shiftKey: true });
  check(page.ed.part === part0 && equal(chosen(), [notes()[0]]), "shift and a click on a chosen note takes it out of the choice, and drags nothing");
  // the velocity row: the note pressed set, the others chosen moved as much
  page.ed.select(notes().slice(0, 2));
  page.ed.set([notes()[1]], { velocity: 60 });
  const velY = (v) => 700 - 92 - 64 + 4 + (64 - 8) * (1 - v / 127);
  mouse("down", X(4.5), velY(110));
  mouse("up", X(4.5), velY(110));
  check(equal(notes().slice(0, 3).map((n) => n.velocity), [110, 74, 96]), "a press in the velocity row: the note pressed to it, the other chosen by as much, their difference kept");
  meta("z");
  type("n-velocity", "100");
  check(equal(notes().slice(0, 3).map((n) => n.velocity), [100, 64, 96]), "and the panel's velocity: the first note to it, the other by as much");
  meta("z");
  meta("z");
  // the keys at the left: every note on that key
  click(20, Y(64));
  check(chosen().length === notes().filter((n) => n.pitch === "E4").length && chosen().every((n) => n.pitch === "E4") && said().endsWith("on E4"), "a click on a key at the left chooses every note on it");
  click(20, Y(62), { shiftKey: true });
  check(chosen().every((n) => n.pitch === "E4" || n.pitch === "D4") && chosen().some((n) => n.pitch === "D4"), "with shift, adds those on another");
  // Tab and shift Tab, Escape
  page.ed.select([notes()[0]]);
  keydown("Tab");
  check(equal(chosen(), [notes()[1]]), "Tab chooses the next note");
  keydown("Tab", { shiftKey: true });
  check(equal(chosen(), [notes()[0]]), "shift Tab the one before");
  {
    // on a number of the panel or a button, Tab moves the keys on as Tab does
    let prevented = 0;
    const tab = (target, more = {}) => { for (const f of document.on.keydown) f({ key: "Tab", target, preventDefault() { prevented++; }, ...more }); };
    tab(page.fields["n-velocity"].el);
    tab($("sing"));
    tab(page.fields["n-velocity"].el, { shiftKey: true });
    check(equal(chosen(), [notes()[0]]) && prevented === 0 && page.fields["n-velocity"].el.tagName === "DIV", "on the velocity field or a button, Tab and shift Tab are left to the page, the note still chosen");
  }
  keydown("Escape");
  check(page.ed.selected.size === 0, "Escape lets go");
  // a breath mark goes with its note, and out with it
  page.ed.select([notes()[0]]);
  keydown("b");
  keydown("ArrowRight");
  check(equal(page.ed.part.marks, [{ at: 4 * g + g / 4, breath: true }]), "B marks a breath on the note, and it goes where the note goes");
  keydown("Delete");
  check(equal(page.ed.part.marks, []), "deleted, its mark goes with it");
  for (let i = 0; i < 3; i++) meta("z");
  check(notes().length === n0 && notes()[0].at === 4 * g && equal(page.ed.part.marks, []), "all of it undone");
  // a note moved up or down is named for the key: E minor, found in Mary's notes, spells with sharps
  page.ed.select([notes()[0]]);
  type("n-pitch", "Bb4");
  keydown("ArrowUp");
  keydown("ArrowDown");
  check(T.detect(notes())[0].name === "E minor" && notes()[0].pitch === "A#4", "Bb4 up a key and back is A#4, as E minor (found in the notes) names it");
  for (let i = 0; i < 3; i++) meta("z");
  check(notes()[0].pitch === "E4", "and undone");
  // a right click on a note: it is chosen, and a menu of what can be done there
  page.ed.select([]);
  const n2 = notes()[2];
  $("canvas").fire("contextmenu", { clientX: X(6.5), clientY: Y(60), button: 2 });
  const menuEl = document.body.children.at(-1), rowsOf = (m) => m.children.filter((c) => c.attrs.role === "menuitem");
  const labels = rowsOf(menuEl).map((r) => r.children[0].textContent);
  check(menuEl.className.startsWith("cmd-menu") && menuEl.attrs.role === "menu" && equal(chosen(), [n2]) && ["Cut", "Copy", "Paste", "Duplicate", "Delete", "Choose", "Breath before the note: always, never, or left to the singer", "Type the note's syllable", "Sing from here"].every((l) => labels.includes(l)), "a right click on a note chooses it and opens a menu of what can be done to it");
  rowsOf(menuEl).find((r) => r.children[0].textContent === "Copy").fire("click");
  await settle();
  check(!document.body.children.includes(menuEl) && board.text === Clip.copy(page.ed.part, [n2]) && said() === "1 note copied", "Copy chosen from it: the note copied, the menu gone");
  // on the empty roll: Paste there
  $("canvas").fire("contextmenu", { clientX: X(44), clientY: Y(70), button: 2 });
  rowsOf(document.body.children.at(-1)).find((r) => r.children[0].textContent === "Paste").fire("click");
  await sleep(5);
  check(notes().length === n0 + 1 && equal(chosen().map((n) => [n.at / g, n.pitch]), [[44, "C4"]]) && said() === "1 note pasted at beat 44", "Paste from a right click on the empty roll: pasted where the click was");
  meta("z");
  // on a tab
  tabEls()[0].fire("contextmenu", { clientX: 30, clientY: 40 });
  const tabMenu = rowsOf(document.body.children.at(-1));
  check(equal(tabMenu.slice(0, 4).map((r) => [r.children[0].textContent, r.attrs["aria-disabled"]]), [["Add a singer", "false"], ["Copy this singer as a new one", "false"], ["Rename this singer", "false"], ["Remove this singer", "true"]]) && tabMenu[3].attrs.title === "a score has one singer at least", "a right click on a tab: what can be done to its singer, Remove greyed with why");
  check(["Add a harmony", "Make a round or canon", "Double this singer", "Octave double", "Make a section", "Add echoes", "Hocket: the words handed between singers", "Add a drone", "Fill bare notes with scat", "Another singer of this voice: the next seed", "Way to sing"].every((l) => tabMenu.some((r) => r.children[0].textContent === l && r.attrs["aria-disabled"] === "false")) && tabMenu.find((r) => r.children[0].textContent === "Split a chord into singers").attrs.title === "no two of its notes sound together" && tabMenu.find((r) => r.children[0].textContent.startsWith("Unlink")).attrs.title === "this singer follows no one", "and the new singers that can be made from it, those that cannot greyed with why");
  document.body.children.at(-1).fire("keydown", { key: "Escape", preventDefault() {} });
  check(!document.body.children.some((c) => String(c.className).startsWith("cmd-menu")), "Escape closes it");
  // the ContextMenu key, with no point: the menu at the first note chosen
  page.ed.select([notes()[4]]);
  view.left = 0;
  $("canvas").fire("contextmenu", { clientX: 0, clientY: 0 });
  const keyed = document.body.children.at(-1);
  check(String(keyed.className).startsWith("cmd-menu") && keyed.style.left === `${X(8) + 4}px` && equal(chosen(), [notes()[4]]) && rowsOf(keyed).some((r) => r.children[0].textContent === "Copy"), "the ContextMenu key opens the note's menu at the first note chosen");
  keyed.fire("keydown", { key: "Escape", preventDefault() {} });
  // a key bound to a command that cannot run now: why said, and the browser's own use of it refused
  keydown("Escape");
  let refused = false;
  meta("d", { preventDefault() { refused = true; } });
  check(refused && said() === "Duplicate: no note is chosen", "cmd D with nothing chosen: why said, and the browser does not bookmark the page");
  // the palette: cmd K, words typed, Enter
  page.ed.select([notes()[1]]);
  meta("k");
  const dialog = document.body.children.at(-1), find = dialog.children[0];
  check(dialog.tagName === "DIALOG" && dialog.open && document.activeElement === find, "cmd K opens Find a command, the keys in its box");
  find.value = "every key";
  find.fire("input");
  check(dialog.children[1].children[0].children.find((c) => c.className === "cmd-label").textContent === "Choose every note on this key", "words typed find the command");
  find.fire("keydown", { key: "Enter", preventDefault() {} });
  check(!document.body.children.includes(dialog) && chosen().length === notes().filter((n) => n.pitch === "D4").length && chosen().every((n) => n.pitch === "D4") && said().endsWith("on D4"), "Enter runs it: every note on the chosen note's key");
  // from here on, and the choice inverted
  view.left = 0;
  $("canvas").fire("contextmenu", { clientX: X(20.05), clientY: 15, button: 2 });
  const choose = rowsOf(document.body.children.at(-1)).find((r) => r.children[0].textContent === "Choose");
  choose.fire("click");
  rowsOf(choose.children.find((c) => String(c.className).startsWith("cmd-menu"))).find((r) => r.children[0].textContent === "Choose every note from here on").fire("click");
  const later = notes().filter((n) => n.at >= 20 * g);
  check(equal(chosen(), later) && said() === `${later.length} notes from beat 20 on`, "from a right click on the ruler: every note from there on");
  meta("k");
  const find2 = document.body.children.at(-1).children[0];
  find2.value = "invert";
  find2.fire("input");
  find2.fire("keydown", { key: "Enter", preventDefault() {} });
  check(equal(chosen(), notes().filter((n) => n.at < 20 * g)), "Invert the choice: the others");
  check(!failed(), "and nothing said went wrong");
  delete window.navigator.clipboard;
  await pickExample("round.score");
}

// ---- the key and Scale: found in the notes or chosen, the roll's rows tinted for it, notes named
// for it and, with Scale on, landing on its notes
{
  await pickExample("mary.part");
  const g = 480, notes = () => page.ed.part.notes, chosen = () => notes().filter((n) => page.ed.selected.has(n));
  const meta = (key, more = {}) => keydown(key, { metaKey: true, ...more });
  const pitches = () => notes().map((n) => n.pitch);
  const rowFill = (k) => calls.rects.find((r) => r[1] === 56 && r[2] === 30 + view.y(k))?.[0];
  const minor = { tonic: 4, scale: "natural minor" };
  check($("key-tonic").value === "" && $("key-scale").value === "natural minor" && !$("key-scale").disabled && $("key-said").textContent === "E minor, found in the notes: 100% of their time is on its scale. Next: C major, G major." && equal($("key-tonic").children.map((o) => o.textContent), ["from the notes", ...Array.from({ length: 12 }, (_, t) => T.tonicName({ tonic: t, scale: "natural minor" }))]), "Mary's key is found in its notes, E minor, and the panel says so and what came next");
  calls.rects = [];
  page.paint();
  check(rowFill(64) === rootProps.get("--roll-tonic") && rowFill(66) === rootProps.get("--roll-in-key") && rowFill(65) === rootProps.get("--roll-black") && calls.rects.some((r) => r[0] === rootProps.get("--roll-tonic-key") && r[1] === 51 && r[2] === 30 + view.y(64)), "the roll's rows: E the tonic's, F# the key's, F not the key's, E marked at the left");
  calls.rects = null;
  // a tonic chosen, then a scale
  $("key-tonic").value = "5";
  $("key-tonic").fire("change");
  $("key-scale").value = "major";
  $("key-scale").fire("change");
  check(equal(page.set.key, { tonic: 5, scale: "major" }) && said() === "the key: F major, chosen" && $("key-tonic").value === "5" && $("key-said").textContent === "F major, chosen. The notes fit E minor best." && $("key-tonic").children[11].textContent === "Bb" && equal(JSON.parse(store.get("lipservice editor: the page 2")).key, { tonic: 5, scale: "major" }), "F major chosen: kept with the page's settings, and the panel says what the notes fit best");
  calls.rects = [];
  page.paint();
  check(rowFill(65) === rootProps.get("--roll-tonic") && rowFill(64) === rootProps.get("--roll-in-key") && rowFill(66) === rootProps.get("--roll-black"), "the rows tinted for F major");
  calls.rects = null;
  // named for the key as they move
  page.ed.select([notes()[0]]);
  keydown("ArrowUp");
  keydown("ArrowUp");
  check(notes()[0].pitch === "Gb4", "E4 up two keys in F major is Gb4: F major names it with a flat");
  keydown("ArrowDown");
  check(notes()[0].pitch === "F4", "and down one, F4");
  for (let i = 0; i < 3; i++) meta("z");
  // Scale on: the arrows step along the scale, alt a key at a time
  keydown("S", { shiftKey: true });
  check(page.set.scale && $("scale").attrs["aria-pressed"] === "true" && said() === "Scale on: notes land on the notes of F major" && JSON.parse(store.get("lipservice editor: the page 2")).scale === true, "shift S: Scale on, kept with the page's settings");
  page.ed.select([notes()[0]]);
  keydown("ArrowUp");
  const up1 = notes()[0].pitch;
  keydown("ArrowUp");
  const up2 = notes()[0].pitch;
  keydown("ArrowDown", { altKey: true });
  const off = notes()[0].pitch;
  keydown("ArrowDown");
  check(equal([up1, up2, off, notes()[0].pitch], ["F4", "G4", "Gb4", "F4"]), "with Scale, up a step is F4 then G4; alt and down a key is Gb4; down from it lands on F4");
  for (let i = 0; i < 4; i++) meta("z");
  check(notes()[0].pitch === "E4", "each a step of Undo");
  // a note dragged lands on the key's notes, on the side the mouse went
  const u0 = page.ed.past.length;
  mouse("down", X(5.5), Y(62));
  mouse("move", X(5.5), Y(63));
  const half = notes()[1].pitch;
  mouse("move", X(5.5), Y(66));
  mouse("up", X(5.5), Y(66));
  check(half === "E4" && notes()[1].pitch === "G4" && page.ed.past.length === u0 + 1, "with Scale, D4 dragged to Eb lands on E4, and on to Gb, G4: one step");
  meta("z");
  // a copy dragged out lands on them too
  page.ed.select([notes()[0]]);
  mouse("down", X(4.5), Y(64), { altKey: true });
  mouse("move", X(8.5), Y(66), { altKey: true });
  mouse("up", X(8.5), Y(66), { altKey: true });
  check(equal(chosen().map((n) => [n.at / g, n.pitch]), [[8, "G4"]]), "an alt drag's copy, from E4 to Gb, lands on G4");
  meta("z");
  // drawn on C# it lands on C, the nearer below where two are as near
  const n0 = notes().length;
  twice(X(1.3), Y(61));
  mouse("up", X(1.3), Y(61));
  check(notes().length === n0 + 1 && notes()[0].at === 1.25 * g && notes()[0].pitch === "C4", "with Scale, a note drawn on C# lands on C4");
  meta("z");
  // no key at all: what Scale needs is said, and nothing is drawn
  menuPick("File", "New score");
  twice(X(1.3), Y(61));
  mouse("up", X(1.3), Y(61));
  check(notes().length === 0 && failed() && said() === "Scale is on, and the score has no key: choose one in the panel, or turn Scale off" && page.set.key === null && $("key-said").textContent === "No key yet: no notes to find a key in. Choose one above." && $("key-scale").disabled, "a new score has no key: with Scale on a note is not drawn, and why is said");
  $("undo").click();
  check(notes().length === n0 && $("key-said").textContent.startsWith("E minor, found in the notes"), "Mary back: its key found again, a score opened having none chosen");
  keydown("S", { shiftKey: true });
  check(!page.set.scale && said() === "Scale off: notes go to any key", "shift S again: Scale off");
}

// ---- the tools (shape.js): from their keys, the menu and Find a command; those with options in a
// panel of pull fields over the roll, run at once, pulled live, kept or put back as one step
{
  const g = 480, notes = () => page.ed.part.notes, chosen = () => notes().filter((n) => page.ed.selected.has(n));
  const meta = (key, more = {}) => keydown(key, { metaKey: true, ...more });
  const steps = () => page.ed.past.length, journal = () => $("undo").disabled;
  const panel = () => $("roll").children.find((c) => c.className === "tool") ?? null;
  const pane = () => page.tool();
  const brief = (list) => list.map((n) => [n.at / g, n.ticks, n.pitch, n.lyric]);
  const was = notes().slice(), s0 = steps();
  // the Keys help and the menu have them
  const kbds = new Set($("keys").all("cmd-keys").flatMap((s) => s.children.map((k) => k.textContent)));
  check(["Q", "S", "alt S", "J", "shift L", "shift G", "T", "shift T", "I", "R", "shift R", "A", "V", "shift S", "alt up", "alt down"].every((k) => kbds.has(k)), "the Keys help has the tools' keys");
  // gate: shift G, the panel over the roll, the tool done at once
  page.ed.select(notes().slice(0, 3));
  keydown("G", { shiftKey: true });
  check(panel() && panel().children[0].children[0].textContent === "Gate" && equal(notes().slice(0, 3).map((n) => n.ticks), [240, 240, 240]) && chosen().length === 3 && steps() === s0 + 1 && said().startsWith("Gate: 3 notes\n"), "shift G: Gate's panel, the notes half as long at once, one step");
  pane().pulls.fraction.typed("0.25");
  check(equal(notes().slice(0, 3).map((n) => n.ticks), [120, 120, 120]) && steps() === s0 + 1 && pane().pulls.fraction.value === 0.25, "its length pulled to a quarter: done again from where it began, still one step");
  keydown("Escape");
  check(!panel() && equal(notes(), was) && steps() === s0 && $("redo").disabled && said() === "Gate: the notes are as they were", "Escape: the notes back as they were, and no step of Undo or Redo left for it");
  keydown("G", { shiftKey: true });
  check(equal(notes().slice(0, 3).map((n) => n.ticks), [120, 120, 120]), "opened again, the length it had");
  keydown("Enter");
  check(!panel() && steps() === s0 + 1 && said() === "Gate: kept", "Enter keeps it");
  meta("z");
  check(equal(notes(), was), "and one Undo takes it back");
  // a refusal: said, the notes as they were before the tool, the panel still open
  page.ed.select([notes()[0]]);
  meta("k");
  const find = document.body.children.at(-1).children[0];
  find.value = "turn";
  find.fire("input");
  find.fire("keydown", { key: "Enter", preventDefault() {} });
  check(panel() && pane().values.kind === "turn" && equal(brief(chosen()), [[4, 60, "F#4", "Ma-"], [4.125, 60, "E4", "_"], [4.25, 60, "D4", "_"], [4.375, 300, "E4", "_"]]), "Find a command, turn: E4 turned on E minor's neighbours, on its syllable");
  pane().pulls.rate.typed("2 beats");
  check(failed() && said() === "Ornament: beat 4: a turn at 960 ticks a note needs 3840 ticks, and the note is 480" && equal(notes(), was) && panel() && pane().pulls.rate.el.children[1].textContent === "2 beats", "a rate too slow for the note is refused by beat; the notes as they were, the panel open");
  pane().pulls.rate.typed("1/16");
  check(!failed() && chosen().length === 4 && chosen()[3].ticks === 390, "a faster one is done");
  panel().children[3].children[0].click();
  check(!panel() && steps() === s0 + 1 && said() === "Ornament: kept", "Keep keeps it");
  meta("z");
  // the menu: an Ornament submenu, its trill
  $("canvas").fire("contextmenu", { clientX: X(4.5), clientY: Y(64), button: 2 });
  const menuEl = document.body.children.at(-1), rowsOf = (m) => m.children.filter((c) => c.attrs.role === "menuitem");
  const labels = rowsOf(menuEl).map((r) => r.children[0].textContent);
  check(["Quantize: the starts to the step", "Split into equal notes", "Transform", "Ornament", "Arpeggiate: notes together become a line", "Shape the vibrato over each note: late, swell or fade", "Find the key of the chosen notes"].every((l) => labels.includes(l)), "a right click on a note offers the tools, the transforms and the ornaments in menus of their own");
  const orn = rowsOf(menuEl).find((r) => r.children[0].textContent === "Ornament");
  orn.fire("click");
  const sub = orn.children.find((c) => String(c.className).startsWith("cmd-menu"));
  rowsOf(sub).find((r) => r.children[0].textContent === "Trill").fire("click");
  check(panel() && pane().values.kind === "trill" && pane().pulls.kind.value === "trill" && chosen().length === 15 && chosen().every((n, i) => n.pitch === (i % 2 ? "F#4" : "E4")) && pane().pulls.rate.el.children[1].textContent === "1/16", "Trill from it, at the rate the turn was left at: E4 and F#4 in turn, ending on E4");
  pane().pulls.key.click();
  check(pane().pulls.key.attrs["aria-pressed"] === "false" && pane().pulls.key.textContent === "by semitones" && pane().pulls.width && equal(chosen().map((n) => n.pitch).slice(0, 2), ["E4", "F#4"]), "by semitones: its width shown, a whole tone by default");
  pane().pulls.width.typed("1");
  check(equal(chosen().map((n) => n.pitch).slice(0, 2), ["E4", "F4"]), "a semitone wide: F4");
  panel().children[3].children[1].click();
  check(!panel() && equal(notes(), was) && steps() === s0, "Cancel puts the notes back");
  // quantize: Q, its strength pulled
  page.ed.select([notes()[1]]);
  type("n-at", "5.1");
  const s1 = steps();
  keydown("q");
  check(notes()[1].at === 5 * g && steps() === s1 + 1, "Q quantizes a start to the quarter beat");
  pane().pulls.strength.typed("0.5");
  check(notes()[1].at === 5.05 * g, "half the way");
  pane().pulls.step.typed("1/2");
  check(pane().pulls.step.el.children[1].textContent === "1/2" && notes()[1].at === 5.05 * g, "its step pulled through the snap's lengths");
  keydown("Escape");
  meta("z");
  check(equal(notes(), was), "put back, and the start undone");
  // split, then join
  page.ed.select([notes()[0]]);
  keydown("s");
  pane().pulls.n.typed("3");
  check(equal(brief(chosen()), [[4, 160, "E4", "Ma-"], [4 + 1 / 3, 160, "E4", "_"], [4 + 2 / 3, 160, "E4", "_"]]), "S splits, in 3 when pulled to 3: the syllable held");
  keydown("Enter");
  keydown("j");
  check(equal(brief(chosen()), [[4, 480, "E4", "Ma-"]]) && said() === "Join: 3 notes made 1 note", "J joins them again");
  meta("z");
  meta("z");
  check(equal(notes(), was), "two steps back");
  page.ed.select(notes().slice(4, 6));
  keydown("j");
  check(failed() && said() === "beat 9: \"tle\" is a syllable of its own, and joined it would be lost" && equal(notes(), was), "J on two syllables is refused by beat");
  // split where Sing starts
  page.place(4.5 * g);
  page.ed.select([notes()[0]]);
  keydown("s", { altKey: true });
  check(equal(brief(chosen()), [[4, 240, "E4", "Ma-"], [4.5, 240, "E4", "_"]]) && said() === "Split here: 1 note made 2 notes", "alt S splits where Sing starts");
  meta("z");
  page.place(0);
  // reverse: the words read as they did
  page.ed.select(notes().slice(0, 4));
  const words = wordsOf(notes());
  keydown("r");
  check(equal(notes().slice(0, 4).map((n) => n.pitch), ["D4", "C4", "D4", "E4"]) && wordsOf(notes()) === words, "R reverses the notes, the words still in order");
  meta("z");
  // transpose, named for the key; invert along the scale and by semitones
  page.ed.select(notes().slice(0, 3));
  keydown("t");
  check(equal(chosen().map((n) => n.pitch), ["E5", "D5", "C5"]), "T transposes, an octave by default");
  pane().pulls.semitones.typed("-2");
  check(equal(chosen().map((n) => n.pitch), ["D4", "C4", "A#3"]), "pulled down two: named as E minor names them");
  keydown("Escape");
  page.ed.select(notes().slice(0, 4));
  keydown("i");
  check(equal(chosen().map((n) => n.pitch), ["E4", "F#4", "G4", "F#4"]) && pane().pulls.axis.el.children[1].textContent === "E4", "I mirrors them about the first, along E minor");
  pane().pulls.key.click();
  check(equal(chosen().map((n) => n.pitch), ["E4", "F#4", "G#4", "F#4"]), "by semitones");
  keydown("Escape");
  check(equal(notes(), was) && steps() === s0, "each put back");
  // arpeggiate: a note alone is its octaves, or a chord of the key
  page.ed.select([notes()[0]]);
  keydown("a");
  check(equal(chosen().map((n) => n.pitch), ["E4", "E4", "E4", "E4"]), "A on a note alone: a line of it");
  pane().pulls.chord.value = "triad";
  pane().pulls.chord.fire("change");
  check(equal(brief(chosen()), [[4, 120, "E4", "Ma-"], [4.25, 120, "G4", "_"], [4.5, 120, "B4", "_"], [4.75, 120, "E4", "_"]]), "with a triad chosen: E minor's on E, up, on the one syllable");
  pane().pulls.pattern.value = "digits";
  pane().pulls.pattern.fire("change");
  pane().pulls.digits.value = "3 2 1";
  pane().pulls.digits.fire("input");
  check(equal(chosen().map((n) => n.pitch), ["B4", "G4", "E4", "B4"]), "digits typed: 3 2 1");
  keydown("Escape");
  // the vibrato shaped, and what the singer's motion means for it said
  page.ed.select([notes()[6]]);
  const lane = page.ed.part.lanes.vibrato;
  keydown("v");
  check(page.ed.part.lanes.vibrato !== lane && page.ed.part.lanes.vibrato.every((q) => q.value > 0) && said().includes("the drawn vibrato is sung with the motion \"- (drawn)\" only, and this singer's is vibrato"), "V shapes the vibrato over the note; never to none, and the motion it needs said");
  keydown("Escape");
  check(page.ed.part.lanes.vibrato === lane, "put back");
  // the panel is kept and closed by what else is done
  page.ed.select(notes().slice(0, 3));
  keydown("G", { shiftKey: true });
  page.showMixer();
  check(!panel() && notes()[0].ticks === 120, "the mixer shown: the panel kept and closed");
  page.show(0);
  keydown("G", { shiftKey: true });
  mouse("down", X(20), Y(70));
  mouse("up", X(20), Y(70));
  check(!panel(), "a press on the roll closes it too");
  meta("z");
  meta("z");
  check(equal(notes(), was) && steps() === s0, "each a step");
  // the key of the chosen notes, said and not set
  page.ed.select(notes().slice(0, 4));
  meta("k");
  const find2 = document.body.children.at(-1).children[0];
  find2.value = "find key";
  find2.fire("input");
  find2.fire("keydown", { key: "Enter", preventDefault() {} });
  check(said().startsWith("the chosen notes fit ") && said().endsWith("The key is chosen in the panel") && page.set.key === null, "the key of the chosen notes is said, and not set");
  await pickExample("round.score");
}

// ---- new singers made from one (make.js), each in a panel of its values, live and one step of
// Undo; singers that follow another kept in step with it; the ways to sing (ways.js) and another
// singer of the same voice
{
  await pickExample("mary.part");
  const g = 480, rows = () => page.desk.value.rows, notes = () => page.ed.part.notes, meta = (key, more = {}) => keydown(key, { metaKey: true, ...more });
  const panel = () => $("roll").children.find((c) => c.className === "tool") ?? null, pane = () => page.tool();
  const keys = (part) => part.notes.map((n) => P.key(n.pitch));
  const whole = () => { try { S.check(page.score()); return true; } catch { return false; } };
  const button = (id) => $(id).on.click[0]({ type: "click", target: $(id) });
  const E = { tonic: 4, scale: "natural minor" }, mary = page.ed.part, steps0 = page.desk.past.length;
  // a harmony: H opens its panel, and Escape takes it back with no step left
  keydown("h");
  check(panel() && rows().length === 2 && pane().spec.label === "Harmony", "H: Harmony's panel, and a new singer at once");
  keydown("Escape");
  check(!panel() && rows().length === 1 && page.ed.part === mary && page.desk.past.length === steps0 && $("redo").disabled && said() === "Harmony: taken back, the score as it was", "Escape takes the new singer back, leaving no step of Undo or Redo");
  // a third above along E minor, of the voice after this one's on the site's list, a seed of its own
  keydown("h");
  const h = rows()[1];
  check(h.ed.part.singer.voice === "2428" && h.ed.part.singer.seed !== mary.singer.seed && equal(h.ed.part.notes, Make.harmonize(mary, E, 2, "2428", h.ed.part.singer.seed).notes) && !h.follows && page.ed === rows()[0].ed && pane().pulls.interval.el.children[1].textContent === "a third above" && said().startsWith("Harmony: a new singer, Mary Had a Little Lamb, a third above") && whole(), "a third above in E minor, the next voice on the site's list and a seed of its own; this singer still in sight");
  pane().pulls.interval.typed("-2");
  check(rows()[1].ed === h.ed && equal(rows()[1].ed.part.notes, Make.harmonize(mary, E, -2, "2428", h.ed.part.singer.seed).notes) && pane().pulls.interval.el.children[1].textContent === "a third below", "its interval pulled: the same new singer, a third below now");
  pane().pulls.key.click();
  check(equal(rows()[1].follows, { leader: 0, after: 0, keys: -2 }) && equal(keys(rows()[1].ed.part), keys(mary).map((k) => k - 2)) && pane().pulls.interval.el.children[1].textContent === "2 semitones below" && whole(), "by semitones it follows this singer, two keys down");
  keydown("Enter");
  check(!panel() && rows().length === 2 && said() === "Harmony: kept" && tabEls()[1].children.some((c) => c.textContent === "follows 1"), "Enter keeps it: its tab says whom it follows");
  meta("z");
  check(rows().length === 1 && page.ed.part === mary, "one Undo takes all of it back");
  meta("z", { shiftKey: true });
  check(rows().length === 2 && equal(rows()[1].follows, { leader: 0, after: 0, keys: -2 }), "and Redo brings it back, linked");
  meta("z");
  // an octave double from the panel's button: it follows, and is kept in step with its leader
  button("make-octave");
  check(panel() && pane().values.by === "an octave above" && rows().length === 2 && equal(rows()[1].follows, { leader: 0, after: 0, keys: 12 }) && equal(keys(rows()[1].ed.part), keys(mary).map((k) => k + 12)) && rows()[1].ed.part.singer.voice === "2428", "the Octave button: a new singer an octave above, following this one");
  keydown("Enter");
  const twin = () => rows()[1].ed.part;
  page.ed.select([notes()[0]]);
  keydown("ArrowUp");
  check(notes()[0].pitch === "F4" && twin().notes[0].pitch === "F5" && whole(), "a note of the leader moved: the follower's moves with it");
  meta("z");
  check(notes()[0].pitch === "E4" && twin().notes[0].pitch === "E5", "and one Undo puts both back");
  // a drag, as one step
  mouse("down", X(4.5), Y(64));
  mouse("move", X(5.5), Y(66));
  mouse("up", X(5.5), Y(66));
  check(notes()[0].at === 5 * g && equal(twin().notes.map((n) => [n.at, P.key(n.pitch)]), notes().map((n) => [n.at, P.key(n.pitch) + 12])) && whole(), "a leader's note dragged: the follower's goes with it all the way");
  meta("z");
  check(equal(twin().notes, Make.followed(mary, twin(), rows()[1].follows).notes) && notes()[0].at === 4 * g, "the whole drag one step for both");
  // a tool's panel on the leader: the follower in step as it is pulled, and put back with it
  const was = twin(), u0 = page.desk.past.length + page.ed.past.length;
  page.ed.select(notes().slice(0, 3));
  keydown("t");
  pane().pulls.semitones.typed("12");
  check(equal(twin().notes.slice(0, 3).map((n) => n.pitch), ["E6", "D6", "C6"]), "Transpose on the leader: the follower an octave up with it");
  pane().pulls.semitones.typed("-12");
  check(equal(twin().notes.slice(0, 3).map((n) => n.pitch), ["E4", "D4", "C4"]), "pulled down: the follower with it");
  keydown("Escape");
  check(twin() === was && page.desk.past.length + page.ed.past.length === u0 && $("redo").disabled, "Escape: both as they were, no step left");
  // words given the leader are the follower's
  $("words").value = Array(notes().length).fill("la").join(" ");
  $("words").fire("input");
  $("words-apply").click();
  check(twin().notes.every((n) => n.lyric === "la") && whole(), "words put under the leader's notes are under the follower's");
  meta("z");
  check(twin().notes[0].lyric === "Ma-", "and undone from both");
  // what is shown of it: the panel, the tab, the mixer, the roll
  page.show(1);
  check(!$("s-follows").hidden && !$("s-unlink").hidden && $("s-follows-text").textContent.startsWith("Follows Mary Had a Little Lamb, an octave above. Its notes, words and vibrato are made from Mary Had a Little Lamb's") && page.board.fields.strips[1].label.textContent === "Mary Had a Little Lamb, an octave above, following Mary Had a Little Lamb", "the follower's panel says whom it follows, with Unlink beside; its mixer strip says so too");
  calls.text = 0;
  page.paint();
  check(calls.text > 0, "its roll is drawn, notes with a broken edge and a line saying whom it follows");
  // a harmony made from it by semitones follows its leader
  keydown("h");
  check(rows().length === 3 && equal(rows()[2].follows, { leader: 0, after: 0, keys: 10 }) && whole(), "a harmony two keys under the follower follows its leader, ten keys up");
  keydown("Escape");
  // its own notes cannot be changed; its settings are its own
  page.ed.select([notes()[0]]);
  keydown("ArrowUp");
  check(failed() && said().startsWith("Mary Had a Little Lamb, an octave above follows Mary Had a Little Lamb, so its notes, words and vibrato are made from Mary Had a Little Lamb's: change those, or unlink it first") && notes()[0].pitch === "E5", "a follower's own note moved is refused, saying why and what to do");
  type("s-shift", "1");
  check(page.ed.part.singer.shift === 1 && $("s-said").textContent === "" && whole(), "its settings are its own");
  meta("z");
  page.show(0);
  check($("s-follows-text").textContent === "Followed by Mary Had a Little Lamb, an octave above: a change to these notes is theirs too." && $("s-unlink").hidden, "the leader's panel says who follow it");
  // A 0 of vibrato under the leader's motion is not sung; under a follower's motion - it would be
  // a flat held tone, and is refused. Nor is one copied from under a motion pasted under -.
  {
    const motion = (m) => { $("s-motion").value = m; $("s-motion").fire("change"); };
    page.show(1);
    motion("-");
    page.show(0);
    const lead0 = page.ed.part, twin0 = twin();
    let refusal = null;
    try { page.ed.point("vibrato", 2 * g, 0); } catch (e) { refusal = e.message; }
    check(twin0.singer.motion === null && refusal?.includes("would have a vibrato of 0 at beat 2 with its motion -, a flat held tone, where its leader has the motion vibrato and does not sing it") && page.ed.part === lead0 && twin() === twin0, `the leader's point pulled to 0 with its follower's motion -: refused, nothing changed: "${refusal}"`);
    page.show(1);
    meta("z");
    page.show(0);
    check(twin().singer.motion === "vibrato", "the follower's motion back");
    page.ed.point("vibrato", 4 * g, 0);
    check(twin().lanes.vibrato.some((q) => q.at === 4 * g && q.value === 0), "with a motion of its own, the follower takes the leader's 0, not sung by either");
    const zero = Clip.copy(page.ed.part, page.ed.part.notes.slice(0, 2));
    motion("-");
    const before = page.ed.part;
    document.on.paste.at(-1)({ type: "paste", target: $("canvas"), clipboardData: { getData: (k) => (k === "text/plain" ? zero : "") }, preventDefault() {} });
    check(failed() && said().startsWith("the paste is refused: its vibrato is 0 at beat ") && said().includes("where the singer it was copied from has the motion vibrato and does not sing it, and this singer's motion is -") && page.ed.part === before, `notes copied from under a motion, a 0 among their vibrato, pasted under -: refused: "${said()}"`);
    meta("z");
    meta("z");
    check(page.ed.part === mary && twin().lanes === twin0.lanes, "all of it undone");
  }
  // kept and saved with the score
  menuPick("File", "Save the score");
  check(downloads.at(-1).data.includes("\nfollows 1 keys 12\n") && equal(S.read(downloads.at(-1).data), page.score()) && S.read(store.get("lipservice editor: the score")).singers[1].follows.keys === 12, "saved and kept, the follower's line with it");
  page.take(new TextEncoder().encode(downloads.at(-1).data), "linked.score");
  check(!failed() && rows().length === 2 && equal(rows()[1].follows, { leader: 0, after: 0, keys: 12 }) && tabEls()[1].children.some((c) => c.textContent === "follows 1"), "and opened again, it follows");
  page.ed.select([notes()[0]]);
  keydown("ArrowUp");
  check(twin().notes[0].pitch === "F5", "kept in step as before");
  meta("z");
  meta("z");
  check(rows()[0].ed.part === mary && equal(rows()[1].follows, { leader: 0, after: 0, keys: 12 }), "Undo goes back to the score before it was opened");
  // unlinked: its notes its own, one step
  page.show(1);
  button("s-unlink");
  check(rows()[1].follows === undefined && said() === "Mary Had a Little Lamb, an octave above no longer follows Mary Had a Little Lamb: its notes are its own" && $("s-follows").hidden, "Unlink: it follows no one");
  page.ed.select([notes()[0]]);
  keydown("ArrowUp");
  check(!failed() && notes()[0].pitch === "F5", "and its notes can be moved");
  meta("z");
  meta("z");
  check(equal(rows()[1].follows, { leader: 0, after: 0, keys: 12 }), "two steps back, it follows again");
  // its leader taken out: it follows no one, and Undo brings both back
  tabEls()[0].children.at(-1).fire("click", {});
  check(rows().length === 1 && rows()[0].follows === undefined && said().endsWith("Mary Had a Little Lamb, an octave above follows no one now: its notes are its own") && whole(), "the leader taken out of the score: its follower follows no one");
  meta("z");
  check(rows().length === 2 && rows()[1].follows.leader === 0 && whole(), "and Undo brings the leader back, and the link");
  meta("z");
  check(rows().length === 1 && page.ed.part === mary, "the octave double undone");
  // a round: the tune twice, two more coming in two bars apart, following
  page.show(0);
  button("make-round");
  const mine = rows()[1]?.ed;
  check(rows().length === 3 && notes().length === 2 * mary.notes.length && equal(rows().slice(1).map((r) => r.follows), [{ leader: 0, after: 8 * g, keys: 0 }, { leader: 0, after: 16 * g, keys: 0 }]) && equal(rows().map((r) => r.ed.part.singer.voice), ["6147", "2428", "6147"]) && new Set(rows().map((r) => r.ed.part.singer.seed)).size === 3 && equal(rows().map((r) => r.pan), [-0.55, 0, 0.55]) && whole(), "Round: the tune sung twice, two more singers each two bars after the one before, of the voices after this one's in turn, following it");
  pane().pulls.singers.typed("2");
  check(rows().length === 2 && rows()[1].ed === mine, "fewer singers pulled: the first new one kept");
  keydown("Escape");
  check(rows().length === 1 && page.ed.part === mary, "and taken back");
  // a section, then its breaths staggered
  button("make-section");
  check(rows().length === 4 && rows().every((r) => r.level === -6.02 && r.ed.part.singer.voice === "6147") && new Set(rows().map((r) => r.ed.part.singer.seed)).size === 4 && rows().slice(1).every((r) => equal(r.follows, { leader: 0, after: 0, keys: 0 })) && equal(rows().map((r) => r.pan), [-0.167, 0.167, -0.5, 0.5]) && whole(), "Section: four of the voice on the same notes, each a seed of its own and quieter, following it");
  pane().pulls.singers.typed("3");
  keydown("Enter");
  const parts = rows().map((r) => r.ed.part);
  button("make-stagger");
  check(equal(rows().map((r) => r.ed.part.marks), Make.stagger(parts, 1).map((p) => p.marks)) && whole(), "Stagger the breaths: the section's marks, each breathing in turn");
  keydown("Enter");
  meta("z");
  check(equal(rows().map((r) => r.ed.part), parts), "one Undo takes the marks back");
  meta("z");
  check(rows().length === 1, "and one more the section");
  // echoes, a hocket, a drone
  meta("k");
  const find = document.body.children.at(-1).children[0];
  find.value = "echoes";
  find.fire("input");
  find.fire("keydown", { key: "Enter", preventDefault() {} });
  check(rows().length === 3 && equal(rows().slice(1).map((r) => [r.follows.after, r.level]), [[g / 2, -4], [g, -8]]) && whole(), "Add echoes from Find a command: two, each half a beat later and 4 dB quieter");
  keydown("Escape");
  button("make-hocket");
  check(rows().length === 2 && rows()[0].ed.part.notes.length + rows()[1].ed.part.notes.length === mary.notes.length && rows()[1].follows === undefined && whole(), "Hocket: the words handed out between this singer and a new one");
  keydown("Escape");
  button("make-drone");
  const drone = rows()[1].ed.part;
  check(rows().length === 2 && drone.notes.every((n) => n.pitch === "E3") && drone.notes[0].lyric === "ooh" && drone.notes.every((n) => n.lyric === "ooh" || n.lyric === "_") && panel().children[0].children[1].textContent === "in E minor", "Drone: E3 held under the line, the key's tonic, a note a bar");
  pane().pulls.on.value = "fifth";
  pane().pulls.on.fire("change");
  check(rows()[1].ed.part.notes.every((n) => n.pitch === "B3"), "on the fifth: B3, at or under the line's lowest");
  keydown("Escape");
  button("make-divisi");
  check(failed() && said() === "Split a chord into singers: no two of its notes sound together" && rows().length === 1, "Split a chord, where no notes sound together: said why");
  // scat under bare notes, and a word stuttered
  page.ed.set(notes().slice(0, 2), { lyric: null });
  button("make-scat");
  check(equal(notes().slice(0, 3).map((n) => n.lyric), ["doo", "doo", "had"]) && said().startsWith("Scat: 2 notes given syllables"), "Scat: the bare notes given doo");
  pane().pulls.syllables.value = "la dee";
  pane().pulls.syllables.fire("input");
  check(equal(notes().slice(0, 2).map((n) => n.lyric), ["la", "dee"]), "the syllables typed, in turn");
  keydown("Enter");
  meta("z");
  meta("z");
  check(page.ed.part === mary, "undone, step by step");
  page.ed.select([notes()[2]]);
  meta("k");
  const find2 = document.body.children.at(-1).children[0];
  find2.value = "stutter";
  find2.fire("input");
  find2.fire("keydown", { key: "Enter", preventDefault() {} });
  check(equal(notes().slice(2, 5).map((n) => [n.at, n.ticks, n.lyric]), [[6 * g, 160, "had"], [6 * g + 160, 160, "had"], [6 * g + 320, 160, "had"]]) && page.ed.selected.size === 3, "Stutter: had sung three times in its place");
  keydown("Escape");
  check(page.ed.part === mary, "and taken back");
  // a voice the site has not: no next one to take
  page.ed.singer("voice", "9999");
  keydown("h");
  check(failed() && said() === "Harmony: this singer's voice is not on this site's list, and a new singer takes the voice after it there: give this singer one of the site's voices first" && rows().length === 1, "a singer whose voice the site has not: Harmony says why");
  keydown("Escape");
  meta("z");
  // sixteen singers at most
  button("make-section");
  pane().pulls.singers.typed("9");
  keydown("Enter");
  button("make-section");
  pane().pulls.singers.typed("9");
  check(failed() && said() === "Section: a score holds 16 singers, and this makes 8 more: there is room for 7" && rows().length === 9, "a section past sixteen singers is refused, saying how many fit");
  pane().pulls.singers.typed("8");
  check(rows().length === 16 && !failed() && whole(), "seven more fit");
  keydown("Enter");
  keydown("h");
  check(said() === "Add a harmony: a score holds 16 singers, and there is room for 0 more" && rows().length === 16 && !panel(), "sixteen singers: H says there is no room");
  meta("z");
  meta("z");
  check(rows().length === 1, "back to one singer");
  // the ways to sing: a select in the singer's panel, its line said
  check($("s-way").children[0].textContent === "as set" && $("s-way").children[0].disabled && equal($("s-way").children.slice(1).map((o) => o.value), Ways.WAYS.map((w) => w.name)) && $("s-way").children.find((o) => o.value === "Sliding").title.endsWith("Not yet heard: join 0.5, glide 30"), "the ways to sing in the singer's panel, those not yet heard said so");
  const s0 = page.ed.past.length;
  $("s-way").value = "Sliding";
  $("s-way").fire("change");
  check(page.ed.part.singer.glide === 30 && page.ed.part.singer.join === 0.5 && page.ed.part.singer.voice === mary.singer.voice && page.ed.part.singer.seed === mary.singer.seed && page.ed.past.length === s0 + 1 && $("s-said").textContent === `Sliding: ${Ways.WAYS.find((w) => w.name === "Sliding").said}\nNot yet heard: join 0.5, glide 30` && $("s-way").value === "Sliding", "a way picked: its settings at once, one step, its line said and what has not been heard");
  type("s-glide", "20");
  check($("s-way").value === "", "a setting changed: the panel shows the settings as set");
  meta("z");
  meta("z");
  check(page.ed.part === mary && $("s-way").value === (Ways.which(mary.singer)?.name ?? ""), "undone");
  tabEls()[0].fire("contextmenu", { clientX: 30, clientY: 40 });
  {
    const m = document.body.children.at(-1), rowsOf = (x) => x.children.filter((c) => c.attrs.role === "menuitem");
    const ways = rowsOf(m).find((r) => r.children[0].textContent === "Way to sing");
    ways.fire("click");
    const sub = ways.children.find((c) => String(c.className).startsWith("cmd-menu"));
    rowsOf(sub).find((r) => r.children[0].textContent === "Clipped").fire("click");
  }
  check(page.ed.part.singer.glide === 3 && page.ed.part.singer.breath === 0.3 && said().startsWith("Clipped: "), "a way from the tab's menu");
  meta("z");
  button("s-another");
  check(page.ed.part.singer.seed === Ways.another(mary.singer.seed) && $("s-said").textContent.startsWith(`seed ${Ways.another(mary.singer.seed)}: another singer of this voice`), "Another singer: the next seed");
  meta("z");
  check(page.ed.part === mary, "all of it undone");
  check($("keys").all("cmd-keys").some((s) => s.children.some((k) => k.textContent === "H")), "the Keys help has H");
  // with the mixer in sight, a tab's menu offers the makers for that singer, as it does Copy
  page.showMixer();
  tabEls()[0].fire("contextmenu", { clientX: 30, clientY: 40 });
  {
    const m = document.body.children.at(-1), items = m.children.filter((c) => c.attrs.role === "menuitem");
    const row = (label) => items.find((r) => r.children[0].textContent === label);
    check(["Add a harmony", "Make a round or canon", "Double this singer", "Add echoes"].every((l) => row(l)?.attrs["aria-disabled"] === "false" && !row(l).attrs.title) && row("Copy this singer as a new one").attrs["aria-disabled"] === "false", "with the mixer in sight, a tab's menu offers the new singers made from it");
    row("Add a harmony").fire("click");
  }
  check(page.tool()?.name === "harmony" && page.desk.value.rows.length === 2 && !failed(), "Add a harmony from it: the singer shown and the panel open");
  keydown("Escape");
  check(page.desk.value.rows.length === 1 && page.ed.part === mary, "and Escape takes it back");
  // a chord split into singers: the top line stays, a new singer a line below it
  {
    const n = (at, pitch, lyric) => ({ at: at * g, ticks: g, pitch, cents: 0, velocity: 80, release: 64, lyric });
    const chords = { ...mary, title: "Chords", notes: P.sort([n(0, "G4", "la"), n(0, "E4", null), n(0, "C4", null), n(1, "A4", "lo"), n(1, "F4", null), n(1, "C4", null)]), marks: [] };
    page.take(new TextEncoder().encode(P.write(chords)), "chords.part");
    button("make-divisi");
    check(rows().length === 3 && equal(rows().map((r) => r.ed.part.notes.map((x) => [x.pitch, x.lyric])), [[["G4", "la"], ["A4", "lo"]], [["E4", "la"], ["F4", "lo"]], [["C4", "la"], ["C4", "lo"]]]) && equal(rows().map((r) => r.ed.part.singer.voice), ["6147", "2428", "6147"]) && whole(), "Split a chord: the top line stays with this singer, each line under it a new singer, the words on every line");
    keydown("Enter");
    meta("z");
    check(rows().length === 1 && notes().length === 6, "and one Undo puts the chords back");
  }
  await pickExample("round.score");
}

// ---- singing: each singer to a worker, their sound on the speaker's one line, the mix in its nodes
{
  const RATE = 24000, HEAD = 24000, g = 480;
  const lineOf = (tick) => HEAD + Math.round(tick / g * 0.6 * RATE); // at 100 beats a minute
  const node = () => nodes.find((n) => n.name === "speaker");
  const sings = () => workers.flatMap((w) => w.posted.filter((m) => m.type === "sing").map((m) => ({ ...m, w }))).sort((a, b) => a.id - b.id);
  const stops = () => workers.flatMap((w) => w.posted.filter((m) => m.type === "stop").flatMap((m) => m.ids));
  const from = (m, data) => m.w.onmessage({ data: { id: m.id, ...data } });
  const opened = (m, zero, first, last) => from(m, { type: "open", frames: 0, lead: 10, lag: 0, zero, first, last, early: 0, rests: [], breaths: [], text: "" });
  const sound = (m, n, v) => from(m, { type: "chunk", samples: new Float32Array(n).fill(v) });
  const made = (m) => from(m, { type: "done", secs: 1, ms: 5 });
  const told = (type) => node().told.filter((m) => m.type === type);
  const near = (a, b, by = 1e-6) => Math.abs(a - b) <= by;

  page.show(0);
  keydown(" ");
  await settle();
  await settle();
  const first = sings();
  check(first.length === 3 && workers.length === 2 && equal(first.map((m) => workers.indexOf(m.w)), [0, 1, 0]) && first.every((m, i) => m.part === page.desk.value.rows[i].ed.part && m.from === undefined && m.step === 20 && m.together === true) && said() === "3 singers are getting ready", "space: every singer asked for all of its part, the singers shared between the workers");
  const mix = page.mix();
  check(speakers.length === 1 && speakers[0].options.sampleRate === RATE && speakers[0].modules[0].endsWith("/speaker.js") && node().options.numberOfOutputs === 17, "the speaker is the page's own, an output a singer and one for the click");
  check(equal(mix.fx.map((f) => f.kind), ["reverb", "limiter"]) && near(mix.master.gain.value, 10 ** (SCORES.round().master / 20)) && equal(mix.strips.slice(0, 4).map((s) => Number(s.level.gain.value.toFixed(4))), [1, Number((10 ** (-1.5 / 20)).toFixed(4)), 1, 0]) && equal(mix.strips.slice(0, 3).map((s) => s.pan.pan.value), [-0.55, 0, 0.55]), "the mix is in its nodes: each singer's level and pan, the chain in its order, the master's level");
  check(mix.bus.to[0][0] === mix.fx[0].in && mix.fx[0].out.to.some(([to]) => to === mix.fx[1].in) && mix.fx[1].out.to[0][0] === mix.master && mix.master.to[0][0] === speakers[0].destination && mix.click.to[0][0] === speakers[0].destination, "the singers' sum through the chain to the master; the click past it all");
  // each singer says where its sound falls: its own lead-in before beat 0
  const zeros = [2400, 2640, 2880], long = 96000;
  opened(first[0], zeros[0], 0, long);
  opened(first[1], zeros[1], 0, long);
  await settle();
  check(told("play").length === 0, "nothing plays until every singer has said where its sound falls");
  opened(first[2], zeros[2], 0, long);
  first.forEach((m, i) => { sound(m, long, 0.1 * (i + 1)); made(m); });
  await settle();
  const play = told("play")[0], takes = told("take");
  check(equal(takes.map((t) => [t.slot, t.from, t.length, t.now]), zeros.map((z, i) => [i, HEAD - z, long, true])) && play.pos === HEAD - 2880 && play.loop === null && play.end === HEAD - 2400 + long && equal(play.wait, [0, 1, 2]), "each singer's sound laid on the line so that its beat 0 is the line's; played from the first of them");
  check(told("beats")[0].list[0].at === lineOf(0) && told("beats")[0].list[0].accent && told("beats")[0].list[1].at === lineOf(1.5 * g), "the clicks where the beats fall on the line, in 6/8 every three eighths");
  check(/^3 singers singing: 4\.0 s; the line waits 13 ms for the speaker \(the browser says 10 ms, the chain holds 3 ms\)/.test(said()), "what is sung said, and what the line waits for: the browser's lateness and the chain's");
  const out = render(0.5);
  const at = (k, i) => out[k][i];
  check(out[0].slice(0, 480 - 5).every((v) => v === 0) && near(at(0, 480 + 200), 0.1) && near(at(1, 240 + 200), 0.2) && near(at(2, 200), 0.3) && at(1, 230) === 0, "the three sound together, each from its own start, sample for sample");
  draw();
  const p = node().processor.pos, want = ((p - 0.013 * RATE - HEAD) / RATE) / 0.6 * g;
  check(Math.abs(page.heardAt() - want) < 80, `the line is where the sound is, less what it waits (beat ${(page.heardAt() / g).toFixed(2)})`);

  // the mix heard at once
  page.board.fields.master.level.typed("-6");
  page.board.fields.strips[1].m.click();
  check(near(mix.master.gain.value, 10 ** (-6 / 20)) && mix.strips[1].level.gain.value === 0 && page.desk.value.rows[1].mute && tabEls()[1].children.some((c) => c.textContent === "M"), "the master's level typed and a singer muted are in the nodes at once; the tab shows the mute");
  page.board.fields.strips[1].m.click();
  page.board.fields.strips[2].s.click();
  check(equal(mix.strips.slice(0, 3).map((s) => Number(s.level.gain.value.toFixed(3))), [0, 0, 1]), "a singer soloed silences the others");
  page.board.fields.strips[2].s.click();
  const add = $("mixer").children[3].children.at(-1);
  add.value = "echo";
  add.fire("change");
  check(equal(page.desk.value.chain.map((e) => e.kind), ["reverb", "limiter", "echo"]) && equal(mix.fx.map((f) => f.kind), ["reverb", "limiter", "echo"]) && mix.fx[2].out.to[0][0] === mix.master, "an effect added is at the chain's end, and in the sound");
  page.board.fields.fx[2].card.children[0].children[1].click();
  check(equal(mix.fx.map((f) => f.kind), ["reverb", "echo", "limiter"]), "moved sooner, it is sooner in the sound");
  page.board.fields.fx[1].on.click();
  check(equal(mix.fx.map((f) => f.kind), ["reverb", "limiter"]) && page.desk.value.chain[1].on === false, "switched off, the sound goes past it");
  page.board.fields.fx[1].pulls.find(([k]) => k === "mix")[1].typed("0.5");
  page.board.fields.fx[1].card.children[0].children[3].click();
  check(equal(page.desk.value.chain.map((e) => e.kind), ["reverb", "limiter"]), "and its x takes it out of the chain");
  for (let i = 0; i < 10; i++) $("undo").click();
  check(equal(page.score(), SCORES.round()) && near(mix.master.gain.value, 10 ** (SCORES.round().master / 20)), "all of it undone, step by step");
  check(sings().length === 3 && page.playing() !== null, "none of which the singers were asked to sing again for");
  {
    const bars = () => tabEls().at(-1).children[0].children.map((slot) => slot.children[0].style.height);
    page.show(0);
    draw();
    check($("mixer").hidden && bars().length === 2 && bars().every((h) => h.endsWith("%") && near(parseFloat(h), 100 * (1 + 20 * Math.log10(0.5) / 48))), "the mixer's tab shows the master's level while it sounds, a singer's notes in sight");
  }

  // a singer's part changed while it sounds: that singer alone sung anew, from a little ahead, and faded in
  type("s-shift", "3");
  await sleep(220);
  const again = sings();
  const ahead = again[3] && again[3].from;
  check(again.length === 4 && workers.indexOf(again[3].w) === 0 && again[3].part === page.ed.part && again[3].early === 0 && again[3].to === undefined && ahead > page.heardAt() && ahead < page.heardAt() + 2 * g && said() === "Finn: sung anew from here", "a setting changed: its singer is asked again, from just ahead of the sound");
  const start = zeros[0] + Math.round(ahead / g * 0.6 * RATE);
  opened(again[3], zeros[0], start, long);
  await settle();
  check(equal([told("take").at(-1).from, told("take").at(-1).now], [lineOf(ahead), false]) && node().processor.slots[0].cur.id === first[0].id, "its new sound is laid on the line where it belongs, the old still sounding");
  sound(again[3], long - start, 0.9);
  made(again[3]);
  await settle();
  const swap = render(0.6);
  check(said() === "Finn: the change is in" && near(swap[0].at(-1), 0.9) && near(swap[0][0], 0.1) && near(swap[1].at(-1), 0.2) && node().processor.stalls === 0, "the speaker fades it in when the line reaches it; the others never stop");
  // a change that cannot be sung leaves what was sung
  page.ed.set([page.ed.part.notes[0]], { lyric: null });
  page.show(0);
  await sleep(220);
  check(sings().length === 4 && said().startsWith("Finn: ") && said().endsWith("it goes on as it last could be sung") && !failed() && page.playing() !== null, "a note left with no word is said, and the singer goes on as it last could be sung");
  $("undo").click();
  await sleep(220);
  check(sings().length === 5, "mended, it is sung anew");
  // a tool's panel while it sounds: what it does is heard at once, and so is putting it back
  page.ed.select(page.ed.part.notes.slice(0, 2));
  keydown("t");
  await sleep(220);
  check(sings().length === 6 && sings().at(-1).part === page.ed.part && page.tool() !== null, "a tool run while the score sounds: its singer sung anew with it, the panel still open");
  page.tool().pulls.semitones.typed("7");
  await sleep(220);
  check(sings().length === 7 && sings().at(-1).part === page.ed.part, "and again as its value is pulled");
  keydown("Escape");
  await sleep(220);
  check(sings().length === 8 && page.tool() === null && sings().at(-1).part === page.ed.part, "and put back, sung as it was");
  // a new singer made while it sounds: it joins, and as its panel is pulled it alone is sung anew
  page.show(2);
  const sung0 = sings().length;
  keydown("h");
  await sleep(220);
  const joined = sings().slice(sung0);
  check(page.desk.value.rows.length === 4 && joined.length === 1 && joined[0].part === page.desk.value.rows[3].ed.part && said() === "Ben, 2 semitones below: joining", "a harmony made while the score sounds: the new singer joins, the others sung on as they were");
  page.tool().pulls.interval.typed("-3");
  await sleep(220);
  const pulled = sings().slice(sung0 + 1);
  check(pulled.length === 1 && pulled[0].part === page.desk.value.rows[3].ed.part && said() === "Ben, 3 semitones below: sung anew from here", "its interval pulled: it alone is sung anew");
  keydown("Escape");
  await sleep(220);
  check(page.desk.value.rows.length === 3 && sings().length === sung0 + 5 && page.playing() !== null, "taken back: the three sung on without it");
  page.show(0);
  const sung1 = sings().length;

  // a click on the ruler while they sing
  const before = told("seek").length, jobs = sung1;
  page.place(2 * g);
  await sleep(20);
  check(told("seek").length === before && sings().length === jobs + 3 && sings().at(-1).from === 2 * g && sings().at(-1).early === 2400, "a place whose sound is not all made is sung from there by all");
  keydown(" ");
  await settle();
  check(page.playing() === null && told("stop").length >= 1 && stops().length >= 3 && said() === "stopped", "space stops it: the speaker and the singers still at work are told");

  // round a loop
  page.set.loop.from = 6 * g;
  page.set.loop.to = 12 * g;
  keydown("o");
  keydown(" ");
  await settle();
  const round = sings().slice(-3);
  check(round.every((m) => m.from === 6 * g && m.to === 12 * g && m.early === 2400), "round a loop: every singer asked for the loop's stretch, a tenth of a second early");
  const span = lineOf(12 * g) - lineOf(6 * g);
  round.forEach((m, i) => { const a = zeros[i] + lineOf(6 * g) - HEAD - 2400; opened(m, zeros[i], a, a + span); sound(m, span, 0.1 * (i + 1)); made(m); });
  await settle();
  const lp = told("play").at(-1);
  check(equal(lp.loop, { from: lineOf(6 * g) - 2400, to: lineOf(12 * g) - 2400 }) && lp.pos === lp.loop.from && lp.end === Infinity && /^3 singers singing round the loop: 3\.6 s/.test(said()), "the speaker goes round the same stretch of the line");
  render(4);
  draw();
  check(node().processor.rounds === 1 && page.heardAt() >= 6 * g && page.heardAt() < 12 * g, "and the line goes round with it");
  const seeks = told("seek").length;
  page.place(9 * g);
  await settle();
  check(told("seek").length === seeks + 1 && told("seek").at(-1).pos === lineOf(9 * g) - 2400 && said() === "at beat 9" && sings().length === jobs + 6, "a click inside it, all of it made: the speaker jumps, no singer asked");
  keydown("o");
  await settle();
  check(sings().length === jobs + 9 && sings().at(-1).to === undefined && sings().at(-1).from > 8 * g && said() !== "stopped", "the loop switched off while it sounds: sung on from where the sound is");
  keydown(" ");

  // a singer that cannot be sung
  page.show(1);
  page.ed.set([page.ed.part.notes[3]], { lyric: null });
  page.show(0);
  const asked = sings().length;
  keydown(" ");
  await settle();
  check(failed() && said().startsWith("Cora is not sung yet:\n") && page.ed === page.desk.value.rows[1].ed && page.ed.selected.size === 1 && sings().length === asked && page.playing() === null, "a singer with a note it cannot sing stops Sing: said by name, its tab and the note in sight");
  page.board.fields.strips[1].m.click();
  keydown(" ");
  await settle();
  check(!failed() && sings().length === asked + 2 && equal(sings().slice(-2).map((m) => m.part.title), ["Finn", "Ben"]), "muted, it is left out and the others sing");
  const [finn, ben] = sings().slice(-2);
  opened(finn, 2400, 0, long);
  from(ben, { type: "error", message: "beat 6: the engine has no such word", at: 6 * g });
  await settle();
  check(failed() && said() === "Ben: beat 6: the engine has no such word" && page.playing() === null && page.ed === page.desk.value.rows[2].ed, "a singer that fails to start stops them all, said by name");
  $("undo").click();
  $("undo").click();

  // one singer keeps its own consonants; a second with notes, and both keep the one clock
  await pickExample("mary.part");
  keydown(" ");
  await settle();
  await settle();
  const solo = sings().at(-1);
  check(page.desk.value.rows.length === 1 && solo.together === false && solo.part === page.ed.part, "a singer alone is not asked to keep the others' clock");
  opened(solo, 2400, 0, long);
  sound(solo, long, 0.5);
  made(solo);
  await settle();
  render(0.3);
  const was = sings().length;
  $("tabs").children.find((c) => c.textContent === "+").fire("click", {});
  await sleep(220);
  check(sings().length === was && page.desk.value.rows.length === 2, "a singer added with no notes yet changes nothing of the first's");
  const note = page.ed.add(0, g, 60, 80);
  page.ed.set([note], { lyric: "la" });
  page.show(1);
  await sleep(220);
  const both = sings().slice(was);
  check(both.length === 2 && both.every((m) => m.together === true) && equal(both.map((m) => m.part), page.desk.value.rows.map((r) => r.ed.part)) && both.every((m) => m.from > 0), "its first note sung: both are asked anew from here, on the one clock");
  page.ed.select([page.ed.part.notes[0]]);
  page.ed.remove();
  page.show(1);
  await sleep(220);
  const back = sings().slice(was + 2);
  check(back.length === 1 && back[0].together === false && back[0].part === page.desk.value.rows[0].ed.part, "its notes gone: the first is asked anew, on its own clock again");
  keydown(" ");
  await settle();
}

// a score opened while the roll has no width (the mixer in sight) is fitted once it has one
{
  const resize = (w) => { $("canvas").clientWidth = w; for (const f of sized) f(); };
  await pickExample("round.score");
  const fitted = page.view.wide;
  page.view.zoom(3, 0);
  page.showMixer();
  resize(0);
  await pickExample("round.score");
  check(!failed() && page.view.wide === fitted * 3, "opened with no roll to fit to, the roll's view is left alone");
  resize(1200);
  check(page.view.wide === fitted && page.view.left === 0, "and fitted when the roll is back");
  page.view.zoom(2, 0);
  resize(900);
  check(page.view.wide === fitted * 2, "a fit is done once: a later resize keeps the view");
  resize(1200);
  // a desk's fit: every singer's every key in the roll, at any height; fitted again as the roll's
  // height changes while it is as the fit left it
  const inRoll = () => {
    const v = page.view, roll = $("canvas").clientHeight - 30 - 30 - 64 - 92; // RULER, WORDS, the lanes
    return page.desk.value.rows.every((r) => r.ed.part.notes.every((n) => v.y(P.key(n.pitch)) >= 0 && v.y(P.key(n.pitch)) + v.tall <= roll));
  };
  await pickExample("round.score");
  keydown("f");
  check(inRoll(), "Fit: every singer's every note in the roll");
  $("canvas").clientHeight = 420;
  for (const f of sized) f();
  check(inRoll(), "the roll made shorter while as fitted: fitted again, every note still in it");
  page.view.zoom(2, 0);
  const moved = page.view.tall;
  $("canvas").clientHeight = 700;
  for (const f of sized) f();
  check(page.view.wide !== fitted && page.view.tall === moved, "a roll moved since its fit is left as it is");
  await pickExample("round.score");
  // the ruler's bar numbers never run into each other, however far out
  const clear = (wide) => {
    page.view.zoom(wide / page.view.wide, 0);
    calls.bars.length = 0;
    page.paint();
    return calls.bars.length > 1 && calls.bars.every(([text, x], i) => i === 0 || x >= calls.bars[i - 1][1] + 6 * calls.bars[i - 1][0].length + 6);
  };
  check(clear(0.002) && clear(0.01) && clear(0.05) && clear(0.4), "the bars' numbers are apart at every width");
  check(clear(0.4) && equal(calls.bars.map((b) => b[0]).slice(0, 2), ["1", "2"]), "and every bar has its number where there is room");
}

// ---- the score's time: a tempo or a meter changed at a right click on the ruler, a change taken
// away there, bars put in, taken out and sung again; every singer alike, a follower made again
// from its leader, each in the tools' panel, live and one step of Undo
{
  await pickExample("mary.part");
  const g = 480, rows = () => page.desk.value.rows, notes = () => page.ed.part.notes, meta = (key, more = {}) => keydown(key, { metaKey: true, ...more });
  const panel = () => $("roll").children.find((c) => c.className === "tool") ?? null, pane = () => page.tool();
  const rowsOf = (m) => m.children.filter((c) => c.attrs.role?.startsWith("menuitem")), menu = () => document.body.children.at(-1);
  const whole = () => { try { S.check(page.score()); return true; } catch { return false; } };
  const ruler = (beat, dx = 1) => { view.left = 0; page.paint(); $("canvas").fire("contextmenu", { clientX: X(beat) + dx, clientY: 15, button: 2 }); return rowsOf(menu()); };
  const pick = (items, label) => items.find((r) => r.children[0].textContent === label);
  const brief = (p) => p.notes.map((n) => `${P.beat(n.at, g)} ${n.pitch} ${n.lyric}`);
  view.zoom(3, 0);
  // an octave double that follows Mary, to be made again from her as her time changes
  $("make-octave").click();
  keydown("Enter");
  page.show(0);
  const mary = page.ed.part, double = () => rows()[1].ed.part, past = () => page.desk.value.rows.map((r) => r.ed.past.length);
  check(rows().length === 2 && equal(rows()[1].follows, { leader: 0, after: 0, keys: 12 }), "Mary and an octave double following her");
  // the ruler's menu
  const items = ruler(8);
  const TIME = ["Tempo change here", "Meter change from this bar", "Take away this tempo change", "Take away this meter change", "Insert bars before this one", "Delete bars from this one", "Repeat bars from this one"];
  check(TIME.every((l) => pick(items, l)) && pick(items, "Take away this tempo change").attrs["aria-disabled"] === "true" && pick(items, "Take away this tempo change").attrs.title === "no tempo change at beat 8", "a right click on the ruler: the time's commands, Take away greyed where there is no change");
  // a tempo change at beat 8, pulled, every singer's, one step
  const u0 = past();
  pick(items, "Tempo change here").fire("click");
  check(panel() && pane().spec.label === "Tempo change here" && pane().values.bpm === 96 && equal(mary.tempo, page.ed.part.tempo) && said().startsWith("Tempo change here: 96 beats a minute is the tempo before beat 8: no change there"), "Tempo change here: its panel with the tempo in force there, and no change made yet");
  pane().pulls.bpm.typed("132");
  const t132 = [{ at: 0, bpm: 96 }, { at: 8 * g, bpm: 132 }];
  check(equal(page.ed.part.tempo, t132) && equal(double().tempo, t132) && whole() && said().startsWith("Tempo change here: 132 beats a minute from beat 8\n"), "pulled to 132: from beat 8 for every singer, the double too");
  pane().pulls.bpm.typed("140");
  check(equal(double().tempo, [{ at: 0, bpm: 96 }, { at: 8 * g, bpm: 140 }]) && equal(past(), u0.map((n) => n + 1)), "pulled again: still one step for each singer");
  keydown("Enter");
  check(!panel() && said() === "Tempo change here: kept", "kept");
  page.paint();
  check(calls.text > 0 && ruler(8, 12).length && pick(rowsOf(menu()), "Take away this tempo change").attrs["aria-disabled"] === "false", "drawn on the ruler, and a right click on it finds it");
  pick(rowsOf(menu()), "Take away this tempo change").fire("click");
  check(equal(page.ed.part.tempo, [{ at: 0, bpm: 96 }]) && equal(double().tempo, [{ at: 0, bpm: 96 }]) && said() === "the tempo change at beat 8 is taken away: 96 beats a minute goes on there", "Take away: gone for every singer, and what goes on there said");
  meta("z");
  check(equal(page.ed.part.tempo, [{ at: 0, bpm: 96 }, { at: 8 * g, bpm: 140 }]) && equal(double().tempo, page.ed.part.tempo), "Undo brings it back for both");
  meta("z");
  check(equal(page.ed.part.tempo, [{ at: 0, bpm: 96 }]) && equal(double().tempo, [{ at: 0, bpm: 96 }]), "and Undo again takes the change away from both, one step");
  check(ruler(0) && pick(rowsOf(menu()), "Take away this tempo change").attrs.title === "the tempo at beat 0 is where the score starts: change it; it cannot be taken away", "the first tempo cannot be taken away, said why");
  menu().fire("keydown", { key: "Escape", preventDefault() {} });
  // a meter change from the bar a right click is in, put back with Escape
  pick(ruler(9.5), "Meter change from this bar").fire("click");
  pane().pulls.n.typed("3");
  check(equal(page.ed.part.meter, [{ at: 0, n: 4, d: 4 }, { at: 8 * g, n: 3, d: 4 }]) && equal(double().meter, page.ed.part.meter) && said().startsWith("Meter change: 3/4 from bar 3 (beat 8)"), "Meter change from a right click at beat 9.5: 3/4 from its bar's line, beat 8, every singer's");
  pane().pulls.d.value = "8";
  pane().pulls.d.fire("change");
  check(equal(double().meter.at(-1), { at: 8 * g, n: 3, d: 8 }), "its note chosen: 3/8");
  keydown("Escape");
  check(!panel() && equal(page.ed.part.meter, [{ at: 0, n: 4, d: 4 }]) && equal(double().meter, page.ed.part.meter) && $("redo").disabled, "Escape puts the meter back for both, and leaves no step");
  // bars put in before bar 3: the notes from beat 8 on a bar later, the double made again from Mary
  const before = brief(mary);
  pick(ruler(9), "Insert bars before this one").fire("click");
  check(brief(page.ed.part).slice(0, 4).join() === before.slice(0, 4).join() && page.ed.part.notes[4].at === 12 * g && page.ed.part.notes.at(-1).at === mary.notes.at(-1).at + 4 * g && S.unlike(page.ed.part, double(), rows()[1].follows) === null && whole() && said().startsWith("Insert bars: 1 bar of 4/4 put in at bar 3 (beat 8): what came after is 4 beats later"), "Insert bars at beat 9: a bar put in before bar 3, the notes after it a bar later; the double still Mary's octave");
  pane().pulls.bars.typed("2");
  check(page.ed.part.notes[4].at === 16 * g && equal(page.ed.part.lanes.vibrato.at(-1).at, mary.lanes.vibrato.at(-1).at + 8 * g) && double().notes[4].at === 16 * g, "pulled to 2: two bars, the vibrato moved with them");
  keydown("Enter");
  meta("z");
  check(equal(page.ed.part, mary) && S.unlike(mary, double(), rows()[1].follows) === null, "one Undo puts both as they were");
  // bars taken out
  pick(ruler(4), "Delete bars from this one").fire("click");
  check(page.ed.part.notes.length === mary.notes.length - 4 && brief(page.ed.part)[0] === `4 ${mary.notes[4].pitch} ${mary.notes[4].lyric}` && double().notes.length === page.ed.part.notes.length && said().startsWith("Delete bars: bar 2 (beats 4 to 8) taken out: 4 notes with them"), "Delete bars from bar 2: its four notes gone, the rest a bar sooner, for both");
  keydown("Escape");
  check(equal(page.ed.part, mary), "Escape: as it was");
  // bars sung again
  pick(ruler(4.5), "Repeat bars from this one").fire("click");
  pane().pulls.times.typed("2");
  const bar2 = mary.notes.filter((n) => n.at >= 4 * g && n.at < 8 * g);
  check(page.ed.part.notes.length === mary.notes.length + 8 && equal(page.ed.part.notes.slice(4, 8).map((n) => [n.at - 4 * g, n.pitch, n.lyric]), bar2.map((n) => [n.at, n.pitch, n.lyric])) && equal(page.ed.part.notes.slice(8, 12).map((n) => n.lyric), bar2.map((n) => n.lyric)) && double().notes.length === page.ed.part.notes.length && whole() && said().startsWith("Repeat bars: bar 2 (beats 4 to 8) sung 2 more times: 8 notes laid again"), "Repeat bar 2 twice more: its notes and words laid again after it, the double with them");
  keydown("Enter");
  meta("z");
  // a note that sounds past the bars sung again: refused by the singer and its beat, nothing changed
  page.ed.select([notes()[6]]);
  keydown("ArrowRight", { altKey: true });
  keydown("ArrowRight", { altKey: true });
  keydown("ArrowRight", { altKey: true });
  keydown("ArrowRight", { altKey: true });
  const longer = page.ed.part;
  pick(ruler(8), "Repeat bars from this one").fire("click");
  check(failed() && said().startsWith(`Repeat bars: Mary Had a Little Lamb: the note ${P.pitch(mary.notes[6])} at beat 10 sounds on past beat 12, where the bars sung again end`) && page.ed.part === longer && panel(), "Repeat bar 3, which a note sounds out of: refused by the singer and the note's beat, the notes as they were, the panel open");
  keydown("Escape");
  check(!panel(), "Escape closes it");
  for (let i = 0; i < 4; i++) meta("z");
  check(equal(page.ed.part, mary), "the note as it was");
  // a time change from Find a command, where Sing starts
  page.place(16 * g);
  meta("k");
  const find = document.body.children.at(-1).children[0];
  find.value = "tempo change";
  find.fire("input");
  find.fire("keydown", { key: "Enter", preventDefault() {} });
  pane().pulls.bpm.typed("80");
  keydown("Enter");
  check(equal(page.ed.part.tempo, [{ at: 0, bpm: 96 }, { at: 16 * g, bpm: 80 }]), "Find a command, Tempo change here: where Sing starts");
  meta("z");
  page.place(0);
  meta("z");
  page.show(0);
  check(rows().length === 1 && !failed(), "the double taken back");
  // a round's entry comes in later: a breath marked on its note stays on that note as bars go in
  $("make-round").click();
  keydown("Enter");
  page.show(1);
  const lag = rows()[1].follows.after;
  check(lag > 0, "a round made: its entry follows Mary, later");
  page.ed.select(notes().filter((n) => n.at === 5 * g + lag));
  keydown("b");
  const marked = 5 * g + lag;
  page.show(0);
  pick(ruler(9), "Insert bars before this one").fire("click");
  keydown("Enter");
  const entry = rows()[1].ed.part;
  check(entry.marks.some((m) => m.at === marked && m.breath) && entry.notes.some((n) => n.at === marked) && whole(), "bars put in before beat 8: the entry's note from Mary's beat 5 does not move, nor does its breath mark");
  meta("z");
  meta("z");
  meta("z");
  check(rows().length === 1 && equal(page.ed.part, mary), "undone, step by step");
}

// ---- notes played in (midiin.js): MIDI in asked for, step input from it and from the computer's
// keys (Keys play notes), and a take recorded while the score sings, each one step of Undo
{
  await pickExample("mary.part");
  const g = 480, rows = () => page.desk.value.rows, notes = () => page.ed.part.notes, meta = (key, more = {}) => keydown(key, { metaKey: true, ...more });
  const undos = () => page.ed.past.length, brief = (list) => list.map((n) => `${P.beat(n.at, g)}+${P.beat(n.ticks, g)} ${P.pitch(n)}${n.lyric === null ? "" : ` ${n.lyric}`}`);
  const kbds = new Set($("keys").all("cmd-keys").flatMap((s) => s.children.map((k) => k.textContent)));
  const lines = $("keys").all("cmd-help-row").map((r) => r.children[1].textContent);
  check(["shift N", "shift K", "A", "W", "K", "Z", "X", "Backspace", "pedal"].every((k) => kbds.has(k)) && lines.some((l) => l.startsWith("with Keys play notes on: a keyboard, C up to the next C. These letters do not do their commands")), "the Keys help says which keys Keys play notes takes, and the keys of step input");
  check(/<section class="fold desk" id="play-part">/.test(html) && /html\.phone \.desk[^{]*\{[^}]*display: none/.test(sheet), "none of it on a phone");
  // no Web MIDI, then refused, then granted with two inputs
  $("midi-open").click();
  await settle();
  check(failed() && said().startsWith("this browser has no Web MIDI here (Safari has none") && page.midi() === null && $("midi-input").hidden, "MIDI in where the browser has none: said, and nothing stands in");
  window.navigator.requestMIDIAccess = async () => { throw Object.assign(new Error("the person said no"), { name: "NotAllowedError" }); };
  $("midi-open").click();
  await settle();
  check(failed() && said() === "MIDI in was refused: the browser's permission for MIDI on this site is off (NotAllowedError: the person said no)" && page.midi() === null, "refused: said so");
  const port = (id, name) => ({ id, name, manufacturer: "", type: "input", state: "connected", onmidimessage: null, open: async () => {}, close: async () => {} });
  const access = { inputs: new Map([["k1", port("k1", "Keystation")], ["k2", port("k2", "Pads")]]), onstatechange: null }, asked = [];
  window.navigator.requestMIDIAccess = async (o) => { asked.push(o); return access; };
  $("midi-open").click();
  await settle();
  await settle();
  check(!failed() && equal(asked, [{ sysex: false, software: false }]) && page.midi().chosen === "k1" && !$("midi-input").hidden && equal($("midi-input").children.map((o) => [o.value, o.textContent]), [["", "no input"], ["k1", "Keystation"], ["k2", "Pads"]]) && $("midi-input").value === "k1" && said().startsWith("MIDI in: Keystation (2 inputs: another is chosen in the panel). Turn on Step"), "granted: no system exclusive asked for, the first input played from, the others in the panel");
  const play = (bytes, input = "k1") => access.inputs.get(input).onmidimessage({ data: bytes, timeStamp: window.performance.now() });
  play([0x90, 60, 100]);
  play([0x80, 60, 40]);
  check(said() === "C4: nothing takes notes now. Turn on Step to write them where Sing starts, or Record and Sing to record them" && notes().length === 26, "a key played with nothing to take it: said what would");
  // the input unplugged and plugged back in; another chosen in the panel
  const k1 = access.inputs.get("k1");
  k1.state = "disconnected";
  access.onstatechange({ port: k1 });
  check(failed() && said() === "MIDI in: Keystation was unplugged" && page.midi().chosen === null && $("midi-input").children[1].textContent === "Keystation (unplugged)" && $("midi-input").children[1].disabled, "the input unplugged: said, and shown so in the panel");
  k1.state = "connected";
  access.onstatechange({ port: k1 });
  await settle();
  check(said() === "MIDI in: Keystation is back" && page.midi().chosen === "k1" && typeof k1.onmidimessage === "function", "plugged back in: played from again");
  $("midi-input").value = "k2";
  $("midi-input").fire("change");
  await settle();
  check(page.midi().chosen === "k2" && k1.onmidimessage === null && said().startsWith("MIDI in: Pads"), "another input chosen in the panel");
  $("midi-input").value = "k1";
  $("midi-input").fire("change");
  await settle();
  // step input from the MIDI keyboard, at the place set, a beat a step
  $("snap").value = "480";
  $("snap").fire("change");
  page.place(40 * g);
  keydown("N", { shiftKey: true });
  check(page.stepping() && $("step").attrs["aria-pressed"] === "true" && said().startsWith("step input at beat 40: each note played goes in there, a beat long"), "shift N: step input at the place Sing starts");
  const u0 = undos();
  play([0x90, 60, 100]);
  check(brief(notes().slice(-1))[0] === "40+1 C4" && notes().at(-1).velocity === 100 && said() === "C4 at beat 40, a beat", "a key down writes its note at once");
  play([0x80, 60, 30]);
  check(page.cursor() === 41 * g && notes().at(-1).release === 30 && undos() === u0 + 1 && said() === "C4 at beat 40, a beat; on to beat 41", "let go, the place moves on a step: one step of Undo");
  play([0x90, 64, 90]);
  play([0x90, 67, 90]);
  play([0x80, 64, 64]);
  play([0x80, 67, 64]);
  check(equal(brief(notes().slice(-2)), ["41+1 E4", "41+1 G4"]) && undos() === u0 + 2 && page.cursor() === 42 * g, "a chord: its keys in one step");
  play([0xb0, 64, 127]);
  play([0x90, 62, 80]);
  play([0x80, 62, 64]);
  play([0x90, 65, 80]);
  play([0x80, 65, 64]);
  check(page.cursor() === 42 * g && equal(brief(notes().slice(-2)), ["42+1 D4", "42+1 F4"]), "with the pedal down, keys played one by one are one chord");
  play([0xb0, 64, 0]);
  check(page.cursor() === 43 * g && undos() === u0 + 3, "the pedal up: on a step");
  play([0xfe]);
  check(undos() === u0 + 3 && page.cursor() === 43 * g, "what is not a note, a pedal or the wheel is left");
  meta("z");
  check(notes().length === 26 + 3 && page.cursor() === 43 * g, "Undo takes the last step back");
  // the snap changed: the steps after are that long
  $("snap").value = "240";
  $("snap").fire("change");
  play([0x90, 69, 80]);
  play([0x80, 69, 64]);
  check(brief(notes().slice(-1))[0] === "43+0.5 A4", "a step as long as the snap's from then");
  // the Words typed are the steps' syllables
  $("words").value = "la la";
  $("words").fire("input");
  keydown("N", { shiftKey: true });
  keydown("N", { shiftKey: true });
  play([0x90, 60, 80]);
  play([0x80, 60, 64]);
  check(notes().at(-1).lyric === "la" && $("play-said").textContent.includes('the next syllable "la"'), "words typed in the Words box: each step takes the next syllable");
  keydown("N", { shiftKey: true });
  $("words").value = "";
  $("words").fire("input");
  // the computer's keys: shift K, the letters a keyboard by where they are
  const down = (key, code, more = {}) => keydown(key, { code, timeStamp: window.performance.now(), ...more });
  const up = (key, code) => document.on.keyup.at(-1)({ key, code, target: $("canvas"), timeStamp: window.performance.now(), preventDefault() {} });
  page.place(48 * g);
  keydown("K", { shiftKey: true, code: "KeyK" });
  check(page.keyboard() && page.stepping() && $("keys-play").attrs["aria-pressed"] === "true" && said().startsWith("Keys play notes: A W S E D F T G Y H U J K are C4 to C5;") && said().endsWith("Step input is on: each note goes in where Sing starts."), "shift K: Keys play notes, and step input with it");
  const n0 = notes().length;
  down("a", "KeyA");
  up("a", "KeyA");
  down("j", "KeyJ");
  up("j", "KeyJ");
  check(equal(brief(notes().slice(n0)), ["48+0.5 C4", "48.5+0.5 B4"]) && !page.tool(), "A and J play C4 and B4, not their commands (arpeggiate, join)");
  down("z", "KeyZ");
  check(said().startsWith("the keys: A W S E D F T G Y H U J K are C3 to C4"), "Z: an octave down");
  down("x", "KeyX");
  down("ArrowRight", "ArrowRight");
  check(page.cursor() === 49.5 * g && said() === "a rest at beat 49; on to beat 49.5", "the right arrow: a rest");
  down("Backspace", "Backspace");
  down("Backspace", "Backspace");
  check(notes().length === n0 + 1 && page.cursor() === 48.5 * g && said() === "the step at beat 48.5 taken back", "Backspace twice: the rest, then the note, taken back");
  down("]", "BracketRight");
  check(said() === "step input: a step is a beat now", "] : a step twice as long");
  // a key held and the window left: the step closed
  down("d", "KeyD");
  check(page.cursor() === 48.5 * g, "a key held: its step open");
  window.on.blur.at(-1)();
  check(page.cursor() === 49.5 * g && brief(notes().slice(-1))[0] === "48.5+1 E4", "the window left: the step closed, on a step");
  up("d", "KeyD");
  // cmd Z is still Undo; with Scale on a key lands on the key's notes
  meta("z");
  check(notes().length === n0 + 1 && page.cursor() === 49.5 * g, "cmd Z still undoes");
  keydown("S", { shiftKey: true, code: "KeyS" });
  check(page.set.scale === true && notes().length === n0 + 1 && page.keyboard(), "with Keys play notes on, shift S is still Scale: a letter held with shift is its command's");
  down("w", "KeyW");
  up("w", "KeyW");
  check(notes().length === n0 + 2 && notes().at(-1).pitch === "C4" && page.set.scale, "with Scale on, C# played lands on E minor's C4");
  $("scale").click();
  // shift K, as its button and the Keys help say, turns it off and on again, playing nothing
  keydown("K", { shiftKey: true, code: "KeyK" });
  check(!page.keyboard() && page.stepping() && notes().length === n0 + 2 && said() === "Keys play notes is off: the keys are the editor's again", "with Keys play notes on, shift K turns it off: no C is played");
  keydown("K", { shiftKey: true, code: "KeyK" });
  check(page.keyboard() && notes().length === n0 + 2, "and on again");
  check(/with shift, cmd, ctrl or alt they do/.test($("keys-play").title) && $("keys").all("cmd-help-row").some((r) => r.children[1].textContent.endsWith("These letters do not do their commands while it is on; with shift, cmd, ctrl or alt they do")), "the button and the Keys help say a letter with shift is its command's");
  // into a singer that follows another: refused by name, step input as it was
  $("make-octave").click();
  keydown("Enter");
  page.show(1);
  const d0 = notes().length;
  down("a", "KeyA");
  check(failed() && said().includes(" follows Mary Had a Little Lamb, so its notes, words and vibrato are made from") && said().endsWith("or unlink it first") && notes().length === d0 && !page.ed.drag, "a key played into a follower: refused by name, nothing written");
  up("a", "KeyA");
  page.show(0);
  meta("z");
  // Escape gives the keys back, and leaves step input
  down("Escape", "Escape");
  check(!page.keyboard() && !page.stepping() && said() === "Keys play notes and step input are off: the keys are the editor's again", "Escape: the keys the editor's again");
  page.ed.select([notes()[0]]);
  keydown("a", { code: "KeyA" });
  check(page.tool()?.name === "arpeggiate", "and A arpeggiates again");
  keydown("Escape");

  // a take: Record on, the score sung, a key played where it is heard, kept at Stop as one step
  await pickExample("mary.part");
  const RATE = 24000, HEAD = 24000;
  const sings = () => workers.filter((w) => !w.gone).flatMap((w) => w.posted.filter((m) => m.type === "sing").map((m) => ({ ...m, w }))).sort((a, b) => a.id - b.id);
  const from = (m, data) => m.w.onmessage({ data: { id: m.id, ...data } });
  const opened = (m, zero, first, last) => from(m, { type: "open", frames: 0, lead: 10, lag: 0, zero, first, last, early: 0, rests: [], breaths: [], text: "" });
  const sound = (m, n) => from(m, { type: "chunk", samples: new Float32Array(n).fill(0.1) });
  const made = (m) => from(m, { type: "done", secs: 1, ms: 5 });
  $("snap").value = "240";
  $("snap").fire("change");
  page.place(0);
  $("record").click();
  check($("record").attrs["aria-pressed"] === "true" && said().startsWith("Record is on: Sing records what is played into Mary Had a Little Lamb, where it is heard, its starts and ends to the snap's 1/2"), "Record on: said where and how");
  const s0 = sings().length;
  keydown(" ");
  await settle();
  const m = sings()[s0], long = 24000 * 30;
  check(page.recording() && page.recording().ed === page.ed && said().includes("; recording into Mary Had a Little Lamb once it is heard"), "Sing: a take begun");
  play([0x90, 72, 90]);
  check(failed() && said() === "nothing is heard yet: play once the singing is heard", "a key played before anything is heard: said");
  opened(m, 2400, 0, long);
  sound(m, long);
  made(m);
  await settle();
  render(3);
  draw();
  const at1 = page.heardAt();
  play([0x90, 72, 90]);
  render(1);
  draw();
  calls.rects = [];
  page.paint();
  check(calls.rects.some(([fill]) => fill === rootProps.get("--roll-ok")), "the take drawn as it is played");
  calls.rects = null;
  const at2 = page.heardAt();
  play([0x80, 72, 50]);
  const n1 = notes().length, u1 = undos();
  keydown(" ");
  const snapped = (t) => Math.round(t / 240) * 240, took = notes().filter((n) => n.pitch === "C5" && n.lyric === null);
  check(took.length === 1 && took[0].at === snapped(at1) && took[0].ticks === snapped(at2) - snapped(at1) && took[0].velocity === 90 && took[0].release === 50 && undos() === u1 + 1 && said().startsWith(`stopped\nrecorded into Mary Had a Little Lamb: 1 note from beat ${P.beat(snapped(at1), g)}, in place of the `), `Stop: the note where it was heard (beats ${P.beat(at1, g)} to ${P.beat(at2, g)}), to the snap's step, in place of the notes there; one step of Undo`);
  meta("z");
  check(notes().length === n1 && !notes().some((n) => n.pitch === "C5" && n.lyric === null), "Undo takes the take out, and puts back the notes it was in place of");
  // a take kept while a tool's panel is open: the panel closed first, what it did kept, and the
  // take a step of its own, which neither the panel nor its Cancel can take away
  {
    const t0 = notes(), tu = undos(), taken = () => notes().some((n) => n.pitch === "C5" && n.lyric === null);
    page.ed.select(notes().slice(-2));
    keydown("t");
    const t1 = notes();
    keydown(" ");
    await settle();
    check(page.tool()?.name === "transpose" && page.recording(), "Sing with Transpose's panel open: the panel stays, and a take is begun");
    const tm = sings().at(-1);
    opened(tm, 2400, 0, long);
    sound(tm, long);
    made(tm);
    await settle();
    render(3);
    draw();
    play([0x90, 72, 90]);
    render(1);
    draw();
    play([0x80, 72, 50]);
    keydown(" ");
    check(!page.tool() && taken() && undos() === tu + 2 && equal(t1.slice(-2), notes().slice(-2)) && !equal(t0.slice(-2), t1.slice(-2)) && !failed(), "Stop: the panel closed with the notes transposed, the take one step more");
    keydown("Escape");
    check(taken(), "Escape after it takes nothing away");
    meta("z");
    check(!taken() && equal(notes(), t1), "one Undo takes the take out, the transposed notes stay");
    meta("z");
    check(equal(notes(), t0) && undos() === tu, "and the next the transpose");
  }
  // round a loop, each round a take of its own
  Object.assign(page.set, { loop: { on: true, from: 4 * g, to: 8 * g } });
  keydown(" ");
  await settle();
  const lm = sings().at(-1), p = page.playing(), lineOf = (t) => HEAD + Math.round(p.secs(t) * RATE), span = lineOf(8 * g) - lineOf(4 * g);
  const a = 2400 + lineOf(4 * g) - HEAD - 2400;
  opened(lm, 2400, a, a + span);
  sound(lm, span);
  made(lm);
  await settle();
  render(0.5);
  draw();
  play([0x90, 74, 70]);
  render(0.4);
  draw();
  play([0x80, 74, 64]);
  check(page.recording().pass === 0, "round the loop: the first round's take");
  render(2.4);
  draw();
  check(page.recording() && page.recording().pass === 1 && notes().some((n) => n.pitch === "D5" && n.lyric === null) && said().startsWith("recorded into Mary Had a Little Lamb: 1 note from beat 4"), "the round heard to its end: its take kept, and the next round a take of its own");
  keydown(" ");
  meta("z");
  page.set.loop.on = false;
  // the wheel down to 0 under the drawn vibrato: refused, the notes kept only at a press
  $("s-motion").value = "-";
  $("s-motion").fire("change");
  keydown(" ");
  await settle();
  const wm = sings().at(-1);
  opened(wm, 2400, 0, long);
  sound(wm, long);
  made(wm);
  await settle();
  render(2);
  draw();
  play([0x90, 76, 70]);
  play([0xb0, 1, 0]);
  render(0.5);
  play([0x80, 76, 64]);
  const lane = page.ed.part.lanes.vibrato, n2 = notes().length;
  keydown(" ");
  check(failed() && said().includes("the take: the wheel is down to 0 at beat") && said().endsWith("Keep the notes only, in the panel, keeps its notes without the wheel") && !$("take-notes").hidden && notes().length === n2, "a wheel down to 0 under the drawn vibrato: refused, nothing kept, Keep the notes only offered");
  $("take-notes").click();
  check(!failed() && notes().some((n) => n.pitch === "E5" && n.lyric === null) && page.ed.part.lanes.vibrato === lane && $("take-notes").hidden, "Keep the notes only: the notes kept, the vibrato as it was");
  meta("z");
  meta("z");
  $("record").click();
  check(!page.recording() && $("record").attrs["aria-pressed"] === "false" && said() === "Record is off", "Record off");
  delete window.navigator.requestMIDIAccess;
  $("snap").value = "120";
  $("snap").fire("change");
}

// ---- Save sound: the whole score as a WAV, as Sing from the start plays it, offered to be pressed;
// a Cancel while it is made; the memory it may take refused past its numbers
{
  const off = standin({ processors: registered, live: window.AudioWorkletNode });
  Object.assign(window, { OfflineAudioContext: off.OfflineAudioContext, AudioBuffer: off.AudioBuffer, AudioWorkletNode: off.AudioWorkletNode, File: class { constructor(parts, name, o) { Object.assign(this, { parts, name, type: o.type }); } } });
  const shared = [], locks = [];
  Object.assign(window.navigator, { canShare: ({ files }) => files.every((f) => f.type === "audio/wav"), share: async (d) => { shared.push(d); }, wakeLock: { request: async () => { const l = { on: true, release: async () => { l.on = false; } }; locks.push(l); return l; } } });
  const sings = () => workers.filter((w) => !w.gone).flatMap((w) => w.posted.filter((m) => m.type === "sing").map((m) => ({ ...m, w }))).sort((a, b) => a.id - b.id);
  const stops = () => workers.flatMap((w) => w.posted.filter((m) => m.type === "stop").flatMap((m) => m.ids));
  const from = (m, data) => m.w.onmessage({ data: { id: m.id, ...data } });
  const opened = (m, zero, n) => from(m, { type: "open", frames: 0, lead: 10, lag: 0, zero, first: 0, last: n, early: 0, rests: [], breaths: [], text: "" });
  const until = async (f) => { for (let i = 0; i < 100 && !f(); i++) await settle(); };
  const file = "row-row-row-your-boat-a-round-for-three.wav", speakerNode = () => nodes.find((n) => n.name === "speaker");
  await pickExample("round.score");
  check($("sound-ready").hidden && $("save-sound").textContent === "Save sound" && /id="sound-make" class="hand"/.test(html) && /\.wav,/.test(html), "no sound file yet: Save sound, and Save as sound for a phone; a .wav may be opened");
  const kbds = new Set($("keys").all("cmd-keys").flatMap((s) => s.children.map((k) => k.textContent)));
  check(kbds.has("cmd shift S"), "the Keys help has cmd shift S");
  page.board.fields.strips[1].m.click();
  Object.assign(page.set, { click: { on: true, volume: 50 }, loop: { on: true, from: 0, to: 4 * 480 } });
  const told = speakerNode().told.length, before = sings().length;
  $("save-sound").click();
  await settle();
  const asked = sings().slice(before);
  check(!failed() && equal(asked.map((m) => m.part), [0, 2].map((i) => page.desk.value.rows[i].ed.part)) && asked.every((m) => m.from === undefined && m.to === undefined && m.early === undefined && m.step === 20 && m.together === true) && said() === `making ${file}: 2 singers are getting ready`, "Save sound: each heard singer asked for all its part, as Sing from the start asks, on the one clock the muted one counts in; the muted one not asked");
  check($("save-sound").textContent === "Cancel sound" && $("sound-make").textContent === "Stop making the sound file", "while it is made, the button stops it");
  opened(asked[0], 2400, 48000);
  check(said() === `making ${file}: 2 singers are getting ready`, "how far it is is not said until every singer has said how long it is");
  opened(asked[1], 2880, 48000);
  check(said() === `making ${file}: singing 2 singers, 0%`, "then it is said");
  from(asked[0], { type: "chunk", samples: new Float32Array(48000).fill(0.1) });
  check(said() === `making ${file}: singing 2 singers, 50%`, "as a part of all the samples to be made");
  keydown("s", { metaKey: true, shiftKey: true });
  check(said() === "Save the score as it sounds, as a WAV file: a sound file is being made: Cancel sound stops it" && sings().length === before + 2, "cmd shift S while one is made says why it does not start another");
  page.ed.select(page.ed.part.notes.slice(0, 1));
  keydown("ArrowUp");
  check(!failed() && page.rendering() !== null && page.rendering().url === null, "an edit while it is made leaves it be: the file is the score as pressed");
  keydown("z", { metaKey: true });
  from(asked[0], { type: "done", secs: 2, ms: 5 });
  from(asked[1], { type: "chunk", samples: new Float32Array(48000).fill(0.3) });
  from(asked[1], { type: "done", secs: 2, ms: 5 });
  await until(() => failed() || said().includes(" is ready"));
  const a = $("sound-save"), bytes = blobs.get(a.href), back = W.read(bytes);
  const late = 71; // the limiter's
  check(!failed() && !$("sound-ready").hidden && $("save-sound").textContent === "Save sound" && a.download === file && /^Save row-row-row-your-boat-a-round-for-three\.wav \(\d+\.\d MB, 0:0\d\)$/.test(a.textContent) && back.rate === 24000 && back.channels.length === 2 && back.bits === 16 && back.cue === 2880 + late && back.title === page.desk.value.title && S.read(back.score).singers[1].mute === true, `the file offered to be pressed: a WAV of two ears at 24 kHz, its title, the score inside, beat 0 cued (${a.textContent})`);
  check(said().startsWith(`${file} is ready: 2 singers, `) && said().includes("the score as it was when Save sound was pressed") && !$("sound-share").hidden && locks.length === 1 && !locks[0].on, `the person told it is ready; Share where the browser shares files; the screen let sleep again: "${said()}"`);
  check(speakerNode().told.length === told && back.channels[0].slice(0, late).every((v) => v === 0) && back.channels[0][late] !== 0 && back.channels[0][late + 2880 - 2400 + 200] > back.channels[0][late + 200], "the speaker told nothing, so no click and no loop; the file from the first singer's first sample, as late as the chain, the other joining where its sound falls");
  a.click();
  check(said() === `saved ${file}`, "pressed, it is saved");
  $("sound-share").click();
  await settle();
  check(shared.length === 1 && shared[0].files[0].name === file && shared[0].files[0].type === "audio/wav" && said() === `${file}: shared`, "Share hands the file to the browser's sharing");
  keydown(" ");
  await settle();
  check(!$("sound-ready").hidden && page.playing() !== null && !said().includes("let go of"), "Sing after it is made keeps the file made");
  keydown(" ");
  // a sound file opened gives back the score it was made from
  page.take(bytes, file);
  check(!failed() && said() === `${file}: the score it was made from, 3 singers, ${page.score().singers.reduce((n, x) => n + x.part.notes.length, 0)} notes` && page.desk.value.rows[1].mute && $("sound-ready").hidden, "opened, the sound file is the score it was made from; the file made let go of");
  page.take(W.wav({ channels: [new Float32Array([0.5]), new Float32Array(1)], rate: 24000, cue: 0 }).bytes, "other.wav");
  check(failed() && said() === "other.wav: a sound file with no score in it: the editor opens scores, parts and MIDI files, and the sound files it saved", "a sound file with no score in it is refused, and why");
  // Sing while it is made lets it go
  $("save-sound").click();
  await settle();
  const second = sings().slice(-2);
  keydown(" ");
  await settle();
  check(second.every((m) => stops().includes(m.id)) && said().endsWith(`; ${file} is let go of`) && page.playing() !== null && page.rendering() === null, `Sing while the file is made: its singing stopped, and said: "${said()}"`);
  keydown(" ");
  await settle();
  // Cancel: the button pressed again while it is made
  $("save-sound").click();
  await settle();
  const third = sings().slice(-2);
  $("save-sound").click();
  check(!failed() && third.every((m) => stops().includes(m.id)) && said() === `stopped making ${file}` && page.rendering() === null && $("save-sound").textContent === "Save sound", "pressed again while it is made: its singing stopped, and said");
  // more than the page lets itself use: refused with both numbers, the other singer stopped
  BUDGET.desk = 2 ** 20;
  $("save-sound").click();
  await settle();
  const fourth = sings().slice(-2);
  opened(fourth[0], 2400, 48000);
  opened(fourth[1], 2880, 48000 * 20);
  BUDGET.desk = 1500 * 2 ** 20;
  check(failed() && /^row-row-row-your-boat-a-round-for-three\.wav: this score's sound needs \d+ MB to make here, more than this page lets itself use \(1 MB\)$/.test(said()) && stops().includes(fourth[0].id) && stops().includes(fourth[1].id) && page.rendering() === null, `a sound file past the memory it may take is refused with its numbers: "${said()}"`);
  // a singer the engine refuses: named, its note shown
  $("save-sound").click();
  await settle();
  const fifth = sings().slice(-2), ben = page.desk.value.rows[2].ed;
  from(fifth[1], { type: "error", message: "beat 6: the singer cannot sing this", at: ben.part.notes[0].at });
  check(failed() && said() === `${file}: Ben: beat 6: the singer cannot sing this` && page.ed === ben && ben.selected.size > 0 && stops().includes(fifth[0].id), "a singer the engine refuses is named, its note shown, the others stopped");
  // every singer muted: nothing to hear, and said
  for (const i of [0, 2]) page.board.fields.strips[i].m.click();
  $("save-sound").click();
  check(failed() && said() === "nothing would be heard: every singer with notes is muted, or another is soloed" && page.rendering() === null, "every singer muted: refused, and why");
  for (const i of [0, 1, 2]) page.board.fields.strips[i].m.click();
  check(FADE === globalThis.SPEAKER.FADE, "render.js's FADE is speaker.js's");
  Object.assign(page.set, { click: { on: false, volume: 50 }, loop: { on: false, from: 0, to: 0 } });
  await pickExample("round.score");
}

// the panel's qualities, and those lit
const radios = () => $("route").children.map((l) => l.children[0]), lit = () => radios().filter((r) => r.checked).map((r) => r.value);
// ---- the site's qualities: the choice in the panel, kept for the whole site, and workers made anew for the one chosen
{
  const q = (w) => new URL(w.url).searchParams, kept = () => JSON.parse(store.get("lipservice-quality"));
  const sungBy = (w) => w.posted.filter((m) => m.type === "sing").length;
  const pick = (by, key = false) => {
    for (const r of radios()) r.checked = r.value === by;
    const r = radios().find((x) => x.value === by);
    if (key) r.fire("keydown", { key: "ArrowRight" });
    r.fire("change");
    return r;
  };
  check($("route-row").hidden === false && /id="route" class="seg" role="radiogroup" aria-labelledby="route-label"/.test(html), "the qualities are a group of radios, named by the label beside them");
  check(equal(radios().map((r) => [r.type, r.name, r.value]), [["radio", "quality", "hifi"], ["radio", "quality", "fast"]]) && equal($("route").children.map((l) => [l.tagName, l.children[1].textContent]), [["LABEL", "hifi"], ["LABEL", "fast"]]) && equal(lit(), ["hifi"]) && page.chosen() === null && page.quality() === "hifi" && equal(page.routes(), ["hifi", "fast"]), "the site's two qualities are in the panel, its first in use on a desk");
  check($("route-said").hidden === false && $("route-said").textContent === "Better sound. Fast is about twice as quick." && !store.has("lipservice-quality") && !("route" in JSON.parse(store.get("lipservice editor: the page 2"))), "beside it, why; and nothing kept where nothing was chosen");
  check(workers.length === 2 && workers.every((w) => new URL(w.url).pathname.endsWith("/singer.js") && q(w).get("web") === WEB && q(w).get("models") === MODELS && q(w).get("route") === "hifi"), "each worker is told the site's two places, and the quality in use");
  const mouse = pick("fast");
  check(mouse.blurred === 1 && equal(lit(), ["fast"]), "picked with the mouse: lit, and the keys given back to the roll");
  check(!failed() && page.chosen() === "fast" && kept() === "fast" && store.get("lipservice-quality") === '"fast"' && workers.every((w) => w.gone) && !page.playing() && said() === "every singer is sung in fast" && $("route-said").textContent === "About twice as quick. Hifi sounds better.", "fast chosen while nothing is sung: kept as the site keeps it, the workers let go, and why said");
  keydown(" ");
  await settle();
  await settle();
  const fast = workers.slice(2);
  check(!failed() && fast.length === 2 && fast.every((w) => q(w).get("route") === "fast" && q(w).get("models") === MODELS && !w.gone) && fast.reduce((a, w) => a + sungBy(w), 0) === 3, "Sing: new workers asked for the fast sound sing the three singers");
  const keyed = pick("hifi", true);
  check(!keyed.blurred && equal(lit(), ["hifi"]), "picked with the arrows: lit, and the keys kept for the next");
  await settle();
  await settle();
  const hifi = workers.slice(4);
  check(!failed() && page.chosen() === "hifi" && kept() === "hifi" && fast.every((w) => w.gone) && hifi.length === 2 && hifi.every((w) => q(w).get("route") === "hifi") && hifi.reduce((a, w) => a + sungBy(w), 0) === 3 && page.playing() !== null, "hifi chosen while it sings: the fast workers let go, and every singer sung again by new ones");
  let refused = null;
  try { page.reroute("slow"); } catch (e) { refused = e.message; }
  check(refused === "this site has no slow quality (it has hifi and fast)" && page.chosen() === "hifi" && hifi.every((w) => !w.gone), "a quality the site has not is refused by name, and nothing changes");
  const ran = workers.length;
  pick("hifi");
  check(!failed() && page.chosen() === "hifi" && workers.length === ran && hifi.every((w) => !w.gone) && page.playing() !== null, "the quality in use chosen again: the singing goes on as it was");
  keydown(" ");
  await settle();
}

// ---- a voice is called by the name in its label; the name a part's file has for it is not shown
{
  page.take(new TextEncoder().encode(P.write(P.blank(P.singer("9999")))), "x.part");
  const texts = $("s-voice").children.map((o) => o.textContent);
  check(!failed() && equal(texts, ["A woman, woman", "A man, man", "a voice not on this site"]) && $("s-voice").value === "9999", "the panel's voices by name and sex; a part's voice the site has not is said so, not named");
  check(tabEls()[0].children[1].textContent === "Singer 1" && !$("tabs").children.some((c) => JSON.stringify(c.children.map((x) => x.textContent)).includes("9999")), "its tab is the singer's place, not the voice's name in the file");
}

// ---- a page started with a quality chosen on a site that had it, on one that has not; one kept
// as no quality is; a phone's; and a page started with no word of where the site's files are
{
  // the key and Scale kept from a visit before; a key kept that is not one refused by name
  {
    const SET = "lipservice editor: the page 2", v = JSON.parse(store.get(SET));
    store.set(SET, JSON.stringify({ ...v, key: { tonic: 2, scale: "dorian" }, scale: true }));
    const kept = boot({ document, window, web: WEB, models: MODELS });
    await kept.sounds;
    check(equal(kept.set.key, { tonic: 2, scale: "dorian" }) && kept.set.scale && $("key-said").textContent.startsWith("D dorian, chosen.") && $("scale").attrs["aria-pressed"] === "true" && $("key-tonic").value === "2", "the key and Scale as a visit before left them");
    store.set(SET, JSON.stringify({ ...v, key: { tonic: 2, scale: "dorish" } }));
    const odd = boot({ document, window, web: WEB, models: MODELS });
    check(odd.set.key === null && failed() && said().startsWith("the loop, the click and the key of the last visit are not read: "), "a key kept that is not one is said, and none taken");
    await odd.sounds;
    store.set(SET, JSON.stringify(v));
  }
  const Q = "lipservice-quality", phone = (ua, data) => { window.navigator = { userAgent: ua, platform: /iPhone/.test(ua) ? "iPhone" : "MacIntel", ...(data ? { userAgentData: data } : {}) }; };
  store.set(Q, JSON.stringify("slow"));
  const again = boot({ document, window, web: WEB, models: MODELS });
  check(again.chosen() === "slow", "the quality chosen on the last visit is read");
  await again.sounds;
  check(again.chosen() === null && again.quality() === "hifi" && store.get(Q) === '"slow"' && equal(lit(), ["hifi"]) && failed() && said().startsWith("this site has no slow quality"), "the site has it not: said, its first in use, and what another page keeps left alone");
  store.set(Q, "fast");
  const bad = boot({ document, window, web: WEB, models: MODELS });
  check(bad.chosen() === null && failed() && said() === "the quality chosen on the last visit is not read: " + (() => { try { JSON.parse("fast"); } catch (e) { return e.message; } })(), "a quality kept not as the site keeps it is said, and none taken");
  store.delete(Q);
  phone("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
  const hand = boot({ document, window, web: WEB, models: MODELS });
  check(hand.quality() === null, "a phone's quality waits for the site to say what it has");
  hand.take(new Uint8Array(readFileSync(here("examples/round.score"))), "round.score");
  const early = workers.length;
  hand.sing(0);
  const first = workers.slice(early);
  check(first.length > 0 && first.every((w) => new URL(w.url).searchParams.get("route") === null), "sung before it has said: workers asked for no quality, the site's first");
  await hand.sounds;
  await settle();
  await settle();
  const then = workers.slice(early + first.length);
  check(first.every((w) => w.gone) && then.length > 0 && then.every((w) => new URL(w.url).searchParams.get("route") === "fast" && !w.gone) && hand.playing() !== null, "once it has, the phone's fast: those let go, and the score sung again by new ones");
  hand.stop();
  // a phone's page: its roll is not drawn on, and the words go to every singer who sings them, sung at once
  check(document.documentElement.className === "phone", "a phone's page is dressed as one (html.phone)");
  const notes = hand.ed.part.notes.length, before = workers.length;
  {
    const tap = (px, py) => {
      for (const kind of ["down", "up"]) $("canvas").on[`pointer${kind}`].at(-1)({ clientX: px, clientY: py, pointerId: 5, type: `pointer${kind}`, button: 0 });
    };
    const n = hand.ed.part.notes[2], v = hand.view, c0 = hand.cursor();
    tap(56 + v.x(n.at) + 3, 30 + v.y(P.key(n.pitch)) + v.tall / 2);
    check(hand.ed.part.notes.length === notes && hand.cursor() === c0 && hand.ed.selected.has(n) && hand.ed.selected.size === 1 && said() === "hold the note to drag it", "a tap on a note chooses it, and leaves where singing starts");
    tap(300, 15);
    check(hand.ed.part.notes.length === notes && hand.cursor() > 0 && hand.cursor() !== c0, "a tap on the ruler sets where singing starts and adds no note");
  }
  // a note held still is taken hold of: dragged up two keys, and sung from a beat before it when let go
  {
    const n = hand.ed.part.notes[3], k = P.key(n.pitch), v = hand.view, keys = () => hand.ed.part.notes.map((m) => m.pitch);
    const spot = () => [56 + v.x(n.at) + 3, 30 + v.y(k) + v.tall / 2]; // GUT, RULER
    const finger = (kind, px, py) => $("canvas").on[`pointer${kind}`].at(-1)({ clientX: px, clientY: py, pointerId: 7, type: `pointer${kind}`, button: 0 });
    hand.stop();
    const was = keys(), top0 = v.top;
    let [x, y] = spot();
    finger("down", x, y);
    finger("move", x, y + 40);
    finger("up", x, y + 40);
    check(equal(keys(), was) && v.top !== top0 && !hand.playing(), "a finger that moves at once moves the roll, not the note");
    [x, y] = spot();
    const top = v.top;
    finger("down", x, y);
    await new Promise((r) => setTimeout(r, 400));
    check(said() === "drag to move the note" && hand.ed.selected.has(hand.ed.part.notes[3]), "held still, the note is taken hold of and chosen");
    finger("move", x, y - 2 * v.tall);
    finger("up", x, y - 2 * v.tall);
    await settle();
    const m = hand.ed.part.notes.find((q) => q.at === n.at && q.lyric === n.lyric);
    check(m && P.key(m.pitch) === k + 2 && v.top === top && hand.playing() !== null && hand.playing().start === Math.max(0, n.at - hand.ed.part.grid), "dragged up two keys, the roll still; let go, sung from a beat before it");
    hand.stop();
    document.on.keydown.at(-1)({ key: "z", metaKey: true, target: $("canvas"), preventDefault() {} });
    check(equal(keys(), was), "and undone as any change is");
    // a finger a little off the note still takes hold of it
    [x, y] = spot();
    x = 56 + v.x(n.at) + (n.ticks * v.wide) / 2; // its middle, away from the notes beside it
    finger("down", x, y + v.tall / 2 + 10);
    await new Promise((r) => setTimeout(r, 400));
    const near = said() === "drag to move the note" && hand.ed.selected.has(hand.ed.part.notes[3]);
    $("canvas").on.pointercancel.at(-1)({ clientX: x, clientY: y, pointerId: 7, type: "pointercancel" });
    check(near, "a finger held 10 pixels under the note takes hold of it");
    // another singer's note, held, is taken hold of, and its tab shown
    const rect = (n) => { const x0 = 56 + v.x(n.at); return { x0, x1: x0 + n.ticks * v.wide, mid: 30 + v.y(P.key(n.pitch)) + v.tall / 2 }; };
    const finn = hand.desk.value.rows[0].ed.part.notes.map(rect);
    const cora = hand.desk.value.rows[1].ed.part.notes.find((q) => {
      const c = rect(q);
      return c.x0 > 60 && c.x1 < 1100 && c.mid > 40 && c.mid < 500 && finn.every((f) => f.x1 < c.x0 - 40 || f.x0 > c.x1 + 40 || Math.abs(f.mid - c.mid) > 40);
    });
    check(cora !== undefined, "the round has a note of Cora's in view with none of Finn's near it");
    const c = rect(cora);
    finger("down", (c.x0 + c.x1) / 2 - 4, c.mid);
    await new Promise((r) => setTimeout(r, 400));
    const theirs = hand.ed === hand.desk.value.rows[1].ed && hand.ed.selected.has(cora) && tabEls()[1].getAttribute("aria-selected") === "true";
    $("canvas").on.pointercancel.at(-1)({ clientX: c.x0, clientY: c.mid, pointerId: 7, type: "pointercancel" });
    check(theirs, "held on Cora's note: hers is taken hold of, and her tab shown");
    // nothing near: said so
    const all = hand.desk.value.rows.flatMap((r) => r.ed.part.notes.map(rect));
    const empty = [...Array(40).keys()].map((j) => [300, 36 + j * 6]).find(([px, py]) => all.every((f) => Math.hypot(px < f.x0 ? f.x0 - px : px > f.x1 ? px - f.x1 : 0, Math.abs(py - f.mid)) > 40));
    check(empty !== undefined, "the roll has a spot with no note near it");
    finger("down", ...empty);
    await new Promise((r) => setTimeout(r, 400));
    const none = said();
    $("canvas").on.pointercancel.at(-1)({ clientX: empty[0], clientY: empty[1], pointerId: 7, type: "pointercancel" });
    check(none === "no note there to take hold of: hold a finger on one", "held where no note is near, said so");
    // two fingers: apart up and down, the keys taller; apart sideways, the time wider
    const pf = (kind, id, px, py) => $("canvas").on[`pointer${kind}`].at(-1)({ clientX: px, clientY: py, pointerId: id, type: `pointer${kind}`, button: 0 });
    const [tall0, wide0] = [v.tall, v.wide];
    pf("down", 21, 400, 200);
    pf("down", 22, 400, 260);
    pf("move", 22, 400, 320);
    check(v.tall > tall0 * 1.9 && v.wide === wide0, "pinched apart up and down: the keys about twice as tall, the time as it was");
    pf("move", 22, 520, 320);
    check(v.wide > wide0 * 2 && v.tall > tall0 * 1.9, "then apart sideways: the time wider too");
    pf("up", 22, 520, 320);
    pf("up", 21, 400, 200);
    check(hand.ed.part.notes.length === notes && !hand.playing(), "a pinch changes no note and sings nothing");
    hand.show(0);
  }
  // the elements are every page's booted here, so this page's own listeners are called: the last added
  const own = (id, kind) => $(id).on[kind].at(-1)({ type: kind, target: $(id), preventDefault() {} });
  $("words-all").checked = /id="words-all" type="checkbox" checked/.test(html); // as index.html starts it
  const mine = hand.ed.part.notes.map((n) => n.lyric), others = hand.desk.value.rows.slice(1).map((r) => r.ed.part.notes.map((n) => n.lyric));
  check($("words-all-row").hidden === false && $("words-all").checked && $("words-count").textContent === `${notes} syllables for ${notes} notes`, "the round's singers sing the same words: the choice to give them all the new ones, and the words counted");
  $("words").value = Array(notes).fill("la").join(" ");
  own("words", "input");
  check($("words-count").textContent === `${notes} syllables for ${notes} notes`, "the count follows what is typed");
  own("words-apply", "click");
  await settle();
  check(!failed() && hand.desk.value.rows.every((r) => r.ed.part.notes.every((n) => n.lyric === "la")) && hand.playing() !== null && hand.playing().start === 0, "Use these words: every singer sings them, from the start, at once");
  // one button sings and stops: its listener is this page's, the one before the focus listeners added after it
  const singer = () => $("sing").on.click.at(-2)({ type: "click", target: $("sing") });
  draw();
  check($("sing").textContent === "Stop" && !/id="stop"[^>]*class="[^"]*hand/.test(html), "while it sounds, the phone's Sing button reads Stop");
  singer();
  draw();
  check(hand.playing() === null && said() === "stopped" && $("sing").textContent === "Sing", "pressed, it stops, and reads Sing again");
  singer();
  draw();
  check(hand.playing() !== null && $("sing").textContent === "Stop", "pressed again, it sings");
  hand.stop();
  draw();
  document.on.keydown.at(-1)({ key: "z", metaKey: true, target: $("canvas"), preventDefault() {} }); // cmd Z, to this page
  check(equal(hand.ed.part.notes.map((n) => n.lyric), mine) && equal(hand.desk.value.rows.slice(1).map((r) => r.ed.part.notes.map((n) => n.lyric)), others), "one undo takes them back from every singer");
  $("words-all").checked = false;
  $("words").value = Array(notes).fill("da").join(" ");
  own("words-apply", "click");
  check(hand.ed.part.notes.every((n) => n.lyric === "da") && equal(hand.desk.value.rows.slice(1).map((r) => r.ed.part.notes.map((n) => n.lyric)), others), "without it, this singer's alone");
  $("words").value = Array(notes + 2).fill("da").join(" ");
  own("words", "input");
  own("words-apply", "click");
  check($("words-count").textContent.endsWith(": too many") && $("words-said").textContent === `${notes + 2} syllables for the ${notes} notes`, "too many syllables: said as they are typed, and refused");
  check($("words").value === Array(notes + 2).fill("da").join(" ") && hand.ed.part.notes.every((n) => n.lyric === "da"), "and what was typed stays in the box to be cut, the notes as they were");
  hand.stop();
  $("words-all").checked = true;
  check(hand.chosen() === null && hand.quality() === "fast" && equal(lit(), ["fast"]) && $("route-said").textContent === "Fast on phones, so singing keeps up. Hifi sounds better." && !store.has(Q), "a phone with nothing chosen: fast, why said, and nothing kept");
  // a phone's new singers: Add a harmony and Make it a round, a tap each, sung from the start
  {
    const tap = (id) => $(id).on.click.at(-2)({ type: "click", target: $(id) });
    const z = () => document.on.keydown.at(-1)({ key: "z", metaKey: true, target: $("canvas"), preventDefault() {} });
    hand.show(2);
    const n0 = hand.desk.value.rows.length;
    tap("make-harmony");
    await settle();
    const made = hand.desk.value.rows.at(-1);
    check(!failed() && hand.desk.value.rows.length === n0 + 1 && made.ed.part.singer.voice === "6147" && made.ed.part.title === "Ben, a third above" && hand.tool() === null && hand.playing() !== null && hand.playing().start === 0, "a phone's Add a harmony: a tap, a third above in the key found in the notes, sung from the start");
    hand.stop();
    z();
    check(hand.desk.value.rows.length === n0, "one Undo takes it back");
    tap("make-round");
    await settle();
    check(!failed() && hand.desk.value.rows.length === n0 + 2 && hand.desk.value.rows.slice(-2).every((r) => r.follows?.leader === 2) && hand.playing()?.start === 0, "Make it a round: two more singers coming in after it, following it, sung from the start");
    hand.stop();
    z();
    check(hand.desk.value.rows.length === n0 && [...html.matchAll(/<button id="make-(\w+)"( class="desk")?/g)].every((m) => (m[1] === "harmony" || m[1] === "round") === !m[2]) && /id="s-another" class="desk"/.test(html) && /html\.phone #side \.rows > :is\([^)]*#s-way/.test(sheet), "and nothing else of them on a phone but the ways to sing");
    hand.show(0);
  }
  store.set(Q, JSON.stringify("hifi"));
  const picked = boot({ document, window, web: WEB, models: MODELS });
  await picked.sounds;
  check(picked.quality() === "hifi" && $("route-said").textContent === "Better sound. Fast is about twice as quick.", "a phone's visitor who chose hifi gets hifi");
  store.delete(Q);
  phone("Mozilla/5.0 (Linux; Android 15) Mobile", { mobile: false });
  const said_ = boot({ document, window, web: WEB, models: MODELS });
  await said_.sounds;
  check(said_.quality() === "hifi", "a browser that says it is not a phone is taken at its word");
  phone("a desk's browser");
  let refused = null;
  try { boot({ document, window, web: WEB }); } catch (e) { refused = e.message; }
  check(refused === "boot: models is a folder's address, ending in /, not undefined", "a page not told where the models are does not start");
}

// ---- a site whose models are a hosted bundle's: its voices are the bundle's, by the site's bundle.js
{
  const set = "0123456789ab", sum = "0".repeat(64), file = (site) => ({ size: 1, sha256: sum, site });
  const manifest = { format: 1, set, voices: [{ id: "9", label: "Nine", sex: "F", base: "b" }, { id: "8", label: "Eight", sex: "M", base: "b" }], files: { "v/9.lsw": file("models/voices/9.lsw"), "v/9.vox.lsw": file("models/voices/9.vox.lsw"), "v/8.lsw": file("models/voices/8.lsw") } };
  bundled = { named: { urls: ["bundle/", "https://mirror.test/"] }, files: { "https://mirror.test/manifest.json": JSON.stringify(manifest) } };
  const at = fetched.length;
  const again = boot({ document, window, web: WEB, models: MODELS });
  await again.sounds;
  await settle();
  await settle();
  check(equal($("s-voice").children.map((o) => o.value).slice(0, 2), ["9", "8"]) && $("s-voice").children[0].textContent === "Nine, woman", "the voices in the panel are the bundle's");
  check(equal(fetched.slice(at), [`${MODELS}site.json`, `${WEB}bundle/manifest.json`, "https://mirror.test/manifest.json"]), "its manifest asked of the bundle's sources in turn, the first beside the site's page files; no voices.json");
  check(failed() && said().includes(`the bundle's manifest from bundle/`) && said().includes("taken from https://mirror.test/ instead"), "the source that failed is said");
  bundled = null;
}

// ---- the score in a link: opened over the one kept, which Undo and Back to my score bring back,
// the address cleared of it; a broken one said; Copy link on a desk, Share link on a phone
{
  const BEFORE = "lipservice editor: the score before a link", KEEP = "lipservice editor: the score";
  const own = (id) => $(id).on.click.at(-2)({ type: "click", target: $(id), preventDefault() {} }); // the last page's own, before its focus listener
  const z = (more = {}) => document.on.keydown.at(-1)({ key: "z", metaKey: true, target: $("canvas"), preventDefault() {}, ...more });
  const round = readFileSync(here("examples/round.score"), "utf8"), mary = S.write(S.of(P.read(readFileSync(here("examples/mary.part"), "utf8"))));
  // a score of n notes, each a key and a word at random, for links of a known length
  const noisy = (n, seed = 7) => {
    let x = seed;
    const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648, abc = "abcdefghijklmnopqrstuvwxyz";
    const lines = Array.from({ length: n }, (_, i) => `note ${i} 1 ${P.name(48 + Math.floor(rnd() * 24))} ${1 + Math.floor(rnd() * 126)} 0 ${Array.from({ length: 3 + Math.floor(rnd() * 5) }, () => abc[Math.floor(rnd() * 26)]).join("")}`);
    return S.read(S.write(S.of(P.read(`${P.write({ ...P.blank(P.singer("6147"), 480), title: "noise" })}\n${lines.join("\n")}\n`))));
  };
  const base = "https://lipservice.test/editor/";
  store.clear();
  store.set(KEEP, round);
  window.location.hash = SH.KEY + (await SH.pack(mary));
  const n0 = replaced.length;
  const lk = boot({ document, window, web: WEB, models: MODELS, welcome: true });
  await lk.sounds;
  check((await lk.linked) === "opened" && lk.greeted === null && S.write(lk.score()) === mary && !failed(), "a link's score is opened over the one kept from the visit before");
  check(said() === "the score from the link: 1 singer, 26 notes\nyour own score is put aside: Undo, or Back to my score, brings it back" && store.get(BEFORE) === round && store.get(KEEP) === mary && !$("link-before").hidden, `the visitor's own put aside, and said: "${said()}"`);
  check(equal(replaced.slice(n0), ["/editor/?x=1"]) && window.location.hash === "", "the address cleared of the score, the rest of it kept: a reload opens what is kept since");
  z();
  check(S.write(lk.score()) === round && $("link-before").hidden && store.get(KEEP) === round && !store.has(BEFORE), "Undo brings back the score kept from the visit before, keeps it again, and puts nothing aside");
  z({ shiftKey: true });
  check(S.write(lk.score()) === mary && !$("link-before").hidden && store.get(BEFORE) === round, "and Redo the link's, the visitor's put aside again");
  own("link-before");
  check(S.write(lk.score()) === round && said() === `your score from before the link: 3 singers, ${S.read(round).singers.reduce((n, x) => n + x.part.notes.length, 0)} notes. Undo brings back the link's` && $("link-before").hidden && !store.has(BEFORE) && store.get(KEEP) === round, "Back to my score opens it as a file is opened, and it is put aside no longer");
  z();
  check(S.write(lk.score()) === mary && !$("link-before").hidden && store.get(BEFORE) === round, "and one Undo takes it back, the visitor's put aside again");
  // Copy link, on a desk: to the clipboard through a ClipboardItem, started within the press
  const clip = { text: null, refuse: null, items: 0 };
  window.ClipboardItem = class { constructor(items) { this.items = items; } };
  window.navigator.clipboard = { write: async ([item]) => { clip.items++; if (clip.refuse) throw new Error(clip.refuse); clip.text = (await item.items["text/plain"]).parts[0]; } };
  own("copy-link");
  check(clip.items === 1 && said() === "the link is being made", "Copy link writes to the clipboard within the press");
  await sleep(20);
  check(!failed() && clip.text === base + SH.KEY + (await SH.pack(mary)) && (await SH.unpack(clip.text.slice(base.length + SH.KEY.length))) === mary && said() === `a link to this score is on the clipboard: ${clip.text.length.toLocaleString("en-US")} characters`, `the link is the page's address and the score, and said: "${said()}"`);
  lk.take(new TextEncoder().encode(S.write(noisy(300))), "noise.score");
  own("copy-link");
  await sleep(20);
  check(!failed() && /^a link to this score is on the clipboard: 4,\d{3} characters; too long for a Discord or Telegram message$/.test(said()), `a link too long for some apps says which: "${said()}"`);
  lk.take(new TextEncoder().encode(S.write(noisy(2000))), "noise.score");
  own("copy-link");
  await sleep(20);
  check(failed() && /^a link to this score is 2\d,\d{3} characters, and a link works up to 12,000: save the score as a file to send it$/.test(said()), `a link too long to work is refused with both lengths: "${said()}"`);
  clip.refuse = "Write permission denied.";
  z();
  own("copy-link");
  await sleep(20);
  check(failed() && said() === "the link is not on the clipboard: Write permission denied.", "the clipboard refused: said");
  delete window.ClipboardItem;
  own("copy-link");
  check(failed() && said() === "this browser does not let a page put a link on the clipboard", "a browser with no ClipboardItem: said");
  // a link broken: said, nothing changed, nothing put aside, the address cleared of it
  store.set(BEFORE, "kept");
  const n1 = replaced.length;
  window.location.hash = `${SH.KEY}1.abc+def`;
  const broken = boot({ document, window, web: WEB, models: MODELS, welcome: true });
  check((await broken.linked) === "refused" && failed() && said().startsWith("this link's score is not opened: the link's score is cut or changed: \"+\" at its character 4") && S.write(broken.score()) === store.get(KEEP) && store.get(BEFORE) === "kept" && replaced.length === n1 + 1, `a broken link: said, the kept score left as it is: "${said()}"`);
  await broken.greeted;
  // the visitor's own link: nothing to put aside
  store.delete(BEFORE);
  window.location.hash = SH.KEY + (await SH.pack(store.get(KEEP)));
  const mine = boot({ document, window, web: WEB, models: MODELS });
  check((await mine.linked) === "opened" && said() === `the score from the link: 1 singer, ${S.read(store.get(KEEP)).singers[0].part.notes.length} notes` && !store.has(BEFORE) && $("link-before").hidden, "a link to the score kept already puts nothing aside");
  // the browser's storage refusing to put it aside: said, and Undo still brings it back
  {
    const was = window.localStorage, kept = store.get(KEEP);
    window.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { if (k === BEFORE) throw new Error("the quota is full"); store.set(k, v); } };
    window.location.hash = SH.KEY + (await SH.pack(round));
    const full = boot({ document, window, web: WEB, models: MODELS });
    check((await full.linked) === "opened" && failed() && said().endsWith("\nyour own score is not put aside for a reload (the quota is full): Undo brings it back while this page is open") && !store.has(BEFORE) && $("link-before").hidden, `storage refused: said, and nothing offered but Undo: "${said()}"`);
    document.on.keydown.at(-1)({ key: "z", metaKey: true, target: $("canvas"), preventDefault() {} });
    check(S.write(full.score()) === kept, "and Undo brings it back");
    window.localStorage = was;
  }
  // put aside, it can be gone back to after a reload, and after a change to the score's singers
  const reload = () => boot({ document, window, web: WEB, models: MODELS });
  store.set(BEFORE, round);
  store.set(KEEP, mary);
  window.location.hash = "";
  const rl = reload();
  await rl.linked;
  await rl.sounds;
  await settle();
  check(S.write(rl.score()) === mary && !$("link-before").hidden, "a reload: Back to my score still offered");
  document.on.keydown.at(-1)({ key: "h", target: $("canvas"), preventDefault() {} });
  document.on.keydown.at(-1)({ key: "Enter", target: $("canvas"), preventDefault() {} });
  check(rl.desk.value.rows.length === 2 && !$("link-before").hidden, "and after a singer added");
  {
    const was = window.navigator;
    window.navigator = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", platform: "iPhone" };
    const rp = reload();
    await rp.linked;
    check(document.documentElement.className.includes("phone") && !$("link-before").hidden && /html\.phone header > :is\([^)]*#link-before:not\(\[hidden\]\)/.test(sheet), "and on a phone after a reload, where the button is the only way to it");
    own("link-before");
    check(S.write(rp.score()) === round && $("link-before").hidden && !store.has(BEFORE), "where it opens the visitor's own");
    window.navigator = was;
  }
  // a second link before going back: the score put aside stays the visitor's own
  {
    store.set(BEFORE, round);
    store.set(KEEP, mary);
    const third = S.write(noisy(12));
    window.location.hash = SH.KEY + (await SH.pack(third));
    const l2 = reload();
    check((await l2.linked) === "opened" && S.write(l2.score()) === third && store.get(BEFORE) === round && failed() && said() === "the score from the link: 1 singer, 12 notes\nthe score that was open is not put aside, as your own is put aside already (Back to my score): Undo brings it back while this page is open" && !$("link-before").hidden, `a second link: the visitor's own stays put aside, and the one open is said not to be kept: "${said()}"`);
    z();
    check(S.write(l2.score()) === mary && store.get(BEFORE) === round && !$("link-before").hidden, "Undo brings back the first link's, the visitor's still put aside");
    own("link-before");
    check(S.write(l2.score()) === round && !store.has(BEFORE), "and Back to my score the visitor's own");
  }
  // the browser refusing to take it out: said, and the score opened all the same
  {
    const was = window.localStorage;
    store.set(BEFORE, round);
    window.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: () => { throw new Error("storage is off"); } };
    const l3 = reload();
    await l3.linked;
    own("link-before");
    check(S.write(l3.score()) === round && failed() && said().endsWith("\nthe score put aside for a link stays in the browser (storage is off)") && $("link-before").hidden, `a removal refused: said, the score opened: "${said()}"`);
    window.localStorage = was;
    store.delete(BEFORE);
    store.set(KEEP, mary);
  }
  // the address that cannot be changed: said, so that a reload opening the link again is no surprise
  {
    const was = window.history;
    window.history = { replaceState: () => { throw new Error("too many calls"); } };
    window.location.hash = SH.KEY + (await SH.pack(mary));
    const stuck = boot({ document, window, web: WEB, models: MODELS });
    check((await stuck.linked) === "opened" && failed() && said().startsWith("the score from the link: 1 singer, 26 notes") && said().endsWith("\nthe link stays in the page's address (too many calls): a reload opens it again"), `the address not cleared: said with what was opened: "${said()}"`);
    window.history = was;
    window.location.hash = "";
  }
  // no score in the address: nothing done, the address left alone
  const n2 = replaced.length;
  window.location.hash = "#somewhere";
  const plain = boot({ document, window, web: WEB, models: MODELS });
  check((await plain.linked) === "none" && replaced.length === n2 && window.location.hash === "#somewhere", "an address with no score in it is left alone");
  window.location.hash = "";
  // a newcomer by a link gets the link's score, not the example
  store.clear();
  window.location.hash = SH.KEY + (await SH.pack(mary));
  const fresh = boot({ document, window, web: WEB, models: MODELS, welcome: true });
  await fresh.sounds;
  await fresh.greeted;
  check(S.write(fresh.score()) === mary && said() === "the score from the link: 1 singer, 26 notes" && !store.has(BEFORE), "a first visit by a link opens the link's score, not the example");
  // a phone: Share link to the share sheet, the link made ahead so that the sheet opens within the tap
  const shared = [];
  let tapping = false, refuse = null;
  window.navigator = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", platform: "iPhone", canShare: (d) => typeof d.url === "string" && !d.files, share: async (d) => { shared.push({ ...d, within: tapping }); if (refuse) throw Object.assign(new Error(refuse.message), { name: refuse.name }); } };
  store.set(KEEP, round);
  const ph = boot({ document, window, web: WEB, models: MODELS });
  await ph.sounds;
  await ph.linked;
  await sleep(20);
  tapping = true;
  own("copy-link");
  tapping = false;
  await settle();
  check(shared.length === 1 && shared[0].within && shared[0].url === base + SH.KEY + (await SH.pack(round)) && shared[0].title === ph.score().title && said() === `the link is shared: ${shared[0].url.length.toLocaleString("en-US")} characters`, "a phone's Share link: the share sheet opened within the tap, with the link made ahead");
  refuse = { name: "AbortError", message: "Share canceled" };
  own("copy-link");
  await settle();
  check(!failed() && said() === "the link is not shared", "the sheet closed: not shared, and no failure");
  refuse = { name: "NotAllowedError", message: "not now" };
  own("copy-link");
  await settle();
  check(failed() && said() === "the link is not shared: not now", "the sheet refused: said");
  refuse = null;
  // an edit just before the tap: the link made in it, then shared
  ph.ed.set([ph.ed.part.notes[0]], { lyric: "Oh" });
  own("copy-link");
  check(said() === "the link is being made", "a link not made yet is made at the tap");
  await sleep(20);
  check(shared.at(-1).url === base + SH.KEY + (await SH.pack(S.write(ph.score()))) && !failed(), "and shared once made");
  window.navigator.share = undefined;
  own("copy-link");
  check(failed() && said() === "this browser has no share sheet for a link", "a phone with no share sheet: said");
  // Save as sound on a phone: a phone's memory, refused past it with its numbers
  const w0 = workers.length;
  BUDGET.phone = 2 ** 20;
  own("sound-make");
  await settle();
  const asked = workers.slice(w0).flatMap((w) => w.posted.filter((m) => m.type === "sing").map((m) => ({ ...m, w }))).sort((a, b) => a.id - b.id);
  check(asked.length === 3 && $("sound-make").textContent === "Stop making the sound file" && /html\.phone #sound-make \{ display: block/.test(sheet) && /html\.phone header > :is\([^)]*#copy-link/.test(sheet), "Save as sound on a phone: every singer asked, and the button stops it");
  asked.forEach((m, i) => m.w.onmessage({ data: { id: m.id, type: "open", frames: 0, lead: 10, lag: 0, zero: 2400, first: 0, last: 48000 * (i + 1) * 5, early: 0, rests: [], breaths: [], text: "" } }));
  BUDGET.phone = 400 * 2 ** 20;
  check(failed() && /: this score's sound needs \d+ MB to make here, more than this page lets itself use \(1 MB\)$/.test(said()) && ph.rendering() === null, `past a phone's memory: refused with its numbers: "${said()}"`);
  window.navigator = { userAgent: "a desk's browser", platform: "MacIntel" };
}

// ---- a first visit, where the page is asked to greet one: the round opened, and where to start said
{
  store.clear();
  const hello = boot({ document, window, web: WEB, models: MODELS, welcome: true });
  await hello.sounds;
  await hello.greeted;
  const lines = said().split("\n");
  check(!failed() && hello.desk.value.rows.length === 3 && hello.desk.value.title.startsWith("Row, Row, Row Your Boat") && lines.length === 3 && lines[0].startsWith("Start here: press Sing") && lines[2] === "The editor needs a mouse and a keyboard. It does not work by touch.", "nothing kept: the round for three is open, and three lines say where to start");
  const kept = boot({ document, window, web: WEB, models: MODELS, welcome: true });
  await kept.sounds;
  check(kept.greeted === null && said() === "the score as it was left", "a score kept from a visit before opens as it was left, with no greeting");
  check(page.greeted === null, "a page not asked to greet does not");
}

// ---- the buttons' titles name their keys as the Keys help does, on a Mac and off one
{
  const keysOf = (id) => $(id).title.match(/\(([^()]*)\)[^()]*$/)[1];
  window.navigator = { userAgent: "a desk's browser", platform: "MacIntel" };
  boot({ document, window, web: WEB, models: MODELS });
  check(keysOf("undo") === "cmd Z" && keysOf("redo") === "cmd shift Z or cmd Y" && keysOf("save-sound") === "cmd shift S" && $("save-sound").title.endsWith("(cmd shift S). Press again while it is made to stop it") && keysOf("side-toggle") === "P" && keysOf("step") === "shift N" && $("step").title.includes("(Keys, or MIDI in)"), "on a Mac: cmd Z, cmd shift S; P for the panel; only the last brackets are keys");
  window.navigator = { userAgent: "a desk's browser", platform: "Win32" };
  boot({ document, window, web: WEB, models: MODELS });
  const help = new Set($("keys").all("cmd-keys").flatMap((s) => s.children.map((k) => k.textContent)));
  check(keysOf("undo") === "ctrl Z" && keysOf("save-sound") === "ctrl shift S" && help.has("ctrl shift S") && !help.has("cmd shift S") && keysOf("keys-play") === "shift K", "on Windows: ctrl S and ctrl shift S, as the Keys help has them");
  window.navigator = { userAgent: "a desk's browser", platform: "MacIntel" };
}

// ---- no en or em dash in the editor's files, and no emoji (a sign drawn as text, as its close, is not one)
{
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(here(".")).filter((f) => /\.(js|mjs|html|css|md)$/.test(f));
  const bad = files.filter((f) => /[\u2013\u2014\uFE0F]|\p{Emoji_Presentation}/u.test(readFileSync(here(f), "utf8")));
  check(files.length > 30 && !bad.length, `no en or em dash, and no emoji, in the editor's ${files.length} files${bad.length ? `: ${bad.join(", ")}` : ""}`);
}

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
