// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// midiin.js: MIDI messages as events, Web MIDI against stand-ins for the browser's access and its
// ports, the computer's keys as a keyboard, step input onto an Editor, and a take merged into a
// part. node midiin_test.mjs
import assert from "node:assert/strict";
import * as P from "./part.js";
import { Editor } from "./edit.js";
import { syllables } from "./edit.js";
import { size } from "./midi.js";
import { parse, bent, open, Keys, Steps, apply, Take, PIANO } from "./midiin.js";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const rejected = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const G = 960;
const fresh = (motion = "vibrato") => new Editor(P.blank({ ...P.singer("6147", 3), motion }));
const brief = (part) => part.notes.map((n) => `${P.beat(n.at, G)}+${P.beat(n.ticks, G)} ${P.pitch(n)} ${n.velocity}/${n.release}${n.lyric === null ? "" : ` ${n.lyric}`}`);
const on = (key, velocity = 90, time = 0) => ({ type: "on", key, velocity, channel: 1, time });
const off = (key, release = 64, time = 0) => ({ type: "off", key, release, channel: 1, time });
const tick = (n) => new Promise((r) => setTimeout(r, n));

// ------------------------------------------------------------------ messages

{
  check(equal(parse([0x90, 60, 100], 5), { type: "on", key: 60, velocity: 100, channel: 1, time: 5 }), "a note on, its key, velocity, channel and time");
  check(equal(parse(new Uint8Array([0x93, 61, 0]), 6), { type: "off", key: 61, release: 64, channel: 4, time: 6 }), "a note on of no force is a note off with a release of 64, on its channel");
  check(equal(parse([0x80, 62, 30], 7), { type: "off", key: 62, release: 30, channel: 1, time: 7 }), "a note off keeps its release");
  check(equal(parse([0xb0, 1, 100], 8), { type: "wheel", value: 100, channel: 1, time: 8 }), "controller 1 is the wheel");
  check(parse([0xb0, 64, 127], 9).down === true && parse([0xb0, 64, 63], 9).down === false, "controller 64 is the pedal, down from 64");
  check(equal(parse([0xe0, 0, 64], 1), { type: "bend", value: 8192, channel: 1, time: 1 }) && parse([0xe0, 127, 127], 1).value === 16383, "a bend's two bytes, 8192 none");
  check(equal(parse([0xf8], 2), { type: "other", data: [0xf8], time: 2 }) && parse([0xb0, 7, 100], 2).type === "other", "a clock and other controllers are others, with their bytes");
  check(threw(() => parse([60, 100], 0))?.includes("no status byte"), "a message with no status byte is refused, its bytes named");
  check(threw(() => parse([0x90, 60], 0))?.includes("90 3C"), "a note on cut short is refused");
  check(threw(() => parse([0x90, 60, 100])) !== null, "a message with no time is refused");
}
{
  check(equal(bent(60, 8192), [60, 0]), "no bend is the key as played");
  check(equal(bent(60, 12288), [61, 0]), "a bend of 100 cents moves the key and leaves no cents");
  check(equal(bent(60, 10240), [60, 50]), "a bend of a quarter of the range is 50 cents");
  check(equal(bent(60, 16383, 12), [71, 99.8535]), "a bend past 99 cents moves the key and the rest stays in cents");
  check(equal(bent(60, 0), [58, 0]) && equal(bent(60, 4096), [59, 0]), "down too");
  check(threw(() => bent(127, 16383))?.includes("outside MIDI's keys"), "a bend past the keyboard's end is refused");
}

// ------------------------------------------------------------------ Web MIDI, against stand-ins

function port(id, name) {
  return {
    id, name, manufacturer: "", type: "input", state: "connected", connection: "closed", onmidimessage: null, opened: 0, closed: 0, refuse: null,
    async open() { if (this.refuse) throw this.refuse; this.opened++; this.connection = "open"; return this; },
    async close() { this.closed++; this.connection = "closed"; return this; },
    send(data, timeStamp) { this.onmidimessage?.({ data: new Uint8Array(data), timeStamp }); },
  };
}
function browser(ports) {
  const access = { inputs: new Map(ports.map((p) => [p.id, p])), outputs: new Map(), onstatechange: null, asked: null };
  const nav = { requestMIDIAccess: async (opts) => { access.asked = opts; return access; } };
  return { access, nav, plug(p, state) { p.state = state; access.onstatechange?.({ port: p }); } };
}
const said = () => {
  const s = { events: [], changes: [], fails: [] };
  s.say = { event: (e, id) => s.events.push([e, id]), change: (c) => s.changes.push(c), fail: (e) => s.fails.push(e.message) };
  return s;
};

