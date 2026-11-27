// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The mix as the browser's audio nodes: the speaker's output a singer through that singer's
// level and pan into one bus, the bus through the master's chain of effects and the master's
// level to the machine's output, with the click beside it all. Every setting is live: set() takes
// the mix as it is now and moves the nodes there.
//
// A sound file is mixed by the same strips and the same chain in an OfflineAudioContext: offline()
// wires each singer's sound from a buffer where live it comes from the speaker, and sets every
// value at once where live it glides there. There is no click in it.
//
//   new Mix(window, audio)   after speaker.js is the context's module
//   set(score, click)        score: {master, chain, singers: [{level, pan, mute, solo}]} (score.js);
//                            click: its gain, 0 to 1
//   peaks()                  {singers: [dB], master: [dB left, dB right]}: the most of the last
//                            moment's sound, -Infinity for none
//   late                     seconds the chain holds the sound back by
//   speaker                  the AudioWorkletNode (speaker.js "speaker")
//
//   strips(score)            [{gain, pan}] a slot: what each singer is heard at, mute and solo in it
//   new Chain(window, audio) the master's chain: in (the bus), out (the master's level), fx, late;
//                            set(score, put) builds and sets it
//   offline(window, audio, score, takes)
//                            takes: [{slot, buffer}], each buffer from the context's first sample.
//                            The mix wired to audio.destination: {late, chain}
//   glide(t), at0            how a value is put: from time t over SOON, or at time 0

import { EFFECTS, MOST as SLOTS } from "./score.js";

const LOOK = 72; // speaker.js's limiter sees this many samples ahead

const SOON = 0.012; // seconds a level takes to its new place: no step is heard
const gain = (db) => 10 ** (db / 20);

// how a value reaches a node's param: live, gliding there from now; in a sound file, there from
// its first sample
export const glide = (t) => (param, v) => param.setTargetAtTime(v, t, SOON);
export const at0 = (param, v) => param.setValueAtTime(v, 0);

// What each of the speaker's outputs is heard at: a singer's level, or nothing where it is muted,
// or where another is soloed and it is not; and its pan.
export function strips(score) {
  const solo = score.singers.some((s) => s.solo);
  return Array.from({ length: SLOTS }, (_, i) => {
    const s = score.singers[i];
    return { gain: s && !s.mute && (!solo || s.solo) ? gain(s.level) : 0, pan: s ? s.pan : 0 };
  });
}

// A room's ring as an impulse: noise dying away to a thousandth in `seconds`, its top going
// first, down toward `damp` Hz. The same numbers give the same room. Each ear its own noise.
export function room(audio, seconds, damp) {
  const rate = audio.sampleRate, n = Math.max(1, Math.round(seconds * rate)), buffer = audio.createBuffer(2, n, rate);
  let seed = 20261117;
  const noise = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2147483648) - 1;
  for (let ch = 0; ch < 2; ch++) {
    const x = buffer.getChannelData(ch);
    let y = 0, energy = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate, cut = damp + (rate / 2 - damp) * Math.exp(-3 * t / seconds);
      const k = 1 - Math.exp(-2 * Math.PI * Math.min(cut, rate * 0.49) / rate);
      y += k * (noise() - y);
      x[i] = y * Math.exp(-6.908 * t / seconds);
      energy += x[i] * x[i];
    }
    const norm = 1 / Math.sqrt(energy);
    for (let i = 0; i < n; i++) x[i] *= norm;
  }
  return buffer;
}

