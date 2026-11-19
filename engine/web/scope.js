// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// What reaches the speaker, as it plays. Left: left against right, turned so a sound the same in
// both ears stands upright (one voice is a vertical line; a choir from its seats spreads out), and
// under it how alike the two ears are. Right: the spectrum on a log scale of frequency, with its
// recent peaks. Both from the audio graph (AnalyserNode), scaled to what plays.

import { colours, fit } from "./paint.js";

const FLO = 50, FHI = 11000;

export class Scope {
  constructor(cv) {
    this.cv = cv;
    this.an = null;
    this.peak = 1e-3;
    this.corr = 1;
    this.hold = null;
  }

  // listens to `node` (two channels) in `ctx`
  attach(ctx, node) {
    const split = ctx.createChannelSplitter(2);
    const make = (fft) => { const a = ctx.createAnalyser(); a.fftSize = fft; a.smoothingTimeConstant = 0.6; return a; };
    this.l = make(2048);
    this.r = make(2048);
    this.an = make(4096);
    node.connect(split);
    split.connect(this.l, 0);
    split.connect(this.r, 1);
    node.connect(this.an);
    this.bl = new Float32Array(this.l.fftSize);
    this.br = new Float32Array(this.r.fftSize);
    this.spec = new Float32Array(this.an.frequencyBinCount);
    this.hold = new Float32Array(this.an.frequencyBinCount).fill(-200);
    this.sr = ctx.sampleRate;
  }

  draw() {
    const g = fit(this.cv, 170), c = colours();
    g.clearRect(0, 0, g.w, g.h);
    const S = Math.min(g.h - 30, g.w * 0.4), gx = 0, gy = 0;
    // left against right
    g.strokeStyle = c.line;
    g.lineWidth = 1;
    g.strokeRect(gx + 0.5, gy + 0.5, S - 1, S - 1);
    const cx = gx + S / 2, cy = gy + S / 2;
    g.setLineDash([2, 4]);
    g.beginPath(); g.moveTo(cx, gy); g.lineTo(cx, gy + S); g.moveTo(gx, cy); g.lineTo(gx + S, cy); g.stroke();
    g.beginPath(); g.moveTo(gx, gy); g.lineTo(gx + S, gy + S); g.moveTo(gx + S, gy); g.lineTo(gx, gy + S); g.stroke();
    g.setLineDash([]);
    g.font = "10px system-ui, sans-serif";
    g.fillStyle = c.faint;
    g.fillText("L", gx + 6, gy + 12);
    g.fillText("R", gx + S - 13, gy + 12);
    if (this.an) {
      this.l.getFloatTimeDomainData(this.bl);
      this.r.getFloatTimeDomainData(this.br);
      const L = this.bl, R = this.br;
      let mx = 0, lr = 0, ll = 0, rr = 0;
      for (let i = 0; i < L.length; i++) {
        mx = Math.max(mx, Math.abs(L[i]), Math.abs(R[i]));
        lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i];
      }
      this.peak = Math.max(mx, this.peak * 0.97, 1e-4);
      const k = (S * 0.46) / (this.peak * Math.SQRT2);
      g.fillStyle = c.made;
      g.globalAlpha = 0.55;
      for (let i = 0; i < L.length; i++) {
        const m = L[i] + R[i], s = L[i] - R[i];
        g.fillRect(cx - s * k * Math.SQRT1_2 - 0.6, cy - m * k * Math.SQRT1_2 - 0.6, 1.2, 1.2);
      }
      g.globalAlpha = 1;
      if (ll > 1e-9 && rr > 1e-9) this.corr += 0.25 * (lr / Math.sqrt(ll * rr) - this.corr);
    }
    // how alike the ears are: +1 the same, 0 unrelated, -1 opposed
    const by = gy + S + 8, bw = S;
    g.fillStyle = c.line;
    g.fillRect(gx, by + 4, bw, 2);
    g.fillRect(gx + bw / 2, by, 1, 10);
    g.fillStyle = c.made;
    const px = gx + ((this.corr + 1) / 2) * bw;
    g.beginPath(); g.arc(px, by + 5, 4, 0, 2 * Math.PI); g.fill();
    g.fillStyle = c.faint;
    g.fillText("opposed", gx, by + 19);
    g.textAlign = "right";
    g.fillText("the same", gx + bw, by + 19);
    g.textAlign = "left";
    // the spectrum
    const x0 = S + 18, x1 = g.w, w = x1 - x0, y0 = 0, h = g.h - 14;
    const lf = Math.log(FLO), lh = Math.log(FHI), X = (f) => x0 + ((Math.log(f) - lf) / (lh - lf)) * w;
    g.fillStyle = c.faint;
    for (const [f, t] of [[100, "100 Hz"], [1000, "1 kHz"], [10000, "10 kHz"]]) {
      g.fillStyle = c.line;
      g.fillRect(X(f), y0, 1, h);
      g.fillStyle = c.faint;
      g.fillText(t, X(f) + 3, h + 9);
    }
    if (!this.an) return;
    this.an.getFloatFrequencyData(this.spec);
    const D0 = -115, D1 = -15, Y = (d) => y0 + h - Math.max(0, Math.min(1, (d - D0) / (D1 - D0))) * h;
    const bin = this.sr / this.an.fftSize, sp = this.spec, hold = this.hold;
    for (let i = 0; i < sp.length; i++) hold[i] = Math.max(sp[i], hold[i] - 0.6);
    // per pixel column, the most of the bins under it
    const col = (arr, px) => {
      const fa = Math.exp(lf + ((px - x0) / w) * (lh - lf)), fb = Math.exp(lf + ((px + 1 - x0) / w) * (lh - lf));
      let m = -Infinity;
      for (let i = Math.max(1, Math.floor(fa / bin)); i <= Math.min(arr.length - 1, Math.ceil(fb / bin)); i++) m = Math.max(m, arr[i]);
      return m;
    };
    const grad = g.createLinearGradient(0, y0, 0, y0 + h);
    grad.addColorStop(0, c.pitch);
    grad.addColorStop(1, c.made);
    g.fillStyle = grad;
    g.globalAlpha = 0.75;
    g.beginPath();
    g.moveTo(x0, y0 + h);
    for (let px = x0; px < x1; px++) g.lineTo(px, Y(col(sp, px)));
    g.lineTo(x1, y0 + h);
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = c.fg;
    g.globalAlpha = 0.5;
    g.lineWidth = 1;
    g.beginPath();
    for (let px = x0; px < x1; px++) { const y = Y(col(hold, px)); if (px === x0) g.moveTo(px, y); else g.lineTo(px, y); }
    g.stroke();
    g.globalAlpha = 1;
  }
}
