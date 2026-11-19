// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The engine off the page's thread. Messages in: {type: "say" | "sing" | "choir" | "choir-load" | "note" |
// "note-stop" | "stop", id, ...}; out: {type: "ready" | "plan" | "sung" | "chunk" | "done" | "error", id, ...}, for a
// choir "choir-open" | "choir-chunk" | "choir-end" | "choir-done", and for a note "note-open" |
// "note-chunk" | "note-end". Ids rise; a stop ends every job up to its id, queued or running. Parts
// load from the server's /models/: what the route makes its sound by (routes.js; worker.js?route=fast asks
// for one, else the site's first: the latent voice, models/vox.lsw, or the vocoder and, for speech, the
// mel route), the phonemizer and the break model. Loaded as worker.js?light, the worker leaves out the mel route and the break model
// (the choir's helpers do), and cannot speak as the page does. No making waits on a timer, so a page
// in the background, whose timers the browser slows, still keeps its speaker fed; sound kept from an
// earlier making is held to a pace by one, counted by the time gone by. A choir told how far to
// sing ("choir-reach") waits there for the next word, which wakes it.

import { Engine, SR } from "./lipservice.js";
import { perform, library, asked, sized } from "./perform.js";
import { add, within } from "./take.js";
import { Held } from "./room.js";
import { routesOf } from "./routes.js";
import { loader } from "./bundle.js";

const query = new URL(import.meta.url).searchParams;
const light = query.has("light");

// A file of the site, asked of the server each time: a copy the browser kept is used only if the
// server says it is still the file, so a build's engine never meets an older build's models.
const ask = async (url) => {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return r;
};
const get = async (url) => new Uint8Array(await (await ask(url)).arrayBuffer());
const json = async (url) => (await ask(url)).json();

let engine = null, list = [], route = null; // route: how the site makes its sound (choirs.js ROUTES)
let files = null; // the site's model files, its own or a hosted bundle's (bundle.js)
const warned = []; // sources of the bundle that failed where a mirror then gave the file
const voices = new Map(); // name: promise of index
const bases = new Map(); // name: promise of index
let cancelled = 0; // jobs with ids up to this are stopped
let reach = { id: 0, to: Infinity }; // the sample of its mix choir `id` is sung up to, until told further (choir.js reach())
let woken = null; // a choir waiting there, to be told

async function init() {
  const t = performance.now();
  const site = await json("models/site.json");
  // the route asked for (worker.js?route=fast), or the site's first
  const routes = routesOf(site);
  route = query.get("route") ?? routes[0];
  if (!routes.includes(route)) throw new Error(`this site has no ${route} sound (it has ${routes.join(" and ")})`);
  const vox = route === "hifi";
  if (![undefined, true, false].includes(site.notes)) throw new Error("models/site.json: notes is true or false");
  files = await loader(site, { onFail: (m) => { warned.push(m); console.warn(m); } });
  const want = { g2p: "models/g2p.lsw", lex: "models/lexicon.lsw" };
  if (vox) want.vox = "models/vox.lsw";
  else want.voc = "models/vocoder.lsw";
  if (!vox && !light) want.mel = "models/melvoc.lsw";
  if (!light) want.brk = "models/breaks.lsw";
  const got = Object.fromEntries(await Promise.all([["wasm", get("lipservice.wasm")], ...Object.entries(want).map(([k, url]) => [k, files.get(url)])].map(async ([k, p]) => [k, await p])));
  engine = await Engine.create(got.wasm);
  if (got.vox) engine.vox(got.vox);
  if (got.voc) engine.vocoder(got.voc);
  if (got.mel) engine.melvoc(got.mel);
  if (got.brk) engine.breaks(got.brk);
  engine.phonemizer(got.g2p, got.lex);
  list = await files.voices();
  postMessage({ type: "ready", voices: list, vox, route, routes, warned: [...warned], notes: site.notes === true, ms: performance.now() - t });
}

// each file is loaded once, however many ask while it loads; a failed load is tried again by the next
const once = (cache, name, load) => {
  if (!cache.has(name)) cache.set(name, load().catch((e) => { cache.delete(name); throw e; }));
  return cache.get(name);
};

const base = (name) => once(bases, name, async () => engine.base(await files.get(`models/bases/${name}.lsw`)));

