// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A score: several singers' parts and their mix, as plain text (`lipservice score 1`, SCORE.md).
// Each singer's part is a whole `lipservice part 2` inside it, so a part lifted out of a score is
// a part's file. The mix is a strip a singer (level, pan, mute, solo) and the master: an ordered
// chain of effects and a level after it.
//
// A score is {title, master (dB), chain: [{kind, on, ...its settings}],
//             singers: [{level (dB), pan (-1 left to 1 right), mute, solo, follows?, part}]}.
//
// A singer may follow another: `follows` is {leader (its place in `singers`, from 0), after
// (ticks), keys (semitones)}, and the follower's notes and lanes are then its leader's, `after`
// ticks later and `keys` keys up. Its singer, title and marks are its own. A singer that follows
// none has no `follows`.

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

// ---------------------------------------------------------------- following

// how a link reads: "6 beats later and 12 keys up"
function how(link, grid) {
  const said = [];
  if (link.after) said.push(`${P.beat(link.after, grid)} ${link.after === grid ? "beat" : "beats"} later`);
  if (link.keys) said.push(`${Math.abs(link.keys)} ${Math.abs(link.keys) === 1 ? "key" : "keys"} ${link.keys > 0 ? "up" : "down"}`);
  return said.length ? ` ${said.join(" and ")}` : "";
}

// What is wrong with a link's own numbers, or null.
function wrongLink(f, n) {
  if (!f || typeof f !== "object") return "follows: a leader, the ticks after it and the keys from it";
  const more = Object.keys(f).find((k) => !["leader", "after", "keys"].includes(k));
  if (more) return `follows has no ${more}`;
  if (!Number.isInteger(f.leader) || f.leader < 0 || f.leader >= n) return `follows singer ${Number.isInteger(f.leader) ? f.leader + 1 : f.leader}: there are singers 1 to ${n}`;
  if (!Number.isInteger(f.after) || f.after < 0) return `follows after ${f.after} ticks: a whole number of ticks, 0 or more`;
  if (!Number.isInteger(f.keys) || f.keys < -127 || f.keys > 127) return `follows ${f.keys} keys up: a whole number of keys, -127 to 127`;
  return null;
}

// The notes and lanes a follower has by its link: the leader's moved `after` ticks on and `keys`
// keys up, each pitch named as part.js names a key. Throws where a note goes past MIDI's keys.
export function led(leader, link) {
  return {
    notes: leader.notes.map((n) => {
      const k = P.key(n.pitch) + link.keys;
      if (k < 0 || k > 127) throw new Error(`the leader's ${n.pitch} at beat ${P.beat(n.at, leader.grid)} moved ${link.keys} keys is past MIDI's keys, C-1 to G9`);
      return { ...n, at: n.at + link.after, key: k };
    }),
    lanes: Object.fromEntries(P.LANES.map((l) => [l, leader.lanes[l].map((q) => ({ ...q, at: q.at + link.after }))])),
  };
}

