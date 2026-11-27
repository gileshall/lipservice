// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// New singers made from a part: a harmony, a canon and a round, doubles and a section, echoes, a
// hocket, a chord dealt out as divisi, a drone; and, inside a part, scat syllables for bare notes
// and a note sung again in quick repeats. No DOM: the page and node both use it.
//
// Only written notes are made here: their keys, their spelling and their cents as the score has
// them. Nothing reaches the pitch the engine sings. A new singer's settings are its source's, its
// voice and seed given by the caller, never chosen here by voice. A source whose sway is 0, or
// whose vibrato lane is 0 under motion -, holds its notes flat, and nothing is made from it.
//
// `who` is a new singer: {voice, seed, title?}. A strip is score.js's: {level, pan, mute, solo,
// part, follows?}. The makers of several singers give strips, the first the source's own as it
// now is, the rest new; `leader` (the source's place in the score, from 0) has the new strips
// written to follow it where they can.

import * as P from "./part.js";
import * as T from "./theory.js";
import * as S from "./score.js";
import { words, problems, song } from "./song.js";

const SEEDS = 4294967296;

// ---------------------------------------------------------------- helpers

const named = (part) => (part.title ? `"${part.title}"` : "the part");
const at = (part, t) => `beat ${P.beat(t, part.grid)}`;
const end = (n) => n.at + n.ticks;
const fixed = (x, places) => Number(x.toFixed(places)) + 0;

function whole(n, what) {
  if (!Number.isInteger(n)) throw new Error(`${what} ${n}: a whole number`);
  return n;
}

// a part with nothing shared with `part`
function copy(part) {
  return {
    ...part,
    singer: { ...part.singer },
    tempo: part.tempo.map((t) => ({ ...t })),
    meter: part.meter.map((m) => ({ ...m })),
    notes: part.notes.map((n) => ({ ...n })),
    lanes: Object.fromEntries(P.LANES.map((l) => [l, part.lanes[l].map((q) => ({ ...q }))])),
    marks: part.marks.map((m) => ({ ...m })),
  };
}

// Throws where a singer made from `part` would hold its notes flat.
function moving(part) {
  const s = part.singer;
  if (s.sway === 0) throw new Error(`${named(part)}: sway 0 holds its notes flat, and a singer made from it would too; give it a sway above 0 first`);
  if (s.motion === null) {
    const q = part.lanes.vibrato.find((p) => p.value === 0);
    if (q) throw new Error(`${named(part)}: its vibrato is 0 at ${at(part, q.at)} with motion -, a flat held tone, and a singer made from it would sing it too; raise the point or give it a motion first`);
  }
}

// The new singers checked against the source and each other: each has a seed of its own.
function own(part, who) {
  if (!Array.isArray(who)) throw new Error("the new singers: a list of {voice, seed}");
  const seen = new Set([part.singer.seed]);
  for (const w of who) {
    if (!w || typeof w !== "object") throw new Error(`${JSON.stringify(w)}: a new singer is {voice, seed}`);
    if (w.seed === part.singer.seed) throw new Error(`seed ${w.seed} is ${named(part)}'s own: each singer has a seed of its own`);
    if (seen.has(w.seed)) throw new Error(`seed ${w.seed} is given twice: each singer has a seed of its own`);
    seen.add(w.seed);
  }
  return who;
}

// The seeds after the source's, n of them, where none are given.
function seeds(part, n, given) {
  const list = given ?? Array.from({ length: n }, (_, i) => (part.singer.seed + i + 1) % SEEDS);
  if (list.length !== n) throw new Error(`${list.length} seeds for ${n} singers`);
  return list;
}

// a new singer's part: the source's settings, its own voice, seed and title, checked
function made(part, w, title, changes) {
  moving(part);
  own(part, [w]);
  const out = { ...copy(part), title: w.title ?? title, singer: { ...part.singer, voice: w.voice, seed: w.seed }, ...changes };
  P.check(out);
  return out;
}

