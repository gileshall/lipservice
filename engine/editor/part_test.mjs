// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// part.js: a part read back as written, the text's own shapes, and every malformed line refused
// by name. node part_test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as P from "./part.js";
import { EXAMPLES, files } from "./examples/make.mjs";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const here = (name) => fileURLToPath(new URL(name, import.meta.url));

// every example reads back as the part it was written from, and writes back to the same text
for (const name of Object.keys(EXAMPLES)) {
  const part = EXAMPLES[name](), text = P.write(part);
  check(equal(P.read(text), part), `${name}: read back as written`);
  check(P.write(P.read(text)) === text, `${name}: written back to the same text`);
  check(readFileSync(here(`examples/${name}.part`), "utf8") === text, `${name}: examples/${name}.part is what make.mjs writes`);
}

// a part with nothing in it
{
  const p = P.blank(P.singer("6147", 3));
  check(equal(P.read(P.write(p)), p), "a blank part reads back");
  check(P.write(p).startsWith("lipservice part 2\ntitle\ngrid 960\n\nvoice 6147\nseed 3\nshift 0\n"), "a blank part's head");
  check(P.write(p).endsWith("breath 0.85\n\ntempo 0 120\nmeter 0 4/4\n"), "a blank part's end");
}

// every tick of a grid is written as a beat that reads back to it
{
  let bad = 0, n = 0;
  for (const grid of [1, 3, 96, 384, 480, 960, 1024, 15360, 32767]) {
    const p = P.blank(P.singer("a"), grid);
    const ticks = new Set([0, 1, grid - 1, grid, grid + 1, 7 * grid + Math.floor(grid / 3), 1000 * grid - 1, 99999 * grid + Math.floor(grid / 7)]);
    for (let t = 0; t < Math.min(grid * 2, 4000); t++) ticks.add(t);
    p.notes = P.sort([...ticks].map((at) => ({ at, ticks: at + 1, pitch: "C4", cents: 0, velocity: 64, release: 64, lyric: null })));
    const back = P.read(P.write(p));
    n += p.notes.length;
    bad += back.notes.filter((x, i) => x.at !== p.notes[i].at || x.ticks !== p.notes[i].ticks).length;
  }
  check(bad === 0, `${n} starts and lengths over nine grids read back to their ticks`);
  check(P.beat(320, 960) === "0.333333" && P.beat(640, 960) === "0.666667" && P.beat(1440, 960) === "1.5" && P.beat(0, 960) === "0" && P.beat(9600, 960) === "10", "beats as written");
}

// the text as a person may leave it: tabs, runs of spaces, blank lines, CRLF, a byte order mark,
// no last line end, the lines in another order, flats and a spelled-out +0
{
  const part = EXAMPLES.every(), text = P.write(part);
  const lines = text.trimEnd().split("\n");
  const loose = "﻿" + [lines[0], ...lines.slice(1).reverse().filter((l) => !/^(note|vibrato|mark|tempo|meter|grid) /.test(l)), "", "", ...lines.filter((l) => l.startsWith("grid ")), ...lines.filter((l) => /^(note|vibrato|mark|tempo|meter) /.test(l)).map((l) => `  ${l.replace(/ /g, " \t ")}  `)].join("\r\n");
  check(equal(P.read(loose), part), "a part with its lines moved about, tabs, CRLF and a byte order mark reads the same");
  check(P.write(P.read(loose)) === text, "and is written back as the writer writes it");
  const p = P.read(text.replace("note 1 1 D4 70 64", "note 1.0 1.000000 D4+0 70 64").replace("vibrato 6 0\n", "vibrato 6.00 0.0\n"));
  check(equal(p, part), "1.0, 1.000000, +0 and 0.0 read as 1, 1, no cents and 0");
}

// keys and their names
{
  check(P.key("C4") === 60 && P.key("C-1") === 0 && P.key("G9") === 127 && P.key("F#3") === 54 && P.key("Bb2") === 46 && P.key("Dbb4") === 60 && P.key("B##3") === 61, "keys by name");
  check([0, 60, 61, 70, 127].map(P.name).join(" ") === "C-1 C4 C#4 A#4 G9", "names of keys");
  check([...Array(128).keys()].every((k) => P.key(P.name(k)) === k), "every key's name spells it");
  for (const bad of ["H4", "C", "c4", "C#b4", "C###4", "G#9", "Cb-1", "C4.5", "4", ""]) check(threw(() => P.key(bad)) !== null, `no key ${JSON.stringify(bad)}`);
  const pitches = (s) => P.read(P.write(P.blank(P.singer("a"))) + `note 0 1 ${s} 64 64\n`).notes[0];
  check(equal([pitches("E4+14"), pitches("B3-15.6"), pitches("C-1+99.5"), pitches("C-1-99"), pitches("Bb2")].map((n) => [n.pitch, n.cents]), [["E4", 14], ["B3", -15.6], ["C-1", 99.5], ["C-1", -99], ["Bb2", 0]]), "a pitch is a key and its cents");
}

