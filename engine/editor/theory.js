// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// Keys and scales: which keys are in a key, steps along its scale, its names for the notes, its
// chords, and the key a stretch of notes is likeliest in. No DOM: the page and node both use it.
//
// A key here is {tonic, scale}: the tonic a pitch class, 0 to 11 (C 0, C# 1, ... B 11), the scale a
// name of SCALES. A note is a MIDI key, 0 to 127 (C4 is 60), and its name is as part.js writes a
// pitch ("Bb4"). Only written keys are moved and named here. A note's cents are its own, and
// nothing here reaches the pitch the singer sings.

import * as P from "./part.js";

// steps: semitones from the tonic, rising. from: the step of a major scale this scale starts on,
// which gives its signature (dorian 2: D dorian has C major's). letters: the letter each step
// takes, counted from the tonic's, or null for a scale named by its signature alone.
const SEVEN = [0, 1, 2, 3, 4, 5, 6];
export const SCALES = Object.freeze({
  "major": { steps: [0, 2, 4, 5, 7, 9, 11], from: 0, letters: SEVEN },
  "natural minor": { steps: [0, 2, 3, 5, 7, 8, 10], from: 9, letters: SEVEN },
  "harmonic minor": { steps: [0, 2, 3, 5, 7, 8, 11], from: 9, letters: SEVEN },
  "melodic minor": { steps: [0, 2, 3, 5, 7, 9, 11], from: 9, letters: SEVEN },
  "dorian": { steps: [0, 2, 3, 5, 7, 9, 10], from: 2, letters: SEVEN },
  "phrygian": { steps: [0, 1, 3, 5, 7, 8, 10], from: 4, letters: SEVEN },
  "lydian": { steps: [0, 2, 4, 6, 7, 9, 11], from: 5, letters: SEVEN },
  "mixolydian": { steps: [0, 2, 4, 5, 7, 9, 10], from: 7, letters: SEVEN },
  "locrian": { steps: [0, 1, 3, 5, 6, 8, 10], from: 11, letters: SEVEN },
  "major pentatonic": { steps: [0, 2, 4, 7, 9], from: 0, letters: [0, 1, 2, 4, 5] },
  "minor pentatonic": { steps: [0, 3, 5, 7, 10], from: 9, letters: [0, 2, 3, 4, 6] },
  "blues": { steps: [0, 3, 5, 6, 7, 10], from: 9, letters: [0, 2, 3, 4, 4, 6] },
  "whole tone": { steps: [0, 2, 4, 6, 8, 10], from: 0, letters: null },
  "chromatic": { steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], from: 0, letters: null },
});
for (const s of Object.values(SCALES)) Object.freeze(s);

// the scales in the order a person picks from them
export const SCALE_NAMES = Object.freeze(Object.keys(SCALES));

// what a key is called when it is read: names() says "minor" for the natural minor
const ALIASES = { "minor": "natural minor", "ionian": "major", "aeolian": "natural minor" };

const LETTERS = "CDEFGAB";
const NATURAL = [0, 2, 4, 5, 7, 9, 11];
const MAJOR = SCALES.major.steps;
const mod = (a, n) => ((a % n) + n) % n;

// the key's scale; throws what is wrong with the key
function known(key) {
  if (!key || typeof key !== "object" || !Number.isInteger(key.tonic) || key.tonic < 0 || key.tonic > 11 || !Object.hasOwn(SCALES, key.scale)) {
    throw new Error(`${JSON.stringify(key)}: a key is a tonic, 0 to 11, and a scale: ${SCALE_NAMES.join(", ")}`);
  }
  return SCALES[key.scale];
}

function keyed(k) {
  if (!Number.isInteger(k) || k < 0 || k > 127) throw new Error(`key ${k}: 0 to 127`);
  return k;
}

// ---------------------------------------------------------------- spelling

// semitones from letter `l`'s natural to pitch class `pc`, -6 to 5
const accidental = (pc, l) => mod(pc - NATURAL[l] + 6, 12) - 6;
const written = (l, a) => `${LETTERS[l]}${a > 0 ? "#".repeat(a) : "b".repeat(-a)}`;

// In a key of no sharps or flats, a note off its scale is spelled the way most written music
// spells it.
const PLAIN = { 1: 0, 3: 2, 6: 3, 8: 4, 10: 6 };

// The major scale of `sig` sharps (flats below 0) on pitch class `tonic`: [{letter, pc}].
function major(tonic, sig) {
  const l = mod(4 * sig, 7);
  return MAJOR.map((s, j) => ({ letter: (l + j) % 7, pc: (tonic + s) % 12 }));
}