// A voice's parts of the latent voice and its mel decoder may be files of their own (the voice list's
// "parts": models/voices/NAME.vox.lsw, NAME.mel.lsw), so a worker fetches only what its route runs:
// the vox part on hifi; the mel part where speech goes through the mel route, which a light worker
// does not load. The engine refuses a voice whose part its loaded models need and were not given.
const voice = (name) => once(voices, name, async () => {
  const v = list.find((v) => v.name === name);
  if (!v) throw new Error(`no voice ${name}`);
  const apart = v.parts ?? [];
  if (!Array.isArray(apart) || apart.some((p) => !["vox", "mel"].includes(p))) throw new Error(`the voice ${name}: parts are vox and mel, not ${JSON.stringify(v.parts)}`);
  const part = (p, used) => (apart.includes(p) && used ? files.get(`models/voices/${name}.${p}.lsw`) : undefined);
  const [bytes, b, vox, mel] = await Promise.all([files.get(`models/voices/${name}.lsw`), v.base ? base(v.base) : -1, part("vox", route === "hifi"), part("mel", route === "fast" && !light)]);
  return engine.voice(bytes, b, { vox, mel });
});

// a yield to the event loop that browsers do not slow down as they do a timer: lets a stop in
const chan = new MessageChannel(), waiting = [];
chan.port1.onmessage = () => waiting.shift()();
const yieldNow = () => new Promise((r) => { waiting.push(r); chan.port2.postMessage(0); });

// Speech a step at a time. Each part's plan goes out as it starts ("plan", at: the sample of the
// utterance it starts on), each chunk with the pitch made since the last (Hz a frame of its part,
// from frame `from`); busy counts the time spent making them. The sound goes out held under the
// ceiling (Held), its last samples in a chunk of their own.
async function say(m) {
  const v = await voice(m.voice);
  if (m.id <= cancelled) return;
  const t = performance.now();
  engine.start(v, m.text, m);
  const held = new Held();
  let first = null, n = 0, part = 0, from = 0, busy = performance.now() - t;
  postMessage({ type: "plan", id: m.id, plan: engine.plan(), at: 0 });
  for (;;) {
    const t0 = performance.now();
    const c = engine.step(m.step);
    if (c === null) break;
    const k = engine.part();
    let plan = null;
    if (k !== part) {
      part = k;
      from = 0;
      plan = engine.plan();
    }
    const pitch = engine.pitch(from);
    busy += performance.now() - t0;
    first ??= performance.now() - t;
    if (plan) postMessage({ type: "plan", id: m.id, plan, at: n + plan.gap });
    const len = c.length, frames = pitch.length, y = held.push(c); // the post takes them
    postMessage({ type: "chunk", id: m.id, samples: y, part, from, pitch, busy }, [y.buffer, pitch.buffer]);
    from += frames;
    n += len;
    await yieldNow();
    if (m.id <= cancelled) return;
  }
  const y = held.end();
  postMessage({ type: "chunk", id: m.id, samples: y, part, from, pitch: new Float32Array(0), busy }, [y.buffer]);
  postMessage({ type: "done", id: m.id, first, ms: performance.now() - t, busy, secs: n / SR });
}

// A song sung alone goes out this far under how it is sung. Through the latent voice singing comes 7 to
// 9 dB over speech, its highest samples to 7 dB over full scale; at this it meets the limiter as seldom
// as speech does. Through the vocoder it comes 3 dB quieter and never over full scale, and goes out as loud.
const ALONE = { hifi: 10 ** (-9 / 20), fast: 10 ** (-6 / 20) };

// A song a step at a time, as sing() renders it whole: its frames and rests first ("sung"), then
// chunks with their pitch as for speech, held under the ceiling as speech is. m.style is
// lipservice.js singer()'s, m.motion a pitch motion model's name or none.
async function sing(m) {
  const [v, mo] = await Promise.all([voice(m.voice), m.motion ? motion(m.motion) : -1]);
  if (m.id <= cancelled) return;
  const t = performance.now();
  const s = engine.singer(v, m.song, { ...m.style, shift: m.shift, seed: m.seed, motion: mo });
  try {
    const held = new Held();
    let first = null, n = 0, from = 0, busy = performance.now() - t;
    postMessage({ type: "sung", id: m.id, frames: s.frames, rests: s.rests });
    for (;;) {
      const t0 = performance.now();
      const c = s.step(m.step);
      if (c === null) break;
      const pitch = s.pitch(from);
      busy += performance.now() - t0;
      first ??= performance.now() - t;
      for (let i = 0; i < c.length; i++) c[i] *= ALONE[route];
      const len = c.length, frames = pitch.length, y = held.push(c); // the post takes them
      postMessage({ type: "chunk", id: m.id, samples: y, part: 0, from, pitch, busy }, [y.buffer, pitch.buffer]);
      from += frames;
      n += len;
      await yieldNow();
      if (m.id <= cancelled) return;
    }
    const y = held.end();
    postMessage({ type: "chunk", id: m.id, samples: y, part: 0, from, pitch: new Float32Array(0), busy }, [y.buffer]);
    postMessage({ type: "done", id: m.id, first, ms: performance.now() - t, busy, secs: n / SR });
  } finally {
    s.close();
  }
}

