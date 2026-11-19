// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The mixer's tab: a strip a singer (its name, mute, solo, level, pan, and how loud it is now),
// the master's strip, and the master's chain of effects, each a card of its settings in the order
// the sound goes through them. Every number is a pull field (pull.js); every change is given to
// the page at once, as a function from the mix to the mix.
//
//   mixer(document, host, {begin, end, change(f), show(i), name(i), color(i)})
//     -> {render(desk), meters(peaks)}
//   desk: {rows: [{level, pan, mute, solo}], master, chain}
//   peaks: mix.js peaks(), or null for silence

import { EFFECTS, LEVEL, MOST, effect } from "./score.js";
import { pull } from "./pull.js";

const FLOOR = -60, TOP = 6; // dB a meter shows from and to
const FALL = 1.2; // dB a meter falls a frame

export function mixer(document, host, page) {
  const make = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const strips = make("div", "mx-strips"), chainHead = make("h2", null, "Master chain"), chain = make("div", "mx-chain");
  const hint = make("div", "mx-hint", "All the singers together pass through these effects, left to right, and then the master level.");
  host.replaceChildren(strips, chainHead, hint, chain);
  let desk = null, built = { strips: "", chain: "" };
  let fields = { strips: [], master: null, fx: [] }; // what render() sets: [{level, pan, m, s, meter}], {level, meters}, [{on, pulls}]
  const levels = []; // each meter's bar as shown, dB

  const field = (o) => pull(document, { begin: page.begin, end: page.end, ...o });
  const row = (i, f) => (d) => ({ ...d, rows: d.rows.map((r, j) => (j === i ? f(r) : r)) });
  const fx = (i, f) => (d) => ({ ...d, chain: d.chain.map((e, j) => (j === i ? f(e) : e)) });
  // a button's change, whole; the keys are not left with the button, so that space sings
  const press = (el, f) => el.addEventListener("click", () => {
    page.begin();
    page.change(f);
    page.end();
    el.blur?.();
  });
  const meter = () => {
    const el = make("div", "meter"), bar = make("div", "meter-bar");
    el.append(bar);
    levels.push({ bar, el, db: -Infinity, over: 0 });
    return levels.at(-1);
  };
  const level = (get, set) => field({ min: LEVEL.min, max: LEVEL.max, step: 0.1, fine: 0.1, def: 0, origin: LEVEL.min, label: "level", show: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`, change: set });

  function buildStrips() {
    levels.length = 0;
    fields.strips = desk.rows.map((_, i) => {
      const el = make("div", "mx-strip"), name = make("button", "mx-name"), dot = make("span", "dot"), label = make("span", "mx-label");
      dot.style.background = page.color(i);
      name.append(dot, label);
      name.title = "Open this singer's notes";
      name.addEventListener("click", () => page.show(i));
      const m = make("button", "mx-m", "M"), s = make("button", "mx-s", "S");
      m.title = "Mute this singer";
      s.title = "Solo: hear only this singer";
      press(m, row(i, (r) => ({ ...r, mute: !r.mute })));
      press(s, row(i, (r) => ({ ...r, solo: !r.solo })));
      const lv = level(null, (v) => page.change(row(i, (r) => ({ ...r, level: v }))));
      const pan = field({ min: -1, max: 1, step: 0.01, fine: 0.01, def: 0, origin: 0, label: "pan", show: (v) => (v === 0 ? "C" : `${v < 0 ? "L" : "R"} ${Math.round(Math.abs(v) * 100)}`), change: (v) => page.change(row(i, (r) => ({ ...r, pan: v }))) });
      pan.el.className += " narrow";
      const mt = meter();
      el.append(name, m, s, lv.el, pan.el, mt.el);
      return { el, label, m, s, level: lv, pan, meter: mt };
    });
    const el = make("div", "mx-strip master"), name = make("div", "mx-name", "Master");
    const lv = level(null, (v) => page.change((d) => ({ ...d, master: v })));
    const pair = make("div", "meter-pair"), meters = [meter(), meter()];
    pair.append(meters[0].el, meters[1].el);
    el.append(name, make("span", "mx-gap"), lv.el, make("span", "mx-gap narrow"), pair);
    fields.master = { level: lv, meters };
    strips.replaceChildren(...fields.strips.map((s) => s.el), el);
  }

  function buildChain() {
    fields.fx = desk.chain.map((e, i) => {
      const card = make("div", "fx"), head = make("div", "fx-head");
      const on = make("button", "fx-on", e.kind), left = make("button", "fx-btn", "◀"), right = make("button", "fx-btn", "▶"), gone = make("button", "fx-btn", "✕");
      on.title = "Turn this effect on or off";
      left.title = "Move this effect earlier";
      right.title = "Move this effect later";
      gone.title = "Remove this effect";
      left.disabled = i === 0;
      right.disabled = i === desk.chain.length - 1;
      press(on, fx(i, (x) => ({ ...x, on: !x.on })));
      const swap = (j) => (d) => {
        const c = [...d.chain];
        [c[i], c[j]] = [c[j], c[i]];
        return { ...d, chain: c };
      };
      press(left, swap(i - 1));
      press(right, swap(i + 1));
      press(gone, (d) => ({ ...d, chain: d.chain.filter((_, j) => j !== i) }));
      head.append(on, left, right, gone);
      const body = make("div", "fx-body");
      const pulls = EFFECTS[e.kind].map((s) => {
        const f = field({ min: s.min, max: s.max, step: s.step, fine: s.step, log: s.log, def: s.def, unit: s.unit, origin: s.min < 0 && s.max > 0 ? 0 : s.min, label: `${e.kind} ${s.name}`, change: (v) => page.change(fx(i, (x) => ({ ...x, [s.name]: v }))) });
        body.append(make("label", null, s.name), f.el);
        return [s.name, f];
      });
      card.append(head, body);
      return { card, on, pulls };
    });
    const add = make("select", "fx-add"), option = (value, text) => {
      const o = make("option", null, text);
      o.value = value;
      return o;
    };
    add.replaceChildren(option("", "+ effect"), ...Object.keys(EFFECTS).map((k) => option(k, k)));
    add.addEventListener("change", () => {
      const kind = add.value;
      add.value = "";
      if (!kind) return;
      page.begin();
      page.change((d) => ({ ...d, chain: [...d.chain, effect(kind)] }));
      page.end();
    });
    chain.replaceChildren(...fields.fx.map((f) => f.card), add);
  }

  return {
    render(next) {
      desk = next;
      const sig = { strips: String(desk.rows.length), chain: desk.chain.map((e) => e.kind).join(" ") };
      if (sig.strips !== built.strips) buildStrips();
      if (sig.chain !== built.chain) buildChain();
      built = sig;
      const solo = desk.rows.some((r) => r.solo);
      desk.rows.forEach((r, i) => {
        const f = fields.strips[i];
        f.label.textContent = page.name(i);
        f.m.setAttribute("aria-pressed", String(r.mute));
        f.s.setAttribute("aria-pressed", String(r.solo));
        f.el.className = `mx-strip${r.mute || (solo && !r.solo) ? " quiet" : ""}`;
        f.level.set(r.level);
        f.pan.set(r.pan);
      });
      fields.master.level.set(desk.master);
      desk.chain.forEach((e, i) => {
        const f = fields.fx[i];
        f.on.setAttribute("aria-pressed", String(e.on));
        f.card.className = `fx${e.on ? "" : " off"}`;
        for (const [name, p] of f.pulls) p.set(e[name]);
      });
    },
    // each meter to the most of the moment, falling slowly from it; red a while after it passes full scale
    meters(peaks) {
      const now = peaks ? [...peaks.singers.slice(0, fields.strips.length), ...peaks.master] : levels.map(() => -Infinity);
      let moving = false;
      levels.forEach((m, i) => {
        const db = now[i] ?? -Infinity;
        m.db = Math.max(db, m.db - FALL);
        if (db > 0) m.over = 90;
        else if (m.over > 0) m.over--;
        m.bar.style.width = `${Math.max(0, Math.min(1, (m.db - FLOOR) / (TOP - FLOOR))) * 100}%`;
        m.el.className = `meter${m.over > 0 ? " over" : ""}`;
        if (m.db > FLOOR || m.over > 0) moving = true;
      });
      return moving;
    },
    most: MOST,
    get fields() { return fields; },
  };
}
