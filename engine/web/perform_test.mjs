// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// perform.js: a song read, its lanes, its vibrato sized; choirs.js's arranging (the engine's, in the
// wasm) and its presets. How a part is performed is the engine's, tested in engine/tests/perform.rs.
// node perform_test.mjs LIPSERVICE.wasm
import { readFileSync } from "node:fs";
import { Engine } from "./lipservice.js";
import { parse, laned, sized, asked } from "./perform.js";
import { FULL_CHOIR, LOUD, setEngine } from "./room.js";
import { RANGES } from "./voices_ranges.js";
import { REFL_SUM } from "./choir.js";
import { CHOIRS, ROUTES, VIBRATO, arrange, vibrato } from "./choirs.js";

if (!process.argv[2]) { console.error("usage: node perform_test.mjs LIPSERVICE.wasm"); process.exit(2); }
setEngine(await Engine.create(readFileSync(process.argv[2])));

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const notes = (ph) => ph.words.flatMap((w) => w.groups.flat());
const len = (ph) => notes(ph).reduce((a, x) => a + x.beats, 0);
const end = (ph) => ph.start + len(ph);

const SONG = "%bpm 90\n# a test\n%rest 2\nla C4:1 D4:0.5+E4:0.5\nlee G4:2\n%rest 1\n%rest 1\nla A4:0.75 G4:0.25\n%rest 0.5\nloo F4:3\n%rest 0.25\nla C4:2\n%rest 1\n";

// ---- parse
{
  const s = parse(SONG);
  check(s.bpm === 90 && s.tail === 1 && s.phrases.length === 4, "parse: bpm, phrases between rests, the tail");
  check(s.phrases.map((p) => p.start).join() === "2,8,9.5,12.75" && s.phrases.map(len).join() === "4,1,3,2", `parse: each phrase's start and length in beats (${s.phrases.map((p) => p.start)}; ${s.phrases.map(len)})`);
  check(JSON.stringify(s.phrases[0].words[0]) === JSON.stringify({ word: "la", groups: [[{ pitch: "C4", beats: 1 }], [{ pitch: "D4", beats: 0.5 }, { pitch: "E4", beats: 0.5 }]] }), "parse: a word's syllables, each its notes, pitches as written");
  const bad = { "no bpm": "la C4:1\n", "bpm twice": "%bpm 90\n%bpm 80\nla C4:1\n", "no beats": "%bpm 90\nla C4\n", "zero beats": "%bpm 90\nla C4:0\n", "a bare rest": "%bpm 90\nrest\nla C4:1\n", "no words": "%bpm 90\n%rest 1\n", "a word alone": "%bpm 90\nla\n" };
  for (const [what, text] of Object.entries(bad)) check(threw(() => parse(text)) !== null, `parse: refuses ${what} (${threw(() => parse(text))})`);
}

// ---- the engine's reader and this page's, on every song of engine/tests/songs.json: the same
// reading, or the same refusal word for word
{
  // what parse() gives, from the engine's reading of the song
  const read = (s) => {
    let cur = null, tail = 0, lane = [];
    const phrases = [];
    for (const l of [...s.items, ...s.vibrato.map((v) => ({ ...v, kind: "vibrato" }))].sort((a, b) => a.line - b.line)) {
      if (l.kind === "vibrato") lane.push({ line: `%vibrato ${l.sizes.join(" ")}`, back: 0 });
      else if (l.kind === "rest") {
        for (const c of lane) c.back += l.beats;
        cur = null;
        tail = l.beat + l.beats - (phrases.length ? end(phrases.at(-1)) : l.beat + l.beats);
      } else {
        if (!cur) { cur = { start: l.beat, words: [] }; phrases.push(cur); }
        cur.words.push({ word: l.braces === null ? l.word : `${l.word}{${l.braces}}`, groups: l.notes.map((g) => g.map((x) => ({ pitch: x.note, beats: x.beats }))), ...(lane.length ? { lane } : {}) });
        lane = [];
        tail = 0;
      }
    }
    return { bpm: s.bpm, phrases, tail, ...(lane.length ? { after: lane.map((c) => c.line) } : {}), ...(s.diction.length ? { diction: s.diction.map((d) => `%diction ${d.text}`) } : {}), ...(s.together ? { together: true } : {}) };
  };
  const cases = JSON.parse(readFileSync(new URL("../tests/songs.json", import.meta.url), "utf8"));
  const engine = await Engine.create(readFileSync(process.argv[2]));
  const wrong = [];
  for (const c of cases) {
    const ours = threw(() => parse(c.text));
    const theirs = threw(() => engine.song(c.text));
    if (c.refused !== undefined ? ours !== c.refused || theirs !== c.refused : ours !== null || theirs !== null || JSON.stringify(parse(c.text)) !== JSON.stringify(read(c.song)) || JSON.stringify(engine.song(c.text)) !== JSON.stringify(c.song)) {
      wrong.push(`${c.name}: page ${ours ?? JSON.stringify(parse(c.text))}; engine ${theirs ?? "read"}; file ${c.refused ?? JSON.stringify(read(c.song))}`);
    }
  }
  check(cases.length >= 60 && wrong.length === 0, `songs.json: ${cases.length} songs read by the page as by the engine, refusals word for word${wrong.length ? `\n  ${wrong.join("\n  ")}` : ""}`);
}

