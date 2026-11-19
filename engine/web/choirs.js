// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// Choir presets. Each part is a song file (see the Sing tab), the voice it starts with, where it
// starts in the piece (at, s), its gain and its seat; a preset has its room, how wide its stage is
// (pan) and how its singers sing (style, perform.js and lipservice.js singer()); a part's scale is
// what of the style it sings by a factor of its own. A voice sings a
// part as the Sing tab does: written as it is for a woman, an octave down for a man. The songs are
// public domain or written for lipservice.

import { makeSeats, coprimeStep, REFL_SUM } from "./choir.js";
import { parse, laned, LANES, LEAD as SILENT } from "./perform.js";
import { rng, FULL_CHOIR, LOUD } from "./room.js";
import { LEVELS } from "./choirs_levels.js";
import { ROUTES } from "./routes.js";
export { ROUTES };
import { DEMOS } from "./choirs_demos.js";

// how the sing-demos pieces were sung: pitch motion from VocalSet's singers, a little loose in time
// and tune, breaths taken in the rests
const HUMAN = { glide: 9, dynamics: 1.3, breathiness: 0.35, diction: true };
// the vibrato's size where a preset's style gives none: under the singers' own
export const VIBRATO = 0.6;
const HYMN = { ...HUMAN, motion: "vibrato", jitter: 2, detune: 3, spread: 0, breath: 0.85 };
// a choir's singers keep time together (perform.js jitter's moments), and a note gives a breath a
// third of itself at most
const TOGETHER = true, GIVE = 1 / 3;

const fmt = (x) => x.toFixed(4).replace(/\.?0+$/, "");
const NEAR = 0.005, GAP = 0.01; // beats: how far apart a take's parts are written, and the rest a breath is taken in
const note = (m) => fmt(m + 12); // written an octave up, for a man to sing an octave down

// A part's song from its notes [{word, notes: [[midi, beats]...] (one a syllable), at (beats)}],
// time-ordered, starting `lead` beats before the first: a rest wherever one note does not run into
// the next.
function song(bpm, notes, lead) {
  const out = [`bpm ${bpm}`, `rest ${fmt(lead)}`];
  let t = notes[0].at;
  for (const n of notes) {
    if (n.at < t - 1e-9) throw new Error(`a note at ${n.at} overlaps the one before`);
    if (n.at > t + 1e-9) out.push(`rest ${fmt(n.at - t)}`);
    out.push(`${n.word} ${n.notes.map((g) => g.map(([m, b]) => `${note(m)}:${fmt(b)}`).join("+")).join(" ")}`);
    t = n.at + n.notes.flat().reduce((a, [, b]) => a + b, 0);
  }
  return out.join("\n") + "\n";
}

// choirkit.join for a part written out: after a word ending on a note of `long` beats or more, a rest
// not following, a breath may be taken: the note 0.01 beats shorter, a rest in their place.
const lined = (long) => (part) => {
  const ls = part.song.trimEnd().split("\n");
  const word = (l) => l !== undefined && !["bpm", "rest", ...LANES].includes(l.split(" ")[0]);
  const song = ls.flatMap((l, i) => {
    const m = /^(.*:)([\d.]+)$/.exec(l);
    if (!word(l) || !word(ls[i + 1]) || !m || +m[2] < long) return [l];
    return [`${m[1]}${fmt(+m[2] - 0.01)}`, "rest 0.01"];
  });
  return { ...part, song: song.join("\n") + "\n" };
};

// A barbershop tag: each chord a segment of its own harmonic series,
// the root harmonic 4 and each part a whole multiple of it, so the chords ring. The bell chord
// builds one voice at a time; the tag goes three times, each pure pass a comma (80/81) lower, the
// third with the C to E widened to 81/64 so the fifths close and the key holds.
function barbershop() {
  const BPM = 75, TONIC = 261.6256 / 2, COMMA = 80 / 81, BREAK = 0.5, GAP = 1.5, FINAL = 5;
  const TAG = [[1, [4, 6, 8, 10], 1.5], [5 / 4, [4, 5, 7, 8], 1.5], [5 / 6, [4, 7, 10, 12], 1], [10 / 9, [4, 5, 7, 8], 1.5], [20 / 27, [4, 6, 10, 14], 1.5], [80 / 81, [4, 6, 8, 10], 3]];
  const ANCHOR = [1, 81 / 64, 27 / 32, 9 / 8, 3 / 4, 1];
  const LYRIC = [["Hold", "that", "old", "sweet", "chord", "low"], ["Lean", "on", "that", "blue", "note", "now"], ["Bring", "the", "whole", "thing", "back", "home"]];
  const midi = (hz) => 69 + 12 * Math.log2(hz / 440);
  const parts = [[], [], [], []]; // bass, bari, lead, tenor
  let t = 1;
  for (let p = 0; p < 4; p++) parts[p].push({ word: "Ring", at: t + 0.4 * p, notes: [[[midi(TONIC / 4 * TAG[0][1][p]), 3.5 - 0.4 * p]]] });
  t += 3.5 + GAP;
  for (let v = 0; v < 3; v++) {
    const tonic = TONIC * COMMA ** v;
    TAG.forEach(([root, h, beats], i) => {
      const b = v === 2 && i === TAG.length - 1 ? FINAL : beats;
      const r = v === 2 ? ANCHOR[i] : root;
      for (let p = 0; p < 4; p++) parts[p].push({ word: LYRIC[v][i], at: t, notes: [[[midi(tonic * r / 4 * h[p]), b]]] });
      t += b + (i === 2 ? BREAK : 0);
    });
    t += GAP;
  }
  // the bass: of the site's four men the one with the most fundamental under the part, and lifted
  // 5 dB over the median voice's level there (barbershop-human/bass.json: 8088 sings it at -3.2 dB
  // of fundamental against a -4.8 median, at 0.343 rms against 0.276)
  const cast = [["Bass", "8088", 10 ** (5 / 20) * 0.2763 / 0.3434], ["Baritone", "6209", 1], ["Lead", "3752", 1], ["Tenor", "2428", 1]];
  return {
    source: "A barbershop tag written for lipservice. Every chord is tuned pure, each note a whole multiple of one fundamental, so the chords ring. The opening chord is built one voice at a time; the tag then goes three times, the second a comma lower where the pure chords leave it, the third with one interval widened so the key holds. Four men: bass, baritone, lead and tenor.",
    room: "driest", pan: 0.32,
    style: { ...HUMAN, glide: 14, motion: "straight", jitter: 2, detune: 2, spread: 0, breath: 0.85 },
    level: 1 / (4 * REFL_SUM),
    parts: cast.map(([name, voice, gain], p) => ({ name, voice, gain, seat: p, song: song(BPM, parts[p], parts[p][0].at) })),
  };
}

// "Shenandoah", call and response: a solo man sings the calls and the
// choir answers, growing verse by verse; in the third verse a few join the calls, in the last half
// of them do, and everyone holds the last word on a note of a D major chord. MIDI as men sing it.
function shenandoah() {
  const BPM = 120, VERSE = 68, N = 16, LEAD = 2;
  const CHORUS = [4, 8, 12, 16], CALL = [1, 1, 3, 8], CHORD_END = [50, 54, 57, 45, 62];
  const w = (s) => s.split(" | ").map((x) => {
    const [word, ...gs] = x.split(" ");
    return { word, notes: gs.map((g) => g.split("+").map((n) => n.split(":").map(Number))) };
  });
  const call1 = [
    "oh 45:2 | shenandoah 50:1 50:1 50:3 52:1 | i 54:1 | long 55:1 | to 59:1 | see 57:3 | you 62:1+61:1",
    "oh 45:2 | shenandoah 50:1 50:1 50:3 52:1 | i 54:1 | love 55:1 | your 59:1 | daughter 57:3 62:1+61:1",
    "oh 45:2 | shenandoah 50:1 50:1 50:3 52:1 | i'm 54:1 | bound 55:1 | to 59:1 | leave 57:3 | you 62:1+61:1",
    "oh 45:2 | shenandoah 50:1 50:1 50:3 52:1 | i 54:1 | long 55:1 | to 59:1 | see 57:3 | you 62:1+61:1",
  ].map(w);
  const call2 = [
    "seven 59:1 59:1 | long 59:3 | years 54:1 | since 57:1 | last 54:1 | i 52:1 | saw 50:3 | you 52:2",
    "i'll 59:1 | take 59:1 | her 59:1.5 | across 59:1.5 54:1 | the 57:1 | rolling 54:1 52:1 | water 50:3 52:2",
    "oh 59:1 | seven 59:1 59:3 | long 54:1 | years 57:1 | since 54:1 | i 52:1 | saw 50:3 | you 52:2",
    "seven 59:1 59:1 | long 59:3 | years 54:1 | since 57:1 | last 54:1 | i 52:1 | saw 50:3 | you 52:2",
  ].map(w);
  const resp1 = w("away 59:3 57:1 | you 59:1 | rolling 57:1 54:1 | river 57:3 57:2");
  const resp2 = w("away 54:3 52:1 | we're 54:1.5 | bound 59:0.5 | away 57:3 57:3 | across 50:1.5 52:0.5 | the 54:1.5 | wide 54:1.5 | missouri 52:1 52:2 50:4");
  const beats = (ws) => ws.reduce((a, x) => a + x.notes.flat().reduce((b, [, d]) => b + d, 0), 0);
  // the solo man first, then the seven other voices, then all eight again, each round shuffled, so
  // that the first two verses' choirs are every voice once
  const site = ["4446", "2428", "6345", "3752", "1088", "6209", "6147", "8088"];
  const sh = rng("shenandoah");
  const shuffle = (xs) => {
    for (let i = xs.length - 1; i > 0; i--) { const k = sh.int(0, i); [xs[i], xs[k]] = [xs[k], xs[i]]; }
    return xs;
  };
  const order = ["3752", ...shuffle(site.filter((v) => v !== "3752")), ...shuffle([...site])];
  const step = coprimeStep(N);
  const parts = order.map((voice, j) => {
    const fin = rng(`shenandoah ${j}`).choice(CHORD_END);
    const blocks = [];
    for (let v = 0; v < 4; v++) {
      const t = LEAD + v * VERSE, last = v === 3;
      if (j < CALL[v]) blocks.push([t, call1[v]]);
      if (j < CHORUS[v]) blocks.push([t + 16, resp1]);
      if (j < CALL[v]) blocks.push([t + 28, call2[v]]);
      if (j < CHORUS[v]) {
        const r = last ? [...resp2.slice(0, -1), { word: "missouri", notes: [[[52, 1]], [[52, 2]], [[fin, 16]]] }] : resp2;
        blocks.push([t + 42, r]);
      }
    }
    // choirkit.join: blocks that meet run on, unless after a last note of 2.6 beats or more a breath
    // is taken there (one decision a boundary, for everyone), the next block 0.01 beats late
    const notes = [];
    let end = null;
    for (const [s, ws] of blocks) {
      const lastNote = notes.length ? notes.at(-1).notes.at(-1).at(-1)[1] : 0;
      const late = end !== null && Math.abs(s - end) < 1e-3 && lastNote >= 2.6 && rng(`join ${s.toFixed(3)}`).uniform() < 0.7 ? 0.01 : 0;
      let at = s + late;
      for (const x of ws) {
        notes.push({ ...x, at });
        at += beats([x]);
      }
      end = s + beats(ws);
    }
    const first = blocks[0][0];
    return {
      name: j === 0 ? "Solo" : `Choir ${j}`, voice, at: (first - LEAD) * 60 / BPM,
      gain: j === 0 ? 2.2 : j < 4 ? 1.5 : 1, seat: (step * j) % N, song: song(BPM, notes, LEAD),
    };
  });
  return {
    source: "\"Shenandoah\", an American river and sea song of the early 19th century; tune and traditional verses public domain. A solo man sings the calls and the choir answers, growing verse by verse; in the third verse a few join the calls, in the last half of them, and everyone holds the last word on a note of a D major chord. Sixteen singers, the eight voices twice over.",
    room: "card", pan: 0.85,
    style: { ...HUMAN, motion: "vibrato", jitter: 0, detune: 10, spread: 0.03, breath: 0.9 },
    // the level the hundred-voice original went into its mastering at: its full chorus over this one's
    level: (Math.sqrt(25 + 9 * 4 + 90) / (100 * REFL_SUM)) / Math.sqrt(2.2 ** 2 + 3 * 1.5 ** 2 + 12),
    parts,
  };
}

// "Siuil a Ruin" at length, made from the sing-demos take `c` (the air and three parts under it,
// one verse and the chorus), whose notes are kept as they are: Moffat's four verses, each with the
// chorus. The men build an open fifth and the soprano sings the first verse alone over it; chorus
// and second verse are the take's harmony; a far voice echoes the calls of "Shule" in the second
// and third choruses; the third verse is the women alone, the air over three held lines; the fourth
// is the soprano alone, the fifth coming back under her; the last chorus has one singer to a part
// until "Shule go teir", the last line slowing (Moffat prints poco rit. there) to a chord with no
// third. Nothing echoes in the last chorus or after it.
function siuil(c) {
  const BPM = 108, LEAD = 3, V0 = 4, C0 = 36, LINE = 8;
  const T = [11, 75, 143, 211], C = T.map((t) => t + 32); // each verse's and chorus's first downbeat
  const VERSES = [
    null,
    "I'll sell my rock I'll sell my reel | I'll sell my on-ly spin-ning wheel | To buy my love a sword of steel",
    "I wish I wish I wish in vain | I wish I had my heart a-gain | And vain-ly think I'd not com-plain",
    "But now my love has gone to France | To try his for-tunes to ad-vance | If he ere come back 'tis but a chance",
  ];
  const beats = (e) => e.notes.reduce((a, [, b]) => a + b, 0);
  // a part of the take as syllables [{at (beats), word, k (which of its word's), notes: [[pitch, beats]]}]
  const read = (name) => {
    const part = c.parts.find((p) => p.name === name);
    if (!part) throw new Error(`Siuil a Ruin: no part ${name}`);
    const s = parse(part.song), all = [];
    if (s.bpm !== BPM) throw new Error(`Siuil a Ruin: ${name} at ${s.bpm} to the minute`);
    if (laned(s)) throw new Error(`Siuil a Ruin: ${name} writes a lane, which the arrangement would not carry`);
    for (const ph of s.phrases) {
      let t = ph.start;
      for (const w of ph.words) w.groups.forEach((g, k) => {
        all.push({ at: t, word: w.word, k, notes: g.map((x) => [+x.pitch, x.beats]) });
        t += g.reduce((a, x) => a + x.beats, 0);
      });
    }
    const verse = all.filter((e) => e.at < C0 - 1e-6), chorus = all.filter((e) => e.at >= C0 - 1e-6);
    if (verse.length !== 4 * LINE - 1 || verse[0].at !== V0 - 1 || chorus[0].at !== C0) throw new Error(`Siuil a Ruin: ${name} is not the take this was made from`);
    return { verse, chorus };
  };
  const move = (evs, d) => evs.map((e) => ({ ...e, at: e.at + d }));
  const halves = (e) => {
    const [a, b] = e.notes.length === 2 ? e.notes : [[e.notes[0][0], e.notes[0][1] / 2], [e.notes[0][0], e.notes[0][1] / 2]];
    if (e.notes.length > 2) throw new Error(`Siuil a Ruin: ${e.word} has ${e.notes.length} notes to halve`);
    return [{ ...e, notes: [a] }, { ...e, at: e.at + a[1], notes: [b] }];
  };
  // a verse's three lines to other words, a syllable for a syllable; a line a syllable longer
  // splits its first. The fourth line, the refrain, is the take's.
  const reword = (verse, text) => {
    if (!text) return verse;
    const out = [];
    text.split(" | ").forEach((ln, i) => {
      const syl = ln.split(" ").flatMap((w) => w.split("-").map((_, k) => ({ word: w.replaceAll("-", ""), k })));
      let evs = verse.slice(LINE * i, LINE * (i + 1));
      if (syl.length === LINE + 1) evs = [...halves(evs[0]), ...evs.slice(1)];
      if (syl.length !== evs.length) throw new Error(`Siuil a Ruin: ${syl.length} syllables in "${ln}"`);
      evs.forEach((e, j) => out.push({ ...e, ...syl[j] }));
    });
    return [...out, ...verse.slice(3 * LINE)];
  };
  // a wordless note held from cuts[0] to the last, taken again at each cut between
  const hold = (pitch, cuts) => cuts.slice(1).map((b, i) => {
    const at = cuts[i] + (i ? GAP : 0);
    return { at, word: "ooh", k: 0, notes: [[pitch, b - at]] };
  });
  // the last chorus: the last line slower syllable by syllable
  const KNOT = [59, 59.5, 60, 61, 62, 63, 64, 66], RIT = [1.2, 1.3, 1.4, 1.5, 1.65, 1.8, 3], BAR13 = 52, SLAN = 64;
  const slow = (t) => RIT.reduce((y, r, i) => y + (r - 1) * Math.max(0, Math.min(t, KNOT[i + 1]) - KNOT[i]), t);
  const last = (chorus, from = C0) => chorus.filter((e) => e.at >= from - 1e-6).map((e) => {
    const d = C[3] - C0;
    let t = e.at;
    const notes = e.notes.map(([m, b]) => { const n = [m, slow(t + b) - slow(t)]; t += b; return n; });
    return { ...e, at: slow(e.at) + d, notes };
  });
  const END = slow(KNOT.at(-1)) + C[3] - C0; // where the last chord stops
  const hollow = (evs) => evs.map((e) => (e.word === "slan" && e.at > END - 7 ? { ...e, notes: e.notes.map(([, b]) => [64, b]) } : e));

  const air = read("Soprano"), bass = read("Bass 1"), tenor = read("Tenor 1"), alto = read("Alto 1");
  const chorus = (p, k) => move(p.chorus, C[k] - C0), verse = (p, k) => move(reword(p.verse, VERSES[k]), T[k] - V0);
  // the far voice: the two calls a beat after the soprano's
  const calls = (k) => move(air.chorus.filter((e) => e.at < C0 + 3), C[k] - C0 + 1);
  const sung = {
    "Bass 1": [...hold(57, [3, 11, 19, 27, 35, 41]), ...chorus(bass, 0), ...verse(bass, 1), ...chorus(bass, 1), ...chorus(bass, 2), ...hold(57, [T[3] + 16, T[3] + 23, T[3] + 30]), ...last(bass.chorus)],
    "Bass 2": [...hold(57, [7, 15, 23, 32, 41]), ...chorus(bass, 0), ...verse(bass, 1), ...chorus(bass, 1), ...chorus(bass, 2), ...last(bass.chorus, BAR13)],
    "Tenor 1": [...hold(64, [5, 13, 21, 29, 37, 41]), ...chorus(tenor, 0), ...verse(tenor, 1), ...chorus(tenor, 1), ...chorus(tenor, 2), ...hold(64, [T[3] + 22, T[3] + 30]), ...last(tenor.chorus)],
    "Tenor 2": [...hold(64, [9, 17, 25, 33, 41]), ...chorus(tenor, 0), ...verse(tenor, 1), ...chorus(tenor, 1), ...chorus(tenor, 2), ...last(tenor.chorus, BAR13)],
    "Alto 1": [...chorus(alto, 0), ...verse(alto, 1), ...chorus(alto, 1), ...hold(64, [T[2], T[2] + 5, T[2] + 13, T[2] + 21, T[2] + 30]), ...chorus(alto, 2), ...hollow(last(alto.chorus))],
    "Alto 2": [...chorus(alto, 0), ...verse(alto, 1), ...chorus(alto, 1),
      // a sigh, C to B and back, where the take's harmony goes to G and to E minor
      ...[[0, [[60, 8]]], [8, [[60, 4], [59, 4]]], [16, [[60, 8]]], [24, [[59, 4], [60, 2]]]].map(([at, notes], i) => ({ at: T[2] + at + (i ? GAP : 0), word: "ooh", k: 0, notes: notes.map(([m, b], j) => [m, b - (i && !j ? GAP : 0)]) })),
      ...chorus(alto, 2), ...hollow(last(alto.chorus, BAR13))],
    "Soprano": [...verse(air, 0), ...chorus(air, 0), ...verse(air, 1), ...chorus(air, 1), ...verse(air, 2), ...chorus(air, 2), ...verse(air, 3), ...last(air.chorus)],
    "Far voice": [...calls(1), ...hold(69, [T[2] - 4, T[2] + 3, T[2] + 10, T[2] + 18, T[2] + 26, T[2] + 30]), ...calls(2), ...hold(69, [C[2] + 8, C[2] + 16, C[2] + 24, C[2] + 30])],
  };
  const write = (name) => {
    const evs = sung[name], out = [`bpm ${BPM}`, `rest ${LEAD}`];
    let t = evs[0].at;
    for (const e of evs) {
      const gap = e.at - t, g = e.notes.map(([m, b]) => `${fmt(m)}:${fmt(b)}`).join("+");
      if (gap < -5e-5) throw new Error(`Siuil a Ruin: ${name}: ${e.word} at ${e.at} starts before the note before it ends`);
      if (e.k > 0 && gap > 5e-5) throw new Error(`Siuil a Ruin: ${name}: a rest inside ${e.word}`);
      if (gap > 5e-5) out.push(`rest ${fmt(gap)}`);
      if (e.k > 0) out[out.length - 1] += ` ${g}`;
      else out.push(`${e.word} ${g}`);
      t = e.at + beats(e);
    }
    return { song: out.join("\n") + "\n", at: (evs[0].at - LEAD) * 60 / BPM };
  };
  const seat = (name) => c.parts.find((p) => p.name === name);
  const parts = Object.keys(sung).map((name) => (name === "Far voice"
    ? { name, voice: "6147", gain: 0.32, seat: c.parts.length, ...write(name) }
    : { name, voice: seat(name).voice, gain: seat(name).gain, seat: seat(name).seat, ...write(name) }));
  if (parts.length !== c.parts.length + 1) throw new Error("Siuil a Ruin: the take has parts this leaves out");
  return {
    source: "\"Siuil a Ruin\": the Irish air and all four verses as Alfred Moffat printed them in 1897; public domain. Three parts written for lipservice under the air. The men build an open fifth and the soprano sings the first verse alone over it. The second verse and the choruses are in the take's harmony, a far voice echoing the calls of \"Shule\" in the second and third choruses. The third verse is the women alone, the air over three held lines; the fourth is the soprano alone. The last chorus begins with one singer to a part, slows through its last line as Moffat marks it, and ends on a chord with no third. Set 4 semitones lower than the demo, to where every voice here holds its top note.",
    room: c.room, pan: c.pan, level: c.level, style: c.style, parts,
  };
}

// A strophic take (every singer on every word of every verse, at one level and one speed) made to
// change as it goes, its notes kept as they are. The take's lines are the tune's phrases; `plan` is
// runs of them, [lines, {group: duty or [duties]}], a group being the parts of one name ("Soprano 1"
// to "Soprano 4"), its singers counted from the middle of the stage outwards, and a duty
// [how, singers (all that are left unless given), level (1 unless given)]:
//   "words": the group's own line as the take has it
//   "tune": the tune and its words, an octave down for a man
//   "ooh", "ah": the group's own line on that vowel, a note held wherever it is sung twice running,
//     breaths staggered: the singers so singing take theirs at different places, most of them inside
//     a line and holding through its end, so the line under a soloist is not broken where she breathes
// A group a run does not name is silent in it. A level is what the singer's gain is times for those
// lines (choir.js Mixer), changed in the rest before them. `close` is the ending: the last line
// slowing to `slow` of the tempo as Friberg and Sundberg (1999) found players do (the tempo
// [1 + (slow^3 - 1) x]^(1/3) at x of the way to its last chord), that chord held `hold` beats if it
// is not longer as written and, with `fade`, let down to that much of its level.
function strophes(title, c, { plan, close, source }) {
  const REST = 2, EPS = 1e-6;
  const bpm = parse(c.parts[0].song).bpm, spb = 60 / bpm;
  const no = (what) => { throw new Error(`${title}: ${what}`); };
  const end = (e) => e.at + e.notes.reduce((a, [, b]) => a + b, 0);
  // a part as syllables on the piece's clock: [{at (beats), word, k (which of its word's), notes: [[pitch, beats]]}]
  const read = (p) => {
    const s = parse(p.song), all = [];
    if (s.bpm !== bpm) no(`${p.name} at ${s.bpm} to the minute`);
    if (laned(s)) no(`${p.name} writes a lane, which the arrangement would not carry`);
    for (const ph of s.phrases) {
      let t = ph.start + (p.at ?? 0) / spb;
      for (const w of ph.words) w.groups.forEach((g, k) => {
        all.push({ at: t, word: w.word, k, notes: g.map((x) => [x.pitch, x.beats]) });
        t += g.reduce((a, x) => a + x.beats, 0);
      });
    }
    return all;
  };
  const groups = {}, mid = (c.parts.length - 1) / 2;
  c.parts.forEach((p, i) => (groups[p.name.replace(/ \d+$/, "")] ??= []).push(i));
  for (const [g, is] of Object.entries(groups)) {
    if (is.some((i) => c.parts[i].song !== c.parts[is[0]].song || (c.parts[i].at ?? 0) !== (c.parts[is[0]].at ?? 0))) no(`the ${g} singers do not share a song`);
    is.sort((a, b) => Math.abs((c.parts[a].seat ?? a) - mid) - Math.abs((c.parts[b].seat ?? b) - mid));
  }
  if (!groups.Soprano) no("no Soprano has the tune");
  const tune = read(c.parts[groups.Soprano[0]]);
  const starts = tune.filter((e, i) => !i || e.at > end(tune[i - 1]) + EPS).map((e) => e.at), END = end(tune.at(-1));
  // each group's syllables line by line (a line of the tune's may be joined late)
  const lines = Object.fromEntries(Object.entries(groups).map(([g, is]) => {
    const evs = read(c.parts[is[0]]);
    const ls = starts.map((a, i) => evs.filter((e) => e.at >= a - NEAR && e.at < (starts[i + 1] ?? Infinity) - NEAR));
    if (ls.flat().length !== evs.length || ls.some((l) => !l.length) || end(evs.at(-1)) > END + NEAR) no(`the ${g} line is not sung with the tune's`);
    return [g, ls];
  }));
  if (plan.reduce((a, [n]) => a + n, 0) !== starts.length) no(`a plan for ${plan.reduce((a, [n]) => a + n, 0)} lines of ${starts.length}`);

  const period = (a, b) => ((b < starts.length ? starts[b] : END) - starts[a]) / (b - a) * spb;

  const sung = c.parts.map(() => []);
  let a = 0;
  const vowel = (how) => how === "ooh" || how === "ah";
  for (const [n, who] of plan) {
    const duties = Object.entries(who).map(([g, d]) => [g, Array.isArray(d[0]) ? d : [d]]);
    const pads = duties.filter(([, ds]) => ds.some(([how]) => vowel(how))).map(([g]) => g);
    for (const [g, ds] of duties) {
      if (!groups[g]) no(`no ${g}`);
      let k = 0;
      for (const [how, count = groups[g].length - k, level = 1] of ds) {
        if (!(count > 0 && k + count <= groups[g].length && level > 0)) no(`${count} of the ${g} singers at ${level}`);
        for (let r = 0; r < count; r++) {
          const evs = how === "words" ? lines[g].slice(a, a + n).flat() : how === "tune" ? lines.Soprano.slice(a, a + n).flat()
            : vowel(how) ? hummed(lines[g].slice(a, a + n), how, (r + pads.indexOf(g) / pads.length) / count, period(a, a + n)) : no(`no duty ${how}`);
          sung[groups[g][k + r]].push(...evs.map((e) => ({ ...e, level })));
        }
        k += count;
      }
    }
    a += n;
  }

  // the ending: where beat t of the take falls, and where the last chord stops
  const { slow = 1, hold = 0, fade = 1 } = close;
  const from = starts.at(-1), last = tune.at(-1), chord = end(last) - last.notes.at(-1)[1];
  const warp = (t) => {
    if (t <= from || slow === 1) return t;
    const k = slow ** 3 - 1, x = Math.min(1, (t - from) / (chord - from));
    return from + (chord - from) * ((1 + k * x) ** (2 / 3) - 1) / (k * 2 / 3) + Math.max(0, t - chord);
  };
  const stop = warp(chord) + Math.max(hold, END - chord);
  const parts = c.parts.map((p, i) => {
    if (!sung[i].length) no(`${p.name} never sings`);
    const evs = sung[i].map((e) => {
      let t = e.at;
      const notes = e.notes.map(([m, d]) => { const y = [m, warp(t + d) - warp(t)]; t += d; return y; });
      if (Math.abs(t - END) < NEAR) notes.at(-1)[1] += stop - warp(END);
      return { ...e, at: warp(e.at), notes };
    });
    if (evs[0].at < REST) no(`${p.name} starts at beat ${evs[0].at}`);
    const zero = evs[0].at - REST, out = [`bpm ${bpm}`, `rest ${REST}`], secs = (t) => +(SILENT + (t - zero) * spb).toFixed(4);
    const levels = [[0, evs[0].level]];
    let t = evs[0].at;
    evs.forEach((e, j) => {
      const gap = e.at - t, g = e.notes.map(([m, d]) => `${m}:${fmt(d)}`).join("+");
      if (gap < -5e-5) no(`${p.name}: ${e.word} at ${e.at} starts before the note before it ends`);
      if (e.k > 0 && gap > 5e-5) no(`${p.name}: a rest inside ${e.word}`);
      if (gap > 5e-5) out.push(`rest ${fmt(gap)}`);
      if (j && e.level !== evs[j - 1].level) {
        const d = Math.min(0.25, gap * spb / 3);
        if (!(d >= 0.05)) no(`${p.name}: no rest before ${e.word} at ${e.at} to change level in`);
        levels.push([+(secs(t) + d).toFixed(4), evs[j - 1].level], [+(secs(t) + 2 * d).toFixed(4), e.level]);
      }
      if (e.k > 0) out[out.length - 1] += ` ${g}`;
      else out.push(`${e.word} ${g}`);
      t = end(e);
    });
    if (fade !== 1 && Math.abs(t - stop) < NEAR) levels.push([secs(stop - 0.6 * (stop - warp(chord))), evs.at(-1).level], [secs(stop), evs.at(-1).level * fade]);
    return { name: p.name, voice: p.voice, gain: p.gain, seat: p.seat, song: out.join("\n") + "\n", at: zero * spb, ...(levels.some(([, k]) => k !== 1) ? { levels } : {}) };
  });
  return { source, room: c.room, pan: c.pan, level: c.level, style: c.style, parts };
}

// ---- An arranger's kit. A line of a piece is its syllables on the piece's clock, [{at (beats),
// word, k (which of its word's), notes: [[pitch, beats]]}], and an arrangement may say of each its
// level (what the singer's gain is times, 1 unless given) and its vib (how its vibrato is pedalled,
// scored()). ----
const sylBeats = (e) => e.notes.reduce((a, [, b]) => a + b, 0), sylEnd = (e) => e.at + sylBeats(e);
const SEMIS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midi = (x) => {
  if (Number.isFinite(+x)) return +x;
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(x);
  if (!m) throw new Error(`${x}: not a note`);
  return SEMIS[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12 * (+m[3] + 1);
};

// a preset's part as a line
function syllables(p, title) {
  const s = parse(p.song), spb = 60 / s.bpm, all = [];
  if (laned(s)) throw new Error(`${title}: ${p.name} writes a lane, which the arrangement would not carry`);
  for (const ph of s.phrases) {
    let t = ph.start + (p.at ?? 0) / spb;
    for (const w of ph.words) w.groups.forEach((g, k) => {
      all.push({ at: t, word: w.word, k, notes: g.map((x) => [midi(x.pitch), x.beats]) });
      t += g.reduce((a, x) => a + x.beats, 0);
    });
  }
  return all;
}
// a line's phrases: its syllables in runs with no rest between
const phrased = (evs) => evs.reduce((ls, e, i) => { if (!i || e.at > sylEnd(evs[i - 1]) + 1e-6) ls.push([]); ls.at(-1).push(e); return ls; }, []);
const moved = (evs, d) => evs.map((e) => ({ ...e, at: e.at + d }));
const marked = (evs, how) => evs.map((e) => ({ ...e, ...how }));
const raised = (evs, semis) => evs.map((e) => ({ ...e, notes: e.notes.map(([m, b]) => [m + semis, b]) }));
// A take's lines with every note's start and end on the nearest `q` of a beat (some takes are
// written a little off it, singer by singer), a breath kept between lines the take had apart.
function squared(ls, q = 0.25) {
  const r = (t) => Math.round(t / q) * q;
  const out = ls.map((evs) => evs.map((e) => {
    let t = e.at;
    const notes = e.notes.map(([p, d]) => { const y = [p, r(t + d) - r(t)]; t += d; return y; });
    if (notes.some(([, d]) => d <= 0)) throw new Error(`${e.word} at ${e.at}: a note shorter than ${q} of a beat`);
    return { ...e, at: r(e.at), notes };
  }));
  out.forEach((evs, i) => { if (out[i + 1] && out[i + 1][0].at - sylEnd(evs.at(-1)) < GAP) evs.at(-1).notes.at(-1)[1] -= GAP; });
  return out;
}
const lineNotes = (evs) => evs.flatMap((e) => { let t = e.at; return e.notes.map(([p, d]) => { const n = { p, x: t, y: t + d }; t += d; return n; }); });

// Other words under a line's notes, a syllable to each of its syllables in turn: words apart by
// spaces and a word's syllables by "-"; "syl~3" takes three of the line's syllables' notes as one
// (notes of one pitch running on are one), and a syllable ending "/" shares one of the line's with
// the next, its notes dealt out in turn or its one note in equal parts.
function underlay(evs, text, title) {
  const out = [], toks = text.split(" ").flatMap((w) => w.split("-").map((s, k) => ({ s, k, word: w.replace(/[-/]|~\d+/g, "") })));
  let i = 0;
  for (let j = 0; j < toks.length; j++) {
    const { s, k, word } = toks[j], m = /^(.*?)(?:~(\d+))?(\/?)$/.exec(s);
    if (m[3]) {
      let n = 2;
      while (toks[j + n - 1]?.s.endsWith("/")) n++;
      if (!toks[j + n - 1]) throw new Error(`${title}: "${text}": nothing after ${s}`);
      const e = evs[i++];
      if (!e || (e.notes.length !== 1 && e.notes.length !== n)) throw new Error(`${title}: "${text}": ${n} syllables to share ${e ? e.notes.length : "no"} notes`);
      let at = e.at;
      for (let q = 0; q < n; q++) {
        const note = e.notes.length === 1 ? [e.notes[0][0], e.notes[0][1] / n] : e.notes[q];
        out.push({ at, word: toks[j + q].word, k: toks[j + q].k, notes: [note] });
        at += note[1];
      }
      j += n - 1;
    } else {
      const n = +(m[2] ?? 1), es = evs.slice(i, i + n);
      i += n;
      if (es.length !== n || es.some((e, q) => q && Math.abs(e.at - sylEnd(es[q - 1])) > NEAR)) throw new Error(`${title}: "${text}": ${s} has not ${n} syllables' notes running on`);
      const notes = [];
      for (const [p, d] of es.flatMap((e) => e.notes)) {
        if (n > 1 && notes.length && notes.at(-1)[0] === p) notes.at(-1)[1] += d;
        else notes.push([p, d]);
      }
      out.push({ at: es[0].at, word, k, notes });
    }
  }
  if (i !== evs.length) throw new Error(`${title}: "${text}" is ${i} syllables to the line's ${evs.length}`);
  return out;
}

// A line's pitches under another's syllables: each syllable of `tune` on what `line` holds while it
// sounds (the line's first note before it starts, its last after it ends).
function under(tune, line) {
  const ns = lineNotes(line), at = (t) => (ns.findLast((n) => n.x <= t + NEAR) ?? ns[0]).p;
  return tune.map((e) => {
    const a = e.at, b = sylEnd(e), cuts = [a, ...ns.map((n) => n.x).filter((x) => x > a + NEAR && x < b - NEAR), b], notes = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const p = at(cuts[i]);
      if (notes.length && notes.at(-1)[0] === p) notes.at(-1)[1] += cuts[i + 1] - cuts[i];
      else notes.push([p, cuts[i + 1] - cuts[i]]);
    }
    return { ...e, notes };
  });
}

// a wordless note held from cuts[0] to the last, taken again at each cut between
const held = (pitch, cuts, vowel = "ooh") => cuts.slice(1).map((b, i) => {
  const at = cuts[i] + (i ? GAP : 0);
  return { at, word: vowel, k: 0, notes: [[pitch, b - at]] };
});

// a written line from beat `at`: its notes [[pitch, beats]], a syllable each
const laid = (at, notes, word = "ooh") => notes.map(([p, d], i) => ({ at: at + notes.slice(0, i).reduce((a, n) => a + n[1], 0), word, k: 0, notes: [[p, d]] }));

