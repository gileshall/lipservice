// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// song.js: a part written as the engine's song text. The cases of part.rs's own tests of roll()
// give the same text here; the vibrato the engine would read from that text is the part's lane;
// tempo changes are written flat; marks settle their rests; what cannot be sung is named by beat.
// node song_test.mjs
import assert from "node:assert/strict";
import * as P from "./part.js";
import { song, problems, words, word, clock, beatOf, tempo } from "./song.js";
import { syllables } from "./edit.js";
import { EXAMPLES } from "./examples/make.mjs";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const G = 960;

// a part of keys [key, start, beats], words as typed, the vibrato's points [beat, value, line]
function part(bpm, keys, text, { vibrato = [], join = 0, marks = [], tempo = [] } = {}) {
  const lyrics = syllables(text);
  return {
    ...P.blank({ ...P.singer("6147"), join }),
    tempo: [{ at: 0, bpm }, ...tempo.map(([at, b]) => ({ at: Math.round(at * G), bpm: b }))],
    notes: keys.map(([k, at, beats], i) => ({ at: Math.round(at * G), ticks: Math.round(beats * G), pitch: P.name(Math.floor(k)), cents: Math.round((k % 1) * 100), velocity: 64, release: 64, lyric: lyrics[i] ?? null })),
    lanes: { vibrato: vibrato.map(([at, value, line = false]) => ({ at: Math.round(at * G), value, line })) },
    marks: marks.map(([at, breath]) => ({ at: Math.round(at * G), breath })),
  };
}
const text = (...a) => song(part(...a)).text;

// ---- part.rs roll's own cases
{
  const keys = [[60, 1, 1], [62, 2, 1], [64, 3, 1.5], [65, 5, 1]];
  check(text(90, keys, "the wide_ sea") === "%bpm 90\n%rest 1\nthe 60:1\nwide 62:1+64:1.5\n%rest 0.5\nsea 65:1\n", "no vibrato: the song as roll writes it");
  check(text(90, keys, "the wide_ sea", { vibrato: [[0, 0], [2.5, 0.5], [3, 2], [5, 1]] }) === "%bpm 90\n%rest 1\n%vibrato 0\nthe 60:1\n%vibrato 0:0.5 0.5 0.5:0.5 2\nwide 62:1+64:1.5\n%rest 0.5\n%vibrato 1\nsea 65:1\n", "the pedal set before the first note, moved in the held word, and on the last word's beat");
  check(text(90, keys, "the wide_ sea", { vibrato: [[4.75, 0.25], [5.5, 1.5], [7, 0]] }) === "%bpm 90\n%rest 1\nthe 60:1\n%vibrato 1:2.75 0.25\nwide 62:1+64:1.5\n%rest 0.5\n%vibrato 0.25:0.5 1.5 1.5:1.5 0\nsea 65:1\n", "a point in a rest goes with the word before it, as one after the last note does");
  check(text(90, [[60, 1, 0.9], ...keys.slice(1)], "the wide_ sea") === "%bpm 90\n%rest 1\nthe 60:0.9\n%rest 0.1\nwide 62:1+64:1.5\n%rest 0.5\nsea 65:1\n", "rests and holds");
  check(text(120, [[60, 0, 2], [62, 1, 1]], "a b") === "%bpm 120\na 60:1\nb 62:1\n", "a note still sounding ends where the next starts");
  const gaps = [[60, 0, 0.9], [62, 1, 0.5], [64, 2, 1]];
  check(text(120, gaps, "a b c") === "%bpm 120\na 60:0.9\n%rest 0.1\nb 62:0.5\n%rest 0.5\nc 64:1\n", "a gap between words is a rest");
  check(text(120, gaps, "a b c", { join: 0.125 }) === "%bpm 120\na 60:1\nb 62:0.5\n%rest 0.5\nc 64:1\n", "unless it is short enough to join");
  check(text(120, [[60, 3, 1], [62, 4.5, 1]], "a b") === "%bpm 120\n%rest 3\na 60:1\n%rest 0.5\nb 62:1\n", "a song from the part's start");
  const water = [[60, 0, 1], [62, 1, 0.5], [64, 2, 1], [65, 3, 1]];
  check(text(60, water, "wa_-ter is") === "%bpm 60\nwater 60:1+62:1 64:1\nis 65:1\n", "a word split, a syllable held: inside a word a note runs to the next");
  check(text(60, water.slice(0, 3), "wa-ter wide") === "%bpm 60\nwater 60:1 62:0.5\n%rest 0.5\nwide 64:1\n", "and between words no further than its own end");
}

