// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// time.js: bars put in, taken out and sung again, the music moved keeping its notes, words,
// vibrato (value for value), marks, tempos and meters; tempo and meter changes set and taken away;
// what cannot be done refused by its beat. node time_test.mjs
import assert from "node:assert/strict";
import * as P from "./part.js";
import * as Tm from "./time.js";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const G = 960, BAR = 4 * G;
const brief = (p) => p.notes.map((n) => `${P.beat(n.at, G)}+${P.beat(n.ticks, G)} ${n.pitch}${n.lyric === null ? "" : ` ${n.lyric}`}`);
const note = (beat, beats, pitch, lyric) => ({ at: beat * G, ticks: beats * G, pitch, cents: 0, velocity: 80, release: 64, lyric });
const pt = (beat, value, line = false) => ({ at: beat * G, value, line });
const near = (a, b) => Math.abs(a - b) < 1e-5;
// the lane's value at every eighth of a beat from `a` to `b` (beats), as f maps a tick of the part
// before to the part after; or the ticks where they differ
const vibAt = (p, t) => P.at(p.lanes.vibrato, t, P.REST.vibrato);
const kept = (was, now, a, b, f) => {
  const off = [];
  for (let t = a * G; t < b * G; t += G / 8) if (!near(vibAt(was, t), vibAt(now, f(t)))) off.push(`${P.beat(t, G)}: ${vibAt(was, t)} became ${vibAt(now, f(t))}`);
  return off;
};

// a part with notes across bar lines, a tempo and a meter change, marks, and a vibrato of lines,
// holds and a jump on a line's beat
const part = () => ({
  ...P.blank(P.singer("6147", 3)),
  tempo: [{ at: 0, bpm: 100 }, { at: 9 * G, bpm: 80 }],
  meter: [{ at: 0, n: 4, d: 4 }, { at: 12 * G, n: 3, d: 4 }],
  notes: [note(0, 1, "C4", "Ma-"), note(1, 1, "D4", "ry"), note(3, 2, "E4", "had"), note(5, 1, "F4", "a"), note(8, 1, "G4", "lit-"), note(9, 1, "A4", "tle"), note(12, 3, "B4", "lamb")],
  lanes: { vibrato: [pt(0, 1), pt(2, 0.5, true), pt(6, 1.5, true), pt(8, 2, true), pt(8, 0.8), pt(10, 1.2, true)] },
  marks: [{ at: 3 * G, breath: true }, { at: 8 * G, breath: false }],
});

// ---- bars
{
  const p = part();
  check(Tm.barLine(p, 6 * G) === 4 * G && Tm.barLine(p, 12 * G) === 12 * G && Tm.barLine(p, 16 * G) === 15 * G, "the bar line at or before a beat, a meter's bars laid from its own beat");
  check(Tm.barOf(p, 0) === 1 && Tm.barOf(p, 9 * G) === 3 && Tm.barOf(p, 12 * G) === 4 && Tm.barOf(p, 15 * G) === 5, "bars numbered as the roll numbers them");
  check(Tm.barsFrom(p, 8 * G, 1) === 12 * G && Tm.barsFrom(p, 8 * G, 2) === 15 * G && Tm.barsFrom(p, 0, 4) === 15 * G, "bars counted on across a change of meter, each as long as its meter has it");
  const odd = { ...p, meter: [{ at: 0, n: 4, d: 4 }, { at: 10 * G, n: 3, d: 8 }] };
  check(Tm.barsFrom(odd, 8 * G, 1) === 10 * G && Tm.barOf(odd, 10 * G) === 4, "a bar cut short by a meter mid-bar is a bar");
  check(threw(() => Tm.barsFrom(p, 0, 0)) === "0 bars: a whole number, 1 or more", "no bars refused");
}

