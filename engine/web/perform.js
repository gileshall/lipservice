// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A part sung as a person sings it, after the sing-demos pieces (barbershop-human,
// folk-shenandoah): each phrase a few frames off the beat and its notes pulled
// about inside it, the pitch a few cents off, and breaths cut from VocalSet taken in the rests, room
// made for them by shortening the note before. No engine here: perform() is handed open(text), which
// plans the song and says where its rests fell.

import { rng } from "./room.js";

export const SR = 24000;
export const FPS = 100;
export const BREATH_PRE = 0.07; // s of silence between a note's end and the breath
export const ONSET_MARGIN = 0.25; // s of a rest the next word's onset may take
export const MIN_NOTE = 0.5; // beats a shortened note keeps
export const LEAD = 0.1; // s the engine sets before a song's first sound
const ENTRY = 0.8; // s, the longest breath before the first phrase
const NEAR = 0.3; // s, a breath at least this long is preferred
const ATTEMPTS = 14;
const MIN_REST = 6; // frames: a space, three consonants and a frame of silence

// What of a part decides how it is sung: all but its name, level and seat, and whether it is muted
// (left out of the mix: the others sung alone).
export const asked = (p) => JSON.stringify({ ...p, name: undefined, gain: undefined, levels: undefined, seat: undefined, mute: undefined });

// The song's phrases (runs of words with no rest between), in beats from its start:
// {bpm, phrases: [{start, words: [{word, groups: [[{pitch, beats}]]}]}], tail}. The engine checks
// the notes; this keeps them as written. A lane's lines (LANES: a value written along the song,
// taking no time) stay with the word they come before: its lane, [{line, back}], back the beats of
// rest between the line and the word. Those after the last word are the song's after.
export const LANES = ["vibrato"];
const fmt = (b) => b.toFixed(6).replace(/\.?0+$/, "");
export function parse(text) {
  let bpm = null, beat = 0, cur = null, tail = 0, lane = [];
  const phrases = [];
  const num = (s, n) => {
    const v = Number(s);
    if (!(v > 0 && Number.isFinite(v))) throw new Error(`line ${n}: ${s}: beats must be a positive number`);
    return v;
  };
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim(), n = i + 1;
    if (!line || line.startsWith("#")) return;
    const f = line.split(/\s+/);
    if (f[0] === "bpm" && f.length === 2) {
      if (bpm !== null) throw new Error(`line ${n}: bpm given twice`);
      bpm = num(f[1], n);
    } else if (f[0] === "rest" && f.length === 2) {
      const b = num(f[1], n);
      beat += b;
      for (const c of lane) c.back += b;
      cur = null;
      tail = beat - (phrases.length ? end(phrases.at(-1)) : beat);
    } else if (f[0] === "bpm" || f[0] === "rest") {
      throw new Error(`line ${n}: ${f[0]} takes one number`);
    } else if (LANES.includes(f[0])) {
      if (f.length < 2) throw new Error(`line ${n}: ${f[0]} takes its sizes, VALUE or VALUE:BEATS each`);
      lane.push({ line: f.join(" "), back: 0 });
    } else if (f.length >= 2) {
      const groups = f.slice(1).map((g) => g.split("+").map((x) => {
        const k = x.lastIndexOf(":");
        if (k < 1) throw new Error(`line ${n}: ${x}: a note is NOTE:BEATS`);
        return { pitch: x.slice(0, k), beats: num(x.slice(k + 1), n) };
      }));
      if (!cur) { cur = { start: beat, words: [] }; phrases.push(cur); }
      cur.words.push({ word: f[0], groups, ...(lane.length ? { lane } : {}) });
      lane = [];
      for (const g of groups) for (const x of g) beat += x.beats;
      tail = 0;
    } else {
      throw new Error(`line ${n}: ${f[0]}: a word takes its notes, NOTE:BEATS each`);
    }
  });
  if (bpm === null) throw new Error("the song has no bpm line");
  if (!phrases.length) throw new Error("the song has no words");
  return { bpm, phrases, tail, ...(lane.length ? { after: lane.map((c) => c.line) } : {}) };
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
    if (f[0] === "bpm" && !head) {
      head = true;
      return [raw, `vibrato ${fmt(k)}`];
    }
    if (f[0] !== "vibrato" || f.length < 2) return [raw];
    return [`vibrato ${f.slice(1).map((x) => {
      const [v, ...over] = x.split(":");
      if (v === "" || !(Number(v) >= 0 && Number.isFinite(Number(v))) || over.length > 1) throw new Error(`${x}: a size is VALUE or VALUE:BEATS, the value 0 or more`);
      return [fmt(Number(v) * k), ...over].join(":");
    }).join(" ")}`];
  });
  if (!head) throw new Error("the song has no bpm line");
  return out.join("\n");
}

const notes = (ph) => ph.words.flatMap((w) => w.groups.flat());
const end = (ph) => ph.start + notes(ph).reduce((a, x) => a + x.beats, 0);
const copy = (ph) => ({ start: ph.start, words: ph.words.map((w) => ({ ...w, groups: w.groups.map((g) => g.map((x) => ({ ...x }))) })) });

