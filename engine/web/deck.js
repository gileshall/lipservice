// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The deck plays a take (take.js, a tape) through the speaker (player.js): from any made sample, as
// far as the tape is made, a few seconds sent ahead of where it plays. The speaker is set down at
// a sample once the tape is ready there: what is in hand is the whole rest, or the making is known
// to keep ahead from there, or, with a making that has not said how fast it goes, there are some
// seconds of it. A speaker that runs dry is taken up, and set down again where it stopped once the
// making, watched for a while, has enough in hand to reach the take's end at the pace it has kept
// since (one waiting to be changed to another take is left to wait for that). A take made again another way is changed to while it plays, the old faded
// into the new a little ahead of the speaker. What it is told of the speaker's place keeps a
// playhead and how the making has paced it (pace.js). No DOM: the page and node both use it.

import { SR } from "./take.js";

export const FIRST = 0.1; // s of sound in hand before the speaker is set down
export const AMPLE = 4; // s in hand that set it down while the making has yet to say how fast it goes
export const AHEAD = 3; // s the speaker is sent ahead of where it plays
export const XF = 960; // samples one making is faded into another over
export const LATE = 3600; // samples ahead of the speaker a change to its sound is put
export const REFILL = 1; // s the making is watched, at the least, before a speaker that ran dry is set down again
export const SPARE = 0.8; // the part of the pace it kept while watched that is counted on

// How a setting down goes, for pace.js: the sound in hand and heard from `base`, by the ms since t0.
// holds: the times the speaker ran dry and was taken up before this setting down.
const pace = (t0, base, holds = 0) => ({ t0, base, made: [[0, 0]], heardAt: [], first: null, begun: null, done: null, ended: false, stalls: 0, stallAt: [], holds });

export class Deck {
  // send(m, transfer): to the speaker, which answers (hear()) in a later turn, never inside send;
  // clock(): the audio context's sample now, latency(): samples
  // from there to the ear; nextId(): a new id, rising; ahead(take, c): whether the take's making
  // keeps ahead of a speaker set down at c, null if it cannot say yet. onBegin(utterance), onEnd(the speaker's "ended"),
  // onHold(): the speaker ran dry and is taken up, to be set down again (onBegin) where it stopped;
  // onSwap(take, at): the take played is now this one, changed to at sample `at` as it played
  // (null: with nothing playing, or none of it yet heard).
  constructor({ send, clock, latency = () => 0, nextId, ahead = () => true, now = () => performance.now(), onBegin = () => {}, onEnd = () => {}, onHold = () => {}, onSwap = () => {} }) {
    Object.assign(this, { send, clock, latency, nextId, ahead, now, onBegin, onEnd, onHold, onSwap });
    this.take = null;
    this.utt = null; // what the speaker has: {id, base, sent, closed, held}, base the take's sample its first is, held once it is being taken up
    this.want = null; // the sample the speaker is to be set down at, once the take is ready there
    this.next = null; // a take to change to: {take, from}
    this.ref = null; // the speaker's last word: {n, frame}
    this.pos = 0; // where the speaker last was, with nothing playing
    this.run = null; // pace
  }

  // playing, or about to
  get active() { return this.utt !== null || this.want !== null; }

  // a take to play from `at`, its pace counted from t0 (ms)
  load(take, at = 0, t0 = take.t0) {
    this.halt();
    this.next = null;
    this.take = take;
    this.want = this.pos = at;
    this.run = pace(t0, at);
    this.pump();
  }

  // the speaker to `at`
  jump(at) {
    if (!this.take) throw new Error("deck: no take to jump in");
    if (this.next) this.commit();
    this.halt();
    const t = this.take;
    this.want = this.pos = Math.max(0, Math.min(Math.floor(at), (t.length ?? Infinity) - 1));
    this.run = pace(this.now(), this.want);
    this.pump();
  }

  stop() {
    if (this.next) this.commit();
    this.halt();
    this.want = null;
  }

  halt() {
    const u = this.utt;
    if (!u) return;
    this.pos = Math.floor(this.ph());
    this.send({ type: "stop", id: u.id });
    this.utt = null;
    this.ref = null;
    this.run.ended = true;
  }

  // The take is made again another way (take.stale()), from `from` on at first: the speaker changes
  // to it, the old faded into the new, once the new is ready a little ahead of it. The old take
  // must reach `from`.
  swap(take, from) {
    if (!this.utt) throw new Error("deck: nothing is playing to change");
    this.next = { take, from };
    this.pump();
  }

  // the take, with nothing playing, is this one
  replace(take) {
    if (this.utt) throw new Error("deck: a take is playing");
    this.next = null;
    this.take = take;
    this.onSwap(take, null);
    this.pump();
  }

  commit(at = null) {
    const { take } = this.next;
    this.next = null;
    this.take = take;
    this.onSwap(take, at);
  }

  // where the speaker reads, in samples of the take
  played() {
    const u = this.utt;
    if (!u) return this.want ?? this.pos;
    if (!this.ref) return u.base;
    const n = this.ref.n + this.clock() - this.ref.frame;
    return u.base + Math.max(0, Math.min(n, this.ref.n + 2048, u.sent - u.base));
  }

  // what is heard now
  ph() {
    const u = this.utt;
    if (!u || !this.ref) return this.played();
    return Math.max(u.base, this.played() - this.latency());
  }

  // whether a speaker set down at c of the take now has enough
  ready(t, c) {
    const e = t.end(c);
    if (t.closed && e >= t.length) return true;
    const n = e - c;
    if (n < FIRST * SR) return false;
    const a = this.ahead(t, c);
    return a === null ? n >= AMPLE * SR : a;
  }

