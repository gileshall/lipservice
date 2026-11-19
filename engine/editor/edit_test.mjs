// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// edit.js: the editor's changes, each undone as one, what is refused left as it was, the words
// typed under the notes, and where things are on the roll. node edit_test.mjs
import assert from "node:assert/strict";
import * as P from "./part.js";
import { History, Editor, View, bars, steps, snap, hit, sounding, syllables, typed, word, clicks } from "./edit.js";
import { EXAMPLES } from "./examples/make.mjs";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const G = 960;
const fresh = () => new Editor(P.blank(P.singer("6147", 3)));
const brief = (ed) => ed.part.notes.map((n) => `${P.beat(n.at, G)}+${P.beat(n.ticks, G)} ${P.pitch(n)}${n.lyric === null ? "" : ` ${n.lyric}`}`);

// notes drawn, moved, lengthened and removed; each undone and done again
{
  const ed = fresh();
  const a = ed.add(0, G, 60, 80), b = ed.add(2 * G, G / 2, 64, 90), c = ed.add(G, G, 62, 70);
  check(equal(brief(ed), ["0+1 C4", "1+1 D4", "2+0.5 E4"]) && ed.selected.has(c) && ed.selected.size === 1, "three notes drawn, kept in the order of their starts, the last drawn chosen");
  check(c.velocity === 70 && c.release === 64 && c.lyric === null && c.cents === 0, "a note drawn has its velocity, a release of 64, no words and no cents");
  ed.select([a, b]);
  ed.move(G / 2, 2);
  check(equal(brief(ed), ["0.5+1 D4", "1+1 D4", "2.5+0.5 F#4"]) && ed.selected.size === 2, "two moved half a beat on and two keys up, still chosen");
  ed.move(-10 * G, -200);
  check(equal(brief(ed), ["0+1 C-1", "1+1 D4", "2+0.5 E-1"]), "moved as far as the part's start and the lowest key let them, together");
  ed.move(0, 500);
  check(equal(brief(ed), ["0+1 D#9", "1+1 D4", "2+0.5 G9"]), "and as far as the highest");
  check(ed.undo() && ed.undo() && ed.undo() && equal(brief(ed), ["0+1 C4", "1+1 D4", "2+0.5 E4"]) && ed.selected.size === 2, "three moves undone, the choice as it was");
  ed.stretch(-10 * G, G / 4);
  check(equal(brief(ed), ["0+0.25 C4", "1+1 D4", "2+0.25 E4"]), "shortened no further than the snap's step");
  ed.stretch(G);
  ed.select([ed.part.notes[1]]);
  ed.remove();
  check(equal(brief(ed), ["0+1.25 C4", "2+1.25 E4"]) && ed.selected.size === 0, "lengthened a beat; the middle one removed");
  check(ed.undo() && ed.part.notes.length === 3 && ed.redo() && ed.part.notes.length === 2 && !ed.redo(), "removal undone and done again");
  const sharp = ed.add(4 * G, G, 61, 64);
  ed.set([sharp], { pitch: "Db4", cents: -12.5 });
  ed.move(G, 0);
  check(brief(ed)[2] === "5+1 Db4-12.5", "a note moved along keeps its spelling and its cents");
  ed.move(0, 1);
  check(brief(ed)[2] === "5+1 D4-12.5", "moved to another key it is spelled as that key is");
  // what the text cannot hold is refused, and the part is as it was
  const before = ed.part, undos = ed.past.length;
  check(threw(() => ed.set([ed.part.notes[0]], { velocity: 0 }))?.includes("velocity 0") && ed.part === before && ed.past.length === undos, "a velocity of 0 is refused and nothing is changed");
  check(threw(() => ed.set([ed.part.notes[0]], { lyric: "two words" })) !== null && ed.part === before, "a lyric of two words is refused");
  check(threw(() => ed.add(0.5, G, 60, 64)) !== null && ed.part === before, "a note off the ticks is refused");
}

