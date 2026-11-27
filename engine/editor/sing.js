// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A part performed: the song song.js writes, as the engine performs a part (engine/src/part.rs,
// lipservice.js perform()) as the page's choirs and the plugin do: each phrase a few frames off
// the beat, the pitch a few cents off, breaths taken in the rests, with the part's marks deciding
// a rest's breath where they are. No engine and nothing of the page's here: room.js's rng and
// perform.js's numbers are handed in (`web`), since the page serves them from elsewhere than the
// repo keeps them.

import * as P from "./part.js";

// The engine's style for a part's singer (lipservice.js singer()), its vibrato drawn for the
// singer as choirs.js vibrato() and the plugin's Sheet::vibrato draw it; its diction as rule
// lines, the singer's switch on what the engine's sung set is. `motion`: the index of the
// singer's motion model, or -1.
export function style(web, singer, motion) {
  const r = web.rng(`vibrato ${singer.seed}`);
  const [depth, hz, delay] = [r.between(0.15, 0.35), r.between(4.8, 6.0), r.between(0.2, 0.5)];
  return { seed: singer.seed, vibrato: depth * singer.sway, vibratoHz: hz, vibratoDelay: delay, glide: singer.glide, dynamics: singer.dynamics, breathiness: singer.breathiness, diction: singer.diction ? [] : ["spoken"], motion, motionScale: singer.sway };
}

// The part as the engine performs it (lipservice.js perform(), ls_perform): the song, the
// singer's numbers and the style it opens with, and the breaths the part marks by phrase (true
// always, false never, null the singer's chance). Its moments run from the phrase's own beat (at
// 0), its timing its own; `clocked`: its singer keeps the clock every singer shares, the same word
// with the same consonants in every part (sing.rs Song::together). Who sings, for diction rules
// written for some singers (for=): the part's title as its name, where it has one, and the voice,
// by its name on the site and the name people call it.
//   sung: song.js song(part); voice: {sex, called}, the site's for the singer's voice; style:
//   style() of the singer
export function asked(part, sung, voice, style, clocked) {
  const s = part.singer;
  const wants = sung.phrases.map((_, j) => (sung.wants.has(j) ? sung.wants.get(j) : null));
  const { vibrato, vibratoHz, vibratoDelay, glide, dynamics, breathiness, diction, motionScale } = style;
  return { song: sung.text, sex: voice.sex, ...(part.title ? { name: part.title } : {}), voice: s.voice, called: voice.called, seed: s.seed, at: 0, shift: s.shift, jitter: s.jitter, detune: s.detune, spread: s.spread, breath: s.breath, together: false, clocked, wants, vibrato, vibratoHz, vibratoDelay, glide, dynamics, breathiness, diction, motionScale };
}

// The frames of a song's sound before its beat 0: the engine's lead-in and its first word's opening
// consonants, which it sets ahead of the beat (sing.rs plan()). `read`: the song as the engine
// reads its text (lipservice.js song()), its tempo and its beats in all; `frames`: the song's
// length. The engine's end after the last note is as long as its lead-in.
export function opening(web, read, frames) {
  const end = Math.round(web.LEAD * web.FPS);
  const lead = frames - end - Math.round(read.beats * web.FPS * 60 / read.bpm);
  if (lead < end) throw new Error(`the song's ${frames} frames are fewer than its beats and its lead-in`);
  return lead;
}

// What the engine says of a word it will not sing, with the beats of the words it may mean:
// "little: 2 syllables (L IH1 T AH1 L), 1 notes" names no place; and of a breath marked that
// does not fit, by its phrase ("phrase 3 (from 0): ..."), said by the beat the phrase starts on.
export function located(message, part, sung) {
  const ph = /^phrase (\d+) \(from 0\): (.*)$/s.exec(message);
  if (ph && sung.phrases[Number(ph[1])]) {
    const at = sung.phrases[Number(ph[1])].at;
    return { message: `beat ${P.beat(at, part.grid)}: ${ph[2]}`, at };
  }
  const m = /^(.+?): (\d+) syllables \((.*)\), (\d+) notes$/.exec(message);
  if (!m) return { message, at: null };
  const those = sung.words.filter((w) => w.text === m[1] && w.syllables === Number(m[4]));
  if (!those.length) return { message, at: null };
  return { message: `beat ${those.map((w) => P.beat(w.at, part.grid)).join(", ")}: "${m[1]}" is written in ${m[4]} ${m[4] === "1" ? "syllable" : "syllables"} and sung in ${m[2]} (${m[3]})`, at: those[0].at };
}
