// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The stage from above: the singers on risers in an arc facing the listener (the dot at the
// bottom), each where its seat puts it (choir.js makeSeats: its row, and the angle its pan comes
// from), lit as loud as it sings at the speaker and puffing as it takes a breath. Behind them the
// hall glows as it rings. A tap on a singer shows how it sings (its info()) and draws its sound's
// three ways to the listener: straight, and off the two walls that make its early reflections.
// Where the stage's singers can be heard alone (alone, tap), a tap asks for that too: the others
// are drawn dim.

import { HOP } from "./take.js";
import { colours, fit, hsl } from "./paint.js";

const HALF = 52; // degrees either side, as makeSeats
const GLOW = 1.25; // the hall's glow reaches this many times the back row's radius: the furthest thing drawn
const ARC = 1.2; // rad either side of straight ahead the glow spans
const WALL = 1.12; // the walls a tapped singer's reflections come off, in radii
const EDGE = 4; // px kept clear at the canvas's edges
const DOT = 10; // px, the largest a singer is drawn
const REACH = 3.2; // a singer's light and breath reach this many times its size from its seat

// The stage on a canvas w px wide: the canvas's height h, the listener at (cx, cy) and the back
// row's radius R, the largest that keeps the glow, the back row's breaths and the walls inside it.
export function layout(w) {
  const h = Math.round(Math.min(400, Math.max(220, w * 0.56)));
  const cx = w / 2, cy = h - 16;
  const R = Math.min((cy - EDGE) / GLOW, (cx - EDGE) / (GLOW * Math.sin(ARC)), cy - EDGE - DOT * REACH);
  return { h, cx, cy, R };
}