  // Whether a speaker that ran dry may be set down again at `want`: the making has been watched
  // for REFILL s since its first sound there, and what is in hand is all the take's end needs at
  // SPARE of the pace the making has kept while watched. With the take's length not known, AMPLE s
  // in hand.
  refilled(t) {
    const r = this.run, c = this.want, e = t.end(c);
    if (!r.holds || (t.closed && e >= t.length)) return true;
    if (r.first === null) return false;
    const s = (this.now() - r.t0 - r.first) / 1000;
    if (s < REFILL) return false;
    if (t.length === null) return e - c >= AMPLE * SR;
    return e - c >= (t.length - c) * (1 - SPARE * (e - c) / SR / s);
  }

  // the speaker has played all it was sent of a take that has more to come, and is not waiting to
  // be changed to another
  dry() {
    const u = this.utt;
    return this.ref !== null && !u.closed && !this.next && this.played() >= u.sent;
  }

  // the speaker is taken up: once it says where it stopped (hear()), it is to be set down there
  hold() {
    const u = this.utt;
    u.held = true;
    this.send({ type: "stop", id: u.id });
  }

  // To be called whenever the tape has more or the speaker has moved.
  pump() {
    const t = this.take;
    if (!t) return;
    if (this.want !== null && this.ready(t, this.want) && this.refilled(t)) {
      this.utt = { id: this.nextId(), base: this.want, sent: this.want, closed: false, held: false };
      this.want = null;
      this.ref = null;
      this.run.begun = this.now() - this.run.t0;
      this.onBegin(this.utt);
    }
    if (this.utt && !this.utt.held) {
      if (this.dry()) {
        this.hold();
      } else {
        if (this.next) this.cut();
        this.feed();
      }
    }
    this.note();
  }

  chunk(u, [l, r], at = null) {
    const m = { type: at === null ? "chunk" : "splice", id: u.id, samples: l };
    if (at !== null) m.at = at - u.base;
    if (r) m.right = r;
    this.send(m, r ? [l.buffer, r.buffer] : [l.buffer]);
  }

  feed() {
    const u = this.utt, t = this.take;
    const e = Math.min(t.end(u.sent), Math.ceil(this.played()) + AHEAD * SR);
    if (e > u.sent) {
      this.chunk(u, t.cut(u.sent, e));
      u.sent = e;
    }
    if (!u.closed && t.closed && u.sent >= t.length) {
      this.send({ type: "end", id: u.id });
      u.closed = true;
    }
  }

  // the change to the next take, if it is ready where the change would be put
  cut() {
    const { take: nt, from } = this.next, u = this.utt, old = this.take;
    const oe = old.end(u.sent); // as far as the old take plays on
    if (oe < from) throw new Error(`deck: the take played ends at ${oe}, before the change at ${from}`);
    const c = Math.min(Math.max(from, Math.ceil(this.played()) + LATE), oe);
    if (!this.ready(nt, c)) return;
    if (u.sent < c) {
      this.chunk(u, old.cut(u.sent, c));
      u.sent = c;
    }
    const n = Math.min(XF, oe - c, nt.end(c) - c);
    const e = Math.max(c + n, Math.min(nt.end(c), Math.ceil(this.played()) + AHEAD * SR));
    const y = nt.cut(c, e);
    if (n) {
      const o = old.cut(c, c + n);
      for (let k = 0; k < 2; k++) if (y[k]) for (let i = 0; i < n; i++) y[k][i] = (i / n) * y[k][i] + (1 - i / n) * o[k][i];
    }
    this.chunk(u, y, u.sent > c || u.closed ? c : null);
    u.sent = e;
    u.closed = false;
    this.commit(c);
  }

  // [a, b) of the take was written again: what of it the speaker was sent, and is far enough ahead
  // to change, is sent again
  wrote(take, a, b) {
    const u = this.utt;
    if (!u || take !== this.take) return;
    const c = Math.max(a, Math.ceil(this.played()) + LATE);
    if (c >= Math.min(b, u.sent)) return;
    this.chunk(u, take.cut(c, u.sent), c);
    u.closed = false;
    this.feed();
  }

  // the speaker's word: {type: "at"} or {type: "ended"}
  hear(m) {
    const u = this.utt;
    if (!u || m.id !== u.id) return;
    const r = this.run, now = this.now();
    if (m.type === "at") {
      this.ref = { n: m.n, frame: m.frame };
      const dry = m.stalls > r.stalls;
      if (dry) r.stallAt.push(now - r.t0);
      r.stalls = m.stalls;
      r.heardAt.push([now - r.t0, m.n]);
      if (dry && !u.held && !u.closed && !this.next) this.hold();
      this.pump();
    } else if (m.type === "ended") {
      this.pos = u.base + (this.ref?.n ?? 0);
      this.utt = null;
      this.ref = null;
      r.ended = true;
      if (this.next) this.commit();
      if (!u.held) {
        this.onEnd(m);
        return;
      }
      this.want = this.pos;
      this.run = pace(now, this.pos, r.holds + 1);
      this.onHold();
      this.pump();
    }
  }

  // pace: the sound in hand from where the speaker was set down
  note() {
    const r = this.run, t = this.take, u = this.utt;
    if (!r || r.ended || (!u && this.want === null)) return;
    const e = t.end(u ? u.sent : this.want), made = e - r.base, ms = this.now() - r.t0;
    if (made !== r.made.at(-1)[1]) r.made.push([ms, made]);
    if (r.first === null && made > 0) r.first = ms;
    if (r.done === null && t.closed && e >= t.length) r.done = ms;
  }
}
