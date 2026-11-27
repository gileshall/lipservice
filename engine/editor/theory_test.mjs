// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// theory.js: keys and scales, steps along them, spelling, chords, and the key notes are in.
// node theory_test.mjs
import assert from "node:assert/strict";
import * as P from "./part.js";
import * as T from "./theory.js";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const K = (text) => T.read(text);
const C = K("C major"), Am = K("A minor"), F = K("F major"), B = K("B major");
const ALL = T.SCALE_NAMES.flatMap((scale) => Array.from({ length: 12 }, (_, tonic) => ({ tonic, scale })));
const spelled = (key, ks) => ks.map((k) => T.spell(key, k));

// the scales
{
  check(equal(T.SCALE_NAMES, ["major", "natural minor", "harmonic minor", "melodic minor", "dorian", "phrygian", "lydian", "mixolydian", "locrian", "major pentatonic", "minor pentatonic", "blues", "whole tone", "chromatic"]), "fourteen scales, in the order a person picks from them");
  check(T.SCALE_NAMES.every((n) => { const s = T.SCALES[n].steps; return s[0] === 0 && s.every((x, i) => i === 0 || x > s[i - 1]) && s.at(-1) < 12; }), "each scale's steps rise from the tonic within an octave");
  const notes = (key) => Array.from({ length: 12 }, (_, i) => 60 + i).filter((k) => T.inKey(key, k));
  check(equal(notes(C), [60, 62, 64, 65, 67, 69, 71]), "C major's keys from C4");
  check(equal(notes(K("D dorian")), [60, 62, 64, 65, 67, 69, 71]) && equal(notes(Am), notes(C)), "D dorian and A minor have C major's keys");
  check(equal(notes(K("A harmonic minor")), [60, 62, 64, 65, 68, 69, 71]), "A harmonic minor raises its seventh");
  check(equal(notes(K("A melodic minor")), [60, 62, 64, 66, 68, 69, 71]), "A melodic minor its sixth and seventh");
  check(equal(notes(K("C blues")), [60, 63, 65, 66, 67, 70]) && equal(notes(K("C whole tone")), [60, 62, 64, 66, 68, 70]) && notes(K("C chromatic")).length === 12, "blues, whole tone, chromatic");
  check(equal(T.degree(C, 64), { degree: 2, offset: 0 }) && equal(T.degree(C, 61), { degree: 0, offset: 1 }) && equal(T.degree(K("D minor"), 50), { degree: 0, offset: 0 }), "a key's degree and its offset off the scale");
  check(/0 to 11/.test(threw(() => T.inKey({ tonic: 12, scale: "major" }, 60))) && /a scale: major/.test(threw(() => T.inKey({ tonic: 0, scale: "ionian" }, 60))), "a key with no such tonic or scale is refused, the scales named");
  check(threw(() => T.inKey(C, 128)) === "key 128: 0 to 127" && threw(() => T.inKey(C, 60.5)) === "key 60.5: 0 to 127", "and a key off MIDI's");
}

// names of keys, read back
{
  const n = (tonic, scale) => T.names({ tonic, scale });
  check(n(2, "natural minor") === "D minor" && n(9, "dorian") === "A dorian" && n(0, "major") === "C major", "D minor, A dorian, C major");
  check(n(10, "major") === "Bb major" && n(3, "major") === "Eb major" && n(1, "major") === "Db major" && n(8, "major") === "Ab major", "major keys on black keys take flats where the flats are fewer");
  check(n(6, "major") === "F# major" && n(3, "natural minor") === "Eb minor" && n(1, "natural minor") === "C# minor" && n(8, "natural minor") === "G# minor" && n(10, "natural minor") === "Bb minor", "F# major, Eb minor, C# minor, G# minor, Bb minor");
  check(n(11, "lydian") === "B lydian" && n(5, "locrian") === "F locrian" && n(1, "mixolydian") === "Db mixolydian", "six sharps or six flats: the tonic with fewer accidentals");
  check(n(6, "whole tone") === "F# whole tone" && n(4, "major pentatonic") === "E major pentatonic" && n(10, "blues") === "Bb blues", "the other scales named by their tonics");
  check(ALL.every((key) => equal(T.read(T.names(key)), key)), "every key's name reads back as the key");
  check(equal(K("bb Natural  Minor"), { tonic: 10, scale: "natural minor" }) && equal(K("A# minor"), { tonic: 10, scale: "natural minor" }) && equal(K("E aeolian"), K("E minor")) && equal(K("G ionian"), K("G major")), "names read in any case and spacing, an enharmonic tonic the same key, ionian and aeolian known");
  check(/"H major": a key is a tonic and a scale/.test(threw(() => K("H major"))) && /"C bebop"/.test(threw(() => K("C bebop"))) && /"Cmajor"/.test(threw(() => K("Cmajor"))), "a name that is no key is refused, named");
  check(T.signature(F) === -1 && T.signature(B) === 5 && T.signature(K("D dorian")) === 0 && T.signature(K("E phrygian")) === 0 && T.signature(K("Eb minor")) === -6, "signatures");
}