// a drag is one change however far it goes, made each time from where it began
{
  const ed = fresh();
  const a = ed.add(0, G, 60, 80);
  const n = ed.past.length;
  ed.begin();
  for (const d of [100, 480, 960, 1440]) {
    ed.again();
    ed.move(d, 1);
  }
  ed.end();
  check(equal(brief(ed), ["1.5+1 C#4"]) && ed.past.length === n + 1, "a drag of four moves ends a beat and a half on, one key up, as one change");
  ed.undo();
  check(ed.part.notes[0] === a, "and is undone as one");
  ed.begin();
  ed.again();
  ed.end();
  check(ed.past.length === n && ed.future.length === 1, "a press with no drag changes nothing");
  // drawing: the note is drawn again at each length
  ed.begin();
  for (const len of [G, G / 2, 3 * G]) {
    ed.again();
    ed.add(4 * G, len, 67, 80);
  }
  ed.end();
  check(equal(brief(ed), ["0+1 C4", "4+3 G4"]) && ed.past.length === n + 1 && ed.future.length === 0, "a note drawn and dragged out is one note and one change");
}

// choosing
{
  const ed = new Editor(EXAMPLES.mary());
  const [a, b, c] = ed.part.notes;
  ed.select([a, b]);
  ed.select([b, c], true);
  check(equal([...ed.selected], [a, c]), "choosing more adds a note and lets go of one chosen already");
  ed.select([c]);
  check(equal([...ed.selected], [c]), "choosing afresh lets go of the rest");
}

// words typed under the notes
{
  check(equal(syllables("Ma-ry had a lit-tle lamb,"), ["Ma-", "ry", "had", "a", "lit-", "tle", "lamb,"]), "a word a note a syllable, a hyphen between a word's syllables");
  check(equal(syllables("wide__ wa_-ter is _ so"), ["wide", "_", "_", "wa-", "_", "ter", "is", "_", "so"]), "a _ for each further note a syllable holds, after it or standing alone");
  check(equal(syllables("one two\nthree_\n\nfour"), ["one", "two/", "three/", "_", "four"]), "a line typed ends a line of the lyric, on its last syllable");
  check(equal(syllables("Ma- ry/ had"), ["Ma-", "ry/", "had"]), "a syllable written as the part writes it is taken as it is");
  check(equal(syllables("  \n "), []), "nothing typed is no syllables");
  for (const bad of ["_ la", "a--b", "-a", "a_b", "/", "la //"]) check(threw(() => syllables(bad)) !== null, `${JSON.stringify(bad)} is not words`);
  for (const name of ["mary", "every"]) {
    const notes = EXAMPLES[name]().notes;
    check(equal(syllables(typed(notes)), notes.map((n) => n.lyric)), `${name}: its words as typed are its syllables again`);
  }
  check(typed(EXAMPLES.mary().notes).startsWith("Ma-ry had a lit-tle lamb,\nlit-tle lamb,\n"), "the words read as a lyric does");
  check(word(["lit-", "tle"]) === "little" && word(["“O-", "_", "ver,”/"]) === "Over" && word(["o'er."]) === "o'er", "a word for the engine: its syllables joined, no punctuation at its ends");

  const ed = new Editor(EXAMPLES.mary());
  ed.set(ed.part.notes, { lyric: null });
  const next = ed.words(ed.part.notes[0], "Ma-ry had a");
  check(equal(ed.part.notes.slice(0, 5).map((n) => n.lyric), ["Ma-", "ry", "had", "a", null]) && next === ed.part.notes[4], "words laid from a note on, and the note after them given back");
  check(ed.words(ed.part.notes[25], "snow.") === null, "the last note has none after it");
  const before = ed.part;
  check(threw(() => ed.words(ed.part.notes[24], "as white snow"))?.includes("3 syllables for the 2 notes from here") && ed.part === before, "more syllables than notes are refused, and nothing is laid");
}

