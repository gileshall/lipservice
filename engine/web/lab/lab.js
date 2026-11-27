// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The diction bench's page: it draws a bench (bench.js) and calls it. One singer, one song, and
// everything the engine takes for how it is sung, each change sung and played at once. Nothing
// here decides how a word is sung: the sounds and options offered are the engine's (ls_bench), the
// bench writes the song's text, and the engine, in a worker (worker.js), sings it or refuses it.
import { Engine } from "../lipservice.js";
import { Bench } from "./bench.js";
import { HOP, SR, bpmOf, parsePhones, commandLine, differences, hasClose, insertSound, label, midiOf, noteMoved, notesOf, refusal, removeSound, rowLines, ruleLines, setClose, setCloseMs, setSound, setStress, snap, sungText, sweepValues, useReader, vowelRow, wordLines } from "./model.js";
import { asIn, cue, isVowel, name, say, sounds, stress, stressWord } from "./sounds.js";
import { tour } from "./tour.js";
// written by build.sh
import { MODELS } from "./models.js";

const KEY = "diction-bench";
const app = document.getElementById("app");

// an element: its attributes (on* a listener, class, the rest as given) and its children
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    // through the CSSOM: a style attribute is refused under style-src 'self'
    else if (k === "style") el.style.cssText = v;
    else if (["value", "checked", "disabled", "selected"].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
};
const help = (text) => h("div", { class: "help" }, text);

// ---------------------------------------------------------------- the engine, in a worker
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const waiting = new Map();
let asked = 0;
worker.onmessage = ({ data }) => {
  const w = waiting.get(data.id);
  waiting.delete(data.id);
  if (data.error !== undefined) w.reject(new Error(data.error));
  else w.resolve(data);
};
worker.onerror = (e) => fatal(`the engine's worker failed: ${e.message ?? e}`);
const ask = (m) => new Promise((resolve, reject) => {
  waiting.set(asked, { resolve, reject });
  worker.postMessage({ id: asked++, ...m });
});
const fatal = (why) => app.replaceChildren(h("div", { class: "bad" }, why));

// ---------------------------------------------------------------- what the page holds beside the bench
let lab = null, snd = null;
const view = {
  loop: false,
  hear: true, // what is touched is played
  open: [], // the folded parts of the page that are open
  more: null, // the vowel rule whose lesser settings are open
  sweep: { id: null, from: null, to: null, count: 5, picked: [], skip: [] },
  note: null, // a line said once: copied, saved, a saved session not read
};
// kept across redraws, so a hand in them is not thrown out
const songBox = h("textarea", { id: "song", spellcheck: "false", placeholder: "%bpm 84\nsilent F4:1.5+G4:0.5 F4:1\nnight D4:3\n%rest 1", title: "%bpm N, then a word a line: WORD NOTE:BEATS for each syllable. + joins notes on one syllable. %rest N is silence." });
const nameBox = h("input", { type: "text", id: "take-name", placeholder: "a name for the take" });
const scroller = h("div", { class: "scroll", id: "strip" });

// ---------------------------------------------------------------- sound
let ctx = null, playing = null;
// a sweep's runs heard in turn: the one playing; `turning` while the round itself starts a play
let turn = null, turning = false;
const buffers = new WeakMap();
const stop = () => {
  if (!playing) return;
  playing.src.onended = null;
  playing.src.stop();
  playing = null;
};
// where the playing is, seconds of the song
const position = () => {
  const run = ctx.currentTime - playing.t0, p = playing.at + run;
  if (!playing.loop) return Math.min(p, playing.to);
  return p < playing.to ? p : playing.from + ((p - playing.to) % (playing.to - playing.from));
};
// a sung song from `from` to `to` seconds, started at `at`, again and again if asked
const play = (sung, from, to, { loop = false, at = from } = {}) => {
  stop();
  if (!turning) turn = null;
  wake();
  if (!buffers.has(sung)) {
    const buf = ctx.createBuffer(1, sung.samples.length, SR);
    buf.copyToChannel(sung.samples, 0);
    buffers.set(sung, buf);
  }
  const src = ctx.createBufferSource();
  src.buffer = buffers.get(sung);
  src.connect(ctx.destination);
  Object.assign(src, { loop, loopStart: from, loopEnd: to });
  if (loop) src.start(0, at);
  else src.start(0, at, to - at);
  playing = { src, t0: ctx.currentTime, at, from, to, loop };
  src.onended = () => {
    if (playing?.src !== src) return;
    playing = null;
    if (turn !== null) turnTo(turn + 1);
    else draw();
  };
};
// what is heard, its region; `carry`: from where the playing is now, as a flip does
const playNow = ({ carry = false, from = null } = {}) => {
  const s = lab.shown();
  if (!s) return;
  const dur = s.samples.length / SR;
  const [a, b] = lab.region ? [Math.min(lab.region[0], dur), Math.min(lab.region[1], dur)] : [0, dur];
  if (from !== null) return play(s, Math.min(from, dur), dur);
  if (b - a < 0.02) return;
  const at = carry && playing ? Math.min(Math.max(position(), a), b - 0.01) : a;
  play(s, a, b, { loop: view.loop, at });
};
// what was touched is heard, if that is wanted
const touched = (how) => { if (view.hear) playNow(how); };
// a browser plays nothing before the page is touched: the first touch wakes the sound
const wake = () => {
  if (!ctx) {
    ctx = new AudioContext();
    // the page says so when the browser holds the sound back
    ctx.onstatechange = () => { if (lab) draw(); };
  }
  if (ctx.state !== "running") ctx.resume();
};
for (const t of ["pointerdown", "mousedown", "touchend", "click", "keydown"]) addEventListener(t, wake, true);
const tick = () => {
  const head = document.getElementById("head");
  if (head) {
    if (playing) {
      const x = position() * zoom();
      head.style.display = "block";
      head.style.left = `${x}px`;
      if (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = Math.max(0, x - 40);
    } else {
      head.style.display = "none";
    }
  }
  guide.place();
  requestAnimationFrame(tick);
};

// ---------------------------------------------------------------- a number pulled with the mouse
// while a number is pulled or a list is open the page is not redrawn under the hand
let pulling = false, late = false;
// Shows `value`; pulled left or right it moves by `step` (ten steps with shift held) and
// `done(value)` is called on letting go (the arrow keys move it too).
const pull = (value, { min, max, step, show = (v) => String(v) }, done) => {
  const fit = (v) => Math.min(max, Math.max(min, snap(v, step)));
  const el = h("span", { class: "pull", tabindex: "0", title: "Pull left or right. Hold shift for bigger steps." }, show(value));
  let v = value;
  el.addEventListener("pointerdown", (e) => {
    const x0 = e.clientX, v0 = value;
    el.setPointerCapture(e.pointerId);
    el.classList.add("pulling");
    pulling = true;
    const move = (m) => {
      v = fit(v0 + Math.round((m.clientX - x0) / 6) * step * (m.shiftKey ? 10 : 1));
      el.textContent = show(v);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.classList.remove("pulling");
      pulling = false;
      if (v !== value) done(v);
      else if (late) draw();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    e.preventDefault();
  });
  el.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const to = fit(value + d * step * (e.shiftKey ? 10 : 1));
    if (to !== value) done(to);
  });
  return el;
};
const ms = (v) => `${v} ms`;
// a list to pick one of: [{value, label}]
const pick = (id, choices, value, done) => {
  const el = h("select", { id, onchange: (e) => { e.target.blur(); done(choices[Number(e.target.value)].value); }, onblur: () => { if (late) draw(); } },
    choices.map((c, k) => h("option", { value: String(k), selected: c.value === value }, c.label)));
  return el;
};
const vowelChoices = (none) => [...(none ? [{ value: null, label: none }] : []), ...snd.vowels.map((v) => ({ value: `${v}1`, label: cue(`${v}1`) }))];