// ---- Mary
{
  const s = song(EXAMPLES.mary()), lines = s.text.split("\n");
  check(equal(lines.slice(0, 7), ["%bpm 96", "%rest 4", "%vibrato 0.625", "Mary 64:1 62:1", "had 60:1", "a 62:1", "little 64:1 64:1"]), "Mary: at 96, four beats in, the wheel low, a word and its notes a line");
  check(lines[7].startsWith("%vibrato 0.625:0.125 0.734375 0.734375:0.125 0.859375 ") && lines[7].endsWith(" 1.888889 1.888889:0.125 0.625") && equal(lines.slice(8, 10), ["lamb 64:1.5", "%rest 0.5"]), "the wheel pressed through the long note, and the rest after it");
  check(equal(lines.filter((l) => l && !l.startsWith("%")).map((l) => l.split(" ")[0]).join(" "), "Mary had a little lamb little lamb little lamb Mary had a little lamb its fleece was white as snow"), "its words, their punctuation left off");
  check(equal(s.phrases.map((p) => [p.from / 480, p.at / 480]), [[0, 4], [11.5, 12], [15.5, 16], [19.5, 20]]) && s.wants.size === 0, "four phrases, each after its rest; no breath marked");
  check(s.words.length === 20 && s.words[0].notes.length === 2 && s.notes.length === 26, "20 words of 26 notes");
}

// ---- the vibrato the engine reads from the text is the part's lane
{
  // sing.rs Lane: the points a song's vibrato lines write, and its value at a beat
  const lane = (songText) => {
    const pts = [];
    let beat = 0;
    const at = (b) => {
      const i = pts.findLastIndex((p) => p[0] <= b);
      if (i < 0) return 1;
      const [a, n] = [pts[i], pts[i + 1]];
      return n ? a[1] + (n[1] - a[1]) * (b - a[0]) / (n[0] - a[0]) : a[1];
    };
    for (const l of songText.trim().split("\n")) {
      const f = l.split(" ");
      if (f[0] === "%bpm") continue;
      if (f[0] === "%rest") beat += Number(f[1]);
      else if (f[0] === "%vibrato") {
        const v = at(beat);
        while (pts.length && pts.at(-1)[0] > beat) pts.pop();
        pts.push([beat, v]);
        let t = beat;
        for (const s of f.slice(1)) {
          const [value, over] = s.split(":").map(Number);
          t += over ?? 0;
          pts.push([t, value]);
        }
      } else for (const group of f.slice(1)) for (const n of group.split("+")) beat += Number(n.split(":")[1]);
    }
    return at;
  };
  for (const name of Object.keys(EXAMPLES).filter((n) => n !== "unfinished")) {
    const p = EXAMPLES[name](), s = song(p), at = lane(s.text), first = s.words[0].at, end = Math.max(...p.notes.map((n) => n.at + n.ticks));
    let worst = 0, n = 0;
    for (let t = first; t < end; t += 7) {
      // on a tick where the lane jumps, the engine has the value after it or before it
      if (p.lanes.vibrato.some((q) => !q.line && Math.abs(q.at - t) < 8)) continue;
      // a breath made where there was no rest moves what follows by a tick
      worst = Math.max(worst, Math.abs(at(beatOf(p, t)) - P.at(p.lanes.vibrato, t, 1)));
      n++;
    }
    check(worst < 0.002, `${name}: at ${n} places from its first note to its last the engine's vibrato is the lane's (off by ${worst.toFixed(6)} at most)`);
  }
  const p = part(60, [[60, 1, 4], [62, 5, 4]], "la la", { vibrato: [[0, 0.5], [3, 0.5], [7, 2, true], [7, 0.25], [9, 0.25]] });
  check(song(p).text === "%bpm 60\n%rest 1\n%vibrato 0.5 0.5:2 1.25:2\nla 60:4\n%vibrato 2:2 0.25 0.25:2\nla 62:4\n", "a line drawn across two words is drawn to the second word's start, and on from there; a point that changes nothing writes no jump");
}

