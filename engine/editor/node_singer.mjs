// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// singer.js run in a node worker thread as a browser runs it: postMessage, onmessage (messages
// that come before it is set are kept), and fetch of the site's files. workerData: {site, web,
// route}: the built site (lipservice.wasm, models/), the page's files (engine/web), and the route
// to sing by where one is asked for.
import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { site, web, route } = workerData;
const root = pathToFileURL(web + "/"), models = pathToFileURL(join(site, "models") + "/");
globalThis.postMessage = (m, transfer) => parentPort.postMessage(m, transfer);
globalThis.onmessage = null;
// node drains a port's messages, posted while it drains, before any other port's: a worker's own
// MessageChannel would starve its parent's messages, where a browser takes the two in turn
globalThis.MessageChannel = class {
  constructor() {
    const a = { onmessage: null }, b = { onmessage: null };
    a.postMessage = (data) => setImmediate(() => b.onmessage?.({ data }));
    b.postMessage = (data) => setImmediate(() => a.onmessage?.({ data }));
    this.port1 = a;
    this.port2 = b;
  }
};
// the engine is the site's, whichever the page's files are
globalThis.fetch = async (url) => {
  const path = fileURLToPath(url), under = fileURLToPath(root);
  try {
    const b = await readFile(path.startsWith(under) ? join(site, path.slice(under.length)) : path);
    return {
      ok: true, status: 200, statusText: "OK",
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length),
      json: async () => JSON.parse(b.toString()),
    };
  } catch (e) {
    return { ok: false, status: 404, statusText: e.message };
  }
};
const early = [];
let loaded = false;
parentPort.on("message", (data) => (loaded ? globalThis.onmessage({ data }) : early.push(data)));
await import(new URL(`./singer.js?web=${encodeURIComponent(root.href)}&models=${encodeURIComponent(models.href)}${route ? `&route=${route}` : ""}`, import.meta.url).href);
for (const data of early) globalThis.onmessage({ data });
loaded = true;
