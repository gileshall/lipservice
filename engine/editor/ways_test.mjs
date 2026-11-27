// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// ways.js: each way whole and safe to sing, written over a singer and known again, its unheard
// settings named; another singer of a voice. node ways_test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as P from "./part.js";
import { WAYS, KEYS, HEARD, check as sound, apply, which, unheard, another } from "./ways.js";
import { EXAMPLES } from "./examples/make.mjs";
import { CHOIRS } from "../web/choirs.js";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const source = readFileSync(here("ways.js"), "utf8");

// every way whole and safe
{
  check(WAYS.length >= 8, `${WAYS.length} ways`);
  check(WAYS.every((w) => threw(() => sound(w)) === null), "every way is one a singer can take");
  check(new Set(WAYS.map((w) => w.name)).size === WAYS.length, "no two ways share a name");
  check(WAYS.every((w) => equal(Object.keys(w.settings).sort(), [...KEYS].sort())), "every way says every setting of how a part is sung, and nothing else");
  check(WAYS.every((w) => !("voice" in w.settings) && !("seed" in w.settings) && !("shift" in w.settings)), "no way sets the voice, the seed or the shift");
  check(WAYS.every((w) => typeof w.settings.sway === "number" && w.settings.sway > 0), "no way writes sway 0");
  check(WAYS.every((w) => typeof w.settings.motion === "string" && w.settings.motion !== "-"), "no way writes motion -, so none leaves its vibrato to the drawn line");
  const same = WAYS.flatMap((a, i) => WAYS.slice(i + 1).filter((b) => KEYS.every((k) => a.settings[k] === b.settings[k])).map((b) => `${a.name} and ${b.name}`));
  check(same.length === 0, `no two ways sing alike${same.length ? `: ${same.join("; ")}` : ""}`);
  check(WAYS.every((w) => w.said.trim() && !/\n/.test(w.said) && w.name.trim() && !/\n/.test(w.name)), "every way has a name and a line saying what it does");
  check(WAYS.every((w) => !/auto-?tun|robot|whisper/i.test(w.name)), "no way is named for autotune, robots or a whisper");
  check(!/[\u2013\u2014]|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(source), "no dashes but hyphens, no emoji, in ways.js");
  check(Object.isFrozen(WAYS) && WAYS.every((w) => Object.isFrozen(w) && Object.isFrozen(w.settings)), "the ways cannot be changed by whoever uses them");
}

// written over a singer, known again
{
  const singers = [P.singer("6147", 3), P.singer("8088", 0), { ...P.singer("2428", 4294967295), shift: -12 }, ...Object.values(EXAMPLES).map((f) => f().singer)];
  let all = true, kept = true, back = true, untouched = true;
  for (const s of singers) {
    const was = { ...s };
    for (const w of WAYS) {
      const t = apply(s, w);
      all &&= which(t) === w;
      kept &&= t.voice === s.voice && t.seed === s.seed && t.shift === s.shift;
      const part = { ...P.blank(t), notes: [] };
      back &&= which(P.read(P.write(part)).singer) === w;
    }
    untouched &&= equal(s, was);
  }
  check(all, "every way, written over every singer, is known again as itself");
  check(kept, "and leaves the voice, the seed and the shift as they were");
  check(back, "and is known again after the part is written as text and read");
  check(untouched, "the singer given is left as it was");
  check(which(P.singer("6147", 7)) === WAYS[0] && WAYS[0].name === "As the choirs sing", "a new singer sings as the choirs do");
  const off = { ...apply(P.singer("6147"), WAYS[2]), glide: 10 };
  check(which(off) === null, "a singer one setting off every way has none");
  check(which(P.singer("6147"), []) === null, "and none of no ways");
  const airy = WAYS.find((w) => w.name === "Airy and close");
  check(airy.settings.breathiness > 1 && /not a whisper/.test(airy.said), "the airy way has the breath up and says it is not a whisper");
}

// ways refused, by what is wrong and by name
{
  const base = WAYS[0], mk = (settings, more = {}) => ({ name: "Mine", said: "a way of my own", ...more, settings: { ...base.settings, ...settings } });
  const s = P.singer("6147", 3);
  const said = (w) => threw(() => apply(s, w));
  check(/"Mine": sway 0 sings a held note as a flat tone/.test(said(mk({ sway: 0 }))), "sway 0 refused, by the way's name");
  check(/"Mine": motion -/.test(said(mk({ motion: null }))) && /"Mine": motion -/.test(said(mk({ motion: "-" }))), "motion - refused, written either way");
  check(/leaves the voice alone/.test(said(mk({ voice: "8088" }))), "a way with a voice refused");
  check(/leaves the seed alone/.test(said(mk({ seed: 9 }))), "a way with a seed refused");
  check(/leaves the shift alone: it moves the notes/.test(said(mk({ shift: 12 }))), "a way with a shift refused");
  check(/loudness: no such setting of a way/.test(said(mk({ loudness: 2 }))), "a setting no singer has refused");
  const short = mk({});
  delete short.settings.glide;
  delete short.settings.breath;
  check(/does not say its glide, breath/.test(said(short)), "a way that leaves settings unsaid refused, naming them");
  check(/"Mine": glide 0: a whole number of frames/.test(said(mk({ glide: 0 }))), "a value a part cannot hold refused, as part.js says it");
  check(/"Mine": breath 2: a chance/.test(said(mk({ breath: 2 }))), "a breath past 1 refused");
  check(/with no name: a way has a name/.test(said({ said: "x", settings: base.settings })), "a way with no name refused");
  check(/"Mine": a way says in a line/.test(said({ name: "Mine", said: " ", settings: base.settings })), "a way that says nothing refused");
  check(/seed -1/.test(threw(() => apply({ ...s, seed: -1 }, base))), "a singer a part cannot hold refused");
}