{
  const s = said();
  check((await rejected(() => open({}, s.say)))?.includes("no Web MIDI"), "a browser with no Web MIDI says so");
  check((await rejected(() => open(undefined, s.say)))?.includes("no Web MIDI"), "and so does no navigator");
  const refuse = (name) => ({ requestMIDIAccess: async () => { const e = new Error("Permission denied"); e.name = name; throw e; } });
  const no = await rejected(() => open(refuse("NotAllowedError"), s.say));
  check(no?.includes("refused") && no.includes("NotAllowedError: Permission denied"), "a refused permission is said plainly, with the browser's words");
  check((await rejected(() => open(refuse("SecurityError"), s.say)))?.includes("refused"), "as is Firefox's refusal");
  check((await rejected(() => open(refuse("AbortError"), s.say)))?.includes("could not be opened: AbortError"), "any other failure is named");
  check((await rejected(() => open(browser([]).nav, { event: () => {} })))?.includes("change"), "open() is given every one of its callbacks");
}
{
  const a = port("a1", "Keystation 49"), b = port("b2", ""), s = said(), w = browser([a, b]);
  const m = await open(w.nav, s.say);
  check(equal(w.access.asked, { sysex: false, software: false }), "access is asked for with no system exclusive");
  check(equal(m.inputs(), [{ id: "a1", name: "Keystation 49", maker: "", on: true }, { id: "b2", name: "the input b2", maker: "", on: true }]), "the inputs listed by name; one with none by its id");
  check(m.chosen === null && a.onmidimessage === null, "none is played from until chosen");
  await m.choose("a1");
  a.send([0x90, 60, 99], 12.5);
  a.send([0xb0, 1, 70], 13);
  check(m.chosen === "a1" && a.opened === 1 && equal(s.events, [[{ type: "on", key: 60, velocity: 99, channel: 1, time: 12.5 }, "a1"], [{ type: "wheel", value: 70, channel: 1, time: 13 }, "a1"]]), "the input chosen is opened, and its messages come as events with their times");
  await m.choose("b2");
  a.send([0x90, 62, 99], 14);
  check(a.closed === 1 && a.onmidimessage === null && s.events.length === 2 && m.chosen === "b2", "another chosen: the first is closed and heard no more");
  b.send([0x90], 15);
  check(s.fails.length === 1 && s.fails[0].includes("the input b2") && s.fails[0].includes("90"), "a message that cannot be read is said, naming the input");
  await m.choose(null);
  check(m.chosen === null && b.closed === 1, "none chosen: the input is closed");
  check((await rejected(() => m.choose("zz")))?.includes("Keystation 49, the input b2"), "an input not there is refused, naming those there");
  a.refuse = Object.assign(new Error("in use"), { name: "InvalidAccessError" });
  const busy = await rejected(() => m.choose("a1"));
  check(busy?.includes("Keystation 49 could not be opened: InvalidAccessError: in use") && m.chosen === null, "an input that will not open says why, and is not chosen");
  a.refuse = null;
  await m.choose("a1");
  w.plug(a, "disconnected");
  const lost = s.changes[s.changes.length - 1];
  check(lost.lost === "Keystation 49" && lost.back === null && lost.inputs[0].on === false && m.chosen === null, "the input chosen pulled out: said by name, and not chosen");
  w.plug(a, "connected");
  await tick(0);
  const back = s.changes[s.changes.length - 1];
  a.send([0x80, 60, 20], 20);
  check(back.back === "Keystation 49" && m.chosen === "a1" && a.opened === 3 && s.events[s.events.length - 1][0].type === "off", "put back: said, opened again, and heard");
  w.plug(b, "disconnected");
  check(s.changes[s.changes.length - 1].lost === null && m.chosen === "a1", "another input pulled out: the list changes, the choice does not");
  const s2 = said(), w2 = browser([port("c", "C")]);
  const m2 = await open(w2.nav, { ...s2.say, event: () => { throw new Error("no room for it"); } });
  await m2.choose("c");
  w2.access.inputs.get("c").send([0x90, 60, 1], 0);
  check(equal(s2.fails, ["C: no room for it"]), "what goes wrong with an event is said, not dropped");
  await m.close();
  check(a.onmidimessage === null && w.access.onstatechange === null, "closed: no input heard, no change listened for");
}

