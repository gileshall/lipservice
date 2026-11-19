// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A part in and out of a MIDI file (PART.md, "In a MIDI file"). write() says what a MIDI file can
// say in the standard way and puts the part's own text inside as a system exclusive event; read()
// gives back that part where the file is as lipservice left it, and reads the events where it is
// not, or where there is no part inside. No DOM: the page and node both use it.

import * as P from "./part.js";

// The controller that is the vibrato's lane: the mod wheel.
export const WHEEL = 1;
// A system exclusive message of lipservice's: the number MIDI keeps for use outside commerce, then
// the name, then the kind.
export const SIGN = [0x7d, ...new TextEncoder().encode("lipservice")];
export const KIND = { part: 1 };
// the bend's range where no file says: semitones either way
const RANGE = 2;
const CENTRE = 8192;

// The vibrato's size at a controller's step, against the voice's own: none at 0, the voice's own
// at the middle (64), twice it at the top (127). As the plugin has it (plugin/src/midi.rs).
export function size(step) {
  const s = Math.min(step, 127);
  return s <= 64 ? s / 64 : 1 + (s - 64) / 63;
}

// The step nearest a size: size() the other way.
export function step(size) {
  const s = size <= 1 ? size * 64 : 64 + (size - 1) * 63;
  return Math.max(0, Math.min(127, Math.round(s)));
}

// ---------------------------------------------------------------- the part inside

// Text as a system exclusive message's bytes may be: each byte over 7F, and each %, as % and its
// two hexadecimal digits.
export function seven(text) {
  const out = [];
  for (const b of new TextEncoder().encode(text)) {
    if (b < 0x80 && b !== 0x25) out.push(b);
    else out.push(0x25, ...new TextEncoder().encode(b.toString(16).toUpperCase().padStart(2, "0")));
  }
  return out;
}

// seven() the other way.
export function eight(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 0x80) throw new Error(`a byte over 7F (${b.toString(16)}) in a system exclusive message`);
    if (b !== 0x25) { out.push(b); continue; }
    const h = String.fromCharCode(...bytes.slice(i + 1, i + 3));
    if (!/^[0-9A-F]{2}$/.test(h)) throw new Error(`"%${h}": a % is followed by two hexadecimal digits`);
    out.push(parseInt(h, 16));
    i += 2;
  }
  return utf8(new Uint8Array(out), "the text of a lipservice message");
}