// a note's syllable
{
  for (const ok of ["Ma-", "ry", "_", "lamb,/", "Ma-/", "o'er", "x-y", "x-y-", "é-", "snow.", "!"]) check(P.lyrical(ok), `${JSON.stringify(ok)} is a note's lyric`);
  for (const bad of ["", "-", "/", "a b", "a_", "__", "_-", "_/", "a/b", "a--", "a//", "a/-", "-a-b--", null, 3]) check(!P.lyrical(bad), `${JSON.stringify(bad)} is not`);
  check(equal([P.syllable("Ma-"), P.syllable("ry"), P.syllable("lamb,/"), P.syllable("x-y-/"), P.syllable("_")], [{ text: "Ma", on: true, end: false }, { text: "ry", on: false, end: false }, { text: "lamb,", on: false, end: true }, { text: "x-y", on: true, end: true }, null]), "a syllable apart");
}

// a lane's value along the part
{
  const pts = [[10, 0.5], [30, 0.5], [50, 1.5, true], [60, 0], [100, 1, true], [100, 3]].map(([at, value, line = false]) => ({ at, value, line }));
  const at = (t) => P.at(pts, t, 1);
  check(equal([0, 9, 10, 29, 30, 40, 50, 59, 60, 80, 99, 100, 5000].map(at), [1, 1, 0.5, 0.5, 0.5, 1, 1.5, 1.5, 0, 0.5, 0.975, 3, 3]), "a lane holds, is drawn, and jumps");
  check(P.at([], 7, 1) === 1, "an empty lane is at rest");
}

// what is not a part is refused, and the line is named
{
  const text = P.write(EXAMPLES.every());
  const lineOf = (s) => text.split("\n").findIndex((l) => l.startsWith(s)) + 1;
  for (const [from, to, why] of [
    ["lipservice part 2", "lipservice part 1", "its first line"],
    ["lipservice part 2", "lipservice part 3", "its first line"],
    ["seed 11\n", "", "the part has no seed"],
    ["title Every line of a part: étude, 100%\n", "", "the part has no title"],
    ["grid 960\n", "", "a beat before the grid"],
    ["seed 11", "seed 11\nseed 12", "seed given twice"],
    ["grid 960", "grid 960\ngrid 960", "grid given twice"],
    ["seed 11", "seed x", "seed is a number"],
    ["seed 11", "seed 1.5", "a whole number, 0 to 4294967295"],
    ["seed 11", "seed 4294967296", "a whole number, 0 to 4294967295"],
    ["seed 11", "seed 11 12", "seed takes one value"],
    ["shift -2", "shift 1e3", "shift is a number"],
    ["shift -2", "shift --2", "shift is a number"],
    ["join 0.25", "join -1", "0 or more"],
    ["glide 12", "glide 0", "1 at least"],
    ["diction 0", "diction 2", "0 or 1"],
    ["motion -", "motion wide vibrato", "motion takes one value"],
    ["motion -", "motion a.b", "a name, or - for none"],
    ["jitter 3", "jitter 3.5", "a whole number, 0 or more"],
    ["breath 0.6", "breath 2", "a chance, 0 to 1"],
    ["voice 4446", "voice", "voice takes one value"],
    ["grid 960", "grid 0", "1 to 32767"],
    ["grid 960", "grid 32768", "1 to 32767"],
    ["grid 960", "grid 96.5", "a whole number"],
    ["sway 1.25", "sway 1.25\nreverb 3", "\"reverb\": no such line"],
    ["sway 1.25", "sway 1.25\n# a comment", "\"#\": no such line"],
    ["tempo 0 72", "tempo 1 72", "the first tempo is on beat 0"],
    ["tempo 14 60.5", "tempo 0 60.5", "after the one before it"],
    ["tempo 14 60.5", "tempo 14 3", "4 to 60000000"],
    ["tempo 14 60.5", "tempo 14", "tempo takes a beat and"],
    ["meter 6 4/4", "meter 6 4/3", "meter 4/3"],
    ["meter 6 4/4", "meter 6 0/4", "meter 0/4"],
    ["meter 6 4/4", "meter 6 4/64", "meter 4/64"],
    ["meter 6 4/4", "meter 6 common", "a meter is as 4/4"],
    ["meter 0 3/4", "meter 0.5 3/4", "the first meter is on beat 0"],
    ["note 2 1 E4 64 64 ly", "note 2 1 E4 64 64 ly ric", "a note is its start"],
    ["note 2 1 E4 64 64 ly", "note 2 1 E4 64", "a note is its start"],
    ["note 2 1 E4 64 64 ly", "note 2 0 E4 64 64 ly", "not a tick at least"],
    ["note 2 1 E4 64 64 ly", "note -2 1 E4 64 64 ly", "in beats, 0 or more"],
    ["note 2 1 E4 64 64 ly", "note 2 1 H4 64 64 ly", "a pitch is a key"],
    ["note 2 1 E4 64 64 ly", "note 2 1 64 64 64 ly", "a pitch is a key"],
    ["note 2 1 E4 64 64 ly", "note 2 1 E4+100 64 64 ly", "100 cents"],
    ["note 2 1 E4 64 64 ly", "note 2 1 G#9 64 64 ly", "outside MIDI's keys"],
    ["note 2 1 E4 64 64 ly", "note 2 1 E4 0 64 ly", "velocity 0"],
    ["note 2 1 E4 64 64 ly", "note 2 1 E4 128 64 ly", "velocity 128"],
    ["note 2 1 E4 64 64 ly", "note 2 1 E4 64 128 ly", "release 128"],
    ["note 2 1 E4 64 64 ly", "note 2 1 E4 64 6.4 ly", "a whole number"],
    ["note 2 1 E4 64 64 ly", "note 2 1 E4 64 64 l_y", "a syllable is its letters"],
    ["note 2 1 E4 64 64 ly", "note 2 1 E4 64 64 -", "a syllable is its letters"],
    ["note 2 1 E4 64 64 ly", "note 0.5 1 E4 64 64 ly", "in the order of their starts"],
    ["note 2 1 E4 64 64 ly", "note 1 1 C4 64 64 ly", "the lower key first"],
    ["note 2 1 E4 64 64 ly", "note 2.0001 1 E4 64 64 ly", "on no tick of a grid of 960"],
    ["note 10.333333 0.333333", "note 10.33 0.333333", "on no tick of a grid of 960"],
    ["vibrato 1 0.5", "vibrato 1 0.5 line", "the first point is reached by no line"],
    ["vibrato 5 1.5 line", "vibrato 5 1.5 curve", "vibrato takes a beat and a value"],
    ["vibrato 5 1.5 line", "vibrato 5 -1 line", "not a number 0 or more"],
    ["vibrato 6 0", "vibrato 4 0", "before the point before it"],
    ["vibrato 6 0", "vibrato 5 0\nvibrato 5 1", "two points share a beat only where"],
    ["vibrato 10 0.75", "vibrato 10 0.75 line", "two points share a beat only where"],
    ["vibrato 3 0.5", "vibrato 1 0.5", "two points share a beat only where"],
    ["mark 12 breath", "mark 12 sigh", "a mark is breath or nobreath"],
    ["mark 12 breath", "mark 6.5 nobreath", "one to a beat"],
    ["mark 12 breath", "mark 12", "mark takes a beat"],
  ]) {
    const n = text.split(from).length - 1;
    const e = n === 1 ? threw(() => P.read(text.replace(from, to))) : `"${from}" is in the text ${n} times`;
    check(e !== null && e.includes(why), `${JSON.stringify(to)} for ${JSON.stringify(from)} is refused: ${why}`);
    if (e !== null && !e.includes(why)) console.log(`     ${e}`);
  }
  // the line a fault is on
  check(threw(() => P.read(text.replace("glide 12", "glide 0"))).startsWith(`line ${lineOf("glide")}: `), "a setting's fault names its line");
  check(threw(() => P.read(text.replace("note 8 0.5 F#4", "note 8 0.5 F#44"))).startsWith(`line ${lineOf("note 8 ")}: `), "a note's fault names its line");
  check(threw(() => P.read(text.replace("vibrato 6 0", "vibrato 4 0"))).startsWith(`line ${lineOf("vibrato 6 ")}: `), "a point's fault names its line");
  check(threw(() => P.read("")) !== null && threw(() => P.read("lipservice part 2")) !== null && threw(() => P.read(7)) !== null, "nothing, a head alone and a number are no part");
}