// ---- tempo changes written flat
{
  const keys = [[60, 0, 2], [62, 2, 2], [64, 4, 2]];
  check(text(120, keys, "a b c", { tempo: [[2, 60], [4, 240]] }) === "%bpm 120\na 60:2\nb 62:4\nc 64:1\n", "a note at half the tempo is twice the first tempo's beats; at twice, half");
  check(text(120, keys, "a b c", { tempo: [[3, 60]] }) === "%bpm 120\na 60:2\nb 62:3\nc 64:4\n", "a tempo that changes inside a note");
  const p = part(120, keys, "a b c", { tempo: [[2, 60], [4, 240]] });
  check(equal([0, 2, 3, 4, 6].map((b) => clock(p)(b * G)), [0, 1, 2, 3, 3.5]) && beatOf(p, 4 * G) === 6, "the seconds a beat falls at, through the tempos");
  check(text(72, [[57, 14, 3]], "la", { tempo: [[14, 60.5]] }) === "%bpm 72\n%rest 14\nla 57:3.570248\n", "three beats at 60.5 are 3.570248 at 72");
  // the engine sings 20 to 400 beats a minute: a tempo outside is doubled or halved into it, and
  // each note as many of those beats as it lasts, the seconds the same
  check(equal([10, 20, 400, 401, 1000, 4].map((b) => tempo(part(b, keys, "a b c"))), [20, 20, 400, 200.5, 250, 32]), "a song's tempo is 20 to 400");
  check(text(10, keys, "a b c") === "%bpm 20\na 60:4\nb 62:4\nc 64:4\n" && text(1000, keys, "a b c") === "%bpm 250\na 60:0.5\nb 62:0.5\nc 64:0.5\n", "10 beats a minute is written at 20, each beat two; 1000 at 250, each a quarter");
  const slow = part(10, keys, "a b c");
  check(beatOf(slow, 2 * G) === 4 && clock(slow)(2 * G) === 12, "the song's beats are its tempo's, the seconds the part's");
}

// ---- cents
check(text(60, [[64.14, 0, 1], [58.84, 1, 1]], "a b") === "%bpm 60\na 64.14:1\nb 58.84:1\n", "a note's cents are the fraction of its MIDI number");

