// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// bundle.js: the hash, and a site's files from itself, from a bundle, and from a bundle's mirror.
//     node bundle_test.mjs
import { createHash, randomBytes } from "node:crypto";
import { bundleOf, loader, sha256, sha256js } from "./bundle.js";

let bad = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) bad += 1; };
const threw = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };
const sum = (b) => createHash("sha256").update(b).digest("hex");

const sizes = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 1000, 65536, 1000003];
check(sizes.every((n) => { const b = new Uint8Array(randomBytes(n)); return sha256js(b) === sum(b); }), `sha256js is node's on ${sizes.length} lengths`);
const big = new Uint8Array(randomBytes(3_000_000));
check(await sha256(big) === sum(big), "sha256 is node's through the platform's");

// a made-up site and two hosts of one bundle
const enc = (s) => new TextEncoder().encode(s);
const set = "0123456789ab";
const vox = new Uint8Array(randomBytes(5000)), voice = new Uint8Array(randomBytes(700));
const manifest = { format: 1, set, voices: [{ name: "ada", id: "4446", label: "Ada", sex: "F", base: "b", source: "x" }], files: {
  "hifi/vox.lsw": { size: vox.length, sha256: sum(vox), site: "models/vox.lsw" },
  "voices/ada.lsw": { size: voice.length, sha256: sum(voice), site: "models/voices/4446.lsw" },
  "voices/ada.vox.lsw": { size: 3, sha256: sum(enc("abc")), site: "models/voices/4446.vox.lsw" },
  "extra.bin": { size: 3, sha256: sum(enc("abc")) },
} };
const host = (files) => ({ "manifest.json": enc(JSON.stringify(manifest)), "hifi/vox.lsw": vox, "voices/ada.lsw": voice, ...files });
function world(homes) {
  const asked = [];
  const own = { "models/site.json": enc("{}"), "models/vox.lsw": enc("the site's own"), "lipservice.wasm": enc("wasm") };
  const fetch = async (url) => {
    asked.push(url);
    const m = /^https:\/\/(\w+)\/(.*)$/.exec(url), files = m ? homes[m[1]] : own, key = m ? m[2] : url;
    const b = files?.[key];
    if (b === "down") throw new Error("connection refused");
    return b ? { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) } : { ok: false, status: 404, statusText: "Not Found" };
  };
  return { fetch, asked };
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const site = { routes: ["hifi"], bundle: { urls: ["https://home/", "https://mirror/"] } };