function utf8(bytes, what) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${what} is not UTF-8 text`);
  }
}

// A lipservice message whole, F0 to F7, as a cable carries it.
export function message(kind, text) {
  return new Uint8Array([0xf0, ...SIGN, kind, ...seven(text), 0xf7]);
}

// What a system exclusive message holds if it is lipservice's: {kind, text}; null of any other.
// `data` is the message after its F0.
export function ours(data) {
  if (data.length < SIGN.length || SIGN.some((b, i) => data[i] !== b)) return null;
  if (data.length < SIGN.length + 2 || data[data.length - 1] !== 0xf7) throw new Error("a lipservice message that is cut short");
  return { kind: data[SIGN.length], text: eight(data.slice(SIGN.length + 1, -1)) };
}

// ---------------------------------------------------------------- write

// A length as a file writes it: seven bits a byte, the last with its top bit clear.
function vlq(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0x0fffffff) throw new Error(`${n}: more than a MIDI file can count to`);
  const out = [n & 0x7f];
  for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift(0x80 | (n & 0x7f));
  return out;
}

const text = (s) => [...new TextEncoder().encode(s)];
const meta = (kind, data) => [0xff, kind, ...vlq(data.length), ...data];

// The bend that is `cents` off a key, in a range of RANGE semitones.
const bend = (cents) => CENTRE + Math.round(cents / (RANGE * 100) * CENTRE);

// A note's syllable as a lyric event's text, or null where it has none.
function sung(lyric) {
  if (lyric === null || lyric === "_") return null;
  const s = P.syllable(lyric);
  return s.text + (s.on ? "-" : "") + (s.end ? "\n" : s.on ? "" : " ");
}

// The wheel's moves for a lane: [tick, step], in order.
function wheel(points) {
  const out = [];
  let standing = null;
  const move = (t, s) => {
    if (s === standing) return;
    out.push([t, s]);
    standing = s;
  };
  if (points.length && points[0].at > 0) move(0, step(P.REST.vibrato));
  points.forEach((q, i) => {
    if (!q.line) return move(q.at, step(q.value));
    const a = points[i - 1];
    for (let t = a.at + 1; t <= q.at; t++) move(t, step(a.value + (q.value - a.value) * (t - a.at) / (q.at - a.at)));
  });
  return out;
}

// The part as a MIDI file's bytes.
export function write(part) {
  const body = P.write(part);
  const events = []; // [tick, order at that tick, bytes]
  const at = (tick, order, bytes) => events.push([tick, order, events.length, bytes]);
  at(0, 0, [0xf0, ...vlq(SIGN.length + 2 + seven(body).length), ...SIGN, KIND.part, ...seven(body), 0xf7]);
  if (part.title) at(0, 1, meta(0x03, text(part.title)));
  if (part.notes.some((n) => n.cents !== 0)) {
    for (const [c, v] of [[101, 0], [100, 0], [6, RANGE], [38, 0], [101, 127], [100, 127]]) at(0, 2, [0xb0, c, v]);
  }
  for (const t of part.tempo) {
    const us = Math.round(60e6 / t.bpm);
    at(t.at, 3, meta(0x51, [us >> 16, (us >> 8) & 0xff, us & 0xff]));
  }
  for (const m of part.meter) at(m.at, 4, meta(0x58, [m.n, Math.log2(m.d), 96 / m.d, 8]));
  const until = new Map(); // each key's last end
  let standing = CENTRE;
  for (const n of part.notes) {
    const k = P.key(n.pitch);
    if (until.has(k) && until.get(k) > n.at) throw new Error(`two ${n.pitch}s sound at once at beat ${P.beat(n.at, part.grid)}: a MIDI file cannot tell them apart`);
    until.set(k, n.at + n.ticks);
    const b = bend(n.cents);
    if (b !== standing) {
      at(n.at, 7, [0xe0, b & 0x7f, b >> 7]);
      standing = b;
    }
    const words = sung(n.lyric);
    if (words !== null) at(n.at, 8, meta(0x05, text(words)));
    at(n.at, 9, [0x90, k, n.velocity]);
    at(n.at + n.ticks, 5, [0x80, k, n.release]);
  }
  for (const [t, s] of wheel(part.lanes.vibrato)) at(t, 6, [0xb0, WHEEL, s]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const track = [];
  let now = 0;
  for (const [t, , , bytes] of events) {
    track.push(...vlq(t - now), ...bytes);
    now = t;
  }
  track.push(0, 0xff, 0x2f, 0);
  const u32 = (n) => [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return new Uint8Array([...text("MThd"), ...u32(6), 0, 0, 0, 1, part.grid >> 8, part.grid & 0xff, ...text("MTrk"), ...u32(track.length), ...track]);
}

// ---------------------------------------------------------------- parse

// Whether these are a MIDI file's bytes.
export const is = (bytes) => bytes.length >= 4 && String.fromCharCode(...bytes.slice(0, 4)) === "MThd";

class Reader {
  constructor(b, from = 0, to = b.length) {
    this.b = b;
    this.at = from;
    this.to = to;
  }

  take(n) {
    if (this.to - this.at < n) throw new Error(`the file ends ${this.to - this.at} bytes into ${n} at byte ${this.at}`);
    this.at += n;
    return this.b.subarray(this.at - n, this.at);
  }

  byte() { return this.take(1)[0]; }

  u16() { const b = this.take(2); return b[0] * 256 + b[1]; }

  u32() { const b = this.take(4); return ((b[0] * 256 + b[1]) * 256 + b[2]) * 256 + b[3]; }

  vlq() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.byte();
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error(`a length of more than four bytes at byte ${this.at - 4}`);
  }
}

// The file's events: {division, tracks: [[{tick, ...}]]}. An event is {meta, data}, {sysex: data
// after the F0} or {status, a, b} (a channel's message).
export function parse(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error("a MIDI file is bytes");
  const r = new Reader(bytes);
  if (!is(bytes) || (r.take(4), r.u32()) !== 6) throw new Error("not a MIDI file: no MThd header of 6 bytes");
  const format = r.u16();
  r.u16();
  const division = r.u16();
  if (format > 1) throw new Error(`a MIDI file of format ${format}: 0 or 1 (one song)`);
  if (division & 0x8000 || division === 0) throw new Error("a MIDI file timed in frames a second: its notes are on no beat");
  const tracks = [];
  while (r.at < bytes.length) {
    const kind = String.fromCharCode(...r.take(4)), len = r.u32();
    const end = r.at + len;
    r.take(len);
    if (kind !== "MTrk") continue;
    const t = new Reader(bytes, end - len, end), events = [];
    let now = 0, running = null;
    while (t.at < end) {
      now += t.vlq();
      const first = t.byte();
      let status = first;
      if (first < 0x80) {
        if (running === null) throw new Error(`a track's event at tick ${now} has no status`);
        t.at -= 1;
        status = running;
      }
      if (status === 0xff) {
        const meta = t.byte(), data = t.take(t.vlq());
        running = null;
        if (meta === 0x2f) break;
        events.push({ tick: now, meta, data });
      } else if (status === 0xf0 || status === 0xf7) {
        const data = t.take(t.vlq());
        running = null;
        events.push(status === 0xf0 ? { tick: now, sysex: data } : { tick: now, escape: data });
      } else if (status > 0xf0) {
        throw new Error(`a track's event ${status.toString(16)} at tick ${now}: not a file's`);
      } else {
        running = status;
        const kind = status & 0xf0, a = t.byte(), b = kind === 0xc0 || kind === 0xd0 ? 0 : t.byte();
        if (a & 0x80 || b & 0x80) throw new Error(`a track's event at tick ${now}: a status where its data should be`);
        events.push({ tick: now, status, a, b });
      }
    }
    tracks.push(events);
  }
  return { division, tracks };
}

