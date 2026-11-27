// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// make.js: new singers made from a part sing what they are made to, keep the words singable, are
// each their own singer, and link to their leader as score.js reads it. node make_test.mjs
import assert from "node:assert/strict";
import * as P from "./part.js";
import * as S from "./score.js";
import * as T from "./theory.js";
import * as M from "./make.js";
import { problems, words } from "./song.js";
import { EXAMPLES, round as roundScore } from "./examples/make.mjs";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const refused = (f, like) => { try { f(); return false; } catch (e) { return like.test(e.message) || (console.log(`     said: ${e.message}`), false); } };
const C = { tonic: 0, scale: "major" }, F = { tonic: 5, scale: "major" }, D = { tonic: 2, scale: "natural minor" };
const keys = (p) => p.notes.map((n) => P.key(n.pitch));
const rhythm = (p) => p.notes.map((n) => [n.at, n.ticks, n.cents, n.velocity, n.release, n.lyric]);
const singable = (p) => problems(p).length === 0;
const scoreOf = (strips) => ({ title: "", master: 0, chain: S.chain(), singers: strips });
const linked = (strips) => { S.check(scoreOf(strips)); return true; };
const settings = (p) => { const { voice, seed, ...rest } = p.singer; return rest; };

const mary = EXAMPLES.mary(), twinkle = EXAMPLES.twinkle(), grace = EXAMPLES.grace(), row = EXAMPLES.row(), every = EXAMPLES.every();
const G = mary.grid;
const frozen = JSON.stringify([mary, twinkle, grace, row, every]);

// ---------------------------------------------------------------- harmony

