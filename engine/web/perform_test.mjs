// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// perform.js: the song read, its timing loosened, breaths planned into its rests and fitted to where
// the engine puts them, against a stand-in for the engine's plan. node perform_test.mjs
import { parse, jitter, library, plan, deficits, perform, laned, sized, FPS, SR, BREATH_PRE, ONSET_MARGIN, MIN_NOTE, LEAD } from "./perform.js";
import { rng, FULL_CHOIR, LOUD } from "./room.js";
import { RANGES } from "./voices_ranges.js";
import { REFL_SUM } from "./choir.js";
import { CHOIRS, ROUTES, VIBRATO, arrange, vibrato } from "./choirs.js";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const notes = (ph) => ph.words.flatMap((w) => w.groups.flat());
const len = (ph) => notes(ph).reduce((a, x) => a + x.beats, 0);
const end = (ph) => ph.start + len(ph);

// sing.rs plan()'s silent spans, frames: the lead-in (LEAD and the song's start), each rest up to the
// next word's onset (`on` frames a word, fitted into the rest less a frame), the tail; everything
// after the lead-in later by the first onset. Refuses a rest too short for an onset of two sounds, as
// the engine does.
function engine(on) {
  const opened = [];
  const open = (text, shift) => {
    const s = parse(text), fpb = FPS * 60 / s.bpm, f = (b) => Math.round(b * fpb);
    const lead = Math.round(LEAD * FPS), t0 = lead + on;
    const rests = [[0, lead + f(s.phrases[0].start)]];
    s.phrases.forEach((ph, k) => {
      if (k === 0) return;
      const a = f(end(s.phrases[k - 1])), b = f(ph.start);
      if (b - a < 3) throw new Error(`a rest of ${b - a} frames before ${ph.words[0].word}`);
      rests.push([t0 + a, t0 + b - Math.min(on, b - a - 1)]);
    });
    if (s.tail > 0) {
      const a = f(end(s.phrases.at(-1)));
      rests.push([t0 + a, t0 + f(end(s.phrases.at(-1)) + s.tail)]);
    }
    const singer = { closed: false, close() { this.closed = true; } };
    opened.push({ text, shift, singer, rests });
    return { singer, rests };
  };
  return { open, opened };
}

const SONG = "bpm 90\n# a test\nrest 2\nla C4:1 D4:0.5+E4:0.5\nlee G4:2\nrest 1\nrest 1\nla A4:0.75 G4:0.25\nrest 0.5\nloo F4:3\nrest 0.25\nla C4:2\nrest 1\n";

// ---- parse
{
  const s = parse(SONG);
  check(s.bpm === 90 && s.tail === 1 && s.phrases.length === 4, "parse: bpm, phrases between rests, the tail");
  check(s.phrases.map((p) => p.start).join() === "2,8,9.5,12.75" && s.phrases.map(len).join() === "4,1,3,2", `parse: each phrase's start and length in beats (${s.phrases.map((p) => p.start)}; ${s.phrases.map(len)})`);
  check(JSON.stringify(s.phrases[0].words[0]) === JSON.stringify({ word: "la", groups: [[{ pitch: "C4", beats: 1 }], [{ pitch: "D4", beats: 0.5 }, { pitch: "E4", beats: 0.5 }]] }), "parse: a word's syllables, each its notes, pitches as written");
  const bad = { "no bpm": "la C4:1\n", "bpm twice": "bpm 90\nbpm 80\nla C4:1\n", "no beats": "bpm 90\nla C4\n", "zero beats": "bpm 90\nla C4:0\n", "a bare rest": "bpm 90\nrest\nla C4:1\n", "no words": "bpm 90\nrest 1\n", "a word alone": "bpm 90\nla\n" };
  for (const [what, text] of Object.entries(bad)) check(threw(() => parse(text)) !== null, `parse: refuses ${what} (${threw(() => parse(text))})`);
}

