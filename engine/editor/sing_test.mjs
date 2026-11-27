// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// sing.js: the singer's style and the part as the engine performs it. The diction switch is rule
// lines (on, the engine's sung set; off, none); who sings is the part's title, the voice's name
// on the site and the name people call it.
// node sing_test.mjs
import assert from "node:assert/strict";
import * as S from "./sing.js";
import { song } from "./song.js";
import { rng } from "../web/room.js";
import { FPS, SR, LEAD } from "../web/perform.js";
import { EXAMPLES } from "./examples/make.mjs";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const web = { rng, FPS, SR, LEAD };
const ada = { sex: "F", called: "Ada" };

{
  const on = EXAMPLES.mary(), off = EXAMPLES.every();
  check(on.singer.diction === true && off.singer.diction === false, "the examples have diction on (mary) and off (every)");
  check(equal(S.style(web, on.singer, -1).diction, []), "diction on: no rule lines, sung as every song is");
  check(equal(S.style(web, off.singer, -1).diction, ["spoken"]), "diction off: spoken");
  const a = S.asked(on, song(on), ada, S.style(web, on.singer, -1), false);
  check(equal(a.diction, []) && a.sex === "F" && a.voice === on.singer.voice && a.called === "Ada", "the part asked carries the rule lines, the voice's sex, its name on the site and the name it is called");
  check(a.name === on.title && typeof a.name === "string" && a.name !== "", "a titled part is named by its title");
  const untitled = { ...on, title: null };
  check(!("name" in S.asked(untitled, song(untitled), ada, S.style(web, untitled.singer, -1), false)), "an untitled part has no name: only rules for every singer are its");
  check(!("tags" in a), "no tags: the editor's parts have none");
}

{
  // the frames before beat 0, from the song as the engine reads it: the length less the end, as
  // long as the lead-in, and its beats at its tempo
  check(S.opening(web, { bpm: 120, beats: 6 }, 10 + 300 + 10 + 12) === 22, "the opening: what is left of the frames after the beats and the end");
  check(/fewer than its beats/.test((() => { try { S.opening(web, { bpm: 120, beats: 6 }, 315); return ""; } catch (e) { return e.message; } })()), "frames too few for the beats are refused");
}

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
