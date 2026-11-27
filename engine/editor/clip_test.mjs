// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// clip.js: notes copied as a part's text, read back, pasted into a part from a tick, duplicated;
// every example copied whole and pasted back; the part around a paste left as it sang. node
// clip_test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as P from "./part.js";
import * as C from "./clip.js";
import { Editor } from "./edit.js";
import { EXAMPLES } from "./examples/make.mjs";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const G = 960;
const blank = (grid = G) => P.blank(P.singer("6147", 3), grid);
const brief = (part) => part.notes.map((n) => `${P.beat(n.at, part.grid)}+${P.beat(n.ticks, part.grid)} ${P.pitch(n)}${n.lyric === null ? "" : ` ${n.lyric}`}`);
const note = (at, ticks, pitch, lyric = null) => ({ at, ticks, pitch, cents: 0, velocity: 80, release: 64, lyric });
const made = (notes, vibrato = [], marks = [], grid = G) => ({ ...blank(grid), notes: P.sort(notes), lanes: { vibrato }, marks });
const pt = (at, value, line = false) => ({ at, value, line });
const moved = (xs, dt) => xs.map((x) => ({ ...x, at: x.at + dt }));
const end = (notes) => Math.max(...notes.map((n) => n.at + n.ticks));

// The ticks where a lane may change, and either side of them, and a stride across [from, to).
const probes = (points, from, to, more = []) => {
  const out = new Set([from, to - 1, to, to + 1]);
  for (const t of [...points.map((q) => q.at), ...more]) for (const d of [-1, 0, 1]) out.add(t + d);
  for (let t = from; t < to; t += 7) out.add(t);
  return [...out].filter((t) => t >= 0).sort((a, b) => a - b);
};
const near = (a, b) => Math.abs(a - b) <= 1e-6;

// ---------------------------------------------------------------- every example, whole

for (const [name, make] of Object.entries(EXAMPLES)) {
  const src = make(), start = src.notes[0].at, stop = end(src.notes);
  const text = C.copy(src, src.notes);
  const clip = C.read(text);
  check(text.startsWith(`${P.HEAD}\ntitle ${src.title}`.trimEnd()) && P.read(text).singer.voice === src.singer.voice && equal(P.read(text).singer, src.singer), `${name}: copied whole, a part's text with its title and singer`);
  check(clip.notes[0].at === 0 && clip.len === stop - start && equal(clip.notes, moved(src.notes, -start)), `${name}: read back, the notes and their words from beat 0`);
  const again = P.read(text);
  check(C.copy(again, again.notes) === text && equal(C.read(P.write(src)), clip), `${name}: the clip's text copied again is itself; the part's own file reads as the same clip`);
  for (const at of [0, start]) {
    const { part, notes } = C.paste(blank(src.grid), clip, at);
    check(equal(part.notes, moved(src.notes, at - start)) && equal(notes, part.notes), `${name}: pasted at beat ${P.beat(at, src.grid)} into a blank part: the same notes and words, every one chosen`);
    check(equal(part.marks, moved(src.marks.filter((m) => m.at >= start && m.at < stop), at - start)), `${name}: and the same marks`);
    const lane = src.lanes.vibrato, got = part.lanes.vibrato;
    const sung = probes(lane, start, stop, src.notes.map((n) => n.at)).filter((t) => t >= start && t < stop);
    check(sung.every((t) => near(P.at(got, t + at - start, 1), P.at(lane, t, 1))), `${name}: the vibrato the same under every note (${sung.length} ticks)`);
    check(P.at(got, at + stop - start, 1) === 1 && (at === 0 || P.at(got, at - 1, 1) === 1), `${name}: the blank part's own vibrato before and after them`);
  }
  const back = C.paste(blank(src.grid), clip, start).part.lanes.vibrato;
  const lane = src.lanes.vibrato;
  if (name === "every") {
    // the lane ends on a line down to 0 at the last note's end: the blank part's size of 1 is set
    // again there, so a note drawn after them is not sung at 0
    check(equal(back, [...lane, pt(20 * G, 1)]), "every: the same lane, and the blank part's size set again where the notes end");
  } else if (name === "mary") {
    // the first point is before the first note, so it comes in where that note starts; the last
    // is where the notes end, setting the size after them: the blank part's is set there instead
    check(equal(back, [pt(start, lane[0].value), ...lane.slice(1, -1), pt(lane.at(-1).at, 1)]), "mary: the same lane under the notes; its first point at the first note, the blank part's size after the last");
  } else {
    check(equal(back, lane), `${name}: the same lane`);
  }
}

