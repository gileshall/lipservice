// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// share.js: every example in a link and back as it was, the link's length, and what is not a
// score's link refused, saying why. node share_test.mjs
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as P from "./part.js";
import * as M from "./midi.js";
import * as S from "./score.js";
import { pack, unpack, link, fromLocation, cut, LIMIT, KEY, MOST, VERSION } from "./share.js";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const refused = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const BASE = "https://lipservice.dev/editor/";

// what a packed score is made of, by hand: for links pack() would never make
const deflate = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const forged = async (text) => `${VERSION}.${b64(await deflate(new TextEncoder().encode(text)))}`;

// Every example, as the page opens it: a score as it is, a part or a MIDI file as a score of one.
const examples = readdirSync(here("examples")).filter((f) => /\.(score|part|mid)$/.test(f)).sort();
check(examples.length >= 13, `${examples.length} examples found`);
const lengths = [];
for (const file of examples) {
  const bytes = new Uint8Array(readFileSync(here(`examples/${file}`)));
  const text = file.endsWith(".score") ? new TextDecoder().decode(bytes)
    : file.endsWith(".part") ? S.write(S.of(P.read(new TextDecoder().decode(bytes))))
    : S.write(S.of(M.read(bytes, { singer: P.singer("6147", 3) }).part));
  const packed = await pack(text), url = await link(BASE, text);
  const back = await unpack(packed), opened = await fromLocation(new URL(url));
  check(back === text && opened === text && /^[A-Za-z0-9._-]+$/.test(packed), `${file}: through a link and back as it was, in letters a link keeps`);
  lengths.push([file, text.length, packed.length, url.length]);
}
console.log("\n  example               text   packed   link");
for (const [f, t, p, u] of lengths) console.log(`  ${f.padEnd(20)} ${String(t).padStart(5)}   ${String(p).padStart(6)}   ${String(u).padStart(4)}`);
console.log(`  (the link with ${BASE})\n`);

// Longer scores, written to be like a hymn: notes on a walk in each singer's range, words under
// every one, the vibrato drawn now and then. Their lengths say what LIMIT leaves room for.
function hymn(singers, bars) {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const words = ["glo-", "ry", "to", "the", "new", "born", "King,/", "peace", "on", "earth", "and", "mer-", "cy", "mild,/", "God", "and", "sin-", "ners", "re-", "con-", "ciled./"];
  const grid = 480, parts = [];
  for (let s = 0; s < singers; s++) {
    const part = { ...P.blank(P.singer(String(6000 + s), s), grid), title: `Singer ${s + 1}` };
    let at = 0, key = 48 + 5 * (s % 4), w = s;
    while (at < bars * 4 * grid) {
      const beats = [0.5, 1, 1, 1, 2][Math.floor(rand() * 5)];
      key = Math.max(36, Math.min(84, key + Math.floor(rand() * 5) - 2));
      part.notes.push({ at, ticks: beats * grid, pitch: P.name(key), cents: 0, velocity: 60 + Math.floor(rand() * 40), release: 64, lyric: words[w++ % words.length] });
      if (rand() < 0.1) part.lanes.vibrato.push({ at, value: Math.round(rand() * 150) / 100, line: false });
      at += beats * grid;
    }
    parts.push({ ...S.strip(), pan: Math.round((s / Math.max(1, singers - 1) - 0.5) * 100) / 100, part });
  }
  return S.write({ title: `a hymn for ${singers}`, master: 0, chain: S.chain(), singers: parts });
}
const sizes = [];
for (const [n, bars] of [[4, 16], [4, 32], [4, 64], [8, 32], [16, 32]]) {
  const text = hymn(n, bars), packed = await pack(text), whole = BASE.length + KEY.length + packed.length;
  check((await unpack(packed)) === text, `a hymn for ${n}, ${bars} bars: through a link and back`);
  sizes.push([`${n} singers, ${bars} bars`, text.length, packed.length, whole]);
}
console.log("\n  written here                 text   packed    link");
for (const [f, t, p, u] of sizes) console.log(`  ${f.padEnd(26)} ${String(t).padStart(6)}   ${String(p).padStart(6)}   ${String(u).padStart(5)}${u > LIMIT ? "  over the limit" : ""}`);
console.log(`  (the limit ${LIMIT})\n`);

// a link too long is refused, saying how long it is and how long one may be
{
  const text = hymn(16, 32), whole = BASE.length + KEY.length + (await pack(text)).length;
  const why = await refused(() => link(BASE, text));
  check(whole > LIMIT && why === `a link to this score is ${whole.toLocaleString("en-US")} characters, and a link works up to ${LIMIT.toLocaleString("en-US")}: save the score as a file to send it`, `a link of ${whole} characters is refused, both lengths said: ${why}`);
  const fits = hymn(4, 16);
  check((await link(BASE, fits)).length <= LIMIT, "a link under the limit is made");
}

