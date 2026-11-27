// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// Notes in from a MIDI keyboard (Web MIDI) and from the computer's keys, as plain events, and the
// two ways they are written: a step at a time at the cursor (Steps), or as played while the score
// sounds (Take). No DOM: open() is given the browser's navigator, and node tests it with stand-ins.
//
// An event:
//   {type: "on", key, velocity, channel, time}     a key down, velocity 1 to 127
//   {type: "off", key, release, channel, time}     a key up, release 0 to 127
//   {type: "wheel", value, channel, time}          the mod wheel (controller 1), 0 to 127
//   {type: "sustain", down, channel, time}         the sustain pedal (controller 64)
//   {type: "bend", value, channel, time}           the pitch bend, 0 to 16383, 8192 none
//   {type: "other", data, time}                    any other message, its bytes
// and from the computer's keys (Keys) also: rest, back, shorter, longer, octave, leave.
// `time` is the browser's clock (performance.now()) when the key went. A channel is 1 to 16;
// every channel is taken.

import * as P from "./part.js";
import { WHEEL, size } from "./midi.js";

export const SUSTAIN = 64;
const CENTRE = 8192;
// the bend's range where nothing says: semitones either way, as midi.js reads a file
export const RANGE = 2;

const whole = (v) => Number.isInteger(v) && v >= 0;
// a lane's value worked out, to six places, as the text can write it
const six = (v) => Math.round(v * 1e6) / 1e6;
const hex = (d) => d.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

// ---------------------------------------------------------------- messages

// A MIDI message's bytes as an event.
export function parse(data, time) {
  const d = [...data];
  if (!d.length) throw new Error("a MIDI message with no bytes");
  if (!Number.isFinite(time)) throw new Error(`a MIDI message ${hex(d)} with no time`);
  const s = d[0], kind = s & 0xf0, channel = (s & 0x0f) + 1;
  if (s < 0x80) throw new Error(`a MIDI message ${hex(d)}: no status byte first`);
  const takes = (n) => {
    if (d.length < n || d.slice(1, n).some((b) => b > 127)) throw new Error(`a MIDI message ${hex(d)}: ${n - 1} data bytes under 80 after its status`);
  };
  if (kind === 0x80 || kind === 0x90) {
    takes(3);
    // a note on of no force is a note off with a release of 64, as MIDI says
    return kind === 0x90 && d[2] > 0
      ? { type: "on", key: d[1], velocity: d[2], channel, time }
      : { type: "off", key: d[1], release: kind === 0x80 ? d[2] : 64, channel, time };
  }
  if (kind === 0xb0) {
    takes(3);
    if (d[1] === WHEEL) return { type: "wheel", value: d[2], channel, time };
    if (d[1] === SUSTAIN) return { type: "sustain", down: d[2] >= 64, channel, time };
  }
  if (kind === 0xe0) {
    takes(3);
    return { type: "bend", value: d[1] | (d[2] << 7), channel, time };
  }
  return { type: "other", data: d, time };
}

// A key under a bend standing, as a part's note has it: [key, cents]. Past 99 cents the key moves
// and the rest stays in cents.
export function bent(key, bend, range = RANGE) {
  const c = Math.round((bend - CENTRE) / CENTRE * range * 100 * 1e4) / 1e4;
  const moved = Math.trunc(c / 100), k = key + moved, cents = Math.round((c - moved * 100) * 1e4) / 1e4 || 0;
  if (k < 0 || k > 127) throw new Error(`${P.name(key)} bent ${c} cents is outside MIDI's keys, C-1 to G9`);
  return [k, cents];
}

// ---------------------------------------------------------------- Web MIDI

const NONE = "this browser has no Web MIDI here (Safari has none; the others give it only to https and the computer's own addresses): no MIDI keyboard can play into the editor";

