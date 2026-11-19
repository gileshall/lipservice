// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A part performed: the song song.js writes, sung as the page's choirs and the plugin sing a
// part (web/perform.js perform(), plugin/src/worker.rs prepare()): each phrase a few frames off
// the beat, the pitch a few cents off, breaths taken in the rests, with the part's marks
// deciding a rest's breath where they are. No engine and nothing of the page's here: perform.js
// and room.js are handed in (`web`), since the page serves them from elsewhere than the repo
// keeps them.

import * as P from "./part.js";

const ATTEMPTS = 14; // perform.js's own

// The engine's style for a part's singer (lipservice.js singer()), its vibrato drawn for the
// singer as choirs.js vibrato() and the plugin's Sheet::vibrato draw it. `motion`: the index of
// the singer's motion model, or -1.
export function style(web, singer, motion) {
  const r = web.rng(`vibrato ${singer.seed}`);
  const [depth, hz, delay] = [r.between(0.15, 0.35), r.between(4.8, 6.0), r.between(0.2, 0.5)];
  return { seed: singer.seed, vibrato: depth * singer.sway, vibratoHz: hz, vibratoDelay: delay, glide: singer.glide, dynamics: singer.dynamics, breathiness: singer.breathiness, diction: singer.diction, motion, motionScale: singer.sway };
}

// The song performed: {singer, text, breaths: [{clip, at}] (at in samples of the part), lag (s),
// shift}. perform.js perform(), but that a phrase the part marks breathes or does not as marked.
//   sung: song.js song(part); sex: the voice's; lib: perform.js library() of the breaths, or null
//   open(text, shift): the engine's singer of a song at a shift, {singer, rests}
// A breath marked that fits no rest is refused, by its beat.
export function perform(web, part, sung, sex, lib, open) {
  const s = part.singer, r = web.rng(`${s.seed} perform`);
  const written = web.parse(sung.text);
  if (written.phrases.length !== sung.phrases.length) throw new Error(`the song's ${written.phrases.length} phrases are not the part's ${sung.phrases.length}`);
  const { song: loose, lag } = web.jitter(written, r, s.jitter);
  const shift = s.shift + r.between(-s.detune, s.detune) / 100;
  const spread = r.between(-s.spread, s.spread);
  const spb = 60 / written.bpm;
  const moment = (j) => (written.phrases[j].start * spb).toFixed(3);
  const want = (j) => (sung.wants.has(j) ? sung.wants.get(j) : web.rng(`breath ${moment(j)}`).uniform() < s.breath);
  const margins = {}, pins = {};
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const p = web.plan(loose, { sex, lib, want, deck: moment, turn: s.seed, margins, pins });
    for (const [j, marked] of sung.wants) {
      if (marked && !p.reqs.some((q) => q.j === j)) throw Object.assign(new Error(`beat ${P.beat(sung.phrases[j].at, part.grid)}: the breath marked does not fit: no breath is short enough for the time the note before can give`), { at: sung.phrases[j].at });
    }
    const o = open(p.text, shift);
    const spans = o.rests.map(([a, b]) => [a / web.FPS, b / web.FPS]);
    const short = web.deficits(spans, p.reqs);
    if (!Object.keys(short).length) {
      const breaths = p.reqs.map(({ rest, clip }) => {
        const [c0, c1] = spans[rest];
        const room = Math.max(0, c1 - c0 - clip.dur - web.BREATH_PRE - 0.03);
        const e = c1 - 0.03 - Math.min(0.04, room);
        return { clip, at: Math.round((e - clip.dur) * web.SR) };
      });
      return { singer: o.singer, text: p.text, breaths, lag: lag + spread, shift };
    }
    o.singer.close();
    for (const { rest, j, room } of p.reqs) {
      if (j in short) margins[j] = room - (spans[rest][1] - spans[rest][0]) + 0.05;
    }
  }
  throw new Error(`the breaths do not fit the rests after ${ATTEMPTS} tries`);
}

// A song with the line that has its singer keep the clock all singers share (sing.rs
// Song::together; worker.js clocked()), after its bpm: the same word has the same consonants in
// every part. For the engine only: perform.js's parse() does not know the line.
export function together(text) {
  const lines = text.split("\n"), k = lines.findIndex((l) => l.trim().split(/\s+/)[0] === "bpm");
  if (k < 0) throw new Error("the song has no bpm line");
  lines.splice(k + 1, 0, "together");
  return lines.join("\n");
}

// The beats a song's text runs: its rests and its notes.
export function beats(text) {
  let n = 0;
  for (const l of text.split("\n")) {
    if (!l || /^(bpm|vibrato) /.test(l)) continue;
    if (l.startsWith("rest ")) n += Number(l.slice(5));
    else for (const g of l.split(" ").slice(1)) for (const x of g.split("+")) n += Number(x.split(":")[1]);
  }
  return n;
}

// The frames of a song's sound before its beat 0: the engine's lead-in and its first word's opening
// consonants, which it sets ahead of the beat (sing.rs plan()). `frames`: the song's length; the
// engine's end after the last note is as long as its lead-in.
export function opening(web, text, frames) {
  const bpm = web.parse(text).bpm, end = Math.round(web.LEAD * web.FPS);
  const lead = frames - end - Math.round(beats(text) * web.FPS * 60 / bpm);
  if (lead < end) throw new Error(`the song's ${frames} frames are fewer than its beats and its lead-in`);
  return lead;
}

// What the engine says of a word it will not sing, with the beats of the words it may mean:
// "little: 3 syllables (L IH1 T AH0 L), 2 notes" names no place.
export function located(message, part, sung) {
  const m = /^(.+?): (\d+) syllables \((.*)\), (\d+) notes$/.exec(message);
  if (!m) return { message, at: null };
  const those = sung.words.filter((w) => w.text === m[1] && w.syllables === Number(m[4]));
  if (!those.length) return { message, at: null };
  return { message: `beat ${those.map((w) => P.beat(w.at, part.grid)).join(", ")}: "${m[1]}" is written in ${m[4]} ${m[4] === "1" ? "syllable" : "syllables"} and sung in ${m[2]} (${m[3]})`, at: those[0].at };
}
