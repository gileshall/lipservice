// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The editor without its page: a part, what of it is selected, what was done to it and can be
// undone, and where things are on a roll that scrolls and zooms. Every change leaves a part the
// text can hold (part.js check) or is refused and leaves the part as it was. No DOM: the page
// draws what this holds, and node tests it.

import * as P from "./part.js";

export { word } from "./song.js";

// Words as typed, as the syllables notes take in turn: a word a note a syllable, a hyphen between
// a word's syllables (lit-tle), a _ for each further note a syllable holds (wide__, wa_-ter, or
// a _ standing alone), a line's end where the typing's line ends or a word ends in /.
export function syllables(text) {
  const out = [], lines = text.split("\n");
  lines.forEach((line, li) => {
    let last = -1; // the line's last syllable, where its end is not written yet
    for (const raw of line.trim().split(/\s+/).filter(Boolean)) {
      const end = raw.endsWith("/"), word = end ? raw.slice(0, -1) : raw;
      if (/^_+$/.test(word)) {
        if (!out.length) throw new Error(`${raw}: a held note with no syllable before it`);
        for (let h = 0; h < word.length; h++) out.push("_");
      } else {
        const pieces = word.split("-");
        const on = pieces.length > 1 && pieces[pieces.length - 1] === "";
        if (on) pieces.pop();
        pieces.forEach((piece, k) => {
          const s = piece.replace(/_+$/, "");
          if (!s || /[_/]/.test(s)) throw new Error(`${raw}: a syllable is its letters, then a _ for each note it holds`);
          out.push(s + (k + 1 < pieces.length || on ? "-" : ""));
          last = out.length - 1;
          for (let h = s.length; h < piece.length; h++) out.push("_");
        });
      }
      if (end) {
        if (last < 0) throw new Error(`${raw}: a line's end with no syllable in the line`);
        out[last] += "/";
        last = -1;
      }
    }
    if (last >= 0 && li + 1 < lines.length) out[last] += "/";
  });
  return out;
}

// The notes' syllables as words to read or type: syllables() the other way. Notes with no words
// are left out.
export function typed(notes) {
  let out = "", before = null; // the syllable before
  for (const n of notes) {
    if (n.lyric === null) continue;
    if (n.lyric === "_") { out += "_"; continue; }
    const s = P.syllable(n.lyric);
    if (before) out += (before.on ? "-" : "") + (before.end ? "\n" : before.on ? "" : " ");
    out += s.text;
    before = s;
  }
  return out + (before?.on ? "-" : "") + (before?.end ? "\n" : "");
}

// A value and what it was: commit() takes its next, undo() and redo() go back and on. A drag is
// as an Editor's: from begin() to end() each change is made again from where it began (again()),
// and the whole is undone as one. `pushed`, where set, is called as a step back is laid down.
export class History {
  constructor(value) {
    Object.assign(this, { value, past: [], future: [], drag: null, pushed: null });
  }

  commit(value) {
    if (!this.drag || !this.drag.done) {
      this.past.push((this.drag ?? this).value);
      this.future = [];
      if (this.drag) this.drag.done = true;
      this.pushed?.(this);
    }
    this.value = value;
  }

  undo() {
    if (!this.past.length) return false;
    this.future.push(this.value);
    this.value = this.past.pop();
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.past.push(this.value);
    this.value = this.future.pop();
    return true;
  }

  begin() { this.drag = { value: this.value, done: false }; }

  again() { if (this.drag) this.value = this.drag.value; }

  end() { this.drag = null; }
}

export class Editor {
  constructor(part) {
    P.check(part);
    this.part = part;
    this.selected = new Set(); // of the part's notes
    this.past = [];
    this.future = [];
    this.drag = null;
    this.saved = part; // the part as last read or written
    this.pushed = null; // called as a step back is laid down
  }

  get changed() { return this.part !== this.saved; }

  // ---- what was done