const called = (title, what) => (title ? `${title}, ${what}` : what);

const ORDINALS = ["in unison", "a second", "a third", "a fourth", "a fifth", "a sixth", "a seventh", "an octave", "a ninth", "a tenth", "an eleventh", "a twelfth", "a thirteenth", "a fourteenth", "two octaves"];

// An interval as a person says it: "a third above" in a key of seven notes, "4 steps below" in
// another scale, "an octave above" or "7 semitones below" with no key.
export function apart(key, n) {
  whole(n, "an interval");
  const way = n > 0 ? " above" : " below", m = Math.abs(n);
  if (n === 0) return "in unison";
  if (key !== null && T.SCALES[key.scale]?.steps.length === 7 && m < ORDINALS.length) return `${ORDINALS[m]}${way}`;
  if (key !== null) return `${m} ${m === 1 ? "step" : "steps"}${way}`;
  if (m % 12 === 0) return `${m === 12 ? "an octave" : `${m / 12} octaves`}${way}`;
  return `${m} ${m === 1 ? "semitone" : "semitones"}${way}`;
}

// Each note's key moved: `n` steps along the key's scale and spelled for it, or with no key `n`
// semitones, a flat kept a flat (theory.js moved()). A note past MIDI's keys is refused by its beat.
function transposed(part, key, n) {
  whole(n, "an interval");
  return P.sort(part.notes.map((note) => {
    try {
      const pitch = key === null ? T.moved(note.pitch, n) : T.spell(key, T.step(key, P.key(note.pitch), n));
      return { ...note, pitch };
    } catch (e) {
      throw new Error(`${at(part, note.at)}: ${e.message}`);
    }
  }));
}

// Notes, lanes and marks `after` ticks later.
function later(part, after) {
  whole(after, "ticks later");
  if (after < 0) throw new Error(`${after} ticks later: 0 or more`);
  return {
    notes: part.notes.map((n) => ({ ...n, at: n.at + after })),
    lanes: Object.fromEntries(P.LANES.map((l) => [l, part.lanes[l].map((q) => ({ ...q, at: q.at + after }))])),
    marks: part.marks.map((m) => ({ ...m, at: m.at + after })),
  };
}

// The bar line at or before tick `t` (or at or after it, `up`), as the part's meters lay bars.
export function barLine(part, t, up = false) {
  const ms = part.meter;
  let i = ms.length - 1;
  while (i > 0 && ms[i].at > t) i--;
  const m = ms[i], len = m.n * part.grid * 4 / m.d;
  let b = m.at + (up ? Math.ceil((t - m.at) / len) : Math.floor((t - m.at) / len)) * len;
  if (up && i + 1 < ms.length && b > ms[i + 1].at) b = ms[i + 1].at;
  if (!Number.isInteger(b)) throw new Error(`bars of ${m.n}/${m.d} fall on no whole tick of a grid of ${part.grid}`);
  return b;
}

// Pans for n singers spread evenly across `width` about `center`, left to right.
function pans(center, width, n) {
  if (!(typeof width === "number" && width >= 0 && width <= 2)) throw new Error(`a width of ${width}: 0 to 2, the whole way from one ear to the other`);
  const out = Array.from({ length: n }, (_, i) => fixed(n === 1 ? center : center - width / 2 + width * i / (n - 1), 3));
  if (out.some((p) => p < -1 || p > 1)) throw new Error(`pans from ${out[0]} to ${out[n - 1]}: past an ear; narrow the width or move the pan`);
  return out;
}

function level(db, what) {
  const x = fixed(db, 2);
  if (x < S.LEVEL.min || x > S.LEVEL.max) throw new Error(`${what} at ${x} dB: a strip is ${S.LEVEL.min} to ${S.LEVEL.max} dB`);
  return x;
}