// ---- jitter
{
  const s = parse(SONG), same = jitter(s, rng("j"), 0);
  check(JSON.stringify(same.song) === JSON.stringify(s) && same.lag === 0, "jitter: none at 0 frames");
  const fpb = FPS * 60 / s.bpm;
  let ok = true, lags = true, rests = true, moved = false;
  for (let seed = 0; seed < 300; seed++) {
    const jf = 1 + (seed % 4), { song: j, lag } = jitter(s, rng(`j ${seed}`), jf);
    lags &&= Math.abs(lag) <= jf / FPS + 1e-12;
    j.phrases.forEach((ph, k) => {
      const o = s.phrases[k], a = notes(o), b = notes(ph);
      ok &&= Math.abs(len(ph) - len(o)) < 1e-9 && b.every((x) => x.beats > 0);
      ok &&= Math.abs((ph.start - o.start) * fpb) <= 2 * jf + 1e-9;
      // each boundary within jf frames of where it was, and within a fifth of the notes beside it
      let ca = 0, cb = 0;
      for (let i = 0; i + 1 < a.length; i++) {
        ca += a[i].beats; cb += b[i].beats;
        const q = Math.floor(0.2 * Math.min(a[i].beats, a[i + 1].beats) * fpb);
        ok &&= Math.abs(cb - ca) * fpb <= Math.min(jf, q) + 1e-9;
        moved ||= Math.abs(cb - ca) > 1e-9;
      }
      if (k > 0) rests &&= (ph.start - end(j.phrases[k - 1])) * fpb >= 1 - 1e-9;
    });
  }
  check(ok && moved, "jitter: phrases keep their length, notes stay positive, boundaries move up to jf frames and a fifth of a note");
  check(lags, "jitter: the first phrase's offset is the part's lag, within jf frames");
  check(rests, "jitter: every rest keeps a frame");
  const tight = parse("bpm 120\nla C4:1\nrest 0.04\nla D4:1\n"); // a rest of 2 frames
  let keeps = true;
  for (let seed = 0; seed < 200; seed++) {
    const j = jitter(tight, rng(`t ${seed}`), 4).song;
    keeps &&= (j.phrases[1].start - end(j.phrases[0])) * 50 >= 1 - 1e-9;
  }
  check(keeps, "jitter: a two-frame rest keeps a frame whatever the draw");
}

// ---- plan, no breaths
{
  const s = parse(SONG), p = plan(s, { sex: "F", lib: null, want: () => true, deck: () => "p", turn: 0 });
  const back = parse(p.text);
  check(p.reqs.length === 0 && JSON.stringify(back) === JSON.stringify(s), "plan: no breaths, the song as it was");
  const short = parse("bpm 120\nla C4:1\nrest 0.1\nla D4:1\nrest 0.12\nla E4:1\n"); // 5 and 6 frames
  const q = parse(plan(short, { sex: "F", lib: null, want: () => true, deck: () => "p", turn: 0 }).text);
  check(q.phrases.length === 2 && Math.abs(len(q.phrases[0]) - 2.1) < 1e-9 && Math.abs(q.phrases[1].start - 2.22) < 1e-9, `plan: a rest under 6 frames is held by the note before (${q.phrases.map((x) => `${x.start}+${len(x)}`)})`);
}

