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
import { Mix, strips } from "./mix.js";
import { BUDGET, Gather, can, cue, mixdown, placed, tail } from "./render.js";
import { wav, scoreOf } from "./wav.js";
import * as SH from "./share.js";
import { filesOf } from "./site.js";
import * as Cmd from "./commands.js";
import * as Clip from "./clip.js";
import * as T from "./theory.js";
import * as X from "./shape.js";
import * as Make from "./make.js";
import * as Ways from "./ways.js";
import * as MI from "./midiin.js";
import * as Tm from "./time.js";

// the roll's left gutter and its rows, pixels
const GUT = 56, RULER = 30, WORDS = 30;
const LANES = { vel: 64, vib: 92 }; // the velocity and vibrato rows' heights, where they are drawn: not on a phone
const STRIP = 16; // a row under the roll folded: its name only, to press to unfold it
const LAYOUT = "lipservice editor: the layout"; // the panel, its sections folded, the rows under the roll
// a roll to read, as a score opens: a beat this many pixels wide, a key's row this tall at least
const BEAT = 52, ROW = 16;
const KEEP = "lipservice editor: the score";
const KEPT_PART = "lipservice editor: the part"; // what the page kept when it held one singer
const BEFORE_LINK = "lipservice editor: the score before a link"; // the score kept, put aside when a link opened another
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
// sets its own. With a key, a row of its scale is in-key, the tonic's row tonic, and the tonic's
// key at the left marked tonic-key.
const ROLL = { bg: "bg", row: "row", black: "black", line: "line", beat: "beat", bar: "bar", ink: "ink", dim: "dim", note: "note", chosen: "chosen", bad: "bad", ok: "ok", lane: "lane", keyBlack: "key-black", keyWhite: "key-white", onNote: "on-note", inKey: "in-key", tonic: "tonic", tonicKey: "tonic-key" };
const SINGERS = 8;
const NOTHING = Object.freeze({ line: "", bad: false }); // what is said of a take where none was played
let C = null, COLORS = null, FONT = null;