const fresh = (pan, part, follows) => ({ ...S.strip(), pan, part, ...(follows ? { follows } : {}) });
const source = (strip, changes) => ({ level: strip.level, pan: strip.pan, mute: strip.mute, solo: strip.solo, ...changes });
const leading = (leader, after, keys) => (leader === null || leader === undefined ? null : { leader: whole(leader, "the leader's place"), after, keys });

// The marks a singer of only `notes` keeps of `marks`: none inside one of its notes or after its
// last, and of several in one of its rests the last, the one nearest the note that ends it.
function kept(notes, marks) {
  const last = notes.length ? Math.max(...notes.map(end)) : 0;
  const out = new Map();
  for (const m of marks) {
    if (m.at >= last || notes.some((n) => n.at < m.at && m.at < end(n))) continue;
    out.set(notes.filter((n) => n.at < m.at).length, m);
  }
  return [...out.values()].map((m) => ({ ...m }));
}

// A vocable checked: one closed syllable in lower case with a vowel to sing on, or a capital
// letter where `letters` asks for them spelled.
function vocable(s, letters) {
  if (typeof s !== "string" || !P.lyrical(s) || s === "_" || s.endsWith("-") || s.endsWith("/")) throw new Error(`"${s}": a scat syllable is one word, no space, _, / or - at its end`);
  const upper = /[A-Z]/.test(s);
  if (upper && !letters) throw new Error(`"${s}": the engine spells out a word with a capital in it unless it knows it, so "Ah" is sung "ay aitch"; write "${s.toLowerCase()}"`);
  if (!upper && !/[aeiouy]/.test(s)) throw new Error(`"${s}": no vowel to sing on; a closed-mouth hum cannot take a note, and "ooh" is the nearest`);
  return s;
}

// ---------------------------------------------------------------- harmony and canon

// A new singer singing the part `interval` steps along `key`'s scale away (2 a third above, -5 a
// sixth below), or `interval` semitones away where `key` is null. The same rhythm, words, vibrato
// and marks. A note off the scale moves by the steps of the scale note below it and keeps its
// offset (theory.js step()). Cents are kept.
export function harmonize(part, key, interval, voice, seed) {
  return made(part, { voice, seed }, called(part.title, apart(key, interval)), { notes: transposed(part, key, interval) });
}

// The part sung again by a new singer `after` ticks later, `interval` away as harmonize() moves it.
// Its vibrato and marks come later with it; before them it has the lane's rest.
export function canon(part, after, interval, voice, seed, key = null) {
  const moved = { ...part, notes: transposed(part, key, interval) };
  const what = `${P.beat(after, part.grid)} ${after === part.grid ? "beat" : "beats"} later${interval ? `, ${apart(key, interval)}` : ""}`;
  return made(part, { voice, seed }, called(part.title, what), later(moved, after));
}

// The part sung by another of the same voice (or `voice`) and its own seed, `semitones` away (0 in
// unison, 12 an octave up) and `cents` off through its shift. Followed by it, `keys` is
// `semitones`: the notes are moved; the cents are the singer's.
export function double(part, semitones, seed, cents = 0, voice = part.singer.voice) {
  if (!(typeof cents === "number" && Number.isFinite(cents))) throw new Error(`${cents} cents: a number`);
  const singer = { ...part.singer, voice, seed, shift: fixed(part.singer.shift + cents / 100, 4) };
  return made(part, { voice, seed }, called(part.title, semitones ? apart(null, semitones) : "a double"), { singer, notes: transposed(part, null, semitones) });
}