// ---- plan, breaths
const CLIPS = [];
for (const sex of ["F", "M"]) for (const d of [0.12, 0.2, 0.26, 0.31, 0.38, 0.45, 0.6, 0.75]) CLIPS.push({ id: `${sex}${d}`, sex, n: Math.round(d * SR) });
const lib = library(CLIPS);
{
  check(threw(() => library([{ id: "x", sex: "X", n: 10 }])) !== null && threw(() => lib.pick("X", 1, "x", 0)) !== null && threw(() => lib.pick("F", 1, "x", 0.5)) !== null, "library: refuses a sex it does not know, and a turn that is no whole number");
  const picks = Array.from({ length: 200 }, (_, i) => lib.pick("M", 0.5, `m${i >> 3}`, i));
  check(picks.every((c) => c.sex === "M" && c.dur <= 0.5 && c.dur >= 0.3), "library: a clip that fits, 0.3 s or more when there is one");
  check(lib.pick("F", 0.25, "a", 3).dur <= 0.25 && lib.pick("F", 0.1, "a", 3) === null, "library: a shorter one when that is all that fits, none when none does");
  const five = [0, 1, 2, 3, 4].map((k) => lib.pick("M", 1, "now", 40 + k).id);
  check(new Set(five).size === 5 && lib.pick("M", 1, "now", 41).id === five[1] && lib.pick("M", 1, "then", 41) !== null, `library: singers a turn apart at one moment draw different clips (${five})`);

  const s = parse(SONG), spb = 60 / s.bpm;
  const p = plan(s, { sex: "F", lib, want: () => true, deck: (j) => `b${j}`, turn: 2 });
  const back = parse(p.text);
  const total = (x) => end(x.phrases.at(-1)) + x.tail;
  check(Math.abs(total(back) - total(s)) < 1e-5, "plan: the song keeps its length");
  // the third phrase's rest is half a beat after a quarter-beat note: no room for a breath
  check(p.reqs.map((q) => `${q.j}:${q.rest}`).join() === "0:0,1:1,3:3", `plan: a breath before each phrase with room for one, in the lead-in and then the rests, counted as the engine counts them (${p.reqs.map((q) => `${q.j}:${q.rest}`)})`);
  // each rest made long enough: the clip, the silence before it and the onset's margin
  const okRoom = p.reqs.every(({ j, clip }) => {
    if (j === 0) return clip.dur <= Math.min(0.8, back.phrases[0].start * spb + LEAD - BREATH_PRE - ONSET_MARGIN) + 1e-9;
    return (back.phrases[j].start - end(back.phrases[j - 1])) * spb >= clip.dur + BREATH_PRE + ONSET_MARGIN - 1e-5;
  });
  check(okRoom, "plan: each breath's rest holds it, the silence before it and the onset's margin");
  const was = s.phrases.flatMap(notes), now = back.phrases.flatMap(notes);
  const cut = now.filter((x, i) => x.beats < was[i].beats - 1e-9).map((x) => x.beats);
  check(cut.length > 0 && cut.every((b) => b >= MIN_NOTE - 1e-6) && now.every((x, i) => x.beats <= was[i].beats + 1e-9), `plan: notes shortened for breaths keep ${MIN_NOTE} beats (${cut}), none lengthened`);
  check(back.phrases.map((ph) => ph.start).join() === s.phrases.map((ph) => ph.start).join(), "plan: every phrase starts where it did");
  const { open } = engine(4);
  check(Object.keys(deficits(open(p.text, 0).rests.map(([a, b]) => [a / FPS, b / FPS]), p.reqs)).length === 0, "deficits: none where the onsets fit the margin");
  const d = deficits([[0, 0.5], [1, 1.2]], [{ rest: 0, clip: { dur: 0.3 }, j: 0 }, { rest: 1, clip: { dur: 0.3 }, j: 5 }]);
  check(Object.keys(d).join() === "5" && Math.abs(d[5] - (0.3 + BREATH_PRE + 0.03 - 0.2)) < 1e-12, `deficits: by phrase, what a rest is short of its breath (${JSON.stringify(d)})`);
}

