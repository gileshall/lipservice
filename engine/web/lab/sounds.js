// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// Plain words for the engine's sounds. The sounds themselves are the engine's list (ls_bench's
// phones, render.js); here is only how each is said to a reader who knows no phonetic symbols: a
// spelling of the sound and a word it is in. A sound's name is its symbol without a vowel's
// stress digit. A sound of the engine's with no words here stops the lab (`sounds`).

const PLAIN = {
  AA: ["ah", "father"], AE: ["a", "cat"], AH: ["uh", "but"], AO: ["aw", "law"], AW: ["ow", "now"], AY: ["eye", "night"],
  EH: ["e", "bed"], ER: ["er", "bird"], EY: ["ay", "day"], IH: ["i", "bit"], IY: ["ee", "see"], OW: ["oh", "go"],
  OY: ["oy", "joy"], UH: ["oo", "book"], UW: ["oo", "moon"],
  B: ["b", "boy"], CH: ["ch", "church"], D: ["d", "dog"], DH: ["th", "this"], F: ["f", "fan"], G: ["g", "go"],
  HH: ["h", "hat"], JH: ["j", "judge"], K: ["k", "key"], L: ["l", "love"], M: ["m", "moon"], N: ["n", "no"],
  NG: ["ng", "sing"], P: ["p", "pie"], R: ["r", "red"], S: ["s", "see"], SH: ["sh", "she"], T: ["t", "tea"],
  TH: ["th", "thin"], V: ["v", "voice"], W: ["w", "we"], Y: ["y", "yes"], Z: ["z", "zoo"], ZH: ["zh", "measure"],
};
// a vowel's stress digit, in plain words
const STRESS = { 0: "weak", 1: "strong", 2: "half strong" };

export const name = (p) => p.replace(/[012]$/, "");
export const stress = (p) => (/[012]$/.test(p) ? p.at(-1) : null);
export const isVowel = (p) => stress(p) !== null;

// The engine's sounds (its phones, a vowel's stress digit on it) in the order it lists them:
// {vowels, consonants: names; stresses: the digits a vowel takes; all: names}.
export const sounds = (phones) => {
  const vowels = [], consonants = [], stresses = [];
  for (const p of phones) {
    const n = name(p);
    if (!(n in PLAIN)) throw new Error(`${p}: a sound of the engine's the lab has no plain words for`);
    const into = isVowel(p) ? vowels : consonants;
    if (!into.includes(n)) into.push(n);
    if (isVowel(p) && !stresses.includes(stress(p))) stresses.push(stress(p));
  }
  for (const s of stresses) if (!(s in STRESS)) throw new Error(`stress ${s}: the lab has no plain word for it`);
  return { vowels, consonants, stresses: stresses.sort(), all: [...vowels, ...consonants] };
};

const plain = (p) => {
  const w = PLAIN[name(p)];
  if (!w) throw new Error(`${p}: not a sound the engine has`);
  return w;
};
// "ah"
export const say = (p) => plain(p)[0];
// "father"
export const asIn = (p) => plain(p)[1];
// "ah" as in father; a vowel that is not strong says so
export const cue = (p) => `"${say(p)}" as in ${asIn(p)}${isVowel(p) && stress(p) !== "1" ? `, ${STRESS[stress(p)]}` : ""}`;
export const stressWord = (digit) => STRESS[digit];
