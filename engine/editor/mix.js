// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The mix as the browser's audio nodes: the speaker's output a singer through that singer's
// level and pan into one bus, the bus through the master's chain of effects and the master's
// level to the machine's output, with the click beside it all. Every setting is live: set() takes
// the mix as it is now and moves the nodes there.
//
//   new Mix(window, audio)   after speaker.js is the context's module
//   set(score, click)        score: {master, chain, singers: [{level, pan, mute, solo}]} (score.js);
//                            click: its gain, 0 to 1
//   peaks()                  {singers: [dB], master: [dB left, dB right]}: the most of the last
//                            moment's sound, -Infinity for none
//   late                     seconds the chain holds the sound back by
//   speaker                  the AudioWorkletNode (speaker.js "speaker")

import { EFFECTS, MOST as SLOTS } from "./score.js";

const LOOK = 72; // speaker.js's limiter sees this many samples ahead

const SOON = 0.012; // seconds a level takes to its new place: no step is heard
const gain = (db) => 10 ** (db / 20);

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

// An effect's nodes: {in, out, set(e), late, close()}.
const MAKE = {
  gain(audio) {
    const g = audio.createGain();
    return { in: g, out: g, nodes: [g], set: (e, t) => g.gain.setTargetAtTime(gain(e.db), t, SOON) };
  },
  filter(audio) {
    const hp = audio.createBiquadFilter(), lp = audio.createBiquadFilter();
    hp.type = "highpass";
    lp.type = "lowpass";
    hp.connect(lp);
    return { in: hp, out: lp, nodes: [hp, lp], set: (e, t) => { hp.frequency.setTargetAtTime(e.lowcut, t, SOON); lp.frequency.setTargetAtTime(e.highcut, t, SOON); } };
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
      set: (e, t) => {
        lo.gain.setTargetAtTime(e.low, t, SOON);
        lo.frequency.setTargetAtTime(e.lowhz, t, SOON);
        mid.gain.setTargetAtTime(e.mid, t, SOON);
        mid.frequency.setTargetAtTime(e.midhz, t, SOON);
        mid.Q.setTargetAtTime(e.q, t, SOON);
        hi.gain.setTargetAtTime(e.high, t, SOON);
        hi.frequency.setTargetAtTime(e.highhz, t, SOON);
      },
    };
  },
  compressor(audio) {
    const c = audio.createDynamicsCompressor(), up = audio.createGain();
    c.connect(up);
    return {
      in: c, out: up, nodes: [c, up], late: 0.006, // the browser's compressor looks 6 ms ahead
      set: (e, t) => {
        c.threshold.setTargetAtTime(e.threshold, t, SOON);
        c.ratio.setTargetAtTime(e.ratio, t, SOON);
        c.knee.setTargetAtTime(e.knee, t, SOON);
        c.attack.setTargetAtTime(e.attack / 1000, t, SOON);
        c.release.setTargetAtTime(e.release / 1000, t, SOON);
        up.gain.setTargetAtTime(gain(e.makeup), t, SOON);
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
      set: (e, t) => {
        delay.delayTime.setTargetAtTime(e.ms / 1000, t, SOON);
        back.gain.setTargetAtTime(e.feedback, t, SOON);
        dry.gain.setTargetAtTime(Math.cos(e.mix * Math.PI / 2), t, SOON);
        wet.gain.setTargetAtTime(Math.sin(e.mix * Math.PI / 2), t, SOON);
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
      set: (e, t) => {
        if (built !== `${e.seconds} ${e.damp}`) {
          ring.buffer = room(audio, e.seconds, e.damp);
          built = `${e.seconds} ${e.damp}`;
        }
        pre.delayTime.setTargetAtTime(e.predelay / 1000, t, SOON);
        dry.gain.setTargetAtTime(Math.cos(e.mix * Math.PI / 2), t, SOON);
        wet.gain.setTargetAtTime(Math.sin(e.mix * Math.PI / 2), t, SOON);
      },
    };
  },
  limiter(audio, window) {
    const node = new window.AudioWorkletNode(audio, "limiter", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit" });
    return {
      in: node, out: node, nodes: [node], late: (LOOK - 1) / audio.sampleRate,
      set: (e, t) => {
        node.parameters.get("ceiling").setTargetAtTime(gain(e.ceiling), t, SOON);
        node.parameters.get("release").setTargetAtTime(e.release / 1000, t, SOON);
      },
    };
  },
};
for (const kind of Object.keys(EFFECTS)) if (!MAKE[kind]) throw new Error(`mix.js makes no ${kind}`);

export class Mix {
  constructor(window, audio) {
    this.window = window;
    this.audio = audio;
    this.speaker = new window.AudioWorkletNode(audio, "speaker", { numberOfInputs: 0, numberOfOutputs: SLOTS + 1, outputChannelCount: Array(SLOTS + 1).fill(1) });
    this.bus = audio.createGain();
    this.bus.channelCount = 2;
    this.bus.channelCountMode = "explicit";
    this.master = audio.createGain();
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
    this.fx = []; // the chain's effects that are on, as built: [{kind, ...its nodes}]
    this.bus.connect(this.master);
    this.late = 0;
  }

  set(score, click) {
    const t = this.audio.currentTime;
    const solo = score.singers.some((s) => s.solo);
    this.strips.forEach((st, i) => {
      const s = score.singers[i];
      st.level.gain.setTargetAtTime(s && !s.mute && (!solo || s.solo) ? gain(s.level) : 0, t, SOON);
      st.pan.pan.setTargetAtTime(s ? s.pan : 0, t, SOON);
    });
    this.master.gain.setTargetAtTime(gain(score.master), t, SOON);
    this.click.gain.setTargetAtTime(click, t, SOON);
    // the chain: built again where its effects or their order have changed, else only set
    const on = score.chain.filter((e) => e.on);
    if (on.length !== this.fx.length || on.some((e, i) => e.kind !== this.fx[i].kind)) {
      this.bus.disconnect();
      for (const f of this.fx) for (const node of f.nodes) node.disconnect();
      this.fx = on.map((e) => ({ kind: e.kind, ...MAKE[e.kind](this.audio, this.window) }));
      let from = this.bus;
      for (const f of this.fx) {
        from.connect(f.in);
        from = f.out;
      }
      from.connect(this.master);
    }
    on.forEach((e, i) => this.fx[i].set(e, t));
    this.late = this.fx.reduce((sum, f) => sum + (f.late ?? 0), 0);
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
