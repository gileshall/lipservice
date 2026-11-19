// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A score: several singers' parts and their mix, as plain text (`lipservice score 1`, SCORE.md).
// Each singer's part is a whole `lipservice part 2` inside it, so a part lifted out of a score is
// a part's file. The mix is a strip a singer (level, pan, mute, solo) and the master: an ordered
// chain of effects and a level after it.
//
// A score is {title, master (dB), chain: [{kind, on, ...its settings}],
//             singers: [{level (dB), pan (-1 left to 1 right), mute, solo, part}]}.

import * as P from "./part.js";

export const HEAD = "lipservice score 1";
export const MOST = 16; // singers a score holds: the speaker has an output each
export const LEVEL = { min: -60, max: 12 };

// The effects a chain is made of, and each one's settings in the order written:
// name, least, most, what it is when added, its unit, the step a pull moves it by, and `log`
// where a pull moves it by ratio.
const S = (name, min, max, def, unit, step, log = false) => ({ name, min, max, def, unit, step, log });
export const EFFECTS = {
  gain: [S("db", -24, 24, 0, "dB", 0.1)],
  filter: [S("lowcut", 20, 2000, 80, "Hz", 1, true), S("highcut", 500, 11500, 11500, "Hz", 1, true)],
  eq: [S("low", -18, 18, 0, "dB", 0.1), S("lowhz", 40, 600, 120, "Hz", 1, true), S("mid", -18, 18, 0, "dB", 0.1), S("midhz", 200, 8000, 1000, "Hz", 1, true), S("q", 0.3, 8, 1, "", 0.01, true), S("high", -18, 18, 0, "dB", 0.1), S("highhz", 1500, 11000, 6000, "Hz", 1, true)],
  compressor: [S("threshold", -60, 0, -18, "dB", 0.1), S("ratio", 1, 20, 3, ":1", 0.1, true), S("knee", 0, 40, 6, "dB", 0.1), S("attack", 0, 200, 10, "ms", 0.1), S("release", 10, 1000, 150, "ms", 1, true), S("makeup", 0, 24, 0, "dB", 0.1)],
  echo: [S("ms", 20, 1500, 375, "ms", 1, true), S("feedback", 0, 0.9, 0.35, "", 0.01), S("mix", 0, 1, 0.2, "", 0.01)],
  reverb: [S("seconds", 0.2, 8, 1.8, "s", 0.01, true), S("predelay", 0, 150, 20, "ms", 1), S("damp", 500, 11500, 6000, "Hz", 1, true), S("mix", 0, 1, 0.2, "", 0.01)],
  limiter: [S("ceiling", -12, 0, -1, "dB", 0.1), S("release", 10, 500, 80, "ms", 1, true)],
};

