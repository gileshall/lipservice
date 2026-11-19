// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A singer's part as text: `lipservice part 2` (PART.md). read() and write() are each other's
// inverse on every part check() passes. No DOM: the page and node both use it.
//
// A part:
//   {title, grid,
//    singer: {voice, seed, shift, join, glide, dynamics, breathiness, diction, motion, sway,
//             jitter, detune, spread, breath},
//    tempo: [{at, bpm}], meter: [{at, n, d}],
//    notes: [{at, ticks, pitch, cents, velocity, release, lyric}],
//    lanes: {vibrato: [{at, value, line}]},
//    marks: [{at, breath}]}
// Every `at` and `ticks` is a whole number of ticks, `grid` to the beat. A note's pitch is its
// key's name as spelled ("E4", "Bb2"); its lyric is its syllable as the text writes it ("Ma-",
// "ry", "_", "lamb,/") or null.

export const HEAD = "lipservice part 2";
export const GRID = 960;
export const LANES = ["vibrato"];
// what a lane stands at before its first point
export const REST = { vibrato: 1 };
export const UNITS = [1, 2, 4, 8, 16, 32];
// a number read as a beat may be this far from a whole tick
const NEAR = 0.05;

// name, kind: a setting a line, in the order written
const SINGER = [
  ["voice", "name"],
  ["seed", "seed"],
  ["shift", "any"],
  ["join", "some"],
  ["glide", "frames"],
  ["dynamics", "some"],
  ["breathiness", "some"],
  ["diction", "flag"],
  ["motion", "motion"],
  ["sway", "some"],
  ["jitter", "count"],
  ["detune", "some"],
  ["spread", "some"],
  ["breath", "chance"],
];

const whole = (v) => Number.isInteger(v) && v >= 0;
const NUMBER = /^-?\d+(\.\d+)?$/;

// a number as the text writes it
function num(x, what) {
  const s = String(x);
  if (!Number.isFinite(x) || !NUMBER.test(s)) throw new Error(`${what} ${x}: not a number the text can write`);
  return s;
}

// what is wrong with a setting's value, or null
function wrong(kind, v) {
  const n = typeof v === "number" && Number.isFinite(v) && NUMBER.test(String(v));
  switch (kind) {
    case "name": return typeof v === "string" && /^\S+$/.test(v) ? null : "a name with no space in it";
    case "seed": return whole(v) && v <= 4294967295 ? null : "a whole number, 0 to 4294967295";
    case "any": return n ? null : "a number";
    case "some": return n && v >= 0 ? null : "0 or more";
    case "frames": return whole(v) && v >= 1 ? null : "a whole number of frames, 1 at least";
    case "count": return whole(v) ? null : "a whole number, 0 or more";
    case "flag": return typeof v === "boolean" ? null : "0 or 1";
    case "motion": return v === null || (typeof v === "string" && /^[A-Za-z0-9]+$/.test(v)) ? null : "a name, or - for none";
    case "chance": return n && v >= 0 && v <= 1 ? null : "a chance, 0 to 1";
  }
  throw new Error(`no kind ${kind}`);
}

// ---------------------------------------------------------------- pitch

