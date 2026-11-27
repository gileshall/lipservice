// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A song as a singer reads it: its phrases and the lines written along it (parse), whether it writes
// any (laned), its vibrato sized (sized), and what of a part decides how it is sung (asked). How a
// part is performed (its timing loosened, breaths cut from VocalSet taken in the rests) is the
// engine's (engine/src/part.rs, ls_perform).

export const SR = 24000;
export const FPS = 100;
export const LEAD = 0.1; // s the engine sets before a song's first sound

// What of a part decides how it is sung: all but its level and seat, whether it is muted (left out
// of the mix: the others sung alone), and its name, unless a rule of its diction is for someone
// (for=), which its name may be.
export const asked = (p) => JSON.stringify({ ...p, name: (p.diction || []).some((l) => /(^|\s)for=/.test(l)) ? p.name : undefined, gain: undefined, levels: undefined, seat: undefined, mute: undefined });

// The song's phrases (runs of words with no rest between), in beats from its start:
// {bpm, phrases: [{start, words: [{word, groups: [[{pitch, beats}]]}]}], tail}, its notes kept as
// written. A lane's lines (LANES: a value written along the song, taking no time) stay with the
// word they come before: its lane, [{line, back}], back the beats of rest between the line and
// the word. Those after the last word are the song's after. Its %diction lines are its diction,
// and together says it has its %together line; each is left out where the song has none.
//
// The format's reader is the engine's (engine/src/song.rs; lipservice.js song()). This is that
// reader again, line for line and refusal for refusal, for the pieces choirs.js builds as it loads,
// before there is an engine to ask: engine/tests/songs.json holds songs and what the engine makes
// of each, and perform_test.mjs holds this to them.
export const LANES = ["%vibrato"];
export const INSTRUCTIONS = ["%bpm", "%together", "%diction", "%rest", "%vibrato"];
const BPM = [20, 400];
const fmt = (b) => b.toFixed(6).replace(/\.?0+$/, "");
// a number as the engine reads one
const NUMBER = /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf|infinity|nan)$/i;
const number = (s) => (NUMBER.test(s) ? Number(s.replace(/^([+-]?)inf(inity)?$/i, "$1Infinity")) : NaN);
const beats = (s) => {
  const v = number(s);
  if (!(v > 0 && Number.isFinite(v))) throw new Error(`${s}: beats must be a positive number`);
  return v;
};
const STEPS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midi(s) {
  if (NUMBER.test(s)) {
    const v = number(s);
    if (!(v >= 0 && v <= 127)) throw new Error(`${s}: MIDI 0 to 127`);
    return v;
  }
  const m = /^([A-G])([#b]*)(.*)$/s.exec(s);
  if (!m || !/^[+-]?\d+$/.test(m[3])) throw new Error(`${s}: not a note (C4, F#3, Bb2 or a MIDI number)`);
  const v = 12 * (Number(m[3]) + 1) + STEPS[m[1]] + [...m[2]].reduce((a, c) => a + (c === "#" ? 1 : -1), 0);
  if (!(v >= 0 && v <= 127)) throw new Error(`${s}: outside MIDI 0 to 127`);
  return v;
}
function size(s) {
  const k = s.indexOf(":"), v = k < 0 ? s : s.slice(0, k);
  if (k >= 0) beats(s.slice(k + 1));
  if (!(number(v) >= 0 && Number.isFinite(number(v)))) throw new Error(`${s}: a size is VALUE or VALUE:BEATS, the value 0 or more`);
}
// what an instruction's word was before it took its %
const once = (f) => (["bpm", "rest", "vibrato", "together", "diction"].includes(f[0]) ? ` (the instruction is written %${f.join(" ")})` : "");
function word(f) {
  if (f.length < 2) throw new Error(`${f[0]}: a word takes its notes, NOTE:BEATS each${once(f)}`);
  const w = f[0];
  if (/[{}]/.test(w) && !/^[^{}]+\{[^{}]+\}$/.test(w)) throw new Error(`${w}: a word's phones are written in one piece, commas between: night{N,AA,~AY:200,T}`);
  return f.slice(1).map((g) => g.split("+").map((x) => {
    const k = x.indexOf(":");
    if (k < 1 || x.indexOf(":", k + 1) >= 0) throw new Error(`${x}: a note is NOTE:BEATS${once(f)}`);
    midi(x.slice(0, k));
    return { pitch: x.slice(0, k), beats: beats(x.slice(k + 1)) };
  }));
}
export function parse(text) {
  let bpm = null, beat = 0, cur = null, tail = 0, lane = [], together = false, sung = false;
  const phrases = [], diction = [];
  // a line ends at \n or \r\n, as the engine's do
  text.split("\n").forEach((raw, i, all) => {
    if (i === all.length - 1 && raw === "") return;
    const line = raw.trim(), n = i + 1;
    if (!line || line.startsWith("#")) return;
    const f = line.split(/\s+/);
    const no = (what) => { throw new Error(`line ${n}: ${what}`); };
    const at = (g) => { try { return g(); } catch (e) { return no(e.message); } };
    const head = (what) => { if (sung) no(`${what} is the whole song's: it comes before the first word`); };
    if (f[0] === "%bpm") {
      head("%bpm");
      if (f.length !== 2) no("%bpm takes one number");
      const v = number(f[1]);
      if (!(v >= BPM[0] && v <= BPM[1])) no(`%bpm ${f[1]}: ${BPM[0]} to ${BPM[1]} beats a minute`);
      if (bpm !== null) no("%bpm given twice: a song has one tempo");
      bpm = v;
    } else if (f[0] === "%together") {
      head("%together");
      if (f.length !== 1) no("%together takes nothing after it");
      if (together) no("%together given twice");
      together = true;
    } else if (f[0] === "%diction") {
      head("%diction");
      if (f.length < 2) no("%diction takes a rule (diction.rs), or spoken, or sung");
      diction.push(f.join(" "));
    } else if (f[0] === "%rest") {
      if (f.length !== 2) no("%rest takes one number, its beats");
      const b = at(() => beats(f[1]));
      beat += b;
      for (const c of lane) c.back += b;
      cur = null;
      tail = beat - (phrases.length ? end(phrases.at(-1)) : beat);
    } else if (f[0] === "%vibrato") {
      if (f.length < 2) no("%vibrato takes its sizes, VALUE or VALUE:BEATS each");
      at(() => f.slice(1).forEach(size));
      lane.push({ line: f.join(" "), back: 0 });
    } else if (f[0].startsWith("%")) {
      no(`${f[0]}: not an instruction (${INSTRUCTIONS.join(", ")})`);
    } else {
      sung = true;
      const groups = at(() => word(f));
      if (!cur) { cur = { start: beat, words: [] }; phrases.push(cur); }
      cur.words.push({ word: f[0], groups, ...(lane.length ? { lane } : {}) });
      lane = [];
      for (const g of groups) for (const x of g) beat += x.beats;
      tail = 0;
    }
  });
  if (bpm === null) throw new Error("the song has no %bpm line");
  if (!sung) throw new Error("the song has no words");
  return {
    bpm, phrases, tail,
    ...(lane.length ? { after: lane.map((c) => c.line) } : {}),
    ...(diction.length ? { diction } : {}),
    ...(together ? { together: true } : {}),
  };
}

// whether a parsed song writes a lane
export const laned = (song) => song.after !== undefined || song.phrases.some((ph) => ph.words.some((w) => w.lane));

// A song with its vibrato `k` times the size: every size its lines write, and the voice's own (1)
// they start from, as a line at the song's head.
export function sized(text, k) {
  if (!(k >= 0 && Number.isFinite(k))) throw new Error(`a vibrato ${k} times the size`);
  if (k === 1) return text;
  let head = false;
  const out = text.split("\n").flatMap((raw) => {
    const f = raw.trim().split(/\s+/);
    if (f[0] === "%bpm" && !head) {
      head = true;
      return [raw, `%vibrato ${fmt(k)}`];
    }
    if (f[0] !== "%vibrato" || f.length < 2) return [raw];
    return [`%vibrato ${f.slice(1).map((x) => {
      const [v, ...over] = x.split(":");
      if (v === "" || !(Number(v) >= 0 && Number.isFinite(Number(v))) || over.length > 1) throw new Error(`${x}: a size is VALUE or VALUE:BEATS, the value 0 or more`);
      return [fmt(Number(v) * k), ...over].join(":");
    }).join(" ")}`];
  });
  if (!head) throw new Error("the song has no %bpm line");
  return out.join("\n");
}

const notes = (ph) => ph.words.flatMap((w) => w.groups.flat());
const end = (ph) => ph.start + notes(ph).reduce((a, x) => a + x.beats, 0);