// pitch motion models by name (models/motion-NAME.lsw), and the breaths (models/breaths.*)
const motions = new Map();
const motion = (name) => once(motions, name, async () => engine.motion(await files.get(`models/motion-${name}.lsw`)));
let breathLib = null;
const breaths = () => (breathLib ??= (async () => {
  const [meta, pcm] = await Promise.all([files.json("models/breaths.json"), files.get("models/breaths.bin")]);
  if (meta.sr !== SR) throw new Error(`breaths at ${meta.sr} Hz, not ${SR}`);
  if (pcm.byteLength % 2) throw new Error("breaths.bin: an odd number of bytes");
  return { lib: library(meta.clips), pcm: new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2) };
})().catch((e) => { breathLib = null; throw e; }));

// the breaths that fall in samples [s0, s0 + c.length) of a part, added to its chunk c
function breathe(c, s0, bs, pcm) {
  const k = 1 / 32767;
  for (const { clip, at } of bs) {
    const lo = Math.max(s0, at), hi = Math.min(s0 + c.length, at + clip.n);
    for (let s = lo; s < hi; s++) c[s - s0] += pcm[clip.at + s - at] * k;
  }
}

// A song with the line that has its singer keep the others' clock (sing.rs Song::together), after its bpm.
function clocked(text) {
  const lines = text.split("\n"), k = lines.findIndex((l) => l.trim().split(/\s+/)[0] === "bpm");
  if (k < 0) throw new Error("the song has no bpm line");
  lines.splice(k + 1, 0, "together");
  return lines.join("\n");
}

// The parts as performed, kept from one choir to the next: a part asked for again as it was is not
// performed again, and what of it was sung is not sung again, as long as this worker's parts
// together are no longer than KEEP.
const performed = new Map(); // a part as asked for: {singer, breaths, lag, shift, kept, spans, where, skip}
const HOP = SR / 100;
const KEEP = 600 * SR; // samples
const BURST = 3, PACE = 6; // kept sound is given BURST s at once, then PACE times as fast as it plays: the page has it all to mix

