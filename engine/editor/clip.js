// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The clipboard: notes copied out of a part as text, and pasted into a part. A clip's text is a
// whole `lipservice part 2` (PART.md), so a person can read it, another tab or window can paste
// it, and it opens as a part's file. No DOM: the page and node both use it.
//
// A clip is the copied stretch of a part, moved to start at tick 0:
//   {title, grid, singer, tempo, meter, notes, lanes, marks, len}
// a part (part.js) and `len`, its length in ticks: from 0 to the end of its last note. Its notes,
// lane points and marks are the source's from the first copied note's start to the last one's
// end. The singer lines are the source singer's, and the tempo and meter are those in force over
// the stretch, so the clip opened as a file sings as the stretch did. Pasting takes its notes,
// lanes and marks only: a part keeps its own singer and its own time.
//
// A lane is carried when the source part has points in it: then the clip's lane starts with a
// point at 0 holding the value standing where the copy starts, has the source's points inside
// the stretch, and ends with a line to the value at the stretch's end where a line runs past it.
// A source lane with no points says nothing, and pasting it leaves the part's lane as it is.

import * as P from "./part.js";
import * as S from "./score.js";

const NONE = "the clipboard holds no lipservice notes; words go in the Words box";

// A lane value as the text can write it: a value worked out on a line is cut to six places, as
// a written number of more would print with an exponent.
const six = (x) => Number(x.toFixed(6));

// A lane's value at tick `t`, as P.at, a point's own value kept as it is written.
function standing(points, t, rest) {
  for (let i = 0; i < points.length; i++) {
    const q = points[i];
    if (q.at <= t) continue;
    if (!q.line) break;
    const a = points[i - 1];
    if (a.at === t) break;
    return six(a.value + (q.value - a.value) * (t - a.at) / (q.at - a.at));
  }
  let v = rest;
  for (const q of points) if (q.at <= t) v = q.value;
  return v;
}

// A tempo or meter list from `start` to `end`, moved to start at 0: the one in force at `start`,
// then the changes inside.
function span(list, start, end) {
  let first = list[0];
  for (const m of list) if (m.at <= start) first = m;
  return [{ ...first, at: 0 }, ...list.filter((m) => m.at > start && m.at < end).map((m) => ({ ...m, at: m.at - start }))];
}

// A lane from `start` to `end`, moved to start at 0 (see the head of this file).
function stretch(points, start, end, rest) {
  if (!points.length) return [];
  const out = [{ at: 0, value: standing(points, start, rest), line: false }];
  for (const q of points) {
    if (q.at > start && (q.at < end || (q.at === end && q.line))) out.push({ ...q, at: q.at - start });
  }
  const after = points.find((q) => q.at > end);
  if (after?.line && !points.some((q) => q.at === end)) out.push({ at: end - start, value: standing(points, end, rest), line: true });
  return out;
}

// The clip of `notes`, notes of `part`: the object copy() writes.
export function take(part, notes) {
  const which = new Set(notes);
  if (!which.size) throw new Error("no notes are chosen to copy");
  const chosen = part.notes.filter((n) => which.has(n));
  if (chosen.length !== which.size) throw new Error("a note to copy is not one of this part's notes");
  const start = chosen[0].at, end = Math.max(...chosen.map((n) => n.at + n.ticks));
  const clip = {
    title: part.title,
    grid: part.grid,
    singer: { ...part.singer },
    tempo: span(part.tempo, start, end),
    meter: span(part.meter, start, end),
    notes: chosen.map((n) => ({ ...n, at: n.at - start })),
    lanes: Object.fromEntries(P.LANES.map((l) => [l, stretch(part.lanes[l], start, end, P.REST[l])])),
    marks: part.marks.filter((m) => m.at >= start && m.at < end).map((m) => ({ ...m, at: m.at - start })),
    len: end - start,
  };
  P.check(clip);
  return clip;
}

// The text for the clipboard: a part holding just `notes` of `part` (take()).
export function copy(part, notes) {
  const { len, ...clip } = take(part, notes);
  return P.write(clip);
}

// The clip a clipboard's text holds: a clip copy() wrote, or any part's text, taken whole.
// Anything else is refused.
export function read(text) {
  if (typeof text !== "string") throw new Error(NONE);
  const head = text.replace(/^\ufeff/, "").split("\n")[0].replace(/\r$/, "");
  if (S.is(text)) throw new Error("the clipboard holds a score, not one singer's notes; open it as a file to see its singers");
  if (head !== P.HEAD) throw new Error(NONE);
  let part;
  try {
    part = P.read(text);
  } catch (e) {
    throw new Error(`the clipboard's part does not read: ${e.message}`, { cause: e });
  }
  if (!part.notes.length) throw new Error("the clipboard's part has no notes");
  return take(part, part.notes);
}

// ---------------------------------------------------------------- paste

// Clip tick `t` as a tick of `part`, the clip placed from `at`: the clip's beat read on the
// part's grid, as part.js reads a beat, so what falls off a whole tick by more than it allows is
// refused.
function landing(part, clip, at, t, what) {
  if (clip.grid === part.grid) return at + t;
  try {
    return at + P.ticks(P.beat(t, clip.grid), part.grid);
  } catch (e) {
    const near = (at / part.grid + t / clip.grid).toFixed(6).replace(/\.?0+$/, "");
    throw new Error(`${what} falls between the ticks of this part's grid (${part.grid} a beat), near beat ${near}; the clip's grid is ${clip.grid} a beat`, { cause: e });
  }
}