  // The part becomes `part`. Refused, and nothing changed, if the text cannot hold it.
  commit(part, selected = this.selected) {
    P.check(part);
    if (!this.drag || !this.drag.done) {
      const was = this.drag ?? this;
      this.past.push([was.part, was.selected]);
      this.future = [];
      if (this.drag) this.drag.done = true;
      this.pushed?.(this);
    }
    this.part = part;
    this.selected = new Set([...selected].filter((n) => part.notes.includes(n)));
  }

  undo() {
    if (!this.past.length) return false;
    this.future.push([this.part, this.selected]);
    [this.part, this.selected] = this.past.pop();
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.past.push([this.part, this.selected]);
    [this.part, this.selected] = this.future.pop();
    return true;
  }

  // A drag: from begin() to end(), each change is made again from where the drag began (again()
  // puts the part back there), and the whole drag is undone as one.
  begin() { this.drag = { part: this.part, selected: this.selected, done: false }; }

  again() { if (this.drag) [this.part, this.selected] = [this.drag.part, this.drag.selected]; }

  end() { this.drag = null; }

  // ---- notes

  select(notes, more = false) {
    const next = new Set(more ? this.selected : []);
    for (const n of notes) {
      if (more && this.selected.has(n)) next.delete(n);
      else next.add(n);
    }
    this.selected = next;
  }