// ------------------------------------------------------------------ the computer's keys

{
  const k = new Keys();
  const press = (code, more = {}) => k.down({ code, timeStamp: 1, ...more }, 80);
  check(equal(PIANO.map((code) => { const e = press(code); k.up({ code, timeStamp: 2 }); return e[0].key; }), [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72]), "A W S E D F T G Y H U J K are C4 up to C5");
  check(equal(press("KeyA"), [{ type: "on", key: 60, velocity: 80, channel: 1, time: 1 }]), "a key down is a note on, at the velocity given");
  check(equal(press("KeyA", { repeat: true }), []) && equal(press("KeyA"), []), "a key held is not struck again, and is still the keyboard's");
  check(press("KeyA", { metaKey: true }) === null && press("KeyZ", { ctrlKey: true }) === null && press("KeyQ") === null && press("Space") === null, "with Cmd or Ctrl, and keys that are not these, the page has them");
  check(press("KeyK", { key: "K", shiftKey: true }) === null && press("KeyS", { shiftKey: true }) === null && press("KeyX", { shiftKey: true }) === null && press("Backspace", { altKey: true }) === null, "with Shift or Alt too: shift K, which turns the keys off, is the page's");
  const o = press("KeyX");
  check(o[0].type === "octave" && o[0].octave === 5 && o[0].low === "C5", "X goes an octave up");
  check(equal(k.up({ code: "KeyA", timeStamp: 3 }), [{ type: "off", key: 60, release: 64, channel: 1, time: 3 }]), "a key let go after the octave moved lets go of the key it struck");
  check(press("KeyA")[0].key === 72, "and the next is in the new octave");
  for (let i = 0; i < 6; i++) press("KeyZ");
  check(k.octave === -1 && threw(() => press("KeyZ")).includes("as low as they go"), "Z goes down to C-1 and no further, and says so");
  for (let i = 0; i < 9; i++) press("KeyX");
  check(k.octave === 8 && threw(() => press("KeyX")).includes("as high as they go"), "X goes up until K is C9, and no further");
  check(equal(["ArrowRight", "Backspace", "BracketLeft", "BracketRight", "Escape"].map((code) => press(code)[0].type), ["rest", "back", "shorter", "longer", "leave"]), "a rest, back, shorter, longer, and leave");
  check(press("Backspace", { repeat: true })[0].type === "back" && press("ArrowRight", { repeat: true })[0].type === "rest" && equal(press("KeyX", { repeat: true }), []), "held, back and rest go again; the octave does not");
  check(threw(() => new Keys().down({ code: "KeyA", timeStamp: 0 }, 0))?.includes("velocity 0"), "a velocity of 0 is refused");
  const k2 = new Keys();
  k2.down({ code: "KeyA", timeStamp: 0 }, 80);
  k2.down({ code: "KeyD", timeStamp: 0 }, 80);
  check(equal(k2.lift(9).map((e) => [e.type, e.key, e.time]), [["off", 60, 9], ["off", 64, 9]]) && !k2.held.size, "every key held let go at once, as when the window is left");
  check(equal(k2.up({ code: "KeyA", timeStamp: 10 }), []) && k2.up({ code: "KeyQ", timeStamp: 10 }) === null, "a key up after that is nothing; one not the keyboard's is the page's");
}

// ------------------------------------------------------------------ step input