// ---- lanes: SONG with a vibrato written along it
{
  const LANED = "bpm 90\nvibrato 0\nrest 2\nla C4:1 D4:0.5+E4:0.5\nvibrato 1:2\nlee G4:2\nvibrato 0\nrest 1\nvibrato 0.5 2:3\nrest 1\nla A4:0.75 G4:0.25\nrest 0.5\nloo F4:3\nrest 0.25\nla C4:2\nvibrato 0.3\nrest 1\n";
  const s = parse(LANED), plain = parse(SONG);
  const bare = (x) => JSON.stringify({ ...x, after: undefined, phrases: x.phrases.map((ph) => ({ ...ph, words: ph.words.map((w) => ({ ...w, lane: undefined })) })) });
  const lanes = (x) => JSON.stringify([x.phrases.map((ph) => ph.words.map((w) => w.lane ?? null)), x.after ?? null]);
  check(bare(s) === JSON.stringify(plain) && laned(s) && !laned(plain), "lanes: the notes are the song's without them");
  const want = [[[{ line: "vibrato 0", back: 2 }], [{ line: "vibrato 1:2", back: 0 }]], [[{ line: "vibrato 0", back: 2 }, { line: "vibrato 0.5 2:3", back: 1 }]], [null], [null]];
  check(lanes(s) === JSON.stringify([want, ["vibrato 0.3"]]), `lanes: a line stays with the word after it, the beats of rest between them counted (${lanes(s)})`);
  check(threw(() => parse("bpm 90\nvibrato\nla C4:1\n")) !== null, `lanes: refuses a line with no sizes (${threw(() => parse("bpm 90\nvibrato\nla C4:1\n"))})`);
  const p = plan(s, { sex: "F", lib: null, want: () => true, deck: () => "p", turn: 0 });
  check(p.text === LANED, "lanes: planned with no breaths, the song as it was written");
  const j = jitter(s, rng("j 3"), 3).song;
  check(lanes(j) === lanes(s) && bare(j) !== bare(s), "lanes: loosened, each line is still with its word");
  // a breath's room is taken from the note before: the lines in that rest stay their beats before the word
  const q = plan(parse("bpm 90\nla C4:3\nvibrato 0\nrest 0.25\nvibrato 2:1\nla D4:2\n"), { sex: "F", lib, want: (k) => k === 1, deck: (k) => `b${k}`, turn: 2 });
  const ls = q.text.trim().split("\n"), num = (l) => Number(l.split(/[ :]/).at(-1));
  check(q.reqs.length === 1 && ls.length === 7 && ls.slice(3).join("|") === "vibrato 0|rest 0.25|vibrato 2:1|la D4:2" && ls[1].startsWith("la C4:") && ls[2].startsWith("rest ")
    && num(ls[1]) < 3 && Math.abs(num(ls[1]) + num(ls[2]) - 3) < 1e-5,
    `lanes: where a note gives a breath room, a line after it is where the note was written to end (${ls.join(" | ")})`);
  const b = plan(s, { sex: "F", lib, want: () => true, deck: (k) => `b${k}`, turn: 2 });
  check(b.reqs.length > 1 && lanes(parse(b.text)) === lanes(s) && Math.abs(parse(b.text).phrases[1].start - s.phrases[1].start) < 1e-9, "lanes: planned with breaths and read back, every line is where it was");
  // sized: every size written, and the voice's own they start from
  check(sized(LANED, 1) === LANED && sized(LANED, 0.5) === LANED.replace("bpm 90\n", "bpm 90\nvibrato 0.5\n").replace("vibrato 1:2", "vibrato 0.5:2").replace("vibrato 0.5 2:3", "vibrato 0.25 1:3").replace("vibrato 0.3", "vibrato 0.15"),
    `sized: a song's vibrato half the size (${JSON.stringify(sized(LANED, 0.5))})`);
  check(sized(SONG, 0.6) === SONG.replace("bpm 90\n", "bpm 90\nvibrato 0.6\n") && threw(() => sized(SONG, -1)) !== null && threw(() => sized("bpm 90\nvibrato x\nla C4:1\n", 0.5)) !== null && threw(() => sized("la C4:1\n", 0.5)) !== null,
    "sized: a song with no lines starts from the size; refuses a size under 0, a line that is not sizes, a song with no bpm");
  // a rest the note before holds: the line is at the word
  const held = plan(parse("bpm 120\nla C4:1\nvibrato 0\nrest 0.1\nla D4:1\nvibrato 2\n"), { sex: "F", lib: null, want: () => true, deck: () => "p", turn: 0 }).text;
  check(held === "bpm 120\nla C4:1.1\nvibrato 0\nla D4:1\nvibrato 2\n", `lanes: a line in a rest the note before holds is at the word after (${JSON.stringify(held)})`);
}

