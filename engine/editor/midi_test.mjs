// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// midi.js: a part through a MIDI file and back with nothing lost, a file from elsewhere read by
// its events, a file changed elsewhere told from one that was not, and what is no song refused.
// node midi_test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as S from "./score.js";
import * as P from "./part.js";
import * as M from "./midi.js";
import { EXAMPLES, BORROWED } from "./examples/make.mjs";
import { MENU } from "./examples/menu.js";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const SINGER = P.singer("6147", 3);

// ------------------------------------------------------------------ a file by hand

const text = (s) => [...new TextEncoder().encode(s)];
function vlq(n) {
  const out = [n & 0x7f];
  for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift(0x80 | (n & 0x7f));
  return out;
}
const chunk = (kind, body) => [...text(kind), body.length >>> 24, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body];
// A file of `tracks`, each its events: [ticks since the one before, the event's bytes].
function file(format, division, tracks) {
  const out = chunk("MThd", [0, format, 0, tracks.length, division >> 8, division & 255]);
  for (const t of tracks) out.push(...chunk("MTrk", [...t.flatMap(([delta, e]) => [...vlq(delta), ...e]), 0, 0xff, 0x2f, 0]));
  return new Uint8Array(out);
}
const meta = (kind, data) => [0xff, kind, ...vlq(data.length), ...data];
const lyric = (s) => meta(0x05, text(s));
const read = (bytes, pick = {}) => M.read(bytes, { singer: SINGER, ...pick });
// a file's events as file() takes them, each track's ticks times `k`, with running status
function again(bytes, k) {
  const { division, tracks } = M.parse(bytes);
  return file(tracks.length > 1 ? 1 : 0, division * k, tracks.map((events) => {
    let now = 0, running = null;
    return events.map((e) => {
      const delta = (e.tick - now) * k;
      now = e.tick;
      if (e.meta !== undefined) { running = null; return [delta, meta(e.meta, [...e.data])]; }
      if (e.sysex !== undefined) { running = null; return [delta, [0xf0, ...vlq(e.sysex.length), ...e.sysex]]; }
      const two = (e.status & 0xf0) === 0xc0 || (e.status & 0xf0) === 0xd0;
      const data = two ? [e.a] : [e.a, e.b];
      const out = running === e.status ? data : [e.status, ...data];
      running = e.status;
      return [delta, out];
    });
  }));
}

// ------------------------------------------------------------------ the wheel and the text inside

check(equal([0, 32, 64, 127, 200].map(M.size), [0, 0.5, 1, 2, 2]), "the wheel's steps as sizes");
check([...Array(128).keys()].every((s) => M.step(M.size(s)) === s), "every step is the step of its size");
check(equal([-1, 0.26, 9, 1.5].map(M.step), [0, 17, 127, 96]), "sizes as steps");
{
  const s = "lipservice part 2\ntitle étude 100% \u{1f3b5} %41\n";
  const m = M.message(M.KIND.part, s);
  check(m[0] === 0xf0 && m[m.length - 1] === 0xf7 && [...m.slice(1, -1)].every((b) => b < 0x80), "a message is seven bits a byte between its F0 and F7");
  check(new TextDecoder().decode(m.slice(1, 12)) === "}lipservice", "it starts 7D lipservice");
  check(equal(M.ours(m.slice(1)), { kind: 1, text: s }), "and reads back");
  check(new TextDecoder().decode(new Uint8Array(M.seven("a%bé\n"))) === "a%25b%C3%A9\n", "a % and a byte over 7F are written as % and two digits");
  check(M.ours(new Uint8Array([0x7e, 0x7f, 9, 1, 0xf7])) === null && M.ours(new Uint8Array([0x7d, 0x6c, 0x69, 0xf7])) === null, "another's message is not lipservice's");
  check(threw(() => M.ours(m.slice(1, -1))).includes("cut short"), "a message with no F7 is cut short");
  for (const bad of ["%4", "%zz", "%c3%a9", "%C3"]) check(threw(() => M.eight(text(bad))) !== null, `${bad} is not text`);
}

