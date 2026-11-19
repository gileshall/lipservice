// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The conductor keeps a choir's take (take.js, a tape) made where it is wanted: ahead of the speaker
// (deck.js) wherever that is set down, and again from just ahead of it when what is sung changes,
// so a change is heard while the choir plays. How far ahead goes by how long such a making has
// taken to give its first sound: the workers keep what they sang, so a change to the room, the
// seats or the levels alone sings nothing again, and a change to some parts sings those alone. A
// making picked up beside sound made earlier is faded into it at both ends. Asked for the take
// whole (fill()), it makes what the speaker left unmade too, playing or not. No DOM: the page and
// node both use it.

import { SR, Take } from "./take.js";
import { asked } from "./perform.js";
import { TAIL, TRACE } from "./room.js";
import { XF } from "./deck.js";

const down = (s) => Math.floor(s / TRACE) * TRACE;
const up = (s) => Math.ceil(s / TRACE) * TRACE;

export class Conductor {
  // choir (choir.js): its onOpen, onSound, onDone and onError are to be handed to opened(), sound(),
  // done() and error(). deck (deck.js): its ahead() is to ask ahead(). nextId(): a new id, rising.
  // onOpen(take, job): a making of the take has its parts open (take.lanes, take.trace);
  // onDone(take, stats): a making is over (choir.js stats); onError(message). lead: the most s
  // a making goes past a speaker that is up (rein()); null for no such rein.
  constructor({ choir, deck, nextId, now = () => performance.now(), onOpen = () => {}, onDone = () => {}, onError, lead = null }) {
    Object.assign(this, { choir, deck, nextId, now, onOpen, onDone, onError, lead });
    this.cur = null; // the take as it is to be sung now
    this.job = null; // its making: {id, take, from, until, seam, next, t0, first}
    this.whole = false; // the take is wanted made from its start to its end
    this.lat = null; // ms the last making took to its first sound
    this.pace = { mix: null, part: null }; // ms to the first sound with nothing to sing, and more for each part its busiest worker sings
  }

  // settings: {parts, seats, room, bpm} (choirs.js arrange()). The choir sung from its start; what
  // is on the tape already as these settings give it is played again, not made again.
  sing(settings) {
    const key = JSON.stringify(settings), d = this.deck;
    if (this.cur?.key === key) {
      if (d.take === this.cur) d.jump(0);
      else d.load(this.cur, 0, this.now());
      this.ensure();
      return this.cur;
    }
    this.halt();
    this.whole = false;
    const t = Object.assign(new Take("choir", this.now()), { settings, key, total: null, workers: null });
    this.cur = t;
    d.load(t, 0);
    this.make(t, 0, null, null);
    return t;
  }

  // the speaker to sample `at` of the take
  seek(at) {
    if (!this.cur) return;
    this.deck.jump(at);
    this.ensure();
  }

  // ms to the first sound of a making whose busiest worker sings n parts where it starts
  expect(n) {
    const { mix, part } = this.pace;
    if (!n) return mix ?? 250;
    return part === null ? 1000 : (mix ?? 0) + n * part;
  }

  // the most parts one worker would sing for `settings`, the take's parts taken as kept where they
  // are the same; every part with no take or other parts. A muted part is not sung.
  toSing(settings, t = null) {
    const ps = settings.parts, w = t?.workers ?? this.choir.workers(ps.length);
    const old = t && t.workers !== null && t.settings.parts.length === ps.length ? t.settings.parts.map(asked) : null;
    const n = new Array(w).fill(0);
    ps.forEach((p, i) => { if (!p.mute && (!old || asked(p) !== old[i])) n[i % w] += 1; });
    return Math.max(...n);
  }

  // What is sung changes. Playing, the take is made again from a little ahead of the speaker (as
  // long as such a making is expected to take to its first sound, and a third) and changed to
  // there; not playing, it is made when next played.
  change(settings) {
    const key = JSON.stringify(settings), d = this.deck;
    if (!this.cur || key === this.cur.key) return;
    this.halt();
    const ms = 1.3 * this.expect(this.toSing(settings, this.cur));
    const t = Object.assign(this.cur.stale(), { settings, key, total: this.cur.total, workers: this.cur.workers });
    this.cur = t;
    if (!d.utt) {
      d.replace(t);
      this.ensure();
      return;
    }
    const p = Math.ceil(d.played()), wait = Math.round(ms / 1000 * SR);
    let from = Math.max(0, Math.min(up(p + wait), down(d.take.end(p))));
    if (t.total !== null) from = Math.min(from, down(t.total));
    d.swap(t, from);
    this.make(t, from, null, null);
  }

  // The take as it is to be sung now is wanted whole (or, on false, no longer): what of it is not
  // made is made, the speaker's wants first, until none of it is missing. Kept through a change of
  // what is sung; over at a stop, or when another choir is sung.
  fill(on = true) {
    this.whole = on && this.cur !== null;
    this.ensure();
  }

  stop() {
    this.halt();
    this.whole = false;
    this.deck.stop();
  }

  // the take is no longer the page's
  forget() {
    this.halt();
    this.whole = false;
    this.cur = null;
  }

