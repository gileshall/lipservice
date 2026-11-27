// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The engine in wasm (engine/wasm): load the parts from bytes, then speak a step at a time or
// sing a song whole. Samples are mono float at 24 kHz. Works in a browser, a worker or node.

export const SR = 24000;

export class Engine {
  static async create(wasm) {
    const { instance } = await WebAssembly.instantiate(wasm, {});
    return new Engine(instance.exports);
  }

  constructor(x) {
    this.x = x;
  }

  // copies bytes into the instance, calls f(ptr, len), and frees them
  with(bytes, f) {
    const p = this.x.ls_alloc(bytes.length);
    new Uint8Array(this.x.memory.buffer, p, bytes.length).set(bytes);
    try {
      return f(p, bytes.length);
    } finally {
      this.x.ls_free(p, bytes.length);
    }
  }

  check(r) {
    if (r < 0) {
      const m = new Uint8Array(this.x.memory.buffer, this.x.ls_error(), this.x.ls_error_len());
      throw new Error(new TextDecoder().decode(m));
    }
    return r;
  }

  samples(n) {
    return new Float32Array(this.x.memory.buffer, this.x.ls_out(), n).slice();
  }

  // log F0 and voicing pairs at ls_out (n numbers) as Hz a frame, NaN where unvoiced
  hz(n) {
    const p = new Float32Array(this.x.memory.buffer, this.x.ls_out(), n), y = new Float32Array(n / 2);
    for (let i = 0; i < y.length; i++) y[i] = p[2 * i + 1] > 0.5 ? Math.exp(p[2 * i]) : NaN;
    return y;
  }

  // a base file's bytes: its index
  base(bytes) {
    return this.check(this.with(bytes, (p, n) => this.x.ls_base(p, n)));
  }

  // a voice file's bytes, on a base (its index) or whole (-1): the voice's index. parts: the
  // voice's parts kept in files of their own, {vox} its parts of the latent voice (that route
  // alone), {mel} its mel decoder (speech on the mel route alone, so after melvoc())
  voice(bytes, base = -1, parts = {}) {
    const given = (b, f) => (b ? this.with(b, f) : f(0, 0));
    return this.check(this.with(bytes, (p, n) => given(parts.vox, (vp, vn) => given(parts.mel, (mp, mn) => this.x.ls_voice_parts(p, n, base, vp, vn, mp, mn)))));
  }

  vocoder(bytes) {
    this.check(this.with(bytes, (p, n) => this.x.ls_vocoder(p, n)));
  }

  // the latent voice, which speech and songs then go through, as each voice loaded after it wears
  // it
  vox(bytes) {
    this.check(this.with(bytes, (p, n) => this.x.ls_vox(p, n)));
  }

  // the mel route, which speech then goes through
  melvoc(bytes) {
    this.check(this.with(bytes, (p, n) => this.x.ls_melvoc(p, n)));
  }

  // the break model, which speech is then phrased by, at each voice's share of word gaps
  breaks(bytes) {
    this.check(this.with(bytes, (p, n) => this.x.ls_breaks(p, n)));
  }

  phonemizer(g2p, lexicon) {
    this.check(this.with(g2p, (gp, gn) => this.with(lexicon, (lp, ln) => this.x.ls_phonemizer(gp, gn, lp, ln))));
  }

  // speech, as chunks of samples, `step` score frames (10 ms each) at a time
  *say(voice, text, { ssml = false, rate = 1, shift = 0, seed = 0, step = 20 } = {}) {
    this.start(voice, text, { ssml, rate, shift, seed });
    for (;;) {
      const c = this.step(step);
      if (c === null) return;
      yield c;
    }
  }

  // say() a step at a time: start(), then step() until null, reading part(), plan() and pitch() between
  start(voice, text, { ssml = false, rate = 1, shift = 0, seed = 0 } = {}) {
    const b = new TextEncoder().encode(text);
    return this.check(this.with(b, (p, n) => this.x.ls_say(voice, p, n, ssml ? 1 : 0, rate, shift, seed)));
  }

