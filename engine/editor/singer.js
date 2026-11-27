// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The editor's singer, off the page's thread: a part in, its sound out. It sings through the
// site's own engine build, at the two places its address gives (singer.js?web=URL&models=URL,
// as where.js has them): lipservice.js, perform.js, room.js, routes.js and lipservice.wasm in
// the first, the models in the second, or in the bundle the site names (site.js). Of those it uses
// the engine (Engine: a part performed and its breaths taken, a song's Singer, the sound held under
// the ceiling), perform.js's FPS, SR and LEAD, room.js's rng, and routes.js's routesOf. It sings by the route asked for (&route=fast), or the first of the
// site's, the one the page gives a visitor unasked.
//
// In:  {type: "sing", id, part, step, from, to, early, together}
//                                       the part (part.js), sung `step` frames a chunk: all of it,
//                                       or from the tick `from` and to the tick `to` where they are
//                                       given, both `early` samples sooner (as far as the sound
//                                       goes back), so that a note on `from` keeps the consonants
//                                       it opens with and one on `to` does not start; with
//                                       `together`, its consonants as long as every singer's
//                                       are (the engine's clocked line, sing.rs Song::together)
//      {type: "stop", ids}              ends those jobs
// Jobs are sung at once, a chunk of each in turn, so that several singers' sound comes together.
// Out: {type: "ready", voices, route, routes}
//                                       the site's voices, the route it sings by and the routes
//                                       the site has, once the engine is loaded
//      {type: "open", id, frames, lead, lag, zero, first, last, early, rests, breaths: [[sample, samples]], text, song}
//                                       the part as it will be sung: its length in frames (10 ms),
//                                       the frames before the song's beat 0 (the engine's lead-in
//                                       and the first word's opening consonants), the seconds its
//                                       singer is late by, the sample of its sound the part's beat
//                                       0 falls on (the lead less the lateness), the samples the
//                                       chunks to come run from and to and how many sooner than
//                                       asked that is, the engine's silent
//                                       spans in frames, its breaths, the song the engine was
//                                       given, and that song as the engine reads it (song())
//      {type: "chunk", id, samples}     the next of its sound, mono at 24 kHz
//      {type: "done", id, secs, ms, held}
//                                       all of it given: its length, how long it took to make, and
//                                       the samples of it the limiter turned down
//      {type: "error", id, message, at} what stopped it, and the tick it is at where it has one
//      {type: "warned", message}        a source of the site's bundle failed, and another gave
//                                       the file

import * as P from "./part.js";
import { song, clock } from "./song.js";
import * as S from "./sing.js";
import { filesOf } from "./site.js";

const asked = new URL(import.meta.url).searchParams;
const place = (key) => {
  const v = asked.get(key);
  if (!v || !v.endsWith("/")) throw new Error(`singer.js?${key}=: a folder's address, ending in /, not ${v}`);
  return new URL(v);
};
let files = null; // the site's model files (site.js)
const get = (name) => files.get(name), json = (name) => files.json(name);

let web = null, engine = null, list = [], route = null;
const cancelled = new Set();
// A singer goes out this far under how it is sung, a route its own, as the page's song alone
// does (worker.js ALONE): the engine's highest samples are over full scale, and at this the
// limiter is a net.
const UNDER = { hifi: 10 ** (-9 / 20), fast: 10 ** (-6 / 20) };
const voices = new Map(), bases = new Map(), motions = new Map();
let breathLib = null;