// ---------------------------------------------------------------- copy

{
  const src = EXAMPLES.every(), pick = src.notes.filter((n) => n.at >= 6.5 * G && n.at < 10 * G);
  check(C.copy(src, pick) === [
    P.HEAD, "title Every line of a part: étude, 100%", "grid 960", "",
    "voice 4446", "seed 11", "shift -2", "join 0.25", "glide 12", "dynamics 0.8", "breathiness 0.5", "diction 0", "motion -", "sway 1.25", "jitter 3", "detune 4.5", "spread 0.015", "breath 0.6", "",
    "tempo 0 72", "meter 0 4/4", "",
    "note 0 0.5 D4 52 64 the", "note 0.5 1 G4 96 64 riv-", "note 1.5 0.5 F#4 70 64 er", "note 2 1.5 E4+14 80 30 turns,/", "",
    "vibrato 0 0", "vibrato 2 0.25", "vibrato 3.5 1.25 line", "",
    "mark 0 breath", "",
  ].join("\n"), "four notes copied: from beat 0, the meter in force, the vibrato standing at their start and the line reaching their end, the breath on the first");
  const from = src.notes.filter((n) => n.at >= 14 * G);
  const later = C.read(C.copy(src, from));
  check(equal(later.tempo, [{ at: 0, bpm: 60.5 }]) && equal(later.lanes.vibrato, [pt(0, 0.75), pt(3 * G, 2.5, true), pt(6 * G, 0, true)]), "copied after a change of tempo: the tempo then; the lanes' lines kept");
  check(C.copy(src, [src.notes[3], src.notes[0], src.notes[3]]) === C.copy(src, [src.notes[0], src.notes[3]]), "notes given in any order, or twice, copy the same");
  const gap = C.read(C.copy(src, [src.notes[0], src.notes[14]]));
  check(gap.notes.length === 2 && gap.notes[1].at === 13 * G && gap.marks.length === 3, "two notes far apart: the stretch between them comes too, its marks with it, its notes not");
  check(threw(() => C.copy(src, [])) === "no notes are chosen to copy", "copying nothing is refused");
  check(threw(() => C.copy(src, [{ ...src.notes[0] }])) === "a note to copy is not one of this part's notes", "a note not of the part is refused");

  // a line running through both ends of the copy
  const ramp = made([note(2 * G, 2 * G, "C4", "la")], [pt(0, 0.5), pt(8 * G, 1.5, true)]);
  check(equal(C.read(C.copy(ramp, ramp.notes)).lanes.vibrato, [pt(0, 0.75), pt(2 * G, 1, true)]), "a line through the copied stretch: the value at its start held, a line to the value at its end");
  const none = made([note(0, G, "C4")]);
  check(equal(C.read(C.copy(none, none.notes)).lanes.vibrato, []), "a part with no vibrato drawn: the clip has none");
}

// ---------------------------------------------------------------- read

