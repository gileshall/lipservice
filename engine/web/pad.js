// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The crowd's pad: a finger's place sets two of the crowd's settings (live.js PARAMS), one across
// and one up, as it moves. Where an axis is the voices, a line marks how many the workers keep up
// with; past it is shaded, where the speaker will run dry.

import { PARAMS } from "./live.js";
import { colours, fit, hsl } from "./paint.js";

const TRAIL = 28;

export class Pad {
  // cv: the canvas; xs, ys: selects of PARAMS keys; onSet(changes): a place was picked
  constructor(cv, xs, ys, onSet) {
    this.cv = cv;
    this.xs = xs;
    this.ys = ys;
    this.onSet = onSet;
    this.P = null; // the crowd's settings, shown
    this.trail = [];
    this.down = false;
    for (const s of [xs, ys]) {
      for (const [k, p] of Object.entries(PARAMS)) {
        const o = document.createElement("option");
        o.value = k;
        o.textContent = p.label;
        s.append(o);
      }
    }
    xs.value = "voices";
    ys.value = "spread";
    this.was = { x: xs.value, y: ys.value };
    // the two axes never the same setting: picking the other's swaps them
    const pick = (me, other, key) => {
      if (me.value === other.value) other.value = this.was[key];
      this.was = { x: xs.value, y: ys.value };
      this.trail = [];
    };
    xs.onchange = () => pick(xs, ys, "x");
    ys.onchange = () => pick(ys, xs, "y");
    cv.style.touchAction = "none";
    const at = (e) => {
      const r = cv.getBoundingClientRect();
      const u = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), v = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
      this.trail.push([u, v]);
      if (this.trail.length > TRAIL) this.trail.shift();
      this.onSet({ [xs.value]: PARAMS[xs.value].value(u), [ys.value]: PARAMS[ys.value].value(v) });
    };
    cv.addEventListener("pointerdown", (e) => { this.down = true; cv.setPointerCapture(e.pointerId); at(e); });
    cv.addEventListener("pointermove", (e) => { if (this.down) at(e); });
    const up = () => { this.down = false; };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
  }

  // P: the crowd's settings; capacity: voices the workers keep up with, or null
  draw(P, capacity) {
    const W = this.cv.clientWidth, g = fit(this.cv, Math.round(Math.min(W * 0.75, 380))), c = colours();
    const w = g.w, h = g.h, xk = this.xs.value, yk = this.ys.value, px = PARAMS[xk], py = PARAMS[yk];
    g.clearRect(0, 0, w, h);
    g.strokeStyle = c.line;
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      g.beginPath(); g.moveTo((w * i) / 4, 0); g.lineTo((w * i) / 4, h); g.stroke();
      g.beginPath(); g.moveTo(0, (h * i) / 4); g.lineTo(w, (h * i) / 4); g.stroke();
    }
    // how many voices keep up
    if (capacity !== null && (xk === "voices" || yk === "voices")) {
      const u = Math.max(0, Math.min(1, PARAMS.voices.u(capacity)));
      g.fillStyle = c.bad;
      g.globalAlpha = 0.1;
      if (xk === "voices") g.fillRect(u * w, 0, w - u * w, h);
      else g.fillRect(0, 0, w, (1 - u) * h);
      g.globalAlpha = 1;
      g.strokeStyle = c.made;
      g.lineWidth = 2;
      g.setLineDash([6, 5]);
      g.beginPath();
      if (xk === "voices") { g.moveTo(u * w, 0); g.lineTo(u * w, h); } else { g.moveTo(0, (1 - u) * h); g.lineTo(w, (1 - u) * h); }
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = c.made;
      g.font = "600 11px system-ui, sans-serif";
      const t = `this device keeps up with ${Math.round(capacity)}`;
      if (xk === "voices") {
        g.save(); g.translate(u * w - 16, 10); g.rotate(Math.PI / 2); g.textAlign = "left"; g.fillText(t, 0, 0); g.restore();
      } else {
        g.fillText(t, 8, (1 - u) * h - 7);
      }
    }
    // the axes' ends
    g.font = "10px system-ui, sans-serif";
    g.fillStyle = c.faint;
    g.textBaseline = "alphabetic";
    g.fillText(px.show(px.value(0)), 6, h - 6);
    g.textAlign = "right";
    g.fillText(`${px.label} ${px.show(px.value(1))}`, w - 6, h - 6);
    g.textAlign = "left";
    g.fillText(`${py.label} ${py.show(py.value(1))}`, 6, 14);
    if (!P) return;
    // the trail, then where it is
    for (let i = 0; i < this.trail.length; i++) {
      const [u, v] = this.trail[i];
      g.fillStyle = hsl(165, (0.35 * (i + 1)) / this.trail.length);
      g.beginPath(); g.arc(u * w, (1 - v) * h, 3 + (5 * i) / this.trail.length, 0, 2 * Math.PI); g.fill();
    }
    const x = px.u(P[xk]) * w, y = (1 - py.u(P[yk])) * h;
    g.strokeStyle = c.mute;
    g.globalAlpha = 0.5;
    g.setLineDash([2, 4]);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
    const gl = g.createRadialGradient(x, y, 0, x, y, 26);
    gl.addColorStop(0, hsl(165, 0.5, 60));
    gl.addColorStop(1, hsl(165, 0, 60));
    g.fillStyle = gl;
    g.beginPath(); g.arc(x, y, 26, 0, 2 * Math.PI); g.fill();
    g.fillStyle = c.made;
    g.beginPath(); g.arc(x, y, 8, 0, 2 * Math.PI); g.fill();
  }
}