// A key's spelling of each pitch class: [{letter, acc}] by pitch class, and its signature.
const TABLES = new Map();
function table(key) {
  const sc = known(key), id = `${key.tonic} ${key.scale}`;
  if (TABLES.has(id)) return TABLES.get(id);
  const parent = mod(key.tonic - sc.from, 12);
  let sig = mod(7 * parent, 12);
  if (sig > 6) sig -= 12;
  let ladder = major(parent, sig);
  const tonicIn = (m) => m.find((d) => d.pc === key.tonic).letter;
  if (sig === 6) {
    // six sharps or six flats: the one whose tonic has the fewer, and on a tie flats, but F# major
    const flat = major(parent, -6), a = Math.abs(accidental(key.tonic, tonicIn(ladder))), b = Math.abs(accidental(key.tonic, tonicIn(flat)));
    if (b < a || (b === a && sc.from !== 0)) [ladder, sig] = [flat, -6];
  }
  const first = tonicIn(ladder), spelt = [];
  for (let pc = 0; pc < 12; pc++) {
    const i = sc.steps.indexOf(mod(pc - key.tonic, 12)), d = ladder.find((x) => x.pc === pc);
    const letter = i >= 0 && sc.letters ? (first + sc.letters[i]) % 7
      : d ? d.letter
      : NATURAL.includes(pc) ? NATURAL.indexOf(pc)
      : sig > 0 ? NATURAL.indexOf(pc - 1)
      : sig < 0 ? NATURAL.indexOf(pc + 1)
      : PLAIN[pc];
    const acc = accidental(pc, letter);
    if (Math.abs(acc) > 2) throw new Error(`tonic ${key.tonic} ${key.scale}: no spelling of pitch class ${pc} on ${LETTERS[letter]}`);
    spelt.push({ letter, acc });
  }
  const t = { spelt, sig };
  TABLES.set(id, t);
  return t;
}

// A letter and its accidentals as a name with the octave that makes it key `k`.
function nameOf(l, a, k) {
  const name = `${written(l, a)}${(k - NATURAL[l] - a) / 12 - 1}`;
  if (P.key(name) !== k) throw new Error(`${name}: spelled for key ${k} but is ${P.key(name)}`);
  return name;
}

// Key `k`'s name spelled for the key: Bb in F major, A# in B major, F## in G# harmonic minor.
export function spell(key, k) {
  const { spelt } = table(key), s = spelt[keyed(k) % 12];
  return nameOf(s.letter, s.acc, k);
}

// The tonic as the key spells it, with no octave: "Bb", "F#".
export function tonicName(key) {
  const s = table(key).spelt[key.tonic];
  return written(s.letter, s.acc);
}

// The key's sharps (above 0) or flats (below 0) as written in its signature, -6 to 6. A scale with
// no signature of its own (whole tone, chromatic) is given the major's on its tonic.
export const signature = (key) => table(key).sig;

const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