// the vibrato's points
{
  const ed = fresh(), pts = () => ed.part.lanes.vibrato.map((q) => `${P.beat(q.at, G)}:${q.value}${q.line ? "/" : ""}`);
  check(ed.point("vibrato", 2 * G, 0.5) === 0 && ed.point("vibrato", 4 * G, 1.5) === 1 && ed.point("vibrato", G, 0) === 0, "a point's place among the others is given back");
  ed.point("vibrato", 2 * G, 0.75);
  check(equal(pts(), ["1:0", "2:0.75", "4:1.5"]), "a point put where one is takes its place");
  ed.line("vibrato", 2, true);
  ed.repoint("vibrato", 1, 9 * G, 2.5);
  check(equal(pts(), ["1:0", "3.998958:2.5", "4:1.5/"]), "a point dragged past the next stops a tick short of it");
  ed.repoint("vibrato", 2, 0, -3);
  check(equal(pts(), ["1:0", "3.998958:2.5", "4:0/"]), "one reached by a line, dragged back, stops a tick after the point before; no size is under 0");
  ed.repoint("vibrato", 1, 2 * G, 1);
  ed.line("vibrato", 1, true);
  ed.point("vibrato", 3 * G, 0.5);
  ed.repoint("vibrato", 2, 0, 0.5);
  check(equal(pts(), ["1:0", "2:1/", "2:0.5", "4:0/"]), "a point that holds may be dragged onto one reached by a line: the value arrives, then jumps");
  check(equal(ed.room("vibrato", 1), [G + 1, 2 * G]) && equal(ed.room("vibrato", 0), [0, 2 * G - 1]) && equal(ed.room("vibrato", 3), [2 * G + 1, Infinity]), "the room each point has between its neighbours");
  const before = ed.part;
  check(threw(() => ed.line("vibrato", 0, true))?.includes("the first point is reached by no line") && ed.part === before, "the first point cannot be reached by a line");
  check(threw(() => ed.line("vibrato", 2, true))?.includes("two points share a beat") && ed.part === before, "nor the second of two on a beat");
  ed.unpoint("vibrato", 0);
  check(equal(pts(), ["2:0.5", "4:0/"]), "the first point removed: of the two on the next beat the jump is the first now");
  ed.unpoint("vibrato", 0);
  check(equal(pts(), ["4:0"]), "and removed again: the point reached by a line holds");
}

// marks, tempo, meter, the singer, the title, another part
{
  const ed = fresh();
  ed.mark(4 * G);
  ed.mark(G);
  check(equal(ed.part.marks, [{ at: G, breath: true }, { at: 4 * G, breath: true }]), "a breath marked, in the order of their beats");
  ed.mark(G);
  check(equal(ed.part.marks[0], { at: G, breath: false }), "marked again: not to be taken");
  ed.mark(G);
  check(equal(ed.part.marks, [{ at: 4 * G, breath: true }]), "and again: no mark");
  ed.tempo(8 * G, 90);
  ed.tempo(0, 100);
  ed.meter(4 * G, 3, 4);
  check(equal(ed.part.tempo, [{ at: 0, bpm: 100 }, { at: 8 * G, bpm: 90 }]) && equal(ed.part.meter, [{ at: 0, n: 4, d: 4 }, { at: 4 * G, n: 3, d: 4 }]), "a tempo and a meter set from a beat on");
  ed.tempo(8 * G, null);
  check(ed.part.tempo.length === 1 && threw(() => ed.tempo(0, null))?.includes("no tempo") && threw(() => ed.meter(0, null))?.includes("the first meter is on beat 0"), "one taken away; the first of each stays");
  ed.singer("shift", -12);
  ed.title("  A tune ");
  check(ed.part.singer.shift === -12 && ed.part.title === "A tune" && threw(() => ed.singer("breath", 2))?.includes("a chance") && threw(() => ed.singer("reverb", 1)) !== null, "the singer and the title set; what a singer has not is refused");
  check(ed.changed, "the part has changed since it was read");
  const mary = EXAMPLES.mary();
  ed.load(mary);
  check(ed.part === mary && !ed.changed && ed.selected.size === 0, "another part in its place is as read");
  check(ed.undo() && ed.part.title === "A tune" && ed.changed, "and opening it is undone like any change");
}