// ------------------------------------------------------------------ a part through a MIDI file

for (const name of Object.keys(EXAMPLES)) {
  const part = EXAMPLES[name]();
  if (name === "unfinished") {
    check(threw(() => M.write(part)) === null, "unfinished: a part that cannot be sung is written");
  }
  const bytes = M.write(part);
  const back = M.read(bytes);
  check(back.how === "inside" && equal(back.part, part), `${name}: through a MIDI file and back, nothing lost`);
  check(P.write(back.part) === P.write(part), `${name}: its text the same after`);
  check(Buffer.compare(Buffer.from(M.write(back.part)), Buffer.from(bytes)) === 0, `${name}: and the file the same written again`);
  check(Buffer.compare(readFileSync(here(`examples/${name}.mid`)), Buffer.from(bytes)) === 0, `${name}: examples/${name}.mid is that file`);
  // the same events at another division, in running status: still as lipservice left it
  const other = M.read(again(bytes, 3));
  check(other.how === "inside" && equal(other.part, part), `${name}: written again by another hand at three times the division, still the part inside`);
}

// the files the editor's menu has, and the one that is another's
for (const [file, from] of Object.entries(BORROWED)) {
  check(Buffer.compare(readFileSync(here(`examples/${file}`)), readFileSync(here(`examples/${from}`))) === 0, `examples/${file} is ${from} as it is`);
}
for (const { file, label } of MENU) {
  const bytes = new Uint8Array(readFileSync(here(`examples/${file}`)));
  const text = M.is(bytes) ? null : new TextDecoder().decode(bytes);
  const parts = M.is(bytes) ? [M.read(bytes, { singer: P.singer("6147") }).part] : S.is(text) ? S.read(text).singers.map((x) => x.part) : [P.read(text)];
  check(label.length > 0 && parts.every((part) => part.notes.length > 0), `the menu's ${file} reads: ${parts.map((part) => part.notes.length).join(" + ")} notes`);
}

