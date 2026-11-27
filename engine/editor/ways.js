// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// Ways to sing: a singer's settings in one, named by what they do. A way says how a part is sung
// (join, glide, dynamics, breathiness, diction, motion, sway, jitter, detune, spread, breath) and
// never who sings it or what notes: the voice, the seed and the shift are the singer's own, so a
// way sounds the same way on every voice. No DOM: the page and node both use it.
//
// A way never writes sway 0 or motion -: sway 0 sings a held note as a flat tone, and under - the
// vibrato drawn under the notes decides, which a way cannot see.
//
// A way cannot set the drawn vibrato's rate or how late in a note it starts. The seed draws both
// (sing.js style()), and setting them needs singer lines PART.md does not have yet (`vibratorate`,
// `vibratodelay`, each a number or - for the seed's draw). They would act only under motion -.
//
// Breathiness adds breath noise to the sung vowels and leaves the voice voiced: an airy voice,
// never a whisper.

import * as P from "./part.js";

// what a way sets, in the order a part writes them
export const KEYS = ["join", "glide", "dynamics", "breathiness", "diction", "motion", "sway", "jitter", "detune", "spread", "breath"];
// what a way leaves alone
const OWN = { voice: "the voice alone", seed: "the seed alone", shift: "the shift alone: it moves the notes" };

// What the site's choirs sing with (web/choirs.js CHOIRS, as arrange() sings them): a number's
// lowest and highest, or the values taken. Their singers keep time together, so their spread is
// sung as 0. Their songs write a rest wherever one note does not run into the next, as join 0.
// A setting outside these has not been heard.
export const HEARD = {
  join: [0, 0],
  glide: [9, 14],
  dynamics: [0.8, 1.5],
  breathiness: [0.3, 0.35],
  diction: [true],
  motion: ["vibrato", "straight"],
  sway: [1, 1],
  jitter: [0, 2],
  detune: [0, 14],
  spread: [0, 0],
  breath: [0.8, 1],
};
const PICKED = ["diction", "motion"];

// a setting as a part's text writes it
const told = (k, v) => `${k} ${k === "diction" ? (v ? "1" : "0") : k === "motion" ? (v ?? "-") : v}`;

// The settings of `settings` the choirs do not sing with, as a part writes them ("glide 30").
export function unheard(settings) {
  return KEYS.filter((k) => k in settings).filter((k) => {
    const v = settings[k], h = HEARD[k];
    return PICKED.includes(k) ? !h.includes(v) : v < h[0] || v > h[1];
  }).map((k) => told(k, settings[k]));
}

// The choirs' way, which every way starts from.
const CHOIRS = Object.fromEntries(KEYS.map((k) => [k, P.singer("x")[k]]));
const way = (name, said, changes) => Object.freeze({ name, said, settings: Object.freeze({ ...CHOIRS, ...changes }) });