// MIDI in: the browser's access to its MIDI inputs, asked for with no system exclusive. Each event
// of the input chosen goes to `event(e, id)`; `change({inputs, lost, back})` is told as inputs come
// and go (`lost`, the chosen one's name where it went; `back`, where it came back and is taken
// again); `fail(error)` is given what went wrong with a message or in `event`. Throws where the
// browser has no Web MIDI, or the person or the browser refused it.
export async function open(nav, { event, change, fail } = {}) {
  for (const [n, f] of Object.entries({ event, change, fail })) if (typeof f !== "function") throw new Error(`open() takes ${n}, a function`);
  if (typeof nav?.requestMIDIAccess !== "function") throw new Error(NONE);
  let access;
  try {
    access = await nav.requestMIDIAccess({ sysex: false, software: false });
  } catch (e) {
    const no = e?.name === "NotAllowedError" || e?.name === "SecurityError";
    throw new Error(no ? `MIDI in was refused: the browser's permission for MIDI on this site is off (${e.name}: ${e.message})` : `MIDI in could not be opened: ${e?.name ?? "Error"}: ${e?.message ?? e}`, { cause: e });
  }
  return new Midi(access, { event, change, fail });
}

const label = (port) => port.name || `the input ${port.id}`;

export class Midi {
  #access; #say;
  #port = null; // the input chosen, from the moment it is asked to open
  #wanted = null; // the id chosen, kept while its input is away, to be taken again when it is back

  constructor(access, say) {
    this.#access = access;
    this.#say = say;
    access.onstatechange = (e) => this.#changed(e.port);
  }

  // [{id, name, maker, on (connected)}], in the browser's order
  inputs() {
    return [...this.#access.inputs.values()].map((p) => ({ id: p.id, name: label(p), maker: p.manufacturer || "", on: p.state === "connected" }));
  }

  get chosen() { return this.#port?.id ?? null; }

  // The input `id` is the one played from; null for none.
  async choose(id) {
    await this.#drop();
    this.#wanted = null;
    if (id === null) return;
    const port = this.#access.inputs.get(id);
    if (!port) throw new Error(`no MIDI input ${id}: the inputs are ${this.inputs().map((p) => p.name).join(", ") || "none"}`);
    this.#wanted = id;
    await this.#attach(port);
  }

  async close() {
    this.#wanted = null;
    await this.#drop();
    this.#access.onstatechange = null;
  }

  async #attach(port) {
    this.#port = port;
    try {
      await port.open();
    } catch (e) {
      if (this.#port === port) this.#port = null;
      throw new Error(`the MIDI input ${label(port)} could not be opened: ${e?.name ?? "Error"}: ${e?.message ?? e}`, { cause: e });
    }
    port.onmidimessage = (m) => {
      try {
        this.#say.event(parse(m.data, m.timeStamp), port.id);
      } catch (e) {
        this.#say.fail(new Error(`${label(port)}: ${e.message}`, { cause: e }));
      }
    };
  }

  async #drop() {
    const p = this.#port;
    if (!p) return;
    this.#port = null;
    p.onmidimessage = null;
    await p.close();
  }

  #changed(port) {
    if (port.type !== "input") return; // outputs are not played from
    let lost = null, back = null;
    if (this.#port?.id === port.id && port.state === "disconnected") {
      this.#port.onmidimessage = null;
      this.#port = null;
      lost = label(port);
    } else if (!this.#port && this.#wanted === port.id && port.state === "connected") {
      back = label(port);
      this.#attach(port).catch((e) => this.#say.fail(e));
    }
    this.#say.change({ inputs: this.inputs(), lost, back });
  }
}

// ---------------------------------------------------------------- the computer's keys

// The keys that play, by where they are on the keyboard (e.code), not the letter they make, so
// that another layout does not move them: A W S E D F T G Y H U J K, C up to the next C.
export const PIANO = ["KeyA", "KeyW", "KeyS", "KeyE", "KeyD", "KeyF", "KeyT", "KeyG", "KeyY", "KeyH", "KeyU", "KeyJ", "KeyK"];
// and the rest of step input's
export const ACTIONS = { KeyZ: "lower", KeyX: "higher", ArrowRight: "rest", Backspace: "back", BracketLeft: "shorter", BracketRight: "longer", Escape: "leave" };
const AGAIN = new Set(["rest", "back", "shorter", "longer"]); // a key held down does these again
const LOWEST = -1, HIGHEST = 8; // octaves A may be C of, the top K staying a key