// ---- tempo and meter
{
  const p = part();
  check(equal(Tm.tempo(p, 4 * G, 132).tempo, [{ at: 0, bpm: 100 }, { at: 4 * G, bpm: 132 }, { at: 9 * G, bpm: 80 }]), "a tempo change put in its place among the others");
  check(equal(Tm.tempo(p, 9 * G, 90).tempo, [{ at: 0, bpm: 100 }, { at: 9 * G, bpm: 90 }]), "a tempo change on a beat that has one changes it");
  check(equal(Tm.tempo(p, 9 * G, null).tempo, [{ at: 0, bpm: 100 }]), "and taken away");
  check(threw(() => Tm.tempo(p, 0, null)) === "the tempo at beat 0 is where the part starts: change it; it cannot be taken away", "the first tempo cannot be taken away");
  check(threw(() => Tm.tempo(p, 3 * G, null)) === "no tempo change at beat 3 to take away", "nor one that is not there");
  check(threw(() => Tm.tempo(p, 3 * G, 2)) === "tempo 2: 4 to 60000000 beats a minute", "a tempo the text cannot hold refused");
  check(equal(Tm.meter(p, 8 * G, 6, 8).meter, [{ at: 0, n: 4, d: 4 }, { at: 8 * G, n: 6, d: 8 }, { at: 12 * G, n: 3, d: 4 }]) && equal(Tm.meter(p, 12 * G, null).meter, [{ at: 0, n: 4, d: 4 }]), "a meter change put in, and taken away");
  check(threw(() => Tm.meter(p, 4 * G, 5, 3)) === "meter 5/3: 1 to 255 notes of a 1st, 2nd, 4th, 8th, 16th or 32nd", "a meter the text cannot hold refused");
}

// ---- bars put in
{
  const p = part(), r = Tm.insert(p, 4 * G, BAR), q = r.part;
  check(equal(brief(q), ["0+1 C4 Ma-", "1+1 D4 ry", "3+6 E4 had", "9+1 F4 a", "12+1 G4 lit-", "13+1 A4 tle", "16+3 B4 lamb"]) && r.held === 1, "a bar put in at beat 4: the notes from there move on, the one sounding across it holds through");
  check(equal(q.tempo, [{ at: 0, bpm: 100 }, { at: 13 * G, bpm: 80 }]) && equal(q.meter, [{ at: 0, n: 4, d: 4 }, { at: 16 * G, n: 3, d: 4 }]), "the changes after it move on");
  check(equal(q.marks, [{ at: 3 * G, breath: true }, { at: 12 * G, breath: false }]), "the marks move with their notes");
  check(!kept(p, q, 0, 4, (t) => t).length && !kept(p, q, 4, 14, (t) => t + BAR).length, `the vibrato before it as it was, and after it moved on value for value ${kept(p, q, 4, 14, (t) => t + BAR).join("; ")}`);
  check(q.lanes.vibrato.filter((x) => x.at >= 4 * G && x.at <= 8 * G).every((x) => near(x.value, 1.0)), "the line running across it comes to its value there and holds it through the bar put in");
  // put in on a point a line reaches, and on the line's jump
  const on = Tm.insert(p, 8 * G, BAR).part;
  check(!kept(p, on, 0, 8, (t) => t).length && !kept(p, on, 8, 14, (t) => t + BAR).length && on.lanes.vibrato.some((x) => x.at === 8 * G && x.line && x.value === 2), "put in where a line arrives and the lane jumps: it arrives, holds, and the jump comes with the music");
  const p2 = { ...p, tempo: [{ at: 0, bpm: 100 }, { at: 4 * G, bpm: 70 }] };
  check(equal(Tm.insert(p2, 4 * G, BAR).part.tempo, [{ at: 0, bpm: 100 }, { at: 4 * G, bpm: 70 }]), "a change on the beat put in at stays there: the bars put in are of the tempo in force there");
  check(equal(Tm.insert(p, 0, BAR).part.tempo, [{ at: 0, bpm: 100 }, { at: 13 * G, bpm: 80 }]) && Tm.insert(p, 0, BAR).part.notes[0].at === BAR, "a bar put in at the start");
  check(threw(() => Tm.insert(p, 4 * G, 0)) === "0 ticks put in: a whole number, 1 or more", "nothing put in refused");
}

