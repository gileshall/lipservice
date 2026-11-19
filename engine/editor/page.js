// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The editor's page: a score's singers a tab each, the roll of the one in sight drawn, the mixer's
// tab, and the mouse, the keys and files turned into edit.js's changes. Whatever changes is heard
// at once: the mix through its audio nodes, a singer's part by that singer being sung anew from
// where the sound is. boot() is given the document and the window, so that node can run it with
// stand-ins for them (page_smoke.mjs), and the two places the site keeps what is sung with
// (where.js): `web`, its page files, and `models`. With `welcome`, a first visit (nothing kept
// from one before) opens on an example and says where to start.

import * as P from "./part.js";
import * as M from "./midi.js";
import * as S from "./score.js";
import { Editor, History, View, bars, steps, snap, hit, sounding, typed, clicks, syllables } from "./edit.js";
import { problems, clock, tickAt as tickAfter } from "./song.js";
import { MENU } from "./examples/menu.js";
import { pull } from "./pull.js";
import { mixer } from "./mixer.js";
import { Mix } from "./mix.js";
import { filesOf } from "./site.js";

// the roll's left gutter and its rows, pixels
const GUT = 56, RULER = 30, WORDS = 30;
const LANES = { vel: 64, vib: 92 }; // the velocity and vibrato rows' heights, where they are drawn: not on a phone
const KEEP = "lipservice editor: the score";
const KEPT_PART = "lipservice editor: the part"; // what the page kept when it held one singer
const SET = "lipservice editor: the page 2";
const RATE = 24000; // the engine's samples a second
const EVERY = 1024, AHEAD = 4800; // speaker.js's: samples between its words of where it is, and what it has ready before it sounds
const PRE = 2400; // samples of sound before a place sung from: a note there keeps the consonants it opens with
const HEAD = RATE; // samples of the speaker's line before the parts' beat 0: room for each singer's lead-in
const SOON = 7200; // samples ahead of the sound that a singer sung anew starts from
const BLACK = [1, 3, 6, 8, 10];
// a first visit's example, and what it is told
const FIRST = "round.score";
const HELLO = "Start here: press Sing, or the space bar, to hear this round for three singers.\nClick a singer's tab to see its notes. Drag a note to move it. Double click an empty spot to add one.\nThe editor needs a mouse and a keyboard. It does not work by touch.";
// and on a phone, where the notes are heard and watched and the words changed, not the notes
const HELLO_PHONE = "Press Sing to hear this round for three singers.\nPress and hold a note, then drag it to move it; hold its right end to change its length.\nTap the ruler at the top of the notes to choose where singing starts.\nChange the words below and press Use these words to hear your own.";
// A voice as the page names it: the name in its label, with nothing of a bracket after it. The
// name a part calls its voice by (the voice list's `name`) is the file's, and is not shown.
const called = (v) => v.label.split(" (")[0];
const SEX = { F: "woman", M: "man" };
// The quality the visitor chose (a route of the site's routes.js), kept for every page of the site,
// JSON-encoded as the site keeps it; and what the panel says of the one in use, by why it is in use.
const QUALITY = "lipservice-quality";
const WHY = {
  chosen: { hifi: "Better sound. Fast is about twice as quick.", fast: "About twice as quick. Hifi sounds better." },
  default: { hifi: "Better sound. Fast is about twice as quick.", fast: "About twice as quick. Hifi sounds better." },
  phone: { fast: "Fast on phones, so singing keeps up. Hifi sounds better." },
};
// The roll's colors, each singer's and the roll's type: the page's own custom properties
// (editor.css :root, --roll-* and --singer-1 to 8), read at boot, so a site that dresses the editor
// sets its own.
const ROLL = { bg: "bg", row: "row", black: "black", line: "line", beat: "beat", bar: "bar", ink: "ink", dim: "dim", note: "note", chosen: "chosen", bad: "bad", ok: "ok", lane: "lane", keyBlack: "key-black", keyWhite: "key-white", onNote: "on-note" };
const SINGERS = 8;
let C = null, COLORS = null, FONT = null;