// each file is loaded once, however many ask while it loads; a failed load is tried again by the next
const once = (cache, name, load) => {
  if (!cache.has(name)) cache.set(name, load().catch((e) => { cache.delete(name); throw e; }));
  return cache.get(name);
};
const base = (name) => once(bases, name, async () => engine.base(await get(`bases/${name}.lsw`)));
// A voice's part of the latent voice may be a file of its own (the voice list's "parts" has
// "vox": voices/NAME.vox.lsw), given with the voice where the route is hifi. Its "mel" part is
// speech's, and is not asked for here.
// a voice by the name people call it: its label up to the source in brackets
const called = (v) => v.label.split(" (")[0];
const voice = (name) => once(voices, name, async () => {
  const v = list.find((v) => v.name === name);
  if (!v) throw new Error(`the singer's voice is not on this site: choose one of ${list.map(called).join(", ")}`);
  const apart = v.parts ?? [];
  if (!Array.isArray(apart) || apart.some((p) => p !== "vox" && p !== "mel")) throw new Error(`the voice ${name}: its parts are vox and mel, not ${JSON.stringify(v.parts)}`);
  const own = route === "hifi" && apart.includes("vox");
  const [bytes, b, vox] = await Promise.all([get(`voices/${name}.lsw`), v.base ? base(v.base) : -1, own ? get(`voices/${name}.vox.lsw`) : null]);
  return { index: own ? engine.voice(bytes, b, { vox }) : engine.voice(bytes, b), sex: v.sex, called: called(v) };
});
const motion = (name) => once(motions, name, async () => engine.motion(await get(`motion-${name}.lsw`)));
// the breaths, loaded into the engine once
const breaths = () => (breathLib ??= (async () => {
  const [index, sound] = await Promise.all([get("breaths.json"), get("breaths.bin")]);
  engine.breaths(index, sound);
})().catch((e) => { breathLib = null; throw e; }));