// Lane points `put` (the clip's, placed from `at` to `end`) in place of the part's there. Before
// `at` and after `end` the part's lane is as it was: a line running into the stretch keeps its
// way to `at`, and the value standing at `end` is set again there where it is not already.
function relane(points, put, at, end, rest) {
  if (!put.length) return points;
  const out = points.filter((q) => q.at < at || (q.at === at && q.line));
  const next = points.find((q) => q.at > at);
  if (next?.line && !points.some((q) => q.at === at)) out.push({ at, value: standing(points, at, rest), line: true });
  out.push(...put);
  const held = points.some((q) => q.at === end && !q.line), back = standing(points, end, rest);
  const later = points.find((q) => q.at > end);
  if (!held && (later?.line || standing(put, end, rest) !== back)) out.push({ at: end, value: back, line: false });
  out.push(...points.filter((q) => q.at > end || (q.at === end && !q.line)));
  return out;
}

// `clip` pasted into `part` from tick `at`: its notes added, its lane points in place of the
// part's over the clip's stretch, its marks merged, one of the clip's winning its beat. With
// `over`, the part's notes the stretch covers go: those starting in it are removed, one sounding
// into it from before ends where it starts; and the part's marks in it go too. The part's singer
// and time are kept. Returns {part, notes (the pasted ones, as in the part), said (what a person
// should be told: words that run on past the pasted notes, a tempo not the part's)}. A paste
// that would leave a part the text cannot hold, or a flat held tone (below), is refused, and
// nothing is changed.
export function paste(part, clip, at, { over = false } = {}) {
  if (!Number.isInteger(at) || at < 0) throw new Error(`paste at tick ${at}: a whole number of ticks from 0`);
  P.check(clip);
  if (!clip.notes.length) throw new Error("the clip has no notes");
  if (clip.notes[0].at !== 0 || clip.len !== Math.max(...clip.notes.map((n) => n.at + n.ticks))) throw new Error("not a clip: its notes run from 0 to its length (read() and take() make one)");
  const notes = clip.notes.map((n) => {
    const from = landing(part, clip, at, n.at, "the note"), to = landing(part, clip, at, n.at + n.ticks, `the end of the note at beat ${P.beat(from, part.grid)}`);
    if (to <= from) throw new Error(`the note at beat ${P.beat(from, part.grid)} would be shorter than a tick on this part's grid (${part.grid} a beat)`);
    return { ...n, at: from, ticks: to - from };
  });
  const end = landing(part, clip, at, clip.len, "the clip's end");
  const kept = over
    ? part.notes.filter((n) => n.at < at || n.at >= end).map((n) => (n.at < at && n.at + n.ticks > at ? { ...n, ticks: at - n.at } : n))
    : part.notes;
  const lanes = Object.fromEntries(P.LANES.map((l) => {
    const put = clip.lanes[l].map((q) => ({ ...q, at: landing(part, clip, at, q.at, `the ${l} point`) }));
    // Under motion - the drawn vibrato is sung. A 0 copied from a singer with a motion was never
    // sung; pasted under - it would be a flat held tone. One drawn under - and heard so is the
    // person's, and goes as it is.
    const zero = l === "vibrato" && part.singer.motion === null && clip.singer.motion !== null ? put.find((q) => q.value === 0) : null;
    if (zero) throw new Error(`the paste is refused: its vibrato is 0 at beat ${P.beat(zero.at, part.grid)}, where the singer it was copied from has the motion ${clip.singer.motion} and does not sing it, and this singer's motion is -, so its notes there would be held flat. Raise that point before copying, or give this singer a motion`);
    return [l, relane(part.lanes[l], put, at, end, P.REST[l])];
  }));
  const pasted = clip.marks.map((m) => ({ ...m, at: landing(part, clip, at, m.at, "the mark") }));
  const beats = new Set(pasted.map((m) => m.at));
  const marks = [...part.marks.filter((m) => !beats.has(m.at) && !(over && m.at >= at && m.at < end)), ...pasted].sort((a, b) => a.at - b.at);
  const next = { ...part, notes: P.sort([...kept, ...notes]), lanes, marks };
  try {
    P.check(next);
  } catch (e) {
    throw new Error(`the paste is refused: ${e.message}`, { cause: e });
  }
  const said = [];
  const sung = notes.find((n) => n.lyric !== null);
  if (sung?.lyric === "_") said.push(`the pasted notes start on _: beat ${P.beat(sung.at, part.grid)} holds the syllable sung before it`);
  const tail = notes.filter((n) => n.lyric !== null && n.lyric !== "_").at(-1);
  if (tail && P.syllable(tail.lyric).on) said.push(`the pasted notes end inside a word: "${tail.lyric}" at beat ${P.beat(tail.at, part.grid)} runs on into the next syllable`);
  const theirs = clip.tempo.map((t) => `${Math.round(t.at * part.grid / clip.grid)}:${t.bpm}`).join(" ");
  const ours = span(part.tempo, at, end);
  if (theirs !== ours.map((t) => `${t.at}:${t.bpm}`).join(" ")) said.push(`the clip's tempo is not this part's here (${clip.tempo[0].bpm} against ${ours[0].bpm} beats a minute): its notes keep their beats`);
  return { part: next, notes, said };
}

// `notes` of `part` copied again right after themselves: the copy starts the stretch's length
// later, that length rounded up to `step` ticks (the snap's step). The copy so falls against the
// beat as the notes do; where they start on the step, it starts at their end rounded up to it.
// Returns paste()'s {part, notes, said} and `at`, where the copy starts.
export function duplicate(part, notes, step) {
  if (!Number.isInteger(step) || step < 1) throw new Error(`step ${step}: a whole number of ticks, 1 at least`);
  const clip = take(part, notes);
  const start = Math.min(...[...new Set(notes)].map((n) => n.at));
  const at = start + Math.ceil(clip.len / step) * step;
  return { ...paste(part, clip, at), at };
}