// spelling
{
  check(T.spell(F, 70) === "Bb4" && T.spell(B, 70) === "A#4", "Bb in F major, A# in B major");
  check(equal(spelled(C, [61, 63, 66, 68, 70]), ["C#4", "Eb4", "F#4", "G#4", "Bb4"]), "C major's notes off its scale as written music spells them");
  check(equal(spelled(K("G major"), [70, 63]), ["A#4", "D#4"]) && equal(spelled(K("Eb major"), [66, 61]), ["Gb4", "Db4"]), "off the scale, sharps in sharp keys and flats in flat ones");
  check(equal(spelled(K("Gb major"), [66, 68, 70, 71, 73, 75, 77]), ["F#4", "G#4", "A#4", "B4", "C#5", "D#5", "E#5"]), "F# major in its own sharps, E# and all");
  check(equal(spelled(K("Eb minor"), [63, 65, 66, 68, 70, 71, 73]), ["Eb4", "F4", "Gb4", "Ab4", "Bb4", "Cb5", "Db5"]), "Eb minor in six flats, Cb5 the B above Bb4");
  check(equal(spelled(K("Db major"), [62, 67]), ["D4", "G4"]), "a white key off a flat key's scale is a natural");
  check(T.spell(K("A harmonic minor"), 68) === "G#4" && T.spell(K("C# harmonic minor"), 72) === "B#4" && T.spell(K("G# harmonic minor"), 67) === "F##4", "a raised seventh on its own letter: G#, B#, F##");
  check(equal(spelled(K("A melodic minor"), [66, 68]), ["F#4", "G#4"]) && T.spell(K("C harmonic minor"), 71) === "B4", "melodic minor's sixth and seventh, harmonic minor's natural seventh");
  check(T.spell(K("C blues"), 66) === "Gb4" && T.spell(K("E blues"), 70) === "Bb4" && T.spell(K("A blues"), 63) === "Eb4", "the blue note a flat fifth");
  check(equal(spelled(K("F# major pentatonic"), [66, 68, 70, 73, 75]), ["F#4", "G#4", "A#4", "C#5", "D#5"]) && equal(spelled(K("Bb minor pentatonic"), [70, 73, 75, 77, 80]), ["Bb4", "Db5", "Eb5", "F5", "Ab5"]), "pentatonics in their keys' letters");
  check(equal(spelled(K("C whole tone"), [66, 68, 70]), ["F#4", "G#4", "Bb4"]) && equal(spelled(K("F# whole tone"), [66, 68, 70, 72, 74, 76]), ["F#4", "G#4", "A#4", "C5", "D5", "E5"]), "whole tone by its tonic's signature");
  check(T.spell(K("C# harmonic minor"), 0) === "B#-2" && P.key("B#-2") === 0 && T.spell(C, 127) === "G9", "the ends of MIDI's keys");
  let all = true, letters = true;
  for (const key of ALL) {
    for (let k = 0; k < 128; k++) if (P.key(T.spell(key, k)) !== k) all = false;
    const sc = T.SCALES[key.scale];
    if (sc.steps.length === 7) {
      const ls = sc.steps.map((s) => T.spell(key, 60 + key.tonic + s)[0]);
      if (new Set(ls).size !== 7) letters = false;
    }
  }
  check(all, "every key of every key is spelled as itself, 168 keys by 128");
  check(letters, "every scale of seven notes spells them on seven letters");
}

