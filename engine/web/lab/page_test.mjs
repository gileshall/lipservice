// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The bench's own page script (lab.js) run in node on a built lab, with stand-ins for the
// document, the sound and the store and with worker.js in a worker thread: a song is typed, a
// sound chosen, replaced, ended and timed from the engine's list, options and rules pulled, a take
// kept and flipped to, a sweep sung, a refusal shown, and the session comes back. Fails on
// anything the page throws. It draws nothing and plays nothing: how the page looks and sounds is
// for a browser.
//     node page_test.mjs LAB
// LAB: the built lab (build.sh): lab/, lipservice.js, lipservice.wasm, and the models it was
// built to read, a folder under LAB or on the network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker as Thread } from "node:worker_threads";

const site = process.argv[2];
if (!site) { console.error("usage: node page_test.mjs LAB"); process.exit(2); }
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const fail = (what) => { console.error(`FAIL ${what}`); process.exit(1); };
process.on("uncaughtException", (e) => fail(e.stack));
process.on("unhandledRejection", (e) => fail(e?.stack ?? e));

// ---------------------------------------------------------------- stand-ins
const pen = new Proxy({}, { get: () => () => {}, set: () => true });
class El {
  constructor(tag) {
    Object.assign(this, { tag, tagName: tag.toUpperCase(), kids: [], attrs: {}, on: {}, style: {}, className: "", value: "", checked: false, disabled: false, scrollLeft: 0, clientWidth: 1200 });
    this.classList = { add: (c) => { this.className += ` ${c}`; }, remove: (c) => { this.className = this.className.split(" ").filter((x) => x !== c).join(" "); } };
  }
  append(...kids) { this.kids.push(...kids); }
  replaceChildren(...kids) { this.kids = kids; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === "id") this.id = v; }
  addEventListener(t, f) { (this.on[t] ??= []).push(f); }
  removeEventListener(t, f) { this.on[t] = (this.on[t] ?? []).filter((x) => x !== f); }
  fire(t, ev = {}) { for (const f of [...(this.on[t] ?? [])]) f({ target: this, preventDefault() {}, ...ev }); }
  click() { if (this.disabled) throw new Error(`a click on ${this.id ?? this.tag}, which is off`); this.fire("click"); }
  get textContent() { return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join(""); }
  set textContent(v) { this.kids = [v]; }
  get width() { return Number(this.attrs.width); }
  get height() { return Number(this.attrs.height); }
  getContext() { return pen; }
  setPointerCapture() {}
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  blur() {}
  all(f, out = []) { for (const k of this.kids) if (typeof k !== "string") { if (f(k)) out.push(k); k.all(f, out); } return out; }
}
const app = new El("div"), tourRoot = new El("div");
const $ = (id) => app.all((e) => e.id === id)[0] ?? null;
const by = (attr, v, under = app) => under.all((e) => e.attrs[attr] === String(v))[0] ?? null;
const every = (attr) => app.all((e) => attr in e.attrs);
// the page's own fetch of the engine, a file beside it
globalThis.fetch = async (url) => {
  const b = readFileSync(fileURLToPath(url));
  return { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "#000" });
globalThis.document = { documentElement: {}, createElement: (t) => new El(t), getElementById: (id) => (id === "app" ? app : id === "tour" ? tourRoot : $(id)), activeElement: null };
const kept = new Map();
globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) };
const plays = [];
globalThis.AudioContext = class {
  currentTime = 0;
  state = "running";
  destination = {};
  resume() {}
  createBuffer(_, n) { return { n, copyToChannel() {} }; }
  createBufferSource() { return { connect() {}, stop() {}, start(_, at, dur) { plays.push({ at, dur, loop: this.loop, from: this.loopStart, to: this.loopEnd, n: this.buffer.n }); } }; }
};
globalThis.requestAnimationFrame = () => {};
Object.assign(globalThis, { scrollX: 0, scrollY: 0, scrollTo() {} });
const keys = [];
globalThis.addEventListener = (t, f) => { if (t === "keydown") keys.push(f); };
let copied = null;
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (t) => { copied = t; } } }, configurable: true });
const threads = [];
globalThis.Worker = class {
  constructor(url) {
    this.t = new Thread(new URL("./page_test_worker.mjs", import.meta.url), { workerData: { url: url.href } });
    this.t.on("message", (data) => this.onmessage({ data }));
    this.t.on("error", (e) => fail(e.stack));
    threads.push(this.t);
  }
  postMessage(m) { this.t.postMessage(m); }
};

