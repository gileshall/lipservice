// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// shape.js: the tools that reshape chosen notes, each leaving a part the text holds and words
// sung as they were, or refused by beat. node shape_test.mjs
import assert from "node:assert/strict";
import * as P from "./part.js";
import * as T from "./theory.js";
import * as S from "./song.js";
import * as X from "./shape.js";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const G = 960;
const C = T.read("C major");

// a part at 120 from notes "start beats pitch [syllable]"
function make(...lines) {
  const p = P.blank(P.singer("6147", 3));
  p.notes = P.sort(lines.map((l) => {
    const [at, len, pitch, lyric] = l.split(" ");
    const [name, cents] = P.pitched(pitch);
    return { at: P.ticks(at, G), ticks: P.ticks(len, G), pitch: name, cents, velocity: 90, release: 64, lyric: lyric ?? null };
  }));
  P.check(p);
  return p;
}
const brief = (notes) => notes.map((n) => `${P.beat(n.at, G)}+${P.beat(n.ticks, G)} ${P.pitch(n)}${n.lyric === null ? "" : ` ${n.lyric}`}`);
const words = (p) => S.words(p).words.map((w) => w.text);
const sung = (p) => S.problems(p).length === 0;
// a tool run on a copy, the part given checked to be as it was
function run(tool, p, picked, o) {
  const was = structuredClone(p), r = tool(p, picked, o);
  if (!equal(p, was)) throw new Error("the part given was changed");
  return r;
}
// a tool run on all the notes of a part made from `lines`
const each = (tool, lines, o) => { const p = make(...lines); return run(tool, p, p.notes, o); };
const mary = () => make("0 1 E4 Ma-", "1 1 D4 ry", "2 1 C4 had", "3 1 D4 a", "4 1 E4 lit-", "5 1 E4 tle", "6 2 E4 lamb,/");

// ---------------------------------------------------------------- options

