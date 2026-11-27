// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// Tools that reshape chosen notes: quantize, legato, gate, split, join; reverse, invert, steps
// in a key, transpose, double and half time; ornaments sung on one syllable; arpeggios; the
// vibrato's shape over a note. No DOM: the page and node both use it.
//
// Every tool is tool(part, notes, options) -> {part, notes}: the part made, and the notes of it
// that are chosen after. `notes` are notes of `part` (an array or a Set). A tool leaves a part
// part.js check() passes, or refuses with what is wrong and the beat it is wrong at; the part
// it was given is never changed. options(grid) gives each tool's options as data, each with its
// range and its default, for the page's pull fields.
//
// The words are left sung right, as song.js reads them: a note added inside a syllable holds it
// with `_`, a split note's pieces are its syllable then `_`, a join keeps the first note's
// syllable, and the syllables stay in reading order. No tool makes two notes start together
// that did not before (a singer sings one at a time), no note a tool makes or shortens is
// shorter than the engine's shortest vowel, and a part that was sung is sung still: what would
// stop it is refused, by beat (song.js problems).
//
// These write the score: keys, cents, times, the drawn vibrato's size. Nothing here reaches the
// pitch line the singer sings, and no tool sets the vibrato to 0.

import * as P from "./part.js";
import * as T from "./theory.js";
import { clock, problems } from "./song.js";

// seconds: the engine's shortest vowel, 3 frames of 10 ms (sing.rs MIN_VOWEL)
export const LEAST = 0.03;

const where = (part, t) => `beat ${P.beat(t, part.grid)}`;
// a lane value as the text can write it: six places at most
const six = (x) => Number(x.toFixed(6));
// what a note made inside another's syllable sings
const held = (lyric) => (lyric === null ? null : "_");

// ---------------------------------------------------------------- options

const number = (name, label, min, max, step, def, unit, said, more = {}) => ({ name, kind: "number", label, min, max, step, default: def, unit, said, ...more });
const choice = (name, label, choices, def, said, more = {}) => ({ name, kind: "choice", label, choices, default: def, said, ...more });
const flag = (name, label, def, said, more = {}) => ({ name, kind: "flag", label, default: def, said, ...more });
const KEY = { name: "key", kind: "key", label: "Key", default: null, said: "The key the notes are named in and stepped along: {tonic, scale} as theory.js has it, or none." };

export const ORNAMENTS = Object.freeze(["trill", "upper mordent", "lower mordent", "turn", "grace", "appoggiatura", "slide", "fall"]);
export const PATTERNS = Object.freeze(["up", "down", "up and down", "down and up", "outside in", "as written", "random", "digits"]);
export const SHAPES = Object.freeze(["late", "swell", "fade"]);
export const TIMES = Object.freeze(["2", "1/2", "3/2", "2/3", "3", "1/3", "4", "1/4"]);
const NEIGHBOURS = ["trill", "upper mordent", "lower mordent", "turn", "grace", "appoggiatura"];

