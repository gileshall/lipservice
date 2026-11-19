// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The example parts, written beside this script as text (.part) and as MIDI files (.mid), and
// the plugin's own MIDI file of Mary beside them as it is (mary-pedal.mid):
//
//   node make.mjs
//
// menu.js names the ones the editor's Examples menu has.
//
// mary        Mary Had a Little Lamb as the plugin's songs have it (plugin/songs/mary-pedal.mid),
//             given a singer and a title. Words: Sarah Josepha Hale, 1830. Tune: Lowell Mason,
//             1831. Both public domain.
// twinkle     Twinkle, Twinkle, Little Star. Words: Jane Taylor, 1806. Tune: "Ah! vous dirai-je,
//             maman", printed 1761. Both public domain. A man's part, a breath's rest at each
//             line's end.
// grace       Amazing Grace, its first verse. Words: John Newton, 1779. Tune: New Britain,
//             printed 1829. Both public domain. In three, from an upbeat, with syllables held
//             over two notes, the vibrato drawn wider through the long notes, and breaths marked.
// row         Row, Row, Row Your Boat. Words printed 1852; tune: Eliphalet Oriel Lyte, 1881. Both
//             public domain. In six eight.
// every       every line a part can have, in a part that can be sung: a change of meter and of
//             tempo, a third of a beat, a held syllable, cents, the vibrato held and drawn, a
//             breath marked in a rest, one marked where there is no rest, and one marked not to
//             be taken. Tune and words written here.
// unfinished  what a part may hold before it can be sung: notes with no words, two notes at
//             once, a word left open, a mark in no rest. Written here.
//
// A second reader of the format is checked against these files; part_test.mjs and midi_test.mjs
// check that they are what this script writes.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as P from "../part.js";
import * as M from "../midi.js";
import * as S from "../score.js";

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

export function mary() {
  const bytes = new Uint8Array(readFileSync(here("../../plugin/songs/mary-pedal.mid")));
  const { part } = M.read(bytes, { singer: P.singer("6147", 3) });
  return { ...part, title: "Mary Had a Little Lamb" };
}

// [beats from the part's start, beats long, pitch, velocity, release, lyric]
const note = (grid) => ([at, beats, pitch, velocity, release, lyric = null]) => {
  const m = /^(.*?\d)([+-]\d.*)?$/.exec(pitch);
  return { at: Math.round(at * grid), ticks: Math.round(beats * grid), pitch: m[1], cents: m[2] ? Number(m[2]) : 0, velocity, release, lyric };
};
const point = (grid) => ([at, value, line = false]) => ({ at: Math.round(at * grid), value, line });

// A tune written in order from beat `at`: [beats long, pitch (null: a rest), velocity, lyric].
const run = (grid, at, rows) => {
  const out = [];
  for (const [beats, pitch, velocity, lyric] of rows) {
    if (pitch !== null) out.push(note(grid)([at, beats, pitch, velocity, 64, lyric]));
    at += beats;
  }
  return out;
};

export function twinkle() {
  const grid = 480;
  const line = (keys, words, loud) => keys.map((k, i) => [i === 6 ? 1.5 : 1, k, loud + (i % 2 ? -8 : 0) + (i === 6 ? 4 : 0), words[i]]).concat([[0.5, null]]);
  const first = ["C3", "C3", "G3", "G3", "A3", "A3", "G3"], second = ["F3", "F3", "E3", "E3", "D3", "D3", "C3"], third = ["G3", "G3", "F3", "F3", "E3", "E3", "D3"];
  return {
    title: "Twinkle, Twinkle, Little Star",
    grid,
    singer: P.singer("2428", 5),
    tempo: [{ at: 0, bpm: 96 }],
    meter: [{ at: 0, n: 4, d: 4 }],
    notes: run(grid, 0, [
      ...line(first, ["Twin-", "kle,", "twin-", "kle,", "lit-", "tle", "star,/"], 76),
      ...line(second, ["How", "I", "won-", "der", "what", "you", "are!/"], 72),
      ...line(third, ["Up", "a-", "bove", "the", "world", "so", "high,/"], 84),
      ...line(third, ["Like", "a", "dia-", "mond", "in", "the", "sky./"], 80),
      ...line(first, ["Twin-", "kle,", "twin-", "kle,", "lit-", "tle", "star,/"], 70),
      ...line(second, ["How", "I", "won-", "der", "what", "you", "are!/"], 64),
    ]),
    lanes: { vibrato: [] },
    marks: [],
  };
}