// a part the text cannot hold is not written
{
  const good = () => EXAMPLES.every();
  for (const [why, spoil] of [
    ["a title of two lines", (p) => { p.title = "a\nb"; }],
    ["a title with a space at its end", (p) => { p.title = "a "; }],
    ["a seed that is no whole number", (p) => { p.singer.seed = 1.5; }],
    ["a setting the format has not", (p) => { p.singer.reverb = 1; }],
    ["a setting missing", (p) => { delete p.singer.sway; }],
    ["a number too small to write", (p) => { p.singer.spread = 1e-9; }],
    ["a note off the ticks", (p) => { p.notes[0].at = 0.5; }],
    ["a note with no length", (p) => { p.notes[0].ticks = 0; }],
    ["notes out of order", (p) => { p.notes.reverse(); }],
    ["100 cents", (p) => { p.notes[0].cents = -100; }],
    ["a lyric of two words", (p) => { p.notes[0].lyric = "a b"; }],
    ["no tempo", (p) => { p.tempo = []; }],
    ["no meter", (p) => { p.meter = []; }],
    ["a lane the format has not", (p) => { p.lanes.loudness = []; }],
    ["a mark that is neither", (p) => { p.marks[0].breath = "yes"; }],
    ["a vibrato that is not a number", (p) => { p.lanes.vibrato[0].value = NaN; }],
  ]) {
    const p = good();
    spoil(p);
    check(threw(() => P.write(p)) !== null, `not written: ${why}`);
  }
}

// the examples' files are what make.mjs writes
for (const name of Object.keys(EXAMPLES)) {
  for (const [file, data] of files(name)) {
    const on = readFileSync(here(`examples/${file}`));
    check(typeof data === "string" ? on.toString("utf8") === data : Buffer.compare(on, Buffer.from(data)) === 0, `examples/${file} is what make.mjs writes`);
  }
}

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
