// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A part as the engine sings it: the song text sing.rs reads (a word and its notes a line, rests
// for the gaps, the vibrato's lines before each word), as part.rs roll() writes one from a piano
// roll, and what of a part stops it being sung, by beat. No DOM, no engine: what the engine itself
// refuses (a word it says in other syllables than are written) it says when it is asked to sing.
//
// As roll() has it: one note at a time; a note still sounding when the next starts ends there; in
// a word a note runs to the next note's start; a gap between words of `join` beats or less is no
// rest, the note before holds it; any other gap is a rest. A part's tempo changes are written
// flat: the song is at one tempo (tempo()) and each note as many of its beats as it lasts.
// Instructions are lines that start with % (%bpm, %rest, %vibrato); a word line is a word and its
// notes, so a word may be any word but one that starts with % or #.

import * as P from "./part.js";

const PUNCT = ".,;:!?\"()“”";

// The word a run of syllables is, as the engine is given it: joined, no punctuation at its ends.
export function word(lyrics) {
  let w = lyrics.filter((l) => l !== "_").map((l) => P.syllable(l).text).join("");
  while (w && PUNCT.includes(w[0])) w = w.slice(1);
  while (w && PUNCT.includes(w[w.length - 1])) w = w.slice(0, -1);
  return w;
}

// Beats as the song text writes them: six places, trailing zeros dropped (perform.js fmt).
const fmt = (b) => b.toFixed(6).replace(/\.?0+$/, "");

// The tempo a part's song is written at: the engine sings 20 to 400 beats a minute, so the
// part's first tempo, doubled or halved until it is in that range. The seconds sung are the same
// whichever: each note is as many of these beats as it lasts.
export function tempo(part) {
  let bpm = part.tempo[0].bpm;
  while (bpm < 20) bpm *= 2;
  while (bpm > 400) bpm /= 2;
  return bpm;
}

// The seconds from the part's start to a tick, through its tempos.
export function clock(part) {
  const starts = [];
  let s = 0;
  part.tempo.forEach((t, i) => {
    if (i > 0) s += (t.at - part.tempo[i - 1].at) / part.grid * 60 / part.tempo[i - 1].bpm;
    starts.push(s);
  });
  return (tick) => {
    let i = part.tempo.length - 1;
    while (i > 0 && part.tempo[i].at > tick) i--;
    return starts[i] + (tick - part.tempo[i].at) / part.grid * 60 / part.tempo[i].bpm;
  };
}

// clock() the other way: the tick the part has come to, a number of seconds from its start.
export function tickAt(part) {
  const secs = clock(part);
  return (s) => {
    let i = part.tempo.length - 1;
    while (i > 0 && secs(part.tempo[i].at) > s) i--;
    return part.tempo[i].at + (s - secs(part.tempo[i].at)) * part.tempo[i].bpm / 60 * part.grid;
  };
}