export function grace() {
  const grid = 480;
  return {
    title: "Amazing Grace",
    grid,
    singer: { ...P.singer("6345", 7), glide: 12 },
    tempo: [{ at: 0, bpm: 80 }],
    meter: [{ at: 0, n: 3, d: 4 }],
    notes: run(grid, 2, [
      [1, "D4", 60, "A-"],
      [2, "G4", 78, "ma-"], [0.5, "B4", 70, "zing"], [0.5, "G4", 64, "_"],
      [2, "B4", 86, "grace!"], [1, "A4", 68, "(how"],
      [2, "G4", 80, "sweet"], [1, "E4", 62, "the"],
      [2, "D4", 74, "sound)/"], [1, "D4", 62, "That"],
      [2, "G4", 82, "saved"], [0.5, "B4", 72, "a"], [0.5, "G4", 66, "_"],
      [2, "B4", 90, "wretch"], [1, "A4", 74, "like"],
      [4, "D5", 100, "me!/"], [1, null],
      [0.5, "B4", 70, "I"], [0.5, "D5", 76, "_"],
      [2, "D5", 96, "once"], [1, "B4", 78, "was"],
      [2, "G4", 84, "lost,"], [1, "D4", 62, "but"],
      [2, "E4", 76, "now"], [0.5, "G4", 68, "am"], [0.5, "E4", 62, "_"],
      [2, "D4", 72, "found,/"], [1, "D4", 58, "Was"],
      [2, "G4", 78, "blind,"], [0.5, "B4", 70, "but"], [0.5, "G4", 64, "_"],
      [2, "B4", 84, "now"], [1, "A4", 68, "I"],
      [5, "G4", 74, "see./"],
    ]),
    lanes: {
      // its own size, wider through "me" and wider still through "see"
      vibrato: [[2, 1], [21.5, 1], [24, 1.6, true], [25, 1], [45.5, 1], [49, 1.8, true], [50, 1, true]].map(point(grid)),
    },
    // a breath after "sound" where no rest is written, one in the rest after "me", one after "found"
    marks: [{ at: 14 * grid, breath: true }, { at: 26 * grid, breath: true }, { at: 38 * grid, breath: true }],
  };
}

export function row() {
  const grid = 480;
  const three = (k, loud, word) => [[0.5, k, loud, word[0]], [0.5, k, loud - 10, word[1]], [0.5, k, loud - 14, word[2]]];
  const merrily = ["Mer-", "ri-", "ly,"], again = ["mer-", "ri-", "ly,"];
  return {
    title: "Row, Row, Row Your Boat",
    grid,
    singer: P.singer("6209", 2),
    tempo: [{ at: 0, bpm: 100 }],
    meter: [{ at: 0, n: 6, d: 8 }],
    notes: run(grid, 0, [
      [1.5, "C3", 80, "Row,"], [1.5, "C3", 76, "row,"],
      [1, "C3", 80, "row"], [0.5, "D3", 66, "your"], [1.5, "E3", 84, "boat,/"],
      [1, "E3", 78, "Gent-"], [0.5, "D3", 64, "ly"], [1, "E3", 76, "down"], [0.5, "F3", 66, "the"],
      [2.5, "G3", 90, "stream./"], [0.5, null],
      ...three("C4", 96, merrily), ...three("G3", 90, again),
      ...three("E3", 84, again), ...three("C3", 78, ["mer-", "ri-", "ly,/"]),
      [1, "G3", 82, "Life"], [0.5, "F3", 68, "is"], [1, "E3", 76, "but"], [0.5, "D3", 64, "a"],
      [3, "C3", 72, "dream./"],
    ]),
    lanes: { vibrato: [] },
    marks: [],
  };
}

