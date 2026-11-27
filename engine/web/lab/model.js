// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The diction bench's reckoning, no page in it: a song's text and the edits to it (a word's sounds
// in braces, its notes, the tempo), the diction's rules as `%diction` lines, the sing options, what
// a sweep runs over, and the text it all comes to (engine/src/sing.rs: `word{...}`;
// engine/src/diction.rs: the rules). Nothing here chooses how anything is sung; what is offered
// is the engine's (`bench`: ls_bench's phones, options, motions, sets and dipped).
import { cue, isVowel, name, sounds, stress } from "./sounds.js";

export const SR = 24000;
// samples a frame of the sung pitch and the level
export const HOP = 240;

const clone = (x) => JSON.parse(JSON.stringify(x));
// a number on a pull's steps, without the float's tail
export const snap = (v, step) => Number((Math.round(v / step) * step).toFixed(6));

// ---------------------------------------------------------------- a word's sounds

// A sound of a word: {p: its symbol, a vowel's stress digit on it; close: it ends the vowel
// before it; ms: a close's written length, or null}.
export const sound = (s, close = false, ms = null) => {
  if (!/^[A-Z]+[012]?$/.test(s)) throw new Error(`${s}: not a sound`);
  return { p: s, close, ms: close ? ms : null };
};
// a vowel written without its stress digit is strong, as the engine reads it
const read = (s, vowels) => (vowels.includes(s) ? `${s}1` : s);

// "N,AA,~AY:200,T" (what goes between a word's braces) to sounds, and back
export const parsePhones = (text, bench) => {
  const { vowels } = sounds(bench.phones);
  return text.split(",").map((x) => {
    const close = x.startsWith("~");
    const [s, ms, ...more] = (close ? x.slice(1) : x).split(":");
    if (more.length || (ms !== undefined && !/^\d+$/.test(ms))) throw new Error(`${x}: a sound, or ~SOUND:MS for a vowel's end`);
    if (!bench.phones.includes(read(s, vowels))) throw new Error(`${s}: not a sound the engine has`);
    return sound(read(s, vowels), close, ms === undefined ? null : Number(ms));
  });
};
const sym = (p) => p.replace(/1$/, "");
export const phonesText = (phones) => phones.map((s) => `${s.close ? "~" : ""}${sym(s.p)}${s.close && s.ms !== null ? `:${s.ms}` : ""}`).join(",");

// a word as the engine planned it ({word, phones: [[symbol, close, start, end]]}, samples) as
// sounds: written so, it is sung the same again
export const fromPlan = (w) => w.phones.map(([p, close, a, b]) => sound(p, !!close, close ? Math.round(((b - a) / SR) * 1000) : null));

// The sounds with one changed, each a new list. `n` is a sound's name: a vowel in a vowel's place
// keeps that vowel's stress, else it is strong.
export const withName = (n, was, bench) => {
  const { vowels } = sounds(bench.phones);
  if (!vowels.includes(n)) return n;
  return `${n}${was && isVowel(was) ? stress(was) : "1"}`;
};
export const setSound = (phones, i, n, bench) => phones.map((x, k) => (k === i ? sound(withName(n, x.p, bench), x.close, x.ms) : x));
export const setStress = (phones, i, digit) => phones.map((x, k) => (k === i ? { ...x, p: `${name(x.p)}${digit}` } : x));
// a vowel left out takes its end with it
export const removeSound = (phones, i) => phones.filter((x, k) => k !== i && !(k === i + 1 && x.close && !phones[i].close));
export const insertSound = (phones, at, n, bench) => [...phones.slice(0, at), sound(withName(n, null, bench)), ...phones.slice(at)];
export const hasClose = (phones, i) => !!phones[i + 1]?.close;
// the vowel at i ended on sound n for ms (null: no written length), or with n null its end taken away
export const setClose = (phones, i, n, ms, bench) => {
  const out = phones.filter((x, k) => !(k === i + 1 && x.close));
  if (n !== null) out.splice(i + 1, 0, sound(withName(n, null, bench), true, ms));
  return out;
};
export const setCloseMs = (phones, i, ms) => phones.map((x, k) => (k === i ? { ...x, ms } : x));

