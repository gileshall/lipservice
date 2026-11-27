// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The lab's engine off the page's thread (render.js). Asked {id, op: "open", models} it loads the
// engine, the models from that folder's URL, and answers {id, voices, bench}; asked {id, op: "sing", text, voice, options} it answers {id,
// samples, plan, pitch, notes}; what fails answers {id, error}, the engine's own words.
import { Renderer } from "./render.js";

const at = (p) => new URL(p, import.meta.url);
const bytes = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return new Uint8Array(await r.arrayBuffer());
};
let lab = null;
// one at a time, in the order asked
let last = Promise.resolve();

const answer = async (m) => {
  if (m.op === "open") {
    if (typeof m.models !== "string") throw new Error("the lab's worker was opened with no models' folder");
    lab = await Renderer.open(await bytes(at("../lipservice.wasm")), (p) => bytes(new URL(p, m.models)));
    return [{ voices: lab.voices, bench: lab.bench }, []];
  }
  if (m.op === "sing") {
    const r = await lab.sing(m.text, m.voice, m.options);
    return [r, [r.samples.buffer]];
  }
  throw new Error(`the lab's worker was asked to ${m.op}`);
};

onmessage = ({ data }) => {
  last = last.then(async () => {
    try {
      const [out, moved] = await answer(data);
      postMessage({ id: data.id, ...out }, moved);
    } catch (e) {
      postMessage({ id: data.id, error: e.message });
    }
  });
};
