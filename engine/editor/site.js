// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A site's model files by their names under models/: the site's own, at `models`, or a hosted
// bundle's where the site's models/site.json names one. A bundle is read by the site's own
// bundle.js (its loader: every file checked against the bundle's manifest, a source that failed
// said), asked for at `web`.
//
//   filesOf({web, models, fetch, said, caches})
//     -> {site, get(name), json(name), voices()}
//   web, models: the two places (where.js), each a folder's address ending in /
//   fetch, caches: the page's or the worker's; said(message): a source of the bundle that failed
//                  where another then gave the file
//   site: models/site.json as read; get: a file's bytes; voices: the site's voice list

export async function filesOf({ web, models, fetch, said, caches }) {
  const ask = async (name) => {
    const url = new URL(name, models), r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${url.pathname}: ${r.status} ${r.statusText}`);
    return r;
  };
  const get = async (name) => new Uint8Array(await (await ask(name)).arrayBuffer());
  const json = async (name) => (await ask(name)).json();
  const site = await json("site.json");
  if (site.bundle === undefined) return { site, get, json, voices: () => json("voices.json") };
  const B = await import(new URL("bundle.js", web).href);
  if (typeof B.loader !== "function") throw new Error("the site names a bundle, and its bundle.js has no loader");
  // the loader asks by the page's paths: models/ is at `models`, and what else it names (the
  // bundle's folder, where the site gives it beside its page) is at `web`
  const at = (path) => (path.startsWith("models/") ? new URL(path.slice("models/".length), models) : new URL(path, web));
  const from = await B.loader(site, { fetch: (path, init) => fetch(at(String(path)), init), onFail: said, caches });
  return { site, get: (name) => from.get(`models/${name}`), json: (name) => from.json(`models/${name}`), voices: from.voices };
}
