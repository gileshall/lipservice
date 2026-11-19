// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// Where a site's model files come from. A site serves them itself, at the paths the page asks for
// (models/vox.lsw, models/voices/4446.lsw, ...), or names a hosted bundle in models/site.json:
//
//   "bundle": {"urls": ["https://models.lipservice.dev/", "https://mirror.example/"]}
//
// A bundle is a folder whose files are overwritten in place, its manifest beside them
// (python/bundle.py): URL/manifest.json, {"format": 1, "set", "voices": [{"id", "label", "sex",
// "base"}, ...], "files": {NAME: {"size", "sha256", "site"}}}, "set" a hash of the files' hashes
// (said, not checked), "site" the path the page asks for and "voices" what a site's own
// models/voices.json lists (its name the bundle's id). A format the page does not know is refused.
// Every file taken from a bundle is checked against the manifest's size and sha256 whichever source
// gave it, so a source can only give the same bytes or fail. The sources are tried in order: the
// first is the home, the rest are mirrors, and a source that failed is said (onFail) and never
// passed over in silence. A file once checked is kept in the browser's Cache Storage under its
// sha256, where there is one, so a later visit fetches the manifest and what changed in it alone.

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// SHA-256 without the platform's (a page served over plain http has no crypto.subtle).
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256js(bytes) {
  const n = bytes.length, blocks = Math.ceil((n + 9) / 64), w = new Uint32Array(64);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const tail = new Uint8Array(blocks * 64 - Math.floor(n / 64) * 64), at = Math.floor(n / 64) * 64;
  tail.set(bytes.subarray(at));
  tail[n - at] = 0x80;
  new DataView(tail.buffer).setUint32(tail.length - 8, Math.floor(n / 0x20000000));
  new DataView(tail.buffer).setUint32(tail.length - 4, (n * 8) >>> 0);
  for (let b = 0; b < blocks; b++) {
    const src = b * 64 < at ? bytes : tail, o = b * 64 < at ? b * 64 : b * 64 - at;
    for (let i = 0; i < 16; i++) w[i] = (src[o + 4 * i] << 24) | (src[o + 4 * i + 1] << 16) | (src[o + 4 * i + 2] << 8) | src[o + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = (w[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
    }
    let [a, bb, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  h.forEach((v, i) => new DataView(out.buffer).setUint32(4 * i, v));
  return hex(out);
}

export async function sha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  return subtle ? hex(new Uint8Array(await subtle.digest("SHA-256", bytes))) : sha256js(bytes);
}

// Cache Storage for checked files, each under its sha256; a hash the manifest no longer names is dropped.
const KEPT = "lipservice-files", KEPT_AT = "https://lipservice.invalid/sha256/";
const FORMAT = 1;

// What models/site.json says of a bundle, or null where the site serves its own files.
export function bundleOf(site) {
  const b = site.bundle;
  if (b === undefined) return null;
  const ok = b && typeof b === "object" && Object.keys(b).every((k) => k === "urls") && Array.isArray(b.urls) && b.urls.length > 0 && b.urls.every((u) => typeof u === "string" && u.endsWith("/"));
  if (!ok) throw new Error('models/site.json: bundle is {"urls": [folders, each ending in /]}');
  return { urls: b.urls };
}

// The site's files by the paths the page asks for: get(path) gives a file's bytes, json(path) its
// JSON. fetch: the page's; onFail(message): a source that failed where another then gave the file.
export async function loader(site, { fetch = globalThis.fetch, onFail = (m) => console.warn(m), caches = globalThis.caches } = {}) {
  const own = async (path) => {
    const r = await fetch(path, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${r.statusText}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  const bundle = bundleOf(site);
  const text = async (get, path) => JSON.parse(new TextDecoder().decode(await get(path)));
  // a site's own voices: models/voices.json
  if (!bundle) return { set: null, get: own, json: (path) => text(own, path), voices: () => text(own, "models/voices.json") };

  // every source in turn, each one's failure kept; the first to give the thing ends it
  const from = async (what, take) => {
    const failed = [];
    for (const url of bundle.urls) {
      try {
        const got = await take(url);
        for (const f of failed) onFail(`${f}; taken from ${url} instead`);
        return got;
      } catch (e) {
        failed.push(`${what} from ${url}: ${e.message}`);
      }
    }
    throw new Error(failed.join("; "));
  };
  // asked of the source each time: a file overwritten there must not come from the browser's HTTP cache
  const bytesOf = async (url) => {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  const manifest = await from("the bundle's manifest", async (folder) => {
    const m = JSON.parse(new TextDecoder().decode(await bytesOf(`${folder}manifest.json`)));
    if (m.format !== FORMAT) throw new Error(`its format is ${JSON.stringify(m.format)}, and this page reads format ${FORMAT}: reload the page`);
    if (typeof m.set !== "string" || !/^[0-9a-f]{12}$/.test(m.set)) throw new Error("it names no set");
    if (!m.files || typeof m.files !== "object") throw new Error("it lists no files");
    return m;
  });
  const set = manifest.set, bySite = new Map(), sums = new Set();
  for (const [name, f] of Object.entries(manifest.files)) {
    if (!Number.isInteger(f.size) || !/^[0-9a-f]{64}$/.test(f.sha256 ?? "")) throw new Error(`bundle ${set}: ${name} has no size and sha256`);
    sums.add(f.sha256);
    if (f.site === undefined) continue; // a file the page does not ask for
    if (bySite.has(f.site)) throw new Error(`bundle ${set}: ${f.site} is two files`);
    bySite.set(f.site, { name, ...f });
  }
  // kept by content, so a file overwritten in place is fetched again and one unchanged is not
  const keyOf = (sum) => `${KEPT_AT}${sum}`;
  let kept = null;
  if (caches) {
    for (const name of await caches.keys()) if (/^lipservice-[0-9a-f]{12}$/.test(name)) await caches.delete(name); // kept by set, before
    kept = await caches.open(KEPT);
    for (const req of await kept.keys()) {
      const url = typeof req === "string" ? req : req.url;
      if (!sums.has(url.slice(KEPT_AT.length))) await kept.delete(url);
    }
  }
  const checked = async (f, bytes) => {
    if (bytes.length !== f.size) throw new Error(`${bytes.length} bytes, not the manifest's ${f.size}`);
    const sum = await sha256(bytes);
    if (sum !== f.sha256) throw new Error(`sha256 ${sum.slice(0, 12)}, not the manifest's ${f.sha256.slice(0, 12)}`);
    return bytes;
  };
  const get = async (path) => {
    const f = bySite.get(path);
    if (!f) return own(path); // the site's own: its page files, its site.json
    const key = keyOf(f.sha256);
    const hit = kept ? await kept.match(key) : undefined;
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      if (bytes.length === f.size) return bytes; // checked when it was kept
      await kept.delete(key);
    }
    const bytes = await from(f.name, async (folder) => checked(f, await bytesOf(`${folder}${f.name}`)));
    if (kept) await kept.put(key, new Response(bytes.slice(), { headers: { "Content-Type": "application/octet-stream" } }));
    return bytes;
  };
  // the bundle's voices as a site lists them, in the bundle's order
  const voices = async () => {
    if (!Array.isArray(manifest.voices) || !manifest.voices.length) throw new Error(`bundle ${set} lists no voices`);
    return manifest.voices.map((v) => {
      if (![v.id, v.label, v.base].every((x) => typeof x === "string" && x) || !["F", "M"].includes(v.sex)) throw new Error(`bundle ${set}: a voice without id, label, sex and base: ${JSON.stringify(v)}`);
      if (!bySite.has(`models/voices/${v.id}.lsw`)) throw new Error(`bundle ${set}: no file for the voice ${v.id}`);
      // its parts kept in files of their own are the ones the bundle holds
      const parts = ["vox", "mel"].filter((p) => bySite.has(`models/voices/${v.id}.${p}.lsw`));
      return { name: v.id, label: v.label, sex: v.sex, base: v.base, ...(v.group ? { group: v.group } : {}), ...(parts.length ? { parts } : {}) };
    });
  };
  return { set, get, json: (path) => text(get, path), voices };
}