// Timing as a person's: each phrase starts off the beat by up to jf frames, and inside it each note
// boundary moves by up to jf frames (never more than a fifth of either note beside it), its end
// moving with its start, so a part wanders against the beat and never walks away from it. The first
// phrase's offset is returned as lag (s) for the part's start; the rest move against it.
// With moment (a beat of the song as written -> the piece's moment, a string), each draw is the
// moment's and not the part's: every part with a phrase starting or a note changing at a moment
// moves it the same way, so the singers wander against the beat together and their consonants land
// as one.
export function jitter(song, rnd, jf, moment = null) {
  const fpb = FPS * 60 / song.bpm;
  const draw = (what, beat) => (moment ? rng(`timing ${what} ${moment(beat)}`) : rnd).int(-jf, jf);
  const offs = song.phrases.map((ph) => draw("phrase", ph.start));
  const phrases = song.phrases.map((ph, k) => {
    const out = copy(ph), ns = notes(out);
    out.start = ph.start + (offs[k] - offs[0]) / fpb;
    if (k > 0) { // the rest before it keeps a frame
      const room = (ph.start - end(song.phrases[k - 1])) * fpb - 1;
      const d = offs[k] - offs[k - 1];
      if (d < -room) {
        offs[k] = offs[k - 1] - Math.floor(room);
        out.start = ph.start + (offs[k] - offs[0]) / fpb;
      }
    }
    let prev = 0; // the last boundary's move, frames
    let beat = ph.start; // the boundary as written
    const written = notes(ph).map((x) => x.beats);
    for (let i = 1; i < ns.length; i++) {
      beat += written[i - 1];
      const q = Math.floor(0.2 * Math.min(ns[i - 1].beats, ns[i].beats) * fpb);
      const e = Math.max(-q, Math.min(q, draw("note", beat)));
      ns[i - 1].beats += (e - prev) / fpb;
      prev = e;
    }
    ns.at(-1).beats -= prev / fpb;
    return out;
  });
  return { song: { ...song, phrases }, lag: offs[0] / FPS };
}

// The clips by sex; pick() as choirkit.BreathLib.pick: one that fits, preferring 0.3 s or more. Where
// choirkit draws at random (a hundred singers), a few singers breathing together must not draw the
// same clip: the clips to choose among are put in an order set by `deck` (the moment, the same for
// every part breathing then) and a part takes the one `turn` places in, so parts with the same room
// and turns apart by less than the number to choose among draw different clips.
export function library(clips) {
  const by = { F: [], M: [] };
  for (const c of clips) {
    if (!by[c.sex]) throw new Error(`breath ${c.id}: sex ${c.sex}`);
    by[c.sex].push({ ...c, dur: c.n / SR });
  }
  return {
    clips,
    pick(sex, maxd, deck, turn) {
      if (!by[sex]) throw new Error(`no breaths for sex ${sex}`);
      if (!Number.isInteger(turn)) throw new Error(`a breath's turn is a whole number, not ${turn}`);
      const cs = [...by[sex]], r = rng(`deck ${deck}`);
      for (let i = cs.length - 1; i > 0; i--) { const k = r.int(0, i); [cs[i], cs[k]] = [cs[k], cs[i]]; }
      const ok = cs.filter((c) => c.dur <= maxd);
      if (!ok.length) return null;
      const near = ok.filter((c) => c.dur >= NEAR), of = near.length ? near : ok;
      return of[((turn % of.length) + of.length) % of.length];
    },
  };
}

const line = (w) => `${w.word} ${w.groups.map((g) => g.map((x) => `${x.pitch}:${fmt(x.beats)}`).join("+")).join(" ")}`;