// Lines (`ls`, each a run of syllables) on a vowel, a note held wherever it is sung twice running,
// the singer's breaths `phase` of the way from one to the next after the others': most are taken
// inside a line and held through its end, so the line under a soloist is not broken where she
// breathes. `period` is a line's length (s), which sets how often a breath is taken.
function hummed(ls, vowel, phase, period) {
  const CARRY = 1.5, EPS = 1e-6, n = ls.length;
  const m = period < 5.5 ? 0.5 : period <= 11 ? 1 : 2; // breaths a line
  const takes = [];
  for (let j = 0; (phase + j) / m < n - EPS; j++) takes.push((phase + j) / m);
  const out = [];
  let cur = null;
  const put = (p, x, y) => {
    const n = cur.at(-1);
    if (n && n.p === p && Math.abs(n.y - x) < EPS) n.y = y;
    else cur.push({ p, x, y });
  };
  for (let q = 0; q < n; q++) {
    const evs = ls[q], x0 = evs[0].at, len = sylEnd(evs.at(-1)) - x0;
    if (cur && !takes.some((u) => Math.abs(u - q) < EPS) && x0 - cur.at(-1).y <= CARRY) cur.at(-1).y = x0;
    else { if (cur) out.push(cur); cur = []; }
    const ns = lineNotes(evs);
    const cuts = takes.filter((u) => u > q + EPS && u < q + 1 - EPS).map((u) => {
      const want = x0 + (u - q) * len;
      const near = ns.slice(1).filter((n, i) => n.p !== ns[i].p).map((n) => n.x).sort((s, t) => Math.abs(s - want) - Math.abs(t - want))[0];
      return near !== undefined && Math.abs(near - want) <= 0.1 * len ? near : want;
    });
    for (const n of ns) {
      let x = n.x;
      for (const cut of cuts) {
        if (cut < x - EPS || cut >= n.y - EPS) continue;
        if (cut > x + EPS) put(n.p, x, cut);
        out.push(cur);
        cur = [];
        x = cut + GAP;
      }
      put(n.p, x, n.y);
    }
  }
  out.push(cur);
  return out.map((sp) => ({ at: sp[0].x, word: vowel, k: 0, notes: sp.map((n) => [n.p, n.y - n.x]) }));
}

// The parts of an arrangement written out: `cast` [{name, voice, gain, seat, motion (its own in
// place of the piece's)}] and `sung`, each one's line by its name.
//   level: a syllable's level is changed in the rest before it, or across its start where there is none.
//   vib: {base, bloom, wait, rise, die}: the vibrato is `base` times its size as a syllable starts
//     and for `wait` s (0.3), then grows towards `bloom`, which it would reach in `rise` s (1), as a
//     singer lets it into a note: a short note has little more than `base` and a held one all of
//     `bloom`. With `die` it is let down to that through what is left of the syllable. A syllable
//     with no vib is sung at the voice's own (1).
//   swells: [[which names (a RegExp), [[beat, factor]...]]]: a level drawn along the piece, a
//     straight line from each to the next, that the names' levels are times.
//   close: {from, chord, slow, hold, fade}: from beat `from` the tempo falls to `slow` of itself at
//     beat `chord` as Friberg and Sundberg (1999) found players' does (the tempo
//     [1 + (slow^3 - 1) x]^(1/3) at x of the way); the notes sounding at the piece's end are held
//     `hold` beats from `chord` if not longer as written and, with `fade`, let down to that much.
//   lifts: [[beat, beats]]: a silence put in before `beat`; a note sounding across it is held through.
function scored(title, cast, sung, { bpm, close = {}, swells = [], lifts = [] }) {
  const REST = 2, spb = 60 / bpm, no = (what) => { throw new Error(`${title}: ${what}`); };
  for (const name of Object.keys(sung)) if (!cast.some((p) => p.name === name)) no(`no ${name} in the cast`);
  const END = Math.max(...Object.values(sung).flat().map(sylEnd));
  const { from = END, chord = END, slow = 1, hold = 0, fade = 1 } = close;
  // where beat t of the arrangement falls: a note's start is after a lift at its beat, its end before
  const warp = (t, ends = false) => {
    let y = t;
    if (t > from && slow !== 1) {
      const k = slow ** 3 - 1, x = Math.min(1, (t - from) / (chord - from));
      y = from + (chord - from) * ((1 + k * x) ** (2 / 3) - 1) / (k * 2 / 3) + Math.max(0, t - chord);
    }
    for (const [at, b] of lifts) if (ends ? t > at + NEAR : t >= at - NEAR) y += b;
    return y;
  };
  const stop = warp(chord) + Math.max(hold, END - chord);
  const line = (c, t) => { // a drawn level at t: from the last point at or before it
    let i = -1;
    for (let lo = 0, hi = c.length; lo < hi;) { const mid = (lo + hi) >> 1; if (c[mid][0] <= t) lo = (i = mid) + 1; else hi = mid; }
    if (i < 0) return c[0][1];
    if (i + 1 === c.length) return c[i][1];
    return c[i][1] + (c[i + 1][1] - c[i][1]) * (t - c[i][0]) / (c[i + 1][0] - c[i][0]);
  };
  const parts = cast.map((p) => {
    if (!sung[p.name]?.length) no(`${p.name} never sings`);
    const evs = [...sung[p.name]].sort((a, b) => a.at - b.at).map((e) => {
      let t = e.at;
      const last = Math.abs(sylEnd(e) - END) < NEAR;
      const notes = e.notes.map(([m, d], i) => { const y = [m, (last && i + 1 === e.notes.length ? stop : warp(t + d, true)) - warp(t)]; t += d; return y; });
      return { ...e, at: warp(e.at), notes, level: e.level ?? 1 };
    });
    if (evs[0].at < REST) no(`${p.name} starts at beat ${evs[0].at}`);
    const zero = evs[0].at - REST, out = [`bpm ${bpm}`, `rest ${REST}`], secs = (t) => +(SILENT + (t - zero) * spb).toFixed(4);
    const steps = [[0, evs[0].level]];
    let t = evs[0].at, size = 1;
    evs.forEach((e, j) => {
      const gap = e.at - t, g = e.notes.map(([m, d]) => `${fmt(m)}:${fmt(d)}`).join("+");
      if (gap < -5e-5) no(`${p.name}: ${e.word} at ${e.at} starts before the note before it ends`);
      if (e.k > 0 && gap > 5e-5) no(`${p.name}: a rest inside ${e.word}`);
      if (gap > 5e-5) out.push(`rest ${fmt(gap)}`);
      if (j && e.level !== evs[j - 1].level) {
        const d = gap * spb >= 0.15 ? Math.min(0.25, gap * spb / 3) : 0.04, a = gap * spb >= 0.15 ? secs(t) + d : secs(e.at) - 0.06;
        if (!(a > steps.at(-1)[0])) no(`${p.name}: no room before ${e.word} at ${e.at} to change level in`);
        steps.push([+a.toFixed(4), evs[j - 1].level], [+(a + d).toFixed(4), e.level]);
      }
      if (e.k === 0) { // the word's vibrato, a line before it
        const pts = [], was = size;
        for (let i = j; i === j || evs[i]?.k > 0; i++) {
          const { base = 1, bloom = base, wait = 0.3, rise = 1, die = null } = evs[i].vib ?? {};
          const d = sylBeats(evs[i]), up = Math.min(rise, d * spb - wait);
          // after a rest the syllable starts at `base`; within a phrase the vibrato comes down to it
          const easing = size !== base && !(i === j && (j === 0 || gap > 5e-5));
          if (size !== base && !easing) pts.push([base, null]);
          if ((bloom !== base || die !== null) && up > 0.15) {
            const top = +(base + (bloom - base) * up / rise).toFixed(3), left = d - (wait + up) / spb;
            pts.push([base, wait / spb], [top, up / spb]);
            if (left > 1e-6) pts.push([die ?? top, left]);
            size = left > 1e-6 ? die ?? top : top;
          } else {
            const g = easing ? Math.min(d, wait / spb) : 0;
            if (g > 0) pts.push([base, g]);
            if (d - g > 1e-6) pts.push([base, d - g]);
            size = base;
          }
        }
        // a size held to the word's end says nothing
        while (pts.length && pts.at(-1)[1] !== null && pts.length > 1 && pts.at(-1)[0] === pts.at(-2)[0]) pts.pop();
        if (pts.length === 1 && pts[0][1] !== null && pts[0][0] === was) pts.pop();
        if (pts.length) out.push(`vibrato ${pts.map(([v, b]) => (b === null ? fmt(v) : `${fmt(v)}:${fmt(b)}`)).join(" ")}`);
        out.push(`${e.word} ${g}`);
      } else out[out.length - 1] += ` ${g}`;
      t = sylEnd(e);
    });
    if (fade !== 1 && Math.abs(t - stop) < NEAR) steps.push([secs(stop - 0.6 * (stop - warp(chord))), evs.at(-1).level], [secs(stop), evs.at(-1).level * fade]);
    // the levels drawn along the piece, on the part's own clock
    const drawn = swells.filter(([who]) => who.test(p.name)).map(([, pts]) => pts.map(([b, k]) => [secs(warp(b)), k]));
    const times = [...new Set([...steps, ...drawn.flat()].map(([x]) => x).filter((x) => x >= 0))].sort((a, b) => a - b);
    const levels = times.map((x) => [x, +(line(steps, x) * drawn.reduce((k, c) => k * (c.length ? line(c, x) : 1), 1)).toFixed(4)]);
    return {
      name: p.name, voice: p.voice, gain: p.gain, seat: p.seat, ...(p.motion ? { motion: p.motion } : {}), song: out.join("\n") + "\n", at: zero * spb,
      ...(levels.some(([, k]) => k !== 1) ? { levels } : {}),
    };
  });
  return parts;
}

// A singer's own machine vibrato, as the sing-demos drew each singer's: its
// peak (semitones), its rate (Hz) and how far into a vowel it starts (s).
export function vibrato(seed) {
  const r = rng(`vibrato ${seed}`);
  return { vibrato: r.between(0.15, 0.35), vibratoHz: r.between(4.8, 6.0), vibratoDelay: r.between(0.2, 0.5) };
}

// The parts of preset `c` as choir.js start() takes them: the preset's voices and songs unless
// voices[i] or songs[i] say otherwise, seeds from `seed`, a level of 1 / (N REFL_SUM) unless the
// preset sets one. `how` is how it is sung where that is not the preset's own way: sway (the
// pitch's movement, the singers' own or the machine vibrato, against its own size) and loose (how
// far off the beat and the pitch each singer is, against the preset's), each 1 unless given;
// vibrato (the vibrato alone against its own size, a singer's drift left: what the songs' vibrato
// lines are sized by) in place of the preset's or VIBRATO; and glide, dynamics, breathiness and
// breath in place of the preset's. A part with a motion of its own keeps it while the piece is sung
// in the preset's.
//
// The piece's level is made here, by one gain on every part. A piece whose loud passages have been
// measured as it is written (c.loud, dBFS: choir_levels.mjs) has them brought to the room's LOUD;
// one that has not is set so that all its singers at once at their fullest are the room's FULL_CHOIR.
// A piece's measured level is a route's own (routes.js), so a choir is arranged for one.
export function arrange(c, { list, route, seed = 0, voices = [], songs = [], room = c.room, motion = c.style.motion, how = {} }) {
  if (!ROUTES.includes(route)) throw new Error(`a choir is arranged for a route, ${ROUTES.join(" or ")}: ${route}`);
  const level = c.level ?? 1 / (c.parts.length * REFL_SUM);
  const { sway = 1, loose = 1, vibrato: size = c.style.vibratoSize ?? VIBRATO, ...own } = how;
  for (const k of Object.keys(own)) if (!["glide", "dynamics", "breathiness", "breath"].includes(k)) throw new Error(`how a choir sings: no ${k}`);
  const style = { ...c.style, ...own };
  const parts = c.parts.map((p, i) => {
    const voice = voices[i] ?? p.voice, v = list.find((v) => v.name === voice);
    if (!v) throw new Error(`${p.name}: no voice ${voice}`);
    const mine = vibrato(seed + i), k = { dynamics: 1, breathiness: 1, detune: 1, spread: 1, ...p.scale };
    if (Object.keys(k).length !== 4) throw new Error(`${p.name}: a scale of ${Object.keys(p.scale)}`);
    return {
      ...style, motion: (motion === c.style.motion ? p.motion : null) ?? motion, motionScale: sway, ...mine, vibrato: mine.vibrato * sway, vibratoSize: size, dynamics: style.dynamics * k.dynamics, breathiness: style.breathiness * k.breathiness,
      // singers who keep time together start together: a start of one's own puts a vowel under the others' S
      jitter: Math.round((style.jitter ?? 0) * loose), detune: (style.detune ?? 0) * loose * k.detune, spread: (style.together ?? TOGETHER) ? 0 : (style.spread ?? 0) * loose * k.spread,
      together: style.together ?? TOGETHER, give: style.give ?? GIVE,
      name: p.name, voice, sex: v.sex, shift: v.sex === "F" ? 0 : -12, seed: seed + i,
      song: songs[i] ?? p.song, at: p.at ?? 0, gain: level * (p.gain ?? 1), levels: p.levels ?? null, seat: p.seat ?? i,
    };
  });
  const full = Math.hypot(...parts.map((p) => p.gain * Math.max(...(p.levels ?? [[0, 1]]).map(([, k]) => k))));
  // the loud passages as measured on this route (choirs_levels.js), or one number for every route
  const loud = typeof c.loud === "object" ? c.loud[route] : c.loud;
  const k = loud === undefined ? FULL_CHOIR / full : 10 ** ((LOUD - loud) / 20);
  if (!(k > 0 && Number.isFinite(k))) throw new Error(`a choir's level: loud passages at ${loud}, a full choir of ${full}`);
  for (const p of parts) p.gain *= k;
  return { parts, seats: makeSeats(parts.length, c.pan), room, bpm: parse(parts[0].song).bpm };
}

const WRITTEN = {
  "Shenandoah": shenandoah(),
  "Barbershop tag": barbershop(),
  "Ode to Joy": {
    room: "drier", pan: 0.5, style: HYMN,
    source: "Melody by Beethoven (Symphony No. 9, 1824); words by Henry van Dyke (Joyful, Joyful, We Adore Thee, 1907). Both public domain. Four-part harmony arranged for lipservice, in G; women on soprano and alto, men on tenor and bass.",
    parts: [
      { name: "Soprano", voice: "4446", song: `bpm 100
rest 2
joyful B4:1 B4:1
joyful C5:1 D5:1
we D5:1
adore C5:1 B4:1
thee A4:1
God G4:1
of G4:1
glory A4:1 B4:1
Lord B4:1.5
of A4:0.5
love A4:2
hearts B4:1
unfold B4:1 C5:1
like D5:1
flowers D5:0.5 D5:0.5
before C5:1 B4:1
thee A4:1
opening G4:0.5 G4:0.5 G4:1
to A4:1
the B4:1
sun A4:1.5
above G4:0.5 G4:2
melt A4:1
the A4:1
clouds B4:1
of G4:1
sin A4:1
and B4:0.5+C5:0.5
sadness B4:1 G4:1
drive A4:1
the B4:0.5+C5:0.5
dark B4:1
of A4:1
doubt G4:1
away A4:1 D4:2
giver B4:1 B4:1
of C5:1
immortal D5:1 D5:1 C5:1
gladness B4:1 A4:1
fill G4:1
us G4:1
with A4:1
the B4:1
light A4:1.5
of G4:0.5
day G4:3
rest 0.5
` },
      { name: "Alto", voice: "6345", song: `bpm 100
rest 2
joyful G4:1 G4:1
joyful G4:1 F#4:1
we G4:1
adore F#4:1 G4:1
thee F#4:1
God G4:1
of G4:1
glory F#4:1 G4:1
Lord G4:1.5
of F#4:0.5
love F#4:2
hearts G4:1
unfold G4:1 G4:1
like F#4:1
flowers F#4:0.5 F#4:0.5
before F#4:1 G4:1
thee D4:1
opening D4:0.5 D4:0.5 D4:1
to F#4:1
the G4:1
sun F#4:1.5
above D4:0.5 D4:2
melt E4:1
the F#4:1
clouds G4:1
of E4:1
sin E4:1
and F#4:1
sadness G4:1 D4:1
drive E4:1
the D4:1
dark D4:1
of D4:1
doubt D4:1
away D4:1 D4:2
giver D4:1 D4:1
of E4:1
immortal F#4:1 F#4:1 F#4:1
gladness G4:1 F#4:1
fill G4:1
us G4:1
with F#4:1
the G4:1
light F#4:1.5
of D4:0.5
day D4:3
rest 0.5
` },
      { name: "Tenor", voice: "3752", song: `bpm 100
rest 2
joyful D5:1 D5:1
joyful E5:1 D5:1
we D5:1
adore D5:1 D5:1
thee D5:1
God D5:1
of D5:1
glory D5:1 D5:1
Lord D5:1.5
of D5:0.5
love D5:2
hearts D5:1
unfold D5:1 C5:1
like A4:1
flowers A4:0.5 A4:0.5
before A4:1 G4:1
thee F#4:1
opening G4:0.5 B4:0.5 B4:1
to D5:1
the D5:1
sun D5:1.5
above B4:0.5 B4:2
melt A4:1
the D5:1
clouds D5:1
of B4:1
sin C5:1
and C5:1
sadness D5:1 B4:1
drive A4:1
the F#4:1
dark G4:1
of F#4:1
doubt G4:1
away F#4:1 F#4:2
giver G4:1 G4:1
of G4:1
immortal A4:1 A4:1 D5:1
gladness D5:1 D5:1
fill D5:1
us D5:1
with D5:1
the D5:1
light D5:1.5
of B4:0.5
day B4:3
rest 0.5
` },
      { name: "Bass", voice: "2428", song: `bpm 100
rest 2
joyful G3:1 G3:1
joyful C4:1 A3:1
we B3:1
adore D4:1 G4:1
thee D4:1
God B3:1
of B3:1
glory D4:1 G4:1
Lord G4:1.5
of D4:0.5
love D4:2
hearts G4:1
unfold G4:1 E4:1
like D4:1
flowers D4:0.5 D4:0.5
before D4:1 D4:1
thee D4:1
opening B3:0.5 G3:0.5 G3:1
to D4:1
the G4:1
sun D4:1.5
above G3:0.5 G3:2
melt C4:1
the D4:1
clouds D4:1
of E4:1
sin A3:1
and D4:1
sadness G3:1 G3:1
drive C4:1
the C4:1
dark G3:1
of A3:1
doubt B3:1
away D4:1 D4:2
giver G3:1 G3:1
of G3:1
immortal D4:1 D4:1 D4:1
gladness G4:1 D4:1
fill B3:1
us B3:1
with D4:1
the G4:1
light D4:1.5
of G3:0.5
day G3:3
rest 0.5
` },
    ].map(lined(2)),
  },
  "Row, Row, Row Your Boat": {
    room: "drier", pan: 0.85, style: HYMN,
    source: "Traditional round (tune published 1881, words 1852), public domain. Four entries two bars apart, each sung by a woman and a man an octave below, three times through; eight voices.",
    parts: [
      { name: "Entry 1, high", voice: "4446", song: `bpm 264
rest 4
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
` },
      { name: "Entry 1, low", voice: "2428", song: `bpm 264
rest 4
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
` },
      { name: "Entry 2, high", voice: "6345", song: `bpm 264
rest 16
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
` },
      { name: "Entry 2, low", voice: "3752", song: `bpm 264
rest 16
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
` },
      { name: "Entry 3, high", voice: "1088", song: `bpm 264
rest 28
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
` },
      { name: "Entry 3, low", voice: "6209", song: `bpm 264
rest 28
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
` },
      { name: "Entry 4, high", voice: "6147", song: `bpm 264
rest 40
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
` },
      { name: "Entry 4, low", voice: "8088", song: `bpm 264
rest 40
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
row C4:3
row C4:3
row C4:2
your D4:1
boat E4:3
gently E4:2 D4:1
down E4:2
the F4:1
stream G4:6
merrily C5:1 C5:1 C5:1
merrily G4:1 G4:1 G4:1
merrily E4:1 E4:1 E4:1
merrily C4:1 C4:1 C4:1
life G4:2
is F4:1
but E4:2
a D4:1
dream C4:6
` },
    ].map(lined(6)),
  },
  "Vibrato, Written": {
    room: "drier", pan: 0.5, style: HYMN,
    source: "Nine chords written for lipservice, to hear a vibrato written on the beat (the vibrato lines under Parts as song files). The soprano sings straight and lets the vibrato in on each long note, on the last growing it to twice its usual size and letting it die. The tenor does the opposite: each long note starts wide and settles to a straight tone. The alto has no line and sings as the voice always does, and the bass is straight throughout. Click a singer on the stage to hear one alone.",
    parts: [
      { name: "Soprano", voice: "4446", song: `bpm 72
rest 2
vibrato 0
slow A4:2
the B4:2
vibrato 0 1:3
tide A4:4
rest 2
vibrato 0
still D5:2
the C#5:2
vibrato 0 1.5:3
night B4:4
rest 2
vibrato 0
hold A4:2
the A4:2
vibrato 0 0:2 2:4 0:2
light A4:8
rest 1
` },
      { name: "Alto", voice: "6345", song: `bpm 72
rest 2
slow F#4:2
the G4:2
tide E4:4
rest 2
still F#4:2
the E4:2
night G4:4
rest 2
hold D4:2
the C#4:2
light D4:8
rest 1
` },
      { name: "Tenor", voice: "3752", song: `bpm 72
rest 2
slow D5:2
the D5:2
vibrato 1.5 0:3
tide C#5:4
rest 2
vibrato 1
still D5:2
the A4:2
vibrato 1.5 0:3
night B4:4
rest 2
vibrato 1
hold A4:2
the G4:2
vibrato 2 0:6
light F#4:8
rest 1
` },
      { name: "Bass", voice: "2428", song: `bpm 72
rest 2
vibrato 0
slow D4:2
the B3:2
tide A3:4
rest 2
still B3:2
the C#4:2
night E4:4
rest 2
hold F#4:2
the A3:2
light D4:8
rest 1
` },
    ],
  },
  // the sing-demos pieces
  ...Object.fromEntries(Object.entries(DEMOS).map(([name, { songs, ...c }]) => [name, { ...c, parts: c.parts.map((p) => ({ ...p, song: songs[p.song] })) }])),
};

// The pieces arranged, each from the sing-demos take of its name. The strophic ones (strophes()):
// who sings each run of lines and how, and the ending.
// SOLO: one of sixteen stood forward, as a soloist is given a microphone of her own (a tenor's is
// twice it, the take's sopranos being at about twice its other parts).
const SOLO = 1.5;
const EVERYONE = (level) => ({ Soprano: ["words", 4, level], Alto: ["words", 4, level], Tenor: ["words", 4, level], Bass: ["words", 4, level] });
const HALF = (level) => ({ Soprano: ["words", 2, level], Alto: ["words", 2, level], Tenor: ["words", 2, level], Bass: ["words", 2, level] });
const ARRANGED = {
  "Siuil a Ruin": siuil,
  "Loch Lomond": (c) => strophes("Loch Lomond", c, {
    plan: [
      [4, { Soprano: ["words", 1, SOLO], Tenor: ["ooh", 2, 0.7], Bass: ["ooh", 2, 0.7] }],
      [4, HALF(0.8)],
      [4, { Soprano: ["words", 4, 0.8], Alto: ["words", 4, 0.8] }],
      [4, EVERYONE(0.9)],
      [4, { Tenor: ["tune", 4, 1.2], Bass: ["tune", 4, 1.2] }],
      [2, EVERYONE(1)],
      [1, EVERYONE(0.5)],
      [1, EVERYONE(0.7)],
    ],
    close: { slow: 0.6, hold: 5 },
    source: "\"Loch Lomond\", a Scottish song of the 19th century; tune and words public domain. Three verses, each answered by the chorus, the tune in the sopranos and three parts written for lipservice under it, every triad tuned pure. One soprano sings the first verse over the men's held \"ooh\"; half the choir answers with the chorus. The second verse is the women alone and its chorus the whole choir. The third verse is the men alone, in unison on the tune, and the last chorus the whole choir in harmony, dropping to half its level at \"never meet again\" and slowing through the last line to a held chord. Sung here by 16 of the demo's 20 singers. Set 7 semitones lower than the demo, to where every voice here holds its top note.",
  }),
  "Wayfaring Stranger": (c) => strophes("Wayfaring Stranger", c, {
    plan: [
      [4, { Soprano: ["words", 1, SOLO] }],
      [4, { Soprano: ["words", 1, SOLO], Alto: ["ooh", 2, 0.55], Tenor: ["ooh", 2, 0.55], Bass: ["ooh", 2, 0.55] }],
      [4, { Soprano: ["words", 4, 0.8], Alto: ["words", 4, 0.8], Bass: ["ooh", 4, 0.5] }],
      [4, EVERYONE(0.8)],
      [6, EVERYONE(1)],
      [1, EVERYONE(0.6)],
      [1, { Soprano: ["words", 1, SOLO], Alto: ["ooh", 4, 0.4], Tenor: ["ooh", 4, 0.4], Bass: ["ooh", 4, 0.4] }],
    ],
    close: { slow: 0.6, hold: 6, fade: 0.5 },
    source: "\"Wayfaring Stranger\", an American folk hymn of the early 19th century; tune and words public domain. Three verses in four parts written for lipservice, the tune in the sopranos, every triad tuned pure. One soprano sings the first four lines alone, and the rest of the verse over a held \"ooh\". The second verse is the women over the basses' \"ooh\", the whole choir at \"I'm going there to see my mother\". The third verse is the whole choir at its full level until \"I'm only going over Jordan\"; the last line is the one soprano again over the choir's \"ooh\", slowing to a held chord. Sung here by 16 of the demo's 20 singers. Set 7 semitones lower than the demo, to where every voice here holds its top note.",
  }),
  "She Moved Through the Fair": (c) => strophes("She Moved Through the Fair", c, {
    plan: [
      [4, { Soprano: ["words", 1, SOLO], Tenor: ["ooh", 2, 0.7], Bass: ["ooh", 2, 0.7] }],
      [4, { Soprano: ["words", 4, 0.8], Alto: ["words", 4, 0.8], Tenor: ["ooh", 4, 0.5], Bass: ["ooh", 4, 0.5] }],
      [3, EVERYONE(1)],
      [1, EVERYONE(0.6)],
      [2, { Soprano: ["words", 1, SOLO] }],
      [2, { Soprano: ["words", 1, SOLO], Alto: ["ooh", 4, 0.4], Tenor: ["ooh", 4, 0.4] }],
    ],
    close: { slow: 0.6, hold: 6, fade: 0.4 },
    source: "\"She Moved Through the Fair\": Padraic Colum's four verses (1909) to the Donegal air; both public domain. The tune in the sopranos, three parts written for lipservice under it. The air is nearly all held notes: four cadences a verse, each held five seconds or more. One soprano sings the first verse over the men's held \"ooh\", the singers breathing in turn so the long lines are not broken. The second verse is the women over the men's \"ooh\", the third the whole choir, falling back at \"that was the last that I saw of my dear\". The dream of the fourth verse is the one soprano alone, the altos and tenors coming in under her at \"She came close beside me\", with no bass, slowing through the last line to a chord that is let go. Sung here by 16 of the demo's 20 singers. Set 6 semitones lower than the demo, to where every voice here holds its top note.",
  }),
  "The Water Is Wide": (c) => strophes("The Water Is Wide", c, {
    plan: [
      [4, { Soprano: ["words", 1, SOLO] }],
      [4, { Soprano: ["words", 1, SOLO], Alto: ["ooh", 2, 0.7], Tenor: ["ooh", 2, 0.7] }],
      [4, { Soprano: ["words", 2], Alto: ["words", 2] }],
      [4, { Tenor: ["tune", 4, 1.2], Bass: ["tune", 4, 1.2] }],
      [4, EVERYONE(0.75)],
      [4, EVERYONE(1)],
      [4, { Soprano: ["words", 4, 0.75], Alto: ["ah", 4, 0.5], Tenor: ["ah", 4, 0.5], Bass: ["ah", 4, 0.5] }],
      [4, { Soprano: ["words", 1, 1.2], Alto: ["words", 1, 1.2], Tenor: ["words", 1, 1.2], Bass: ["words", 1, 1.2] }],
    ],
    close: { slow: 0.6, hold: 6, fade: 0.3 },
    source: "\"The Water Is Wide\": the eight verses and the air Cecil Sharp noted from Caroline Cox at High Ham in 1905; public domain. The tune in the sopranos, three parts written for lipservice under it, tuned pure: one long note of the tune is a different pitch in the odd verses than in the even, by a fifth of a semitone, because the chord under it changes. No two verses are sung by the same forces. One soprano alone; the same soprano over a held \"ooh\"; two sopranos and two altos; the men alone, in unison on the tune; the whole choir, and again at its full level for \"Must I be bound\"; the sopranos over the choir's \"ah\" for the ship; and one singer to a part for the last, slowing through \"fades away like the morning dew\" to a chord that fades. Sung here by 16 of the demo's 20 singers. Set 4 semitones lower than the demo, to where every voice here holds its top note.",
  }),
  "Ca' the Yowes": (c) => strophes("Ca' the Yowes", c, {
    plan: [
      [4, HALF(0.7)],
      [4, { Soprano: ["words", 1, SOLO], Alto: ["ooh", 2, 0.5], Tenor: ["ooh", 2, 0.5], Bass: ["ooh", 2, 0.5] }],
      [4, EVERYONE(0.75)],
      [4, { Tenor: [["tune", 1, 2 * SOLO], ["ooh", 3, 0.4]], Alto: ["ooh", 4, 0.4], Bass: ["ooh", 4, 0.4] }],
      [4, EVERYONE(0.85)],
      [4, { Soprano: ["words", 4, 0.7], Alto: ["words", 4, 0.7] }],
      [4, EVERYONE(0.9)],
      [4, { Soprano: ["words", 1, 1.1], Alto: ["words", 1, 1.1], Tenor: ["words", 1, 1.1], Bass: ["words", 1, 1.1] }],
      [4, EVERYONE(1)],
      [3, EVERYONE(1)],
      [1, EVERYONE(0.7)],
      [4, EVERYONE(0.55)],
    ],
    close: { slow: 0.6, hold: 5, fade: 0.5 },
    source: "\"Ca' the Yowes\": Robert Burns's version of 1794, chorus and five stanzas, to the traditional air; public domain. The tune in the sopranos, three parts written for lipservice under it. The air has six notes and never sings the sixth of its scale, so the choruses leave it out of the harmony too and the verses take it one way and then the other. The chorus is the choir's and grows each time it comes back; the stanzas are passed around, as in Vaughan Williams's setting, where a solo voice sings them over a wordless choir. The first stanza is one soprano over a held \"ooh\"; the second one tenor, the tune an octave down over the altos and basses; the third the women alone; the fourth one singer to a part; the fifth the whole choir. The last chorus is quiet and slows to a held chord. Sung here by 16 of the demo's 20 singers. Set 6 semitones lower than the demo, to where every voice here holds its top note.",
  }),
  "Black Is the Colour": (c) => strophes("Black Is the Colour", c, {
    plan: [
      [4, { Soprano: ["words"] }],
      [4, { Soprano: ["words"], Tenor: ["ooh", 1, 0.7], Bass: ["ooh", 1, 0.7] }],
      [4, { Soprano: ["words"], Alto: ["words"], Tenor: ["words"], Bass: ["words"] }],
      [4, { Soprano: ["words"], Alto: ["words"], Bass: ["ooh", 1, 0.8] }],
      [4, { Soprano: ["words"], Alto: ["words"], Tenor: ["words"], Bass: ["words"] }],
      [4, { Soprano: ["words"], Alto: ["ooh", 1, 0.7], Tenor: ["ooh", 1, 0.7], Bass: ["ooh", 1, 0.7] }],
    ],
    close: { slow: 0.65, hold: 6, fade: 0.5 },
    source: "\"Black Is the Colour\", as Cecil Sharp printed it from Lizzie Roberts's singing in 1917; public domain. Six stanzas for a quartet, three parts written for lipservice under the air. The soprano sings the first stanza alone and the second over the tenor's and bass's held \"ooh\". The third and fifth are the quartet; the fourth is soprano and alto over the bass. The last, the first stanzas' words come back, is the soprano over the other three on \"ooh\", slowing to a held chord. Set 7 semitones lower than the demo, to where every voice here holds its top note.",
  }),
};