// ---- bars taken out
{
  const p = part(), r = Tm.cut(p, 4 * G, 8 * G), q = r.part, by = 4 * G;
  check(equal(brief(q), ["0+1 C4 Ma-", "1+1 D4 ry", "3+1 E4 had", "4+1 G4 lit-", "5+1 A4 tle", "8+3 B4 lamb"]) && r.gone === 1 && r.shortened === 1, "beats 4 to 8 taken out: the note in them goes, the one sounding into them is cut short, those after move back");
  check(equal(q.tempo, [{ at: 0, bpm: 100 }, { at: 5 * G, bpm: 80 }]) && equal(q.meter, [{ at: 0, n: 4, d: 4 }, { at: 8 * G, n: 3, d: 4 }]) && equal(q.marks, [{ at: 3 * G, breath: true }, { at: 4 * G, breath: false }]), "the changes and marks after move back");
  check(!kept(p, q, 0, 4, (t) => t).length && !kept(p, q, 8, 14, (t) => t - by).length, `the vibrato before as it was, and after moved back value for value ${kept(p, q, 8, 14, (t) => t - by).join("; ")}`);
  // a stretch that a line runs across, and one where the tempo changes inside
  const mid = Tm.cut(p, 7 * G, 9 * G).part;
  check(!kept(p, mid, 0, 7, (t) => t).length && !kept(p, mid, 9, 14, (t) => t - 2 * G).length, `a stretch inside a line taken out: both sides keep their values ${kept(p, mid, 9, 14, (t) => t - 2 * G).join("; ")}`);
  check(equal(mid.tempo, [{ at: 0, bpm: 100 }, { at: 7 * G, bpm: 80 }]), "taken out over a tempo change: the tempo where it ends is in force where it began");
  const long = { ...p, notes: [note(2, 10, "C4", "oh")] };
  check(equal(brief(Tm.cut(long, 4 * G, 8 * G).part), ["2+6 C4 oh"]), "a note across the whole stretch is shorter by it");
  check(equal(Tm.cut(p, 0, 9 * G).part.tempo, [{ at: 0, bpm: 80 }]), "taken out from the start: the tempo where it ends is the first");
  check(threw(() => Tm.cut(p, 4 * G, 4 * G)) === "bars taken out from beat 4 to beat 4: nothing between", "nothing to take out refused");
}

