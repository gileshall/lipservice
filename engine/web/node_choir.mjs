// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// choir.js in node: worker.js in worker threads (node_worker.mjs), one with the speech model and
// light helpers, as the page starts them.
//
//     const choir = await nodeChoir(site, { onSound, onOpen, onDone, onError, route });
//
// site: the built site (lipservice.wasm and models/); the page's files are this directory's.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { Choir } from "./choir.js";
import { Engine } from "./lipservice.js";
import { setEngine } from "./room.js";
import { routesOf } from "./routes.js";

const web = dirname(fileURLToPath(import.meta.url));

// The route a tool works a built site by (routes.js): the one ROUTE names in the environment, or the
// site's only one.
export function routeOf(site) {
  const routes = routesOf(JSON.parse(readFileSync(join(site, "models/site.json"), "utf8")));
  const route = process.env.ROUTE ?? (routes.length === 1 ? routes[0] : null);
  if (!routes.includes(route)) throw new Error(`${site} has ${routes.join(" and ")}: ROUTE names the one to use${route ? `, not ${route}` : ""}`);
  return route;
}

export async function nodeChoir(site, { onSound = () => {}, onOpen = () => {}, onDone = () => {}, onError, cap = +(process.env.CHOIR_WORKERS ?? 4), route = routeOf(site) }) {
  if (!onError) throw new Error("nodeChoir: no onError");
  class NodeWorker {
    constructor(light) {
      this.w = new Worker(join(web, "node_worker.mjs"), { workerData: { web, site, light, route } });
      this.onmessage = null;
      this.w.on("message", (data) => this.onmessage?.({ data }));
      this.w.on("error", (e) => onError(e.stack ?? String(e)));
    }
    postMessage(m, transfer) { this.w.postMessage(m, transfer); }
    terminate() { return this.w.terminate(); }
  }
  // the mixer and the room run in an engine on this thread
  setEngine(await Engine.create(readFileSync(join(site, "lipservice.wasm"))));
  const main = new NodeWorker(false);
  const choir = new Choir({ main, cores: cpus().length, cap, spawn: () => new NodeWorker(true), onSound, onOpen, onDone, onError });
  await new Promise((resolve, reject) => {
    main.onmessage = ({ data }) => {
      if (data.type === "ready") resolve();
      else if (data.type === "error") reject(new Error(data.message));
      else choir.message(0, data);
    };
  });
  main.onmessage = ({ data }) => choir.message(0, data);
  return choir;
}