// what the file says in the standard way
{
  const part = EXAMPLES.every(), { division, tracks } = M.parse(M.write(part));
  const [t] = tracks, at = (beats) => Math.round(beats * 960);
  const rows = (pred, row) => t.filter(pred).map(row);
  check(division === 960 && tracks.length === 1, "one track at the part's grid");
  check(t[0].tick === 0 && t[0].sysex !== undefined && equal(M.ours(t[0].sysex), { kind: 1, text: P.write(part) }), "the part's text first, at tick 0");
  check(equal(rows((e) => e.meta === 0x03, (e) => new TextDecoder().decode(e.data)), [part.title]), "the title as the track's name");
  check(equal(rows((e) => e.meta === 0x51, (e) => [e.tick, [...e.data]]), [[0, [0x0c, 0xb7, 0x35]], [at(14), [0x0f, 0x21, 0xf8]]]), "the tempos, microseconds a beat (833333 and 991736)");
  check(equal(rows((e) => e.meta === 0x58, (e) => [e.tick, [...e.data]]), [[0, [3, 2, 24, 8]], [at(6), [4, 2, 24, 8]]]), "the meters");
  check(equal(rows((e) => e.meta === 0x05, (e) => new TextDecoder().decode(e.data)), ["Slow-", "ly ", "now ", "the ", "riv-", "er ", "turns,\n", "o-", "ver ", "stone ", "and ", "un-", "der ", "sky. "]), "the syllables as lyrics, none for a held note");
  const ons = rows((e) => (e.status & 0xf0) === 0x90, (e) => [e.tick, e.a, e.b]), offs = rows((e) => (e.status & 0xf0) === 0x80, (e) => [e.tick, e.a, e.b]);
  check(equal(ons, part.notes.map((n) => [n.at, P.key(n.pitch), n.velocity])), "a note on for each note, its velocity");
  check(equal(offs.sort((a, b) => a[0] - b[0]), part.notes.map((n) => [n.at + n.ticks, P.key(n.pitch), n.release]).sort((a, b) => a[0] - b[0])), "a note off for each, its release");
  // E4+14: 14/200 of 8192 is 573 over the centre; then back to the centre; then B3-15.6: 639 under; then the centre
  check(equal(rows((e) => (e.status & 0xf0) === 0xe0, (e) => [e.tick, (e.a | (e.b << 7)) - 8192]), [[at(8.5), 573], [at(10), 0], [at(12), -639], [at(13), 0]]), "the cents as bends, each before its note");
  check(equal(rows((e) => (e.status & 0xf0) === 0xb0 && e.a !== 1, (e) => [e.tick, e.a, e.b]), [[0, 101, 0], [0, 100, 0], [0, 6, 2], [0, 38, 0], [0, 101, 127], [0, 100, 127]]), "the bend's range set to 2 semitones");
  const wheel = rows((e) => (e.status & 0xf0) === 0xb0 && e.a === 1, (e) => [e.tick, e.b]);
  check(equal(wheel.slice(0, 3), [[0, 64], [at(1), 32], [at(3) + 15, 33]]), "the wheel at rest until the lane's first point, then at it, then up the line");
  check(wheel.every(([tick, s]) => s === M.step(P.at(part.lanes.vibrato, tick, 1))), "every move of the wheel is the lane's size there");
  check(wheel.every(([, s], i) => i === 0 || s !== wheel[i - 1][1]), "and no move leaves it where it was");
  const jump = wheel.findIndex(([tick]) => tick === at(10));
  check(equal(wheel[jump], [at(10), 48]) && wheel[jump - 1][1] === 80 && wheel[jump - 1][0] > at(9.9) && wheel[jump - 1][0] < at(10) && wheel[jump + 1][0] > at(14), "a line runs up to its end, and the jump after it is one move there");
  check(Math.max(...wheel.map(([, s]) => s)) === 127 && wheel[wheel.length - 1][1] === 0, "a size over 2 is the wheel's top");
  const order = t.filter((e) => e.tick === at(8.5)).map((e) => e.meta ?? e.status & 0xf0);
  check(equal(order, [0x80, 0xb0, 0xe0, 0x05, 0x90]), "on one tick: the note before's end, the wheel, the bend, the lyric, the note");
  // a part with no cents and no title has neither bends, the range, nor a name
  const plain = M.parse(M.write(EXAMPLES.unfinished())).tracks[0];
  check(!plain.some((e) => e.meta === 0x03 || (e.status & 0xf0) === 0xe0 || (e.status & 0xf0) === 0xb0), "no name, bend or controller in a part with no title, cents or vibrato");
}

// two notes of one key at once are not a MIDI file's to tell apart
{
  const p = P.blank(SINGER);
  p.notes = [{ at: 0, ticks: 960, pitch: "C4", cents: 0, velocity: 64, release: 64, lyric: null }, { at: 480, ticks: 960, pitch: "B#3", cents: 0, velocity: 64, release: 64, lyric: null }];
  check(threw(() => M.write(p))?.includes("two B#3s sound at once at beat 0.5"), "two notes of one key at once are refused");
  p.notes[1].at = 960;
  check(threw(() => M.write(p)) === null, "one after the other they are written");
}

// ------------------------------------------------------------------ the plugin's songs

