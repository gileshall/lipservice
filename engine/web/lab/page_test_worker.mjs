// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// worker.js run in a node worker thread as a browser runs it (page_test.mjs): postMessage,
// onmessage and a fetch: of the files beside it, and of models on the network when built so.
import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

globalThis.postMessage = (m, moved) => parentPort.postMessage(m, moved);
globalThis.onmessage = null;
const net = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (/^https?:$/.test(new URL(url).protocol)) return net(url);
  try {
    const b = await readFile(fileURLToPath(url));
    return { ok: true, status: 200, statusText: "OK", arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
  } catch (e) {
    return { ok: false, status: 404, statusText: e.message };
  }
};
await import(workerData.url);
parentPort.on("message", (data) => globalThis.onmessage({ data }));