// bars and beats, the snap, the roll
{
  const every = EXAMPLES.every();
  const drawn = bars(every, 0, 14 * G).map((b) => `${b.tick / G}${b.bar === null ? "" : `|${b.bar}`}`);
  check(equal(drawn, ["0|1", "1", "2", "3|2", "4", "5", "6|3", "7", "8", "9", "10|4", "11", "12", "13", "14|5"]), "3/4 for two bars, then 4/4, the bars counted through");
  check(equal(bars(every, 9.5 * G, 11 * G).map((b) => [b.tick / G, b.bar, b.beat]), [[10, 4, 1], [11, null, 2]]), "only the lines in sight");
  const eight = { ...P.blank(P.singer("a")), meter: [{ at: 0, n: 6, d: 8 }] };
  check(equal(bars(eight, 0, 3 * G).map((b) => [b.tick / G, b.bar]), [[0, 1], [0.5, null], [1, null], [1.5, null], [2, null], [2.5, null], [3, 2]]), "6/8: a line each eighth");
  check(equal(steps(960).map((s) => s.ticks), [960, 480, 320, 240, 160, 120, 80, 60, 1]) && equal(steps(96).map((s) => s.name), ["1 beat", "1/2", "1/3", "1/4", "1/6", "1/8", "1/12", "1/16", "tick"]) && equal(steps(100).map((s) => s.ticks), [100, 50, 25, 1]), "the steps a grid has whole ticks for");
  check(snap(250, 240) === 240 && snap(370, 240) === 480 && snap(-90, 240) === 0, "the snap, to the nearest step, not before the start");

  const v = new View({ left: 0, wide: 0.1, top: 72, tall: 10 });
  check(v.x(960) === 96 && v.tick(96) === 960 && v.y(72) === 0 && v.y(60) === 120 && v.key(0) === 72 && v.key(9.9) === 72 && v.key(10) === 71 && v.key(125) === 60, "ticks along and keys down");
  v.zoom(2, 96);
  check(v.wide === 0.2 && Math.abs(v.tick(96) - 960) < 1e-9, "widened about a place, the tick under it stays there");
  v.zoom(1e9, 0);
  check(v.wide === 4, "no wider than four pixels a tick");
  v.zoom(1e-12, 500);
  check(v.wide === 0.002 && v.left === 0, "no narrower than a five-hundredth, and not before the start");
  v.heighten(2, 0);
  check(v.tall === 20 && v.key(0) === 72, "heightened about a place, the key under it stays there");
  v.scroll(-50, 0, 300);
  v.scroll(0, -1e6, 300);
  check(v.left === 0 && v.top === 127, "scrolled no further than the start and the top key");
  v.scroll(0, 1e6, 300);
  check(v.key(299) === 0, "nor further than the bottom key");
  const mary = EXAMPLES.mary(), f = new View();
  f.fit(mary, 1000, 280);
  check(f.left === 0 && f.x(36 * 480) < 1000 && f.x(36 * 480) > 900 && f.y(67) > 0 && f.y(60) + f.tall < 280, "a part fitted is all in sight");
  check(threw(() => f.fit(mary, 0, 280)) !== null && threw(() => f.fit(mary, -80, 280)) !== null && threw(() => f.fit(mary, 1000, 0)) !== null, "no fitting to no room");

  const [a] = mary.notes;
  check(hit(mary, 4 * 480, 64, 30)?.note === a && hit(mary, 4 * 480 + 479, 64, 30).end && !hit(mary, 4 * 480 + 200, 64, 30).end && hit(mary, 4 * 480, 65, 30) === null && hit(mary, 3 * 480, 64, 30) === null, "the note under the mouse, and whether its end is");
  check(sounding(mary, 4 * 480 + 10) === a && sounding(mary, 0) === null && sounding(mary, 11.75 * 480) === null, "the note sounding at a tick, none in a rest");
}

// where the clicks fall
{
  const every = EXAMPLES.every(), g = every.grid;
  check(equal(clicks(every, 10 * g).map((c) => [c.tick / g, c.accent]), [[0, true], [1, false], [2, false], [3, true], [4, false], [5, false], [6, true], [7, false], [8, false], [9, false], [10, true]]), "a click a beat, an accent on each bar's first, through a change of meter");
  const row = EXAMPLES.row(), h = row.grid;
  check(equal(clicks(row, 6 * h).map((c) => [c.tick / h, c.accent]), [[0, true], [1.5, false], [3, true], [4.5, false], [6, true]]), "in six eight, a click every three eighths");
  const three = { ...row, meter: [{ at: 0, n: 3, d: 8 }] };
  check(equal(clicks(three, 2 * h).map((c) => [c.tick / h, c.accent]), [[0, true], [0.5, false], [1, false], [1.5, true], [2, false]]), "in three eight, a click an eighth");
}

// ---- a value and what it was
{
  const h = new History("a"), pushed = [];
  h.pushed = (x) => pushed.push(x.value);
  h.commit("b");
  h.begin();
  h.commit("c");
  h.again();
  h.commit("d");
  h.end();
  check(h.value === "d" && h.past.length === 2 && pushed.length === 2, "a history takes each value; a drag's many are one step");
  check(h.undo() && h.value === "b" && h.undo() && h.value === "a" && !h.undo(), "back through them, and no further");
  check(h.redo() && h.redo() && h.value === "d" && !h.redo(), "and on again");
  h.undo();
  h.commit("e");
  check(!h.redo() && h.value === "e", "a new value after a step back leaves nothing to go on to");
}

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