{ // no bundle: the site's own files
  const w = world({}), l = await loader({ routes: ["hifi"] }, { fetch: w.fetch, caches: null });
  check(l.set === null && new TextDecoder().decode(await l.get("models/vox.lsw")) === "the site's own", "a site with no bundle serves its own files");
  check(/404/.test(await threw(() => l.get("models/none.lsw")) ?? ""), "and a file it lacks is an error");
}
{ // the home has it all
  const w = world({ home: host({}), mirror: host({}) }), said = [];
  const l = await loader(site, { fetch: w.fetch, caches: null, onFail: (m) => said.push(m) });
  check(same(await l.get("models/vox.lsw"), vox) && same(await l.get("models/voices/4446.lsw"), voice) && said.length === 0 && w.asked.every((u) => !u.includes("mirror")), "a bundle's files come from its home, by the paths the page asks for");
  check(new TextDecoder().decode(await l.get("lipservice.wasm")) === "wasm", "what the bundle does not hold is the site's own");
  check(JSON.stringify(await l.voices()) === JSON.stringify([{ name: "4446", label: "Ada", sex: "F", base: "b", parts: ["vox"] }]), "the bundle's voices are listed as a site's are, the name the reader's number, with the parts the bundle keeps apart");
}
{ // the home lacks a file, then gives wrong bytes: the mirror gives it, and it is said
  const w = world({ home: host({ "hifi/vox.lsw": undefined, "voices/ada.lsw": new Uint8Array(voice.length) }), mirror: host({}) }), said = [];
  const l = await loader(site, { fetch: w.fetch, caches: null, onFail: (m) => said.push(m) });
  check(same(await l.get("models/vox.lsw"), vox) && said.length === 1 && /hifi\/vox.lsw from https:\/\/home\/: 404.*taken from https:\/\/mirror\//.test(said[0]), "a file the home lacks comes from the mirror, and the home's failure is said");
  check(same(await l.get("models/voices/4446.lsw"), voice) && said.length === 2 && /sha256/.test(said[1]), "a file the home gives wrong is refused by its hash and comes from the mirror");
}
{ // the home is down for the manifest too
  const w = world({ home: { "manifest.json": "down" }, mirror: host({}) }), said = [];
  const l = await loader(site, { fetch: w.fetch, caches: null, onFail: (m) => said.push(m) });
  check(l.set === set && /manifest from https:\/\/home\/: connection refused/.test(said[0] ?? ""), "a home that is down is said, and the mirror's manifest taken");
}
{ // nothing gives it: an error that names every source
  const w = world({ home: host({ "hifi/vox.lsw": new Uint8Array(7) }), mirror: host({ "hifi/vox.lsw": undefined }) });
  const l = await loader(site, { fetch: w.fetch, caches: null, onFail: () => {} });
  const e = await threw(() => l.get("models/vox.lsw")) ?? "";
  check(/home\/: 7 bytes, not the manifest's 5000/.test(e) && /mirror\/: 404/.test(e), "a file no source gives right is an error naming each source's failure");
}
{ // a manifest of a format the page does not know
  const other = { ...manifest, format: 2 };
  const w = world({ home: { "manifest.json": enc(JSON.stringify(other)) }, mirror: { "manifest.json": enc(JSON.stringify(other)) } });
  check(/its format is 2, and this page reads format 1/.test(await threw(() => loader(site, { fetch: w.fetch, caches: null, onFail: () => {} })) ?? ""), "a manifest of a format the page does not know is refused");
  check((await loader(site, { fetch: world({ home: host({}), mirror: host({}) }).fetch, caches: null })).set === set, "the loader says the manifest's set");
}
// the browser's Cache Storage: named caches of url -> response
function storage(names = []) {
  const all = new Map(names.map((n) => [n, new Map([["https://lipservice.invalid/old", { arrayBuffer: async () => new ArrayBuffer(1) }]])]));
  const open = async (name) => {
    if (!all.has(name)) all.set(name, new Map());
    const store = all.get(name);
    return { match: async (k) => store.get(k), put: async (k, r) => { store.set(k, { arrayBuffer: async () => r.arrayBuffer() }); }, delete: async (k) => store.delete(k), keys: async () => [...store.keys()].map((url) => ({ url })) };
  };
  return { caches: { open, keys: async () => [...all.keys()], delete: async (n) => all.delete(n) }, all };
}
{ // kept: a second loader fetches the manifest alone
  const { caches } = storage();
  const w = world({ home: host({}), mirror: host({}) });
  const a = await loader(site, { fetch: w.fetch, caches });
  await a.get("models/vox.lsw");
  const before = w.asked.length;
  const b = await loader(site, { fetch: w.fetch, caches });
  check(same(await b.get("models/vox.lsw"), vox) && w.asked.length === before + 1 && w.asked[before].endsWith("manifest.json"), "a file kept from an earlier visit is not fetched again");
}
{ // a file overwritten in place, the same name and size: the new bytes, and the old ones dropped
  const { caches, all } = storage(["lipservice-0123456789ab"]);
  const w = world({ home: host({}), mirror: host({}) });
  await (await loader(site, { fetch: w.fetch, caches })).get("models/voices/4446.lsw");
  check(!all.has("lipservice-0123456789ab"), "what was kept by set before is dropped");
  const voice2 = new Uint8Array(randomBytes(voice.length));
  const m2 = { ...manifest, files: { ...manifest.files, "voices/ada.lsw": { ...manifest.files["voices/ada.lsw"], sha256: sum(voice2) } } };
  const host2 = () => host({ "manifest.json": enc(JSON.stringify(m2)), "voices/ada.lsw": voice2 });
  const w2 = world({ home: host2(), mirror: host2() });
  const b = await loader(site, { fetch: w2.fetch, caches });
  check(same(await b.get("models/voices/4446.lsw"), voice2) && w2.asked.some((u) => u.endsWith("voices/ada.lsw")), "a file overwritten with the same size is fetched again, not taken from what was kept");
  check(![...all.get("lipservice-files").keys()].some((k) => k.endsWith(sum(voice))), "and the bytes the manifest no longer names are dropped");
}
{ // a manifest overwritten with a file unchanged: that file is not fetched again
  const { caches } = storage();
  const w = world({ home: host({}), mirror: host({}) });
  await (await loader(site, { fetch: w.fetch, caches })).get("models/vox.lsw");
  const m2 = { ...manifest, set: "ba9876543210" };
  const w2 = world({ home: { "manifest.json": enc(JSON.stringify(m2)) }, mirror: {} });
  const b = await loader(site, { fetch: w2.fetch, caches });
  check(same(await b.get("models/vox.lsw"), vox) && w2.asked.length === 1, "a file the new manifest names unchanged is taken from what was kept");
}
check(/bundle is/.test(await threw(async () => bundleOf({ bundle: { urls: [] } })) ?? "") && /bundle is/.test(await threw(async () => bundleOf({ bundle: { set: "0123456789ab", urls: ["https://home/"] } })) ?? "") && bundleOf({}) === null, "site.json's bundle is checked, a set in it refused");
console.log(bad ? `${bad} failed` : "all passed");
process.exit(bad ? 1 : 0);
