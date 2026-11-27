// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The diction bench without its page: one singer's song and how it is sung (model.js's state),
// sung again on every change; the sound chosen in it; takes kept by name; a sweep's runs; which of
// them is heard and which it flips with; undo. `sing(text, voice, options)` is the engine's
// (render.js), `store` keeps the session between visits, `changed(what)` tells the page.
import { SR, checked, fresh, fromPlan, levels, parsePhones, phonesText, setBpm, setNote, setWordPhones, sungText, targets, wordLines, wordSpan } from "./model.js";

const FORMAT = 6;
// sung songs kept to flip and undo without singing again: this many, and this many samples at most
const KEPT = 48, KEPT_SAMPLES = 60e6;
const clone = (x) => JSON.parse(JSON.stringify(x));

export class Bench {
  constructor({ sing, bench, voices, store, changed = () => {} }) {
    Object.assign(this, { ask: sing, bench, voices, store, changed });
    this.state = fresh(bench, voices);
    this.sung = null; // the state as sung: {samples, plan, pitch, notes, level}, or null with nothing to sing
    this.error = null; // the engine's refusal of the state as it is
    this.busy = 0;
    this.sel = null; // the word chosen and the sound in it: {k, i (or null)}
    this.region = null; // what is played, [from, to] seconds; null: the whole song
    this.follow = false; // the region is the chosen word's, and moves with it
    this.margin = 0.3; // seconds played either side of a chosen word
    this.takes = []; // {id, name, state, sung, error}
    this.sweep = null; // {label, runs: [{value, label, state, sung, error}]}
    this.heard = { kind: "bench" }; // what is shown and played: the bench, a take or a sweep's run
    this.other = null; // what it flips with
    this.past = [];
    this.future = [];
    this.view = { zoom: 120 }; // the page's own, kept with the session
    this.cache = new Map();
    this.asked = 0;
    this.ids = 0;
  }

  // ---------------------------------------------------------------- singing