{
  const round = readFileSync(new URL("./examples/round.score", import.meta.url), "utf8");
  check(threw(() => C.read("Mary had a little lamb")) === "the clipboard holds no lipservice notes; words go in the Words box", "words are refused, saying there are no notes");
  check(threw(() => C.read("")) === "the clipboard holds no lipservice notes; words go in the Words box", "nothing is refused");
  check(/holds a score/.test(threw(() => C.read(round))), "a score is refused, saying it is a score");
  check(/^the clipboard's part does not read: line 3: /.test(threw(() => C.read(`${P.HEAD}\ntitle x\ngrid nine\n`))), "a part that does not read is refused, naming the line");
  check(threw(() => C.read(P.write(blank()))) === "the clipboard's part has no notes", "a part with no notes is refused");
  const crlf = P.write(EXAMPLES.mary()).replace(/\n/g, "\r\n");
  check(equal(C.read("\ufeff" + crlf), C.read(P.write(EXAMPLES.mary()))), "a part's text from another program, a byte order mark before it and \\r\\n line ends, reads");
}

// ---------------------------------------------------------------- paste

{
  // a clip's line through its ends into a part with a line through the paste's ends
  const ramp = made([note(2 * G, 2 * G, "C4", "la")], [pt(0, 0.5), pt(8 * G, 1.5, true)]);
  const clip = C.read(C.copy(ramp, ramp.notes));
  const into = made([note(0, G, "E4", "oh"), note(8 * G, G, "E4", "ah")], [pt(0, 0.2), pt(10 * G, 1.2, true)]);
  const { part, notes, said } = C.paste(into, clip, 4 * G);
  check(equal(brief(part), ["0+1 E4 oh", "4+2 C4 la", "8+1 E4 ah"]) && notes.length === 1 && part.notes.includes(notes[0]) && equal(said, []), "pasted at beat 4 among the part's notes, the pasted note given back");
  check(equal(part.lanes.vibrato, [pt(0, 0.2), pt(4 * G, 0.6, true), pt(4 * G, 0.75), pt(6 * G, 1, true), pt(6 * G, 0.8), pt(10 * G, 1.2, true)]), "the part's line keeps its way to the paste, the clip's lane in it, the part's line again from its end");
  const a = into.lanes.vibrato, b = part.lanes.vibrato, c = clip.lanes.vibrato;
  check(probes(a, 0, 12 * G).every((t) => (t >= 4 * G && t < 6 * G ? near(P.at(b, t, 1), P.at(c, t - 4 * G, 1)) : near(P.at(b, t, 1), P.at(a, t, 1)))), "the vibrato the clip's in the paste and the part's everywhere else");

  // the clip ends where the part's line stands at its value: the line is still begun again there
  const flat = made([note(0, 2 * G, "C4", "oo")], [pt(0, 1.5)]);
  const rising = made([], [pt(0, 0.5), pt(2 * G, 1), pt(10 * G, 2, true)]);
  check(equal(C.paste(rising, C.read(C.copy(flat, flat.notes)), 4 * G).part.lanes.vibrato, [pt(0, 0.5), pt(2 * G, 1), pt(4 * G, 1.25, true), pt(4 * G, 1.5), pt(6 * G, 1.5), pt(10 * G, 2, true)]), "a paste ending on the value a line of the part has there: the line begun again where it ends");

  // every example's notes, whole and in pieces, pasted into every example at several beats
  let pastes = 0, bad = [];
  const parts = Object.entries(EXAMPLES).map(([name, make]) => [name, make()]);
  for (const [sn, src] of parts) {
    const n = src.notes.length;
    const picks = [src.notes, src.notes.slice(0, Math.ceil(n / 2)), src.notes.slice(Math.floor(n / 3), Math.floor(2 * n / 3) + 1), [src.notes[n - 1]]];
    for (const pick of picks) {
      const clip = C.read(C.copy(src, pick));
      for (const [tn, dst] of parts) {
        const last = Math.max(end(dst.notes), ...dst.lanes.vibrato.map((q) => q.at));
        for (const at of [0, dst.notes[0].at, Math.round(last / 2), last, last + dst.grid].map((t) => Math.round(t / dst.grid) * dst.grid)) {
          const what = `${sn} (${pick.length} notes) into ${tn} at beat ${P.beat(at, dst.grid)}`;
          let r;
          try {
            r = C.paste(dst, clip, at);
          } catch (e) {
            bad.push(`${what}: ${e.message}`);
            continue;
          }
          pastes++;
          const stop = at + clip.len * dst.grid / clip.grid;
          const x = dst.lanes.vibrato, y = r.part.lanes.vibrato, z = clip.lanes.vibrato;
          const scale = (t) => (t - at) * clip.grid / dst.grid;
          const ok = probes([...x, ...y], 0, last + 4 * dst.grid, r.notes.map((m) => m.at)).every((t) => {
            if (t >= at && t < stop && z.length) return near(P.at(y, t, 1), P.at(z, scale(t), 1));
            return near(P.at(y, t, 1), P.at(x, t, 1));
          });
          const notesOk = equal(r.part.notes, P.sort([...dst.notes, ...r.notes])) && equal(r.notes.map((m) => [m.pitch, m.cents, m.lyric, m.velocity, m.release]), clip.notes.map((m) => [m.pitch, m.cents, m.lyric, m.velocity, m.release]));
          const marksOk = equal(r.part.marks, [...dst.marks.filter((m) => !clip.marks.some((k) => at + k.at * dst.grid / clip.grid === m.at)), ...clip.marks.map((k) => ({ ...k, at: at + k.at * dst.grid / clip.grid }))].sort((p, q) => p.at - q.at));
          const timeOk = equal([r.part.singer, r.part.tempo, r.part.meter, r.part.title, r.part.grid], [dst.singer, dst.tempo, dst.meter, dst.title, dst.grid]);
          if (!(ok && notesOk && marksOk && timeOk)) bad.push(`${what}: ${[ok ? "" : "vibrato", notesOk ? "" : "notes", marksOk ? "" : "marks", timeOk ? "" : "singer or time"].filter(Boolean).join(", ")}`);
        }
      }
    }
  }
  check(!bad.length && pastes === 6 * 4 * 6 * 5, `every example's notes, whole and in pieces, pasted into every example at five beats, grids converted: the notes added, the vibrato the clip's in the paste and the part's around it, marks merged, singer and time the part's (${pastes} pastes)`);
  for (const b of bad.slice(0, 8)) console.log(`     ${b}`);

  // drawn at random on a coarse grid, so that points, pairs, notes' ends and pastes meet often
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
  const lane = () => {
    const out = [];
    let t = rand(3);
    for (let k = rand(7); k > 0; k--) {
      const line = out.length > 0 && rand(2) === 0, v = [0.25, 0.5, 1, 1.5, 2][rand(5)];
      out.push(pt(t, v, line));
      if (line && rand(3) === 0) out.push(pt(t, [0.25, 0.75, 1.25][rand(3)]));
      t += 1 + rand(4);
    }
    return out;
  };
  const tune = () => {
    const out = [];
    for (let t = rand(4), k = 1 + rand(5); k > 0; k--, t += 1 + rand(3)) out.push(note(t, 1 + rand(3), ["C4", "D4", "E4"][rand(3)], "la"));
    return out;
  };
  let tries = 0, wrong = [];
  for (let k = 0; k < 4000; k++) {
    const src = made(tune(), lane(), [], 4), dst = made(tune(), lane(), [], 4);
    const pick = src.notes.filter(() => rand(3) > 0);
    if (!pick.length) continue;
    const at = rand(30);
    let clip, r;
    try {
      clip = C.read(C.copy(src, pick));
      r = C.paste(dst, clip, at);
    } catch (e) {
      wrong.push(`${k}: ${e.message}`);
      continue;
    }
    tries++;
    const start = pick.reduce((m, n) => Math.min(m, n.at), Infinity), stop = at + clip.len;
    const x = src.lanes.vibrato, y = dst.lanes.vibrato, z = r.part.lanes.vibrato;
    for (let t = 0; t < 50; t++) {
      const want = t >= at && t < stop && x.length ? P.at(x, t - at + start, 1) : P.at(y, t, 1);
      if (!near(P.at(z, t, 1), want)) { wrong.push(`${k}: tick ${t}: ${P.at(z, t, 1)}, not ${want}`); break; }
    }
  }
  check(!wrong.length && tries > 2500, `lanes drawn at random, copied and pasted: always a part the text holds, the vibrato the source's in the paste and the part's around it (${tries} pastes)`);
  for (const w of wrong.slice(0, 8)) console.log(`     ${w}`);

  // marks: a pasted one wins its beat
  const src = made([note(0, G, "C4", "a"), note(2 * G, G, "D4", "b")], [], [{ at: 2 * G, breath: true }]);
  const dst = made([note(8 * G, G, "C4", "c")], [], [{ at: 6 * G, breath: false }, { at: 9 * G, breath: false }]);
  const m = C.paste(dst, C.read(C.copy(src, src.notes)), 4 * G).part.marks;
  check(equal(m, [{ at: 6 * G, breath: true }, { at: 9 * G, breath: false }]), "marks merged, the pasted one winning its beat");
  const o = C.paste(dst, C.read(C.copy(src, [src.notes[0]])), 6 * G).part.marks;
  check(equal(o, [{ at: 6 * G, breath: false }, { at: 9 * G, breath: false }]), "a clip with no mark leaves the part's");

  // over
  const full = made([note(0, 3 * G, "C4", "long"), note(4 * G, G, "D4", "gone"), note(5 * G, 3 * G, "E4", "too"), note(8 * G, G, "F4", "stays")], [], [{ at: 4 * G, breath: true }, { at: 8 * G, breath: true }]);
  const pair = made([note(0, G, "G4", "new"), note(G, G, "A4", "ones")]), two = C.read(C.copy(pair, pair.notes));
  const plain = C.paste(full, two, 2 * G).part, over = C.paste(full, two, 2 * G, { over: true }).part;
  check(equal(brief(plain), ["0+3 C4 long", "2+1 G4 new", "3+1 A4 ones", "4+1 D4 gone", "5+3 E4 too", "8+1 F4 stays"]), "a plain paste adds to the notes there");
  check(equal(brief(over), ["0+2 C4 long", "2+1 G4 new", "3+1 A4 ones", "4+1 D4 gone", "5+3 E4 too", "8+1 F4 stays"]), "a paste over: the note sounding into it ends where it starts");
  const wide = C.paste(full, C.read(C.copy(full, full.notes.slice(1, 3))), 3 * G, { over: true }).part;
  check(equal(brief(wide), ["0+3 C4 long", "3+1 D4 gone", "4+3 E4 too", "8+1 F4 stays"]) && equal(wide.marks, [{ at: 3 * G, breath: true }, { at: 8 * G, breath: true }]), "a paste over: the notes starting in its stretch gone, and the marks there, the pasted ones in");

  // grids
  const fine = made([note(0, G / 2, "C4", "a"), note(G / 2, G / 3, "D4", "b"), note(G / 2 + G / 3, G / 6, "E4", "c")]);
  const coarse = C.paste(blank(96), C.read(C.copy(fine, fine.notes)), 96);
  check(equal(brief(coarse.part), ["1+0.5 C4 a", "1.5+0.333333 D4 b", "1.833333+0.166667 E4 c"]) && coarse.part.grid === 96, "a clip on a grid of 960 pasted into one of 96: the same beats");
  const into480 = C.paste(blank(480), C.read(P.write(EXAMPLES.every())), 480);
  check(equal(brief(into480.part), brief(EXAMPLES.every())), "every pasted into a grid of 480 from beat 1, where it starts: the same beats");
  const tenth = made([note(0, G, "C4"), note(96, G, "D4")]);
  check(threw(() => C.paste(blank(96), C.read(C.copy(tenth, tenth.notes)), 96 * 2)) === "the note falls between the ticks of this part's grid (96 a beat), near beat 2.1; the clip's grid is 960 a beat", "a note off a whole tick of the part's grid is refused, naming the beat");
  const third = made([note(0, G / 3, "C4")]);
  check(/^the end of the note at beat 0 falls between the ticks of this part's grid \(4 a beat\), near beat 0\.333333/.test(threw(() => C.paste(blank(4), C.read(C.copy(third, third.notes)), 0))), "a note's end off a whole tick is refused, naming the note");
  const tiny = made([note(0, 1, "C4"), note(5, 32767, "D4")], [], [], 32767);
  check(threw(() => C.paste(blank(1), C.read(C.copy(tiny, tiny.notes)), 0)) === "the note at beat 0 would be shorter than a tick on this part's grid (1 a beat)", "a note shorter than a tick of the part's grid is refused");
  check(threw(() => C.paste(blank(), two, -1)) === "paste at tick -1: a whole number of ticks from 0" && threw(() => C.paste(blank(), two, 0.5)) === "paste at tick 0.5: a whole number of ticks from 0", "a paste before the start or off a tick is refused");
  const before = P.write(full);
  check(threw(() => C.paste(full, C.read(C.copy(tenth, tenth.notes)), 1, {})) === null && P.write(full) === before, "the part pasted into is not changed: a new part is made");

  // what is said
  const held = made([note(0, G, "C4", "Ma-"), note(G, G, "D4", "_"), note(2 * G, G, "E4", "ry"), note(3 * G, G, "F4", "lit-")]);
  const run = C.paste(blank(), C.read(C.copy(held, held.notes.slice(1))), 0);
  check(equal(run.said, ["the pasted notes start on _: beat 0 holds the syllable sung before it", "the pasted notes end inside a word: \"lit-\" at beat 2 runs on into the next syllable"]), "a pasted run starting on _ and ending inside a word is said");
  const slow = { ...blank(), tempo: [{ at: 0, bpm: 72 }], notes: [note(0, G, "C4", "la")] };
  check(equal(C.paste(blank(), C.read(C.copy(slow, slow.notes)), 0).said, ["the clip's tempo is not this part's here (72 against 120 beats a minute): its notes keep their beats"]), "a clip at another tempo is said");
  const changes = { ...blank(), tempo: [{ at: 0, bpm: 120 }, { at: 4 * G, bpm: 72 }] };
  check(equal(C.paste(changes, C.read(C.copy(slow, slow.notes)), 4 * G).said, []) && C.paste(changes, C.read(C.copy(slow, slow.notes)), 3 * G).said.length === 1, "pasted where the part's tempo is the clip's, nothing is said; where it changes inside the paste, it is");
}

// ---------------------------------------------------------------- duplicate

{
  const src = made([note(0, G, "C4", "one"), note(G, G / 2, "D4", "two"), note(2 * G, G, "E4", "three")], [pt(0, 0.5), pt(2 * G, 1.5, true)], [{ at: 0, breath: true }]);
  const d = C.duplicate(src, src.notes, G);
  check(d.at === 3 * G && equal(brief(d.part), ["0+1 C4 one", "1+0.5 D4 two", "2+1 E4 three", "3+1 C4 one", "4+0.5 D4 two", "5+1 E4 three"]) && d.notes.length === 3, "three notes duplicated right after themselves, the copies given back");
  check(equal(d.part.lanes.vibrato, [pt(0, 0.5), pt(2 * G, 1.5, true), pt(3 * G, 0.5), pt(5 * G, 1.5, true)]) && equal(d.part.marks, [{ at: 0, breath: true }, { at: 3 * G, breath: true }]), "their vibrato and their mark go with them");
  const short = C.duplicate(src, [src.notes[1]], G);
  check(short.at === 2 * G && equal(brief(short.part).slice(2), ["2+0.5 D4 two", "2+1 E4 three"]), "a half beat duplicated on a step of a beat: the copy a beat on");
  const off = made([note(G / 2, G, "C4", "up"), note(3 * G / 2, G / 2, "D4", "beat")]);
  const o = C.duplicate(off, off.notes, G);
  check(o.at === G / 2 + 2 * G && equal(brief(o.part), ["0.5+1 C4 up", "1.5+0.5 D4 beat", "2.5+1 C4 up", "3.5+0.5 D4 beat"]), "notes starting off the step: the copy falls against the beat as they do");
  const ed = new Editor(src);
  const r = C.duplicate(ed.part, [...ed.part.notes], G / 4);
  ed.commit(r.part, new Set(r.notes));
  check(ed.part.notes.length === 6 && ed.selected.size === 3 && [...ed.selected].every((n) => n.at >= 3 * G), "committed to the editor: one change, the copies chosen");
  check(ed.undo() && ed.part === src && !ed.undo(), "and undone as one");
  check(threw(() => C.duplicate(src, src.notes, 0)) === "step 0: a whole number of ticks, 1 at least", "a step of no ticks is refused");
}

// ---------------------------------------------------------------- a 0 of vibrato under motion -

{
  const notes = [note(0, G, "C4", "la"), note(G, G, "D4", "la")], lane = [pt(0, 0), pt(2 * G, 0.5)];
  const moving = { ...made(notes, lane), singer: { ...blank().singer, motion: "vibrato" } };
  const drawn = { ...made([]), singer: { ...blank().singer, motion: null } };
  const clip = C.read(C.copy(moving, moving.notes));
  check(threw(() => C.paste(drawn, clip, 4 * G)) === "the paste is refused: its vibrato is 0 at beat 4, where the singer it was copied from has the motion vibrato and does not sing it, and this singer's motion is -, so its notes there would be held flat. Raise that point before copying, or give this singer a motion", "a 0 copied from a singer with a motion, never sung, is not pasted under -");
  check(C.paste({ ...drawn, singer: { ...drawn.singer, motion: "wide" } }, clip, 4 * G).part.lanes.vibrato[0].value === 0, "under a motion it goes in, as it is not sung there");
  const own = { ...moving, singer: { ...moving.singer, motion: null } };
  check(C.paste(drawn, C.read(C.copy(own, own.notes)), 4 * G).part.lanes.vibrato.some((q) => q.at === 4 * G && q.value === 0), "a 0 drawn and sung under - is the person's, and goes in as it is");
}

console.log(fails ? `${fails} failed` : "all ok");
process.exit(fails ? 1 : 0);