export function every() {
  const grid = 960;
  return {
    title: "Every line of a part: étude, 100%",
    grid,
    singer: { voice: "4446", seed: 11, shift: -2, join: 0.25, glide: 12, dynamics: 0.8, breathiness: 0.5, diction: false, motion: null, sway: 1.25, jitter: 3, detune: 4.5, spread: 0.015, breath: 0.6 },
    tempo: [{ at: 0, bpm: 72 }, { at: 14 * grid, bpm: 60.5 }],
    meter: [{ at: 0, n: 3, d: 4 }, { at: 6 * grid, n: 4, d: 4 }],
    notes: [
      [1, 1, "D4", 70, 64, "Slow-"], [2, 1, "E4", 64, 64, "ly"], [3, 2, "F#4", 88, 40, "now"], [5, 1, "E4", 60, 20, "_"],
      [6.5, 0.5, "D4", 52, 64, "the"], [7, 1, "G4", 96, 64, "riv-"], [8, 0.5, "F#4", 70, 64, "er"], [8.5, 1.5, "E4+14", 80, 30, "turns,/"],
      [10, 1 / 3, "Bb3", 66, 64, "o-"], [10 + 1 / 3, 1 / 3, "C4", 72, 64, "ver"], [10 + 2 / 3, 1 / 3 + 1, "D4", 90, 64, "stone"],
      [12, 1, "B3-15.6", 58, 64, "and"], [13, 0.5, "C#4", 62, 64, "un-"], [13.5, 0.5, "D4", 66, 64, "der"],
      [14, 3, "A3", 100, 10, "sky."], [17, 3, "D4", 84, 0, "_"],
    ].map(note(grid)),
    lanes: {
      vibrato: [[1, 0.5], [3, 0.5], [5, 1.5, true], [6, 0], [8.5, 0.25], [10, 1.25, true], [10, 0.75], [14, 0.75], [17, 2.5, true], [20, 0, true]].map(point(grid)),
    },
    marks: [{ at: grid, breath: false }, { at: Math.round(6.5 * grid), breath: true }, { at: 12 * grid, breath: true }],
  };
}

export function unfinished() {
  const grid = 96;
  return {
    title: "",
    grid,
    singer: P.singer("2428"),
    tempo: [{ at: 0, bpm: 120 }],
    meter: [{ at: 0, n: 4, d: 4 }],
    notes: [
      [0, 1, "C3", 64, 64], [1, 2, "E3", 64, 64, "A-"], [2, 2, "G3", 64, 64], [2, 1, "Bb3", 64, 64, "ha/"], [4, 1, "C4", 1, 127, "_"], [6, 1, "Dbb4", 127, 0, "Ma-"],
    ].map(note(grid)),
    lanes: { vibrato: [] },
    marks: [{ at: Math.round(1.5 * grid), breath: true }],
  };
}

export const EXAMPLES = { mary, twinkle, grace, row, every, unfinished };

// The plugin's file of Mary, as it is: a MIDI file from elsewhere, with no part inside.
// Row, Row, Row Your Boat as the round it is: three singers, each two bars after the one before,
// each through the tune twice; the middle one a woman an octave up. A little room on the master.
// At these levels the three together go no higher than 4 dB under full scale: its limiter is a net.
export function round() {
  const tune = row(), long = 24 * tune.grid, wait = 6 * tune.grid;
  const twice = (notes) => [...notes, ...notes.map((n) => ({ ...n, at: n.at + long }))];
  const voice = (name, who, seed, enter, up) => ({
    ...tune,
    title: name,
    singer: P.singer(who, seed),
    notes: twice(tune.notes).map((n) => ({ ...n, at: n.at + enter * wait, pitch: P.name(P.key(n.pitch) + up) })),
  });
  return {
    title: "Row, Row, Row Your Boat: a round for three",
    master: 0,
    chain: [{ ...S.effect("reverb"), seconds: 1.4, mix: 0.16 }, S.effect("limiter")],
    singers: [
      { ...S.strip(), pan: -0.55, part: voice("Finn", "6209", 2, 0, 0) },
      { ...S.strip(), level: -1.5, part: voice("Cora", "6345", 5, 1, 12) },
      { ...S.strip(), pan: 0.55, part: voice("Ben", "2428", 9, 2, 0) },
    ],
  };
}
export const SCORES = { round };

export const BORROWED = { "mary-pedal.mid": "../../plugin/songs/mary-pedal.mid" };

// What an example's files hold: [name, bytes or text].
export function files(name) {
  const part = EXAMPLES[name]();
  return [[`${name}.part`, P.write(part)], [`${name}.mid`, M.write(part)]];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const name of Object.keys(EXAMPLES)) {
    for (const [file, data] of files(name)) {
      writeFileSync(here(file), data);
      console.log(`${file}: ${data.length} ${typeof data === "string" ? "characters" : "bytes"}`);
    }
  }
  for (const [name, make] of Object.entries(SCORES)) {
    const data = S.write(make());
    writeFileSync(here(`${name}.score`), data);
    console.log(`${name}.score: ${data.length} characters`);
  }
  for (const [file, from] of Object.entries(BORROWED)) {
    const data = readFileSync(here(from));
    writeFileSync(here(file), data);
    console.log(`${file}: ${data.length} bytes, as ${from}`);
  }
}