// The computer's keys as a keyboard: down() and up() give a key's events, or null for a key that
// is not one of these (the page does with it as it would). A key held with Cmd, Ctrl, Alt or
// Shift is not one of these: shift K, which turns them off, is the page's.
export class Keys {
  constructor({ octave = 4 } = {}) {
    if (!Number.isInteger(octave) || octave < LOWEST || octave > HIGHEST) throw new Error(`octave ${octave}: ${LOWEST} to ${HIGHEST}`);
    this.octave = octave; // A is C of this octave: 4 is middle C
    this.held = new Map(); // code: the key it went down as
  }

  // the key A plays, by name
  get low() { return P.name(12 * (this.octave + 1)); }

  #ours(e) { return !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) && (PIANO.includes(e.code) || e.code in ACTIONS); }

  down(e, velocity) {
    if (!this.#ours(e)) return null;
    const time = e.timeStamp, i = PIANO.indexOf(e.code);
    if (i >= 0) {
      if (e.repeat || this.held.has(e.code)) return [];
      if (!whole(velocity) || velocity < 1 || velocity > 127) throw new Error(`velocity ${velocity}: 1 to 127`);
      const key = 12 * (this.octave + 1) + i;
      this.held.set(e.code, key);
      return [{ type: "on", key, velocity, channel: 1, time }];
    }
    const act = ACTIONS[e.code];
    if (e.repeat && !AGAIN.has(act)) return [];
    if (act === "lower" || act === "higher") {
      const to = this.octave + (act === "lower" ? -1 : 1);
      if (to < LOWEST) throw new Error("the keys are as low as they go: A is C-1");
      if (to > HIGHEST) throw new Error("the keys are as high as they go: A is C8");
      this.octave = to;
      return [{ type: "octave", octave: to, low: this.low, time }];
    }
    return [{ type: act, time }];
  }

  up(e) {
    if (this.held.has(e.code)) {
      const key = this.held.get(e.code);
      this.held.delete(e.code);
      return [{ type: "off", key, release: 64, channel: 1, time: e.timeStamp }];
    }
    return this.#ours(e) ? [] : null;
  }

  // every key held let go, as when the page loses the keys (the window left)
  lift(time) {
    const out = [...this.held.values()].map((key) => ({ type: "off", key, release: 64, channel: 1, time }));
    this.held.clear();
    return out;
  }
}

// ---------------------------------------------------------------- step input

// Notes a step at a time from the cursor: each key down adds a note of the step's length there, a
// chord's keys to the one step, and the cursor goes on a step once every key and the pedal are up.
// A rest goes on with no note, or with keys held, lengthens the step they are in by a step (a tie).
// back takes the last step back. Where words are given, each step's notes take the next syllable.
// take() gives an edit for apply(), or null where the event changes nothing:
//   {op: "step", at, ticks, notes, first, open, cursor}   the step as it stands, as part notes
//   {op: "rest", at, ticks, cursor}
//   {op: "back", at, ticks, keys, cursor}                  the keys of the step taken back
//   {op: "length", ticks}                                  the step's length from now
// `cursor` is where the cursor is after it.
export class Steps {
  constructor({ at = 0, ticks, range = RANGE } = {}) {
    if (!whole(at)) throw new Error(`a step at tick ${at}: a whole number of ticks from 0`);
    this.at = at;
    this.length(ticks);
    this.range = range;
    this.syllables = []; // the words' syllables, as edit.js syllables() gives them
    this.next = 0; // the one the next step takes
    this.bend = CENTRE;
    this.pedal = false;
    this.down = new Set(); // the keys held, as played
    this.open = null; // the step being played: {at, ticks, notes (Map of the key played: its note), lyric}
    this.done = []; // the steps written, the last last: {at, ticks, keys, worded}
  }

  length(ticks) {
    if (!whole(ticks) || ticks < 1) throw new Error(`a step of ${ticks} ticks: a whole number, 1 at least`);
    this.ticks = ticks;
  }

  // The syllables the steps take from `next` on.
  words(syllables, next = 0) {
    if (!Array.isArray(syllables) || syllables.some((s) => !P.lyrical(s))) throw new Error("the words: syllables as edit.js syllables() gives them");
    if (!whole(next) || next > syllables.length) throw new Error(`syllable ${next} of ${syllables.length}`);
    this.syllables = syllables;
    this.next = next;
  }