// Each tool's options as data, for a grid of `grid` ticks a beat: {tool: {label, said, fields}},
// a field {name, kind, label, default, said} and by kind: number {min, max, step, unit, whole};
// choice {choices}; flag; key (theory.js's {tonic, scale}, or null); tick (a whole number of
// ticks); pitch (a MIDI key, or null); text. A field with `kinds` is read by those ornaments only.
export function options(grid) {
  if (!Number.isInteger(grid) || grid < 1) throw new Error(`grid ${grid}: ticks a beat, 1 at least`);
  const part = (k) => Math.max(1, Math.round(grid / k));
  const rate = (def, said) => number("rate", "Rate", 1, grid * 2, 1, def, "ticks", said, { whole: true });
  return {
    quantize: { label: "Quantize", said: "Moves the starts, the lengths or both toward the step.", fields: [
      number("step", "Step", 1, grid * 4, 1, part(4), "ticks", "The grid the notes are drawn to.", { whole: true }),
      number("strength", "Strength", 0, 1, 0.05, 1, "of the way", "How far toward the step: 1 all the way."),
      number("swing", "Swing", 0, 0.5, 0.01, 0, "of a step", "Every second step lands this much later."),
      flag("starts", "Starts", true, "Move the notes' starts."),
      flag("lengths", "Lengths", false, "Make the notes' lengths whole steps, a step at least."),
    ] },
    legato: { label: "Legato", said: "Each note runs on to the next note's start. Inside a word the singer does this already; it is heard where a word ends.", fields: [
      number("within", "Within", 0, 16, 0.25, 16, "beats", "A gap longer than this is a rest, and is kept."),
    ] },
    gate: { label: "Gate", said: "Shortens each note to a share of its length. Inside a word the singer runs a note on to the next; a gap made where a word ends is a rest, where the singer may breathe.", fields: [
      number("fraction", "Length", 0.05, 1, 0.05, 0.5, "of the note", "How much of each note is left."),
    ] },
    split: { label: "Split", said: "Each note into equal notes.", fields: [
      number("n", "Notes", 2, 16, 1, 2, "notes", "How many notes each becomes.", { whole: true }),
      flag("held", "Held", true, "The notes after the first hold its syllable; off, they have no words, for the Words box."),
    ] },
    splitAt: { label: "Split here", said: "The notes sounding across a tick, in two there.", fields: [
      { name: "at", kind: "tick", label: "At", default: null, said: "The tick to split at." },
      flag("held", "Held", true, "The second note holds the syllable; off, it has no words."),
    ] },
    join: { label: "Join", said: "Notes on one key, one after another, as one note: the first's syllable and loudness, the last's release.", fields: [] },
    reverse: { label: "Reverse", said: "The notes backward, the words still read in order.", fields: [
      flag("keys", "Keys only", false, "Keep the rhythm and reverse only the keys."),
    ] },
    invert: { label: "Invert", said: "The notes mirrored about a key, along the key's scale where a key is given.", fields: [
      { name: "axis", kind: "pitch", label: "About", default: null, said: "The key mirrored about: the first chosen note's where none is given." },
      KEY,
    ] },
    scaleStep: { label: "Step in key", said: "The notes moved along the key's scale.", fields: [
      number("steps", "Steps", -14, 14, 1, 1, "steps", "Steps along the scale, down below 0.", { whole: true }),
      KEY,
    ] },
    transpose: { label: "Transpose", said: "The notes moved by semitones, named for the key where one is given.", fields: [
      number("semitones", "Semitones", -48, 48, 1, 12, "semitones", "Up above 0, down below.", { whole: true }),
      KEY,
    ] },
    scaleTime: { label: "Time", said: "The notes' times and lengths from the first chosen note's start, times this.", fields: [
      choice("by", "Times", TIMES, "2", "2 is double time's length, 1/2 half."),
      flag("ripple", "Push along", false, "The notes, vibrato and marks after move by the change."),
    ] },
    ornament: { label: "Ornament", said: "An ornament on each chosen note, sung on its syllable, inside the note's time.", fields: [
      choice("kind", "Ornament", ORNAMENTS, "trill", "What is sung."),
      rate(part(8), "How long each quick note is."),
      KEY,
      number("width", "Width", 1, 2, 1, 2, "semitones", "With no key, how far the neighbour note is.", { whole: true, kinds: NEIGHBOURS }),
      flag("below", "From below", false, "The grace note or appoggiatura from the note below.", { kinds: ["grace", "appoggiatura"] }),
      number("span", "Span", 0.25, 1, 0.05, 1, "of the note", "How much of the note the trill takes; the rest holds the note.", { kinds: ["trill"] }),
      number("lean", "Lean", 0.1, 0.9, 0.05, 0.5, "of the note", "How much of the note the appoggiatura takes.", { kinds: ["appoggiatura"] }),
      number("slide", "Slide", -12, 12, 1, -3, "semitones", "Where a slide comes from, or a fall goes: below the note under 0.", { whole: true, kinds: ["slide", "fall"] }),
    ] },
    run: { label: "Run", said: "A run along the key's scale from each chosen note to the next, sung on the first's syllable.", fields: [
      rate(part(8), "How long each note of the run is."),
      KEY,
      flag("whole", "Whole note", false, "The run shares the first note's whole length evenly; off, it takes the note's end at the rate."),
    ] },
    arpeggiate: { label: "Arpeggiate", said: "Notes that sound together become a line on the chord's syllable.", fields: [
      choice("pattern", "Pattern", PATTERNS, "up", "The order the chord's notes come in."),
      rate(part(4), "How long each note of the line is."),
      number("octaves", "Octaves", 1, 3, 1, 1, "octaves", "How many octaves up the chord is spread over.", { whole: true }),
      number("gate", "Gate", 0.1, 1, 0.05, 1, "of a note", "How much of its time each note sounds. Inside the syllable the singer carries each note on to the next, so it is heard at the line's end."),
      number("seed", "Seed", 0, 4294967295, 1, 1, "", "Which random order: the same seed, the same line.", { whole: true }),
      { name: "digits", kind: "text", label: "Digits", default: "1 3 2 4", said: "The order as the chord's notes counted from the lowest, 1 first, as 1 3 2 4." },
      choice("chord", "Chord", ["none", ...Object.keys(T.KINDS)], "none", "A note sounding alone is given this chord in the key first."),
      KEY,
    ] },
    swell: { label: "Vibrato shape", said: "The drawn vibrato shaped over each chosen note, then back as it was.", fields: [
      choice("shape", "Shape", SHAPES, "swell", "late: comes in after a while; swell: grows, then fades; fade: fades away."),
      number("low", "Least", 0.05, 2, 0.05, 0.2, "of the voice's", "The vibrato's smallest: never none."),
      number("top", "Most", 0.1, 3, 0.05, 1, "of the voice's", "The vibrato's largest."),
      number("at", "Turn", 0.1, 0.9, 0.05, 0.5, "of the note", "late: where it comes in; swell: where it is fullest; fade: where it starts to fade."),
      number("least", "Notes from", 0, 8, 0.25, 1, "beats", "Notes shorter than this are left as they are."),
    ] },
  };
}

// what is wrong with value `v` of field `f`, or null
function wrong(f, v) {
  switch (f.kind) {
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v) || v < f.min || v > f.max) return `${f.min} to ${f.max}`;
      return f.whole && !Number.isInteger(v) ? "a whole number" : null;
    case "choice": return f.choices.includes(v) ? null : `one of ${f.choices.join(", ")}`;
    case "flag": return typeof v === "boolean" ? null : "true or false";
    case "key":
      if (v === null) return null;
      try { T.names(v); } catch (e) { return e.message; }
      return null;
    case "tick": return Number.isInteger(v) && v >= 0 ? null : "a whole number of ticks, 0 or more";
    case "pitch": return v === null || (Number.isInteger(v) && v >= 0 && v <= 127) ? null : "a key, 0 to 127";
    case "text": return typeof v === "string" ? null : "text";
  }
  throw new Error(`no kind ${f.kind}`);
}