  step(frames) {
    const n = this.check(this.x.ls_step(frames));
    return n === 0 ? null : this.samples(n);
  }

  // the part being said, from 0
  part() {
    return this.check(this.x.ls_say_part());
  }

  // the part being said as planned: {part, parts, gap (samples of silence before it), tokens, dur
  // (frames a token), phrased (tokens that are commas put where a reader would break), words
  // ([text, first, end]), rises ([first, end])}
  plan() {
    const n = this.check(this.x.ls_say_info());
    return JSON.parse(new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, this.x.ls_info(), n)));
  }

  // the part's pitch, Hz a frame (NaN unvoiced), from frame `from` as far as made
  pitch(from) {
    return this.hz(this.check(this.x.ls_say_pitch(from)));
  }

  sing(voice, song, { shift = 0, seed = 0 } = {}) {
    const b = new TextEncoder().encode(song);
    return this.samples(this.check(this.with(b, (p, n) => this.x.ls_sing(voice, p, n, shift, seed))));
  }

  // trained singers' pitch motion, each singer's own (a motion file's bytes), for singer(): its index
  motion(bytes) {
    return this.check(this.with(bytes, (p, n) => this.x.ls_motion(p, n)));
  }

  // the breaths a choir's singers take: the index's bytes (breaths.json) and the sound's (breaths.bin)
  breaths(index, sound) {
    return this.check(this.with(index, (p, n) => this.with(sound, (q, m) => this.x.ls_breaths(p, n, q, m))));
  }

  // a part of a choir performed as a person sings it (engine/src/part.rs), its breaths in its
  // samples: {singer, text (the song as sung), breaths: [[sample of the part, samples]], lag (s it
  // starts late by), shift (semitones, its detune in it)}. part: as choirs.js arrange() gives it;
  // motion: from motion(), or -1. Close the singer when done.
  perform(voice, part, motion = -1) {
    const b = new TextEncoder().encode(JSON.stringify(part));
    const h = this.check(this.with(b, (p, n) => this.x.ls_perform(voice, p, n, motion)));
    return { singer: new Singer(this, h), ...this.info(this.check(this.x.ls_perform_info())) };
  }

  // JSON this engine left at ls_info, n bytes of it
  info(n) {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, this.x.ls_info(), n)));
  }

  // a song's text read (engine/src/song.rs, the one reader of the format; needs no model): {bpm,
  // bpm_line, beats, lead (beats before the first word), together, diction: [{line, text}], items:
  // [{line, kind: "rest" | "word", beat, beats; a word's: word, braces (or null), notes: [[{note,
  // beats_text, midi, beats}]] a syllable each}], vibrato: [{line, beat, sizes}]}. A line is its
  // number from 1. A text that is no song throws, the line's number first.
  song(text) {
    const b = new TextEncoder().encode(text);
    return this.info(this.check(this.with(b, (p, n) => this.x.ls_song(p, n))));
  }

  // a choir arranged (engine/src/choir.rs arrange, as choirs.js arrange() takes it): {parts, seats,
  // room, bpm}, as choir.js start() takes them
  arrange(c, { list, route, seed = 0, voices = [], songs = [], room, motion, how = {} }) {
    const ask = { choir: c, list: list.map(({ name, sex }) => ({ name, sex })), route, seed, voices_by_part: voices.map((v) => v ?? null), songs: songs.map((v) => v ?? null), how };
    if (room !== undefined) ask.room = room;
    if (motion !== undefined) ask.motion = motion === null ? "none" : motion; // null: the machine vibrato
    const b = new TextEncoder().encode(JSON.stringify(ask));
    return this.info(this.check(this.with(b, (p, n) => this.x.ls_arrange(p, n))));
  }

  // a singer's own machine vibrato: {vibrato (peak semitones), vibratoHz, vibratoDelay (s)}
  vibrato(seed) {
    const [vibrato, vibratoHz, vibratoDelay] = this.info(this.check(this.x.ls_vibrato(seed)));
    return { vibrato, vibratoHz, vibratoDelay };
  }

  // n seats facing the listener, left to right (choir.rs seats)
  seats(n, panMax, halfAngle) {
    return this.info(this.check(this.x.ls_seats(n, panMax, halfAngle)));
  }

  // a source at gain from a seat as taps [{ch, g, d}] (choir.rs taps)
  taps(gain, seat) {
    const b = new TextEncoder().encode(JSON.stringify(seat));
    return this.info(this.check(this.with(b, (p, n) => this.x.ls_taps(gain, p, n))));
  }

  // the rooms a choir may be sung in, by name
  rooms() {
    return this.info(this.check(this.x.ls_rooms()));
  }

  // one voice heard alone on its way out: speech, or a song sung alone (sung)
  alone(sung = false) {
    return new Alone(this, this.check(this.x.ls_alone(sung ? 1 : 0)));
  }

  // a song to sing a step at a time, any number at once, in a style: the vibrato (peak
  // semitones), its rate (Hz) and how far into a vowel it starts (s), the glide (frames),
  // dynamics, breathiness, the diction (rules as lines, engine/src/diction.rs, read before the
  // song's own; who: {track, voice, tags}, who sings, for the rules' for=), and a motion (from
  // motion(), in place of the vibrato: one of its singers by the seed, motionScale times that
  // singer's own size) or -1. With the defaults, sing()'s samples.
  // Close it when done.
  singer(voice, song, { shift = 0, seed = 0, vibrato = 0.25, vibratoHz = 5.5, vibratoDelay = 0.25, glide = 9, dynamics = 0, breathiness = 1, diction = [], who = {}, motion = -1, motionScale = 1 } = {}) {
    if (!Array.isArray(diction)) throw new Error(`diction ${JSON.stringify(diction)}: rules as lines, a list`);
    const b = new TextEncoder().encode(song);
    const d = new TextEncoder().encode(JSON.stringify({ who, diction }));
    return new Singer(
      this,
      this.check(this.with(b, (p, n) => this.with(d, (q, m) => this.x.ls_sing_open(voice, p, n, shift, seed, vibrato, vibratoHz, vibratoDelay, glide, dynamics, breathiness, q, m, motion, motionScale)))),
    );
  }
}