export function boot({ document, window, web, models, welcome = false }) {
  // A phone: the roll is watched, moved and pinched, not drawn on; the panel holds the voice, the
  // shift, the words and the quality (editor.css, html.phone).
  const phone = window.navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad/.test(window.navigator.userAgent);
  if (phone) document.documentElement.className = "phone";
  const VEL = phone ? 0 : LANES.vel, VIB = phone ? 0 : LANES.vib;
  for (const [k, v] of [["web", web], ["models", models]]) if (typeof v !== "string" || !v.endsWith("/")) throw new Error(`boot: ${k} is a folder's address, ending in /, not ${v}`);
  const style = window.getComputedStyle(document.documentElement);
  const prop = (name) => {
    const v = style.getPropertyValue(name).trim();
    if (!v) throw new Error(`the page sets no ${name}`);
    return v;
  };
  C = Object.fromEntries(Object.entries(ROLL).map(([k, name]) => [k, prop(`--roll-${name}`)]));
  COLORS = Array.from({ length: SINGERS }, (_, i) => prop(`--singer-${i + 1}`));
  FONT = prop("--roll-font");
  const $ = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`the page has no #${id}`);
    return el;
  };
  const make = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const canvas = $("canvas"), ctx = canvas.getContext("2d"), status = $("status"), lyric = $("lyric");
  const view = new View();

  // What was done, in the order it was done: each step the editors and the desk it changed.
  const journal = { past: [], future: [], group: null };
  const record = (h) => {
    if (journal.group) {
      if (!journal.group.includes(h)) journal.group.push(h);
    } else journal.past.push([h]);
    journal.future = [];
  };
  // what f changes is one step
  const together = (f) => {
    if (journal.group) return f();
    journal.group = [];
    try {
      return f();
    } finally {
      if (journal.group.length) journal.past.push(journal.group);
      journal.group = null;
    }
  };
  const fresh = (part) => {
    const e = new Editor(part);
    e.pushed = record;
    return e;
  };
  // The desk: the score as it is edited, {title, master, chain, rows: [{ed (the singer's part and
  // what was done to it), level, pan, mute, solo}]}.
  const desk = new History({ title: "", master: 0, chain: S.chain(), rows: [{ ...S.strip(), ed: fresh(P.blank(P.singer("6147"))) }] });
  desk.pushed = record;
  let saved = desk.value; // the desk as last read or written
  let cur = 0; // the singer in sight
  let ed = desk.value.rows[0].ed; // and its editor
  let tab = "singer"; // or "mixer"
  let panel = true; // the panel beside the roll is in sight
  let renaming = null; // the singer whose tab is being typed into
  let voices = []; // the site's
  let step = P.GRID / 4; // ticks a note snaps to
  let stepName = "1/4"; // and what that is of a beat, kept when the grid changes
  let drawing = false; // a press on the empty roll draws a note
  let point = null; // the vibrato point chosen
  let drag = null;
  let band = null; // the box a drag on the empty roll selects in: [tick, key, tick, key]
  let worded = null; // the note whose syllable is being typed
  const last = { ticks: P.GRID, velocity: 80 };
  let snapped = null; // the grid the snap's choices were made for
  let tapped = { at: -Infinity, x: 0, y: 0 }; // the press before this one
  let W = 0, H = 0;
  const pool = []; // the workers that sing (singer.js), a singer's by its place
  const cores = window.navigator.hardwareConcurrency;
  const WORKERS = cores ? Math.max(1, Math.min(4, cores - 2)) : 2;
  let audio = null, speaker = null, mix = null; // the sound's context, its speaker.js loading, and the mix's nodes (mix.js)
  let jobs = 0, runs = 0; // the singers' jobs, and the singings
  // What is being sung: {n (which singing), loop ({from, to} in ticks, or null), start (tick),
  //   at (seconds to ticks), secs (ticks to seconds), time, meter   the time it is sung in
  //   tracks   ed: {slot, cur, next}: a singer's sound on the speaker's line; a take is {job, part,
  //            whole (sung from its start), from, len (samples of the line), got, done, open}.
  //            next: the part as changed since, being made, faded in by the speaker when ready
  //   jobs     job: {t, rec}, those still being made
  //   seen     ed: the part last looked at for changes
  //   began    the speaker was told to play; line: the loop in samples of the line; floor: the
  //            sample it last started from; end: the line's last sample
  //   heard    the speaker's last word of where it is; ended: the context's sample it ended at}
  let playing = null;
  // what the page is set to, kept between visits: the loop (ticks; none where to is not after from),
  // the click, the ms added to the speaker's lateness, and whether the other singers' notes show
  const set = { loop: { on: false, from: 0, to: 0 }, click: { on: false, volume: 50 }, delay: 0, others: true };
  let routes = null; // the site's qualities, once it has said
  let radios = []; // the panel's choice of them
  let chosen = null; // the quality the visitor chose, on this page or another of the site's (QUALITY)
  let made = null; // the quality the workers in the pool sing by, null where they were asked for none: the site's first
  // The quality in use, and why: the one chosen; else fast on a phone, where the site has it; else
  // the site's first. null until the site has said what it has, unless one was chosen.
  const quality = () => chosen ?? (routes ? (phone && routes.includes("fast") ? "fast" : routes[0]) : null);
  const why = () => (chosen ? "chosen" : phone && routes?.includes("fast") ? "phone" : "default");
  let cursor = 0; // the tick Sing starts from

  const color = (i) => COLORS[i % COLORS.length];
  // a singer's name: its part's title, or its voice's
  const name = (i) => {
    const part = desk.value.rows[i].ed.part, v = voices.find((x) => x.name === part.singer.voice);
    return part.title || (v ? called(v) : `Singer ${i + 1}`);
  };
  const singerName = (e) => name(desk.value.rows.findIndex((r) => r.ed === e));
  // the other singers who sing the words this one sings
  const alike = () => {
    const mine = typed(ed.part.notes);
    return ed.part.notes.length ? desk.value.rows.map((r) => r.ed).filter((e) => e !== ed && e.part.notes.length && typed(e.part.notes) === mine) : [];
  };
  // the words typed counted against the notes they go under
  let draft = null; // {ed, text}: the words typed for a singer and not yet under its notes, kept in the box
  const counted = () => {
    const n = syllables($("words").value).length, room = ed.part.notes.length;
    $("words-count").textContent = `${n} ${n === 1 ? "syllable" : "syllables"} for ${room} ${room === 1 ? "note" : "notes"}${n > room ? ": too many" : ""}`;
    $("words-count").className = n > room ? "said bad" : "said";
  };
  // the score as its file has it
  const score = () => {
    const d = desk.value;
    return { title: d.title, master: d.master, chain: d.chain, singers: d.rows.map((r) => ({ level: r.level, pan: r.pan, mute: r.mute, solo: r.solo, part: r.ed.part })) };
  };
  const changed = () => desk.value !== saved || desk.value.rows.some((r) => r.ed.changed);

  // ---------------------------------------------------------------- said

  const say = (text, bad = false) => {
    status.textContent = text;
    status.className = bad ? "bad" : "";
  };
  // what a person asked for, done; what stops it said where they will read it
  const attempt = (f, where = null) => {
    try {
      const r = f();
      if (where) { where.textContent = ""; where.className = "said"; }
      return r;
    } catch (e) {
      if (where) { where.textContent = e.message; where.className = "said bad"; } else say(e.message, true);
      return undefined;
    } finally {
      refresh();
    }
  };

  // ---------------------------------------------------------------- where things are

  const rows = () => {
    const roll = Math.max(40, H - RULER - WORDS - VEL - VIB);
    return { roll, words: RULER + roll, vel: RULER + roll + WORDS, vib: RULER + roll + WORDS + VEL };
  };
  const top = () => Math.max(2, ...ed.part.lanes.vibrato.map((q) => q.value)) * 1.05;
  const laneY = (value) => rows().vib + 6 + (1 - value / top()) * (VIB - 12);
  const laneValue = (y) => Math.round(Math.max(0, Math.min(top(), (1 - (y - rows().vib - 6) / (VIB - 12)) * top())) * 100) / 100;
  const velocityAt = (y) => Math.max(1, Math.min(127, Math.round((1 - (y - rows().vel - 4) / (VEL - 8)) * 127)));
  const region = (x, y) => {
    const r = rows();
    return x < GUT ? "keys" : y < RULER ? "ruler" : y < r.words ? "roll" : y < r.vel ? "words" : y < r.vib ? "velocity" : "vibrato";
  };
  const tickAt = (x) => Math.max(0, view.tick(x - GUT));
  const keyAt = (y) => Math.max(0, Math.min(127, view.key(y - RULER)));
  const pointAt = (x, y) => ed.part.lanes.vibrato.findIndex((q) => Math.hypot(GUT + view.x(q.at) - x, laneY(q.value) - y) <= 7);

  // ---------------------------------------------------------------- drawing

  let queued = false;
  const paintSoon = () => {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => {
      queued = false;
      paint();
    });
  };

  function size() {
    const k = window.devicePixelRatio || 1;
    [W, H] = [canvas.clientWidth, canvas.clientHeight];
    canvas.width = Math.round(W * k);
    canvas.height = Math.round(H * k);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    if (owed) fit();
    paintSoon();
  }

  function paint() {
    const part = ed.part, r = rows(), g = part.grid;
    const [from, to] = [view.tick(0), view.tick(W - GUT)];
    const X = (tick) => GUT + view.x(tick), Y = (key) => RULER + view.y(key);
    const line = (x0, y0, x1, y1, color, width = 1) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    };
    const clip = (x, y, w, h, f) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      f();
      ctx.restore();
    };
    if (phone) {
      const now = aloud() ? "Stop" : "Sing";
      if ($("sing").textContent !== now) $("sing").textContent = now;
    }
    ctx.font = FONT;
    ctx.textBaseline = "middle";
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    // the keys' rows
    clip(0, RULER, W, r.roll, () => {
      for (let k = Math.min(127, view.key(0)); k >= 0 && Y(k) < RULER + r.roll; k--) {
        const black = BLACK.includes(k % 12);
        ctx.fillStyle = black ? C.black : C.row;
        ctx.fillRect(GUT, Y(k), W - GUT, view.tall);
        if (view.tall >= 7) line(GUT, Y(k) + view.tall, W, Y(k) + view.tall, k % 12 === 0 ? C.beat : C.line);
        ctx.fillStyle = black ? C.keyBlack : C.keyWhite;
        ctx.fillRect(0, Y(k), GUT - 1, view.tall - 1);
        if (k % 12 === 0 && view.tall >= 9) {
          ctx.fillStyle = C.dim;
          ctx.fillText(P.name(k), 6, Y(k) + view.tall / 2);
        }
      }
    });

    // bars, beats and the snap's steps, through the roll and the rows under it
    clip(GUT, 0, W - GUT, H, () => {
      const lines = bars(part, Math.max(0, from), to);
      const beatWide = g * view.wide;
      if (step * view.wide >= 9) {
        for (let t = Math.ceil(Math.max(0, from) / step) * step; t <= to; t += step) line(X(t), RULER, X(t), RULER + r.roll, C.line);
      }
      // zoomed far out, a bar line every 2, 4, 8... bars, and a number where there is room for one
      const numbered = lines.filter((b) => b.bar !== null);
      const barWide = Math.min(...part.meter.map((m) => g * 4 / m.d * m.n)) * view.wide;
      const every = (px) => 2 ** Math.max(0, Math.ceil(Math.log2(px / barWide)));
      const lined = every(8), named = every(ctx.measureText(String(numbered.at(-1)?.bar ?? 1)).width + 12);
      for (const b of lines) {
        if (b.bar === null ? beatWide < 7 : (b.bar - 1) % lined !== 0) continue;
        line(X(b.tick), b.bar === null ? RULER : 0, X(b.tick), H, b.bar === null ? C.beat : C.bar);
        if (b.bar !== null && (b.bar - 1) % named === 0) {
          ctx.fillStyle = C.dim;
          ctx.fillText(String(b.bar), X(b.tick) + 4, 9);
        }
      }
      // the tempos and the meters, and the breaths marked
      ctx.fillStyle = C.ink;
      const marks = [...part.tempo.map((t) => [t.at, `${t.bpm}`]), ...part.meter.map((m) => [m.at, `${m.n}/${m.d}`])].sort((a, b) => a[0] - b[0]);
      let lastX = -Infinity, lastAt = -1;
      for (const [at, label] of marks) {
        const x = at === lastAt ? lastX : Math.max(X(at) + 4, lastX + 6);
        ctx.fillText(label, x, 21);
        [lastX, lastAt] = [x + ctx.measureText(label).width + 6, at];
      }
      for (const m of part.marks) {
        const x = X(m.at);
        ctx.strokeStyle = ctx.fillStyle = m.breath ? C.ok : C.bad;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - 5, RULER - 9);
        ctx.lineTo(x, RULER - 1);
        ctx.lineTo(x + 5, RULER - 9);
        if (m.breath) ctx.fill();
        else {
          ctx.closePath();
          ctx.stroke();
          line(x - 6, RULER - 1, x + 6, RULER - 10, C.bad, 1.5);
        }
      }
    });
    // the loop: a band along the ruler's top between its two ends, and a line down from each
    if (set.loop.to > set.loop.from) {
      clip(GUT, 0, W - GUT, H, () => {
        const [x0, x1] = [X(set.loop.from), X(set.loop.to)], color = set.loop.on ? C.ok : C.dim;
        ctx.globalAlpha = set.loop.on ? 0.16 : 0.08;
        ctx.fillStyle = color;
        ctx.fillRect(x0, 0, x1 - x0, RULER);
        ctx.globalAlpha = 1;
        ctx.fillRect(x0, 0, x1 - x0, 3);
        for (const [x, d] of [[x0, 1], [x1, -1]]) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x + 8 * d, 0);
          ctx.lineTo(x, 10);
          ctx.fill();
          ctx.globalAlpha = set.loop.on ? 0.6 : 0.3;
          line(x, 0, x, H, color);
          ctx.globalAlpha = 1;
        }
      });
    }
    line(0, RULER, W, RULER, C.bar);

    // the notes: the other singers' behind, then this one's
    clip(GUT, RULER, W - GUT, r.roll, () => {
      if (set.others) {
        desk.value.rows.forEach((row, i) => {
          if (i === cur) return;
          ctx.fillStyle = ctx.strokeStyle = color(i);
          ctx.lineWidth = 1;
          for (const n of row.ed.part.notes) {
            if (n.at > to || n.at + n.ticks < from) continue;
            const x = X(n.at), w = Math.max(2, n.ticks * view.wide - 1), y = Y(P.key(n.pitch)), h = Math.max(2, view.tall - 1);
            ctx.globalAlpha = 0.16;
            ctx.fillRect(x, y, w, h);
            ctx.globalAlpha = 0.5;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
          }
        });
        ctx.globalAlpha = 1;
      }
      for (const n of part.notes) {
        if (n.at > to || n.at + n.ticks < from) continue;
        const x = X(n.at), w = Math.max(2, n.ticks * view.wide - 1), y = Y(P.key(n.pitch)), h = Math.max(2, view.tall - 1);
        const chosen = ed.selected.has(n);
        ctx.globalAlpha = 0.45 + 0.55 * n.velocity / 127;
        ctx.fillStyle = chosen ? C.chosen : color(cur);
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;
        if (n.lyric === null) {
          ctx.strokeStyle = C.bad;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        }
        if (n.cents !== 0) line(x, y, x + Math.min(w, 8), y, C.ink, 2);
        if (view.tall >= 11 && n.lyric !== null && n.lyric !== "_" && w >= 14) {
          ctx.fillStyle = C.onNote;
          clip(x, y, w, h, () => ctx.fillText(P.syllable(n.lyric).text, x + 3, y + h / 2));
        }
      }
      if (band) {
        const [t0, k0, t1, k1] = band;
        ctx.strokeStyle = C.chosen;
        ctx.lineWidth = 1;
        ctx.strokeRect(X(Math.min(t0, t1)), Y(Math.max(k0, k1)), Math.abs(t1 - t0) * view.wide, (Math.abs(k1 - k0) + 1) * view.tall);
      }
    });

    // the words, the velocities and the vibrato under the roll
    for (const [y, name] of [[r.words, "words"], ...(phone ? [] : [[r.vel, "velocity"], [r.vib, "vibrato"]])]) {
      line(0, y, W, y, C.bar);
      ctx.fillStyle = C.dim;
      ctx.fillText(name, 6, y + 12);
    }
    clip(GUT, r.words, W - GUT, WORDS + VEL + VIB, () => {
      for (const n of part.notes) {
        if (n.at > to || n.at + n.ticks < from) continue;
        const x = X(n.at), w = Math.max(2, n.ticks * view.wide - 2), chosen = ed.selected.has(n), mid = r.words + WORDS / 2;
        if (n.lyric === null) {
          ctx.fillStyle = C.bad;
          ctx.fillRect(x + 2, mid - 1, Math.min(6, w), 2);
        } else if (n.lyric === "_") {
          line(x, mid, x + w, mid, chosen ? C.chosen : C.dim);
        } else {
          const s = P.syllable(n.lyric);
          ctx.fillStyle = chosen ? C.chosen : C.ink;
          ctx.fillText(s.text + (s.on ? "-" : ""), x + 2, mid);
          if (s.end) line(x + w, r.words + 5, x + w, r.words + WORDS - 5, C.dim);
        }
        const v = (n.velocity / 127) * (VEL - 8), up = (n.release / 127) * (VEL - 8);
        ctx.fillStyle = chosen ? C.chosen : color(cur);
        ctx.fillRect(x, r.vel + VEL - 4 - v, 3, v);
        ctx.fillRect(x - 2, r.vel + VEL - 4 - v, 7, 2);
        line(x + w, r.vel + VEL - 4, x + w, r.vel + VEL - 4 - up, C.dim);
      }
      // the vibrato: the voice's own as a dashed line, then the lane
      ctx.setLineDash([3, 4]);
      line(GUT, laneY(1), W, laneY(1), C.beat);
      ctx.setLineDash([]);
      const pts = part.lanes.vibrato;
      ctx.strokeStyle = C.lane;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(GUT, laneY(P.at(pts, Math.max(0, from), P.REST.vibrato)));
      let standing = P.REST.vibrato;
      for (const q of pts) {
        if (!q.line) ctx.lineTo(X(q.at), laneY(standing));
        ctx.lineTo(X(q.at), laneY(q.value));
        standing = q.value;
      }
      ctx.lineTo(W, laneY(standing));
      ctx.stroke();
      pts.forEach((q, i) => {
        ctx.fillStyle = i === point ? C.chosen : C.lane;
        ctx.beginPath();
        if (q.line) {
          ctx.moveTo(X(q.at), laneY(q.value) - 5);
          ctx.lineTo(X(q.at) + 5, laneY(q.value));
          ctx.lineTo(X(q.at), laneY(q.value) + 5);
          ctx.lineTo(X(q.at) - 5, laneY(q.value));
        } else {
          ctx.arc(X(q.at), laneY(q.value), 4, 0, 2 * Math.PI);
        }
        ctx.fill();
      });
    });
    // the place Sing starts from, and the place being heard
    if (X(cursor) >= GUT) {
      const x = X(cursor);
      ctx.fillStyle = C.chosen;
      ctx.beginPath();
      ctx.moveTo(x - 5, RULER - 8);
      ctx.lineTo(x + 5, RULER - 8);
      ctx.lineTo(x, RULER);
      ctx.fill();
      ctx.globalAlpha = 0.45;
      line(x, RULER, x, H, C.chosen);
      ctx.globalAlpha = 1;
    }
    const now = heardAt();
    if (now !== null && X(now) >= GUT) line(X(now), 0, X(now), H, C.ink);
    if (!phone) {
      ctx.fillStyle = C.dim;
      ctx.fillText(top().toFixed(1), GUT - 26, r.vib + 8);
      ctx.fillText("0", GUT - 12, r.vib + VIB - 8);
    }
    line(GUT, RULER, GUT, H, C.bar);
  }

  // ---------------------------------------------------------------- the panel, the tabs, the mixer

  const SINGER = ["seed", "shift", "join", "glide", "dynamics", "breathiness", "sway", "jitter", "detune", "spread", "breath"];
  // how each of a singer's numbers is pulled: its range under the mouse (a typed number may pass it, as far as a part's text can hold)
  const RANGE = {
    seed: { min: 0, max: Infinity, hi: 4294967295, step: 1, whole: true, per: 0.2 },
    shift: { min: -24, max: 24, lo: -Infinity, hi: Infinity, step: 1, fine: 0.01, origin: 0, unit: "st" },
    join: { min: 0, max: 2, hi: Infinity, step: 0.05, fine: 0.01 },
    glide: { min: 1, max: 40, hi: Infinity, step: 1, whole: true },
    dynamics: { min: 0, max: 3, hi: Infinity, step: 0.05, fine: 0.01 },
    breathiness: { min: 0, max: 2, hi: Infinity, step: 0.05, fine: 0.01 },
    sway: { min: 0, max: 3, hi: Infinity, step: 0.05, fine: 0.01 },
    jitter: { min: 0, max: 12, hi: Infinity, step: 1, whole: true },
    detune: { min: 0, max: 50, hi: Infinity, step: 0.5, fine: 0.1, unit: "c" },
    spread: { min: 0, max: 0.1, hi: Infinity, step: 0.005, fine: 0.001, unit: "s" },
    breath: { min: 0, max: 1, step: 0.05, fine: 0.01 },
  };
  const focused = (el) => document.activeElement === el;
  const first = () => ed.part.notes.find((n) => ed.selected.has(n)) ?? null;
  const tempoAt = (part, tick) => part.tempo.findLast((t) => t.at <= tick);

  // the numbers pulled with the mouse (pull.js), by the id of the place each sits in
  const fields = {};
  const put = (id, o) => {
    const f = pull(document, o);
    $(id).replaceChildren(f.el);
    fields[id] = f;
    return f;
  };
  const told = (where) => (message) => {
    where.textContent = message ?? "";
    where.className = message ? "said bad" : "said";
  };
  {
    // a note's: pulled, all the notes chosen go with the first
    let held = null, spelled = null;
    const note = (o) => ({
      begin: () => {
        ed.begin();
        const n = first();
        held = n && { at: n.at, ticks: n.ticks, key: P.key(n.pitch) };
      },
      end: () => {
        ed.end();
        refresh();
      },
      said: told($("n-said")),
      ...o,
      change: (v) => attempt(() => {
        if (!held) return;
        ed.again();
        o.change(v);
      }, $("n-said")),
    });
    const beats = { show: (v) => P.beat(v, ed.part.grid), text: (v) => P.beat(v, ed.part.grid), read: (s) => P.ticks(s.trim(), ed.part.grid) };
    put("n-at", note({ min: 0, max: Infinity, fine: 1, label: "start", ...beats, change: (v) => ed.move(v - held.at, 0) }));
    put("n-beats", note({ min: 1, max: Infinity, fine: 1, label: "beats", ...beats, read: (s) => Math.max(1, beats.read(s)), change: (v) => ed.stretch(v - held.ticks, 1) }));
    put("n-pitch", note({
      min: 0, max: 127, step: 1, whole: true, per: 0.12, label: "pitch",
      show: () => (first() ? P.pitch(first()) : ""), text: () => (first() ? P.pitch(first()) : ""),
      read: (s) => {
        spelled = P.pitched(s.trim());
        return P.key(spelled[0]) + spelled[1] / 1000;
      },
      change: (v) => {
        if (spelled) ed.set([first()], { pitch: spelled[0], cents: spelled[1] });
        else ed.move(0, Math.round(v) - held.key);
        spelled = null;
      },
    }));
    put("n-velocity", note({ min: 1, max: 127, step: 1, whole: true, def: 80, label: "velocity", change: (v) => { ed.set([...ed.selected], { velocity: v }); last.velocity = v; } }));
    put("n-release", note({ min: 0, max: 127, step: 1, whole: true, def: 64, label: "release", change: (v) => ed.set([...ed.selected], { release: v }) }));
    for (const k of SINGER) {
      put(`s-${k}`, {
        ...RANGE[k], def: P.singer("x")[k], label: k, said: told($("s-said")),
        begin: () => ed.begin(),
        change: (v) => attempt(() => { ed.again(); ed.singer(k, v); }, $("s-said")),
        end: () => { ed.end(); refresh(); },
      });
    }
    // the tempo in force where Sing starts, every singer's alike
    put("tempo", {
      min: 30, max: 240, lo: 4, hi: 60000000, step: 1, fine: 0.1, def: 120, label: "tempo", title: "Tempo where singing starts, for every singer. Drag to change; click to type",
      show: (v) => `${v} bpm`,
      begin: () => desk.value.rows.forEach((r) => r.ed.begin()),
      change: (v) => attempt(() => together(() => {
        const at = tempoAt(ed.part, cursor).at;
        for (const r of desk.value.rows) {
          r.ed.again();
          r.ed.tempo(at, v);
        }
      })),
      end: () => { desk.value.rows.forEach((r) => r.ed.end()); refresh(); },
    });
    put("click-volume", { min: 0, max: 100, step: 1, whole: true, def: 50, unit: "%", label: "the click's volume", title: "Metronome volume. Drag to change", change: (v) => { set.click.volume = v; shown(); } });
    put("delay", { min: -300, max: 300, lo: -10000, hi: 10000, step: 1, whole: true, def: 0, origin: 0, unit: "ms", label: "ms added to the speaker's lateness", said: told($("delay-said")), change: (v) => { set.delay = v; shown(); } });
  }

  // a singer's tab in sight
  function show(i) {
    if (worded) commitWord(false);
    cur = i;
    ed = desk.value.rows[i].ed;
    tab = "singer";
    point = null;
    refresh();
  }

  function addSinger(copy) {
    const rows = desk.value.rows, base = ed.part;
    if (rows.length >= S.MOST) throw new Error(`a score holds ${S.MOST} singers`);
    const used = new Set(rows.map((r) => r.ed.part.singer.voice));
    const voice = voices.find((v) => !used.has(v.name))?.name ?? base.singer.voice;
    const part = copy ? { ...base, title: base.title ? `${base.title} 2` : "" } : { ...P.blank({ ...base.singer, voice, seed: base.singer.seed + rows.length }, base.grid), tempo: base.tempo, meter: base.meter };
    desk.commit({ ...desk.value, rows: [...rows, { ...S.strip(), ed: fresh(part) }] });
    show(rows.length);
    say(copy ? `${name(rows.length)}: a copy, to change` : `${name(rows.length)}: a singer with no notes yet, in the time the others keep`);
  }

  function removeSinger(i) {
    const rows = desk.value.rows;
    if (rows.length === 1) throw new Error("a score has one singer at least");
    const gone = name(i);
    desk.commit({ ...desk.value, rows: rows.filter((_, j) => j !== i) });
    cur = Math.min(i < cur ? cur - 1 : cur, rows.length - 2);
    ed = desk.value.rows[cur].ed;
    point = null;
    say(`${gone} is out of the score: Undo brings it back`);
  }

  let tabsBuilt = "";
  // the mixer's tab, first in the row: its two bars are the master's level as it sounds
  const mixerTab = make("div", "tab mixer"), mixerBars = [make("b"), make("b")];
  {
    const lv = make("span", "lv");
    lv.append(...mixerBars.map((b) => {
      const slot = make("i");
      slot.append(b);
      return slot;
    }));
    mixerTab.append(lv, make("span", "tab-name", "Mixer"));
    mixerTab.setAttribute("role", "tab");
    mixerTab.title = "Mixer: each singer's level and pan, and the master effects (M)";
    mixerTab.addEventListener("click", () => showMixer());
  }
  function tabs() {
    const rows = desk.value.rows;
    const sig = JSON.stringify([rows.map((r, i) => [name(i), r.mute, r.solo]), cur, tab, renaming]);
    if (sig === tabsBuilt) return;
    tabsBuilt = sig;
    let typing = null;
    const els = rows.map((r, i) => {
      const el = make("div", "tab"), dot = make("span", "dot");
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", String(tab === "singer" && i === cur));
      el.title = `${name(i)}${i < 9 ? ` (${i + 1})` : ""}: double click to rename`;
      dot.style.background = color(i);
      el.append(dot);
      if (renaming === i) {
        typing = make("input");
        typing.value = r.ed.part.title;
        typing.placeholder = name(i);
        const done = (keep) => {
          if (renaming !== i) return;
          renaming = null;
          if (keep && typing.value.trim() !== r.ed.part.title) attempt(() => r.ed.title(typing.value));
          else refresh();
          canvas.focus();
        };
        typing.addEventListener("keydown", (e) => {
          e.stopPropagation?.();
          if (e.key === "Enter") done(true);
          else if (e.key === "Escape") done(false);
        });
        typing.addEventListener("blur", () => done(true));
        typing.addEventListener("click", (e) => e.stopPropagation?.());
        el.append(typing);
      } else {
        el.append(make("span", "tab-name", name(i)));
        if (r.mute) el.append(make("span", "flag", "M"));
        if (r.solo) el.append(make("span", "flag solo", "S"));
        el.addEventListener("click", () => {
          show(i);
          canvas.focus();
        });
        el.addEventListener("dblclick", () => {
          show(i);
          renaming = i;
          refresh();
        });
      }
      if (rows.length > 1 && renaming !== i) {
        const x = make("button", "x", "✕");
        x.title = `Remove ${name(i)} from the score`;
        x.addEventListener("click", (e) => {
          e.stopPropagation?.();
          attempt(() => removeSinger(i));
        });
        el.append(x);
      }
      return el;
    });
    const plus = make("div", "tab plain", "+");
    plus.title = "Add a singer. Hold shift to copy this one";
    plus.addEventListener("click", (e) => attempt(() => addSinger(Boolean(e.shiftKey))));
    mixerTab.setAttribute("aria-selected", String(tab === "mixer"));
    $("tabs").replaceChildren(mixerTab, ...els, plus);
    if (typing) {
      typing.focus();
      typing.select();
    }
  }

  const board = mixer(document, $("mixer"), {
    begin: () => desk.begin(),
    end: () => { desk.end(); refresh(); },
    change: (f) => attempt(() => { desk.again(); desk.commit(f(desk.value)); }),
    show: (i) => { show(i); canvas.focus(); },
    name, color,
  });
  let metering = false;
  const BAR_FLOOR = -48; // dB the mixer's tab shows from
  // the mixer's meters, moved while its tab is in sight and there is sound or its trace
  function meter() {
    const moving = board.meters(mix && audio.state === "running" ? mix.peaks() : null);
    board.fields.master.meters.forEach((m, i) => {
      mixerBars[i].style.height = `${Math.max(0, Math.min(1, (m.db - BAR_FLOOR) / -BAR_FLOOR)) * 100}%`;
      mixerBars[i].className = m.over > 0 ? "over" : "";
    });
    metering = Boolean(playing) || moving;
    if (metering) window.requestAnimationFrame(meter);
  }
  function showMixer() {
    if (worded) commitWord(false);
    tab = "mixer";
    refresh();
    if (!metering) meter();
  }

  let voiced = "";
  function sync() {
    const part = ed.part, n = first(), d = desk.value;
    if (!focused($("title"))) $("title").value = d.title;
    tabs();
    $("mixer").hidden = tab !== "mixer";
    $("roll").hidden = tab === "mixer";
    $("side").hidden = tab === "mixer" || !panel;
    board.render(d);
    for (const k of ["at", "beats", "pitch", "velocity", "release"]) fields[`n-${k}`].able(Boolean(n));
    $("n-lyric").disabled = !n;
    for (const k of ["n-at", "n-beats"]) Object.assign(fields[k].o, { step, per: step / 8 });
    if (n) {
      fields["n-at"].set(n.at);
      fields["n-beats"].set(n.ticks);
      fields["n-pitch"].set(P.key(n.pitch) + n.cents / 1000);
      fields["n-velocity"].set(n.velocity);
      fields["n-release"].set(n.release);
      if (!focused($("n-lyric"))) $("n-lyric").value = n.lyric ?? "";
    } else $("n-lyric").value = "";
    for (const k of SINGER) fields[`s-${k}`].set(part.singer[k]);
    // the voices: the site's, and this singer's where the site has none of that name
    const known = voices.some((v) => v.name === part.singer.voice), list = `${voices.length} ${known ? "" : part.singer.voice}`;
    if (list !== voiced) {
      voiced = list;
      const option = (value, text) => {
        const o = make("option", null, text);
        o.value = value;
        return o;
      };
      $("s-voice").replaceChildren(...voices.map((v) => option(v.name, `${called(v)}, ${SEX[v.sex]}`)), ...(known ? [] : [option(part.singer.voice, voices.length ? "a voice not on this site" : "the voice the part names")]));
    }
    if (!focused($("s-voice"))) $("s-voice").value = part.singer.voice;
    $("s-diction").checked = part.singer.diction;
    if (!focused($("s-motion"))) $("s-motion").value = part.singer.motion ?? "-";
    fields.tempo.set(tempoAt(part, cursor).bpm);
    if (!focused($("text"))) $("text").value = P.write(part);
    if (!focused($("words"))) $("words").value = draft?.ed === ed ? draft.text : typed(part.notes);
    $("words-all-row").hidden = !alike().length;
    counted();
    $("undo").disabled = !journal.past.length;
    $("redo").disabled = !journal.future.length;
    $("draw").setAttribute("aria-pressed", String(drawing));
    if (snapped !== part.grid) {
      const options = steps(part.grid);
      const same = options.find((o) => o.name === stepName) ?? options[0];
      [step, stepName] = [same.ticks, same.name];
      $("snap").replaceChildren(...options.map((o) => {
        const el = document.createElement("option");
        el.value = String(o.ticks);
        el.textContent = o.name;
        return el;
      }));
      snapped = part.grid;
    }
    if (!focused($("snap"))) $("snap").value = String(step);
    document.title = `${changed() ? "* " : ""}${d.title || "a score"}`;
  }

  let kept = [];
  function keep() {
    const now = [desk.value, ...desk.value.rows.map((r) => r.ed.part)];
    if (now.length === kept.length && now.every((x, i) => x === kept[i])) return;
    kept = now;
    try {
      window.localStorage.setItem(KEEP, S.write(score()));
    } catch (e) {
      say(`the score is not kept for the next visit: ${e.message}`, true);
    }
  }

  function refresh() {
    if (point !== null && point >= ed.part.lanes.vibrato.length) point = null;
    sync();
    keep();
    if (mix) mix.set(score(), level());
    if (playing) {
      window.clearTimeout(playing.timer);
      playing.timer = window.setTimeout(live, 140);
    }
    paintSoon();
  }

  // ---------------------------------------------------------------- files

  function download(file, data, type) {
    const url = window.URL.createObjectURL(new window.Blob([data], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = file;
    a.click();
    window.URL.revokeObjectURL(url);
  }
  const stem = (title, or) => title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() || or;

  // The score as a score; or the singer in sight as a part or a MIDI file.
  function save(kind) {
    attempt(() => {
      const part = ed.part;
      if (kind === "score") {
        const s = score(), file = `${stem(s.title, "score")}.score`;
        download(file, S.write(s), "text/plain");
        for (const r of desk.value.rows) r.ed.saved = r.ed.part;
        saved = desk.value;
        return say(`saved ${file}: ${s.singers.length} ${s.singers.length === 1 ? "singer" : "singers"}, ${s.singers.reduce((n, x) => n + x.part.notes.length, 0)} notes`);
      }
      const file = `${stem(part.title || desk.value.title, "part")}.${kind === "midi" ? "mid" : "part"}`;
      if (kind === "midi") download(file, M.write(part), "audio/midi");
      else download(file, P.write(part), "text/plain");
      ed.saved = part;
      say(`saved ${file}: ${desk.value.rows.length > 1 ? `${name(cur)}, ` : ""}${part.notes.length} notes`);
    });
  }

  // the roll wide and tall enough for every singer's notes; while the roll has no width (the
  // mixer is in sight, or the window has no size) it is owed, and size() does it
  let owed = false;
  // every note in view; on a phone, no narrower than a note of the middling length is wide enough
  // for its syllable to be read (the roll follows the singing along), and the keys as tall as the
  // singer in sight's notes allow, centred on them
  const READ = 26; // pixels
  function fit() {
    owed = W <= GUT;
    if (owed) return;
    const notes = desk.value.rows.flatMap((r) => r.ed.part.notes);
    view.fit({ ...ed.part, notes }, W - GUT, rows().roll);
    if (phone && notes.length) {
      const ticks = notes.map((n) => n.ticks).sort((a, b) => a - b)[Math.floor(notes.length / 2)];
      if (view.wide * ticks < READ) view.zoom(READ / (view.wide * ticks), 0);
      const mine = ed.part.notes.length ? ed.part.notes : notes, keys = mine.map((n) => P.key(n.pitch)), lo = Math.min(...keys), hi = Math.max(...keys), roll = rows().roll;
      view.tall = Math.max(12, Math.min(20, roll / (hi - lo + 3)));
      view.top = Math.min(127, (hi + lo) / 2 + roll / view.tall / 2);
    }
  }

  // A score in the desk's place, as a file opened gives it. Undo brings the last one back.
  function open(s) {
    S.check(s);
    stop();
    const rows = s.singers.map((x) => ({ level: x.level, pan: x.pan, mute: x.mute, solo: x.solo, ed: fresh(x.part) }));
    desk.commit({ title: s.title, master: s.master, chain: s.chain, rows });
    saved = desk.value;
    [cur, ed, tab, point, cursor, renaming] = [0, rows[0].ed, "singer", null, 0, null];
    unloop();
    fit();
  }

  // A file's bytes as the score: a MIDI file (a track of it, or each a singer), a score's text,
  // or a part's.
  function take(bytes, file, pick = null) {
    attempt(() => {
      try {
        if (M.is(bytes)) {
          const from = M.survey(bytes), like = ed.part.singer;
          if (!pick && from.length > 1) return choose(bytes, file, from);
          if (pick === "all") {
            const singers = from.slice(0, S.MOST).map((x, i) => {
              const r = M.read(bytes, { singer: { ...like, voice: voices.length ? voices[i % voices.length].name : like.voice, seed: like.seed + i }, track: x.track, channel: x.channel });
              return { ...S.strip(), part: r.part.title && from.length === 1 ? r.part : { ...r.part, title: x.name || `track ${x.track}` } };
            });
            open({ title: file.replace(/\.[^.]+$/, ""), master: 0, chain: S.chain(), singers });
            say(`${file}: ${singers.length} singers, a track each${from.length > S.MOST ? `; the file's other ${from.length - S.MOST} are left out, a score holding ${S.MOST}` : ""}`);
          } else {
            const r = M.read(bytes, { singer: like, ...(pick ?? {}) });
            open(S.of(r.part));
            say(`${file}: ${r.said.join("\n")}`);
          }
        } else {
          let text;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new Error("neither a MIDI file nor text");
          }
          if (S.is(text)) {
            const s = S.read(text);
            open(s);
            say(`${file}: a score, ${s.singers.length} ${s.singers.length === 1 ? "singer" : "singers"}, ${s.singers.reduce((n, x) => n + x.part.notes.length, 0)} notes`);
          } else {
            const part = P.read(text);
            open(S.of(part));
            say(`${file}: a part, ${part.notes.length} notes`);
          }
        }
      } catch (e) {
        throw new Error(`${file}: ${e.message}`);
      }
    });
  }

  function choose(bytes, file, from) {
    const button = (text, pick) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.addEventListener("click", () => {
        $("which").close();
        take(bytes, file, pick);
      });
      return b;
    };
    $("which-list").replaceChildren(
      button(`all ${Math.min(from.length, S.MOST)}, a singer each`, "all"),
      ...from.map((s) => button(`track ${s.track}${s.name ? ` "${s.name}"` : ""}, channel ${s.channel}: ${s.notes} notes, ${s.lyrics} lyrics`, { track: s.track, channel: s.channel })),
    );
    $("which").showModal();
  }

  // ---------------------------------------------------------------- singing

  // The speaker's line: every singer's sound laid along one count of samples, the parts' beat 0
  // at its sample HEAD.
  const lineOf = (tick) => HEAD + Math.round(playing.secs(tick) * RATE);
  const tickOf = (sample) => playing.at(Math.max(0, (sample - HEAD) / RATE));
  // whether two parts are sung alike: all but their titles and meters
  const sameSung = (a, b) => a.notes === b.notes && a.singer === b.singer && a.lanes === b.lanes && a.marks === b.marks && a.tempo === b.tempo && a.grid === b.grid;
  const timeOf = (part) => JSON.stringify([part.grid, part.tempo]);
  // whether the singers keep one clock for their consonants: where more than one has notes
  const oneClock = () => desk.value.rows.filter((r) => r.ed.part.notes.length).length > 1;
  const tracks = () => [...playing.tracks.values()];

  // the sample of the line the speaker is at now
  function lineNow() {
    const h = playing.heard;
    return h ? h.pos + (h.running ? Math.max(0, Math.min(audio.currentTime * RATE - h.frame, 2 * EVERY)) : 0) : playing.floor;
  }

  // The tick being heard, or null when nothing is: the sample the speaker says it is at, carried
  // on by the audio clock, less the time the sound takes to leave the machine. Round a loop, what
  // is heard at a round's start is still the end of the round before.
  function heardAt() {
    if (!playing || !playing.heard) return null;
    const late = latency() * RATE, l = playing.line;
    if (playing.ended !== null) return tickOf(Math.min(playing.end, playing.end - late + audio.currentTime * RATE - playing.ended));
    let p = lineNow() - late;
    if (l && playing.heard.rounds > 0 && p < l.from) p += l.to - l.from;
    return tickOf(Math.max(p, l && playing.heard.rounds > 0 ? l.from : playing.floor));
  }

  // Seconds from a sample played to its being heard: what the browser says of its output (0 where
  // it says nothing), what the master's chain holds it back by, and what the page is set to add.
  const reported = () => (typeof audio.outputLatency === "number" && Number.isFinite(audio.outputLatency) ? audio.outputLatency : null);
  const latency = () => (reported() ?? 0) + (mix ? mix.late : 0) + set.delay / 1000;

  // the place in sight, a quarter of the way along where it was not
  function reveal(tick) {
    const x = view.x(tick);
    if (x < 0 || x > W - GUT - 40) view.left = Math.max(0, tick - (W - GUT) / 4 / view.wide);
  }

  // the roll drawn as the singing `n` goes; it stops with that singing
  function follow(n) {
    if (!playing || playing.n !== n) return;
    // all of it played, and the last of it out of the machine
    if (playing.ended !== null && audio.currentTime * RATE - playing.ended >= latency() * RATE) {
      playing = null;
      return paintSoon();
    }
    const now = heardAt();
    if (now !== null && tab === "singer") reveal(now);
    paint();
    window.requestAnimationFrame(() => follow(n));
  }

  // The speaker (speaker.js, an AudioWorklet) and the mix's nodes after it (mix.js). Made at the
  // first singing, as a browser starts sound only from a press.
  function speak() {
    if (!audio) {
      audio = new window.AudioContext({ sampleRate: RATE });
      if (!audio.audioWorklet) {
        audio = null;
        throw new Error("a browser gives a page its speaker only at an https address or at 127.0.0.1 or localhost");
      }
      audio.onstatechange = () => {
        if (playing && audio.state !== "running") say(`the browser has stopped the sound (${audio.state})`, true);
      };
    }
    audio.resume().catch((e) => say(`the browser would not start the sound: ${e.message}`, true));
    speaker ??= audio.audioWorklet.addModule(new URL("./speaker.js", import.meta.url)).then(() => {
      mix = new Mix(window, audio);
      mix.speaker.onprocessorerror = () => {
        halt();
        say("the speaker failed: the browser's console has why", true);
      };
      mix.speaker.port.onmessage = played;
      mix.set(score(), level());
    });
  }
  // a word to the speaker, in the order given
  const tell = (m, moved = []) => speaker.then(() => mix.speaker.port.postMessage(m, moved)).catch((e) => {
    halt();
    speaker = null;
    say(`the speaker (speaker.js) did not start: ${e.message}`, true);
  });

  // the click's gain: its volume, or nothing while it is off
  const level = () => (set.click.on ? set.click.volume / 100 : 0);

  // the worker that sings the singer in place `slot`
  function worker(slot) {
    const k = slot % WORKERS;
    if (!pool[k]) {
      if (!pool.some(Boolean)) made = quality();
      const url = new URL("./singer.js", import.meta.url);
      url.searchParams.set("web", web);
      url.searchParams.set("models", models);
      if (made !== null) url.searchParams.set("route", made);
      pool[k] = new window.Worker(url, { type: "module" });
      pool[k].onmessage = heard;
      pool[k].onerror = (e) => {
        stop();
        say(`the singer: ${e.message}`, true);
      };
    }
    return pool[k];
  }
  const cancel = (slot, rec) => {
    if (!playing.jobs.delete(rec.job)) return;
    worker(slot).postMessage({ type: "stop", ids: [rec.job] });
  };

  // The singer in row `i` asked for its sound. `live`: while the others sound, from a little
  // ahead of where they are, to be faded in over what it sang before.
  function ask(i, live) {
    const r = desk.value.rows[i], part = r.ed.part, l = playing.loop;
    const stretch = l ? { from: l.from, to: l.to, early: PRE } : live ? { from: Math.ceil(tickOf(lineNow() + SOON)), early: 0 } : playing.start > 0 ? { from: playing.start, early: PRE } : {};
    const rec = { job: ++jobs, part, whole: stretch.from === undefined, from: 0, len: 0, got: 0, done: false, open: false };
    let t = playing.tracks.get(r.ed);
    if (!t) playing.tracks.set(r.ed, (t = { slot: i, cur: null, next: null }));
    if (t.next) cancel(i, t.next);
    if (t.cur) cancel(i, t.cur);
    if (live && t.cur) t.next = rec;
    else [t.cur, t.next] = [rec, null];
    playing.jobs.set(rec.job, { t, rec });
    worker(i).postMessage({ type: "sing", id: rec.job, part, step: 20, together: playing.together, ...stretch });
  }

  const lineEnd = () => Math.max(...tracks().map((t) => {
    const r = t.next && t.next.open ? t.next : t.cur;
    return r.from + r.len;
  }));
  // the clicks, where the score's beats fall on the line
  function beats() {
    const part = desk.value.rows[0].ed.part;
    tell({ type: "beats", list: clicks(part, playing.loop ? playing.loop.to : Math.ceil(tickOf(playing.end))).map((b) => ({ at: lineOf(b.tick), accent: b.accent })) });
  }

  // every singer has said where its sound falls: the speaker is told to play
  function begin() {
    const l = playing.loop, first = tracks().map((t) => t.cur), grid = desk.value.rows[0].ed.part.grid;
    let pos, line = null;
    if (l) {
      line = { from: lineOf(l.from) - PRE, to: lineOf(l.to) - PRE };
      if (line.to - line.from < RATE / 4) {
        stop();
        return say("the loop is under a quarter of a second: too short to go round", true);
      }
      pos = playing.start === l.from ? line.from : lineOf(playing.start) - PRE;
    } else pos = playing.start > 0 ? lineOf(playing.start) - PRE : Math.min(...first.map((r) => r.from));
    Object.assign(playing, { began: true, line, floor: pos, end: lineEnd() });
    beats();
    tell({ type: "play", n: playing.n, pos, loop: line, end: l ? Infinity : playing.end, wait: tracks().map((t) => t.slot) });
    const browser = reported(), waits = Math.round(latency() * 1000);
    const speakerSaid = `the line waits ${waits} ms for the speaker (${browser === null ? "this browser does not say how late its speaker is" : `the browser says ${Math.round(browser * 1000)} ms`}${mix && mix.late ? `, the chain holds ${Math.round(mix.late * 1000)} ms` : ""}${set.delay ? `, ${set.delay} ms added` : ""})`;
    const who = first.length === 1 ? "singing" : `${first.length} singers singing`;
    const from = (l ? playing.start !== l.from : playing.start > 0) ? ` from beat ${P.beat(playing.start, grid)}` : "";
    const long = l ? `${((line.to - line.from) / RATE).toFixed(1)} s` : `${((playing.end - pos) / RATE).toFixed(1)} s`;
    playing.intro = `${l ? `${who} round the loop${from}` : `${who}${from}`}: ${long}; ${speakerSaid}`;
    say(playing.intro);
    const run = playing.n;
    window.requestAnimationFrame(() => follow(run));
    if (!metering) meter();
  }

  // what the speaker says: where it is, that a singer's new sound is in, that the line is over
  function played({ data: m }) {
    if (m.type === "error") {
      stop();
      return say(`the speaker: ${m.message}`, true);
    }
    if (!playing || !playing.began || m.n !== playing.n) return;
    if (m.type === "at") {
      if (!m.on) return;
      if (m.stalls > playing.heard?.stalls) say(`${status.textContent.split("\n")[0]}\nthe singers fell behind the speaker: it waited for them`);
      playing.heard = m;
    } else if (m.type === "swapped") {
      const t = tracks().find((x) => x.slot === m.slot);
      if (!t || !t.next || t.next.job !== m.id) return;
      [t.cur, t.next] = [t.next, null];
      if (!playing.loop) {
        playing.end = lineEnd();
        tell({ type: "end", at: playing.end });
      }
      say(`${name(t.slot)}: the change is in`);
    } else if (m.type === "ended") {
      playing.heard ??= { pos: playing.end, frame: audio.currentTime * RATE, running: false, rounds: 0, stalls: 0 };
      playing.ended = audio.currentTime * RATE;
      paintSoon();
    }
  }

  // what a singer's worker says
  function heard({ data: m }) {
    if (m.type === "ready") return;
    if (m.type === "warned") return say(m.message, true);
    if (m.type === "error" && m.id === null) {
      stop();
      return say(m.message, true);
    }
    const j = playing && playing.jobs.get(m.id);
    if (!j) return;
    const { t, rec } = j, i = t.slot, many = desk.value.rows.length > 1;
    if (m.type === "error") {
      playing.jobs.delete(m.id);
      // a change that cannot be sung leaves what was sung before; a singer that cannot start stops all
      if (t.next === rec) {
        t.next = null;
        return say(`${name(i)}: ${m.message}\nwhat it sang before goes on`, true);
      }
      stop();
      if (m.at !== null) {
        show(i);
        ed.select(ed.part.notes.filter((n) => n.at === m.at));
        reveal(m.at);
      }
      say(many ? `${name(i)}: ${m.message}` : m.message, true);
      return refresh();
    }
    if (m.type === "open") {
      const from = HEAD - m.zero + m.first;
      if (from < 0) {
        stop();
        return say(`${name(i)} starts ${((m.zero - HEAD) / RATE).toFixed(2)} s before the speaker's line does`, true);
      }
      Object.assign(rec, { from, len: m.last - m.first, open: true });
      tell({ type: "take", slot: i, id: rec.job, from, length: rec.len, now: t.cur === rec });
      if (!playing.began) {
        if (tracks().every((x) => x.cur.open)) begin();
      } else if (!playing.loop && t.cur === rec) {
        playing.end = lineEnd();
        tell({ type: "end", at: playing.end });
      }
    } else if (m.type === "chunk") {
      if (!m.samples.length) return;
      rec.got += m.samples.length;
      tell({ type: "chunk", slot: i, id: rec.job, samples: m.samples }, [m.samples.buffer]);
    } else if (m.type === "done") {
      rec.done = true;
      playing.jobs.delete(m.id);
      tell({ type: "done", slot: i, id: rec.job });
      // all of it made, where nothing has been said since it began
      if (!playing.jobs.size && status.textContent === playing.intro) say(`${playing.intro}; made in ${((window.performance.now() - playing.t0) / 1000).toFixed(1)} s`);
    }
  }

  // A quality chosen: kept for every page of the site, and where the workers sing by another, they
  // are let go and the score, where it is sung, sung again from where the sound is.
  function reroute(by) {
    if (!routes) throw new Error("the site has not said yet which qualities it has");
    if (!routes.includes(by)) throw new Error(`this site has no ${by} quality (it has ${routes.join(" and ")})`);
    chosen = by;
    try {
      window.localStorage.setItem(QUALITY, JSON.stringify(by));
    } catch (e) {
      say(`the quality is not kept for the next visit: ${e.message}`, true);
    }
    shown();
    if (requalify()) say(`every singer is sung in ${by}`);
  }
  // The workers let go where they sing by another quality than the one in use, and the score,
  // where it is sung, sung again by new ones from where the sound is. Whether they were.
  function requalify() {
    if (!pool.some(Boolean) || (made ?? routes[0]) === quality()) return false;
    const at = playing && playing.ended === null ? heardAt() ?? playing.start : null;
    stop();
    for (const w of pool) w?.terminate();
    pool.length = 0;
    if (at !== null) sing(at);
    return true;
  }

  // the singing let go of, the speaker told nothing
  function halt() {
    if (!playing) return;
    window.clearTimeout(playing.timer);
    for (const [job, { t }] of playing.jobs) worker(t.slot).postMessage({ type: "stop", ids: [job] });
    playing = null;
    paintSoon();
  }
  function stop() {
    if (!playing) return;
    halt();
    tell({ type: "stop" });
  }

  // Every singer that has notes is sung, from the place set (or `at`): round the loop where it is
  // on. A singer whose part cannot be sung yet stops it, by its note; unless it is muted.
  function sing(at = null) {
    attempt(() => {
      const rows = desk.value.rows, todo = [];
      rows.forEach((r, i) => {
        const part = r.ed.part;
        if (!part.notes.length) return;
        const inTheWay = problems(part);
        if (!inTheWay.length) return todo.push(i);
        if (r.mute) return;
        if (tab !== "singer" || cur !== i) show(i);
        ed.select(part.notes.filter((n) => n.at === inTheWay[0].at));
        reveal(inTheWay[0].at);
        throw new Error(`${rows.length > 1 ? `${name(i)} is ` : ""}not sung yet:\n${inTheWay.map((p) => p.what).join("\n")}`);
      });
      if (!todo.length) throw new Error(rows.some((r) => r.ed.part.notes.length) ? "the only singers with notes are muted, and cannot be sung yet" : "no singer has a note to sing");
      stop();
      speak();
      // Round a loop, the loop's stretch is sung, from the place set where that is inside it and
      // from its start where not. With no loop, the score from the place set to its end.
      const part = rows[0].ed.part, want = at ?? cursor;
      const loop = set.loop.on && looped() ? { from: set.loop.from, to: set.loop.to } : null;
      const start = loop ? (want > loop.from && want < loop.to ? want : loop.from) : want;
      playing = { n: ++runs, loop, start, at: tickAfter(part), secs: clock(part), time: timeOf(part), together: oneClock(), meter: part.meter, tracks: new Map(), jobs: new Map(), seen: new Map(rows.map((r) => [r.ed, r.ed.part])), began: false, line: null, floor: 0, end: 0, heard: null, ended: null, timer: null, t0: window.performance.now() };
      for (const i of todo) ask(i, false);
      say(todo.length > 1 ? `${todo.length} singers are getting ready` : "the singer is getting ready");
    });
  }

  // What has changed since it was last looked at, heard: a singer whose part changed is sung anew
  // and faded in; one with notes for the first time joins; one with none left falls silent. A
  // part that cannot be sung goes on as it last could be. Where the singers themselves or the
  // tempo changed, all are sung again from where the sound is.
  function live() {
    if (!playing || playing.ended !== null) return;
    const rows = desk.value.rows, part0 = rows[0].ed.part;
    if ([...playing.tracks].some(([e, t]) => !rows[t.slot] || rows[t.slot].ed !== e) || timeOf(part0) !== playing.time) return sing(heardAt() ?? playing.start);
    if (part0.meter !== playing.meter && playing.began) {
      playing.meter = part0.meter;
      beats();
    }
    // a second singer with notes, or one left: every singer is sung anew, on the clock or off it
    const one = oneClock(), turned = one !== playing.together;
    playing.together = one;
    let again = false;
    rows.forEach((r, i) => {
      const part = r.ed.part, seen = playing.seen.get(r.ed);
      if (seen && sameSung(seen, part) && !turned) return;
      playing.seen.set(r.ed, part);
      const t = playing.tracks.get(r.ed);
      if (!part.notes.length) {
        if (!t) return;
        if (t.next) cancel(i, t.next);
        cancel(i, t.cur);
        playing.tracks.delete(r.ed);
        return tell({ type: "drop", slot: i });
      }
      const inTheWay = problems(part);
      if (inTheWay.length) return say(`${name(i)}: ${inTheWay[0].what}\n${t ? "it goes on as it last could be sung" : "it joins when it can be sung"}`);
      if (!playing.began) again = true;
      else {
        say(t ? `${name(i)}: sung anew from here` : `${name(i)}: joining`);
        ask(i, true);
      }
    });
    if (!playing.tracks.size) {
      stop();
      say("no singer has a note left to sing");
    } else if (again) sing(playing.start);
  }

  // The place singing starts from set to a tick. While the score is sung, the singing goes there:
  // at once where every singer's sound is already made, sung anew from there where it is not.
  // Round a loop, a place outside the loop is kept for when the loop is off, and the loop goes on.
  function place(tick) {
    cursor = tick;
    sync();
    paintSoon();
    const beat = P.beat(tick, ed.part.grid);
    if (!playing) return say(`Sing starts at beat ${beat}${set.loop.on && looped() && !(tick > set.loop.from && tick < set.loop.to) ? " when the loop is off" : ""}`);
    if (playing.loop && !(tick >= playing.loop.from && tick < playing.loop.to)) return say(`beat ${beat} is outside the loop: the loop goes on, and Sing starts there when the loop is off`);
    if (!playing.began || playing.ended !== null) return sing();
    // the sound from a little before the place, so that a note there keeps what it opens with
    const p = Math.max(0, lineOf(tick) - PRE);
    const made = [...playing.tracks].every(([e, t]) => !t.next && t.cur.open && sameSung(t.cur.part, e.part) && (t.cur.whole || p >= t.cur.from) && (t.cur.done || p + AHEAD <= t.cur.from + t.cur.got));
    if (!made) return sing();
    tell({ type: "seek", pos: p });
    playing.floor = p;
    playing.heard = { pos: p, frame: audio.currentTime * RATE, running: false, rounds: 0, stalls: playing.heard ? playing.heard.stalls : 0 };
    say(`at beat ${beat}`);
  }

  // ---------------------------------------------------------------- the loop, the click, the speaker's lateness

  const looped = () => set.loop.to > set.loop.from;
  function keepSet() {
    try {
      window.localStorage.setItem(SET, JSON.stringify(set));
    } catch (e) {
      say(`the loop and the click are not kept for the next visit: ${e.message}`, true);
    }
  }
  // the buttons and fields as the page is set
  function shown() {
    $("loop").setAttribute("aria-pressed", String(set.loop.on));
    $("click").setAttribute("aria-pressed", String(set.click.on));
    $("others").setAttribute("aria-pressed", String(set.others));
    fields["click-volume"].set(set.click.volume);
    fields.delay.set(set.delay);
    if (routes) {
      for (const r of radios) r.checked = r.value === quality();
      $("route-said").textContent = WHY[why()][quality()];
    }
    if (mix) mix.set(score(), level());
    keepSet();
    paintSoon();
  }
  // the loop changed while the score is sung: sung again from where the sound is, the new way
  const reloop = () => { if (playing) sing(heardAt() ?? playing.start); };
  // The loop on or off. With none marked, it is marked round the notes chosen, or round all of them.
  function toggleLoop() {
    if (!set.loop.on && !looped()) {
      const notes = ed.selected.size ? [...ed.selected] : desk.value.rows.flatMap((r) => r.ed.part.notes);
      if (!notes.length) throw new Error("no notes to loop: drag along the ruler to mark a stretch");
      set.loop.from = Math.min(...notes.map((n) => n.at));
      set.loop.to = Math.max(...notes.map((n) => n.at + n.ticks));
    }
    set.loop.on = !set.loop.on;
    shown();
    say(set.loop.on ? `Sing goes round beats ${P.beat(set.loop.from, ed.part.grid)} to ${P.beat(set.loop.to, ed.part.grid)}` : "Sing sings the score through");
    reloop();
  }
  function unloop() {
    set.loop = { on: false, from: 0, to: 0 };
    shown();
  }
  // the loop's end under x in the ruler: "from", "to", or null
  const loopEnd = (x) => (!looped() ? null : Math.abs(GUT + view.x(set.loop.from) - x) <= 6 ? "from" : Math.abs(GUT + view.x(set.loop.to) - x) <= 6 ? "to" : null);

  // ---------------------------------------------------------------- a note's syllable

  function word(note) {
    worded = note;
    const x = Math.max(GUT, GUT + view.x(note.at));
    lyric.style.left = `${x}px`;
    lyric.style.top = `${rows().words + 3}px`;
    lyric.style.width = `${Math.max(90, Math.min(260, note.ticks * view.wide))}px`;
    lyric.style.display = "block";
    lyric.value = note.lyric ?? "";
    lyric.focus();
    lyric.select();
    ed.select([note]);
    refresh();
  }

  function unword() {
    worded = null;
    lyric.style.display = "none";
    canvas.focus();
  }

  // What is typed, under the note and the notes after it: the note after those, or null. False
  // if it was refused.
  function lay() {
    const note = worded, text = lyric.value.trim();
    try {
      if (!text) {
        ed.set([note], { lyric: null });
        const i = ed.part.notes.findIndex((n) => n.at === note.at && n.pitch === note.pitch);
        return ed.part.notes[i + 1] ?? null;
      }
      return ed.words(note, text);
    } catch (e) {
      say(e.message, true);
      return false;
    }
  }

  function commitWord(onward) {
    if (!worded) return;
    const next = lay();
    if (next === false) return refresh();
    say("");
    if (onward && next) word(next);
    else {
      unword();
      refresh();
    }
  }

  // ---------------------------------------------------------------- the mouse

  const at = (e) => {
    const b = canvas.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  };

  function down(e) {
    if (worded) commitWord(false);
    canvas.focus();
    const [x, y] = at(e), where = region(x, y), part = ed.part;
    const tick = tickAt(x), key = keyAt(y);
    const twice = e.timeStamp - tapped.at < 400 && Math.hypot(x - tapped.x, y - tapped.y) < 5;
    tapped = { at: twice ? -Infinity : e.timeStamp, x, y };
    canvas.setPointerCapture?.(e.pointerId);
    if (where === "roll") {
      const h = hit(part, tick, key, 7 / view.wide);
      point = null;
      if (h) {
        if (e.shiftKey) ed.select([h.note], true);
        else if (!ed.selected.has(h.note)) ed.select([h.note]);
        ed.begin();
        drag = { kind: h.end ? "stretch" : "move", tick, key, note: h.note };
      } else if (drawing || twice) {
        const from = Math.floor(tick / step) * step;
        ed.begin();
        attempt(() => ed.add(from, last.ticks, key, last.velocity));
        drag = { kind: "draw", from, key, x, sized: false };
      } else {
        drag = { kind: "band", tick, key, had: e.shiftKey ? new Set(ed.selected) : new Set() };
        if (!e.shiftKey) ed.select([]);
      }
    } else if (where === "ruler") {
      // an end of the loop taken hold of, or a new loop drawn from here
      const end = loopEnd(x);
      drag = { kind: "loop", fixed: end ? (end === "from" ? set.loop.to : set.loop.from) : snap(tick, step), fresh: !end, x, moved: false };
    } else if (where === "words") {
      const n = sounding(part, tick);
      if (n) return word(n);
      ed.select([]);
    } else if (where === "velocity") {
      const n = sounding(part, tick);
      if (n) {
        if (!ed.selected.has(n)) ed.select([n]);
        ed.begin();
        drag = { kind: "velocity" };
        move(e);
      }
    } else if (where === "vibrato") {
      const i = pointAt(x, y);
      ed.begin();
      if (i >= 0) {
        point = i;
        drag = { kind: "point", i, fresh: false, moved: false };
        if (e.shiftKey) {
          attempt(() => ed.line("vibrato", i, !part.lanes.vibrato[i].line));
          drag = null;
          ed.end();
        }
      } else {
        drag = { kind: "point", fresh: true };
        move(e);
      }
    }
    refresh();
  }

  function move(e) {
    const [x, y] = at(e);
    if (!drag) {
      const where = region(x, y);
      const h = where === "roll" && hit(ed.part, tickAt(x), keyAt(y), 7 / view.wide);
      canvas.style.cursor = h ? (h.end ? "ew-resize" : "grab") : where === "vibrato" && pointAt(x, y) >= 0 ? "grab" : where === "words" ? "text" : where === "ruler" ? (loopEnd(x) ? "ew-resize" : "col-resize") : "default";
      return;
    }
    const tick = tickAt(x), key = keyAt(y);
    if (drag.kind === "loop") {
      // a press that has not moved is a place set (up()); once it moves it marks the loop, and a
      // new loop is on from then
      if (!drag.moved && Math.abs(x - drag.x) < 5) return;
      drag.moved = true;
      const other = snap(tick, step);
      if (other === drag.fixed) return;
      set.loop = { on: drag.fresh ? true : set.loop.on, from: Math.min(drag.fixed, other), to: Math.max(drag.fixed, other) };
      return shown();
    }
    if (drag.kind === "move") {
      const dt = snap(drag.note.at + tick - drag.tick, step) - drag.note.at;
      ed.again();
      attempt(() => ed.move(dt, key - drag.key));
    } else if (drag.kind === "stretch") {
      const end = drag.note.at + drag.note.ticks, dt = snap(end + tick - drag.tick, step) - end;
      ed.again();
      attempt(() => ed.stretch(dt, step));
      const n = first();
      if (n) last.ticks = n.ticks;
    } else if (drag.kind === "draw") {
      if (!drag.sized && Math.abs(x - drag.x) < 5) return;
      drag.sized = true;
      const ticks = Math.max(step, snap(tick, step) - drag.from);
      ed.again();
      attempt(() => ed.add(drag.from, ticks, drag.key, last.velocity));
      last.ticks = ticks;
    } else if (drag.kind === "band") {
      band = [drag.tick, drag.key, tick, key];
      const [t0, t1] = [Math.min(drag.tick, tick), Math.max(drag.tick, tick)], [k0, k1] = [Math.min(drag.key, key), Math.max(drag.key, key)];
      const inside = ed.part.notes.filter((n) => n.at < t1 && n.at + n.ticks > t0 && P.key(n.pitch) >= k0 && P.key(n.pitch) <= k1);
      ed.select([...drag.had, ...inside]);
      refresh();
    } else if (drag.kind === "velocity") {
      const velocity = velocityAt(y);
      ed.again();
      attempt(() => ed.set([...ed.selected], { velocity }));
      last.velocity = velocity;
    } else if (drag.kind === "point") {
      const where = snap(tick, step), value = laneValue(y);
      ed.again();
      if (drag.fresh) attempt(() => { point = ed.point("vibrato", where, value); });
      else attempt(() => ed.repoint("vibrato", drag.i, where, value));
    }
  }

  function up(e) {
    canvas.releasePointerCapture?.(e.pointerId);
    if (!drag) return;
    if (drag.kind === "loop") {
      const moved = drag.moved;
      drag = null;
      if (!moved) return attempt(() => place(snap(tickAt(at(e)[0]), step)));
      if (looped()) say(`the loop: beats ${P.beat(set.loop.from, ed.part.grid)} to ${P.beat(set.loop.to, ed.part.grid)}${set.loop.on ? "" : ", off"}`);
      shown();
      if (playing && (set.loop.on || playing.loop)) reloop();
      return;
    }
    drag = null;
    band = null;
    ed.end();
    refresh();
  }

  function wheel(e) {
    e.preventDefault();
    const [x, y] = at(e);
    if (worded) commitWord(false);
    if (e.ctrlKey || e.metaKey) view.zoom(Math.exp(-e.deltaY * 0.01), Math.max(0, x - GUT));
    else if (e.altKey) view.heighten(Math.exp(-e.deltaY * 0.01), Math.max(0, y - RULER));
    else view.scroll(e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, e.shiftKey ? 0 : e.deltaY, rows().roll);
    paintSoon();
  }

  // ---------------------------------------------------------------- undo

  // the tab in sight after a step back or on: the singer it changed, where it changed one
  function landed(g) {
    const rows = desk.value.rows, i = rows.findIndex((r) => g.includes(r.ed));
    cur = Math.min(i >= 0 ? i : cur, rows.length - 1);
    ed = rows[cur].ed;
    if (i >= 0 && !g.includes(desk)) tab = "singer";
    point = null;
  }
  function back() {
    const g = journal.past.pop();
    if (!g) return;
    for (const h of [...g].reverse()) h.undo();
    journal.future.push(g);
    landed(g);
  }
  function forth() {
    const g = journal.future.pop();
    if (!g) return;
    for (const h of g) h.redo();
    journal.past.push(g);
    landed(g);
  }

  // ---------------------------------------------------------------- the keys

  function key(e) {
    const t = e.target, typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
    if (e.defaultPrevented) return; // a pull field took it
    const mod = e.metaKey || e.ctrlKey, k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mod && k === "s") {
      e.preventDefault();
      return save("score");
    }
    if (mod && k === "o") {
      e.preventDefault();
      return $("file").click();
    }
    if (typing || (t && t.tagName === "BUTTON" && (k === "Enter" || k === " "))) return;
    const done = (f) => {
      e.preventDefault();
      attempt(f);
    };
    if (mod && k === "z") return done(e.shiftKey ? forth : back);
    if (mod && k === "y") return done(forth);
    if (mod && k === "a") return done(() => ed.select(ed.part.notes));
    if (mod) return;
    if (k === " ") {
      e.preventDefault();
      return playing ? (stop(), say("stopped")) : sing();
    }
    if (k === "m") return tab === "mixer" ? show(cur) : showMixer();
    if (/^[1-9]$/.test(k) && Number(k) <= desk.value.rows.length) return show(Number(k) - 1);
    if (k === "o") return done(toggleLoop);
    if (k === "k") return done(() => { set.click.on = !set.click.on; shown(); });
    if (tab === "mixer") return;
    const sel = [...ed.selected];
    if (k === "Delete" || k === "Backspace") {
      return done(() => {
        if (point !== null) {
          ed.unpoint("vibrato", point);
          point = null;
        } else ed.remove();
      });
    }
    if (k === "ArrowLeft" || k === "ArrowRight") {
      const d = k === "ArrowLeft" ? -step : step;
      return done(() => (e.altKey ? ed.stretch(d, step) : ed.move(d, 0)));
    }
    if (k === "ArrowUp" || k === "ArrowDown") return done(() => ed.move(0, (k === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 12 : 1)));
    if (k === "Enter" && first()) {
      e.preventDefault();
      return word(first());
    }
    if (k === "Escape") return done(() => { ed.select([]); point = null; });
    if (k === "b" && sel.length) return done(() => ed.mark(first().at));
    if (k === "l" && point !== null) return done(() => ed.line("vibrato", point, !ed.part.lanes.vibrato[point].line));
    if (k === "Home") return done(() => place(0));
    if (k === "g") return done(() => { set.others = !set.others; shown(); });
    if (k === "d") return done(() => { drawing = !drawing; });
    if (k === "f") return done(fit);
    if (k === "=" || k === "+") return done(() => view.zoom(1.25, (W - GUT) / 2));
    if (k === "-") return done(() => view.zoom(0.8, (W - GUT) / 2));
  }

  // ---------------------------------------------------------------- wiring

  // On a phone a finger moves the roll, two pinch it (apart sideways, wider in time; up and down,
  // taller in pitch). A tap on the ruler sets where singing starts (while it sings, it jumps
  // there); on a note, chooses it. A finger held still takes hold of the note nearest it, any
  // singer's (whose tab is then shown): dragged, the note moves, or by its right end it grows or
  // shrinks; let go, it is sung from a beat before.
  const HOLD = 350; // ms a finger is held still to take hold of a note
  const REACH = 24; // pixels from a note a finger may be and still take hold of it
  const EDGE = 16; // pixels of a note's right end that take hold of its length
  // the note nearest (x, y) within REACH, this singer's before another's as near: {i (its singer), note, end}
  const nearest = (x, y) => {
    let best = null;
    desk.value.rows.forEach((r, i) => {
      for (const n of r.ed.part.notes) {
        const x0 = GUT + view.x(n.at), x1 = x0 + n.ticks * view.wide, mid = RULER + view.y(P.key(n.pitch)) + view.tall / 2;
        const d = Math.hypot(x < x0 ? x0 - x : x > x1 ? x - x1 : 0, Math.max(0, Math.abs(y - mid) - view.tall / 2)) + (i === cur ? 0 : 0.5);
        if (d <= REACH && (!best || d < best.d)) best = { i, note: n, d, end: x > x1 - Math.min(EDGE, (x1 - x0) / 3) };
      }
    });
    return best;
  };
  const fingers = new Map(); // pointer: where it is
  let gesture = null; // one finger: {x, y (where it went down), last, moved, timer}; two: {span, tall (apart in x, in y), mid}
  function hold() {
    const { x, y } = gesture, tick = tickAt(x), key = keyAt(y);
    gesture.timer = null;
    if (region(x, y) !== "roll") return;
    const h = nearest(x, y);
    if (!h) return say("no note there to take hold of: hold a finger on one");
    if (h.i !== cur) show(h.i);
    ed.select([h.note]);
    ed.begin();
    drag = { kind: h.end ? "stretch" : "move", tick, key, note: h.note };
    window.navigator.vibrate?.(12);
    say(h.end ? "drag to change the note's length" : "drag to move the note");
    refresh();
  }
  const letGo = () => {
    if (gesture?.timer) window.clearTimeout(gesture.timer);
  };
  const pinch = () => {
    const [a, b] = [...fingers.values()];
    return { span: Math.abs(a[0] - b[0]), tall: Math.abs(a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
  };
  const one = (p, moved) => ({ x: p[0], y: p[1], last: p, moved });
  function touchDown(e) {
    if (drag) return; // a note held: other fingers do nothing
    canvas.setPointerCapture?.(e.pointerId);
    fingers.set(e.pointerId, at(e));
    letGo();
    if (fingers.size === 1) gesture = { ...one(at(e), false), timer: window.setTimeout(hold, HOLD) };
    else if (fingers.size === 2) gesture = pinch();
  }
  function touchMove(e) {
    if (!fingers.has(e.pointerId)) return;
    if (drag) return move(e);
    const p = at(e);
    fingers.set(e.pointerId, p);
    if (fingers.size === 1) {
      if (!gesture.moved && Math.hypot(p[0] - gesture.x, p[1] - gesture.y) < 8) return;
      letGo();
      view.scroll(gesture.last[0] - p[0], gesture.last[1] - p[1], rows().roll);
      gesture = { ...gesture, last: p, moved: true };
    } else if (fingers.size === 2) {
      const now = pinch();
      view.zoom(Math.max(now.span, 30) / Math.max(gesture.span, 30), Math.max(0, now.mid[0] - GUT));
      view.heighten(Math.max(now.tall, 30) / Math.max(gesture.tall, 30), Math.max(0, now.mid[1] - RULER));
      view.scroll(gesture.mid[0] - now.mid[0], gesture.mid[1] - now.mid[1], rows().roll);
      gesture = now;
    }
    paintSoon();
  }
  function touchUp(e) {
    canvas.releasePointerCapture?.(e.pointerId);
    if (!fingers.delete(e.pointerId)) return;
    letGo();
    if (drag) {
      drag = null;
      gesture = null;
      ed.end();
      refresh();
      const n = first();
      if (n && e.type === "pointerup") sing(Math.max(0, n.at - ed.part.grid));
      return;
    }
    if (fingers.size) {
      gesture = one([...fingers.values()][0], true);
      return;
    }
    const [x, y] = at(e), tap = e.type === "pointerup" && gesture.x !== undefined && !gesture.moved;
    gesture = null;
    if (!tap) return;
    const where = region(x, y);
    if (where === "ruler") return attempt(() => place(snap(tickAt(x), step)));
    if (where !== "roll") return;
    const h = nearest(x, y);
    if (h && h.i !== cur) show(h.i);
    ed.select(h ? [h.note] : []);
    if (h) say("hold the note to drag it");
    refresh();
  }
  // iOS takes a finger held still for its own (a selection, a callout) and cancels it: refused, the
  // roll's pointers keep it
  if (phone) canvas.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  canvas.addEventListener("pointerdown", phone ? touchDown : down);
  canvas.addEventListener("pointermove", phone ? touchMove : move);
  canvas.addEventListener("pointerup", phone ? touchUp : up);
  canvas.addEventListener("pointercancel", phone ? touchUp : up);
  canvas.addEventListener("wheel", wheel, { passive: false });
  document.addEventListener("keydown", key);
  new window.ResizeObserver(size).observe(canvas);

  lyric.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitWord(false); }
    else if (e.key === "Tab") { e.preventDefault(); commitWord(true); }
    else if (e.key === "Escape") { e.preventDefault(); unword(); refresh(); }
  });
  // a space or a hyphen after a syllable is the next note's turn
  lyric.addEventListener("input", () => {
    const v = lyric.value;
    if (v.trim() && (/\s$/.test(v) || (/[^-]-$/.test(v) && v.trim().length > 1))) commitWord(true);
  });
  lyric.addEventListener("blur", () => { if (worded) commitWord(false); });

  $("title").addEventListener("change", () => attempt(() => {
    const title = $("title").value.trim();
    S.check({ ...score(), title });
    desk.commit({ ...desk.value, title });
  }));
  $("new").addEventListener("click", () => attempt(() => {
    open(S.of(P.blank(ed.part.singer)));
    say("a new score, with the singer the last had");
  }));
  $("open").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", async () => {
    const f = $("file").files[0];
    if (!f) return;
    try {
      take(new Uint8Array(await f.arrayBuffer()), f.name);
    } catch (e) {
      say(`${f.name}: ${e.message}`, true);
    }
    $("file").value = "";
  });
  // the examples: each opened as its file is, the menu left at its name
  {
    const option = (value, text) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      return o;
    };
    $("examples").replaceChildren(option("", "Examples"), ...MENU.map((x) => option(x.file, x.label)));
    $("examples").value = "";
  }
  $("examples").addEventListener("change", async () => {
    const file = $("examples").value;
    $("examples").value = "";
    canvas.focus();
    if (!file) return;
    try {
      const r = await window.fetch(new URL(`./examples/${file}`, import.meta.url));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      take(new Uint8Array(await r.arrayBuffer()), file);
    } catch (e) {
      say(`${file}: ${e.message}`, true);
    }
  });
  for (const el of [canvas, $("mixer")]) {
    el.addEventListener("dragover", (e) => e.preventDefault());
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (!f) return;
      try {
        take(new Uint8Array(await f.arrayBuffer()), f.name);
      } catch (err) {
        say(`${f.name}: ${err.message}`, true);
      }
    });
  }
  $("save-score").addEventListener("click", () => save("score"));
  $("save-part").addEventListener("click", () => save("part"));
  $("save-midi").addEventListener("click", () => save("midi"));
  // on a phone one button sings and stops: Stop while it sounds (paint())
  const aloud = () => playing !== null && playing.ended === null;
  $("sing").addEventListener("click", () => {
    if (!phone || !aloud()) return sing();
    stop();
    say("stopped");
  });
  $("loop").addEventListener("click", () => attempt(toggleLoop));
  $("click").addEventListener("click", () => attempt(() => { set.click.on = !set.click.on; shown(); }));
  $("stop").addEventListener("click", () => {
    stop();
    say("stopped");
  });
  $("undo").addEventListener("click", () => attempt(back));
  $("redo").addEventListener("click", () => attempt(forth));
  $("draw").addEventListener("click", () => attempt(() => { drawing = !drawing; }));
  $("others").addEventListener("click", () => attempt(() => { set.others = !set.others; shown(); }));
  $("snap").addEventListener("change", () => attempt(() => {
    step = Number($("snap").value);
    stepName = steps(ed.part.grid).find((o) => o.ticks === step).name;
  }));
  $("zoom-in").addEventListener("click", () => attempt(() => view.zoom(1.25, (W - GUT) / 2)));
  $("zoom-out").addEventListener("click", () => attempt(() => view.zoom(0.8, (W - GUT) / 2)));
  $("fit").addEventListener("click", () => attempt(fit));
  $("side-toggle").addEventListener("click", () => {
    panel = !panel;
    $("side-toggle").setAttribute("aria-pressed", String(panel));
    refresh();
    size();
  });
  $("which-cancel").addEventListener("click", () => $("which").close());
  // a button pressed gives the keys back to the roll, so that space sings and does not press it again
  for (const id of ["new", "open", "save-score", "save-part", "save-midi", "sing", "stop", "loop", "click", "undo", "redo", "draw", "others", "zoom-in", "zoom-out", "fit", "side-toggle", "words-apply", "text-apply"]) {
    $(id).addEventListener("click", () => { if (tab === "singer") canvas.focus(); });
  }

  $("n-lyric").addEventListener("change", () => attempt(() => {
    const n = first(), v = $("n-lyric").value.trim();
    if (n) ed.set([n], { lyric: v === "" ? null : v });
  }, $("n-said")));
  $("s-voice").addEventListener("change", () => attempt(() => ed.singer("voice", $("s-voice").value), $("s-said")));
  $("s-diction").addEventListener("change", () => attempt(() => ed.singer("diction", $("s-diction").checked), $("s-said")));
  $("s-motion").addEventListener("change", () => attempt(() => ed.singer("motion", $("s-motion").value === "-" ? null : $("s-motion").value), $("s-said")));
  // The words under this singer's notes, and, where it is asked, under those of every singer who
  // sang the same words; on a phone, sung at once from the start.
  $("words-apply").addEventListener("click", () => attempt(() => {
    if (!ed.part.notes.length) throw new Error("no notes to lay the words under");
    const text = $("words").value, eds = [ed, ...($("words-all").checked ? alike() : [])];
    for (const e of eds) {
      const n = syllables(text).length, room = e.part.notes.length;
      if (n > room) throw new Error(`${n} syllables for ${eds.length > 1 ? `${singerName(e)}'s` : "the"} ${room} ${room === 1 ? "note" : "notes"}`);
    }
    together(() => { for (const e of eds) e.words(e.part.notes[0], text); });
    draft = null;
    if (phone) {
      stop();
      sing(0);
    }
  }, $("words-said")));
  $("words").addEventListener("input", () => {
    draft = { ed, text: $("words").value };
    counted();
  });
  // The text read as this singer's part. The score keeps one time: a tempo or a meter changed
  // here is every singer's, and another grid is refused while there are others.
  $("text-apply").addEventListener("click", () => attempt(() => together(() => {
    const part = P.read($("text").value), others = desk.value.rows.filter((r) => r.ed !== ed);
    if (others.length && part.grid !== ed.part.grid) throw new Error(`grid ${part.grid}: the score's singers share a grid of ${ed.part.grid}`);
    ed.load(part, false);
    for (const r of others) {
      if (JSON.stringify([r.ed.part.tempo, r.ed.part.meter]) !== JSON.stringify([part.tempo, part.meter])) r.ed.commit({ ...r.ed.part, tempo: part.tempo, meter: part.meter });
    }
    point = null;
  }), $("text-said")));

  // the score as it was left, and the voices there are
  size();
  const stored = (k, what) => {
    try {
      return window.localStorage.getItem(k);
    } catch (e) {
      say(`${what} of the last visit cannot be asked for: ${e.message}`, true);
      unread = true;
      return null;
    }
  };
  let unread = false, newcomer = false; // the browser's storage refused; nothing was kept from a visit before
  {
    const was = stored(KEEP, "the score"), one = was === null ? stored(KEPT_PART, "the part") : null;
    newcomer = was === null && one === null && !unread;
    if (was !== null || one !== null) {
      try {
        const s = was !== null ? S.read(was) : S.of(P.read(one));
        desk.value = { title: s.title, master: s.master, chain: s.chain, rows: s.singers.map((x) => ({ level: x.level, pan: x.pan, mute: x.mute, solo: x.solo, ed: fresh(x.part) })) };
        saved = desk.value;
        ed = desk.value.rows[0].ed;
        kept = [desk.value, ...desk.value.rows.map((r) => r.ed.part)];
        say(was !== null ? "the score as it was left" : "the part as it was left");
      } catch (e) {
        say(`the ${was !== null ? "score" : "part"} of the last visit is not read: ${e.message}`, true);
      }
    }
  }
  // the loop, the click, the speaker's lateness and the other singers' notes as they were left
  try {
    const text = stored(SET, "the loop and the click");
    if (text !== null) {
      const v = JSON.parse(text), whole = (n) => Number.isInteger(n) && n >= 0;
      if (!(v && v.loop && typeof v.loop.on === "boolean" && whole(v.loop.from) && whole(v.loop.to) && v.click && typeof v.click.on === "boolean" && whole(v.click.volume) && v.click.volume <= 100 && Number.isFinite(v.delay) && typeof v.others === "boolean")) throw new Error(text);
      Object.assign(set, { loop: { on: v.loop.on, from: v.loop.from, to: v.loop.to }, click: { on: v.click.on, volume: v.click.volume }, delay: v.delay, others: v.others });
    }
  } catch (e) {
    say(`the loop and the click of the last visit are not read: ${e.message}`, true);
  }
  // the quality chosen on a visit before, on this page or another of the site's
  try {
    const text = stored(QUALITY, "the quality chosen");
    if (text !== null) {
      const v = JSON.parse(text);
      if (typeof v !== "string") throw new Error(text);
      chosen = v;
    }
  } catch (e) {
    say(`the quality chosen on the last visit is not read: ${e.message}`, true);
  }
  shown();
  fit();
  refresh();
  // a first visit greeted: the example opened as any file is, and where to start said
  const greeted = welcome && newcomer ? window.fetch(new URL(`./examples/${FIRST}`, import.meta.url)).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const before = desk.value;
    take(new Uint8Array(await r.arrayBuffer()), FIRST);
    if (desk.value !== before) say(phone ? HELLO_PHONE : HELLO);
  }).catch((e) => say(`${FIRST}: ${e.message}`, true)) : null;
  // the site's model files (site.js): its voices, and what it says of itself
  const files = filesOf({ web, models, fetch: (url, o) => window.fetch(url, o), said: (m) => say(m, true), caches: window.caches });
  files.then((f) => f.voices()).then((list) => {
    for (const v of list) if (typeof v.name !== "string" || typeof v.label !== "string" || !called(v) || !SEX[v.sex]) throw new Error(`a voice without a name, a label and a sex of F or M: ${JSON.stringify(v)}`);
    voices = list;
    refresh();
  }).catch((e) => {
    $("s-said").textContent = `no list of the site's voices (${e.message}): each singer keeps the voice its part names`;
  });
  // the site's qualities: where it has more than one, the panel has the choice of them
  const sounds = Promise.all([import(new URL("routes.js", web).href), files]).then(([R, { site }]) => {
    routes = R.routesOf(site);
    if (chosen !== null && !routes.includes(chosen)) {
      say(`this site has no ${chosen} quality, the one chosen on the last visit: it sings in ${routes[0]}`, true);
      chosen = null;
    }
    // the qualities side by side, the one in use lit. Picked with the mouse, the choice gives the
    // keys back to the roll; picked with the arrows, it keeps them for the next
    let keyed = false;
    radios = routes.map((r) => {
      const input = make("input");
      Object.assign(input, { type: "radio", name: "quality", value: r });
      input.addEventListener("keydown", () => { keyed = true; });
      input.addEventListener("change", () => attempt(() => {
        if (!keyed) input.blur?.();
        keyed = false;
        reroute(r);
      }));
      return input;
    });
    $("route").replaceChildren(...radios.map((input) => {
      const label = make("label");
      label.append(input, make("span", null, input.value));
      return label;
    }));
    $("route-row").hidden = $("route-said").hidden = routes.length < 2;
    shown();
    requalify();
  }).catch((e) => {
    say(`the site's qualities are not known (${e.message}): there is no choice of them here`, true);
  });

  return {
    get ed() { return ed; },
    desk, view, fields, board, take, save, paint, sing, stop, heardAt, set, place, show, showMixer, score,
    cursor: () => cursor, playing: () => playing, mix: () => mix, sounds, reroute, routes: () => routes, quality, chosen: () => chosen, greeted,
  };
}