// ---------------------------------------------------------------- the song's text

// The engine's reader of a song's text (lipservice.js Engine.song: engine/src/song.rs, the one
// reader of the format), given once. Every reading here is its.
let reader = null;
export const useReader = (read) => { reader = read; last = null; };
let last = null;
// A song's text as the engine reads it; where it refuses the text, its refusal thrown.
export const reading = (text) => {
  if (!reader) throw new Error("the song's reader is not given (useReader)");
  if (last?.text !== text) {
    last = { text, song: null, refusal: null };
    try { last.song = reader(text); } catch (e) { last.refusal = e; }
  }
  if (last.refusal) throw last.refusal;
  return last.song;
};
// why the engine does not read a text, in its words; null where it does
export const refusal = (text) => {
  try { reading(text); return null; } catch (e) { return e.message; }
};
const fields = (raw) => raw.trim().split(/\s+/).filter(Boolean);

// The song's words in order: [{line (from 0), word, braces (its sounds as written, or null), notes
// (its note groups as written)}]. A text the engine does not read has none to show or change: its
// refusal is what the page shows.
export const wordLines = (text) =>
  (refusal(text) === null ? reading(text).items : []).filter((i) => i.kind === "word")
    .map((i) => ({ line: i.line - 1, word: i.word, braces: i.braces, notes: i.notes.map((g) => g.map((n) => `${n.note}:${n.beats_text}`).join("+")) }));

const rewrite = (text, line, change) => {
  const rows = text.split("\n");
  rows[line] = `${rows[line].match(/^\s*/)[0]}${change(fields(rows[line])).join(" ")}`;
  return rows.join("\n");
};
const wordAt = (text, k) => {
  const no = refusal(text);
  if (no !== null) throw new Error(no);
  const w = wordLines(text)[k];
  if (!w) throw new Error(`the song has no word ${k + 1}`);
  return w;
};

// word k's sounds written in its braces, or with null its braces taken away
export const setWordPhones = (text, k, phones) => {
  const w = wordAt(text, k);
  return rewrite(text, w.line, (f) => [phones === null ? w.word : `${w.word}{${phonesText(phones)}}`, ...f.slice(1)]);
};