{
  const ed = fresh(), st = new Steps({ at: 0, ticks: G / 2 });
  const run = (e) => { const x = st.take(e); if (x) apply(ed, x); return x; };
  const undos = () => ed.past.length;
  run(on(60, 100));
  check(equal(brief(ed.part), ["0+0.5 C4 100/64"]) && st.at === 0, "a key down writes its note at once; the cursor stays while it is down");
  const x = run(off(60, 40));
  check(equal(brief(ed.part), ["0+0.5 C4 100/40"]) && x.cursor === G / 2 && st.at === G / 2 && undos() === 1, "let go: its release is kept, and the cursor goes on a step; one change");
  run(on(64, 90));
  run(on(67, 80));
  run(off(64));
  check(st.at === G / 2 && brief(ed.part).length === 3, "a chord: the cursor waits while any key is down");
  const y = run(off(67));
  check(equal(brief(ed.part), ["0+0.5 C4 100/40", "0.5+0.5 E4 90/64", "0.5+0.5 G4 80/64"]) && y.cursor === G && undos() === 2, "a chord is a chord: both keys on the one step, one change to undo");
  check(ed.selected.size === 2, "the step's notes are the ones chosen");
  run({ type: "rest" });
  check(st.at === 3 * G / 2 && brief(ed.part).length === 3 && undos() === 2, "a rest goes on a step with no note and nothing to undo");
  run(on(62));
  run({ type: "rest" });
  run({ type: "rest" });
  run(off(62));
  check(brief(ed.part)[3] === "1.5+1.5 D4 90/64" && st.at === 3 * G && undos() === 3, "a rest with a key down lengthens its note a step each time: a tie");
  run({ type: "sustain", down: true });
  run(on(65));
  run(off(65));
  run(on(69));
  run(off(69));
  check(st.at === 3 * G && brief(ed.part).length === 6, "with the pedal down the step stays open: a chord played a key at a time");
  run({ type: "sustain", down: false });
  check(st.at === 7 * G / 2 && undos() === 4, "the pedal up closes it");
  check(equal(run({ type: "back" }), { op: "back", at: 3 * G, ticks: G / 2, keys: [65, 69], cursor: 3 * G }) && brief(ed.part).length === 4 && st.at === 3 * G && undos() === 5, "back takes the last step's notes out and the cursor back to it, as one change");
  run({ type: "back" });
  run({ type: "back" });
  check(st.at === G && equal(brief(ed.part), ["0+0.5 C4 100/40", "0.5+0.5 E4 90/64", "0.5+0.5 G4 80/64"]), "back again takes the tie's note, then the rest");
  run({ type: "back" });
  run({ type: "back" });
  check(st.at === 0 && !ed.part.notes.length && threw(() => run({ type: "back" })) === "no step to take back", "back to the start, and no further");
  run(on(60));
  check(threw(() => run({ type: "back" }))?.includes("let go") && threw(() => st.place(0))?.includes("let go"), "no step taken back, and the cursor not moved, while a key is down");
  run(off(60));
  check(equal(run({ type: "shorter" }), { op: "length", ticks: G / 4 }) && equal(run({ type: "longer" }), { op: "length", ticks: G / 2 }) && st.ticks === G / 2, "shorter halves the step, longer doubles it");
  const odd = new Steps({ ticks: 3 });
  check(threw(() => odd.take({ type: "shorter" }))?.includes("3 ticks cannot be halved"), "a step that cannot be halved in whole ticks says so");
  check(run({ type: "wheel", value: 3 }) === null && run({ type: "other", data: [0xf8] }) === null, "the wheel and other messages write nothing in step input");
  check(threw(() => run({ type: "octave" }))?.includes("no octave") && threw(() => run({ type: "leave" })) !== null, "the page's own events are not step input's");
  check(threw(() => st.take(on(60, 0)))?.includes("velocity 0"), "a velocity of 0 is refused");
  st.place(4 * G);
  check(st.at === 4 * G && threw(() => run({ type: "back" })) === "no step to take back", "the cursor placed elsewhere: the steps before are not taken back from there");
  ed.select([]);
  ed.undo();
  check(ed.part.notes.length === 0, "a step is undone by the Editor's undo, as one");
}
{
  // a bend at the key's going down is the note's cents
  const ed = fresh(), st = new Steps({ ticks: G });
  const run = (e) => { const x = st.take(e); if (x) apply(ed, x); };
  run({ type: "bend", value: 9216 });
  run(on(60));
  run(off(60));
  run({ type: "bend", value: 8192 });
  run(on(60));
  run(off(60));
  check(equal(brief(ed.part), ["0+1 C4+25 90/64", "1+1 C4 90/64"]), "a bend standing as a key goes down is its note's cents");
}
{
  // words: each step takes the next syllable
  const ed = fresh(), st = new Steps({ ticks: G });
  st.words(syllables("Ma-ry had a_"));
  const run = (e) => { const x = st.take(e); if (x) apply(ed, x); };
  for (const k of [64, 62, 60]) { run(on(k)); run(off(k)); }
  run({ type: "rest" });
  run(on(62)); run(on(67)); run(off(62)); run(off(67));
  run(on(64)); run(off(64));
  run(on(65)); run(off(65));
  check(equal(ed.part.notes.map((n) => n.lyric), ["Ma-", "ry", "had", "a", "a", "_", null]), "each step takes the next syllable, a chord's notes all of it, a rest none; past the words, none");
  run({ type: "back" });
  run({ type: "back" });
  check(st.next === 4, "back gives the syllable back");
  run(on(69)); run(off(69));
  check(ed.part.notes[ed.part.notes.length - 1].lyric === "_", "and the next step takes it again");
  check(threw(() => st.words(["two words"]))?.includes("syllables"), "words that are not syllables are refused");
}
{
  // a step whose notes were changed since is not taken back blindly
  const ed = fresh(), st = new Steps({ ticks: G });
  const run = (e) => { const x = st.take(e); if (x) apply(ed, x); };
  run(on(60)); run(off(60));
  ed.select(ed.part.notes);
  ed.move(0, 2);
  const before = ed.part;
  check(threw(() => run({ type: "back" }))?.includes("no C4 there") && ed.part === before, "a step changed since is not taken back, and says what is not there");
  const st2 = new Steps({ ticks: G }), ed2 = fresh();
  apply(ed2, st2.take(on(60)));
  apply(ed2, st2.take(on(64)));
  apply(ed2, st2.lift());
  check(ed2.past.length === 1 && ed2.drag === null && st2.at === G && !st2.down.size, "lifted: the step open is closed, as one change");
  check(threw(() => apply(fresh(), { op: "step", at: 0, ticks: 1, notes: [], first: false, open: true })).includes("begun elsewhere"), "a step's later edit on an editor that did not begin it is refused");
}

