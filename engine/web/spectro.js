// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A take's spectrogram, worked out as it is drawn: a column a frame (HOP samples), each BANDS mel
// bands of a Hann-windowed N-point spectrum, painted into strips of canvas COLS columns wide. The
// colours run from the page's background up over RANGE dB below TOP (fixed, so a column is painted
// once for each time its samples are written).

import { FFT } from "./room.js";
import { HOP, SR } from "./take.js";

const N = 512;
export const BANDS = 48;
const COLS = 1024;
const TOP = 28; // dB of a band's mean power: about the loudest of a voice's formants
const RANGE = 75;
const FMAX = 11000;

const mel = (f) => 2595 * Math.log10(1 + f / 700);
const hz = (m) => 700 * (10 ** (m / 2595) - 1);

// colours from dark (quiet) through indigo, magenta and orange to pale yellow (loud)
const STOPS = [[0, [13, 15, 16]], [0.28, [40, 30, 92]], [0.52, [140, 47, 122]], [0.76, [240, 123, 63]], [1, [253, 230, 138]]];
const LUT = new Uint8ClampedArray(256 * 4);
for (let i = 0; i < 256; i++) {
  const u = i / 255;
  let k = 0;
  while (k < STOPS.length - 2 && u > STOPS[k + 1][0]) k++;
  const [u0, c0] = STOPS[k], [u1, c1] = STOPS[k + 1], f = (u - u0) / (u1 - u0);
  for (let c = 0; c < 3; c++) LUT[4 * i + c] = c0[c] + (c1[c] - c0[c]) * f;
  LUT[4 * i + 3] = 255;
}
export const colour = (u) => { const i = 4 * Math.max(0, Math.min(255, Math.round(u * 255))); return `rgb(${LUT[i]},${LUT[i + 1]},${LUT[i + 2]})`; };

export class Spectro {
  constructor() {
    this.fft = new FFT(N);
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    const bw = SR / N, m1 = mel(FMAX);
    // each band's bins [lo, hi), at least one
    this.bins = Array.from({ length: BANDS }, (_, b) => {
      const lo = hz((m1 * b) / BANDS), hi = hz((m1 * (b + 1)) / BANDS);
      const a = Math.round(lo / bw), z = Math.max(a + 1, Math.round(hi / bw));
      return [a, z];
    });
    this.strips = [];
    this.todo = []; // columns to paint: [a, b) in order, none touching
  }

  // nothing left to paint
  get done() { return this.todo.length === 0; }

  // columns [a, b) to paint
  want(a, b) {
    const t = this.todo;
    a = Math.max(0, a);
    if (b <= a) return;
    let i = 0;
    while (i < t.length && t[i][1] < a) i++;
    let j = i;
    while (j < t.length && t[j][0] <= b) { a = Math.min(a, t[j][0]); b = Math.max(b, t[j][1]); j++; }
    t.splice(i, j - i, [a, b]);
  }

  // paints the columns whose samples the take has had written since last asked, in at most `ms`
  update(take, ms = 6) {
    const t = performance.now(), y = take.y;
    for (const [a, b] of take.drain()) this.want(Math.floor((a - N / 2) / HOP) + 1, Math.ceil((b + N / 2) / HOP));
    let dirty = null;
    while (this.todo.length && performance.now() - t < ms) {
      const span = this.todo[0], c = span[0]++, s0 = c * HOP - N / 2;
      if (span[0] >= span[1]) this.todo.shift();
      for (let i = 0; i < N; i++) {
        const j = s0 + i;
        this.re[i] = j >= 0 && j < take.n ? y[j] * this.win[i] : 0;
        this.im[i] = 0;
      }
      this.fft.run(this.re, this.im, false);
      const k = Math.floor(c / COLS);
      if (!this.strips[k]) {
        const cv = document.createElement("canvas");
        cv.width = COLS; cv.height = BANDS;
        const g = cv.getContext("2d");
        this.strips[k] = { cv, g, img: g.createImageData(COLS, BANDS) };
      }
      const st = this.strips[k], x = c % COLS, d = st.img.data;
      for (let b = 0; b < BANDS; b++) {
        const [lo, hi] = this.bins[b];
        let p = 0;
        for (let i = lo; i < hi; i++) p += this.re[i] * this.re[i] + this.im[i] * this.im[i];
        const db = 10 * Math.log10(p / (hi - lo) + 1e-12);
        const u = Math.max(0, Math.min(255, Math.round(((db - TOP + RANGE) / RANGE) * 255)));
        const o = 4 * ((BANDS - 1 - b) * COLS + x);
        d[o] = LUT[4 * u]; d[o + 1] = LUT[4 * u + 1]; d[o + 2] = LUT[4 * u + 2]; d[o + 3] = 255;
      }
      (dirty ??= new Set()).add(k);
    }
    if (dirty) for (const k of dirty) this.strips[k].g.putImageData(this.strips[k].img, 0, 0);
    return this.done;
  }

  // the columns [c0, c1) drawn into the box (x, y, w, h) of g
  draw(g, c0, c1, x, y, w, h) {
    if (c1 <= c0) return;
    const sx = w / (c1 - c0);
    g.imageSmoothingEnabled = true;
    for (let k = Math.max(0, Math.floor(c0 / COLS)); k * COLS < Math.min(c1, this.strips.length * COLS); k++) {
      const st = this.strips[k];
      if (!st) continue;
      const a = Math.max(c0, k * COLS), b = Math.min(c1, (k + 1) * COLS);
      if (b <= a) continue;
      g.drawImage(st.cv, a - k * COLS, 0, b - a, BANDS, x + (a - c0) * sx, y, (b - a) * sx, h);
    }
  }
}