  // each note as f gives it: the note itself, another in its place, or null for none
  #notes(f) {
    const out = [], selected = new Set();
    for (const n of this.part.notes) {
      const m = f(n);
      if (m === null) continue;
      out.push(m);
      if (this.selected.has(n)) selected.add(m);
    }
    this.commit({ ...this.part, notes: P.sort(out) }, selected);
  }

  add(at, ticks, key, velocity, release = 64) {
    const note = { at, ticks, pitch: P.name(key), cents: 0, velocity, release, lyric: null };
    this.commit({ ...this.part, notes: P.sort([...this.part.notes, note]) }, new Set([note]));
    return note;
  }

  remove() {
    if (this.selected.size) this.#notes((n) => (this.selected.has(n) ? null : n));
  }

  // The selected notes `dt` ticks later and `dk` keys higher, as far as the part's start and the
  // keyboard's ends let them all go.
  move(dt, dk) {
    const sel = [...this.selected];
    if (!sel.length) return;
    dt = Math.max(dt, -Math.min(...sel.map((n) => n.at)));
    dk = Math.max(-Math.min(...sel.map((n) => P.key(n.pitch))), Math.min(127 - Math.max(...sel.map((n) => P.key(n.pitch))), dk));
    if (!dt && !dk) return;
    this.#notes((n) => (this.selected.has(n) ? { ...n, at: n.at + dt, pitch: dk ? P.name(P.key(n.pitch) + dk) : n.pitch } : n));
  }

  // The selected notes `dt` ticks longer, none shorter than `least`.
  stretch(dt, least = 1) {
    if (!this.selected.size) return;
    this.#notes((n) => (this.selected.has(n) ? { ...n, ticks: Math.max(Math.min(least, n.ticks), n.ticks + dt) } : n));
  }

  set(notes, values) {
    const which = new Set(notes);
    this.#notes((n) => (which.has(n) ? { ...n, ...values } : n));
  }

  // The words typed, a syllable to each note from `note` on.
  words(note, text) {
    const syl = syllables(text), from = this.part.notes.indexOf(note);
    if (from < 0) throw new Error("no such note");
    const room = this.part.notes.length - from;
    if (syl.length > room) throw new Error(`${syl.length} syllables for the ${room} ${room === 1 ? "note" : "notes"} from here`);
    const which = new Map(this.part.notes.slice(from, from + syl.length).map((n, i) => [n, syl[i]]));
    this.#notes((n) => (which.has(n) ? { ...n, lyric: which.get(n) } : n));
    return this.part.notes[from + syl.length] ?? null;
  }

  // ---- lanes

  // The ticks point `i` of a lane may be on, between the points beside it.
  room(lane, i) {
    const pts = this.part.lanes[lane], q = pts[i], a = pts[i - 1], b = pts[i + 1];
    const lo = !a ? 0 : a.at + (a.line && !q.line && pts[i - 2]?.at !== a.at && i > 1 ? 0 : 1);
    const hi = !b ? Infinity : b.at - (q.line && !b.line && pts[i + 2]?.at !== b.at ? 0 : 1);
    return [lo, hi];
  }

  #lane(lane, points) { this.commit({ ...this.part, lanes: { ...this.part.lanes, [lane]: points } }); }

  // A point that holds at `at`, in place of one there already: its index.
  point(lane, at, value) {
    const pts = this.part.lanes[lane], i = pts.findIndex((q) => q.at >= at);
    const there = i >= 0 && pts[i].at === at && pts[i + 1]?.at !== at;
    const k = i < 0 ? pts.length : i;
    const next = there ? pts.map((q, j) => (j === k ? { ...q, value } : q)) : [...pts.slice(0, k), { at, value, line: false }, ...pts.slice(k)];
    this.#lane(lane, next);
    return k;
  }

  // Point `i` at `at` (as near as the points beside it let it) and `value`.
  repoint(lane, i, at, value) {
    const [lo, hi] = this.room(lane, i);
    this.#lane(lane, this.part.lanes[lane].map((q, j) => (j === i ? { ...q, at: Math.max(lo, Math.min(hi, at)), value: Math.max(0, value) } : q)));
  }

  line(lane, i, line) { this.#lane(lane, this.part.lanes[lane].map((q, j) => (j === i ? { ...q, line } : q))); }

  unpoint(lane, i) {
    let pts = this.part.lanes[lane].filter((_, j) => j !== i);
    // the point after the first is the first now, and is reached by no line: it holds, or where
    // a jump shares its beat, the jump is all there is
    if (pts[0]?.line) pts = pts[1]?.at === pts[0].at ? pts.slice(1) : [{ ...pts[0], line: false }, ...pts.slice(1)];
    this.#lane(lane, pts);
  }

  // ---- the rest of the part

  // The mark at `at`: none, then breath, then nobreath, then none.
  mark(at) {
    const m = this.part.marks.find((x) => x.at === at), rest = this.part.marks.filter((x) => x.at !== at);
    const marks = !m ? [...rest, { at, breath: true }] : m.breath ? [...rest, { at, breath: false }] : rest;
    this.commit({ ...this.part, marks: marks.sort((a, b) => a.at - b.at) });
  }

  // The tempo from `at` on; null for the one before it to run on (not at the part's start).
  tempo(at, bpm) {
    const rest = this.part.tempo.filter((t) => t.at !== at);
    this.commit({ ...this.part, tempo: (bpm === null ? rest : [...rest, { at, bpm }]).sort((a, b) => a.at - b.at) });
  }

  meter(at, n, d) {
    const rest = this.part.meter.filter((m) => m.at !== at);
    this.commit({ ...this.part, meter: (n === null ? rest : [...rest, { at, n, d }]).sort((a, b) => a.at - b.at) });
  }

  singer(name, value) { this.commit({ ...this.part, singer: { ...this.part.singer, [name]: value } }); }

  title(text) { this.commit({ ...this.part, title: text.trim() }); }

  // Another part in this one's place, as a file opened gives it.
  load(part, saved = true) {
    this.commit(part, new Set());
    if (saved) this.saved = part;
  }
}

// ---------------------------------------------------------------- the roll

// The bar lines and beat lines from tick `from` to `to`: [{tick, bar (from 1, at a bar line),
// beat (in its bar, from 1)}]. A meter's bars start at its own beat.
export function bars(part, from, to) {
  const out = [];
  let number = 1;
  part.meter.forEach((m, i) => {
    const until = part.meter[i + 1]?.at ?? Infinity, step = part.grid * 4 / m.d;
    const count = Math.ceil((Math.min(until, to + 1) - m.at) / step);
    const first = Math.max(0, Math.ceil((from - m.at) / step));
    for (let k = first; k < count && m.at + k * step <= to; k++) {
      const tick = m.at + k * step;
      if (tick >= until) break;
      out.push({ tick, bar: k % m.n === 0 ? number + k / m.n : null, beat: (k % m.n) + 1 });
    }
    if (until !== Infinity) number += Math.ceil((until - m.at) / step / m.n);
  });
  return out;
}