// The part sung `times` over, each time from the bar line at or after the time before ends.
// Vibrato before a lane's first point is its rest, so each time after the first starts with a
// point holding what the lane is at the part's start.
export function repeat(part, times) {
  whole(times, "times");
  if (times < 1) throw new Error(`${times} times: once at least`);
  if (!part.notes.length) throw new Error(`${named(part)} has no notes to sing again`);
  const period = barLine(part, Math.max(...part.notes.map(end)), true);
  for (const l of P.LANES) {
    const past = part.lanes[l].find((q) => q.at > period);
    if (past) throw new Error(`${named(part)}: its ${l} at ${at(part, past.at)} is past the bar line at ${at(part, period)}, where it would be sung again`);
  }
  const past = part.marks.find((m) => m.at >= period);
  if (past) throw new Error(`${named(part)}: its mark at ${at(part, past.at)} is at or past the bar line at ${at(part, period)}, where it would be sung again`);
  const out = copy(part);
  for (let r = 1; r < times; r++) {
    const o = r * period;
    out.notes.push(...part.notes.map((n) => ({ ...n, at: n.at + o })));
    out.marks.push(...part.marks.map((m) => ({ ...m, at: m.at + o })));
    for (const l of P.LANES) {
      const pts = part.lanes[l];
      if (!pts.length) continue;
      const again = pts.map((q) => ({ ...q, at: q.at + o }));
      if (pts[0].at > 0) again.unshift({ at: o, value: P.REST[l], line: false });
      // a point that holds from where the next time starts is the next time's to say
      out.lanes[l] = out.lanes[l].filter((q) => q.at !== o || q.line).concat(again);
    }
  }
  P.check(out);
  return out;
}

// A round: the part (sung `times` over) and an entry for each of `who`, the ith `after` * i ticks
// after the first and intervals[i - 1] away as harmonize() moves it. Pans spread left to right in
// the order of entry across `width`. Entries moved by no key, or not moved, follow the first.
export function round(part, who, after, { key = null, intervals = [], times = 1, strip = S.strip(), width = 0, leader = null } = {}) {
  own(part, who);
  if (intervals.length > who.length) throw new Error(`${intervals.length} intervals for ${who.length} entries after the first`);
  const tune = repeat(part, times), ps = pans(strip.pan, width, who.length + 1);
  const out = [source(strip, { pan: ps[0], part: tune })];
  who.forEach((w, i) => {
    const n = intervals[i] ?? 0, wait = after * (i + 1);
    const p = canon(tune, wait, n, w.voice, w.seed, key);
    if (w.title !== undefined) p.title = w.title;
    out.push(fresh(ps[i + 1], p, key === null || n === 0 ? leading(leader, wait, key === null ? n : 0) : null));
  });
  return out;
}

// ---------------------------------------------------------------- doubles

// A unison section: the part and `n` doubles, each its own seed (the source's plus 1 on, or
// `seeds`) and a few cents off through its shift, above and below in turn, out to `cents` either
// way; each strip's level down by 10 log10 of the section's size so the section
// sums as the one singer did, and pans spread across `width`, the source in the middle.
export function section(part, n, width, { strip = S.strip(), leader = null, cents = 5, seeds: given = null } = {}) {
  whole(n, "doubles");
  if (n < 1) throw new Error(`${n} doubles: 1 at least`);
  const list = seeds(part, n, given), size = n + 1;
  own(part, list.map((seed) => ({ voice: part.singer.voice, seed })));
  const db = level(strip.level - 10 * Math.log10(size), `a section of ${size}`);
  const spots = pans(strip.pan, width, size);
  // the source takes the spot nearest the middle, the doubles the rest outward
  const order = spots.map((p, i) => [Math.abs(p - strip.pan), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, i]) => i);
  const half = Math.ceil(n / 2);
  const out = [source(strip, { level: db, pan: spots[order[0]], part })];
  list.forEach((seed, i) => {
    const off = fixed(cents * (i % 2 ? -1 : 1) * Math.ceil((i + 1) / 2) / half, 2);
    const p = double(part, 0, seed, off);
    p.title = called(part.title, `double ${i + 1}`);
    out.push({ ...fresh(spots[order[i + 1]], p, leading(leader, 0, 0)), level: db });
  });
  return out;
}

