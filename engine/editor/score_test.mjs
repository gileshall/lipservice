// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// score.js: a score reads back as written, and what is wrong with a file is refused by its line.
//
//     node score_test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as P from "./part.js";
import * as S from "./score.js";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const refused = (f, like) => { try { f(); return false; } catch (e) { return like.test(e.message) || (console.log(`     said: ${e.message}`), false); } };
const here = (name) => fileURLToPath(new URL(name, import.meta.url));

const mary = P.read(readFileSync(here("examples/mary.part"), "utf8"));
const one = S.of(mary);
check(one.title === mary.title && one.singers.length === 1 && equal(one.chain, [S.effect("limiter")]) && one.master === 0, "a score of one part: its title, a strip, a limiter on the master");
check(equal(S.read(S.write(one)), one), "it reads back as written");
check(S.write(S.read(S.write(one))) === S.write(one) && S.is(S.write(one)) && !S.is(P.write(mary)), "and writes again the same; a score's text is told from a part's");

// every effect, every setting off its default, three singers
const second = { ...mary, title: "Ben", singer: { ...mary.singer, voice: "2428", shift: -12 }, notes: mary.notes.slice(0, 5) };
const third = { ...P.blank(P.singer("6345"), mary.grid), title: "", tempo: mary.tempo, meter: mary.meter };
const full = {
  title: "Every line of a score: étude, 100%",
  master: -2.5,
  chain: Object.keys(S.EFFECTS).map((kind, i) => ({ ...S.effect(kind), on: i % 2 === 0, ...Object.fromEntries(S.EFFECTS[kind].map((s) => [s.name, s.log ? Math.round(Math.sqrt(s.min * s.max) * 100) / 100 : Math.round((s.min + (s.max - s.min) * 0.25) * 100) / 100])) })),
  singers: [{ level: -3.5, pan: -0.5, mute: false, solo: true, part: mary }, { level: 2, pan: 0.75, mute: true, solo: false, part: second }, { ...S.strip(), part: third }],
};
const text = S.write(full);
check(equal(S.read(text), full) && S.write(S.read(text)) === text, "a score with every effect and three singers reads back as written");
check(text.split("\n").filter((l) => l === P.HEAD).length === 3 && text.includes("\neffect compressor off threshold -45 ratio 4.47 knee 10 attack 50 release 100 makeup 6\n"), "each part whole inside it; an effect is a line of its settings by name");
const lifted = text.slice(text.indexOf(P.HEAD), text.indexOf("\nsinger", text.indexOf(P.HEAD)));
check(equal(P.read(lifted), mary), "a part lifted out of the score's text is the part");
check(equal(S.read(text.replace(/\n/g, "\r\n")), full), "a file with a carriage return a line reads the same");

// refusals, by line
const lines = text.split("\n");
const withLine = (i, line) => [...lines.slice(0, i), line, ...lines.slice(i + 1)].join("\n");
const at = (start) => lines.findIndex((l) => l.startsWith(start));
check(refused(() => S.read(text.replace(S.HEAD, "lipservice score 9")), /not a lipservice score/), "another first line is refused");
check(refused(() => S.read(withLine(at("master"), "master loud")), new RegExp(`^line ${at("master") + 1}: loud: the master's level is a number`)), "a master that is no number, by its line");
check(refused(() => S.read(withLine(at("master"), "master 40")), /master 40: -60 to 12 dB/), "a master out of range");
check(refused(() => S.read(withLine(at("effect gain"), "effect fuzz on")), new RegExp(`^line ${at("effect gain") + 1}: "fuzz": no such effect`)), "an effect there is none of");
check(refused(() => S.read(withLine(at("effect gain"), "effect gain on db 99")), /gain db 99: -24 to 24/), "an effect's setting out of range");
check(refused(() => S.read(withLine(at("effect echo"), "effect echo on ms 300 mix 0.2 feedback 0.1")), /echo takes: ms N feedback N mix N/), "an effect's settings out of their order");
check(refused(() => S.read(withLine(at("effect gain"), "effect gain maybe db 0")), /gain: on or off/), "an effect neither on nor off");
check(refused(() => S.read(withLine(at("pan"), "pan 2")), new RegExp(`^line ${at("pan") + 1}: pan 2: -1 \\(left\\) to 1 \\(right\\)`)), "a pan past an ear");
check(refused(() => S.read(withLine(at("mute"), "mute yes")), /mute yes: 0 or 1/), "a mute that is not 0 or 1");
check(refused(() => S.read(withLine(at("level"), "")), new RegExp(`^line ${at("singer") + 1}: the singer has no level`)), "a singer with no level, by the singer's line");
check(refused(() => S.read(withLine(at("level"), "level 0\nlevel 1")), /level given twice/), "a level given twice");
check(refused(() => S.read(withLine(at("level"), "volume 3")), /"volume": a singer is level, pan, mute, solo and then its part/), "a line a singer has none of");
check(refused(() => S.read(withLine(at("master"), "tempo 0 90")), /"tempo": no such line before a score's first singer/), "a part's line outside a part");
const note = at("note");
check(refused(() => S.read(withLine(note, "note 4 1 H4 96 0 Ma-")), new RegExp(`^line ${note + 1}: `)), "what is wrong inside a part is named by its line in the score");
check(refused(() => S.read(`${text}\nsinger\nlevel 0\npan 0\nmute 0\nsolo 0\n`), /the singer has no part/), "a singer with no part");
check(refused(() => S.read(`${S.HEAD}\ntitle x\nmaster 0\n`), /0 singers: a score has 1 to 16/), "a score of no singers");
check(refused(() => S.read(text.replace(/^title .*\n/m, "")), /the score has no title/), "a score with no title");

// one time for all
const off = { ...full, singers: [full.singers[0], { ...full.singers[1], part: { ...second, tempo: [{ at: 0, bpm: 90 }] } }] };
check(refused(() => S.write(off), /singer 2 \(Ben\): its tempo is not the first singer's/), "a singer with a tempo of its own is refused, by who it is");
check(refused(() => S.check({ ...full, singers: [full.singers[0], { ...full.singers[2], part: P.blank(P.singer("6345"), 960) }] }), /singer 2: its grid is not the first singer's/), "and one with a grid of its own");
check(refused(() => S.check({ ...full, singers: Array.from({ length: 17 }, () => full.singers[0]) }), /17 singers/), "seventeen singers are one too many");
check(refused(() => S.effect("fuzz"), /no such effect/) && equal(S.effect("echo"), { kind: "echo", on: true, ms: 375, feedback: 0.35, mix: 0.2 }), "an effect as it is when added");

console.log(fails ? `\n${fails} failed` : "\nall ok");
process.exit(fails ? 1 : 0);