  // The cursor put at `at` by the page. The steps before it are not taken back from there.
  place(at) {
    if (!whole(at)) throw new Error(`a step at tick ${at}: a whole number of ticks from 0`);
    if (this.open) throw new Error("let go of the keys and the pedal before the cursor moves");
    if (at !== this.at) this.done = [];
    this.at = at;
  }

  // The steps before are not taken back: after an undo, say, which took them back already.
  forget() { this.done = []; }

  take(e) {
    switch (e.type) {
      case "on": {
        if (!whole(e.velocity) || e.velocity < 1 || e.velocity > 127) throw new Error(`velocity ${e.velocity}: 1 to 127`);
        const [key, cents] = bent(e.key, this.bend, this.range);
        if (!this.open) {
          const lyric = this.next < this.syllables.length ? this.syllables[this.next] : null;
          this.open = { at: this.at, ticks: this.ticks, notes: new Map(), lyric, first: true };
        }
        this.down.add(e.key);
        this.open.notes.set(e.key, { key, cents, velocity: e.velocity, release: 64 });
        return this.#edit();
      }
      case "off": {
        if (!this.down.has(e.key)) return null; // went down before step input began
        this.down.delete(e.key);
        this.open.notes.get(e.key).release = e.release;
        return this.down.size || this.pedal ? this.#edit() : this.#close();
      }
      case "sustain":
        this.pedal = e.down;
        return !e.down && this.open && !this.down.size ? this.#close() : null;
      case "bend":
        this.bend = e.value;
        return null;
      case "rest": {
        if (this.open) {
          this.open.ticks += this.ticks;
          return this.#edit();
        }
        const at = this.at;
        this.done.push({ at, ticks: this.ticks, keys: [], worded: false });
        this.at += this.ticks;
        return { op: "rest", at, ticks: this.ticks, cursor: this.at };
      }
      case "back": {
        if (this.open) throw new Error("let go of the keys and the pedal before taking a step back");
        const s = this.done.pop();
        if (!s) throw new Error("no step to take back");
        this.at = s.at;
        if (s.worded) this.next--;
        return { op: "back", at: s.at, ticks: s.ticks, keys: s.keys, cursor: s.at };
      }
      case "shorter":
        if (this.ticks % 2) throw new Error(`a step of ${this.ticks} ${this.ticks === 1 ? "tick" : "ticks"} cannot be halved`);
        this.length(this.ticks / 2);
        return { op: "length", ticks: this.ticks };
      case "longer":
        this.length(this.ticks * 2);
        return { op: "length", ticks: this.ticks };
      case "wheel":
      case "other":
        return null; // step input writes no lane
    }
    throw new Error(`step input takes no ${e.type}`);
  }

  // Every key and the pedal let go, as where the keys or the input went away: the step closed.
  lift() {
    this.down.clear();
    this.pedal = false;
    return this.open ? this.#close() : null;
  }

  #edit(open = true) {
    const s = this.open, first = s.first;
    s.first = false;
    const notes = [...s.notes.values()].map((n) => ({ at: s.at, ticks: s.ticks, pitch: P.name(n.key), cents: n.cents, velocity: n.velocity, release: n.release, lyric: s.lyric }));
    return { op: "step", at: s.at, ticks: s.ticks, notes: P.sort(notes), first, open, cursor: open ? s.at : s.at + s.ticks };
  }

  #close() {
    const edit = this.#edit(false), s = this.open;
    this.open = null;
    this.done.push({ at: s.at, ticks: s.ticks, keys: edit.notes.map((n) => P.key(n.pitch)), worded: s.lyric !== null });
    if (s.lyric !== null) this.next++;
    this.at = s.at + s.ticks;
    return edit;
  }
}