// ---------------------------------------------------------------- the page
const page = pathToFileURL(join(site, "lab", "lab.js")).href;
let lab = await (await import(page)).ready;
const idle = async () => { do { await new Promise((r) => setTimeout(r, 20)); } while (lab.busy); };
const text = () => app.textContent;
const pullIn = (el) => el.all((e) => /pull/.test(e.className));
const drag = async (p, px) => {
  p.fire("pointerdown", { clientX: 300, pointerId: 1 });
  p.fire("pointermove", { clientX: 300 + px });
  const shown = p.textContent;
  p.fire("pointerup");
  await idle();
  return shown;
};
// a list set to the choice whose words hold `label`
const choose = async (sel, label) => {
  const k = sel.kids.findIndex((o) => o.textContent.includes(label));
  if (k < 0) throw new Error(`${sel.id}: no choice ${label}`);
  sel.value = sel.kids[k].value;
  sel.fire("change");
  await idle();
};
const type = async (song) => {
  const box = $("song");
  box.value = song;
  box.fire("input");
  box.fire("blur");
  await idle();
};
const key = async (k, more = {}) => { for (const f of keys) f({ key: k, target: app, preventDefault() {}, ...more }); await idle(); };

// an empty bench: nothing is sung, no song is given, and the lesser parts are folded shut
check(/No song yet/.test(text()) && $("song").value === "" && $("strip") === null && $("word") === null && $("rules") === null && every("data-fold").length === 0 && $("voice").kids.length === 16, "the bench opens empty: the song box, every voice, and nothing else");
const unfold = () => { for (const id of ["options", "sweep", "takes", "out"]) by("data-fold", id).click(); };

// the walk round the page: each step names an area that is there, and says what to do first where it is not
const guide = () => tourRoot.textContent, tourId = (id) => tourRoot.all((e) => e.id === id)[0] ?? null;
$("tour-open").click();
check(/1 of 9/.test(guide()) && /The song/.test(guide()) && tourId("tour-back").disabled && tourId("tour-act") !== null, "the walk opens on the song, and offers to type one into an empty box");
tourId("tour-next").click();
check(/2 of 9/.test(guide()) && /Nothing is sung yet/.test(guide()), "with nothing sung a step says to write a song first");
tourId("tour-back").click();
tourId("tour-act").click();
await idle();
check($("song").value.startsWith("%bpm 84") && lab.error === null && $("strip") !== null && tourId("tour-act") === null, "the song it types is sung");
check(every("data-option").length === 0 && $("keep") === null && $("out-song") === null && every("data-fold").length === 4, "the settings, the sweep, the takes and the text are folded shut");
unfold();
check(every("data-option").length === 11 && every("data-option").every((r) => r.textContent.length > 30), "every sing option the engine has is there with its line of help");
check(every("data-rule").length === 0 && every("data-set-rules").length === 2 && $("set-plain") === null && $("set-sung").checked && /built inplain1 rule/.test(by("data-set-rules", "plain").textContent) && $("out-rules") === null, "the engine's sets are two rows, plain always, sung ticked, and no rule is written");
for (let k = 2; k <= 9; k++) {
  tourId("tour-next").click();
  if (k === 3) { check(/No sound is chosen/.test(guide()), "the sound's step asks for a sound"); by("data-sound", "1.1").click(); await idle(); }
  check(new RegExp(`${k} of 9`).test(guide()) && !/Nothing is sung|is chosen\. Click/.test(guide()), `step ${k} of the walk has its area`);
}
tourId("tour-next").click();
check(tourRoot.className === "", "Done closes the walk");
await type("");
lab.select(null);
plays.length = 0;

// a song typed is sung and spelled out, its vowels spoken: each sound as written
await key(" ");
await type("%bpm 84\nsilent F4:1.5+G4:0.5 F4:1\nnight D4:3\nholy F4:1.5 F4:1\n");
check(lab.sung.plan[1].phones.map((p) => p[0]).join() === "N,AA1,AY1,T", "sung as every song is: a held eye opened");
plays.length = 0;
$("set-sung").checked = false;
$("set-sung").fire("change");
await idle();
check(!lab.state.rules.sung && $("out-rules").textContent === "%diction spoken", "sung ticked off: spoken, a line before the song");
check(every("data-word").length === 3 && every("data-sound").length === 13 && $("curves").width > 400 && plays.length === 1 && plays[0].at === 0, "a song typed is sung, spelled out sound by sound, and played");
check(/"n" as in no/.test(by("data-sound", "1.0").attrs.title) && by("data-sound", "1.0").textContent === "n" && by("data-sound", "1.1").textContent === "eye" && by("data-sound", "1.2").textContent === "t",
  "every sound of a word is a tile with its plain name, the short ones too");

