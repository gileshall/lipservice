// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The path from what is asked to the speaker, a box a step, each saying what it is doing at the
// speaker's place: the word and the phones being said, the commas the break model put in, the
// pitch; for a choir or the crowd, how much of what is heard is echo and hall, and what the
// compressor and the limiter take off.

import { COMP, TRACE } from "./room.js";
import { HOP } from "./take.js";
import { colours, fit } from "./paint.js";

// the latent voice's steps from the score to sound (a site whose sound it makes, models/site.json)
const VOX = [
  ["loud", "Loudness", "how loud each moment is, drawn for the voice"],
  ["code", "Code", "the sound described, 100 frames a second"],
  ["render", "Generator", "the code into sound, on the pitch"],
];

const STEPS = {
  say: [
    ["text", "Text", "numbers and dates spelled out, each word read in its sense"],
    ["phones", "Phones", "a dictionary, and a model for the words not in it"],
    ["pauses", "Pauses", "a model of where readers pause, commas or not"],
    ["score", "Score", "how long each sound lasts, its pitch, the voice"],
    ["decoder", "Mel decoder", "the voice's spectrum, 100 frames a second"],
    ["vocos", "Vocos", "the spectrum into sound"],
    ["speaker", "Speaker", null],
  ],
  sing: [
    ["song", "Song", "a syllable a note"],
    ["notes", "Notes", "each syllable's pitch and length"],
    ["singer", "Singer", "the pitch moving into and around each note, the breath"],
    ["vocoder", "Vocoder", "a source and a filter, sample by sample"],
    ["speaker", "Speaker", null],
  ],
  room: [
    ["echo", "Echo", "left and right, half a beat apart"],
    ["hall", "Hall", "the room's ring"],
    ["mhall", "Mastering hall", "a longer ring on 200 Hz to 5 kHz"],
    ["hp", "High-pass", "below 30 Hz out"],
    ["comp", "Compressor", `${COMP.ratio}:1 above ${COMP.thresh} dB, a soft knee`],
    ["lim", "Limiter", "a ceiling at -1.5 dB, 12 ms ahead"],
    ["speaker", "Speaker", null],
  ],
};
STEPS.voxsay = [...STEPS.say.slice(0, 4), ...VOX, ["speaker", "Speaker", null]];
STEPS.voxsing = [...STEPS.sing.slice(0, 2), ["singer", "Singer", "the pitch moving into and around each note"], ...VOX, ["speaker", "Speaker", null]];
STEPS.choir = [["parts", "Parts", null], ["seats", "Seats", "each singer's place: pan, distance, two walls"], ...STEPS.room];
STEPS.crowd = [["parts", "Notes", null], ["seats", "Seats", "128 places on the risers"], ...STEPS.room];

const LO = -48, HI = 0; // dB across the compressor's picture
const knee = (x) => {
  const over = x - COMP.thresh, k = COMP.knee, s = 1 - 1 / COMP.ratio;
  return over <= -k / 2 ? 0 : over >= k / 2 ? over * s : ((over + k / 2) ** 2 / (2 * k)) * s;
};
const share = (x, of) => (x > 0 && of > 0 ? Math.max(0, Math.min(1, 1 + (10 * Math.log10(x / of)) / 30)) : 0);

export class Chain {
  // vox: the site's sound is the latent voice's
  constructor(el) {
    this.el = el;
    this.vox = false;
    this.kind = null;
    this.boxes = {};
  }

  // kind: "say", "sing", "choir" or "crowd"; what: the part's lines for the boxes that depend on
  // the take ({key: text})
  set(kind, what = {}) {
    this.kind = kind;
    this.boxes = {};
    // a row of `wide` boxes, or of `half` on a narrower page, or a column on a phone: each box's
    // arrow to the next where that is beside it (go-wide, go-half), or below (go-down)
    const steps = STEPS[this.vox && (kind === "say" || kind === "sing") ? `vox${kind}` : kind], m = steps.length, wide = m <= 7 ? m : Math.ceil(m / 2), half = Math.ceil(m / 2);
    this.el.style.setProperty("--wide", wide);
    this.el.style.setProperty("--half", half);
    this.el.replaceChildren(...steps.map(([key, name, line], i) => {
      const d = document.createElement("div");
      d.className = "step";
      if (i < m - 1) d.classList.add("go-down");
      if (i < m - 1 && (i + 1) % wide) d.classList.add("go-wide");
      if (i < m - 1 && (i + 1) % half) d.classList.add("go-half");
      const b = document.createElement("b"), s = document.createElement("span"), n = document.createElement("output");
      b.textContent = name;
      s.textContent = what[key] ?? line ?? "";
      d.append(b, s, n);
      const box = { d, now: n };
      if (["echo", "hall", "mhall", "lim", "seats"].includes(key)) {
        const m = document.createElement("i");
        m.className = key === "lim" ? "meter bad" : "meter";
        m.append(document.createElement("i"));
        d.append(m);
        box.meter = m.firstChild;
      }
      if (key === "comp") {
        box.cv = document.createElement("canvas");
        box.cv.className = "curve";
        d.append(box.cv);
      }
      this.boxes[key] = box;
      return d;
    }));
  }