// A step input's edit made on an edit.js Editor. A step is one change to undo however many keys
// it took: an Editor drag from its first key to its last.
export function apply(ed, edit) {
  switch (edit.op) {
    case "step": {
      if (edit.first) ed.begin();
      else if (!ed.drag) throw new Error(`the step at beat ${P.beat(edit.at, ed.part.grid)} was begun elsewhere`);
      else ed.again();
      try {
        const notes = edit.notes.map((n) => ({ ...n }));
        ed.commit({ ...ed.part, notes: P.sort([...ed.part.notes, ...notes]) }, new Set(notes));
      } catch (e) {
        ed.again();
        ed.end();
        throw e;
      }
      if (!edit.open) ed.end();
      return;
    }
    case "back": {
      if (!edit.keys.length) return;
      const gone = edit.keys.map((k) => {
        const n = ed.part.notes.find((x) => x.at === edit.at && P.key(x.pitch) === k);
        if (!n) throw new Error(`the step at beat ${P.beat(edit.at, ed.part.grid)} is not as it was written: no ${P.name(k)} there`);
        return n;
      });
      ed.commit({ ...ed.part, notes: ed.part.notes.filter((n) => !gone.includes(n)) }, new Set());
      return;
    }
    case "rest":
    case "length":
      return;
  }
  throw new Error(`no step input edit ${edit.op}`);
}

// ---------------------------------------------------------------- a take

// What is played while the score sounds, written where it was heard. `tick(time)` is the caller's
// clock: the part's tick (a fraction where it falls between) heard at the browser's `time`. The
// take begins at tick `from`: a note let go before it is left out (and counted), one held across
// it starts there, and the wheel moved before it is where the take's vibrato starts. The pedal
// holds a note let go until the pedal is up or the key is struck again. The bend standing at a
// note's start is its cents.
export class Take {
  constructor({ tick, from = 0, range = RANGE } = {}) {
    if (typeof tick !== "function") throw new Error("a take is given its clock: tick(time)");
    if (!whole(from)) throw new Error(`a take from tick ${from}: a whole number of ticks from 0`);
    Object.assign(this, { tick, from, range });
    this.bend = CENTRE;
    this.pedal = false;
    this.down = new Map(); // the key played: {at, key, cents, velocity, release, up (let go under the pedal)}
    this.played = []; // the notes ended: {at, end, key, cents, velocity, release}, ticks as heard
    this.wheel = []; // [{at, value}], value a size of vibrato, at a whole tick
    this.until = null; // the tick it was finished at
  }