  halt() {
    if (!this.job) return;
    this.choir.stop(this.job.id);
    this.job.take.head = null;
    this.job = null;
  }

  make(t, from, until, seam) {
    this.job = { id: this.nextId(), take: t, from, until, seam, next: from, t0: this.now(), first: null };
    t.head = from;
    this.choir.start({ id: this.job.id, ...t.settings, from, until, trace: t.trace ?? true, lv: t.lanes?.map((l) => l.lv) ?? [] });
    this.rein();
  }

  // The take made on from where the speaker will want it: nothing to do if it is made from the
  // speaker to its end, or a making is at work there; else one is started at the end of the sound
  // in hand, to run to the next sound made already (or the end), faded into both. With the speaker
  // wanting nothing and the take wanted whole, the same from the take's start: a making at work is
  // left to end first (done() asks this again), so each gap is made in its turn.
  ensure() {
    this.wanted();
    this.rein();
  }

  // With the speaker up (paused, stopped, never set down) a making goes no further than `lead` s
  // past where it was: what a listener who stops there, or goes elsewhere, never hears is not sung.
  // A speaker down, or waiting to be set down, has the making run free to the end, and so has a take
  // wanted whole. To be asked whenever the speaker is taken up or moved while up.
  rein() {
    const j = this.job, d = this.deck;
    if (!j || this.lead === null) return;
    const held = !this.whole && d.take === j.take && !d.active;
    this.choir.reach(held ? Math.floor(d.played()) + Math.round(this.lead * SR) : Infinity);
  }

  wanted() {
    const t = this.cur, d = this.deck, j = this.job;
    if (!t) return;
    // where the sound made from s on stops short of the take's end; null if it does not
    const short = (s) => { const u = t.end(s); return t.closed && u >= t.length ? null : u; };
    let u = d.take === t && d.active ? short(Math.floor(d.played())) : null;
    if (u !== null) {
      const keep = Math.max(1, (this.pace.part === null ? 0 : this.expect(this.toSing(t.settings))) / 1000) * SR; // a making this close behind gets there sooner than a new one
      if (j && j.next <= u && u - j.next < keep && (j.until === null || j.until > u)) return;
    } else {
      if (!this.whole || j) return;
      u = short(0);
      if (u === null) { this.whole = false; return; }
    }
    this.halt();
    const a0 = t.begin(u);
    let from = down(Math.max(0, u - XF));
    if (from < a0) from = down(u);
    if (t.total !== null) from = Math.min(from, down(t.total));
    const b = t.next(u);
    const seam = { a: from >= a0 ? from : u, u, b, e: b === null ? null : b + Math.min(XF, t.end(b) - b) };
    this.make(t, from, seam.e, seam);
  }

  // whether the take's making keeps ahead of a speaker set down at c; null while it has not said
  // how fast it goes, or is not at work on the sound c is in
  ahead(t, c) {
    const j = this.job;
    if (!j || j.take !== t || t.end(j.next) !== t.end(c) || this.choir.job?.id !== j.id || !this.choir.measured()) return null;
    return this.choir.keepsUp(c);
  }

  opened(j) {
    const job = this.job;
    if (!job || j.id !== job.id) return;
    const t = job.take;
    t.total = j.mixer.total;
    t.workers = j.w;
    t.close(j.mixer.total + Math.round(TAIL * SR));
    t.trace = j.room.trace;
    if (t.trace) t.trace.given = (f) => t.shows(f * TRACE);
    t.lanes = t.settings.parts.map((p, i) => ({ name: p.name, sex: p.sex, mute: p.mute === true, off: j.mixer.parts[i].off, lv: j.mixer.parts[i].lv, breaths: j.sung[i].breaths, cents: j.sung[i].cents, lag: j.sung[i].lag }));
    this.onOpen(t, j);
    this.deck.pump();
  }

  sound(j, y, at) {
    const job = this.job;
    if (!job || j.id !== job.id) return;
    const t = job.take, now = this.now(), end = at + y[0].length, s = job.seam;
    if (job.first === null) {
      this.lat = job.first = now - job.t0;
      if (!j.picked) this.pace.mix = job.first;
      else this.pace.part = Math.max(0, job.first - (this.pace.mix ?? 0)) / j.picked;
    }
    t.first ??= now - t.t0;
    t.busy = j.busy.reduce((a, b) => a + b, 0);
    t.write(at, y[0], y[1], s);
    job.next = t.head = end;
    // what was made already and is now written again
    if (s) for (const [a, b] of [[s.a, s.u], [s.b, s.e]]) if (a !== null && Math.min(b, end) > Math.max(a, at)) this.deck.wrote(t, Math.max(a, at), Math.min(b, end));
    this.deck.pump();
  }

  done(j, stats) {
    const job = this.job;
    if (!job || j.id !== job.id) return;
    this.job = null;
    job.take.head = null;
    this.onDone(job.take, stats);
    this.ensure();
    this.deck.pump();
  }

  error(message) {
    this.halt();
    this.whole = false;
    this.deck.stop();
    this.onError(message);
  }
}