{
  const plainBytes = new Uint8Array(readFileSync(here("../plugin/songs/mary.mid"))), pedalBytes = new Uint8Array(readFileSync(here("../plugin/songs/mary-pedal.mid")));
  const words = readFileSync(here("../plugin/songs/mary.txt"), "utf8");
  const f = read(plainBytes), g = read(pedalBytes);
  const b = (n) => [P.key(n.pitch), n.at / 480, n.ticks / 480];
  check(f.how === "events" && f.part.grid === 480 && f.part.notes.length === 26 && equal([b(f.part.notes[0]), b(f.part.notes[6]), b(f.part.notes[25])], [[64, 4, 1], [64, 10, 1.5], [60, 32, 4]]), "mary.mid: its 26 notes on their beats");
  check(f.part.notes.every((n) => n.velocity === 96 && n.release === 0 && n.cents === 0), "each at the velocity and release the file gives it");
  check(equal(f.part.tempo, [{ at: 0, bpm: 96 }]) && equal(f.part.meter, [{ at: 0, n: 4, d: 4 }]) && f.part.title === "" && equal(f.part.singer, SINGER), "at 96 in 4/4, sung by the singer given");
  // the words as the plugin writes them: a syllable to a note, a hyphen inside a word, a line a lyric line
  const lines = [];
  let line = "";
  for (const n of f.part.notes) {
    const s = P.syllable(n.lyric);
    line += s.text + (s.on ? "-" : s.end ? "" : " ");
    if (s.end) { lines.push(line); line = ""; }
  }
  check([...lines, line.trim()].join("\n") + "\n" === words, "its lyrics are mary.txt's words");
  check(f.part.lanes.vibrato.length === 0 && f.said.length === 1 && f.said[0] === "the file's events: 26 notes, 26 syllables, 0 points of vibrato", "no vibrato written, and nothing left behind");
  const v = g.part.lanes.vibrato, pt = (q) => [q.at / 480, q.value];
  check(equal(g.part.notes, f.part.notes) && v.length === 69 && v.every((q) => !q.line), "mary-pedal.mid: the same notes, and 69 points of vibrato that hold");
  check(equal([pt(v[0]), pt(v[11]), pt(v[12]), pt(v[68])], [[0, M.size(40)], [11.375, M.size(120)], [11.5, M.size(40)], [36, M.size(40)]]), "the wheel low on the quick notes and pressed through the long ones");

  // loaded and saved: the file written says what the file read said, event for event, and holds the part
  for (const [name, bytes, was] of [["mary.mid", plainBytes, f], ["mary-pedal.mid", pedalBytes, g]]) {
    const saved = M.write(was.part), a = M.events(bytes).read, c = M.events(saved).read;
    const same = equal({ ...a, lyrics: a.lyrics.map(([t, s]) => [t, s.trimEnd()]) }, { ...c, lyrics: c.lyrics.map(([t, s]) => [t, s.trimEnd()]) });
    check(same, `${name} loaded and saved: the same tempo, meter, notes, velocities, lyrics and wheel, tick for tick`);
    check(equal(a.lyrics.filter(([t, s], i) => s !== c.lyrics[i][1]).map(([, s]) => s), ["snow."]) && c.lyrics[25][1] === "snow. ", `${name}: one lyric differs, by the space that ends the last word`);
    const back = M.read(saved);
    check(back.how === "inside" && equal(back.part, was.part), `${name} loaded, saved and loaded: the same part`);
  }
}

// ------------------------------------------------------------------ files from elsewhere

// lyrics as files write them
{
  const song = (syllables) => {
    const t = [];
    syllables.forEach((s, i) => {
      if (s !== null) t.push([0, lyric(s)]);
      t.push([0, [0x90, 60 + i, 100]], [96, [0x80, 60 + i, 0]]);
    });
    return read(file(0, 96, [t])).part.notes.map((n) => n.lyric);
  };
  check(equal(song(["Ma", "ry ", "had ", "a ", "lit", "tle ", "lamb, "]), ["Ma-", "ry", "had", "a", "lit-", "tle", "lamb,"]), "a space ends a word; a syllable with none goes on");
  check(equal(song(["Ma-", "ry", " had", " a", " lit-", "tle", " lamb.\n", "Its ", null, "fleece"]), ["Ma-", "ry", "had", "a", "lit-", "tle", "lamb./", "Its", "_", "fleece"]), "a space before the next ends it too; a line end ends a line; a note with no lyric holds");
  check(equal(song(["wa", null, "ter ", null, "wide"]), ["wa-", "_", "ter", "_", "wide"]), "a held note inside a word");
  check(equal(song([null, null, "la", " ", "\r", "la-"]), [null, null, "la", "_", "_", "la-"]), "notes before the lyrics begin have no words; a lyric of spaces is a held note");
  check(equal(song(["x-y", " z-", "rock-n-", "roll\r\n"]), ["x-y", "z-", "rock-n-", "roll/"]), "a hyphen inside a syllable is its own");
  for (const [bad, why] of [["oh my ", "one syllable"], ["a_b", "one syllable"], ["a/b", "one syllable"], ["a--", "one syllable"]]) {
    check(threw(() => song([bad]))?.includes(why), `the lyric ${JSON.stringify(bad)} is refused`);
  }
}