// a sound chosen: one row to change it by
let n = plays.length;
by("data-sound", "1.1").click();
const dur = lab.sung.samples.length / 24000;
check(plays.length === n + 1 && Math.abs(plays.at(-1).at - lab.region[0]) < 1e-9 && plays.at(-1).dur < dur && /Sound/.test($("sound").textContent) && /\d+ ms/.test($("sound").textContent), "a sound clicked is chosen and its word played");
check($("sound-is").kids.length === 39 && $("sound-weight").kids.length === 3 && $("sound-end").kids.length === 16 && $("notes") !== null, "all 39 sounds to make it, the three weights, an ending from the vowels, and the word's notes");
$("hear").checked = false;
$("hear").fire("change");
by("data-sound", "1.1").click();
check(plays.length === n + 1, "with play what I touch off, a click is silent");
$("hear").checked = true;
$("hear").fire("change");
await choose($("sound-is"), "father");
check($("song").value.includes("\nnight{N,AA,T} D4:3\n") && lab.sung.plan[1].phones[1][0] === "AA1" && plays.length === n + 2, "a sound picked takes the chosen one's place, in the song's text, sung and played at once");
check(by("data-edited", "1") !== null && /word 2night ?n ah t/.test(by("data-edited", "1").textContent), "and is a row of what is changed");
await choose($("sound-end"), "night");
check($("song").value.includes("night{N,AA,~AY,T}") && lab.sel.i === 1 && by("data-sound", "1.2").textContent === "eye" && /n ah →eye t/.test(by("data-edited", "1").textContent), "the vowel made to slide to another sound at its end");
const shown = await drag(pullIn($("sound"))[0], -60);
check(/^\d+ ms$/.test(shown) && new RegExp(`night\\{N,AA,~AY:${parseInt(shown, 10)},T\\}`).test($("song").value), `the ending's length pulled: ${shown}`);
await choose($("add-after"), '"s" as');
check(/~AY:\d+,S,T\}/.test($("song").value), "a sound put after it");
by("data-sound", "1.3").click();
$("remove").click();
await idle();
check(/~AY:\d+,T\}/.test($("song").value) && $("sound") === null, "and taken out");
by("data-sound", "1.1").click();
await choose($("sound-weight"), "weak");
check($("song").value.includes("night{N,AA0,"), "a vowel sung weak");
await key("z", { metaKey: true });
check($("song").value.includes("night{N,AA,~AY"), "undo, from the keyboard");
await drag(pullIn($("notes"))[0], 12);
await drag(pullIn($("notes"))[1], -24);
check(/\} E4:2\.5\n/.test($("song").value), `the word's note pulled higher and shorter: ${$("song").value.split("\n")[2]}`);

// options and rules
await drag(pullIn(by("data-option", "shift"))[0], -18);
check(lab.state.options.shift === -3 && $("out-command").textContent.endsWith("--shift -3") && /settingshift-3/.test(by("data-set", "shift").textContent), "an option pulled is sung, in the command line, and a row of what is changed");
await choose($("opt-motion"), "wide");
$("set-sung").checked = true;
$("set-sung").fire("change");
await idle();
check(lab.state.options.motion === "wide" && lab.state.rules.sung && /--motion wide$/.test($("out-command").textContent) && $("out-rules") === null, "a motion chosen, the set sung ticked on again: no line");
by("data-more", "set-sung").click();
check(/vowel -> stress=1\nER0 -> AH R\nAY held>=240/.test(by("data-set-rules", "sung").textContent), "a set's rules are shown in the engine's words");
await choose($("rule-add"), "long vowel: \"eye\"");
check(every("data-rule").length === 1 && /AY -> same\nAY held>=240 not-before=L,R -> AA ~AY:<200\nAY held>=240 before=vowel -> AA ~IY:<200/.test(by("data-rule", "0").textContent) && lab.error === null, "a long vowel's row starts as the set sings it, its rule written under it");
const base = lab.sung;
await drag(pullIn(by("data-rule", "0"))[0], -30);
by("data-more", "rule-0").click();
await choose($("rule-0-into"), "same");
const AY = "%diction AY -> same\n%diction AY held>=240 not-before=L,R -> AA ~AY:<150";
check($("out-rules").textContent === AY && $("out-song").textContent.startsWith(`${AY}\n%bpm 84\n`) && lab.sung !== base, "a rule pulled is diction lines before the song, sung at once");
check(every("data-sound").some((t) => /ruled/.test(t.className) && /"eye" as in night\nrule: vowel -> stress=1/.test(t.attrs.title)) && !/ruled/.test(by("data-sound", "0.0").className), "a sound's tile says which rule gave it: the eye of silent, left whole before its l, its stress the set's");
await choose($("rule-0-who"), "only");
check($("out-rules").textContent.includes(`diction for=${lab.state.voice.toLowerCase()} AY held>=240`), "a rule for the bench's voice alone");
await choose($("rule-0-who"), "everyone");
$("rule-0-on").checked = false;
$("rule-0-on").fire("change");
await idle();
check($("out-rules") === null && every("data-rule").length === 1 && lab.state.rules.rows[0].ms === 150, "a row unticked is sung without and kept as it was");
$("rule-0-on").checked = true;
$("rule-0-on").fire("change");
await idle();
check($("out-rules").textContent === AY, "and ticked again is back");
await choose($("rule-add"), "go");
check(every("data-rule").length === 2 && $("out-rules").textContent.endsWith("%diction OW -> same\n%diction OW held>=240 -> OW") && lab.error === null, "any vowel can be given a row");
by("data-drop", "1").click();
await idle();
await choose($("rule-add"), "pitch dip");
await drag(pullIn(by("data-rule", "1"))[0], 10);
$("rule-1-every").checked = true;
$("rule-1-every").fire("change");
await idle();
check(/diction B,D,G,JH -> dip=1.2$/.test($("out-rules").textContent) && lab.error === null, "the dip a row: its depth, and every b, d, g and j");
await choose($("rule-add"), "engine's words");
$("rule-2-text").value = "T place=last before=rest -> none";
$("rule-2-text").fire("change");
await idle();
check($("out-rules").textContent.endsWith("%diction T place=last before=rest -> none") && lab.error === null, "a rule written in the engine's words is sung");
$("rule-2-text").value = "T place=last ->";
$("rule-2-text").fire("change");
await idle();
check(/the rules, line \d+: .*nothing after ->/.test(lab.error) && /nothing after ->/.test(text()), "one the engine refuses is said on the page");
by("data-drop", "2").click();
await idle();
by("data-drop", "1").click();
await idle();
$("everywhere").click();
await idle();
check(by("data-word-rule", "night") !== null && /nightn ah →eye t/.test(by("data-word-rule", "night").textContent) && /diction word=night -> N AA ~AY:\d+ T$/.test($("out-rules").textContent), "a word's sounds made the rule for every such word");
$("copy-song").click();
await idle();
check(copied === $("out-song").textContent && /The song copied/.test($("said").textContent), "the song copied as text");