// An effect's nodes: {in, out, nodes, set(e, put), late}.
const MAKE = {
  gain(audio) {
    const g = audio.createGain();
    return { in: g, out: g, nodes: [g], set: (e, put) => put(g.gain, gain(e.db)) };
  },
  filter(audio) {
    const hp = audio.createBiquadFilter(), lp = audio.createBiquadFilter();
    hp.type = "highpass";
    lp.type = "lowpass";
    hp.connect(lp);
    return { in: hp, out: lp, nodes: [hp, lp], set: (e, put) => { put(hp.frequency, e.lowcut); put(lp.frequency, e.highcut); } };
  },
  eq(audio) {
    const lo = audio.createBiquadFilter(), mid = audio.createBiquadFilter(), hi = audio.createBiquadFilter();
    lo.type = "lowshelf";
    mid.type = "peaking";
    hi.type = "highshelf";
    lo.connect(mid);
    mid.connect(hi);
    return {
      in: lo, out: hi, nodes: [lo, mid, hi],
      set: (e, put) => {
        put(lo.gain, e.low);
        put(lo.frequency, e.lowhz);
        put(mid.gain, e.mid);
        put(mid.frequency, e.midhz);
        put(mid.Q, e.q);
        put(hi.gain, e.high);
        put(hi.frequency, e.highhz);
      },
    };
  },
  compressor(audio) {
    const c = audio.createDynamicsCompressor(), up = audio.createGain();
    c.connect(up);
    return {
      in: c, out: up, nodes: [c, up], late: 0.006, // the browser's compressor looks 6 ms ahead
      set: (e, put) => {
        put(c.threshold, e.threshold);
        put(c.ratio, e.ratio);
        put(c.knee, e.knee);
        put(c.attack, e.attack / 1000);
        put(c.release, e.release / 1000);
        put(up.gain, gain(e.makeup));
      },
    };
  },
  echo(audio) {
    const [input, dry, wet, back, out] = [0, 0, 0, 0, 0].map(() => audio.createGain()), delay = audio.createDelay(2);
    input.connect(dry);
    dry.connect(out);
    input.connect(delay);
    delay.connect(back);
    back.connect(delay);
    delay.connect(wet);
    wet.connect(out);
    return {
      in: input, out, nodes: [input, dry, wet, back, out, delay],
      set: (e, put) => {
        put(delay.delayTime, e.ms / 1000);
        put(back.gain, e.feedback);
        put(dry.gain, Math.cos(e.mix * Math.PI / 2));
        put(wet.gain, Math.sin(e.mix * Math.PI / 2));
      },
    };
  },
  reverb(audio) {
    const [input, dry, wet, out] = [0, 0, 0, 0].map(() => audio.createGain()), pre = audio.createDelay(1), ring = audio.createConvolver();
    ring.normalize = false;
    input.connect(dry);
    dry.connect(out);
    input.connect(pre);
    pre.connect(ring);
    ring.connect(wet);
    wet.connect(out);
    let built = "";
    return {
      in: input, out, nodes: [input, dry, wet, out, pre, ring],
      set: (e, put) => {
        if (built !== `${e.seconds} ${e.damp}`) {
          ring.buffer = room(audio, e.seconds, e.damp);
          built = `${e.seconds} ${e.damp}`;
        }
        put(pre.delayTime, e.predelay / 1000);
        put(dry.gain, Math.cos(e.mix * Math.PI / 2));
        put(wet.gain, Math.sin(e.mix * Math.PI / 2));
      },
    };
  },
  limiter(audio, window) {
    const node = new window.AudioWorkletNode(audio, "limiter", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit" });
    return {
      in: node, out: node, nodes: [node], late: (LOOK - 1) / audio.sampleRate,
      set: (e, put) => {
        put(node.parameters.get("ceiling"), gain(e.ceiling));
        put(node.parameters.get("release"), e.release / 1000);
      },
    };
  },
};
for (const kind of Object.keys(EFFECTS)) if (!MAKE[kind]) throw new Error(`mix.js makes no ${kind}`);

// The master's chain: the bus every singer goes into, the effects that are on in their order, and
// the master's level after them.
export class Chain {
  constructor(window, audio) {
    this.window = window;
    this.audio = audio;
    this.in = audio.createGain();
    this.in.channelCount = 2;
    this.in.channelCountMode = "explicit";
    this.out = audio.createGain();
    this.fx = []; // the effects that are on, as built: [{kind, ...its nodes}]
    this.in.connect(this.out);
    this.late = 0;
  }

  // built again where its effects or their order have changed, else only set
  set(score, put) {
    const on = score.chain.filter((e) => e.on);
    if (on.length !== this.fx.length || on.some((e, i) => e.kind !== this.fx[i].kind)) {
      this.in.disconnect();
      for (const f of this.fx) for (const node of f.nodes) node.disconnect();
      this.fx = on.map((e) => ({ kind: e.kind, ...MAKE[e.kind](this.audio, this.window) }));
      let from = this.in;
      for (const f of this.fx) {
        from.connect(f.in);
        from = f.out;
      }
      from.connect(this.out);
    }
    on.forEach((e, i) => this.fx[i].set(e, put));
    put(this.out.gain, gain(score.master));
    this.late = this.fx.reduce((sum, f) => sum + (f.late ?? 0), 0);
  }
}

export class Mix {
  constructor(window, audio) {
    this.window = window;
    this.audio = audio;
    this.speaker = new window.AudioWorkletNode(audio, "speaker", { numberOfInputs: 0, numberOfOutputs: SLOTS + 1, outputChannelCount: Array(SLOTS + 1).fill(1) });
    this.chain = new Chain(window, audio);
    this.strips = Array.from({ length: SLOTS }, (_, i) => {
      const level = audio.createGain(), pan = audio.createStereoPanner(), meter = audio.createAnalyser();
      level.gain.value = 0;
      meter.fftSize = 1024;
      this.speaker.connect(level, i);
      level.connect(pan);
      level.connect(meter);
      pan.connect(this.bus);
      return { level, pan, meter };
    });
    this.click = audio.createGain();
    this.click.gain.value = 0;
    this.speaker.connect(this.click, SLOTS);
    this.click.connect(audio.destination);
    const split = audio.createChannelSplitter(2);
    this.master.connect(audio.destination);
    this.master.connect(split);
    this.meters = [0, 1].map((ch) => {
      const m = audio.createAnalyser();
      m.fftSize = 1024;
      split.connect(m, ch);
      return m;
    });
    this.scratch = new Float32Array(1024);
  }

  get bus() { return this.chain.in; }
  get master() { return this.chain.out; }
  get fx() { return this.chain.fx; }
  get late() { return this.chain.late; }

  set(score, click) {
    const put = glide(this.audio.currentTime);
    strips(score).forEach((s, i) => {
      put(this.strips[i].level.gain, s.gain);
      put(this.strips[i].pan.pan, s.pan);
    });
    put(this.click.gain, click);
    this.chain.set(score, put);
  }

  peaks() {
    const peak = (meter) => {
      meter.getFloatTimeDomainData(this.scratch);
      let top = 0;
      for (const v of this.scratch) top = Math.max(top, Math.abs(v));
      return 20 * Math.log10(top);
    };
    return { singers: this.strips.map((s) => peak(s.meter)), master: this.meters.map(peak) };
  }
}

// The mix of a sound file: each take from its buffer through its singer's level and pan, set
// there from the first sample, into the same chain as live, to the context's output. No click,
// no meters. Every take starts at the context's first sample, so none falls between two.
export function offline(window, audio, score, takes) {
  const chain = new Chain(window, audio), heard = strips(score), rate = audio.sampleRate;
  const sources = takes.map(({ slot, buffer }) => {
    if (!heard[slot]) throw new Error(`the speaker has no slot ${slot}`);
    if (buffer.sampleRate !== rate) throw new Error(`slot ${slot}: its sound is at ${buffer.sampleRate} a second, the mix at ${rate}`);
    const source = audio.createBufferSource(), level = audio.createGain(), pan = audio.createStereoPanner();
    source.buffer = buffer;
    at0(level.gain, heard[slot].gain);
    at0(pan.pan, heard[slot].pan);
    source.connect(level);
    level.connect(pan);
    pan.connect(chain.in);
    return source;
  });
  chain.set(score, at0);
  chain.out.connect(audio.destination);
  for (const source of sources) source.start(0);
  return { late: chain.late, chain };
}