// two tracks: the tune, and a piano. One singer sings one of them.
{
  const tune = [[0, meta(0x03, text("Voice "))], [0, meta(0x51, [7, 0xa1, 0x20])], [960, lyric("Wa")], [0, [0x90, 60, 100]], [480, [0x80, 60, 0]], [0, lyric("ter ")], [0, [0x90, 62, 90]], [240, [62, 0]], [240, lyric("wide\r")], [0, [0x90, 64, 80]], [480, [64, 0]], [0, [65, 80]], [200000, [0x80, 65, 64]]];
  const piano = [[0, meta(0x03, text("Piano"))], [0, [0xc1, 0]], [0, [0xb1, 1, 0]], [0, [0xb1, 7, 100]], [0, [0x91, 48, 70]], [0, [0x91, 55, 70]], [1920, [0x81, 48, 0]], [0, [0x81, 55, 0]]];
  const bytes = file(1, 480, [tune, piano]);
  check(equal(M.survey(bytes), [{ track: 0, channel: 1, name: "Voice", notes: 4, lyrics: 3 }, { track: 1, channel: 2, name: "Piano", notes: 2, lyrics: 0 }]), "where a file's notes are");
  check(threw(() => read(bytes))?.includes("track 0 channel 1, track 1 channel 2: one singer sings one of them"), "notes on two tracks: refused until told which");
  const a = read(bytes, { track: 0 });
  check(equal(a.part.notes.map((n) => [n.at, n.ticks, n.pitch, n.velocity, n.release, n.lyric]), [[960, 480, "C4", 100, 0, "Wa-"], [1440, 240, "D4", 90, 64, "ter"], [1920, 480, "E4", 80, 64, "wide/"], [2400, 200000, "F4", 80, 64, "_"]]), "the tune: a strike of no force lets go with a release of 64, a lyric ends running status");
  check(a.part.title === "Voice" && equal(a.part.tempo, [{ at: 0, bpm: 120 }]) && equal(a.part.meter, [{ at: 0, n: 4, d: 4 }]), "the track's name the title; 500000 microseconds a beat is 120; no meter written is 4/4");
  check(equal(a.said, ["the file's events: 4 notes, 3 syllables, 0 points of vibrato", "left: 1 other tracks' names", "left: 2 notes of other tracks and channels", "left: 1 other tracks' and channels' controllers and programs"]), "what was taken and what was left");
  const b = read(bytes, { channel: 2 });
  check(equal(b.part.notes.map((n) => n.pitch), ["C3", "G3"]) && b.part.title === "Piano" && equal(b.part.lanes.vibrato, [{ at: 0, value: 0, line: false }]), "the piano by its channel, its wheel its own");
  check(b.said.includes("left: 3 lyrics of other tracks") && b.said.includes("left: 1 moves of controller 7") && b.said.includes("left: 1 program changes"), "the tune's lyrics, a controller and a program left");
  check(threw(() => read(bytes, { track: 2 }))?.includes("no notes there") && threw(() => read(bytes, { track: 0, channel: 2 }))?.includes("no notes there"), "a track or channel with no notes is refused");
  // lyrics in a track of their own are the singer's
  const apart = file(1, 96, [[[0, lyric("la ")], [96, lyric("lu")]], [[0, [0x90, 60, 1]], [96, [0x80, 60, 0]], [0, [0x90, 62, 1]], [96, [0x80, 62, 0]]]]);
  check(equal(read(apart).part.notes.map((n) => n.lyric), ["la", "lu"]), "lyrics in a track with no notes are the singer's");
}

