// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The diction bench without its page: what the engine offers (ls_bench), the reckoning (model.js),
// the engine (render.js) held against the command line for the same text and flags, and a bench
// driven as the page drives it (bench.js).
//     node lab_test.mjs LIPSERVICE.wasm BUNDLE ENGINE
// BUNDLE: the models as the package keeps them (LIPSERVICE_MODELS). ENGINE: the lipservice binary
// built from the same source.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cue, sounds } from "./sounds.js";
import { bpmOf, commandFlags, commandLine, differences, fresh, fromPlan, insertSound, levels, noteMoved, notesOf, parsePhones, phonesText, removeSound, rowLines, ruleLines, setBpm, setClose, setCloseMs, setNote, setSound, setStress, setVowels, setWordPhones, sungText, sweepValues, targets, refusal, useReader, vowelRow, wordLines } from "./model.js";
import { Renderer } from "./render.js";
import { Bench } from "./bench.js";

const [wasm, bundle, engine] = process.argv.slice(2);
if (!engine) { console.error("usage: node lab_test.mjs LIPSERVICE.wasm BUNDLE ENGINE"); process.exit(2); }
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const refused = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };
const tmp = mkdtempSync(join(tmpdir(), "bench-"));

// ---------------------------------------------------------------- what the engine offers
const read = async (p) => new Uint8Array(readFileSync(join(bundle, p)));
const lab = await Renderer.open(readFileSync(wasm), read);
const bench = lab.bench, snd = sounds(bench.phones);
// the song's text read by the engine's reader, as the page reads it
useReader((text) => lab.engine.song(text));
check(bench.phones.length === 69 && snd.vowels.length === 15 && snd.consonants.length === 24 && snd.stresses.join() === "0,1,2", "the engine's sounds: 15 vowels at three stresses and 24 consonants");
check(bench.phones.every((p) => /" as in \w+/.test(cue(p))), "every one of them has its plain words");
check(bench.options.map((o) => o.name).join() === "shift,seed,vibrato,vibrato_hz,vibrato_delay,motion,motion_scale,glide,dynamics,consonants,breathiness" && bench.options.every((o) => o.help.length > 20 && o.min <= o.default && o.default <= o.max), "the sing options, each with its range and its line of help");
check(bench.motions.join() === "straight,vibrato,wide", "the trained motions");
check(JSON.stringify(bench.sets) === '{"plain":["B,D,G place=first -> dip=1"],"sung":["vowel -> stress=1","ER0 -> AH R","AY held>=240 not-before=L,R -> AA ~AY:<200","AY held>=240 before=vowel -> AA ~IY:<200","OY held>=240 -> AO ~OY:<200","OY held>=240 before=vowel -> AO ~IY:<200"]}' && bench.dipped.join() === "B,D,G,JH", "the diction's sets as the engine has them, each rule a line");

// ---------------------------------------------------------------- the reckoning
{
  const night = parsePhones("N,AA,~AY:200,T", bench);
  check(phonesText(night) === "N,AA,~AY:200,T" && night[1].p === "AA1" && night[2].close && night[2].ms === 200, "a word's sounds read and written");
  check(phonesText(parsePhones("AH0,B,AW2,T", bench)) === "AH0,B,AW2,T", "a weak and a half strong vowel keep their marks");
  check(/XX: not a sound/.test(await refused(() => parsePhones("N,XX,T", bench))) && /a sound, or ~SOUND:MS/.test(await refused(() => parsePhones("N,~AY:x,T", bench))), "sounds the engine has not, refused");
  check(phonesText(setSound(parsePhones("AH0,B,AW,T", bench), 0, "IH", bench)) === "IH0,B,AW,T" && phonesText(setSound(night, 3, "D", bench)) === "N,AA,~AY:200,D", "a sound replaced: a vowel keeps the stress it had");
  check(phonesText(setStress(night, 1, "0")) === "N,AA0,~AY:200,T" && phonesText(insertSound(night, 0, "S", bench)) === "S,N,AA,~AY:200,T" && phonesText(removeSound(night, 1)) === "N,T" && phonesText(removeSound(night, 2)) === "N,AA,T", "stress, a sound put in, a vowel out with its end, an end out alone");
  check(phonesText(setClose(parsePhones("N,AY,T", bench), 1, "IH", null, bench)) === "N,AY,~IH,T" && phonesText(setCloseMs(night, 2, 80)) === "N,AA,~AY:80,T" && phonesText(setCloseMs(night, 2, null)) === "N,AA,~AY,T", "a vowel given an end, the end's length written and unwritten");

  const song = "# a carol\n%bpm 84\n%diction AY -> same\n  silent F4:1.5+G4:0.5 F4:1\n%vibrato 0 1:2\nnight{N,AA,~AY,T} D4:3\n%rest 1\ndiction Bb4:1 A4:1\n";
  const w = wordLines(song);
  check(w.length === 3 && w.map((x) => x.word).join() === "silent,night,diction" && w[1].braces === "N,AA,~AY,T" && w[0].braces === null && w[2].line === 7, "a song's words as the engine reads them: comments and % lines are not words, a word named diction is");
  const late = "%bpm 84\nnight D4:3\n%diction AY -> same\n";
  check(refusal(late) === "line 3: %diction is the whole song's: it comes before the first word" && wordLines(late).length === 0 && bpmOf(late) === null && /^line 3: /.test(await refused(async () => setWordPhones(late, 0, null))) && /write %bpm 90|%bpm 90/.test(refusal("bpm 90\nnight D4:3\n")),
    `a text the engine does not read has its refusal and no words to change: ${refusal("bpm 90\nnight D4:3\n")}`);
  const s2 = setWordPhones(song, 0, parsePhones("S,AY,L,AH0,N,T", bench));
  check(s2.split("\n")[3] === "  silent{S,AY,L,AH0,N,T} F4:1.5+G4:0.5 F4:1" && s2.split("\n").filter((l, i) => i !== 3).join("\n") === song.split("\n").filter((l, i) => i !== 3).join("\n"), "a word's sounds written into its line, every other line as it was");
  check(setWordPhones(song, 1, null).includes("\nnight D4:3\n"), "and taken out again");
  check(notesOf(song, 0).map((n) => `${n.note}:${n.beats}:${n.first}`).join(" ") === "F4:1.5:true G4:0.5:false F4:1:true" && setNote(song, 0, 1, { note: "A4", beats: "0.75" }).includes("silent F4:1.5+A4:0.75 F4:1"), "a word's notes, and one written anew");
  check(noteMoved("Bb4", 1) === "B4" && noteMoved("Bb4", -2) === "Ab4" && noteMoved("F#3", 1) === "G3" && noteMoved("C4", -1) === "B3" && noteMoved("60", 2) === "62", "a note moved keeps its spelling");
  check(bpmOf(song) === 84 && bpmOf(setBpm(song, 60)) === 60 && setBpm("night D4:3", 72) === "%bpm 72\nnight D4:3" && bpmOf("night D4:3") === null, "the tempo read and written");

  const st = fresh(bench, lab.voices);
  check(st.voice === lab.voices[0].name && st.options.motion === "none" && !("diction" in st.options) && st.rules.sung === true && !("sets" in st.rules) && st.options.glide === 9 && st.text === "", "a fresh bench: the engine's own values, no song");
  check(ruleLines(st.rules, st.voice).length === 0 && commandFlags(st, bench).join(" ") === `--voice ${st.voice}`, "sung as every song is, and the engine's own options, write nothing");
  const ay = vowelRow(bench, "AY1");
  check(JSON.stringify(ay) === JSON.stringify({ kind: "vowel", of: "AY1", held: 240, hold: "AA1", close: "AY1", ms: 200, into: "IY1", whole: ["L", "R"] }) && rowLines(ay, "ada").join("|") === "AY -> same|AY held>=240 not-before=L,R -> AA ~AY:<200|AY held>=240 before=vowel -> AA ~IY:<200"
    && JSON.stringify(vowelRow(bench, "OW1")) === JSON.stringify({ kind: "vowel", of: "OW1", held: 240, hold: "OW1", close: null, ms: 200, into: null, whole: [] }) && setVowels(bench).join() === "AY1,OY1", "a held vowel's row starts as the sets sing it; a vowel no set holds, as itself");
  const r = JSON.parse(JSON.stringify(st));
  r.rules.rows.push({ ...ay, close: "IH1", ms: 100, into: null, whole: [] }, { ...vowelRow(bench, "OW1"), hold: "AO1", ms: 120, whole: ["L"] }, { kind: "line", text: " OY -> same " }, { kind: "dip", depth: 1.5, every: true },
    { kind: "word", word: "boat", phones: "B,AO,T" }, { kind: "word", word: "boat", phones: "B,OW,T", who: true, off: true }, { kind: "line", text: "" });
  const want = ["%diction AY -> same", "%diction AY held>=240 -> AA ~IH:<100", "%diction OW -> same", "%diction OW held>=240 not-before=L -> AO", "%diction OY -> same", "%diction B,D,G,JH -> dip=1.5", "%diction word=boat -> B AO T"];
  check(ruleLines(r.rules, r.voice).join("|") === want.join("|"), `rules as diction lines: each row in the engine's words, a row off and a line not written left out: ${ruleLines(r.rules, r.voice).join("|")}`);
  check(rowLines(r.rules.rows[5], "Ada B").join() === "for=adab word=boat -> B OW T" && rowLines({ kind: "dip", depth: 0.5, every: false }, "ada").join() === "B,D,G place=first -> dip=0.5", "a row for the bench's voice alone, a word's first b, d, g");
  const off = JSON.parse(JSON.stringify(r.rules));
  off.sung = false;
  check(ruleLines(off, r.voice).slice(0, 2).join("|") === "%diction spoken|%diction AY -> same" && ruleLines({ sung: false, rows: [] }, r.voice).join() === "%diction spoken", "sung off is spoken, said first");
  r.text = "%bpm 60\nboat D4:1\n";
  Object.assign(r.options, { motion: "wide", consonants: 1.2, vibrato_hz: 6 });
  check(sungText(r).lines === 7 && sungText(r).text.endsWith("%diction word=boat -> B AO T\n%bpm 60\nboat D4:1\n") && sungText(st).lines === 0, "the text sung: the rules' lines, then the song");
  check(commandLine(r, bench) === `lipservice sing song.txt -o song.wav --voice ${st.voice} --vibrato-hz 6 --motion wide --consonants 1.2`, "the command line that sings the same");
  check(differences(st, r, bench).join("|") === `vibrato hz: 5.5, 6|motion: none, wide|consonants: 1, 1.2|the rules|2 lines of the song`, "what differs between two states, in plain words");
  check(sweepValues(0, 1, 5, 0.05).join() === "0,0.25,0.5,0.75,1" && sweepValues(100, 300, 3, 10).join() === "100,200,300" && sweepValues(1, 1.1, 5, 0.05).join() === "1,1.05,1.1", "a sweep's values, on the pull's steps, none twice");
  const ts = targets(r, bench, { k: 0, i: 1, phones: parsePhones("B,AO,T", bench) });
  check(bench.options.every((o) => ts.some((t) => t.id === `option.${o.name}`)) && ["bpm", "rule.0.held", "rule.0.ms", "rule.1.hold", "rule.3.depth", "sound"].every((id) => ts.some((t) => t.id === id)) && !ts.some((t) => t.id === "sound.ms"), "what a sweep can run over: every option, the tempo, every rule, the chosen sound");
  const sweepSound = ts.find((t) => t.id === "sound");
  check(sweepSound.choices.length === 39 && sweepSound.set(r, "UW").text === "%bpm 60\nboat{B,UW,T} D4:1\n" && ts.find((t) => t.id === "rule.0.ms").set(r, 50).rules.rows[0].ms === 50 && r.rules.rows[0].ms === 100, "a target set gives a new state, the old one as it was");
  check(Array.from(levels(new Float32Array(480).fill(0.5, 0, 240))).join() === "0.5,0", "the level, a frame at a time");
}

// ---------------------------------------------------------------- the engine against the command line
const cli = (text, flags, rules = null) => {
  const [song, out, timing] = [join(tmp, "song.txt"), join(tmp, "out.wav"), join(tmp, "out.json")];
  writeFileSync(song, text);
  if (rules !== null) writeFileSync(join(tmp, "rules.txt"), rules);
  execFileSync(engine, ["sing", song, "-o", out, ...flags, ...(rules !== null ? ["--rules", join(tmp, "rules.txt")] : []), "--timing", timing], { env: { ...process.env, LIPSERVICE_MODELS: bundle }, stdio: "pipe" });
  const b = readFileSync(out), t = JSON.parse(readFileSync(timing, "utf8")).parts[0];
  return { samples: new Float32Array(b.buffer.slice(b.byteOffset + 58, b.byteOffset + b.length)), phones: t.phones, pitch: t.pitch };
};
// The browser build's arithmetic is not the native build's and the latent voice's samples drift by
// it, so the samples are not held to the bit: every sound's span is, and the sung pitch closely.
const asCli = (a, b) => {
  const spans = a.plan.flatMap((w) => w.phones.map(([p, , s, e]) => [s, e, p]));
  const pitch = Math.max(...b.pitch.map((hz, i) => (hz === 0 || a.pitch[i] === 0 ? (hz === a.pitch[i] ? 0 : 1) : Math.abs(hz / a.pitch[i] - 1))));
  return { ok: JSON.stringify(spans) === JSON.stringify(b.phones) && a.pitch.length === b.pitch.length && a.samples.length === b.samples.length && pitch < 1e-3, said: `pitch within ${pitch.toExponential(1)}` };
};
const SONG = "%bpm 84\nsilent F4:1.5+G4:0.5 F4:1\nnight D4:3\nholy F4:1.5+G4:0.5 F4:1\nnight{N,AA,~IH:120,T} D4:2.5\n%rest 0.5\nbig D4:1\ndog D4:2\n";
{
  const st = fresh(bench, lab.voices);
  st.text = SONG;
  const plain = await lab.sing(sungText(st).text, st.voice, st.options);
  const c = asCli(plain, cli(st.text, commandFlags(st, bench)));
  check(c.ok, `with nothing set the bench sings the song as the command line does: ${c.said}`);

  Object.assign(st.options, { shift: -2, seed: 7, motion: "vibrato", motion_scale: 0.8, glide: 14, dynamics: 1.3, consonants: 1.3, breathiness: 0.4 });
  st.rules.rows.push({ ...vowelRow(bench, "AY1"), held: 200, ms: 120, whole: [] }, { ...vowelRow(bench, "OY1"), held: 200 }, { ...vowelRow(bench, "OW1"), held: 200, hold: "AO1", close: "OW1", ms: 150, who: true }, { kind: "dip", depth: 1.5, every: true });
  const set = await lab.sing(sungText(st).text, st.voice, st.options);
  const c2 = asCli(set, cli(sungText(st).text, commandFlags(st, bench)));
  check(c2.ok && JSON.stringify(set.plan) !== JSON.stringify(plain.plan), `with every option and rule set, the text and flags written out sing on the command line as on the bench: ${c2.said}`);
  const lines = ruleLines(st.rules, st.voice);
  const c3 = asCli(set, cli(st.text, commandFlags(st, bench), lines.join("\n")));
  check(c3.ok, `and so do the rules alone as a rules file under the bare song: ${c3.said}`);
  const said = (r) => r.plan.map((w) => w.phones.map((p) => p[0]).join(" ")).join(" | ");
  check(set.rules.join("|") === ["B,D,G place=first -> dip=1", ...bench.sets.sung, ...lines.map((l) => l.replace(/^%diction /, ""))].join("|") && set.rules[set.plan[1].phones[1][4]] === "AY held>=200 -> AA ~AY:<120" && set.rules[set.plan[5].phones[0][5]] === "B,D,G,JH -> dip=1.5" && set.plan[4].phones[0][4] === null,
    `the plan says which rule gave each sound and its dip, a word written whole by none: ${JSON.stringify(set.plan[1].phones)}`);
  check(said(set).includes("S AA1 AY1 L AH1 N T | N AA1 AY1 T | HH AO1 OW1 L IY1 | N AA1 IH1 T") && set.plan[1].phones[2][3] - set.plan[1].phones[2][2] === 120 * 24, `the rules are heard in the plan: a held vowel in two, its end the length written: ${said(set)}`);

  // each word written as the engine planned it is the same performance again
  let text = st.text;
  set.plan.forEach((w, k) => { text = setWordPhones(text, k, fromPlan(w)); });
  const again = await lab.sing(sungText({ ...st, text }).text, st.voice, st.options);
  const sounds4 = (r) => JSON.stringify(r.plan.map((w) => w.phones.map((p) => p.slice(0, 4))));
  check(sounds4(again) === sounds4(set) && again.plan.every((w) => w.phones.every((p) => p[4] === null)) && again.samples.every((v, i) => v === set.samples[i]), "every word written as the engine planned it sings the same samples again, no rule its sounds' but the dips'");

  check(/tempo: not a sing option/.test(await refused(() => lab.sing(SONG, st.voice, { tempo: 3 }))) && /glide 0: a whole number, 1 to 80/.test(await refused(() => lab.sing(SONG, st.voice, { glide: 0 }))) && /no motion swing/.test(await refused(() => lab.sing(SONG, st.voice, { motion: "swing" }))), "an option the engine has not, or out of its range, is refused");
}

// ---------------------------------------------------------------- a bench, driven as the page drives it
{
  let kept = null;
  const store = { get: () => kept, set: (j) => { kept = j; } };
  const events = [];
  const b = new Bench({ sing: (t, v, o) => lab.sing(t, v, o), bench, voices: lab.voices, store, changed: (w) => events.push(w) });
  await b.resing();
  check(b.sung === null && b.error === null, "an empty bench sings nothing and refuses nothing");
  await b.setText(SONG);
  check(b.sung.plan.length === 6 && b.error === null && b.sung.level.length === Math.ceil(b.sung.samples.length / 240) && events.includes("sung"), "a song written is sung");
  b.select(1, 1);
  const [ra, rb] = b.region;
  check(Math.abs(ra - (b.sung.plan[1].phones[0][2] / 24000 - 0.3)) < 1e-9 && rb > ra && b.chosen().phones.map((x) => x.p).join() === "N,AA1,AY1,T", "a sound chosen: its word and a little either side is what plays");
  await b.edit(1, setClose(setSound(b.chosen().phones, 1, "AA", bench), 1, "AY", null, bench));
  check(b.state.text.includes("\nnight{N,AA,~AY,T} D4:3\n") && b.sung.plan[1].phones.map((p) => p[0]).join() === "N,AA1,AY1,T" && b.follow && Math.abs(b.region[0] - ra) < 0.2, "its sounds changed are written in the song and sung at once");
  await b.edit(1, setCloseMs(b.phones(1), 2, 400));
  check(b.sung.plan[1].phones[2][3] - b.sung.plan[1].phones[2][2] === 400 * 24, "an end's length is the length sung");
  const first = b.keep("held ah");
  await b.edit(1, insertSound(b.phones(1), 4, "S", bench));
  await b.edit(1, parsePhones("N,AA,IY,T", bench));
  check(/^night: 2 syllables/.test(b.error) && b.sung.plan[1].phones.length === 5, `what the engine refuses is said in its words, the last performance kept: ${b.error}`);
  await b.undo();
  check(b.error === null && b.state.text.includes("night{N,AA,~AY:400,T,S}") && b.future.length === 1, "undo takes it back");
  await b.setRules((r) => { r.rows.push({ kind: "dip", depth: 2, every: false }); });
  await b.setText(b.state.text.replace("big D4:1", "big D4"));
  check(/^line 7: /.test(b.error), `a refusal names the song's own line, whatever rules stand over it: ${b.error}`);
  await b.undo();
  await b.setRules((r) => { r.rows.push({ kind: "line", text: "G place=last before=rest -> K" }); });
  check(b.sung.plan[5].phones.at(-1)[0] === "K" && b.sung.plan[4].phones.at(-1)[0] === "G", "a rule in the engine's words is sung: the G before the end, not the one before a word");
  await b.setRules((r) => { r.rows[1].text = "G place=last -> "; });
  check(/^the rules, line 2: .*nothing after ->/.test(b.error), `a rule the engine refuses is said, by its line among the rules: ${b.error}`);
  await b.undo();
  await b.everywhere(1);
  const rule = b.state.rules.rows.at(-1);
  check(rule.kind === "word" && rule.word === "night" && !("nth" in rule) && rule.phones === "N,AA,~AY:400,T,S" && b.sung.plan[3].phones.length === 4, "a word's sounds for every such word: the rule is there, a word written in its own line keeps its own");
  await b.setNote(5, 0, { beats: "3" });
  check(b.state.text.includes("dog D4:3"), "a note pulled is written");

  // takes and flipping
  await b.hear({ kind: "take", id: first });
  check(b.heard.kind === "take" && b.other.kind === "bench" && b.shown().plan[1].phones.length === 4 && b.chosen() === null, "a take heard is what is shown, and is not changed where it is");
  await b.flip();
  check(b.heard.kind === "bench" && b.other.kind === "take" && b.shown() === b.sung, "flip goes back, and back again");
  await b.flip();
  await b.setOption("shift", 2);
  check(b.heard.kind === "bench" && b.other.kind === "take", "a change to the bench is what is heard");
  await b.load({ kind: "take", id: first });
  check(b.state.text.includes("night{N,AA,~AY:400,T} D4:3") && b.state.options.shift === 0 && b.state.rules.rows.length === 0, "a take put on the bench is the bench");

  // a sweep
  b.select(1, 2);
  await b.run("sound.ms", sweepValues(100, 300, 3, 10));
  check(b.sweep.runs.length === 3 && b.sweep.runs.every((r, j) => r.sung.plan[1].phones[2][3] - r.sung.plan[1].phones[2][2] === [100, 200, 300][j] * 24), "a sweep of an end's length sings each");
  await b.hear({ kind: "run", k: 2 });
  const id = b.keep("", { kind: "run", k: 2 });
  check(b.takes.at(-1).state.text.includes("~AY:300") && b.takes.at(-1).name === `take ${id}` && b.state.text.includes("~AY:400"), "a run kept is a take; the bench is as it was");
  check(/B: not one of the chosen sound/.test(await refused(() => b.run("sound", ["IY", "B"]))), "a vowel's end is swept over vowels only");
  b.select(1, 1);
  await b.run("sound", ["IY", "B"]);
  check(b.heard.kind === "bench" && b.sweep.runs[0].sung !== null && /a close comes straight after the vowel/.test(b.sweep.runs[1].error), `a sweep of the chosen sound: one sung, one the engine refuses, said so: ${b.sweep.runs[1].error}; heard ${b.heard.kind}`);
  await b.run("option.motion", ["none", "wide"]);
  check(b.sweep.runs.every((r) => r.sung) && b.sweep.runs[0].sung === b.sung, "a sweep of a choice; a value already sung is not sung again");
  b.drop(first);
  check(b.takes.length === 1 && (b.other === null || b.other.kind !== "take" || b.other.id !== first), "a take forgotten is gone from the flip too");

  // kept between visits
  const b2 = new Bench({ sing: (t, v, o) => lab.sing(t, v, o), bench, voices: lab.voices, store });
  await b2.load_saved(kept);
  check(b2.state.text === b.state.text && JSON.stringify(b2.state) === JSON.stringify(b.state) && b2.takes.length === 1 && b2.sel.k === 1 && b2.sung.samples.every((v, i) => v === b.sung.samples[i]), "a session comes back as it was left");
  check(/format 2/.test(await refused(() => b2.load_saved('{"format":2}'))) && /sing options are not this engine's/.test(await refused(() => b2.load_saved(JSON.stringify({ ...JSON.parse(kept), state: { ...b.state, options: { shift: 0 } } })))), "a session that is not this bench's is refused");
  const five = JSON.stringify({ format: 5, state: { text: "bpm 84\nnight D4:3\n", voice: b.state.voice, options: fresh(bench, lab.voices).options, rules: { sets: { plain: true, sung: true }, rows: [] } }, takes: [] });
  check((await refused(() => b2.load_saved(five))) === "it was saved as format 5; this page reads only format 6" && b2.state.text === b.state.text, "a session saved by an earlier page is refused, not rewritten, and the bench is left as it was");
}

console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
