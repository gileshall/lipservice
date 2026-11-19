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
import { boot } from "./page.js";
import { EXAMPLES, SCORES } from "./examples/make.mjs";
import { MENU } from "./examples/menu.js";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) { fails++; console.log(`     status: ${JSON.stringify(els.get("status").textContent)}`); } };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const here = (name) => fileURLToPath(new URL(name, import.meta.url));

// ---- the document: every element the page asks for by id, as index.html has them
const html = readFileSync(here("index.html"), "utf8");
const idsInPage = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const calls = { fill: 0, text: 0, bars: [] }; // bars: the ruler's bar numbers as drawn, [text, x]
const context = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : k === "measureText" ? (s) => ({ width: 6 * String(s).length }) : (...a) => {
    if (k === "fillRect") calls.fill++;
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
  getBoundingClientRect() { return { left: 0, top: 0 }; }
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
const frames = [], blobs = new Map(), store = new Map(), fetched = [], sized = [];
let bundled = null; // a site that names a bundle: {named (its site.json's bundle), files: {address: text}}
const window = {
  getComputedStyle: (el) => {
    if (el !== document.documentElement) throw new Error("getComputedStyle of an element other than the page's root");
    return { getPropertyValue: (k) => rootProps.get(k) ?? "" };
  },
  devicePixelRatio: 2,
  navigator: { userAgent: "a desk's browser" },
  requestAnimationFrame: (f) => frames.push(f),
  ResizeObserver: class { constructor(f) { sized.push(f); } observe() {} },
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
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
  addEventListener() {},
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
check(view.x(36 * 480) < 1200 - 56 && view.left === 0, "all of it in sight");
// the singer named in its tab: the part's title
tabEls()[0].fire("dblclick");
{
  const input = tabEls()[0].children.find((c) => c.tagName === "INPUT");
  input.value = "Mary Had a Little Lamb";
  input.fire("keydown", { key: "Enter" });
}
check(page.ed.part.title === "Mary Had a Little Lamb" && tabEls()[0].children[1].textContent === "Mary Had a Little Lamb", "a tab double clicked takes the singer's name, which is its part's title");
$("save-midi").click();
$("save-part").click();
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
$("new").click();
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
  $("save-score").click();
  check(downloads.at(-1).name === "row-row-row-your-boat-a-round-for-three.score" && equal(S.read(downloads.at(-1).data), SCORES.round()) && document.title === "Row, Row, Row Your Boat: a round for three", "Save writes the score: every singer and the mix");
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

  // a click on the ruler while they sing
  const before = told("seek").length, jobs = sings().length;
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
  const Q = "lipservice-quality", phone = (ua, data) => { window.navigator = { userAgent: ua, ...(data ? { userAgentData: data } : {}) }; };
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

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