// moved, keeping its spelling
{
  check(T.moved("Bb4", 1) === "B4" && T.moved("B4", -1) === "Bb4" && T.moved(T.moved("Bb4", 1), -1) === "Bb4", "Bb4 up a key and back is Bb4, not A#4");
  check(T.moved("Bb4", 3) === "Db5" && T.moved("Bb4", -2) === "Ab4" && T.moved("Db4", 2) === "Eb4", "a flat moved stays a flat");
  check(T.moved("A#4", 3) === "C#5" && T.moved("F#3", -2) === "E3", "a sharp stays a sharp");
  check(T.moved("C4", 1) === "C#4" && T.moved("E4", -1) === "Eb4" && T.moved("E4", 1) === "F4", "a natural moved up takes sharps, down flats");
  check(T.moved("Bb4", 12) === "Bb5" && T.moved("Cb4", 12) === "Cb5" && T.moved("E#4", -24) === "E#2" && T.moved("F##4", 0) === "F##4", "by octaves the name is kept as spelled");
  check(T.moved("A#4", 0, F) === "Bb4" && T.moved("C4", 6, B) === "F#4" && T.moved("C4", 6, K("Db major")) === "Gb4", "with a key, spelled for it");
  check(threw(() => T.moved("G9", 1)) === "G9 moved 1: past MIDI's keys, C-1 to G9" && threw(() => T.moved("C-1", -1)) === "C-1 moved -1: past MIDI's keys, C-1 to G9", "past MIDI's keys is refused, named");
  check(/H4: not a key/.test(threw(() => T.moved("H4", 1))) && threw(() => T.moved("C4", 0.5)) === "C4 moved 0.5: a whole number of semitones", "a name or a move that is none is refused");
}

// nearest, for dragging onto the scale
{
  check(T.nearest(C, 64) === 64 && T.nearest(C, 64, 1) === 64 && T.nearest(C, 64, -1) === 64, "a key in the scale is its own nearest");
  check(T.nearest(C, 61, 1) === 62 && T.nearest(C, 61, -1) === 60 && T.nearest(C, 61) === 60 && T.nearest(C, 66) === 65, "C#4 up is D4, down C4; a tie goes down");
  check(T.nearest(K("A minor pentatonic"), 70) === 69 && T.nearest(K("A minor pentatonic"), 71) === 72 && T.nearest(K("A minor pentatonic"), 65, 1) === 67, "a pentatonic's gaps go to the nearer side");
  const db = K("Db major");
  check(T.nearest(db, 127, 1) === null && T.nearest(db, 127, -1) === 126 && T.nearest(db, 127) === 126, "none above G9 in Db major: null that way, F#9 either way");
  check(T.nearest(K("B major"), 0, -1) === null && T.nearest(K("B major"), 0) === 1, "and none below C-1 in B major");
  check(/direction 2/.test(threw(() => T.nearest(C, 61, 2))), "a direction that is none is refused");
}