// Where a click falls from tick 0 to `to`: [{tick, accent}], a click a beat of the meter and an
// accent on each bar's first; in six, nine or twelve eight, a click every three eighths.
export function clicks(part, to) {
  const out = [];
  for (const b of bars(part, 0, to)) {
    let m = part.meter[0];
    for (const x of part.meter) if (x.at <= b.tick) m = x;
    if (m.d === 8 && m.n >= 6 && m.n % 3 === 0 && (b.beat - 1) % 3 !== 0) continue;
    out.push({ tick: b.tick, accent: b.bar !== null });
  }
  return out;
}

// The steps a note may snap to on a grid: [{name, ticks}], whole numbers of ticks only.
export function steps(grid) {
  return [["1 beat", 1], ["1/2", 2], ["1/3", 3], ["1/4", 4], ["1/6", 6], ["1/8", 8], ["1/12", 12], ["1/16", 16]]
    .filter(([, k]) => grid % k === 0)
    .map(([name, k]) => ({ name, ticks: grid / k }))
    .concat([{ name: "tick", ticks: 1 }]);
}

export const snap = (tick, step) => Math.max(0, Math.round(tick / step) * step);

// Where ticks and keys are on a roll: `left` the tick at x 0, `wide` pixels a tick, `top` the key
// whose row's top is at y 0 (a fraction of a key scrolls), `tall` pixels a key.
export class View {
  constructor({ left = 0, wide = 0.1, top = 84, tall = 14 } = {}) {
    Object.assign(this, { left, wide, top, tall });
  }

  x(tick) { return (tick - this.left) * this.wide; }

  tick(x) { return this.left + x / this.wide; }

  // the top of a key's row
  y(key) { return (this.top - key) * this.tall; }

  // the key whose row y is in
  key(y) { return Math.ceil(this.top - y / this.tall); }

  // `k` times as wide (or as tall), what is under x (or y) staying there
  zoom(k, x) {
    const at = this.tick(x);
    this.wide = Math.max(0.002, Math.min(4, this.wide * k));
    this.left = Math.max(0, at - x / this.wide);
  }

  heighten(k, y) {
    const at = this.top - y / this.tall;
    this.tall = Math.max(4, Math.min(40, this.tall * k));
    this.top = at + y / this.tall;
  }

  scroll(dx, dy, height) {
    this.left = Math.max(0, this.left + dx / this.wide);
    this.top = Math.max(Math.min(127, height / this.tall - 1), Math.min(127, this.top - dy / this.tall));
  }

  // the whole of `part` in `width` pixels, and its notes' keys in `height`
  fit(part, width, height) {
    if (!(width > 0 && height > 0)) throw new Error(`no room to fit a part in: ${width} by ${height}`);
    const end = Math.max(part.grid * 16, ...part.notes.map((n) => n.at + n.ticks), ...P.LANES.flatMap((l) => part.lanes[l].map((q) => q.at)));
    this.left = 0;
    this.wide = Math.max(0.002, Math.min(4, width / (end * 1.05)));
    if (part.notes.length) {
      const keys = part.notes.map((n) => P.key(n.pitch)), mid = (Math.max(...keys) + Math.min(...keys)) / 2;
      this.top = Math.min(127, Math.round(mid + height / this.tall / 2));
    }
  }
}

// The note of `part` at a tick and key, the last drawn first; and whether the tick is within
// `edge` ticks of its end (where a drag lengthens it).
export function hit(part, tick, key, edge) {
  for (let i = part.notes.length - 1; i >= 0; i--) {
    const n = part.notes[i];
    if (P.key(n.pitch) === key && tick >= n.at && tick < n.at + n.ticks) return { note: n, end: n.at + n.ticks - tick <= Math.min(edge, n.ticks / 2) };
  }
  return null;
}

// The note whose time `tick` is in, for the rows under the roll (words, velocity): the last to
// start on or before it that still sounds, else null.
export function sounding(part, tick) {
  let found = null;
  for (const n of part.notes) {
    if (n.at > tick) break;
    if (tick < n.at + n.ticks) found = n;
  }
  return found;
}