// the options given, each checked, the rest their defaults
function settle(tool, part, given) {
  const { fields } = options(part.grid)[tool];
  for (const k of Object.keys(given)) {
    if (!fields.some((f) => f.name === k)) throw new Error(`${tool} has no ${k}${fields.length ? `: it takes ${fields.map((f) => f.name).join(", ")}` : ""}`);
  }
  const o = {};
  for (const f of fields) {
    const v = given[f.name] === undefined ? f.default : given[f.name];
    const why = wrong(f, v);
    if (why) throw new Error(`${tool}: ${f.name} ${JSON.stringify(v)}: ${why}`);
    o[f.name] = v;
  }
  return o;
}

// ---------------------------------------------------------------- the whole

// the chosen notes, in the part's order
function chosen(part, notes) {
  const set = new Set(notes);
  if (!set.size) throw new Error("no notes chosen");
  for (const n of set) if (!part.notes.includes(n)) throw new Error(`a chosen note${n && Number.isInteger(n.at) ? ` at ${where(part, n.at)}` : ""} is not one of the part's`);
  return part.notes.filter((n) => set.has(n));
}

// f(), what it throws said at note `n`'s beat
function at(part, n, f) {
  try {
    return f();
  } catch (e) {
    throw new Error(`${where(part, n.at)}: ${e.message}`);
  }
}

// marks in the order of their beats, one to a beat
function remark(part, marks) {
  const out = [...marks].sort((a, b) => a.at - b.at);
  for (let i = 1; i < out.length; i++) if (out[i].at === out[i - 1].at) throw new Error(`${where(part, out[i].at)}: two marks would share the beat`);
  return out;
}

// A mark on a chosen note's start goes where `place` puts the note, unless another note starts
// there too, whose rest it settles.
function follow(part, mine, place) {
  const set = new Set(mine), still = new Set(part.notes.filter((n) => !set.has(n)).map((n) => n.at)), moves = new Map();
  for (const n of mine) if (!still.has(n.at) && !moves.has(n.at)) moves.set(n.at, place(n));
  return remark(part, part.marks.map((m) => (moves.has(m.at) && moves.get(m.at) !== m.at ? { ...m, at: moves.get(m.at) } : m)));
}

// The part made from `before` with `notes` (in any order): checked, or refused by beat.
//   from     a note made: the note of `before` it was made from
//   chosen   the notes chosen after
//   order    the words must read as they did
//   sung     a part that was sung is sung still (false: the tool leaves notes with no words)
function finish(before, notes, { from = new Map(), chosen: picked = [], lanes = before.lanes, marks = before.marks, order = false, sung = true } = {}) {
  const part = { ...before, notes: P.sort(notes), lanes, marks };
  const old = new Set(before.notes), ns = part.notes;
  const source = (n) => (old.has(n) ? n : from.get(n));
  for (let i = 0; i < ns.length;) {
    let j = i;
    while (j < ns.length && ns[j].at === ns[i].at) j++;
    if (j - i > 1 && !ns.slice(i, j).every((n) => old.has(n))) {
      const s = ns.slice(i, j).map(source);
      if (!s.every((x) => x && x.at === s[0].at)) throw new Error(`${where(part, ns[i].at)}: two notes would start together, and a singer sings one at a time`);
    }
    i = j;
  }
  if (order) {
    const i = ns.findIndex((n, k) => n.lyric !== before.notes[k].lyric);
    if (i >= 0) throw new Error(`${where(part, ns[i].at)}: the words would be out of order`);
  }
  // a note made to hold a syllable comes after the note that sings it, with none between
  const carrier = new Map();
  for (const n of ns) if (!old.has(n) && from.has(n) && n.lyric !== null && n.lyric !== "_") carrier.set(from.get(n), n);
  ns.forEach((m, i) => {
    const c = !old.has(m) && m.lyric === "_" && carrier.get(from.get(m));
    if (!c) return;
    let j = i - 1;
    while (j >= 0 && (ns[j].lyric === "_" || ns[j].lyric === null)) j--;
    if (ns[j] !== c) throw new Error(`${where(part, m.at)}: ${j >= 0 ? `the note at ${where(part, ns[j].at)} comes between, and ` : ""}"${c.lyric}" would not be held here`);
  });
  P.check(part);
  const secs = clock(part);
  for (const n of ns) {
    if (old.has(n)) continue;
    const s = from.get(n);
    if (s && n.ticks >= s.ticks) continue;
    const len = secs(n.at + n.ticks) - secs(n.at);
    if (len < LEAST - 1e-9) throw new Error(`${where(part, n.at)}: a note ${Math.round(len * 1000)} ms long; a singer needs ${LEAST * 1000} ms at least to sing one`);
  }
  if (sung && !problems(before).length) {
    const [p] = problems(part);
    if (p) throw new Error(`${p.what}; the part would not be sung`);
  }
  const set = new Set(picked);
  return { part, notes: ns.filter((n) => set.has(n)) };
}

// the part's notes with some put in place of others: `swap` an old note -> its new notes
function swapped(part, swap) {
  return part.notes.flatMap((n) => (swap.has(n) ? swap.get(n) : [n]));
}

// ---------------------------------------------------------------- time

