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
check(refused(() => S.read(withLine(at("level"), "volume 3")), /"volume": a singer is level, pan, mute, solo, follows where it follows another, and then its part/), "a line a singer has none of");
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

// linked singers: a follower's notes, words and vibrato are its leader's, later and moved by keys
const G = mary.grid;
const lead = (p, after, keys) => ({ ...p, notes: p.notes.map((n) => ({ ...n, at: n.at + after, pitch: P.name(P.key(n.pitch) + keys) })), lanes: { vibrato: p.lanes.vibrato.map((q) => ({ ...q, at: q.at + after })) } });
const octave = { ...lead(mary, 0, 12), title: "Up", singer: { ...mary.singer, seed: 4, shift: 0.05 }, marks: [] };
const later = { ...lead(mary, 2 * G, 0), title: "Late", singer: { ...mary.singer, voice: "2428", seed: 5 }, marks: [{ at: 0, breath: false }] };
const linked = { ...one, singers: [one.singers[0], { ...S.strip(), pan: 0.5, follows: { leader: 0, after: 0, keys: 12 }, part: octave }, { ...S.strip(), follows: { leader: 0, after: 2 * G, keys: 0 }, part: later }, { ...S.strip(), follows: { leader: 0, after: G / 2, keys: -3 }, part: { ...lead(mary, G / 2, -3), title: "" } }] };
const ltext = S.write(linked);
check(equal(S.read(ltext), linked) && S.write(S.read(ltext)) === ltext, "a score of linked singers reads back as written");
check(ltext.includes("\nsolo 0\nfollows 1 keys 12\nlipservice part 2\n") && ltext.includes("\nfollows 1 after 2\n") && ltext.includes("\nfollows 1 after 0.5 keys -3\n") && !S.write(one).includes("follows"), "follows K, after BEATS where later, keys N where moved; a singer that follows none says nothing");
check(equal(S.read(ltext.replace("follows 1 after 2\n", "follows 1 after 2 keys 0\n")), linked) && equal(S.read(ltext.replace("follows 1 keys 12", "follows 1 after 0 keys 12")), linked), "after 0 and keys 0 read as no wait and no move");
check(octave.singer.shift !== mary.singer.shift && later.singer.voice !== mary.singer.voice && !equal(later.marks, mary.marks), "a follower's singer, title and marks are its own");
const lfollow = ltext.split("\n").findIndex((l) => l.startsWith("follows 1 after 2"));
const lwith = (line) => [...ltext.split("\n").slice(0, lfollow), line, ...ltext.split("\n").slice(lfollow + 1)].join("\n");
check(refused(() => S.read(lwith("follows one")), new RegExp(`^line ${lfollow + 1}: follows takes the leader's place in the score`)), "a follows line that names no singer is refused by its line");
check(refused(() => S.read(lwith("follows 1 keys 2 after 2")), /follows takes/) && refused(() => S.read(lwith("follows 1 after")), /follows takes/) && refused(() => S.read(lwith("follows 1 keys 1.5")), /follows takes/), "after before keys, each with its number");
check(refused(() => S.read(lwith("follows 1 after 2.001")), new RegExp(`^line ${lfollow + 1}: follows after 2.001: on no tick of a grid of ${G}`)), "a wait on no tick is refused by its line");
check(refused(() => S.read(lwith("follows 1 after 2\nfollows 1 after 2")), /follows given twice/), "follows given twice");
check(refused(() => S.read(lwith("follows 9 after 2")), /^singer 3 \(Late\): follows singer 9: there are singers 1 to 4/), "a leader there is not");
check(refused(() => S.read(lwith("follows 3 after 2")), /^singer 3 \(Late\): follows itself/), "a singer that follows itself");
check(refused(() => S.read(lwith("follows 2 after 2")), /^singer 3 \(Late\): follows singer 2 \(Up\), who follows singer 1 \(Mary Had a Little Lamb\); a leader follows no one/), "a leader that follows another");
const swap = (i, part) => ({ ...linked, singers: linked.singers.map((s, j) => (j === i ? { ...s, part } : s)) });
const n3 = later.notes[3];
check(refused(() => S.check(swap(2, { ...later, notes: later.notes.map((n) => (n === n3 ? { ...n, lyric: "hid" } : n)) })), new RegExp(`^singer 3 \\(Late\\): follows singer 1 \\(Mary Had a Little Lamb\\) 2 beats later, but its note at beat ${P.beat(n3.at, G)} is not the leader's at beat ${P.beat(n3.at - 2 * G, G)}: its syllable is "hid", not "${n3.lyric}" as the leader's makes it$`)), "words of its own are refused, by who and where");
check(refused(() => S.check(swap(1, { ...octave, notes: octave.notes.map((n, i) => (i === 0 ? { ...n, pitch: "E4" } : n)) })), /^singer 2 \(Up\): follows singer 1 \(Mary Had a Little Lamb\) 12 keys up, but its note at beat 4 is not the leader's at beat 4: its key is E4, not E5 as the leader's makes it$/), "a key of its own");
check(refused(() => S.check(swap(1, { ...octave, notes: octave.notes.map((n, i) => (i === 0 ? { ...n, cents: 10 } : n)) })), /its cents is 10, not 0/), "cents of its own");
check(refused(() => S.check(swap(2, { ...later, notes: later.notes.slice(1) })), /its note at beat 7 is not the leader's at beat 4: its start is beat 7, not beat 6/), "a note left out");
check(refused(() => S.check(swap(2, { ...later, notes: [...later.notes, { ...later.notes.at(-1), at: later.notes.at(-1).at + 4 * G }] })), /is past the leader's last/), "a note more");
check(refused(() => S.check(swap(2, { ...later, lanes: { vibrato: later.lanes.vibrato.slice(1) } })), /its vibrato at beat .* is not the leader's at beat/), "a vibrato of its own");
check(equal(S.read(S.write(swap(1, { ...octave, notes: octave.notes.map((n) => ({ ...n, pitch: P.name(P.key(n.pitch)).replace(/^C#/, "Db") })) }))).singers[1].part.notes.length, mary.notes.length), "a follower may spell its keys its own way");
check(refused(() => S.check({ ...one, singers: [{ ...S.strip(), part: { ...mary, notes: [{ ...mary.notes[0], pitch: "G9" }] } }, { ...S.strip(), follows: { leader: 0, after: 0, keys: 1 }, part: mary }] }), /^singer 2 \(Mary Had a Little Lamb\): follows singer 1 \(Mary Had a Little Lamb\) 1 key up, but the leader's G9 at beat 4 moved 1 keys is past MIDI's keys/), "a leader whose notes cannot be moved that far");
check(refused(() => S.check({ ...linked, singers: [linked.singers[0], { ...linked.singers[1], follows: { leader: 0, after: -1, keys: 12 } }] }), /follows after -1 ticks: a whole number of ticks, 0 or more/) && refused(() => S.check({ ...linked, singers: [linked.singers[0], { ...linked.singers[1], follows: { leader: 0, after: 0, keys: 12, by: 1 } }] }), /follows has no by/), "a link's own numbers are checked");

console.log(fails ? `\n${fails} failed` : "\nall ok");
process.exit(fails ? 1 : 0);