export function boot({ document, window, web, models, welcome = false }) {
  // A phone: the roll is watched, moved and pinched, not drawn on; the panel holds the voice, the
  // shift, the words and the quality (editor.css, html.phone).
  const phone = window.navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad/.test(window.navigator.userAgent);
  // the machine, for the keys' names (cmd on a Mac, ctrl elsewhere: commands.js)
  const platform = window.navigator.platform, apple = Cmd.mac(platform);
  if (phone) document.documentElement.className = "phone";
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

  // What was done, in the order it was done: each step the editors and the desk it changed. A
  // follower made again from its leader goes in the leader's step (`joining`).
  const journal = { past: [], future: [], group: null };
  let joining = null;
  const record = (h) => {
    const last = journal.past.at(-1);
    if (journal.group) {
      if (!journal.group.includes(h)) journal.group.push(h);
    } else if (joining && last?.includes(joining)) {
      if (!last.includes(h)) last.push(h);
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
  // A singer's editor. Where singers follow it (a row's `follows`), each change to its notes,
  // words or vibrato makes theirs again from it (make.js followed), in the same step: a change
  // that would leave one unmade is refused before anything changes. A drag of it is a drag of
  // theirs. A follower's own notes are its leader's: a change to them is refused, its settings,
  // title and marks are its own.
  let syncing = false; // followers being made again from their leader
  const fresh = (part) => {
    const e = new Editor(part);
    e.pushed = record;
    const own = { commit: e.commit.bind(e), begin: e.begin.bind(e), again: e.again.bind(e), end: e.end.bind(e) };
    e.commit = (next, selected = e.selected) => {
      const rows = desk.value.rows, i = rows.findIndex((r) => r.ed === e), link = i < 0 ? null : rows[i].follows;
      if (link && !syncing) {
        const why = S.unlike(rows[link.leader].ed.part, next, link);
        if (why) throw new Error(`${name(i)} follows ${name(link.leader)}, so its notes, words and vibrato are made from ${name(link.leader)}'s: change those, or unlink it first`);
      }
      const again = i < 0 || (next.notes === e.part.notes && next.lanes === e.part.lanes) ? [] : rows.flatMap((r, j) => {
        if (r.follows?.leader !== i) return [];
        try {
          return S.unlike(next, r.ed.part, r.follows) === null ? [] : [[r.ed, Make.followed(next, r.ed.part, r.follows)]];
        } catch (err) {
          throw new Error(`${name(j)} follows ${name(i)}${linkSaid(r.follows, next.grid, ", ")}: ${err.message}`);
        }
      });
      own.commit(next, selected);
      if (!again.length) return;
      const was = joining;
      [syncing, joining] = [true, e];
      try {
        for (const [f, p] of again) f.commit(p, new Set());
      } finally {
        [syncing, joining] = [false, was];
      }
    };
    const theirs = (k) => () => {
      own[k]();
      const i = desk.value.rows.findIndex((r) => r.ed === e);
      if (i >= 0) for (const r of desk.value.rows) if (r.follows?.leader === i) r.ed[k]();
    };
    e.begin = theirs("begin");
    e.again = theirs("again");
    e.end = theirs("end");
    return e;
  };
  // how a singer follows its leader, in words: ", 6 beats later, an octave above"
  const linkSaid = (f, grid, lead = " ") => {
    const said = [...(f.after ? [`${P.beat(f.after, grid)} ${f.after === grid ? "beat" : "beats"} later`] : []), ...(f.keys ? [Make.apart(null, f.keys)] : [])];
    return said.length ? `${lead}${said.join(", ")}` : `${lead}in unison`;
  };
  // The desk: the score as it is edited, {title, master, chain, rows: [{ed (the singer's part and
  // what was done to it), level, pan, mute, solo, follows (where it follows another: score.js)}]}.
  const desk = new History({ title: "", master: 0, chain: S.chain(), rows: [{ ...S.strip(), ed: fresh(P.blank(P.singer("6147"))) }] });
  desk.pushed = record;
  let saved = desk.value; // the desk as last read or written
  let cur = 0; // the singer in sight
  let ed = desk.value.rows[0].ed; // and its editor
  let tab = "singer"; // or "mixer"
  // How the page is laid out, kept between visits (LAYOUT): the panel in sight, which of its
  // sections are unfolded, and which rows under the roll are unfolded (a phone has the words only,
  // always unfolded, and every section unfolded).
  const layout = {
    panel: true,
    lanes: { words: true, velocity: false, vibrato: false },
    folds: { note: true, singer: true, how: false, makers: false, key: false, sound: false, play: false, words: false, text: false },
  };
  const unseen = new WeakSet(); // the singers (their editors) whose notes are not shown behind the one in sight's
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
  // The sound file being made, or made: {n, score (as it was when Save sound was pressed), file,
  //   count, gather (render.js, till all is sung), jobs (job: slot, those still being made), t0,
  //   shown (the percent last said), lock (the screen kept awake), sleepy (why it may not be),
  //   url and share once it is ready}
  let rendering = null, renders = 0;
  // The link to the score as it last was (share.js): {text, made (settles once it is made), url, why
  // (where it is refused)}. On a phone it is made ahead, as the share sheet opens only within a tap.
  let linking = null, linkTimer = null;
  // The score put aside when a link opened another (its text, or null), kept in the browser
  // (BEFORE_LINK) so that a reload or a closed tab does not lose it. A link opened puts it aside,
  // going back to it takes it out, each in the step of Undo that opened the score: Undo and Redo
  // put it aside or take it out again, in the browser too.
  const aside = new History(null);
  aside.pushed = record;
  function stash() {
    try {
      if (aside.value === null) window.localStorage.removeItem(BEFORE_LINK);
      else window.localStorage.setItem(BEFORE_LINK, aside.value);
    } catch (e) {
      say(`${status.textContent}\n${aside.value === null ? "the score put aside for a link stays in the browser" : "the score put aside for a link is not kept for a reload"} (${e.message})`, true);
    }
  }
  for (const k of ["undo", "redo"]) {
    const f = aside[k].bind(aside);
    aside[k] = () => {
      const r = f();
      stash();
      return r;
    };
  }
  // what the page is set to, kept between visits: the loop (ticks; none where to is not after from),
  // the click, the ms added to the speaker's lateness, whether the other singers' notes show, the
  // key chosen (theory.js {tonic, scale}; null: the one found in the notes), and Scale (notes
  // drawn, dragged and stepped land on the key's notes)
  const set = { loop: { on: false, from: 0, to: 0 }, click: { on: false, volume: 50 }, delay: 0, others: true, key: null, scale: false };
  let routes = null; // the site's qualities, once it has said
  let radios = []; // the panel's choice of them
  let chosen = null; // the quality the visitor chose, on this page or another of the site's (QUALITY)
  let made = null; // the quality the workers in the pool sing by, null where they were asked for none: the site's first
  // The quality in use, and why: the one chosen; else fast on a phone, where the site has it; else
  // the site's first. null until the site has said what it has, unless one was chosen.
  const quality = () => chosen ?? (routes ? (phone && routes.includes("fast") ? "fast" : routes[0]) : null);
  const why = () => (chosen ? "chosen" : phone && routes?.includes("fast") ? "phone" : "default");
  let cursor = 0; // the tick Sing starts from
  let pointed = null; // where a right click was, while its menu is open: {place, tick, key, note, singer}
  // Notes played in (midiin.js), into the singer in sight; none of it on a phone:
  //   stepping   {steps (Steps)} while Step is on: what is played goes in where Sing starts, a step at a time
  //   keyboard   Keys, while "Keys play notes" is on: the letters A to K a keyboard
  //   recording  {take (Take), n (the singing it is heard against), pass (the loop's round), ed} while
  //              a take is played: Record on and the score sung
  //   midi       the browser's MIDI in (Midi), once asked for
  //   unwheeled  {take, ed}: a take whose wheel the singer cannot sing, its notes kept at a press
  let stepping = null, keyboard = null, recording = null, midi = null, unwheeled = null;
  let recordOn = false, quantize = true, octave = 4;
  let rulerMarks = []; // the tempo and meter changes as the ruler shows them: {kind, at, x0, x1}

  const color = (i) => COLORS[i % COLORS.length];
  // a singer's name: its part's title, or its voice's
  const name = (i) => {
    const part = desk.value.rows[i].ed.part, v = voices.find((x) => x.name === part.singer.voice);
    return part.title || (v ? called(v) : `Singer ${i + 1}`);
  };
  const singerName = (e) => name(desk.value.rows.findIndex((r) => r.ed === e));
  // whom singer i follows, and how: "Finn, 6 beats later"
  const following = (i) => {
    const f = desk.value.rows[i].follows;
    return `${name(f.leader)}${linkSaid(f, desk.value.rows[i].ed.part.grid, ", ")}`;
  };
  // the singers who follow singer i
  const followers = (i) => desk.value.rows.flatMap((r, j) => (r.follows?.leader === i ? [j] : []));
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
    return { title: d.title, master: d.master, chain: d.chain, singers: d.rows.map((r) => ({ level: r.level, pan: r.pan, mute: r.mute, solo: r.solo, ...(r.follows ? { follows: r.follows } : {}), part: r.ed.part })) };
  };
  // a score's singers as the desk's rows, each with an editor of its own
  const rowsOf = (s) => s.singers.map((x) => ({ level: x.level, pan: x.pan, mute: x.mute, solo: x.solo, ...(x.follows ? { follows: x.follows } : {}), ed: fresh(x.part) }));
  const changed = () => desk.value !== saved || desk.value.rows.some((r) => r.ed.changed);

  // ---------------------------------------------------------------- the key

  // The key the score is in (theory.js {tonic, scale}): the one chosen in the panel, or the one
  // every singer's notes fit best (detect), worked out again only when a part has changed. What
  // stops one being found is said in the panel. A phone has none: its roll is not tinted, and
  // its notes are not named by one.
  let found = { parts: [], ranked: null, why: null }; // ranked: detect's list, best first
  const finding = () => {
    const parts = desk.value.rows.map((r) => r.ed.part);
    if (parts.length !== found.parts.length || parts.some((p, i) => p !== found.parts[i])) {
      try {
        found = { parts, ranked: T.detect(parts.flatMap((p) => p.notes)), why: null };
      } catch (e) {
        found = { parts, ranked: null, why: e.message };
      }
    }
    return found;
  };
  const keyNow = () => (phone ? null : set.key ?? finding().ranked?.[0].key ?? null);
  // With Scale on, the key notes land in; null with it off. Refused where there is no key.
  const scaleKey = () => {
    if (!set.scale || phone) return null;
    const K = keyNow();
    if (!K) throw new Error("Scale is on, and the score has no key: choose one in the panel, or turn Scale off");
    return K;
  };
  // key k moved `steps` along K's scale, landing on it: a key off the scale goes first to the
  // scale's next key that way
  const land = (K, k, steps) => {
    if (!steps) return k;
    const d = Math.sign(steps);
    if (T.inKey(K, k)) return T.step(K, k, steps);
    const near = T.nearest(K, k, d);
    if (near === null) throw new Error(`${P.name(k)}: no key of ${T.names(K)} ${d > 0 ? "above" : "below"} it`);
    return T.step(K, near, steps - d);
  };
  // the steps along K's scale that take key k0 to the scale's key nearest t, on t's side of it
  const stepsTo = (K, k0, t) => {
    if (t === k0) return 0;
    const d = Math.sign(t - k0), s = T.nearest(K, t, d);
    if (s === null) throw new Error(`${P.name(t)}: no key of ${T.names(K)} ${d > 0 ? "above" : "below"} it`);
    return T.inKey(K, k0) ? T.distance(K, k0, s) : T.distance(K, T.nearest(K, k0, d), s) + d;
  };
  // The chosen notes `dt` ticks later and `steps` along K's scale, each landing on it and named
  // for it, its cents its own. Every note is worked out before any moves.
  function along(dt, steps, K) {
    const sel = ed.part.notes.filter((n) => ed.selected.has(n));
    if (!sel.length) return;
    dt = Math.max(dt, -Math.min(...sel.map((n) => n.at)));
    if (!dt && !steps) return;
    const to = new Map(sel.map((n) => [n, steps ? T.spell(K, land(K, P.key(n.pitch), steps)) : n.pitch]));
    ed.change(sel, (n) => ({ at: n.at + dt, pitch: to.get(n) }));
  }
  // the chosen notes up a key (down below 0): a step of the scale with Scale on; named for the key
  const pitched = (dk) => {
    const S = scaleKey();
    if (S) return along(0, dk, S);
    ed.move(0, dk, keyNow());
  };
  // a note made at key k, named for K where there is one
  const plant = (at, ticks, k, K) => {
    const n = ed.add(at, ticks, k, last.velocity), name = K ? T.spell(K, k) : n.pitch;
    if (name !== n.pitch) ed.set([n], { pitch: name });
  };
  // The key chosen, or with null found in the notes again; kept with the page's settings.
  function chooseKey(K) {
    if (K) T.names(K);
    set.key = K;
    shown();
    const now = keyNow();
    say(K ? `the key: ${T.names(K)}, chosen` : now ? `the key: ${T.names(now)}, found in the notes` : `no key: ${finding().why}`);
  }
  const percent = (x) => `${Math.round(x * 100)}%`;
  function toggleScale() {
    set.scale = !set.scale;
    shown();
    const K = keyNow();
    say(!set.scale ? "Scale off: notes go to any key" : K ? `Scale on: notes land on the notes of ${T.names(K)}` : "Scale on, and the score has no key yet: choose one in the panel");
  }
  // the panel's key: its tonic (or found in the notes), its scale, and where it came from
  let tonicsFor = null;
  function keyShown() {
    const f = finding(), K = keyNow(), tonic = $("key-tonic"), scale = $("key-scale");
    // with no key, the tonics are named as a major's
    const named = K ? K.scale : "major";
    if (tonicsFor !== named) {
      tonicsFor = named;
      const option = (value, text) => {
        const o = make("option", null, text);
        o.value = value;
        return o;
      };
      tonic.replaceChildren(option("", "from the notes"), ...Array.from({ length: 12 }, (_, t) => option(String(t), T.tonicName({ tonic: t, scale: named }))));
      if (!scale.children.length) scale.replaceChildren(...T.SCALE_NAMES.map((s) => option(s, s === "natural minor" ? "minor" : s)));
    }
    if (!focused(tonic)) tonic.value = set.key ? String(set.key.tonic) : "";
    if (!focused(scale)) scale.value = named;
    scale.disabled = !K;
    const top = f.ranked?.[0];
    $("key-said").textContent = set.key
      ? `${T.names(set.key)}, chosen.${top && top.name !== T.names(set.key) ? ` The notes fit ${top.name} best.` : ""}`
      : top ? `${top.name}, found in the notes: ${percent(top.inside)} of their time is on its scale. Next: ${f.ranked[1].name}, ${f.ranked[2].name}.`
      : `No key yet: ${f.why}. Choose one above.`;
  }

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

  // the rows under the roll, each its height unfolded, or a strip folded; none but the words on a phone
  const laneTall = (k) => (phone && k !== "words" ? 0 : phone || layout.lanes[k] ? { words: WORDS, velocity: LANES.vel, vibrato: LANES.vib }[k] : STRIP);
  const rows = () => {
    const [wordsH, velH, vibH] = ["words", "velocity", "vibrato"].map(laneTall);
    const roll = Math.max(40, H - RULER - wordsH - velH - vibH);
    return { roll, words: RULER + roll, vel: RULER + roll + wordsH, vib: RULER + roll + wordsH + velH, wordsH, velH, vibH };
  };
  const top = () => Math.max(2, ...ed.part.lanes.vibrato.map((q) => q.value)) * 1.05;
  const laneY = (value) => rows().vib + 6 + (1 - value / top()) * (rows().vibH - 12);
  const laneValue = (y) => Math.round(Math.max(0, Math.min(top(), (1 - (y - rows().vib - 6) / (rows().vibH - 12)) * top())) * 100) / 100;
  const velocityAt = (y) => Math.max(1, Math.min(127, Math.round((1 - (y - rows().vel - 4) / (rows().velH - 8)) * 127)));
  // the row under the roll at y: "words", "velocity" or "vibrato", or null above them
  const laneAt = (y) => {
    const r = rows();
    return y < r.words ? null : y < r.vel ? "words" : y < r.vib ? "velocity" : "vibrato";
  };
  const folded = (k) => !phone && !layout.lanes[k];
  const region = (x, y) => (x < GUT ? "keys" : y < RULER ? "ruler" : laneAt(y) ?? "roll");
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
    if (owed || fitted === seen()) refit();
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

    // the keys' rows: with a key, the rows of its scale lighter and its tonic's lightest, each
    // tonic named for the key at the left; with none, the piano's white and black
    const K = keyNow();
    clip(0, RULER, W, r.roll, () => {
      for (let k = Math.min(127, view.key(0)); k >= 0 && Y(k) < RULER + r.roll; k--) {
        const black = BLACK.includes(k % 12), d = K && T.degree(K, k), tonic = Boolean(d) && d.degree === 0 && d.offset === 0;
        ctx.fillStyle = K ? (tonic ? C.tonic : d.offset === 0 ? C.inKey : C.black) : black ? C.black : C.row;
        ctx.fillRect(GUT, Y(k), W - GUT, view.tall);
        if (view.tall >= 10 || k % 12 === 0) line(GUT, Y(k) + view.tall, W, Y(k) + view.tall, k % 12 === 0 ? C.beat : C.line);
        ctx.fillStyle = black ? C.keyBlack : C.keyWhite;
        ctx.fillRect(0, Y(k), GUT - 1, view.tall - 1);
        if (tonic) {
          ctx.fillStyle = C.tonicKey;
          ctx.fillRect(GUT - 5, Y(k), 4, view.tall - 1);
        }
        if ((k % 12 === 0 || tonic) && view.tall >= 9) {
          ctx.fillStyle = tonic ? C.ink : C.dim;
          ctx.fillText(K ? T.spell(K, k) : P.name(k), 6, Y(k) + view.tall / 2);
        }
      }
    });

    // bars, beats and the snap's steps, through the roll and the rows under it
    clip(GUT, 0, W - GUT, H, () => {
      const lines = bars(part, Math.max(0, from), to);
      const beatWide = g * view.wide;
      // the snap's steps and the beats only where they are well apart, so a roll seen whole is calm
      if (step * view.wide >= 14 && step < g) {
        for (let t = Math.ceil(Math.max(0, from) / step) * step; t <= to; t += step) line(X(t), RULER, X(t), RULER + r.roll, C.line);
      }
      // zoomed far out, a bar line every 2, 4, 8... bars, and a number where there is room for one
      const numbered = lines.filter((b) => b.bar !== null);
      const barWide = Math.min(...part.meter.map((m) => g * 4 / m.d * m.n)) * view.wide;
      const every = (px) => 2 ** Math.max(0, Math.ceil(Math.log2(px / barWide)));
      const lined = every(16), named = every(ctx.measureText(String(numbered.at(-1)?.bar ?? 1)).width + 12);
      for (const b of lines) {
        if (b.bar === null ? beatWide < 14 : (b.bar - 1) % lined !== 0) continue;
        line(X(b.tick), b.bar === null ? RULER : 0, X(b.tick), H, b.bar === null ? C.beat : C.bar);
        if (b.bar !== null && (b.bar - 1) % named === 0) {
          ctx.fillStyle = C.dim;
          ctx.fillText(String(b.bar), X(b.tick) + 4, 9);
        }
      }
      // the tempos and the meters, a change after the start marked where it falls, each kept for a
      // right click to find; and the breaths marked
      const marks = [...part.tempo.map((t) => ["tempo", t.at, `${t.bpm}`]), ...part.meter.map((m) => ["meter", m.at, `${m.n}/${m.d}`])].sort((a, b) => a[1] - b[1]);
      let lastX = -Infinity, lastAt = -1;
      rulerMarks = [];
      for (const [kind, at, label] of marks) {
        if (at > 0) line(X(at), 14, X(at), RULER, C.dim);
        const x = at === lastAt ? lastX : Math.max(X(at) + 4, lastX + 6), w = ctx.measureText(label).width;
        ctx.fillStyle = C.ink;
        ctx.fillText(label, x, 21);
        rulerMarks.push({ kind, at, x0: x, x1: x + w });
        [lastX, lastAt] = [x + w + 6, at];
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
          if (i === cur || unseen.has(row.ed)) return;
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
      // a follower's notes are its leader's: drawn with a broken edge
      const link = desk.value.rows[cur].follows;
      for (const n of part.notes) {
        if (n.at > to || n.at + n.ticks < from) continue;
        const x = X(n.at), w = Math.max(2, n.ticks * view.wide - 1), y = Y(P.key(n.pitch)), h = Math.max(2, view.tall - 1);
        const chosen = ed.selected.has(n);
        ctx.globalAlpha = 0.45 + 0.55 * n.velocity / 127;
        ctx.fillStyle = chosen ? C.chosen : color(cur);
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;
        if (link) {
          ctx.strokeStyle = C.ink;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
          ctx.setLineDash([]);
        }
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
      // a take being played into this singer: its notes as they are heard, a held one to now
      if (recording && recording.ed === ed && playing?.n === recording.n && playing.heard) {
        ctx.strokeStyle = ctx.fillStyle = C.ok;
        ctx.lineWidth = 1;
        for (const n of recording.take.notes(window.performance.now())) {
          const x = X(n.at), w = Math.max(2, n.ticks * view.wide - 1), y = Y(n.key), h = Math.max(2, view.tall - 1);
          ctx.globalAlpha = 0.25 + 0.5 * n.velocity / 127;
          ctx.fillRect(x, y, w, h);
          ctx.globalAlpha = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        }
      }
      if (band) {
        const [t0, k0, t1, k1] = band;
        ctx.strokeStyle = C.chosen;
        ctx.lineWidth = 1;
        ctx.strokeRect(X(Math.min(t0, t1)), Y(Math.max(k0, k1)), Math.abs(t1 - t0) * view.wide, (Math.abs(k1 - k0) + 1) * view.tall);
      }
      // whom this singer follows, or who follow it
      const led = followers(cur);
      if (link || led.length) {
        ctx.fillStyle = C.dim;
        ctx.fillText(link ? `Follows ${following(cur)}: its notes are made from ${name(link.leader)}'s` : `Followed by ${listed(led.map(name))}: a change here is theirs too`, GUT + 8, RULER + 10);
      }
    });

    // the words, the velocities and the vibrato under the roll: each named at the left, with a
    // mark to fold it or unfold it; folded, a strip with its name only
    for (const [y, k] of [[r.words, "words"], ...(phone ? [] : [[r.vel, "velocity"], [r.vib, "vibrato"]])]) {
      line(0, y, W, y, C.bar);
      ctx.fillStyle = C.dim;
      if (phone) {
        ctx.fillText(k, 6, y + 12);
        continue;
      }
      const open = !folded(k), cy = y + (open ? 12 : STRIP / 2);
      ctx.fillText(k, 15, cy);
      ctx.beginPath();
      if (open) {
        ctx.moveTo(5, cy - 2);
        ctx.lineTo(11, cy - 2);
        ctx.lineTo(8, cy + 2);
      } else {
        ctx.moveTo(6, cy - 3);
        ctx.lineTo(10, cy);
        ctx.lineTo(6, cy + 3);
      }
      ctx.fill();
    }
    clip(GUT, r.words, W - GUT, H - r.words, () => {
      part.notes.forEach((n, i) => {
        if (n.at > to || n.at + n.ticks < from) return;
        const x = X(n.at), w = Math.max(2, n.ticks * view.wide - 2), chosen = ed.selected.has(n);
        if (!folded("words")) {
          // a syllable kept to its note, and to the room before the next one starts
          const mid = r.words + r.wordsH / 2, next = part.notes[i + 1], room = Math.max(w, next ? X(next.at) - x - 3 : W);
          if (n.lyric === null) {
            ctx.fillStyle = C.bad;
            ctx.fillRect(x + 2, mid - 1, Math.min(6, w), 2);
          } else if (n.lyric === "_") {
            line(x, mid, x + w, mid, chosen ? C.chosen : C.dim);
          } else if (room >= 10) {
            const s = P.syllable(n.lyric);
            ctx.fillStyle = chosen ? C.chosen : C.ink;
            clip(x, r.words, room, r.wordsH, () => ctx.fillText(s.text + (s.on ? "-" : ""), x + 2, mid));
            if (s.end) line(x + w, r.words + 5, x + w, r.words + r.wordsH - 5, C.dim);
          } else {
            ctx.fillStyle = chosen ? C.chosen : C.dim;
            ctx.fillRect(x + 1, mid - 1, 2, 2);
          }
        }
        if (!phone && !folded("velocity")) {
          const V = r.velH, v = (n.velocity / 127) * (V - 8), up = (n.release / 127) * (V - 8);
          ctx.fillStyle = chosen ? C.chosen : color(cur);
          ctx.fillRect(x, r.vel + V - 4 - v, 3, v);
          ctx.fillRect(x - 2, r.vel + V - 4 - v, 7, 2);
          line(x + w, r.vel + V - 4, x + w, r.vel + V - 4 - up, C.dim);
        }
      });
      if (phone || folded("vibrato")) return;
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
    if (!phone && !folded("vibrato")) {
      ctx.fillStyle = C.dim;
      ctx.fillText(top().toFixed(1), GUT - 26, r.vib + 26);
      ctx.fillText("0", GUT - 12, r.vib + r.vibH - 8);
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
        closeTool(true);
        ed.begin();
        const n = first();
        held = n && { at: n.at, ticks: n.ticks, key: P.key(n.pitch), velocity: n.velocity, release: n.release };
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
        else ed.move(0, Math.round(v) - held.key, keyNow());
        spelled = null;
      },
    }));
    // the first to the number, the others chosen by as much: their differences kept
    const by = (k, lo) => (v) => ed.change([...ed.selected], (n) => ({ [k]: Math.max(lo, Math.min(127, n[k] + v - held[k])) }));
    put("n-velocity", note({ min: 1, max: 127, step: 1, whole: true, def: 80, label: "velocity", change: (v) => { by("velocity", 1)(v); last.velocity = v; } }));
    put("n-release", note({ min: 0, max: 127, step: 1, whole: true, def: 64, label: "release", change: by("release", 0) }));
    for (const k of SINGER) {
      put(`s-${k}`, {
        ...RANGE[k], def: P.singer("x")[k], label: k, said: told($("s-said")),
        begin: () => { closeTool(true); ed.begin(); },
        change: (v) => attempt(() => { ed.again(); ed.singer(k, v); }, $("s-said")),
        end: () => { ed.end(); refresh(); },
      });
    }
    // the tempo in force where Sing starts, every singer's alike
    put("tempo", {
      min: 30, max: 240, lo: 4, hi: 60000000, step: 1, fine: 0.1, def: 120, label: "tempo", title: "Tempo where singing starts, for every singer. Drag to change; click to type",
      show: (v) => `${v} bpm`,
      begin: () => { closeTool(true); desk.value.rows.forEach((r) => r.ed.begin()); },
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

  // ---------------------------------------------------------------- the layout

  const FOLDS = Object.keys(layout.folds);
  function keepLayout() {
    try {
      window.localStorage.setItem(LAYOUT, JSON.stringify(layout));
    } catch (e) {
      say(`the layout is not kept for the next visit: ${e.message}`, true);
    }
  }
  // the panel's sections as they are folded: on a phone, every one unfolded
  function folds() {
    for (const k of FOLDS) {
      const open = phone || layout.folds[k];
      $(`fold-${k}`).hidden = !open;
      $(`fold-${k}-head`).setAttribute("aria-expanded", String(open));
    }
  }
  function foldSection(k) {
    layout.folds[k] = !layout.folds[k];
    keepLayout();
    folds();
    sync();
  }
  // a row under the roll folded, or unfolded
  function foldLane(k) {
    layout.lanes[k] = !layout.lanes[k];
    keepLayout();
    refresh();
  }
  function togglePanel() {
    layout.panel = !layout.panel;
    keepLayout();
    refresh();
    size();
  }
  // Singer i's notes shown behind the one in sight's, or not. One shown turns Others on.
  function toggleSeen(i) {
    const e = desk.value.rows[i].ed, hide = !unseen.has(e);
    if (hide) unseen.add(e);
    else unseen.delete(e);
    if (!hide && !set.others) {
      set.others = true;
      shown();
    }
    say(hide ? `${name(i)}'s notes are not shown behind the others'` : `${name(i)}'s notes are shown behind the others'`);
    refresh();
  }
  // another singer's note shown behind this one's at a tick and key: {i, note}, or null
  function ghostAt(tick, key) {
    if (!set.others) return null;
    for (let i = desk.value.rows.length - 1; i >= 0; i--) {
      const r = desk.value.rows[i];
      if (i === cur || unseen.has(r.ed)) continue;
      const h = hit(r.ed.part, tick, key, 0);
      if (h) return { i, note: h.note };
    }
    return null;
  }
  // what a folded section holds, said beside its heading; nothing beside one unfolded
  function sums() {
    const n = first(), K = phone ? null : keyNow(), way = Ways.which(ed.part.singer);
    const sum = (k, text) => { $(`${k}-sum`).textContent = layout.folds[k] ? "" : text; };
    sum("note", ed.selected.size > 1 ? `${ed.selected.size} chosen` : n ? `${P.pitch(n)}${n.lyric && n.lyric !== "_" ? ` ${n.lyric}` : ""}` : "none chosen");
    sum("singer", `${name(cur)}`);
    sum("how", way ? way.name : "as set");
    sum("key", K ? `${T.names(K)}${set.scale ? ", Scale on" : ""}` : "none");
    sum("sound", [quality(), set.click.on ? "click on" : ""].filter(Boolean).join(", "));
    sum("play", [midi?.chosen ? "MIDI in" : "", keyboard ? "Keys" : "", stepping ? "Step" : ""].filter(Boolean).join(", "));
  }

  // a singer's tab in sight
  function show(i) {
    closeTool(true);
    if (worded) commitWord(false);
    // a step being played is the singer's it began in; the steps before are not taken back in another
    if (stepping && i !== cur) {
      closeStep();
      stepping.steps.forget();
    }
    cur = i;
    ed = desk.value.rows[i].ed;
    tab = "singer";
    point = null;
    refresh();
  }

  function addSinger(copy) {
    closeTool(true);
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
    closeTool(true);
    unstep();
    const rows = desk.value.rows;
    if (rows.length === 1) throw new Error("a score has one singer at least");
    const gone = name(i), freed = rows.flatMap((r, j) => (r.follows?.leader === i ? [name(j)] : []));
    // the others' links to their leaders by their places now; those that followed it, unlinked
    const next = rows.filter((_, j) => j !== i).map((r) => {
      if (!r.follows) return r;
      if (r.follows.leader === i) return unlinked(r);
      return r.follows.leader > i ? { ...r, follows: { ...r.follows, leader: r.follows.leader - 1 } } : r;
    });
    desk.commit({ ...desk.value, rows: next });
    cur = Math.min(i < cur ? cur - 1 : cur, rows.length - 2);
    ed = desk.value.rows[cur].ed;
    point = null;
    say(`${gone} is out of the score: Undo brings it back${freed.length ? `\n${listed(freed)} ${freed.length === 1 ? "follows" : "follow"} no one now: ${freed.length === 1 ? "its" : "their"} notes are ${freed.length === 1 ? "its" : "their"} own` : ""}`);
  }

  // a row as it is with no leader
  const unlinked = (r) => {
    const { follows, ...rest } = r;
    return rest;
  };
  const listed = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
  // Singer i unlinked from its leader: its notes its own from now on, one step of Undo.
  function unlink(i) {
    const r = desk.value.rows[i];
    if (!r.follows) throw new Error(`${name(i)} follows no one`);
    const leader = name(r.follows.leader);
    desk.commit({ ...desk.value, rows: desk.value.rows.map((x, j) => (j === i ? unlinked(x) : x)) });
    say(`${name(i)} no longer follows ${leader}: its notes are its own`);
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
    if (!phone) mixerTab.addEventListener("contextmenu", (e) => { e.preventDefault(); offer(e.clientX, e.clientY, { place: "mixer" }); });
  }
  function tabs() {
    const rows = desk.value.rows;
    const sig = JSON.stringify([rows.map((r, i) => [name(i), r.mute, r.solo, r.follows ?? null, unseen.has(r.ed)]), cur, tab, renaming]);
    if (sig === tabsBuilt) return;
    tabsBuilt = sig;
    let typing = null;
    const els = rows.map((r, i) => {
      const el = make("div", "tab"), dot = make("span", "dot");
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", String(tab === "singer" && i === cur));
      el.title = `${name(i)}${i < 9 ? ` (${i + 1})` : ""}${r.follows ? `: follows ${following(i)}` : ""}: double click to rename`;
      // the dot: pressed, this singer's notes shown behind the others' or not; hollow where not
      Object.assign(dot.style, { background: unseen.has(r.ed) ? "transparent" : color(i), borderColor: color(i) });
      dot.title = `${unseen.has(r.ed) ? "Show" : "Hide"} ${name(i)}'s notes behind the other singers'`;
      if (!phone) dot.addEventListener("click", (e) => {
        e.stopPropagation?.();
        attempt(() => toggleSeen(i));
      });
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
        if (r.follows) el.append(make("span", "flag follows", `follows ${r.follows.leader + 1}`));
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
        if (!phone) el.addEventListener("contextmenu", (e) => { e.preventDefault(); offer(e.clientX, e.clientY, { place: "tab", singer: i }); });
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
    // a follower's strip says whom it follows
    name: (i) => (desk.value.rows[i]?.follows ? `${name(i)}, following ${name(desk.value.rows[i].follows.leader)}` : name(i)),
    color,
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
    closeTool(true);
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
    $("side").hidden = tab === "mixer" || !layout.panel;
    $("side-toggle").setAttribute("aria-pressed", String(layout.panel));
    board.render(d);
    for (const k of ["at", "beats", "pitch", "velocity", "release"]) fields[`n-${k}`].able(Boolean(n));
    $("n-none").hidden = Boolean(n);
    $("n-rows").hidden = !n;
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
    // the way to sing its settings are, or "as set"
    const way = Ways.which(part.singer);
    if (!focused($("s-way"))) $("s-way").value = way?.name ?? "";
    $("s-way").title = way ? way.said : "These settings are no way's: pick one to set them all";
    // whom it follows, or who follow it
    const link = d.rows[cur].follows, led = followers(cur);
    $("s-follows").hidden = !link && !led.length;
    $("s-follows-text").textContent = link ? `Follows ${following(cur)}. Its notes, words and vibrato are made from ${name(link.leader)}'s; its settings and breath marks are its own.` : led.length ? `Followed by ${listed(led.map(name))}: a change to these notes is theirs too.` : "";
    $("s-unlink").hidden = !link;
    fields.tempo.set(tempoAt(part, cursor).bpm);
    if (!focused($("text"))) $("text").value = P.write(part);
    if (!focused($("words"))) $("words").value = draft?.ed === ed ? draft.text : typed(part.notes);
    $("words-all-row").hidden = !alike().length;
    counted();
    $("undo").disabled = !journal.past.length;
    $("redo").disabled = !journal.future.length;
    $("link-before").hidden = aside.value === null;
    soundShown();
    $("draw").setAttribute("aria-pressed", String(drawing));
    if (!phone) {
      keyShown();
      playShown();
    }
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
    if (!phone) sums();
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
    if (phone) {
      window.clearTimeout(linkTimer);
      linkTimer = window.setTimeout(() => linkFor(S.write(score())), 400);
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
  // mixer is in sight, or the window has no size) it is owed, and size() does it. A roll still
  // as the fit left it is fitted again when its size changes.
  let owed = false, fitted = null, refit = () => fit();
  const seen = () => `${view.left} ${view.wide} ${view.top} ${view.tall}`;
  // every note in view; on a phone, no narrower than a note of the middling length is wide enough
  // for its syllable to be read (the roll follows the singing along), and the keys as tall as the
  // singer in sight's notes allow, centred on them
  const READ = 26; // pixels
  function fit() {
    refit = fit;
    owed = W <= GUT;
    if (owed) return;
    const notes = desk.value.rows.flatMap((r) => r.ed.part.notes);
    view.fit({ ...ed.part, notes }, W - GUT, rows().roll);
    // on a desk every note's key in sight, the rows as tall as the roll gives them
    if (!phone && notes.length) {
      const keys = notes.map((n) => P.key(n.pitch)), lo = Math.min(...keys), hi = Math.max(...keys), roll = rows().roll;
      view.tall = Math.max(4, Math.min(20, roll / (hi - lo + 3)));
      view.top = Math.min(127, (hi + lo) / 2 + roll / view.tall / 2);
    }
    if (phone && notes.length) {
      const ticks = notes.map((n) => n.ticks).sort((a, b) => a - b)[Math.floor(notes.length / 2)];
      if (view.wide * ticks < READ) view.zoom(READ / (view.wide * ticks), 0);
      const mine = ed.part.notes.length ? ed.part.notes : notes, keys = mine.map((n) => P.key(n.pitch)), lo = Math.min(...keys), hi = Math.max(...keys), roll = rows().roll;
      view.tall = Math.max(12, Math.min(20, roll / (hi - lo + 3)));
      view.top = Math.min(127, (hi + lo) / 2 + roll / view.tall / 2);
    }
    fitted = seen();
  }
  // A roll to read, as a score opens: a beat BEAT pixels wide (wider where the whole score fits
  // so), from the start, or from the bar the singer in sight comes in on where that is further
  // on; the rows at least ROW tall, centred on that singer's notes in sight. On a phone, the fit.
  function frame() {
    if (phone) return fit();
    refit = frame;
    owed = W <= GUT;
    if (owed) return;
    const part = ed.part, g = part.grid, all = desk.value.rows.flatMap((r) => r.ed.part.notes), mine = part.notes.length ? part.notes : all;
    const end = Math.max(g * 16, ...all.map((n) => n.at + n.ticks)), wide = W - GUT, roll = rows().roll;
    view.wide = Math.max(0.002, Math.min(4, Math.max(BEAT / g, wide / (end * 1.05))));
    const first = mine.length ? Math.min(...mine.map((n) => n.at)) : 0;
    view.left = first < wide / view.wide / 4 ? 0 : Tm.barLine(part, first);
    const right = view.left + wide / view.wide, near = mine.filter((n) => n.at < right && n.at + n.ticks > view.left);
    if (near.length) {
      const keys = near.map((n) => P.key(n.pitch)), lo = Math.min(...keys), hi = Math.max(...keys);
      view.tall = Math.max(ROW, Math.min(22, roll / (hi - lo + 3)));
      view.top = Math.min(127, (hi + lo) / 2 + roll / view.tall / 2);
    }
    fitted = seen();
  }
  // the chosen notes filling the roll, with a little room round them
  function fitChosen() {
    const sel = ed.part.notes.filter((n) => ed.selected.has(n)), roll = rows().roll;
    const t0 = Math.min(...sel.map((n) => n.at)), t1 = Math.max(...sel.map((n) => n.at + n.ticks)), span = Math.max(t1 - t0, ed.part.grid);
    view.wide = Math.max(0.002, Math.min(4, (W - GUT) / (span * 1.2)));
    view.left = Math.max(0, t0 - span * 0.1);
    const keys = sel.map((n) => P.key(n.pitch)), lo = Math.min(...keys), hi = Math.max(...keys);
    view.tall = Math.max(6, Math.min(30, roll / (hi - lo + 5)));
    view.top = Math.min(127, (hi + lo) / 2 + roll / view.tall / 2);
  }

  // A score in the desk's place, as a file opened gives it, its key found in its notes. Undo
  // brings the last one back.
  function open(s) {
    S.check(s);
    closeTool(true);
    stop();
    unrender(true);
    // step input goes on in the score opened, from its start
    if (stepping) {
      closeStep();
      stepping = { steps: new MI.Steps({ at: 0, ticks: stepping.steps.ticks }) };
    }
    const rows = rowsOf(s);
    desk.commit({ title: s.title, master: s.master, chain: s.chain, rows });
    saved = desk.value;
    [cur, ed, tab, point, cursor, renaming] = [0, rows[0].ed, "singer", null, 0, null];
    set.key = null;
    unloop();
    frame();
  }

  // A file's bytes as the score: a MIDI file (a track of it, or each a singer), a score's text,
  // a part's, or a sound file the editor saved (the score inside it).
  function take(bytes, file, pick = null) {
    attempt(() => {
      try {
        if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE") {
          const text = scoreOf(bytes);
          if (text === null) throw new Error("a sound file with no score in it: the editor opens scores, parts and MIDI files, and the sound files it saved");
          const s = S.read(text);
          open(s);
          say(`${file}: the score it was made from, ${s.singers.length} ${s.singers.length === 1 ? "singer" : "singers"}, ${s.singers.reduce((n, x) => n + x.part.notes.length, 0)} notes`);
        } else if (M.is(bytes)) {
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
    // all of it played, and the last of it out of the machine: a take played against it kept
    if (playing.ended !== null && audio.currentTime * RATE - playing.ended >= latency() * RATE) {
      const took = finishTake();
      playing = null;
      if (took.line) {
        say(took.line.slice(1), took.bad);
        refresh();
      }
      return paintSoon();
    }
    if (recording?.n === n) rounded();
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
    if (rendering && rendering.jobs.has(m.id)) return rendered(m);
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
      const from = placed(HEAD, m);
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
    const was = soundGone();
    if (requalify()) say(`every singer is sung in ${by}${was}`);
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

  // The singing let go of, the speaker told nothing; a take played against it kept. What is said
  // of the take: {line ("" or a line to add, from a new line), bad}.
  function halt() {
    if (!playing) return NOTHING;
    const took = finishTake();
    window.clearTimeout(playing.timer);
    for (const [job, { t }] of playing.jobs) worker(t.slot).postMessage({ type: "stop", ids: [job] });
    playing = null;
    paintSoon();
    return took;
  }
  // the singing stopped, and a sound file being made let go of: the workers are the same
  function stop() {
    unrender();
    if (!playing) return NOTHING;
    const took = halt();
    tell({ type: "stop" });
    return took;
  }
  // a press that stops the singing: said, with the take kept, where one was played
  function stopped() {
    const was = soundGone(), took = stop();
    say(`stopped${was}${took.line}`, took.bad);
  }

  // The singers that can be sung: every one with notes. One whose part cannot be sung yet is shown
  // and refused by its note; unless it is muted.
  function singable() {
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
    return todo;
  }

  // Every singer that has notes is sung, from the place set (or `at`): round the loop where it is
  // on. A singer whose part cannot be sung yet stops it, by its note; unless it is muted.
  function sing(at = null) {
    attempt(() => {
      const rows = desk.value.rows, todo = singable(), was = soundGone();
      const took = stop();
      speak();
      // Round a loop, the loop's stretch is sung, from the place set where that is inside it and
      // from its start where not. With no loop, the score from the place set to its end.
      const part = rows[0].ed.part, want = at ?? cursor;
      const loop = set.loop.on && looped() ? { from: set.loop.from, to: set.loop.to } : null;
      const start = loop ? (want > loop.from && want < loop.to ? want : loop.from) : want;
      playing = { n: ++runs, loop, start, at: tickAfter(part), secs: clock(part), time: timeOf(part), together: oneClock(), meter: part.meter, tracks: new Map(), jobs: new Map(), seen: new Map(rows.map((r) => [r.ed, r.ed.part])), began: false, line: null, floor: 0, end: 0, heard: null, ended: null, timer: null, t0: window.performance.now() };
      for (const i of todo) ask(i, false);
      if (recordOn && !phone) startTake(start, 0);
      say(`${todo.length > 1 ? `${todo.length} singers are getting ready` : "the singer is getting ready"}${was}${recording ? `; recording into ${name(cur)} once it is heard` : ""}${took.line}`, took.bad);
    });
  }

  // ---------------------------------------------------------------- the score as a sound file

  // The whole score as a WAV, as Sing from the start plays it: every singer heard sung by the
  // workers, laid on the speaker's line, and mixed by the mix's own strips and chain faster than
  // it plays (render.js); no click, no loop. Editing goes on meanwhile: the file is the score as
  // it was when pressed. It is offered as a link to press, as a browser saves or shares a file
  // only on a press of its own.
  function making() {
    return rendering !== null && rendering.url === null;
  }
  function saveSound() {
    attempt(() => {
      can(window);
      if (!routes) throw new Error("the site has not said yet how it sings: press Save sound again in a moment");
      const todo = singable(), s = score(), heard = strips(s), sung = todo.filter((i) => heard[i].gain > 0);
      if (!sung.length) throw new Error("nothing would be heard: every singer with notes is muted, or another is soloed");
      stop();
      unrender(true);
      requalify();
      const file = `${stem(s.title, "score")}.wav`, singers = sung.map((i) => ({ slot: i, job: ++jobs, name: name(i) }));
      const gather = new Gather({ window, rate: RATE, head: HEAD, singers, tail: tail(s.chain, RATE), budget: phone ? BUDGET.phone : BUDGET.desk });
      const r = (rendering = { n: ++renders, score: s, file, count: sung.length, gather, jobs: new Map(singers.map((x) => [x.job, x.slot])), t0: window.performance.now(), shown: -1, lock: null, sleepy: null, url: null, share: null });
      // on one clock where more than one singer has notes, muted ones too, as Sing has it
      const together = oneClock();
      for (const x of singers) worker(x.slot).postMessage({ type: "sing", id: x.job, part: s.singers[x.slot].part, step: 20, together });
      awake(r);
      say(`making ${file}: ${sung.length === 1 ? "the singer is" : `${sung.length} singers are`} getting ready`);
    });
  }
  // the sound file being made let go of, at a press
  function cancelSound() {
    const r = rendering;
    if (!making()) throw new Error("no sound file is being made");
    unrender();
    say(`stopped making ${r.file}`);
  }

  // a worker's word on the sound file: its singers' sound gathered, how far it is said
  function rendered(m) {
    const r = rendering;
    if (m.type === "done" || m.type === "error") r.jobs.delete(m.id);
    let got;
    try {
      got = r.gather.told(m);
    } catch (e) {
      unrender();
      if (e.at !== undefined && e.at !== null) {
        show(e.slot);
        ed.select(ed.part.notes.filter((n) => n.at === e.at));
        reveal(e.at);
      }
      say(`${r.file}: ${e.message}`, true);
      return refresh();
    }
    if (got.done) return mixed(r);
    const pc = got.progress === null ? null : Math.floor(100 * got.progress);
    if (pc !== null && pc !== r.shown) {
      r.shown = pc;
      say(`making ${r.file}: singing ${r.count === 1 ? "" : `${r.count} singers, `}${pc}%${r.sleepy ? `\n${r.sleepy}` : ""}`);
    }
  }

  // every singer sung: the line mixed, made a WAV, and offered
  async function mixed(r) {
    say(`making ${r.file}: mixing`);
    let wave;
    try {
      const line = r.gather.line();
      r.gather = null;
      const out = await mixdown({ window, score: r.score, line, rate: RATE, speaker: new URL("./speaker.js", import.meta.url) });
      if (rendering !== r) return; // let go of while it mixed
      wave = wav({ channels: [out.left, out.right], rate: RATE, title: r.score.title, cue: cue(HEAD, line, out.late, RATE), score: S.write(r.score) });
    } catch (e) {
      if (rendering === r) unrender();
      return say(`${r.file}: ${e.message}`, true);
    }
    const bytes = wave.bytes, secs = wave.frames / RATE;
    r.url = window.URL.createObjectURL(new window.Blob([bytes], { type: "audio/wav" }));
    const shared = new window.File([bytes], r.file, { type: "audio/wav" });
    r.share = window.navigator.canShare?.({ files: [shared] }) ? shared : null;
    const a = $("sound-save");
    a.href = r.url;
    a.download = r.file;
    a.textContent = `Save ${r.file} (${(bytes.length / 2 ** 20).toFixed(1)} MB, ${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")})`;
    $("sound-share").hidden = !r.share;
    asleep(r);
    soundShown();
    const also = [...(wave.clipped ? ["some of it is louder than a sound file holds, and is cut flat there: a limiter last in the master chain keeps it under"] : []), ...(wave.ringing ? ["it was still sounding where the file ends"] : [])];
    say(`${r.file} is ready: ${r.count === 1 ? "1 singer" : `${r.count} singers`}, ${secs.toFixed(1)} s, made in ${((window.performance.now() - r.t0) / 1000).toFixed(1)} s. It is the score as it was when Save sound was pressed, and the score is inside it: open it in the editor to edit it again${also.length ? `\n${also.join("\n")}` : ""}`);
  }

  // The sound file being made let go of: its singing stopped, the screen let sleep. With `all`, a
  // file made is let go of too, and its link.
  function unrender(all = false) {
    const r = rendering;
    if (!r || (r.url && !all)) return;
    rendering = null;
    for (const [job, slot] of r.jobs) pool[slot % WORKERS]?.postMessage({ type: "stop", ids: [job] });
    if (r.url) window.URL.revokeObjectURL(r.url);
    asleep(r);
    soundShown();
  }
  // what a press that lets a sound file being made go says of it
  function soundGone() {
    return making() ? `; ${rendering.file} is let go of` : "";
  }
  // the buttons as the sound file is: Save sound, or Cancel while one is made; the file to press once made
  function soundShown() {
    $("save-sound").textContent = making() ? "Cancel sound" : "Save sound";
    $("save-sound").hidden = !making();
    $("sound-make").textContent = making() ? "Stop making the sound file" : "Save as sound";
    $("sound-ready").hidden = !(rendering && rendering.url);
  }

  // the screen kept awake while a sound file is made, where the browser lets a page keep it so
  function awake(r) {
    if (!window.navigator.wakeLock) {
      r.sleepy = "the screen may sleep and pause the sound file: this browser does not let a page keep it awake";
      return;
    }
    window.navigator.wakeLock.request("screen").then((lock) => {
      if (rendering === r && !r.url) r.lock = lock;
      else lock.release().catch((e) => say(`the screen's wake lock: ${e.message}`, true));
    }, (e) => {
      r.sleepy = `the screen may sleep and pause the sound file: ${e.message}`;
    });
  }
  function asleep(r) {
    if (!r.lock) return;
    r.lock.release().catch((e) => say(`the screen's wake lock: ${e.message}`, true));
    r.lock = null;
  }

  // ---------------------------------------------------------------- the score as a link (share.js)

  // The page's own address, with no hash, that a link to a score starts with.
  function linkBase() {
    return window.location.origin + window.location.pathname;
  }
  // the link to the score `text`, made once: a refusal kept in its `why`, said when it is asked for
  function linkFor(text) {
    if (linking?.text === text) return linking;
    const l = (linking = { text, made: null, url: null, why: null });
    l.made = Promise.resolve().then(() => SH.link(linkBase(), text)).then((url) => { l.url = url; }, (e) => { l.why = e; });
    return l;
  }
  const linkLong = (url) => {
    const apps = SH.cut(url.length).map((c) => c.app);
    return `${url.length.toLocaleString("en-US")} characters${apps.length ? `; too long for a ${apps.join(" or ")} message` : ""}`;
  };
  // A link to the score as it is now: on a desk to the clipboard, on a phone to the share sheet.
  // Each is started within the press, as a browser lets a page use them only there.
  function copyLink() {
    const l = linkFor(S.write(score())), nav = window.navigator;
    if (phone) {
      if (typeof nav.share !== "function" || !nav.canShare?.({ url: linkBase() })) throw new Error("this browser has no share sheet for a link");
      const go = (url) => nav.share({ title: score().title || "a score", url }).then(
        () => say(`the link is shared: ${linkLong(url)}`),
        (e) => say(e.name === "AbortError" ? "the link is not shared" : `the link is not shared: ${e.message}`, e.name !== "AbortError"),
      );
      if (l.why) throw l.why;
      if (l.url) return go(l.url);
      say("the link is being made");
      return l.made.then(() => (l.why ? say(l.why.message, true) : go(l.url)));
    }
    if (typeof nav.clipboard?.write !== "function" || typeof window.ClipboardItem !== "function") throw new Error("this browser does not let a page put a link on the clipboard");
    const blob = l.made.then(() => {
      if (l.why) throw l.why;
      return new window.Blob([l.url], { type: "text/plain" });
    });
    say("the link is being made");
    return nav.clipboard.write([new window.ClipboardItem({ "text/plain": blob })]).then(
      () => say(`a link to this score is on the clipboard: ${linkLong(l.url)}`),
      (e) => say(l.why ? l.why.message : `the link is not on the clipboard: ${e.message}`, true),
    );
  }
  // the score put aside when a link opened another, opened again, and so no longer put aside:
  // one step of Undo
  function backToMine() {
    if (aside.value === null) throw new Error("no score was put aside for a link");
    const s = S.read(aside.value);
    together(() => {
      open(s);
      aside.commit(null);
    });
    say(`your score from before the link: ${s.singers.length} ${s.singers.length === 1 ? "singer" : "singers"}, ${s.singers.reduce((n, x) => n + x.part.notes.length, 0)} notes. Undo brings back the link's`);
    stash();
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
    // step input goes on from the place set: refused while a step is being played
    if (stepping) stepping.steps.place(tick);
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
      say(`the loop, the click and the key are not kept for the next visit: ${e.message}`, true);
    }
  }
  // the buttons and fields as the page is set
  function shown() {
    $("loop").setAttribute("aria-pressed", String(set.loop.on));
    $("click").setAttribute("aria-pressed", String(set.click.on));
    $("scale").setAttribute("aria-pressed", String(set.scale));
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
    // the words row unfolded for the syllable typed into it
    if (folded("words")) {
      layout.lanes.words = true;
      keepLayout();
    }
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
    // a right click (ctrl and a click on a Mac) is the menu's (offer()), not a press on the roll
    if (e.button > 0 || (e.ctrlKey && apple)) return;
    if (worded) commitWord(false);
    canvas.focus();
    const [x, y] = at(e), where = region(x, y), lane = laneAt(y);
    // a row under the roll folded or unfolded at its name; a folded one unfolded anywhere along it
    if (lane && !phone && (x < GUT || folded(lane))) return attempt(() => foldLane(lane));
    // a tool's panel is kept and closed by a press on the roll; on the ruler it stays, so the
    // place sung from can be moved while it is open
    if (where !== "ruler") closeTool(true);
    const part = ed.part, tick = tickAt(x), key = keyAt(y);
    const twice = e.timeStamp - tapped.at < 400 && Math.hypot(x - tapped.x, y - tapped.y) < 5;
    tapped = { at: twice ? -Infinity : e.timeStamp, x, y };
    canvas.setPointerCapture?.(e.pointerId);
    if (where === "roll") {
      const h = hit(part, tick, key, 7 / view.wide);
      point = null;
      if (h) {
        if (e.shiftKey) {
          ed.select([h.note], true);
          // taken out of the choice: nothing to drag
          if (!ed.selected.has(h.note)) return refresh();
        } else if (!ed.selected.has(h.note)) ed.select([h.note]);
        // the key the notes are named for, and with Scale on the one they land in, as the drag began
        const S = h.end && !e.altKey ? null : attempt(scaleKey);
        if (S === undefined) return;
        if (e.altKey) {
          // alt: the chosen notes dragged out as a copy, the notes themselves left where they are
          const sel = ed.part.notes.filter((n) => ed.selected.has(n)), clip = attempt(() => Clip.take(part, sel));
          if (!clip) return;
          ed.begin();
          drag = { kind: "copy", tick, key, note: h.note, clip, start: sel[0].at, made: null, K: keyNow(), scale: S };
          return refresh();
        }
        ed.begin();
        drag = { kind: h.end ? "stretch" : "move", tick, key, note: h.note, K: keyNow(), scale: S };
      } else if (drawing || twice) {
        // with Scale on, the note lands on the key's note nearest the press
        const S = attempt(scaleKey);
        if (S === undefined) return;
        const from = Math.floor(tick / step) * step, k = S ? T.nearest(S, key, 0) : key, K = keyNow();
        ed.begin();
        drag = { kind: "draw", from, key: k, x, sized: false, K };
        attempt(() => plant(from, last.ticks, k, K));
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
        drag = { kind: "velocity", note: n };
        move(e);
      }
    } else if (where === "keys" && y >= RULER && y < rows().words) {
      // a key in the gutter: every note on it chosen; with shift, added to those chosen
      const on = part.notes.filter((n) => P.key(n.pitch) === key);
      ed.select(e.shiftKey ? [...ed.selected, ...on] : on);
      point = null;
      say(on.length ? `${on.length} ${on.length === 1 ? "note" : "notes"} on ${P.name(key)}` : `no note on ${P.name(key)}`);
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
      const where = region(x, y), lane = laneAt(y);
      const h = where === "roll" && hit(ed.part, tickAt(x), keyAt(y), 7 / view.wide);
      canvas.style.cursor = lane && !phone && (x < GUT || folded(lane)) ? "pointer" : h ? (e.altKey ? "copy" : h.end ? "ew-resize" : "grab") : where === "vibrato" && pointAt(x, y) >= 0 ? "grab" : where === "words" ? "text" : where === "ruler" ? (loopEnd(x) ? "ew-resize" : "col-resize") : "default";
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
      // by keys, named for the key; with Scale on, by the scale's steps, landing on its notes
      const dt = snap(drag.note.at + tick - drag.tick, step) - drag.note.at, k0 = P.key(drag.note.pitch);
      ed.again();
      attempt(() => (drag.scale ? along(dt, stepsTo(drag.scale, k0, k0 + key - drag.key), drag.scale) : ed.move(dt, key - drag.key, drag.K ?? null)));
    } else if (drag.kind === "copy") {
      // the copy as far as the part's start and the keyboard's ends let it go (with Scale on, along
      // the scale); none where it has not moved
      const keys = drag.clip.notes.map((n) => P.key(n.pitch)), k0 = P.key(drag.note.pitch);
      const dt = Math.max(-drag.start, snap(drag.note.at + tick - drag.tick, step) - drag.note.at);
      ed.again();
      drag.made = null;
      attempt(() => {
        let notes = drag.clip.notes;
        if (drag.scale) {
          const s = stepsTo(drag.scale, k0, k0 + key - drag.key);
          if (s) notes = notes.map((n) => ({ ...n, pitch: T.spell(drag.scale, land(drag.scale, P.key(n.pitch), s)) }));
        } else {
          const dk = Math.max(-Math.min(...keys), Math.min(127 - Math.max(...keys), key - drag.key));
          if (dk) notes = notes.map((n) => ({ ...n, pitch: T.moved(n.pitch, dk, drag.K) }));
        }
        if (!dt && notes === drag.clip.notes) return;
        const clip = notes === drag.clip.notes ? drag.clip : { ...drag.clip, notes };
        const r = Clip.paste(ed.part, clip, drag.start + dt);
        ed.commit(r.part, new Set(r.notes));
        drag.made = { at: drag.start + dt, n: r.notes.length, said: r.said };
      });
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
      attempt(() => plant(drag.from, ticks, drag.key, drag.K));
      last.ticks = ticks;
    } else if (drag.kind === "band") {
      band = [drag.tick, drag.key, tick, key];
      const [t0, t1] = [Math.min(drag.tick, tick), Math.max(drag.tick, tick)], [k0, k1] = [Math.min(drag.key, key), Math.max(drag.key, key)];
      const inside = ed.part.notes.filter((n) => n.at < t1 && n.at + n.ticks > t0 && P.key(n.pitch) >= k0 && P.key(n.pitch) <= k1);
      ed.select([...drag.had, ...inside]);
      refresh();
    } else if (drag.kind === "velocity") {
      // the note pressed to where the mouse is, the others chosen by as much: their differences kept
      const velocity = velocityAt(y), by = velocity - drag.note.velocity;
      ed.again();
      attempt(() => ed.change([...ed.selected], (n) => ({ velocity: Math.max(1, Math.min(127, n.velocity + by)) })));
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
    const made = drag.kind === "copy" ? drag.made : null;
    drag = null;
    band = null;
    ed.end();
    if (made) say([`${made.n} ${made.n === 1 ? "note" : "notes"} copied to beat ${P.beat(made.at, ed.part.grid)}`, ...made.said].join("\n"));
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
  // a step being played is closed first, and step input does not take back what Undo took
  const unstep = () => {
    if (!stepping) return;
    closeStep();
    stepping.steps.forget();
  };
  function back() {
    closeTool(true);
    unstep();
    const g = journal.past.pop();
    if (!g) return;
    for (const h of [...g].reverse()) h.undo();
    journal.future.push(g);
    landed(g);
  }
  function forth() {
    closeTool(true);
    unstep();
    const g = journal.future.pop();
    if (!g) return;
    for (const h of g) h.redo();
    journal.past.push(g);
    landed(g);
  }

  // ---------------------------------------------------------------- the clipboard

  const each = (n) => `${n} ${n === 1 ? "note" : "notes"}`;
  // a text box's own keys and clipboard, not the roll's
  const typingIn = (t) => Boolean(t) && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable === true);

  // The chosen notes as a clip's text (clip.js), for the clipboard, the system's only: the page
  // keeps no clipboard of its own. A cut takes them out of the part as one step of Undo.
  function lift(cut) {
    const notes = ed.part.notes.filter((n) => ed.selected.has(n)), text = Clip.copy(ed.part, notes);
    if (cut) ed.remove();
    say(`${each(notes.length)} ${cut ? "cut: Undo brings them back" : "copied"}`);
    return { text, n: notes.length };
  }
  // and onto the system clipboard: where the browser gives the page none, nothing is copied or
  // cut; where it refuses them, that is said, and a cut is Undo's to bring back
  const NO_BOARD = "this browser gives the page no clipboard here (it has one at an https address, 127.0.0.1 or localhost)";
  function lifted(cut) {
    const system = window.navigator.clipboard;
    if (!system?.writeText) throw new Error(`nothing is ${cut ? "cut" : "copied"}: ${NO_BOARD}`);
    const { text, n } = lift(cut);
    system.writeText(text).then(null, (e) => say(`the ${each(n)} ${cut ? "cut" : "copied"} are not on the clipboard: the browser would not put them there (${e.message})${cut ? ". Undo brings them back" : ""}`, true));
  }

  // A clip's text pasted into the singer `into` (an editor) at tick `at`, the pasted notes chosen
  // and the singer in sight; `over`, over the notes it covers.
  function drop(into, text, at, over) {
    const i = desk.value.rows.findIndex((r) => r.ed === into);
    if (i < 0) throw new Error("the singer to paste into is out of the score");
    const r = Clip.paste(into.part, Clip.read(text), at, { over });
    into.commit(r.part, new Set(r.notes));
    if (tab !== "singer" || cur !== i) show(i);
    point = null;
    reveal(at);
    say([`${each(r.notes.length)} pasted${over ? " over the notes there" : ""} at beat ${P.beat(at, into.part.grid)}`, ...r.said].join("\n"));
  }
  // A paste with no paste event (the menu, the palette, shift cmd V): the clipboard read where the
  // browser lets the page; where it does not, nothing is pasted, and said why.
  function fetchPaste(at, over) {
    const into = ed, system = window.navigator.clipboard;
    const refused = (why) => say(`nothing is pasted: the browser would not let the page read the clipboard (${why})`, true);
    if (!system?.readText) return refused(NO_BOARD);
    system.readText().then((text) => attempt(() => together(() => drop(into, text, at, over))), (e) => refused(e.message));
  }
  // cmd V: the browser's paste event brings the clipboard (pasted()). Where it sends none, as a
  // browser may on a page with nothing to type in, the clipboard is read as from the menu.
  let awaited = null;
  function awaitPaste() {
    const p = (awaited = { at: cursor });
    window.setTimeout(() => {
      if (awaited !== p) return;
      awaited = null;
      fetchPaste(p.at, false);
    }, 0);
  }
  function pasted(e) {
    if (typingIn(e.target) || tab === "mixer") return;
    const p = awaited;
    awaited = null;
    e.preventDefault();
    attempt(() => together(() => drop(ed, e.clipboardData.getData("text/plain"), p ? p.at : cursor, false)));
  }

  // The chosen notes again right after themselves (clip.js duplicate), the copy chosen.
  function duplicate() {
    const r = Clip.duplicate(ed.part, ed.part.notes.filter((n) => ed.selected.has(n)), step);
    ed.commit(r.part, new Set(r.notes));
    reveal(r.at);
    say([`${each(r.notes.length)} again at beat ${P.beat(r.at, ed.part.grid)}`, ...r.said].join("\n"));
  }

  // ---------------------------------------------------------------- notes played in (midiin.js)

  // Notes from a MIDI keyboard, or from the computer's keys while "Keys play notes" is on, go into
  // the singer in sight: with Step on a step at a time where Sing starts, each step one step of
  // Undo; with Record on as they are heard while the score sings, each take one step of Undo. What
  // is played sounds only once it is written: the engine sings words, not a key at a time.
  const b = (tick) => P.beat(tick, ed.part.grid);
  // a step's length in words: "1/4 of a beat"
  const lengthSaid = (ticks) => {
    const s = steps(ed.part.grid).find((o) => o.ticks === ticks);
    return s && s.name !== "tick" ? (s.name === "1 beat" ? "a beat" : `${s.name} of a beat`) : `${b(ticks)} beats`;
  };
  // a key played, landing on the key's notes while Scale is on, as a note drawn does
  function scaled(ev) {
    if (ev.type !== "on" && ev.type !== "off") return ev;
    const S = scaleKey();
    if (!S) return ev;
    const k = T.nearest(S, ev.key, 0);
    if (k === null) throw new Error(`${P.name(ev.key)}: no note of ${T.names(S)} near it`);
    return { ...ev, key: k };
  }
  const TAKES = new Set(["on", "off", "wheel", "sustain", "bend", "other"]); // what a take records
  // A note, a pedal, a wheel or a step input key played: to the take where one is played, to step
  // input where it is on; a note with neither says so.
  function playIn(ev) {
    if (ev.type === "octave") return say(`the keys: ${keysSaid()}`);
    if (ev.type === "leave") return leaveKeys(true);
    if (recording && TAKES.has(ev.type) && playing?.n === recording.n) return void recording.take.take(scaled(ev));
    if (stepping) return stepIn(ev);
    if (ev.type === "on") say(`${P.name(ev.key)}: nothing takes notes now. Turn on Step to write them where Sing starts, or Record and Sing to record them`);
    else if (!TAKES.has(ev.type)) say("the right arrow, Backspace, [ and ] are step input's: turn on Step");
  }

  // ---- step input

  function stepOn() {
    if (tab === "mixer") throw new Error("step input writes into the singer in sight: choose a singer's tab");
    closeTool(true);
    const steps = new MI.Steps({ at: cursor, ticks: step }), words = draft?.ed === ed ? syllables(draft.text) : [];
    if (words.length) steps.words(words);
    stepping = { steps };
    return words.length;
  }
  function toggleStep() {
    if (stepping) {
      closeStep();
      stepping = null;
      return say("step input is off");
    }
    const n = stepOn();
    say(`step input at beat ${b(cursor)}: each note played goes in there, ${lengthSaid(step)} long, and on to the next${n ? `; each takes the next of the ${n} syllables typed in Words` : ""}. ${keyboard ? "The keys A to K play" : midi?.chosen ? "Play the MIDI keyboard" : "Play with Keys (shift K) or MIDI in"}`);
  }
  // a step being played closed, as though every key and the pedal came up
  function closeStep() {
    const x = stepping?.steps.lift();
    if (x && ed.drag) MI.apply(ed, x);
  }
  // a step input event made on the singer in sight, and where it leaves the place Sing starts said
  function stepIn(ev) {
    if (tab === "mixer") throw new Error("step input writes into the singer in sight: choose a singer's tab");
    const st = stepping, was = st.steps.next, x = st.steps.take(scaled(ev));
    if (!x) return;
    closeTool(true);
    const K = keyNow();
    if (x.op === "step" && K) x.notes = x.notes.map((n) => ({ ...n, pitch: T.spell(K, P.key(n.pitch)) }));
    try {
      MI.apply(ed, x);
    } catch (e) {
      // the step is not written: none open, none to take back, the syllable and the place as they were
      st.steps.lift();
      st.steps.next = was;
      st.steps.place(cursor);
      st.steps.forget();
      throw e;
    }
    if (x.op === "length") return say(`step input: a step is ${lengthSaid(x.ticks)} now`);
    cursor = x.cursor;
    reveal(cursor);
    const lyric = x.op === "step" && x.notes[0].lyric !== null ? ` on "${x.notes[0].lyric}"` : "";
    say(x.op === "step" ? `${x.notes.map(P.pitch).join(" ")} at beat ${b(x.at)}, ${lengthSaid(x.ticks)}${lyric}${x.open ? "" : `; on to beat ${b(x.cursor)}`}`
      : x.op === "rest" ? `a rest at beat ${b(x.at)}; on to beat ${b(x.cursor)}` : `the step at beat ${b(x.at)} taken back`);
  }

  // ---- the computer's keys

  const keysSaid = () => `A W S E D F T G Y H U J K are ${keyboard.low} to ${P.name(12 * (keyboard.octave + 2))}; Z and X move them an octave; Escape gives the keys back`;
  function toggleKeys() {
    if (keyboard) return leaveKeys(false);
    const also = !stepping && !recordOn ? (stepOn(), " Step input is on: each note goes in where Sing starts.") : "";
    keyboard = new MI.Keys({ octave });
    say(`Keys play notes: ${keysSaid()}. While it is on those keys do not do their commands; with shift, cmd, ctrl or alt they do.${also}`);
  }
  // the keys given back to the editor, a key still down let go; with `all`, step input left too
  function leaveKeys(all) {
    const k = keyboard;
    keyboard = null;
    octave = k.octave;
    for (const ev of k.lift(window.performance.now())) playIn(ev);
    if (all && stepping) {
      closeStep();
      stepping = null;
    }
    say(all ? "Keys play notes and step input are off: the keys are the editor's again" : "Keys play notes is off: the keys are the editor's again");
  }
  // every key and the pedal let go, as where the window loses the keys
  function letGoAll() {
    if (keyboard) for (const ev of keyboard.lift(window.performance.now())) playIn(ev);
    closeStep();
  }

  // ---- a take: what is played while the score sings, written where it was heard

  // The sample of the line heard now, a loop's rounds counted on rather than folded back.
  function heardLine() {
    const late = latency() * RATE, l = playing.line;
    if (playing.ended !== null) return Math.min(playing.end, playing.end - late + audio.currentTime * RATE - playing.ended);
    return lineNow() - late + (l ? playing.heard.rounds * (l.to - l.from) : 0);
  }
  // the round of the loop heard now, the first 0
  const passNow = () => {
    const l = playing.line;
    return l && playing.heard ? Math.max(0, Math.floor((heardLine() - l.from) / (l.to - l.from))) : 0;
  };
  // A take's clock: the tick that was being heard at a time of the browser's clock, in the take's
  // round of a loop. Each key is written where it was heard, the speaker's lateness taken off.
  const clockOf = (rec) => (time) => {
    if (playing?.n !== rec.n) throw new Error("the singing the take was played against has stopped");
    if (!playing.heard) throw new Error("nothing is heard yet: play once the singing is heard");
    const l = playing.line, u = heardLine() - (window.performance.now() - time) / 1000 * RATE;
    return tickOf(l ? u - rec.pass * (l.to - l.from) : u);
  };
  function startTake(from, pass) {
    const rec = { n: playing.n, pass, ed, take: null };
    rec.take = new MI.Take({ from: Math.max(0, Math.floor(from)), tick: clockOf(rec) });
    recording = rec;
  }
  // The take ended at `time` and kept, one step of Undo. What is said of it: {line, bad}.
  function finishTake(time = window.performance.now()) {
    const rec = recording;
    if (!rec) return NOTHING;
    recording = null;
    const t = rec.take;
    // nothing was played: nothing to keep
    if (!t.played.length && !t.down.size && !t.wheel.length) return NOTHING;
    try {
      t.finish(time);
      return { line: `\n${keepTake(rec.ed, t, true)}`, bad: false };
    } catch (e) {
      return { line: `\nthe take: ${e.message}`, bad: true };
    }
  }
  // A finished take in the singer `into`, in place of its notes that start inside it: the notes
  // to the snap's step where Quantize is on, named for the key, and with `wheel` the wheel as its
  // vibrato. A wheel the singer cannot sing is refused, and its notes are kept only at a press
  // (Keep the notes only): the vibrato is never set to 0 for it. A tool's panel open (Sing and
  // Stop leave it open) is closed first, what it did kept, so the take is a step of its own and
  // not part of the tool's. What is said of it.
  function keepTake(into, t, wheel) {
    if (!desk.value.rows.some((r) => r.ed === into)) throw new Error("the singer it was played into is out of the score");
    closeTool(true);
    const o = { step: quantize ? step : 0, replace: true };
    let r;
    try {
      r = t.merge(into.part, { ...o, wheel });
    } catch (e) {
      if (!wheel || !t.wheel.length) throw e;
      t.merge(into.part, { ...o, wheel: false });
      unwheeled = { take: t, ed: into };
      throw new Error(`${e.message}. Keep the notes only, in the panel, keeps its notes without the wheel`);
    }
    unwheeled = null;
    const old = new Set(into.part.notes), K = keyNow();
    const notes = r.part.notes.map((n) => (old.has(n) || !K ? n : { ...n, pitch: T.spell(K, P.key(n.pitch)) }));
    const made = notes.filter((n) => !old.has(n)), gone = into.part.notes.filter((n) => !r.part.notes.includes(n)).length;
    into.commit({ ...r.part, notes }, new Set(made));
    const g = into.part.grid, at = (x) => P.beat(x, g);
    return [
      `recorded into ${singerName(into)}: ${made.length ? `${each(made.length)} from beat ${at(Math.min(...made.map((n) => n.at)))}` : "no notes"}${gone ? `, in place of the ${each(gone)} there` : ""}${wheel && t.wheel.length ? "; the wheel as its vibrato" : ""}. Undo takes it out`,
      ...(r.early ? [`${each(r.early)} let go before the take began ${r.early === 1 ? "is" : "are"} left out`] : []),
      ...(made.length ? ["the notes have no words yet: type them under the notes, or in Words"] : []),
    ].join("\n");
  }
  // the take whose wheel was refused, its notes kept without it
  function notesOnly() {
    if (!unwheeled) throw new Error("no take is waiting: its notes are kept already, or were taken back");
    const { take, ed: into } = unwheeled;
    say(keepTake(into, take, false));
  }
  // Round a loop: a round heard to its end keeps its take, and the next is a take of its own.
  function rounded() {
    const l = playing.line, rec = recording;
    if (!l || !playing.heard) return;
    const len = l.to - l.from, u = heardLine(), pass = Math.floor((u - l.from) / len);
    if (pass <= rec.pass) return;
    const took = finishTake(window.performance.now() - (u - (l.from + (rec.pass + 1) * len)) / RATE * 1000);
    startTake(playing.loop.from, pass);
    if (took.line) {
      say(took.line.slice(1), took.bad);
      refresh();
    }
  }
  function toggleRecord() {
    recordOn = !recordOn;
    if (!recordOn) {
      const took = finishTake();
      return say(`Record is off${took.line}`, took.bad);
    }
    const into = name(cur), fit = quantize ? `, its starts and ends to the snap's ${stepName}` : "";
    if (playing && playing.ended === null) {
      const from = heardAt() ?? playing.start;
      startTake(from, passNow());
      return say(`recording into ${into} from beat ${b(Math.floor(from))}${fit}`);
    }
    say(`Record is on: Sing records what is played into ${into}, where it is heard${fit}. Each take is one step of Undo`);
  }
  function toggleQuantize() {
    quantize = !quantize;
    say(quantize ? `takes go in to the snap's ${stepName}, their starts and their ends` : "takes go in as played, to the tick");
  }

  // ---- MIDI in

  // The browser's MIDI asked for, and the first input there is played from. A refusal, or a
  // browser with none, is said; nothing stands in for it.
  async function midiIn() {
    if (!midi) {
      say("MIDI in: asking the browser");
      midi = await MI.open(window.navigator, {
        // What is not a note, a pedal, the wheel or the bend (the clock, active sensing) is left on
        // purpose. The wheel and the bend change no part as they come, so the page is not drawn
        // anew for each.
        event: (ev) => {
          if (ev.type === "other") return;
          if (ev.type !== "wheel" && ev.type !== "bend") return attempt(() => playIn(ev));
          try {
            playIn(ev);
          } catch (e) {
            say(e.message, true);
          }
        },
        change: ({ lost, back }) => attempt(() => {
          if (lost) {
            closeStep();
            say(`MIDI in: ${lost} was unplugged`, true);
          } else if (back) say(`MIDI in: ${back} is back`);
        }),
        fail: (e) => say(e.message, true),
      });
    }
    const first = midi.inputs().find((x) => x.on);
    if (midi.chosen === null && first) await midi.choose(first.id);
    say(midiSaid());
    refresh();
  }
  const midiSaid = () => {
    const list = midi.inputs(), on = list.find((x) => x.id === midi.chosen);
    if (on) return `MIDI in: ${on.name}${list.length > 1 ? ` (${list.length} inputs: another is chosen in the panel)` : ""}. ${stepping ? "Step is on: what is played goes in where Sing starts" : "Turn on Step to write what is played where Sing starts, or Record and Sing to record it"}`;
    return list.length ? `MIDI in: ${list.length} ${list.length === 1 ? "input" : "inputs"}, none chosen: choose one in the panel` : "MIDI in: the browser has no MIDI input. Plug a keyboard in, and it shows in the panel";
  };

  // the panel's Play in as things are
  let midiListed = "";
  function playShown() {
    $("step").setAttribute("aria-pressed", String(Boolean(stepping)));
    $("keys-play").setAttribute("aria-pressed", String(Boolean(keyboard)));
    $("record").setAttribute("aria-pressed", String(recordOn));
    $("record").className = recording ? "taking" : "";
    $("quantize").setAttribute("aria-pressed", String(quantize));
    $("take-notes").hidden = !unwheeled;
    const sel = $("midi-input");
    sel.hidden = !midi;
    if (midi) {
      const list = midi.inputs(), sig = JSON.stringify(list);
      if (sig !== midiListed) {
        midiListed = sig;
        sel.replaceChildren(make("option", null, "no input"), ...list.map((x) => {
          const o = make("option", null, x.on ? x.name : `${x.name} (unplugged)`);
          o.value = x.id;
          o.disabled = !x.on;
          return o;
        }));
        sel.children[0].value = "";
      }
      if (!focused(sel)) sel.value = midi.chosen ?? "";
    }
    const s = stepping?.steps, lines = [
      ...(keyboard ? [`Keys play notes: ${keysSaid()}.`] : []),
      ...(s ? [`Step input at beat ${b(cursor)}: a note ${lengthSaid(s.ticks)} long${s.next < s.syllables.length ? `, the next syllable "${s.syllables[s.next]}"` : ""}.`] : []),
      ...(recordOn ? [`Record: Sing records what is played into ${name(cur)}${quantize ? `, to the snap's ${stepName}` : ""}.`] : []),
    ];
    $("play-said").textContent = lines.length ? lines.join("\n") : "Step writes what is played where Sing starts; Record writes it where it is heard while the score sings. Play with the computer's keys (Keys) or a MIDI keyboard (MIDI in).";
  }

  // ---------------------------------------------------------------- new singers (make.js)

  // The voices new singers take: the site's list in order, from the one after `voice`, the same
  // rule for every voice. A voice the site has not has no place in the list to go on from.
  function voicesAfter(voice, n) {
    if (!voices.length) throw new Error("the site's voices are not known yet, and a new singer takes the next of them");
    const i = voices.findIndex((v) => v.name === voice);
    if (i < 0) throw new Error("this singer's voice is not on this site's list, and a new singer takes the voice after it there: give this singer one of the site's voices first");
    return Array.from({ length: n }, (_, k) => voices[(i + 1 + k) % voices.length].name);
  }
  // n new singers {voice, seed}: the voices after this one's (or its own, for doubles), each seed
  // the next after the one before that no singer of the score has (ways.js another)
  function newcomers(part, n, own = false) {
    const vs = own ? Array(n).fill(part.singer.voice) : voicesAfter(part.singer.voice, n);
    const used = new Set(desk.value.rows.map((r) => r.ed.part.singer.seed)), seeds = [];
    for (let s = part.singer.seed; seeds.length < n; seeds.push(s)) used.add((s = Ways.another(s, used)));
    return vs.map((voice, i) => ({ voice, seed: seeds[i] }));
  }
  // the strip of the singer in sight, as make.js takes one; a new strip beside it
  const stripNow = () => {
    const r = desk.value.rows[cur];
    return { level: r.level, pan: r.pan, mute: r.mute, solo: r.solo };
  };
  const beside = (part, more = {}) => ({ ...S.strip(), level: stripNow().level, pan: stripNow().pan, part, ...more });
  // the most notes of a part sounding at once
  const most = (part) => Math.max(0, ...part.notes.map((n) => part.notes.filter((m) => m.at <= n.at && m.at + m.ticks > n.at).length));
  const barOf = (part) => (part.meter[0].n * 4) / part.meter[0].d;
  const hasNotes = (part, what) => {
    if (!part.notes.length) throw new Error(`${what}: this singer has no notes`);
  };
  // a whole part the same as another, read as its text would be
  const same = (a, b) => a === b || P.write(a) === P.write(b);

  // the makers' options, as shape.js gives a tool's
  const num = (name, label, min, max, step, def, unit, said, more = {}) => ({ name, kind: "number", label, min, max, step, default: def, unit, said, ...more });
  const among = (name, label, choices, def, said) => ({ name, kind: "choice", label, choices, default: def, said });
  const ALONG_KEY = { name: "key", kind: "key", label: "Key", default: null, said: "Along the key's scale, or by semitones." };
  const IN_KEY = { name: "key", kind: "key", label: "Key", default: null, said: "The key in force." };
  // how far apart the singers made stand about this one: `def`, or as far as its pan lets them
  const WIDTH = (def) => num("width", "Width", 0, 2, 0.05, Math.min(def, Math.floor(40 * (1 - Math.abs(stripNow().pan))) / 20), "", "How far apart they stand about this singer: 2 from one ear to the other.", { show: (x) => (x === 0 ? "together" : x.toFixed(2)) });
  const INTERVAL = (def, said) => num("interval", "Interval", -24, 24, 1, def, "", said, { whole: true, origin: 0, show: (x, t) => Make.apart(t.values.key && t.K ? t.K : null, x) });
  const OCTAVES = { "an octave above": 12, "an octave below": -12, "two octaves above": 24, "two octaves below": -24 };
  const beatsIn = (beats, part) => P.ticks(String(beats), part.grid);

  // The ways one singer is made many, and the ways it is changed with the others in mind
  // (make.js). Each: {label, said, notes (it works on the chosen notes), fields(part), run(part,
  // values, tool)} -> {strips (make.js's: the first the source's own, or null where it is as it
  // was; the rest new), part (the source's new part), edits ([editor, part] of other singers),
  // chosen (the source's notes chosen after), said}. A new singer takes the voices after this
  // one's and a seed of its own (newcomers); a double, an echo and a section take its own voice.
  // Those made by semitones, or not moved at all, follow it.
  const MAKERS = {
    harmony: {
      label: "Harmony",
      said: "A new singer singing this line a set way off, along the key's scale or by semitones: the same rhythm, words, vibrato and breath marks. By semitones it follows this singer.",
      fields: () => [INTERVAL(2, "Steps along the key's scale, or semitones: above over 0, below under 0."), ALONG_KEY],
      run: (part, v) => {
        hasNotes(part, "a harmony");
        const [w] = newcomers(part, 1);
        return { strips: [null, beside(Make.harmonize(part, v.key, v.interval, w.voice, w.seed), v.key === null ? { follows: { leader: cur, after: 0, keys: v.interval } } : {})] };
      },
    },
    round: {
      label: "Round or canon",
      said: "The line sung by more singers, each coming in a set time after the one before, the tune sung through a set number of times. Entries moved by semitones, or not at all, follow this singer.",
      fields: (part) => [
        num("singers", "Singers", 2, 8, 1, 3, "singers", "How many sing it, this one first.", { whole: true }),
        num("after", "Each after", 0.5, 64, 0.5, 2 * barOf(part), "beats", "How long after the one before each comes in."),
        num("times", "Times", 1, 8, 1, 2, "times", "How many times the tune is sung through.", { whole: true }),
        INTERVAL(0, "How far from this singer each entry sings: steps along the key's scale, or semitones."),
        ALONG_KEY,
        WIDTH(1.1),
      ],
      run: (part, v) => {
        hasNotes(part, "a round");
        const who = newcomers(part, v.singers - 1);
        return { strips: Make.round(part, who, beatsIn(v.after, part), { key: v.key, intervals: who.map(() => v.interval), times: v.times, strip: stripNow(), width: v.width, leader: cur }) };
      },
    },
    double: {
      label: "Double",
      said: "Another of this voice on the same notes, with a seed of its own: its own vibrato, timing and breaths, a few cents off. It follows this singer. The two are each made quieter, to sum as the one did.",
      fields: () => [num("cents", "Cents off", 0, 25, 1, 5, "cents", "How far the double is off in tune, through its shift.", { whole: true }), WIDTH(0.5)],
      run: (part, v) => {
        hasNotes(part, "a double");
        return { strips: Make.section(part, 1, v.width, { strip: stripNow(), leader: cur, cents: v.cents, seeds: newcomers(part, 1, true).map((w) => w.seed) }) };
      },
    },
    octave: {
      label: "Octave double",
      said: "A new singer singing this line an octave or two away. It follows this singer.",
      fields: () => [among("by", "Where", Object.keys(OCTAVES), "an octave above", "Above or below, by one octave or two.")],
      run: (part, v) => {
        hasNotes(part, "an octave double");
        const [w] = newcomers(part, 1), keys = OCTAVES[v.by];
        return { strips: [null, beside(Make.double(part, keys, w.seed, 0, w.voice), { follows: { leader: cur, after: 0, keys } })] };
      },
    },
    section: {
      label: "Section",
      said: "This singer made a section: more of its voice on the same notes, each with a seed of its own and a few cents off, spread across, all following it. Each is made quieter, so the section sums as the one singer did.",
      fields: () => [num("singers", "Singers", 2, 9, 1, 4, "singers", "How many in the section, this one with them.", { whole: true }), WIDTH(1), num("cents", "Cents apart", 0, 25, 1, 5, "cents", "The most one is off in tune, above or below.", { whole: true })],
      run: (part, v) => {
        hasNotes(part, "a section");
        return { strips: Make.section(part, v.singers - 1, v.width, { strip: stripNow(), leader: cur, cents: v.cents, seeds: newcomers(part, v.singers - 1, true).map((w) => w.seed) }) };
      },
    },
    echoes: {
      label: "Echoes",
      said: "More of this voice singing the line again a little later, each quieter and further out to a side. They follow this singer.",
      fields: () => [
        num("n", "Echoes", 1, 6, 1, 2, "", "How many echoes.", { whole: true, show: (x) => `${x} ${x === 1 ? "echo" : "echoes"}` }),
        num("after", "Each after", 0.25, 16, 0.25, 0.5, "beats", "How long after the one before each comes in."),
        num("fall", "Quieter by", 0, 24, 0.5, 4, "dB", "How much quieter each is than the one before."),
        WIDTH(1),
      ],
      run: (part, v) => {
        hasNotes(part, "echoes");
        return { strips: Make.echoes(part, v.n, beatsIn(v.after, part), { strip: stripNow(), leader: cur, fall: v.fall, width: v.width, seeds: newcomers(part, v.n, true).map((w) => w.seed) }) };
      },
    },
    hocket: {
      label: "Hocket",
      said: "The words handed out in turn among this singer and new ones, a word or a phrase each, so the line goes from one to the next across the stage. Each sings only its own words.",
      fields: () => [num("singers", "Singers", 2, 4, 1, 2, "singers", "How many share the line, this one with them.", { whole: true }), among("by", "By", ["word", "phrase"], "word", "A word each, or a phrase each: the words from one rest to the next."), WIDTH(1)],
      run: (part, v) => {
        hasNotes(part, "a hocket");
        return { strips: Make.hocket(part, newcomers(part, v.singers - 1), { by: v.by, strip: stripNow(), width: v.width }) };
      },
    },
    divisi: {
      label: "Split a chord",
      said: "Notes that sound together dealt out to singers, a line each: the top line stays with this singer, the next goes to a new one, and so on down. Where fewer notes sound, the lines left over rest.",
      fields: () => [WIDTH(1)],
      run: (part, v) => {
        const n = most(part);
        if (n < 2) throw new Error("no two of this singer's notes sound together: there is no chord to split");
        return { strips: Make.divisi(part, newcomers(part, n - 1), { strip: stripNow(), width: v.width }) };
      },
    },
    drone: {
      label: "Drone",
      said: "A new singer holding the key's tonic or fifth under the line, a note a bar, from the bar the line starts in to the bar it ends in.",
      fields: () => [
        among("on", "On", ["tonic", "fifth"], "tonic", "The key's tonic, or its fifth."),
        num("every", "Again every", 0, 16, 1, 4, "bars", "The syllable sung again, a breath before it, every this many bars; 0 holds it throughout.", { whole: true }),
        { name: "syllable", kind: "text", label: "Syllable", default: "ooh", said: "What it sings: a syllable with a vowel, in lower case." },
        IN_KEY,
      ],
      run: (part, v) => {
        hasNotes(part, "a drone");
        if (!v.key) throw new Error("a drone is on the key's tonic or fifth, and the score has no key: choose one in the panel");
        const [w] = newcomers(part, 1);
        return { strips: [null, beside(Make.drone(part, v.key, v.syllable.trim(), w.voice, w.seed, { on: v.on, every: v.every }))] };
      },
    },
    scat: {
      label: "Scat",
      said: "Syllables to scat on, in turn, under the notes with no words; or under every note.",
      fields: () => [
        { name: "syllables", kind: "text", label: "Syllables", default: "doo", said: `In turn, apart by spaces. Some to try: ${Make.VOCABLES.join(" ")}.` },
        { name: "all", kind: "flag", label: "Every note", default: false, said: "Every note's words replaced; a held note stays held." },
      ],
      run: (part, v) => {
        const p = Make.vocables(part, v.syllables, { all: v.all }), n = p.notes.filter((x, i) => x.lyric !== part.notes[i].lyric).length;
        return { part: p, said: `${each(n)} given ${n === 1 ? "a syllable" : "syllables"}` };
      },
    },
    stutter: {
      label: "Stutter",
      notes: true,
      said: "Each chosen word of one syllable sung again in quick repeats: la la la.",
      fields: () => [num("k", "Times", 2, 8, 1, 3, "times", "How many times each is sung.", { whole: true })],
      run: (part, v, t) => {
        const p = Make.stutter(part, t.picked, v.k), inside = (n) => t.picked.some((m) => n.pitch === m.pitch && n.at >= m.at && n.at < m.at + m.ticks);
        const chosen = p.notes.filter(inside);
        return { part: p, chosen, said: `${each(t.picked.length)} made ${each(chosen.length)}` };
      },
    },
    stagger: {
      label: "Stagger the breaths",
      said: "This singer and those following it in time (a section, doubles) take turns to breathe, so the line never stops: at each rest no more than this many breathe. Only breath marks change.",
      fields: () => [num("most", "At once", 1, 8, 1, 1, "", "How many may breathe at each rest.", { whole: true })],
      run: (part, v) => {
        const along = followers(cur).filter((j) => desk.value.rows[j].follows.after === 0).map((j) => desk.value.rows[j].ed);
        if (!along.length) throw new Error("no singer follows this one in time: staggered breathing is for a section or doubles");
        const out = Make.stagger([part, ...along.map((e) => e.part)], v.most);
        return { part: out[0], edits: along.map((e, i) => [e, out[i + 1]]), said: `${along.length + 1} singers take turns to breathe, ${v.most} at a time` };
      },
    },
  };

  // ---- the score's time (time.js)

  // A change of time made to every singer alike, as a score keeps one time: f(part, d) gives
  // {part, and what it did}, its place `d` ticks later. A follower's notes and vibrato are made
  // again from its leader's; its tempos and meters are its own, changed as the others' are, and its
  // marks, which go with its notes, are changed `after` ticks later, where its notes moved. All of
  // it is worked out before any of it is changed, so a refusal (named by the singer) changes
  // nothing. What f gave for each singer that follows no one.
  function timed(f) {
    const rows = desk.value.rows, bare = (p) => ({ ...p, notes: [], lanes: Object.fromEntries(P.LANES.map((l) => [l, []])) });
    const out = rows.map((r, i) => {
      try {
        if (!r.follows) return f(r.ed.part, 0);
        const time = f(bare(r.ed.part), 0), marks = r.follows.after ? f(bare(r.ed.part), r.follows.after) : time;
        return { part: { ...time.part, marks: marks.part.marks } };
      } catch (e) {
        throw new Error(rows.length > 1 ? `${name(i)}: ${e.message}` : e.message);
      }
    });
    rows.forEach((r, i) => { if (!r.follows) r.ed.commit(out[i].part); });
    rows.forEach((r, i) => { if (r.follows) r.ed.commit({ ...r.ed.part, tempo: out[i].part.tempo, meter: out[i].part.meter, marks: out[i].part.marks }); });
    S.check(score());
    return out.filter((_, i) => !rows[i].follows);
  }
  const sum = (out, k) => out.reduce((n, x) => n + x[k], 0);
  const barsSaid = (n) => `${n} ${n === 1 ? "bar" : "bars"}`;
  // bars from tick `at` to `to`: "bars 5 to 6 (beats 16 to 24)", or "bar 5 (beats 16 to 20)"
  const stretchSaid = (part, at, to) => {
    const [x, y] = [Tm.barOf(part, at), Tm.barOf(part, to - 1)];
    return `${x === y ? `bar ${x}` : `bars ${x} to ${y}`} (beats ${P.beat(at, part.grid)} to ${P.beat(to, part.grid)})`;
  };
  // A tempo or meter change at `at` that is the one in force before it is none: taken away, or not made.
  const restated = (list, at, same) => at > 0 && same(list.filter((x) => x.at !== at).findLast((x) => x.at < at));
  // The score's time changed at a place (the tool's `at`), every singer alike, each in the small
  // panel the tools have: one step of Undo from opening to closing, heard as it is pulled.
  const DS = ["1", "2", "4", "8", "16", "32"];
  const TIMES = {
    tempoHere: {
      label: "Tempo change here", every: true,
      said: "The tempo from here on, for every singer, until the next change.",
      fields: () => [num("bpm", "Tempo", 20, 300, 1, 120, "bpm", "Beats a minute from here on.", { whole: true })],
      run: (part, v, t) => {
        const same = restated(part.tempo, t.at, (x) => x.bpm === v.bpm), there = part.tempo.some((x) => x.at === t.at);
        if (!same || there) timed((p) => ({ part: Tm.tempo(p, t.at, same ? null : v.bpm) }));
        return { said: same ? `${v.bpm} beats a minute is the tempo before beat ${P.beat(t.at, part.grid)}: no change there` : `${v.bpm} beats a minute from beat ${P.beat(t.at, part.grid)}` };
      },
    },
    meterHere: {
      label: "Meter change", every: true,
      said: "The meter from this bar on, for every singer, until the next change.",
      fields: () => [num("n", "Beats", 1, 32, 1, 4, "", "How many notes a bar has.", { whole: true }), among("d", "Of", DS, "4", "The note a bar is counted in: 4 a quarter note, 8 an eighth.")],
      run: (part, v, t) => {
        const d = Number(v.d), same = restated(part.meter, t.at, (x) => x.n === v.n && x.d === d), there = part.meter.some((x) => x.at === t.at);
        if (!same || there) timed((p) => ({ part: Tm.meter(p, t.at, same ? null : v.n, d) }));
        return { said: same ? `${v.n}/${d} is the meter before bar ${Tm.barOf(part, t.at)}: no change there` : `${v.n}/${d} from bar ${Tm.barOf(part, t.at)} (beat ${P.beat(t.at, part.grid)})` };
      },
    },
    insertBars: {
      label: "Insert bars", every: true,
      said: "Empty bars put in before this bar, for every singer: what comes after moves on, in the tempo and the meter in force here.",
      fields: () => [num("bars", "Bars", 1, 64, 1, 1, "bars", "How many bars to put in.", { whole: true })],
      run: (part, v, t) => {
        const m = Tm.meterAt(part, t.at), ticks = v.bars * Tm.barTicks(part, m), out = timed((p, d) => Tm.insert(p, t.at + d, ticks)), held = sum(out, "held");
        return { said: `${barsSaid(v.bars)} of ${m.n}/${m.d} put in at bar ${Tm.barOf(part, t.at)} (beat ${P.beat(t.at, part.grid)}): what came after is ${P.beat(ticks, part.grid)} beats later${held ? `; ${each(held)} sounding across it hold through` : ""}` };
      },
    },
    deleteBars: {
      label: "Delete bars", every: true,
      said: "Bars taken out from this one on, for every singer: the notes that start in them go, and what comes after moves back.",
      fields: () => [num("bars", "Bars", 1, 64, 1, 1, "bars", "How many bars to take out.", { whole: true })],
      run: (part, v, t) => {
        const to = Tm.barsFrom(part, t.at, v.bars), out = timed((p, d) => Tm.cut(p, t.at + d, to + d)), gone = sum(out, "gone"), short = sum(out, "shortened");
        return { said: `${stretchSaid(part, t.at, to)} taken out: ${gone ? `${each(gone)} with them` : "no note started in them"}${short ? `, ${each(short)} sounding into them cut short` : ""}` };
      },
    },
    repeatBars: {
      label: "Repeat bars", every: true,
      said: "Bars from this one on sung again straight after themselves, for every singer, with their words, vibrato, marks and changes of time; what comes after moves on.",
      fields: () => [num("bars", "Bars", 1, 64, 1, 1, "bars", "How many bars, from this one, to sing again.", { whole: true }), num("times", "Times", 1, 16, 1, 1, "times", "How many more times they are sung.", { whole: true })],
      run: (part, v, t) => {
        const to = Tm.barsFrom(part, t.at, v.bars), out = timed((p, d) => Tm.repeat(p, t.at + d, to + d, v.times));
        return { said: `${stretchSaid(part, t.at, to)} sung ${v.times === 1 ? "once more" : `${v.times} more times`}: ${each(sum(out, "notes"))} laid again` };
      },
    },
  };
  // a time change taken away at once: one step of Undo for every singer
  function unchange(kind, at) {
    const part = ed.part, list = part[kind];
    if (!list.some((x) => x.at === at)) throw new Error(`no ${kind} change at beat ${P.beat(at, part.grid)}`);
    timed((p) => ({ part: kind === "tempo" ? Tm.tempo(p, at, null) : Tm.meter(p, at, null) }));
    const now = kind === "tempo" ? `${Tm.tempoAt(ed.part, at).bpm} beats a minute` : (({ n, d }) => `${n}/${d}`)(Tm.meterAt(ed.part, at));
    say(`the ${kind} change at beat ${P.beat(at, part.grid)} is taken away: ${now} goes on there`);
  }

  // What a maker made, in the score as one change: the source's part (its followers made again
  // from it), the other singers' parts it changed, the source's strip, and the new singers after
  // the others, a tab each, a link to the source's leader where the source follows one. `made`:
  // the editors a panel made before, kept for the new singers in their places so that only they
  // are sung anew. Every editor it makes is in a drag of its own, as the source's and the desk's
  // are, so that a panel's pull is made again from where it began. The new singers' editors.
  function seat(r, made) {
    const rows = desk.value.rows, src = rows[cur], strips = r.strips ?? [null], news = strips.slice(1);
    const room = S.MOST - rows.length;
    if (news.length > room) throw new Error(`a score holds ${S.MOST} singers, and this makes ${news.length} more: there is room for ${room}`);
    const own = r.part ?? strips[0]?.part;
    if (own && !same(own, ed.part)) ed.commit(own, r.chosen ? new Set(r.chosen) : ed.selected);
    for (const [e, p] of r.edits ?? []) if (!same(p, e.part)) e.commit(p);
    const eds = news.map((s, i) => {
      if (made[i]) {
        made[i].commit(s.part, new Set());
        return made[i];
      }
      const e = fresh(s.part);
      e.begin();
      return e;
    });
    const moved = strips[0] && (strips[0].level !== src.level || strips[0].pan !== src.pan);
    if (news.length || moved) {
      const link = src.follows, linked = (f) => (link ? { leader: link.leader, after: link.after + f.after, keys: link.keys + f.keys } : f);
      const added = news.map((s, i) => ({ level: s.level, pan: s.pan, mute: s.mute, solo: s.solo, ...(s.follows ? { follows: linked(s.follows) } : {}), ed: eds[i] }));
      desk.commit({ ...desk.value, rows: [...rows.map((x, j) => (j === cur && moved ? { ...x, level: strips[0].level, pan: strips[0].pan } : x)), ...added] });
    }
    S.check(score());
    return eds;
  }

  // A panel's whole life is one step of Undo: f's changes go in the step it made first, or in the
  // step being made where there is one (a command's), or in a new one.
  function grouped(t, f) {
    const g = t.group;
    if (g && journal.group === g) return f();
    if (g && journal.past.at(-1) === g && !journal.group) {
      journal.group = g;
      try {
        return f();
      } finally {
        journal.group = null;
      }
    }
    if (journal.group) {
      [t.group, t.from] = [journal.group, journal.group.length];
      return f();
    }
    t.from = 0;
    return together(() => {
      t.group = journal.group;
      return f();
    });
  }

  // A maker run with the panel's values, from the score as it was when the panel opened. A
  // refusal is said and leaves the score as it was. Whether it was made.
  function makeIt(t) {
    const reset = () => {
      desk.again();
      ed.again();
      for (const e of t.made) e.again();
      for (const [e] of t.drags ?? []) e.again();
    };
    reset();
    try {
      const n0 = desk.value.rows.length;
      let r = null;
      grouped(t, () => {
        r = t.maker.run(ed.part, optionsOf(t), t);
        t.made = seat(r, t.made);
      });
      const rows = desk.value.rows.slice(n0), names = rows.map((x) => x.ed.part.title || "a singer");
      const said = r.said ?? (rows.length ? `${rows.length === 1 ? "a new singer" : `${rows.length} new singers`}, ${listed(names)}${rows.every((x) => x.follows) ? `, following ${name(rows[0].follows.leader)}` : rows.some((x) => x.follows) ? `; those moved by no key follow ${name(cur)}` : ""}` : "done");
      say(`${t.spec.label}: ${said}${t.bare ? "" : "\nKeep it, or press Escape to take it back"}`);
      return true;
    } catch (e) {
      reset();
      say(`${t.spec.label}: ${e.message}`, true);
      return false;
    }
  }

  // A maker at a tap (the phone's buttons): with its values as they start, as one step, and the
  // score sung from its start so that what it made is heard. On a phone the key is the one found
  // in the notes.
  function oneTap(name) {
    const before = desk.value;
    openTool(name, {}, { bare: true, K: phone ? finding().ranked?.[0].key ?? null : keyNow() });
    closeTool(true);
    if (desk.value === before) return;
    stop();
    sing(0);
  }

  // ---------------------------------------------------------------- ways to sing (ways.js)

  // what is said of a way: its line, and what of it has not been heard
  const wayLine = (w) => {
    const not = Ways.unheard(w.settings);
    return `${w.name}: ${w.said}${not.length ? `\nNot yet heard: ${not.join(", ")}` : ""}`;
  };
  // the singer in sight sung the way `w`, one step of Undo, its line said
  function sungWay(w) {
    ed.commit({ ...ed.part, singer: Ways.apply(ed.part.singer, w) });
    return wayLine(w);
  }
  // another singer of the same voice: the next seed no other singer of the score has
  function anotherSeed() {
    const seed = Ways.another(ed.part.singer.seed, desk.value.rows.filter((r) => r.ed !== ed).map((r) => r.ed.part.singer.seed));
    ed.singer("seed", seed);
    return `seed ${seed}: another singer of this voice, its own vibrato, timing and breaths`;
  }

  // ---------------------------------------------------------------- the tools (shape.js)

  // the ornaments as the menus name them
  const ORNAMENT = { "trill": "Trill", "upper mordent": "Upper mordent", "lower mordent": "Lower mordent", "turn": "Turn", "grace": "Grace note", "appoggiatura": "Appoggiatura", "slide": "Slide into the note", "fall": "Fall off the note" };

  // what a tool made of the notes it was given, said
  const outcome = (label, a, b) => `${label}: ${a === b ? each(a) : `${each(a)} made ${each(b)}`}`;
  // A tool with no options run on the chosen notes, as one step of Undo.
  function shaped(name, o = {}) {
    const sel = ed.part.notes.filter((n) => ed.selected.has(n)), r = X[name](ed.part, sel, o);
    ed.commit(r.part, new Set(r.notes));
    say(outcome(X.options(ed.part.grid)[name].label, sel.length, r.notes.length));
  }

  // A tool's options in a small panel over the roll, a pull field each (shape.js options): the tool
  // runs on the notes chosen as it opened, at once, and again from where it began on each change
  // (Editor begin, again, end), so all of it is one step of Undo and each change is heard as it
  // is made. What a value is refused for is said, and the notes are left as they were before the
  // tool. Keep or Enter keeps what it did; Cancel or Escape puts the notes back. The values are
  // kept for the next time, while the page is open.
  //   tool: {name, spec (its options), ed, picked, values, grid, K (the key as it opened), drag
  //          (the editor's drag it began), mark (the steps of Undo before it), el, pulls}
  let tool = null;
  const remembered = new Map(); // a tool's name: {grid, values}
  // the tools where a key is a choice (along the scale, or by semitones); the others are given the
  // key in force, for naming and for what needs one
  const ALONG = new Set(["invert", "ornament", "harmony", "round"]);
  // the lengths a field of ticks is pulled through, shortest first: the snap's, and its own default
  const lengths = (grid, f) => {
    const list = [["4 beats", 4 * grid], ["2 beats", 2 * grid], ...steps(grid).filter((s) => s.name !== "tick").map((s) => [s.name, s.ticks])];
    if (!list.some(([, t]) => t === f.default)) list.push([`${f.default} ticks`, f.default]);
    return list.filter(([, t]) => t >= f.min && t <= f.max).sort((a, b) => a[1] - b[1]).map(([name, ticks]) => ({ name, ticks }));
  };
  // whether a field is shown for the values as they are
  const shows = (name, f, v) => {
    if (f.kind === "tick") return false;
    if (f.kind === "key") return ALONG.has(name);
    if (f.kinds && !f.kinds.includes(v.kind)) return false;
    if (name === "ornament" && f.name === "width") return !(v.key && tool.K);
    if (name === "arpeggiate" && f.name === "digits") return v.pattern === "digits";
    if (name === "arpeggiate" && f.name === "seed") return v.pattern === "random";
    if (name === "run" && f.name === "rate") return !v.whole;
    return true;
  };
  // the options the tool is called with
  const optionsOf = (t) => Object.fromEntries(t.spec.fields.filter((f) => f.kind !== "tick").map((f) => [f.name, f.kind === "key" ? (ALONG.has(t.name) && !t.values.key ? null : t.K) : t.values[f.name]]));
  const places = (step) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));

  // The panel for tool `name` opened on the chosen notes, `preset` values in place of those kept.
  // A maker of singers (MAKERS) works on the singer in sight and the score, the desk in a drag
  // too. `how`: bare, run with no panel (closed at once by the caller); K, the key in place of
  // the one in force. Whether the tool did what it was asked.
  function openTool(name, preset = {}, how = {}) {
    closeTool(true);
    const maker = MAKERS[name] ?? TIMES[name] ?? null, grid = ed.part.grid, was = remembered.get(name);
    const spec = maker ? { label: maker.label, said: maker.said, fields: maker.fields(ed.part) } : X.options(grid)[name];
    const values = was && was.grid === grid ? { ...was.values } : Object.fromEntries(spec.fields.filter((f) => f.kind !== "tick").map((f) => [f.name, f.kind === "key" ? true : f.default]));
    // a key to mirror about is the notes', not kept from the last time
    for (const f of spec.fields) if (f.kind === "pitch") values[f.name] = f.default;
    Object.assign(values, preset);
    const picked = ed.part.notes.filter((n) => ed.selected.has(n));
    if ((!maker || maker.notes) && !picked.length) throw new Error(`${spec.label}: no note is chosen`);
    // a change of the score's time is every singer's: each in a drag of its own
    if (maker?.every) for (const r of desk.value.rows) if (r.ed !== ed) r.ed.begin();
    ed.begin();
    if (maker) desk.begin();
    const drags = maker?.every ? desk.value.rows.map((r) => [r.ed, r.ed.drag]) : null;
    tool = { name, spec, maker, ed, picked, values, grid, K: how.K === undefined ? keyNow() : how.K, at: how.at ?? cursor, drag: ed.drag, desk: desk.drag, drags, made: [], group: null, from: 0, bare: Boolean(how.bare), mark: journal.past.length, el: make("div", "tool"), pulls: {} };
    tool.el.setAttribute("role", "dialog");
    tool.el.setAttribute("aria-label", spec.label);
    if (!how.bare) {
      $("roll").append(tool.el);
      build();
    }
    return apply();
  }

  // A value of the panel changed: kept for the next time, and the tool run again with it.
  // `again`: the fields that show depend on it.
  function toolValue(f, v, again = false) {
    const t = tool;
    t.values[f.name] = v;
    remembered.set(t.name, { grid: t.grid, values: { ...t.values } });
    if (again) build();
    apply();
  }

  // a field's control, as its kind is
  function control(f) {
    const t = tool, v = t.values;
    if (f.kind === "number" || f.kind === "pitch") {
      let o;
      if (f.kind === "pitch") {
        // the key mirrored about: the first chosen note's until one is pulled
        const first = P.key(t.picked[0].pitch), name = (k) => (t.K && ALONG.has(t.name) && v.key ? T.spell(t.K, k) : P.name(k));
        o = { min: 0, max: 127, step: 1, whole: true, per: 0.12, def: first, show: name, text: name, read: (s) => P.key(s.trim()), value: v[f.name] ?? first, put: (k) => k };
      } else if (f.unit === "ticks") {
        // pulled through the lengths of a beat, as the snap has them
        const list = lengths(t.grid, f), at = (ticks) => list.findIndex((x) => x.ticks === ticks);
        const read = (s) => {
          const i = list.findIndex((x) => x.name === s.trim() || String(x.ticks) === s.trim());
          if (i < 0) throw new Error(`${s}: one of ${list.map((x) => x.name).join(", ")}`);
          return i;
        };
        o = { min: 0, max: list.length - 1, step: 1, whole: true, def: at(f.default), show: (i) => list[i].name, text: (i) => list[i].name, read, value: at(v[f.name]), put: (i) => list[i].ticks };
      } else {
        // one of a word's: "1 beat", "2 beats"
        const unit = (x) => (x === 1 && /^[a-z]+s$/.test(f.unit) ? f.unit.slice(0, -1) : f.unit);
        const shown = (x) => `${x.toFixed(places(f.step))}${f.unit ? ` ${unit(x)}` : ""}`;
        const wide = f.max - f.min > 1000; // pulled a pixel at a time, as the singer's seed is
        o = { min: f.min, max: wide ? Infinity : f.max, hi: f.max, step: f.step, whole: f.whole, per: wide ? 0.2 : undefined, def: f.default, origin: f.origin ?? null, show: f.show ? (x) => f.show(x, t) : shown, value: v[f.name], put: (x) => x };
      }
      const p = pull(document, {
        ...o, label: f.label, title: `${f.said} Drag to change; click to type`,
        said: (m) => { if (m) say(`${t.spec.label}: ${m}`, true); },
        change: (x) => attempt(() => {
          p.set(x);
          toolValue(f, o.put(x));
        }),
      });
      p.set(o.value);
      t.pulls[f.name] = p;
      return p.el;
    }
    if (f.kind === "choice") {
      const sel = make("select");
      sel.setAttribute("aria-label", f.label);
      sel.title = f.said;
      sel.replaceChildren(...f.choices.map((c) => {
        const x = make("option", null, c);
        x.value = c;
        return x;
      }));
      sel.value = v[f.name];
      sel.addEventListener("change", () => attempt(() => toolValue(f, sel.value, true)));
      t.pulls[f.name] = sel;
      return sel;
    }
    if (f.kind === "flag" || f.kind === "key") {
      // a key: along the key's scale, or by semitones
      const b = make("button", "tool-flag", f.kind === "key" ? (t.K && v.key ? `along ${T.names(t.K)}` : t.K ? "by semitones" : "by semitones: no key") : v[f.name] ? "on" : "off");
      b.setAttribute("aria-pressed", String(Boolean(v[f.name]) && (f.kind !== "key" || Boolean(t.K))));
      b.disabled = f.kind === "key" && !t.K;
      b.title = f.kind === "key" ? "Along the key's scale, or by semitones" : f.said;
      b.addEventListener("click", () => attempt(() => toolValue(f, !v[f.name], true)));
      t.pulls[f.name] = b;
      return b;
    }
    if (f.kind === "text") {
      const input = make("input", "tool-text");
      input.value = v[f.name];
      input.spellcheck = false;
      input.setAttribute("aria-label", f.label);
      input.title = f.said;
      input.addEventListener("input", () => attempt(() => toolValue(f, input.value)));
      t.pulls[f.name] = input;
      return input;
    }
    throw new Error(`${t.spec.label}: no control for a field of kind ${f.kind}`);
  }

  // the panel drawn for its values
  function build() {
    const t = tool, head = make("div", "tool-head"), rows = make("div", "tool-rows"), foot = make("div", "tool-foot");
    head.append(make("span", "tool-name", t.spec.label));
    if (t.spec.fields.some((f) => f.kind === "key") && !ALONG.has(t.name)) head.append(make("span", "tool-key", t.K ? `in ${T.names(t.K)}` : "no key"));
    t.pulls = {};
    for (const f of t.spec.fields) {
      if (!shows(t.name, f, t.values)) continue;
      rows.append(make("label", null, f.kind === "key" ? "Steps" : f.label), control(f));
    }
    const keep = make("button", null, "Keep"), cancel = make("button", null, "Cancel");
    keep.title = "Keep what it did (Enter)";
    cancel.title = t.maker ? "Take back what it made (Escape)" : "Put the notes back as they were (Escape)";
    keep.addEventListener("click", () => attempt(() => closeTool(true, true)));
    cancel.addEventListener("click", () => attempt(() => closeTool(false, true)));
    foot.append(keep, cancel);
    t.el.replaceChildren(head, make("div", "tool-said", t.spec.said), rows, foot);
  }

  // The tool run on the notes as they were when it opened, with the panel's values. A refusal is
  // said, and leaves them as they were.
  function apply() {
    const t = tool;
    if (t.ed !== ed || ed.drag !== t.drag || (t.maker && desk.drag !== t.desk) || t.drags?.some(([e, d]) => e.drag !== d)) {
      closeTool(true);
      throw new Error(`${t.spec.label}: another change came first, so its panel is closed`);
    }
    if (t.maker) return makeIt(t);
    ed.again();
    try {
      const r = X[t.name](ed.part, t.picked, optionsOf(t));
      ed.commit(r.part, new Set(r.notes));
      const motion = t.name === "swell" && ed.part.singer.motion !== null ? `\nthe drawn vibrato is sung with the motion "- (drawn)" only, and this singer's is ${ed.part.singer.motion}` : "";
      say(`${outcome(t.spec.label, t.picked.length, r.notes.length)}${motion}\nKeep it, or press Escape to put the notes back`);
    } catch (e) {
      say(`${t.spec.label}: ${e.message}`, true);
    }
  }

  // The panel closed: what it did kept, or the notes put back as they were and the step it made
  // taken out of Undo and Redo both. `said`: closed by Keep, Cancel, Enter or Escape, and said so.
  function closeTool(keep, said = false) {
    const t = tool;
    if (!t) return;
    tool = null;
    t.el.remove();
    // the tool's last value refused: nothing it did stands, and no step of Undo is left for it
    const nothing = t.ed.part === t.drag.part && (!t.maker || desk.value === t.desk.value) && (t.drags ?? []).every(([e, d]) => e.part === d.part);
    if (t.ed.drag === t.drag) t.ed.end();
    for (const [e, d] of t.drags ?? []) if (e.drag === d) e.end();
    if (t.maker) {
      if (desk.drag === t.desk) desk.end();
      for (const e of t.made) e.end();
    }
    if (!keep || nothing) {
      const g = t.maker ? t.group : journal.past.length > t.mark ? journal.past.at(-1) : null;
      if (g && journal.group === g) {
        // the step is still being made (a command's): what the tool put in it taken back
        for (const h of g.splice(t.from).reverse()) {
          h.undo();
          h.future.pop();
        }
      } else if (g && journal.past.at(-1) === g) {
        back();
        for (const h of journal.future.pop()) h.future.pop();
      }
    }
    if (said) say(keep ? `${t.spec.label}: kept` : t.maker ? `${t.spec.label}: taken back, the score as it was` : `${t.spec.label}: the notes are as they were`);
    if (said) canvas.focus();
  }

  // ---------------------------------------------------------------- the commands

  // What a command is given (commands.js): the page as it is now, and `at`, where a right click
  // was while its menu is open. A command for a place uses that, or else where Sing starts.
  const here = () => ({ ed, desk, cur, tab, cursor, step, point, at: pointed });
  const spot = (ctx) => ctx.at?.tick ?? ctx.cursor;
  // the tick of the tempo or meter change a right click was on, or else the place
  const changeAt = (ctx, kind) => (ctx.at?.change?.kind === kind ? ctx.at.change.at : spot(ctx));
  const changeWhy = (ctx, kind) => {
    const at = changeAt(ctx, kind);
    if (at === 0) return `the ${kind} at beat 0 is where the score starts: change it; it cannot be taken away`;
    return ed.part[kind].some((x) => x.at === at) ? null : `no ${kind} change at beat ${P.beat(at, ed.part.grid)}`;
  };
  const inRoll = () => (tab === "mixer" ? "the mixer is in sight: choose a singer's tab" : null);
  const chose = () => inRoll() ?? (ed.selected.size ? null : "no note is chosen");
  const single = () => inRoll() ?? (first() ? null : "no note is chosen");
  const keyOf = (ctx) => ctx.at?.key ?? (first() ? P.key(first().pitch) : null);
  const singerAt = (ctx) => ctx.at?.singer ?? cur;
  const room = () => (desk.value.rows.length < S.MOST ? null : `a score holds ${S.MOST} singers`);
  const many = () => (desk.value.rows.length > 1 ? null : "the score has one singer");
  // The makers (MAKERS) as commands: what each is called there, and what stops it for singer i.
  const fits = (n) => (desk.value.rows.length + n <= S.MOST ? null : `a score holds ${S.MOST} singers, and there is room for ${S.MOST - desk.value.rows.length} more`);
  const noted = (i) => (desk.value.rows[i].ed.part.notes.length ? null : "this singer has no notes");
  const MAKE = {
    harmony: { label: "Add a harmony", keys: ["h"], when: (i) => noted(i) ?? fits(1) },
    round: { label: "Make a round or canon", when: (i) => noted(i) ?? fits(1) },
    double: { label: "Double this singer", when: (i) => noted(i) ?? fits(1) },
    octave: { label: "Octave double", when: (i) => noted(i) ?? fits(1) },
    section: { label: "Make a section", when: (i) => noted(i) ?? fits(1) },
    echoes: { label: "Add echoes", when: (i) => noted(i) ?? fits(1) },
    hocket: { label: "Hocket: the words handed between singers", when: (i) => noted(i) ?? fits(1) },
    divisi: { label: "Split a chord into singers", when: (i) => noted(i) ?? (most(desk.value.rows[i].ed.part) > 1 ? null : "no two of its notes sound together") ?? fits(1) },
    drone: { label: "Add a drone", when: (i) => noted(i) ?? (keyNow() ? null : "the score has no key: choose one in the panel") ?? fits(1) },
    scat: { label: "Fill bare notes with scat", when: noted },
    stagger: { label: "Stagger the breaths of a section", when: (i) => (followers(i).some((j) => desk.value.rows[j].follows.after === 0) ? null : "no singer follows this one in time") },
  };
  // the chosen notes' places in the part
  const chosenAt = () => ed.part.notes.flatMap((n, i) => (ed.selected.has(n) ? [i] : []));
  // the note after the last chosen (or before the first) chosen alone, and in sight
  function onward(d) {
    const at = chosenAt(), n = ed.part.notes[d > 0 ? at.at(-1) + 1 : at[0] - 1];
    ed.select([n]);
    point = null;
    reveal(n.at);
  }
  const COMMANDS = Cmd.table([
    ...(phone ? [] : [{
      id: "palette", label: "Find a command", group: "Commands", keys: ["mod+k"], typing: true,
      run: () => Cmd.palette(document, COMMANDS, here(), (c) => { if (c) attempt(() => together(() => c.run(here()))); }),
    }]),
    { id: "new", label: "New score", group: "File", run: () => { open(S.of(P.blank(ed.part.singer))); say("a new score, with the singer the last had"); } },
    { id: "open", label: "Open a file", group: "File", keys: ["mod+o"], typing: true, run: () => $("file").click() },
    { id: "save", label: "Save the score", group: "File", keys: ["mod+s"], typing: true, run: () => save("score") },
    { id: "save-part", label: "Save this singer's part", group: "File", run: () => save("part") },
    { id: "save-midi", label: "Save this singer's part as a MIDI file", group: "File", run: () => save("midi") },
    { id: "save-sound", label: "Save the score as it sounds, as a WAV file", group: "File", keys: ["mod+shift+s"], typing: true, when: () => (making() ? "a sound file is being made: Cancel sound stops it" : null), run: saveSound },
    { id: "cancel-sound", label: "Stop making the sound file", group: "File", when: () => (making() ? null : "no sound file is being made"), run: cancelSound },
    { id: "copy-link", label: phone ? "Share a link to this score" : "Copy a link to this score", group: "File", run: copyLink },
    { id: "link-before", label: "Open the score put aside when a link opened another", group: "File", when: () => (aside.value === null ? "no score was put aside for a link" : null), run: backToMine },

    { id: "undo", label: "Undo", group: "Edit", keys: ["mod+z"], when: () => (journal.past.length ? null : "nothing to undo"), run: back },
    { id: "redo", label: "Redo", group: "Edit", keys: ["mod+shift+z", "mod+y"], when: () => (journal.future.length ? null : "nothing to redo"), run: forth },
    { id: "cut", label: "Cut", group: "Edit", keys: ["mod+x"], where: ["note"], when: chose, run: () => lifted(true) },
    { id: "copy", label: "Copy", group: "Edit", keys: ["mod+c"], where: ["note"], when: chose, run: () => lifted(false) },
    { id: "paste", label: "Paste", group: "Edit", keys: ["mod+v"], where: ["note", "roll", "ruler"], when: inRoll, run: (ctx) => fetchPaste(spot(ctx), false) },
    { id: "paste-over", label: "Paste over the notes there", group: "Edit", keys: ["mod+shift+v"], where: ["note", "roll", "ruler"], when: inRoll, run: (ctx) => fetchPaste(spot(ctx), true) },
    { id: "duplicate", label: "Duplicate", group: "Edit", keys: ["mod+d"], where: ["note"], when: chose, run: duplicate },
    {
      id: "delete", label: "Delete", group: "Edit", keys: ["delete", "backspace"], where: ["note", "vibrato"],
      when: () => inRoll() ?? (point !== null || ed.selected.size ? null : "nothing is chosen"),
      run: () => {
        if (point === null) return ed.remove();
        ed.unpoint("vibrato", point);
        point = null;
      },
    },

    { id: "all", label: "Choose every note", group: "Choose", under: "Choose", keys: ["mod+a"], where: ["roll", "note", "words"], when: inRoll, run: () => { ed.select(ed.part.notes); point = null; } },
    {
      id: "on-key", label: "Choose every note on this key", group: "Choose", under: "Choose", where: ["note", "roll", "keys"],
      when: (ctx) => inRoll() ?? (keyOf(ctx) === null ? "no note is chosen" : null),
      run: (ctx) => {
        const k = keyOf(ctx), on = ed.part.notes.filter((n) => P.key(n.pitch) === k);
        ed.select(on);
        point = null;
        say(on.length ? `${each(on.length)} on ${P.name(k)}` : `no note on ${P.name(k)}`);
      },
    },
    {
      id: "from-here", label: "Choose every note from here on", group: "Choose", under: "Choose", where: ["note", "roll", "ruler"], when: inRoll,
      run: (ctx) => {
        const from = ctx.at?.note ? ctx.at.note.at : spot(ctx), on = ed.part.notes.filter((n) => n.at >= from);
        ed.select(on);
        point = null;
        say(`${each(on.length)} from beat ${P.beat(from, ed.part.grid)} on`);
      },
    },
    { id: "invert", label: "Invert the choice", group: "Choose", under: "Choose", where: ["note", "roll"], when: inRoll, run: () => { ed.select(ed.part.notes.filter((n) => !ed.selected.has(n))); point = null; } },
    { id: "next", label: "Choose the next note", group: "Choose", keys: ["tab"], when: () => chose() ?? (chosenAt().at(-1) === ed.part.notes.length - 1 ? "the last note is chosen" : null), run: () => onward(1) },
    { id: "before", label: "Choose the note before", group: "Choose", keys: ["shift+tab"], when: () => chose() ?? (chosenAt()[0] === 0 ? "the first note is chosen" : null), run: () => onward(-1) },
    { id: "none", label: "Let go of the chosen notes", group: "Choose", keys: ["escape"], when: () => inRoll() ?? (ed.selected.size || point !== null ? null : "nothing is chosen"), run: () => { ed.select([]); point = null; } },

    { id: "earlier", label: "Earlier by the snap's step", group: "Notes", keys: ["left"], when: chose, run: () => ed.move(-step, 0) },
    { id: "later", label: "Later by the snap's step", group: "Notes", keys: ["right"], when: chose, run: () => ed.move(step, 0) },
    { id: "shorter", label: "Shorter by the snap's step", group: "Notes", keys: ["alt+left"], when: chose, run: () => ed.stretch(-step, step) },
    { id: "longer", label: "Longer by the snap's step", group: "Notes", keys: ["alt+right"], when: chose, run: () => ed.stretch(step, step) },
    { id: "up", label: "Up a key; a step of the scale while Scale is on", group: "Notes", keys: ["up"], when: chose, run: () => pitched(1) },
    { id: "down", label: "Down a key; a step of the scale while Scale is on", group: "Notes", keys: ["down"], when: chose, run: () => pitched(-1) },
    ...(phone ? [] : [
      { id: "semitone-up", label: "Up a key, on or off the scale", group: "Notes", keys: ["alt+up"], when: chose, run: () => ed.move(0, 1, keyNow()) },
      { id: "semitone-down", label: "Down a key, on or off the scale", group: "Notes", keys: ["alt+down"], when: chose, run: () => ed.move(0, -1, keyNow()) },
    ]),
    { id: "octave-up", label: "Up an octave", group: "Notes", keys: ["shift+up"], when: chose, run: () => ed.move(0, 12, keyNow()) },
    { id: "octave-down", label: "Down an octave", group: "Notes", keys: ["shift+down"], when: chose, run: () => ed.move(0, -12, keyNow()) },
    { id: "breath", label: "Breath before the note: always, never, or left to the singer", group: "Notes", keys: ["b"], where: ["note"], when: single, run: () => ed.mark(first().at) },
    { id: "draw", label: "Draw: one press on an empty spot adds a note", group: "Notes", keys: ["d"], where: ["roll"], when: inRoll, on: () => drawing, run: () => { drawing = !drawing; } },
    // the tools (shape.js): those with options open their panel
    ...(phone ? [] : [
      { id: "quantize", label: "Quantize: the starts to the step", group: "Notes", keys: ["q"], where: ["note"], when: chose, run: () => openTool("quantize") },
      { id: "legato", label: "Legato: each note on to the next", group: "Notes", keys: ["shift+l"], where: ["note"], when: chose, run: () => openTool("legato") },
      { id: "gate", label: "Gate: each note shorter", group: "Notes", keys: ["shift+g"], where: ["note"], when: chose, run: () => openTool("gate") },
      { id: "split", label: "Split into equal notes", group: "Notes", keys: ["s"], where: ["note"], when: chose, run: () => openTool("split") },
      { id: "split-here", label: "Split here: at the right click, or where Sing starts", group: "Notes", keys: ["alt+s"], where: ["note"], when: chose, run: (ctx) => shaped("splitAt", { at: spot(ctx) }) },
      { id: "join", label: "Join notes on one key", group: "Notes", keys: ["j"], where: ["note"], when: chose, run: () => shaped("join") },

      { id: "transpose", label: "Transpose", group: "Transform", under: "Transform", keys: ["t"], where: ["note"], when: chose, run: () => openTool("transpose") },
      { id: "step-in-key", label: "Step along the key's scale", group: "Transform", under: "Transform", keys: ["shift+t"], where: ["note"], when: chose, run: () => openTool("scaleStep") },
      { id: "mirror", label: "Invert: the notes mirrored", group: "Transform", under: "Transform", keys: ["i"], where: ["note"], when: chose, run: () => openTool("invert") },
      { id: "reverse", label: "Reverse: the notes backward, the words in order", group: "Transform", under: "Transform", keys: ["r"], where: ["note"], when: chose, run: () => shaped("reverse") },
      { id: "reverse-keys", label: "Reverse the keys only", group: "Transform", under: "Transform", keys: ["shift+r"], where: ["note"], when: chose, run: () => shaped("reverse", { keys: true }) },
      { id: "time", label: "Time: double, half and more", group: "Transform", under: "Transform", where: ["note"], when: chose, run: () => openTool("scaleTime") },

      ...X.ORNAMENTS.map((kind) => ({
        id: `ornament-${kind.replace(/ /g, "-")}`, label: ORNAMENT[kind], group: "Ornament", under: "Ornament", where: ["note"], when: chose, run: () => openTool("ornament", { kind }),
      })),
      { id: "run", label: "Run along the scale to the next note", group: "Ornament", under: "Ornament", where: ["note"], when: chose, run: () => openTool("run") },

      { id: "arpeggiate", label: "Arpeggiate: notes together become a line", group: "Arpeggio", keys: ["a"], where: ["note"], when: chose, run: () => openTool("arpeggiate") },
    ]),

    { id: "syllable", label: "Type the note's syllable", group: "Words", keys: ["enter"], where: ["note", "words"], when: single, run: () => word(first()) },
    ...(phone ? [] : [{ id: "stutter", label: "Stutter: each chosen word sung again in quick repeats", group: "Words", where: ["note"], when: chose, run: () => openTool("stutter") }]),

    { id: "line", label: "Vibrato point: slide to it, or jump to it", group: "Vibrato", keys: ["l"], where: ["vibrato"], when: () => inRoll() ?? (point === null ? "no vibrato point is chosen" : null), run: () => ed.line("vibrato", point, !ed.part.lanes.vibrato[point].line) },
    ...(phone ? [] : [
      { id: "vibrato-shape", label: "Shape the vibrato over each note: late, swell or fade", group: "Vibrato", keys: ["v"], where: ["note"], when: chose, run: () => openTool("swell") },

      {
        id: "scale", label: "Scale: notes drawn, dragged and stepped land on the key's notes", group: "Key", keys: ["shift+s"], where: ["roll", "keys"],
        on: () => set.scale, run: toggleScale,
      },
      {
        id: "find-key", label: "Find the key of the chosen notes", group: "Key", where: ["note"], when: chose,
        run: () => {
          const r = T.detect(ed.part.notes.filter((n) => ed.selected.has(n)));
          say(`the chosen notes fit ${r[0].name} best (${percent(r[0].inside)} of their time on its scale), then ${r[1].name} and ${r[2].name}. The key is chosen in the panel`);
        },
      },
      { id: "found-key", label: "The key found in the notes, not one chosen", group: "Key", where: ["roll", "keys"], when: () => (set.key ? null : "the key is the one found in the notes already"), run: () => chooseKey(null) },
    ]),

    // the score's time, every singer's (time.js): at a right click on the ruler, or where Sing starts
    ...(phone ? [] : [
      { id: "tempo-here", label: "Tempo change here", group: "Time", where: ["ruler"], when: inRoll, run: (ctx) => { const at = changeAt(ctx, "tempo"); openTool("tempoHere", { bpm: Tm.tempoAt(ed.part, at).bpm }, { at }); } },
      {
        id: "meter-here", label: "Meter change from this bar", group: "Time", where: ["ruler"], when: inRoll,
        run: (ctx) => {
          const at = ctx.at?.change?.kind === "meter" ? ctx.at.change.at : Tm.barLine(ed.part, spot(ctx)), m = Tm.meterAt(ed.part, at);
          openTool("meterHere", { n: m.n, d: String(m.d) }, { at });
        },
      },
      { id: "tempo-gone", label: "Take away this tempo change", group: "Time", where: ["ruler"], when: (ctx) => inRoll() ?? changeWhy(ctx, "tempo"), run: (ctx) => unchange("tempo", changeAt(ctx, "tempo")) },
      { id: "meter-gone", label: "Take away this meter change", group: "Time", where: ["ruler"], when: (ctx) => inRoll() ?? changeWhy(ctx, "meter"), run: (ctx) => unchange("meter", changeAt(ctx, "meter")) },
      { id: "insert-bars", label: "Insert bars before this one", group: "Time", where: ["ruler"], when: inRoll, run: (ctx) => openTool("insertBars", {}, { at: Tm.barLine(ed.part, spot(ctx)) }) },
      { id: "delete-bars", label: "Delete bars from this one", group: "Time", where: ["ruler"], when: inRoll, run: (ctx) => openTool("deleteBars", {}, { at: Tm.barLine(ed.part, spot(ctx)) }) },
      { id: "repeat-bars", label: "Repeat bars from this one", group: "Time", where: ["ruler"], when: inRoll, run: (ctx) => openTool("repeatBars", {}, { at: Tm.barLine(ed.part, spot(ctx)) }) },
    ]),

    { id: "sing", label: "Sing, or stop", group: "Sing", keys: ["space"], run: () => (playing ? stopped() : sing()) },
    { id: "sing-here", label: "Sing from here", group: "Sing", where: ["ruler", "roll", "note", "ghost"], when: (ctx) => (ctx.at ? null : "right click where it should start"), run: (ctx) => place(spot(ctx)) },
    { id: "start", label: "Back to the start", group: "Sing", keys: ["home"], where: ["ruler"], when: inRoll, run: () => place(0) },
    { id: "loop", label: "Loop on or off", group: "Sing", keys: ["o"], where: ["ruler"], on: () => set.loop.on, run: toggleLoop },
    { id: "click", label: "Metronome click on or off", group: "Sing", keys: ["k"], on: () => set.click.on, run: () => { set.click.on = !set.click.on; shown(); } },

    // notes played in (midiin.js): from a MIDI keyboard, or the computer's keys
    ...(phone ? [] : [
      { id: "step-input", label: "Step input: notes played go in where Sing starts, a step at a time", group: "Play in", keys: ["shift+n"], when: () => (stepping ? null : inRoll()), on: () => Boolean(stepping), run: toggleStep },
      { id: "keys-play", label: "Keys play notes: the letters A to K a keyboard", group: "Play in", keys: ["shift+k"], on: () => Boolean(keyboard), run: toggleKeys },
      { id: "record", label: "Record: what is played while the score sings goes in where it is heard", group: "Play in", on: () => recordOn, run: toggleRecord },
      { id: "quantize-takes", label: "Quantize takes to the snap's step, or not", group: "Play in", on: () => quantize, run: toggleQuantize },
      { id: "midi-in", label: "MIDI in: play from a MIDI keyboard", group: "Play in", run: () => { midiIn().catch((e) => { say(e.message, true); refresh(); }); } },
      { id: "take-notes", label: "Keep the take's notes only, without its wheel", group: "Play in", when: () => (unwheeled ? null : "no take is waiting"), run: notesOnly },
    ]),

    { id: "mixer", label: "The mixer, or back to the singer", group: "Singers", keys: ["m"], where: ["mixer"], run: () => (tab === "mixer" ? show(cur) : showMixer()) },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => ({
      id: `singer-${k}`, label: `Singer ${k}`, group: "Singers", keys: [String(k)],
      when: () => (k <= desk.value.rows.length ? null : `the score has ${desk.value.rows.length} ${desk.value.rows.length === 1 ? "singer" : "singers"}`),
      run: () => show(k - 1),
    })),
    { id: "next-singer", label: "The next singer", group: "Singers", keys: ["]"], when: many, run: () => show((cur + 1) % desk.value.rows.length) },
    { id: "singer-before", label: "The singer before", group: "Singers", keys: ["["], when: many, run: () => show((cur + desk.value.rows.length - 1) % desk.value.rows.length) },
    { id: "add-singer", label: "Add a singer", group: "Singers", where: ["tab", "mixer"], when: room, run: () => addSinger(false) },
    { id: "copy-singer", label: "Copy this singer as a new one", group: "Singers", where: ["tab"], when: room, run: (ctx) => { show(singerAt(ctx)); addSinger(true); } },
    { id: "rename-singer", label: "Rename this singer", group: "Singers", where: ["tab"], run: (ctx) => { show(singerAt(ctx)); renaming = singerAt(ctx); } },
    { id: "remove-singer", label: "Remove this singer", group: "Singers", where: ["tab"], when: () => (desk.value.rows.length > 1 ? null : "a score has one singer at least"), run: (ctx) => removeSinger(singerAt(ctx)) },
    // new singers made from this one (make.js): a panel of their values on a desk, at a tap on a phone
    ...Object.entries(MAKE).filter(([id]) => !phone || id === "harmony" || id === "round").map(([id, m]) => ({
      id, label: m.label, group: "Singers", where: ["tab"], ...(m.keys ? { keys: m.keys } : {}),
      // at a right click on a tab, that singer is shown when it runs, mixer or not
      when: (ctx) => (ctx.at?.place === "tab" ? null : inRoll()) ?? m.when(singerAt(ctx)),
      run: (ctx) => {
        if (singerAt(ctx) !== cur || tab !== "singer") show(singerAt(ctx));
        if (phone) return oneTap(id);
        openTool(id);
      },
    })),
    {
      id: "unlink", label: "Unlink: its notes its own, following no one", group: "Singers", where: ["tab"],
      when: (ctx) => (desk.value.rows[singerAt(ctx)].follows ? null : "this singer follows no one"),
      run: (ctx) => unlink(singerAt(ctx)),
    },
    ...(phone ? [] : [
      {
        id: "another-seed", label: "Another singer of this voice: the next seed", group: "Singers", where: ["tab"],
        run: (ctx) => {
          if (singerAt(ctx) !== cur || tab !== "singer") show(singerAt(ctx));
          say(anotherSeed());
        },
      },
      ...Ways.WAYS.map((w, i) => ({
        id: `way-${i + 1}`, label: w.name, group: "Singers", under: "Way to sing", where: ["tab"],
        run: (ctx) => {
          if (singerAt(ctx) !== cur || tab !== "singer") show(singerAt(ctx));
          say(sungWay(w));
        },
      })),
    ]),

    { id: "others", label: "Show the other singers' notes, or hide them", group: "View", keys: ["g"], when: inRoll, on: () => set.others, run: () => { set.others = !set.others; shown(); } },
    { id: "fit", label: "Fit every note in view", group: "View", keys: ["f"], where: ["roll"], when: inRoll, run: fit },
    { id: "wider", label: "Wider in time", group: "View", keys: ["=", "plus"], when: inRoll, run: () => view.zoom(1.25, (W - GUT) / 2) },
    { id: "narrower", label: "Narrower in time", group: "View", keys: ["minus"], when: inRoll, run: () => view.zoom(0.8, (W - GUT) / 2) },
    ...(phone ? [] : [
      { id: "fit-chosen", label: "Zoom to the chosen notes", group: "View", keys: ["shift+f"], where: ["note"], when: chose, run: fitChosen },
      { id: "read", label: "Zoom to read: a beat wide enough for its words", group: "View", where: ["roll"], when: inRoll, run: frame },
      { id: "taller", label: "Taller rows", group: "View", when: inRoll, run: () => view.heighten(1.25, rows().roll / 2) },
      { id: "shorter-rows", label: "Shorter rows", group: "View", when: inRoll, run: () => view.heighten(0.8, rows().roll / 2) },
      {
        id: "seen", label: "Its notes shown behind the singer in sight's", group: "View", where: ["tab"],
        on: (ctx) => !unseen.has(desk.value.rows[singerAt(ctx)].ed), run: (ctx) => toggleSeen(singerAt(ctx)),
      },
      {
        id: "go-ghost", label: "Go to this note's singer, the note chosen", group: "Singers", where: ["ghost"],
        when: (ctx) => (ctx.at?.ghost ? null : "no other singer's note there"),
        run: (ctx) => { show(ctx.at.ghost.i); ed.select([ctx.at.ghost.note]); },
      },
      ...["words", "velocity", "vibrato"].map((k) => ({
        id: `lane-${k}`, label: `${k[0].toUpperCase()}${k.slice(1)}`, group: "View", under: "Rows under the notes", on: () => layout.lanes[k], run: () => foldLane(k),
      })),
      { id: "panel", label: "The panel at the right", group: "View", keys: ["p"], on: () => layout.panel, run: togglePanel },
      { id: "keys-help", label: "Keys and mouse", group: "Help", run: () => $("keys-help").showModal() },
    ]),
    // the examples, each opened as its file is
    ...MENU.map((x, i) => ({ id: `example-${i + 1}`, label: x.label, group: "File", under: "Examples", run: () => { example(x.file); } })),
  ], platform);

  // What the mouse does, for the Keys help beside the commands' keys.
  const GESTURES = [
    { keys: ["right click"], label: "a note, the roll, the ruler, a key or a tab: what can be done there", group: "Commands" },
    { keys: ["up", "down", "Enter", "Escape"], label: "in a menu or in Find a command: move, choose, close", group: "Commands" },
    { keys: ["Enter"], label: "with a tool's panel open: keep what it did", group: "Commands" },
    { keys: ["Escape"], label: "with a tool's panel open: put the notes back as they were", group: "Commands" },
    { keys: ["alt", "drag"], label: "a note: drag out a copy of the chosen notes", group: "Edit" },
    { keys: ["click"], label: "a note chooses it", group: "Choose" },
    { keys: ["shift", "click"], label: "a note: add it to the chosen, or take it out", group: "Choose" },
    { keys: ["drag"], label: "on an empty spot: choose the notes in the box; with shift, add them", group: "Choose" },
    { keys: ["click"], label: "a key at the left: choose every note on it; with shift, add them", group: "Choose" },
    { keys: ["double click"], label: "an empty spot adds a note", group: "Notes" },
    { keys: ["drag"], label: "a note moves it; its right end changes its length", group: "Notes" },
    { keys: ["drag"], label: "in the velocity row: the chosen notes louder or softer, their differences kept", group: "Notes" },
    { keys: ["click"], label: "under a note: type its syllable. Several words fill the notes after it", group: "Words" },
    { keys: ["space", "-"], label: "after a syllable typed: on to the next note", group: "Words" },
    { keys: ["Tab"], label: "in a syllable: keep it and go on to the next note", group: "Words" },
    { keys: ["Enter"], label: "in a syllable: keep it", group: "Words" },
    { keys: ["Escape"], label: "in a syllable: leave the note as it was", group: "Words" },
    { keys: ["click"], label: "in the vibrato row: a point; drag it to place it", group: "Vibrato" },
    { keys: ["shift", "click"], label: "a vibrato point: slide to it, or jump to it", group: "Vibrato" },
    { keys: ["click"], label: "the ruler: where singing starts; while it sings, it jumps there", group: "Sing" },
    { keys: ["drag"], label: "along the ruler: mark a loop; drag its ends to change it", group: "Sing" },
    { keys: ["right click"], label: "the ruler, or a tempo or meter on it: change the tempo or the meter there, take a change away, insert, delete or repeat bars", group: "Time" },
    { keys: ["A", "W", "S", "E", "D", "F", "T", "G", "Y", "H", "U", "J", "K"], label: "with Keys play notes on: a keyboard, C up to the next C. These letters do not do their commands while it is on; with shift, cmd, ctrl or alt they do", group: "Play in" },
    { keys: ["Z", "X"], label: "with Keys play notes on: the keyboard an octave down, or up", group: "Play in" },
    { keys: ["right"], label: "with Keys play notes and Step on: a rest; with a key held, the step a step longer", group: "Play in" },
    { keys: ["Backspace"], label: "with Keys play notes and Step on: the last step taken back", group: "Play in" },
    { keys: ["[", "]"], label: "with Keys play notes and Step on: a step half as long, or twice", group: "Play in" },
    { keys: ["Escape"], label: "with Keys play notes on: Keys play notes and Step off, the keys the editor's again", group: "Play in" },
    { keys: ["pedal"], label: "on a MIDI keyboard, with Step on: keys played with the sustain pedal down are one chord", group: "Play in" },
    { keys: ["double click"], label: "a tab renames its singer", group: "Singers" },
    { keys: ["click"], label: "the + tab adds a singer; with shift, a copy of this one", group: "Singers" },
    { keys: ["Enter", "Escape"], label: "in a singer's name being typed: keep it, or leave it as it was", group: "Singers" },
    { keys: ["scroll"], label: "move along; with shift, along in time only", group: "View" },
    { keys: [apple ? "cmd" : "ctrl", "scroll"], label: "zoom in time, as a pinch does", group: "View" },
    { keys: ["alt", "scroll"], label: "zoom in pitch", group: "View" },
    { keys: ["drag"], label: "a number: change it; with shift, in small steps", group: "Numbers" },
    { keys: ["click"], label: "a number: type it", group: "Numbers" },
    { keys: ["alt", "click"], label: "a number: put it back", group: "Numbers" },
    { keys: ["up", "down", "scroll"], label: "on a number: step it; with shift, in small steps", group: "Numbers" },
    { keys: ["page up", "page down"], label: "on a number: ten steps", group: "Numbers" },
    { keys: ["Home", "End"], label: "on a number: its least or its most", group: "Numbers" },
    { keys: ["delete"], label: "on a number: put it back", group: "Numbers" },
  ];
  $("keys").replaceChildren(make("div", null, "The editor needs a mouse and a keyboard. It does not work by touch."), Cmd.help(document, COMMANDS, GESTURES));
  // A button's title names its command's keys in its last brackets, as the Keys help names them
  // for this machine (ctrl shift S off a Mac); a command not on this page (a phone's) leaves it.
  const TITLED = { "save-sound": "save-sound", sing: "sing", stop: "sing", loop: "loop", click: "click", draw: "draw", scale: "scale", step: "step-input", "keys-play": "keys-play", fit: "fit", "make-harmony": "harmony", undo: "undo", redo: "redo", "side-toggle": "panel" };
  for (const [id, cid] of Object.entries(TITLED)) {
    const c = COMMANDS.find((x) => x.id === cid), el = $(id), brackets = el.title.match(/\([^()]*\)/g) ?? [];
    if (!c) continue;
    if (!c.keys.length || !brackets.length) throw new Error(`the title of #${id} names the keys of ${cid} in its last brackets: "${el.title}"`);
    const i = el.title.lastIndexOf(brackets.at(-1));
    el.title = `${el.title.slice(0, i)}(${c.keys.join(" or ")})${el.title.slice(i + brackets.at(-1).length)}`;
  }

  // The menu bar, on a desk: every command in a menu by what it works on, each menu made as it
  // opens so that what cannot run now is greyed and what is on is checked. A singer's notes behind
  // the one in sight, and the singers to go to, are listed by name.
  const bySinger = (f) => desk.value.rows.map((r, i) => f(r, i));
  const MENUS = [
    { label: "File", layout: () => ["new", "open", { label: "Examples", items: MENU.map((_, i) => `example-${i + 1}`) }, "-", "save", "save-part", "save-midi", "-", "save-sound", "cancel-sound", "-", "copy-link", "link-before"] },
    { label: "Edit", layout: () => ["undo", "redo", "-", "cut", "copy", "paste", "paste-over", "duplicate", "delete", "-", { label: "Choose", items: ["all", "on-key", "from-here", "invert", "-", "next", "before", "none"] }, "-", "palette"] },
    {
      label: "Notes",
      layout: () => [
        "draw", "scale", "-",
        { label: "Move", items: ["earlier", "later", "shorter", "longer", "-", "up", "down", "semitone-up", "semitone-down", "octave-up", "octave-down"] },
        "quantize", "legato", "gate", "split", "split-here", "join", "-",
        { label: "Transform", items: ["transpose", "step-in-key", "mirror", "reverse", "reverse-keys", "time"] },
        { label: "Ornament", items: [...X.ORNAMENTS.map((k) => `ornament-${k.replace(/ /g, "-")}`), "run"] },
        "arpeggiate", "-", "syllable", "stutter", "breath", "vibrato-shape", "-",
        { label: "Key", items: ["find-key", "found-key"] },
      ],
    },
    {
      label: "Singers",
      layout: () => [
        { label: "Go to", items: [...bySinger((r, i) => ({ label: name(i), keys: i < 9 ? [String(i + 1)] : [], checked: tab === "singer" && i === cur, run: () => show(i) })), "-", "mixer"] },
        "next-singer", "singer-before", "-",
        "add-singer", "copy-singer", "rename-singer", "remove-singer", "-",
        { label: "New singers from this one", items: Object.keys(MAKE) },
        { label: "Way to sing", items: Ways.WAYS.map((_, i) => `way-${i + 1}`) },
        "another-seed", "unlink",
      ],
    },
    {
      label: "View",
      layout: () => [
        "read", "fit", "fit-chosen", "-", "wider", "narrower", "taller", "shorter-rows", "-",
        "others",
        { label: "Each singer's notes behind", items: bySinger((r, i) => ({ label: name(i), checked: !unseen.has(r.ed), why: i === cur && tab === "singer" ? "this singer is in sight" : null, run: () => toggleSeen(i) })) },
        { label: "Rows under the notes", items: ["lane-words", "lane-velocity", "lane-vibrato"] },
        "-", "panel",
      ],
    },
    { label: "Sing", layout: () => ["sing", "start", "loop", "click", "-", "record", "step-input", "keys-play", "quantize-takes", "midi-in", "take-notes"] },
    { label: "Help", layout: () => ["keys-help", "palette"] },
  ];
  if (!phone) {
    Cmd.menubar(document, $("menus"), MENUS.map((m) => ({ label: m.label, items: () => Cmd.laid(COMMANDS, here(), m.layout()) })), (it) => {
      if (tool && !BESIDE.has(it.command?.id)) closeTool(true);
      if (it.command?.id === "paste") return attempt(() => it.command.run(here()));
      attempt(() => together(() => (it.command ? it.command.run(here()) : it.run())));
    });
  }

  // A key pressed: the command bound to it run (commands.js find), or why it cannot run now said,
  // and the browser's own use of the key (cmd D's bookmark) refused either way. Escape and Tab
  // with nothing to do say nothing and are left to the page, so that Tab leaves the roll; on a
  // button or a number Tab is never a command (commands.js bound). cmd V waits for the browser's
  // paste event (awaitPaste).
  // With a tool's panel open, Enter keeps what it did and Escape puts the notes back; any other
  // command keeps it and closes it first, but those that sing or move the view, which leave it open.
  const QUIET = new Set(["none", "next", "before"]);
  const BESIDE = new Set(["sing", "start", "loop", "click", "others", "fit", "wider", "narrower", "fit-chosen", "read", "taller", "shorter-rows", "panel", "lane-words", "lane-velocity", "lane-vibrato", "seen"]);
  function key(e) {
    if ($("keys-help").open) return;
    if (tool && !e.defaultPrevented && (e.key === "Escape" || (e.key === "Enter" && !typingIn(e.target) && e.target?.tagName !== "BUTTON"))) {
      e.preventDefault();
      return attempt(() => closeTool(e.key === "Enter", true));
    }
    // Keys play notes: the letters it takes (midiin.js Keys, by where they are on the keyboard)
    // play before any command sees them; with shift, cmd, ctrl or alt they are the commands'
    if (keyboard && tab !== "mixer" && !e.defaultPrevented && !e.isComposing && !typingIn(e.target)) {
      let evs;
      try {
        evs = keyboard.down(e, last.velocity);
      } catch (err) {
        e.preventDefault();
        return say(err.message, true);
      }
      if (evs) {
        e.preventDefault();
        if (evs.length) attempt(() => evs.forEach(playIn));
        return;
      }
    }
    const c = Cmd.find(COMMANDS, e, here());
    if (!c) {
      const b = Cmd.bound(COMMANDS, e);
      if (!b || QUIET.has(b.id)) return;
      e.preventDefault();
      say(`${b.label}: ${Cmd.why(b, here())}`);
      return;
    }
    if (tool && !BESIDE.has(c.id)) closeTool(true);
    if (c.id === "paste") return awaitPaste();
    e.preventDefault();
    attempt(() => together(() => c.run(here())));
  }

  // A right click: the commands for the place under it (commands.js items) in a menu at (x, y) in
  // the window, run as a key's are. `where`: {place, and tick, key, note or singer as it has them}.
  function offer(x, y, where) {
    closeTool(true);
    if (worded) commitWord(false);
    pointed = where;
    const list = Cmd.items(COMMANDS, here(), where.place);
    if (!list.length) {
      pointed = null;
      return;
    }
    attempt(() => Cmd.menu(document, list, x, y, (it) => {
      if (it) attempt(() => together(() => it.command.run(here())));
      pointed = null;
    }));
  }
  // On the roll: a note not chosen is chosen first; a vibrato point under it is the one chosen.
  // The ContextMenu key gives no point: the menu opens at the first note chosen.
  function rollMenu(e) {
    e.preventDefault();
    closeTool(true);
    const b = canvas.getBoundingClientRect(), keyed = e.clientX === 0 && e.clientY === 0, n0 = first();
    const x = keyed ? (n0 ? GUT + Math.max(0, view.x(n0.at)) + 4 : GUT + 4) : e.clientX - b.left;
    const y = keyed ? (n0 ? RULER + view.y(P.key(n0.pitch)) + view.tall / 2 : RULER + 4) : e.clientY - b.top;
    const part = ed.part, tick = tickAt(x), key = keyAt(y);
    let place = region(x, y), note = null, change = null, ghost = null;
    if (place === "ruler") {
      // a tempo or a meter shown on the ruler: the change there
      const m = rulerMarks.find((r) => x >= r.x0 - 3 && x <= r.x1 + 3);
      if (m) change = { kind: m.kind, at: m.at };
    } else if (place === "roll") {
      const h = hit(part, tick, key, 7 / view.wide);
      if (h) [place, note, point] = ["note", h.note, null];
      else if ((ghost = ghostAt(tick, key))) place = "ghost";
    } else if (!phone && laneAt(y) && folded(laneAt(y))) return;
    else if (place === "words" || place === "velocity") note = sounding(part, tick);
    else if (place === "vibrato") {
      const i = pointAt(x, y);
      if (i < 0) return;
      point = i;
    } else if (place === "keys" && !(y >= RULER && y < rows().words)) return;
    if (note && !ed.selected.has(note)) ed.select([note]);
    refresh();
    offer(b.left + x, b.top + y, { place, tick: change ? change.at : snap(tick, step), key, note, change, ghost });
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
  // a phone has no right click and no clipboard here: a finger held is the note's hold
  if (!phone) {
    // a key of Keys play notes let go; and every key let go where the window loses the keys, so
    // that no step is left open
    document.addEventListener("keyup", (e) => {
      const evs = keyboard?.up(e);
      if (!evs) return;
      e.preventDefault();
      if (evs.length) attempt(() => evs.forEach(playIn));
    });
    window.addEventListener("blur", () => { if (keyboard || stepping) attempt(letGoAll); });
    canvas.addEventListener("contextmenu", rollMenu);
    document.addEventListener("paste", pasted);
    // the browser's own Copy and Cut (its Edit menu), where the roll has the keys
    for (const kind of ["copy", "cut"]) {
      document.addEventListener(kind, (e) => {
        if (typingIn(e.target) || tab === "mixer" || !ed.selected.size) return;
        e.preventDefault();
        attempt(() => together(() => e.clipboardData.setData("text/plain", lift(kind === "cut").text)));
      });
    }
  }
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
  // an example opened as its file is; whatever stops it said
  async function example(file) {
    try {
      const r = await window.fetch(new URL(`./examples/${file}`, import.meta.url));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      take(new Uint8Array(await r.arrayBuffer()), file);
    } catch (e) {
      say(`${file}: ${e.message}`, true);
    }
  }
  $("examples").addEventListener("change", () => {
    const file = $("examples").value;
    $("examples").value = "";
    canvas.focus();
    if (file) return example(file);
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
  // on a phone one button sings and stops: Stop while it sounds (paint())
  const aloud = () => playing !== null && playing.ended === null;
  $("sing").addEventListener("click", () => {
    if (!phone || !aloud()) return sing();
    stop();
    say("stopped");
  });
  $("loop").addEventListener("click", () => attempt(toggleLoop));
  $("click").addEventListener("click", () => attempt(() => { set.click.on = !set.click.on; shown(); }));
  $("stop").addEventListener("click", () => attempt(stopped));
  // notes played in: step input, the keys as a keyboard, a take recorded as the score sings, MIDI in
  $("step").addEventListener("click", () => attempt(toggleStep));
  $("keys-play").addEventListener("click", () => attempt(toggleKeys));
  $("record").addEventListener("click", () => attempt(toggleRecord));
  $("quantize").addEventListener("click", () => attempt(toggleQuantize));
  $("take-notes").addEventListener("click", () => attempt(notesOnly));
  $("midi-open").addEventListener("click", () => attempt(() => { midiIn().catch((e) => { say(e.message, true); refresh(); }); }));
  $("midi-input").addEventListener("change", () => {
    const id = $("midi-input").value;
    midi.choose(id === "" ? null : id).then(() => { say(midiSaid()); refresh(); }, (e) => { say(e.message, true); refresh(); });
  });
  // the sound file: made, or stopped while it is made; once made, saved or shared at a press of its own
  for (const id of ["save-sound", "sound-make"]) $(id).addEventListener("click", () => attempt(() => (making() ? cancelSound() : saveSound())));
  $("sound-save").addEventListener("click", () => { if (rendering && rendering.url) say(`saved ${rendering.file}`); });
  $("sound-share").addEventListener("click", () => {
    const r = rendering;
    if (!r || !r.share) return say("there is no sound file to share: press Save sound", true);
    window.navigator.share({ files: [r.share], title: r.score.title || r.file }).then(
      () => say(`${r.file}: shared`),
      (e) => say(e.name === "AbortError" ? `${r.file}: not shared` : `${r.file} was not shared: ${e.message}`, e.name !== "AbortError"),
    );
  });
  $("copy-link").addEventListener("click", () => attempt(copyLink));
  $("link-before").addEventListener("click", () => attempt(backToMine));
  $("undo").addEventListener("click", () => attempt(back));
  $("redo").addEventListener("click", () => attempt(forth));
  $("draw").addEventListener("click", () => attempt(() => { drawing = !drawing; }));
  $("scale").addEventListener("click", () => attempt(toggleScale));
  // the key: a tonic chosen (with the scale shown), or found in the notes again; a scale chosen
  // for the key in force
  $("key-tonic").addEventListener("change", () => attempt(() => {
    const v = $("key-tonic").value;
    chooseKey(v === "" ? null : { tonic: Number(v), scale: $("key-scale").value });
    canvas.focus();
  }));
  $("key-scale").addEventListener("change", () => attempt(() => {
    const K = keyNow();
    if (!K) throw new Error("no key to give a scale: choose its tonic first");
    chooseKey({ tonic: K.tonic, scale: $("key-scale").value });
    canvas.focus();
  }));
  // a press anywhere but the roll, the panel itself, or what sings and moves the view keeps what
  // a tool's panel did and closes it, before what it presses sees the notes
  const BESIDE_IDS = "#sing, #stop, #loop, #click, #click-volume, #fit, #side-toggle";
  if (!phone) document.addEventListener("pointerdown", (e) => {
    if (tool && !tool.el.contains(e.target) && e.target !== canvas && !e.target?.closest?.(BESIDE_IDS)) closeTool(true);
  }, true);
  $("snap").addEventListener("change", () => attempt(() => {
    step = Number($("snap").value);
    stepName = steps(ed.part.grid).find((o) => o.ticks === step).name;
    // step input's notes as long as the snap's step from now
    if (stepping) stepping.steps.length(step);
  }));
  $("fit").addEventListener("click", () => attempt(fit));
  $("side-toggle").addEventListener("click", () => attempt(togglePanel));
  // the panel's sections folded and unfolded at their headings; the Keys help closed
  for (const k of FOLDS) $(`fold-${k}-head`).addEventListener("click", () => attempt(() => foldSection(k)));
  $("keys-close").addEventListener("click", () => { $("keys-help").close(); canvas.focus(); });
  $("which-cancel").addEventListener("click", () => $("which").close());
  // the ways to sing: "as set" first, shown where the settings are no way's, and not to be picked
  {
    const option = (w) => {
      const o = make("option", null, w ? w.name : "as set");
      o.value = w ? w.name : "";
      if (w) o.title = wayLine(w);
      else o.disabled = true;
      return o;
    };
    $("s-way").replaceChildren(option(null), ...Ways.WAYS.map(option));
  }
  $("s-way").addEventListener("change", () => {
    const w = Ways.WAYS.find((x) => x.name === $("s-way").value);
    if (!w) return;
    const line = attempt(() => sungWay(w), $("s-said"));
    if (line) $("s-said").textContent = line;
  });
  $("s-another").addEventListener("click", () => {
    const line = attempt(anotherSeed, $("s-said"));
    if (line) $("s-said").textContent = line;
  });
  $("s-unlink").addEventListener("click", () => attempt(() => unlink(cur)));
  // the makers' buttons run their commands: a panel on a desk, a tap's worth on a phone
  for (const c of COMMANDS.filter((x) => x.id in MAKE)) {
    $(`make-${c.id}`).addEventListener("click", () => {
      const why = Cmd.why(c, here());
      if (why) return say(`${c.label}: ${why}`, true);
      attempt(() => together(() => c.run(here())));
    });
  }
  // a button pressed gives the keys back to the roll, so that space sings and does not press it again
  for (const id of ["save-sound", "sound-make", "sound-save", "sound-share", "copy-link", "link-before", "sing", "stop", "loop", "click", "undo", "redo", "draw", "scale", "fit", "side-toggle", "words-apply", "text-apply", "s-another", "s-unlink", "step", "keys-play", "record", "quantize", "take-notes", "midi-open", ...Object.keys(MAKE).map((id) => `make-${id}`)]) {
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
    // a follower whose leader is given the words has them from it
    const rows = desk.value.rows, by = (e) => rows.find((r) => r.ed === e).follows;
    together(() => { for (const e of eds.filter((x) => !by(x) || !eds.includes(rows[by(x).leader].ed))) e.words(e.part.notes[0], text); });
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
  let fromVisit = false; // the score in the desk is one kept from a visit before
  {
    const was = stored(KEEP, "the score"), one = was === null ? stored(KEPT_PART, "the part") : null;
    newcomer = was === null && one === null && !unread;
    if (was !== null || one !== null) {
      try {
        const s = was !== null ? S.read(was) : S.of(P.read(one));
        desk.value = { title: s.title, master: s.master, chain: s.chain, rows: rowsOf(s) };
        saved = desk.value;
        ed = desk.value.rows[0].ed;
        kept = [desk.value, ...desk.value.rows.map((r) => r.ed.part)];
        fromVisit = true;
        say(was !== null ? "the score as it was left" : "the part as it was left");
      } catch (e) {
        say(`the ${was !== null ? "score" : "part"} of the last visit is not read: ${e.message}`, true);
      }
    }
  }
  // the loop, the click, the speaker's lateness, the other singers' notes, the key and Scale as they
  // were left
  try {
    const text = stored(SET, "the loop, the click and the key");
    if (text !== null) {
      const v = JSON.parse(text), whole = (n) => Number.isInteger(n) && n >= 0;
      // a key kept is a key of theory.js's; settings kept before there was one have none, which is the key found
      const keyed = (k) => k === null || (Boolean(k) && Number.isInteger(k.tonic) && k.tonic >= 0 && k.tonic <= 11 && T.SCALE_NAMES.includes(k.scale));
      if (!(v && v.loop && typeof v.loop.on === "boolean" && whole(v.loop.from) && whole(v.loop.to) && v.click && typeof v.click.on === "boolean" && whole(v.click.volume) && v.click.volume <= 100 && Number.isFinite(v.delay) && typeof v.others === "boolean" && (!("key" in v) || keyed(v.key)) && (!("scale" in v) || typeof v.scale === "boolean"))) throw new Error(text);
      Object.assign(set, { loop: { on: v.loop.on, from: v.loop.from, to: v.loop.to }, click: { on: v.click.on, volume: v.click.volume }, delay: v.delay, others: v.others, key: "key" in v ? v.key && { tonic: v.key.tonic, scale: v.key.scale } : null, scale: v.scale ?? false });
    }
  } catch (e) {
    say(`the loop, the click and the key of the last visit are not read: ${e.message}`, true);
  }
  // the layout as it was left: the panel, its sections, the rows under the roll
  try {
    const text = stored(LAYOUT, "the layout");
    if (text !== null) {
      const v = JSON.parse(text), flags = (o, keys) => Boolean(o) && typeof o === "object" && keys.every((k) => typeof o[k] === "boolean");
      if (!(v && typeof v.panel === "boolean" && flags(v.lanes, Object.keys(layout.lanes)) && flags(v.folds, FOLDS))) throw new Error(text);
      layout.panel = v.panel;
      for (const k of Object.keys(layout.lanes)) layout.lanes[k] = v.lanes[k];
      for (const k of FOLDS) layout.folds[k] = v.folds[k];
    }
  } catch (e) {
    say(`the layout of the last visit is not read: ${e.message}`, true);
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
  // the score put aside when a link opened another, on this visit or one before
  aside.value = stored(BEFORE_LINK, "the score put aside for a link");
  shown();
  frame();
  folds();
  refresh();
  // A score in the page's address (share.js): opened as a file opened is, over the one kept from
  // the visit before, so that Undo brings that back. That one is put aside too, so that a reload
  // or a closed tab does not lose it ("Back to my score", and Find a command). Where a score is
  // put aside already (a link opened before, and not gone back from), that one stays: it is the
  // visitor's own, and the one open is said not to be kept past this page. The address is then
  // cleared of the score, so that a reload opens what has been done since, not the link again.
  // "opened", "none" (the address has no score), or "refused" (said why).
  const linked = SH.fromLocation(window.location).then((text) => {
    if (text === null) return "none";
    return attempt(() => fromLink(text)) ? "opened" : "refused";
  }, (e) => {
    say(`this link's score is not opened: ${e.message}`, true);
    return "refused";
  }).then((how) => {
    if (how !== "none") unaddress();
    if (phone) linkFor(S.write(score()));
    return how;
  });
  function fromLink(text) {
    const s = S.read(text), mine = fromVisit && desk.value.rows.some((r) => r.ed.part.notes.length) ? S.write(score()) : null;
    let said = "", put = false;
    if (mine !== null && mine !== text) {
      if (aside.value !== null) said = "\nthe score that was open is not put aside, as your own is put aside already (Back to my score): Undo brings it back while this page is open";
      else {
        try {
          window.localStorage.setItem(BEFORE_LINK, mine);
          put = true;
          said = "\nyour own score is put aside: Undo, or Back to my score, brings it back";
        } catch (e) {
          said = `\nyour own score is not put aside for a reload (${e.message}): Undo brings it back while this page is open`;
        }
      }
    }
    together(() => {
      open(s);
      if (put) aside.commit(mine);
    });
    say(`the score from the link: ${s.singers.length} ${s.singers.length === 1 ? "singer" : "singers"}, ${s.singers.reduce((n, x) => n + x.part.notes.length, 0)} notes${said}`, said.includes("not put aside"));
    return true;
  }
  // the score's link taken out of the page's address, the rest of it kept
  function unaddress() {
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch (e) {
      say(`${status.textContent}\nthe link stays in the page's address (${e.message}): a reload opens it again`, true);
    }
  }
  // a first visit greeted: the example opened as any file is, and where to start said; unless a
  // link brought a score, or a broken one, which is said instead
  const greeted = welcome && newcomer ? linked.then(async (how) => {
    if (how !== "none") return;
    const r = await window.fetch(new URL(`./examples/${FIRST}`, import.meta.url));
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
    desk, view, fields, board, take, save, paint, sing, stop, heardAt, set, layout, place, show, showMixer, score, tool: () => tool,
    cursor: () => cursor, playing: () => playing, mix: () => mix, sounds, reroute, routes: () => routes, quality, chosen: () => chosen, greeted, linked,
    rendering: () => rendering,
    stepping: () => stepping, keyboard: () => keyboard, recording: () => recording, midi: () => midi,
  };
}