// The starts (and lengths) moved `strength` of the way to the nearest `step`; with swing, every
// second step is that share of a step later. Marks on the notes' starts go with them.
export function quantize(part, notes, options = {}) {
  const o = settle("quantize", part, options), mine = chosen(part, notes);
  if (!o.starts && !o.lengths) throw new Error("quantize: the starts, the lengths or both");
  const { step, strength, swing } = o;
  const to = (t) => {
    const k = Math.round(t / step);
    return k * step + (k % 2 ? swing * step : 0);
  };
  const from = new Map(), swap = new Map(), place = new Map();
  for (const n of mine) {
    const a = o.starts ? Math.round(n.at + strength * (to(n.at) - n.at)) : n.at;
    const want = Math.max(step, Math.round(n.ticks / step) * step);
    const len = o.lengths ? Math.max(1, Math.round(n.ticks + strength * (want - n.ticks))) : n.ticks;
    const m = a === n.at && len === n.ticks ? n : { ...n, at: a, ticks: len };
    if (m !== n) from.set(m, n);
    swap.set(n, [m]);
    place.set(n, m);
  }
  const marks = follow(part, mine, (n) => place.get(n).at);
  return finish(part, swapped(part, swap), { from, chosen: [...place.values()], marks, order: true });
}

// Each note runs on to the next note's start, where the gap to it is `within` beats or less; a
// note sounding past the next one's start ends there.
export function legato(part, notes, options = {}) {
  const o = settle("legato", part, options), mine = chosen(part, notes);
  const from = new Map(), swap = new Map(), out = [];
  for (const n of mine) {
    const next = part.notes.find((x) => x.at > n.at);
    const len = next && next.at - (n.at + n.ticks) <= o.within * part.grid ? next.at - n.at : n.ticks;
    const m = len === n.ticks ? n : { ...n, ticks: len };
    if (m !== n) from.set(m, n);
    swap.set(n, [m]);
    out.push(m);
  }
  return finish(part, swapped(part, swap), { from, chosen: out });
}

// Each note `fraction` of its length, a tick at least.
export function gate(part, notes, options = {}) {
  const o = settle("gate", part, options), mine = chosen(part, notes);
  const from = new Map(), swap = new Map(), out = [];
  for (const n of mine) {
    const len = Math.max(1, Math.round(n.ticks * o.fraction));
    const m = len === n.ticks ? n : { ...n, ticks: len };
    if (m !== n) from.set(m, n);
    swap.set(n, [m]);
    out.push(m);
  }
  return finish(part, swapped(part, swap), { from, chosen: out });
}

// A note in pieces at the ticks `cuts` (inside it, rising): the first keeps the syllable, the
// rest hold it, or with `keep` false have no words.
function cut(n, cuts, keep, from) {
  const edges = [n.at, ...cuts, n.at + n.ticks];
  return cuts.concat([null]).map((_, i) => {
    const m = { ...n, at: edges[i], ticks: edges[i + 1] - edges[i], lyric: i === 0 ? n.lyric : keep ? held(n.lyric) : null };
    from.set(m, n);
    return m;
  });
}

// Each note as `n` notes of equal length, to the tick.
export function split(part, notes, options = {}) {
  const o = settle("split", part, options), mine = chosen(part, notes);
  const from = new Map(), swap = new Map();
  for (const n of mine) {
    if (n.ticks < o.n) throw new Error(`${where(part, n.at)}: the note is ${n.ticks} ticks long, too short to split in ${o.n}`);
    swap.set(n, cut(n, Array.from({ length: o.n - 1 }, (_, i) => n.at + Math.floor((i + 1) * n.ticks / o.n)), o.held, from));
  }
  return finish(part, swapped(part, swap), { from, chosen: [...swap.values()].flat(), sung: o.held });
}

// The chosen notes sounding across tick `at`, in two there.
export function splitAt(part, notes, options = {}) {
  const o = settle("splitAt", part, options), mine = chosen(part, notes);
  const from = new Map(), swap = new Map();
  for (const n of mine) if (n.at < o.at && o.at < n.at + n.ticks) swap.set(n, cut(n, [o.at], o.held, from));
  if (!swap.size) throw new Error(`${where(part, o.at)}: no chosen note sounds across it`);
  return finish(part, swapped(part, swap), { from, chosen: [...swap.values()].flat(), sung: o.held });
}

// Chosen notes on one key, one after another with no other note starting between, as one: from
// the first's start to the last's end, the first's pitch, syllable and velocity, the last's
// release. Refused where a note joined has a syllable of its own, which would be lost.
export function join(part, notes, options = {}) {
  settle("join", part, options);
  const mine = chosen(part, notes), runs = [];
  for (const n of mine) {
    const run = runs.at(-1), prev = run?.at(-1);
    const next = prev && P.key(prev.pitch) === P.key(n.pitch) && n.at > prev.at && !part.notes.some((x) => x !== n && x.at > prev.at && x.at < n.at);
    if (next) run.push(n);
    else runs.push([n]);
  }
  const from = new Map(), swap = new Map(), out = [];
  for (const run of runs.filter((r) => r.length > 1)) {
    const [first] = run, last = run.at(-1), end = Math.max(...run.map((n) => n.at + n.ticks));
    for (const n of run.slice(1)) {
      if (n.lyric !== null && n.lyric !== "_") throw new Error(`${where(part, n.at)}: "${n.lyric}" is a syllable of its own, and joined it would be lost`);
    }
    const mark = part.marks.find((m) => m.at > first.at && m.at < end);
    if (mark) throw new Error(`${where(part, mark.at)}: the mark here would be inside the note joined`);
    const m = { ...first, ticks: end - first.at, release: last.release };
    run.forEach((n, i) => swap.set(n, i === 0 ? [m] : []));
    from.set(m, first);
    out.push(m);
  }
  if (!out.length) throw new Error("nothing to join: choose notes on one key, one after another");
  return finish(part, swapped(part, swap), { from, chosen: out });
}