// tempo, meter, the wheel, the bend
{
  const t = [
    [0, [0xb0, 1, 0]], [0, [0xb0, 1, 64]], [0, [0x90, 60, 100]], [0, [0xe0, 0x3d, 0x44]], [48, [0xe0, 0, 0x40]], [48, [0x80, 60, 0]],
    [0, meta(0x58, [6, 3, 36, 8])], [0, meta(0x51, [0x06, 0xa2, 0x5f])], [0, [0xb0, 1, 96]], [0, [0xb0, 1, 96]], [0, [0xb0, 1, 127]],
    [0, [0xb0, 101, 0]], [0, [0xb0, 100, 0]], [0, [0xb0, 6, 12]], [0, [0xe0, 0, 0x44]], [0, [0x90, 60, 100]], [96, [0x90, 60, 0]],
    [0, [0xb0, 6, 1]], [0, [0xb0, 101, 127]], [0, [0xb0, 100, 127]], [0, [0xb0, 6, 99]], [0, [0xe0, 0, 0x20]], [0, [0x90, 61, 1]], [96, [0x80, 61, 7]],
  ];
  const r = read(file(0, 96, [t])), p = r.part;
  check(equal(p.tempo, [{ at: 0, bpm: 120 }, { at: 96, bpm: 138 }]) && equal(p.meter, [{ at: 0, n: 4, d: 4 }, { at: 96, n: 6, d: 8 }]), "a tempo and a meter that start late follow MIDI's own; 434783 microseconds a beat is 138");
  check(equal(p.lanes.vibrato, [{ at: 96, value: 2, line: false }]), "the wheel one point a tick, the last to come; a move back to rest on the tick it left is no point");
  // 573/8192 of 2 semitones on the first note, a bend on its tick though after it; then 512/8192 of 12; then 4096 under, of 1
  check(equal(p.notes.map((n) => [n.pitch, n.cents]), [["C4", 573 / 8192 * 200], ["C4", 75], ["C#4", -50]]), "the bend standing as a note starts is its cents, in the range the file sets");
  check(r.said.includes("left: 1 bends inside a note"), "a bend inside a note is left, and said");
  for (const us of [625000, 500000, 434783, 597015, 1, 15000000]) {
    const part = read(file(0, 96, [[[0, meta(0x51, [us >> 16, (us >> 8) & 255, us & 255])], [0, [0x90, 60, 1]], [9, [0x80, 60, 0]]]])).part;
    const back = M.parse(M.write(part)).tracks[0].find((e) => e.meta === 0x51).data;
    check(((back[0] << 16) | (back[1] << 8) | back[2]) === us, `${us} microseconds a beat is ${part.tempo[0].bpm} beats a minute, and is written back as ${us}`);
  }
}

// ------------------------------------------------------------------ a file changed elsewhere

