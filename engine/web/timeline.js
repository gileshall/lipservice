// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A take on a time line that follows the speaker. Speech: the words, the phones as long as each
// lasts (the commas the break model put where a reader would pause marked), the pitch with the
// questions that rise; song: the written notes under the sung pitch; a choir: each part's level and
// breaths, and what the compressor and limiter take off. Then for all the spectrogram and the
// waveform. What is made runs ahead of the speaker; what is not made is hatched, and what is to be
// made again another way is dimmed. Drag to look about; "follow" (or the next take) brings it back
// to the speaker. A click sets the speaker down there (onSeek); a click with shift held marks the
// place for a note (onMark). The listener's notes (pins: [{s, n}], n the number shown) are flagged,
// and the place of one being written (mark).

import { Spectro } from "./spectro.js";
import { HOP, SR } from "./take.js";
import { colours, fit, rounded, clock, hue, hsl } from "./paint.js";

const GUTTER = 0;
const VOWEL = /\d$/;
const PUNCT = new Set([",", ".", "?", "!", ";", ":", "-"]);

export class Timeline {
  constructor(cv) {
    this.cv = cv;
    this.take = null;
    this.span = 8; // s across, or null for the whole take
    this.follow = true;
    this.x0 = 0;
    this.drag = null;
    this.pins = [];
    this.mark = null;
    cv.style.touchAction = "pan-y";
    cv.addEventListener("pointerdown", (e) => {
      if (!this.take) return;
      this.drag = { x: e.clientX, x0: this.x0, moved: false, px: e.clientX - cv.getBoundingClientRect().left };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener("pointermove", (e) => {
      if (!this.drag || this.span === null) return;
      const dx = e.clientX - this.drag.x;
      if (Math.abs(dx) > 4) this.drag.moved = true;
      if (!this.drag.moved) return;
      this.follow = false;
      this.x0 = Math.max(0, this.drag.x0 - dx * this.spp);
      this.onFollow?.(false);
    });
    cv.addEventListener("pointerup", (e) => {
      const d = this.drag, t = this.take;
      this.drag = null;
      if (!d || d.moved || !t || !this.spp) return;
      const total = Math.max(t.length ?? 0, t.n);
      if (total <= 0) return;
      const s = Math.max(0, Math.min(total - 1, Math.floor(d.x0 + (d.px - GUTTER) * this.spp)));
      if (e.shiftKey) this.onMark?.(s);
      else this.onSeek?.(s);
    });
    cv.addEventListener("pointercancel", () => { this.drag = null; });
  }

  show(take) {
    this.take = take;
    this.sp = new Spectro();
    take.drain();
    this.sp.want(0, Math.ceil(take.n / HOP) + 1); // what it has already
    this.laned = null;
    this.follow = true;
    this.x0 = 0;
    this.onFollow?.(true);
  }

  // the take is made again another way (take.stale()): its picture stays, repainted as it is made
  swap(take) {
    this.take = take;
    this.laned = null;
  }

  // the spectrogram has columns still to paint
  get busy() { return this.take !== null && !(this.sp.done && !this.take.dirty.length); }

  followNow() {
    this.follow = true;
    this.onFollow?.(true);
  }

  // the tracks for the take: [name, height]
  tracks() {
    const k = this.take.kind;
    if (k === "say") return [["words", 22], ["phones", 20], ["pitch", 70], ["spectro", 72], ["wave", 40], ["ruler", 16]];
    if (k === "sing") return [["words", 20], ["notes", 96], ["spectro", 72], ["wave", 40], ["ruler", 16]];
    const n = this.take.lanes?.length ?? 4, lh = Math.max(5, Math.min(14, Math.floor(132 / n)));
    return [["lanes", lh * n + 2], ["gr", 22], ["spectro", 72], ["wave", 40], ["ruler", 16]];
  }

  // draws the take with the speaker at sample `ph` (heard: it has played, or is about to); budget:
  // ms for the spectrogram this frame
  draw(ph, heard, budget = 6) {
    const t = this.take;
    if (!t) return;
    this.heard = heard;
    this.sp.update(t, budget);
    const tr = this.tracks(), H = tr.reduce((a, [, h]) => a + h + 4, 0);
    const g = fit(this.cv, H), c = colours(), W = g.w - GUTTER;
    const total = Math.max(t.length ?? 0, t.n, SR);
    let spp;
    if (this.span === null) {
      spp = total / W;
      this.x0 = 0;
    } else {
      spp = (this.span * SR) / W;
      if (this.follow) this.x0 = Math.max(0, ph - 0.3 * this.span * SR);
    }
    this.spp = spp;
    const x0 = this.x0, x1 = x0 + W * spp, X = (s) => GUTTER + (s - x0) / spp;
    g.clearRect(0, 0, g.w, g.h);
    g.font = "12px system-ui, sans-serif";
    g.textBaseline = "middle";
    let y = 0;
    const boxes = {};
    for (const [name, h] of tr) {
      boxes[name] = { y, h };
      this[name](g, c, { x0, x1, X, y, h, W, spp, ph });
      y += h + 4;
    }
    // What is not made, hatched; what an earlier making left, to be made again, dimmed.
    const H0 = boxes.ruler.y;
    const hatch = (a, b) => {
      const xa = Math.max(GUTTER, X(a)), xb = Math.min(g.w, b === Infinity ? g.w : X(b));
      if (xb <= xa) return;
      g.save();
      g.beginPath();
      g.rect(xa, 0, xb - xa, H0);
      g.clip();
      g.strokeStyle = c.line;
      g.lineWidth = 1;
      const k0 = Math.floor((xa - H0 + x0 / spp) / 7) * 7 - x0 / spp; // the hatching moves with the take
      for (let x = k0; x < xb; x += 7) { g.beginPath(); g.moveTo(x, H0); g.lineTo(x + H0, 0); g.stroke(); }
      g.restore();
    };
    const dim = (a, b) => {
      const xa = Math.max(GUTTER, X(a)), xb = Math.min(g.w, X(b));
      if (xb <= xa) return;
      g.fillStyle = c.bg;
      g.globalAlpha = 0.55;
      g.fillRect(xa, 0, xb - xa, H0);
      g.globalAlpha = 1;
    };
    let at = 0;
    for (const [a, b] of [...t.spans, [Infinity, Infinity]]) { // the gaps between what is made
      if (a > at && at < x1) {
        let s = at;
        for (const [sa, sb] of t.shown) { // of a gap, what is shown is dimmed and the rest hatched
          const lo = Math.max(sa, at), hi = Math.min(sb, a);
          if (hi <= lo) continue;
          if (lo > s) hatch(s, lo);
          dim(lo, hi);
          s = hi;
        }
        if (a > s) hatch(s, a);
      }
      at = b;
    }
    const top = 0, bot = H0 - 2;
    const line = (x, col, w = 1.5) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(x, top); g.lineTo(x, bot); g.stroke(); };
    const xm = t.head === null ? -1 : X(t.head);
    if (xm >= GUTTER && xm <= g.w) line(xm, c.made, 1.5);
    const xp = X(ph);
    if (heard && xp >= GUTTER && xp <= g.w) line(xp, c.head, 2);
    // the notes: a flag with its number at each, and the place of the one being written
    const flag = (s, n) => {
      const x = X(s);
      if (x < GUTTER - 12 || x > g.w) return;
      g.setLineDash(n === null ? [2, 3] : [5, 3]);
      line(x, c.note, 1);
      g.setLineDash([]);
      g.fillStyle = c.note;
      const w = n === null ? 9 : Math.max(13, 7 * String(n).length + 6);
      rounded(g, x, 0, w, 13, 3);
      g.fill();
      if (n === null) return;
      g.fillStyle = c.bg;
      g.font = "700 10px system-ui, sans-serif";
      g.textAlign = "center";
      g.fillText(String(n), x + w / 2, 7);
      g.textAlign = "left";
    };
    for (const p of this.pins) flag(p.s, p.n);
    if (this.mark !== null) flag(this.mark, null);
  }

  words(g, c, { x0, x1, X, y, h, ph }) {
    const t = this.take, items = t.kind === "say" ? t.parts.flatMap((p) => p.words) : t.notes.filter((n) => n.word).map((n) => ({ text: n.word, a: n.a, b: n.b }));
    g.font = "600 12px system-ui, sans-serif";
    let lastEnd = -Infinity;
    for (let i = 0; i < items.length; i++) {
      const w = items[i];
      if (w.b < x0 || w.a > x1) continue;
      const xa = Math.max(X(w.a), lastEnd + 4), next = items[i + 1] ? X(items[i + 1].a) : Infinity;
      const tw = g.measureText(w.text).width;
      const now = ph >= w.a && ph < w.b && this.heard;
      if (tw > next - xa + 2 && !now) continue;
      if (now) {
        g.fillStyle = c.head;
        rounded(g, xa - 4, y + 2, tw + 8, h - 4, 6);
        g.fill();
        g.fillStyle = c.bg;
      } else {
        g.fillStyle = w.b <= ph && this.heard ? c.fg : w.a < t.n ? c.mute : c.faint;
      }
      g.fillText(w.text, xa, y + h / 2);
      lastEnd = xa + tw;
    }
    g.font = "12px system-ui, sans-serif";
  }

  phones(g, c, { x0, x1, X, y, h }) {
    const t = this.take;
    g.font = "10px ui-monospace, monospace";
    g.textAlign = "center";
    for (const p of t.parts) {
      if (p.end < x0 || p.at > x1) continue;
      const tk = p.tokens;
      for (let i = 0; i < tk.length; i++) {
        const k = tk[i];
        if (k.b < x0 || k.a > x1) continue;
        const xa = X(k.a), xb = X(k.b), w = xb - xa;
        if (k.phrased) {
          // the comma the break model put in, and the pause it brought
          const pause = tk[i + 1]?.sym === " " ? tk[i + 1] : k, xe = X(pause.b);
          g.fillStyle = c.comma;
          g.globalAlpha = 0.28;
          rounded(g, xa, y + 1, Math.max(3, xe - xa), h - 2, 4);
          g.fill();
          g.globalAlpha = 1;
          g.fillStyle = c.comma;
          g.font = "700 14px system-ui, sans-serif";
          g.fillText(",", xa + Math.max(3, xe - xa) / 2, y + h / 2 - 2);
          g.font = "10px ui-monospace, monospace";
          continue;
        }
        if (k.sym === "^" || k.sym === "$") continue;
        if (k.sym === " ") {
          if (k.b - k.a >= 0.12 * SR) { // a pause: its length as a thin bar
            g.fillStyle = c.line;
            g.fillRect(xa + 1, y + h / 2 - 1, Math.max(1, w - 2), 2);
          }
          continue;
        }
        if (PUNCT.has(k.sym)) {
          g.fillStyle = c.fg;
          g.font = "700 13px system-ui, sans-serif";
          g.fillText(k.sym, xa + Math.max(w, 4) / 2, y + h / 2 - 1);
          g.font = "10px ui-monospace, monospace";
          continue;
        }
        const vowel = VOWEL.test(k.sym);
        g.fillStyle = c.made;
        g.globalAlpha = vowel ? 0.5 : 0.22;
        rounded(g, xa + 0.5, y + 2, Math.max(1, w - 1), h - 4, 3);
        g.fill();
        g.globalAlpha = 1;
        if (w >= 15) {
          g.fillStyle = c.fg;
          g.fillText(k.sym.replace(/\d/, "").toLowerCase(), xa + w / 2, y + h / 2);
        }
      }
    }
    g.textAlign = "left";
  }

  // speech: the pitch, 60 to 500 Hz on a log scale, and the rising questions
  pitch(g, c, { x0, x1, X, y, h }) {
    const t = this.take, lo = Math.log(60), hi = Math.log(500);
    const Y = (f) => y + h - ((Math.log(f) - lo) / (hi - lo)) * h;
    g.fillStyle = c.faint;
    g.font = "10px system-ui, sans-serif";
    for (const f of [100, 200, 400]) {
      g.fillStyle = c.line;
      g.fillRect(GUTTER, Y(f), g.w, 1);
      g.fillStyle = c.faint;
      g.fillText(`${f} Hz`, GUTTER + 3, Y(f) - 6);
    }
    for (const p of t.parts) for (const r of p.rises) {
      if (r.b < x0 || r.a > x1) continue;
      g.fillStyle = c.pitch;
      g.globalAlpha = 0.14;
      rounded(g, X(r.a), y, X(r.b) - X(r.a), h, 6);
      g.fill();
      g.globalAlpha = 1;
      g.font = "700 13px system-ui, sans-serif";
      g.fillText("?", X(r.b) - 10, y + 9);
    }
    this.curve(g, c, x0, x1, X, Y);
  }

  curve(g, c, x0, x1, X, Y) {
    const t = this.take, f0 = t.f0;
    g.strokeStyle = c.pitch;
    g.lineWidth = 2;
    g.lineJoin = "round";
    g.beginPath();
    let pen = false;
    const fa = Math.max(0, Math.floor(x0 / HOP)), fb = Math.min(f0.length, Math.ceil(x1 / HOP) + 1);
    for (let f = fa; f < fb; f++) {
      const v = f0[f];
      if (!(v > 0)) { pen = false; continue; }
      const x = X(f * HOP + HOP / 2), yy = Y(v);
      if (pen) g.lineTo(x, yy); else g.moveTo(x, yy);
      pen = true;
    }
    g.stroke();
  }

  // song: the written notes as bars, the sung pitch over them
  notes(g, c, { x0, x1, X, y, h }) {
    const t = this.take;
    if (!t.notes.length) return;
    let lo = Infinity, hi = -Infinity;
    for (const n of t.notes) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
    lo -= 3; hi += 3;
    const st = h / (hi - lo), M = (m) => y + h - (m - lo) * st, Y = (f) => M(69 + 12 * Math.log2(f / 440));
    g.font = "10px system-ui, sans-serif";
    for (let m = Math.ceil(lo); m <= hi; m++) {
      if (m % 12 !== 0) continue;
      g.fillStyle = c.line;
      g.fillRect(GUTTER, M(m), g.w, 1);
      g.fillStyle = c.faint;
      g.fillText(`C${m / 12 - 1}`, GUTTER + 3, M(m) - 6);
    }
    for (const n of t.notes) {
      if (n.b < x0 || n.a > x1) continue;
      g.fillStyle = c.made;
      g.globalAlpha = 0.3;
      rounded(g, X(n.a) + 1, M(n.midi) - st / 2, Math.max(2, X(n.b) - X(n.a) - 2), Math.max(3, st), Math.min(4, st / 2));
      g.fill();
      g.globalAlpha = 1;
    }
    this.curve(g, c, x0, x1, X, Y);
  }

  // a choir: each part a lane, bright where it sings loud, its breaths ticked; a muted part's is faint
  lanes(g, c, { x0, x1, X, y, h, spp }) {
    const t = this.take, L = t.lanes;
    if (!L) return;
    const lh = (h - 2) / L.length;
    if (this.laned?.lanes !== L || this.laned.stamp !== t.stamp) { // each lane's colour and loudest frame
      this.laned = {
        lanes: L, stamp: t.stamp, colour: L.map((p) => hsl(hue(p.name, p.sex))),
        max: L.map((p) => { let m = 1e-4; for (const v of p.lv) if (v > m) m = v; return m; }),
      };
    }
    for (let i = 0; i < L.length; i++) {
      const p = L[i], ly = y + i * lh, lv = p.lv, off = p.off, mx = this.laned.max[i], dim = p.mute ? 0.22 : 1;
      g.fillStyle = c.line;
      g.globalAlpha = 0.5;
      g.fillRect(GUTTER, ly + lh / 2, g.w, 1);
      g.globalAlpha = 1;
      const step = Math.max(1, Math.floor(spp / HOP));
      for (let px = GUTTER; px < g.w; px += Math.max(1, step * HOP / spp)) {
        const s = x0 + (px - GUTTER) * spp, f = Math.floor((s - off) / HOP);
        if (f < 0 || f >= lv.length) continue;
        let v = 0;
        for (let k = f; k < Math.min(lv.length, f + step); k++) if (lv[k] > v) v = lv[k];
        if (v < mx * 0.02) continue;
        g.fillStyle = this.laned.colour[i];
        g.globalAlpha = dim * Math.min(1, (v / mx) ** 0.7);
        g.fillRect(px, ly + 0.5, Math.max(1, (step * HOP) / spp) + 0.5, lh - 1);
      }
      g.globalAlpha = 1;
      g.fillStyle = c.fg;
      for (const [at, n] of p.breaths) {
        const a = off + at;
        if (a + n < x0 || a > x1) continue;
        g.globalAlpha = dim * 0.85;
        rounded(g, X(a), ly + lh / 2 - 1.5, Math.max(3, n / spp), 3, 1.5);
        g.fill();
      }
      g.globalAlpha = 1;
      if (lh >= 10) {
        g.font = "9px system-ui, sans-serif";
        g.fillStyle = c.mute;
        g.fillText(p.name, GUTTER + 3, ly + lh / 2);
      }
    }
  }

  // a choir: dB the compressor (pitch colour) and the limiter (red) take off, 0 to 12 down
  gr(g, c, { x0, X, y, h, spp }) {
    const tr = this.take.trace;
    g.fillStyle = c.line;
    g.fillRect(GUTTER, y, g.w, 1);
    if (!tr) return;
    const D = 12;
    for (const [k, col] of [["comp", c.pitch], ["lim", c.bad]]) {
      g.fillStyle = col;
      g.globalAlpha = k === "comp" ? 0.75 : 0.9;
      for (let px = GUTTER; px < g.w; px++) {
        const f = Math.floor((x0 + (px - GUTTER) * spp) / HOP), v = tr.at(k, f);
        if (!(v > 0.05)) continue;
        g.fillRect(px, y + 1, 1, Math.min(1, v / D) * (h - 2));
      }
    }
    g.globalAlpha = 1;
    g.font = "9px system-ui, sans-serif";
    g.fillStyle = c.mute;
    g.fillText("compressor", GUTTER + 3, y + h - 6);
    g.fillStyle = c.bad;
    g.fillText("limiter", GUTTER + 66, y + h - 6);
    void X;
  }

  spectro(g, c, { x0, x1, y, h, X }) {
    g.fillStyle = "#0d0f10";
    g.fillRect(GUTTER, y, g.w - GUTTER, h);
    const c0 = Math.floor(x0 / HOP), c1 = Math.ceil(x1 / HOP);
    this.sp.draw(g, c0, c1, X(c0 * HOP), y, X(c1 * HOP) - X(c0 * HOP), h);
  }

  wave(g, c, { x0, y, h, spp, ph }) {
    const t = this.take, e = t.ext, mid = y + h / 2, frames = Math.floor(t.n / HOP);
    let peak = 1e-3;
    for (let f = 0; f < frames; f += 7) peak = Math.max(peak, Math.abs(e[2 * f]), Math.abs(e[2 * f + 1]));
    const k = (h / 2 - 1) / peak;
    for (let px = GUTTER; px < g.w; px++) {
      const s = x0 + (px - GUTTER) * spp, fa = Math.floor(s / HOP), fb = Math.max(fa + 1, Math.floor((s + spp) / HOP));
      if (fa >= frames) break;
      let lo = 0, hi = 0;
      for (let f = Math.max(0, fa); f < Math.min(fb, frames); f++) { lo = Math.min(lo, e[2 * f]); hi = Math.max(hi, e[2 * f + 1]); }
      g.fillStyle = this.heard && s < ph ? c.fg : c.made;
      g.globalAlpha = this.heard && s < ph ? 0.75 : 0.55;
      g.fillRect(px, mid - hi * k, 1, Math.max(1, (hi - lo) * k));
    }
    g.globalAlpha = 1;
  }

  ruler(g, c, { x0, x1, X, y, h }) {
    const span = (x1 - x0) / SR, step = span > 40 ? 10 : span > 16 ? 5 : span > 6 ? 2 : 1;
    g.font = "10px system-ui, sans-serif";
    g.fillStyle = c.faint;
    for (let s = Math.ceil(x0 / SR / step) * step; s * SR <= x1; s += step) {
      const x = X(s * SR);
      g.fillRect(x, y, 1, 4);
      g.fillText(clock(s), x + 3, y + h / 2 + 2);
    }
  }
}