// ---- perform
const PART = { song: SONG, sex: "F", seed: 7, at: 3, jitter: 2, detune: 3, spread: 0.02, breath: 1, shift: -12 };
function fits(out, rests) {
  return out.breaths.every(({ clip, at }) => rests.some(([a, b]) => at / SR >= a / FPS + BREATH_PRE - 1e-9 && (at + clip.n) / SR <= b / FPS - 0.03 + 1e-9));
}
{
  const e = engine(4), out = perform(PART, lib, e.open);
  const last = e.opened.at(-1);
  check(e.opened.length === 1 && out.text === last.text && out.singer === last.singer && !out.singer.closed, "perform: one try when the breaths fit");
  check(out.breaths.length === 3 && fits(out, last.rests), `perform: ${out.breaths.length} breaths, each inside its rest, after its silence and before the next onset`);
  check(Math.abs(out.shift - -12) <= 0.03 && out.shift === last.shift && Math.abs(out.lag) <= 2 / FPS + 0.02, `perform: the pitch a few cents off (${((out.shift + 12) * 100).toFixed(2)}), the start a little off (${(out.lag * 1000).toFixed(1)} ms)`);
  const again = perform(PART, lib, engine(4).open);
  check(again.text === out.text && again.shift === out.shift && again.lag === out.lag && JSON.stringify(again.breaths) === JSON.stringify(out.breaths), "perform: the same part, the same performance");
  const other = perform({ ...PART, seed: 8 }, lib, engine(4).open);
  check(other.text !== out.text, "perform: another seed, another performance");
}
{
  // the engine's onsets longer than the margin: the rests come out short, the margin widens, it tries again
  const e = engine(35), out = perform(PART, lib, e.open);
  check(e.opened.length > 1 && e.opened.slice(0, -1).every((o) => o.singer.closed) && !out.singer.closed, `perform: tries again when a breath does not fit (${e.opened.length} tries), closing each singer it does not keep`);
  check(out.breaths.length > 0 && fits(out, e.opened.at(-1).rests), `perform: then ${out.breaths.length} breaths, each inside its rest`);
}
{
  // a rest written longer than its breath needs, the onset taking most of it: a wider margin moves no
  // note, so the margin goes at once to what the onset took
  const one = library([{ id: "f", sex: "F", n: 0.6 * SR, at: 0 }]);
  const song = "bpm 120\nla C4:4\nrest 3\nla C4:4\nrest 3\nla C4:4\n";
  const e = engine(82), out = perform({ ...PART, song, jitter: 0 }, one, e.open);
  check(e.opened.length === 2 && out.breaths.length === 2 && fits(out, e.opened.at(-1).rests), `perform: a long rest short of its breath by 20 ms is fitted on the second try (${e.opened.length} tries, ${out.breaths.length} breaths)`);
}
{
  // one decision a moment: parts starting phrases together breathe together
  const want = (p) => perform(p, lib, engine(4).open);
  const a = want({ ...PART, breath: 0.5, jitter: 0, spread: 0 }), b = want({ ...PART, breath: 0.5, jitter: 0, spread: 0, seed: 99, sex: "M" });
  // each in its own rests: a longer clip takes more of the note before
  const which = (o) => o.breaths.map(({ at }) => engine(4).open(o.text, 0).rests.findIndex(([x, y]) => at / SR >= x / FPS && at / SR < y / FPS)).join();
  check(which(a) === which(b) && a.breaths.length > 0 && a.breaths.length < 3, `perform: parts that start a phrase together breathe before it together, or not (${which(a)} and ${which(b)})`);
  // the size is the opener's to write (worker.js), so the engine's own perform (part.rs) stays this one to the letter
  check(perform({ ...PART, vibratoSize: 0.5 }, lib, engine(4).open).text === perform(PART, lib, engine(4).open).text, "perform: a part's vibrato size is left to who opens the song");
  check(want({ ...PART, breath: 0 }).breaths.length === 0 && perform(PART, null, engine(4).open).breaths.length === 0, "perform: no breaths at a chance of 0, or with no library");
}