  #at(time) {
    const t = this.tick(time);
    if (!Number.isFinite(t)) throw new Error(`the clock gave ${t} for the time ${time}`);
    return t;
  }

  #end(played, n, t, release) {
    this.down.delete(played);
    this.played.push({ at: n.at, end: Math.max(t, n.at), key: n.key, cents: n.cents, velocity: n.velocity, release });
  }

  take(e) {
    if (this.until !== null) throw new Error("the take is finished");
    switch (e.type) {
      case "on": {
        const t = this.#at(e.time);
        if (!whole(e.velocity) || e.velocity < 1 || e.velocity > 127) throw new Error(`velocity ${e.velocity}: 1 to 127`);
        const was = this.down.get(e.key);
        if (was) this.#end(e.key, was, t, was.up ? was.release : 64);
        const [key, cents] = bent(e.key, this.bend, this.range);
        this.down.set(e.key, { at: t, key, cents, velocity: e.velocity, release: 64, up: false });
        return null;
      }
      case "off": {
        const n = this.down.get(e.key);
        if (!n) return null; // went down before the take began
        if (this.pedal) Object.assign(n, { up: true, release: e.release });
        else this.#end(e.key, n, this.#at(e.time), e.release);
        return null;
      }
      case "sustain": {
        this.pedal = e.down;
        if (!e.down) {
          const t = this.#at(e.time);
          for (const [k, n] of [...this.down]) if (n.up) this.#end(k, n, t, n.release);
        }
        return null;
      }
      case "bend":
        this.bend = e.value;
        return null;
      case "wheel": {
        const at = Math.max(this.from, Math.round(this.#at(e.time)));
        if (this.wheel.length && this.wheel[this.wheel.length - 1].at === at) this.wheel.pop();
        this.wheel.push({ at, value: size(e.value) });
        return null;
      }
      case "other":
        return null;
    }
    throw new Error(`a take takes no ${e.type}`);
  }

  // Every key still down let go at `time`, and the take ended there.
  finish(time) {
    if (this.until !== null) throw new Error("the take is finished");
    const t = this.#at(time);
    for (const [k, n] of [...this.down]) this.#end(k, n, t, n.up ? n.release : 64);
    this.pedal = false;
    const ends = [t, ...this.played.map((n) => n.end), ...this.wheel.map((q) => q.at + 1)];
    this.until = Math.max(this.from, Math.ceil(Math.max(...ends)));
    return this;
  }

  // What to draw as it comes: [{at, ticks, key, cents, velocity, held}] in ticks as heard, a note
  // still down drawn to `time`.
  notes(time) {
    const t = this.until ?? this.#at(time);
    return [
      ...this.played.map((n) => ({ at: n.at, ticks: n.end - n.at, key: n.key, cents: n.cents, velocity: n.velocity, held: false })),
      ...[...this.down.values()].map((n) => ({ at: n.at, ticks: Math.max(0, t - n.at), key: n.key, cents: n.cents, velocity: n.velocity, held: true })),
    ];
  }

  // `part` with the take in it, as one change: {part, notes (how many went in), early (how many
  // were let go before the take began)}. Starts and ends go to the nearest `step` (ticks), a note
  // a step long at least; with no step, to the nearest tick. With `replace`, the part's notes that
  // start inside the take are taken out first. With `wheel`, where the wheel moved, the vibrato
  // lane from its first move to the take's end is what it played, and after that it is as it was.
  merge(part, { step = 0, wheel = true, replace = true } = {}) {
    if (this.until === null) throw new Error("the take is still being played: finish it first");
    if (!whole(step)) throw new Error(`a step of ${step} ticks: a whole number`);
    const near = (t) => (step ? Math.max(0, Math.round(t / step) * step) : Math.round(t));
    let early = 0;
    const notes = [];
    for (const n of this.played) {
      if (n.end <= this.from) { early++; continue; }
      const at = near(Math.max(n.at, this.from)), end = near(n.end);
      notes.push({ at, ticks: Math.max(step || 1, end - at), pitch: P.name(n.key), cents: n.cents, velocity: n.velocity, release: n.release, lyric: null });
    }
    const kept = replace ? part.notes.filter((n) => n.at < this.from || n.at >= this.until) : part.notes;
    const next = { ...part, notes: P.sort([...kept, ...notes]) };
    if (wheel && this.wheel.length) next.lanes = { ...part.lanes, vibrato: this.#lane(part) };
    P.check(next);
    return { part: next, notes: notes.length, early };
  }

  // the vibrato lane with the take's wheel in it
  #lane(part) {
    const old = part.lanes.vibrato, until = this.until;
    const pts = [];
    for (const q of this.wheel) if (!pts.length || pts[pts.length - 1].value !== q.value) pts.push({ at: q.at, value: q.value, line: false });
    if (part.singer.motion === null) {
      const z = pts.find((q) => q.value === 0);
      if (z) throw new Error(`the wheel is down to 0 at beat ${P.beat(z.at, part.grid)} and the singer's motion is -: a drawn vibrato of 0 is a held tone that does not move. Keep the take without the wheel, or give the singer a motion`);
    }
    const t0 = pts[0].at, head = old.filter((q) => q.at < t0), cut = old.find((q) => q.at >= t0);
    // a line going on into the take still runs as it did up to the take's first point
    if (cut?.line) {
      const a = head[head.length - 1];
      head.push({ at: t0, value: six(a.value + (cut.value - a.value) * (t0 - a.at) / (cut.at - a.at)), line: true });
    }
    let rest = old.filter((q) => q.at >= until);
    const there = six(P.at(old, until, P.REST.vibrato));
    if (rest[0]?.at === until && rest[0].line) {
      // the line's stretch before `until` is the take's now; its point stays as a value there
      rest = rest[1]?.at === until ? rest.slice(1) : [{ ...rest[0], line: false }, ...rest.slice(1)];
    } else if (rest[0]?.at !== until) {
      // the lane as it was from `until` on: a line going on through it goes on from there
      if (pts[pts.length - 1].value !== there || rest[0]?.line) rest = [{ at: until, value: there, line: false }, ...rest];
    }
    return [...head, ...pts, ...rest];
  }
}