// One voice heard alone on its way out (engine/src/alone.rs): a song let down to speech's level,
// held under the ceiling. push() gives what it holds back, end() the rest; close it when done.
export class Alone {
  constructor(engine, handle) {
    this.engine = engine;
    this.handle = handle;
  }

  push(c) {
    const e = this.engine;
    return e.samples(e.check(e.with(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), (p, n) => e.x.ls_alone_push(this.handle, p, n))));
  }

  end() {
    return this.engine.samples(this.engine.check(this.engine.x.ls_alone_end(this.handle)));
  }

  close() {
    this.engine.check(this.engine.x.ls_alone_close(this.handle));
  }
}

export class Singer {
  constructor(engine, handle) {
    this.engine = engine;
    this.handle = handle;
    this.frames = engine.check(engine.x.ls_sing_frames(handle)); // the song's length, 10 ms each
    const r = engine.samples(engine.check(engine.x.ls_sing_rests(handle)));
    this.rests = Array.from({ length: r.length / 2 }, (_, i) => [r[2 * i], r[2 * i + 1]]); // silent spans, [start, end) frames
  }

  // the samples of `frames` more score frames (a little less at first, the rest after the end), or null once all are given
  step(frames) {
    const n = this.engine.check(this.engine.x.ls_sing_step(this.handle, frames));
    return n === 0 ? null : this.engine.samples(n);
  }

  // the song's pitch, Hz a frame (NaN unvoiced), from frame `from` as far as made
  pitch(from) {
    return this.engine.hz(this.engine.check(this.engine.x.ls_sing_pitch(this.handle, from)));
  }

  // picks the song up at `frame`: the next step's samples are the song's from there, as sung from its start
  seek(frame) {
    this.engine.check(this.engine.x.ls_sing_seek(this.handle, frame));
  }

  close() {
    this.engine.check(this.engine.x.ls_sing_close(this.handle));
  }
}