const isOn = (e) => e.status !== undefined && (e.status & 0xf0) === 0x90 && e.b > 0;

// Where a file's notes are: [{track, channel (from 1), name, notes, lyrics}], a line for each
// track and channel with notes.
export function survey(bytes) {
  const { tracks } = parse(bytes);
  return sources(tracks).map(([t, c]) => ({
    track: t,
    channel: c + 1,
    name: named(tracks[t]),
    notes: tracks[t].filter((e) => isOn(e) && (e.status & 0x0f) === c).length,
    lyrics: tracks[t].filter((e) => e.meta === 0x05).length,
  }));
}

function named(events) {
  const e = events.find((e) => e.meta === 0x03);
  return e ? utf8(e.data, "a track's name").trim() : "";
}

// Each track and channel with notes; of a file with none, each with any message; of a file with
// none of those, the first track's first channel.
function sources(tracks) {
  const seen = (pred) => {
    const out = [];
    tracks.forEach((events, t) => {
      for (const e of events) {
        if (e.status === undefined || !pred(e)) continue;
        const c = e.status & 0x0f;
        if (!out.some(([a, b]) => a === t && b === c)) out.push([t, c]);
      }
    });
    return out;
  };
  const notes = seen(isOn);
  if (notes.length) return notes;
  const any = seen(() => true);
  return any.length ? any : [[0, 0]];
}