// ---------------------------------------------------------------- the song and the singer
// the song's text goes to the bench when the typing stops
let typing = null;
const flush = () => {
  if (typing === null) return;
  clearTimeout(typing);
  typing = null;
  if (songBox.value !== lab.state.text) lab.setText(songBox.value);
};
songBox.addEventListener("input", () => {
  clearTimeout(typing);
  typing = setTimeout(flush, 600);
});
songBox.addEventListener("blur", flush);

const songPart = () => {
  const bpm = bpmOf(lab.state.text);
  if (typing === null && songBox.value !== lab.state.text) songBox.value = lab.state.text;
  return h("div", { class: "card", id: "song-card" },
    h("div", { class: "row" },
      h("h2", {}, "The song"),
      h("label", {}, "Singer", pick("voice", lab.voices.map((v) => ({ value: v.name, label: v.label })), lab.state.voice, (v) => lab.setVoice(v))),
      bpm !== null && h("label", {}, "Tempo", pull(bpm, { min: 20, max: 400, step: 1, show: (v) => `${v} bpm` }, (v) => lab.setBpm(v)))),
    songBox,
    null,
    lab.error && h("div", { class: "bad", id: "refused" }, `The engine refused this, so what is below is the song as last sung: ${lab.error}`));
};

// ---------------------------------------------------------------- the performance
// the picture's width a second: the whole song across the page, a long one no tighter than can be read
const CANVAS = 32000, TIGHT = 40;
const zoom = () => {
  const s = lab.shown();
  if (!s) return TIGHT;
  const dur = s.samples.length / SR, wide = (scroller.clientWidth || app.clientWidth - 60) - 4;
  return Math.min(Math.max(wide / dur, TIGHT), CANVAS / dur);
};
const noteName = (m) => noteMoved("C4", Math.round(m) - 60);
// the sung pitch, the written notes and the level under the sounds
const paint = (canvas, s) => {
  const g = canvas.getContext("2d"), W = canvas.width, H = canvas.height, z = zoom();
  g.clearRect(0, 0, W, H);
  const mid = (hz) => 69 + 12 * Math.log2(hz / 440);
  // the page's colours, light or dark
  const css = getComputedStyle(document.documentElement), tone = (name) => css.getPropertyValue(name).trim();
  let lo = Infinity, hi = -Infinity;
  for (const hz of s.pitch) if (hz > 0) { lo = Math.min(lo, mid(hz)); hi = Math.max(hi, mid(hz)); }
  for (const n of s.notes) { lo = Math.min(lo, n[2]); hi = Math.max(hi, n[2]); }
  // the level: a grey hill along the bottom
  let top = 0;
  for (const v of s.level) top = Math.max(top, v);
  if (top > 0) {
    g.fillStyle = tone("--c-level");
    g.beginPath();
    g.moveTo(0, H);
    s.level.forEach((v, f) => g.lineTo(((f + 0.5) * HOP / SR) * z, H - (v / top) * H * 0.4));
    g.lineTo((s.level.length * HOP / SR) * z, H);
    g.fill();
  }
  // where each sound starts
  g.strokeStyle = tone("--c-grid");
  g.beginPath();
  for (const w of s.plan) for (const p of w.phones) { const x = Math.round((p[2] / SR) * z) + 0.5; g.moveTo(x, 0); g.lineTo(x, H); }
  g.stroke();
  if (lo === Infinity) return;
  lo = Math.floor(lo) - 2;
  hi = Math.ceil(hi) + 2;
  const y = (m) => H - ((m - lo) / (hi - lo)) * H;
  // a line a semitone, each named now and then
  g.font = "10px system-ui, sans-serif";
  for (let m = lo + 1; m < hi; m++) {
    g.strokeStyle = tone(m % 12 === 0 ? "--c-grid-strong" : "--c-grid");
    g.beginPath();
    g.moveTo(0, Math.round(y(m)) + 0.5);
    g.lineTo(W, Math.round(y(m)) + 0.5);
    g.stroke();
    g.fillStyle = tone("--c-axis");
    for (let x = 4; x < W; x += 500) g.fillText(noteName(m), x, y(m) - 2);
  }
  // the notes as written
  g.fillStyle = tone("--c-note");
  const one = Math.abs(y(1) - y(0));
  for (const [a, b, m] of s.notes) g.fillRect((a / SR) * z, y(m) - one / 2, ((b - a) / SR) * z, one);
  // the pitch as sung
  g.strokeStyle = tone("--fg");
  g.lineWidth = 1.6;
  g.beginPath();
  let pen = false;
  s.pitch.forEach((hz, f) => {
    if (!(hz > 0)) { pen = false; return; }
    const x = ((f + 0.5) * HOP / SR) * z;
    if (pen) g.lineTo(x, y(mid(hz)));
    else g.moveTo(x, y(mid(hz)));
    pen = true;
  });
  g.stroke();
  g.lineWidth = 1;
};