async function init() {
  const WEB = place("web"), MODELS = place("models");
  const [engineJs, performJs, roomJs, routesJs] = await Promise.all(["lipservice.js", "perform.js", "room.js", "routes.js"].map((f) => import(new URL(f, WEB).href)));
  web = { FPS: performJs.FPS, SR: performJs.SR, LEAD: performJs.LEAD, rng: roomJs.rng };
  for (const name of ["rng", "FPS", "SR", "LEAD"]) {
    if (web[name] === undefined) throw new Error(`the site's perform.js and room.js have no ${name}`);
  }
  if (typeof routesJs.routesOf !== "function") throw new Error("the site's routes.js has no routesOf");
  files = await filesOf({ web: WEB, models: MODELS, fetch: (url, o) => fetch(url, o), said: (message) => postMessage({ type: "warned", message }), caches: globalThis.caches });
  const routes = routesJs.routesOf(files.site), by = asked.get("route") ?? routes[0];
  if (!routes.includes(by)) throw new Error(`this site has no ${by} sound (it has ${routes.join(" and ")})`);
  if (UNDER[by] === undefined) throw new Error(`the editor has no level for the site's ${by} route`);
  const engineBytes = async () => {
    const url = new URL("lipservice.wasm", WEB), r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${url.pathname}: ${r.status} ${r.statusText}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  const [wasm, sound, g2p, lex] = await Promise.all([engineBytes(), get(by === "hifi" ? "vox.lsw" : "vocoder.lsw"), get("g2p.lsw"), get("lexicon.lsw")]);
  engine = await engineJs.Engine.create(wasm);
  if (by === "hifi") engine.vox(sound);
  else engine.vocoder(sound);
  engine.phonemizer(g2p, lex);
  list = await files.voices();
  route = by;
  postMessage({ type: "ready", voices: list, route, routes });
}

// a yield to the event loop that browsers do not slow down as they do a timer: lets a stop in
const chan = new MessageChannel(), waiting = [];
chan.port1.onmessage = () => waiting.shift()();
const yieldNow = () => new Promise((r) => { waiting.push(r); chan.port2.postMessage(0); });

async function sing(m) {
  const t = performance.now(), part = m.part, s = part.singer, under = UNDER[route];
  const sung = song(part);
  const marked = [...sung.wants.values()].some(Boolean);
  const [v, mo] = await Promise.all([voice(s.voice), s.motion ? motion(s.motion) : -1, s.breath > 0 || marked ? breaths() : null]);
  if (cancelled.has(m.id)) return;
  let p;
  try {
    p = engine.perform(v.index, S.asked(part, sung, v, S.style(web, s, mo), Boolean(m.together)), mo);
  } catch (e) {
    const where = S.located(e.message, part, sung);
    throw Object.assign(new Error(where.message), { at: e.at ?? where.at });
  }
  let alone = null;
  try {
    alone = engine.alone(false);
    // the sound held under the ceiling on its way out by the engine (alone.rs, the room's
    // limiter), each sample in its own place: what hold() gives runs the limiter's delay behind
    // what it is given, and each sample given back is set beside the one that went in, to count
    // those it turned down
    const waiting = [];
    let held = 0, at = 0; // the samples gone in and not yet back, and how far into the first of them
    const back = (y) => {
      for (let i = 0; i < y.length; i++) {
        while (at === waiting[0].length) {
          waiting.shift();
          at = 0;
        }
        const x = waiting[0][at++];
        if (Math.abs(y[i] - x) > 1e-4 * Math.abs(x)) held++;
      }
      return y;
    };
    const hold = (c) => {
      waiting.push(Float32Array.from(c));
      return back(alone.push(c));
    };
    // a frame's samples, and the sample of the sound each tick falls on
    const read = engine.song(p.text), per = web.SR / web.FPS, frames = p.singer.frames, lead = S.opening(web, read, frames);
    const zero = Math.round((lead / web.FPS - p.lag) * web.SR), secs = clock(part);
    const sample = (tick) => zero + Math.round(secs(tick) * web.SR);
    const tick = (v) => v === undefined || (Number.isInteger(v) && v >= 0);
    if (!tick(m.from) || !tick(m.to) || !tick(m.early) || (m.from !== undefined && m.to !== undefined && m.to <= m.from)) throw new Error(`sung from tick ${m.from} to ${m.to}, ${m.early} samples early: not a stretch of the part`);
    // the samples given
    const early = m.from === undefined ? 0 : Math.max(0, Math.min(m.early ?? 0, sample(m.from)));
    const first = m.from === undefined ? 0 : sample(m.from) - early, last = m.to === undefined ? frames * per : Math.min(frames * per, sample(m.to) - early);
    if (last <= first) throw new Error(`beat ${P.beat(m.from ?? 0, part.grid)}${m.to === undefined ? "" : ` to ${P.beat(m.to, part.grid)}`}: the part has no sound there`);
    const f0 = Math.floor(first / per);
    if (f0 > 0) p.singer.seek(f0);
    postMessage({ type: "open", id: m.id, frames, lead, lag: p.lag, zero, first, last, early, rests: p.singer.rests, breaths: p.breaths, text: p.text, song: read });
    let n = f0 * per;
    while (n < last) {
      const c = p.singer.step(m.step);
      if (c === null) break;
      for (let i = 0; i < c.length; i++) c[i] *= under;
      const lo = Math.max(0, first - n), hi = Math.min(c.length, last - n);
      n += c.length;
      if (hi > lo) {
        const y = hold(lo === 0 && hi === c.length ? c : c.subarray(lo, hi));
        postMessage({ type: "chunk", id: m.id, samples: y }, [y.buffer]);
      }
      await yieldNow();
      if (cancelled.has(m.id)) return;
    }
    if (n < last) throw new Error(`the engine gave ${n} samples of the ${last} asked for`);
    const y = back(alone.end());
    postMessage({ type: "chunk", id: m.id, samples: y }, [y.buffer]);
    postMessage({ type: "done", id: m.id, secs: (last - first) / web.SR, ms: performance.now() - t, held });
  } finally {
    alone?.close();
    p.singer.close();
  }
}

const ready = init().catch((e) => postMessage({ type: "error", id: null, message: e.message, at: null }));
onmessage = ({ data: m }) => {
  if (m.type === "stop") {
    for (const id of m.ids) cancelled.add(id);
    return;
  }
  if (m.type !== "sing") {
    postMessage({ type: "error", id: m.id ?? null, message: `the singer is asked to ${m.type}: it sings and it stops`, at: null });
    return;
  }
  ready.then(async () => {
    try {
      if (cancelled.has(m.id)) return;
      if (!engine) throw new Error("the engine is not loaded");
      await sing(m);
    } catch (e) {
      postMessage({ type: "error", id: m.id, message: e.message, at: e.at ?? null });
    } finally {
      cancelled.delete(m.id);
    }
  });
};
