// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The stage (stage.js) drawn on a canvas that records where its words are written, and tapped: its
// singers, their light and breath, and its words are inside its canvas at any width and size of
// choir (the glow and the way to the listener, below, may run out of it), and a tap on a singer asks
// for that singer alone where the stage's singers can be.
//
//     node stage_test.mjs

import { makeSeats } from "./choir.js";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };

globalThis.matchMedia = () => ({ addEventListener() {} });
globalThis.window = globalThis;
globalThis.devicePixelRatio = 1;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "#888" });
class El {
  constructor() { Object.assign(this, { children: [], hidden: false, style: {}, on: {}, textContent: "" }); }
  replaceChildren(...xs) { this.children = xs; }
  addEventListener(n, f) { this.on[n] = f; }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
}
globalThis.document = { documentElement: {}, createElement: () => new El() };
const { Stage, layout } = await import("./stage.js");

// a canvas `w` wide whose context keeps the box of the text written on it (7 px a letter, 9 px tall
// above its line)
function canvas(w) {
  const cv = new El();
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const at = (x, y) => { box.x0 = Math.min(box.x0, x); box.x1 = Math.max(box.x1, x); box.y0 = Math.min(box.y0, y); box.y1 = Math.max(box.y1, y); };
  let align = "left";
  const g = {
    setTransform() {}, clearRect() {}, beginPath() {}, fill() {}, stroke() {}, setLineDash() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    arc() {}, moveTo() {}, lineTo() {},
    measureText: (s) => ({ width: 7 * String(s).length }),
    fillText(s, x, y) { const tw = 7 * String(s).length, x0 = align === "center" ? x - tw / 2 : x; at(x0, y - 9); at(x0 + tw, y + 2); },
    set textAlign(v) { align = v; }, get textAlign() { return align; },
  };
  cv.clientWidth = w;
  cv.getContext = () => g;
  return { cv, box, reset: () => Object.assign(box, { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }) };
}

// n singers, all singing as loud as the loudest and at the widest of a breath
const spec = (n, more = {}) => {
  const seats = makeSeats(n, 0.85);
  const asked = { level: [], breath: [] };
  return {
    seats, panMax: Math.max(...seats.map((s) => Math.abs(s.pan)), 1e-3), asked,
    singers: seats.map((_, i) => ({ seat: i, hue: 200, name: `s${i}`, on: () => true, info: () => ["a", "b"], level: () => (asked.level.push(i), 1), breath: () => (asked.breath.push(i), 0.999) })),
    centre: () => "Cmaj7", ...more,
  };
};

{ // everything drawn is on the canvas
  let worst = Infinity, where = "", bad = [];
  for (const w of [300, 360, 420, 520, 650, 800, 968, 1200, 1600]) {
    for (const n of [1, 3, 4, 8, 16, 24, 40, 60, 100]) {
      const { cv, box, reset } = canvas(w), st = new Stage(cv, new El()), s = spec(n);
      st.set(s);
      for (let pick = -1; pick < n; pick++) {
        reset();
        st.pick = pick < 0 ? null : pick;
        st.draw(0, 1);
        st.draw(0, 1); // the second time every singer is at the loudest known
        const h = layout(w, Math.max(...s.seats.map((x) => x.row)) + 1).h, r = 3.2 * st.size;
        for (const p of st.placed) Object.assign(box, { x0: Math.min(box.x0, p.x - r), x1: Math.max(box.x1, p.x + r), y0: Math.min(box.y0, p.y - r), y1: Math.max(box.y1, p.y + r) });
        const m = Math.min(box.x0, box.y0, w - box.x1, h - box.y1);
        if (m < worst) { worst = m; where = `${n} singers on ${w} px, singer ${pick} tapped`; }
        if (m < 0) bad.push(`${w}px ${n} singers pick ${pick}: ${JSON.stringify(box)} in ${w}x${h}`);
      }
    }
  }
  check(bad.length === 0, `stage: at every width and size of choir, with the hall ringing, every singer loud and breathing and any one tapped, the singers' light and breath and the words are on the canvas (nearest its edge: ${worst.toFixed(1)} px, ${where})${bad.length ? `: ${bad.slice(0, 3).join("; ")}` : ""}`);
  const a = layout(968), b = layout(1600), c = layout(360), d = layout(968, 3);
  check(a.R >= 296 && a.h <= 200 && b.h === a.h && b.R === a.R && c.h <= 130 && c.R > 120 && d.R === a.R && d.h <= 280, `stage: on a page 968 px wide the back row is ${a.R.toFixed(0)} px from the listener on a canvas ${a.h} px tall (${c.R.toFixed(0)} px on ${c.h} at 360 wide)`);
}

{ // taps
  const { cv } = canvas(968), card = new El(), st = new Stage(cv, card);
  let alone = new Set(), taps = [], takes = true;
  const s = spec(8, { alone: () => alone, tap: (who, more) => { taps.push([who, more]); if (!takes) return false; if (!who.length) alone = new Set(); else if (more) { alone = new Set(alone); alone.add(who[0]); } else alone = alone.has(who[0]) && alone.size === 1 ? new Set() : new Set(who); return true; } });
  st.set(s);
  st.draw(0, null);
  const tap = (i, e = {}) => cv.on.pointerdown({ clientX: i === null ? 4 : st.placed[i].x + 3, clientY: i === null ? 4 : st.placed[i].y - 2, ...e });
  tap(3);
  check(JSON.stringify(taps) === "[[[3],false]]" && st.pick === 3 && !card.hidden && card.children[0].textContent === "s3", "tap: a singer tapped is asked for alone, and its card shown");
  s.asked.level.length = s.asked.breath.length = 0;
  st.draw(0, null);
  check(s.asked.level.join() === "3" && s.asked.breath.join() === "3", "tap: only the one heard is lit or breathes");
  tap(5, { shiftKey: true });
  check(JSON.stringify(taps.at(-1)) === "[[5],true]" && st.pick === 5 && [...alone].sort().join() === "3,5", "tap: with shift, another is added");
  s.asked.level.length = 0;
  st.draw(0, null);
  check(s.asked.level.join() === "3,5", "tap: both are lit");
  // sung another way: the stage set again keeps the singer tapped, or not
  const s2 = spec(8, { alone: s.alone, tap: s.tap });
  st.set(s2, true);
  check(st.pick === 5 && !card.hidden, "set: the same stage sung another way keeps the singer tapped");
  st.draw(0, null);
  tap(null);
  check(JSON.stringify(taps.at(-1)) === "[[],false]" && st.pick === null && card.hidden && alone.size === 0, "tap: the empty stage brings the choir back");
  s2.asked.level.length = 0;
  st.draw(0, null);
  check(s2.asked.level.length === 8, "tap: all are lit again");
  tap(2); tap(2);
  check(alone.size === 0 && st.pick === null && card.hidden, "tap: the one heard alone, tapped again, brings the choir back");
  // a stage that does not take the tap (another choir is shown), and one with no singers to hear alone
  takes = false;
  tap(4);
  check(st.pick === 4 && !card.hidden && alone.size === 0, "tap: where the choir cannot be changed, the card alone is shown");
  tap(4);
  check(st.pick === null && card.hidden, "tap: and hidden by a second tap");
  st.set(spec(8));
  st.draw(0, null);
  tap(1);
  check(st.pick === 1 && !card.hidden, "tap: a stage with no singers to hear alone shows the card");
  st.set(spec(5));
  check(st.pick === null && card.hidden, "set: another stage has no singer tapped");
}

console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