const strip = () => {
  const s = lab.shown();
  if (!s) {
    scroller.replaceChildren();
    return null;
  }
  const z = zoom(), dur = s.samples.length / SR, W = Math.ceil(dur * z), px = (n) => (n / SR) * z;
  const canvas = h("canvas", { id: "curves", width: String(W), height: "180", style: `width:${W}px` });
  const shade = h("div", { class: "region", id: "region", style: lab.region ? `left:${lab.region[0] * z}px;width:${(lab.region[1] - lab.region[0]) * z}px` : "display:none" });
  // pulled across, the part that plays; touched, it plays from there
  canvas.addEventListener("pointerdown", (e) => {
    const x0 = e.offsetX;
    let x1 = x0;
    canvas.setPointerCapture(e.pointerId);
    const move = (m) => {
      x1 = Math.min(W, Math.max(0, m.offsetX));
      if (Math.abs(x1 - x0) > 4) shade.style.cssText = `left:${Math.min(x0, x1)}px;width:${Math.abs(x1 - x0)}px`;
    };
    const up = () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      if (Math.abs(x1 - x0) > 4) {
        lab.setRegion([Math.min(x0, x1) / z, Math.max(x0, x1) / z]);
        playNow();
      } else {
        playNow({ from: x0 / z });
      }
      draw();
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    e.preventDefault();
  });
  const inner = h("div", { class: "inner", style: `width:${W}px` },
    s.plan.map((w, k) => {
      const a = w.phones[0][2], b = w.phones.at(-1)[3];
      return h("div", { class: `tw${lab.sel?.k === k ? " sel" : ""}`, style: `left:${px(a)}px;width:${px(b - a)}px`, title: w.word, onclick: () => { lab.select(k); touched(); } }, w.word);
    }),
    s.plan.flatMap((w, k) => w.phones.map(([p, close, a, b], i) => {
      const cls = `band ${close ? "close" : isVowel(p) ? "vowel" : "cons"}${lab.sel?.k === k && lab.sel.i === i ? " sel" : ""}`;
      const len = Math.round(((b - a) / SR) * 1000);
      return h("div", { class: cls, style: `left:${px(a)}px;width:${px(b - a)}px`, title: `${cue(p)}${close ? ", the end of the vowel before it" : ""}: ${len} ms`, onclick: () => { lab.select(k, i); touched(); } });
    })),
    canvas, shade, h("div", { class: "head", id: "head" }));
  scroller.className = `scroll${lab.busy || (lab.heard.kind === "bench" && lab.error) ? " stale" : ""}`;
  scroller.replaceChildren(inner);
  paint(canvas, s);
  return scroller;
};

// the line spelled out: under each word every sound it is sung with, none left out for being short
const spelled = (s, words) =>
  h("div", { class: "spell", id: "spell" }, s.plan.map((w, k) =>
    h("div", { class: `sp${lab.sel?.k === k ? " sel" : ""}` },
      h("button", { class: "sp-word", "data-word": String(k), title: "Choose this word and hear it", onclick: () => { lab.select(k); touched(); } },
        w.word, words[k]?.braces !== null && h("span", { class: "dot", title: "You changed its sounds." }, " •")),
      h("div", { class: "sp-tiles" }, w.phones.map(([p, close, , , by, dip], i) =>
        h("button", { class: `tile ${close ? "close" : isVowel(p) ? "vowel" : "cons"}${by !== null || dip !== null ? " ruled" : ""}${lab.sel?.k === k && lab.sel.i === i ? " sel" : ""}`, "data-sound": `${k}.${i}`,
          title: [`${cue(p)}${close ? ", the end of the vowel before it" : ""}`, ...ruledBy(s, by, dip)].join("\n"), onclick: () => { lab.select(k, i); touched(); } }, say(p)))))));
// the rules that gave a sound and its dip, in the engine's words
const ruledBy = (s, by, dip) => [by, dip].filter((r) => r !== null && r !== undefined).map((r) => `rule: ${s.rules[r]}`);