  // a state sung: its result, null with no song written; the engine's refusal thrown in its words
  async render(state) {
    if (!state.text.trim()) return null;
    const { text, lines } = sungText(state);
    const key = JSON.stringify([text, state.voice, state.options]);
    if (this.cache.has(key)) {
      const r = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, r);
      return r;
    }
    let r;
    try {
      r = await this.ask(text, state.voice, state.options);
    } catch (e) {
      // the engine counts the rules' lines too; the song's own lines are what the reader sees
      throw new Error(e.message.replace(/^line (\d+):/, (m, n) => (Number(n) > lines ? `line ${Number(n) - lines}:` : `the rules, line ${n}:`)));
    }
    r.level = levels(r.samples);
    this.cache.set(key, r);
    let total = 0;
    for (const v of this.cache.values()) total += v.samples.length;
    for (const [k, v] of this.cache) {
      if (this.cache.size <= KEPT && total <= KEPT_SAMPLES) break;
      if (v === r) continue;
      this.cache.delete(k);
      total -= v.samples.length;
    }
    return r;
  }

  // the bench's state sung again
  async resing() {
    const mine = ++this.asked;
    this.busy++;
    this.changed("busy");
    try {
      const r = await this.render(this.state);
      if (mine !== this.asked) return;
      Object.assign(this, { sung: r, error: null });
    } catch (e) {
      if (mine !== this.asked) return;
      this.error = e.message;
    } finally {
      this.busy--;
    }
    this.settle();
    this.changed("sung");
  }

  // the chosen sound and the played region held to what is now sung
  settle() {
    const plan = this.sung?.plan;
    if (this.sel && (!plan || this.sel.k >= plan.length)) Object.assign(this, { sel: null, follow: false });
    if (this.sel && this.sel.i !== null && !this.error && this.sel.i >= plan[this.sel.k].phones.length) this.sel.i = null;
    if (this.sel && this.follow && !this.error) this.region = this.around(this.sel.k);
    if (!this.sung) this.region = null;
  }

  // ---------------------------------------------------------------- changes, each sung at once

  commit(state) {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return Promise.resolve();
    this.past.push(this.state);
    if (this.past.length > 200) this.past.shift();
    this.future = [];
    return this.become(state);
  }
  become(state) {
    this.state = state;
    if (this.heard.kind !== "bench") Object.assign(this, { other: this.heard, heard: { kind: "bench" } });
    this.save();
    return this.resing();
  }
  undo() {
    if (!this.past.length) return Promise.resolve();
    this.future.push(this.state);
    return this.become(this.past.pop());
  }
  redo() {
    if (!this.future.length) return Promise.resolve();
    this.past.push(this.state);
    return this.become(this.future.pop());
  }

  setText(text) { return this.commit({ ...clone(this.state), text }); }
  setVoice(voice) { return this.commit({ ...clone(this.state), voice }); }
  setOption(name, value) {
    const s = clone(this.state);
    if (!(name in s.options)) throw new Error(`${name}: not a sing option`);
    s.options[name] = value;
    return this.commit(s);
  }
  // the rules changed by `f(rules)`
  setRules(f) {
    const s = clone(this.state);
    f(s.rules);
    return this.commit(s);
  }
  setBpm(bpm) { return this.setText(setBpm(this.state.text, bpm)); }
  setNote(k, j, to) { return this.setText(setNote(this.state.text, k, j, to)); }

  // word k's sounds: as its braces write them, else as the engine planned them
  phones(k) {
    const w = wordLines(this.state.text)[k];
    if (!w) throw new Error(`the song has no word ${k + 1}`);
    if (w.braces !== null) return parsePhones(w.braces, this.bench);
    if (!this.sung || this.error) throw new Error("the song is not sung as it stands, so the engine's sounds for this word are not known");
    return fromPlan(this.sung.plan[k]);
  }
  // word k sung with these sounds; null: as the engine reads the word
  edit(k, phones) { return this.setText(setWordPhones(this.state.text, k, phones)); }
  // every such word of the song sung as word k is written
  everywhere(k) {
    const word = wordLines(this.state.text)[k].word.toLowerCase(), phones = this.phones(k);
    return this.setRules((r) => {
      r.rows = r.rows.filter((w) => !(w.kind === "word" && w.word === word));
      r.rows.push({ kind: "word", word, phones: phonesText(phones) });
    });
  }

  // ---------------------------------------------------------------- what is chosen and played

  around(k) {
    const [a, b] = wordSpan(this.sung.plan, k);
    return [Math.max(0, a / SR - this.margin), Math.min(this.sung.samples.length / SR, b / SR + this.margin)];
  }
  // word k chosen, and sound i in it (or none): it and a little either side is what plays
  select(k, i = null) {
    if (k === null) Object.assign(this, { sel: null, follow: false, region: null });
    else {
      Object.assign(this, { sel: { k, i }, follow: true });
      const s = this.shown();
      if (s && k < s.plan.length) this.region = [Math.max(0, wordSpan(s.plan, k)[0] / SR - this.margin), Math.min(s.samples.length / SR, wordSpan(s.plan, k)[1] / SR + this.margin)];
    }
    this.save();
    this.changed("selected");
  }
  setRegion(region) {
    Object.assign(this, { region, follow: false });
    this.save();
    this.changed("region");
  }
  setMargin(s) {
    this.margin = s;
    if (this.sel && this.follow) return this.select(this.sel.k, this.sel.i);
    this.save();
    this.changed("region");
  }
  // the chosen sound where it can be changed (the bench is what is shown, or `unseen`): {k, i, phones}, or null
  chosen(unseen = false) {
    if (!this.sel || this.sel.i === null || (this.heard.kind !== "bench" && !unseen)) return null;
    try {
      const phones = this.phones(this.sel.k);
      return this.sel.i < phones.length ? { k: this.sel.k, i: this.sel.i, phones } : null;
    } catch {
      return null;
    }
  }

  // what a reference is: {name, state, sung, error}
  what(ref) {
    if (ref.kind === "bench") return { name: "the bench", state: this.state, sung: this.sung, error: this.error };
    if (ref.kind === "take") {
      const t = this.takes.find((x) => x.id === ref.id);
      if (!t) throw new Error(`no take ${ref.id}`);
      return t;
    }
    const r = this.sweep?.runs[ref.k];
    if (!r) throw new Error(`no run ${ref.k} of a sweep`);
    return { ...r, name: r.label };
  }
  same(a, b) { return a !== null && b !== null && a.kind === b.kind && a.id === b.id && a.k === b.k; }
  // the sung song shown and played
  shown() { return this.what(this.heard).sung; }
  // a reference heard; what was heard before is what it flips with
  async hear(ref) {
    const w = this.what(ref);
    if (ref.kind === "take" && !w.sung && !w.error) {
      this.busy++;
      this.changed("busy");
      try { w.sung = await this.render(w.state); } catch (e) { w.error = e.message; } finally { this.busy--; }
    }
    if (!this.same(ref, this.heard)) Object.assign(this, { other: this.heard, heard: ref });
    this.changed("heard");
  }
  flip() {
    if (!this.other) return Promise.resolve();
    return this.hear(this.other);
  }
  // a reference that is gone is not heard or flipped to
  forget(gone) {
    if (gone(this.heard)) this.heard = { kind: "bench" };
    if (this.other && (gone(this.other) || this.same(this.other, this.heard))) this.other = null;
  }

  // ---------------------------------------------------------------- takes

  // what a reference sings, kept under a name
  keep(name, ref = { kind: "bench" }) {
    const w = this.what(ref), id = ++this.ids;
    this.takes.push({ id, name: name.trim() || `take ${id}`, state: clone(w.state), sung: w.error ? null : w.sung, error: w.error });
    this.save();
    this.changed("takes");
    return id;
  }
  rename(id, name) {
    this.what({ kind: "take", id }).name = name;
    this.save();
  }
  drop(id) {
    this.takes = this.takes.filter((t) => t.id !== id);
    this.forget((r) => r.kind === "take" && r.id === id);
    this.save();
    this.changed("takes");
  }
  // a take or a run put on the bench, to change it
  load(ref) { return this.commit(clone(this.what(ref).state)); }

  // ---------------------------------------------------------------- sweeps

  targets() { return targets(this.state, this.bench, this.chosen(true)); }
  // the bench's state sung once for each value of a target
  async run(id, values) {
    const t = this.targets().find((x) => x.id === id);
    if (!t) throw new Error(`${id}: nothing to sweep`);
    const said = (v) => {
      if (t.kind !== "choice") return String(v);
      const c = t.choices.find((x) => x.value === v);
      if (!c) throw new Error(`${v}: not one of ${t.label}`);
      return c.label;
    };
    const sweep = { label: t.label, runs: values.map((v) => ({ value: v, said: said(v), label: `${t.label}: ${said(v)}`, state: t.set(this.state, v), sung: null, error: null })) };
    this.forget((r) => r.kind === "run");
    this.sweep = sweep;
    this.busy++;
    this.changed("sweep");
    try {
      for (const r of sweep.runs) {
        if (this.sweep !== sweep) return;
        try { r.sung = await this.render(r.state); } catch (e) { r.error = e.message; }
        this.changed("run");
      }
    } finally {
      this.busy--;
      this.changed("sweep");
    }
  }
  endSweep() {
    this.forget((r) => r.kind === "run");
    this.sweep = null;
    this.changed("sweep");
  }

  // ---------------------------------------------------------------- kept between visits

  export() {
    return { format: FORMAT, state: this.state, takes: this.takes.map(({ id, name, state }) => ({ id, name, state })), sel: this.sel, region: this.region, follow: this.follow, margin: this.margin, view: this.view };
  }
  save() { this.store.set(JSON.stringify(this.export())); }
  // a saved session taken up; one that is not this bench's is refused
  async load_saved(json) {
    const s = JSON.parse(json);
    if (s.format !== FORMAT) throw new Error(`it was saved as format ${s.format}; this page reads only format ${FORMAT}`);
    const read = (st) => checked(st, this.bench, this.voices);
    const state = read(s.state);
    const takes = s.takes.map((t) => ({ id: t.id, name: String(t.name), state: read(t.state), sung: null, error: null }));
    Object.assign(this, { state, takes, sel: s.sel ?? null, region: s.region ?? null, follow: !!s.follow, margin: s.margin ?? this.margin, view: { ...this.view, ...s.view } });
    this.ids = Math.max(0, ...takes.map((t) => t.id));
    Object.assign(this, { past: [], future: [], heard: { kind: "bench" }, other: null, sweep: null });
    await this.resing();
  }
}