// The rest of the pieces arranged, each written out a line at a time (scored()).
const onto = (evs, pitch, beats) => [...evs.slice(0, -1), { ...evs.at(-1), notes: [...evs.at(-1).notes, [pitch, beats]] }]; // a held line moved to a last note
// an arrangement being written: give(who, line, level, vib) hands a line to the parts `who` names
function book(c) {
  const sung = Object.fromEntries(c.parts.map((p) => [p.name, []]));
  const give = (who, evs, level = 1, vib) => {
    const to = c.parts.filter((p) => who.test(p.name));
    if (!to.length) throw new Error(`no part is ${who}`);
    for (const p of to) sung[p.name].push(...marked(evs, vib ? { level, vib } : { level }));
  };
  return { sung, give };
}
const cast = (c) => c.parts.map(({ name, voice, gain, seat }, i) => ({ name, voice, gain, seat: seat ?? i }));
const lines = (c, name, title) => phrased(syllables(c.parts.find((p) => p.name === name) ?? (() => { throw new Error(`${title}: no ${name}`); })(), title));
// A line a word at a time ([[syllable...]]) where several sing it and each rests in turn to breathe.
// wordSpan: a word's [start, end]. unbroken: the line in runs with no rest between. rested: the line
// without the words sounding in the `size` beats from each of `wanted` ([[beat, till]]), each put at
// the nearest multiple of `grid` that leaves `head` beats sung before it, ends by `till`, is `pad`
// beats from every rest in `taken` (the group's, which the singer's are added to) and that
// `free(from, to)` allows.
const wordSpan = (u) => [u[0].at, sylEnd(u.at(-1))];
const unbroken = (us) => us.reduce((rs, u) => { if (!rs.length || u[0].at > wordSpan(rs.at(-1).at(-1))[1] + 1e-6) rs.push([]); rs.at(-1).push(u); return rs; }, []);
const NEARBY = Array.from({ length: 25 }, (_, i) => (i % 2 ? (i + 1) / 2 : -i / 2));
function rested(us, wanted, { size, grid = 1, head, pad, taken, free = () => true }) {
  const span = new Map(us.map((u) => [u, wordSpan(u)]));
  let from = us[0][0].at, kept = us;
  for (const [h0, till] of wanted) {
    const fit = NEARBY.map((d) => {
      const h = (Math.round(h0 / grid) + d) * grid, gone = kept.filter((u) => span.get(u)[0] < h + size && span.get(u)[1] > h);
      if (!gone.length) return null;
      const a = span.get(gone[0])[0], b = span.get(gone.at(-1))[1];
      return a >= from + head && b <= till && free(a, b) && taken.every(([x, y]) => b + pad <= x || a >= y + pad) ? { gone, a, b } : null;
    }).find(Boolean);
    if (!fit) throw new Error(`nowhere to breathe near beat ${h0}`);
    kept = kept.filter((u) => !fit.gone.includes(u));
    taken.push([fit.a, fit.b]);
    from = fit.b;
  }
  return kept;
}
// how a vibrato is pedalled: a soloist's let into her held notes, a choir's kept closer, a hum's closer still
const LEAD_VOICE = { base: 0.7, bloom: 1.8 }, TUTTI = { base: 0.75, bloom: 1.25 }, FULL = { base: 1, bloom: 1.5 }, HUM = { base: 0.4 };
// in a piece sung straight, one who carries the tune has the vibrato's motion to themself: little of it on a note that moves on, more on one held
const FOLK = { base: 0.5, bloom: 1.7 }, PLAIN = { base: 0.5 };
const AMONG = { base: 0.3 }; // a soloist back among singers who sing straight
// a take's singers ("Melody 7" is 7, or one by its whole name) under an arrangement's names, each with its kind's gain (its name's first word)
const recast = (w, title, role, gain) => ({ ...w, parts: w.parts.map((p) => {
  const name = role[p.name] ?? role[p.name.replace(/^\D+/, "")] ?? (() => { throw new Error(`${title}: no part for ${p.name}`); })();
  return { ...p, name, gain: gain[name.split(" ")[0]] ?? (() => { throw new Error(`${title}: no gain for ${name}`); })() };
}) });
const own = (c, who) => cast(c).map((p) => (who.test(p.name) ? { ...p, motion: "vibrato" } : p));
// two singers' voices changed over, each keeping its name, its place and its line
const traded = (c, a, b, title) => {
  const voice = (n) => (c.parts.find((p) => p.name === n) ?? (() => { throw new Error(`${title}: no ${n}`); })()).voice;
  return { ...c, parts: c.parts.map((p) => (p.name === a ? { ...p, voice: voice(b) } : p.name === b ? { ...p, voice: voice(a) } : p)) };
};
const SCORED = {
  "The Parting Glass": (c) => {
    const T = "The Parting Glass", V = 74; // the second verse this many beats after the first
    const S = lines(c, "Soprano 1", T), A = lines(c, "Alto 2", T), N = lines(c, "Tenor 1", T), B = lines(c, "Bass 1", T); // S: lines 1 to 8, A and N: 5 to 8, B: 3 to 8
    const { sung, give } = book(c);
    // verse 1, as the take builds it
    give(/^Soprano 1$/, [...S[0], ...S[1]], 1.15, LEAD_VOICE);
    give(/^Soprano 1$/, [...S[2], ...S[3]], 1.25, LEAD_VOICE);
    give(/^Soprano 1$/, [...S[4], ...S[5]], 1.3, LEAD_VOICE);
    give(/^Bass [13]$/, [...B[0], ...B[1]], 0.6, HUM);
    give(/^Bass [13]$/, [...B[2], ...B[3]], 0.75, TUTTI);
    give(/^Tenor [13]$/, [...N[0], ...N[1]], 0.75, TUTTI);
    give(/^Alto [23]$/, [...A[0], ...A[1]], 0.75, TUTTI);
    give(/^Soprano/, [...S[6], ...S[7]], 0.9, TUTTI);
    give(/^Alto/, [...A[2], ...A[3]], 0.9, TUTTI);
    give(/^Tenor/, [...N[2], ...N[3]], 0.9, TUTTI);
    give(/^Bass/, [...B[4], ...B[5]], 0.9, TUTTI);
    // verse 2. The second strain's parts (lines 7 and 8) fit lines 3 and 4 half a beat on.
    const words = [
      "Of all the com-rades that ere I had", "they're sor-ry for/ my go-ing a-way",
      "And all the sweet-hearts that ere I had", "they'd wish me one more day to stay",
      "But since it falls un-to my lot", "that I should~2 rise and you should not",
      "I'll gent-ly rise and soft-ly call", "good night and joy be with you all",
    ];
    // line 3 has line 1's syllables here, so line 1's notes
    const tune = [S[0], S[1], moved(S[0], S[2][0].at - S[0][0].at), S[3], S[4], S[5], S[6], S[7]].map((l, i) => underlay(moved(l, V), words[i], T));
    const at = (i) => tune[i][0].at, end = (i) => sylEnd(tune[i].at(-1));
    const early = (l) => moved(l, V - 36.25);
    const alto = [null, null, early(A[2]), early(A[3]), moved(A[0], V), moved(A[1], V), moved(A[2], V), moved(A[3], V)];
    const tenor = [null, null, early(N[2]), early(N[3]), moved(N[0], V), moved(N[1], V), moved(N[2], V), moved(N[3], V)];
    const bass = [null, null, moved(B[0], V), moved(B[1], V), moved(B[2], V), moved(B[3], V), moved(B[4], V), moved(B[5], V)];
    const two = (i) => [...tune[i], ...tune[i + 1]], both = (ls, i) => [...under(tune[i], ls[i]), ...under(tune[i + 1], ls[i + 1])];
    const hum = (ls, i, n, phase) => hummed(ls.slice(i, i + n), "ooh", phase, (end(i + n - 1) - at(i)) / n * 60 / 80);
    // one tenor, the others and the basses on the keynote and its fifth, the basses to the chord of "away"
    const away = tune[1].at(-2).at;
    give(/^Tenor 3$/, two(0), 2 * SOLO, LEAD_VOICE);
    give(/^Bass [13]$/, onto(held(60, [at(0), end(0) - 0.4, away]), 63.1564, end(1) - away), 0.5, HUM);
    give(/^Bass [24]$/, onto(held(60, [at(0), at(0) + 4.5, at(1) + 3, away]), 63.1564, end(1) - away), 0.5, HUM);
    give(/^Tenor 1$/, held(67.0196, [at(0), at(0) + 6.25, at(1) + 4, end(1)]), 0.5, HUM);
    give(/^Tenor [24]$/, held(67.0196, [at(0), at(1) + 0.75, end(1)]), 0.5, HUM);
    // the women answer, the men under them
    give(/^Soprano/, two(2), 0.8, TUTTI);
    give(/^Alto/, both(alto, 2), 0.8, TUTTI);
    give(/^Tenor [124]$/, hum(tenor, 2, 2, 0.35), 0.5, HUM);
    give(/^Tenor 3$/, hum(tenor, 2, 2, 0.6), 0.5, HUM);
    give(/^Bass [13]$/, hum(bass, 2, 2, 0), 0.5, HUM);
    give(/^Bass [24]$/, hum(bass, 2, 2, 0.8), 0.5, HUM);
    // everyone
    give(/^Soprano/, two(4), 1, FULL);
    give(/^Alto/, both(alto, 4), 1, FULL);
    give(/^Tenor/, both(tenor, 4), 1, FULL);
    give(/^Bass/, both(bass, 4), 1, FULL);
    // two to a part
    give(/^Soprano [12]$/, tune[6], 0.65, TUTTI);
    give(/^Alto [23]$/, under(tune[6], alto[6]), 0.65, TUTTI);
    give(/^Tenor [13]$/, under(tune[6], tenor[6]), 0.65, TUTTI);
    give(/^Bass [13]$/, under(tune[6], bass[6]), 0.65, TUTTI);
    // the soprano who began it, over the altos' and the men's hum
    const last = (evs, vib) => [...evs.slice(0, -1), { ...evs.at(-1), vib }];
    give(/^Soprano 1$/, last(marked(tune[7], { vib: LEAD_VOICE }), { ...LEAD_VOICE, die: 0.3 }), 1.1);
    for (const [re, ls, phase] of [[/^Alto [14]$/, alto[7], 0.3], [/^Alto [23]$/, alto[7], 0], [/^Tenor [13]$/, tenor[7], 0], [/^Tenor [24]$/, tenor[7], 0.45], [/^Bass [13]$/, bass[7], 0], [/^Bass [24]$/, bass[7], 0.55]]) {
      give(re, last(marked(hummed([ls], "ooh", phase, 6), { vib: HUM }), { ...HUM, die: 0.1 }), 0.4);
    }
    const parts = scored(T, cast(c), sung, {
      bpm: 80,
      close: { from: at(7) + 3, chord: tune[7].at(-1).at, slow: 0.6, hold: 6, fade: 0.4 },
      swells: [
        [/^Soprano 1$/, [[10.75, 1], [16.75, 1.15], [18.75, 1], [28.75, 1], [31.75, 1.15], [36.75, 0.9], [37.5, 1]]], // to "company", to "was"
        [/./, [[37, 1], [37.8, 0.9], [45, 1.1], [47.25, 1], [55.25, 0.85], [56.5, 1], [65, 1], [68, 1.12], [73, 0.8], [74, 1]]], // through the second strain; "joy"
        [/./, [[at(4) - 1, 1], [at(4) - 0.2, 0.9], [at(5) + 3.5, 1.2], [end(5), 0.9], [at(6) - 0.2, 1]]], // to "rise"
      ],
    });
    return {
      ...c, parts,
      source: "\"The Parting Glass\": the tune is the Scottish \"Good Night and Joy Be Wi' Ye A'\", in print before 1800, the verses traditional; both public domain. Four parts written for lipservice under the tune, every chord tuned pure. Two verses. One soprano sings the first strain alone, her vibrato let into the notes she holds; the basses come in under her, then the tenors and altos, and everyone at \"So fill to me the parting glass\". The second verse, \"Of all the comrades that ere I had\", is one tenor over the men's held \"ooh\"; the women answer with \"And all the sweethearts\" over the men; the whole choir sings \"But since it falls unto my lot\" and half of it \"I'll gently rise and softly call\"; the soprano who began sings the last line over the others' \"ooh\", slowing to a held chord. Sung here by 16 of the demo's 20 singers. Set 6 semitones lower than the demo, to where every voice here holds its top note.",
    };
  },
  "Wild Mountain Thyme": (c) => {
    const T = "Wild Mountain Thyme", ST = 42; // a stanza's beats
    const { sung, give } = book(c);
    // each 12 lines: the first strain, the second, and the first again with its last line broadened
    const S = lines(c, "Soprano", T), A = lines(c, "Alto 1", T), N = lines(c, "Tenor 1", T), B = lines(c, "Bass 1", T);
    const words = [
      null,
      ["I will twine thee a bow/-er", "By the clear sil-ler foun-tain", "And I'll co-ver it ore", "Wih the flow-ers o' the moun-tain",
        "I will range through/ the wilds~2", "And/ the deep glens sae~2 drea-ry", "And re-turn wih their spoils", "To the bow/-er o'/ my dea-rie~2"],
      ["When the rude win-try win'", "Id-ly raves round oour dwel-ling", "And the roar of the linn", "On the night~2 breeze is swel-ling",
        "So/ mer-ri-ly we'll sing~2", "As/ the storm rat-tles ore us~2", "Till the dear shie-ling ring", "Wih the light lil/-ting cho-rus~2"],
      ["Now the sim/-mer is in prime", "Wih the flow/-ers rich-ly bloom-ing", "And the wild moun-tain time", "Aw the moor~2-lands per-fu-ming",
        "To oour dear na/-tive scenes~2", "Let/ us jour-ney to~2-ge-ther", "Where glad in-no-cence reigns", "'Mang the braes o' Bal-qui-ther"],
    ];
    // stanza n's line i: the tune, and a part's line under the tune's syllables
    const tune = (n, i) => (n === 4 ? moved(S[8 + i], 3 * ST) : words[n] ? underlay(moved(S[i], n * ST), words[n][i], T) : S[i]);
    const part = (X, n, i) => (n === 4 ? moved(X[8 + i], 3 * ST) : moved(X[i], n * ST));
    const span = (n, a, b, f) => Array.from({ length: b - a }, (_, k) => f(n, a + k));
    const air = (n, a, b) => span(n, a, b, tune).flat();
    const with_ = (X, n, a, b) => span(n, a, b, (n, i) => under(tune(n, i), part(X, n, i))).flat();
    const hum = (X, n, a, b, phase) => hummed(span(n, a, b, (n, i) => part(X, n, i)), "ooh", phase, 3.6);
    // 1: she sings alone, and the altos come in under her at "Where the deer and the rae"
    give(/^Soprano$/, air(0, 0, 8), 1.1, FOLK);
    give(/^Alto 1$/, hum(A, 0, 4, 8, 0), 1, PLAIN);
    give(/^Alto 2$/, hum(A, 0, 4, 8, 0.5));
    // 2: his answer, a tenor over the men, the altos again at the second strain
    give(/^Tenor 1$/, air(1, 0, 8), 3, FOLK);
    give(/^Tenor 2$/, hum(N, 1, 0, 8, 0.4), 0.9);
    give(/^Bass 1$/, hum(B, 1, 0, 8, 0));
    give(/^Bass 2$/, hum(B, 1, 0, 8, 0.5));
    give(/^Alto 1$/, hum(A, 1, 4, 8, 0.25), 1, PLAIN);
    give(/^Alto 2$/, hum(A, 1, 4, 8, 0.75));
    // 3: winter, an alto over the men; then everyone, growing to "the light lilting chorus"
    give(/^Alto 1$/, air(2, 0, 4), 2.7, FOLK);
    give(/^Tenor 1$/, hum(N, 2, 0, 4, 0.3), 0.8, PLAIN);
    give(/^Tenor 2$/, hum(N, 2, 0, 4, 0.7), 0.8);
    give(/^Bass 1$/, hum(B, 2, 0, 4, 0), 0.8);
    give(/^Bass 2$/, hum(B, 2, 0, 4, 0.5), 0.8);
    give(/^Soprano$/, air(2, 4, 8), 1, FOLK);
    give(/^Alto 1$/, with_(A, 2, 4, 8), 1, PLAIN);
    give(/^Alto 2$/, with_(A, 2, 4, 8));
    give(/^Tenor 1$/, with_(N, 2, 4, 8), 1, PLAIN);
    give(/^Tenor 2$/, with_(N, 2, 4, 8));
    give(/^Bass/, with_(B, 2, 4, 8));
    // 4: summer, everyone
    give(/^Soprano$/, air(3, 0, 8), 1.1, FOLK);
    give(/^Alto 1$/, with_(A, 3, 0, 8), 1.1, PLAIN);
    give(/^Alto 2$/, with_(A, 3, 0, 8), 1.1);
    give(/^Tenor 1$/, with_(N, 3, 0, 8), 1.1, PLAIN);
    give(/^Tenor 2$/, with_(N, 3, 0, 8), 1.1);
    give(/^Bass/, with_(B, 3, 0, 8), 1.1);
    // "Will ye go" again: she alone, then the altos with her, then everyone, the last line broad
    give(/^Soprano$/, air(4, 0, 4), 1.05, FOLK);
    give(/^Alto 1$/, with_(A, 4, 1, 4), 0.95, PLAIN);
    give(/^Alto 2$/, with_(A, 4, 1, 4), 0.95);
    give(/^Tenor 1$/, with_(N, 4, 2, 4), 1, PLAIN);
    give(/^Tenor 2$/, with_(N, 4, 2, 4));
    give(/^Bass/, with_(B, 4, 2, 4));
    const last = tune(4, 3), hea = last.at(-2).at, at = (n, i) => tune(n, i)[0].at;
    const parts = scored(T, own(c, /^(Soprano|Alto 1|Tenor 1)$/), sung, {
      bpm: 88,
      close: { from: last[2].at, chord: last.at(-1).at, slow: 0.6, hold: 1.5, fade: 0.6 },
      lifts: [[hea + 0.25, 1]], // "hea-" held
      swells: [
        [/^Soprano$/, [[at(0, 5) - 0.5, 1], [at(0, 5) + 2.5, 1.15], [at(0, 6), 1]]], // "Lightly"
        [/^Tenor 1$/, [[at(1, 5) - 0.5, 1], [at(1, 5) + 2.5, 1.12], [at(1, 6), 1]]], // "deep glens"
        [/./, [[at(2, 4) - 0.6, 1], [at(2, 4) - 0.1, 0.8], [at(2, 6), 1], [at(2, 7) + 2, 1.15], [at(3, 0) - 1, 1.1], [at(3, 0) - 0.3, 1]]], // to "the light lilting chorus"
        [/./, [[at(3, 5), 1], [at(3, 5) + 2.5, 1.15], [at(3, 6), 1], [at(3, 7), 0.9], [at(3, 7) + 5, 0.8], [at(4, 0) - 0.3, 1]]], // "journey", and down to the stanza's end
        [/./, [[at(4, 3), 1], [at(4, 3) + 2.5, 1.15]]], // "Highland"
      ],
    });
    return {
      ...c, parts,
      source: "\"The Braes of Balquhidder\", Robert Tannahill's words as R. A. Smith set them in The Scotish Minstrel (1821), the song \"Wild Mountain Thyme\" came from; public domain. All four of Tannahill's stanzas and the first strain again, three parts written for lipservice under the air. The soprano sings the first stanza, alone and then over the altos' \"ooh\". A tenor answers with \"I will twine thee a bower\" over the men. The winter stanza is an alto over the men, and the choir comes in at \"So merrily we'll sing\" and grows to \"the light lilting chorus\"; the summer stanza is everyone. \"Will ye go, Lassie, go\" comes back in the soprano alone, the altos and then the men joining her, the last line broad. The three who carry the tune let a vibrato into the notes they hold; the others sing straight. Some of the Scots is spelled as it sounds, for the reading: \"wih\" is wi', \"aw\" is a', \"oour\" is oor, our, \"ore\" is o'er, and \"time\" is thyme. Set 7 semitones lower than the demo, to where every voice here holds its top note.",
    };
  },
  "The Turtle Dove": (c) => {
    const T = "The Turtle Dove", ST = 48, LINE = 9; // a stanza's beats, and from a line to the next
    const { sung, give } = book(c);
    const she = lines(c, "Alto 2", T), he = lines(c, "Bass 4", T); // stanzas 1, 3 and 6; 2, 4 and 5
    // The choir's harmony, written for this: through each of a stanza's first four lines, the beat
    // into the line and the notes from there for sopranos, altos, tenors and basses (the men's sound
    // an octave down). A flat, D flat, E flat with its seventh, B flat minor, and F minor under "my
    // dear". No voice goes with another, or with either soloist, in fifths or octaves. The last
    // line's is the take's, the altos on the thirds under a soloist.
    const CHART = [
      [[0, [60, 56, 63, 56]], [2, [61, 56, 65, 61]], [4.5, [61, 55, 67, 63]], [7, [60, 56, 63, 56]]],
      [[0, [60, 56, 60, 56]], [1, [61, 56, 65, 61]], [3, [63, 60, 68, 56]], [5, [61, 58, 65, 58]], [7, [63, 58, 67, 63]]],
      [[0, [63, 60, 68, 56]], [1, [61, 61, 65, 61]], [2, [61, 58, 67, 63]], [3, [60, 56, 63, 56]], [5, [61, 56, 65, 61]], [7, [63, 60, 68, 56]]],
      [[0, [63, 60, 68, 56]], [1, [61, 56, 65, 61]], [3, [63, 60, 68, 56]], [5, [65, 60, 68, 53]]],
    ];
    const LAST = 2 + 5 * ST + 4 * LINE, thirds = [61, 60, 60, 60, 58, 60].map((m, k) => ({ at: LAST + k, word: "ooh", k: 0, notes: [[m, k === 5 ? 2 : 1]] }));
    const TAKE = [lines(c, "Soprano 1", T)[0], lines(c, "Alto 1", T)[0], lines(c, "Tenor 1", T)[0], lines(c, "Bass 1", T)[0]];
    const VOICES = [/^Soprano/, /^Alto [1345]$/, /^Tenor/, /^Bass [1235]$/], CHOIR = /^(Soprano|Tenor|Alto [1345]|Bass [1235])/;
    const line = (v, n, i) => (i === 4 ? moved(v === 1 ? thirds : TAKE[v], ST * (n - 5))
      : CHART[i].map(([b, m], k) => ({ at: 2 + ST * n + LINE * i + b, word: "ooh", k: 0, notes: [[m[v], (CHART[i][k + 1]?.[0] ?? 8) - b]] })));
    // voices `vs` on a vowel through lines a to b of stanza n, each singer breathing in turn
    const hum = (vs, n, a, b, level, vowel = "ooh") => {
      for (const v of vs) c.parts.filter((p) => VOICES[v].test(p.name)).forEach((p, q) => {
        give(new RegExp(`^${p.name}$`), hummed(Array.from({ length: b - a }, (_, k) => line(v, n, a + k)), vowel, 0.3 + 0.6 * (q + v / 4) / 4, 6.1), level); // no breath just as a line begins
      });
    };
    give(/^Alto 2$/, she.flat(), 1, FOLK);
    give(/^Bass 4$/, he.slice(0, 10).flat(), 1, FOLK);
    give(/^Bass 4$/, he.slice(10).flat(), 1.1, FOLK);
    hum([0, 1], 0, 2, 5, 0.3); // 1: she is alone, the women under her from "Lamenting"
    hum([2, 3], 1, 0, 4, 0.3); // 2: he over the men, everyone at "If I row ten thousand mile"
    hum([0, 1, 2, 3], 1, 4, 5, 0.35);
    hum([0, 1, 2, 3], 2, 0, 5, 0.35); // 3: everyone under her
    hum([0, 1], 3, 0, 2, 0.3); // 4: the women under him, then everyone
    hum([0, 1, 2, 3], 3, 2, 5, 0.38);
    hum([0, 1, 2, 3], 4, 0, 4, 0.45, "ah"); // 5: opened to "ah", and "Until the day I die" sung with him
    const die = he[14];
    give(VOICES[1], die, 0.5);
    for (const v of [0, 2, 3]) give(VOICES[v], under(die, line(v, 4, 4)), 0.6);
    hum([0, 1, 2, 3], 5, 0, 2, 0.3); // 6: under her, growing, and everyone's "Till all my days are done"
    hum([0, 1, 2, 3], 5, 2, 4, 0.4);
    TAKE.forEach((l, v) => give(VOICES[v], l, 0.8));
    const at = (n, i) => 2 + ST * n + LINE * i;
    const parts = scored(T, own(c, /^(Alto 2|Bass 4)$/), sung, {
      bpm: 88,
      close: { from: LAST + 2, chord: LAST + 5, slow: 0.6, hold: 5, fade: 0.5 },
      swells: [
        // the choir leans into each stanza's third line and away through its fourth
        ...[0, 1, 2, 3, 4, 5].map((n) => [CHOIR, [[at(n, 2), 1], [at(n, 2) + 4, 1.25], [at(n, 3), 1.05], [at(n, 3) + 8, 0.85], [at(n, 4) - 0.3, 1]]]),
        [CHOIR, [[at(4, 0) - 0.8, 1], [at(4, 0) - 0.3, 0.8], [at(4, 2), 1], [at(5, 0) - 2, 1.1], [at(5, 0) - 1, 1]]], // the fifth stanza grows from its start
        [CHOIR, [[at(5, 2), 1], [at(5, 3) + 8, 1.3], [at(5, 4) - 0.3, 1]]], // and the sixth to the last line
      ],
    });
    return {
      ...c, parts,
      source: "\"The Turtle Dove\", an English folk song; tune and words public domain. Six stanzas as a dialogue: an alto is the one who stays and a bass, an octave under her, the one who goes, each letting a vibrato into the notes they hold. Under them the choir, a harmony written for lipservice, sung on \"ooh\": the women come in under her at \"Lamenting for her own true love\", the men are under him, and from the third stanza it is everyone. In the fifth the choir opens to \"ah\" and sings \"Until the day I die\" with him; the sixth grows to everyone's \"Till all my days are done\", slowed to a held chord. Set 4 semitones lower than the demo, to where every voice here holds its top note.",
    };
  },
  "Hard Times": (c) => {
    const T = "Hard Times", V = 35.5, C = 37, K = 37.5; // from a verse's start to its chorus's, from a chorus's to the next verse's, and the take's first chorus
    const { sung, give } = book(c);
    const take = (name, n) => { const ls = squared(lines(c, name, T)); if (ls.length !== n) throw new Error(`${T}: ${name} has ${ls.length} lines`); return ls; };
    const solo = take("Solo", 11); // the first verse's lines 0 to 4, the second's 5 to 10
    const CH = ["First soprano 1", "Second soprano 1", "Tenor 1", "Bass 1"].map((name) => take(name, 16).slice(0, 8)); // the chorus's 8 lines, a voice each
    const WHO = [/^First soprano/, /^Second soprano/, /^Tenor/, /^Bass/];
    const v = [2, 2 + V + C, 2 + 2 * (V + C), 2 + 3 * V + 2 * C], k = [2 + V, 2 + 2 * V + C, 2 + 4 * V + 2 * C]; // verses and choruses: the third verse runs on into the fourth
    // A verse's four lines. The chorus's parts go under them: its "Many days you have lingered" is
    // the first and third lines' tune and its last line the verse's; the second line's harmony is
    // written for this (F, C, G7, C), each voice's notes and beats.
    const LINE2 = [null, [[60, 4], [59, 1], [60, 2]], [[65, 1], [64, 1], [67, 2], [65, 1], [64, 2]], [[53, 1], [60, 3], [55, 1], [60, 2]]];
    const harm = (x, at) => [moved(CH[x][5], at - K - 16.5), laid(at + 8, LINE2[x]), moved(CH[x][5], at - K - 0.5), [...moved(CH[x][6], at - K - 0.5), ...moved(CH[x][7], at - K - 0.5)]];
    const first = [solo[0], solo[1], solo[2], [...solo[3], ...solo[4]]], second = [solo[5], solo[6], [...solo[7], ...solo[8]], [...solo[9], ...solo[10]]];
    const words = [
      null, null,
      ["There's a pale droop-ing mai-den who toils her life a-way", "With a worn heart/ whose bet-ter days are ore", "Though her voice would be mer-ry 'tis sigh-ing all the day"],
      ["'Tis a sigh that is waf-ted a-cross the trou-bled wave", "'Tis a wail that/ is heard up-on the shore", "'Tis a dirge that is mur-mured a-round the low-ly grave"],
    ];
    const tune = (n, i) => (n === 1 ? second[i] : words[n]?.[i] ? underlay(moved(first[i], v[n] - 2), words[n][i], T) : moved(first[i], v[n] - 2));
    const air = (n, a, b) => Array.from({ length: b - a }, (_, j) => tune(n, a + j)).flat();
    // voice x's line under lines a to b of verse n, on a vowel, by those `who` names, breathing in
    // turn, none of them as the line begins or late in its last note
    const hum = (who, x, n, a, b, level, vowel = "ooh") => c.parts.filter((p) => who.test(p.name)).forEach((p, q, all) => {
      give(new RegExp(`^${p.name}$`), hummed(harm(x, v[n]).slice(a, b), vowel, 0.2 + 0.6 * (q + x / 4) / all.length, 8 * 60 / 92), level);
    });
    // lines a to b of chorus n: voice x's, and everyone's (the soloist with the tune at her own level, if any)
    const chorus = (n, x, a, b) => moved(CH[x].slice(a, b).flat(), k[n] - K);
    const all = (n, a, b, level, lead) => {
      WHO.forEach((who, x) => give(who, chorus(n, x, a, b), level));
      if (lead) give(/^Solo$/, chorus(n, 0, a, b), lead, FOLK);
    };
    // 1: she is alone, and at "There's a song that will linger" the song is under her
    give(/^Solo$/, air(0, 0, 4), 1.15, FOLK);
    for (const x of [1, 2, 3]) hum(WHO[x], x, 0, 2, 4, 0.33);
    all(0, 0, 2, 0.5);
    all(0, 2, 5, 0.55);
    all(0, 5, 6, 0.5);
    all(0, 6, 8, 0.45);
    // 2: a tenor, the women over him and the basses under
    give(/^Tenor 1$/, air(1, 0, 4), 1.25, FOLK);
    hum(WHO[0], 2, 1, 0, 4, 0.3);
    hum(WHO[1], 1, 1, 0, 4, 0.3);
    hum(WHO[3], 3, 1, 0, 4, 0.33);
    // the women begin the chorus, and the men come in at "Hard Times"
    for (const x of [0, 1]) give(WHO[x], chorus(1, x, 0, 2), 0.7);
    all(1, 2, 5, 0.7);
    all(1, 5, 6, 0.65);
    all(1, 6, 8, 0.6);
    // 3: she again, two under her, then the men
    give(/^Solo$/, air(2, 0, 4), 1.15, FOLK);
    hum(WHO[1], 1, 2, 0, 4, 0.3);
    for (const x of [2, 3]) hum(WHO[x], x, 2, 2, 4, 0.3);
    // 4: everyone, the words under the tune; the third line hushed, the last growing into the chorus
    [[0.6, 0.9], [0.7, 1], [0.45, 0.7], [0.6, 0.9]].forEach(([level, lead], i) => {
      give(/^Solo$/, tune(3, i), lead, FOLK);
      give(WHO[0], tune(3, i), level);
      for (const x of [1, 2, 3]) give(WHO[x], under(tune(3, i), harm(x, v[3])[i]), level);
    });
    all(2, 0, 2, 0.85, 1.1);
    all(2, 2, 5, 0.9, 1.15);
    all(2, 5, 6, 0.65, 0.95);
    all(2, 6, 8, 0.5, 0.85);
    sung.Solo = sung.Solo.map((e) => (sylEnd(e) > k[2] + 32.9 ? { ...e, vib: { ...FOLK, die: 0.3 } } : e));
    sung["Tenor 1"] = sung["Tenor 1"].map((e) => (e.vib ? e : { ...e, vib: PLAIN })); // one of the tenors when he is not the soloist
    const parts = scored(T, own(c, /^(Solo|Tenor 1)$/), sung, {
      bpm: 92,
      close: { from: k[2] + 28, chord: k[2] + 30, slow: 0.6, hold: 6, fade: 0.4 },
      lifts: [[k[2] + 25.5, 1.5]], // the last "Oh" held
      swells: [
        [/./, [[v[0] + 16.5, 1], [v[0] + 20, 1.1], [v[0] + 23.5, 1]]], // "linger"
        [/./, [[k[0] + 8.5, 1], [k[0] + 9.5, 1.2], [k[0] + 11.5, 1.25], [k[0] + 15, 1], [k[0] + 17, 1], [k[0] + 20.5, 1.12], [k[0] + 24, 1], [k[0] + 28, 1], [k[0] + 31, 0.85], [k[0] + 35, 1]]], // "Hard Times, Hard Times"; "lingered"; away
        [/./, [[v[1] + 16, 1], [v[1] + 19.5, 0.9], [v[1] + 21, 0.9], [v[1] + 23.5, 1.1], [v[1] + 26, 1.1], [v[1] + 27.5, 1]]], // "silent", and "their pleading looks will say"
        [/./, [[k[1] + 8.5, 1], [k[1] + 9.5, 1.2], [k[1] + 11.5, 1.25], [k[1] + 15, 1.05], [k[1] + 16.4, 1], [k[1] + 20.5, 1.1], [k[1] + 24, 1], [k[1] + 29, 1], [k[1] + 32, 0.8], [k[1] + 35, 1]]],
        [/./, [[v[2] + 16, 1], [v[2] + 19.5, 1.1], [v[2] + 21.5, 0.9], [v[2] + 24, 1]]], // "merry", "sighing"
        [/./, [[v[3] + 4, 1], [v[3] + 6.5, 1.15], [v[3] + 7.9, 1], [v[3] + 24, 1], [v[3] + 27, 1.15], [v[3] + 31, 1.3], [v[3] + 34, 1]]], // "the troubled wave"; into the chorus
        [/./, [[k[2] + 8.5, 1], [k[2] + 9.5, 1.15], [k[2] + 11.5, 1.2], [k[2] + 15.5, 1.05], [k[2] + 16.4, 1], [k[2] + 20.5, 1.15], [k[2] + 24.3, 1]]],
      ],
    });
    return {
      ...c, parts,
      source: "\"Hard Times Come Again No More\" by Stephen Foster (1854); public domain. All four of Foster's verses, the chorus in his four parts. The soloist sings the first verse alone until \"There's a song that will linger\", where the choir comes in under her on \"ooh\": the chorus's own parts, and a harmony written for lipservice under each verse's second line. A tenor sings the second verse, the women over him and the basses under; the women begin its chorus alone and the men come in at \"Hard Times\". The third verse, \"There's a pale drooping maiden\", is the soloist again, and the fourth, \"'Tis a sigh that is wafted across the troubled wave\", follows it with no chorus between: everyone, the words under the tune, hushed at \"'Tis a dirge that is murmured\" and growing into the last chorus, whose last \"Oh\" is held before the close slows to its chord. The two soloists let a vibrato into the notes they hold; the others sing straight. The demo's notes are set on the beat here, where it wrote each singer a little off it. \"ore\" is o'er, spelled as it sounds for the reading. Set 3 semitones lower than the demo, to where every voice here holds its top note.",
    };
  },
  "Amazing Grace": (w) => {
    const T = "Amazing Grace", ST = 48, HALF = 24, at = (n, h = 0) => 2 + ST * n + HALF * h; // a stanza's beats, and half of one: its two lines
    // the take's sixteen, who all sing the tune, as a soloist and a choir in four parts
    const ROLE = { 1: "Solo", 2: "Soprano 1", 3: "Soprano 2", 12: "Soprano 3", 7: "Alto 1", 8: "Alto 2", 9: "Alto 3", 11: "Alto 4", 16: "Alto 5", 4: "Tenor 1", 5: "Tenor 2", 6: "Tenor 3", 10: "Bass 1", 13: "Bass 2", 14: "Bass 3", 15: "Bass 4" };
    const c = recast(w, T, ROLE, { Solo: 5, Soprano: 1.5, Alto: 1.2, Tenor: 1.5, Bass: 1.3 });
    const S = lines(w, "Melody 1", T); // the four stanzas' eight lines
    const { sung, give } = book(c);
    // The harmony, written for this: under each of a stanza's two lines an alto's, a tenor's and a
    // bass's, from the line's upbeat ([pitch, beats]; the men's sound an octave down). In F: the
    // first line by way of B flat and D minor to C, the second through F7 over E flat to B flat and
    // home by D minor.
    const HARM = {
      Alto: [[[57, 1], [60, 3], [65, 3], [62, 2], [58, 1], [57, 3], [60, 3], [65, 3], [64, 4]],
        [[65, 1], [69, 1.5], [65, 0.5], [69, 0.5], [65, 0.5], [60, 2], [57, 1], [58, 3], [57, 3], [62, 3], [65, 2], [64, 1], [60, 4]]],
      Tenor: [[[65, 1], [69, 3], [69, 3], [70, 2], [65, 1], [65, 3], [69, 3], [69, 2], [74, 1], [72, 3], [70, 1]],
        [[72, 1], [72, 3], [69, 2], [65, 1], [65, 3], [65, 3], [69, 3], [72, 2], [70, 1], [69, 4]]],
      Bass: [[[53, 1], [65, 3], [65, 3], [58, 3], [53, 3], [65, 2], [64, 1], [62, 2], [58, 1], [60, 4]],
        [[65, 1], [65, 3], [65, 2], [63, 1], [62, 1.5], [58, 1.5], [53, 2], [60, 1], [62, 3], [60, 3], [65, 4]]],
      // the tenors' second line for sopranos over the altos: its A kept where a tenor goes up to C, which would be a fifth over the altos twice
      Over: [null, [[72, 1], [72, 3], [69, 2], [65, 1], [65, 3], [65, 3], [69, 5], [70, 1], [69, 4]]],
    };
    const line = (v, n, h) => laid(at(n, h), HARM[v][h]);
    const words = ["the lord has prom-ised good to me his word my hope se-cures", "he will my shield and por-tion be as long as life en-dures"];
    const ending = (evs, pitch) => [...evs.slice(0, -1), { ...evs.at(-1), notes: [[pitch, 4]] }]; // the last word, as long as a stanza's
    // stanza n's line h: the take's first three, a fourth on the first's notes, and the take's last
    const tune = (n, h) => (n === 3 ? underlay(moved(S[h], 3 * ST), words[h], T) : n === 4 ? (h ? ending(moved(S[7], ST), 65) : moved(S[6], ST)) : S[2 * n + h]);
    const sing = (who, v, n, h, level, vib) => give(who, v ? under(tune(n, h), line(v, n, h)) : tune(n, h), level, vib);
    const hum = (who, v, n, a, b, level) => c.parts.filter((p) => who.test(p.name)).forEach((p, q, all) => {
      give(new RegExp(`^${p.name}$`), hummed(Array.from({ length: b - a }, (_, j) => line(v, n, a + j)), "ooh", 0.3 + 0.7 * (q + (v === "Bass" ? 0.5 : 0)) / all.length, HALF * 60 / 80), level, HUM); // no breath just after the upbeat
    });
    // 1: she is alone
    for (const h of [0, 1]) sing(/^Solo$/, null, 0, h, 1, LEAD_VOICE);
    // 2: the altos under her with the words, the men on "ooh"; the sopranos with her at "How precious"
    for (const h of [0, 1]) {
      sing(/^Solo$/, null, 1, h, 0.95, LEAD_VOICE);
      sing(/^Alto/, "Alto", 1, h, 0.8, TUTTI);
    }
    hum(/^Tenor/, "Tenor", 1, 0, 2, 0.5);
    hum(/^Bass/, "Bass", 1, 0, 2, 0.6);
    sing(/^Soprano/, null, 1, 1, 0.7, TUTTI);
    // 3: the men, the tenors with the tune; the women over them on "ooh" at "'Tis grace hath brought me safe thus far"
    for (const h of [0, 1]) {
      sing(/^Tenor/, null, 2, h, 1.5, TUTTI);
      sing(/^Bass/, "Bass", 2, h, 1, TUTTI);
    }
    hum(/^Alto/, "Alto", 2, 1, 2, 0.55);
    hum(/^Soprano/, "Over", 2, 1, 2, 0.45);
    // 4: the choir in its four parts, and she comes back at "He will my shield and portion be"
    for (const h of [0, 1]) {
      sing(/^Soprano/, null, 3, h, 1 + 0.1 * h, TUTTI);
      for (const v of ["Alto", "Tenor", "Bass"]) sing(new RegExp(`^${v}`), v, 3, h, 0.9 + 0.1 * h, TUTTI);
    }
    sing(/^Solo$/, null, 3, 1, 0.6, LEAD_VOICE);
    // 5: everyone, after a breath; she holds the fifth over the last chord and two basses the keynote under it
    for (const h of [0, 1]) {
      give(/^Solo$/, h ? ending(tune(4, 1), 72) : tune(4, 0), 0.8, LEAD_VOICE);
      sing(/^Soprano/, null, 4, h, 0.95, FULL);
      sing(/^Alto/, "Alto", 4, h, 0.85, FULL);
      sing(/^Tenor/, "Tenor", 4, h, 0.9, FULL);
      sing(/^Bass/, "Bass", 4, h, 0.85, FULL);
    }
    const END = at(4, 1) + 23;
    for (const p of c.parts) {
      sung[p.name] = sung[p.name].map((e) => (sylEnd(e) < END - NEAR ? e
        : { ...e, notes: /^Bass [14]$/.test(p.name) ? [[53, 4]] : e.notes, vib: p.name === "Solo" ? { ...LEAD_VOICE, die: 0.3 } : { ...FULL, die: 0.2 } }));
    }
    // a stanza's shape: up to its first line's top note, and down through its second
    const arch = (n, k = 1) => [[at(n) + 0.5, 1], [at(n) + 13, 1], [at(n) + 19.5, 1 + 0.15 * k], [at(n) + 22.9, 1], [at(n) + 25.5, 1 + 0.1 * k], [at(n) + 30, 1], [at(n) + 37, 1], [at(n) + 41, 1 + 0.08 * k], [at(n) + 46.5, 1 - 0.1 * k], [at(n) + 47.6, 1]];
    const parts = scored(T, cast(c), sung, {
      bpm: 80,
      close: { from: at(4) + 37, chord: at(4) + 43, slow: 0.55, hold: 8, fade: 0.4 },
      lifts: [[at(4), 1]], // a breath before the last stanza
      swells: [
        [/./, [...arch(0), ...arch(1), ...arch(2, 0.8)]],
        [/./, [[at(3) + 0.5, 1], [at(3) + 13, 1], [at(3) + 19.5, 1.12], [at(3) + 22.9, 1], [at(3) + 36, 1], [at(3) + 46, 1.15], [at(3) + 47.6, 1]]], // the fourth grows into the fifth
        [/./, [[at(4) + 13, 1], [at(4) + 19.5, 1.15], [at(4) + 23.5, 1.05], [at(4) + 25.5, 1.12], [at(4) + 31, 1], [at(4) + 36, 1]]], // "bright shining as the sun"
      ],
    });
    return {
      ...c, parts,
      source: "\"Amazing Grace\": words by John Newton (1779) with the stanza \"When we've been there ten thousand years\", anonymous and in print since the 1790s; the tune New Britain (early 19th century). All public domain. Five stanzas, in a four-part harmony written for lipservice. One woman sings the first alone, her vibrato let into the notes she holds. In the second the altos sing under her and the men hold the harmony on \"ooh\"; the sopranos join her at \"How precious did that grace appear\". The third is the men's, the tenors with the tune, and the women come in over them on \"ooh\" at \"'Tis grace hath brought me safe thus far\". \"The Lord has promised good to me\" is the choir in its four parts. After a breath everyone sings \"When we've been there ten thousand years\", slowing into the last line and its held chord. Sung here by 16 of the demo's 100 singers. Set 2 semitones lower than the demo, to where every voice here holds its top note.",
    };
  },
  "Greensleeves": (w) => {
    const T = "Greensleeves", ROUND = 96, HALF = 24; // a verse and its chorus; half of either, four bars of six
    const start = { v: (n) => 3 + ROUND * n, c: (n) => 52 + ROUND * n }, len = { v: [24, 25], c: [24, 23] }; // a verse begins on its upbeat
    // The solo is the take's third singer's voice (the first's is hard on the open vowels he holds alone), and the first's sings among the tenors.
    const c = traded(recast(w, T, { 1: "Solo", 2: "Soprano 1", 4: "Soprano 2", 5: "Soprano 3", 6: "Soprano 4", 7: "Alto 1", 8: "Alto 2", 9: "Alto 3", 3: "Tenor 1", 12: "Tenor 2", 13: "Tenor 3", 16: "Tenor 4", 10: "Bass 1", 11: "Bass 2", 14: "Bass 3", 15: "Bass 4" },
      { Solo: 5, Soprano: 1.5, Alto: 1.3, Tenor: 1.4, Bass: 1.3 }), "Solo", "Tenor 1", T);
    const { sung, give } = book(c);
    // The take's tune from its first singer, who sings it all. At the cadences the take writes the
    // note under the leading note a seventh over it, and the voice breaks up to it: kept.
    const all = squared([syllables(w.parts.find((p) => p.name === "Melody 1"), T)])[0];
    all[all.length - 1] = { ...all.at(-1), notes: [[62, 5]] }; // the last word, as long as a chorus's
    // half h of verse or chorus n, a breath after it
    const tune = (kind, n, h) => {
      const a = start[kind](n) + HALF * h, b = a + len[kind][h], evs = all.filter((e) => e.at >= a - NEAR && e.at < b - NEAR);
      if (!evs.length || Math.abs(evs[0].at - a) > NEAR || Math.abs(sylEnd(evs.at(-1)) - b) > NEAR) throw new Error(`${T}: no ${kind}${n} half ${h} in the take`);
      return [...evs.slice(0, -1), { ...evs.at(-1), notes: evs.at(-1).notes.map(([m, d], i, ns) => [m, i + 1 === ns.length ? d - GAP : d]) }];
    };
    // The harmony, written for this, over the old ground: D minor, C, D minor, A, and the chorus
    // from F. Each voice's notes under each half ([pitch, beats]; the men's sound an octave down).
    // The basses leave D for F under the verse's first bar: the tune and the ground would go
    // down together a fifth apart.
    const HARM = {
      Alto: { v: [[[62, 1], [62, 6], [64, 6], [62, 2], [57, 4], [61, 5]], [[62, 1], [62, 6], [64, 6], [57, 6], [57, 6]]],
        c: [[[69, 3], [65, 3], [64, 6], [62, 2], [57, 4], [61, 6]], [[60, 3], [65, 3], [64, 6], [57, 6], [57, 5]]] },
      Tenor: { v: [[[69, 1], [65, 3], [69, 3], [72, 3], [67, 3], [65, 6], [64, 3], [67, 2]], [[69, 1], [65, 3], [69, 3], [72, 3], [67, 3], [65, 3], [64, 3], [65, 6]]],
        c: [[[69, 3], [72, 3], [72, 3], [67, 3], [65, 6], [64, 6]], [[69, 3], [72, 3], [72, 3], [67, 3], [65, 3], [64, 3], [65, 5]]] },
      Bass: { v: [[[65, 1], [62, 3], [65, 3], [60, 6], [62, 6], [57, 5]], [[65, 1], [62, 3], [65, 3], [60, 6], [62, 3], [57, 3], [62, 6]]],
        c: [[[65, 6], [60, 6], [62, 6], [57, 6]], [[65, 6], [60, 6], [62, 3], [57, 3], [62, 5]]] },
    };
    const line = (v, kind, n, h) => laid(start[kind](n) + HALF * h, HARM[v][kind][h]);
    const sing = (who, v, kind, n, h, level, vib) => give(who, v ? under(tune(kind, n, h), line(v, kind, n, h)) : tune(kind, n, h), level, vib);
    const hum = (who, v, kind, n, level) => c.parts.filter((p) => who.test(p.name)).forEach((p, q, some) => {
      const last = line(v, kind, n, 1);
      last.at(-1).notes[0][1] -= GAP; // a breath before what comes next
      give(new RegExp(`^${p.name}$`), hummed([line(v, kind, n, 0), last], "ooh", 0.3 + 0.6 * (q + (v === "Bass" ? 0.5 : 0)) / some.length, HALF * 60 / 150), level, HUM);
    });
    for (const h of [0, 1]) {
      // 1: he is alone, and the men are under him on "ooh" at the chorus
      sing(/^Solo$/, null, "v", 0, h, 1, LEAD_VOICE);
      sing(/^Solo$/, null, "c", 0, h, 1, LEAD_VOICE);
      // 2: her answer, one soprano over the altos and basses; the women's chorus, the altos under the tune with the words
      sing(/^Soprano 1$/, null, "v", 1, h, 3.2, LEAD_VOICE);
      sing(/^Soprano 1$/, null, "c", 1, h, 1.6, TUTTI);
      sing(/^Soprano [234]$/, null, "c", 1, h, 1, TUTTI);
      sing(/^Alto/, "Alto", "c", 1, h, 0.9, TUTTI);
      // 3: the choir in four parts, and he is with the sopranos' tune, an octave under it, in the chorus
      sing(/^Soprano/, null, "v", 2, h, 0.8, TUTTI);
      sing(/^Soprano/, null, "c", 2, h, 1.05, TUTTI);
      for (const v of ["Alto", "Tenor", "Bass"]) {
        sing(new RegExp(`^${v}`), v, "v", 2, h, v === "Alto" ? 0.75 : 0.8, TUTTI);
        sing(new RegExp(`^${v}`), v, "c", 2, h, v === "Alto" ? 0.95 : 1, TUTTI);
      }
      sing(/^Solo$/, null, "c", 2, h, 0.7, LEAD_VOICE);
      // 4: he again, everyone but the sopranos under him on "ooh"; then, after a breath, everyone, the second half softer
      sing(/^Solo$/, null, "v", 3, h, 1, LEAD_VOICE);
      sing(/^Solo$/, null, "c", 3, h, h ? 0.65 : 0.75, LEAD_VOICE);
      sing(/^Soprano/, null, "c", 3, h, h ? 0.8 : 1, FULL);
      for (const v of ["Alto", "Tenor", "Bass"]) sing(new RegExp(`^${v}`), v, "c", 3, h, (v === "Alto" ? 0.9 : 0.95) * (h ? 0.8 : 1), FULL);
    }
    hum(/^Tenor/, "Tenor", "c", 0, 0.5);
    hum(/^Bass/, "Bass", "c", 0, 0.55);
    hum(/^Alto/, "Alto", "v", 1, 0.5);
    hum(/^Bass/, "Bass", "v", 1, 0.5);
    hum(/^Tenor/, "Tenor", "c", 1, 0.55);
    hum(/^Bass/, "Bass", "c", 1, 0.6);
    hum(/^Alto/, "Alto", "v", 3, 0.5);
    hum(/^Tenor/, "Tenor", "v", 3, 0.5);
    hum(/^Bass/, "Bass", "v", 3, 0.55);
    // the last chord is major, the tenors on its third
    const END = Math.max(...Object.values(sung).flat().map(sylEnd));
    for (const p of c.parts) {
      sung[p.name] = sung[p.name].map((e) => (sylEnd(e) < END - NEAR ? e
        : { ...e, notes: /^Tenor/.test(p.name) ? [...e.notes.slice(0, -1), [66, e.notes.at(-1)[1]]] : e.notes, vib: p.name === "Solo" ? { ...LEAD_VOICE, die: 0.3 } : { ...FULL, die: 0.2 } }));
    }
    const V = start.v, C = start.c;
    const verse = (n, low = 0.92) => [[V(n) + 1, 1], [V(n) + 8, 1.1], [V(n) + 13, 1], [V(n) + 20, 0.95], [V(n) + 25, 1], [V(n) + 32, 1.12], [V(n) + 37, 1], [V(n) + 44, low], [V(n) + 48.5, 1]];
    const chorus = (n) => [[C(n) - 0.4, 1], [C(n) + 0.5, 1.12], [C(n) + 6, 1.05], [C(n) + 18, 0.95], [C(n) + 23.5, 1], [C(n) + 24.5, 1.12], [C(n) + 30, 1.02], [C(n) + 36, 1], [C(n) + 44, 0.9], [C(n) + 47.5, 1]];
    const parts = scored(T, cast(c), sung, {
      bpm: 150,
      close: { from: C(3) + 36, chord: C(3) + 42, slow: 0.6, hold: 12, fade: 0.4 },
      lifts: [[C(3), 1.5]], // a breath before the last chorus
      swells: [
        [/./, [...verse(0), ...chorus(0), ...verse(1), ...chorus(1), ...verse(2), ...chorus(2), ...verse(3, 0.8)]], // "and yet thou wouldst not love me" hushed
        [/./, [[C(3) - 0.4, 1], [C(3) + 0.5, 1.12], [C(3) + 6, 1.05], [C(3) + 18, 0.95], [C(3) + 23.5, 1]]],
      ],
    });
    return {
      ...c, parts,
      source: "\"Greensleeves\", the English tune of the 1580s, with words from A Handful of Pleasant Delights (1584); public domain. Four stanzas, each with the chorus, in a four-part harmony written for lipservice over the old ground. One man sings the first stanza alone, and the men come in under his chorus on \"ooh\". A soprano answers with \"I have been ready at your hand\" over the altos and basses, and the women sing her chorus, the altos under the tune. \"If you intend thus to disdain\" is the choir in its four parts, and he joins its chorus an octave under the sopranos. He sings \"My men were clothed all in green\" over the choir's \"ooh\", hushed at \"and yet thou wouldst not love me\"; after a breath everyone sings the last chorus, its second half softer and slowing to a held major chord. At each cadence the voice breaks up a seventh from the leading note and falls back, as the demo has it. Sung here by 16 of the demo's 100 singers. Set 7 semitones lower than the demo, to where every voice here holds its top note.",
    };
  },
  "Shenandoah": (w) => {
    const T = "Shenandoah", VERSE = 68, CUT = [0, 16, 28, 42, 66]; // a verse's beats; its two calls and their answers
    const V = (n) => 2 + VERSE * n;
    const c = recast(w, T, { "": "Solo", 1: "Soprano 1", 2: "Soprano 2", 6: "Soprano 3", 7: "Soprano 4", 8: "Alto 1", 9: "Alto 2", 14: "Alto 3", 15: "Alto 4", 3: "Tenor 1", 4: "Tenor 2", 10: "Tenor 3", 5: "Bass 1", 11: "Bass 2", 12: "Bass 3", 13: "Bass 4" },
      { Solo: 3.6, Soprano: 1.3, Alto: 1.1, Tenor: 1.5, Bass: 1.2 });
    const { sung, give } = book(c);
    const all = syllables(w.parts.find((p) => p.name === "Solo"), T);
    // part k of verse n (the fourth verse is the first again), a breath after it
    const tune = (n, k) => {
      const m = n % 3, a = V(m) + CUT[k], b = V(m) + CUT[k + 1], evs = all.filter((e) => e.at >= a - NEAR && e.at < b - NEAR);
      if (!evs.length || Math.abs(evs[0].at - a) > NEAR || Math.abs(sylEnd(evs.at(-1)) - b) > NEAR) throw new Error(`${T}: no part ${k} of verse ${m} in the take`);
      return moved([...evs.slice(0, -1), { ...evs.at(-1), notes: evs.at(-1).notes.map(([m, d], i, ns) => [m, i + 1 === ns.length ? d - GAP : d]) }], VERSE * (n - m));
    };
    // The harmony, written for this: under each call and each answer an alto's, a tenor's and a
    // bass's notes ([pitch, beats]; the men's sound an octave down). In D: the basses walk down
    // from D to G under "I long to see you" and again into "seven long years"; the altos hold a
    // fourth over the A of "river" and let it down; "bound away" goes by F sharp minor.
    const HARM = {
      Alto: [[[57, 9], [59, 2], [62, 4], [57, 1]], [[59, 3], [62, 5.5], [61, 1.5], [62, 2]], [[62, 8], [64, 1], [59, 3], [61, 2]], [[62, 9], [61, 3], [59, 2], [62, 3], [61, 3], [57, 4]]],
      Tenor: [[[66, 7], [69, 2], [67, 2], [66, 5]], [[67, 5], [66, 2], [64, 3], [66, 2]], [[66, 8], [69, 1], [66, 3], [69, 2]], [[69, 5.5], [67, 0.5], [66, 3], [69, 3], [67, 2], [66, 3], [67, 3], [66, 4]]],
      Bass: [[[62, 7], [61, 1], [62, 1], [55, 2], [62, 2], [61, 1], [59, 1], [57, 1]], [[55, 5], [62, 2], [57, 3], [62, 1], [61, 1]], [[59, 5], [62, 3], [61, 1], [59, 3], [57, 2]], [[62, 5.5], [55, 0.5], [62, 3], [54, 3], [55, 2], [57, 6], [62, 4]]],
    };
    // voice v's line under part k of verse n, from `skip` beats into it
    const line = (v, n, k, skip = 0) => {
      const [[m, d], ...rest] = HARM[v][k];
      return laid(V(n) + CUT[k] + skip, [[m, d - skip], ...rest]);
    };
    const sing = (who, v, n, k, level, vib) => give(who, v ? under(tune(n, k), line(v, n, k)) : tune(n, k), level, vib);
    // on "ooh": a call in one breath, from "Shenandoah"; through the long answer each singer takes one in turn
    const hum = (who, v, n, k, level) => c.parts.filter((p) => who.test(p.name)).forEach((p, q, some) => {
      const evs = line(v, n, k, k ? 0 : 2);
      evs.at(-1).notes[0][1] -= GAP; // a breath before what comes next
      give(new RegExp(`^${p.name}$`), hummed([evs], "ooh", k === 3 ? 0.3 + 0.5 * q / some.length : 1, 10), level, HUM);
    });
    const LOW = ["Alto", "Tenor", "Bass"], of = (v) => new RegExp(`^${v}`);
    // 1: his calls alone; the men answer under him, then hum under "seven long years", and the altos come in under the last answer
    for (const k of [0, 1, 2, 3]) sing(/^Solo$/, null, 0, k, 1, LEAD_VOICE);
    for (const v of ["Tenor", "Bass"]) {
      sing(of(v), v, 0, 1, 0.5, TUTTI);
      hum(of(v), v, 0, 2, 0.33);
      sing(of(v), v, 0, 3, 0.55, TUTTI);
    }
    hum(/^Alto/, "Alto", 0, 3, 0.36);
    // 2: the choir hums under his calls and answers in its four parts, the sopranos with the tune over him
    for (const k of [0, 1, 2, 3]) sing(/^Solo$/, null, 1, k, k % 2 ? 0.8 : 1, LEAD_VOICE);
    for (const k of [0, 2]) for (const v of LOW) hum(of(v), v, 1, k, k ? 0.38 : 0.33);
    for (const k of [1, 3]) {
      sing(/^Soprano/, null, 1, k, k === 1 ? 0.7 : 0.8, TUTTI);
      for (const v of LOW) sing(of(v), v, 1, k, k === 1 ? 0.7 : 0.8, TUTTI);
    }
    // 3: the women call "I'm bound to leave you" over the men's "ooh"; he is back for the answers, and for "seven long years" under the sopranos
    sing(/^Soprano/, null, 2, 0, 0.8, TUTTI);
    sing(/^Alto/, "Alto", 2, 0, 0.75, TUTTI);
    for (const v of ["Tenor", "Bass"]) hum(of(v), v, 2, 0, 0.42);
    for (const k of [1, 3]) {
      sing(/^Solo$/, null, 2, k, 0.8, LEAD_VOICE);
      sing(/^Soprano/, null, 2, k, k === 1 ? 0.85 : 0.92, TUTTI);
      for (const v of LOW) sing(of(v), v, 2, k, k === 1 ? 0.85 : 0.92, TUTTI);
    }
    sing(/^Solo$/, null, 2, 2, 1, LEAD_VOICE);
    sing(/^Soprano/, null, 2, 2, 0.5, TUTTI);
    for (const v of LOW) hum(of(v), v, 2, 2, 0.42);
    // 4: after a breath, everyone with the words in four parts; "seven long years" hushed
    [0.95, 1, 0.75, 1].forEach((x, k) => {
      sing(/^Solo$/, null, 3, k, 0.7 * x, LEAD_VOICE);
      sing(/^Soprano/, null, 3, k, 0.95 * x, FULL);
      for (const v of LOW) sing(of(v), v, 3, k, (v === "Alto" ? 0.9 : 0.95) * x, FULL);
    });
    // the last chord: two sopranos go up to its third as the others come down to D
    const END = Math.max(...Object.values(sung).flat().map(sylEnd));
    for (const p of c.parts) {
      sung[p.name] = sung[p.name].map((e) => (sylEnd(e) < END - NEAR ? e
        : { ...e, notes: /^Soprano [12]$/.test(p.name) ? [...e.notes.slice(0, -1), [66, e.notes.at(-1)[1]]] : e.notes, vib: p.name === "Solo" ? { ...LEAD_VOICE, die: 0.3 } : { ...FULL, die: 0.2 } }));
    }
    // each call rises to its long note, each answer falls away from its first
    const arch = (n) => [[V(n) + 1, 1], [V(n) + 11, 1.12], [V(n) + 15.5, 1.05], [V(n) + 16.5, 1.1], [V(n) + 22, 1], [V(n) + 27.5, 0.92], [V(n) + 28.5, 1.06], [V(n) + 33, 1], [V(n) + 41.5, 0.92],
      [V(n) + 42.5, 1.05], [V(n) + 48, 1.15], [V(n) + 53, 1.05], [V(n) + 56, 1], [V(n) + 65, 0.88], [V(n) + 67, 1]];
    const parts = scored(T, cast(c), sung, {
      bpm: 120,
      close: { from: V(3) + 54, chord: V(3) + 62, slow: 0.55, hold: 10, fade: 0.4 },
      lifts: [[V(3), 1.5]],
      swells: [[/./, [...arch(0), ...arch(1), ...arch(2), ...arch(3).slice(0, -2), [V(3) + 62, 0.9]]]],
    });
    return {
      ...c, parts,
      source: "\"Shenandoah\", an American river and sea song of the early 19th century; tune and traditional verses public domain. Four verses in a four-part harmony written for lipservice. A man sings the first calls alone; the men answer under him, and the altos come in under \"across the wide Missouri\" on \"ooh\". In the second verse the choir hums under his calls and answers in its four parts, the sopranos with the tune over him. The women call \"I'm bound to leave you\" over the men's \"ooh\", and he is back for the answers. After a breath everyone sings the last verse, \"seven long years\" hushed, slowing through \"across the wide Missouri\" to a held chord, two sopranos on its third. Sixteen singers, the eight voices twice over.",
    };
  },
  "Drunken Sailor": (w) => {
    const T = "Drunken Sailor", LINE = 16, PART = 4 * LINE; // a line's beats; a verse's or a refrain's
    const B = (s, l = 0) => 2 + PART * s + LINE * l;
    const c = recast(w, T, { "Leader 1": "Leader 1", "Leader 2": "Leader 2", 1: "Soprano 1", 2: "Soprano 2", 5: "Soprano 3", 9: "Soprano 4", 10: "Alto 1", 11: "Alto 2", 12: "Alto 3", 14: "Alto 4", 3: "Tenor 1", 6: "Tenor 2", 7: "Tenor 3", 4: "Bass 1", 13: "Bass 2", 8: "Bass 3" },
      { Leader: 3.5, Soprano: 1.3, Alto: 1.1, Tenor: 1.4, Bass: 1.3 });
    const { sung, give } = book(c);
    const all = squared([syllables(w.parts.find((p) => p.name === "Leader 1"), T)])[0];
    const from = (b) => { // the take's line at its beat b
      const evs = all.filter((e) => e.at >= b - NEAR && e.at < b + LINE - NEAR);
      if (!evs.length || Math.abs(evs[0].at - b) > NEAR || Math.abs(sylEnd(evs.at(-1)) - b - LINE) > NEAR) throw new Error(`${T}: no line at beat ${b} of the take`);
      return moved(evs, -b);
    };
    // the take starts at its first verse's answer: the three calls before it are sung here to the last verse's notes
    const LAST_CALLS = [469, 485, 501].map(from), REFRAIN = [21, 37, 53].map(from), EARLY = from(5);
    const CALLS = [LAST_CALLS.map((evs) => underlay(evs, "what shall we do with the drunk-en sail-or", T)), [85, 101, 117].map(from), [213, 229, 245].map(from), [341, 357, 373].map(from), LAST_CALLS];
    // line l of part s: the verses are parts 0, 2, 4, 6 and 8, a refrain after each
    const tune = (s, l) => moved(l === 3 ? EARLY : s % 2 ? REFRAIN[l] : CALLS[s / 2][l], B(s, l));
    // The harmony, written for this: under each of the four lines an alto's, a tenor's and a
    // bass's notes ([pitch, beats]; the men's sound an octave down). In C dorian: C minor, B flat
    // with its third in the bass, C minor rising by F and G minor, then B flat, E flat, F, B flat
    // and home. The lower voices leap with the tune at "rises"; High is held over it.
    const HARM = {
      Alto: [[[63, 10], [55, 2], [60, 2], [63, 2]], [[62, 10], [58, 4], [62, 2]], [[63, 10], [65, 2], [62, 2], [65, 2]], [[62, 2], [63, 2], [60, 2], [58, 2], [55, 8]]],
      Tenor: [[[72, 10], [63, 2], [67, 4]], [[70, 10], [65, 4], [70, 2]], [[67, 4], [72, 8], [70, 2], [69, 2]], [[70, 4], [69, 2], [65, 2], [63, 8]]],
      Bass: [[[60, 16]], [[62, 4], [58, 10], [65, 2]], [[60, 10], [65, 2], [67, 2], [65, 2]], [[58, 2], [63, 2], [65, 2], [58, 2], [60, 8]]],
      High: [[[72, 16]], [[70, 16]], [[72, 16]]],
    };
    // the last "early in the morning": the sopranos climb to the chord's top as the leaders come down with the tune
    const LAST = { Soprano: [[70, 2], [67, 2], [65, 2], [67, 2], [72, 8]], Under: [[70, 2], [67, 2], [65, 2], [67, 10]], Alto: [[62, 2], [63, 2], [60, 2], [62, 2], [63, 8]], Tenor: [[70, 4], [69, 2], [67, 10]], Bass: HARM.Bass[3] };
    // A line to its singers: the tune, or the words on a voice's notes. At this pace a breath fits
    // only after "morning", so the calls are traded: each man breathes while the other sings.
    const sing = (who, v, s, l, level, vib, notes) => {
      const evs = v ? under(tune(s, l), laid(B(s, l), notes ?? HARM[v][l])) : tune(s, l);
      give(who, l === 3 ? [...evs.slice(0, -1), { ...evs.at(-1), notes: evs.at(-1).notes.map(([m, d], i, ns) => [m, i + 1 === ns.length ? d - GAP : d]) }] : evs, level, vib);
    };
    // the men in three parts: the tenors over the leaders' tune, the basses under
    const crew = (s, l, lead, level, vib = TUTTI) => {
      sing(/^Leader/, null, s, l, lead, vib);
      sing(/^Tenor/, "Tenor", s, l, level, vib);
      sing(/^Bass/, "Bass", s, l, level, vib);
    };
    // everyone in four parts, the sopranos with the tune an octave over the leaders
    const tutti = (s, l, lead, level, vib = TUTTI) => {
      crew(s, l, lead, level, vib);
      sing(/^Soprano/, null, s, l, level, vib);
      sing(/^Alto/, "Alto", s, l, level, vib);
    };
    const CALL = [0, 1, 2], EACH = [0, 1, 2, 3];
    // 1: two men trade the calls and the men answer as one; the refrain is theirs, in three parts
    for (const l of CALL) sing(l === 1 ? /^Leader 2$/ : /^Leader 1$/, null, 0, l, 1, LEAD_VOICE);
    sing(/^(Leader|Tenor|Bass)/, null, 0, 3, 0.6, TUTTI);
    for (const l of EACH) crew(1, l, 0.6, 0.7);
    // 2: they trade again, the tenors with the third call as it rises; the women come in with the refrain
    for (const l of CALL) sing(l === 1 ? /^Leader 1$/ : /^Leader 2$/, null, 2, l, 1, LEAD_VOICE);
    sing(/^Tenor/, "Tenor", 2, 2, 0.5, TUTTI);
    crew(2, 3, 0.6, 0.7);
    for (const l of EACH) tutti(3, l, 0.5, 0.7);
    // 3: the women call, in two parts from the second line, and the men answer
    for (const l of CALL) sing(/^Soprano/, null, 4, l, 0.75, TUTTI);
    for (const l of [1, 2]) sing(/^Alto/, "Alto", 4, l, 0.7, TUTTI);
    crew(4, 3, 0.6, 0.72);
    for (const l of EACH) tutti(5, l, 0.55, 0.78);
    // 4: low, one man, then the other, then the crew; the refrain grows line by line
    sing(/^Leader 1$/, null, 6, 0, 0.5, LEAD_VOICE);
    sing(/^Leader 2$/, null, 6, 1, 0.5, LEAD_VOICE);
    crew(6, 2, 0.5, 0.42);
    tutti(6, 3, 0.42, 0.45);
    [0.45, 0.55, 0.68, 0.82].forEach((x, l) => tutti(7, l, 0.4 + 0.05 * l, x));
    // 5: after a breath, everyone; in the refrain two sopranos hold a note over the tune
    for (const l of EACH) tutti(8, l, 0.6, 0.85, FULL);
    for (const l of CALL) {
      crew(9, l, 0.6, 0.85, FULL);
      sing(/^Alto/, "Alto", 9, l, 0.85, FULL);
      sing(/^Soprano [34]$/, null, 9, l, 0.85, FULL);
      sing(/^Soprano [12]$/, "High", 9, l, 0.8, FULL);
    }
    sing(/^Leader/, null, 9, 3, 0.6, FULL);
    for (const [who, v] of [[/^Soprano [12]$/, "Soprano"], [/^Soprano [34]$/, "Under"], [/^Alto/, "Alto"], [/^Tenor/, "Tenor"], [/^Bass/, "Bass"]]) sing(who, v, 9, 3, 0.85, FULL, LAST[v]);
    // a refrain leans into each "rises" and most into the third; a verse into its third call
    const arch = (s) => (s % 2
      ? [[B(s), 1], [B(s) + 9, 1.08], [B(s, 1), 1], [B(s, 1) + 9, 1.08], [B(s, 2), 1.02], [B(s, 2) + 15, 1.16], [B(s, 3) + 8, 1.05], [B(s, 3) + 15.5, 1]]
      : [[B(s), 1], [B(s, 2), 1], [B(s, 2) + 15, 1.1], [B(s, 3) + 15.5, 1]]);
    const parts = scored(T, cast(c), sung, {
      bpm: 240,
      close: { from: B(9, 3), chord: B(9, 3) + 12, slow: 0.5, hold: 18, fade: 0.75 },
      lifts: [[B(8), 2]],
      swells: [[/./, [...[0, 1, 2, 3, 4, 5, 6, 7, 8].flatMap(arch), ...arch(9).slice(0, -2), [B(9, 3) + 8, 1.15]]]],
    });
    return {
      ...c, parts,
      source: "\"What Shall We Do with the Drunken Sailor\", a sea shanty of the 19th century; public domain. Five verses and their refrains in a four-part harmony written for lipservice. Two men trade the calls of the first verse and the men answer \"early in the morning\" as one; the first refrain is theirs, in three parts, the tenors over the tune. The two trade again in the second verse, and the women come in with its refrain. The women call \"pull out the plug\" and the men answer. \"Shave his belly\" is sung low, by one man, then the other, then the crew, and the refrain after it grows line by line. After a breath everyone sings the last verse; in the last refrain two sopranos hold a note over the tune, and the last \"early in the morning\" slows and climbs to a held chord. Sixteen singers, the eight voices twice over.",
    };
  },
  "Ode to Joy": (w) => {
    const T = "Ode to Joy", VERSE = 68, LINE = 16; // a stanza's beats, its last note and a rest in them; one of its four lines'
    const V = (n, k = 0) => 2 + VERSE * n + LINE * k;
    const c = { ...w, parts: [["Soprano 1", "4446"], ["Soprano 2", "1088"], ["Alto 1", "6345"], ["Alto 2", "6147"], ["Tenor 1", "3752"], ["Tenor 2", "6209"], ["Bass 1", "2428"], ["Bass 2", "8088"]].map(([name, voice], seat) => ({ name, voice, gain: 1, seat })) };
    const { sung, give } = book(c);
    const TAKE = Object.fromEntries(["Soprano", "Alto", "Tenor", "Bass"].map((v) => {
      const ls = squared(lines(w, v, T));
      if (ls.length !== 4 || ls.some((evs, k) => Math.abs(evs[0].at - V(0, k)) > NEAR)) throw new Error(`${T}: ${v} has not the take's four lines`);
      return [v, ls];
    }));
    // van Dyke's second and fourth stanzas under the first's notes ("o'er" spelled as it is sung)
    const WORDS = [null, [
      "all thy works with joy sur-round thee earth and heav/-en re-flect thy rays",
      "stars and an-gels sing~2 a-round thee cen~2-ter of un-bro-ken praise",
      "field and for-est vale and moun-tain flow-er/-y mead-ow flash-ing sea",
      "chant-ing bird and flow-ing foun-tain call us to re-joice in thee",
    ], [
      "mor-tals join the might-y cho-rus which the morn-ing stars be-gan",
      "fa-ther love is reign~2-ing ore us bro~2-ther love binds man to man",
      "ev-er sing-ing march we on-ward vic-tors in the midst of strife",
      "joy-ful mu-sic lifts us sun-ward in the tri-umph song of life",
    ]];
    // voice v's line k of stanza n, with its words
    const line = (v, n, k) => moved(n ? underlay(TAKE[v][k], WORDS[n][k], T) : TAKE[v][k], VERSE * n);
    const sing = (who, v, n, k, level, vib) => give(who, line(v, n, k), level, vib);
    // The altos' "ooh" over the tenors' tune in the third line: their own line there would go in
    // fifths with a tune sung under it, so it holds its G and comes up to the F sharp late.
    const UNDER = { Mid: [null, null, laid(V(0, 2), [[64, 1], [66, 1], [67, 2], [64, 1.5], [66, 0.5], [67, 2], [64, 1], [62, 7]])] };
    // on "ooh" through lines ks, each singer's breath in its own place
    const hum = (who, v, n, ks, level) => c.parts.filter((p) => who.test(p.name)).forEach((p, q, some) => {
      const evs = hummed(ks.map((k) => moved((TAKE[v] ?? UNDER[v])[k], VERSE * n)), "ooh", 0.35 + 0.4 * q / some.length + (/^(Bass|Alto)/.test(p.name) ? 0.15 : 0), LINE * 60 / 100);
      give(new RegExp(`^${p.name}$`), evs, level, HUM);
    });
    const SATB = ["Soprano", "Alto", "Tenor", "Bass"], of = (v, which = "") => new RegExp(`^${v}${which}`);
    // 1: a quartet, as the hymn is known; "melt the clouds" lower
    [1, 1, 0.82, 1].forEach((x, k) => {
      sing(/^Soprano 1$/, "Soprano", 0, k, 1.3 * x, LEAD_VOICE);
      sing(/^Alto 1$/, "Alto", 0, k, 1.15 * x, TUTTI);
      sing(/^Tenor 1$/, "Tenor", 0, k, 1.15 * x, TUTTI);
      sing(/^Bass 1$/, "Bass", 0, k, 1.2 * x, TUTTI);
    });
    // 2: the women over the men's "ooh"; the men's "field and forest", the tune in the tenors and
    // the women's "ooh" over them, the sopranos on what the tenors had; then all eight
    for (const k of [0, 1]) {
      sing(/^Soprano/, "Soprano", 1, k, 0.95, TUTTI);
      sing(/^Alto/, "Alto", 1, k, 0.85, TUTTI);
    }
    hum(/^Tenor/, "Tenor", 1, [0, 1], 0.42);
    hum(/^Bass/, "Bass", 1, [0, 1], 0.45);
    sing(/^Tenor/, "Soprano", 1, 2, 1, TUTTI);
    sing(/^Bass/, "Bass", 1, 2, 0.9, TUTTI);
    hum(/^Soprano/, "Tenor", 1, [2], 0.36);
    hum(/^Alto/, "Mid", 1, [2], 0.4);
    for (const v of SATB) sing(of(v), v, 1, 3, 0.85, TUTTI);
    // 3: after a breath all eight; "ever singing, march we onward" as one line in octaves; in the
    // last line the second soprano goes over the tune to the chord's third
    for (const k of [0, 1]) for (const v of SATB) sing(of(v), v, 2, k, 1, FULL);
    sing(/./, "Soprano", 2, 2, 0.9, FULL);
    for (const v of SATB) sing(of(v, v === "Soprano" ? " 1" : ""), v, 2, 3, 1.05, FULL);
    const over = line("Soprano", 2, 3), TOP = [72, 71, 71];
    give(/^Soprano 2$/, over.map((e, i) => (i < over.length - 3 ? e : { ...e, notes: e.notes.map(([, d]) => [TOP[i - over.length + 3], d]) })), 1.05, FULL);
    const END = Math.max(...Object.values(sung).flat().map(sylEnd));
    for (const p of c.parts) sung[p.name] = sung[p.name].map((e) => (sylEnd(e) < END - NEAR ? e : { ...e, vib: { ...FULL, die: 0.4 } }));
    // a line rises to its fourth bar and falls to its cadence; the third climbs to its end
    const arch = (n) => [[V(n), 1], [V(n) + 4, 1.1], [V(n) + 15, 0.95], [V(n, 1), 1], [V(n, 1) + 4, 1.1], [V(n, 1) + 15, 0.95], [V(n, 2), 0.95], [V(n, 2) + 7, 1.04], [V(n, 2) + 13, 1.12], [V(n, 3), 1.05], [V(n, 3) + 4, 1.14], [V(n, 3) + 16, 1]];
    const parts = scored(T, cast(c), sung, {
      bpm: 100,
      close: { from: V(2, 3) + 8, chord: V(2, 3) + 14, slow: 0.6, hold: 8, fade: 0.6 },
      lifts: [[V(2), 1]],
      swells: [[/./, [...arch(0), ...arch(1), ...arch(2).slice(0, -1), [V(2, 3) + 14, 1.1]]]],
    });
    return {
      ...c, parts,
      source: "Melody by Beethoven (Symphony No. 9, 1824); words by Henry van Dyke (Joyful, Joyful, We Adore Thee, 1907). Both public domain. The hymn's first, second and last stanzas in the four-part harmony arranged for lipservice, in G. A quartet sings the first. In the second the women sing over the men's \"ooh\"; the men take \"field and forest\", the tune in the tenors and the women's \"ooh\" over them; and all eight sing its last line. After a breath the eight sing the last stanza, \"ever singing, march we onward\" as one line in octaves, and its last line slows to a held chord, a soprano on its third. Eight singers, the eight voices.",
    };
  },
  "Sweet and Low": (w) => {
    const T = "Sweet and Low", BPM = 171, LINE = 12, V1 = 6, V2 = V1 + 11 * LINE; // counted in eighths, twelve to a line; where each verse starts
    const L = (i, at = 0) => (i < 8 ? V1 : V2) + LINE * (i % 8) + at; // line i of the sixteen
    const COUNT = (i) => (i === 7 ? 36 : i === 15 ? 42 : LINE);
    const GAIN = { Mother: 9, Soprano: 3, Mezzo: 3, Alto: 3, Tenor: 3.5, Bass: 3.5 };
    const c = { ...w, parts: [
      ["Soprano 1", "1088"], ["Soprano 2", "6147"], ["Soprano 3", "6345"], ["Mezzo 1", "6345"], ["Mezzo 2", "1088"], ["Tenor 1", "3752"], ["Bass 1", "2428"],
      ["Mother", "4446"], ["Bass 2", "8088"], ["Tenor 2", "6209"], ["Mezzo 3", "6147"], ["Alto 1", "6147"], ["Alto 2", "4446"], ["Alto 3", "6345"],
    ].map(([name, voice], seat) => ({ name, voice, gain: GAIN[name.split(" ")[0]], seat })) };
    const { sung, give } = book(c);
    // The take's tune is written slower line by line. Here each line is counted even, its notes
    // whole eighths of its own length, and the slowing is the close's.
    const TUNE = lines(w, "Words 1", T).map((evs, i) => {
      const unit = (sylEnd(evs.at(-1)) - evs[0].at) / COUNT(i);
      let at = L(i);
      const out = evs.map((e) => {
        const x = { ...e, at, notes: e.notes.map(([m, d]) => [m, Math.round(d / unit)]) };
        at += sylBeats(x);
        return x;
      });
      if (at - L(i) !== COUNT(i) || out.some((e) => e.notes.some(([, d]) => d < 1))) throw new Error(`${T}: line ${i + 1} is not ${COUNT(i)} eighths`);
      if (i % 8 !== 7) out.at(-1).notes.at(-1)[1] -= GAP;
      return out;
    });
    if (TUNE.length !== 16) throw new Error(`${T}: the take has not sixteen lines`);
    // The take's tuning, pure over D. C is the one the chords of F and A take (9/5), Cv the tune's
    // and the chord of G's (16/9), C7 the seventh harmonic; Ev is a pure third over Cv.
    const JI = { C7: -0.3117, Cv: -0.0391, C: 0.176, D: 2, Ev: 3.824, E: 4.0391, F: 5.1564, G: 6.9804, A: 9.0196, Bb: 10.1369 };
    const notes = (text, up = 0) => text.split(" ").map((x) => {
      const m = /^([A-G][bv7]?)(\d):(\d+)$/.exec(x);
      if (!m || !(m[1] in JI)) throw new Error(`${T}: ${x} is not a note`);
      return [12 * (+m[2] + 1) + JI[m[1]] + up, +m[3]];
    });
    // the harmony, line by line, as it sounds
    const HARM = {
      Soprano: { 8: "A4:3 Bb4:3 A4:3 Bb4:3", 10: "Bb4:3 C5:3 Bb4:3 A4:3", 11: "A4:3 Bb4:2 A4:7", 13: "A4:3 D5:3 Bb4:3 C5:3" },
      Mezzo: { 2: "D4:3 F4:3 Ev4:2 D4:1 C4:3", 3: "F4:3 D4:2 C4:3 D4:4", 4: "F4:3 G4:6 D4:3", 5: "F4:3 D4:6 C4:3", 6: "D4:7 C4:2 D4:3", 7: "F4:3 G4:3 D4:6 D4:3 F4:3 D4:6 D4:12", 15: "F4:3 G4:3 D4:6 D4:3 F4:3 D4:6 D4:18" },
      Alto: {
        2: "G3:3 A3:3 Cv4:3 A3:3", 3: "D4:3 G3:2 A3:7", 4: "D4:9 A3:3", 5: "D4:3 Bb3:6 A3:3", 6: "Bb3:3 A3:9", 7: "D4:6 Bb3:6 Bb3:3 C4:3 D4:3 Bb3:3 A3:12",
        8: "F4:3 D4:3 F4:3 D4:3", 9: "A3:3 Bb3:1 C4:4 D4:4", 10: "D4:3 F4:3 Ev4:2 D4:1 C4:3", 11: "F4:3 D4:2 C4:3 A3:4", 12: "F4:3 G4:3 F4:6", 13: "D4:9 C4:3", 14: "D4:7 C4:2 A3:3", 15: "D4:6 Bb3:6 Bb3:3 C4:3 D4:3 Bb3:3 A3:18",
      },
      Tenor: { 9: "F3:8 D3:4", 10: "G3:3 F3:3 G3:3 A3:3", 11: "F3:3 G3:5 F3:4", 12: "D4:6 C4:3 D4:3", 13: "F3:3 Bb3:6 A3:3", 14: "Bb3:3 A3:2 F3:2 E3:2 F3:3", 15: "A3:3 G3:9 G3:3 F3:6 G3:3 F3:18" },
      Bass: { 9: "D3:3 Bb2:3 A2:2 G2:4", 10: "G2:3 A2:3 Cv3:3 F2:3", 11: "D3:3 G2:2 A2:3 D3:4", 12: "D3:3 G2:3 A2:3 Bb2:3", 13: "F2:3 G2:6 A2:3", 14: "G2:3 A2:6 D3:3", 15: "D3:3 G2:3 Bb2:6 Bb2:3 A2:3 Bb2:3 G2:3 D3:18" },
    };
    const part = (v, i) => {
      const ns = notes(HARM[v][i], /^(Tenor|Bass)/.test(v) ? 12 : 0);
      if (ns.reduce((a, [, d]) => a + d, 0) !== COUNT(i)) throw new Error(`${T}: ${v}'s line ${i + 1} is not ${COUNT(i)} eighths`);
      return laid(L(i), ns);
    };
    const bars = (evs) => evs.reduce((ls, e) => { const k = Math.floor((e.at - evs[0].at + NEAR) / LINE); (ls[k] ??= []).push(e); return ls; }, []);
    // line i with its words: v's own notes under the tune's syllables, or the tune
    const sing = (who, v, i, level, vib) => give(who, HARM[v]?.[i] ? under(TUNE[i], part(v, i)) : TUNE[i], level, vib);
    // v's "ooh" through lines i to j: `phases` is where each of its singers breathes, by their
    // number (a breath every other bar; none late in a chord that ends a verse). Before words it
    // ends a breath early.
    const hum = (v, i, j, level, phases, words = false) => phases.forEach((phase, q) => {
      if (phase === null) return;
      const evs = hummed(Array.from({ length: j - i + 1 }, (_, k) => bars(part(v, i + k))).flat(), "ooh", phase, LINE * 60 / BPM);
      if (words) evs.at(-1).notes.at(-1)[1] -= GAP;
      give(new RegExp(`^${v} ${q + 1}$`), evs, level, HUM);
    });
    // the moon: a falling "ooh" from the sopranos
    const SIGH = { base: 0.3, bloom: 1.2 }, CRADLE = { base: 0.5, bloom: 1.7 };
    const sigh = (at, text, level) => give(/^Soprano/, [{ at, word: "ooh", k: 0, notes: notes(text) }], level, SIGH);
    // she sings it all; "sleeps" is let down
    [0.9, 0.95, 1, 0.95, 1.1, 1.05, 0.95, 0.88, 0.95, 1, 1, 0.95, 1.1, 1.1, 0.92, 0.8].forEach((x, i) => {
      give(/^Mother$/, TUNE[i].slice(0, -1), x, CRADLE);
      give(/^Mother$/, TUNE[i].slice(-1), x, i === 7 ? { ...CRADLE, die: 0.3 } : CRADLE);
    });
    // 1: the moon, and she alone; two mezzos and two altos under her from "low, low", the third of
    // each for "over the rolling waters"; the moon again at "moon and blow" and after "sleeps"
    sigh(3, "C75:3 A4:3", 0.5);
    hum("Mezzo", 2, 7, 0.5, [0.45, 0.6]);
    hum("Alto", 2, 7, 0.5, [0.4, 0.65]);
    hum("Mezzo", 4, 5, 0.5, [null, null, 0.45]);
    hum("Alto", 4, 5, 0.5, [null, null, 0.6]);
    sigh(L(5, 6), "Cv5:3 A4:3", 0.45);
    sigh(L(7, 39), "C75:4 A4:5", 0.5);
    // 2: the women in three parts, she and the mezzos on the tune; the men's "ooh" under them from
    // "father will come to thee soon"
    [[8, 0.6, 0.7, 0.7], [9, 0.7, 0.7, 0.72], [10, 0.75, 0.8, 0.8], [11, 0.65, 0.72, 0.72]].forEach(([i, s, m, a]) => {
      sing(/^Soprano/, "Soprano", i, s, TUTTI);
      sing(/^Mezzo/, "Mezzo", i, m, TUTTI);
      sing(/^Alto/, "Alto", i, a, TUTTI);
    });
    hum("Tenor", 9, 11, 0.5, [0.55, 0.8], true);
    hum("Bass", 9, 11, 0.5, [0.65, 0.92], true);
    // everyone: "father will come to his babe in the nest", "silver sails all out of the west"
    for (const i of [12, 13]) for (const v of ["Soprano", "Mezzo", "Alto", "Tenor", "Bass"]) sing(new RegExp(`^${v}`), v, i, v === "Soprano" ? 0.92 : 1, FULL);
    // she alone over their "ooh", the moon at "moon" and in the last chord
    hum("Alto", 14, 15, 0.48, [0.4, 0.55, 0.62]);
    hum("Tenor", 14, 15, 0.48, [0.45, 0.6]);
    hum("Bass", 14, 15, 0.48, [0.42, 0.65]);
    hum("Mezzo", 15, 15, 0.45, [0.6, 0.95, 0.8]);
    sigh(L(14, 9), "C75:3 A4:3", 0.45);
    sigh(L(15, 29), "C75:4 A4:9", 0.4);
    const END = L(15, 42);
    for (const p of c.parts) sung[p.name] = sung[p.name].map((e) => (sylEnd(e) < END - NEAR ? e : { ...e, vib: { ...e.vib, die: 0.15 } }));
    const parts = scored(T, cast(c), sung, {
      bpm: BPM,
      close: { from: V2, chord: L(15, 24), slow: 0.68, hold: 24, fade: 0.3 },
      swells: [
        [/^Mother$/, [[L(1), 1], [L(1, 8), 1.1], [L(2), 1], [L(4), 1], [L(4, 4), 1.15], [L(4, 9), 1], [L(7, 24), 1], [L(7, 36), 0.7], [L(7, 37), 1]]], // to "sea", to "rolling"; "sleeps" let go
        [/^(Mezzo|Alto)/, [[L(4, -1), 1], [L(4, 3), 1.25], [L(6, -2), 1.25], [L(6, 2), 1], [L(7, 24), 1], [L(7, 36), 0.6], [L(7, 37), 1]]], // up under "over the rolling waters", away under "sleeps"
        [/./, [[L(9), 1], [L(9, 8), 1.08], [L(10), 1], [L(12), 1], [L(12, 4), 1.08], [L(13, 4), 1.15], [L(13, 12), 0.95], [L(14), 1]]], // to "soon"; to "sails"
      ],
    });
    return {
      ...c, parts,
      source: "Tennyson's \"Sweet and Low\" (The Princess, 1850; public domain), to the tune written for lipservice, in a harmony written for it, every chord tuned pure. The sopranos are the moon, a falling \"ooh\". A mother sings the first verse, alone and then over the mezzos' and altos' \"ooh\", the moon before she begins, at \"moon and blow\" and after \"sleeps\". The women sing the second verse with her in three parts; the men come in under them on \"ooh\" at \"father will come to thee soon\" and sing \"father will come to his babe in the nest\" and \"silver sails all out of the west\" with them. From \"under the silver moon\" she sings alone again over everyone's \"ooh\". The second verse slows all the way to its last \"sleep\", the moon in its last chord. Fourteen singers: the mother, nine women and four men.",
    };
  },
  "A Cradle Song": (w) => {
    const T = "A Cradle Song", BPM = 109, UNIT = 0.55, IN = 6, STANZA = 45; // counted in the take's short notes: two bars of three before the tune, fifteen to a stanza
    const COUNT = (i) => (i === 13 ? 15 : i % 2 ? 12 : 9);
    const L = (i, at = 0) => 2 + IN + STANZA * (i >> 2) + [0, 9, 21, 30][i % 4] + at; // line i of the fourteen
    const GAIN = { Soprano: 4.2, Mezzo: 3.6, Alto: 3.6, Tenor: 4, Bass: 4.5 };
    const c = { ...w, parts: [
      ["Bass 1", "2428"], ["Tenor 1", "3752"], ["Alto 1", "6147"], ["Alto 2", "6345"], ["Mezzo 1", "4446"], ["Mezzo 2", "1088"],
      ["Soprano 1", "6345"], ["Soprano 2", "1088"], ["Soprano 3", "6147"], ["Soprano 4", "4446"],
      ["Mezzo 3", "6345"], ["Mezzo 4", "6147"], ["Alto 3", "4446"], ["Alto 4", "1088"], ["Tenor 2", "6209"], ["Bass 2", "8088"],
    ].map(([name, voice], seat) => ({ name, voice, gain: GAIN[name.split(" ")[0]], seat })) };
    const { sung, give } = book(c);
    const TUNE = lines(w, "Words 1", T).map((evs, i) => {
      let at = L(i);
      const out = evs.map((e) => {
        const x = { ...e, at, notes: e.notes.map(([m, d]) => [m, Math.round(d / UNIT)]) };
        at += sylBeats(x);
        return x;
      });
      if (at - L(i) !== (i === 13 ? 12 : COUNT(i)) || out.some((e) => e.notes.some(([, d]) => d < 1))) throw new Error(`${T}: line ${i + 1} is not counted`);
      if (i === 13) out.at(-1).notes.at(-1)[1] += 3; // "smiled" through the cradle's last two bars
      else if (i % 4 !== 3) out.at(-1).notes.at(-1)[1] -= GAP;
      return out;
    });
    if (TUNE.length !== 14) throw new Error(`${T}: the take has not fourteen lines`);
    // The harmony as it sounds, line by line: "in" the two bars before the tune, "3+" the bar after
    // line 4. The cradle is a long note and a short one, three to the bar.
    const HARM = {
      Mezzo: {
        in: "F4:2 C4:1 F4:2 C4:1",
        0: "F4:2 C4:1 D4:2 C4:1 D4:2 C4:1", 1: "F4:2 E4:1 F4:2 G4:1 F4:2 D4:1 F4:2 D4:1", 2: "F4:2 C4:1 D4:2 C4:1 D4:2 C4:1", 3: "D4:2 C4:1 D4:2 E4:1 F4:2 D4:1 C4:3",
        4: "F4:3 E4:2 D4:4", 5: "D4:1 E4:1 F4:1 G4:1 A4:1 G4:1 F4:6", 6: "F4:1 G4:1 F4:1 E4:1 D4:5", 7: "D4:1 E4:1 F4:1 G4:1 F4:1 E4:1 F4:6",
        8: "A4:2 G4:1 F4:1 E4:1 D4:4", 9: "E4:1 F4:1 G4:1 A4:1 G4:1 F4:1 E4:6", 10: "A4:3 G4:1 F4:1 E4:4", 11: "F4:1 E4:1 D4:1 E4:1 F4:1 E4:1 C4:6",
        12: "A4:3 G4:1 F4:1 E4:4", 13: "F4:1 G4:1 A4:1 G4:1 F4:1 E4:1 F4:9",
      },
      Alto: {
        in: "A3:6",
        0: "A3:3 Bb3:3 A3:3", 1: "C4:3 D4:3 C4:3 Bb3:3", 2: "A3:3 Bb3:3 A3:3", 3: "A3:3 G3:3 C4:3 A3:3", "3+": "G3:2 Bb3:1",
        4: "C4:2 A3:1 C4:2 A3:1 D4:2 C4:1", 5: "A3:2 C4:1 D4:2 F4:1 D4:2 C4:1 Bb3:2 D4:1", 6: "C4:2 A3:1 C4:1 A3:2 D4:2 Bb3:1", 7: "D4:2 C4:1 D4:2 Bb3:1 A3:2 C4:1 D4:2 C4:1",
        8: "F4:3 C4:6", 9: "C4:2 E4:1 C4:1 D4:1 C4:7", 10: "C4:3 D4:1 C4:5", 11: "C4:5 Bb3:1 A3:6",
        12: "F4:3 D4:1 C4:4 D4:1", 13: "C4:1 D4:1 F4:1 D4:1 C4:2 C4:2 D4:1 C4:2 D4:1 C4:3",
      },
      Tenor: {
        4: "A3:3 Bb3:2 A3:4", 5: "A3:3 F3:6 D3:3", 6: "F3:3 Bb3:1 F3:2 D3:3", 7: "A3:3 G3:3 A3:6", "7+": "G3:2 Bb3:1",
        8: "C4:2 D4:1 C4:2 D4:1 A3:2 Bb3:1", 9: "G3:2 Bb3:1 A3:2 C4:1 Bb3:2 G3:1 Bb3:2 G3:1", 10: "F3:2 C4:1 G3:2 Bb3:1 C4:2 Bb3:1", 11: "A3:2 F3:1 C4:2 G3:1 A3:2 C4:1 A3:2 C4:1", "11+": "D4:2 C4:1",
        12: "C4:2 D4:3 Bb3:4", 13: "A3:1 G3:1 F3:3 G3:1 A3:2 Bb3:1 A3:2 Bb3:1 A3:3",
      },
      Bass: {
        "3+": "C3:3",
        4: "F3:3 C3:2 D3:4", 5: "C3:3 Bb2:3 D3:3 Bb2:3", 6: "C3:4 D3:2 Bb2:3", 7: "F3:3 Bb2:2 C3:1 F3:6", "7+": "C3:3",
        8: "F3:5 D3:4", 9: "C3:3 F3:3 C3:6", 10: "A2:3 Bb2:2 C3:4", 11: "F3:2 D3:1 C3:3 F2:6", "11+": "F2:3",
        12: "F3:3 Bb2:2 C3:4", 13: "F3:1 D3:1 A2:1 Bb2:1 C3:2 F2:9",
      },
    };
    const AT = (k) => (k === "in" ? 2 : typeof k === "string" ? L(parseInt(k), 12) : L(k)), LEN = (k) => (k === "in" ? IN : typeof k === "string" ? 3 : COUNT(k));
    const part = (v, k) => {
      if (!HARM[v][k]) throw new Error(`${T}: ${v} has no line ${k}`);
      const up = /^(Tenor|Bass)/.test(v) ? 12 : 0, ns = HARM[v][k].split(" ").map((x) => { const [n, d] = x.split(":"); return [midi(n) + up, +d]; });
      if (ns.reduce((a, [, d]) => a + d, 0) !== LEN(k)) throw new Error(`${T}: ${v}'s line ${k} is not ${LEN(k)} long`);
      return laid(AT(k), ns);
    };
    // line i with its words: v's own notes under the tune's syllables, or the tune
    const sing = (v, i, level, vib, who = new RegExp(`^${v}`)) => give(who, v === "Soprano" ? TUNE[i] : under(TUNE[i], part(v, i)), level, vib);
    // v's "ooh" through `groups`, each a line's worth (its keys run on); `phases`: where in a line each
    // of v's singers breathes, by their number, null for one who is not singing. Before words it ends a breath early.
    const hum = (v, groups, level, phases, words = false) => phases.forEach((phase, q) => {
      if (phase === null) return;
      const evs = hummed(groups.map((ks) => [ks].flat().flatMap((k) => part(v, k))), "ooh", phase, 10.5 * 60 / BPM);
      if (words) evs.at(-1).notes.at(-1)[1] -= GAP;
      give(new RegExp(`^${v} ${q + 1}$`), evs, level, HUM);
    });
    const SOFT = { base: 0.5, bloom: 1.6 }, HUSH = { base: 0.5, bloom: 1.2 };
    // 1: two sopranos, then all four, over the cradle
    for (const i of [0, 1]) sing("Soprano", i, 0.85, SOFT, /^Soprano [12]$/);
    for (const i of [2, 3]) sing("Soprano", i, 0.85, SOFT);
    hum("Mezzo", [["in", 0], 1, 2, 3], 0.45, [0.55, 0.7, null, null]);
    hum("Mezzo", [2, 3], 0.45, [null, null, 0.62, 0.75]);
    // the altos rock it on through the second stanza, the men under them from the bar before it
    hum("Alto", [["in", 0], 1, 2, [3, "3+"], 4, 5, 6, 7], 0.45, [0.5, 0.65, null, null]);
    hum("Alto", [2, [3, "3+"], 4, 5, 6, 7], 0.45, [null, null, 0.6, 0.72]);
    hum("Bass", [["3+", 4], 5, 6, [7, "7+"], 8, 9, 10, [11, "11+"]], 0.5, [0.55, 0.7], true);
    hum("Tenor", [4, 5, 6, [7, "7+"], 8, 9, 10, [11, "11+"]], 0.5, [0.6, 0.75], true);
    // 2: the mezzos with the sopranos
    for (const i of [4, 5, 6, 7]) { sing("Soprano", i, 0.92, TUTTI); sing("Mezzo", i, 0.8, TUTTI); }
    // 3: the women in three parts, the tenors rocking
    for (const i of [8, 9, 10, 11]) { sing("Soprano", i, 1, FULL); sing("Mezzo", i, 0.92, FULL); sing("Alto", i, 0.92, FULL); }
    // everyone, hushed; the cradle inside "smiled"
    for (const i of [12, 13]) for (const v of ["Soprano", "Mezzo", "Alto", "Tenor", "Bass"]) sing(v, i, v === "Soprano" ? 0.72 : 0.68, HUSH);
    const END = L(13, 15);
    for (const p of c.parts) sung[p.name] = sung[p.name].map((e) => (sylEnd(e) < END - NEAR ? e : { ...e, vib: { ...e.vib, die: 0.15 } }));
    const parts = scored(T, cast(c), sung, {
      bpm: BPM,
      close: { from: L(12), chord: L(13, 12), slow: 0.6, hold: 10, fade: 0.3 },
      swells: [
        [/^Soprano/, [[L(1), 1], [L(1, 4), 1.1], [L(1, 9), 1], [L(5), 1], [L(5, 4), 1.1], [L(5, 9), 1]]],
        [/./, [[L(9), 1], [L(9, 4), 1.06], [L(10), 1.08], [L(10, 5), 1.14], [L(11), 1.04], [L(11, 6), 1]]],
      ],
    });
    return { ...c, parts, source: "William Blake's \"A Cradle Song\" (Songs of Innocence, 1789; public domain), to the tune written for lipservice, in a harmony written for it. Under the tune a cradle rocks, a long note and a short one: the mezzos' and altos' \"ooh\" through the first stanza, the altos' through the second, where the mezzos sing with the sopranos and the men come in under them, and the tenors' through the third, which the women sing in three parts. Everyone sings \"Sleep, sleep, happy child, all creation slept and smiled\", slowing; the cradle rocks twice more inside the last word and comes to rest. Sixteen singers: twelve women and four men." };
  },
  "Lullaby, Oh, Lullaby": (w) => {
    const T = "Lullaby, Oh, Lullaby", BPM = 60;
    // the poem's refrain (R) before and between the take's lines (L), two beats' rest between
    const R0 = 2, L1 = 14, R1 = 27, L2 = 39, R2 = 51, L3 = 63, R3 = 75, L4 = 87, R4 = 101, END = 125;
    const GAIN = { Solo: 9, Soprano: 3.2, Mezzo: 3.2, Alto: 3.2, Tenor: 3.6, Bass: 4 };
    const c = { ...w, parts: [
      ["Soprano 1", "4446"], ["Soprano 2", "6147"], ["Mezzo 1", "6345"], ["Mezzo 2", "4446"], ["Alto 1", "6345"], ["Tenor 1", "3752"], ["Bass 1", "2428"],
      ["Solo", "1088"], ["Bass 2", "8088"], ["Tenor 2", "6209"], ["Alto 2", "1088"], ["Alto 3", "4446"], ["Mezzo 3", "6147"], ["Soprano 3", "6345"],
    ].map(([name, voice], seat) => ({ name, voice, gain: GAIN[name.split(" ")[0]], seat })) };
    const { sung, give } = book(c);
    const TUNE = lines(w, "Words 11", T);
    if (TUNE.length !== 5 || TUNE.some((evs, i) => Math.abs(evs[0].at - [2, 15, 27, 39, 53][i]) > NEAR)) throw new Error(`${T}: the take's five lines are not where they were`);
    [L1, L2, L3, L4, R4].forEach((at, i) => { TUNE[i] = moved(TUNE[i], at - TUNE[i][0].at); });
    // the last refrain's commas are breaths
    TUNE[4] = TUNE[4].map((e, i) => (i === 2 || i === 3 ? { ...e, notes: e.notes.map(([m, d], j) => [m, j + 1 === e.notes.length ? d - GAP : d]) } : e));
    // Every pitch is a whole multiple of one low D (D1), as the take's are: "10:2" is its tenth for
    // two beats, as it sounds. A man is written an octave over what he sounds.
    const H = (n) => +(26 + 12 * Math.log2(n)).toFixed(4);
    const notes = (v, text) => text.split(" ").map((x) => { const [n, d] = x.split(":"); return [H(/^(Tenor|Bass)/.test(v) ? 2 * n : +n), +d]; });
    const each = (v) => new RegExp(`^${v}${/\d$/.test(v) ? "$" : ""}`);
    // the refrain from beat `at`, or as much of it as v has notes for, counted from its end
    const REFRAIN = [["lullaby", 0], ["lullaby", 1], ["lullaby", 2], ["oh", 0], ["lullaby", 0], ["lullaby", 1], ["lullaby", 2]];
    const refrain = (at, v, text, level, vib) => {
      const ns = notes(v, text);
      let t = at;
      give(each(v), REFRAIN.slice(-ns.length).map(([word, k], i) => { const e = { at: t, word, k, notes: [ns[i]] }; t += ns[i][1]; return e; }), level, vib);
    };
    // line i of the tune with its words on v's own notes
    const sing = (v, i, text, level, vib) => give(each(v), under(TUNE[i], laid(TUNE[i][0].at, notes(v, text))), level, vib);
    // one singer's "ooh" through `spans` [[beat, notes]], a breath `phase` of the way through each
    const hum = (name, spans, phase, level) => give(each(name), hummed(spans.map(([at, text]) => laid(at, notes(name, text))), "ooh", phase, 10), level, HUM);
    const SOLO = { base: 0.5, bloom: 1.7 }, CHANT = { base: 0.6, bloom: 1.2 };

    // The refrain on the low note itself: the basses, the tenors a fifth over them from "oh", the
    // altos and mezzos over those from the second "lullaby", one bass an octave under.
    refrain(R0, "Bass 1", "4:1 4:1 4:2 4:2 4:1 4:1 4:2", 0.7, CHANT);
    refrain(R0, "Bass 2", "4:1 4:1 4:2 4:2 2:1 2:1 2:2", 0.7, CHANT);
    refrain(R0 + 4, "Tenor", "6:2 6:1 6:1 6:2", 0.65, CHANT);
    refrain(R0 + 6, "Alto", "8:1 8:1 8:2", 0.6, CHANT);
    refrain(R0 + 6, "Mezzo", "10:1 9:1 10:2", 0.6, CHANT);
    // She sings alone over the men's "ooh", a fifth; from "stars are up" its third and the octave under.
    hum("Bass 1", [[13, "4:13"], [26, "4:12"], [38, "4:12"], [50, "4:12"]], 0.3, 0.45);
    hum("Bass 2", [[13, "4:13"], [26, "4:12"], [38, "2:12"], [50, "2:12"]], 0.6, 0.45);
    hum("Tenor 1", [[13, "6:13"], [26, "6:12"], [38, "5:12"], [50, "5:12"]], 0.45, 0.45);
    hum("Tenor 2", [[13, "6:13"], [26, "6:12"], [38, "6:12"], [50, "6:12"]], 0.72, 0.45);
    give(/^Solo$/, TUNE[0], 0.95, SOLO);
    // the mezzos and altos answer
    refrain(R1, "Mezzo", "8:1 9:1 10:2 9:2 8:1 7:1 8:2", 0.6, CHANT);
    refrain(R1, "Alto", "6:1 7:1 8:2 7:2 6:1 6:1 6:2", 0.6, CHANT);
    // "stars are up": the mezzos under her as two horns go, the altos' "ooh" on the seventh
    give(/^Solo$/, TUNE[1], 1, SOLO);
    sing("Mezzo", 1, "12:2 10:1 12:1 10:1 8:1 6:1 8:1 6:2", 0.6, CHANT);
    [0.35, 0.55, 0.75].forEach((phase, q) => hum(`Alto ${q + 1}`, [[38, "7:12"]], phase, 0.4));
    // the women in three parts
    refrain(R2, "Soprano", "10:1 12:1 14:2 12:2 10:1 9:1 10:2", 0.7, CHANT);
    refrain(R2, "Mezzo", "8:1 10:1 12:2 10:2 8:1 7:1 8:2", 0.72, CHANT);
    refrain(R2, "Alto", "6:1 8:1 9:2 8:2 6:1 6:1 6:2", 0.72, CHANT);
    // "while the birds are": no men, an octave of "ooh" round her that is gone at "silence keeping"
    give(/^Solo$/, TUNE[2], 0.92, SOLO);
    give(/^Soprano/, held(H(12), [L3, L3 + 4 - GAP]), 0.36, HUM);
    give(/^Alto/, held(H(6), [L3, L3 + 4 - GAP]), 0.36, HUM);
    // the men alone, hushed
    refrain(R3, "Tenor 1", "7:1 6:1 7:2 6:2 5:1 6:1 5:2", 0.6, CHANT);
    refrain(R3, "Tenor 2", "5:1 5:1 5:2 4:2 4:1 4:1 4:2", 0.6, CHANT);
    refrain(R3, "Bass 1", "4:1 4:1 4:2 3:2 3:1 3:1 3:2", 0.62, CHANT);
    refrain(R3, "Bass 2", "2:1 2:1 2:2 2:2 2:1 2:1 2:2", 0.62, CHANT);
    // everyone: from "fall" each on a multiple of its own, the second to the eighth
    give(/^Solo$/, TUNE[3], 1.05, SOLO);
    give(/^Soprano/, TUNE[3], 0.65, TUTTI);
    sing("Mezzo", 3, "10:2 8:1 10:1 8:1 7:1 8:1 7:1 7:4", 0.8, TUTTI);
    sing("Alto", 3, "8:2 7:1 8:1 6:1 6:1 6:1 6:1 6:4", 0.8, TUTTI);
    sing("Tenor 1", 3, "5:2 5:1 5:1 6:1 5:1 5:1 5:1 5:4", 0.85, TUTTI);
    sing("Tenor 2", 3, "4:12", 0.85, TUTTI);
    sing("Bass 1", 3, "4:5 3:7", 0.85, TUTTI);
    sing("Bass 2", 3, "2:12", 0.85, TUTTI);
    // the take's refrain: she sings it, the sopranos with her for the first "lullaby", over everyone's "ooh"
    give(/^Solo$/, TUNE[4], 0.95, SOLO);
    give(/^Soprano/, TUNE[4].slice(0, 2), 0.5, CHANT);
    give(/^Soprano/, TUNE[4].slice(2, 3), 0.5, { ...CHANT, die: 0.3 });
    [0.3, 0.42, 0.5].forEach((phase, q) => hum(`Mezzo ${q + 1}`, [[R4 - 1, "8:4 7:3 6:5.5"], [R4 + 11.5, "6:12.5"]], phase, 0.42));
    [0.36, 0.46, 0.54].forEach((phase, q) => hum(`Alto ${q + 1}`, [[R4 - 1, "6:12.5"], [R4 + 11.5, "6:12.5"]], phase, 0.42));
    hum("Tenor 1", [[R4 - 1, "5:10 6:2.5"], [R4 + 11.5, "6:1.5 5:11"]], 0.4, 0.45);
    hum("Tenor 2", [[R4 - 1, "4:12.5"], [R4 + 11.5, "4:12.5"]], 0.5, 0.45);
    hum("Bass 1", [[R4 - 1, "3:12.5"], [R4 + 11.5, "3:12.5"]], 0.34, 0.48);
    hum("Bass 2", [[R4 - 1, "2:12.5"], [R4 + 11.5, "2:12.5"]], 0.48, 0.48);
    for (const p of c.parts) sung[p.name] = sung[p.name].map((e) => (sylEnd(e) < END - NEAR ? e : { ...e, vib: { ...e.vib, die: 0.15 } }));
    const parts = scored(T, cast(c), sung, {
      bpm: BPM,
      close: { from: R4, chord: R4 + 19, slow: 0.7, hold: 7, fade: 0.3 },
      swells: [
        [/^(Bass|Tenor|Alto|Mezzo)/, [[R0, 0.85], [R0 + 8, 1.1], [R0 + 10, 0.9], [R0 + 11, 1]]], // the note grows as it is built
        [/^Solo$/, [[L1, 1], [L1 + 4, 1.08], [L1 + 11, 0.94], [L2, 1.05], [L2 + 5, 1.08], [L2 + 10, 0.94], [L3, 1], [L3 + 4, 0.92], [L3 + 10, 0.72], [L4 - 1, 1], [R4, 1], [R4 + 9, 0.94], [R4 + 19, 0.82]]], // to "closed", to "moon"; "silence keeping" let go
        [/^(Soprano|Mezzo|Alto)/, [[R2, 1], [R2 + 3, 1.12], [R2 + 6, 1], [R2 + 10, 0.9], [R2 + 11, 1]]],
        [/^(Tenor|Bass)/, [[R2 + 7, 1], [R2 + 11, 0.4], [R2 + 12, 1]]], // the men's "ooh" away before the birds
        [/^(Soprano|Alto)/, [[L3 + 2.5, 1], [L3 + 4, 0.35], [L3 + 5, 1]]],
        [/./, [[L4, 1], [L4 + 4, 1.08], [L4 + 8, 1], [L4 + 12, 0.86], [L4 + 13, 1]]],
      ],
    });
    return {
      ...c, parts,
      source: "Christina Rossetti's \"Lullaby, oh, lullaby!\" (Sing-Song, 1872; public domain), to the tune written for lipservice, in a harmony written for it: every pitch, sung by a man or a woman, is a whole multiple of one low D, as the overtones of one voice are. The poem's refrain, which the demo keeps for the end, is sung where she wrote it. The basses chant it on one note and the choir builds up over them, a fifth, an octave, a third. A soprano sings \"Flowers are closed and lambs are sleeping\" over the men's \"ooh\"; the mezzos and altos answer with the refrain. The mezzos sing \"Stars are up, the moon is peeping\" under her as two horns would, and the women answer in three parts. At \"While the birds are\" the men are gone, and at \"silence keeping\" she sings alone. The men answer by themselves, hushed. Everyone sings \"Sleep, my baby, fall a-sleeping\", from \"fall\" each part on a multiple of its own, the second to the eighth. She sings the last refrain over everyone's \"ooh\", slowing. Fourteen singers: ten women and four men.",
    };
  },
  "The Stolen Child": (w) => {
    const T = "The Stolen Child", BAR = 2.52; // seven of the take's short notes
    const B = (k) => 2 + BAR * (k + 1); // bar k of the tune, a bar of the house before it
    const GAIN = { Faery: 2.4, Child: 5, Human: 1.4 };
    const c = { ...w, parts: w.parts.map((p) => ({ ...p, gain: GAIN[p.name.split(" ")[0]] })) };
    const { sung, give } = book(c);
    const one = (name) => new RegExp(`^${name}$`);
    // The take's device is kept note for note: each faery and the child is written at a pitch of
    // its own that falls, to a quarter tone under the humans'. OWN: each one's 25 lines as the take
    // has them (8 of the first stanza, the refrain's 4, 7, 4, and the 2 it ends on).
    const FAERIES = Array.from({ length: 8 }, (_, k) => `Faery ${k + 1}`), LOW = /^Faery [3478]$/;
    const OWN = Object.fromEntries([...FAERIES, "Child 1", "Child 2"].map((n) => [n, lines(w, n, T).map((evs) => moved(evs, BAR))]));
    for (const [n, ls] of Object.entries(OWN)) if (ls.length !== 25 || Math.abs(ls[0][0].at - B(0)) > NEAR) throw new Error(`${T}: ${n} has not the take's 25 lines`);
    // the tune's five notes over D, and the written one a sung pitch is nearest
    const FIVE = [0, 2, 5, 7, 10], tone = (i) => 12 * Math.floor(i / 5) + 2 + FIVE[i % 5];
    const near = (p) => Array.from({ length: 20 }, (_, k) => 15 + k).reduce((a, i) => (Math.abs(p - tone(i)) < Math.abs(p - tone(a)) ? i : a));
    // a line two of the five notes lower (a fourth, or a third under E), as far fallen as it is
    const lower = (evs) => evs.map((e) => ({ ...e, notes: e.notes.map(([m, d]) => { const i = near(m); return [+(tone(i - 2) + m - tone(i)).toFixed(4), d]; }) }));
    // a line at the pitch its singer ends the take on
    const settled = (n, evs) => {
      const last = OWN[n].at(-1).at(-1).notes.at(-1)[0], fall = last - tone(near(last));
      return evs.map((e) => ({ ...e, notes: e.notes.map(([m, d]) => [+(tone(near(m)) + fall).toFixed(4), d]) }));
    };
    // lines run on as one where the poem does not stop
    const joined = (ls) => ls.flatMap((evs, k) => {
      if (k + 1 === ls.length) return evs;
      const e = evs.at(-1), more = ls[k + 1][0].at - sylEnd(e);
      return [...evs.slice(0, -1), { ...e, notes: e.notes.map(([m, d], j) => [m, j + 1 === e.notes.length ? d + more : d]) }];
    });
    const phrases = (n, groups, low = false) => groups.flatMap((g) => { const evs = joined(g.map((i) => OWN[n][i])); return low ? lower(evs) : evs; });
    // Yeats's last refrain to the refrain's tune: its first two lines are the take's last two, its
    // others the refrain's ten bars on, at the pitch each singer has come to.
    const LAST = Object.fromEntries(Object.keys(OWN).map((n) => [n, [
      underlay(OWN[n][23], "for he comes the hu-man child", T),
      OWN[n][24],
      settled(n, moved(OWN[n][21], 10 * BAR)),
      underlay(settled(n, moved(OWN[n][22], 10 * BAR)), "from a world more full of weep-ing than he can un-der-stand", T),
    ]]));
    const part = (n, evs) => (LOW.test(n) ? lower(evs) : evs);

    // The house: the humans' "ooh" at the pitch everyone starts on, a chord to the bar, as they sound.
    const CHORD = { "D": [50, 57, 62, 64], "C/E": [52, 55, 60, 64], "C": [48, 55, 60, 64], "Am": [45, 52, 60, 64], "Am'": [45, 57, 60, 64], "G": [43, 55, 62, 64] };
    const HOUSE = [
      "D", "D C/E Am G C Am' D G C/E D", "C/E D G D Am' C Am' C G D", "D Am' C Am' C G D Am' D", "C/E D G D Am' C Am' C G D", "C/E D G D",
    ].join(" ").split(" ");
    // each human's line of the four, where in four bars they breathe (none within three beats of
    // starting or stopping, nor within a beat of a change of note unless on it), and the last bar
    // they sing: they fall silent one at a time, as the take's do
    const HUMANS = { "Human 1": [3, 0.3, 30], "Human 5": [0, 0.9, 31], "Human 2": [3, 0.52, 34], "Human 6": [1, 0.76, 35], "Human 3": [2, 0.62, 38], "Human 7": [1, 0.37, 38], "Human 4": [2, 0.42, 41], "Human 8": [0, 0.68, 42] };
    const LATE = GAP; // the house changes chord a hair after the bar line: it is held through a breath taken there
    const WARM = { base: 0.7, bloom: 1.1 }, COOL = { base: 0.4 };
    for (const [n, [v, phase, through]] of Object.entries(HUMANS)) {
      const bars = HOUSE.slice(0, through + 2).map((ch, k) => [B(k - 1) + LATE, (CHORD[ch] ?? (() => { throw new Error(`${T}: no chord ${ch}`); })())[v] + (v < 2 ? 12 : 0)]);
      const ls = [];
      for (let k = 0; k < bars.length; k += 2) ls.push(laid(bars[k][0], bars.slice(k, k + 2).map(([, m]) => [m, BAR])));
      give(one(n), hummed(ls, "ooh", phase, 2 * BAR), 0.5, WARM);
    }
    // 1: the child alone over the house
    [[[0, 1], 0.95], [[2, 3, 4], 1], [[5], 1.05], [[6, 7], 1]].forEach(([g, x]) => give(/^Child 1$/, phrases("Child 1", [g]), x, { base: 0.6, bloom: 1.7 }));
    // The faeries call, the men an octave under the women; from "with a faery, hand in hand" two
    // lines of them a fourth apart.
    for (const n of FAERIES) {
      give(one(n), OWN[n][8], 0.85, COOL);
      give(one(n), OWN[n][9], 0.8, COOL);
      give(one(n), part(n, OWN[n][10]), 0.72, COOL);
      give(one(n), part(n, OWN[n][11]), 0.8, COOL);
    }
    // 2: two faeries sing with the child, who is no longer quite at the house's pitch; two more
    // under them from "we seek for slumbering trout"
    [[[12, 13], 1], [[14, 15], 0.95], [[16, 17], 0.95], [[18], 1]].forEach(([g, x]) => {
      give(/^Child 1$/, phrases("Child 1", [g]), x, { base: 0.55, bloom: 1.5 });
      for (const n of ["Faery 1", "Faery 2"]) give(one(n), phrases(n, [g]), 0.55, COOL);
      if (g[0] >= 16) for (const n of ["Faery 3", "Faery 4"]) give(one(n), phrases(n, [g], true), 0.5, COOL);
    });
    // the refrain, the child among them and falling to their pitch, the house emptying
    [0.9, 0.85, 0.8, 0.88].forEach((x, k) => {
      give(/^Child 1$/, OWN["Child 1"][19 + k], 1, { base: 0.5, bloom: 1.1 + 0.1 * (3 - k) });
      give(/^Child 2$/, OWN["Child 2"][19 + k], 0.6, { base: 0.5, bloom: 1.1 });
      for (const n of FAERIES) give(one(n), part(n, OWN[n][19 + k]), x, COOL);
    });
    // "For he comes, the human child": the last human is gone by "the wild"; "with a faery, hand in
    // hand" is the child and two faeries; everyone ends it
    [0.88, 0.85, null, 0.72].forEach((x, k) => {
      give(/^Child 1$/, LAST["Child 1"][k], k === 2 ? 0.9 : 1, COOL);
      if (k === 2) { for (const n of ["Faery 3", "Faery 4"]) give(one(n), lower(LAST[n][k]), 0.9, COOL); return; }
      give(/^Child 2$/, LAST["Child 2"][k], 0.6, COOL);
      for (const n of FAERIES) give(one(n), part(n, LAST[n][k]), x, COOL);
    });
    // Breaths. Where a faery or the child goes straight on after a note of four of the tune's short
    // notes or more, the last two are the breath; where the tune leaves no room (after "lake", "rats",
    // "car", "star", "ears") the piece waits that long, the house holding.
    const SHORT = BAR / 7, BREATH = 2 * SHORT;
    for (const n of Object.keys(OWN)) {
      const evs = [...sung[n]].sort((a, b) => a.at - b.at);
      sung[n] = evs.map((e, i) => {
        const gap = evs[i + 1] ? evs[i + 1].at - sylEnd(e) : BREATH;
        if (gap > SHORT - NEAR || sylBeats(e) + gap < 4 * SHORT - NEAR) return e;
        const notes = e.notes.map((x) => [...x]);
        let cut = BREATH - gap;
        while (notes.at(-1)[1] <= cut + NEAR) cut -= notes.pop()[1];
        if (cut > NEAR) notes.at(-1)[1] -= cut;
        return { ...e, notes };
      });
    }
    const ENDS = LAST["Child 1"][3].at(-1), END = sylEnd(ENDS);
    for (const p of c.parts) sung[p.name] = sung[p.name].map((e) => (sylEnd(e) < END - NEAR ? e : { ...e, vib: { ...e.vib, die: 0.15 } }));
    const parts = scored(T, cast(c), sung, {
      bpm: 60,
      close: { from: B(45), chord: ENDS.at, slow: 0.72, hold: 5, fade: 0.3 },
      lifts: [2, 5, 23, 25, 27].map((k) => [B(k), BREATH]),
      swells: [
        [/^Child 1$/, [[B(0), 0.95], [B(1), 1.05], [B(2), 0.95], [B(3), 1.05], [B(5), 0.95], [B(6), 1.08], [B(7), 0.95], [B(9), 1.05], [B(10), 0.9], [B(11), 1]]],
        [/^Faery/, [[B(10), 1], [B(11), 1.1], [B(12), 1], [B(16), 1], [B(17), 1.1], [B(18.5), 0.85], [B(20), 1], [B(29), 1], [B(30), 1.1], [B(31), 1], [B(35), 1], [B(36), 1.1], [B(37.5), 0.88], [B(39), 1]]], // to "child", to "weeping"
        [/^Human/, [[B(-1), 0.8], [B(0), 1], [B(10), 1], [B(11), 0.9], [B(20), 0.85], [B(29), 0.8]]], // the house quieter as the faeries sing
        ...Object.entries(HUMANS).map(([n, [, , through]]) => [one(n), [[B(through + 1) - 1.6, 1], [B(through + 1), 0.25]]]), // each one's last note let go
      ],
    });
    return {
      ...c, parts,
      source: "W. B. Yeats's \"The Stolen Child\" (1889; public domain): the first stanza and the refrain, the third stanza and the refrain, and the poem's last refrain, \"For he comes, the human child\", to the tune written for lipservice (seven beats to a bar, on five notes), in an arrangement written for it. The demo's two tunings are kept as written: the faeries fall a quarter tone from the first refrain on, each on a line of their own, the humans stay where everyone began, and the child crosses from one to the other. The humans are the house: a wordless chord to the bar. The child sings the first stanza alone over it, and where the tune leaves no room for a breath the house waits. The faeries answer with \"Come away, O human child\", the men an octave under the women, in two lines a fourth apart from \"with a faery, hand in hand\". Two faeries sing the next stanza with the child, already under the house's pitch. In the refrain the child falls to theirs and the humans stop one at a time; the last is gone in the middle of the last refrain, which ends at the faeries' pitch, half a semitone under where it began. Eighteen singers: eight faeries, eight humans and two for the child.",
    };
  },
  "Sumer Is Icumen In": (w) => {
    const T = "Sumer Is Icumen In", U = 12, KEY = -3; // a line of the round is U beats; a minor third under the take, where women can sing the round an octave over the men
    const at = (t) => 2 + U * (t + 2); // line t of the first singer's tune, the ground alone for two before it
    const END = at(18) + 9, no = (what) => { throw new Error(`${T}: ${what}`); };
    const GAIN = { Round: 1, Ground: 1.1 };
    // across the stage: the round's entries from one side and the other, the ground in the middle
    const c = { ...w, parts: [
      ["Round 5", "4446"], ["Round 1", "2428"], ["Round 7", "1088"], ["Round 3", "6209"], ["Ground 1", "2428"],
      ["Ground 2", "3752"], ["Round 4", "8088"], ["Round 8", "6147"], ["Round 2", "3752"], ["Round 6", "6345"],
    ].map(([name, voice], seat) => ({ name, voice, gain: GAIN[name.split(" ")[0]], seat })) };
    const { sung, give } = book(c);
    const one = (name) => new RegExp(`^${name}$`);
    const ended = (evs) => { // a last note to the piece's end
      const e = evs.at(-1), to = END - (sylEnd(e) - e.notes.at(-1)[1]);
      return [...evs.slice(0, -1), { ...e, notes: [...e.notes.slice(0, -1), [e.notes.at(-1)[0], to]] }];
    };
    // the tune once through as each of the take's four sings it: 15 phrases from "Summer" to "now"
    const TUNE = [1, 2, 3, 4].map((k) => {
      const ls = lines(w, `Round ${k}`, T).slice(0, 15);
      if (ls.length !== 15 || Math.abs(ls[0][0].at - (3 + U * (k - 1))) > 0.1 || ls[14].at(-1).word !== "now") no(`Round ${k} is not the take's`);
      return ls.map((evs) => raised(moved(evs, -(3 + U * (k - 1))), KEY));
    });
    const ROUND = { base: 0.35, bloom: 1.1 }, LAST = { base: 0.5, bloom: 1.5 };
    // eight singers a line apart, the men then the women; each brings out "Summer is acoming in"
    for (let v = 0; v < 8; v++) TUNE[v % 4].forEach((evs, i) => {
      const line = moved(evs, at(v));
      give(one(`Round ${v + 1}`), v === 7 && i === 14 ? ended(line) : line, i === 0 ? 1 : 0.82, v === 7 && i >= 13 ? LAST : ROUND);
    });
    // the ground: its two lines, the take's two basses changing them between them every four bars
    const G1 = lines(w, "Ground 1", T), G2 = lines(w, "Ground 2", T);
    if (G1.length !== 16 || G2.length !== 16 || Math.abs(G1[0][0].at - 3) > 0.1 || Math.abs(G2[1][0].at - 15) > 0.1) no("the grounds are not the take's");
    const turn = (G, first, j, t) => [G[first + 2 * (j % 7)], G[first + 1 + 2 * (j % 7)]].map((evs) => raised(moved(evs, at(t) - (3 + U * first + 2 * U * (j % 7))), KEY));
    const A = [], B = [raised(moved(G2[0], at(-2) - 3), KEY)];
    for (let j = 0; j < 10; j++) A.push(...turn(G1, 0, j, -2 + 2 * j));
    A.push(ended(turn(G1, 0, 10, 18)[0])); // "Sing cuckoo"
    for (let j = 0; j < 10; j++) B.push(...turn(G2, 1, j, -1 + 2 * j));
    B.push(ended(B.pop()));
    for (const ls of [A, B]) if (Math.abs(sylEnd(ls.at(-1).at(-1)) - END) > NEAR) no("a ground does not end with the piece");
    give(/^Ground 1$/, A.flat(), 1);
    give(/^Ground 2$/, B.flat(), 1);
    // a man who has sung the tune through joins the ground, on the line the other bass's voice is not his own
    [["Round 1", B, 12], ["Round 2", A, 13], ["Round 3", A, 14], ["Round 4", B, 15]].forEach(([name, G, t]) => give(one(name), G.flat().filter((e) => e.at > at(t) - 0.5), 0.7, AMONG));
    // a woman who has becomes a cuckoo: its falling third, on the ground's own chord
    const call = (t, beat, last = false) => {
      const x = at(t) + beat;
      return [{ at: x, word: "cuckoo", k: 0, notes: [[72 + KEY, 1]] }, { at: x + 1, word: "cuckoo", k: 1, notes: [[69 + KEY, last ? END - (x + 1) : 1.5]] }];
    };
    give(/^Round 5$/, [...call(16, 0), ...call(16, 6), ...call(17, 0), ...call(18, 0)], 0.6, ROUND);
    give(/^Round 6$/, [...call(17, 6), ...call(18, 6, true)], 0.6, ROUND);
    give(/^Round 7$/, call(18, 6, true), 0.6, ROUND);
    for (const p of c.parts) sung[p.name] = sung[p.name].map((e) => (sylEnd(e) < END - NEAR ? e : { ...e, vib: { ...e.vib, die: 0.2 } }));
    const parts = scored(T, own(c, /^Round/), sung, {
      bpm: 112,
      close: { from: at(18), chord: at(18) + 6, slow: 0.75, hold: 6, fade: 0.3 },
      swells: [
        [/./, [[at(-2), 0.8], [at(0), 0.9], [at(7), 1.08], [at(12), 1.08], [at(16), 0.9], [at(18), 0.82]]], // to the round of eight and away
      ],
    });
    return {
      ...c, parts,
      source: "\"Sumer Is Icumen In\", the English round of the 13th century, as W. S. Rockstro set it out; public domain, in an arrangement written for lipservice, a minor third under the demo so that women can sing the round an octave over the men. Two basses sing the ground alone. Four men enter with the round, one after another, and four women after them: a round of eight. Each man who comes to the end of the tune joins the ground; each woman who does becomes a cuckoo, calling its falling third from one side and the other. The last woman ends the tune alone over them. Ten singers.",
    };
  },
  "Hey Ho, Nobody Home": (w) => {
    const T = "Hey Ho, Nobody Home", P = 10; // the tune is P beats; an entry is two after the one before
    const no = (what) => { throw new Error(`${T}: ${what}`); };
    const c = { ...w, style: { ...w.style, breath: 1 } }; // the breaths are written, and all are taken
    const { sung, give } = book(c);
    const tune = (name) => {
      const evs = lines(w, name, T)[0];
      if (evs.map((e) => e.word).join(" ") !== "hey ho no bah dee at home meat nor drinke nor muh nee have I none fill the pot Ea dee") no(`${name} is not the take's`);
      return moved(evs, -evs[0].at);
    };
    const HIGH = tune("Tenor 1"), LOW = tune("Bass 1"), HOME = 6, NONE = 15;
    // the tune from beat `at`, a breath at its commas where `how` has them: after "home" (h), after "none" (n)
    const SUNG = 0.4;
    const pass = (line, at, how) => moved(line.map((e, i) => ((i === HOME && how.includes("h")) || (i === NONE && how.includes("n")) ? { ...e, notes: [[e.notes[0][0], SUNG]] } : e)), at);
    // each group's first beat and last: in at the tune's start, a tune and two beats after the group before; out at its end
    const GROUPS = [["Tenor", HIGH, 12, 82], ["Alto", LOW, 14, 84], ["Bass", LOW, 26, 86], ["Soprano", HIGH, 38, 78], ["Baritone", LOW, 50, 80]];
    for (const [kind, line, from, to] of GROUPS) for (let n = 1; n <= 3; n++) for (let i = 0; from + P * i < to; i++) {
      const how = n === 1 ? "h" : n === 2 ? "n" : i % 2 ? "h" : "n"; // no two of a group breathe at one comma twice running
      give(new RegExp(`^${kind} ${n}$`), pass(line, from + P * i, how), i === 0 && kind !== "Tenor" ? 1 : 0.85, kind === "Tenor" && n === 1 ? AMONG : undefined);
    }
    // one tenor alone before them, and after: the tune's end, and as far as "nobody at home"
    const SOLO = FOLK, ALONE = 86, LAST = 92, END = LAST + 4;
    give(/^Tenor 1$/, pass(HIGH, 2, "hn"), 1.3, SOLO);
    pass(HIGH, 82, "hn").forEach((e) => give(/^Tenor 1$/, [e], e.at < ALONE - NEAR ? 0.85 : 1.25, SOLO));
    give(/^Tenor 1$/, pass(HIGH, LAST, "").slice(0, HOME + 1).map((e, i) => (i === HOME ? { ...e, vib: { ...SOLO, die: 0.2 } } : { ...e, vib: SOLO })), 1.15);
    if (Math.abs(sylEnd(sung["Tenor 1"].at(-1)) - END) > NEAR) no("the last \"home\" does not end the piece");
    const parts = scored(T, own(c, /^Tenor 1$/), sung, {
      bpm: 63,
      close: { from: LAST, chord: END - 1, slow: 0.7, hold: 3.5, fade: 0.25 },
      lifts: [[LAST, 1]], // a breath before he asks again
      swells: [[/./, [[2, 1], [12, 0.9], [50, 1], [60, 1.12], [76, 1.12], [86, 0.95], [LAST, 0.85]]]],
    });
    return {
      ...c, parts,
      source: "\"Hey Ho, Nobody at Home\", round 85 of Thomas Ravenscroft's Pammelia (1609); public domain, in an arrangement written for lipservice. One tenor sings the round through alone. The others come in a group at a time, each two beats behind the last and a whole tune later: the tenors with him, the altos, the basses, the sopranos, the baritones, until all five entries sound. Then a group at a time they stop at the tune's end, and he is alone again and gets as far as \"nobody at home\". The singers breathe at the tune's commas, no group all at one. Fifteen singers at one tempo, where the demo's each keep their own.",
    };
  },
  "Ah, Poor Bird": (w) => {
    const T = "Ah, Poor Bird", P = 16; // the tune is P beats
    const no = (what) => { throw new Error(`${T}: ${what}`); };
    const c = { ...w, style: { ...w.style, breath: 1 } }; // the breaths are written, and all are taken
    const { sung, give } = book(c);
    const BIRD = 2, WHERE = 6, FREE = 17, C = 60;
    // the tune from beat 0, a breath after "bird" and after "free"
    const TUNE = (() => {
      const evs = lines(w, "Alto 1", T)[0];
      if (evs.map((e) => e.word).join(" ") !== "thou poor bird mournst the tree where sweetly sweetly thou dihdst warble warble in thy wandrings wandrings free") no("Alto 1 is not the take's");
      if (evs[0].notes[0][0] !== C || evs[FREE].notes[0][0] !== C) no("the tune is not on C");
      return moved(evs, -evs[0].at).map((e, i) => (i === BIRD || i === FREE ? { ...e, notes: [[e.notes[0][0], 2 - GAP]] } : e));
    })();
    if (Math.abs(sylEnd(TUNE[FREE]) - (P - GAP)) > NEAR || Math.abs(TUNE[WHERE].at - 7) > NEAR) no("the tune is not the take's length");
    // the tune from beat `at`, its "free" held until `until`
    const pass = (at, until) => moved(TUNE, at).map((e, i) => (i === FREE && until ? { ...e, notes: [[C, until - e.at]] } : e));
    // one alto alone
    give(/^Alto 1$/, pass(2), 1.25, FOLK);
    // the round: the women four beats apart, the men between them. Each singer's first beat, tunes sung,
    // the beat "free" is held to, and where the same note is taken again after a breath: from, to
    const STOP = 91, CHORD = 92, END = CHORD + 2;
    const ROUND = [
      ["Soprano 1", 18, 4, 87, 88, END], ["Alto 2", 22, 4, STOP], ["Soprano 2", 26, 4, STOP], ["Alto 1", 30, 4, END],
      ["Bass 2", 48, 2, 84, 85, STOP], ["Tenor 1", 52, 2, 89, 90, END], ["Bass 1", 56, 2, 90, 91, END], ["Tenor 2", 60, 2, END],
    ];
    const SETTLED = 0.55; // a singer who has stopped on "free", against one still singing
    const swells = [[/./, [[2, 1], [18, 0.85], [30, 0.9], [48, 0.95], [60, 1.1], [78, 1.1], [86, 0.95], [CHORD, 0.9]]]];
    for (const [name, from, n, until, again, to] of ROUND) {
      const who = new RegExp(`^${name}$`), last = from + P * (n - 1);
      for (let i = 0; i < n - 1; i++) give(who, pass(from + P * i), i ? 0.85 : 1, name === "Alto 1" ? AMONG : undefined);
      if (name === "Alto 1") {
        // she ends it as she began it
        const evs = pass(last, until);
        give(who, evs.slice(0, WHERE), 0.9, AMONG);
        give(who, evs.slice(WHERE, FREE), 1.2, FOLK);
        give(who, [evs[FREE]], 1.15, { ...FOLK, die: 0.2 });
        continue;
      }
      give(who, pass(last, until), 0.85);
      if (again) give(who, held(C, [again, to]), 0.85);
      if (until < END) swells.push([who, [[last + P, 1], [last + P + 2, SETTLED]]]);
    }
    // three breathe under her "wanderings" and meet her "free" with what makes the C a major chord
    const E = C + 4 - 0.1369; // a pure third over C
    for (const [name, pitch] of [["Bass 2", C - 12], ["Soprano 2", E], ["Alto 2", C + 7]])
      give(new RegExp(`^${name}$`), laid(CHORD, [[pitch, END - CHORD]]), 1.25);
    const parts = scored(T, own(c, /^Alto 1$/), sung, {
      bpm: 66,
      close: { from: 88, chord: CHORD, slow: 0.72, hold: 4.5, fade: 0.3 },
      lifts: [[2 + TUNE[WHERE].at, 0.6]], // alone, she breathes at the comma
      swells,
    });
    return {
      ...c, parts,
      source: "\"Ah, Poor Bird\", an English round, the words of 1867; public domain, in an arrangement written for lipservice. One alto sings it through alone. The women make a round of four, four beats apart, and the men come in between them, until eight sing two beats apart as in the demo. Then each singer who reaches \"free\" stays on its note, and the round settles, voice by voice, onto one C. The alto who began sings the last line over it, and at her \"free\" three of them add the low octave, the third and the fifth: a major chord. Eight singers at one tempo, where the demo's each keep their own. Set 2 semitones lower than the demo.",
    };
  },
  "Row, Row, Row Your Boat": (w) => {
    const T = "Row, Row, Row Your Boat", U = 6, at = (k) => 6 + U * k; // a bar is U beats; bar k's first beat
    const no = (what) => { throw new Error(`${T}: ${what}`); };
    const c = { ...w, style: { ...w.style, breath: 1 } }; // every breath the tune leaves room for is taken
    const { sung, give } = book(c);
    // the tune's two halves, four bars each, from beat 0
    const [A, B] = (() => {
      const ls = lines(w, "Entry 1, high", T), words = (l) => l.map((e) => e.word).join(" ");
      if (words(ls[0]) !== "row row row your boat gently gently down the stream") no("Entry 1 does not row as the take does");
      if (words(ls[1]) !== "merrily merrily merrily merrily merrily merrily merrily merrily merrily merrily merrily merrily life is but a dream") no("Entry 1 does not dream as the take does");
      return [ls[0], ls[1]].map((l) => moved(l, -l[0].at));
    })();
    for (const l of [A, B]) if (Math.abs(sylEnd(l.at(-1)) - (4 * U - GAP)) > NEAR) no("a half of the tune is not four bars");
    // a line with its words left out: one breath of "ooh", a note sung again run into the one before
    const hum = (line) => {
      const notes = [];
      for (const [m, d] of line.flatMap((e) => e.notes)) if (notes.at(-1)?.[0] === m) notes.at(-1)[1] += d; else notes.push([m, d]);
      return [{ at: line[0].at, word: "ooh", k: 0, notes }];
    };
    // the second half with "life is but a" at half the speed and "dream" a whole bar
    const LIFE = B.findIndex((e) => e.word === "life");
    const DREAMT = (() => {
      let t = B[LIFE].at;
      return [...B.slice(0, LIFE), ...B.slice(LIFE).map((e, i, all) => { const d = i + 1 < all.length ? 2 * e.notes[0][1] : U, y = { ...e, at: t, notes: [[e.notes[0][0], d]] }; t += d; return y; })];
    })();
    const ROW = { base: 0.5, bloom: 1.2 }, LAST = { base: 0.6, bloom: 1.6 }, HAZE = { base: 0.3 };
    // all eight set off together
    give(/./, [...moved(A, at(0)), ...moved(B, at(4))], 1, TUTTI);
    // the round: a pair two bars after the pair before, three times through, the men humming the third
    const END = at(39);
    for (let p = 0; p < 4; p++) for (let j = 0; j < 3; j++) {
      const her = new RegExp(`^Entry ${p + 1}, high$`), him = new RegExp(`^Entry ${p + 1}, low$`), bar = 8 + 2 * p + 8 * j, last = p === 3 && j === 2;
      const a = moved(A, at(bar)), b = moved(last ? DREAMT : B, at(bar + 4));
      if (j < 2) give(him, [...a, ...b], j ? 0.85 : 0.95, ROW); else give(him, [...hum(a), ...hum(b)], 0.6, HUM);
      if (!last) { give(her, [...a, ...b], j ? 0.9 : 1, ROW); continue; }
      give(her, [...a, ...b.slice(0, LIFE)], 0.9, ROW);
      give(her, b.slice(LIFE, -1), 1.1, LAST);
      give(her, b.slice(-1), 1.1, { ...LAST, die: 0.2 });
      if (Math.abs(sylEnd(b.at(-1)) - END) > NEAR) no("the last \"dream\" does not end the piece");
    }
    // under the last line the others gather, one at a time, into fifths stacked on C: C G D A E
    for (const [name, bar, pitch] of [["Entry 1, low", 36, 48], ["Entry 2, low", 36.5, 55], ["Entry 1, high", 37, 62], ["Entry 3, low", 37.5, 67], ["Entry 2, high", 38, 64], ["Entry 3, high", 38, 69]])
      give(new RegExp(`^${name}$`), laid(at(bar), [[pitch, END - at(bar)]]), 0.55, HAZE);
    const parts = scored(T, cast(c), sung, {
      bpm: 264,
      close: { from: at(36), chord: at(38), slow: 0.62, hold: 20, fade: 0.2 },
      swells: [[/./, [[at(0), 1.1], [at(7), 1.1], [at(8), 0.8], [at(14), 1], [at(22), 1], [at(34), 0.62], [at(38), 0.6]]]],
    });
    return {
      ...c, parts,
      source: "Traditional round (tune published 1881, words 1852), public domain, in an arrangement written for lipservice. All eight set off together and sing it once through, a woman and a man an octave below in each pair. Then the round: the four pairs two bars apart, three times through, growing quieter. The third time the men leave the words and hum. The last woman sings \"life is but a dream\" at half the speed, and under her the others gather, one at a time, into a chord of fifths stacked on the keynote. Eight voices.",
    };
  },
  "Frere Jacques": (w) => {
    const T = "Frere Jacques", N = 1.5; // the night is sung N times as slow
    const no = (what) => { throw new Error(`${T}: ${what}`); };
    const c = { ...w, style: { ...w.style, breath: 1 } }; // the breaths are written, and all are taken
    const { sung, give } = book(c);
    const who = (name) => new RegExp(`^Entry ${name}$`);
    // the tune from beat 0: four lines of eight beats
    const TUNE = (() => {
      const evs = lines(w, "Entry 1a", T)[0].slice(0, 32);
      if (evs.map((e) => e.word).join(" ") !== "are you sleep ing are you sleep ing broth er john broth er john morn ing bells are ring ing morn ing bells are ring ing ding ding dong ding ding dong") no("Entry 1a is not the take's");
      return moved(evs, -evs[0].at);
    })();
    if (Math.abs(sylEnd(TUNE[31]) - 32) > NEAR || TUNE[14].at !== 16 || TUNE[26].at !== 24) no("the tune is not four lines of eight beats");
    const JOHN = 10, JOHN2 = 13, DONG = 28, DONG2 = 31;
    // the tune from beat `at`, a breath after each note of `where`
    const tune = (at, where) => moved(TUNE.map((e, i) => (where.includes(i) ? { ...e, notes: [[e.notes[0][0], e.notes[0][1] - GAP]] } : e)), at);
    const NIGHT = { base: 0.5, bloom: 1.4 }, BELL = { base: 0.3 }, SUNG = { base: 0.5, bloom: 1.2 };
    // night: nine slow bars in the minor. Two basses toll a fourth, breathing in turn
    const nb = (k) => 2 + 4 * N * k, DAWN = nb(9), bar = (k) => DAWN + 4 * k;
    const toll = (odd) => Array.from({ length: 9 }, (_, k) => [
      { at: nb(k), word: "ding", k: 0, notes: [[60, 2 * N]] },
      { at: nb(k) + 2 * N, word: "dong", k: 0, notes: [[55, 2 * N - (k < 8 && k % 2 === odd ? GAP : 0)]] },
    ]).flat();
    give(who("2b"), toll(1), 0.6, BELL);
    give(who("5b"), toll(0), 0.6, BELL);
    // over them a bass, a tenor and an alto ask in turn, two bars apart, and the alto is left alone
    const ASKED = TUNE.slice(0, JOHN2 + 1).map((e, i) => ({ ...e, at: e.at * N, notes: [[e.notes[0][0] === 64 ? 63 : e.notes[0][0], e.notes[0][1] * N - (i === JOHN ? GAP : 0)]] }));
    [["1a", 1], ["3a", 3], ["2a", 5]].forEach(([name, k]) => give(who(name), moved(ASKED, nb(k)), 1, NIGHT));
    // morning: the sopranos answer in the major and at speed, and the men ring
    give(/^Entry (3b|7b|4a|8b)$/, moved(TUNE.slice(14, 26), bar(0) - 16), 1, TUTTI);
    give(/^Entry (1a|2b|3a|5a|5b|6a|7a|8a)$/, moved(tune(0, [DONG2]).slice(26), bar(2) - 24), 0.9, TUTTI);
    // the round: four groups of four, two bars apart, half of each group breathing a bar before the other half
    const round = (k) => bar(4 + k), BELLS = round(24), END = round(26);
    // two sopranos leave it to ring rounds: eight bells down the scale, in these bars
    const PEAL = { "3b": [12, 14, 16, 18], "4a": [15, 17, 19] };
    const rung = (k) => [72, 71, 69, 67, 65, 64, 62, 60].map((m, i) => ({ at: round(k) + i / 2, word: i % 2 ? "dong" : "ding", k: 0, notes: [[m, 0.5]] }));
    [["1a", "1b", "5a", "5b"], ["2a", "2b", "6a", "6b"], ["3a", "3b", "7a", "7b"], ["4a", "4b", "8a", "8b"]].forEach((names, g) => names.forEach((name, i) => {
      const where = PEAL[name] || i % 2 === 0 ? [JOHN2, DONG2] : [JOHN, DONG];
      for (let n = 0; 2 * g + 8 * n < 24; n++) {
        if (PEAL[name] && n === 1) { PEAL[name].forEach((k) => give(who(name), rung(k), 1, BELL)); continue; }
        give(who(name), tune(round(2 * g + 8 * n), where).filter((e) => e.at < BELLS - NEAR), n ? 0.9 : 1, SUNG);
      }
    }));
    // all sixteen on the bells, and the last "dong" a chord. The groups longest since a breath take one between the two
    const CHORD = { "1a": 48, "5b": 60, "2b": 60, "6a": 60, "5a": 60, "3a": 67, "7a": 67, "8a": 67, "1b": 60, "4b": 60, "2a": 64, "6b": 64, "7b": 64, "3b": 67, "8b": 67, "4a": 72 };
    if (Object.keys(CHORD).length !== c.parts.length) no("the last chord is not all sixteen");
    for (const [name, m] of Object.entries(CHORD)) {
      const bells = moved(tune(0, /^[2468]/.test(name) ? [DONG] : []).slice(26), BELLS - 24);
      give(who(name), [...bells.slice(0, -1), { ...bells.at(-1), notes: [[m, 2]] }], 1.05, TUTTI);
    }
    const parts = scored(T, cast(c), sung, {
      bpm: 110,
      close: { from: BELLS, chord: END - 2, slow: 0.85, hold: 7, fade: 0.5 },
      swells: [[/./, [[2, 0.7], [DAWN - 0.5, 0.7], [DAWN, 1.1], [round(0), 0.95], [round(6), 1], [round(12), 1.1], [round(22), 1.1], [BELLS, 1.2]]]],
    });
    return {
      ...c, parts,
      source: "\"Frere Jacques\", the French round of the 18th century, in its English words; public domain, in an arrangement written for lipservice. Night: two basses toll a fourth, and over them a bass, a tenor and an alto ask in turn, in the minor and half as slow again, \"Are you sleeping, Brother John?\" (the tune in the minor over a tolling fourth is how Mahler used it in his first symphony). Morning: the sopranos answer in the major and at speed, the men ring \"ding, ding, dong\", and the round begins, four groups of four, two bars apart. Two sopranos leave it to ring rounds over the rest, eight bells down the scale. All sixteen end on the bells together. Sung by 16 of the demo's 100 singers.",
    };
  },
  "Twinkle, Twinkle": (w) => {
    const T = "Twinkle, Twinkle", P = 48, at = (k) => 2 + P * k, END = at(6); // the tune is P beats at full speed, and is sung six times
    const no = (what) => { throw new Error(`${T}: ${what}`); };
    const c = { ...w, style: { ...w.style, breath: 1 } }; // the breaths are written, and all are taken
    const { sung, give } = book(c);
    // the tune's six lines, each seven notes from its own beat 0
    const LINES = lines(w, "Full speed 1", T).slice(0, 6).map((l) => moved(l, -l[0].at).map((e, j) => ({ ...e, notes: [[e.notes[0][0], j < 6 ? 1 : 2]] })));
    if (LINES.map((l) => l.map((e) => e.word).join(" ")).join(", ") !== "twinkle twinkle twinkle twinkle little little star, how I wonder wonder what you are, up above above the world so high, like a diamond diamond in the sky, twinkle twinkle twinkle twinkle little little star, how I wonder wonder what you are") no("Full speed 1 is not the take's");
    if (LINES.some((l) => l.some((e, j) => e.notes.length !== 1 || Math.abs(e.at - j) > NEAR))) no("a line is not seven notes on the beat");
    // lines `from` to `to` of the tune begun at beat `t` and sung `slow` times as slow, a breath after the notes where(line) names:
    // never inside a word, and never after the piece's last note
    const sing = (t, slow, where, from = 0, to = 6) => LINES.slice(from, to).flatMap((line, i) => {
      const l = from + i, b = where(l);
      return line.map((e, j) => {
        const last = l === 5 && j === 6 && Math.abs(t + P * slow - END) < NEAR;
        if (b.includes(j) && line[j + 1]?.k > 0) no(`a breath inside ${e.word}`);
        return { ...e, at: t + (8 * l + j) * slow, notes: [[e.notes[0][0], e.notes[0][1] * slow - (b.includes(j) && !last ? GAP : 0)]] };
      });
    });
    const one = (name) => new RegExp(`^${name}$`), none = () => [];
    const MID = (l) => (l === 2 ? 2 : 3); // where a line's sense divides
    const ENDS = () => [6], MIDS = (l) => [MID(l)], ON = (l) => [MID(l), 6], OFF = (l) => (l % 4 === 0 ? [1, 5] : l === 2 ? [0, 4] : [1, 4]); // within a line
    const EVEN = (l) => (l % 2 ? [] : [6]), ODD = (l) => (l % 2 ? [6] : []); // a breath every other line
    // one woman alone, and under her two men at a sixth of her speed; their women with them from the second line
    const CHILD = { base: 0.4, bloom: 1.3 }, FAST = { base: 0.5, bloom: 1.1 }, SLOW = { base: 0.4, bloom: 1.2, wait: 0.5 }, DEEP = { base: 0.4, bloom: 1, wait: 0.8, rise: 1.5 };
    give(one("Full speed 2"), sing(at(0), 1, (l) => (l === 5 ? [] : l === 4 ? [6] : ODD(l))), 1.1, CHILD); // and on into the second time without a break
    give(one("Sixth speed 1"), sing(at(0), 6, OFF), 0.65, DEEP);
    give(one("Sixth speed 3"), sing(at(0), 6, ON), 0.65, DEEP);
    give(one("Sixth speed 2"), sing(at(0), 6, ON, 1, 5), 0.5, DEEP);
    give(one("Sixth speed 4"), sing(at(0), 6, OFF, 1, 5), 0.5, DEEP);
    // her group with her from the second time through
    for (let k = 1; k < 6; k++) [["Full speed 1", EVEN], ["Full speed 2", ODD], ["Full speed 3", EVEN], ["Full speed 4", ODD]].forEach(([name, where]) => give(one(name), sing(at(k), 1, where), 0.9, FAST));
    // the half speed from the third, the third speed from the fourth: each from the top of the tune
    for (const k of [2, 4]) [["Half speed 1", ENDS], ["Half speed 2", ENDS], ["Half speed 3", MIDS], ["Half speed 4", MIDS]].forEach(([name, where]) => give(one(name), sing(at(k), 2, where), 0.85, FAST));
    [["Third speed 1", ENDS], ["Third speed 2", MIDS], ["Third speed 3", ENDS], ["Third speed 4", MIDS]].forEach(([name, where]) => give(one(name), sing(at(3), 3, where), 0.8, SLOW));
    // the last time through, the two sopranos leave the slowest and sing it twice at twice the speed, a couplet each in turn
    const QUICK = { base: 0.3 }, twice = (n, from) => sing(at(5) + n * P / 2, 0.5, none, from, from + 2);
    give(one("Sixth speed 2"), [...twice(0, 0), ...twice(0, 4), ...twice(1, 2), ...twice(1, 4)], 0.8, QUICK);
    give(one("Sixth speed 4"), [...twice(0, 2), ...twice(1, 0), ...twice(1, 4)], 0.8, QUICK);
    for (const [name, evs] of Object.entries(sung)) if (Math.abs(Math.max(...evs.map(sylEnd)) - END) > NEAR) no(`${name} does not end with the others`);
    const parts = scored(T, cast(c), sung, {
      bpm: 120,
      close: { from: END - 8, chord: END - 1, slow: 0.8, hold: 10, fade: 0.3 },
      swells: [[/./, [[at(0), 0.8], [at(1), 0.85], [at(2), 0.95], [at(3), 1], [at(4), 1.05], [at(5), 1.15], [END - 8, 1.15], [END, 1]]]],
    });
    return {
      ...c, parts,
      source: "\"Twinkle, Twinkle, Little Star\": the French tune of 1761 with Jane Taylor's verse of 1806; public domain, in an arrangement written for lipservice. A canon in proportion: the tune at five speeds, all ending together. One woman sings it alone, and under her two men begin it at a sixth of her speed, a line of theirs to a whole tune of hers. Her group joins her the second time through, the half speed the third, the third speed the fourth, each from the top of the tune. The last time two sopranos sing it twice at twice the speed, a couplet each in turn. The breaths are written, half of each group taking theirs where the other half sings on, and never inside a word. Sung by 16 of the demo's 160 singers.",
    };
  },
  "Canon in D": (w) => {
    const T = "Canon in D", U = 8, at = (k) => 2 + U * k, CHORD = at(13); // the ground is U beats, and is sung thirteen times
    const no = (what) => { throw new Error(`${T}: ${what}`); };
    const c = { ...w, style: { ...w.style, breath: 1 } }; // the breaths are written, and all are taken
    const { sung, give } = book(c);
    const one = (name) => new RegExp(`^${name}$`);
    const SYL = { 0: "do", 2: "re", 4: "mi", 5: "fa", 7: "sol", 9: "la", 11: "ti" }; // by semitones above D
    const said = (p) => SYL[((Math.round(p) - 62) % 12 + 12) % 12] ?? no(`${p} is not in the scale`);
    const written = (notes) => laid(0, notes).map((e) => ({ ...e, word: said(e.notes[0][0]) }));
    const taken = (name, i, text) => {
      const evs = lines(w, name, T)[0].slice(i, i + U), t = evs[0].at;
      if (evs.map((e) => e.word).join(" ") !== text || evs.some((e, j) => e.notes.length !== 1 || e.word !== said(e.notes[0][0]) || Math.abs(e.at - t - j) > NEAR)) no(`${name} is not the take's`);
      return moved(evs, -t).map((e) => ({ ...e, notes: [[e.notes[0][0], 1]] }));
    };
    const GROUND = taken("Ground 1", 0, "do sol la mi fa do fa sol");
    // the canon's first four phrases: the two the take sings, and the next two, which move twice as fast.
    // The third is at Pachelbel's pitch, the others an octave under it
    const P1 = taken("Line 1", 0, "mi re do ti la sol la ti"), P2 = taken("Line 1", U, "do ti la sol fa mi fa re");
    const P3 = written([62, 66, 69, 67, 66, 62, 66, 64, 62, 59, 62, 69, 67, 71, 69, 67].map((m) => [m, 0.5]));
    const P4 = written([...[54, 50, 52, 61, 62, 66, 69, 57, 59, 55, 57, 54, 50, 62].map((m) => [m, 0.5]), [62, 0.75], [61, 0.25]]);
    // a breath is taken out of a note: that note sung short, and the one after it left out where it shares the beat.
    // END breathes after the first three phrases and in the middle of the fourth, so that the fourth runs on into the first;
    // MIDDLE breathes where END sings on
    const SHORT = 0.4, END = [[7], [7], [14, 15], [6, 7]], MIDDLE = [[3], [3], [6, 7], [14, 15]];
    const breathed = (evs, [i, out]) => evs.flatMap((e, j) => (j === out ? [] : j === i ? [{ ...e, notes: [[e.notes[0][0], SHORT]] }] : [e]));
    // phrases i to j of the canon, the first of them at ground k; the second an octave up for those who sing it high
    const QUARTERS = { base: 0.5, bloom: 1.1 }, ALONE = { base: 0.6, bloom: 1.5 }, EIGHTHS = { base: 0.3 }, STILL = { base: 0.3 };
    const canon = (name, k, plan, level, { i = 0, j = 4, high = false, alone = false } = {}) => [P1, high ? raised(P2, 12) : P2, P3, P4].slice(i, j).forEach((ph, n) =>
      give(one(name), moved(breathed(ph, plan[i + n]), at(k + n)), level, i + n > 1 ? EIGHTHS : alone ? ALONE : QUARTERS));
    const MI = 66 - 0.1369; // a pure third over D
    // a slow line of its own, held, from its note `from` to the last chord: written for this arrangement.
    // Each singer breathes at a note of their own, and none before the chord
    const SLOW = [69, 66, 62, 64];
    const slow = (name, from, turn, level, last) => {
      const evs = [];
      for (let i = from; i < 4 * 13; i++) {
        if (i === from || i % 4 === turn) evs.push({ at: at(0) + 2 * i, word: "ooh", k: 0, notes: [] });
        evs.at(-1).notes.push([SLOW[i % 4], 2]);
      }
      for (const e of evs.slice(0, -1)) e.notes.at(-1)[1] -= GAP;
      evs.at(-1).notes.push([last, 4]);
      give(one(name), evs, level, HUM);
    };
    const VOICES = [ // each of the canon's three voices: who leads it, who sings on where she breathes, who joins them, the man who holds under them, and their last notes
      [["Line 1", 62], ["Line 4", 62], ["Line 7b", 69], ["Line 6b", 57]],
      [["Line 2", MI], ["Line 5", 69], ["Line 8b", MI], ["Line 7a", 62]],
      [["Line 3", MI], ["Line 6a", 57], ["Line 8c", 62], ["Line 8a", MI]],
    ];
    const HIGH = new Set(["Line 4", "Line 7b", "Line 8b", "Line 3"]); // the sopranos
    VOICES.forEach(([[lead, l1], [other, l2], [third, l3], [man, l4]], v) => {
      canon(lead, 1 + v, END, 1.15, { alone: true }); // three women, a ground apart
      canon(lead, 5 + v, END, 0.95, { high: HIGH.has(lead) }); // the choir: a second woman with each,
      canon(other, 5 + v, MIDDLE, 0.9, { high: HIGH.has(other) });
      canon(third, 6 + v, END, 0.9, { i: 1, high: HIGH.has(third) }); // and a third from the second phrase
      for (const [name, plan] of [[lead, END], [other, MIDDLE]]) canon(name, 9 + v, plan, 0.9, { j: 4 - v, high: HIGH.has(name) }); // two to a voice, as far as the canon gets
      slow(man, 4 * 4 + 1 + v, 1 + v, 0.55, l4); // the men come to the held line a note apart, before the choir comes in
      slow(third, 4 * (9 + v), [2, 3, 1][v], 0.5, l3);
      for (const [name, pitch] of [[lead, l1], [other, l2]]) give(one(name), laid(CHORD, [[pitch, 4]], said(pitch)), 0.95, TUTTI);
    });
    // the ground: two basses, then the tenors, then the others two at a time. Each leaves out a note of their own every other time, to breathe.
    // Four leave at that note in their last time through, and come back in the last ground
    for (const [n, from, to, out, odd] of [[1, 0, 13, 7, 1], [2, 0, 13, 7, 0], [3, 3, 13, 3, 1], [4, 3, 13, 3, 0], [5, 5, 11, 5, 1], [6, 5, 11, 5, 0], [7, 6, 11, 1, 1], [8, 6, 11, 1, 0]]) {
      for (let k = from; k < to; k++) give(one(`Ground ${n}`), moved(GROUND, at(k)).filter((e, i) => k % 2 !== odd || (k === from && out < 4) || (k === to - 1 && to < 13 ? i < out : i !== out)), 0.7, STILL);
      if (to < 13) give(one(`Ground ${n}`), moved(GROUND, at(12)).slice(n < 7 ? 2 : 6), 0.7, STILL);
    }
    // the canon stops where it stands, on a chord of D
    for (const [n, pitch] of [[1, 50], [2, 50], [5, 50], [6, 50], [3, 62], [7, 62], [4, 57], [8, 57]]) give(one(`Ground ${n}`), laid(CHORD, [[pitch, 4]], said(pitch)), 0.95, TUTTI);
    const parts = scored(T, cast(c).map((p) => ({ ...p, gain: 1 })), sung, {
      bpm: 58,
      close: { from: at(12), chord: CHORD, slow: 0.75, hold: 8, fade: 0.3 },
      swells: [[/./, [[at(0), 0.8], [at(1), 0.9], [at(5), 1], [at(8), 1.15], [at(10), 1.1], [at(12), 0.9], [CHORD, 0.8]]]],
    });
    return {
      ...c, parts,
      source: "A canon on the eight-note ground of Pachelbel's Canon in D (late 17th century; public domain), sung on syllables, in an arrangement written for lipservice. Two basses sing the ground alone. Three women enter a ground apart, as the violins do, each singing the canon's first four phrases: two in slow notes, then two that move twice as fast. Three men come one by one to a slow held line of their own, which is written for this arrangement, and the choir takes the canon up in three groups over all eight men on the ground, the sopranos lifting the second phrase an octave. The last time through there are two to a voice, the others going one by one to the held line, and the canon stops where it stands, on a chord of D. The third phrase is at Pachelbel's pitch, the others an octave under it. A little slower than the demo, so that there is room to breathe: each breath is taken out of a note, and where one singer of a voice breathes another sings on. Sung by 20 of the demo's 291 singers.",
    };
  },
  "Rounds at the Fifth": (w) => {
    const T = "Rounds at the Fifth", L = 16; // the subject is L beats
    const no = (what) => { throw new Error(`${T}: ${what}`); };
    const c = { ...w, style: { ...w.style, breath: 1 } }; // the breaths are written, and all are taken
    const { sung, give } = book(c);
    const one = (name) => new RegExp(`^${name}$`);
    const taken = (name) => {
      const evs = lines(w, name, T)[0];
      if (evs.map((e) => e.word).join(" ") !== "do re sol la do la do do sol re la do" || evs.some((e) => e.notes.length !== 1)) no(`${name} is not the take's`);
      const out = moved(evs, -evs[0].at).map((e, i) => (i === evs.length - 1 ? { ...e, notes: [[e.notes[0][0], 2]] } : e));
      if (Math.abs(sylEnd(out.at(-1)) - L) > NEAR) no(`${name} is not ${L} beats`);
      return out;
    };
    const AT = [taken("Entry 1"), taken("Entry 2")]; // the subject at the written pitch, and a fifth above it
    if (AT[1].some((e, i) => e.notes[0][0] !== AT[0][i].notes[0][0] + 7)) no("Entry 2 is not a fifth above Entry 1");
    const DO = AT.map((evs) => evs[0].notes[0][0]);
    const GROUPS = [["Entry 1"], ["Entry 2"], ["Entry 3a", "Entry 3b"], ["Entry 4a", "Entry 4b"], ["Entry 5a", "Entry 5b"], ["Entry 6a", "Entry 6b"], ["Entry 7a", "Entry 7b", "Entry 7c"], ["Entry 8a", "Entry 8b", "Entry 8c"]]; // by turns at the written pitch and the fifth
    GROUPS.forEach((names, g) => names.forEach((name) => { if (lines(w, name, T)[0][0].notes[0][0] !== DO[g % 2]) no(`${name} is not where the take has it`); }));
    const SOPRANOS = new Set(["Entry 4a", "Entry 5a", "Entry 7c", "Entry 8b"]);
    const LATER = new Set([...SOPRANOS, "Entry 2", "Entry 5b", "Entry 7b", "Entry 8a"]); // half the choir breathes two beats after the other half, the last time
    const A = 4, B = 7, SOL = 8, Z = 11; // the subject's long notes, where a breath can be taken
    // the subject from beat t, `slow` times as slow, a breath after each note of `after`
    const subject = (level, t, after, slow = 1) => AT[level].map((e, i) => ({ ...e, at: t + e.at * slow, notes: [[e.notes[0][0], e.notes[0][1] * slow - (after.includes(i) ? GAP : 0)]] }));
    const SOLO = { base: 0.5, bloom: 1.5 }, ROUND = { base: 0.3, bloom: 0.9 }, LONG = { base: 0.4, bloom: 1.2, wait: 0.6 }, STILL = { base: 0.2 }, LATE = { base: 0.2, bloom: 1.1, wait: 1, rise: 2 };
    // one bass, and one alto answering a fifth above while he stays on his last note
    const ROUNDS = 2 + 2 * L, CLOSE = ROUNDS + 4 * L, ALL = CLOSE + 4 * 7 + L;
    give(one("Entry 1"), subject(0, 2, [B, Z]), 1.1, SOLO);
    give(one("Entry 1"), held(DO[0], [2 + L, 2 + L * 3 / 2, ROUNDS - GAP], "do"), 0.6, STILL);
    give(one("Entry 2"), subject(1, 2 + L, [B, Z]), 1.1, SOLO);
    // the round, two bars apart as in the take, each group twice through; under it the bass sings the subject at half the speed, and after him the alto
    give(one("Entry 1"), subject(0, ROUNDS, [A, B, Z], 2), 1.15, LONG);
    give(one("Entry 2"), subject(1, ROUNDS + 2 * L, [A, B, Z], 2), 1.05, LONG);
    GROUPS.slice(2).forEach((names, i) => names.forEach((name, q) => {
      for (const n of [0, 1]) give(one(name), subject(i % 2, ROUNDS + 8 * i + L * n, [[Z], [B], [A, Z]][q]), 0.85, ROUND);
    }));
    const swells = [[/./, [[2, 0.9], [ROUNDS, 0.9], [ROUNDS + 2 * L, 1], [CLOSE, 0.85], [ALL - 4, 1], [ALL, 1.2], [ALL + L, 1.1]]]];
    GROUPS.forEach((names, g) => names.forEach((name, q) => {
      // the round again a bar apart, once through, each singer staying on the last note: the fifth gathers under it.
      // The first five groups take that note again, each singer in their own time, and go on from it; the last three breathe before what follows
      const even = (g + q) % 2 === 0, on = g < 5, evs = subject(g % 2, CLOSE + 4 * g, [even ? B : A]), from = evs.at(-1).at, again = [];
      if (on) for (let r = ALL - 5 - (g + q) % 3; r > from + 3; r -= 8) again.unshift(r);
      give(one(name), evs.slice(0, -1), 0.9, ROUND);
      give(one(name), held(DO[g % 2], [from, ...again, ALL - (on ? 0 : GAP)], "do"), 0.9, STILL);
      if (from + 2 < ALL) swells.push([one(name), [[from, 1], [from + 2, 0.7], [ALL - 1, 0.7], [ALL, 1]]]);
      // all sixteen together, in fifths; the sopranos take the last three notes an octave up
      const high = SOPRANOS.has(name), all = subject(g % 2, ALL, [LATER.has(name) ? SOL : B]), sung = high ? [...all.slice(0, SOL + 1), ...raised(all.slice(SOL + 1), 12)] : all;
      give(one(name), sung.slice(0, -1), 1.1, STILL);
      give(one(name), sung.slice(-1), 1.1, LATE);
    }));
    const parts = scored(T, cast(c), sung, {
      bpm: 100,
      close: { from: ALL + L - 8, chord: ALL + L - 2, slow: 0.8, hold: 12, fade: 0.3 },
      swells,
    });
    return {
      ...c, parts,
      source: "A round written for lipservice, sung in solfege: twelve notes of a five-note scale, answered a fifth above. One bass sings it alone, and an alto answers at the fifth while he stays on his last note. The round follows as in the demo, six groups two bars apart, by turns at the written pitch and the fifth; under it the bass sings the subject at half the speed, and after him the alto. Then all eight groups a bar apart, each singer staying on the last note, so that the fifth gathers under the round. All sixteen sing it once together in fifths, the sopranos taking the last three notes an octave up. Sung by 16 of the demo's 132 singers. Set 7 semitones lower than the demo, to where every voice here holds its top note.",
    };
  },
  "Crab and Mirror Canon": (w) => {
    const T = "Crab and Mirror Canon", L = 16, at = (k) => 2 + L * k, TURNS = 6, AXIS = at(TURNS); // the subject is L beats; the piece turns at AXIS
    const no = (what) => { throw new Error(`${T}: ${what}`); };
    const c = { ...w, style: { ...w.style, breath: 1 } }; // the breaths are written, and all are taken
    const { sung, give } = book(c);
    const one = (name) => new RegExp(`^${name}$`);
    const TURNED = { Forward: "Backward", Backward: "Forward", "Upside down": "Upside down and backward", "Upside down and backward": "Upside down" };
    const FORM = Object.fromEntries(Object.keys(TURNED).map((g) => {
      const evs = lines(w, `${g} 1`, T)[0];
      if (evs.length !== 12 || evs.some((e) => e.notes.length !== 1)) no(`${g} 1 is not the take's`);
      return [g, moved(evs, -evs[0].at).map((e, i) => (i === 11 ? { ...e, notes: [[e.notes[0][0], 2]] } : e))];
    }));
    const back = (evs) => evs.map((e) => ({ ...e, at: L - sylEnd(e) })).reverse();
    for (const [g, t] of Object.entries(TURNED)) {
      if (!back(FORM[g]).every((e, i) => e.word === FORM[t][i].word && e.notes[0][0] === FORM[t][i].notes[0][0] && Math.abs(e.at - FORM[t][i].at) < NEAR && Math.abs(e.notes[0][1] - FORM[t][i].notes[0][1]) < NEAR)) no(`${t} is not ${g} backward`);
    }
    const SOL = 3, LA = 8, DO = 11; // the long notes, the same in every form: where a breath can be taken
    for (const evs of Object.values(FORM)) if ([0, SOL, LA, DO].some((i) => Math.abs(evs[i].notes[0][1] - 2) > NEAR)) no("a long note is not where it was");
    // each form's own singer, and the note they breathe after
    const LEAD = [["Forward 1", DO], ["Backward 2", SOL], ["Upside down 2", LA], ["Upside down and backward 2", DO]];
    // the rest in the order they come in, one to each note of the subject
    const JOIN = [
      ["Forward 4", SOL], ["Backward 1", LA], ["Upside down 1", DO], ["Upside down and backward 1", LA],
      ["Forward 2", LA], ["Backward 4", DO], ["Upside down 3", SOL], ["Upside down and backward 3", DO],
      ["Forward 3", SOL], ["Backward 3", LA], ["Upside down 4", LA], ["Upside down and backward 4", SOL],
    ];
    if (JOIN.length !== FORM.Forward.length) no("not a singer to each note");
    const group = (name) => name.replace(/ \d$/, "");
    const ALONE = { base: 0.5, bloom: 1.5 }, LED = { base: 0.4, bloom: 1.2 }, JOINED = { base: 0.4, bloom: 1 };
    const LAST = 2 * TURNS - 1;
    // notes i to j of a singer's form in turn k of the subject, backward once the piece has turned
    const sing = (name, k, after, level, vib, i = 0, j = 12) => give(one(name), FORM[k < TURNS ? group(name) : TURNED[group(name)]].slice(i, j).map((e, n) =>
      ({ ...e, at: at(k) + e.at, notes: [[e.notes[0][0], e.notes[0][1] - ([after].flat().includes(i + n) && !(k === LAST && i + n === DO) ? GAP : 0)]] })), level, vib);
    // an alto forward, a tenor backward, a soprano upside down, a bass upside down and backward: each a turn after the last, and leaving in the order they came
    LEAD.forEach(([name, breath], n) => {
      for (let k = n; k <= LAST - n; k++) {
        const alone = n === 0 && (k === 0 || k === LAST);
        sing(name, k, alone ? [SOL, DO] : breath, 1, alone ? ALONE : LED);
      }
    });
    // the others come in behind them through one turn of the subject, a singer on each of its notes; all sixteen for the two turns either side of the middle
    JOIN.forEach(([name, after], i) => {
      sing(name, TURNS - 2, after, 0.85, JOINED, i);
      sing(name, TURNS - 1, after, 0.85, JOINED);
      sing(name, TURNS, after, 0.85, JOINED);
      sing(name, TURNS + 1, 12 - i - after > 3 ? after : [], 0.85, JOINED, 0, 12 - i); // no breath for a last note or two
    });
    // the second half is the first half backward: every note has its twin across the middle
    for (const [name, evs] of Object.entries(sung)) {
      const spans = evs.map((e) => [e.at, sylEnd(e), e.notes[0][0]]), near = (x, y) => Math.abs(x - y) < 2 * GAP + NEAR;
      for (const [a, b, m] of spans) if (!spans.some(([x, y, o]) => o === m && near(x, 2 * AXIS - b) && near(y, 2 * AXIS - a))) no(`${name}: the note at ${a} has no twin`);
    }
    const END = at(LAST + 1);
    // those who join come in under the others and go out under them
    const EASED = JOIN.map(([name]) => {
      const from = sung[name][0].at, to = sylEnd(sung[name].at(-1));
      return [one(name), [[from, 0.6], [from + 4, 1], [to - 4, 1], [to, 0.6]]];
    });
    const parts = scored(T, cast(c), sung, {
      bpm: 96,
      close: { from: END - 6, chord: END - 2, slow: 0.75, hold: 8, fade: 0.2 },
      swells: [
        [/./, [[at(0), 0.85], [at(TURNS - 2), 1], [at(TURNS - 1), 1.15], [AXIS, 1.25], [at(TURNS + 1), 1.15], [at(TURNS + 2), 1], [END, 0.8]]],
        [/^Forward 1$/, [[at(1), 1.15], [at(2), 1], [at(LAST - 1), 1], [at(LAST), 1.15]]],
        ...EASED,
      ],
    });
    return {
      ...c, parts,
      source: "A canon written for lipservice on a subject of twelve notes, sung in solfege, in an arrangement that is itself a crab. One alto sings the subject forward, alone. A tenor joins her with it backward, a soprano with it upside down, a bass with it upside down and backward: four voices, the four forms. The rest of the choir comes in behind them through one turn of the subject, a new singer on each of its twelve notes, and all sixteen sing the four forms together. From the middle on, every singer sings backward what they have sung, so the choir leaves as it came, and the alto ends alone with the subject backward, on the note she began on. The breaths are written, each singer taking theirs where others of the group sing on. Sung by 16 of the demo's 128 singers. Set 2 semitones lower than the demo, to where every voice here holds its top note.",
    };
  },
  "Row Your Boat, Drifting": (w) => {
    const T = "Row Your Boat, Drifting", P = 48, PASSES = 6, DRIFT = 5 * P, STEP = 3; // the tune; the times each sings it once all have begun; how long they drift; how far apart neighbours settle
    const no = (what) => { throw new Error(`${T}: ${what}`); };
    const c = { ...w, style: { ...w.style, breath: 1 } }; // the breaths are written, and all are taken
    const { sung, give } = book(c);
    const N = c.parts.length, one = (n) => new RegExp(`^Singer ${n}$`);
    if (N * STEP !== P) no("the singers a beat apart do not fill the tune");
    const first = lines(w, "Singer 1", T)[0], TUNE = moved(first.slice(0, 27), -first[0].at);
    if (TUNE.filter((e) => !e.k).map((e) => e.word).join(" ") !== "row row row your boat gently down the stream merrily merrily merrily merrily life is but a dream"
      || TUNE.some((e) => e.notes.length !== 1) || Math.abs(sylEnd(TUNE.at(-1)) - P) > NEAR) no("the tune is not the take's");
    const LINE = [0, 5, 10, 22, 27], BOAT = 4, STREAM = 9, DREAM = 26; // where each line begins; the long notes, where a breath can be taken
    const tune = (t, from, to, breaths) => TUNE.slice(from, to).map((e, i) => ({ ...e, at: t + e.at, notes: [[e.notes[0][0], e.notes[0][1] - (breaths.includes(from + i) ? GAP : 0)]] }));
    const UNISON = { base: 0.3, bloom: 0.9 }, SOLO = { base: 0.5, bloom: 1.4 }, LATE = { base: 0.2, bloom: 1.2, wait: 0.8, rise: 2 };
    // one tenor in the middle, and the choir gathering on him a line at a time, from the middle outward
    const BEGINS = 8, GATHER = [[BEGINS], [7, 9, 10], [5, 6, 11, 12], [1, 2, 3, 4, 13, 14, 15, 16]];
    if (GATHER.flat().length !== N) no("not every singer gathers");
    give(one(BEGINS), tune(2, 0, LINE[1], []), 1, SOLO);
    give(one(BEGINS), tune(2, LINE[1], LINE[4], [STREAM, DREAM]), 1, UNISON);
    GATHER.slice(1).forEach((ns, g) => { for (const n of ns) give(one(n), tune(2, LINE[g + 1], LINE[4], g < 2 ? [DREAM] : []), 1, UNISON); });
    // then all begin together, each a little faster than the one on their right: the unison eases apart and eases to rest with neighbours STEP beats apart
    const T0 = 2 + P, ease = (u) => u * u * (3 - 2 * u);
    const ahead = (n) => STEP * (BEGINS - n); // the tenor who began keeps the beat
    const when = (a, x) => { // the beat at which a singer who ends up `a` beats ahead reaches beat x of what they sing
      let lo = 0, hi = PASSES * P + P;
      for (let i = 0; i < 60; i++) { const t = (lo + hi) / 2; if (t + a * ease(Math.min(1, t / DRIFT)) < x) lo = t; else hi = t; }
      return (lo + hi) / 2;
    };
    const LATECOMER = new Set(GATHER[3]);
    for (let n = 1; n <= N; n++) {
      const a = ahead(n), last = n === N;
      // while they are still close the two halves of the choir breathe in turn; after that the drift keeps their breaths apart
      const breaths = (p) => (p === 0 && LATECOMER.has(n) ? [BOAT, DREAM] : p === PASSES - 1 ? [STREAM] : [STREAM, DREAM]);
      const evs = Array.from({ length: PASSES }, (_, p) => tune(0, 0, LINE[4], []).map((e, j) => {
        const from = when(a, p * P + e.at), to = when(a, p * P + sylEnd(e));
        return { ...e, at: T0 + from, notes: [[e.notes[0][0], to - from - (breaths(p).includes(j) ? GAP : 0)]] };
      })).flat();
      if (Math.abs(sylEnd(evs.at(-1)) - (T0 + PASSES * P - a)) > NEAR) no(`Singer ${n} does not end ${a} beats ahead`);
      // the slowest sings the last line alone
      give(one(n), last ? evs.slice(0, -5) : evs, 1, UNISON);
      if (last) { give(one(n), evs.slice(-5, -1), 1, SOLO); give(one(n), evs.slice(-1), 1, LATE); }
    }
    const SETTLED = T0 + DRIFT, END = T0 + PASSES * P - ahead(N);
    const parts = scored(T, cast(c), sung, {
      bpm: 150,
      close: { from: END - 12, chord: END - 6, slow: 0.8, hold: 8, fade: 0.2 },
      swells: [
        [/./, [[2, 0.9], [2 + 36, 1], [T0, 1], [T0 + DRIFT / 2, 0.85], [SETTLED, 1.15], [SETTLED + P / 2, 1.15], [END, 1]]],
        [one(BEGINS), [[2, 1.2], [2 + 12, 1.2], [2 + 15, 1]]],
        [one(N), [[END - 12, 1], [END - 6, 1.15]]],
      ],
    });
    return {
      ...c, parts,
      source: "\"Row, Row, Row Your Boat\", the American round of 1852; public domain. One tenor in the middle begins it, and the choir gathers on him a line at a time, from the middle outward. Then all sixteen begin together and sing it six times, each a little faster than the one on their right while he keeps the beat: the unison eases apart into a cloud, and the cloud settles as a canon a beat apart, the whole tune sounding at once. Each stops when they have sung their six, the fastest first, until the slowest sings the last line alone. The breaths are written. Sung by 16 of the demo's 100 singers.",
    };
  },
  "Three Voices, Georgian Manner": (w) => {
    const T = "Three Voices, Georgian Manner";
    const no = (what) => { throw new Error(`${T}: ${what}`); };
    const c = { ...w, style: { ...w.style, breath: 1 } }; // the breaths are written, and all are taken
    const { sung, give } = book(c);
    const one = (name) => new RegExp(`^${name}$`);
    // the take's five lines, as each of its four parts sings them
    const WORDS = { A: "nay nah nay nah oh", B: "hey nah hey nah hey oh", C: "yo nay yo nah ho", D: "ah ah ah oh", E: "nay oh" };
    const LAST = 8; // the last chord, shorter than the take's: one breath's worth
    const part = (name) => {
      const L = lines(w, name, T), cut = { A: L[2], B: L[3], C: L[4], D: L[5], E: L[8]?.slice(9) };
      return Object.fromEntries(Object.entries(cut).map(([x, evs]) => {
        if (evs?.map((e) => e.word).join(" ") !== WORDS[x]) no(`${name}: line ${x} is not the take's`);
        const end = evs.at(-1), notes = [...end.notes.slice(0, -1), [end.notes.at(-1)[0], x === "E" ? LAST : Math.round(end.notes.at(-1)[1])]];
        return [x, moved([...evs.slice(0, -1), { ...end, notes }], -evs[0].at)];
      }));
    };
    const TOP = part("First part 1"), MIDDLE = part("Second part 1"), LOW = part("Bass 1"), UPPER = part("Bass 2");
    const LINE = (name) => (/^First/.test(name) ? TOP : /^Second/.test(name) ? MIDDLE : /^Bass [145]$/.test(name) ? LOW : UPPER);
    for (const p of w.parts) {
      const a = lines(w, p.name, T).find((l) => Math.abs(l[0].at - 71) < 0.1);
      if (!a || a.slice(0, 5).some((e, i) => e.notes[0][0] !== LINE(p.name).A[i].notes[0][0])) no(`${p.name} does not sing the line it is given`);
    }
    const LONG = { A: 10, B: 11, C: 14, D: 14, E: 4 + LAST }, MID = { A: 2, B: 0, C: 2, D: 1, E: 0 }; // each line's beats; the note in it a breath can follow
    for (const [x, evs] of Object.entries(TOP)) if (Math.abs(sylEnd(evs.at(-1)) - LONG[x]) > NEAR || evs[MID[x]].notes.length !== 1 || evs[MID[x]].notes[0][1] < 2) no(`line ${x} is not the length it was`);
    // a line from beat t, a breath after each of the notes `breaths` counts (AFTER: its last); with none after its last it is sung on into what follows
    const AFTER = -1;
    const sing = (name, x, t, breaths, vib) => give(one(name), moved(LINE(name)[x], t).map((e, i, all) => {
      if (!breaths.includes(i) && !(breaths.includes(AFTER) && i === all.length - 1)) return e;
      if (i < all.length - 1 && (e.notes.length !== 1 || e.notes[0][1] < 2)) no(`no room for a breath in line ${x}`);
      return { ...e, notes: [...e.notes.slice(0, -1), [e.notes.at(-1)[0], e.notes.at(-1)[1] - GAP]] };
    }), 1, vib);
    const SOLO = { base: 0.4, bloom: 1.3 }, LEADS = { base: 0.35, bloom: 1 }, CHOIR = { base: 0.25, bloom: 0.7 }, BANI = { base: 0.15 }, FINAL = { base: 0.2, bloom: 1, wait: 1, rise: 2 };
    const FS = "First part 2", MS = "Second part 2", basses = [1, 2, 3, 4, 5, 6].map((n) => `Bass ${n}`);
    const I = basses.slice(0, 3), II = basses.slice(3); // the two choirs' basses
    const how = (name) => (/^Bass/.test(name) ? BANI : CHOIR);
    const DRONE = (name) => LINE(name).A.at(-1).notes.at(-1)[0]; // the note each bass ends a line on
    const drone = (names, t, cuts) => names.forEach((name, i) => give(one(name), held(DRONE(name), cuts[i].map((x) => t + x), "oh"), 1, BANI));
    // the take's two interludes
    const SOLOS = lines(w, FS, T).filter((l) => l.length === 1 && l[0].word === "ah" && l[0].notes.length > 3);
    if (SOLOS.length !== 4) no("the interludes are not the take's");
    const interlude = (t, k) => { for (const i of [0, 1]) give(one(FS), moved(SOLOS[2 * k + i], t + [0, 11.5][i] - SOLOS[2 * k + i][0].at), 1, SOLO); };
    const V1 = 2, I1 = V1 + 45, V2 = I1 + 24, I2 = V2 + 49, V3 = I2 + 24, END = V3 + 49 + LONG.E;

    // verse 1. The middle voice alone; the top voice over him; the basses in under them one at a time, on the notes they end on.
    // From here to the end one choir's basses breathe where the other's sing on, turn about
    sing(MS, "A", V1, [AFTER], SOLO);
    for (const name of [MS, FS]) { sing(name, "A", V1 + 10, [AFTER], SOLO); sing(name, "B", V1 + 20, [AFTER], SOLO); sing(name, "C", V1 + 31, name === FS ? [AFTER] : [], SOLO); }
    drone(["Bass 2", "Bass 3", "Bass 1"], V1, [[4, 12, 20 - GAP], [6, 20 - GAP], [12, 20 - GAP]]);
    drone(["Bass 6", "Bass 4", "Bass 5"], V1, [[8, 20], [14, 20], [16, 20]]);
    for (const name of I) { sing(name, "B", V1 + 20, [AFTER], BANI); sing(name, "C", V1 + 31, [AFTER], BANI); }
    for (const name of II) { sing(name, "B", V1 + 20, [MID.B], BANI); sing(name, "C", V1 + 31, [MID.C], BANI); }
    // the top voice alone over the basses' drone, each bass breathing in his own place
    interlude(I1, 0);
    drone(I, I1, [[0, 8, 16, 24 - GAP], [0, 9.5, 18, 24 - GAP], [0, 12.5, 24 - GAP]]);
    drone(II, I1, [[0, 4, 13, 26], [0, 6, 15, 26], [0, 5, 14, 26]]); // on under the first choir as it begins
    // verse 2. Two choirs, a line each, the second beginning as the first ends; then all twelve
    for (const name of ["First part 1", "Second part 1", ...I]) { sing(name, "A", V2, [], how(name)); sing(name, "C", V2 + 21, [3], how(name)); sing(name, "D", V2 + 35, [MID.D], how(name)); }
    for (const name of ["First part 3", "Second part 3", ...II]) { sing(name, "B", V2 + 10, [], how(name)); sing(name, "D", V2 + 35, /^Bass/.test(name) ? [AFTER] : [], how(name)); }
    sing(FS, "D", V2 + 35, [AFTER], LEADS); sing(MS, "D", V2 + 35, [], LEADS);
    interlude(I2, 1);
    drone(I, I2, [[0, 6, 14, 21.5, 24], [0, 7, 15, 22.5, 24], [0, 5, 13, 20.5, 24]]);
    drone(II, I2, [[0, 8, 17, 24], [0, 9.5, 19, 24], [0, 12, 21, 24]]);
    // verse 3. All twelve, over the basses who have not stopped: half breathe between the lines and half inside them, so no line ends in silence
    const INSIDE = new Set(["First part 1", "Second part 3", ...I]);
    for (const { name } of w.parts) {
      const vib = name === FS || name === MS ? LEADS : how(name), inside = INSIDE.has(name);
      ["A", "B", "C", "D"].forEach((x, i) => sing(name, x, V3 + [0, 10, 21, 35][i], inside ? (x === "A" ? [] : [MID[x]]) : [AFTER], vib));
      // the last line: "nay", and the chord
      const [nay, oh] = moved(LINE(name).E, V3 + 49);
      give(one(name), [inside ? { ...nay, notes: [[nay.notes[0][0], nay.notes[0][1] - GAP]] } : nay], 1, vib);
      give(one(name), [oh], 1, FINAL);
    }
    const parts = scored(T, cast(c), sung, {
      bpm: 84,
      close: { from: END - LAST - 4, chord: END - LAST, slow: 0.8, hold: LAST, fade: 0.5 },
      swells: [
        [/./, [[V1, 0.9], [I1, 0.95], [V2, 0.95], [V2 + 35, 1.05], [I2, 0.95], [V3, 1.05], [V3 + 35, 1.15], [V3 + 49, 1.2], [END, 1.2]]],
        [/^Bass/, [[V1, 0.4], [V1 + 20, 0.6], [I1 - 1, 0.6], [I1 + 2, 0.45], [V2 - 3, 0.45], [V2, 0.95], [I2 - 1, 0.95], [I2 + 2, 0.45], [V3 - 6, 0.45], [V3, 1]]],
        [/ part 2$/, [[V1, 1.1], [V3 - 2, 1.1], [V3 + 2, 1]]],
        [/^Bass [456]$/, [[V2 - 3, 1], [V2 + 2, 0.5], [V2 + 3, 1]]],
      ],
    });
    return {
      ...c, parts,
      source: "A piece in three parts for men, written for lipservice in the manner of Georgian village polyphony; not a transcription of any song. The middle voice begins alone, the top voice joins over him, and the basses come in under them one at a time. The top voice's two interludes are sung over the basses' drone, written for this arrangement. The second verse is two choirs, a line each; the third is all twelve, half of them breathing inside the lines so that none ends in silence. Sung by 12 of the demo's 100 singers.",
    };
  },
  "Counting, Minimalist Manner": (w) => {
    const T = "Counting, Minimalist Manner";
    const no = (what) => { throw new Error(`${T}: ${what}`); };
    const c = { ...w, style: { ...w.style, breath: 1 } }; // the breaths are written, and all are taken
    const { sung, give } = book(c);
    const one = (name) => new RegExp(`^${name}$`);
    const mod = (a, n) => ((a % n) + n) % n;
    // the piece's process as its maker wrote it, in beats from its first note
    const CYC = 64, BAR = 16, TONIC = 57;
    const TONES = [[0, 3, 7, 12, 15, 19], [-4, 0, 3, 8, 12, 15], [-7, -4, 0, 5, 8, 12], [-5, -1, 2, 7, 11, 14]]; // i, VI, iv, V, a bar each
    const KEY = [0, 0, 0, 0, 0, 0, 3, 3, 3, -2, -2, 0]; // a cycle each: A minor, C minor, G minor, A minor
    const A1 = [0, 1, 2, 0, 1, 2, 1, 2], A2 = [3, 2, 1, 3, 2, 1, 2, 1]; // the 3+3+2 cell and its mirror
    const LINE = [0, 2, 1, 3, 2, 4, 3, 2, 4, 3, 5]; // the line that grows
    const SOLFEGE = { 0: "la", 2: "ti", 3: "do", 5: "re", 7: "mi", 8: "fa", 10: "sol", 11: "si" };
    const COUNT = [["one", 1], ["two", 1], ["three", 1], ["four", 1], ["five", 1], ["six", 1], ["seven", 2], ["eight", 1], ["nine", 1], ["ten", 1]];
    const KS = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11]; // the line's lengths in beats
    const SCALE = [[0, "do"], [2, "re"], [3, "mi"], [5, "fa"], [7, "sol"], [8, "la"], [10, "ti"], [12, "do"]];
    const grows = (k) => 2 * CYC + 2 * KS.filter((x) => x < k).reduce((a, x) => a + x, 0); // where the line is first k beats long
    const GROWS = grows(1), AXIS = grows(Infinity), SWAP = 6 * CYC, QUOTE = 8 * CYC + 32, CANON = 9 * CYC, UNISON = 11 * CYC;
    const FOUR = UNISON + 3 * BAR, LONG = 24, FIVE = FOUR + LONG + 12;
    const tonic = (b) => TONIC + KEY[Math.floor(b / CYC)];
    const pitch = (b, i) => tonic(b) + TONES[Math.floor(mod(b, CYC) / BAR)][i];
    // what is sung, a word at a time: [[syllable...]]
    const note = (at, word, p, d = 1, k = 0) => ({ at, word, k, notes: [[p, d]] });
    const solfege = (b0, b1, cell, off) => Array.from({ length: b1 - b0 }, (_, i) => {
      const b = b0 + i, p = pitch(b, cell[mod(b - off, 8)]);
      return [note(b, SOLFEGE[mod(p - tonic(b), 12)], p)];
    });
    const numbers = (b0, b1, cell, off) => {
      const out = [];
      for (let b = b0; b < b1;) {
        const ph = mod(b - off, 8);
        if (ph === 7) b += 1;
        else if (ph === 6) {
          if (b + 1 >= b1) break;
          out.push([note(b, "seven", pitch(b, cell[6])), note(b + 1, "seven", pitch(b + 1, cell[7]), 1, 1)]);
          b += 2;
        } else { out.push([note(b, COUNT[ph][0], pitch(b, cell[ph]))]); b += 1; }
      }
      return out;
    };
    const grown = () => { // each length twice, up and back down
      const out = [];
      let b = GROWS;
      for (const k of [...KS, ...[...KS].reverse()]) for (let twice = 0; twice < 2; twice++, b += k) {
        let pos = 0;
        for (const [word, n] of COUNT) {
          if (pos === k) break;
          out.push(Array.from({ length: n }, (_, i) => note(b + pos + i, word, pitch(b + pos + i, LINE[pos + i]), 1, i)));
          pos += n;
        }
        if (pos !== k) no(`a line of ${k} beats`);
      }
      return out;
    };
    const roots = Array.from({ length: FOUR / 4 }, (_, i) => { const p = pitch(4 * i, 0); return [note(4 * i, COUNT[i % 4][0], p < 50 ? p + 12 : p, 4)]; });
    const scale = SCALE.map(([up, word], i) => [note(QUOTE + i, word, tonic(QUOTE) + up)]);
    const clear = (us, spans) => us.filter((u) => !spans.some(([a, b]) => wordSpan(u)[0] < b && wordSpan(u)[1] > a));
    const SEAMS = [SWAP, CANON, UNISON].map((b) => [b - 2, b]); // two beats before each change of key with the basses alone
    const upper = (us) => [...clear(us, [...SEAMS, [QUOTE, QUOTE + 8]]), ...scale].sort((a, b) => a[0].at - b[0].at);
    const counting = (off) => upper([...grown(), ...solfege(SWAP, CANON, A2, 5), ...solfege(CANON, UNISON, A1, off), ...solfege(UNISON, FOUR, A1, 0)]);
    const WHOLE = { // each group's line with nothing left out; the men who count are two lines in the canon
      "First arpeggio": [[0, upper([...solfege(BAR, SWAP, A1, 0), ...numbers(SWAP, CANON, A1, 0), ...solfege(CANON, FOUR, A1, 0)])]],
      "Second arpeggio": [[2, upper([...solfege(CYC, SWAP, A2, 3), ...numbers(SWAP, CANON, A2, 3), ...solfege(CANON, UNISON, A1, 2), ...solfege(UNISON, FOUR, A1, 0)])]],
      Bass: [[0, roots]],
      Counting: [[4, counting(4)], [6, counting(6)]],
    };
    if (2 * AXIS - GROWS > SWAP - 2 - BAR) no("the line that grows runs into the change of key");
    // the take's singers sing nothing that is not in these, and end as they did
    const LEAD = 6, same = (a, b) => a && a.word === b.word && a.k === b.k && b.notes.length === 1 && a.notes[0][0] === b.notes[0][0] && Math.abs(a.notes[0][1] - b.notes[0][1]) < 2 * GAP;
    const singers = w.parts.map((p) => {
      const group = p.name.replace(/ \d$/, ""), n = +p.name.at(-1), evs = moved(syllables(p, T), -LEAD);
      const body = evs.filter((e) => e.at < FOUR - 0.5), [four, five, ...more] = evs.filter((e) => e.at >= FOUR - 0.5);
      const line = WHOLE[group]?.find(([, us]) => { const at = new Map(us.flat().map((x) => [x.at, x])); return body.every((e) => Math.abs(e.at - Math.round(e.at)) < 0.01 && same(at.get(Math.round(e.at)), e)); });
      if (!line) no(`${p.name} is not sung as the piece is made`);
      if (!same(note(FOUR, "four", four?.notes[0][0], LONG), four ?? {}) || Math.abs(four.at - FOUR) > 0.01) no(`${p.name} does not end on "four"`);
      if (more.length || (five && !(p.name === "First arpeggio 1" && Math.abs(five.at - FIVE) < 0.01 && same(note(FIVE, "five", TONIC + 12, 7), five)))) no(`${p.name}: an ending that is not the take's`);
      return { name: p.name, group, n, of: w.parts.filter((x) => x.name.startsWith(group)).length, off: line[0], whole: line[1], top: four.notes[0][0] };
    });
    // The take's groups come in whole and all at once after each change of key. Here a singer at a time: each
    // at the start of the cell as their group sings it, the line that grows growing by a man as it does (at
    // JOINS beats long) and shrinking the same way; into the unison on the cell's three strokes.
    const JOINS = [1, 3, 5, 8, 10];
    const cut = (from) => from.map((a, i) => [a, [SWAP - 2, CANON - 2, UNISON - 2, FOUR][i]]);
    const SINGS = { // [[from, to]]
      "First arpeggio": ({ n }) => cut([[BAR, 2 * BAR, 2 * BAR + 8, 3 * BAR][n - 1], SWAP, CANON, UNISON]),
      "Second arpeggio": ({ n }) => cut([CYC + 3 + BAR * (n - 1), SWAP + 3, CANON + 2, UNISON + 3]),
      Bass: ({ n }) => [[BAR * (n - 1), FOUR]],
      Counting: ({ n, off }) => [[grows(JOINS[n - 1]), 2 * AXIS - grows(JOINS[n - 1])], ...cut([0, SWAP + 5, CANON + off, UNISON + 6]).slice(1)],
    };
    // A group's line never stops for breath: each singer leaves out three beats of it (a bass one note) about
    // every REACH, no two of a group at once, the last of them some way before the chord and the groups' apart.
    const REACH = 40, HEAD = 10, TAIL = 10, APART = { "Second arpeggio": 2, Counting: 1 };
    const out = Object.fromEntries(Object.keys(SINGS).map((g) => [g, []]));
    const breathed = ({ name, group, n, of }, us) => {
      if (unbroken(us).length !== 1) no(`${name}: a line with a hole in it`);
      const bass = group === "Bass", size = bass ? 4 : 3;
      const s = us[0][0].at, end = wordSpan(us.at(-1))[1], closing = end === FOUR ? FOUR - 9 - size - (n - 1) * (bass ? 8 : 4) - (APART[group] ?? 0) : null, e = closing ?? end;
      const phrases = Math.ceil((e - s) / (REACH + size)), q = (e - s - (phrases - 1) * size) / phrases;
      const wanted = Array.from({ length: phrases - 1 }, (_, i) => [s + (i + 1) * q + i * size + ((n - 1) / (of - 1) - 0.5) * q / 3, e - TAIL]);
      if (closing !== null) wanted.push([closing, FOUR - 6]);
      return rested(us, wanted, { size, grid: bass ? 4 : 1, head: HEAD, pad: bass ? 0 : 1, taken: out[group], free: (a, b) => !(a < QUOTE + 9 && b > QUOTE - 1) });
    };
    const O = 2; // the arrangement's first beat
    const PULSE = { base: 0.3 }, ROOT = { base: 0.5 }, CHORD = { base: 0.2, bloom: 1, wait: 1, rise: 2.5 }, WORD = { base: 0.4, bloom: 1.3 };
    const shaped = [];
    for (const who of singers) {
      const given = SINGS[who.group](who).map(([a, b]) => who.whole.filter((u) => u[0].at >= a && u[0].at < b));
      who.given = given.flat();
      who.sings = given.map((us) => breathed(who, us));
      give(one(who.name), moved(who.sings.flat(2), O), 1, who.group === "Bass" ? ROOT : PULSE);
      give(one(who.name), [note(O + FOUR, "four", who.top, LONG)], 1, CHORD);
      // a singer slips out to breathe and back in; joins under the others, leaves the same way; into a new key at once
      shaped.push([one(who.name), who.sings.flatMap((us, i) => unbroken(us).flatMap((run, j, all) => {
        const s = run[0][0].at, e = wordSpan(run.at(-1))[1];
        const into = j ? [[s, 0.7], [s + 2, 1]] : i === 0 && who.n > 1 ? [[s, 0.5], [s + 6, 1]] : [[s, 1]];
        const away = j + 1 < all.length ? [[e - 2, 1], [e, 0.75]] : i === 0 && who.group === "Counting" ? [[e - 4, 1], [e, 0.6]] : [[e, 1]];
        return [...into, ...away].map(([b, k]) => [O + b, k]);
      }))]);
    }
    const key = (u) => `${u[0].at} ${u[0].word} ${u[0].notes[0][0]}`;
    for (const a of singers) {
      const mine = new Set(a.sings.flat()), theirs = new Set(singers.filter((b) => b !== a && b.group === a.group).flatMap((b) => b.sings.flat().map(key)));
      if (a.given.some((u) => !mine.has(u) && !theirs.has(key(u)))) no(`${a.name} breathes with no one on the line`);
    }
    give(/^First arpeggio 1$/, [note(O + FIVE, "five", TONIC + 12, 7)], 1, WORD);
    const g = (pts) => pts.map(([b, k]) => [O + b, k]);
    const parts = scored(T, cast(c), sung, {
      bpm: 270,
      close: { chord: O + FIVE, hold: 7, fade: 0.6 },
      swells: [
        // each key at its own level, come to at once; the line that grows, the scale and the canon each a rise; the chord struck, let down and swelled
        [/./, g([[0, 0.85], [GROWS, 0.95], [AXIS, 1.1], [2 * AXIS - GROWS, 0.9], [SWAP - 1.5, 0.8], [SWAP - 0.5, 1.15], [SWAP + 96, 1.05], [QUOTE, 1.1], [QUOTE + 8, 1.25], [CANON - 1.5, 1.25], [CANON - 0.5, 0.75], [CANON + CYC, 0.9], [UNISON - 1.5, 1.1], [UNISON - 0.5, 1.2], [UNISON + 8, 1.3], [FOUR, 1.3], [FOUR + 5, 0.95], [FOUR + LONG, 1.35], [FIVE - 2, 1.35], [FIVE - 1, 0.8]])],
        [/^Counting/, g([[GROWS, 0.85], [AXIS, 1.15], [2 * AXIS - GROWS, 0.8], [SWAP - 1, 0.9], [CANON - 1, 0.9], [CANON, 1]])],
        ...shaped,
      ],
    });
    return {
      ...c, parts,
      source: "A piece written for lipservice in the manner of minimalist process music; not a copy of any piece. Numbers and solfege on a steady pulse: two groups of women sing arpeggios against each other, the basses count the chord roots, and a line of men grows by a note each time round and shrinks again. Here the singers come in one at a time, each at the start of the pattern, and the line that grows by a note grows by a man as it does, and shrinks to one man on \"one\". After each sudden change of key the groups come in in turn: three beats apart where the roles are swapped, two apart in the canon, and into the unison on the pattern's three strokes. Within a group the singers breathe in turn, so no pattern stops for breath. One chord held on \"four\", and one voice with the last word. Sung by 16 of the demo's 100 singers.",
    };
  },
  "Three, Four, Five and Seven": (w) => {
    const T = "Three, Four, Five and Seven";
    const no = (what) => { throw new Error(`${T}: ${what}`); };
    const { sung, give } = book(w);
    const one = (name) => new RegExp(`^${name}$`);
    // the piece's process as its maker wrote it, in pulses from its first note
    const SPAN = 420, END = 3 * SPAN, LONG = 28;
    const FIG = { // each group's figure in each round: [word, note, pulses]
      Sevens: [[["doom", 60, 3], ["dah", 67, 2], ["doo", 65, 2]], [["doom", 63, 3], ["dah", 70, 2], ["doo", 67, 2]], [["doom", 60, 3], ["dah", 65, 2], ["doo", 67, 2]]],
      Fives: [[["bah", 67, 2], ["dee", 70, 1], ["ho", 72, 2]], [["bah", 70, 2], ["dee", 72, 1], ["ho", 67, 2]], [["bah", 67, 2], ["dee", 65, 1], ["ho", 72, 2]]],
      Fours: [[["ta", 72, 1], ["kah", 75, 1], ["ta", 77, 1], ["kah", 75, 1]], [["ta", 75, 1], ["kah", 72, 1], ["ta", 70, 1], ["kah", 72, 1]], [["ta", 72, 1], ["kah", 70, 1], ["ta", 67, 1], ["kah", 70, 1]]],
      Threes: [[["hey", 67, 1], ["ho", 70, 1], ["hey", 65, 1]], [["hey", 70, 1], ["ho", 67, 1], ["hey", 72, 1]], [["hey", 67, 1], ["ho", 65, 1], ["hey", 70, 1]]],
    };
    const LAST = { Sevens: 60, Fives: 67, Fours: 72, Threes: 67 };
    const M = Object.fromEntries(Object.entries(FIG).map(([g, f]) => [g, f[0].reduce((a, x) => a + x[2], 0)]));
    const note = (at, word, p, d = 1) => ({ at, word, k: 0, notes: [[p, d]] });
    // a group's line with nothing left out, a word at a time: [[syllable]]
    const WHOLE = Object.fromEntries(Object.keys(FIG).map((g) => [g, Array.from({ length: END / M[g] }, (_, i) => {
      let at = i * M[g];
      return FIG[g][Math.floor(at / SPAN)].map(([word, p, d]) => { const u = [note(at, word, p, d)]; at += d; return u; });
    }).flat()]));
    // the take's singers sing nothing that is not in these, and end as they did
    const LEAD = 7, same = (a, b) => a && a.word === b.word && b.notes.length === 1 && a.notes[0][0] === b.notes[0][0] && Math.abs(a.notes[0][1] - b.notes[0][1]) < 2 * GAP;
    const singers = w.parts.map((p) => {
      const group = p.name.replace(/ \d$/, ""), evs = moved(syllables(p, T), -LEAD), at = new Map((WHOLE[group] ?? no(`no ${group}`)).flat().map((x) => [x.at, x]));
      const body = evs.filter((e) => e.at < END - 0.5), [last, ...more] = evs.filter((e) => e.at >= END - 0.5);
      if (!body.every((e) => Math.abs(e.at - Math.round(e.at)) < 0.01 && same(at.get(Math.round(e.at)), e))) no(`${p.name} is not sung as the piece is made`);
      if (more.length || !last || Math.abs(last.at - END) > 0.01 || !same(note(END, "ah", LAST[group], LONG), last)) no(`${p.name} does not end on the chord`);
      return { name: p.name, group, first: evs[0].at };
    });
    // The take's groups come in one after another and then all sing to the end. Here each group's first
    // singer comes in where its figure falls in with a group already singing, the rest of it a singer at
    // a time (two figures apart, one where a group comes back), and the middle round is taken apart: the
    // sevens and the fives thin out a singer a figure and leave three against four alone, the fives come
    // back, the fours and the threes leave five against seven alone, and come back in turn for the
    // second meeting.
    const SINGS = { Sevens: [[0, 483], [595, END]], Fives: [[70, 480], [540, END]], Fours: [[140, 600], [700, END]], Threes: [[252, 600], [756, END]] };
    for (const [g, ss] of Object.entries(SINGS)) for (const [a, b] of ss) {
      if (a % M[g] || b % M[g]) no(`the ${g} from ${a} to ${b}: not whole figures`);
      if (a && !Object.entries(SINGS).some(([h, tt]) => h !== g && a % M[h] === 0 && tt.some(([x, y]) => x < a && a < y))) no(`the ${g} come in at ${a} with no one`);
    }
    for (const g of Object.keys(SINGS)) singers.filter((x) => x.group === g).sort((a, b) => a.first - b.first).forEach((x, k, all) => { x.k = k; x.of = all.length; }); // in the order the take brings them in
    // A group's figure never stops for breath: each singer leaves out one figure (of the threes, two), no two
    // of a group at once. Before each meeting and before the chord they breathe one after another as they came
    // in, the last of them CLEAR before it (a figure before the chord), so all sing through it; between, as
    // often as keeps a phrase to about REACH.
    const REACH = 56, HEAD = 21, TAIL = 21, CLEAR = 7, FIGURES = { Sevens: 1, Fives: 1, Fours: 1, Threes: 2 };
    const out = Object.fromEntries(Object.keys(SINGS).map((g) => [g, []]));
    const how = (group) => ({ size: FIGURES[group] * M[group], grid: M[group], head: HEAD, pad: 0, taken: out[group], free: (a, b) => [SPAN, 2 * SPAN].every((x) => b <= x - CLEAR || a >= x + CLEAR) });
    const before = ({ name, group, k, of }, us) => {
      if (unbroken(us).length !== 1) no(`${name}: a line with a hole in it`);
      const m = M[group], size = FIGURES[group] * m, s = us[0][0].at, e = wordSpan(us.at(-1))[1];
      const by = [SPAN, 2 * SPAN].filter((x) => s < x && x < e).map((x) => Math.floor((x - CLEAR) / m) * m);
      if (e === END) by.push(END - m);
      return rested(us, by.map((x) => [x - size * (of - k), x]), how(group));
    };
    const between = ({ group, k, of }, run) => {
      const { size } = how(group), s = run[0][0].at, e = wordSpan(run.at(-1))[1], phrases = Math.ceil((e - s) / REACH);
      if (e === END || phrases < 2) return run;
      const q = (e - s - (phrases - 1) * size) / phrases;
      return rested(run, Array.from({ length: phrases - 1 }, (_, i) => [s + (i + 1) * q + i * size + (k / (of - 1) - 0.5) * q / 4, e - TAIL]), how(group));
    };
    const O = 2; // the arrangement's first beat
    const PULSE = { base: 0.3 }, CHORD = { base: 0.2, bloom: 1, wait: 1, rise: 3 };
    const shaped = [];
    for (const who of singers) {
      const m = M[who.group];
      const given = SINGS[who.group].map(([a, b], i) => WHOLE[who.group].filter((u) => u[0].at >= a + who.k * m * (i ? 1 : 2) && u[0].at < (b === END ? END : b - who.k * m)));
      who.given = given.flat();
      who.sings = given.map((us) => before(who, us));
    }
    for (const who of singers) {
      const m = M[who.group];
      who.sings = who.sings.map((us) => unbroken(us).flatMap((run) => between(who, run)));
      give(one(who.name), moved(who.sings.flat(2), O), 1, PULSE);
      give(one(who.name), [note(O + END, "ah", LAST[who.group], LONG)], 1, CHORD);
      // a singer slips out to breathe and back in; joins under the others and leaves the same way
      const pts = who.sings.flatMap((us, i) => unbroken(us).flatMap((run, j, all) => {
        const s = run[0][0].at, e = wordSpan(run.at(-1))[1];
        const into = j ? [[s, 0.75], [s + m, 1]] : who.k ? [[s, 0.6], [s + 2 * m, 1]] : [[s, 1]];
        const away = j + 1 < all.length ? [[e - m, 1], [e, 0.8]] : e < END ? [[e - 2 * m, 1], [e, who.k ? 0.6 : 0.7]] : [[e, 1]];
        return [...into, ...away].map(([b, x]) => [O + b, x]);
      }));
      if (pts.some(([b], i) => i && b < pts[i - 1][0])) no(`${who.name}: a phrase too short to shape`);
      shaped.push([one(who.name), pts]);
    }
    const key = (u) => `${u[0].at} ${u[0].word} ${u[0].notes[0][0]}`;
    for (const a of singers) {
      const mine = new Set(a.sings.flat()), theirs = new Set(singers.filter((b) => b !== a && b.group === a.group).flatMap((b) => b.sings.flat().map(key)));
      if (a.given.some((u) => !mine.has(u) && !theirs.has(key(u)))) no(`${a.name} breathes with no one on the figure`);
    }
    const g = (pts) => pts.map(([b, x]) => [O + b, x]);
    const LEAN = 1.2; // a figure's first note over the rest of it
    const parts = scored(T, cast(w), sung, {
      bpm: 350,
      close: { chord: O + END, hold: 36, fade: 0.25 },
      swells: [
        // a rise into each meeting; the pairs quieter, so the two figures are heard against each other; the last round from under to the chord
        [/./, g([[0, 0.85], [252, 1], [419, 1.25], [420, 1.3], [428, 1.2], [480, 0.9], [540, 0.85], [600, 0.95], [610, 0.85], [700, 0.95], [756, 1], [839, 1.3], [840, 1.35], [848, 1.25], [980, 1], [1092, 0.9], [1259, 1.35], [1260, 1.4]])],
        // every figure leans on its first note, so where figures start together is heard
        ...Object.keys(SINGS).map((grp) => [new RegExp(`^${grp} `), g(Array.from({ length: END / M[grp] }, (_, i) => i * M[grp]).flatMap((p) => [...(p ? [[p - 0.2, 1]] : []), [p, LEAN], [p + 1, 1]]))]),
        ...shaped,
      ],
    });
    return {
      ...w, parts,
      source: "A piece written for lipservice: four groups repeat figures of three, four, five and seven beats on one fast pulse, so they fall together only every 420 beats. Three such rounds, the middle one in another key, and a held chord to end. Here each group comes in a singer at a time, where its figure falls in with one already going, and every figure leans on its first note. The middle round is taken apart: the sevens and the fives thin out and leave three against four alone, the fives come back, the fours and the threes leave five against seven alone, and then come back in turn for the second meeting. Within a group the singers rest a figure in turn to breathe, so no figure stops. Sung by 16 of the demo's 100 singers. Set 2 semitones lower than the demo, to where every voice here holds its top note.",
    };
  },
  "Comma Pump": (w) => {
    const T = "Comma Pump";
    const no = (what) => { throw new Error(`${T}: ${what}`); };
    const { sung, give } = book(w);
    const one = (name) => new RegExp(`^${name}$`);
    // the piece as its maker wrote it, in beats from its first chord: a chord
    // every CHORD beats, the cadence six times down, the sunken chord, the bell, six times up, "ah men"
    const CHORD = 4, N = 4 * 6, SUNK = N * CHORD, BELL = SUNK + 2 * CHORD + 2, UP = BELL + 2 * CHORD + 1, HOME = UP + N * CHORD, MEN = HOME + CHORD, END = MEN + 3 * CHORD;
    const LEAD = 2, near = (a, b) => Math.abs(a - b) < 2 * GAP;
    const read = (p) => {
      const evs = moved(syllables(p, T), -LEAD);
      return { evs, at: (b, word, k, d) => { const e = evs.find((x) => near(x.at, b)); if (!e || e.word !== word || e.k !== k || e.notes.length !== 1 || !near(e.notes[0][1], d)) no(`${p.name}: no ${word} at beat ${b}`); return e.notes[0][0]; } };
    };
    const tone = (at, word, p, d) => ({ at, word, k: 0, notes: [[p, d]] });
    const bells = w.parts.filter((p) => /^Bell/.test(p.name)).map((p) => {
      const { evs, at } = read(p), first = at(BELL, "ah", 0, 2 * CHORD), home = at(HOME, "ah", 0, CHORD);
      if (evs.length !== 3 || at(MEN, "men", 0, 3 * CHORD) !== home || first !== home) no(`${p.name} is not the bell the piece is made with`);
      return { name: p.name, home };
    });
    // a singer's notes, a chord each: [[from, to, pitch]]
    const singers = w.parts.filter((p) => !/^Bell/.test(p.name)).map((p) => {
      const { evs, at } = read(p), row = (from) => Array.from({ length: N }, (_, i) => [from + i * CHORD, from + (i + 1) * CHORD, at(from + i * CHORD, "alleluia", i % 4, CHORD)]);
      const cells = [...row(0), [SUNK, SUNK + 2 * CHORD, at(SUNK, "ah", 0, 2 * CHORD)], ...row(UP), [HOME, MEN, at(HOME, "ah", 0, CHORD)], [MEN, END, at(MEN, "men", 0, 3 * CHORD)]];
      if (evs.length !== 2 * N + 3 || cells.at(-1)[2] !== cells.at(-2)[2]) no(`${p.name} is not sung as the piece is made`);
      return { name: p.name, section: p.name.replace(/ \d$/, ""), n: +p.name.at(-1), cells };
    });
    if (bells.length + singers.length !== w.parts.length || !bells.length) no("who is the bell");
    const sounds = ({ cells }, t) => (cells.find(([a, b]) => a <= t + 1e-9 && t < b - 1e-9) ?? no(`nothing to sing at beat ${t}`));
    // "alleluia" from `at`, its syllables `lens` beats, on whatever the singer's notes are then
    const word = (who, at, lens) => {
      let t = at;
      return lens.map((len, k) => {
        const notes = [];
        for (let a = t; a < t + len - 1e-9;) {
          const [, to, p] = sounds(who, a), b = Math.min(t + len, to);
          if (notes.length && notes.at(-1)[0] === p) notes.at(-1)[1] += b - a; else notes.push([p, b - a]);
          a = b;
        }
        const e = { at: t, word: "alleluia", k, notes };
        t += len;
        return e;
      });
    };
    // The take's singers begin every word together and breathe together at some of the turns, the ones holding
    // a note over the turn with the rest. Here no one breathes before a note they hold: a singer begins the
    // word on the chord of the four that is theirs (WHERE: down, up), always one their own note moves to, so
    // the word goes round the choir, a few breathe at each chord and never a whole section, and every note
    // held from chord to chord is held. One singer of each part sings the first chord, the soprano the word
    // once over it (a beat a syllable); the rest come in on their chords, and so again for the climb. The
    // words end together on the sunken chord, and on "ah" for the "men".
    const WHERE = { Soprano: [[1, 0], [3, 2], [1, 0], [3, 2]], Alto: [[0, 1], [2, 3], [0, 1], [2, 3]], Tenor: [[0, 1], [2, 2], [3, 3]], Bass: [[0, 0], [1, 1], [2, 3]] };
    const O = 2; // the arrangement's first beat
    const shaped = [], breaths = [];
    for (const who of singers) {
      const [down, up] = WHERE[who.section]?.[who.n - 1] ?? no(`no place for ${who.name}`);
      const sunk = sounds(who, SUNK)[2], home = sounds(who, HOME)[2], said = (at, lens) => ({ evs: word(who, at, lens), peak: at + lens[0] + lens[1] });
      // each: { evs, peak (where it is fullest), on (sung on into the next) }
      const first = [], last = [];
      if (who.n === 1 && down > 1) no(`${who.name} is not there for the first chord`);
      if (who.n === 1 && down) first.push({ ...said(0, [1, 1, 1, 1]), on: true });
      let c = down + (who.n > 1 && !down ? 4 : 0);
      for (; c + 4 <= N + 2; c += 4) first.push(said(c * CHORD, c + 5 === N + 2 ? [CHORD, CHORD, CHORD, 2 * CHORD] : [CHORD, CHORD, CHORD, CHORD]));
      if (N + 2 - c === 2) first.push({ evs: [tone(SUNK, "ah", sunk, 2 * CHORD)], peak: SUNK + 3 });
      else if (N + 2 - c === 3) first.push(said(c * CHORD, [3, 3, 3, 3]));
      for (c = up; c + 4 <= N + 1; c += 4) last.push(said(UP + c * CHORD, [CHORD, CHORD, CHORD, CHORD]));
      if (N + 1 - c === 1) last.push({ evs: [tone(HOME, "ah", home, CHORD)], peak: HOME + 2 });
      else if (N + 1 - c > 1) last.push(said(UP + c * CHORD, Array(4).fill((N + 1 - c) * CHORD / 4)));
      last.at(-1).on = true;
      last.push({ evs: [tone(MEN, "men", home, 3 * CHORD)], peak: MEN });
      if (sylEnd(first.at(-1).evs.at(-1)) !== SUNK + 2 * CHORD || sylEnd(last.at(-2).evs.at(-1)) !== MEN) no(`${who.name}: a word that does not end with the others`);
      const pts = [];
      for (const all of [first, last]) all.forEach((x, i) => {
        const from = x.evs[0].at, to = sylEnd(x.evs.at(-1)), breathes = i + 1 < all.length && !x.on, joined = i && all[i - 1].on;
        if (i && !joined && sounds(who, from)[2] === sounds(who, from - 1)[2]) no(`${who.name} breathes at beat ${from} before a note held`);
        if (!joined) breaths.push([from, who.section]);
        if (breathes) x.evs.at(-1).notes.at(-1)[1] -= GAP;
        give(one(who.name), moved(x.evs, O), 1);
        // a word swells to its third syllable and falls away to the breath
        x.falls = breathes ? 0.72 : x.on && all[i + 1].peak > to ? 0.8 : 1;
        if (x.peak > from) pts.push([from, joined ? all[i - 1].falls : 0.8]);
        pts.push([x.peak, 1], [to, x.falls]);
      });
      if (pts.some(([b], i) => i && b < pts[i - 1][0])) no(`${who.name}: a word too short to shape`);
      shaped.push([one(who.name), pts.map(([b, k]) => [O + b, k])]);
    }
    for (const [at] of breaths) {
      const here = breaths.filter(([b]) => b === at);
      if (here.length > 4 || Object.keys(WHERE).some((sec) => here.filter(([, x]) => x === sec).length === WHERE[sec].length)) no(`too many breathe at beat ${at}`);
    }
    for (const b of bells) give(one(b.name), moved([tone(BELL, "ah", b.home, 2 * CHORD), tone(HOME, "ah", b.home, CHORD), tone(MEN, "men", b.home, 3 * CHORD)], O), 1);
    const g = (pts) => pts.map(([b, k]) => [O + b, k]);
    const parts = scored(T, cast(w), sung, {
      bpm: 72,
      close: { from: O + HOME - 2 * CHORD, chord: O + HOME, slow: 0.8, hold: 5 * CHORD, fade: 0.3 },
      swells: [
        // softer as it sinks, the sunken chord dying; the climb from under to the full "ah men"
        [/^(Soprano|Alto|Tenor|Bass)/, g([[0, 0.95], [2 * CHORD, 1.05], [SUNK, 0.65], [SUNK + 2 * CHORD, 0.4], [UP, 0.5], [UP + 4 * CHORD, 0.6], [HOME - CHORD, 1.2], [HOME, 1.3], [MEN, 1.35], [MEN + CHORD, 1.4]])],
        // the bell struck and dying; with the choir at the end
        [/^Bell/, g([[BELL, 1.1], [BELL + 1.5, 1], [BELL + 2 * CHORD, 0.55], [HOME, 1.1], [MEN, 1.2], [MEN + CHORD, 1.25]])],
        ...shaped,
      ],
    });
    return {
      ...w, parts,
      source: "A piece written for lipservice on the syntonic comma. The choir sings one cadence to \"alleluia\" six times in pure tuning, each singer holding a shared note exactly where it was, and so sinks a little each time: 129 cents in all. Two women at the back then sing the first chord where it began. The cadence sung backwards climbs home again. Here no one breathes before a note they hold: each singer begins the word on the chord where their own note moves, so the word goes round the choir, a few breathe at each chord and the chord never stops, and every held note is held. One singer to a part sings the first chord, the soprano the whole word over it, and the others come in a chord at a time; the words end together on the sunken chord, which dies away; the climb gathers from three voices and grows to the \"ah men\". Sung by 16 of the demo's 108 singers.",
    };
  },
};

// a piece that has been arranged is its arrangement, the take it was made from kept only as its notes
for (const name of Object.keys(SCORED)) if (ARRANGED[name]) throw new Error(`${name} is arranged twice`);
const MADE = { ...ARRANGED, ...SCORED };
for (const name of Object.keys(MADE)) if (!WRITTEN[name]) throw new Error(`no ${name} to arrange`);
export const CHOIRS = Object.fromEntries(Object.entries(WRITTEN).map(([name, c]) => [name, { ...(MADE[name] ? MADE[name](c) : c), loud: Object.fromEntries(ROUTES.map((r) => [r, LEVELS[r][name]])) }]));