const performancePart = () => {
  const s = lab.shown(), w = lab.what(lab.heard);
  if (!s && !lab.busy) {
    return h("div", { class: "card row", id: "performance" }, h("h2", {}, "The line"),
      w.error ? h("div", { class: "bad" }, `Refused: ${w.error}`) : h("span", { class: "help" }, "No song yet."));
  }
  return h("div", { class: "card", id: "performance" },
    h("div", { class: "row", id: "controls" },
      h("h2", {}, "The line"),
      playing
        ? h("button", { class: "big", id: "play", onclick: () => { turn = null; stop(); draw(); } }, "Stop")
        : h("button", { class: "big main", id: "play", disabled: !s, onclick: () => { playNow(); draw(); } }, "Play"),
      lab.region && h("button", { id: "all", onclick: () => lab.select(null) }, "The whole song"),
      h("label", {}, h("input", { type: "checkbox", id: "hear", checked: view.hear, onchange: (e) => { view.hear = e.target.checked; draw(); } }), "play what I touch"),
      h("label", {}, h("input", { type: "checkbox", id: "loop", checked: view.loop, onchange: (e) => { view.loop = e.target.checked; if (playing) playNow({ carry: true }); } }), "round and round"),
      h("button", { id: "undo", disabled: !lab.past.length, onclick: () => lab.undo() }, "Undo"),
      h("button", { id: "redo", disabled: !lab.future.length, onclick: () => lab.redo() }, "Redo"),
      h("span", { class: "soft", id: "status" }, lab.busy ? "Singing." : ""),
      ctx && ctx.state !== "running" && h("button", { class: "bad", id: "blocked", onclick: wake }, `Sound is ${ctx.state} in this browser. Click to start it.`)),
    lab.heard.kind !== "bench" && h("div", { class: "row", id: "heard" },
      h("span", {}, "Playing: ", h("b", {}, w.name)),
      h("button", { id: "to-bench", onclick: () => lab.load(lab.heard) }, "Work on it"),
      h("button", { id: "back", onclick: () => lab.hear({ kind: "bench" }) }, "Back to mine")),
    s && spelled(s, wordLines(w.state.text)),
    s && h("div", { class: "row help" }, h("span", { class: "swatch vowel" }, "vowel"), h("span", { class: "swatch cons" }, "consonant"), h("span", { class: "swatch close" }, "ending")),
    wordPart(),
    strip(),
    h("div", { class: "row help" }, h("label", { title: "How much plays either side of a chosen word" }, "Lead in and out", pull(lab.margin, { min: 0, max: 3, step: 0.05, show: (v) => `${v.toFixed(2)} s` }, (v) => { lab.setMargin(v); touched(); }))));
};

// ---------------------------------------------------------------- the chosen word and sound
const soundChoices = (names) => names.map((n) => ({ value: n, label: cue(snd.vowels.includes(n) ? `${n}1` : n) }));
const lengthOf = (s, k, i) => {
  const p = s.plan[k]?.phones[i];
  return p ? Math.round(((p[3] - p[2]) / SR) * 1000) : null;
};

// one short row for the chosen sound: what it is, how it ends, what goes round it
const soundPart = (c, s) => {
  const { k, i, phones } = c, x = phones[i], len = lengthOf(s, k, i);
  const vowel = isVowel(x.p), end = !x.close && hasClose(phones, i) ? phones[i + 1] : null;
  const after = i + 1 + (end ? 1 : 0);
  const add = [{ value: null, label: "…" }, ...soundChoices(snd.all)];
  const last = (at, y) => [
    h("label", {}, "for the last", pull(y.ms ?? lengthOf(s, k, at) ?? 200, { min: 10, max: 1500, step: 10, show: ms }, (v) => lab.edit(k, setCloseMs(phones, at, v)))),
    y.ms !== null && h("button", { id: "close-free", onclick: () => lab.edit(k, setCloseMs(phones, at, null)) }, "auto")];
  return h("div", { id: "sound" },
    h("div", { class: "row" },
      h("label", {}, h("b", {}, x.close ? "Ending" : "Sound"), pick("sound-is", soundChoices(x.close ? snd.vowels : snd.all), name(x.p), (n) => lab.edit(k, setSound(phones, i, n, lab.bench)))),
      vowel && h("label", {}, "Weight", pick("sound-weight", snd.stresses.map((d) => ({ value: d, label: stressWord(d) })), stress(x.p), (d) => lab.edit(k, setStress(phones, i, d)))),
      x.close && last(i, x),
      len !== null && h("span", { class: "help" }, `${len} ms`),
      ruledBy(s, s.plan[k]?.phones[i]?.[4], s.plan[k]?.phones[i]?.[5]).map((t) => h("code", { class: "rule" }, t))),
    vowel && !x.close && h("div", { class: "row" },
      h("label", { title: "What the vowel slides to at the very end of its note" }, "Ends on", pick("sound-end", [{ value: null, label: "nothing" }, ...soundChoices(snd.vowels)], end ? name(end.p) : null,
        (n) => lab.edit(k, n === null ? setClose(phones, i, null, null, lab.bench) : end ? setSound(phones, i + 1, n, lab.bench) : setClose(phones, i, n, null, lab.bench)))),
      end && last(i + 1, end)),
    h("div", { class: "row" },
      !x.close && h("label", {}, "Add before", pick("add-before", add, null, (n) => { if (n === null) return; lab.sel.i = i + 1; lab.edit(k, insertSound(phones, i, n, lab.bench)); })),
      h("label", {}, "Add after", pick("add-after", add, null, (n) => { if (n !== null) lab.edit(k, insertSound(phones, after, n, lab.bench)); })),
      h("button", { id: "remove", onclick: () => { lab.sel.i = null; lab.edit(k, removeSound(phones, i)); } }, "Remove")));
};

const wordPart = () => {
  const s = lab.shown();
  if (!lab.sel || !s || lab.sel.k >= s.plan.length) return null;
  const k = lab.sel.k, bench = lab.heard.kind === "bench", w = wordLines(lab.what(lab.heard).state.text)[k];
  if (!w) return null;
  const c = lab.chosen();
  // the word's notes, where the song as it is now written reads
  const notes = refusal(lab.state.text) === null && k < wordLines(lab.state.text).length ? notesOf(lab.state.text, k).map((n) => ({ ...n, midi: midiOf(n.note), n: Number(n.beats) })) : null;
  return h("div", { class: "editor", id: "word" },
    null,
    bench && c && soundPart(c, s),
    bench && h("div", { class: "row", id: "notes" },
      h("b", {}, `“${w.word}”`),
      notes && notes.every((n) => n.n > 0) && notes.map((n, j) => h("span", { class: "row" }, n.first ? "" : "+",
        pull(n.midi, { min: 0, max: 127, step: 1, show: (m) => noteMoved(n.note, m - n.midi) }, (m) => lab.setNote(k, j, { note: noteMoved(n.note, m - n.midi) })),
        pull(n.n, { min: 0.125, max: 64, step: 0.125, show: (b) => `${b} beat${b === 1 ? "" : "s"}` }, (b) => lab.setNote(k, j, { beats: String(b) })))),
      w.braces !== null && h("button", { id: "plain", onclick: () => lab.edit(k, null) }, "Reset word"),
      w.braces !== null && h("button", { id: "everywhere", onclick: () => lab.everywhere(k) }, `Every “${w.word}” like this`)),
    null,
    bench && !c && lab.sel.i !== null && help("Not sung as it stands."));
};