// what pack() refuses: text that is not a score
{
  const part = readFileSync(here("examples/mary.part"), "utf8");
  check((await refused(() => pack(part)))?.includes("not a lipservice score"), "a part's text is not packed: a link holds a score");
  check((await refused(() => pack("lipservice score 1\ntitle x\n"))) === "the score has no master", "a score missing a line is not packed");
  check((await refused(() => pack(42))) === "a score is text", "nor what is not text");
}

// what unpack() refuses, each saying why
{
  const round = readFileSync(here("examples/round.score"), "utf8"), good = await pack(round), body = good.slice(2);
  const cases = [
    ["2." + body, `not a score link this editor reads: it starts "2", where one of this editor's starts "1."`, "a link of another packing"],
    [body, `not a score link this editor reads: it starts "${body.slice(0, 12)}", where one of this editor's starts "1."`, "a link with no packing named"],
    ["1.", `the link holds no score: nothing after its "#score=1."`, "a link with nothing after its packing"],
    ["1." + body.slice(0, 10) + "+" + body.slice(11), `the link's score is cut or changed: "+" at its character 11 is not one a link's score is written in`, "a letter base64url has not (+)"],
    ["1." + body.slice(0, 10) + "%20" + body.slice(10), `the link's score is cut or changed: "%" at its character 11 is not one a link's score is written in`, "a letter escaped on the way"],
    ["1." + body.slice(0, 4 * Math.floor(body.length / 4)) + "A", `the link's score is cut: ${4 * Math.floor(body.length / 4) + 1} characters is no whole number of bytes`, "a link cut a character after a whole group"],
    ["1.AB", "the link's score is changed: its last character is not one this packing writes", "a last character with bits set past the bytes"],
    ["1." + body.slice(0, 4 * Math.floor(body.length / 8)), "the link's score is cut or changed: it does not unpack", "a link cut in half"],
    ["1." + b64(new TextEncoder().encode(round.slice(0, 300))), "the link's score is cut or changed: it does not unpack", "plain text, not deflate"],
    [await forged("lipservice part 2\ntitle x\n"), `the link's score: not a lipservice score this reads: its first line is not "lipservice score 1"`, "a part's text, not a score"],
    [await forged(round.replace("master 0", "master 99")), "the link's score: master 99: -60 to 12 dB", "a score the editor would not read"],
    [`${VERSION}.${b64(await deflate(new Uint8Array([0x6c, 0xff, 0xfe, 0x0a])))}`, "the link's score unpacks to bytes that are not text", "bytes that are not UTF-8"],
    [`${VERSION}.${b64(await deflate(new Uint8Array(MOST + 1).fill(0x20)))}`, "the link's score unpacks to more than 1 MB of text, the most a link holds", "a small link that unpacks to too much"],
  ];
  const junk = Buffer.concat([Buffer.from(body, "base64url"), Buffer.from([1, 2, 3])]);
  cases.push(["1." + b64(junk), "the link's score is cut or changed: it does not unpack", "bytes after the score's end"]);
  for (const [s, said, what] of cases) {
    const why = await refused(() => unpack(s));
    check(why !== null && why.startsWith(said), `${what}: ${why}`);
  }
  check((await refused(() => unpack(null))) === "a link's score is text", "unpack is given text");
}

// a page's address: the score in its hash, or null where there is none
{
  const round = readFileSync(here("examples/round.score"), "utf8"), url = await link(BASE, round);
  for (const hash of ["", "#", "#mixer", "#scor", "#Score=1.abc"]) check((await fromLocation({ hash })) === null, `a hash of "${hash}" holds no score`);
  check((await fromLocation(new URL(url))) === round, "the score from a URL's hash");
  check((await fromLocation({ hash: new URL(url).hash })) === round, "and from anything with that hash, as window.location is");
  check((await refused(() => fromLocation({ hash: "#score=9.x" })))?.startsWith("not a score link this editor reads"), "a hash that names a score and is not one is refused, not passed over");
  check((await refused(() => fromLocation({})))?.startsWith("the page's address has no hash"), "a location with no hash is refused");
  check(url.startsWith(BASE + KEY + VERSION + "."), `a link is the page's address, ${KEY} and the packed score`);
  check((await refused(() => link(BASE + "#mixer", round)))?.includes(`has a "#" already`), "an address with a hash already is refused");
  check((await refused(() => link("editor/", round)))?.includes("is not a whole address"), "an address that is not whole is refused");
  check((await link("http://localhost:8000/engine/editor/index.html?x=1", round)).includes("index.html?x=1#score=1."), "an address with its page and query kept");
}

// the apps a link is too long for
check(cut(1900).length === 0 && cut(2001).map((c) => c.app).join() === "Discord" && cut(LIMIT).length === 2, "the apps that cut a link, by its length");

console.log(fails ? `${fails} failed` : "all ok");
process.exit(fails ? 1 : 0);