const STEPS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const PITCH = /^([A-G])(#{1,2}|b{1,2})?(-?\d+)$/;

// the MIDI key a name spells: C4 is 60
export function key(name) {
  const m = typeof name === "string" && PITCH.exec(name);
  if (!m) throw new Error(`${name}: not a key (C4, F#3, Bb2)`);
  const acc = m[2] ? (m[2][0] === "#" ? m[2].length : -m[2].length) : 0;
  const k = 12 * (Number(m[3]) + 1) + STEPS[m[1]] + acc;
  if (k < 0 || k > 127) throw new Error(`${name}: outside MIDI's keys, C-1 to G9`);
  return k;
}

// a MIDI key's name, its black keys as sharps
export function name(k) {
  if (!whole(k) || k > 127) throw new Error(`key ${k}: 0 to 127`);
  return `${SHARPS[k % 12]}${Math.floor(k / 12) - 1}`;
}

// "E4+14" as [name, cents]
export function pitched(s) {
  const m = /^([A-G][#b]*-?\d+?)(?:([+-]\d+(?:\.\d+)?))?$/.exec(s);
  if (!m) throw new Error(`${s}: a pitch is a key (C4, F#3, Bb2), with its cents where it is off (E4+14)`);
  key(m[1]);
  return [m[1], m[2] === undefined ? 0 : Number(m[2])];
}

// ---------------------------------------------------------------- lyric

const SYLLABLE = /^[^\s_/]*[^\s_/-]-?\/?$/;

// whether `s` is a note's lyric as the text writes it
export const lyrical = (s) => s === "_" || (typeof s === "string" && SYLLABLE.test(s));

// a lyric apart: {text, on (its word goes on), end (a line ends)}; null of a held note's
export function syllable(lyric) {
  if (lyric === "_") return null;
  if (!lyrical(lyric)) throw new Error(`"${lyric}": not a syllable`);
  const end = lyric.endsWith("/"), a = end ? lyric.slice(0, -1) : lyric, on = a.endsWith("-");
  return { text: on ? a.slice(0, -1) : a, on, end };
}

// ---------------------------------------------------------------- check

// What is wrong with item `i` of its kind, by itself and after the one before it, or null. The
// reader asks as each line is read, so that it can name the line; check() asks of a whole part.
const RULES = {
  tempo(p, i) {
    const t = p.tempo[i];
    if (!whole(t.at)) return `a tempo at tick ${t.at}: a whole number of ticks from 0`;
    if (!(typeof t.bpm === "number" && NUMBER.test(String(t.bpm)) && t.bpm >= 4 && t.bpm <= 60000000)) return `tempo ${t.bpm}: 4 to 60000000 beats a minute`;
    if (i === 0 ? t.at !== 0 : p.tempo[i - 1].at >= t.at) return i === 0 ? "the first tempo is on beat 0" : `the tempo at beat ${beat(t.at, p.grid)}: after the one before it, one to a beat`;
    return null;
  },
  meter(p, i) {
    const m = p.meter[i];
    if (!whole(m.at)) return `a meter at tick ${m.at}: a whole number of ticks from 0`;
    if (!whole(m.n) || m.n < 1 || m.n > 255 || !UNITS.includes(m.d)) return `meter ${m.n}/${m.d}: 1 to 255 notes of a 1st, 2nd, 4th, 8th, 16th or 32nd`;
    if (i === 0 ? m.at !== 0 : p.meter[i - 1].at >= m.at) return i === 0 ? "the first meter is on beat 0" : `the meter at beat ${beat(m.at, p.grid)}: after the one before it, one to a beat`;
    return null;
  },
  notes(p, i) {
    const n = p.notes[i];
    if (!whole(n.at)) return `a note at tick ${n.at}: a whole number of ticks from 0`;
    const at = `the note at beat ${beat(n.at, p.grid)}`;
    if (!whole(n.ticks) || n.ticks < 1) return `${at}: ${n.ticks} ticks long, not a tick at least`;
    try { key(n.pitch); } catch (e) { return `${at}: ${e.message}`; }
    if (!(typeof n.cents === "number" && NUMBER.test(String(n.cents)) && Math.abs(n.cents) < 100)) return `${at}: ${n.cents} cents, not a number under 100 either way`;
    if (!whole(n.velocity) || n.velocity < 1 || n.velocity > 127) return `${at}: velocity ${n.velocity}, not 1 to 127`;
    if (!whole(n.release) || n.release > 127) return `${at}: release ${n.release}, not 0 to 127`;
    if (n.lyric !== null && !lyrical(n.lyric)) return `${at}: "${n.lyric}" is not a syllable`;
    const b = i > 0 && p.notes[i - 1];
    if (b && (b.at > n.at || (b.at === n.at && key(b.pitch) > key(n.pitch)))) return `${at}: the notes are in the order of their starts, of two that start together the lower key first`;
    return null;
  },
  lane(p, l, i) {
    const pts = p.lanes[l], q = pts[i];
    if (!whole(q.at)) return `${l} at tick ${q.at}: a whole number of ticks from 0`;
    const at = `${l} at beat ${beat(q.at, p.grid)}`;
    if (!(typeof q.value === "number" && NUMBER.test(String(q.value)) && q.value >= 0)) return `${at}: ${q.value}, not a number 0 or more`;
    if (typeof q.line !== "boolean") return `${at}: reached by a line or not`;
    if (i === 0) return q.line ? `${at}: the first point is reached by no line` : null;
    if (pts[i - 1].at > q.at) return `${at}: before the point before it`;
    if (pts[i - 1].at === q.at && (q.line || !pts[i - 1].line || (i > 1 && pts[i - 2].at === q.at))) return `${at}: two points share a beat only where the first is reached by a line and the second is not`;
    return null;
  },
  marks(p, i) {
    const m = p.marks[i];
    if (!whole(m.at)) return `a mark at tick ${m.at}: a whole number of ticks from 0`;
    if (typeof m.breath !== "boolean") return `the mark at beat ${beat(m.at, p.grid)}: breath or nobreath`;
    if (i > 0 && p.marks[i - 1].at >= m.at) return `the mark at beat ${beat(m.at, p.grid)}: after the one before it, one to a beat`;
    return null;
  },
};

// Whether `p` is a part the text can hold: throws what is wrong with it.
export function check(p) {
  if (typeof p.title !== "string" || p.title !== p.title.trim() || /[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(p.title)) throw new Error("the title: one line of text, no space at its ends");
  if (!whole(p.grid) || p.grid < 1 || p.grid > 32767) throw new Error(`grid ${p.grid}: ticks a beat, 1 to 32767`);
  for (const [k, kind] of SINGER) {
    const why = wrong(kind, p.singer[k]);
    if (why) throw new Error(`${k} ${p.singer[k]}: ${why}`);
  }
  const more = Object.keys(p.singer).find((k) => !SINGER.some(([n]) => n === k));
  if (more) throw new Error(`${more}: no such setting of a singer`);
  if (!p.tempo.length) throw new Error("the part has no tempo");
  if (!p.meter.length) throw new Error("the part has no meter");
  if (Object.keys(p.lanes).length !== LANES.length || LANES.some((l) => !Array.isArray(p.lanes[l]))) throw new Error(`the lanes: ${LANES.join(", ")}`);
  const all = (xs, rule) => xs.forEach((_, i) => {
    const why = rule(i);
    if (why) throw new Error(why);
  });
  all(p.tempo, (i) => RULES.tempo(p, i));
  all(p.meter, (i) => RULES.meter(p, i));
  all(p.notes, (i) => RULES.notes(p, i));
  for (const l of LANES) all(p.lanes[l], (i) => RULES.lane(p, l, i));
  all(p.marks, (i) => RULES.marks(p, i));
}

// ---------------------------------------------------------------- write

// ticks as beats: six places at most, trailing zeros dropped
export function beat(ticks, grid) {
  return (ticks / grid).toFixed(6).replace(/\.?0+$/, "");
}

// beats as the text writes them, as ticks: beat() the other way
export function ticks(text, grid) {
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`${text}: beats, 0 or more`);
  const x = Number(text) * grid, t = Math.round(x);
  if (Math.abs(x - t) > NEAR) throw new Error(`${text}: on no tick of a grid of ${grid}`);
  return t;
}

// the pitch as the text writes it
export function pitch(n) {
  return n.cents === 0 ? n.pitch : `${n.pitch}${n.cents > 0 ? "+" : ""}${num(n.cents, "cents")}`;
}

export function write(p) {
  check(p);
  const b = (t) => beat(t, p.grid), s = p.singer;
  const out = [HEAD, p.title ? `title ${p.title}` : "title", `grid ${p.grid}`, ""];
  for (const [k, kind] of SINGER) {
    const v = kind === "flag" ? (s[k] ? "1" : "0") : kind === "motion" ? (s[k] ?? "-") : kind === "name" ? s[k] : num(s[k], k);
    out.push(`${k} ${v}`);
  }
  out.push("");
  for (const t of p.tempo) out.push(`tempo ${b(t.at)} ${num(t.bpm, "tempo")}`);
  for (const m of p.meter) out.push(`meter ${b(m.at)} ${m.n}/${m.d}`);
  if (p.notes.length) out.push("");
  for (const n of p.notes) out.push(`note ${b(n.at)} ${b(n.ticks)} ${pitch(n)} ${n.velocity} ${n.release}${n.lyric === null ? "" : ` ${n.lyric}`}`);
  for (const l of LANES) {
    if (p.lanes[l].length) out.push("");
    for (const q of p.lanes[l]) out.push(`${l} ${b(q.at)} ${num(q.value, l)}${q.line ? " line" : ""}`);
  }
  if (p.marks.length) out.push("");
  for (const m of p.marks) out.push(`mark ${b(m.at)} ${m.breath ? "breath" : "nobreath"}`);
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- read

export function read(text) {
  if (typeof text !== "string") throw new Error("a part is text");
  const lines = text.replace(/^\ufeff/, "").split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines[0] !== HEAD) throw new Error(`not a lipservice part this reads: its first line is not "${HEAD}"`);
  const p = { title: null, grid: null, singer: {}, tempo: [], meter: [], notes: [], lanes: Object.fromEntries(LANES.map((l) => [l, []])), marks: [] };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (i === 0 || !line) return;
    const fail = (why) => { throw new Error(`line ${i + 1}: ${why}`); };
    const rule = (why) => { if (why) fail(why); };
    const f = line.split(/[ \t]+/), [what, ...v] = f;
    const number = (s, of) => {
      if (!NUMBER.test(s)) fail(`${s}: ${of} is a number`);
      return Number(s);
    };
    const count = (s, of) => {
      if (!/^\d+$/.test(s)) fail(`${s}: ${of} is a whole number`);
      return Number(s);
    };
    const ticks = (s, of) => {
      if (p.grid === null) fail("a beat before the grid is given");
      if (!/^\d+(\.\d+)?$/.test(s)) fail(`${s}: ${of} is in beats, 0 or more`);
      const x = Number(s) * p.grid, t = Math.round(x);
      if (Math.abs(x - t) > NEAR) fail(`${s}: ${of} is on no tick of a grid of ${p.grid}`);
      return t;
    };
    const fields = (n, shape) => { if (v.length !== n) fail(`${what} takes ${shape}`); };
    const setting = SINGER.find(([n]) => n === what);
    if (what === "title") {
      if (p.title !== null) fail("title given twice");
      p.title = line.slice(5).trim();
    } else if (what === "grid") {
      fields(1, "the ticks a beat");
      if (p.grid !== null) fail("grid given twice");
      p.grid = count(v[0], "the grid");
      if (p.grid < 1 || p.grid > 32767) fail(`grid ${v[0]}: 1 to 32767`);
    } else if (setting) {
      const [k, kind] = setting;
      fields(1, "one value");
      if (k in p.singer) fail(`${k} given twice`);
      const x = kind === "name" ? v[0]
        : kind === "flag" ? (v[0] === "1" ? true : v[0] === "0" ? false : fail(`${k} ${v[0]}: 0 or 1`))
        : kind === "motion" ? (v[0] === "-" ? null : v[0])
        : number(v[0], k);
      const why = wrong(kind, x);
      if (why) fail(`${k} ${v[0]}: ${why}`);
      p.singer[k] = x;
    } else if (what === "tempo") {
      fields(2, "a beat and the beats a minute from there");
      p.tempo.push({ at: ticks(v[0], "a tempo's beat"), bpm: number(v[1], "a tempo") });
      rule(RULES.tempo(p, p.tempo.length - 1));
    } else if (what === "meter") {
      fields(2, "a beat and the meter from there, as 4/4");
      const m = /^(\d+)\/(\d+)$/.exec(v[1]);
      if (!m) fail(`${v[1]}: a meter is as 4/4`);
      p.meter.push({ at: ticks(v[0], "a meter's beat"), n: Number(m[1]), d: Number(m[2]) });
      rule(RULES.meter(p, p.meter.length - 1));
    } else if (what === "note") {
      if (v.length !== 5 && v.length !== 6) fail("a note is its start, its beats, its pitch, its velocity, its release and its syllable if it has one");
      let named;
      try { named = pitched(v[2]); } catch (e) { fail(e.message); }
      const lyric = v.length === 6 ? v[5] : null;
      if (lyric !== null && !lyrical(lyric)) fail(`"${lyric}": a syllable is its letters, a - if its word goes on, a / if a line ends; or _ for a note that holds the one before`);
      p.notes.push({ at: ticks(v[0], "a note's start"), ticks: ticks(v[1], "a note's length"), pitch: named[0], cents: named[1], velocity: count(v[3], "a velocity"), release: count(v[4], "a release"), lyric });
      rule(RULES.notes(p, p.notes.length - 1));
    } else if (LANES.includes(what)) {
      if ((v.length !== 2 && v.length !== 3) || (v.length === 3 && v[2] !== "line")) fail(`${what} takes a beat and a value, and "line" where the value is reached by one`);
      p.lanes[what].push({ at: ticks(v[0], `${what}'s beat`), value: number(v[1], what), line: v.length === 3 });
      rule(RULES.lane(p, what, p.lanes[what].length - 1));
    } else if (what === "mark") {
      fields(2, "a beat, and breath or nobreath");
      if (v[1] !== "breath" && v[1] !== "nobreath") fail(`${v[1]}: a mark is breath or nobreath`);
      p.marks.push({ at: ticks(v[0], "a mark's beat"), breath: v[1] === "breath" });
      rule(RULES.marks(p, p.marks.length - 1));
    } else {
      fail(`"${what}": no such line in a part`);
    }
  });
  const missing = [...(p.title === null ? ["title"] : []), ...(p.grid === null ? ["grid"] : []), ...SINGER.map(([k]) => k).filter((k) => !(k in p.singer))];
  if (missing.length) throw new Error(`the part has no ${missing.join(", ")}`);
  check(p);
  return p;
}

// ---------------------------------------------------------------- making

// A singer as the page's choirs are sung.
export const singer = (voice, seed = 0) => ({ voice, seed, shift: 0, join: 0, glide: 9, dynamics: 1.3, breathiness: 0.35, diction: true, motion: "vibrato", sway: 1, jitter: 2, detune: 3, spread: 0, breath: 0.85 });

// A part with nothing to sing yet, at 120 in 4/4.
export const blank = (who, grid = GRID) => ({ title: "", grid, singer: { ...who }, tempo: [{ at: 0, bpm: 120 }], meter: [{ at: 0, n: 4, d: 4 }], notes: [], lanes: Object.fromEntries(LANES.map((l) => [l, []])), marks: [] });

// The notes in the order a part keeps them.
export function sort(notes) {
  return notes.map((n, i) => [n, i]).sort(([a, i], [b, j]) => a.at - b.at || key(a.pitch) - key(b.pitch) || i - j).map(([n]) => n);
}

// A lane's value at tick `t`.
export function at(points, t, rest) {
  let v = rest;
  for (let i = 0; i < points.length; i++) {
    const q = points[i];
    if (q.at <= t) { v = q.value; continue; }
    if (q.line) {
      const a = points[i - 1];
      return a.value + (q.value - a.value) * (t - a.at) / (q.at - a.at);
    }
    break;
  }
  return v;
}