// steps along the scale
{
  check(T.step(C, 64, 1) === 65 && T.step(C, 64, 2) === 67 && T.step(C, 64, -3) === 59 && T.step(C, 64, 7) === 76 && T.step(C, 64, -7) === 52 && T.step(C, 64, 0) === 64, "E4 in C major: up one F4, two G4, down three B3, an octave seven");
  check(T.step(C, 61, 1) === 63 && T.step(C, 66, -1) === 65 && T.step(C, 70, 1) === 72, "off the scale: the note below's steps, its offset kept");
  check(T.step(K("D minor"), 62, 2) === 65 && T.step(K("D minor"), 70, 1) === 72 && T.step(K("D minor"), 50, -1) === 48, "D minor: D4 up two F4, Bb4 up one C5, D3 down one C3");
  check(T.step(K("A minor pentatonic"), 69, 1) === 72 && T.step(K("A minor pentatonic"), 69, 5) === 81 && T.step(K("A minor pentatonic"), 57, -1) === 55, "a pentatonic's five steps to the octave");
  check(T.step(K("C chromatic"), 60, 5) === 65 && T.step(K("C whole tone"), 61, 1) === 63, "chromatic steps are keys; whole tone keeps an offset");
  check(threw(() => T.step(C, 125, 2)) === "F9 up 2 steps in C major: past MIDI's keys, C-1 to G9" && threw(() => T.step(C, 0, -1)) === "C-1 down 1 step in C major: past MIDI's keys, C-1 to G9", "past MIDI's keys is refused, named");
  let back = true;
  for (const key of ALL) for (let k = 30; k < 90; k++) for (const n of [-9, -2, 1, 4, 13]) if (T.inKey(key, k) && T.step(key, T.step(key, k, n), -n) !== k) back = false;
  check(back, "every key, every scale: a note of the scale n steps and back is where it was");
  check(T.step(C, 63, 1) === 65 && T.step(C, 65, -1) === 64, "off the scale a step is not undone by its opposite: D#4 up one is F4, and F4 down one E4");
  check(T.distance(C, 60, 67) === 4 && T.distance(C, 67, 60) === -4 && T.distance(C, 60, 72) === 7 && T.distance(C, 61, 64) === 2, "the steps between two keys");
  check(T.mirror(C, 64, 60) === 57 && T.mirror(C, 67, 64) === 60 && T.mirror(C, 66, 60) === 54 && T.mirror(Am, 72, 69) === 65, "mirrored about the axis along the scale: E4 about C4 is A3");
  check(/C#4 is not in C major/.test(threw(() => T.mirror(C, 64, 61))), "a mirror's axis off the scale is refused");
}

// chords in a key, and chord symbols
{
  check(equal(T.chord(C, 60, "triad"), [60, 64, 67]) && equal(T.chord(C, 62, "triad"), [62, 65, 69]) && equal(T.chord(C, 71, "triad"), [71, 74, 77]), "C major's triads: C, D minor, B diminished");
  check(equal(T.chord(C, 67, "seventh"), [67, 71, 74, 77]) && equal(T.chord(C, 60, "seventh"), [60, 64, 67, 71]), "its sevenths: G7, Cmaj7");
  check(equal(T.chord(K("A harmonic minor"), 64, "triad"), [64, 68, 71]) && equal(T.chord(Am, 64, "triad"), [64, 67, 71]), "E major in A harmonic minor, E minor in A minor");
  check(equal(T.chord(C, 60, "sus2"), [60, 62, 67]) && equal(T.chord(C, 60, "sus4"), [60, 65, 67]) && equal(T.chord(C, 60, "sixth"), [60, 64, 67, 69]) && equal(T.chord(C, 60, "add9"), [60, 64, 67, 74]) && equal(T.chord(C, 60, "power"), [60, 67]), "sus2, sus4, sixth, add9, power");
  check(equal(T.chord(C, 61, "triad"), [61, 65, 68]), "on a root off the scale, the chord below moved by its offset");
  check(/chords stack in thirds in a scale of seven notes, and major pentatonic has 5/.test(threw(() => T.chord(K("C major pentatonic"), 60, "triad"))) && /ninth: a chord is one of triad/.test(threw(() => T.chord(C, 60, "ninth"))), "a scale not of seven, or a kind there is not, refused");
  check(/past MIDI's keys/.test(threw(() => T.chord(C, 124, "triad"))), "a chord past the top is refused");
  const ck = T.chordKeys;
  check(equal(ck("C"), [60, 64, 67]) && equal(ck("Am"), [69, 72, 76]) && equal(ck("F#m7"), [66, 69, 73, 76]) && equal(ck("Bbmaj7"), [70, 74, 77, 81]), "C, Am, F#m7, Bbmaj7");
  check(equal(ck("Gsus4"), [67, 72, 74]) && equal(ck("D7"), [62, 66, 69, 72]) && equal(ck("Cdim"), [60, 63, 66]) && equal(ck("Caug"), [60, 64, 68]) && equal(ck("C+"), ck("Caug")), "Gsus4, D7, Cdim, Caug");
  check(equal(ck("C5"), [60, 67]) && equal(ck("Cdim7"), [60, 63, 66, 69]) && equal(ck("Bm7b5"), [71, 74, 77, 81]) && equal(ck("Cm9"), [60, 63, 67, 70, 74]) && equal(ck("CM7"), ck("Cmaj7")) && !equal(ck("CM7"), ck("Cm7")), "power, dim7, half diminished, m9; M7 is not m7");
  check(equal(ck("C/E"), [52, 60, 64, 67]) && equal(ck("Am7/G"), [67, 69, 72, 76, 79]) && equal(ck("C/C"), [48, 60, 64, 67]), "a slash bass below the root");
  check(equal(ck("C", 3), [48, 52, 55]) && equal(ck("Cb"), [59, 63, 66]) && equal(ck(" Eb "), [63, 67, 70]), "an octave named; Cb4 the B below C4; spaces at the ends");
  check(/"Cmaj13#11": not a chord this reads/.test(threw(() => ck("Cmaj13#11"))) && /"H7"/.test(threw(() => ck("H7"))) && /"": not a chord/.test(threw(() => ck(""))) && /"C\/H"/.test(threw(() => ck("C/H"))), "a symbol it does not read is refused, named");
  check(/past MIDI's keys/.test(threw(() => ck("G9", 9))) && /outside MIDI's keys/.test(threw(() => ck("C", 10))), "a chord past the top is refused");
}

// the key the notes are in
{
  const ns = (spec) => spec.split(" ").map((s) => { const [p, b] = s.split(":"); return { at: 0, ticks: Math.round(Number(b ?? 1) * 960), pitch: p, cents: 0 }; });
  const mary = ns("E4 D4 C4 D4 E4 E4 E4:2 D4 D4 D4:2 E4 G4 G4:2 E4 D4 C4 D4 E4 E4 E4 E4 D4 D4 E4 D4 C4:4");
  const twinkle = ns("C4 C4 G4 G4 A4 A4 G4:2 F4 F4 E4 E4 D4 D4 C4:2 G4 G4 F4 F4 E4 E4 D4:2 G4 G4 F4 F4 E4 E4 D4:2 C4 C4 G4 G4 A4 A4 G4:2 F4 F4 E4 E4 D4 D4 C4:2");
  const r = T.detect(twinkle);
  check(r.length === 24 && r[0].name === "C major" && r[0].inside === 1 && r[0].score - r[1].score > 0.1, "Twinkle Twinkle is in C major, all its time on the scale, well ahead of the next");
  const m = T.detect(mary);
  check(m.slice(0, 3).some((e) => e.name === "C major") && m.slice(0, 3).every((e) => e.inside === 1), "Mary Had a Little Lamb's four pitches leave it unsure: C major among the first three, each with all of it on the scale");
  check(r.every((e, i) => i === 0 || e.score <= r[i - 1].score) && r.every((e) => e.score >= -1 && e.score <= 1), "the 24 keys ranked by a score from -1 to 1");
  check(equal(T.detect(twinkle), r), "the same notes rank the same");
  const minor = ns("A3:2 B3 C4 D4 E4:2 F4 G#4 A4:3 E4:2 C4 A3:4");
  check(T.detect(minor)[0].name === "A minor", "a tune on A with a raised seventh is in A minor");
  const lengths = T.detect(ns("C4:8 E4:8 G4:8 F#4:0.25 B4:0.25 D5:0.25"));
  check(lengths[0].name === "C major", "a note counts for its length: short G major notes under long C major ones");
  const dorian = ns("D4:4 E4 F4 G4 A4:2 B4 C5 D5:4");
  check(dorian.length && T.detect(dorian).every((e) => e.key.scale === "major" || e.key.scale === "natural minor"), "only major and minor keys are ranked");
  check(threw(() => T.detect([])) === "no notes to find a key in" && /every pitch the same/.test(threw(() => T.detect(ns("C4 C#4 D4 D#4 E4 F4 F#4 G4 G#4 A4 A#4 B4")))), "no notes, or every pitch alike, is refused");
  check(/H4: not a key/.test(threw(() => T.detect(ns("H4")))) && /a note 0 ticks long/.test(threw(() => T.detect([{ pitch: "C4", ticks: 0 }]))), "a note that is none is refused");
}

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
