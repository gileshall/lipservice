// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A part's time changed: bars put in, taken out and sung again, with its notes, vibrato, marks,
// tempos and meters moved as the music moves. A score's singers keep one time, so the page does
// each of these to every singer alike. No DOM: node tests it (time_test.mjs).
//
// Where a lane's line runs across a place things move from, a point is laid there with the value
// the line had, so that the music moved keeps the vibrato it had, value for value.

import * as P from "./part.js";

const whole = (v) => Number.isInteger(v) && v >= 0;
// a lane's value worked out, to six places, as the text can write it
const six = (v) => Math.round(v * 1e6) / 1e6;
const ticked = (t, what) => {
  if (!whole(t)) throw new Error(`${what} at tick ${t}: a whole number of ticks from 0`);
};

// ---------------------------------------------------------------- bars

// the meter in force at tick t
export const meterAt = (part, t) => part.meter.findLast((m) => m.at <= t);
// the tempo in force at tick t
export const tempoAt = (part, t) => part.tempo.findLast((x) => x.at <= t);
// a bar of meter m, in ticks
export const barTicks = (part, m) => (part.grid * 4 / m.d) * m.n;

// The bar line at or before tick t: a meter's bars are laid from its own beat.
export function barLine(part, t) {
  const m = meterAt(part, t), len = barTicks(part, m);
  return m.at + Math.floor((t - m.at) / len) * len;
}

// The bar tick t is in, the first 1, as the roll numbers them: a bar cut short by a meter after
// it is a bar.
export function barOf(part, t) {
  let number = 1;
  for (let i = 0; i < part.meter.length; i++) {
    const m = part.meter[i], until = part.meter[i + 1]?.at ?? Infinity, len = barTicks(part, m);
    if (t < until) return number + Math.floor((t - m.at) / len);
    number += Math.ceil((until - m.at) / len);
  }
  throw new Error(`tick ${t}: in no bar`);
}

