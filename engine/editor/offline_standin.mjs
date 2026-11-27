// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// For tests only: a stand-in for the browser's OfflineAudioContext, with the nodes mix.js makes,
// run 128 samples a block as a browser runs them. Gain, StereoPanner (the spec's equal-power
// law), AudioBufferSource, Delay (cycles allowed where the delay is a block or more), Convolver
// (the spec's plain convolution, done by FFT), ChannelSplitter and AudioWorkletNode (the
// registered processor's own process()) make their sound. Biquads and the compressor keep their
// settings and refuse to make sound: the browser's are not written down sample for sample.
// Params keep every call made to them; a render takes only values set at time 0.
//
//   const off = standin({processors, live})
//     processors: the Map another stand-in's registerProcessor fills, where that one is in use:
//                 speaker.js is imported under it; else this one has its own, and imports it
//     live: the AudioWorkletNode class for a context that is not this stand-in's
//   off.OfflineAudioContext, off.AudioBuffer, off.AudioWorkletNode
//   await off.processors()   the Map, speaker.js loaded
//   off.processor(name, said)  a processor made alone, what it posts pushed onto `said`

const BLOCK = 128;
const SPEAKER = new URL("./speaker.js", import.meta.url).href;

export function standin({ processors = null, live = null } = {}) {
  let registry = processors, making = null, loading = null;

  async function load() {
    if (processors) {
      await import(SPEAKER);
      if (!processors.has("limiter")) throw new Error("speaker.js is loaded and its processors are not in the Map given");
      return processors;
    }
    loading ??= (async () => {
      if (globalThis.registerProcessor) throw new Error("registerProcessor is another stand-in's: give standin() its processors");
      const own = new Map();
      globalThis.AudioWorkletProcessor = class {
        constructor() {
          const said = making;
          if (!said) throw new Error("a processor made outside the stand-in");
          this.port = { onmessage: null, postMessage: (m) => said.push(m) };
        }
      };
      globalThis.registerProcessor = (name, made) => own.set(name, made);
      globalThis.sampleRate ??= 24000;
      globalThis.currentFrame ??= 0;
      await import(SPEAKER);
      registry = own;
      return own;
    })();
    return loading;
  }

  function processor(name, said = []) {
    if (!registry) throw new Error("the processors are not loaded: await processors() first");
    const made = registry.get(name);
    if (!made) throw new Error(`no processor "${name}" is registered`);
    making = said;
    try {
      return new made();
    } finally {
      making = null;
    }
  }

  class AudioBuffer {
    constructor({ numberOfChannels = 1, length, sampleRate }) {
      if (!Number.isInteger(numberOfChannels) || numberOfChannels < 1 || numberOfChannels > 32) throw new Error(`NotSupportedError: ${numberOfChannels} channels`);
      if (!Number.isInteger(length) || length < 1) throw new Error(`NotSupportedError: a buffer of ${length} samples`);
      if (!(sampleRate >= 3000 && sampleRate <= 768000)) throw new Error(`NotSupportedError: ${sampleRate} samples a second`);
      Object.assign(this, { numberOfChannels, length, sampleRate, duration: length / sampleRate });
      this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    }
    getChannelData(c) {
      if (!this.data[c]) throw new Error(`IndexSizeError: no channel ${c}`);
      return this.data[c];
    }
  }

  // a value of a node: what it is set to, and every call
  class Param {
    constructor(value) {
      this.v = Math.fround(value);
      this.calls = [];
    }
    get value() { return this.v; }
    set value(v) { this.v = Math.fround(v); this.calls.push(["value", v]); }
    setValueAtTime(v, t) { this.calls.push(["setValueAtTime", v, t]); if (t === 0) this.v = Math.fround(v); return this; }
    setTargetAtTime(v, t, k) { this.calls.push(["setTargetAtTime", v, t, k]); this.v = Math.fround(v); return this; }
    // the value a render goes by
    now(of) {
      if (this.calls.some(([how, , t]) => how !== "value" && (how !== "setValueAtTime" || t !== 0))) throw new Error(`the stand-in renders values set at time 0 only (${of})`);
      return this.v;
    }
  }

  const silent = (n) => Array.from({ length: n }, () => new Float32Array(BLOCK));

  class Node {
    constructor(context, kind, { inputs = 1, count = 2, mode = "max" } = {}) {
      Object.assign(this, { context, kind, channelCount: count, channelCountMode: mode, to: [], memo: -1, out: null, busy: false });
      this.ins = Array.from({ length: inputs }, () => []);
      context.made.push(this);
    }
    connect(to, output = 0, input = 0) {
      if (!(to instanceof Node)) throw new Error(`the ${this.kind} joined to what is not a node of the stand-in`);
      if (to.context !== this.context) throw new Error(`the ${this.kind} joined to a node of another context`);
      if (!to.ins[input]) throw new Error(`the ${to.kind} has no input ${input}`);
      this.to.push([to, output, input]);
      to.ins[input].push([this, output]);
      return to;
    }
    disconnect() {
      for (const [to, , input] of this.to) to.ins[input] = to.ins[input].filter(([n]) => n !== this);
      this.to = [];
    }
    // an input's sound for block b: its sources summed, mixed up or down to its channels
    input(b, i = 0) {
      const from = this.ins[i].map(([n, o]) => n.pull(b)[o]);
      const most = Math.max(1, ...from.map((x) => x.length));
      const n = this.channelCountMode === "explicit" ? this.channelCount : this.channelCountMode === "clamped-max" ? Math.min(most, this.channelCount) : most;
      const out = silent(n);
      for (const x of from) {
        if (x.length === n) x.forEach((ch, c) => { for (let s = 0; s < BLOCK; s++) out[c][s] += ch[s]; });
        else if (x.length === 1 && n === 2) for (const o of out) for (let s = 0; s < BLOCK; s++) o[s] += x[0][s];
        else if (x.length === 2 && n === 1) for (let s = 0; s < BLOCK; s++) out[0][s] += 0.5 * (x[0][s] + x[1][s]);
        else throw new Error(`the stand-in mixes 1 and 2 channels, not ${x.length} into ${n}`);
      }
      return out;
    }
    pull(b) {
      if (this.memo === b) return this.out;
      if (this.busy) throw new Error(`a cycle with no delay in it, at the ${this.kind}`);
      this.busy = true;
      try {
        this.out = this.process(b);
      } finally {
        this.busy = false;
      }
      this.memo = b;
      return this.out;
    }
    process() { throw new Error(`the stand-in makes no ${this.kind}'s sound`); }
  }

  class Gain extends Node {
    constructor(context) { super(context, "gain"); this.gain = new Param(1); }
    process(b) {
      const x = this.input(b), g = this.gain.now("gain");
      return [x.map((ch) => ch.map((v) => v * g))];
    }
  }

  class Panner extends Node {
    constructor(context) { super(context, "pan", { mode: "clamped-max" }); this.pan = new Param(0); }
    process(b) {
      const x = this.input(b), pan = Math.max(-1, Math.min(1, this.pan.now("pan"))), l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
      if (x.length === 1) {
        const a = (pan + 1) / 2 * Math.PI / 2, gl = Math.cos(a), gr = Math.sin(a);
        for (let s = 0; s < BLOCK; s++) [l[s], r[s]] = [x[0][s] * gl, x[0][s] * gr];
      } else {
        const a = (pan <= 0 ? pan + 1 : pan) * Math.PI / 2, gl = Math.cos(a), gr = Math.sin(a);
        for (let s = 0; s < BLOCK; s++) {
          if (pan <= 0) [l[s], r[s]] = [x[0][s] + x[1][s] * gl, x[1][s] * gr];
          else [l[s], r[s]] = [x[0][s] * gl, x[1][s] + x[0][s] * gr];
        }
      }
      return [[l, r]];
    }
  }

  class Source extends Node {
    constructor(context) { super(context, "source", { inputs: 0 }); Object.assign(this, { buffer: null, at: null }); }
    start(when = 0) {
      if (this.at !== null) throw new Error("InvalidStateError: a source started twice");
      const f = when * this.context.sampleRate;
      if (!Number.isInteger(f)) throw new Error(`the stand-in starts a source on a sample, not at ${when} s (sample ${f})`);
      this.at = f;
    }
    process(b) {
      if (!this.buffer) throw new Error("a source with no buffer");
      const n = this.buffer.numberOfChannels, out = silent(n);
      if (this.at === null) return [out];
      for (let c = 0; c < n; c++) {
        const d = this.buffer.getChannelData(c);
        for (let s = 0; s < BLOCK; s++) {
          const j = b * BLOCK + s - this.at;
          if (j >= 0 && j < d.length) out[c][s] = d[j];
        }
      }
      return [out];
    }
  }

  // Delay: what came in, `delayTime` ago, between two samples by a straight line. In a cycle, the
  // block it is pulled for again is made from what it was given before, where the delay is a
  // block or more.
  class Delay extends Node {
    constructor(context, most) {
      super(context, "delay");
      this.delayTime = new Param(0);
      this.most = most;
      this.keep = Math.ceil(most * context.sampleRate) + 2 * BLOCK;
      this.ring = [new Float32Array(this.keep), new Float32Array(this.keep)];
      this.pulling = false;
    }
    read(b) {
      const d = this.delayTime.now("delayTime") * this.context.sampleRate, out = silent(2);
      if (d > this.most * this.context.sampleRate) throw new Error(`a delay of ${d} samples, more than its most`);
      for (let s = 0; s < BLOCK; s++) {
        const p = b * BLOCK + s - d, i = Math.floor(p), f = p - i;
        for (let c = 0; c < 2; c++) {
          const at = (k) => (k < 0 ? 0 : this.ring[c][k % this.keep]);
          out[c][s] = f === 0 ? at(i) : at(i) * (1 - f) + at(i + 1) * f;
        }
      }
      return [out];
    }
    pull(b) {
      if (this.memo === b) return this.out;
      if (this.pulling) {
        if (this.delayTime.now("delayTime") * this.context.sampleRate < BLOCK) throw new Error("a delay under a block in a cycle");
        this.out = this.read(b);
        this.memo = b;
        return this.out;
      }
      this.pulling = true;
      try {
        const x = this.input(b), two = x.length === 1 ? [x[0], x[0]] : x;
        for (let c = 0; c < 2; c++) for (let s = 0; s < BLOCK; s++) this.ring[c][(b * BLOCK + s) % this.keep] = two[c][s];
        if (this.memo !== b) this.out = this.read(b);
      } finally {
        this.pulling = false;
      }
      this.memo = b;
      return this.out;
    }
  }

  // FFT of size 256, in place: re, im
  const N = 2 * BLOCK, bitrev = new Uint16Array(N), cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
  for (let i = 0; i < N; i++) { let r = 0; for (let k = 1, j = i; k < N; k <<= 1, j >>= 1) r = (r << 1) | (j & 1); bitrev[i] = r; }
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = -Math.sin(2 * Math.PI * i / N); }
  function fft(re, im, inverse) {
    for (let i = 0; i < N; i++) { const j = bitrev[i]; if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size / 2, step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = inverse ? -sin[k * step] : sin[k * step], a = i + k, c = a + half;
          const tr = re[c] * wr - im[c] * wi, ti = re[c] * wi + im[c] * wr;
          re[c] = re[a] - tr; im[c] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  }

  // Convolver: each ear's sound through that ear's impulse (a mono sound through both), the
  // impulse cut into blocks, each block's product summed in the frequency domain.
  class Convolver extends Node {
    constructor(context) {
      super(context, "convolver", { mode: "clamped-max" });
      Object.assign(this, { normalize: true, impulse: null, parts: null, past: null, prev: null, at: 0 });
    }
    get buffer() { return this.impulse; }
    set buffer(buf) {
      if (this.normalize) throw new Error("the stand-in convolves without normalizing only");
      if (buf.numberOfChannels !== 2) throw new Error("the stand-in convolves by a two-ear impulse only");
      if (buf.sampleRate !== this.context.sampleRate) throw new Error("an impulse at another rate");
      this.impulse = buf;
      const P = Math.ceil(buf.length / BLOCK);
      this.parts = [0, 1].map((c) => Array.from({ length: P }, (_, p) => {
        const re = new Float64Array(N), im = new Float64Array(N), d = buf.getChannelData(c);
        for (let s = 0; s < BLOCK && p * BLOCK + s < d.length; s++) re[s] = d[p * BLOCK + s];
        fft(re, im, false);
        return [re, im];
      }));
      this.past = [0, 1].map(() => Array.from({ length: P }, () => [new Float64Array(N), new Float64Array(N)]));
      this.prev = [new Float64Array(BLOCK), new Float64Array(BLOCK)];
      this.at = 0;
    }
    process(b) {
      if (!this.impulse) throw new Error("a convolver with no impulse");
      const x = this.input(b), out = silent(2), P = this.parts[0].length;
      for (let c = 0; c < 2; c++) {
        const ear = x.length === 1 ? x[0] : x[c], slot = this.at % P, [re, im] = this.past[c][slot];
        re.fill(0); im.fill(0);
        for (let s = 0; s < BLOCK; s++) { re[s] = this.prev[c][s]; re[BLOCK + s] = ear[s]; this.prev[c][s] = ear[s]; }
        fft(re, im, false);
        const yr = new Float64Array(N), yi = new Float64Array(N);
        for (let p = 0; p < P; p++) {
          const [xr, xi] = this.past[c][(slot - p + P) % P], [hr, hi] = this.parts[c][p];
          for (let k = 0; k < N; k++) { yr[k] += xr[k] * hr[k] - xi[k] * hi[k]; yi[k] += xr[k] * hi[k] + xi[k] * hr[k]; }
        }
        fft(yr, yi, true);
        for (let s = 0; s < BLOCK; s++) out[c][s] = yr[BLOCK + s];
      }
      this.at++;
      return [out];
    }
  }

  class Biquad extends Node {
    constructor(context) { super(context, "biquad"); this.type = "lowpass"; Object.assign(this, { frequency: new Param(350), Q: new Param(1), gain: new Param(0), detune: new Param(0) }); }
    process() { throw new Error("the stand-in makes no biquad's sound"); }
  }

  class Compressor extends Node {
    constructor(context) {
      super(context, "compressor", { mode: "clamped-max" });
      Object.assign(this, { threshold: new Param(-24), knee: new Param(30), ratio: new Param(12), attack: new Param(0.003), release: new Param(0.25) });
    }
    process() { throw new Error("the stand-in makes no compressor's sound"); }
  }

  class Analyser extends Node {
    constructor(context) { super(context, "analyser"); this.fftSize = 2048; }
    getFloatTimeDomainData(a) { a.fill(0); }
    process(b) { return [this.input(b)]; }
  }

  class Splitter extends Node {
    constructor(context, n) { super(context, "split", { count: n, mode: "explicit" }); this.n = n; }
    process(b) { return this.input(b).map((ch) => [ch]); }
  }

  class Destination extends Node {
    constructor(context, n) { super(context, "destination", { count: n, mode: "explicit" }); }
  }

  class AudioWorkletNode extends Node {
    constructor(context, name, options = {}) {
      if (!(context instanceof OfflineAudioContext)) {
        if (!live) throw new Error("an AudioWorkletNode of a context that is not the stand-in's, and no other class given for it");
        return new live(context, name, options);
      }
      if (!context.modules.length) throw new Error(`InvalidStateError: no module added for "${name}"`);
      const { numberOfInputs = 1, numberOfOutputs = 1, outputChannelCount = Array(numberOfOutputs).fill(1), channelCount = 2, channelCountMode = "max" } = options;
      super(context, name, { inputs: numberOfInputs, count: channelCount, mode: channelCountMode });
      Object.assign(this, { name, options, said: [], outputChannelCount });
      this.processor = processor(name, this.said);
      this.port = { onmessage: null, postMessage: (m) => this.processor.port.onmessage?.({ data: m }) };
      this.parameters = new Map((registry.get(name).parameterDescriptors ?? []).map((d) => [d.name, new Param(d.defaultValue)]));
    }
    process(b) {
      const inputs = this.ins.map((from, i) => (from.length ? this.input(b, i) : []));
      const outputs = this.outputChannelCount.map((n) => silent(n));
      const params = Object.fromEntries([...this.parameters].map(([k, p]) => [k, new Float32Array([p.now(k)])]));
      this.processor.process(inputs, outputs, params);
      return outputs;
    }
  }

  class OfflineAudioContext {
    constructor({ numberOfChannels, length, sampleRate }) {
      if (!Number.isInteger(length) || length < 1) throw new Error(`NotSupportedError: a render of ${length} samples`);
      Object.assign(this, { numberOfChannels, length, sampleRate, currentTime: 0, made: [], modules: [], rendered: false });
      this.destination = new Destination(this, numberOfChannels);
      this.audioWorklet = {
        addModule: async (url) => {
          if (!new URL(String(url)).pathname.endsWith("/speaker.js")) throw new Error(`the stand-in loads speaker.js only, not ${url}`);
          await load();
          this.modules.push(String(url));
        },
      };
    }
    createGain() { return new Gain(this); }
    createStereoPanner() { return new Panner(this); }
    createBufferSource() { return new Source(this); }
    createDelay(most = 1) { return new Delay(this, most); }
    createConvolver() { return new Convolver(this); }
    createBiquadFilter() { return new Biquad(this); }
    createDynamicsCompressor() { return new Compressor(this); }
    createAnalyser() { return new Analyser(this); }
    createChannelSplitter(n = 6) { return new Splitter(this, n); }
    createBuffer(numberOfChannels, length, sampleRate) { return new AudioBuffer({ numberOfChannels, length, sampleRate }); }
    async startRendering() {
      if (this.rendered) throw new Error("InvalidStateError: rendered once already");
      this.rendered = true;
      const out = new AudioBuffer({ numberOfChannels: this.numberOfChannels, length: this.length, sampleRate: this.sampleRate });
      const was = [globalThis.sampleRate, globalThis.currentFrame];
      globalThis.sampleRate = this.sampleRate;
      try {
        for (let b = 0; b * BLOCK < this.length; b++) {
          globalThis.currentFrame = b * BLOCK;
          const x = this.destination.input(b), n = Math.min(BLOCK, this.length - b * BLOCK);
          for (let c = 0; c < this.numberOfChannels; c++) out.getChannelData(c).set(x[c].subarray(0, n), b * BLOCK);
          this.currentTime = (b + 1) * BLOCK / this.sampleRate;
        }
      } finally {
        [globalThis.sampleRate, globalThis.currentFrame] = was;
      }
      return out;
    }
  }

  return { OfflineAudioContext, AudioBuffer, AudioWorkletNode, processors: load, processor, Param };
}