// takes and flipping
$("take-name").value = "first";
$("keep").click();
await drag(pullIn(by("data-option", "breathiness"))[0], -60);
check(every("data-take").length === 1 && /breathiness: 1, 0\.5/.test(by("data-take", "1").textContent), "a take kept by name, and what has changed since");
n = plays.length;
by("data-hear", "1").click();
await idle();
check(/Playing: first/.test($("heard").textContent) && plays.length === n + 1 && $("sound") === null && /Work on it/.test(text()), "a take heard is shown and played, and is not changed where it is");
await key("f");
check($("heard") === null && plays.length === n + 2 && /Flip to first/.test($("flip2").textContent), "F flips back at the same spot");

// a sweep: sung, then heard in turn
await choose($("sweep-target"), "breathiness");
const sw = pullIn($("sweep"));
await drag(sw[0], 60);
await drag(sw[2], -12);
check(/0\.5, 1\.75, 3 {2}\(now/.test($("sweep").textContent), "a sweep's values as pulled");
n = plays.length;
$("sweep-run").click();
await idle();
check(every("data-run").length === 3 && every("data-run").every((r) => !r.disabled) && every("data-run-on").length === 3, "the sweep is sung, each value with its tick");
check(/Playing: breathiness: 0\.5/.test($("heard").textContent) && plays.length === n + 1, "and its first value plays without being asked");
by("data-run-on", 0).checked = false;
by("data-run-on", 0).fire("change");
$("turn").click();
await idle();
check(/Playing: breathiness: 1\.75/.test($("heard").textContent), "an unticked value is passed over in the round");
by("data-run", 2).click();
await idle();
check(/Playing: breathiness: 3/.test($("heard").textContent) && $("out-command").textContent.includes("--breathiness 3"), "a run heard is shown, and its text is what is written out");
$("run-keep").click();
check(every("data-take").length === 2, "a run kept as a take");
by("data-sound", "1.2").click();
await choose($("sweep-target"), "the chosen sound");
check(every("data-choice").length === 15, "the chosen sound can be swept over every sound it can be");
$("hear-bench").click();
await idle();

// a refusal
await type($("song").value.replace("holy F4:1.5 F4:1", "holy F4:1.5"));
check(/The engine refused this.*holy: 2 syllables/.test($("refused").textContent) && every("data-word").length === 3, `a refusal in the engine's words: ${$("refused").textContent}`);
$("undo").click();
await idle();
check($("refused") === null, "and undone");

// the session comes back
const was = { song: $("song").value, command: $("out-command").textContent, takes: every("data-take").length };
lab = await (await import(`${page}?again`)).ready;
await idle();
unfold();
// the second page draws into the same stand-in
check($("song").value === was.song && $("out-command").textContent === was.command && every("data-take").length === was.takes && every("data-word").length === 3, "the page opened again is the bench as it was left, takes and all");

for (const t of threads) await t.terminate();
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