// Pitch `name` (part.js's, no cents) moved `semitones`. With a key it is spelled for the key.
// Without one a flat stays a flat and a sharp a sharp, so Bb4 up a key and back is Bb4 again; a
// natural moved up takes sharps and moved down flats; an octave keeps the name as spelled.
export function moved(name, semitones, key = null) {
  const k = P.key(name);
  if (!Number.isInteger(semitones)) throw new Error(`${name} moved ${semitones}: a whole number of semitones`);
  const to = k + semitones;
  if (to < 0 || to > 127) throw new Error(`${name} moved ${semitones}: past MIDI's keys, C-1 to G9`);
  if (key !== null) return spell(key, to);
  const m = /^([A-G])(#{1,2}|b{1,2})?(-?\d+)$/.exec(name);
  if (semitones % 12 === 0) return `${m[1]}${m[2] ?? ""}${Number(m[3]) + semitones / 12}`;
  const flat = m[2] ? m[2][0] === "b" : semitones < 0;
  return flat ? `${FLATS[to % 12]}${Math.floor(to / 12) - 1}` : P.name(to);
}

// ---------------------------------------------------------------- names of keys

// The key's name for a person: "D minor", "A dorian", "Bb major", "C whole tone".
export function names(key) {
  known(key);
  return `${tonicName(key)} ${key.scale === "natural minor" ? "minor" : key.scale}`;
}

// A key's name read back: names() the other way. Takes "D minor", "a dorian", "Bb natural minor",
// "F# major pentatonic"; "ionian" and "aeolian" as major and natural minor.
export function read(text) {
  const m = typeof text === "string" && /^\s*([A-Ga-g])(#|b)?\s+(.+?)\s*$/.exec(text);
  const scale = m && m[3].toLowerCase().replace(/\s+/g, " ");
  const name = scale && (ALIASES[scale] ?? scale);
  if (!m || !Object.hasOwn(SCALES, name)) throw new Error(`"${text}": a key is a tonic and a scale, as "D minor" or "A dorian"; the scales: ${SCALE_NAMES.join(", ")}`);
  const pc = NATURAL[LETTERS.indexOf(m[1].toUpperCase())] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return { tonic: mod(pc, 12), scale: name };
}

// ---------------------------------------------------------------- the scale

// Where key `k` sits on the scale: the scale note at or below it, counted in steps from the tonic
// at or below k's octave of it (C major: C4 0, D4 1, B3 -1, C5 7), and the semitones k is above
// that note (0 where k is in the scale).
function place(key, k) {
  const sc = known(key), rel = keyed(k) - key.tonic, oct = Math.floor(rel / 12), pc = rel - 12 * oct;
  let i = sc.steps.length - 1;
  while (sc.steps[i] > pc) i--;
  return { at: oct * sc.steps.length + i, offset: pc - sc.steps[i] };
}

// The key at scale position `pos` (as place() counts), raised `offset`.
function onScale(key, pos, offset) {
  const sc = SCALES[key.scale], n = sc.steps.length;
  return key.tonic + 12 * Math.floor(pos / n) + sc.steps[mod(pos, n)] + offset;
}

// Which step of the scale key `k` is on (0 the tonic) and the semitones it is above that step:
// {degree, offset}, offset 0 where k is in the scale.
export function degree(key, k) {
  const p = place(key, k);
  return { degree: mod(p.at, SCALES[key.scale].steps.length), offset: p.offset };
}

export const inKey = (key, k) => place(key, k).offset === 0;

// The key of the scale nearest key `k`: k itself where it is in the scale. Direction 1 takes the
// nearest at or above it, -1 at or below, 0 either way with a tie going down. null where there is
// none that way within MIDI's keys.
export function nearest(key, k, direction = 0) {
  if (direction !== -1 && direction !== 0 && direction !== 1) throw new Error(`direction ${direction}: 1 up, -1 down, 0 either`);
  if (inKey(key, k)) return k;
  let up = null, down = null;
  for (let j = k + 1; j <= 127 && up === null; j++) if (inKey(key, j)) up = j;
  for (let j = k - 1; j >= 0 && down === null; j--) if (inKey(key, j)) down = j;
  if (direction === 1) return up;
  if (direction === -1) return down;
  if (up === null) return down;
  if (down === null) return up;
  return up - k < k - down ? up : down;
}

// Key `k` moved `steps` steps along the scale, down where below 0. A key off the scale moves by the
// steps of the scale note below it and keeps its offset from it (C#4 up one in C major is D#4).
export function step(key, k, steps) {
  if (!Number.isInteger(steps)) throw new Error(`${steps} steps: a whole number`);
  const p = place(key, k), to = onScale(key, p.at + steps, p.offset);
  if (to < 0 || to > 127) throw new Error(`${spell(key, k)} ${steps < 0 ? "down" : "up"} ${Math.abs(steps)} step${Math.abs(steps) === 1 ? "" : "s"} in ${names(key)}: past MIDI's keys, C-1 to G9`);
  return to;
}

// The scale steps from key `a` to key `b`, each counted from the scale note at or below it.
export function distance(key, a, b) {
  return place(key, b).at - place(key, a).at;
}

// Key `k` mirrored about key `axis` along the scale: as many steps below the axis as k is above
// it, and an offset off the scale mirrored too. The axis is a key of the scale.
export function mirror(key, k, axis) {
  if (!inKey(key, axis)) throw new Error(`${spell(key, axis)} is not in ${names(key)}: a mirror's axis is a note of the scale`);
  const p = place(key, k), to = onScale(key, 2 * place(key, axis).at - p.at, -p.offset);
  if (to < 0 || to > 127) throw new Error(`${spell(key, k)} mirrored about ${spell(key, axis)} in ${names(key)}: past MIDI's keys, C-1 to G9`);
  return to;
}

// ---------------------------------------------------------------- chords

// a chord in a key: the scale steps above its root
export const KINDS = Object.freeze({
  triad: [0, 2, 4],
  seventh: [0, 2, 4, 6],
  sus2: [0, 1, 4],
  sus4: [0, 3, 4],
  sixth: [0, 2, 4, 5],
  add9: [0, 2, 4, 8],
  power: [0, 4],
});
for (const k of Object.values(KINDS)) Object.freeze(k);

// The keys of a `kind` chord built on key `k` in the key, from k up. The chord is stacked from the
// scale, so it is the key's own (D minor on D in C major). A root off the scale moves the chord on
// the scale note below it by its offset, as step() does. Only a scale of seven notes stacks in
// thirds; the others are refused.
export function chord(key, k, kind) {
  const sc = known(key);
  if (!Object.hasOwn(KINDS, kind)) throw new Error(`${kind}: a chord is one of ${Object.keys(KINDS).join(", ")}`);
  if (sc.steps.length !== 7) throw new Error(`a ${kind} in ${names(key)}: chords stack in thirds in a scale of seven notes, and ${key.scale} has ${sc.steps.length}`);
  return KINDS[kind].map((s) => step(key, k, s));
}

// a chord symbol's quality: semitones above its root
const QUALITIES = {
  "": [0, 4, 7], "maj": [0, 4, 7],
  "m": [0, 3, 7], "min": [0, 3, 7], "-": [0, 3, 7],
  "dim": [0, 3, 6],
  "aug": [0, 4, 8], "+": [0, 4, 8],
  "5": [0, 7],
  "sus2": [0, 2, 7], "sus4": [0, 5, 7], "sus": [0, 5, 7],
  "6": [0, 4, 7, 9], "m6": [0, 3, 7, 9],
  "7": [0, 4, 7, 10],
  "maj7": [0, 4, 7, 11], "M7": [0, 4, 7, 11],
  "m7": [0, 3, 7, 10], "min7": [0, 3, 7, 10], "-7": [0, 3, 7, 10],
  "mmaj7": [0, 3, 7, 11], "mM7": [0, 3, 7, 11],
  "dim7": [0, 3, 6, 9],
  "m7b5": [0, 3, 6, 10],
  "aug7": [0, 4, 8, 10], "7#5": [0, 4, 8, 10],
  "7sus4": [0, 5, 7, 10], "7sus": [0, 5, 7, 10],
  "add9": [0, 4, 7, 14], "madd9": [0, 3, 7, 14],
  "9": [0, 4, 7, 10, 14], "maj9": [0, 4, 7, 11, 14], "m9": [0, 3, 7, 10, 14],
};
export const QUALITY_NAMES = Object.freeze(Object.keys(QUALITIES));

// The keys of a chord symbol, from the root in `octave` up (4: C is C4, Cb is Cb4): C, Am, F#m7,
// Bbmaj7, Gsus4, D7, Cdim, Caug, Am7/G. A bass after a / is the nearest key of it below the root.
export function chordKeys(symbol, octave = 4) {
  if (!Number.isInteger(octave)) throw new Error(`octave ${octave}: a whole number`);
  const m = typeof symbol === "string" && /^([A-G](?:#|b)?)([^/\s]*)(?:\/([A-G](?:#|b)?))?$/.exec(symbol.trim());
  if (!m || !Object.hasOwn(QUALITIES, m[2])) throw new Error(`"${symbol}": not a chord this reads (C, Am, F#m7, Bbmaj7, Gsus4, D7, Cdim, Caug, Am7/G)`);
  const root = P.key(`${m[1]}${octave}`), keys = QUALITIES[m[2]].map((s) => root + s);
  if (m[3]) keys.unshift(root - 1 - mod(root - 1 - P.key(`${m[3]}${octave}`), 12));
  for (const k of keys) if (k < 0 || k > 127) throw new Error(`"${symbol}" from octave ${octave}: past MIDI's keys, C-1 to G9`);
  return keys;
}

// ---------------------------------------------------------------- finding the key

// How strongly each step of the scale is heard in a major and a minor key (Krumhansl and Kessler,
// 1982), tonic first.
const PROFILES = {
  "major": [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  "natural minor": [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
};

function pearson(x, y) {
  const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

// The 24 major and minor keys ranked by how well the notes fit them, best first: each note counts
// for its length, the profiles are Krumhansl's. [{key, name, score, inside}]: score from -1 to 1,
// inside the share of the notes' time on the key's scale. Notes are part.js's ({pitch, ticks});
// a note counts as its written key, its cents aside. A tie keeps C first and major before minor.
// The other scales have no profile to rank by, and are not ranked.
export function detect(notes) {
  if (!Array.isArray(notes) || !notes.length) throw new Error("no notes to find a key in");
  const w = new Array(12).fill(0);
  for (const n of notes) {
    if (!Number.isInteger(n.ticks) || n.ticks < 1) throw new Error(`a note ${n.ticks} ticks long: a tick at least`);
    w[P.key(n.pitch) % 12] += n.ticks;
  }
  if (w.every((x) => x === w[0])) throw new Error("the notes weigh every pitch the same: no key stands out");
  const all = w.reduce((a, b) => a + b), out = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const scale of ["major", "natural minor"]) {
      const key = { tonic, scale }, prof = PROFILES[scale], steps = SCALES[scale].steps;
      const score = pearson(w, w.map((_, pc) => prof[mod(pc - tonic, 12)]));
      const inside = w.reduce((a, x, pc) => a + (steps.includes(mod(pc - tonic, 12)) ? x : 0), 0) / all;
      out.push({ key, name: names(key), score, inside });
    }
  }
  return out.map((e, i) => [e, i]).sort(([a, i], [b, j]) => b.score - a.score || i - j).map(([e]) => e);
}