// Echo singers: `n` more of the same voice, the ith `after` * i ticks later, `fall` dB quieter
// than the one before, each panned further out, right and left in turn, across `width`.
export function echoes(part, n, after, { strip = S.strip(), leader = null, fall = 3, width = 1, seeds: given = null } = {}) {
  whole(n, "echoes");
  if (n < 1) throw new Error(`${n} echoes: 1 at least`);
  if (!(typeof fall === "number" && fall >= 0)) throw new Error(`a fall of ${fall} dB: 0 or more`);
  if (!(typeof width === "number" && width >= 0 && width <= 2)) throw new Error(`a width of ${width}: 0 to 2, the whole way from one ear to the other`);
  const list = seeds(part, n, given), half = Math.ceil(n / 2);
  own(part, list.map((seed) => ({ voice: part.singer.voice, seed })));
  const out = [source(strip, { part })];
  list.forEach((seed, i) => {
    const wait = after * (i + 1);
    const p = canon(part, wait, 0, part.singer.voice, seed);
    p.title = called(part.title, `echo ${i + 1}`);
    const pan = fixed(strip.pan + (i % 2 ? -1 : 1) * width / 2 * Math.ceil((i + 1) / 2) / half, 3);
    if (pan < -1 || pan > 1) throw new Error(`echo ${i + 1} at pan ${pan}: past an ear; narrow the width or move the pan`);
    out.push({ ...fresh(pan, p, leading(leader, wait, 0)), level: level(strip.level - fall * (i + 1), `echo ${i + 1}`) });
  });
  return out;
}

// The notes and vibrato `follower` has by `link` ({after, keys}): its leader's, `after` ticks on
// and `keys` keys up, a flat kept a flat. Its singer, title and marks stay its own. What the page
// sings again when a leader is changed; score.js check() holds a follower to it. A vibrato point
// of 0 drawn under the leader's motion is never sung; under the follower's motion - it would be a
// flat held tone, and is refused, but where the follower has it already. One the leader sings
// under - is the person's, and goes as it is.
export function followed(leader, follower, link) {
  const out = { ...copy(follower), ...later({ ...leader, notes: transposed(leader, null, link.keys) }, link.after), marks: follower.marks.map((m) => ({ ...m })) };
  if (out.singer.motion === null && leader.singer.motion !== null) {
    const had = new Set(follower.lanes.vibrato.filter((p) => p.value === 0).map((p) => p.at));
    const q = out.lanes.vibrato.find((p) => p.value === 0 && !had.has(p.at));
    if (q) throw new Error(`${named(follower)} would have a vibrato of 0 at ${at(out, q.at)} with its motion -, a flat held tone, where its leader has the motion ${leader.singer.motion} and does not sing it; raise that point, or give ${named(follower)} a motion`);
  }
  P.check(out);
  return out;
}

// ---------------------------------------------------------------- sharing a line out