// This worker's parts of a choir, each performed (perform.js) and then given m.step frames at a
// time, the part furthest behind in the piece first, so that they keep together. Each part: {part,
// name, voice, song, shift, seed, at, motion, breath, ...} (choir.js start()). The mix starts at its
// sample m.from, its sample 0 being m.t0 s of the piece: each part is picked up at the frame that
// falls in. What a part has kept is given as it is, at its pace; the rest is sung, the singer picked up
// where the kept runs out. A muted part (p.mute) is performed, so the piece keeps its length, and
// opened at its end: none of it is sung or given. busy counts the time spent making sound; work and
// made count the singing alone, less each step a singer was picked up at, which is mostly the run-up to it.
async function choir(m) {
  const vs = await Promise.all(m.parts.map((p) => voice(p.voice)));
  const mo = await Promise.all(m.parts.map((p) => (p.motion ? motion(p.motion) : -1)));
  const br = m.parts.some((p) => p.breath > 0) ? await breaths() : null;
  if (m.id <= cancelled) return;
  if (!Number.isFinite(m.t0) || !Number.isInteger(m.from) || m.from < 0) throw new Error(`choir: the mix from sample ${m.from}, its sample 0 at ${m.t0} s`);
  const keys = m.parts.map(asked), sung = [];
  for (const [k, x] of performed) {
    if (keys.includes(k)) continue;
    performed.delete(k);
    x.singer.close();
  }
  try {
    for (const [i, p] of m.parts.entries()) {
      if (!performed.has(keys[i])) {
        try {
          // the song the engine is given has the part's vibrato size written into it, and, for a part that
          // keeps time with the others, the line that has it place its consonants by the clock they share
          performed.set(keys[i], Object.assign(perform(p, p.breath > 0 ? br.lib : null, (text, shift) => {
            const s = engine.singer(vs[i], sized(p.together ? clocked(text) : text, p.vibratoSize ?? 1), { ...p, shift, motion: mo[i] });
            return { singer: s, rests: s.rests };
          }), { kept: null, spans: [], where: 0, skip: 0 }));
        } catch (e) {
          throw new Error(`${p.name}: ${e.message}`);
        }
        await yieldNow();
        if (m.id <= cancelled) return;
      }
      sung.push(performed.get(keys[i]));
    }
    const lens = sung.map((x) => x.singer.frames * HOP);
    const keep = lens.reduce((a, b) => a + b, 0) <= KEEP;
    sung.forEach((x, i) => {
      if (keep) x.kept ??= new Float32Array(lens[i]);
      else Object.assign(x, { kept: null, spans: [] });
    });
    const at = sung.map((x, i) => m.parts[i].at + x.lag);
    const made = sung.map((x, i) => (m.parts[i].mute ? lens[i] : HOP * Math.max(0, Math.min(x.singer.frames, Math.floor((m.from - Math.round((at[i] - m.t0) * SR)) / HOP)))));
    postMessage({
      type: "choir-open", id: m.id, parts: m.parts.map((p) => p.part), at, lens, from: [...made],
      // how each was performed: its breaths ([sample of the part, samples]), cents off its pitch, s off its start
      sung: sung.map((x, i) => ({ breaths: x.breaths.map((b) => [b.at, b.clip.n]), cents: (x.shift - (m.parts[i].shift ?? 0)) * 100, lag: x.lag })),
      kept: sung.map((x) => x.spans.map(([a, b]) => [a, b])), // the samples of each that need no singing
    });
    const live = new Set(sung.keys()), first = [...made], began = performance.now();
    let busy = 0, n = 0, work = 0, worked = 0, idle = 0;
    while (live.size) {
      // s a part's kept sound is ahead of its pace: the part waits while over 0
      const due = (performance.now() - began) / 1000 * PACE + BURST;
      const over = (k) => (within(sung[k].spans, made[k]) && made[k] < lens[k] ? (made[k] - first[k]) / SR - due : 0);
      let i = -1;
      for (const k of live) if (over(k) <= 0 && (i < 0 || at[k] + made[k] / SR < at[i] + made[i] / SR)) i = k;
      if (i < 0) {
        await new Promise((r) => setTimeout(r, Math.max(4, 1000 / PACE * Math.min(...[...live].map(over)))));
        if (m.id <= cancelled) return;
        continue;
      }
      if (made[i] < lens[i] && reach.id === m.id && Math.round((at[i] - m.t0) * SR) + made[i] >= reach.to) {
        // the part furthest behind is as far past the speaker as is wanted: nothing more is sung
        // until word comes (a timer too, should the word be lost); idle is the time waited so
        const t = performance.now();
        await new Promise((r) => { woken = r; setTimeout(r, 500); });
        woken = null;
        idle += performance.now() - t;
        if (m.id <= cancelled) return;
        continue;
      }
      const x = sung[i], a = made[i];
      if (a === lens[i]) {
        live.delete(i);
        postMessage({ type: "choir-end", id: m.id, part: m.parts[i].part });
        continue;
      }
      const t = performance.now(), sp = within(x.spans, a);
      let c, counted = false;
      if (sp) {
        c = x.kept.slice(a, Math.min(sp[1], a + m.step * HOP));
      } else {
        const picked = x.where !== a;
        if (picked) {
          const f = Math.floor(a / HOP);
          x.singer.seek(f);
          Object.assign(x, { where: a, skip: a - f * HOP });
        }
        c = x.singer.step(m.step);
        if (c === null) throw new Error(`${m.parts[i].name}: its song ended at sample ${a} of ${lens[i]}`);
        if (x.skip) {
          const k = Math.min(x.skip, c.length);
          c = c.slice(k);
          x.skip -= k;
        }
        x.where += c.length;
        if (x.breaths.length) breathe(c, a, x.breaths, br.pcm);
        if (x.kept) {
          x.kept.set(c, a);
          add(x.spans, a, a + c.length);
        }
        counted = !picked || a === 0;
      }
      const dt = performance.now() - t;
      busy += dt;
      if (counted) { work += dt; worked += c.length; }
      made[i] += c.length;
      n += c.length;
      if (c.length) {
        postMessage({ type: "choir-chunk", id: m.id, part: m.parts[i].part, samples: c, busy: work, made: worked, idle }, [c.buffer]);
        idle = 0;
      }
      await yieldNow();
      if (m.id <= cancelled) return;
    }
    postMessage({ type: "choir-done", id: m.id, busy, secs: n / SR });
  } finally {
    for (const x of sung) { // its stream is let go; the song as planned, and what was sung of it, is kept
      x.singer.seek(0);
      Object.assign(x, { where: 0, skip: 0 });
    }
  }
}