// ---- breaths marked
{
  const keys = [[60, 1, 1], [62, 2, 1], [64, 4, 2], [65, 6, 2]];
  const s = song(part(60, keys, "a b c d", { marks: [[1, false], [3.5, true]] }));
  check(equal([...s.wants], [[0, false], [1, true]]) && s.phrases.length === 2, "a mark in a rest, or on the note that ends it, settles that rest");
  const t = song(part(60, keys, "a b c d", { marks: [[6, true]] }));
  check(t.text === "%bpm 60\n%rest 1\na 60:1\nb 62:1\n%rest 1\nc 64:1.998958\n%rest 0.001042\nd 65:2\n" && equal([...t.wants], [[2, true]]) && equal(t.phrases[2], { at: 6 * G, from: 6 * G - 1 }), "a breath marked where there is no rest: the note before ends a tick early, and a phrase starts");
  const j = song(part(60, [[60, 0, 0.9], [62, 1, 1]], "a b", { join: 0.5, marks: [[1, true]] }));
  check(j.text === "%bpm 60\na 60:0.9\n%rest 0.1\nb 62:1\n", "a breath marked in a gap short enough to join keeps the gap");
  const none = song(part(60, keys, "a b c d", { marks: [[6, false]] }));
  check(none.wants.size === 0 && none.phrases.length === 2, "a breath marked not to be taken where a word follows straight on settles nothing");
  check(threw(() => song(part(60, keys, "a b c_", { marks: [[6, true]] })))?.includes("beat 6: the mark is in no rest and on no word's first note"), "a mark inside a word is refused");
  check(threw(() => song(part(60, keys, "a b c d", { marks: [[2.5, true]] })))?.includes("beat 2.5: the mark is in no rest"), "as is one inside a note");
  check(threw(() => song(part(60, keys, "a b c d", { marks: [[3.5, true], [4, false]] })))?.includes("beat 4: a second mark in one rest"), "and a second in one rest");
  const e = EXAMPLES.every(), se = song(e);
  check(equal([...se.wants], [[0, false], [1, true], [2, true]]) && equal(se.phrases.map((p) => p.at / G), [1, 6.5, 12]), "every: none before the first note, one in the rest, one made before \"and\"");
}

// ---- what stops a part being sung
{
  const ps = problems(EXAMPLES.unfinished()).map((p) => p.what);
  check(equal(ps, ["beat 0: the note C3 has no words", "beat 2: the note G3 has no words", "beat 2: two notes start together: a singer sings one at a time", "beat 6: \"Ma-\" goes on to a syllable that is not there"]), "unfinished: each thing in the way, by its beat");
  check(threw(() => song(EXAMPLES.unfinished()))?.startsWith("beat 0: the note C3 has no words\nbeat 2:"), "and singing it is refused with all of them");
  check(equal(problems(EXAMPLES.mary()), []) && equal(problems(EXAMPLES.every()), []), "Mary and every have nothing in the way");
  check(equal(problems(P.blank(P.singer("a"))).map((p) => p.what), ["the part has no notes"]), "a part with no notes");
  const p = part(60, [[60, 0, 1], [62, 1, 1]], "a b");
  p.notes[0].lyric = "_";
  check(problems(p)[0].what === "beat 0: a held note with no syllable before it", "a held note with nothing to hold");
  p.notes[0].lyric = "...";
  check(problems(p)[0].what === "beat 0: \"...\" has no letters to sing", "a word of punctuation alone");
  // a song's line that starts with % is an instruction and one with # a comment: no word can
  p.notes[0].lyric = "%bpm";
  check(problems(p)[0].what === "beat 0: \"%bpm\" starts with %: a line of a song that starts so is an instruction, not a word", "a word that starts with %");
  p.notes[0].lyric = "#1";
  check(problems(p)[0].what === "beat 0: \"#1\" starts with #: a line of a song that starts so is a comment, not a word", "a word that starts with #");
  // the words the instructions are named by are words like any other
  p.notes[0].lyric = "rest";
  p.notes[1].lyric = "bpm";
  check(equal(problems(p), []) && song(p).text === "%bpm 60\nrest 60:1\nbpm 62:1\n", "rest and bpm are words");
  const marked = part(60, [[60, 0, 1], [62, 1, 1]], "a b", { marks: [[0.5, true]] });
  check(equal(problems(marked), [{ at: 480, what: "beat 0.5: the mark is in no rest and on no word's first note" }]), "a mark in no rest is one of them");
  check(word(["lit-", "tle"]) === "little" && word(["“O-", "_", "ver,”/"]) === "Over" && equal(words(EXAMPLES.mary()).words[0].groups.map((g) => g.length), [1, 1]), "a word is its syllables joined");
}

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