// ---------------------------------------------------------------- a part of the page folded shut until wanted
const fold = (id, title, note, body) => {
  const open = view.open.includes(id);
  return h("div", { class: "card", id },
    h("button", { class: "fold", "data-fold": id, onclick: () => { view.open = open ? view.open.filter((x) => x !== id) : [...view.open, id]; draw(); } },
      open ? "▾ " : "▸ ", h("b", {}, title), note && h("span", { class: "help" }, ` ${note}`)),
    open && body());
};

// ---------------------------------------------------------------- how it is sung
const plain = (o) => (o.kind === "choice" ? "none" : o.kind === "switch" ? false : o.default);
const shown = (v) => (v === true ? "on" : v === false ? "off" : String(v));
const changedOptions = () => lab.bench.options.filter((o) => lab.state.options[o.name] !== plain(o));

const optionsPart = () => {
  const n = changedOptions().length;
  return fold("options", "Settings", n ? `${n} changed` : "", () =>
    h("div", { class: "opts" }, lab.bench.options.map((o) => {
      const v = lab.state.options[o.name];
      const control = o.kind === "switch"
        ? h("input", { type: "checkbox", id: `opt-${o.name}`, checked: v, onchange: (e) => lab.setOption(o.name, e.target.checked) })
        : o.kind === "choice"
          ? pick(`opt-${o.name}`, ["none", ...lab.bench.motions].map((m) => ({ value: m, label: m })), v, (m) => lab.setOption(o.name, m))
          : pull(v, o, (x) => lab.setOption(o.name, x));
      return h("div", { class: "opt", "data-option": o.name }, h("div", { class: "name" }, label(o.name)), h("div", {}, control), h("div", { class: "help" }, o.help));
    })));
};

// ---------------------------------------------------------------- everything that is changed, in one list
// what a reference is called on the page
const called = (ref) => (ref.kind === "bench" ? "now" : lab.what(ref).name);
const spell = (phones) => phones.map((x) => `${x.close ? "→" : ""}${say(x.p)}`).join(" ");
const tickOf = (id, on, done) => h("input", { type: "checkbox", id, checked: on, title: "Untick to hear the song without this", onchange: (e) => done(e.target.checked) });

const rulesPart = () => {
  const r = lab.state.rules, words = wordLines(lab.state.text), voice = lab.state.voice;
  const set = (j, f) => lab.setRules((y) => f(y.rows[j]));
  const row = (attrs, ...kids) => h("div", { class: "change", ...attrs }, kids);
  const x = (attrs, run) => h("button", { class: "x", title: "Remove", ...attrs, onclick: run }, "×");
  const drop = (j) => x({ "data-drop": String(j) }, () => lab.setRules((y) => { y.rows.splice(j, 1); }));
  const tick = (v, j) => tickOf(`rule-${j}-on`, !v.off, (t) => set(j, (y) => { if (t) delete y.off; else y.off = true; }));
  const who = (v, j) => pick(`rule-${j}-who`, [{ value: false, label: "everyone" }, { value: true, label: `${voice} only` }], !!v.who, (t) => set(j, (y) => { if (t) y.who = true; else delete y.who; }));
  // the row as the engine reads it
  const lines = (v) => h("code", { class: "rule" }, rowLines(v, voice).join("\n"));
  const more = (id) => h("button", { "data-more": id, class: view.more === id ? "on" : "", onclick: () => { view.more = view.more === id ? null : id; draw(); } }, "…");
  const kinds = {
    vowel: (v, j) => row({ "data-rule": String(j) }, tick(v, j), h("span", {}, "long vowel"), h("b", {}, say(v.of)),
      h("span", { class: "row" },
        h("label", {}, "hold", pick(`rule-${j}-hold`, vowelChoices(null), v.hold, (t) => set(j, (y) => { y.hold = t; }))),
        h("label", {}, "end", pick(`rule-${j}-close`, vowelChoices("nothing"), v.close, (t) => set(j, (y) => { y.close = t; }))),
        h("label", {}, "last", pull(v.ms, { min: 10, max: 1500, step: 10, show: ms }, (t) => set(j, (y) => { y.ms = t; }))),
        h("label", { title: "The shortest note it is sung this way on" }, "from", pull(v.held, { min: 10, max: 3000, step: 10, show: ms }, (t) => set(j, (y) => { y.held = t; }))),
        who(v, j), more(`rule-${j}`),
        view.more === `rule-${j}` && h("label", { title: "What it ends on when the next sound is a vowel" }, "before a vowel, end", pick(`rule-${j}-into`, vowelChoices("same"), v.into, (t) => set(j, (y) => { y.into = t; }))),
        view.more === `rule-${j}` && h("label", { title: "Consonants before which the vowel is left alone" }, "not before",
          v.whole.map((c) => h("button", { "data-unwhole": c, title: "Remove", onclick: () => set(j, (y) => { y.whole = y.whole.filter((z) => z !== c); }) }, say(c), " ×")),
          pick(`rule-${j}-whole`, [{ value: null, label: "+" }, ...soundChoices(snd.consonants.filter((c) => !v.whole.includes(c)))], null,
            (n) => { if (n !== null) set(j, (y) => { y.whole = [...y.whole, n]; }); })),
        lines(v)),
      drop(j)),
    dip: (v, j) => row({ "data-rule": String(j) }, tick(v, j), h("span", {}, "pitch dip"), h("b", {}, v.every ? "b d g j" : "b d g"),
      h("span", { class: "row" },
        h("label", {}, "depth", pull(v.depth, { min: 0, max: 4, step: 0.1, show: (t) => t.toFixed(1) }, (t) => set(j, (y) => { y.depth = t; }))),
        h("label", {}, h("input", { type: "checkbox", id: `rule-${j}-every`, checked: v.every, onchange: (e) => set(j, (y) => { y.every = e.target.checked; }) }), "inside words, and j"),
        who(v, j), lines(v)),
      drop(j)),
    word: (v, j) => row({ "data-rule": String(j), "data-word-rule": v.word }, tick(v, j), h("span", {}, "every"), h("b", {}, v.word),
      h("span", { class: "row" }, h("span", {}, spell(parsePhones(v.phones, lab.bench))), who(v, j), lines(v)),
      drop(j)),
    line: (v, j) => row({ "data-rule": String(j) }, tick(v, j), h("span", {}, "rule"), h("b", {}, ""),
      h("span", { class: "row" }, h("input", { type: "text", class: "rule", id: `rule-${j}-text`, value: v.text, spellcheck: false, placeholder: "T place=last before=rest -> none",
        title: "A rule in the engine's words: [for=WHO] [word=WORD] SOUND [when] -> WHAT. before= and after= see the sounds of the same word; at a word's edge only rest or word. A when reads the word as the dictionary has it.", onchange: (e) => set(j, (y) => { y.text = e.target.value; }) })),
      drop(j)),
  };
  const sets = Object.keys(lab.bench.sets).map((n) => row({ "data-set-rules": n },
    n === "sung" ? tickOf("set-sung", r.sung, (t) => lab.setRules((y) => { y.sung = t; })) : h("span", {}), h("span", {}, "built in"), h("b", {}, n),
    h("span", { class: "row" }, h("span", { class: "help" }, `${lab.bench.sets[n].length} rule${lab.bench.sets[n].length === 1 ? "" : "s"}`), more(`set-${n}`),
      view.more === `set-${n}` && h("code", { class: "rule" }, lab.bench.sets[n].join("\n"))),
    h("span", {})));
  const rows = [
    ...sets,
    ...changedOptions().map((o) => row({ "data-set": o.name }, h("span", {}), h("span", {}, "setting"), h("b", {}, label(o.name)), h("span", {}, shown(lab.state.options[o.name])),
      x({}, () => lab.setOption(o.name, plain(o))))),
    ...words.map((w, k) => w.braces !== null && row({ "data-edited": String(k) }, h("span", {}), h("span", {}, `word ${k + 1}`),
      h("button", { class: "link", title: "Show it", onclick: () => { lab.select(k); touched(); } }, w.word), h("span", {}, spell(parsePhones(w.braces, lab.bench))),
      x({}, () => lab.edit(k, null)))).filter(Boolean),
    ...r.rows.map((v, j) => kinds[v.kind](v, j)),
  ];
  const held = r.rows.filter((v) => v.kind === "vowel").map((v) => v.of);
  const add = [{ value: null, label: "+ rule" },
    ...snd.vowels.map((v) => `${v}1`).filter((v) => !held.includes(v)).map((v) => ({ value: `vowel ${v}`, label: `long vowel: ${cue(v)}` })),
    { value: "dip", label: "pitch dip through b, d, g" }, { value: "line", label: "in the engine's words" }];
  return h("div", { class: "card", id: "rules" },
    h("div", { class: "row" }, h("h2", {}, "Changes"),
      pick("rule-add", add, null, (v) => {
        if (v === null) return;
        const [kind, of] = v.split(" ");
        lab.setRules((y) => { y.rows.push(kind === "vowel" ? vowelRow(lab.bench, of) : kind === "dip" ? { kind: "dip", depth: 1, every: false } : { kind: "line", text: "" }); });
      })),
    h("div", { class: "changes" }, rows));
};