// ------------------------------------------------------------------ a take

{
  // the clock: a beat a second from time 0, in ms
  const clock = (time) => time / 1000 * G;
  const t = new Take({ tick: clock, from: 2 * G });
  t.take(on(59, 70, 1500)); // during the count-in, let go before the take
  t.take(off(59, 64, 1900));
  t.take(on(60, 100, 1950)); // early, held across the start
  t.take(off(60, 30, 3010));
  t.take({ type: "wheel", value: 32, channel: 1, time: 1000 }); // before the take: where its vibrato starts
  t.take(on(64, 80, 3020));
  check(equal(t.notes(3500).map((n) => [n.key, n.held]), [[59, false], [60, false], [64, true]]) && t.notes(3500)[2].ticks === clock(3500) - clock(3020), "what to draw as it comes: the notes let go, and the one down drawn to now");
  t.take({ type: "sustain", down: true, channel: 1, time: 3100 });
  t.take(off(64, 50, 3400));
  t.take(on(67, 90, 3500));
  t.take({ type: "wheel", value: 127, channel: 1, time: 3600 });
  t.take({ type: "wheel", value: 127, channel: 1, time: 3700 });
  t.take({ type: "sustain", down: false, channel: 1, time: 3980 });
  t.take({ type: "bend", value: 10240, channel: 1, time: 4000 });
  t.take(on(62, 60, 4010));
  t.take(on(62, 61, 4300)); // struck again while down
  check(threw(() => t.merge(fresh().part))?.includes("finish it first"), "a take still being played is not merged");
  t.finish(4800);
  check(threw(() => t.take(on(60))) === "the take is finished" && threw(() => t.finish(5000)) === "the take is finished", "a take finished takes nothing more");
  const part0 = fresh().part;
  part0.notes = [
    { at: 0, ticks: G, pitch: "A3", cents: 0, velocity: 64, release: 64, lyric: "la" },
    { at: 3 * G, ticks: G, pitch: "B3", cents: 0, velocity: 64, release: 64, lyric: "lo" },
    { at: 6 * G, ticks: G, pitch: "B3", cents: 0, velocity: 64, release: 64, lyric: "li" },
  ];
  const raw = t.merge(part0);
  check(raw.early === 1 && raw.notes === 5, "the note let go before the take is left out and counted");
  check(equal(brief(raw.part), [
    "0+1 A3 64/64 la",
    "2+1.010417 C4 100/30",
    "3.019792+0.960417 E4 80/50",
    "3.5+1.3 G4 90/64",
    "4.010417+0.289583 D4+50 60/64",
    "4.3+0.5 D4+50 61/64",
    "6+1 B3 64/64 li",
  ]), "played: where heard to the tick, the early note from the take's start, the pedal holding E4 until it came up, the bend as cents, a key struck again ending the one before, a key still down ending at the finish; the part's note inside the take replaced, those outside kept");
  check(equal(raw.part.lanes.vibrato, [{ at: 2 * G, value: 0.5, line: false }, { at: Math.round(clock(3600)), value: 2, line: false }, { at: Math.round(clock(4800)), value: 1, line: false }]), "the wheel as the vibrato lane, 64 the voice's own; moved before the take, from its start; back to as it was after");
  check(raw.part.lanes.vibrato[0].value === size(32), "as midi.js maps the wheel");
  const q = t.merge(part0, { step: G / 4, replace: false, wheel: false });
  check(equal(brief(q.part).filter((s) => !/ (la|lo|li)$/.test(s)), [
    "2+1 C4 100/30",
    "3+1 E4 80/50",
    "3.5+1.25 G4 90/64",
    "4+0.25 D4+50 60/64",
    "4.25+0.5 D4+50 61/64",
  ]) && q.part.notes.length === 8 && equal(q.part.lanes.vibrato, []), "to a quarter beat, a note a step at least; kept beside the part's; the lane left as it was");
  check(P.read(P.write(raw.part)).notes.length === 7, "what is merged is a part the text holds");
}
{
  // the lane around the take: a line going through it runs on as it was either side
  const clock = (time) => time;
  const part = fresh().part;
  part.lanes.vibrato = [{ at: 0, value: 1, line: false }, { at: 1000, value: 2, line: true }, { at: 2000, value: 0.5, line: true }];
  const t = new Take({ tick: clock, from: 400 });
  t.take({ type: "wheel", value: 64, channel: 1, time: 500 });
  t.take({ type: "wheel", value: 0, channel: 1, time: 600 });
  t.finish(1500);
  const lane = t.merge(part).part.lanes.vibrato;
  check(equal(lane, [
    { at: 0, value: 1, line: false },
    { at: 500, value: 1.5, line: true },
    { at: 500, value: 1, line: false },
    { at: 600, value: 0, line: false },
    { at: 1500, value: 1.25, line: false },
    { at: 2000, value: 0.5, line: true },
  ]), "the line into the take runs to its first point, and the line out of it goes on from its end as it did");
  const dashed = { ...part, singer: { ...part.singer, motion: null } };
  const no = threw(() => t.merge(dashed));
  check(no?.includes("down to 0 at beat 0.625") && no.includes("motion is -"), "under motion - a wheel down to 0 is refused, naming where");
  check(equal(t.merge(dashed, { wheel: false }).part.lanes.vibrato, part.lanes.vibrato), "and the take is kept without the wheel when asked");
}
{
  // a line point at the take's very end keeps its value there and after
  const part = fresh().part;
  part.lanes.vibrato = [{ at: 0, value: 1, line: false }, { at: 1000, value: 2, line: true }, { at: 3000, value: 1, line: false }];
  const t = new Take({ tick: (x) => x });
  t.take({ type: "wheel", value: 96, channel: 1, time: 200 });
  t.finish(1000);
  check(equal(t.merge(part).part.lanes.vibrato, [
    { at: 0, value: 1, line: false },
    { at: 200, value: 1.2, line: true },
    { at: 200, value: size(96), line: false },
    { at: 1000, value: 2, line: false },
    { at: 3000, value: 1, line: false },
  ]), "a line ending where the take ends: its value there, and on as it was");
  const t2 = new Take({ tick: (x) => x });
  t2.take(on(60, 90, 100));
  t2.finish(300);
  const kept = t2.merge(part).part;
  check(kept.lanes.vibrato === part.lanes.vibrato && brief(kept)[0] === "0.104167+0.208333 C4 90/64", "a take with no wheel leaves the lane as it was; a note held to the end ends there");
  check(threw(() => new Take({})).includes("clock") && threw(() => new Take({ tick: () => NaN }).take(on(60, 90, 1)))?.includes("NaN"), "a take with no clock, or one that gives no tick, is refused");
}

console.log(fails ? `${fails} failed` : "all ok");
process.exit(fails ? 1 : 0);