{
  const part = EXAMPLES.every(), bytes = M.write(part);
  const spot = (pattern) => {
    const at = bytes.findIndex((_, i) => pattern.every((b, k) => bytes[i + k] === b));
    assert(at > 0 && bytes.findLastIndex((_, i) => pattern.every((b, k) => bytes[i + k] === b)) === at, "once in the file");
    return at;
  };
  // the second note struck harder, as another program would leave it
  const louder = bytes.slice();
  louder[spot([0x90, 64, 64]) + 2] = 99;
  const r = M.read(louder, { singer: SINGER });
  check(r.how === "changed" && r.part.notes[1].velocity === 99, "a velocity changed elsewhere: the file's events are the part");
  check(equal(r.part.singer, part.singer) && r.part.title === part.title, "the singer and the name are the part inside's");
  check(equal(r.part.notes.map((n) => [n.at, n.ticks, n.pitch, n.release, n.lyric]), part.notes.map((n) => [n.at, n.ticks, n.pitch === "Bb3" ? "A#3" : n.pitch, n.release, n.lyric])), "the notes and words as the events have them, a flat now a sharp");
  check(equal(r.said.slice(0, 2), ["changed since lipservice wrote it: the file's events (16 notes, 14 syllables, 338 points of vibrato) and the singer of the part inside", "not kept of the part inside: 3 marks, the vibrato's lines"]), "and the reading says what was not kept");
  check(equal(r.part.marks, []) && r.part.lanes.vibrato.every((q) => !q.line) && r.part.notes[7].cents === 573 / 8192 * 200, "the marks gone, the lines now points, the cents the bend's");
  // each kind of event: a change to any is seen
  for (const [what, change] of [
    ["a tempo", (b) => { b[spot([0xff, 0x51, 3, 0x0c, 0xb7, 0x35]) + 5] = 0x36; }],
    ["a meter", (b) => { b[spot([0xff, 0x58, 4, 3, 2]) + 3] = 2; }],
    ["a lyric", (b) => { b[spot([0xff, 0x05, 4, ...text("the ")]) + 3] = 0x54; }],
    ["a key", (b) => { b[spot([0x90, 67, 96]) + 1] = 68; b[spot([0x80, 67, 64]) + 1] = 68; }],
    ["a release", (b) => { b[spot([0x80, 66, 40]) + 2] = 41; }],
    ["a note's length, and where all after it start", (b) => { b[spot([0x87, 0x40, 0x80, 62, 64]) + 1] = 0x3f; }],
    ["the wheel", (b) => { b[spot([0x87, 0x40, 0xb0, 1, 32]) + 4] = 31; }],
    ["a bend", (b) => { b[spot([0xe0, 0x3d, 0x44]) + 1] = 0x3e; }],
    ["the name", (b) => { b[spot([0xff, 0x03, text(part.title).length, ...text("Every")]) + 3] = 0x65; }],
  ]) {
    const b = bytes.slice();
    change(b);
    check(M.read(b).how === "changed", `${what} changed elsewhere is seen`);
  }
  // what another program adds that a part has no place for does not make the file changed
  const { tracks } = M.parse(bytes);
  const more = again(bytes, 1);
  const raw = (e) => (e.meta !== undefined ? meta(e.meta, [...e.data]) : e.sysex !== undefined ? [0xf0, ...vlq(e.sysex.length), ...e.sysex] : [e.status, e.a, e.b]);
  const others = [[0, [0xc0, 52]], [0, [0xb0, 7, 100]], [0, meta(0x59, [0, 0])], [0, [0xf0, 5, 0x7e, 0x7f, 9, 1, 0xf7]]];
  const added = file(0, 960, [[...others, ...tracks[0].map((e, i) => [e.tick - (i ? tracks[0][i - 1].tick : 0), raw(e)])]]);
  const kept = M.read(added);
  check(M.read(more).how === "inside" && kept.how === "inside" && equal(kept.part, part), "a program, a volume, a key signature and another's message added: still the part inside");
  check(equal(kept.said.slice(1), ["left: 1 program changes", "left: 1 moves of controller 7", "left: 1 key signatures", "left: 1 system exclusive messages that are not lipservice's"]), "and they are said to be left");
  // the part inside spoiled
  const spoiled = bytes.slice();
  spoiled[spot(text("\nseed 11\n")) + 1] = 0x78;
  check(threw(() => M.read(spoiled))?.startsWith("the part inside: line 6: \"xeed\": no such line"), "a part inside that is no part is refused, its line named");
  const twice = file(0, 960, [[[0, [0xf0, ...vlq(tracks[0][0].sysex.length), ...tracks[0][0].sysex]], [0, [0xf0, ...vlq(tracks[0][0].sysex.length), ...tracks[0][0].sysex]], [0, [0x90, 60, 1]], [9, [0x80, 60, 0]]]]);
  check(threw(() => M.read(twice))?.includes("two lipservice parts"), "two parts inside one file are refused");
  const kind = tracks[0][0].sysex.slice();
  kind[11] = 2;
  check(threw(() => M.read(file(0, 960, [[[0, [0xf0, ...vlq(kind.length), ...kind]], [0, [0x90, 60, 1]], [9, [0x80, 60, 0]]]])))?.includes("of kind 2"), "a lipservice message of a kind this does not read is refused");
}