// A hocket: the part's words handed in turn among the source and `who`, `by` "word" or "phrase"
// (the words from one rest to the next), in the order `pattern` gives (indexes into the singers,
// the source 0), or each in turn. Each word goes whole, its held notes with it, so every singer's
// words are words; each mark goes to the singer of the word it comes before. A part whose words
// are not sung as written is refused, by its first problem: give its notes words first.
export function hocket(part, who, { by = "word", pattern = null, strip = S.strip(), width = 0 } = {}) {
  own(part, who);
  moving(part);
  const n = who.length + 1;
  if (n < 2) throw new Error("a hocket is two singers at least");
  const wrong = problems(part);
  if (wrong.length) throw new Error(`${named(part)} is not sung as written, so its words cannot be handed out: ${wrong[0].what}`);
  if (by !== "word" && by !== "phrase") throw new Error(`by ${by}: by word or by phrase`);
  const order = pattern ?? Array.from({ length: n }, (_, i) => i);
  if (!Array.isArray(order) || !order.length || order.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) throw new Error(`pattern ${JSON.stringify(pattern)}: singers 0 to ${n - 1}, the source 0`);
  const ws = words(part).words, phrases = song(part).phrases;
  const unit = (w, j) => (by === "word" ? j : phrases.filter((ph) => ph.at <= w.at).length - 1);
  const owner = ws.map((w, j) => order[unit(w, j) % order.length]);
  const units = by === "word" ? ws.length : phrases.length;
  for (let i = 0; i < n; i++) {
    if (!owner.includes(i)) throw new Error(`singer ${i + 1} of the hocket would sing nothing: ${units} ${by}s for ${n} singers in the pattern ${order.join(" ")}`);
  }
  const ps = pans(strip.pan, width, n);
  return Array.from({ length: n }, (_, i) => {
    const notes = ws.flatMap((w, j) => (owner[j] === i ? w.groups.flat().map((x) => ({ ...x })) : []));
    const marks = part.marks.filter((m) => owner[ws.findIndex((w) => w.at >= m.at)] === i).map((m) => ({ ...m }));
    if (i === 0) {
      const p = { ...copy(part), notes, marks };
      P.check(p);
      return source(strip, { pan: ps[0], part: p });
    }
    return fresh(ps[i], made(part, who[i - 1], called(part.title, `hocket ${i + 1}`), { notes, marks }), null);
  });
}

// Divisi: the notes that sound together dealt to lines, one singer a line, the top note to the
// highest free line, the next to the next: at each start the notes starting there, top to bottom,
// take the lines whose note before has ended, top to bottom. Where fewer notes sound than there
// are lines, the lines left over rest. A note with no syllable takes that of a note starting with
// it, the nearest above, else below, so every line has the words. The source sings the top line.
export function divisi(part, who, { strip = S.strip(), width = 0 } = {}) {
  own(part, who);
  moving(part);
  const n = who.length + 1, free = new Array(n).fill(0), lines = Array.from({ length: n }, () => []);
  const starts = [...new Set(part.notes.map((x) => x.at))];
  for (const t of starts) {
    const here = part.notes.filter((x) => x.at === t).sort((a, b) => P.key(b.pitch) - P.key(a.pitch));
    const open = [];
    for (let i = 0; i < n; i++) if (free[i] <= t) open.push(i);
    if (here.length > open.length) throw new Error(`${at(part, t)}: ${here.length + n - open.length} notes sound together, and there are ${n} lines`);
    here.forEach((x, j) => {
      const lyric = x.lyric ?? here.slice(0, j).reverse().concat(here.slice(j + 1)).find((y) => y.lyric !== null)?.lyric ?? null;
      lines[open[j]].push({ ...x, lyric });
      free[open[j]] = end(x);
    });
  }
  const most = Math.max(0, ...starts.map((t) => part.notes.filter((x) => x.at <= t && end(x) > t).length));
  lines.forEach((l, i) => {
    if (!l.length) throw new Error(`line ${i + 1} would sing nothing: no more than ${most} ${most === 1 ? "note sounds" : "notes sound"} together`);
  });
  const ps = pans(strip.pan, width, n);
  return lines.map((notes, i) => {
    const changes = { notes, marks: kept(notes, part.marks) };
    if (i === 0) {
      const p = { ...copy(part), ...changes };
      P.check(p);
      return source(strip, { pan: ps[0], part: p });
    }
    return fresh(ps[i], made(part, who[i - 1], called(part.title, `line ${i + 1}`), changes), null);
  });
}

// ---------------------------------------------------------------- held and spoken sounds