// The notes backward in time within their stretch, keys and all, the syllables laid back on them
// in reading order so the words read as before; with `keys`, the rhythm and words as they are and
// the keys (with their cents) in reverse. A mark in a rest between the notes goes with the rest.
export function reverse(part, notes, options = {}) {
  const o = settle("reverse", part, options), mine = chosen(part, notes);
  if (mine.length < 2) throw new Error("reverse: choose two notes or more");
  const from = new Map(), swap = new Map();
  if (o.keys) {
    const out = mine.map((n, i) => {
      const k = mine[mine.length - 1 - i], m = k.pitch === n.pitch && k.cents === n.cents ? n : { ...n, pitch: k.pitch, cents: k.cents };
      if (m !== n) from.set(m, n);
      swap.set(n, [m]);
      return m;
    });
    return finish(part, swapped(part, swap), { from, chosen: out });
  }
  const s = mine[0].at, e = Math.max(...mine.map((n) => n.at + n.ticks));
  const placed = P.sort(mine.map((n) => {
    const m = { ...n, at: s + e - (n.at + n.ticks) };
    from.set(m, n);
    return m;
  }));
  const out = placed.map((m, i) => {
    const x = { ...m, lyric: mine[i].lyric };
    from.set(x, from.get(m));
    return x;
  });
  mine.forEach((n) => swap.set(n, []));
  const ends = mine.map((n) => n.at + n.ticks), starts = mine.map((n) => n.at);
  const marks = remark(part, part.marks.map((m) => {
    if (m.at <= s || m.at >= e) return m;
    const a = Math.max(...ends.filter((t) => t <= m.at)), b = Math.min(...starts.filter((t) => t >= m.at));
    // in a rest, it goes on the note that ends the mirrored rest; inside a note, mirrored
    const to = a > -Infinity && b < Infinity && a < b ? s + e - a : s + e - m.at;
    return to === m.at ? m : { ...m, at: to };
  }));
  return finish(part, [...swapped(part, swap), ...out], { from, chosen: out, marks, order: true });
}

// the notes with their keys moved: f(note, key) -> [key, name, cents]
function rekey(part, mine, f) {
  const from = new Map(), swap = new Map(), out = [];
  for (const n of mine) {
    const [k, pitch, cents] = at(part, n, () => f(n, P.key(n.pitch)));
    if (k < 0 || k > 127) throw new Error(`${where(part, n.at)}: ${n.pitch} would go past MIDI's keys, C-1 to G9`);
    const m = pitch === n.pitch && cents === n.cents ? n : { ...n, pitch, cents };
    if (m !== n) from.set(m, n);
    swap.set(n, [m]);
    out.push(m);
  }
  return finish(part, swapped(part, swap), { from, chosen: out });
}

// The notes mirrored about key `axis` (the first chosen note's where null): by semitones, or
// with a key by its scale's steps, the axis a note of the scale. A note's cents are mirrored too.
export function invert(part, notes, options = {}) {
  const o = settle("invert", part, options), mine = chosen(part, notes), axis = o.axis ?? P.key(mine[0].pitch);
  return rekey(part, mine, (n, k) => {
    const to = o.key ? T.mirror(o.key, k, axis) : 2 * axis - k;
    if (to < 0 || to > 127) return [to];
    return [to, o.key ? T.spell(o.key, to) : T.moved(n.pitch, to - k), n.cents === 0 ? 0 : -n.cents];
  });
}

// The notes `steps` steps along the key's scale, named for the key, their cents kept.
export function scaleStep(part, notes, options = {}) {
  const o = settle("scaleStep", part, options), mine = chosen(part, notes);
  if (!o.key) throw new Error("step in key: choose a key");
  return rekey(part, mine, (n, k) => {
    const to = T.step(o.key, k, o.steps);
    return [to, T.spell(o.key, to), n.cents];
  });
}

// The notes `semitones` up, named for the key where one is given; their cents kept.
export function transpose(part, notes, options = {}) {
  const o = settle("transpose", part, options), mine = chosen(part, notes);
  return rekey(part, mine, (n, k) => [k + o.semitones, T.moved(n.pitch, o.semitones, o.key), n.cents]);
}

// The notes' times from the first chosen note's start, and their lengths, times `by`. A note that
// would land off a whole tick is refused. With `ripple`, the notes starting at or after the chosen
// notes' end, the vibrato's points and the marks move by the change, and those within the chosen
// stretch are timed with the notes; without, the marks on the notes' starts go with them.
export function scaleTime(part, notes, options = {}) {
  const o = settle("scaleTime", part, options), mine = chosen(part, notes);
  const [num, den] = o.by.includes("/") ? o.by.split("/").map(Number) : [Number(o.by), 1];
  const s = mine[0].at, end = Math.max(...mine.map((n) => n.at + n.ticks));
  const scaled = (t, what) => {
    const x = (t - s) * num;
    if (x % den) throw new Error(`${where(part, t)}: ${what} at ${o.by} the time would land off a whole tick`);
    return s + x / den;
  };
  const newEnd = scaled(end, "the notes' end"), delta = newEnd - end;
  const from = new Map(), swap = new Map(), out = [];
  for (const n of mine) {
    const a = scaled(n.at, "the note");
    if ((n.ticks * num) % den) throw new Error(`${where(part, n.at)}: the note at ${o.by} its length would be off a whole tick`);
    const m = { ...n, at: a, ticks: n.ticks * num / den };
    from.set(m, n);
    swap.set(n, [m]);
    out.push(m);
  }
  let lanes = part.lanes, marks;
  if (o.ripple) {
    const mineSet = new Set(mine);
    for (const n of part.notes) {
      if (mineSet.has(n) || n.at < end || !delta) continue;
      const m = { ...n, at: n.at + delta };
      from.set(m, n);
      swap.set(n, [m]);
    }
    const time = (t, what) => (t < s ? t : t >= end ? t + delta : scaled(t, what));
    lanes = Object.fromEntries(P.LANES.map((l) => [l, part.lanes[l].map((q) => (time(q.at, `the ${l} point`) === q.at ? q : { ...q, at: time(q.at, `the ${l} point`) }))]));
    marks = remark(part, part.marks.map((m) => (time(m.at, "the mark") === m.at ? m : { ...m, at: time(m.at, "the mark") })));
  } else {
    marks = follow(part, mine, (n) => swap.get(n)[0].at);
  }
  return finish(part, swapped(part, swap), { from, chosen: out, lanes, marks, order: true });
}