// ------------------------------------------------------------------ what is no song

{
  const note = [[0, [0x90, 60, 100]], [96, [0x80, 60, 0]]];
  const good = file(1, 96, [note]);
  check(M.is(good) && !M.is(text("lipservice part 2\n")) && read(good).part.notes.length === 1, "a file of one note is read");
  check(threw(() => M.read(good))?.includes("it needs a singer"), "a file with no part inside needs a singer");
  for (const [bad, why] of [
    [file(2, 96, [note]), "format 2"],
    [file(1, 0xe728, [note]), "frames a second"],
    [file(1, 96, [[[0, [0x90, 60, 100]]]]), "the note C4 at beat 0 is never let go"],
    [file(1, 96, [[[0, [0xb0, 1, 5]]]]), "no notes"],
    [file(1, 96, [[]]), "no notes"],
    [file(1, 96, [[[0, [60, 100]]]]), "no status"],
    [file(1, 96, [[[0, [0x90, 60, 100]], [48, lyric("la")], [48, [0x80, 60, 0]]]]), "the lyric \"la\" at beat 0.5 is under no note's start"],
    [file(1, 96, [[[96, [0x90, 60, 100]], [0, [0x80, 60, 0]]]]), "the note C4 at beat 1 has no length"],
    [file(1, 96, [[[96, [0x90, 60, 100]], [0, [0x90, 60, 100]], [5, [0x80, 60, 0]]]]), "the note C4 at beat 1 has no length"],
    [file(1, 96, [[[0, [0xe0, 0, 0x60]], ...note]]), "is bent 100 cents"],
    [file(1, 96, [[[0, meta(0x58, [4, 6, 24, 8])], ...note]]), "a meter of 4 notes of a 64th"],
    [file(1, 96, [[[0, meta(0x51, [0, 0, 0])], ...note]]), "a tempo of no time"],
    [file(1, 96, [[[0, meta(0x51, [0xff, 0xff, 0xff])], ...note]]), "4 to 60000000 beats a minute"],
    [file(1, 96, [[[0, meta(0x05, [0xff, 0x41])], ...note]]), "the lyric at beat 0 is not UTF-8 text"],
    [file(1, 96, [[[0, meta(0x03, [0xe9])], ...note]]), "a track's name is not UTF-8 text"],
    [file(1, 96, [[[0, [0xf1, 0]], ...note]]), "not a file's"],
    [file(1, 96, [[[0, [0x90, 60, 0x90]], ...note]]), "a status where its data should be"],
    [good.slice(0, good.length - 6), "the file ends"],
    [new Uint8Array(text("MThd\0\0\0\x05")), "not a MIDI file"],
    [new Uint8Array(text("lipservice part 2\n")), "not a MIDI file"],
  ]) {
    const e = threw(() => read(bad));
    check(e !== null && e.includes(why), `refused: ${why}`);
    if (e === null || !e.includes(why)) console.log(`     ${e}`);
  }
  // a file with no notes that lipservice wrote is a part with no notes
  const empty = { ...P.blank(SINGER), title: "Nothing yet", lanes: { vibrato: [{ at: 960, value: 0.5, line: false }] } };
  const back = M.read(M.write(empty));
  check(back.how === "inside" && equal(back.part, empty), "a part with no notes yet goes through a MIDI file too");
}

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