// The tick n bars on from the bar line at `at`, each bar as long as the meter in force has it.
export function barsFrom(part, at, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${n} bars: a whole number, 1 or more`);
  let t = at;
  for (let k = 0; k < n; k++) {
    const next = part.meter.find((x) => x.at > t)?.at ?? Infinity;
    t = Math.min(barLine(part, t) + barTicks(part, meterAt(part, t)), next);
  }
  return t;
}

// ---------------------------------------------------------------- a lane's values

// The value a lane comes to at tick t from before it: a line running on through t, or reaching it,
// gives its value there; a point on t that jumps is not reached yet.
function before(pts, t, rest) {
  let last = null;
  for (const q of pts) {
    if (q.at >= t) {
      if (q.line) return six(last.value + (q.value - last.value) * (t - last.at) / (q.at - last.at));
      break;
    }
    last = q;
  }
  return last ? last.value : rest;
}

// The lane with `ticks` put in at `at`: the points from `at` on moved on.
function opened(pts, at, ticks, rest) {
  const head = pts.filter((q) => q.at < at), tail = pts.filter((q) => q.at >= at);
  const moved = (qs) => qs.map((q) => ({ ...q, at: q.at + ticks }));
  if (!tail[0]?.line) return [...head, ...moved(tail)];
  // a line runs on to `at` or across it: it comes to `at` as it did, holds through what is put
  // in, and the music moved goes on from that value
  const pin = tail[0].at === at ? tail.shift() : { at, value: before(pts, at, rest), line: true };
  const on = moved(tail);
  return [...head, pin, ...(on[0]?.line ? [{ at: at + ticks, value: pin.value, line: false }] : []), ...on];
}

// The lane with [from, to) taken out: the points from `to` on moved back to `from`.
function closed(pts, from, to, rest) {
  const by = to - from, head = pts.filter((q) => q.at < from), tail = pts.filter((q) => q.at >= to).map((q) => ({ ...q, at: q.at - by }));
  const vFrom = before(pts, from, rest), vTo = before(pts, to, rest), pinned = Boolean(pts.find((q) => q.at >= from)?.line);
  const out = [...head, ...(pinned ? [{ at: from, value: vFrom, line: true }] : [])];
  if (tail[0]?.at === from) {
    // the music after starts on a point: a line arriving there arrives at its value, held, unless
    // a jump on the same beat says what it is
    if (tail[0].line) {
      if (tail[1]?.at === from) tail.shift();
      else tail[0] = { ...tail[0], line: false };
    }
  } else if (vTo !== vFrom || (tail[0]?.line && !pinned)) out.push({ at: from, value: vTo, line: false });
  return [...out, ...tail];
}

// ---------------------------------------------------------------- tempo and meter

// a tempo or meter list with the same change from `at` on; null to take the one there away
function changed(list, at, change, what, grid) {
  ticked(at, what);
  const rest = list.filter((x) => x.at !== at);
  if (change === null) {
    if (at === 0) throw new Error(`the ${what} at beat 0 is where the part starts: change it; it cannot be taken away`);
    if (rest.length === list.length) throw new Error(`no ${what} change at beat ${P.beat(at, grid)} to take away`);
    return rest;
  }
  return [...rest, { ...change, at }].sort((a, b) => a.at - b.at);
}

// The part with its tempo from `at` on `bpm`, or with the change at `at` taken away (bpm null).
export function tempo(part, at, bpm) {
  const out = { ...part, tempo: changed(part.tempo, at, bpm === null ? null : { bpm }, "tempo", part.grid) };
  P.check(out);
  return out;
}

// The part in n/d from `at` on, or with the change at `at` taken away (n null).
export function meter(part, at, n, d) {
  const out = { ...part, meter: changed(part.meter, at, n === null ? null : { n, d }, "meter", part.grid) };
  P.check(out);
  return out;
}

// ---------------------------------------------------------------- bars put in, taken out, again

// `ticks` put in at `at`, as bars of the tempo and the meter in force there: what starts at `at` or
// after moves on, a note sounding across it holds through, and the changes after `at` move on.
// {part, held (the notes that hold through)}
export function insert(part, at, ticks) {
  ticked(at, "bars put in");
  if (!Number.isInteger(ticks) || ticks < 1) throw new Error(`${ticks} ticks put in: a whole number, 1 or more`);
  let held = 0;
  const notes = part.notes.map((n) => {
    if (n.at >= at) return { ...n, at: n.at + ticks };
    if (n.at + n.ticks > at) {
      held++;
      return { ...n, ticks: n.ticks + ticks };
    }
    return n;
  });
  const after = (list) => list.map((x) => (x.at > at ? { ...x, at: x.at + ticks } : x));
  const out = {
    ...part,
    tempo: after(part.tempo),
    meter: after(part.meter),
    notes: P.sort(notes),
    lanes: Object.fromEntries(P.LANES.map((l) => [l, opened(part.lanes[l], at, ticks, P.REST[l])])),
    marks: part.marks.map((m) => (m.at >= at ? { ...m, at: m.at + ticks } : m)),
  };
  P.check(out);
  return { part: out, held };
}

// [from, to) taken out, and what came after moved back: the notes that start in it go with it, a
// note sounding into it is cut short by as much as it sounded there, and the tempo and the meter
// in force at `to` are in force at `from`. {part, gone, shortened}
export function cut(part, from, to) {
  ticked(from, "bars taken out");
  ticked(to, "bars taken out");
  if (to <= from) throw new Error(`bars taken out from beat ${P.beat(from, part.grid)} to beat ${P.beat(to, part.grid)}: nothing between`);
  const by = to - from, notes = [];
  let gone = 0, shortened = 0;
  for (const n of part.notes) {
    const end = n.at + n.ticks;
    if (n.at >= to) notes.push({ ...n, at: n.at - by });
    else if (n.at >= from) gone++;
    else if (end > from) {
      shortened++;
      notes.push({ ...n, ticks: end > to ? n.ticks - by : from - n.at });
    } else notes.push(n);
  }
  // the changes before `from`, the one in force at `to` from `from` where it is another, and those after `to` moved back
  const kept = (list, same) => {
    const out = list.filter((x) => x.at < from), there = list.findLast((x) => x.at <= to);
    if (!out.length || !same(out.at(-1), there)) out.push({ ...there, at: from });
    return [...out, ...list.filter((x) => x.at > to).map((x) => ({ ...x, at: x.at - by }))];
  };
  const out = {
    ...part,
    tempo: kept(part.tempo, (a, b) => a.bpm === b.bpm),
    meter: kept(part.meter, (a, b) => a.n === b.n && a.d === b.d),
    notes: P.sort(notes),
    lanes: Object.fromEntries(P.LANES.map((l) => [l, closed(part.lanes[l], from, to, P.REST[l])])),
    marks: part.marks.filter((m) => m.at < from || m.at >= to).map((m) => (m.at >= to ? { ...m, at: m.at - by } : m)),
  };
  P.check(out);
  return { part: out, gone, shortened };
}

// [from, to) sung `times` more times straight after itself: its notes, words, vibrato, marks and the
// tempo and meter changes in it laid again, and what came after moved on. A note that sounds across
// `to` has no place to end in a stretch sung again, and is refused by its beat. {part, notes (laid
// again)}
export function repeat(part, from, to, times) {
  ticked(from, "bars sung again");
  ticked(to, "bars sung again");
  if (to <= from) throw new Error(`bars sung again from beat ${P.beat(from, part.grid)} to beat ${P.beat(to, part.grid)}: nothing between`);
  if (!Number.isInteger(times) || times < 1) throw new Error(`${times} times: a whole number, 1 or more`);
  const across = part.notes.find((n) => n.at < to && n.at + n.ticks > to);
  if (across) throw new Error(`the note ${P.pitch(across)} at beat ${P.beat(across.at, part.grid)} sounds on past beat ${P.beat(to, part.grid)}, where the bars sung again end: shorten it, or take the bars to where it ends`);
  const len = to - from, gap = len * times, bases = Array.from({ length: times }, (_, k) => to + k * len);
  const inside = (x) => x.at >= from && x.at < to, laid = (x, base) => ({ ...x, at: x.at - from + base });
  const notes = [...part.notes.map((n) => (n.at >= to ? { ...n, at: n.at + gap } : n)), ...bases.flatMap((b) => part.notes.filter(inside).map((n) => laid(n, b)))];
  const marks = [...part.marks.filter((m) => m.at < to), ...bases.flatMap((b) => part.marks.filter(inside).map((m) => laid(m, b))), ...part.marks.filter((m) => m.at >= to).map((m) => ({ ...m, at: m.at + gap }))];
  // the changes before `to`; each time again, the one in force at `from` and those inside; then
  // the one in force at `to` and those after it, moved on
  const changes = (list, same) => {
    const out = list.filter((x) => x.at < to), put = (x, at) => {
      if (!same(out.at(-1), x)) out.push({ ...x, at });
    };
    for (const b of bases) {
      put(list.findLast((x) => x.at <= from), b);
      for (const x of list) if (x.at > from && x.at < to) out.push(laid(x, b));
    }
    put(list.findLast((x) => x.at <= to), to + gap);
    return [...out, ...list.filter((x) => x.at > to).map((x) => ({ ...x, at: x.at + gap }))];
  };
  const out = {
    ...part,
    tempo: changes(part.tempo, (a, b) => a.bpm === b.bpm),
    meter: changes(part.meter, (a, b) => a.n === b.n && a.d === b.d),
    notes: P.sort(notes),
    lanes: Object.fromEntries(P.LANES.map((l) => [l, again(part.lanes[l], from, to, times, P.REST[l])])),
    marks: marks.sort((a, b) => a.at - b.at),
  };
  P.check(out);
  return { part: out, notes: part.notes.filter(inside).length * times };
}

// The lane with [from, to) laid again `times` times from `to`. Each time begins at the value the
// lane has at `from` and ends at the value it comes to at `to`.
function again(pts, from, to, times, rest) {
  const len = to - from, gap = len * times;
  const vFrom = P.at(pts, from, rest), vTo = before(pts, to, rest), running = Boolean(pts.find((q) => q.at >= to)?.line);
  // the stretch's points: a line arriving at `from` is the stretch before's
  const seg = pts.filter((q) => q.at >= from && q.at < to && !(q.at === from && q.line));
  const tail = pts.filter((q) => q.at >= to), out = pts.filter((q) => q.at < to);
  const end = (b) => {
    if (running) out.push({ at: b, value: vTo, line: true });
  };
  if (tail[0]?.at === to && tail[0].line) out.push(tail.shift());
  else end(to);
  for (let k = 0; k < times; k++) {
    const base = to + k * len;
    if (seg[0]?.at !== from) out.push({ at: base, value: vFrom, line: false });
    out.push(...seg.map((q) => ({ ...q, at: q.at - from + base })));
    end(base + len);
  }
  const on = tail.map((q) => ({ ...q, at: q.at + gap }));
  return [...out, ...(on[0]?.line ? [{ at: to + gap, value: vTo, line: false }] : []), ...on];
}