// The crowd pad's notes (live.js): each a song sung whole in the style asked. They are not queued
// behind other jobs: each is taken as it comes, and the note due soonest (its start, at s, plus what
// is made of it) gets the next step. busy counts this worker's time spent on notes.
const notes = new Map(); // "id key": {k, m, s, made}
const dropped = new Set(); // "id key" of notes stopped before they were begun
let pumping = false, noteBusy = 0;

async function note(m) {
  const v = await voice(m.voice);
  const k = `${m.id} ${m.key}`;
  if (dropped.delete(k) || m.id <= cancelled) return;
  const t = performance.now();
  const s = engine.singer(v, m.song, m);
  noteBusy += performance.now() - t;
  notes.set(k, { k, m, s, made: 0 });
  postMessage({ type: "note-open", id: m.id, key: m.key, len: s.frames * SR / 100, busy: noteBusy });
  if (!pumping) pumpNotes();
}

async function pumpNotes() {
  pumping = true;
  try {
    while (notes.size) {
      let x = null;
      for (const y of notes.values()) {
        if (y.m.id <= cancelled) {
          notes.delete(y.k);
          y.s.close();
        } else if (!x || y.m.at + y.made / SR < x.m.at + x.made / SR) {
          x = y;
        }
      }
      if (!x) break;
      const { m } = x, t = performance.now();
      let c;
      try {
        c = x.s.step(m.step);
      } catch (e) {
        notes.delete(x.k);
        x.s.close();
        postMessage({ type: "error", id: m.id, message: e.message });
        continue;
      }
      noteBusy += performance.now() - t;
      if (c === null) {
        notes.delete(x.k);
        x.s.close();
        postMessage({ type: "note-end", id: m.id, key: m.key, busy: noteBusy });
      } else {
        x.made += c.length;
        postMessage({ type: "note-chunk", id: m.id, key: m.key, samples: c, busy: noteBusy }, [c.buffer]);
      }
      await yieldNow();
    }
  } finally {
    pumping = false;
  }
}

// a note no longer wanted: its voice has left the crowd
function noteStop(m) {
  const k = `${m.id} ${m.key}`, x = notes.get(k);
  if (!x) { dropped.add(k); return; }
  notes.delete(k);
  x.s.close();
}

// the voices, motion models and breaths of a choir to come, loaded now
async function load(m) {
  const t = performance.now();
  await Promise.all([...m.voices.map(voice), ...m.motions.map(motion), ...(m.breaths ? [breaths()] : [])]);
  postMessage({ type: "choir-loaded", ms: performance.now() - t });
}

const ready = init().catch((e) => postMessage({ type: "error", id: null, message: e.message }));
let queue = ready;
onmessage = ({ data: m }) => {
  if (m.type === "choir-reach") {
    reach = { id: m.id, to: m.to };
    woken?.();
    return;
  }
  if (m.type === "stop") {
    cancelled = Math.max(cancelled, m.id);
    woken?.();
    for (const k of dropped) if (+k.split(" ")[0] <= cancelled) dropped.delete(k);
    return;
  }
  if (m.type === "note-stop") {
    noteStop(m);
    return;
  }
  if (m.type === "note") {
    ready.then(() => {
      if (!engine) throw new Error("the engine did not load");
      return note(m);
    }).catch((e) => postMessage({ type: "error", id: m.id, message: e.message }));
    return;
  }
  const job = { say, sing, choir, "choir-load": load }[m.type];
  queue = queue.then(() => {
    if (!engine) throw new Error("the engine did not load");
    if (!job) throw new Error(`no message ${m.type}`);
    return job(m);
  }).catch((e) => postMessage({ type: "error", id: m.id ?? null, message: e.message }));
};