{
  const o = X.options(G), tools = ["quantize", "legato", "gate", "split", "splitAt", "join", "reverse", "invert", "scaleStep", "transpose", "scaleTime", "ornament", "run", "arpeggiate", "swell"];
  check(equal(Object.keys(o), tools) && tools.every((t) => typeof X[t] === "function"), "every tool has its options, and every option set its tool");
  const fields = Object.values(o).flatMap((t) => t.fields);
  check(Object.values(o).every((t) => t.label && t.said) && fields.every((f) => f.name && f.label && f.said && "default" in f), "each tool and each option has its words and a default");
  const nums = fields.filter((f) => f.kind === "number");
  check(nums.every((f) => f.min <= f.default && f.default <= f.max && f.step > 0 && typeof f.unit === "string") && nums.length > 20, "each number has a range its default is in, a step and a unit word");
  check(fields.filter((f) => f.kind === "choice").every((f) => f.choices.includes(f.default)), "each choice's default is one of its choices");
  check(o.ornament.fields.find((f) => f.name === "rate").default === 120 && o.arpeggiate.fields.find((f) => f.name === "rate").default === 240 && X.options(96).arpeggiate.fields.find((f) => f.name === "rate").default === 24, "rates in ticks for the grid: a 32nd for an ornament, a 16th for an arpeggio");
  const low = o.swell.fields.find((f) => f.name === "low");
  check(low.min > 0, "the vibrato shape's least size is above 0");
  const p = mary();
  check(/quantize has no strenght: it takes step, strength/.test(threw(() => X.quantize(p, p.notes, { strenght: 1 }))), "a misspelt option is refused, the options named");
  check(threw(() => X.gate(p, p.notes, { fraction: 0 })) === "gate: fraction 0: 0.05 to 1", "an option outside its range is refused, its range named");
  check(threw(() => X.split(p, p.notes, { n: 2.5 })) === "split: n 2.5: a whole number" && /one of up, down/.test(threw(() => X.arpeggiate(p, p.notes, { pattern: "sideways" }))), "a whole number and a choice checked");
  check(/a key is a tonic/.test(threw(() => X.transpose(p, p.notes, { key: { tonic: 0, scale: "ionian" } }))), "a key that is no key is refused");
  check(threw(() => X.gate(p, [], {})) === "no notes chosen" && /not one of the part's/.test(threw(() => X.gate(p, [{ ...p.notes[0] }], {}))), "no notes, or a note not the part's, refused");
}

// ---------------------------------------------------------------- time

// quantize
{
  const p = make("0.05 0.9 C4 la", "1.1 0.8 D4 la", "1.95 1.1 E4 la", "3.025 0.5 F4 la");
  const r = run(X.quantize, p, p.notes, { step: G });
  check(equal(brief(r.notes), ["0+0.9 C4 la", "1+0.8 D4 la", "2+1.1 E4 la", "3+0.5 F4 la"]) && r.part.notes.length === 4, "starts drawn to the beat, the lengths as they were");
  const h = run(X.quantize, p, p.notes, { step: G, strength: 0.5 });
  check(equal(h.notes.map((n) => n.at), [24, 1008, 1896, 2892]), "at half strength, half the way");
  const l = run(X.quantize, p, p.notes, { step: G / 2, starts: false, lengths: true });
  check(equal(brief(l.notes), ["0.05+1 C4 la", "1.1+1 D4 la", "1.95+1 E4 la", "3.025+0.5 F4 la"]), "lengths made whole steps, a step at least, the starts left");
  const sw = make("0 0.4 C4 la", "0.5 0.4 D4 la", "1 0.4 E4 la", "1.55 0.4 F4 la");
  const s = run(X.quantize, sw, sw.notes, { step: G / 2, swing: 1 / 3 });
  check(equal(s.notes.map((n) => n.at), [0, 640, 960, 1600]), "swing: every second half beat a third of it later");
  const two = make("0 0.4 C4 a", "0.3 0.4 D4 b");
  check(threw(() => X.quantize(two, two.notes, { step: G })) === "beat 0: two notes would start together, and a singer sings one at a time", "two notes drawn to one start refused, the beat named");
  const cross = make("0 0.5 C4 a", "1.1 0.5 D4 b", "1.2 0.5 E4 c");
  check(threw(() => X.quantize(cross, [cross.notes[2]], { step: G })) === "beat 1: the words would be out of order", "a note drawn past another is refused");
  const marked = { ...make("0 1 C4 a", "2.1 1 D4 b"), marks: [{ at: P.ticks("2.1", G), breath: true }] };
  const m = run(X.quantize, marked, [marked.notes[1]], { step: G });
  check(equal(m.part.marks, [{ at: 2 * G, breath: true }]) && sung(m.part), "a breath marked on a note's start goes with it");
  const chord = make("0.1 1 C4", "0.1 1 E4");
  check(equal(brief(run(X.quantize, chord, chord.notes, { step: G }).part.notes), ["0+1 C4", "0+1 E4"]), "notes that started together may land together");
}

// legato and gate
{
  const p = make("0 0.5 C4 la", "1 0.5 D4 la", "1.25 1 E4 la", "8 1 F4 la");
  const r = run(X.legato, p, p.notes, { within: 4 });
  check(equal(brief(r.part.notes), ["0+1 C4 la", "1+0.25 D4 la", "1.25+1 E4 la", "8+1 F4 la"]), "each runs to the next start; a rest longer than 4 beats kept; the last as it was");
  check(r.notes.length === 4 && r.notes[3] === p.notes[3], "the notes left alone are the same notes");
  check(run(X.legato, p, p.notes, {}).part.notes[2].ticks === 6.75 * G, "by default rests of up to 16 beats are closed");
  const g = run(X.gate, p, p.notes, { fraction: 0.5 });
  check(equal(brief(g.part.notes), ["0+0.25 C4 la", "1+0.25 D4 la", "1.25+0.5 E4 la", "8+0.5 F4 la"]), "gate halves each note");
  const short = make("0 0.0625 C4 la", "1 1 D4 la");
  check(threw(() => X.gate(short, short.notes, { fraction: 0.1 })) === "beat 0: a note 3 ms long; a singer needs 30 ms at least to sing one", "a note made shorter than the singer can sing is refused, the beat named");
}

// split and join
{
  const p = mary();
  const r = run(X.split, p, [p.notes[0], p.notes[6]], { n: 3 });
  check(equal(brief(r.part.notes.slice(0, 3)), ["0+0.333333 E4 Ma-", "0.333333+0.333333 E4 _", "0.666667+0.333333 E4 _"]) && r.notes.length === 6, "a note in three: the syllable, then held twice; all six chosen");
  check(equal(brief(r.part.notes.slice(-3)), ["6+0.666667 E4 lamb,/", "6.666667+0.666667 E4 _", "7.333333+0.666667 E4 _"]), "a line's end stays on its syllable");
  check(equal(words(r.part), words(p)) && sung(r.part), "the words sung as before");
  const bare = run(X.split, p, [p.notes[1]], { n: 2, held: false });
  check(equal(brief(bare.notes), ["1+0.5 D4 ry", "1.5+0.5 D4"]), "split with no words for the notes after");
  const at = run(X.splitAt, p, p.notes, { at: P.ticks("6.5", G) });
  check(equal(brief(at.notes), ["6+0.5 E4 lamb,/", "6.5+1.5 E4 _"]), "split at a tick: only the note across it");
  check(threw(() => X.splitAt(p, p.notes, { at: G })) === "beat 1: no chosen note sounds across it", "a tick no note sounds across refused");
  check(threw(() => each(X.split, ["0 0.001042 C4"], {})) !== null, "a note of a tick is not split");
  const j = run(X.join, r.part, r.part.notes.slice(0, 3), {});
  check(equal(brief(j.part.notes), brief(p.notes.slice(0, 6)).concat(brief(r.part.notes.slice(-3)))) && equal(words(j.part), words(p)), "the three joined back into one, the syllable kept");
  const rel = make("0 1 C4 la", "1 1 C4 _", "2 1 C4 _");
  rel.notes[2] = { ...rel.notes[2], release: 10 };
  const jr = run(X.join, rel, rel.notes, {});
  check(jr.notes.length === 1 && jr.notes[0].ticks === 3 * G && jr.notes[0].release === 10 && jr.notes[0].velocity === 90, "joined: the first's loudness, the last's release");
  check(threw(() => X.join(p, [p.notes[4], p.notes[5]], {})) === "beat 5: \"tle\" is a syllable of its own, and joined it would be lost", "a join that would lose a syllable is refused");
  check(threw(() => X.join(p, [p.notes[0], p.notes[1]], {})) === "nothing to join: choose notes on one key, one after another", "notes on two keys are not joined");
  const between = make("0 1 C4 la", "1 1 D4 _", "2 1 C4 _");
  check(/nothing to join/.test(threw(() => X.join(between, [between.notes[0], between.notes[2]], {}))), "nor where another note starts between");
}

// reverse
{
  const p = make("0 1 C4 Ma-", "1 0.5 D4 _", "1.5 0.5 E4 ry", "3 1 G4 had");
  const r = run(X.reverse, p, p.notes, {});
  check(equal(brief(r.part.notes), ["0+1 G4 Ma-", "2+0.5 E4 _", "2.5+0.5 D4 ry", "3+1 C4 had"]), "the rhythm and keys backward, the syllables in reading order");
  check(equal(words(r.part), words(p)) && sung(r.part), "the words sung as before");
  const k = run(X.reverse, p, p.notes, { keys: true });
  check(equal(brief(k.part.notes), ["0+1 G4 Ma-", "1+0.5 E4 _", "1.5+0.5 D4 ry", "3+1 C4 had"]), "keys only: the rhythm and words kept");
  const m = { ...p, marks: [{ at: 3 * G, breath: true }] };
    check(threw(() => X.reverse(m, m.notes, {})) === "beat 2: the mark is in no rest and on no word's first note; the part would not be sung", "a mark whose rest comes inside a word is refused, as the singer would refuse it");
  const words2 = { ...make("0 1 C4 a", "1 0.5 D4 b", "3 1 E4 c"), marks: [{ at: 3 * G, breath: true }] };
  const rw = run(X.reverse, words2, words2.notes, {});
  check(equal(brief(rw.part.notes), ["0+1 E4 a", "2.5+0.5 D4 b", "3+1 C4 c"]) && equal(rw.part.marks, [{ at: P.ticks("2.5", G), breath: true }]) && sung(rw.part), "a mark in a rest goes with the rest");
  check(threw(() => X.reverse(p, [p.notes[0]], {})) === "reverse: choose two notes or more", "one note is not reversed");
}

// invert, step in key, transpose
{
  const p = make("0 1 C4 a", "1 1 E4-14 b", "2 1 G4 c");
  const r = run(X.invert, p, p.notes, {});
  check(equal(brief(r.part.notes), ["0+1 C4 a", "1+1 Ab3+14 b", "2+1 F3 c"]) && r.notes.length === 3, "mirrored about the first note by semitones, the cents mirrored too");
  const k = run(X.invert, p, p.notes, { key: C, axis: 64 });
  check(equal(brief(k.part.notes), ["0+1 G4 a", "1+1 E4+14 b", "2+1 C4 c"]), "mirrored about E4 along C major's scale, the cents mirrored");
  check(/^beat 0: C#4 is not in C major/.test(threw(() => X.invert(p, p.notes, { key: C, axis: 61 }))), "an axis off the scale refused, the beat named");
  check(threw(() => each(X.invert, ["0 1 C9 a", "1 1 C0 b"], { axis: 120 })) === "beat 1: C0 would go past MIDI's keys, C-1 to G9", "a mirror past the keys refused");
}
{
  const p = make("0 1 C4 a", "1 1 B4-20 b", "2 1 C#4 c");
  const s = run(X.scaleStep, p, p.notes, { key: C, steps: 2 });
  check(equal(brief(s.part.notes), ["0+1 E4 a", "1+1 D5-20 b", "2+1 F4 c"]), "two steps up C major's scale; a note off it keeps its offset, the cents kept");
  check(threw(() => X.scaleStep(p, p.notes, {})) === "step in key: choose a key", "a step in key needs a key");
  const top = make("0 1 F9 a");
  check(threw(() => X.scaleStep(top, top.notes, { key: C, steps: 3 })) === "beat 0: F9 up 3 steps in C major: past MIDI's keys, C-1 to G9", "past the keys refused, the beat named");
  const b = make("0 1 Bb4 a");
  const up = run(X.transpose, b, b.notes, { semitones: 1 }), back = run(X.transpose, up.part, up.notes, { semitones: -1 });
  check(back.notes[0].pitch === "Bb4" && up.notes[0].pitch === "B4", "Bb4 up a key and back is Bb4");
  const f = each(X.transpose, ["0 1 C4 a"], { semitones: 10, key: T.read("F major") });
  check(f.notes[0].pitch === "Bb4", "named for the key given");
  check(/^beat 0: G9 moved 1: past MIDI's keys/.test(threw(() => each(X.transpose, ["0 1 G9 a"], { semitones: 1 }))), "transposed past the keys refused");
}

// double and half time
{
  const p = make("0 1 C4 x", "1 0.5 D4 Ma-", "1.5 0.5 E4 ry", "2 1 F4 had", "4 1 G4 a");
  const d = run(X.scaleTime, p, [p.notes[1], p.notes[2]], { by: "2", ripple: true });
  check(equal(brief(d.part.notes), ["0+1 C4 x", "1+1 D4 Ma-", "2+1 E4 ry", "3+1 F4 had", "5+1 G4 a"]) && d.notes.length === 2, "double time from the first chosen note, the notes after pushed along");
  check(equal(words(d.part), words(p)) && sung(d.part), "the words as before");
  check(threw(() => X.scaleTime(p, [p.notes[1], p.notes[2]], { by: "2" })) === "beat 2: two notes would start together, and a singer sings one at a time", "not pushed along, a note landing on another's start is refused");
  const h = run(X.scaleTime, p, p.notes, { by: "1/2" });
  check(equal(brief(h.part.notes), ["0+0.5 C4 x", "0.5+0.25 D4 Ma-", "0.75+0.25 E4 ry", "1+0.5 F4 had", "2+0.5 G4 a"]), "half time");
  const odd = make("0 0.001042 C4 a", "1 1 D4 b");
  check(/off a whole tick/.test(threw(() => X.scaleTime(odd, odd.notes, { by: "1/2" }))), "a length off a whole tick refused");
  const lanes = { ...p, lanes: { vibrato: [{ at: 0, value: 1, line: false }, { at: G, value: 0.5, line: false }, { at: 3 * G, value: 2, line: true }] }, marks: [{ at: 4 * G, breath: true }] };
  const lr = run(X.scaleTime, lanes, [lanes.notes[1], lanes.notes[2]], { by: "2", ripple: true });
  check(equal(lr.part.lanes.vibrato.map((q) => q.at / G), [0, 1, 4]) && equal(lr.part.marks, [{ at: 5 * G, breath: true }]), "pushed along: the vibrato and the marks after move too");
  const tt = each(X.scaleTime, ["0 1 C4 a", "1 1 D4 b", "2 1 E4 c"], { by: "2/3" });
  check(equal(tt.part.notes.map((n) => [n.at, n.ticks]), [[0, 640], [640, 640], [1280, 640]]), "two thirds the time on a grid of 960");
}

// ---------------------------------------------------------------- ornaments

{
  const p = make("0 1 C4 the", "1 1 E4 Ma-", "2 1 D4 ry");
  const o = (kind, more = {}) => run(X.ornament, p, [p.notes[1]], { kind, key: C, ...more });
  const t = o("trill");
  check(equal(brief(t.notes), ["1+0.125 E4 Ma-", "1.125+0.125 F4 _", "1.25+0.125 E4 _", "1.375+0.125 F4 _", "1.5+0.125 E4 _", "1.625+0.125 F4 _", "1.75+0.25 E4 _"]), "a trill on the scale note above, ending on the note");
  const same = (r) => r.part.notes[0] === p.notes[0] && r.part.notes.at(-1) === p.notes[2] && words(r.part).join(" ") === words(p).join(" ") && sung(r.part);
  check(same(t), "nothing else moved, the words sung as before");
  check(equal(brief(o("trill", { span: 0.5 }).notes), ["1+0.125 E4 Ma-", "1.125+0.125 F4 _", "1.25+0.75 E4 _"]), "a trill over half the note");
  check(equal(brief(o("upper mordent").notes), ["1+0.125 E4 Ma-", "1.125+0.125 F4 _", "1.25+0.75 E4 _"]) && equal(brief(o("lower mordent").notes), ["1+0.125 E4 Ma-", "1.125+0.125 D4 _", "1.25+0.75 E4 _"]), "upper and lower mordents");
  check(equal(brief(o("turn").notes), ["1+0.125 F4 Ma-", "1.125+0.125 E4 _", "1.25+0.125 D4 _", "1.375+0.625 E4 _"]) && same(o("turn")), "a turn");
  const a = o("appoggiatura");
  check(equal(brief(a.notes), ["1+0.5 F4 Ma-", "1.5+0.5 E4 _"]) && equal(brief(o("appoggiatura", { below: true, lean: 0.25 }).notes), ["1+0.25 D4 Ma-", "1.25+0.75 E4 _"]), "an appoggiatura on the beat, from above or below");
  const g = o("grace");
  check(equal(brief(g.part.notes), ["0+0.875 C4 the", "0.875+0.125 F4 Ma-", "1+1 E4 _", "2+1 D4 ry"]) && sung(g.part) && equal(words(g.part), words(p)), "a grace note before the beat, its time from the note before, the syllable on it");
  check(threw(() => X.ornament(p, [p.notes[0]], { kind: "grace" })) === "beat 0: no room before the part's start for a grace note", "a grace note with no room before it refused");
  const tight = make("0 0.25 C4 a", "0.25 1 E4 b");
  check(threw(() => X.ornament(tight, [tight.notes[1]], { kind: "grace", rate: 230 })) === "beat 0: a note 5 ms long; a singer needs 30 ms at least to sing one", "nor where the note before has no time to give");
  const close = make("0 0.25 C4 a", "0.125 0.125 D4 _", "0.25 1 E4 b");
  check(threw(() => X.ornament(close, [close.notes[2]], { kind: "grace", rate: 120 })) === "beat 0.25: no room for a grace note: the note at beat 0.125 starts in its time", "nor where a note starts in the grace note's time");
  const m = { ...p, marks: [{ at: G, breath: true }] };
  check(equal(run(X.ornament, m, [m.notes[1]], { kind: "grace", key: C }).part.marks, [{ at: P.ticks("0.875", G), breath: true }]), "a breath marked on the note goes to the grace note, where the word now starts");
  check(equal(brief(o("slide").notes), ["1+0.125 C#4 Ma-", "1.125+0.125 D4 _", "1.25+0.125 Eb4 _", "1.375+0.625 E4 _"]), "a slide up into the note, spelled in the key");
  check(equal(brief(o("fall", { slide: -2 }).notes), ["1+0.75 E4 Ma-", "1.75+0.125 Eb4 _", "1.875+0.125 D4 _"]), "a fall off the note's end");
  const bare = run(X.ornament, p, [p.notes[1]], { kind: "upper mordent", width: 1 });
  check(equal(brief(bare.notes).map((s) => s.split(" ")[1]), ["E4", "F4", "E4"]) && equal(brief(run(X.ornament, p, [p.notes[1]], { kind: "upper mordent" }).notes).map((s) => s.split(" ")[1]), ["E4", "F#4", "E4"]), "with no key, a neighbour a whole step off or a half step, as chosen");
  check(threw(() => X.ornament(p, [p.notes[1]], { kind: "turn", rate: 300 })) === "beat 1: a turn at 300 ticks a note needs 1200 ticks, and the note is 960", "an ornament that does not fit refused, the beat named");
  check(threw(() => X.ornament(p, [p.notes[1]], { kind: "trill", rate: 20 })) === "beat 1: a note 10 ms long; a singer needs 30 ms at least to sing one", "an ornament too fast to sing refused");
  const all = run(X.ornament, p, p.notes.slice(1), { kind: "upper mordent", key: C });
  check(all.notes.length === 6 && sung(all.part) && equal(words(all.part), words(p)), "an ornament on each chosen note");
  const cents = make("0 1 E4-14 la");
  check(equal(brief(run(X.ornament, cents, cents.notes, { kind: "upper mordent", key: C }).notes), ["0+0.125 E4-14 la", "0.125+0.125 F4 _", "0.25+0.75 E4-14 _"]), "the note keeps its cents; the note beside it is plain");
  const inside = make("0 2 E4 la", "1.0625 1 G4 lo");
  check(threw(() => X.ornament(inside, [inside.notes[0]], { kind: "trill", key: C })) === "beat 1.125: the note at beat 1.0625 comes between, and \"la\" would not be held here", "an ornament over a note that starts inside it refused");
  const on = make("0 2 E4 la", "1 1 G4 lo");
  check(threw(() => X.ornament(on, [on.notes[0]], { kind: "trill", key: C })) === "beat 1: two notes would start together, and a singer sings one at a time", "and where a note of it would start with another");
}

// runs
{
  const p = make("0 1 C4 run-", "1 1 G4 ning");
  const r = run(X.run, p, p.notes, { key: C });
  check(equal(brief(r.notes), ["0+0.625 C4 run-", "0.625+0.125 D4 _", "0.75+0.125 E4 _", "0.875+0.125 F4 _"]) && r.part.notes[4] === p.notes[1], "a run up C major's scale in the first note's end");
  check(equal(words(r.part), words(p)) && sung(r.part), "sung on the first's syllable");
  const w = run(X.run, p, p.notes, { key: C, whole: true });
  check(equal(w.notes.map((n) => [n.at, n.ticks, n.pitch]), [[0, 240, "C4"], [240, 240, "D4"], [480, 240, "E4"], [720, 240, "F4"]]), "or sharing the note's whole length");
  const down = make("0 1 G4 a", "1 1 C4 b");
  check(equal(run(X.run, down, down.notes, { key: T.read("C minor") }).notes.map((n) => n.pitch), ["G4", "F4", "Eb4", "D4"]), "down C minor's scale, spelled for it");
  check(threw(() => X.run(p, p.notes, {})) === "a run goes along a key's scale: choose a key" && threw(() => each(X.run, ["0 1 C4 a", "1 1 D4 b"], { key: C })) === "no key of the scale lies between the chosen notes", "a run needs a key and a key between");
  check(threw(() => X.run(p, p.notes, { key: C, rate: 400 })) === "beat 0: a run of 3 at 400 ticks a note needs more than 1200 ticks, and the note is 960", "a run that does not fit refused");
}

// ---------------------------------------------------------------- arpeggios

{
  const p = make("0 2 C4 ah", "0 2 E4", "0 2 G4", "2 1 F4 oh");
  const line = (o) => run(X.arpeggiate, p, p.notes.slice(0, 3), { rate: 240, ...o });
  const keys = (r) => r.notes.map((n) => n.pitch).join(" ");
  const u = line({});
  check(keys(u) === "C4 E4 G4 C4 E4 G4 C4 E4" && u.notes.every((n, i) => n.at === i * 240 && n.ticks === 240), "up: a note each step through the chord");
  check(equal(u.notes.map((n) => n.lyric), ["ah", "_", "_", "_", "_", "_", "_", "_"]) && sung(u.part) && equal(words(u.part), ["ah", "oh"]), "the chord's syllable on the first, the rest holding it");
  check(keys(line({ pattern: "down" })) === "G4 E4 C4 G4 E4 C4 G4 E4", "down");
  check(keys(line({ pattern: "up and down" })) === "C4 E4 G4 E4 C4 E4 G4 E4" && keys(line({ pattern: "down and up" })) === "G4 E4 C4 E4 G4 E4 C4 E4", "up and down, down and up");
  check(keys(line({ pattern: "outside in", octaves: 2 })) === "C4 G5 E4 E5 G4 C5 C4 G5", "outside in over two octaves");
  check(keys(line({ pattern: "digits", digits: "1 3 2 4", octaves: 2 })) === "C4 G4 E4 C5 C4 G4 E4 C5", "the digits' order");
  check(threw(() => line({ pattern: "digits", digits: "1 5" })) === "beat 0: 5 in the digits: the chord has 3 notes" && /the digits are/.test(threw(() => line({ pattern: "digits", digits: "1 x" }))), "digits past the chord, or not digits, refused");
  const r1 = line({ pattern: "random", seed: 7 }), r2 = line({ pattern: "random", seed: 7 }), r3 = line({ pattern: "random", seed: 8 });
  check(keys(r1) === keys(r2) && keys(r1) !== keys(r3), "random: the same seed the same line, another seed another");
  check(r1.notes.every((n, i) => i === 0 || n.pitch !== r1.notes[i - 1].pitch), "random: no key twice running");
  const rolled = make("0 2 E4 ah", "0.25 1.75 C4", "0.5 1.5 G4");
  check(keys(run(X.arpeggiate, rolled, rolled.notes, { rate: 480, pattern: "as written" })) === "E4 C4 G4 E4", "as written: in the order the notes start");
  const gt = line({ gate: 0.5 });
  check(gt.notes.every((n) => n.ticks === 120), "gate shortens each note");
  const rest = run(X.arpeggiate, p, p.notes.slice(0, 3), { rate: 600 });
  check(equal(rest.notes.map((n) => [n.at, n.ticks]), [[0, 600], [600, 600], [1200, 720]]), "the last note runs to the chord's end");
  const lone = make("0 1 D4 la", "1 1 F4 li");
  const ch = run(X.arpeggiate, lone, [lone.notes[0]], { rate: 240, chord: "triad", key: C });
  check(keys(ch) === "D4 F4 A4 D4" && ch.part.notes.at(-1) === lone.notes[1], "a note alone given its triad in C major first");
  check(keys(run(X.arpeggiate, lone, [lone.notes[0]], { rate: 240, octaves: 2 })) === "D4 D5 D4 D5", "a note alone with no chord: its octaves");
  check(threw(() => X.arpeggiate(lone, [lone.notes[0]], { chord: "triad" })) === "a triad on a note alone is built in a key: choose a key", "a chord with no key refused");
  const two = make("0 1 C4 la", "0 1 E4 lo");
  check(threw(() => X.arpeggiate(two, two.notes, {})) === "beat 0: the chord's notes carry \"la\" and \"lo\"; a line sings one syllable", "a chord of two syllables refused");
  const hi = make("0 1 C9 la", "0 1 G9");
  check(threw(() => X.arpeggiate(hi, hi.notes, { octaves: 2 })) === "beat 0: 2 octaves of the chord go past MIDI's keys, C-1 to G9", "octaves past the keys refused");
  check(threw(() => X.arpeggiate(p, p.notes.slice(0, 3), { rate: 8 })) === "beat 0: a note 4 ms long; a singer needs 30 ms at least to sing one", "a line too fast to sing refused");
  const sep = make("0 1 C4 a", "0 1 E4", "1 1 D4 b", "1 1 F4");
  const both = run(X.arpeggiate, sep, sep.notes, { rate: 480 });
  check(keys(both) === "C4 E4 D4 F4" && sung(both.part) && equal(words(both.part), ["a", "b"]), "two chords, two lines");
  const cents = make("0 1 E4-14 la", "0 1 C4");
  check(equal(brief(run(X.arpeggiate, cents, cents.notes, { rate: 480, octaves: 2 }).notes), ["0+0.5 C4 la", "0.5+0.5 E4-14 _"]) && each(X.arpeggiate, ["0 2 Bb3 la"], { rate: 480, octaves: 2 }).notes[1].pitch === "Bb4", "each note keeps its key's cents and its spelling an octave up");
}

// ---------------------------------------------------------------- the vibrato

{
  const p = make("0 1 C4 a", "1 2 D4 b", "3 2 E4 c", "5 0.5 F4 d");
  const pts = (r) => r.part.lanes.vibrato.map((q) => `${P.beat(q.at, G)} ${q.value}${q.line ? " line" : ""}`);
  const s = run(X.swell, p, [p.notes[1]], {});
  check(equal(pts(s), ["1 0.2", "2 1 line", "3 0.2 line", "3 1"]) && s.notes[0] === p.notes[1], "a swell from little to full and back, then the vibrato as it stood");
  check(equal(pts(run(X.swell, p, [p.notes[1]], { shape: "late", at: 0.25, low: 0.3, top: 1.5 })), ["1 0.3", "1.5 1.5", "3 1"]), "late: held small, then in");
  check(equal(pts(run(X.swell, p, [p.notes[1]], { shape: "fade", at: 0.75 })), ["1 1", "2.5 1", "3 0.2 line", "3 1"]), "fade: full, then fading");
  const both = run(X.swell, p, p.notes, {});
  check(equal(pts(both), ["0 0.2", "0.5 1 line", "1 0.2 line", "1 0.2", "2 1 line", "3 0.2 line", "3 0.2", "4 1 line", "5 0.2 line", "5 1"]), "notes one after another: each shaped, the note under a beat left");
  check(both.part.lanes.vibrato.every((q) => q.value > 0), "never 0");
  const drawn = { ...p, singer: { ...p.singer, motion: null }, lanes: { vibrato: [{ at: 0, value: 0.5, line: false }, { at: P.ticks("1.5", G), value: 0.8, line: false }, { at: 4 * G, value: 1.2, line: true }] } };
  const d = run(X.swell, drawn, [drawn.notes[1]], {});
  check(equal(pts(d), ["0 0.5", "1 0.2", "2 1 line", "3 0.2 line", "3 1.04", "4 1.2 line"]) && S.song(d.part).text.includes("vibrato"), "points inside the note replaced; a line running past the note goes on from where it stood");
  check(threw(() => X.swell(p, [p.notes[3]], {})) === "none of the chosen notes is 1 beat long or more", "notes too short for the shape refused");
  const over = make("0 2 C4 a", "1 2 E4");
  check(threw(() => X.swell(over, over.notes, {})) === "beat 1: two chosen notes sound at once, and the vibrato is one line", "notes sounding at once refused");
}

// every result reads back from its text
{
  const p = mary();
  const results = [
    X.quantize(p, p.notes, { step: G / 2 }), X.legato(p, p.notes, {}), X.gate(p, p.notes, {}), X.split(p, p.notes, {}),
    X.reverse(p, p.notes, {}), X.invert(p, p.notes, { key: C }), X.scaleStep(p, p.notes, { key: C, steps: -2 }), X.transpose(p, p.notes, { semitones: 3 }),
    X.scaleTime(p, p.notes, { by: "3/2" }), X.ornament(p, p.notes, { kind: "turn", key: C }), X.run(p, [p.notes[2], p.notes[4]], { key: C }), X.arpeggiate(p, p.notes, { octaves: 2 }), X.swell(p, p.notes, { least: 0 }),
  ];
  check(results.every((r) => equal(P.read(P.write(r.part)), r.part)), "every tool's part written and read back is itself");
  check(results.every((r) => sung(r.part) && equal(words(r.part), words(p))), "and sung with the same words");
}

console.log(fails ? `${fails} failed` : "all ok");
process.exit(fails ? 1 : 0);