// ---------------------------------------------------------------- ornaments

// A key `k`'s name and cents for a note made from note `n`: n's own where it is n's key.
function named(n, k, key) {
  if (k < 0 || k > 127) throw new Error(`past MIDI's keys, C-1 to G9, from ${n.pitch}`);
  const own = P.key(n.pitch);
  if (k === own) return { pitch: n.pitch, cents: n.cents };
  return { pitch: key ? T.spell(key, k) : T.moved(n.pitch, k - own), cents: 0 };
}

// Note `n` as pieces [[ticks, key]...] from its start: the first takes the syllable, the rest
// hold it.
function pieces(n, list, key, from) {
  let t = n.at;
  return list.map(([len, k], i) => {
    const m = { ...n, ...named(n, k, key), at: t, ticks: len, lyric: i === 0 ? n.lyric : held(n.lyric) };
    t += len;
    from.set(m, n);
    return m;
  });
}

// the scale note next to `k`, up or down: by the key's scale, or by `width` semitones
function neighbour(k, up, o) {
  return o.key ? T.step(o.key, k, up ? 1 : -1) : k + (up ? o.width : -o.width);
}

// Each chosen note ornamented, its time shared out within it so nothing after it moves; a grace
// note takes its time from the note before. The syllable is sung on the first note of each.
export function ornament(part, notes, options = {}) {
  const o = settle("ornament", part, options), mine = chosen(part, notes), r = o.rate;
  const from = new Map(), made = new Set(), placed = new Map();
  let work = part.notes.slice();
  const origin = (x) => from.get(x) ?? x;
  const need = (n, count, what) => {
    if (n.ticks < count * r) throw new Error(`${what} at ${r} ticks a note needs ${count * r} ticks, and the note is ${n.ticks}`);
  };
  for (const n of mine) {
    const k = P.key(n.pitch), rest = (used) => n.ticks - used;
    let out;
    at(part, n, () => {
      switch (o.kind) {
        case "trill": {
          const span = Math.round(n.ticks * o.span), pairs = Math.floor((span / r - 1) / 2);
          if (pairs < 1) throw new Error(`a trill at ${r} ticks a note needs ${3 * r} ticks of the note, and ${o.span === 1 ? "it is" : "its span is"} ${span}`);
          const up = neighbour(k, true, o), list = [];
          for (let i = 0; i < 2 * pairs; i++) list.push([r, i % 2 ? up : k]);
          out = pieces(n, [...list, [rest(2 * pairs * r), k]], o.key, from);
          break;
        }
        case "upper mordent":
        case "lower mordent":
          need(n, 3, `a ${o.kind}`);
          out = pieces(n, [[r, k], [r, neighbour(k, o.kind === "upper mordent", o)], [rest(2 * r), k]], o.key, from);
          break;
        case "turn":
          need(n, 4, "a turn");
          out = pieces(n, [[r, neighbour(k, true, o)], [r, k], [r, neighbour(k, false, o)], [rest(3 * r), k]], o.key, from);
          break;
        case "appoggiatura": {
          const lean = Math.round(n.ticks * o.lean);
          if (lean < 1 || lean >= n.ticks) throw new Error(`the note is ${n.ticks} ticks long, too short to lean on`);
          out = pieces(n, [[lean, neighbour(k, !o.below, o)], [rest(lean), k]], o.key, from);
          break;
        }
        case "slide":
        case "fall": {
          if (o.slide === 0) throw new Error(`a ${o.kind} comes from 1 to 12 semitones away`);
          const s = Math.abs(o.slide), d = Math.sign(o.slide);
          need(n, s + 1, `a ${o.kind} of ${s}`);
          const run = Array.from({ length: s }, (_, i) => [r, o.kind === "slide" ? k + o.slide - d * i : k + d * (i + 1)]);
          out = pieces(n, o.kind === "slide" ? [...run, [rest(s * r), k]] : [[rest(s * r), k], ...run], o.key, from);
          break;
        }
        case "grace": {
          const g = n.at - r;
          if (g < 0) throw new Error("no room before the part's start for a grace note");
          const before = work.filter((x) => x !== n && x.at < n.at && x.at + x.ticks > g);
          const inside = before.find((x) => x.at >= g);
          if (inside) throw new Error(`no room for a grace note: the note at ${where(part, inside.at)} starts in its time`);
          for (const x of before) {
            const y = { ...x, ticks: g - x.at };
            from.set(y, origin(x));
            if (made.has(x)) { made.delete(x); made.add(y); }
            work = work.map((w) => (w === x ? y : w));
          }
          const grace = { ...n, ...named(n, neighbour(k, !o.below, o), o.key), at: g, ticks: r };
          const main = { ...n, lyric: held(n.lyric) };
          from.set(grace, n);
          from.set(main, n);
          out = [grace, main];
          placed.set(n, g);
          break;
        }
      }
    });
    work = work.flatMap((x) => (x === n ? out : [x]));
    out.forEach((m) => made.add(m));
  }
  const marks = placed.size ? follow(part, [...placed.keys()], (n) => placed.get(n)) : part.marks;
  return finish(part, work, { from, chosen: [...made], marks });
}

