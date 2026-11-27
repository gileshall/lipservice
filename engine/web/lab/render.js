// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The lab's engine: the browser build with the models of a bundle (the package's layout: base.lsw,
// g2p.lsw, lexicon.lsw, hifi/vox.lsw, voices/NAME.lsw, hifi/voices/NAME.lsw, motion/NAME.lsw,
// manifest.json), singing a song as the package's sing() and the command line's do. `read(path)`
// gives a file's bytes; a browser's worker and node each bring their own.
import { Engine, Singer } from "../lipservice.js";

// score frames a step, as the package steps
const STEP = 100;

export class Renderer {
  static async open(wasm, read) {
    const e = await Engine.create(wasm);
    e.vox(await read("hifi/vox.lsw"));
    const base = e.base(await read("base.lsw"));
    e.phonemizer(await read("g2p.lsw"), await read("lexicon.lsw"));
    const manifest = JSON.parse(new TextDecoder().decode(await read("manifest.json")));
    // what a bench offers, as the engine has it (ls_bench)
    const bench = e.info(e.check(e.x.ls_bench()));
    return new Renderer(e, read, base, manifest.voices.map((v) => ({ name: v.name, sex: v.sex, label: v.label ?? v.name })), bench);
  }

  constructor(engine, read, base, voices, bench) {
    Object.assign(this, { engine, read, base, voices, bench, loaded: {}, motions: {} });
  }

  async voice(name) {
    if (!this.voices.some((v) => v.name === name)) throw new Error(`no voice ${name}: ${this.voices.map((v) => v.name).join(", ")}`);
    this.loaded[name] ??= this.engine.voice(await this.read(`voices/${name}.lsw`), this.base, { vox: await this.read(`hifi/voices/${name}.lsw`) });
    return this.loaded[name];
  }

  async motion(name) {
    if (!this.bench.motions.includes(name)) throw new Error(`no motion ${name}: none, ${this.bench.motions.join(", ")}`);
    this.motions[name] ??= this.engine.motion(await this.read(`motion/${name}.lsw`));
    return this.motions[name];
  }

  // The song sung by a voice, its style the bench's options by name (ls_sing_with; `motion` a
  // motion's name or "none"): {samples (mono float, 24 kHz, as a voice alone goes out), plan (each
  // word's sounds as planned: [{word, phones: [[symbol, close, start, end, by, dip]]}], samples; by
  // and dip the rules that gave the sound and its dip, places in `rules`, or null), rules (the
  // song's diction as the engine read it, a line each), pitch (Hz
  // a 10 ms frame as sung, 0 where unvoiced), notes ([[start, end, midi, word]], samples)}. What
  // the engine refuses is thrown in its own words.
  async sing(text, voice, options = {}) {
    const e = this.engine;
    const v = await this.voice(voice);
    // who sings, for the rules' for=
    const o = { ...options, who: { voice } };
    if ("motion" in o) o.motion = o.motion === "none" ? -1 : await this.motion(o.motion);
    const enc = new TextEncoder();
    const s = new Singer(e, e.check(e.with(enc.encode(text), (p, n) => e.with(enc.encode(JSON.stringify(o)), (q, m) => e.x.ls_sing_with(v, p, n, q, m)))));
    try {
      const { words: plan, rules } = e.info(e.check(e.x.ls_sing_plan(s.handle)));
      const a = e.alone(true), out = [];
      try {
        for (let c = s.step(STEP); c !== null; c = s.step(STEP)) out.push(a.push(c));
        out.push(a.end());
      } finally {
        a.close();
      }
      const samples = new Float32Array(out.reduce((k, o) => k + o.length, 0));
      let k = 0;
      for (const o of out) { samples.set(o, k); k += o.length; }
      const timing = e.info(e.check(e.x.ls_sing_timing(s.handle)));
      return { samples, plan, rules, pitch: timing.pitch, notes: timing.notes };
    } finally {
      s.close();
    }
  }
}