// choirkit.plan_song: the song text with a breath asked for before phrase j when want(j), room made
// for it in the rest by shortening the note before (to MIN_NOTE beats at least). The first phrase's
// breath fits the lead-in as written. A rest too short for the engine to set a word's onset in
// (MIN_REST frames) is held by the note before. reqs: [{rest, clip, j, room}], rest numbering the
// engine's silent spans (the lead-in is 0, then each rest), room the s of silence written for it.
// deck(j) and turn: library().pick's. A lane's line written in a rest keeps its beats before the
// word after it (the rest written in two), or all of the rest where that has come out shorter.
// give: the most of itself the note before gives a breath (a share, 0 to 1), or null for all but
// MIN_NOTE beats; a breath that does not fit in that is not taken and the note is held.
export function plan(song, { sex, lib, want, deck, turn, margins = {}, pins = {}, give = null }) {
  const spb = 60 / song.bpm, phrases = song.phrases.map(copy), reqs = [], gaps = [];
  let cur = 0, rests = 0;
  phrases.forEach((ph, j) => {
    let gap = ph.start - cur, breath = false;
    const prev = j ? notes(phrases[j - 1]).at(-1) : null;
    if (lib && want(j)) {
      const mg = margins[j] ?? ONSET_MARGIN;
      const lend = j === 0 ? 0 : Math.min(Math.max(0, prev.beats - MIN_NOTE), give === null ? Infinity : prev.beats * give);
      const maxd = j === 0 ? Math.min(ENTRY, gap * spb + LEAD - BREATH_PRE - mg) : (gap + lend) * spb - BREATH_PRE - mg;
      let clip = maxd >= 0.2 ? lib.pick(sex, maxd, deck(j), turn) : null;
      if (pins[j] && pins[j].dur <= maxd) clip = pins[j]; // the first clip stays while the margin widens and it fits
      if (clip) {
        pins[j] = clip;
        const need = (clip.dur + BREATH_PRE + mg) / spb;
        if (j > 0 && gap < need) {
          prev.beats -= need - gap;
          gap = need;
        }
        reqs.push({ rest: j === 0 ? 0 : rests + 1, clip, j, room: gap * spb + (j === 0 ? LEAD : 0) });
        breath = true;
      }
    }
    if (j > 0 && !breath && gap * FPS * spb < MIN_REST) {
      prev.beats += gap;
      gap = 0;
    }
    if (j > 0 && gap > 0) rests += 1;
    gaps.push(gap);
    cur = end(ph);
  });
  const out = [`bpm ${fmt(song.bpm)}`];
  phrases.forEach((ph, j) => {
    let left = gaps[j]; // beats of the rest before the phrase still to write
    const rest = (b) => {
      if (fmt(b) === "0") return;
      out.push(`rest ${fmt(b)}`);
      left -= b;
    };
    ph.words.forEach((w, k) => {
      for (const c of w.lane ?? []) {
        rest(left - Math.min(c.back, left));
        out.push(c.line);
      }
      if (!k && left > 0) {
        out.push(`rest ${fmt(left)}`);
        left = 0;
      }
      out.push(line(w));
    });
  });
  out.push(...(song.after ?? []));
  if (song.tail > 0) out.push(`rest ${fmt(song.tail)}`);
  return { text: out.join("\n") + "\n", reqs };
}

// choirkit.deficits: {j: s} the rests short of their breaths, the engine's own spans in s
export function deficits(spans, reqs) {
  const out = {};
  for (const { rest, clip, j } of reqs) {
    const [c0, c1] = spans[rest];
    const short = clip.dur + BREATH_PRE + 0.03 - (c1 - c0);
    if (short > 1e-4) out[j] = short;
  }
  return out;
}

// The part performed: {singer, text, breaths: [{clip, at}] (at in samples of the part), lag (s)}.
//   part: {song, sex, seed, at (s, where the part starts in the piece, as written), jitter (frames),
//     detune (cents), spread (s, the part's start off by up to this), breath (the chance of a breath
//     before a phrase), together (its timing drawn by the piece's moments, as every such part's),
//     give (the most of itself a note gives a breath, plan())}
//   lib: library() or null for no breaths
//   open(text, shift): the engine's singer for the song at a shift, {singer, rests: [[from, to]] frames}
export function perform(part, lib, open) {
  const r = rng(`${part.seed} perform`);
  const song = parse(part.song);
  const spb = 60 / song.bpm;
  const own = jitter(song, r, part.jitter ?? 0); // drawn either way: the draws after it stay the part's
  const { song: sung, lag } = part.together ? jitter(song, null, part.jitter ?? 0, (beat) => (part.at + beat * spb).toFixed(3)) : own;
  const shift = (part.shift ?? 0) + r.between(-(part.detune ?? 0), part.detune ?? 0) / 100;
  const spread = r.between(-(part.spread ?? 0), part.spread ?? 0);
  // one decision a moment, shared by every part that starts a phrase then
  const moment = (j) => (part.at + song.phrases[j].start * spb).toFixed(3);
  const want = (j) => rng(`breath ${moment(j)}`).uniform() < (part.breath ?? 0);
  const margins = {}, pins = {};
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const p = plan(sung, { sex: part.sex, lib, want, deck: moment, turn: part.seed, margins, pins, give: part.give ?? null });
    const s = open(p.text, shift);
    const spans = s.rests.map(([a, b]) => [a / FPS, b / FPS]);
    const short = deficits(spans, p.reqs);
    if (!Object.keys(short).length) {
      const breaths = p.reqs.map(({ rest, clip }) => {
        const [c0, c1] = spans[rest];
        const room = Math.max(0, c1 - c0 - clip.dur - BREATH_PRE - 0.03);
        const e = c1 - 0.03 - Math.min(0.04, room); // the same lead for every singer, so a section breathes together
        return { clip, at: Math.round((e - clip.dur) * SR) };
      });
      return { singer: s.singer, text: p.text, breaths, lag: lag + spread, shift };
    }
    s.singer.close();
    // what the next word's onset took of the silence written, and a little more: the margin a
    // short rest needs, however long it was written
    for (const { rest, j, room } of p.reqs) {
      if (j in short) margins[j] = room - (spans[rest][1] - spans[rest][0]) + 0.05;
    }
  }
  throw new Error(`the breaths do not fit the rests after ${ATTEMPTS} tries`);
}