// From each chosen note to the next, a run along the key's scale through the keys between them,
// sung on the first's syllable: in the first note's end at `rate` ticks a note, or with `whole`
// sharing its length evenly.
export function run(part, notes, options = {}) {
  const o = settle("run", part, options), mine = chosen(part, notes);
  if (!o.key) throw new Error("a run goes along a key's scale: choose a key");
  if (mine.length < 2) throw new Error("a run goes from one chosen note to the next: choose two notes or more");
  const from = new Map(), swap = new Map(), out = [];
  mine.slice(0, -1).forEach((a, i) => {
    const b = mine[i + 1], ka = P.key(a.pitch), kb = P.key(b.pitch);
    if (b.at < a.at + a.ticks) throw new Error(`${where(part, b.at)}: the note starts before the one before it ends; a run fills that note's own time`);
    const between = [];
    for (let k = ka + Math.sign(kb - ka); k !== kb && ka !== kb; k += Math.sign(kb - ka)) if (T.inKey(o.key, k)) between.push(k);
    if (!between.length) return;
    let list;
    if (o.whole) {
      const c = between.length + 1, edge = (j) => Math.floor(j * a.ticks / c);
      if (a.ticks < c) throw new Error(`${where(part, a.at)}: the note is ${a.ticks} ticks long, too short for a run of ${c}`);
      list = [ka, ...between].map((k, j) => [edge(j + 1) - edge(j), k]);
    } else {
      const left = a.ticks - between.length * o.rate;
      if (left < 1) throw new Error(`${where(part, a.at)}: a run of ${between.length} at ${o.rate} ticks a note needs more than ${between.length * o.rate} ticks, and the note is ${a.ticks}`);
      list = [[left, ka], ...between.map((k) => [o.rate, k])];
    }
    const made = at(part, a, () => pieces(a, list, o.key, from));
    swap.set(a, made);
    out.push(...made);
  });
  if (!out.length) throw new Error("no key of the scale lies between the chosen notes");
  return finish(part, swapped(part, swap), { from, chosen: out });
}

// ---------------------------------------------------------------- arpeggios