// A drone: a new singer holding the key's tonic (or its fifth, 7 semitones up, `on` "fifth") from
// the bar line at or before the part's first note to the one at or after its last, at or below
// the part's lowest note, or in `octave` (4: C4 to B4). A note a bar, held on `syllable`; every
// `every` bars the syllable is sung again with a breath marked before it (0: held throughout).
export function drone(part, key, syllable, voice, seed, { on = "tonic", every = 4, octave = null } = {}) {
  const keyName = T.names(key);
  vocable(syllable, false);
  if (on !== "tonic" && on !== "fifth") throw new Error(`on ${on}: the tonic or the fifth`);
  whole(every, "every");
  if (every < 0) throw new Error(`every ${every} bars: 0 or more`);
  if (!part.notes.length) throw new Error(`${named(part)} has no notes to hold a drone under`);
  const pc = (key.tonic + (on === "fifth" ? 7 : 0)) % 12;
  const low = Math.min(...part.notes.map((x) => P.key(x.pitch)));
  const k = octave === null ? low - ((low - pc + 120) % 12) : 12 * (whole(octave, "octave") + 1) + pc;
  if (k < 0 || k > 127) throw new Error(`a drone on ${keyName}'s ${on} ${octave === null ? `under ${P.name(low)}` : `in octave ${octave}`}: past MIDI's keys, C-1 to G9`);
  const pitch = T.spell(key, k);
  const from = barLine(part, Math.min(...part.notes.map((x) => x.at))), to = barLine(part, Math.max(...part.notes.map(end)), true);
  const loud = Math.round(part.notes.reduce((a, x) => a + x.velocity, 0) / part.notes.length);
  const notes = [], marks = [];
  for (let t = from, bar = 0; t < to; bar++) {
    const next = Math.min(barLine(part, t + 1, true), to);
    const again = bar === 0 || (every > 0 && bar % every === 0);
    notes.push({ at: t, ticks: next - t, pitch, cents: 0, velocity: loud, release: 64, lyric: again ? syllable : "_" });
    if (again && bar > 0) marks.push({ at: t, breath: true });
    t = next;
  }
  return made(part, { voice, seed }, called(part.title, `a drone on ${pitch.replace(/-?\d+$/, "")}`), { notes, lanes: Object.fromEntries(P.LANES.map((l) => [l, []])), marks });
}

// Syllables to scat on, each a word of its own in lower case.
export const VOCABLES = Object.freeze(["doo", "bah", "la", "dum", "ooh", "ah", "na", "dee", "dah", "bop", "wah", "shoo"]);

// The part with scat syllables on its notes that have no words: `pattern` (a list, or the
// syllables apart by spaces) in turn, a word a note. With `all` every note's words are replaced,
// a held note kept held and a line's end kept. `letters` lets capitals through, to be spelled
// letter by letter. A note with no words after a syllable whose word goes on is refused: the word
// would end in a scat syllable.
export function vocables(part, pattern = "doo", { all = false, letters = false } = {}) {
  const list = typeof pattern === "string" ? pattern.trim().split(/\s+/).filter(Boolean) : pattern;
  if (!Array.isArray(list) || !list.length) throw new Error(`${JSON.stringify(pattern)}: scat syllables, one at least`);
  list.forEach((s) => vocable(s, letters));
  let i = 0, open = false;
  const notes = part.notes.map((x) => {
    if (x.lyric === "_") return { ...x };
    if (x.lyric !== null && !all) {
      open = P.syllable(x.lyric).on;
      return { ...x };
    }
    if (open && !all) throw new Error(`${at(part, x.at)}: the word before goes on to this note, which has no words; a scat syllable here would end it`);
    const end = x.lyric !== null && P.syllable(x.lyric).end ? "/" : "";
    open = false;
    return { ...x, lyric: list[i++ % list.length] + end };
  });
  const out = { ...copy(part), notes };
  P.check(out);
  return out;
}