// ---------------------------------------------------------------- sweeps
const openSweep = (id) => {
  const t = lab.targets().find((x) => x.id === id);
  if (!t) return;
  view.sweep = { id, from: t.kind === "number" ? t.min : null, to: t.kind === "number" ? t.max : null, count: view.sweep.count, picked: [], skip: [] };
};
// a sweep's runs heard one after the other, from run j on, the unticked ones passed over
const turnTo = (j) => {
  const runs = lab.sweep?.runs ?? [];
  while (j < runs.length && (!runs[j].sung || view.sweep.skip.includes(j))) j++;
  if (j >= runs.length) { turn = null; draw(); return; }
  turn = j;
  turning = true;
  if (lab.heard.kind === "run" && lab.heard.k === j) { playNow(); draw(); } else lab.hear({ kind: "run", k: j });
  turning = false;
};
const sweepPart = () => fold("sweep", "Sweep", lab.sweep ? lab.sweep.label : "", () => {
  const ts = lab.targets(), sw = view.sweep, t = ts.find((x) => x.id === sw.id) ?? null;
  const values = !t ? [] : t.kind === "number" ? sweepValues(sw.from, sw.to, sw.count, t.step) : t.choices.map((c) => c.value).filter((v) => sw.picked.includes(JSON.stringify(v)));
  const toggle = (v) => { const j = JSON.stringify(v); sw.picked = sw.picked.includes(j) ? sw.picked.filter((x) => x !== j) : [...sw.picked, j]; draw(); };
  const run = lab.heard.kind === "run" ? lab.heard : null;
  return h("div", {},
    h("div", { class: "row" },
      pick("sweep-target", [{ value: null, label: "what to sweep" }, ...ts.map((x) => ({ value: x.id, label: x.label }))], t ? t.id : null, (id) => { if (id) openSweep(id); else view.sweep.id = null; draw(); }),
      t?.kind === "number" && ["from", pull(sw.from, t, (v) => { sw.from = v; draw(); }), "to", pull(sw.to, t, (v) => { sw.to = v; draw(); }), "in", pull(sw.count, { min: 2, max: 16, step: 1, show: (v) => `${v} steps` }, (v) => { sw.count = v; draw(); })],
      t && h("button", { class: "main", id: "sweep-run", disabled: values.length < 2 || lab.busy > 0, onclick: () => { sw.skip = []; lab.run(t.id, values); } }, `Sing ${values.length}`)),
    null,
    t?.kind === "number" && help(`${values.join(", ")}  (now ${t.get(lab.state)})`),
    t?.kind === "choice" && h("div", {},
      h("div", { class: "row" }, t.choices.map((c) => h("button", { "data-choice": JSON.stringify(c.value), class: sw.picked.includes(JSON.stringify(c.value)) ? "on" : "", onclick: () => toggle(c.value) }, c.label)),
        h("button", { id: "sweep-every", onclick: () => { sw.picked = t.choices.map((c) => JSON.stringify(c.value)); draw(); } }, "all"))),
    lab.sweep && h("div", { id: "runs" },
      null,
      h("div", { class: "row" }, lab.sweep.runs.map((r, j) => h("span", { class: "run" },
        h("input", { type: "checkbox", "data-run-on": String(j), checked: !sw.skip.includes(j), title: "Untick to leave it out of the round", onchange: (e) => { sw.skip = e.target.checked ? sw.skip.filter((x) => x !== j) : [...sw.skip, j]; draw(); } }),
        h("button", { "data-run": String(j), class: run?.k === j ? "on" : "", disabled: !r.sung, title: r.error ? `The engine refused it: ${r.error}` : "", onclick: () => { turn = null; if (run?.k === j) { playNow(); draw(); } else lab.hear({ kind: "run", k: j }); } },
          r.said, r.error ? " (refused)" : !r.sung ? " (singing)" : ""))),
        h("button", { id: "turn", class: "main", disabled: lab.busy > 0, onclick: () => turnTo(0) }, "Play ticked")),
      h("div", { class: "row", style: "margin-top:6px" },
        h("button", { id: "run-load", disabled: !run, onclick: () => lab.load(run) }, "Use it"),
        h("button", { id: "run-keep", disabled: !run, onclick: () => lab.keep(nameBox.value || lab.what(run).name, run) }, "Keep as take"),
        h("button", { id: "sweep-end", onclick: () => { turn = null; lab.endSweep(); } }, "Clear")),
      lab.sweep.runs.some((r) => r.error) && help(`Refused: ${lab.sweep.runs.filter((r) => r.error).map((r) => `${r.value}: ${r.error}`).join("; ")}`)));
});