// a seeded random number from 0 to 1 (mulberry32)
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The order, `count` long, a line takes through `n` notes (0 the lowest): `written` is the
// order they were written in.
function sequence(pattern, n, count, { written, rng, digits }) {
  const up = Array.from({ length: n }, (_, i) => i);
  let cycle;
  switch (pattern) {
    case "up": cycle = up; break;
    case "down": cycle = up.slice().reverse(); break;
    case "up and down": cycle = n < 3 ? up : [...up, ...up.slice(1, -1).reverse()]; break;
    case "down and up": cycle = n < 3 ? up.slice().reverse() : [...up.slice().reverse(), ...up.slice(1, -1)]; break;
    case "outside in": cycle = up.map((_, i) => (i % 2 ? n - 1 - (i - 1) / 2 : i / 2)); break;
    case "as written": cycle = written; break;
    case "digits": cycle = digits.map((d) => {
      if (d > n) throw new Error(`${d} in the digits: the chord has ${n} ${n === 1 ? "note" : "notes"}`);
      return d - 1;
    }); break;
    case "random": {
      const out = [];
      while (out.length < count) {
        const deck = up.slice();
        for (let i = n - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        // no note twice running across two rounds
        if (n > 1 && out.length && deck[0] === out.at(-1)) [deck[0], deck[1]] = [deck[1], deck[0]];
        out.push(...deck);
      }
      return out.slice(0, count);
    }
  }
  return Array.from({ length: count }, (_, i) => cycle[i % cycle.length]);
}

// Notes that sound together (each set of chosen notes overlapping in time) become one line over
// their time: a note each `rate` ticks, the last running to the end, each sounding `gate` of its
// time, through the chord's keys over `octaves` octaves in `pattern`'s order. A note sounding
// alone is given the `chord` of that kind on it in the key first, where one is chosen. The
// chord's syllable is on the line's first note, the rest hold it.
export function arpeggiate(part, notes, options = {}) {
  const o = settle("arpeggiate", part, options), mine = chosen(part, notes);
  let digits = null;
  if (o.pattern === "digits") {
    const words = o.digits.trim().split(/[\s,]+/).filter(Boolean);
    if (!words.length || !words.every((w) => /^[1-9]\d*$/.test(w))) throw new Error(`"${o.digits}": the digits are the chord's notes counted from the lowest, 1 first, as 1 3 2 4`);
    digits = words.map(Number);
  }
  if (o.chord !== "none" && !o.key) throw new Error(`a ${o.chord} on a note alone is built in a key: choose a key`);
  const groups = [];
  let end = -1;
  for (const n of mine) {
    if (groups.length && n.at < end) groups.at(-1).push(n);
    else groups.push([n]);
    end = Math.max(groups.at(-1).length > 1 ? end : 0, n.at + n.ticks);
  }
  const rng = random(o.seed), from = new Map(), swap = new Map(), out = [];
  for (const g of groups) {
    const s = Math.min(...g.map((n) => n.at)), e = Math.max(...g.map((n) => n.at + n.ticks)), head = g[0];
    const syl = [...new Set(g.map((n) => n.lyric).filter((l) => l !== null && l !== "_"))];
    if (syl.length > 1) throw new Error(`${where(part, s)}: the chord's notes carry ${syl.map((l) => `"${l}"`).join(" and ")}; a line sings one syllable`);
    const lyric = syl[0] ?? (g.some((n) => n.lyric === "_") ? "_" : null);
    // the chord's keys, rising, each with the note it comes from
    let keys = [];
    for (const n of g) if (!keys.some((x) => x.k === P.key(n.pitch))) keys.push({ k: P.key(n.pitch), n });
    const written = keys.map((x) => x.k);
    if (g.length === 1 && o.chord !== "none") {
      keys = at(part, head, () => T.chord(o.key, P.key(head.pitch), o.chord)).map((k, i) => ({ k, n: head, own: i === 0 }));
    }
    keys.sort((a, b) => a.k - b.k);
    const line = [];
    for (let v = 0; v < o.octaves; v++) {
      for (const x of keys) {
        const k = x.k + 12 * v;
        if (k > 127) throw new Error(`${where(part, s)}: ${o.octaves} octaves of the chord go past MIDI's keys, C-1 to G9`);
        const own = x.own ?? true;
        line.push({ k, n: x.n, pitch: own ? T.moved(x.n.pitch, 12 * v) : T.spell(o.key, k), cents: own ? x.n.cents : 0 });
      }
    }
    const count = Math.floor((e - s) / o.rate);
    if (count < 1) throw new Error(`${where(part, s)}: the chord is ${e - s} ticks long, shorter than a note of the line at ${o.rate}`);
    // as written: the chord's notes in the order of their starts; a chord made for a note, rising
    const firsts = written.length === keys.length ? written.map((k) => keys.findIndex((x) => x.k === k)) : keys.map((_, i) => i);
    const all = Array.from({ length: o.octaves }, (_, v) => firsts.map((i) => i + v * keys.length)).flat();
    const seq = at(part, head, () => sequence(o.pattern, line.length, count, { written: all, rng, digits }));
    const made = seq.map((idx, i) => {
      const t = s + i * o.rate, len = i < count - 1 ? o.rate : e - t, x = line[idx];
      const m = { ...x.n, pitch: x.pitch, cents: x.cents, at: t, ticks: Math.max(1, Math.round(len * o.gate)), lyric: i === 0 ? lyric : held(lyric) };
      from.set(m, head);
      return m;
    });
    g.forEach((n, i) => swap.set(n, i === 0 ? made : []));
    out.push(...made);
  }
  return finish(part, swapped(part, swap), { from, chosen: out });
}

// ---------------------------------------------------------------- the vibrato

// The drawn vibrato shaped over each chosen note `least` beats long or more, then back to what
// stood at the note's end: late (`low` until `at` of the note, then `top`, the singer easing the
// step as it eases any), swell (a line from `low` up to `top` at `at`, and down to `low` at the end) or fade
// (`top` until `at`, then a line down to `low`). Points inside a shaped note are replaced; the
// smallest is never 0, so a note under motion - is never sung as a flat tone.
export function swell(part, notes, options = {}) {
  const o = settle("swell", part, options), mine = chosen(part, notes);
  const shaped = mine.filter((n) => n.ticks >= o.least * part.grid);
  if (!shaped.length) throw new Error(`none of the chosen notes is ${o.least} ${o.least === 1 ? "beat" : "beats"} long or more`);
  shaped.forEach((n, i) => {
    const b = shaped[i + 1];
    if (b && b.at < n.at + n.ticks) throw new Error(`${where(part, b.at)}: two chosen notes sound at once, and the vibrato is one line`);
  });
  const pts = part.lanes.vibrato, low = six(o.low), top = six(o.top);
  const inside = (t) => shaped.some((n) => n.at <= t && t < n.at + n.ticks);
  const ends = new Set(shaped.map((n) => n.at + n.ticks)), starts = new Set(shaped.map((n) => n.at));
  // a point kept at a shaped note's end holds there: what led to it by a line is gone
  let kept = pts.filter((q) => !inside(q.at));
  kept = kept.filter((q, i) => !(ends.has(q.at) && kept[i + 1]?.at === q.at)).map((q) => (ends.has(q.at) && q.line ? { ...q, line: false } : q));
  const made = [];
  for (const n of shaped) {
    const a = n.at, e = n.at + n.ticks, t = a + Math.round(o.at * n.ticks);
    if (!(t > a && t < e)) throw new Error(`${where(part, a)}: the note is ${n.ticks} ticks long, too short to shape`);
    const p = (at, value, line = false) => made.push({ at, value, line });
    if (o.shape === "late") { p(a, low); p(t, top); }
    if (o.shape === "swell") { p(a, low); p(t, top, true); p(e, low, true); }
    if (o.shape === "fade") { p(a, top); p(t, top); p(e, low, true); }
    if (!starts.has(e) && !kept.some((q) => q.at === e)) p(e, six(P.at(pts, e, P.REST.vibrato)));
  }
  const lane = [...kept, ...made].map((q, i) => [q, i]).sort(([x, i], [y, j]) => x.at - y.at || (x.line ? 0 : 1) - (y.line ? 0 : 1) || i - j).map(([q]) => q);
  return finish(part, part.notes, { chosen: mine, lanes: { ...part.lanes, vibrato: lane } });
}