// ---------------------------------------------------------------- the events read

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What a file's events say, as a part's standard events would be written: {division, name,
// tempo: [[tick, microseconds]], meter: [[tick, n, d]], notes: [{at, ticks, key, velocity,
// release, cents}], lyrics: [[tick, text]], wheel: [[tick, step]], bends: [[tick, value]]},
// what a part has no place for (`left`, a line each), and the part inside if there is one.
export function events(bytes, pick = {}) {
  const { division, tracks } = parse(bytes);
  const from = sources(tracks);
  const asked = pick.track !== undefined || pick.channel !== undefined;
  const fits = from.filter(([t, c]) => (pick.track === undefined || pick.track === t) && (pick.channel === undefined || pick.channel === c + 1));
  if (fits.length !== 1) {
    const where = from.map(([t, c]) => `track ${t} channel ${c + 1}`).join(", ");
    throw new Error(asked ? `track ${pick.track ?? "any"}, channel ${pick.channel ?? "any"}: ${fits.length ? "more than one has notes" : "no notes there"}; the file's are on ${where}` : `the file's notes are on ${where}: one singer sings one of them`);
  }
  const [T, C] = fits[0];
  const beat = (tick) => P.beat(tick, division);
  const out = { division, name: tracks[T] ? named(tracks[T]) : "", tempo: [], meter: [], notes: [], lyrics: [], wheel: [], bends: [] };
  const left = new Map(); // what is left, and how many
  const leave = (what) => left.set(what, (left.get(what) ?? 0) + 1);
  let inside = null;
  const silent = tracks.map((events) => !events.some(isOn));
  tracks.forEach((track, t) => {
    const down = new Map(); // key: [tick, velocity]
    const rpn = [127, 127];
    let range = RANGE, foreign = false;
    // the chosen channel's bends: the one standing as a note starts is the last on or before its
    // tick, wherever among that tick's events the file puts it
    const bends = t === T ? track.filter((e) => e.status === (0xe0 | C)).map((e) => [e.tick, e.a | (e.b << 7)]) : [];
    const standing = (tick) => bends.findLast((b) => b[0] <= tick)?.[1] ?? CENTRE;
    for (const e of track) {
      if (e.sysex !== undefined) {
        const m = ours(e.sysex);
        if (!m) leave("system exclusive messages that are not lipservice's");
        else if (m.kind !== KIND.part) throw new Error(`a lipservice message of kind ${m.kind}: this reads a part (${KIND.part})`);
        else if (inside !== null) throw new Error("two lipservice parts inside one file");
        else inside = m.text;
      } else if (e.escape !== undefined) {
        leave("system exclusive messages that are not lipservice's");
      } else if (e.meta !== undefined) {
        if (e.meta === 0x51) {
          if (e.data.length !== 3) throw new Error(`a tempo of ${e.data.length} bytes at beat ${beat(e.tick)}`);
          const us = (e.data[0] << 16) | (e.data[1] << 8) | e.data[2];
          if (us === 0) throw new Error(`a tempo of no time a beat at beat ${beat(e.tick)}`);
          out.tempo.push([e.tick, us]);
        } else if (e.meta === 0x58) {
          if (e.data.length !== 4) throw new Error(`a time signature of ${e.data.length} bytes at beat ${beat(e.tick)}`);
          if (e.data[0] < 1 || e.data[1] > 5) throw new Error(`a meter of ${e.data[0]} notes of a ${2 ** e.data[1]}th at beat ${beat(e.tick)}: 1 to 255 notes of a 1st to a 32nd`);
          out.meter.push([e.tick, e.data[0], 2 ** e.data[1]]);
        } else if (e.meta === 0x05) {
          if (t === T || silent[t]) out.lyrics.push([e.tick, utf8(e.data, `the lyric at beat ${beat(e.tick)}`)]);
          else leave("lyrics of other tracks");
        } else if (e.meta === 0x03) {
          if (t !== T || e !== track.find((x) => x.meta === 0x03)) leave("other tracks' names");
        } else {
          leave({ 0x01: "texts", 0x02: "copyright notices", 0x04: "instrument names", 0x06: "markers", 0x07: "cue points", 0x54: "SMPTE offsets", 0x59: "key signatures", 0x7f: "sequencer's own events" }[e.meta] ?? "other meta events");
        }
      } else {
        const kind = e.status & 0xf0, mine = t === T && (e.status & 0x0f) === C;
        if (!mine) {
          if (isOn(e)) leave("notes of other tracks and channels");
          else if (kind !== 0x80 && kind !== 0x90) foreign = true;
          continue;
        }
        if (kind === 0x80 || kind === 0x90) {
          const on = kind === 0x90 && e.b > 0;
          if (down.has(e.a)) {
            const [at, velocity, cents] = down.get(e.a);
            if (e.tick === at) throw new Error(`the note ${P.name(e.a)} at beat ${beat(at)} has no length`);
            out.notes.push({ at, ticks: e.tick - at, key: e.a, velocity, release: on ? 64 : kind === 0x80 ? e.b : 64, cents });
            down.delete(e.a);
          } else if (!on) {
            leave("note offs with no note down");
          }
          if (on) {
            const cents = (standing(e.tick) - CENTRE) / CENTRE * range * 100;
            if (!(Math.abs(cents) < 100)) throw new Error(`the note ${P.name(e.a)} at beat ${beat(e.tick)} is bent ${cents} cents: a part's note is under 100 from its key`);
            down.set(e.a, [e.tick, e.b, cents]);
          }
        } else if (kind === 0xb0 && e.a === WHEEL) {
          out.wheel.push([e.tick, e.b]);
        } else if (kind === 0xb0 && (e.a === 101 || e.a === 100)) {
          rpn[e.a === 101 ? 0 : 1] = e.b;
        } else if (kind === 0xb0 && (e.a === 6 || e.a === 38) && rpn[0] === 0 && rpn[1] === 0) {
          range = e.a === 6 ? e.b + (range % 1) : Math.floor(range) + e.b / 100;
        } else if (kind === 0xe0) {
          out.bends.push([e.tick, e.a | (e.b << 7)]);
          if ([...down.values()].some(([at]) => at < e.tick)) leave("bends inside a note");
        } else {
          leave(kind === 0xb0 ? `moves of controller ${e.a}` : { 0xa0: "key pressures", 0xc0: "program changes", 0xd0: "channel pressures" }[kind]);
        }
      }
    }
    if (foreign) leave("other tracks' and channels' controllers and programs");
    if (down.size) {
      const [k, [at]] = [...down.entries()][0];
      throw new Error(`the note ${P.name(k)} at beat ${beat(at)} is never let go`);
    }
  });
  const order = (xs) => xs.map((x, i) => [x, i]).sort(([a, i], [b, j]) => a[0] - b[0] || i - j).map(([x]) => x);
  out.tempo = order(out.tempo);
  out.meter = order(out.meter);
  out.lyrics = order(out.lyrics);
  out.notes.sort((a, b) => a.at - b.at || a.key - b.key);
  return { read: out, left: [...left].map(([what, n]) => `${n} ${what}`), inside };
}

// Whether two readings say the same, beat for beat, whatever each one's division.
function same(a, b) {
  const t = (x, y) => x * b.division === y * a.division;
  const each = (xs, ys, eq) => xs.length === ys.length && xs.every((x, i) => eq(x, ys[i]));
  const rows = (xs, ys) => each(xs, ys, (x, y) => t(x[0], y[0]) && x.slice(1).every((v, i) => v === y[i + 1]));
  return a.name === b.name && rows(a.tempo, b.tempo) && rows(a.meter, b.meter) && rows(a.lyrics, b.lyrics) && rows(a.wheel, b.wheel) && rows(a.bends, b.bends)
    && each(a.notes, b.notes, (x, y) => t(x.at, y.at) && t(x.ticks, y.ticks) && x.key === y.key && x.velocity === y.velocity && x.release === y.release);
}

// ---------------------------------------------------------------- a part from the events

// The beats a minute that are `us` microseconds a beat: the shortest number that is.
function bpm(us) {
  for (let d = 0; d <= 9; d++) {
    const s = (60e6 / us).toFixed(d);
    if (Math.round(60e6 / Number(s)) === us) return Number(s);
  }
  throw new Error(`no tempo is ${us} microseconds a beat`);
}

// Rows on ticks as a part's points: the last of each tick, and the standing one where none is on
// tick 0.
function points(rows, standing) {
  const out = [];
  for (const r of rows) {
    if (out.length && out[out.length - 1][0] === r[0]) out[out.length - 1] = r;
    else out.push(r);
  }
  if (!out.length || out[0][0] !== 0) out.unshift([0, ...standing]);
  return out;
}

// The lyrics under the notes, as a part writes them.
function under(read, beat) {
  const at = new Map();
  for (const [tick, s] of read.lyrics) at.set(tick, (at.get(tick) ?? "") + s);
  const out = new Map(); // a note: its lyric
  let begun = false, open = null; // the last syllable, where its word may go on
  read.notes.forEach((n, i) => {
    if (i > 0 && read.notes[i - 1].at === n.at) return out.set(n, null);
    const raw = at.get(n.at);
    at.delete(n.at);
    if (raw !== undefined && open && /^\s/.test(raw)) open = null;
    const s = raw === undefined ? "" : raw.trim();
    if (!s) return out.set(n, begun ? "_" : null);
    const on = s.length > 1 && s.endsWith("-"), core = on ? s.slice(0, -1) : s;
    if (/[\s_/]/.test(core) || core.endsWith("-")) throw new Error(`the lyric "${s}" at beat ${beat(n.at)}: a note's is one syllable, with no space, _ or / in it`);
    if (open) open.on = true;
    const syl = { core, on, end: /[\n\r]/.test(raw) };
    open = on || /\s$/.test(raw) ? null : syl;
    begun = true;
    out.set(n, syl);
  });
  if (at.size) {
    const [tick, s] = [...at.entries()][0];
    throw new Error(`the lyric "${s.trim()}" at beat ${beat(tick)} is under no note's start`);
  }
  return (n) => {
    const s = out.get(n);
    return s === null || s === "_" ? s : s.core + (s.on ? "-" : "") + (s.end ? "/" : "");
  };
}

function build(read, singer) {
  const beat = (tick) => P.beat(tick, read.division);
  const lyric = under(read, beat);
  const wheel = [];
  for (const [tick, s] of read.wheel) {
    if (wheel.length && wheel[wheel.length - 1].at === tick) wheel.pop();
    const standing = wheel.length ? wheel[wheel.length - 1].value : P.REST.vibrato;
    if (size(s) !== standing) wheel.push({ at: tick, value: size(s), line: false });
  }
  const part = {
    title: read.name,
    grid: read.division,
    singer: { ...singer },
    tempo: points(read.tempo, [500000]).map(([at, us]) => ({ at, bpm: bpm(us) })),
    meter: points(read.meter, [4, 4]).map(([at, n, d]) => ({ at, n, d })),
    notes: read.notes.map((n) => ({ at: n.at, ticks: n.ticks, pitch: P.name(n.key), cents: n.cents, velocity: n.velocity, release: n.release, lyric: lyric(n) })),
    lanes: { vibrato: wheel },
    marks: [],
  };
  P.check(part);
  return part;
}

// ---------------------------------------------------------------- read

// A MIDI file as a part: {part, how, said}.
//   how: "inside" (the file is as lipservice wrote it: the part inside, nothing lost), "changed"
//     (it has a part inside and its events no longer say what that part would: the events, and
//     the singer inside), "events" (no part inside: the events, and the singer given).
//   said: what was taken and what was left, a line each.
//   singer: the singer of a file with no part inside (part.js singer()).
//   track, channel: whose notes, where the file has more than one's (survey()).
export function read(bytes, { singer, track, channel } = {}) {
  const { read: seen, left, inside } = events(bytes, { track, channel });
  const count = (p) => `${plural(p.notes.length, "note")}, ${plural(p.notes.filter((n) => n.lyric !== null && n.lyric !== "_").length, "syllable")}, ${plural(p.lanes.vibrato.length, "point")} of vibrato`;
  const rest = left.map((l) => `left: ${l}`);
  if (inside !== null) {
    let kept;
    try {
      kept = P.read(inside);
    } catch (e) {
      throw new Error(`the part inside: ${e.message}`);
    }
    if (same(seen, events(write(kept), {}).read)) return { part: kept, how: "inside", said: [`the part inside, as lipservice wrote it: ${count(kept)}`, ...rest] };
    if (!seen.notes.length) throw new Error("a MIDI file changed since lipservice wrote it, with no notes");
    const part = build(seen, kept.singer);
    const lost = [
      kept.marks.length && plural(kept.marks.length, "mark"),
      kept.lanes.vibrato.some((q) => q.line) && "the vibrato's lines",
    ].filter(Boolean);
    return {
      part,
      how: "changed",
      said: [`changed since lipservice wrote it: the file's events (${count(part)}) and the singer of the part inside`, ...(lost.length ? [`not kept of the part inside: ${lost.join(", ")}`] : []), ...rest],
    };
  }
  if (!seen.notes.length) throw new Error("a MIDI file with no notes");
  if (!singer) throw new Error("a MIDI file with no lipservice part inside: it needs a singer");
  const part = build(seen, singer);
  return { part, how: "events", said: [`the file's events: ${count(part)}`, ...rest] };
}