// ---------------------------------------------------------------- takes
const takesPart = () => fold("takes", "Takes", lab.takes.length ? String(lab.takes.length) : "", () => {
  const mark = (ref) => h("span", { class: "mark", title: "● is playing, ○ is what Flip goes to" }, lab.same(ref, lab.heard) ? "●" : lab.same(ref, lab.other) ? "○" : "");
  return h("div", {},
    h("div", { class: "row" }, nameBox,
      h("button", { class: "main", id: "keep", disabled: !lab.sung || !!lab.error, onclick: () => { lab.keep(nameBox.value); nameBox.value = ""; } }, "Keep"),
      h("button", { id: "flip2", disabled: !lab.other, onclick: () => lab.flip() }, lab.other ? `Flip to ${called(lab.other)} (F)` : "Flip (F)")),
    null,
    h("div", { class: "take" }, mark({ kind: "bench" }), h("span", { class: "name" }, "now"), h("button", { id: "hear-bench", onclick: () => lab.hear({ kind: "bench" }) }, "Hear")),
    lab.takes.map((t) => {
      const ref = { kind: "take", id: t.id }, d = differences(t.state, lab.state, lab.bench);
      return h("div", { class: "take", "data-take": String(t.id) }, mark(ref), h("span", { class: "name" }, t.name),
        h("button", { "data-hear": String(t.id), onclick: () => lab.hear(ref) }, "Hear"),
        h("button", { "data-load": String(t.id), onclick: () => lab.load(ref) }, "Load"),
        h("button", { "data-forget": String(t.id), onclick: () => lab.drop(t.id) }, "Delete"),
        h("span", { class: "help" }, t.error ? `The engine refused it: ${t.error}` : d.length ? d.join("; ") : "same as now"));
    }));
});

// ---------------------------------------------------------------- out as text
const say1 = (what) => { view.note = what; draw(); };
const copy = (text, what) => navigator.clipboard.writeText(text).then(() => say1(`${what} copied.`), (e) => say1(`Not copied: ${e.message}`));
const outPart = () => fold("out", "Text", "", () => {
  const w = lab.what(lab.heard), text = sungText(w.state).text, cmd = commandLine(w.state, lab.bench);
  const rules = ruleLines(w.state.rules, w.state.voice);
  return h("div", {},
    null,
    h("pre", { id: "out-song" }, text || " "),
    h("pre", { id: "out-command" }, cmd),
    null,
    rules.length > 0 && h("pre", { id: "out-rules" }, rules.join("\n")),
    h("div", { class: "row" },
      h("button", { class: "main", id: "copy-song", onclick: () => copy(text, "The song") }, "Copy song"),
      h("button", { id: "copy-command", onclick: () => copy(cmd, "The command line") }, "Copy command"),
      rules.length > 0 && h("button", { id: "copy-rules", onclick: () => copy(rules.join("\n"), "The rules") }, "Copy rules"),
      h("button", { id: "save-session", onclick: () => {
        const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(lab.export(), null, 1)], { type: "application/json" })), download: "diction.json" });
        a.click();
        say1("Saved: diction.json");
      } }, "Save file")));
});