// what the choirs sing with, and the ways that go past it
{
  const seen = {};
  const add = (k, v) => (seen[k] ??= []).push(v);
  for (const c of Object.values(CHOIRS)) {
    const st = c.style;
    for (const p of c.parts) {
      const k = { dynamics: 1, breathiness: 1, ...p.scale };
      add("motion", p.motion ?? st.motion);
      add("dynamics", st.dynamics * k.dynamics);
      add("breathiness", st.breathiness * k.breathiness);
    }
    for (const key of ["glide", "jitter", "detune", "breath"]) add(key, st[key]);
    // the choirs' diction as rule lines, read as the editor's switch: none on, spoken off;
    // lines the switch cannot say are kept as they are, and fail the check below
    const flag = (lines) => (equal(lines, []) ? true : equal(lines, ["spoken"]) ? false : lines);
    add("diction", flag(st.diction ?? []));
    for (const p of c.parts) if (p.diction !== undefined) add("diction", flag(p.diction));
    add("spread", (st.together ?? true) ? 0 : st.spread);
  }
  const span = (xs) => [Math.min(...xs), Math.max(...xs)];
  const derived = {
    glide: span(seen.glide), dynamics: span(seen.dynamics), breathiness: span(seen.breathiness), jitter: span(seen.jitter),
    detune: span(seen.detune), spread: span(seen.spread), breath: span(seen.breath),
  };
  const mine = Object.fromEntries(Object.keys(derived).map((k) => [k, HEARD[k]]));
  check(equal(mine, derived), `HEARD's numbers are the choirs' own${equal(mine, derived) ? "" : `: the choirs sing ${JSON.stringify(derived)}`}`);
  check(equal([...new Set(seen.motion)].sort(), [...HEARD.motion].sort()), `HEARD's motions are the choirs' own: ${[...new Set(seen.motion)].join(", ")}`);
  check(equal([...new Set(seen.diction.map((d) => JSON.stringify(d)))].map((d) => JSON.parse(d)), HEARD.diction), `HEARD's diction is the choirs' own: ${JSON.stringify([...new Set(seen.diction.map((d) => JSON.stringify(d)))])}`);
  check(Object.keys(HEARD).length === KEYS.length && KEYS.every((k) => k in HEARD), "HEARD says every setting a way sets");
  check(unheard(WAYS[0].settings).length === 0, "the choirs' way is all heard");
  const flagged = WAYS.filter((w) => unheard(w.settings).length);
  const lines = source.split("\n");
  const commented = (w) => {
    const i = lines.findIndex((l) => l.trim().startsWith(`way(${JSON.stringify(w.name)},`));
    return i > 0 && lines[i - 1].trim() === `// not yet heard: ${unheard(w.settings).join(", ")}`;
  };
  const bad = flagged.filter((w) => !commented(w)).map((w) => w.name);
  check(bad.length === 0, `every way past what the choirs sing says so above it, naming what${bad.length ? `: not ${bad.join(", ")}` : ""}`);
  const stray = (source.match(/\/\/ not yet heard:/g) ?? []).length;
  check(stray === flagged.length, "and no way within it says it is unheard");
  check(equal(unheard({ glide: 30, diction: false, motion: null, sway: 1 }), ["glide 30", "diction 0", "motion -"]), "unheard settings named as a part writes them");
}

// another singer of a voice
{
  check(another(3) === 4, "the next seed");
  check(another(3, [4, 5, 9]) === 6, "past the seeds in use");
  check(another(3, new Set([4])) === 5, "the seeds in use given as a set");
  check(another(3, [3]) === 4 && another(3, [3, 4]) === 5, "never the seed it was");
  check(another(4294967295) === 0 && another(4294967295, [0, 1]) === 2, "past the last seed back to 0");
  check(another(17, [18, 20]) === another(17, [18, 20]), "the same each time");
  let s = 0, run = new Set([0]);
  for (let i = 0; i < 50; i++) { s = another(s, run); run.add(s); }
  check(run.size === 51, "a run of fifty, each new");
  check(/seed -1: a whole number/.test(threw(() => another(-1))) && /seed 2.5/.test(threw(() => another(2.5))) && /seed 4294967296/.test(threw(() => another(4294967296))), "a seed that is not one refused");
  check(/a seed in use, x/.test(threw(() => another(1, ["x"]))), "a seed in use that is not one refused");
  check(apply({ ...P.singer("6147", 3), seed: another(3) }, WAYS[1]).seed === 4, "a way and another singer go together");
}

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