// The part's words, each {text, at, groups: [[note...]]} (a syllable's notes each), and what stops
// it being sung: [{at (tick), what}].
export function words(part) {
  const out = [], problems = [], grid = part.grid;
  const stop = (at, what) => problems.push({ at, what: `beat ${P.beat(at, grid)}: ${what}` });
  let open = false; // the last syllable's word goes on
  if (!part.notes.length) problems.push({ at: 0, what: "the part has no notes" });
  part.notes.forEach((n, i) => {
    if (i > 0 && part.notes[i - 1].at === n.at) return stop(n.at, "two notes start together: a singer sings one at a time");
    if (n.lyric === null) return stop(n.at, `the note ${n.pitch} has no words`);
    if (n.lyric === "_") {
      if (!out.length) return stop(n.at, "a held note with no syllable before it");
      return out[out.length - 1].groups.at(-1).push(n);
    }
    if (open) out[out.length - 1].groups.push([n]);
    else out.push({ at: n.at, groups: [[n]] });
    open = P.syllable(n.lyric).on;
  });
  if (open) stop(out.at(-1).groups.at(-1)[0].at, `"${out.at(-1).groups.at(-1)[0].lyric}" goes on to a syllable that is not there`);
  for (const w of out) {
    w.text = word(w.groups.map((g) => g[0].lyric));
    if (!w.text) stop(w.at, `"${w.groups.map((g) => g[0].lyric).join("")}" has no letters to sing`);
    else if (/\s/.test(w.text)) stop(w.at, `"${w.text}" is more than one word`);
    else if (/^[%#]/.test(w.text)) stop(w.at, `"${w.text}" starts with ${w.text[0]}: a line of a song that starts so is ${w.text[0] === "%" ? "an instruction" : "a comment"}, not a word`);
  }
  return { words: out, problems };
}

// What stops the part being sung, before the engine is asked: [{at, what}], in the order of their
// beats.
export function problems(part) {
  const all = [...words(part).problems];
  if (!all.length) {
    try {
      song(part);
    } catch (e) {
      if (e.at === undefined) throw e;
      all.push({ at: e.at, what: e.message });
    }
  }
  return all.sort((a, b) => a.at - b.at);
}

// The part as a song for the engine: {text, bpm, phrases: [{at, from}] (each phrase's first note's
// tick, and the tick its rest starts at), wants: Map (a phrase's index: whether its rest's breath
// is marked taken or not), words: [{text, at, syllables, notes}]}. Throws what stops it being sung.
export function song(part) {
  const { words: ws, problems: ps } = words(part);
  if (ps.length) throw Object.assign(new Error(ps.map((p) => p.what).join("\n")), { at: ps[0].at });
  const grid = part.grid, secs = clock(part), bpm = tempo(part);
  // a tick as millionths of the song's beats
  const g = (tick) => Math.round(secs(tick) * bpm / 60 * 1e6);
  const beats = (a, b) => (g(b) - g(a)) / 1e6;
  const join = part.singer.join * grid;
  const notes = ws.flatMap((w) => w.groups.flat());
  const stop = (at, what) => Object.assign(new Error(`beat ${P.beat(at, grid)}: ${what}`), { at });
  // a breath marked on a word's first note is taken there, rest or none: the note before ends a
  // tick early where it would run on, and the performer makes the breath's room out of it
  const taken = new Set(part.marks.filter((m) => m.breath).map((m) => m.at));
  // where each note ends
  const ends = new Map();
  ws.forEach((w, j) => {
    const mine = w.groups.flat();
    mine.forEach((n, k) => {
      const own = n.at + n.ticks, inside = k + 1 < mine.length, next = inside ? mine[k + 1] : ws[j + 1]?.groups[0][0];
      if (!next) return ends.set(n, own);
      if (!inside && taken.has(next.at)) {
        if (next.at - 1 <= n.at) throw stop(next.at, "the note before the breath marked is too short to give it room");
        return ends.set(n, Math.min(own, next.at - 1));
      }
      ends.set(n, inside || next.at - own <= join ? next.at : Math.min(own, next.at));
    });
  });
  const out = [`%bpm ${fmt(bpm)}`], phrases = [];
  const pts = part.lanes.vibrato;
  let pos = 0; // the tick written up to
  ws.forEach((w, j) => {
    // a phrase starts with the first word, and with each word after a rest
    const rest = w.at > pos ? beats(pos, w.at) : 0;
    if (rest > 0) out.push(`%rest ${fmt(rest)}`);
    if (rest > 0 || j === 0) phrases.push({ at: w.at, from: pos });
    // the vibrato from the word's start to the next word's: where it stands, then each point
    const until = ws[j + 1]?.at ?? Infinity;
    const first = pts.findIndex((q) => q.at > w.at);
    const after = first < 0 ? [] : pts.slice(first);
    let v = P.at(pts, w.at, P.REST.vibrato), at = w.at;
    const steps = [];
    const landed = pts.some((q) => q.at <= w.at) && (j === 0 || pts.some((q) => q.at === w.at));
    if (landed && !(j === 0 && v === P.REST.vibrato)) steps.push(fmt(v));
    const over = (to, value) => {
      const b = beats(at, to);
      if (b > 0) steps.push(`${fmt(value)}:${fmt(b)}`);
      else if (value !== v) steps.push(fmt(value));
    };
    for (const q of after) {
      if (q.at >= until) {
        // a line still being drawn as the next word starts is drawn as far as there
        if (q.line) over(until, v + (q.value - v) * (until - at) / (q.at - at));
        break;
      }
      if (q.line) over(q.at, q.value);
      else {
        over(q.at, v);
        if (q.value !== v) steps.push(fmt(q.value));
      }
      [v, at] = [q.value, q.at];
    }
    if (steps.length) out.push(`%vibrato ${steps.join(" ")}`);
    const groups = w.groups.map((group) => group.map((n) => {
      const b = beats(n.at, ends.get(n));
      if (!(b > 0)) throw stop(n.at, "the note is under a millionth of a beat long");
      const midi = P.key(n.pitch) + n.cents / 100;
      if (midi < 0 || midi > 127) throw stop(n.at, `${P.pitch(n)} is off the end of the keys`);
      return `${Number(midi.toFixed(4))}:${fmt(b)}`;
    }).join("+"));
    out.push(`${w.text} ${groups.join(" ")}`);
    pos = ends.get(w.groups.at(-1).at(-1));
  });
  // each mark settles the rest it is in, or on the note that ends; one marked not to be taken
  // on a word that follows straight on has nothing to settle
  const wants = new Map();
  for (const m of part.marks) {
    const j = phrases.findIndex((ph, k) => (m.at > ph.from || k === 0) && m.at <= ph.at);
    if (j < 0) {
      if (ws.some((w) => w.at === m.at)) continue;
      throw stop(m.at, "the mark is in no rest and on no word's first note");
    }
    if (wants.has(j)) throw stop(m.at, "a second mark in one rest");
    wants.set(j, m.breath);
  }
  return { text: out.join("\n") + "\n", bpm, phrases, wants, words: ws.map((w) => ({ text: w.text, at: w.at, syllables: w.groups.length, notes: w.groups.flat() })), notes };
}

// The beat of the song (the beats of its tempo()) a tick falls on.
export function beatOf(part, tick) {
  return clock(part)(tick) * tempo(part) / 60;
}