// ---- lanes: SONG with a vibrato written along it
{
  const LANED = "%bpm 90\n%vibrato 0\n%rest 2\nla C4:1 D4:0.5+E4:0.5\n%vibrato 1:2\nlee G4:2\n%vibrato 0\n%rest 1\n%vibrato 0.5 2:3\n%rest 1\nla A4:0.75 G4:0.25\n%rest 0.5\nloo F4:3\n%rest 0.25\nla C4:2\n%vibrato 0.3\n%rest 1\n";
  const s = parse(LANED), plain = parse(SONG);
  const bare = (x) => JSON.stringify({ ...x, after: undefined, phrases: x.phrases.map((ph) => ({ ...ph, words: ph.words.map((w) => ({ ...w, lane: undefined })) })) });
  const lanes = (x) => JSON.stringify([x.phrases.map((ph) => ph.words.map((w) => w.lane ?? null)), x.after ?? null]);
  check(bare(s) === JSON.stringify(plain) && laned(s) && !laned(plain), "lanes: the notes are the song's without them");
  const want = [[[{ line: "%vibrato 0", back: 2 }], [{ line: "%vibrato 1:2", back: 0 }]], [[{ line: "%vibrato 0", back: 2 }, { line: "%vibrato 0.5 2:3", back: 1 }]], [null], [null]];
  check(lanes(s) === JSON.stringify([want, ["%vibrato 0.3"]]), `lanes: a line stays with the word after it, the beats of rest between them counted (${lanes(s)})`);
  {
    // a diction line is the song's, not a word; a word called diction is a word
    const d = parse("%bpm 90\n%diction word=mild -> M AY AH L D\nla C4:1\nmild D4:1 E4:1\ndiction F4:1\n");
    check(JSON.stringify(d.diction) === '["%diction word=mild -> M AY AH L D"]' && d.phrases[0].words.map((w) => w.word).join(" ") === "la mild diction" && !("diction" in parse(SONG)), "parse: a diction line is a rule of the song's, a word called diction a word");
  }
  {
    const part = { name: "High", voice: "6345", song: SONG, gain: 1, seat: 0, diction: [] };
    const forOne = { ...part, diction: ["for=low B,D,G -> dip=0"] };
    check(asked(part) === asked({ ...part, name: "Low", gain: 2, seat: 1 }) && asked(forOne) !== asked({ ...forOne, name: "Low" }), "asked: a part's name is how it is sung only where a rule is for someone");
  }
  check(threw(() => parse("%bpm 90\n%vibrato\nla C4:1\n")) !== null, `lanes: refuses a line with no sizes (${threw(() => parse("%bpm 90\n%vibrato\nla C4:1\n"))})`);
  // sized: every size written, and the voice's own they start from
  check(sized(LANED, 1) === LANED && sized(LANED, 0.5) === LANED.replace("%bpm 90\n", "%bpm 90\n%vibrato 0.5\n").replace("%vibrato 1:2", "%vibrato 0.5:2").replace("%vibrato 0.5 2:3", "%vibrato 0.25 1:3").replace("%vibrato 0.3", "%vibrato 0.15"),
    `sized: a song's vibrato half the size (${JSON.stringify(sized(LANED, 0.5))})`);
  check(sized(SONG, 0.6) === SONG.replace("%bpm 90\n", "%bpm 90\n%vibrato 0.6\n") && threw(() => sized(SONG, -1)) !== null && threw(() => sized("%bpm 90\n%vibrato x\nla C4:1\n", 0.5)) !== null && threw(() => sized("la C4:1\n", 0.5)) !== null,
    "sized: a song with no lines starts from the size; refuses a size under 0, a line that is not sizes, a song with no bpm");
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
  check(how.every((p) => p.glide === 4 && p.dynamics === 0 && p.breath === 0.2 && p.breathiness === 1 && JSON.stringify(p.diction) === JSON.stringify(c.style.diction) && p.tags.length === 0), "arrange: glide, dynamics, breaths and breathiness in place of the preset's");
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
    return !(j.parts.every((p) => typeof p.song === "string" && p.song.startsWith("%bpm ") && p.at >= 0 && p.gain > 0) && seats.size === j.parts.length && Math.max(...seats) === j.parts.length - 1
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
  const highest = (p) => Math.max(...p.song.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f.length > 1 && !f[0].startsWith("%"))
    .flatMap((f) => f.slice(1).flatMap((g) => g.split("+").map((x) => Number(x.slice(0, x.lastIndexOf(":"))) + p.shift))));
  const overcast = Object.entries(CHOIRS).flatMap(([n, d]) => arrange(d, { list: site, route: "hifi" }).parts.filter((p) => highest(p) > RANGES.hifi[p.voice].top + 0.5).map((p) => `${n}: ${p.name} (${p.voice}) to ${highest(p).toFixed(0)}, its top ${RANGES.hifi[p.voice].top}`));
  check(overcast.length === 0, `choirs: no part sings over its voice's measured top on the route they are cast for${overcast.length ? ` (${overcast.join("; ")})` : ""}`);
  check(bad.length === 0, `choirs: all ${Object.keys(CHOIRS).length} arrange, each part a song and a seat, each way of singing on the page's knobs${bad.length ? ` (not ${bad.join(", ")})` : ""}`);
}

console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