const NUMBER = /^-?\d+(\.\d+)?$/;
const number = (v) => typeof v === "number" && Number.isFinite(v) && NUMBER.test(String(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- making

export const strip = () => ({ level: 0, pan: 0, mute: false, solo: false });
// an effect as it is when added
export function effect(kind) {
  if (!EFFECTS[kind]) throw new Error(`"${kind}": no such effect; there are ${Object.keys(EFFECTS).join(", ")}`);
  return { kind, on: true, ...Object.fromEntries(EFFECTS[kind].map((s) => [s.name, s.def])) };
}
// the chain a new score has: the sum of its singers held under full scale
export const chain = () => [effect("limiter")];
// a score of one part, mixed as a new score is
export const of = (part) => ({ title: part.title, master: 0, chain: chain(), singers: [{ ...strip(), part }] });

// ---------------------------------------------------------------- check

function wrongEffect(e) {
  const spec = EFFECTS[e?.kind];
  if (!spec) return `"${e?.kind}": no such effect; there are ${Object.keys(EFFECTS).join(", ")}`;
  if (typeof e.on !== "boolean") return `${e.kind}: on or off`;
  for (const s of spec) {
    if (!number(e[s.name]) || e[s.name] < s.min || e[s.name] > s.max) return `${e.kind} ${s.name} ${e[s.name]}: ${s.min} to ${s.max}`;
  }
  const more = Object.keys(e).find((k) => k !== "kind" && k !== "on" && !spec.some((s) => s.name === k));
  return more ? `${e.kind} has no ${more}` : null;
}

function wrongStrip(s) {
  if (!number(s.level) || s.level < LEVEL.min || s.level > LEVEL.max) return `level ${s.level}: ${LEVEL.min} to ${LEVEL.max} dB`;
  if (!number(s.pan) || s.pan < -1 || s.pan > 1) return `pan ${s.pan}: -1 (left) to 1 (right)`;
  if (typeof s.mute !== "boolean") return "mute: 0 or 1";
  if (typeof s.solo !== "boolean") return "solo: 0 or 1";
  return null;
}

// who a singer is, for an error: its place and its part's title
const who = (score, i) => `singer ${i + 1}${score.singers[i].part.title ? ` (${score.singers[i].part.title})` : ""}`;

// Whether the text can hold `score`: throws what is wrong with it. The singers keep one time:
// each part has the first's grid, tempos and meters.
export function check(score) {
  if (typeof score.title !== "string" || score.title !== score.title.trim() || /[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(score.title)) throw new Error("the title: one line of text, no space at its ends");
  if (!number(score.master) || score.master < LEVEL.min || score.master > LEVEL.max) throw new Error(`master ${score.master}: ${LEVEL.min} to ${LEVEL.max} dB`);
  for (const e of score.chain) {
    const why = wrongEffect(e);
    if (why) throw new Error(why);
  }
  if (score.singers.length < 1 || score.singers.length > MOST) throw new Error(`${score.singers.length} singers: a score has 1 to ${MOST}`);
  score.singers.forEach((s, i) => {
    const why = wrongStrip(s);
    if (why) throw new Error(`${who(score, i)}: ${why}`);
    try {
      P.check(s.part);
    } catch (e) {
      throw new Error(`${who(score, i)}: ${e.message}`);
    }
    const first = score.singers[0].part;
    for (const k of ["grid", "tempo", "meter"]) {
      if (!same(s.part[k], first[k])) throw new Error(`${who(score, i)}: its ${k} is not the first singer's; a score's singers keep one time`);
    }
  });
}

// ---------------------------------------------------------------- write

const num = (x) => String(x);

export function write(score) {
  check(score);
  const out = [HEAD, score.title ? `title ${score.title}` : "title", "", `master ${num(score.master)}`];
  for (const e of score.chain) out.push(`effect ${e.kind} ${e.on ? "on" : "off"} ${EFFECTS[e.kind].map((s) => `${s.name} ${num(e[s.name])}`).join(" ")}`);
  for (const s of score.singers) {
    out.push("", "singer", `level ${num(s.level)}`, `pan ${num(s.pan)}`, `mute ${s.mute ? 1 : 0}`, `solo ${s.solo ? 1 : 0}`, P.write(s.part).trimEnd());
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- read

export const is = (text) => typeof text === "string" && text.replace(/^﻿/, "").split("\n")[0].replace(/\r$/, "") === HEAD;

export function read(text) {
  if (typeof text !== "string") throw new Error("a score is text");
  const lines = text.replace(/^﻿/, "").split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines[0] !== HEAD) throw new Error(`not a lipservice score this reads: its first line is not "${HEAD}"`);
  const score = { title: null, master: null, chain: [], singers: [] };
  let strip = null, begun = 0; // the singer being read, and the line its `singer` is on
  const STRIP = ["level", "pan", "mute", "solo"];
  let i = 1;
  const fail = (why, at = i) => { throw new Error(`line ${at + 1}: ${why}`); };
  const value = (s, of) => {
    if (!NUMBER.test(s)) fail(`${s}: ${of} is a number`);
    return Number(s);
  };
  const flag = (s, of) => (s === "1" ? true : s === "0" ? false : fail(`${of} ${s}: 0 or 1`));
  const close = () => {
    if (strip && !strip.part) fail(`the singer has no part: a line "${P.HEAD}" and the part after it`, begun);
  };
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [what, ...v] = line.split(/[ \t]+/);
    if (line === "singer") {
      close();
      strip = {};
      begun = i;
      score.singers.push(strip);
    } else if (strip === null) {
      if (what === "title") {
        if (score.title !== null) fail("title given twice");
        score.title = line.slice(5).trim();
      } else if (what === "master") {
        if (v.length !== 1) fail("master takes its level in dB");
        if (score.master !== null) fail("master given twice");
        score.master = value(v[0], "the master's level");
      } else if (what === "effect") {
        const spec = EFFECTS[v[0]];
        if (!spec) fail(`"${v[0] ?? ""}": no such effect; there are ${Object.keys(EFFECTS).join(", ")}`);
        if (v[1] !== "on" && v[1] !== "off") fail(`${v[0]}: on or off after its name`);
        const e = { kind: v[0], on: v[1] === "on" };
        const shape = spec.map((s) => `${s.name} N`).join(" ");
        if (v.length !== 2 + 2 * spec.length) fail(`${v[0]} takes: ${shape}`);
        spec.forEach((s, k) => {
          if (v[2 + 2 * k] !== s.name) fail(`${v[0]} takes: ${shape}`);
          e[s.name] = value(v[3 + 2 * k], s.name);
        });
        const why = wrongEffect(e);
        if (why) fail(why);
        score.chain.push(e);
      } else fail(`"${what}": no such line before a score's first singer`);
    } else if (line === P.HEAD) {
      const missing = STRIP.filter((k) => !(k in strip));
      if (missing.length) fail(`the singer has no ${missing.join(", ")}`, begun);
      // the part: to the next singer, or the file's end
      let end = i + 1;
      while (end < lines.length && lines[end].trim() !== "singer") end++;
      try {
        strip.part = P.read(lines.slice(i, end).join("\n"));
      } catch (e) {
        const m = /^line (\d+): (.*)$/s.exec(e.message);
        throw new Error(m ? `line ${i + Number(m[1])}: ${m[2]}` : `line ${i + 1}: ${e.message}`);
      }
      i = end - 1;
    } else if (STRIP.includes(what)) {
      if (v.length !== 1) fail(`${what} takes one value`);
      if (what in strip) fail(`${what} given twice`);
      strip[what] = what === "mute" || what === "solo" ? flag(v[0], what) : value(v[0], what);
      const why = wrongStrip({ level: 0, pan: 0, mute: false, solo: false, ...strip });
      if (why) fail(why);
    } else fail(`"${what}": a singer is level, pan, mute, solo and then its part`);
  }
  close();
  const missing = [...(score.title === null ? ["title"] : []), ...(score.master === null ? ["master"] : [])];
  if (missing.length) throw new Error(`the score has no ${missing.join(", ")}`);
  check(score);
  return score;
}