{
  const h = M.harmonize(mary, C, 2, "2428", 9);
  check(equal(keys(h), keys(mary).map((k) => T.step(C, k, 2))) && h.notes.every((n) => T.inKey(C, P.key(n.pitch))), "a third above in C major: each note two steps up the scale");
  check(equal(rhythm(h), rhythm(mary)) && equal(h.lanes, mary.lanes) && equal(h.marks, mary.marks), "the same rhythm, cents, words, vibrato and marks");
  check(h.singer.voice === "2428" && h.singer.seed === 9 && equal(settings(h), settings(mary)) && h.title === "Mary Had a Little Lamb, a third above", "its voice and seed as given, every other setting the source's, named by what it is");
  check(singable(h) && equal(h.tempo, mary.tempo) && equal(h.meter, mary.meter), "it is sung as the source is, in the source's time");
  const below = M.harmonize(mary, C, -5, "2428", 9);
  check(equal(keys(below), keys(mary).map((k) => T.step(C, k, -5))) && below.title.endsWith("a sixth below"), "a sixth below");
  const semis = M.harmonize(mary, null, 7, "2428", 9);
  check(equal(keys(semis), keys(mary).map((k) => k + 7)) && semis.title.endsWith("7 semitones above"), "with no key, semitones");
  const off = { ...mary, notes: [{ ...mary.notes[0], pitch: "C#4", cents: 12 }, ...mary.notes.slice(1)] };
  const offUp = M.harmonize(off, C, 1, "2428", 9).notes[0];
  check(P.key(offUp.pitch) === 63 && offUp.pitch === T.spell(C, 63) && offUp.cents === 12, "a note off the scale keeps its offset from the scale note below it (C#4 up one is D#4, spelled for C major), and its cents");
  const flat = { ...mary, notes: mary.notes.map((n) => ({ ...n, pitch: "Bb4" })) };
  check(M.harmonize(flat, F, 2, "2428", 9).notes[0].pitch === "D5" && M.harmonize(flat, null, 1, "2428", 9).notes[0].pitch === "B4" && M.harmonize(flat, null, -2, "2428", 9).notes[0].pitch === "Ab4", "spelled for the key, or a flat kept a flat with none");
  check(M.harmonize(mary, D, 2, "2428", 9).notes.some((n) => n.pitch.includes("b")) && M.harmonize(mary, D, 2, "2428", 9).notes.every((n) => !n.pitch.includes("#")), "D minor spells its sixth step Bb");
  const high = { ...mary, notes: [{ ...mary.notes[0], pitch: "F9" }] };
  check(refused(() => M.harmonize(high, C, 2, "2428", 9), /^beat 4: F9 up 2 steps in C major: past MIDI's keys/), "a note pushed past MIDI's keys is refused by its beat");
  check(refused(() => M.harmonize(mary, C, 2, "2428", mary.singer.seed), /seed 3 is "Mary Had a Little Lamb"'s own: each singer has a seed of its own/), "the source's own seed is refused");
  check(refused(() => M.harmonize(mary, C, 1.5, "2428", 9), /an interval 1.5: a whole number/), "half a step is refused");
  check(refused(() => M.harmonize(mary, C, 2, "two words", 9), /voice two words: a name with no space in it/), "a voice the part cannot hold is refused");
  check(refused(() => M.harmonize({ ...mary, singer: { ...mary.singer, sway: 0 } }, C, 2, "2428", 9), /sway 0 holds its notes flat, and a singer made from it would too/), "nothing is made from a singer with sway 0");
  check(refused(() => M.harmonize(every, C, 2, "2428", 9), /its vibrato is 0 at beat 6 with motion -, a flat held tone/), "nor from a vibrato lane at 0 under motion -");
  check(refused(() => M.harmonize(mary, { tonic: 0, scale: "mixed" }, 2, "2428", 9), /a key is a tonic, 0 to 11, and a scale/), "a key that is no key is refused");
  check(M.apart(C, 7) === "an octave above" && M.apart({ tonic: 0, scale: "major pentatonic" }, 2) === "2 steps above" && M.apart(null, -12) === "an octave below" && M.apart(null, 24) === "2 octaves above" && M.apart(null, -1) === "1 semitone below" && M.apart(C, 0) === "in unison", "intervals said as a person says them");
}

// ---------------------------------------------------------------- canon, repeat and round

{
  const c = M.canon(mary, 4 * G, 12, "2428", 9);
  check(equal(c.notes.map((n) => [n.at - 4 * G, P.key(n.pitch) - 12]), mary.notes.map((n) => [n.at, P.key(n.pitch)])), "a canon: the notes four beats later and an octave up");
  check(equal(c.lanes.vibrato.map((q) => ({ ...q, at: q.at - 4 * G })), mary.lanes.vibrato) && equal(c.marks.map((m) => m.at - 4 * G), mary.marks.map((m) => m.at)), "its vibrato and marks come later with it");
  check(singable(c) && c.title === "Mary Had a Little Lamb, 4 beats later, an octave above", "it is sung, and named");
  const ok = linked([{ ...S.strip(), part: mary }, { ...S.strip(), follows: { leader: 0, after: 4 * G, keys: 12 }, part: c }]);
  check(ok, "a score has it follow the source 4 beats later and 12 keys up");
  const dia = M.canon(mary, 2 * G, -2, "2428", 9, C);
  check(equal(keys(dia), keys(mary).map((k) => T.step(C, k, -2))) && dia.notes[0].at === mary.notes[0].at + 2 * G, "a canon a third below in the key");
  check(refused(() => M.canon(mary, -G, 0, "2428", 9), /-480 ticks later: 0 or more/), "a canon cannot come earlier");

  const twice = M.repeat(grace, 2), period = M.barLine(grace, Math.max(...grace.notes.map((n) => n.at + n.ticks)), true);
  check(period === 51 * grace.grid && twice.notes.length === 2 * grace.notes.length && equal(twice.notes.slice(grace.notes.length).map((n) => n.at - period), grace.notes.map((n) => n.at)), "repeat: Amazing Grace again from the bar line after it ends, beat 51");
  let same = true;
  for (let t = 0; t < period; t += grace.grid / 8) same &&= P.at(twice.lanes.vibrato, t + period, 1) === P.at(grace.lanes.vibrato, t, 1);
  check(same, "its vibrato the second time is what it was the first, beat for beat");
  check(singable(twice) && twice.marks.length === 6, "both times are sung, the breaths marked again");
  check(equal(M.repeat(grace, 1), grace), "once is the part as it is");
  check(refused(() => M.repeat({ ...grace, lanes: { vibrato: [...grace.lanes.vibrato, { at: 60 * grace.grid, value: 1, line: false }] } }, 2), /its vibrato at beat 60 is past the bar line at beat 51/), "a vibrato point past the end is refused, not cut");

  const want = roundScore();
  const r = M.round(row, [{ voice: "6345", seed: 5, title: "Cora" }, { voice: "2428", seed: 9, title: "Ben" }], 6 * row.grid, { intervals: [12, 0], times: 2, width: 1.1, leader: 0 });
  check(r.length === 3 && [0, 1, 2].every((i) => equal(r[i].part.notes, want.singers[i].part.notes) && equal(r[i].part.lanes, want.singers[i].part.lanes) && equal(r[i].part.marks, want.singers[i].part.marks)), "round: Row, Row, Row Your Boat as round.score has it, note for note");
  check(equal(r.map((s) => s.pan), [-0.55, 0, 0.55]) && equal(r.map((s) => s.part.singer), want.singers.map((s) => s.part.singer)) && equal(r.slice(1).map((s) => s.part.title), ["Cora", "Ben"]), "pans across the width in the order they come in, the singers as the example's");
  check(r[0].follows === undefined && equal(r[1].follows, { leader: 0, after: 6 * row.grid, keys: 12 }) && equal(r[2].follows, { leader: 0, after: 12 * row.grid, keys: 0 }), "the entries follow the first, later and moved as they are");
  const text = S.write(scoreOf(r));
  check(linked(r) && equal(S.read(text).singers.map((s) => s.follows), r.map((s) => s.follows)) && text.includes("\nfollows 1 after 6 keys 12\n") && text.includes("\nfollows 1 after 12\n"), "it reads and writes as a score of linked singers");
  const inKey = M.round(row, [{ voice: "6345", seed: 5 }], 6 * row.grid, { key: C, intervals: [2], leader: 0 });
  check(inKey[1].follows === undefined && keys(inKey[1].part)[0] === T.step(C, keys(row)[0], 2), "an entry moved along a key is not linked: a link moves by keys");
  check(refused(() => M.round(row, [{ voice: "6345", seed: 5 }, { voice: "2428", seed: 5 }], 6 * row.grid), /seed 5 is given twice/), "two entries with one seed are refused");
}

// ---------------------------------------------------------------- doubles, sections and echoes

{
  const up = M.double({ ...mary, notes: mary.notes.map((n, i) => (i === 0 ? { ...n, pitch: "Bb3" } : n)) }, 12, 9, 4);
  check(up.notes[0].pitch === "Bb4" && P.key(up.notes[1].pitch) === P.key(mary.notes[1].pitch) + 12 && up.singer.shift === 0.04 && up.singer.voice === mary.singer.voice, "an octave double: every note 12 keys up as spelled, 4 cents in its shift, the same voice");
  const uni = M.double(mary, 0, 9);
  check(equal(uni.notes, mary.notes) && uni.singer.seed === 9 && uni.title === "Mary Had a Little Lamb, a double", "a unison double: the same notes, its own seed");
  check(M.double(mary, -12, 9, 0, "6345").singer.voice === "6345", "a double may be another voice, given");
  check(refused(() => M.double(mary, 0, mary.singer.seed), /seed 3 is .* own/), "a double with the source's seed is the same take twice, and is refused");
  check(equal(M.followed(mary, up, { after: 0, keys: 12 }).notes, M.double(mary, 12, 9, 4).notes), "followed() makes a follower's notes as double() made them");

  const sec = M.section(mary, 3, 1, { leader: 0, strip: { ...S.strip(), level: -2, pan: 0.1 } });
  const db = Number((-2 - 10 * Math.log10(4)).toFixed(2));
  check(sec.length === 4 && sec.every((s) => s.level === db), "a section of four: every strip down by 10 log10 4, so it sums as one singer did");
  check(equal(sec.map((s) => s.part.singer.seed), [3, 4, 5, 6]) && sec.slice(1).every((s) => equal(s.part.notes, mary.notes) && equal(s.part.lanes, mary.lanes)), "the doubles each a seed of their own after the source's, singing its notes");
  const shifts = sec.slice(1).map((s) => s.part.singer.shift);
  check(new Set(shifts).size === 3 && shifts.every((x) => x !== 0 && Math.abs(x) <= 0.05) && sec[0].part === mary, "each a few cents off, none the same, the source untouched");
  check(equal(sec.map((s) => s.pan).sort((a, b) => a - b), [-0.4, -0.067, 0.267, 0.6]) && Math.abs(sec[0].pan - 0.1) <= 0.17, "pans spread across the width about the source's, the source in the middle");
  check(sec.slice(1).every((s) => equal(s.follows, { leader: 0, after: 0, keys: 0 })) && linked(sec), "the doubles follow the source, and the score reads it so");
  check(sec.slice(1).every((s) => s.part.singer.sway === mary.singer.sway && s.part.singer.motion === mary.singer.motion), "no double is given a sway or motion of its own");
  check(refused(() => M.section(mary, 2, 1, { seeds: [4, 3] }), /seed 3 is .* own/) && refused(() => M.section(mary, 2, 1, { seeds: [4, 4] }), /seed 4 is given twice/), "seeds given are each the singer's own");
  check(refused(() => M.section(mary, 3, 1, { strip: { ...S.strip(), level: -57 } }), /a section of 4 at -63.02 dB: a strip is -60 to 12 dB/), "a section too quiet for a strip is refused");
  check(refused(() => M.section(mary, 3, 1.5, { strip: { ...S.strip(), pan: 0.5 } }), /past an ear/), "pans past an ear are refused");

  const echo = M.echoes(mary, 3, G / 2, { leader: 0, fall: 4, width: 1 });
  check(equal(echo.map((s) => s.level), [0, -4, -8, -12]) && equal(echo.slice(1).map((s) => s.follows.after), [G / 2, G, 1.5 * G]), "echoes: each half a beat after the one before, 4 dB quieter");
  check(equal(echo.slice(1).map((s) => s.pan), [0.25, -0.25, 0.5]) && linked(echo) && echo.slice(1).every((s) => singable(s.part)), "panned further out, right and left in turn, each sung and linked");
}

// ---------------------------------------------------------------- following a leader that changed

{
  const c = M.canon(mary, 4 * G, 12, "2428", 9), link = { leader: 0, after: 4 * G, keys: 12 };
  const moved = { ...mary, notes: mary.notes.map((n, i) => (i === 2 ? { ...n, pitch: "F4", lyric: "hid" } : n)) };
  check(refused(() => S.check(scoreOf([{ ...S.strip(), part: moved }, { ...S.strip(), follows: link, part: c }])), /^singer 2 \(Mary Had a Little Lamb, 4 beats later, an octave above\): follows singer 1 \(Mary Had a Little Lamb\) 4 beats later and 12 keys up, but its note at beat 10 is not the leader's at beat 6: its key is C5, not F5 as the leader's makes it$/), "a leader changed: its old follower is refused, by who and where");
  const again = M.followed(moved, { ...c, marks: [{ at: 4 * G, breath: true }] }, link);
  check(linked([{ ...S.strip(), part: moved }, { ...S.strip(), follows: link, part: again }]) && again.notes[2].lyric === "hid" && equal(again.marks, [{ at: 4 * G, breath: true }]) && again.singer.seed === 9, "followed() gives it the leader's change and keeps its own marks and singer");
  // a 0 drawn under the leader's motion, where it is never sung, is a flat held tone under a follower's -
  const lead = { ...mary, singer: { ...mary.singer, motion: "vibrato" }, lanes: { ...mary.lanes, vibrato: [{ at: 0, value: 0.5, line: false }, { at: 2 * G, value: 0.7, line: false }] } };
  const plain = { ...M.double(lead, 0, 9), singer: { ...M.double(lead, 0, 9).singer, motion: null } }, same = { after: 0, keys: 0 };
  const zeroed = { ...lead, lanes: { ...lead.lanes, vibrato: [{ at: 0, value: 0, line: false }, { at: 2 * G, value: 0.5, line: false }] } };
  check(refused(() => M.followed(zeroed, plain, same), /would have a vibrato of 0 at beat 0 with its motion -, a flat held tone/), "a follower with motion - is not given a 0 of its leader's");
  check(M.followed(zeroed, { ...plain, singer: { ...plain.singer, motion: "wide" } }, same).lanes.vibrato[0].value === 0, "one with a motion of its own is, as it is not sung there");
  const had = { ...plain, lanes: { ...plain.lanes, vibrato: zeroed.lanes.vibrato } };
  check(M.followed({ ...zeroed, notes: zeroed.notes.map((n, i) => (i === 0 ? { ...n, lyric: "Oh" } : n)) }, had, same).notes[0].lyric === "Oh", "a 0 the follower has already, set by its own motion's change, does not stop the leader's next change");
  const sung = { ...zeroed, singer: { ...zeroed.singer, motion: null } };
  check(M.followed(sung, plain, same).lanes.vibrato[0].value === 0, "a 0 a leader sings under - itself is the person's drawing, and the follower has it too");
}

// ---------------------------------------------------------------- hocket

{
  const h = M.hocket(mary, [{ voice: "2428", seed: 9 }]);
  const ws = words(mary).words;
  check(h.length === 2 && equal(P.sort([...h[0].part.notes, ...h[1].part.notes]), mary.notes), "a hocket of two: every note sung once, by one of them");
  check(equal(words(h[0].part).words.map((w) => w.text), ws.filter((_, j) => j % 2 === 0).map((w) => w.text)) && equal(words(h[1].part).words.map((w) => w.text), ws.filter((_, j) => j % 2).map((w) => w.text)), "whole words in turn: Mary, a, lamb to the first; had, little to the second");
  check(h.every((s) => singable(s.part)) && h[0].part.singer.seed === mary.singer.seed && h[1].part.singer.seed === 9 && h[1].part.title === "Mary Had a Little Lamb, hocket 2", "each part sung as written, the source's singer first");
  const gh = M.hocket(grace, [{ voice: "2428", seed: 9 }, { voice: "6345", seed: 10 }]);
  check(gh.every((s) => singable(s.part)) && equal(gh.flatMap((s) => s.part.marks.map((m) => m.at)).sort((a, b) => a - b), grace.marks.map((m) => m.at)), "Amazing Grace in three: each sung, each breath with the singer of the word it comes before");
  const held = gh.flatMap((s) => s.part.notes).filter((n) => n.lyric === "_");
  check(held.length === grace.notes.filter((n) => n.lyric === "_").length && gh.every((s) => s.part.notes[0].lyric !== "_"), "a held note goes with its syllable");
  const ph = M.hocket(twinkle, [{ voice: "6345", seed: 9 }], { by: "phrase", width: 1 });
  check(equal(ph.map((s) => words(s.part).words.length), [4 + 6 + 4, 6 + 6 + 6]) && ph[0].part.notes[0].lyric === "Twin-" && ph[1].part.notes[0].lyric === "How" && equal(ph.map((s) => s.pan), [-0.5, 0.5]), "by phrase: Twinkle's lines in turn, panned apart");
  const pat = M.hocket(mary, [{ voice: "2428", seed: 9 }], { pattern: [0, 0, 1] });
  check(equal(words(pat[1].part).words.map((w) => w.text).slice(0, 2), [ws[2].text, ws[5].text]), "a pattern hands every third word to the second singer");
  check(refused(() => M.hocket(EXAMPLES.unfinished(), [{ voice: "2428", seed: 9 }]), /is not sung as written, so its words cannot be handed out: beat 0: the note C3 has no words/), "a part not sung as written is refused, by its first problem");
  const two = { ...mary, notes: mary.notes.slice(0, 3), lanes: { vibrato: [] }, marks: [] };
  check(refused(() => M.hocket(two, [{ voice: "2428", seed: 9 }, { voice: "6345", seed: 10 }]), /singer 3 of the hocket would sing nothing: 2 words for 3 singers/), "a singer left with nothing is refused");
  check(refused(() => M.hocket(mary, [{ voice: "2428", seed: 9 }], { pattern: [0, 2] }), /pattern \[0,2\]: singers 0 to 1/), "a pattern naming a singer there is not is refused");
}

// ---------------------------------------------------------------- divisi

{
  const n = (beat, beats, pitch, lyric = null) => ({ at: beat * G, ticks: beats * G, pitch, cents: 0, velocity: 80, release: 64, lyric });
  const chords = { ...P.blank(P.singer("6147", 3)), title: "Hymn", notes: P.sort([
    n(0, 1, "C4"), n(0, 1, "E4"), n(0, 1, "G4", "Glo-"),
    n(1, 1, "D4"), n(1, 1, "F4", "_"), n(1, 1, "B4", "_"),
    n(2, 2, "C4", "ry"), n(2, 2, "E4"), n(2, 2, "C5"),
    n(4, 1, "G4", "now"),
  ]), marks: [{ at: 4 * G, breath: true }] };
  const d = M.divisi(chords, [{ voice: "2428", seed: 9 }, { voice: "6345", seed: 10 }], { width: 1 });
  check(equal(d.map((s) => s.part.notes.map((x) => x.pitch)), [["G4", "B4", "C5", "G4"], ["E4", "F4", "E4"], ["C4", "D4", "C4"]]), "divisi: each chord dealt top to bottom, the lines left over resting");
  check(equal(d.map((s) => s.part.notes.map((x) => x.lyric)), [["Glo-", "_", "ry", "now"], ["Glo-", "_", "ry"], ["Glo-", "_", "ry"]]), "a note with no words takes those of the note above it that has them");
  check(d.every((s) => singable(s.part)) && equal(d.map((s) => s.pan), [-0.5, 0, 0.5]) && d[0].part.singer.seed === 3, "every line sung as written, the source on the top line");
  check(equal(d[0].part.marks, chords.marks) && equal(d[1].part.marks, []), "a breath goes to the lines it comes in a rest of");
  const held = { ...chords, notes: P.sort([n(0, 4, "C3", "ooh"), n(0, 1, "G4", "la"), n(1, 1, "A4", "la"), n(2, 2, "F4", "la"), n(2, 2, "A4", "la")]), marks: [] };
  check(equal(M.divisi(held, [{ voice: "2428", seed: 9 }, { voice: "6345", seed: 10 }]).map((s) => s.part.notes.map((x) => x.pitch)), [["G4", "A4", "A4"], ["C3"], ["F4"]]), "a note still held keeps its line: the next notes take the lines that are free");
  check(refused(() => M.divisi(chords, [{ voice: "2428", seed: 9 }]), /^beat 0: 3 notes sound together, and there are 2 lines/), "more notes at once than lines is refused by its beat");
  check(refused(() => M.divisi(chords, [9, 10, 11].map((seed) => ({ voice: "2428", seed }))), /line 4 would sing nothing: no more than 3 notes sound together/), "a line with nothing to sing is refused");
}

// ---------------------------------------------------------------- drone

{
  const dr = M.drone(mary, C, "ooh", "2428", 9);
  const first = Math.min(...mary.notes.map((x) => x.at)), last = Math.max(...mary.notes.map((x) => x.at + x.ticks));
  check(dr.notes.every((x) => x.pitch === "C4") && dr.notes[0].at === M.barLine(mary, first) && dr.notes.at(-1).at + dr.notes.at(-1).ticks === M.barLine(mary, last, true), "a drone: C4 at or below Mary's lowest note, from the bar its first note is in to the bar line after its last");
  check(dr.notes.every((x, i) => x.ticks === 4 * G && x.lyric === (i % 4 === 0 ? "ooh" : "_")) && equal(dr.marks.map((m) => m.at), dr.notes.filter((_, i) => i && i % 4 === 0).map((x) => x.at)), "a note a bar, the syllable again every 4 bars with a breath marked there");
  check(singable(dr) && equal(dr.lanes.vibrato, []) && dr.singer.sway === mary.singer.sway && dr.title === "Mary Had a Little Lamb, a drone on C", "it is sung, with the voice's own vibrato and the source's settings");
  check(M.drone(mary, C, "ah", "2428", 9, { on: "fifth" }).notes[0].pitch === "G3" && M.drone(mary, F, "ah", "2428", 9, { octave: 2 }).notes[0].pitch === "F2" && M.drone(mary, { tonic: 10, scale: "major" }, "ah", "2428", 9).notes[0].pitch === "Bb3", "on the fifth, in an octave given, spelled for the key");
  const one = M.drone(mary, C, "ooh", "2428", 9, { every: 0 });
  check(one.notes.filter((x) => x.lyric !== "_").length === 1 && one.marks.length === 0 && singable(one), "every 0: one syllable held throughout");
  check(refused(() => M.drone(mary, C, "Ah", "2428", 9), /"Ah": the engine spells out a word with a capital in it/) && refused(() => M.drone(mary, C, "hmm", "2428", 9), /"hmm": no vowel to sing on/), "a syllable the engine would spell, or that has no vowel, is refused");
  check(refused(() => M.drone({ ...mary, notes: [] }, C, "ooh", "2428", 9), /has no notes to hold a drone under/), "no notes, no drone");
}

// ---------------------------------------------------------------- vocables and stutter

{
  const bare = { ...twinkle, notes: twinkle.notes.map((x) => ({ ...x, lyric: null })) };
  const v = M.vocables(bare, "doo bah");
  check(v.notes.every((x, i) => x.lyric === (i % 2 ? "bah" : "doo")) && singable(v), "bare notes given doo and bah in turn: the part is sung");
  const some = { ...mary, notes: mary.notes.map((x, i) => (i >= 3 && i < 6 ? { ...x, lyric: null } : x)) };
  check(equal(M.vocables(some, ["la"]).notes.map((x) => x.lyric), mary.notes.map((x, i) => (i >= 3 && i < 6 ? "la" : x.lyric))), "only the notes with no words are given them");
  const all = M.vocables(grace, "ooh", { all: true });
  check(all.notes.every((x, i) => (grace.notes[i].lyric === "_" ? x.lyric === "_" : x.lyric.replace(/\/$/, "") === "ooh")) && all.notes.filter((x) => x.lyric === "ooh/").length === grace.notes.filter((x) => x.lyric.endsWith("/")).length && singable(all), "all: every syllable an ooh, held notes held, lines ending where they did");
  check(M.vocables(bare, "B I N G O", { letters: true }).notes[2].lyric === "N", "letters sung spelled when asked for");
  check(refused(() => M.vocables(bare, "Doo"), /"Doo": the engine spells out a word with a capital/) && refused(() => M.vocables(bare, "doo-"), /a scat syllable is one word/) && refused(() => M.vocables(bare, " "), /scat syllables, one at least/), "a capital, a word left open and nothing are refused");
  const open = { ...mary, notes: mary.notes.map((x, i) => (i === 1 ? { ...x, lyric: null } : x)) };
  check(refused(() => M.vocables(open, "la"), /^beat 5: the word before goes on to this note/), "a bare note that would end a word left open is refused by its beat");
  check(equal(M.vocables(mary, "la"), mary) && M.VOCABLES.every((s) => M.vocables(bare, s)), "a part with words already is as it was; every vocable of the list is one");

  const had = mary.notes[2], lamb = mary.notes[6];
  const st = M.stutter(mary, [had, lamb], 3);
  check(equal(st.notes.filter((x) => x.at >= had.at && x.at < had.at + had.ticks).map((x) => [x.ticks, x.lyric, x.pitch]), [[had.ticks / 3, "had", had.pitch], [had.ticks / 3, "had", had.pitch], [had.ticks / 3, "had", had.pitch]]), "stutter: had as had had had, a third of its length each");
  check(equal(st.notes.filter((x) => x.at >= lamb.at && x.at < lamb.at + lamb.ticks).map((x) => x.lyric), ["lamb,", "lamb,", "lamb,/"]) && singable(st), "the line's end on the last; the part still sung");
  check(refused(() => M.stutter(mary, [mary.notes[0]], 2), /"Ma-" is part of a longer word/) && refused(() => M.stutter(mary, [had], 7), /1 beats in 7 is not a whole number of ticks each/), "a syllable of a longer word, or a length that does not split, is refused");
  check(refused(() => M.stutter(mary, [{ ...had }], 2), /that is not the part's/), "a note that is not the part's is refused");
}

// ---------------------------------------------------------------- staggered breathing

{
  const sec = M.section(twinkle, 3, 1).map((s) => s.part);
  const st = M.stagger(sec, 1);
  const rests = [8, 16, 24, 32, 40].map((b) => b * twinkle.grid);
  check(rests.every((t) => st.filter((p) => p.marks.some((m) => m.at === t && !m.breath)).length === 3), "at every rest three of the four are marked not to breathe");
  check(equal(rests.map((t) => st.findIndex((p) => !p.marks.some((m) => m.at === t))), [0, 1, 2, 3, 0]), "and the one left to breathe is each in turn");
  check(st.every(singable) && st.every((p, i) => equal(p.notes, sec[i].notes) && equal(p.singer, sec[i].singer)), "every singer still sung, its notes and settings as they were");
  const gs = M.stagger(M.section(grace, 2, 1).map((s) => s.part), 2);
  const after = [14, 26, 38].map((b) => b * grace.grid).map((t) => gs.filter((p) => p.marks.some((m) => m.at === t && m.breath)).length);
  check(equal(after, [2, 2, 2]) && gs.every(singable), "a breath marked on a word with no rest before it stays with as many as may breathe");
  const one = M.stagger(M.section(grace, 2, 1).map((s) => s.part), 1);
  check(equal([14, 26, 38].map((b) => one.filter((p) => p.marks.some((m) => m.at === b * grace.grid && m.breath)).length), [1, 1, 1]) && one.every(singable), "and with one at a time, the others lose it");
  check(refused(() => M.stagger([mary, M.canon(mary, G, 0, "2428", 9)], 1), /singer 2: its notes at beat 4 are not the first's/), "singers who do not sing together are refused");
  check(refused(() => M.stagger(sec, 4), /4 breathing at once of 4: 1 to 3/), "all of them breathing at once is no stagger");
}

check(JSON.stringify([mary, twinkle, grace, row, every]) === frozen, "no source part was changed by anything made from it");

console.log(fails ? `\n${fails} failed` : "\nall ok");
process.exit(fails ? 1 : 0);
