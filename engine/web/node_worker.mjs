// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// worker.js run in a node worker thread as a browser runs it: postMessage, onmessage (messages that
// come before it is set are kept), fetch of the site's files. workerData: {web, site, light, route}
// (route: the one to ask worker.js for, or none for the site's first).
import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { web, site, light, route } = workerData;
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
globalThis.fetch = async (url) => {
  try {
    const b = await readFile(join(site, url));
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
const query = [light ? "light" : null, route ? `route=${route}` : null].filter(Boolean).join("&");
await import(pathToFileURL(join(web, "worker.js")).href + (query ? `?${query}` : ""));
for (const data of early) globalThis.onmessage({ data });
loaded = true;