// ---------------------------------------------------------------- the walk round the page
const unsung = () => (lab.shown() ? null : { where: "song-card", text: "Nothing is sung yet, so this part of the page is empty. Write a song in the box first." });
const opened = (id) => () => { if (!view.open.includes(id)) { view.open = [...view.open, id]; draw(); } };
const STEPS = [
  { title: "The song", where: "song-card",
    text: ["Write the song in the box: %bpm and the tempo, then a word a line with a note for each syllable, written NOTE:BEATS. A line that starts with % is an instruction (%rest 1 is a beat of silence); every other line is a word. When you stop typing the engine sings it and the rest of the page fills in.",
      "Singer picks the voice. Tempo is a number in a box: press on it and drag left or right. Every number in a box on this page is changed that way."],
    act: () => (songBox.value.trim() ? null : { label: "Type a short one for me", run: () => { songBox.value = songBox.getAttribute("placeholder"); lab.setText(songBox.value); } }) },
  { title: "The line, sound by sound", where: "spell", need: unsung,
    text: ["Each word, and under it every sound it is sung with. Read the tiles in a row and you have the word: n, eye, t is night.",
      "Green is a vowel, grey a consonant, gold a vowel's ending. A bar under a tile means a rule shaped that sound: hover to read which. Click a word to hear it. Click a tile to change that sound."] },
  { title: "Changing a sound", where: "word",
    need: () => unsung() ?? (document.getElementById("sound") ? null : { where: "spell", text: "No sound is chosen. Click one of the tiles under a word." }),
    text: ["The first list is what this sound is: pick another and the word is sung with it at once. A vowel has a second line: what it slides to at the very end of its note, and for how long.",
      "The last line adds a sound before or after, or takes this one out. Under that are the word's notes, which are dragged."] },
  { title: "The line in time", where: "strip", need: unsung,
    text: ["The same sounds laid out by how long each lasts. The line is the pitch as sung, the pale bars the notes you wrote, the grey how loud.",
      "Drag across it to mark the stretch that plays. Click in it to play from that spot."] },
  { title: "What is changed", where: "rules", need: unsung,
    text: ["One row for each thing that shapes how this song is sung. Untick a row to hear the song without it.",
      "Built in are the engine's own sets of rules: every song is sung by both, plain and a singer's vowels. Untick sung to hear the vowels as spoken. The … shows a set's rules.",
      "+ rule adds one of yours, and yours win over a set's. Under each row is the rule as the engine reads it: who it is for, which word, which sound and when, then what it is sung as."] },
  { title: "The singer's settings", where: "options", need: unsung, show: opened("options"),
    text: ["Folded shut until you want it. Every setting the engine takes for singing, with a line on what each does. Any you move shows up as a row in Changes."] },
  { title: "Try several values", where: "sweep", need: unsung, show: opened("sweep"),
    text: ["For finding a value by ear. Choose what to try, drag from, to and how many steps, then press Sing. They play one after the other.",
      "Untick a value to leave it out of the round. Use it makes the one playing the song's."] },
  { title: "Takes", where: "takes", need: unsung, show: opened("takes"),
    text: ["Type a name and keep what you have now. Hear plays a take. Once you have heard two things, Flip or the F key jumps between them at the same spot in the song."] },
  { title: "As text", where: "out", need: unsung, show: opened("out"),
    text: ["The song with every change written into it, and the command line that sings it anywhere. Copy either, or save everything as a file."] },
];
const guide = tour(document.getElementById("tour"), STEPS);

// ---------------------------------------------------------------- the page
const draw = () => {
  if (pulling || document.activeElement?.tagName === "SELECT") { late = true; return; }
  late = false;
  // the page and the picture stay where they were scrolled to
  const left = scroller.scrollLeft, down = scrollY;
  app.replaceChildren(...[
    h("div", { class: "top" }, h("button", { id: "tour-open", onclick: () => guide.open() }, "Show me around")),
    view.note && h("div", { class: "soft", id: "said" }, view.note),
    songPart(),
    performancePart(),
    ...(lab.shown() || lab.busy ? [rulesPart(), optionsPart(), sweepPart(), takesPart(), outPart()] : []),
  ].filter(Boolean));
  scroller.scrollLeft = left;
  scrollTo(scrollX, down);
  guide.render();
};

addEventListener("resize", () => { if (lab) draw(); });
addEventListener("keydown", (e) => {
  if (e.key === "Escape") guide.close();
  if (!lab || ["TEXTAREA", "INPUT", "SELECT"].includes(e.target?.tagName)) return;
  // space on a button presses the button
  if (e.key === " " && e.target?.tagName === "BUTTON") return;
  if (e.key === " ") { e.preventDefault(); if (playing) { turn = null; stop(); } else playNow(); draw(); }
  else if (e.key === "f" || e.key === "F") lab.flip();
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) lab.redo(); else lab.undo(); }
});

// ---------------------------------------------------------------- start
const start = async () => {
  app.replaceChildren(h("p", { class: "soft" }, "Loading"));
  // the models' folder as build.sh was given it, a path from the folder above lab/
  const models = new URL(MODELS, new URL("../", import.meta.url)).href;
  const { voices, bench } = await ask({ op: "open", models });
  snd = sounds(bench.phones);
  // the song's text is read here, as it is typed, by the engine's own reader: no model in it
  const wasm = await fetch(new URL("../lipservice.wasm", import.meta.url));
  if (!wasm.ok) throw new Error(`the engine: ${wasm.status} ${wasm.statusText}`);
  const reader = await Engine.create(new Uint8Array(await wasm.arrayBuffer()));
  useReader((text) => reader.song(text));
  const store = { get: () => localStorage.getItem(KEY), set: (j) => localStorage.setItem(KEY, j) };
  const sing = async (text, voice, options) => {
    const r = await ask({ op: "sing", text, voice, options });
    return { samples: r.samples, plan: r.plan, rules: r.rules, pitch: r.pitch, notes: r.notes };
  };
  lab = new Bench({ sing, bench, voices, store, changed: (what) => {
    if (what === "sung" || what === "selected") view.note = null;
    draw();
    // a change is heard at once; a flip goes on from the same spot
    if (!ctx) return;
    if (what === "sung" && lab.heard.kind === "bench" && !lab.error) touched();
    else if (what === "heard") playNow({ carry: !turning });
    // a sweep all sung is heard, one value after the other
    else if (what === "sweep" && lab.sweep && !lab.busy && view.hear) return turnTo(0);
    else return;
    draw();
  } });
  requestAnimationFrame(tick);
  const saved = store.get();
  if (saved) {
    try {
      await lab.load_saved(saved);
    } catch (e) {
      view.note = `Saved session not read: ${e.message}`;
    }
  }
  draw();
  return lab;
};

addEventListener("unhandledrejection", (e) => say1(`Something failed: ${e.reason?.message ?? e.reason}`));
export const ready = start().catch((e) => { fatal(`Not started: ${e.message}`); throw e; });