// Where `follower` is not `leader` as `link` says, in words, or null. A note is compared by its
// start, length, key (not its spelling), cents, velocity, release and syllable; a lane by its
// points. The singer's settings, the title and the marks are the follower's own.
export function unlike(leader, follower, link) {
  const want = led(leader, link), grid = leader.grid, b = (t) => P.beat(t, grid);
  const notes = follower.notes;
  for (let i = 0; i < Math.max(want.notes.length, notes.length); i++) {
    const w = want.notes[i], n = notes[i];
    if (!n) return `it has no note where the leader's at beat ${b(w.at - link.after)} comes, beat ${b(w.at)}`;
    if (!w) return `its note at beat ${b(n.at)} is past the leader's last`;
    const ways = [
      ["at", n.at, w.at, "its start", (t) => `beat ${b(t)}`],
      ["ticks", n.ticks, w.ticks, "its length", (t) => `${b(t)} beats`],
      ["key", P.key(n.pitch), w.key, "its key", (k) => P.name(k)],
      ["cents", n.cents, w.cents, "its cents", String],
      ["velocity", n.velocity, w.velocity, "its velocity", String],
      ["release", n.release, w.release, "its release", String],
      ["lyric", n.lyric, w.lyric, "its syllable", (s) => (s === null ? "none" : `"${s}"`)],
    ];
    const off = ways.find(([, a, c]) => a !== c);
    if (off) return `its note at beat ${b(n.at)} is not the leader's at beat ${b(w.at - link.after)}: ${off[3]} is ${off[4](off[1])}, not ${off[4](off[2])} as the leader's makes it`;
  }
  for (const l of P.LANES) {
    const pts = follower.lanes[l], ws = want.lanes[l];
    for (let i = 0; i < Math.max(pts.length, ws.length); i++) {
      const q = pts[i], w = ws[i];
      if (!q) return `its ${l} has no point where the leader's at beat ${b(w.at - link.after)} comes, beat ${b(w.at)}`;
      if (!w) return `its ${l} at beat ${b(q.at)} is past the leader's last point`;
      if (q.at !== w.at || q.value !== w.value || q.line !== w.line) return `its ${l} at beat ${b(q.at)} is not the leader's at beat ${b(w.at - link.after)}`;
    }
  }
  return null;
}

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
  score.singers.forEach((s, i) => {
    if (s.follows === undefined) return;
    const why = wrongLink(s.follows, score.singers.length);
    if (why) throw new Error(`${who(score, i)}: ${why}`);
    const f = s.follows, leader = score.singers[f.leader];
    if (f.leader === i) throw new Error(`${who(score, i)}: follows itself`);
    if (leader.follows !== undefined) throw new Error(`${who(score, i)}: follows ${who(score, f.leader)}, who follows ${who(score, leader.follows.leader)}; a leader follows no one`);
    const said = `${who(score, i)}: follows ${who(score, f.leader)}${how(f, s.part.grid)}, but `;
    let off;
    try {
      off = unlike(leader.part, s.part, f);
    } catch (e) {
      throw new Error(said + e.message);
    }
    if (off) throw new Error(said + off);
  });
}

// ---------------------------------------------------------------- write

const num = (x) => String(x);

export function write(score) {
  check(score);
  const out = [HEAD, score.title ? `title ${score.title}` : "title", "", `master ${num(score.master)}`];
  for (const e of score.chain) out.push(`effect ${e.kind} ${e.on ? "on" : "off"} ${EFFECTS[e.kind].map((s) => `${s.name} ${num(e[s.name])}`).join(" ")}`);
  for (const s of score.singers) {
    out.push("", "singer", `level ${num(s.level)}`, `pan ${num(s.pan)}`, `mute ${s.mute ? 1 : 0}`, `solo ${s.solo ? 1 : 0}`);
    const f = s.follows;
    if (f !== undefined) out.push(`follows ${f.leader + 1}${f.after ? ` after ${P.beat(f.after, s.part.grid)}` : ""}${f.keys ? ` keys ${f.keys}` : ""}`);
    out.push(P.write(s.part).trimEnd());
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
  let link = null; // its follows line, until its part is read
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
      if (link) {
        let after;
        try {
          after = link.after === null ? 0 : P.ticks(link.after, strip.part.grid);
        } catch (e) {
          fail(`follows after ${e.message}`, link.line);
        }
        strip.follows = { leader: link.leader, after, keys: link.keys };
        link = null;
      }
      i = end - 1;
    } else if (what === "follows") {
      if (link) fail("follows given twice");
      const shape = "follows takes the leader's place in the score, then after BEATS where it comes later, then keys N where its notes are N keys up (down below 0)";
      if (!/^[1-9]\d*$/.test(v[0] ?? "")) fail(shape);
      link = { leader: Number(v[0]) - 1, after: null, keys: 0, line: i };
      let k = 1;
      if (v[k] === "after") {
        if (v[k + 1] === undefined) fail(shape);
        link.after = v[k + 1];
        k += 2;
      }
      if (v[k] === "keys") {
        if (!/^-?\d+$/.test(v[k + 1] ?? "")) fail(shape);
        link.keys = Number(v[k + 1]) + 0;
        k += 2;
      }
      if (k !== v.length) fail(shape);
    } else if (STRIP.includes(what)) {
      if (v.length !== 1) fail(`${what} takes one value`);
      if (what in strip) fail(`${what} given twice`);
      strip[what] = what === "mute" || what === "solo" ? flag(v[0], what) : value(v[0], what);
      const why = wrongStrip({ level: 0, pan: 0, mute: false, solo: false, ...strip });
      if (why) fail(why);
    } else fail(`"${what}": a singer is level, pan, mute, solo, follows where it follows another, and then its part`);
  }
  close();
  const missing = [...(score.title === null ? ["title"] : []), ...(score.master === null ? ["master"] : [])];
  if (missing.length) throw new Error(`the score has no ${missing.join(", ")}`);
  check(score);
  return score;
}
