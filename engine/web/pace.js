// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// How fast sound is made against how fast it plays. A take: seconds of sound in hand (teal) and
// heard (warm) from where the speaker was set down, against the seconds since it was asked to play
// there; the dashed line is real time from the first sound, so the made line above it is sound in
// hand. The crowd: the voices singing against how many the
// workers keep up with, over the last WINDOW seconds, a red tick at each stall.

import { SR } from "./take.js";
import { colours, fit } from "./paint.js";

const WINDOW = 30;
const PAD = { l: 30, r: 10, t: 10, b: 18 };

function axes(g, c, x0, x1, y0, y1, X, Y, ylab) {
  g.font = "10px system-ui, sans-serif";
  g.textBaseline = "middle";
  const ys = y1 - y0 > 60 ? 20 : y1 - y0 > 24 ? 10 : y1 - y0 > 10 ? 5 : y1 - y0 > 4 ? 2 : 1;
  for (let y = Math.ceil(y0 / ys) * ys; y <= y1; y += ys) {
    g.fillStyle = c.line;
    g.fillRect(PAD.l, Y(y), g.w - PAD.l - PAD.r, 1);
    g.fillStyle = c.faint;
    g.textAlign = "right";
    g.fillText(ylab(y), PAD.l - 4, Y(y));
  }
  g.textAlign = "left";
  const span = x1 - x0, xs = span > 40 ? 10 : span > 16 ? 5 : span > 6 ? 2 : span > 2.5 ? 1 : 0.5;
  for (let x = Math.ceil(x0 / xs) * xs; x <= x1 + 1e-9; x += xs) {
    g.fillStyle = c.faint;
    g.fillRect(X(x), g.h - PAD.b, 1, 3);
    g.fillText(`${+x.toFixed(1)} s`, X(x) + 3, g.h - PAD.b / 2 + 1);
  }
}

function line(g, pts, X, Y, col, w = 2) {
  if (!pts.length) return;
  g.strokeStyle = col;
  g.lineWidth = w;
  g.lineJoin = "round";
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
  g.stroke();
}

export class Pace {
  constructor(cv) {
    this.cv = cv;
  }

  // a setting down of the speaker (deck.js run), `total` samples from there to the take's end,
  // `now` ms since it was asked for
  take(t, total, now) {
    const g = fit(this.cv, 150), c = colours();
    g.clearRect(0, 0, g.w, g.h);
    const end = t.ended && t.heardAt.length ? t.heardAt.at(-1)[0] : now;
    const x1 = Math.max(1, end / 1000) * 1.04;
    const y1 = Math.max(0.5, Math.max(total, t.made.at(-1)[1]) / SR) * 1.08;
    const X = (s) => PAD.l + (s / x1) * (g.w - PAD.l - PAD.r), Y = (s) => g.h - PAD.b - (s / y1) * (g.h - PAD.t - PAD.b);
    axes(g, c, 0, x1, 0, y1, X, Y, (y) => `${y}`);
    const made = t.made.map(([ms, n]) => [ms / 1000, n / SR]);
    if (t.done === null && !t.ended) made.push([now / 1000, made.at(-1)[1]]);
    const heard = [[0, 0], ...t.heardAt.map(([ms, n]) => [ms / 1000, n / SR])];
    // sound in hand: between what is made and what is heard
    if (t.heardAt.length && made.length > 1) {
      g.fillStyle = c.made;
      g.globalAlpha = 0.12;
      g.beginPath();
      made.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
      for (let i = heard.length - 1; i >= 0; i--) g.lineTo(X(heard[i][0]), Y(heard[i][1]));
      g.fill();
      g.globalAlpha = 1;
    }
    if (t.first !== null) {
      const a = t.first / 1000;
      g.setLineDash([4, 4]);
      line(g, [[a, 0], [Math.min(x1, a + y1), Math.min(y1, x1 - a)]], X, Y, c.mute, 1);
      g.setLineDash([]);
      g.fillStyle = c.mute;
      g.fillText("real time", X(Math.min(x1 - 0.2 * x1, a + 0.55 * Math.min(y1, x1 - a))) + 4, Y(0.55 * Math.min(y1, x1 - a)) + 8);
    }
    line(g, heard, X, Y, c.head, 2);
    line(g, made, X, Y, c.made, 2);
    g.fillStyle = c.bad;
    for (const ms of t.stallAt) g.fillRect(X(ms / 1000) - 1, PAD.t, 2, g.h - PAD.t - PAD.b);
    g.font = "600 11px system-ui, sans-serif";
    const lm = made.at(-1), lh = heard.at(-1);
    if (lm) { g.fillStyle = c.made; g.fillText("made", Math.min(X(lm[0]) + 5, g.w - 40), Math.max(PAD.t + 6, Y(lm[1]) - 2)); }
    if (lh && t.heardAt.length) { g.fillStyle = c.head; g.fillText("heard", Math.min(X(lh[0]) + 5, g.w - 40), Math.min(g.h - PAD.b - 6, Y(lh[1]) + 10)); }
  }

  // the crowd: hist [{t (ms), voices, capacity, stalls}], now (ms)
  crowd(hist, now) {
    const g = fit(this.cv, 150), c = colours();
    g.clearRect(0, 0, g.w, g.h);
    const pts = hist.filter((p) => p.t > now - WINDOW * 1000);
    let top = 16;
    for (const p of pts) top = Math.max(top, p.voices, p.capacity ?? 0);
    const y1 = top * 1.15;
    const X = (s) => PAD.l + ((s + WINDOW) / WINDOW) * (g.w - PAD.l - PAD.r), Y = (v) => g.h - PAD.b - (v / y1) * (g.h - PAD.t - PAD.b);
    axes(g, c, -WINDOW, 0, 0, y1, X, Y, (y) => `${y}`);
    const at = (p) => (p.t - now) / 1000;
    // past what the workers keep up with, shaded
    const cap = pts.filter((p) => p.capacity !== null);
    if (cap.length > 1) {
      g.fillStyle = c.bad;
      g.globalAlpha = 0.08;
      g.beginPath();
      g.moveTo(X(at(cap[0])), Y(y1));
      for (const p of cap) g.lineTo(X(at(p)), Y(p.capacity));
      g.lineTo(X(at(cap.at(-1))), Y(y1));
      g.fill();
      g.globalAlpha = 1;
      g.setLineDash([5, 4]);
      line(g, cap.map((p) => [at(p), p.capacity]), X, Y, c.made, 1.5);
      g.setLineDash([]);
    }
    line(g, pts.map((p) => [at(p), p.voices]), X, Y, c.fg, 2);
    g.fillStyle = c.bad;
    for (let i = 1; i < pts.length; i++) if (pts[i].stalls > pts[i - 1].stalls) g.fillRect(X(at(pts[i])) - 1, PAD.t, 2, g.h - PAD.t - PAD.b);
    g.font = "600 11px system-ui, sans-serif";
    const last = pts.at(-1);
    if (last) {
      g.fillStyle = c.fg;
      g.fillText("voices", Math.min(X(0) - 44, g.w - 44), Math.max(PAD.t + 6, Y(last.voices) - 8));
      if (last.capacity !== null) {
        g.fillStyle = c.made;
        g.fillText("keeps up", Math.min(X(0) - 56, g.w - 56), Math.max(PAD.t + 6, Y(last.capacity) - 8));
      }
    }
  }
}