export const WAYS = Object.freeze([
  way("As the choirs sing", "The site's choirs' own way: the trained singers' vibrato, a little loose in time and tune, breaths taken by chance in the rests.", {}),
  way("Straight choral tone", "The trained singers' straight tone, a slower slide from note to note, close in tune: the barbershop tag's way.", { motion: "straight", glide: 14, detune: 2 }),
  // not yet heard: dynamics 2.2, motion wide, sway 1.3
  way("Wide vibrato, big swells", "The trained singers' wide vibrato a third larger, and long and high notes swelled much more.", { motion: "wide", sway: 1.3, dynamics: 2.2 }),
  // not yet heard: motion wide, sway 1.8
  way("A wide wobble", "The trained singers' wide vibrato at nearly twice its size, a slower slide, looser in tune.", { motion: "wide", sway: 1.8, glide: 12, detune: 8 }),
  // not yet heard: jitter 6, spread 0.03
  way("Loose, as a crowd sings", "Each phrase and note further off the beat and the pitch further off, the part's start off by up to 30 ms.", { jitter: 6, detune: 10, spread: 0.03, breath: 0.9 }),
  // not yet heard: dynamics 0.6, breathiness 1.4, sway 0.6
  way("Airy and close", "Much more breath in the tone, little swell, a smaller vibrato. The voice stays voiced: airy, not a whisper.", { breathiness: 1.4, dynamics: 0.6, sway: 0.6, glide: 12 }),
  // not yet heard: join 0.5, glide 30
  way("Sliding", "Slow slides from note to note, 300 ms each, and gaps of half a beat or less sung through.", { glide: 30, join: 0.5 }),
  // not yet heard: glide 3, breath 0.3
  way("Clipped", "Quick steps from note to note, 30 ms each, and few breaths taken by chance.", { glide: 3, breath: 0.3 }),
  // not yet heard: join 1, breath 0
  way("Legato, breaths only where marked", "Gaps of a beat or less sung through, and no breath taken by chance: only a breath mark gives one.", { join: 1, breath: 0 }),
  // not yet heard: glide 6, dynamics 0.5, diction 0, jitter 3
  way("Recited", "Plain and even, for words chanted on one note: straight tone, quick slides, little swell, vowels stressed as in speech.", { motion: "straight", glide: 6, dynamics: 0.5, diction: false, jitter: 3 }),
]);

// Whether `w` is a way: throws what is wrong with it, by its name.
export function check(w) {
  const name = w && typeof w.name === "string" && w.name.trim() ? w.name : null;
  const no = (why) => { throw new Error(`the way ${name === null ? "with no name" : `"${name}"`}: ${why}`); };
  if (name === null) no("a way has a name");
  if (typeof w.said !== "string" || !w.said.trim()) no("a way says in a line what it does");
  const s = w.settings;
  if (!s || typeof s !== "object") no("a way has its settings");
  for (const k of Object.keys(s)) {
    if (k in OWN) no(`a way leaves ${OWN[k]}`);
    if (!KEYS.includes(k)) no(`${k}: no such setting of a way`);
  }
  const missing = KEYS.filter((k) => !(k in s));
  if (missing.length) no(`it does not say its ${missing.join(", ")}`);
  if (s.sway === 0) no("sway 0 sings a held note as a flat tone");
  if (s.motion === null || s.motion === "-") no("motion - leaves the vibrato to the line drawn under the notes, which a way cannot see: a way names a trained singer's motion");
  const why = (() => {
    try { P.check(P.blank({ ...P.singer("x"), ...s })); return null; } catch (e) { return e.message; }
  })();
  if (why) no(why);
}

// The singer's settings with the way's written over them; its voice, seed and shift as they were.
export function apply(singer, w) {
  check(w);
  P.check(P.blank(singer));
  return { ...singer, ...w.settings };
}

// The way of `ways` whose settings the singer has now, or null.
export function which(singer, ways = WAYS) {
  return ways.find((w) => KEYS.every((k) => singer[k] === w.settings[k])) ?? null;
}

const TOP = 4294967295;
const seedly = (s) => Number.isInteger(s) && s >= 0 && s <= TOP;

// A seed for another singer of the same voice: the next seed after `seed` that is not in `used`,
// past the last back to 0. Seeds in a row are the motion's trained singers in a row (sing.rs
// Motion::singer), each with its own drawn vibrato, timing and breaths.
export function another(seed, used = []) {
  if (!seedly(seed)) throw new Error(`seed ${seed}: a whole number, 0 to ${TOP}`);
  const taken = new Set(used);
  for (const s of taken) if (!seedly(s)) throw new Error(`a seed in use, ${s}: a whole number, 0 to ${TOP}`);
  for (let i = 1; i <= TOP; i++) {
    const s = (seed + i) % (TOP + 1);
    if (!taken.has(s)) return s;
  }
  throw new Error("every seed but this one is in use");
}