// ---- bars sung again
{
  const p = { ...part(), notes: part().notes.filter((n) => n.at !== 3 * G) };
  const r = Tm.repeat(p, 4 * G, 8 * G, 2), q = r.part, len = 4 * G;
  check(equal(brief(q), ["0+1 C4 Ma-", "1+1 D4 ry", "5+1 F4 a", "9+1 F4 a", "13+1 F4 a", "16+1 G4 lit-", "17+1 A4 tle", "20+3 B4 lamb"]) && r.notes === 2, "beats 4 to 8 sung twice more: their note and its word laid again, what came after moved on");
  check(equal(q.tempo, [{ at: 0, bpm: 100 }, { at: 17 * G, bpm: 80 }]) && equal(q.meter, [{ at: 0, n: 4, d: 4 }, { at: 20 * G, n: 3, d: 4 }]), "the changes after move on");
  const off = [...kept(p, q, 0, 8, (t) => t), ...kept(p, q, 4, 8, (t) => t + len), ...kept(p, q, 4, 8, (t) => t + 2 * len), ...kept(p, q, 8, 14, (t) => t + 2 * len)];
  check(!off.length, `the vibrato laid again with them, each time from the value at its start, and after them as it was ${off.join("; ")}`);
  // a stretch with a tempo change and a mark inside
  const p2 = { ...p, tempo: [{ at: 0, bpm: 100 }, { at: 6 * G, bpm: 90 }, { at: 9 * G, bpm: 80 }], marks: [{ at: 5 * G, breath: true }] };
  const q2 = Tm.repeat(p2, 4 * G, 8 * G, 1).part;
  check(equal(q2.tempo, [{ at: 0, bpm: 100 }, { at: 6 * G, bpm: 90 }, { at: 8 * G, bpm: 100 }, { at: 10 * G, bpm: 90 }, { at: 13 * G, bpm: 80 }]) && equal(q2.marks, [{ at: 5 * G, breath: true }, { at: 9 * G, breath: true }]), "a tempo change and a mark inside are laid again; each time starts at the tempo it started at");
  check(threw(() => Tm.repeat(part(), 0, 4 * G, 1)) === "the note E4 at beat 3 sounds on past beat 4, where the bars sung again end: shorten it, or take the bars to where it ends", "a note sounding past the stretch's end refused by its beat");
  check(threw(() => Tm.repeat(p, 4 * G, 8 * G, 0)) === "0 times: a whole number, 1 or more", "no times refused");
  // a line running across the stretch's end and on, and one arriving at its start
  const lane = { ...p, lanes: { vibrato: [pt(0, 1), pt(4, 0.6, true), pt(6, 1.4), pt(10, 0.4, true)] } };
  const q3 = Tm.repeat(lane, 4 * G, 8 * G, 3).part;
  const off3 = [...kept(lane, q3, 0, 8, (t) => t), ...[1, 2, 3].flatMap((k) => kept(lane, q3, 4, 8, (t) => t + k * len)), ...kept(lane, q3, 8, 14, (t) => t + 3 * len)];
  check(!off3.length, `a line into the stretch's start and one across its end: every time and what follows keep their values ${off3.join("; ")}`);
}

// ---- many lanes and stretches drawn by chance (the same each run): every part made can be
// written, and the vibrato moved keeps its values
{
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  const lane = () => {
    const pts = [pt(0, 1)];
    for (let b = 1 + rand(3); b < 16; b += 1 + rand(3)) {
      const line = rand(2) === 1;
      pts.push(pt(b, rand(20) / 10, line));
      if (line && rand(3) === 0) pts.push(pt(b, rand(20) / 10));
    }
    return pts;
  };
  let bad = [];
  for (let k = 0; k < 400; k++) {
    const p = { ...P.blank(P.singer("6147", 3)), lanes: { vibrato: lane() } }, a = rand(14), b = a + 1 + rand(4), n = 1 + rand(3);
    const tries = [
      ["put in", () => Tm.insert(p, a * G, (b - a) * G).part, [[0, a, (t) => t], [a, 18, (t) => t + (b - a) * G]]],
      ["taken out", () => Tm.cut(p, a * G, b * G).part, [[0, a, (t) => t], [b, 18, (t) => t - (b - a) * G]]],
      ["sung again", () => Tm.repeat(p, a * G, b * G, n).part, [[0, b, (t) => t], ...Array.from({ length: n }, (_, i) => [a, b, (t) => t + (i + 1) * (b - a) * G]), [b, 18, (t) => t + n * (b - a) * G]]],
    ];
    for (const [what, f, spans] of tries) {
      let q;
      try {
        q = f();
        P.read(P.write(q));
      } catch (e) {
        bad.push(`${what} ${a} to ${b}: ${e.message}`);
        continue;
      }
      const off = spans.flatMap(([x, y, g]) => kept(p, q, x, y, g));
      if (off.length) bad.push(`${what} ${a} to ${b} of ${JSON.stringify(p.lanes.vibrato)}: ${off[0]}`);
    }
  }
  check(!bad.length, `400 lanes drawn by chance, each with bars put in, taken out and sung again: every part written and read back, every value kept${bad.length ? `\n     ${bad.slice(0, 3).join("\n     ")}` : ""}`);
}

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