export class Stage {
  // cv: the canvas; card: an element shown over it with the tapped singer's info
  constructor(cv, card) {
    this.cv = cv;
    this.card = card;
    this.set(null);
    cv.addEventListener("pointerdown", (e) => {
      const s = this.s;
      if (!s) return;
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 22 * 22;
      for (const p of this.placed ?? []) {
        if (!p.on) continue;
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < bd) { bd = d; best = p.i; }
      }
      if (s.tap?.(best === null ? [] : [best], e.shiftKey === true)) this.pick = best !== null && s.alone().has(best) ? best : null;
      else this.pick = best === this.pick ? null : best;
      this.showCard();
    });
  }

  // what is on stage: {seats, panMax, singers: [{seat, hue (or hue(s)), name, info(), level(frame),
  // breath(s), on(s)}], centre(s)}, or null; s a sample of the take, frame one of HOP samples.
  // Where its singers can be heard alone it has alone(), the Set of those asked for so (empty: all
  // are heard), and tap(who, more): the singers tapped (none: the empty stage), more with shift
  // held; true if it took the tap as a word on who is heard. keep: the tapped singer stays tapped
  // (the same stage, sung another way).
  set(s, keep = false) {
    this.s = s;
    if (!keep || !s?.singers[this.pick]) this.pick = null;
    if (!keep) {
      this.peak = 1e-4;
      this.hall = 1e-6;
    }
    this.showCard();
  }

  showCard() {
    this.cardAt = performance.now();
    const p = this.pick === null ? null : this.s?.singers[this.pick];
    this.card.hidden = !p;
    if (!p) return;
    this.card.replaceChildren(...[p.name, ...p.info()].map((t, i) => {
      const d = document.createElement(i ? "div" : "b");
      d.textContent = t;
      return d;
    }));
  }

  // seat i's place: [x, y] about the listener at (cx, cy), radius by row
  place(seat, rows, panMax, cx, cy, R) {
    const sh = Math.sin((HALF * Math.PI) / 180);
    const a = Math.asin(Math.max(-1, Math.min(1, (seat.pan * sh) / panMax)));
    const r = rows > 1 ? R * (0.58 + (0.42 * seat.row) / (rows - 1)) : R * 0.82;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a), r, a];
  }

  // at sample `ph`; hall: the hall's power there (room trace), or null
  draw(ph, hall = null) {
    const s = this.s, { h, cx, cy, R } = layout(this.cv.clientWidth);
    const g = fit(this.cv, h), c = colours();
    g.clearRect(0, 0, g.w, g.h);
    if (!s) return;
    const rows = Math.max(...s.seats.map((x) => x.row)) + 1;
    // the hall, a glow behind the back row as it rings
    if (hall !== null && hall > 0) {
      this.hall = Math.max(this.hall * 0.9995, hall);
      const u = Math.min(1, hall / this.hall);
      const gr = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * GLOW);
      gr.addColorStop(0, hsl(185, 0));
      gr.addColorStop(0.45, hsl(185, 0.22 * u, 55));
      gr.addColorStop(1, hsl(185, 0));
      g.fillStyle = gr;
      g.beginPath();
      g.arc(cx, cy, R * GLOW, -Math.PI / 2 - ARC, -Math.PI / 2 + ARC);
      g.arc(cx, cy, R * 0.9, -Math.PI / 2 + ARC, -Math.PI / 2 - ARC, true);
      g.fill();
    }
    // the risers
    g.strokeStyle = c.line;
    g.lineWidth = 1;
    const a0 = (HALF * Math.PI) / 180 + 0.08;
    for (let r = 0; r < rows; r++) {
      const rr = rows > 1 ? R * (0.58 + (0.42 * r) / (rows - 1)) : R * 0.82;
      g.beginPath();
      g.arc(cx, cy, rr, -Math.PI / 2 - a0, -Math.PI / 2 + a0);
      g.stroke();
    }
    // the listener
    g.fillStyle = c.mute;
    g.beginPath(); g.arc(cx, cy, 4, 0, 2 * Math.PI); g.fill();
    const f = Math.floor(ph / HOP);
    const perRow = s.seats.length / rows, size = Math.max(3, Math.min(DOT, ((R * 0.7 * 2 * a0) / perRow) * 0.36));
    const alone = s.alone?.() ?? null, some = alone !== null && alone.size > 0;
    this.placed = [];
    let peak = 0;
    for (const [i, p] of s.singers.entries()) {
      const [x, y] = this.place(s.seats[p.seat], rows, s.panMax, cx, cy, R);
      const on = p.on(ph), heard = on && (!some || alone.has(i));
      this.placed.push({ i, x, y, on });
      const lv = heard ? p.level(f) : NaN, hu = typeof p.hue === "function" ? p.hue(ph) : p.hue;
      if (lv > peak) peak = lv;
      const u = lv > 0 ? Math.min(1, (lv / this.peak) ** 0.6) : 0;
      if (u > 0.04) {
        const gl = g.createRadialGradient(x, y, 0, x, y, size * (1.6 + 1.6 * u));
        gl.addColorStop(0, hsl(hu, 0.55 * u, 62));
        gl.addColorStop(1, hsl(hu, 0, 62));
        g.fillStyle = gl;
        g.beginPath(); g.arc(x, y, size * (1.6 + 1.6 * u), 0, 2 * Math.PI); g.fill();
      }
      // one not heard keeps its seat and its colour, faint
      g.fillStyle = heard ? hsl(hu, 0.3 + 0.7 * u, 50 + 18 * u) : on ? hsl(hu, 0.22, 50) : c.line;
      g.beginPath(); g.arc(x, y, on ? size : size * 0.55, 0, 2 * Math.PI); g.fill();
      const b = heard ? p.breath(ph) : null;
      if (b !== null) {
        g.strokeStyle = c.fg;
        g.globalAlpha = 0.85 * (1 - b);
        g.lineWidth = 1.5;
        g.beginPath(); g.arc(x, y - size * 0.4, size * (1 + 1.8 * b), 0, 2 * Math.PI); g.stroke();
        g.globalAlpha = 1;
      }
      if (i === this.pick) {
        g.strokeStyle = c.fg;
        g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, size + 4, 0, 2 * Math.PI); g.stroke();
        this.paths(g, c, s.seats[p.seat], x, y, cx, cy, R);
      } else if (some && heard) { // heard alone
        g.strokeStyle = c.fg;
        g.globalAlpha = 0.7;
        g.lineWidth = 1;
        g.beginPath(); g.arc(x, y, size + 3, 0, 2 * Math.PI); g.stroke();
        g.globalAlpha = 1;
      }
    }
    this.peak = Math.max(this.peak * 0.998, peak, 1e-4);
    if (this.pick !== null && performance.now() - this.cardAt > 300) this.showCard();
    const centre = s.centre?.(ph);
    if (centre) {
      g.fillStyle = c.fg;
      g.globalAlpha = 0.8;
      g.font = "600 28px system-ui, sans-serif";
      g.textAlign = "center";
      g.fillText(centre, cx, cy - R * 0.3);
      g.textAlign = "left";
      g.globalAlpha = 1;
    }
  }

  // the tapped singer's sound to the listener: straight, and off the walls (its two reflections),
  // each wall's delay written beside it, inside the canvas
  paths(g, c, seat, x, y, cx, cy, R) {
    const sh = Math.sin((HALF * Math.PI) / 180);
    g.setLineDash([3, 4]);
    g.lineWidth = 1;
    g.strokeStyle = c.mute;
    g.beginPath(); g.moveTo(x, y); g.lineTo(cx, cy); g.stroke();
    g.font = "10px system-ui, sans-serif";
    for (const rf of seat.refl) {
      const a = Math.asin(Math.max(-1, Math.min(1, rf.pan * sh)));
      const wx = cx + R * WALL * Math.sin(a * 1.6), wy = cy - R * WALL * Math.cos(a * 1.6);
      g.strokeStyle = c.made;
      g.globalAlpha = 0.8;
      g.beginPath(); g.moveTo(x, y); g.lineTo(wx, wy); g.lineTo(cx, cy); g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = c.made;
      const text = `${Math.round(rf.delayMs)} ms`, tw = g.measureText(text).width;
      g.fillText(text, Math.max(EDGE, Math.min(g.w - EDGE - tw, wx < cx ? wx - tw - 4 : wx + 4)), Math.max(EDGE + 8, wy));
    }
    g.setLineDash([]);
  }
}