{
  // choirs.js arrange(): how a choir sings, against its preset's own way
  const c = CHOIRS["Barbershop tag"], list = c.parts.map((p, i) => ({ name: p.voice, sex: i % 2 ? "M" : "F" }));
  const base = arrange(c, { list, route: "hifi", seed: 7 }).parts, same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check(same(arrange(c, { list, route: "hifi", seed: 7, how: { sway: 1, loose: 1, glide: c.style.glide, dynamics: c.style.dynamics, breath: c.style.breath, breathiness: c.style.breathiness } }).parts, base),
    "arrange: the preset's own way given back is the preset");
  check(base.every((p) => p.motion === c.style.motion && p.motionScale === 1 && p.jitter === c.style.jitter && p.detune === c.style.detune), "arrange: a part's pitch motion, at its own size, as loose as the preset");
  // each singer a machine vibrato of their own, as the sing-demos drew them, the same every time
  const vs = base.map((p) => [p.vibrato, p.vibratoHz, p.vibratoDelay]);
  check(vs.every(([d, hz, t], i) => d >= 0.15 && d <= 0.35 && hz >= 4.8 && hz <= 6 && t >= 0.2 && t <= 0.5 && same([d, hz, t], Object.values(vibrato(7 + i)))) && new Set(vs.map(String)).size === vs.length,
    `arrange: each singer a vibrato of their own (${vs.map(([d, hz, t]) => `${d.toFixed(2)} st ${hz.toFixed(1)} Hz from ${t.toFixed(2)} s`).join("; ")})`);
  const how = arrange(c, { list, route: "hifi", seed: 7, how: { sway: 0.5, loose: 2, glide: 4, dynamics: 0, breath: 0.2, breathiness: 1 } }).parts;
  check(how.every((p, i) => p.motionScale === 0.5 && Math.abs(p.vibrato - base[i].vibrato / 2) < 1e-12 && p.vibratoHz === base[i].vibratoHz), "arrange: sway scales the motion and the machine vibrato, not its rate");
  check(how.every((p, i) => p.jitter === 2 * base[i].jitter && p.detune === 2 * base[i].detune && p.spread === 2 * base[i].spread), "arrange: loose scales the timing and tuning off the mark");
  check(how.every((p) => p.glide === 4 && p.dynamics === 0 && p.breath === 0.2 && p.breathiness === 1 && p.diction === c.style.diction), "arrange: glide, dynamics, breaths and breathiness in place of the preset's");
  check(/no tremolo/.test(threw(() => arrange(c, { list, route: "hifi", how: { tremolo: 1 } })) ?? ""), "arrange: a way of singing it does not know is refused");
  check(base.every((p) => p.vibratoSize === VIBRATO) && arrange(c, { list, route: "hifi", seed: 7, how: { vibrato: 1.5 } }).parts.every((p, i) => p.vibratoSize === 1.5 && p.motionScale === 1 && p.vibrato === base[i].vibrato)
    && arrange({ ...c, style: { ...c.style, vibratoSize: 0.3 } }, { list, route: "hifi" }).parts.every((p) => p.vibratoSize === 0.3), "arrange: the vibrato alone is the preset's size or the page's, or as asked, the motion's size left");
  // a part's scale: what of the style it sings by a factor of its own, whatever the knobs say
  const own = { ...c, parts: c.parts.map((p, i) => (i === 1 ? { ...p, scale: { dynamics: 0.5, detune: 0, spread: 0 } } : p)) };
  const sc = arrange(own, { list, route: "hifi", seed: 7, how: { loose: 2, dynamics: 1 } }).parts, un = arrange(c, { list, route: "hifi", seed: 7, how: { loose: 2, dynamics: 1 } }).parts;
  check(sc[1].dynamics === 0.5 && sc[1].detune === 0 && sc[1].spread === 0 && sc[1].breathiness === un[1].breathiness && same(sc[0], un[0]), "arrange: a part's scale is a factor on the choir's way, the other parts as they were");
  check(/a scale of/.test(threw(() => arrange({ ...c, parts: c.parts.map((p) => ({ ...p, scale: { glide: 2 } })) }, { list, route: "hifi" })) ?? ""), "arrange: a scale of what has none is refused");
  // the sing-demos pieces (choirs_demos.js): every part a song, a voice of the site's, a seat of its own, and a way of singing the knobs can show
  const on = (v, lo, hi, step) => v >= lo && v <= hi && Math.abs(v / step - Math.round(v / step)) < 1e-9;
  const site = ["4446", "6345", "1088", "6147"].map((name) => ({ name, sex: "F" })).concat(["2428", "3752", "6209", "8088"].map((name) => ({ name, sex: "M" })));
  const bad = Object.entries(CHOIRS).filter(([, d]) => {
    const j = arrange(d, { list: site, route: "hifi" }), seats = new Set(j.parts.map((p) => p.seat));
    return !(j.parts.every((p) => typeof p.song === "string" && p.song.startsWith("bpm ") && p.at >= 0 && p.gain > 0) && seats.size === j.parts.length && Math.max(...seats) === j.parts.length - 1
      && on(d.style.glide, 1, 30, 1) && on(d.style.dynamics, 0, 2.5, 0.05) && on(d.style.breath, 0, 1, 0.05) && on(d.style.breathiness, 0, 1.5, 0.05) && d.source);
  }).map(([n]) => n);
  // a piece's level is one gain on every part: its measured loud passages brought to the room's LOUD, or, with none measured, all its singers at their fullest to the room's full choir
  const full = (ps) => Math.hypot(...ps.map((p) => p.gain * Math.max(...(p.levels ?? [[0, 1]]).map(([, k]) => k))));
  const written = (d) => d.parts.map((p) => (d.level ?? 1 / (d.parts.length * REFL_SUM)) * (p.gain ?? 1));
  const one = (ps, w, k) => ps.every((p, i) => Math.abs(p.gain / (w[i] * k) - 1) < 1e-9);
  const unmeasured = ROUTES.flatMap((r) => Object.keys(CHOIRS).filter((n) => !(CHOIRS[n].loud[r] < 0)).map((n) => `${n} on ${r}`));
  check(unmeasured.length === 0, `choirs: every piece has its loud passages measured on each route (choir_levels.mjs)${unmeasured.length ? ` (not ${unmeasured.join(", ")})` : ""}`);
  check(ROUTES.every((r) => ["Siuil a Ruin", "Canon in D", "Amazing Grace", "Barbershop tag"].every((n) => one(arrange(CHOIRS[n], { list: site, route: r }).parts, written(CHOIRS[n]), 10 ** ((LOUD - CHOIRS[n].loud[r]) / 20)))),
    "arrange: a measured piece's loud passages are brought to the room's level by one gain on its route, its parts as they stood to each other");
  check(/hifi or fast/.test(threw(() => arrange(CHOIRS["Canon in D"], { list: site })) ?? ""), "arrange: a choir arranged for no route is refused");
  const bare = ["Siuil a Ruin", "Canon in D"].map((n) => { const { loud, ...d } = CHOIRS[n]; return [arrange(d, { list: site, route: "hifi" }).parts, written(d)]; });
  check(bare.every(([ps, w]) => Math.abs(full(ps) / FULL_CHOIR - 1) < 1e-9 && one(ps, w, ps[0].gain / w[0])), "arrange: an unmeasured piece is set to the room's full choir, hotter or quieter as written");
  // no part is cast over its voice's measured top (voices_ranges.js): a note as it sounds, the part's shift on it
  const highest = (p) => Math.max(...p.song.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f.length > 1 && !["bpm", "rest", "vibrato", "together"].includes(f[0]))
    .flatMap((f) => f.slice(1).flatMap((g) => g.split("+").map((x) => Number(x.slice(0, x.lastIndexOf(":"))) + p.shift))));
  const overcast = Object.entries(CHOIRS).flatMap(([n, d]) => arrange(d, { list: site, route: "hifi" }).parts.filter((p) => highest(p) > RANGES.hifi[p.voice].top + 0.5).map((p) => `${n}: ${p.name} (${p.voice}) to ${highest(p).toFixed(0)}, its top ${RANGES.hifi[p.voice].top}`));
  check(overcast.length === 0, `choirs: no part sings over its voice's measured top on the route they are cast for${overcast.length ? ` (${overcast.join("; ")})` : ""}`);
  check(bad.length === 0, `choirs: all ${Object.keys(CHOIRS).length} arrange, each part a song and a seat, each way of singing on the page's knobs${bad.length ? ` (not ${bad.join(", ")})` : ""}`);
}

console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