  text(key, s) {
    const b = this.boxes[key];
    if (b && b.now.textContent !== s) b.now.textContent = s;
  }

  meter(key, u) {
    const b = this.boxes[key];
    if (b?.meter) b.meter.style.width = `${(100 * u).toFixed(1)}%`;
  }

  // what each step is doing with the speaker at sample ph of the take (or the crowd's mix); live:
  // the page's figures ({speed, made, heard, chord, voices, workers, ...})
  update({ take = null, ph = 0, trace = null, live = {} }) {
    const k = this.kind;
    if (k === "say" && take) this.speech(take, ph, live);
    if (k === "sing" && take) this.song(take, ph, live);
    if ((k === "choir" || k === "crowd") && trace) this.room(trace, Math.floor(ph / TRACE));
    if (k === "choir" || k === "crowd") this.text("parts", live.parts ?? "");
    this.text("speaker", live.heard ?? "");
  }

  speech(t, ph, live) {
    let word = null, phones = [], commas = 0, part = null;
    for (const p of t.parts) {
      for (const x of p.tokens) if (x.phrased && x.a <= ph) commas++;
      if (ph < p.at || ph >= p.end) continue;
      part = p;
    }
    if (part) {
      word = part.words.find((w) => ph >= w.a && ph < w.b) ?? null;
      if (word) phones = part.tokens.filter((x) => x.a < word.b && x.b > word.a && /^[a-z]/i.test(x.sym)).map((x) => ({ s: x.sym.replace(/\d/, "").toLowerCase(), now: ph >= x.a && ph < x.b }));
    }
    this.text("text", word ? word.text : "");
    this.text("phones", phones.map((x) => (x.now ? x.s.toUpperCase() : x.s)).join(" "));
    this.text("pauses", live.heard ? `${commas} added` : "");
    const f0 = t.f0[Math.floor(ph / HOP)];
    this.text("score", f0 > 0 ? `${Math.round(f0)} Hz` : "");
    for (const k of ["decoder", "code"]) this.text(k, t.n ? `${Math.floor(t.n / HOP)} frames made` : "");
    for (const k of ["vocos", "render"]) this.text(k, live.speed ?? "");
  }

  song(t, ph, live) {
    const n = t.notes.find((x) => ph >= x.a && ph < x.b) ?? null;
    let word = null;
    for (const x of t.notes) if (x.word && x.a <= ph) word = x.word;
    this.text("song", n ? word ?? "" : "");
    this.text("notes", n ? live.noteName(n.midi) : "");
    const f0 = t.f0[Math.floor(ph / HOP)];
    if (n && f0 > 0) {
      const c = Math.round(1200 * Math.log2(f0 / (440 * 2 ** ((n.midi - 69) / 12))));
      this.text("singer", `${c > 0 ? "+" : ""}${c} cents`);
    } else {
      this.text("singer", "");
    }
    for (const k of ["vocoder", "render"]) this.text(k, live.speed ?? "");
  }

  // the room at frame f: each return's share of the mix, what the compressor and limiter take off
  room(tr, f) {
    const v = (key) => tr.at(key, f), master = v("master");
    if (!(master >= 0)) return;
    this.meter("seats", share(v("dry"), master));
    this.meter("echo", share(v("echo"), master));
    this.meter("hall", share(v("hall"), master));
    this.meter("mhall", share(v("mhall"), master + v("mhall")));
    const gr = v("comp"), lim = v("lim");
    this.meter("lim", Math.min(1, lim / 6));
    this.text("lim", lim > 0.05 ? "taking off" : "");
    const pin = master + v("mhall");
    this.curve(pin > 0 ? 10 * Math.log10(pin) : -Infinity, gr);
  }

  // the compressor's curve (out against in), and where the mix is on it now
  curve(x, gr) {
    const b = this.boxes.comp;
    if (!b) return;
    const g = fit(b.cv), c = colours(), w = g.w, h = g.h;
    const X = (d) => ((d - LO) / (HI - LO)) * w, Y = (d) => h - ((d - LO) / (HI - LO)) * h;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = c.line;
    g.lineWidth = 1;
    g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(X(LO), Y(LO)); g.lineTo(X(HI), Y(HI)); g.stroke();
    g.beginPath(); g.moveTo(X(COMP.thresh), 0); g.lineTo(X(COMP.thresh), h); g.stroke();
    g.setLineDash([]);
    g.strokeStyle = c.pitch;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let d = LO; d <= HI; d += 0.5) {
      const y = Y(d - knee(d));
      if (d === LO) g.moveTo(X(d), y); else g.lineTo(X(d), y);
    }
    g.stroke();
    if (x > LO - 20 && Number.isFinite(gr)) {
      const xx = Math.max(LO, Math.min(HI, x));
      g.fillStyle = c.fg;
      g.beginPath(); g.arc(X(xx), Y(xx - gr), 3.5, 0, 2 * Math.PI); g.fill();
    }
  }
}