// The part with each of `notes` (its own note objects) sung again as k notes of equal length, its
// syllable on each: "la" as "la la la". Each is a whole word of one syllable.
export function stutter(part, notes, k) {
  whole(k, "repeats");
  if (k < 2) throw new Error(`${k} repeats: 2 at least`);
  const chosen = new Set(notes);
  for (const x of notes) if (!part.notes.includes(x)) throw new Error(`a note ${x.pitch} at ${at(part, x.at)} that is not the part's`);
  const out = [];
  let open = false;
  for (const x of part.notes) {
    if (!chosen.has(x)) {
      if (x.lyric !== null && x.lyric !== "_") open = P.syllable(x.lyric).on;
      out.push({ ...x });
      continue;
    }
    if (x.lyric === null || x.lyric === "_") throw new Error(`${at(part, x.at)}: the note has no syllable of its own to sing again`);
    const s = P.syllable(x.lyric);
    if (s.on || open) throw new Error(`${at(part, x.at)}: "${x.lyric}" is part of a longer word; only a word of one syllable is sung again`);
    if (x.ticks % k) throw new Error(`${at(part, x.at)}: ${P.beat(x.ticks, part.grid)} beats in ${k} is not a whole number of ticks each`);
    const each = x.ticks / k, plain = s.end ? x.lyric.slice(0, -1) : x.lyric;
    for (let j = 0; j < k; j++) out.push({ ...x, at: x.at + j * each, ticks: each, lyric: j === k - 1 ? x.lyric : plain });
  }
  const result = { ...copy(part), notes: P.sort(out) };
  P.check(result);
  return result;
}

// ---------------------------------------------------------------- breathing

// Breaths staggered across singers who sing the same words at the same times (a section, octave
// doubles): at each rest, and at each word's first note a singer has a breath marked on, at most
// `most` of them may breathe, a different few each time in turn. The others are marked not to
// (in a rest) or lose the breath marked (on a note). The few keep what they had: their marks, or
// the chance their `breath` gives. Nothing here marks a breath that was not there.
export function stagger(parts, most = 1) {
  if (!Array.isArray(parts) || parts.length < 2) throw new Error("staggered breathing is for two singers or more");
  whole(most, "singers breathing at once");
  if (most < 1 || most >= parts.length) throw new Error(`${most} breathing at once of ${parts.length}: 1 to ${parts.length - 1}`);
  const first = parts[0];
  parts.forEach((p, i) => {
    if (p.grid !== first.grid) throw new Error(`singer ${i + 1}: its grid is not the first's`);
    const a = p.notes, b = first.notes;
    for (let j = 0; j < Math.max(a.length, b.length); j++) {
      if (!a[j] || !b[j] || a[j].at !== b[j].at || a[j].ticks !== b[j].ticks || a[j].lyric !== b[j].lyric) {
        const t = (b[j] ?? a[j]).at;
        throw new Error(`singer ${i + 1}: its notes at ${at(first, t)} are not the first's; staggered breathing is for singers who sing the same words at the same times`);
      }
    }
  });
  let sung;
  try {
    sung = song(first);
  } catch (e) {
    throw new Error(`the singers' words are not sung as written: ${e.message}`);
  }
  // [from, to]: a mark at a tick in (from, to] settles the rest; from = to for a word's first note
  const places = [];
  sung.phrases.forEach((ph, j) => {
    if (ph.at > ph.from) places.push({ from: j === 0 ? -1 : ph.from, to: ph.at, rest: true });
  });
  for (const w of sung.words) {
    if (places.some((pl) => pl.to === w.at)) continue;
    if (parts.some((p) => p.marks.some((m) => m.at === w.at && m.breath))) places.push({ from: w.at - 1, to: w.at, rest: false });
  }
  places.sort((a, b) => a.to - b.to);
  const n = parts.length;
  return parts.map((p, i) => {
    let marks = p.marks.map((m) => ({ ...m }));
    places.forEach((pl, q) => {
      const breathes = Array.from({ length: most }, (_, j) => (q * most + j) % n).includes(i);
      if (breathes) return;
      marks = marks.filter((m) => !(m.at > pl.from && m.at <= pl.to));
      if (pl.rest) marks.push({ at: pl.to, breath: false });
    });
    const out = { ...copy(p), marks: marks.sort((a, b) => a.at - b.at) };
    P.check(out);
    return out;
  });
}