const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
// a note as written (C4, F#3, Bb2 or a MIDI number) as MIDI
export const midiOf = (s) => {
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^([A-G])([#b]*)(-?\d+)$/.exec(s);
  if (!m) throw new Error(`${s}: not a note (C4, F#3, Bb2 or a MIDI number)`);
  return 12 * (Number(m[3]) + 1) + SHARPS.indexOf(m[1]) + [...m[2]].reduce((a, c) => a + (c === "#" ? 1 : -1), 0);
};
// a note a whole number of semitones from one written, written as that one was (a number, flats, or sharps)
export const noteMoved = (s, semis) => {
  const m = Math.min(127, Math.max(0, midiOf(s) + semis));
  if (/^\d/.test(s)) return String(m);
  return `${(s.includes("b") ? FLATS : SHARPS)[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
};

// word k's notes in order: [{note, beats (as written)}], the notes sharing a syllable among them
export const notesOf = (text, k) =>
  wordAt(text, k).notes.flatMap((g, gi) => g.split("+").map((x, xi) => {
    const [note, beats] = x.split(":");
    return { note, beats, group: gi, first: xi === 0 };
  }));
// word k's note j written anew: {note} and/or {beats}
export const setNote = (text, k, j, to) => {
  const w = wordAt(text, k);
  let at = 0;
  const groups = w.notes.map((g) => g.split("+").map((x) => {
    const [note, beats] = x.split(":");
    const mine = at++ === j;
    return `${mine && to.note !== undefined ? to.note : note}:${mine && to.beats !== undefined ? to.beats : beats}`;
  }).join("+"));
  if (j < 0 || j >= at) throw new Error(`${w.word} has no note ${j + 1}`);
  return rewrite(text, w.line, (f) => [f[0], ...groups]);
};

// the song's tempo, or null where the engine does not read the text
export const bpmOf = (text) => (refusal(text) === null ? reading(text).bpm : null);
// the tempo written: in its line where the text has one, else as a first line
export const setBpm = (text, bpm) => {
  const line = text.split("\n").findIndex((raw) => fields(raw)[0] === "%bpm");
  return line < 0 ? `%bpm ${bpm}\n${text}` : rewrite(text, line, () => ["%bpm", String(bpm)]);
};

// ---------------------------------------------------------------- the diction's rules

// A bench's rules: {sung (a singer's vowels, the engine's sung set, bench.sets.sung; off is
// `spoken`; plain's are always sung by), rows: [a rule each, in order]}. A row: {kind, off (kept, not
// sung by), who (true: for the bench's voice alone)}, and by kind
//   vowel  {of, held (ms), hold, close (or null), ms, into (the close before a vowel, or null:
//          the same), whole: [consonants it is left alone before]}: a held vowel sung as `hold`
//          and closed by `close` in its last ms
//   dip    {depth, every (every b, d, g and j, not a word's first b, d or g alone)}
//   word   {word, phones (as braces hold them)}: every such word of the song
//   line   {text}: a rule as the engine reads it (engine/src/diction.rs)
export const freshRules = () => ({ sung: true, rows: [] });

// what a set's line holds for a held vowel, as a vowel row's fields
const HELD = /^([A-Z]+) held>=(\d+)(?: not-before=([A-Z,]+))?( before=vowel)? -> ([A-Z]+)(?: ~([A-Z]+):<(\d+))?$/;
// a vowel row for `of` as the sets sing it; with no set's rule for it, the vowel held as itself
export const vowelRow = (bench, of) => {
  const row = { kind: "vowel", of, held: 240, hold: of, close: null, ms: 200, into: null, whole: [] };
  for (const lines of Object.values(bench.sets)) {
    for (const l of lines) {
      const m = HELD.exec(l);
      if (!m || `${m[1]}1` !== of) continue;
      if (m[4]) row.into = m[6] ? `${m[6]}1` : null;
      else Object.assign(row, { held: Number(m[2]), whole: m[3] ? m[3].split(",") : [], hold: `${m[5]}1`, close: m[6] ? `${m[6]}1` : null, ms: m[7] ? Number(m[7]) : 200 });
    }
  }
  return row;
};
// the vowels the sets hold in two
export const setVowels = (bench) => [...new Set(Object.values(bench.sets).flat().map((l) => HELD.exec(l)).filter(Boolean).map((m) => `${m[1]}1`))];

const tight = (s) => s.replace(/\s+/g, "").toLowerCase();
// A row as the engine's rules, without the word `diction`: none for a line not yet written.
export const rowLines = (row, voice) => {
  const who = row.who ? `for=${tight(voice)} ` : "";
  if (row.kind === "vowel") {
    const head = `${who}${sym(row.of)} held>=${row.held}`, end = (c) => (c === null ? "" : ` ~${sym(c)}:<${row.ms}`);
    // the sets' rules for the vowel are off: the row is all that is sung of it
    const out = [`${who}${sym(row.of)} -> same`, `${head}${row.whole.length ? ` not-before=${row.whole.join(",")}` : ""} -> ${sym(row.hold)}${end(row.close)}`];
    if (row.close !== null && row.into !== null && row.into !== row.close) out.push(`${head} before=vowel -> ${sym(row.hold)}${end(row.into)}`);
    return out;
  }
  if (row.kind === "dip") return [`${who}${row.every ? "B,D,G,JH" : "B,D,G place=first"} -> dip=${row.depth}`];
  if (row.kind === "word") return [`${who}word=${row.word} -> ${row.phones.split(",").join(" ")}`];
  if (row.kind === "line") return row.text.trim() ? [`${who}${row.text.trim()}`] : [];
  throw new Error(`${row.kind}: not a kind of rule`);
};

// The `%diction` lines that make the engine's rules these: none where the song is sung as every
// song is.
export const ruleLines = (rules, voice) => {
  const out = rules.sung ? [] : ["%diction spoken"];
  for (const r of rules.rows) if (!r.off) out.push(...rowLines(r, voice).map((l) => `%diction ${l}`));
  return out;
};

const KINDS = { vowel: ["of", "held", "hold", "close", "ms", "into", "whole"], dip: ["depth", "every"], word: ["word", "phones"], line: ["text"] };
const checkedRules = (r) => {
  if (!r || typeof r.sung !== "boolean" || "sets" in r || !Array.isArray(r.rows)) throw new Error("its rules are not this engine's");
  for (const row of r.rows) if (!KINDS[row?.kind] || KINDS[row.kind].some((f) => !(f in row))) throw new Error("one of its rules is not a rule of this bench");
};

// ---------------------------------------------------------------- a bench's state

// What is sung: {text (the song), voice, options (the engine's sing options by name; motion a
// motion's name or "none"), rules}.
export const fresh = (bench, voices) => ({
  text: "",
  voice: voices[0].name,
  options: Object.fromEntries(bench.options.map((o) => [o.name, o.kind === "choice" ? "none" : o.kind === "switch" ? false : o.default])),
  rules: freshRules(),
});

// a state from a saved session, refused where it is not one of this engine's
export const checked = (s, bench, voices) => {
  if (typeof s?.text !== "string" || !voices.some((v) => v.name === s.voice)) throw new Error("not a bench's state, or its voice is not here");
  const names = bench.options.map((o) => o.name);
  if (Object.keys(s.options ?? {}).sort().join() !== [...names].sort().join()) throw new Error("its sing options are not this engine's");
  checkedRules(s.rules);
  return clone(s);
};

// The text the engine is given: the rules' lines, then the song, whose own diction lines are read
// after them. `lines`: how many lines stand before the song's first.
export const sungText = (state) => {
  const lines = ruleLines(state.rules, state.voice);
  return { text: lines.length ? `${lines.join("\n")}\n${state.text}` : state.text, lines: lines.length };
};

// The command line's flags that sing the same: the voice, and what is not as the engine has it.
export const commandFlags = (state, bench) => {
  const flags = ["--voice", state.voice];
  for (const o of bench.options) {
    const v = state.options[o.name], flag = `--${o.name.replace(/_/g, "-")}`;
    if (o.kind === "switch") { if (v) flags.push(flag); } else if (o.kind === "choice") { if (v !== "none") flags.push(flag, v); } else if (v !== o.default) flags.push(flag, String(v));
  }
  return flags;
};
export const commandLine = (state, bench, song = "song.txt", out = "song.wav") => ["lipservice sing", song, "-o", out, ...commandFlags(state, bench)].join(" ");

// What differs between two states, in plain words.
export const differences = (a, b, bench) => {
  const out = [];
  if (a.voice !== b.voice) out.push(`the singer: ${a.voice}, ${b.voice}`);
  for (const o of bench.options) if (a.options[o.name] !== b.options[o.name]) out.push(`${label(o.name)}: ${show(a.options[o.name])}, ${show(b.options[o.name])}`);
  const [ra, rb] = [ruleLines(a.rules, a.voice), ruleLines(b.rules, b.voice)];
  if (ra.join("\n") !== rb.join("\n")) out.push("the rules");
  const [la, lb] = [a.text.split("\n"), b.text.split("\n")];
  const n = Math.max(la.length, lb.length);
  let lines = 0;
  for (let i = 0; i < n; i++) if ((la[i] ?? "").trim() !== (lb[i] ?? "").trim()) lines++;
  if (lines) out.push(`${lines} line${lines === 1 ? "" : "s"} of the song`);
  return out;
};
export const label = (n) => n.replace(/_/g, " ");
const show = (v) => (v === true ? "on" : v === false ? "off" : String(v));

// ---------------------------------------------------------------- what a sweep can run over

// Everything of a state that takes more than one value: [{id, label, kind: "number" (min, max,
// step) or "choice" (choices: [{value, label}]), get(state), set(state, value): a new state}].
// `sel`: the chosen sound, {k: its word among the song's, i: its place in the word, phones: the
// word's sounds}, or null.
export const targets = (state, bench, sel = null) => {
  const snd = sounds(bench.phones), out = [];
  const put = (s, f) => { const n = clone(s); f(n); return n; };
  const vowelChoices = (none) => [...(none ? [{ value: null, label: none }] : []), ...snd.vowels.map((v) => ({ value: `${v}1`, label: cue(`${v}1`) }))];
  for (const o of bench.options) {
    const base = { id: `option.${o.name}`, label: label(o.name), get: (s) => s.options[o.name], set: (s, v) => put(s, (n) => { n.options[o.name] = v; }) };
    if (o.kind === "number" || o.kind === "whole") out.push({ ...base, kind: "number", min: o.min, max: o.max, step: o.step });
    else if (o.kind === "switch") out.push({ ...base, kind: "choice", choices: [{ value: false, label: "off" }, { value: true, label: "on" }] });
    else out.push({ ...base, kind: "choice", choices: ["none", ...bench.motions].map((m) => ({ value: m, label: m })) });
  }
  const bpm = bpmOf(state.text);
  if (bpm !== null) out.push({ id: "bpm", label: "tempo", kind: "number", min: 20, max: 300, step: 1, get: (s) => bpmOf(s.text), set: (s, v) => put(s, (n) => { n.text = setBpm(n.text, v); }) });
  state.rules.rows.forEach((r, j) => {
    const row = (s) => s.rules.rows[j];
    const field = (f) => ({ get: (s) => row(s)[f], set: (s, v) => put(s, (n) => { n.rules.rows[j][f] = v; }) });
    if (r.kind === "vowel") {
      const who = `a held ${cue(r.of)}`;
      out.push({ id: `rule.${j}.held`, label: `${who}: held at least`, kind: "number", min: 10, max: 3000, step: 10, ...field("held") });
      out.push({ id: `rule.${j}.hold`, label: `${who}: held on`, kind: "choice", choices: vowelChoices(null), ...field("hold") });
      out.push({ id: `rule.${j}.close`, label: `${who}: ended on`, kind: "choice", choices: vowelChoices("nothing"), ...field("close") });
      out.push({ id: `rule.${j}.ms`, label: `${who}: its end's length`, kind: "number", min: 10, max: 1500, step: 10, ...field("ms") });
    } else if (r.kind === "dip") {
      out.push({ id: `rule.${j}.depth`, label: "the pitch dip through b, d, g", kind: "number", min: 0, max: 4, step: 0.1, ...field("depth") });
    }
  });
  if (sel) {
    const x = sel.phones[sel.i], word = wordLines(state.text)[sel.k]?.word;
    const edit = (f) => (s, v) => put(s, (n) => { n.text = setWordPhones(n.text, sel.k, f(v)); });
    const names = x.close ? snd.vowels : snd.all;
    out.push({ id: "sound", label: `the chosen sound of "${word}"`, kind: "choice", choices: names.map((v) => ({ value: v, label: cue(withName(v, x.p, bench)) })), get: () => name(x.p), set: edit((v) => setSound(sel.phones, sel.i, v, bench)) });
    if (x.close) out.push({ id: "sound.ms", label: `the chosen end's length in "${word}"`, kind: "number", min: 10, max: 1500, step: 10, get: () => x.ms, set: edit((v) => setCloseMs(sel.phones, sel.i, v)) });
  }
  return out;
};

// `count` values from `from` to `to`, on a pull's steps, none twice
export const sweepValues = (from, to, count, step) => {
  if (!(count >= 2)) throw new Error("a sweep takes two values or more");
  const out = [];
  for (let j = 0; j < count; j++) {
    const v = snap(from + ((to - from) * j) / (count - 1), step);
    if (!out.includes(v)) out.push(v);
  }
  return out;
};

// ---------------------------------------------------------------- what was sung

// a sound's loudness a frame (HOP samples): rms, as the engine's own levels
export const levels = (y) => {
  const out = new Float32Array(Math.ceil(y.length / HOP));
  for (let f = 0; f < out.length; f++) {
    const a = f * HOP, b = Math.min(y.length, a + HOP);
    let e = 0;
    for (let i = a; i < b; i++) e += y[i] * y[i];
    out[f] = Math.sqrt(e / (b - a));
  }
  return out;
};
// word k's samples in a plan, [start, end)
export const wordSpan = (plan, k) => [plan[k].phones[0][2], plan[k].phones.at(-1)[3]];
