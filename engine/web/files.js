// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A take's sound as a file to keep: WAV, FLAC or MP3, each written here from its first byte to its
// last. WAV and FLAC hold the same 24-bit samples. The MP3 is MPEG-2 Layer III at a constant rate:
// long blocks, one step for a frame's channels, no scalefactors, no bit reservoir, the rate set
// high enough to do without them. No DOM: the page and node both use it.

export const FORMATS = {
  wav: { label: "WAV", ext: "wav", mime: "audio/wav", what: "24-bit, as it is made" },
  flac: { label: "FLAC", ext: "flac", mime: "audio/flac", what: "the same samples, smaller" },
  mp3: { label: "MP3", ext: "mp3", mime: "audio/mpeg", what: "small, plays anywhere" },
};

const BLOCK = 4096; // FLAC's block, and the samples a WAV writes between yields
const FULL = 8388608; // full scale at 24 bits

// channels: one Float32Array, or two of one length, full scale at 1; sr: samples a second. A
// generator, so that a long take is written a slice at a time: it yields the share written, and
// returns {bytes, over}: the file, and how many samples lay beyond full scale and were written at
// it, which is how a speaker plays them.
export function* write(format, channels, sr) {
  if (!Object.hasOwn(FORMATS, format)) throw new Error(`no format ${format}`);
  if (channels.length !== 1 && channels.length !== 2) throw new Error(`${channels.length} channels: one or two`);
  const n = channels[0].length;
  if (!n) throw new Error("nothing to write");
  let over = 0;
  for (const c of channels) {
    if (c.length !== n) throw new Error("the channels differ in length");
    for (let i = 0; i < n; i++) {
      const v = c[i];
      if (v >= -1 && v <= 1) continue;
      if (!Number.isFinite(v)) throw new Error(`sample ${i} is not a number`);
      over += 1;
    }
  }
  const bytes = yield* { wav, flac, mp3 }[format](channels, sr);
  return { bytes, over };
}

// ------------------------------------------------------------------ bits

class Bits {
  constructor(n) {
    this.b = new Uint8Array(n);
    this.n = 0; // whole bytes written
    this.acc = 0;
    this.k = 0; // bits waiting in acc, fewer than 8
  }

  // the n bits of v (n to 24, v below 2^n), the highest first
  put(v, n) {
    if (this.n + 4 > this.b.length) {
      const b = new Uint8Array(2 * this.b.length);
      b.set(this.b);
      this.b = b;
    }
    this.acc = (this.acc << n) | v;
    this.k += n;
    while (this.k >= 8) {
      this.k -= 8;
      this.b[this.n++] = this.acc >>> this.k;
    }
    this.acc &= (1 << this.k) - 1;
  }

  // n to 32
  long(v, n) {
    if (n > 16) {
      this.put((v >>> 16) & ((1 << (n - 16)) - 1), n - 16);
      this.put(v & 0xffff, 16);
    } else this.put(v, n);
  }

  zeros(n) {
    for (; n > 24; n -= 24) this.put(0, 24);
    this.put(0, n);
  }

  align() {
    if (this.k) this.put(0, 8 - this.k);
  }
}

const ascii = (b, at, s) => { for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i); };

// ------------------------------------------------------------------ 24 bits: WAV and FLAC

// m samples of x from `at` as 24-bit whole numbers
function fix(x, at, m, out) {
  for (let i = 0; i < m; i++) {
    const v = Math.round(x[at + i] * FULL);
    out[i] = v > FULL - 1 ? FULL - 1 : v < -FULL ? -FULL : v;
  }
}

// the channels' first m samples, a sample of each in turn, low byte first
function pack(xs, m, b, at) {
  for (let i = 0; i < m; i++) {
    for (let c = 0; c < xs.length; c++) {
      const v = xs[c][i];
      b[at++] = v;
      b[at++] = v >> 8;
      b[at++] = v >> 16;
    }
  }
}

// The header that says more than 16 bits properly: WAVE_FORMAT_EXTENSIBLE, with PCM named inside it.
const WAV_HEAD = 68, WAV_PCM = [1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];

function* wav(chs, sr) {
  const n = chs[0].length, c = chs.length, size = 3 * c * n, pad = size & 1;
  if (WAV_HEAD + size + pad > 0xffffffff) throw new Error("wav: more than four gigabytes");
  const b = new Uint8Array(WAV_HEAD + size + pad), v = new DataView(b.buffer);
  ascii(b, 0, "RIFF");
  v.setUint32(4, WAV_HEAD - 8 + size + pad, true);
  ascii(b, 8, "WAVEfmt ");
  v.setUint32(16, 40, true);
  v.setUint16(20, 0xfffe, true);
  v.setUint16(22, c, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, 3 * c * sr, true);
  v.setUint16(32, 3 * c, true);
  v.setUint16(34, 24, true);
  v.setUint16(36, 22, true);
  v.setUint16(38, 24, true); // the bits that count
  v.setUint32(40, c === 1 ? 4 : 3, true); // the speakers: the middle one, or left and right
  b.set(WAV_PCM, 44);
  ascii(b, 60, "data");
  v.setUint32(64, size, true);
  const xs = chs.map(() => new Int32Array(BLOCK));
  for (let at = 0; at < n; at += BLOCK) {
    const m = Math.min(BLOCK, n - at);
    chs.forEach((x, k) => fix(x, at, m, xs[k]));
    pack(xs, m, b, WAV_HEAD + 3 * c * at);
    yield (at + m) / n;
  }
  return b;
}

// RFC 1321, which FLAC signs its samples with
const MD5_K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
class Md5 {
  constructor() {
    this.h = Int32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476);
    this.buf = new Uint8Array(64);
    this.fill = 0;
    this.len = 0;
  }

  block(b, o) {
    const h = this.h;
    let a = h[0], x = h[1], c = h[2], d = h[3];
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (x & c) | (~x & d); g = i; }
      else if (i < 32) { f = (d & x) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = x ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (x | ~d); g = (7 * i) & 15; }
      const p = o + 4 * g, s = MD5_S[(i >> 4) * 4 + (i & 3)];
      f = (f + a + MD5_K[i] + (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24))) | 0;
      a = d;
      d = c;
      c = x;
      x = (x + ((f << s) | (f >>> (32 - s)))) | 0;
    }
    h[0] += a;
    h[1] += x;
    h[2] += c;
    h[3] += d;
  }

  update(b) {
    this.len += b.length;
    let i = 0;
    if (this.fill) {
      const take = Math.min(64 - this.fill, b.length);
      this.buf.set(b.subarray(0, take), this.fill);
      this.fill += take;
      i = take;
      if (this.fill < 64) return;
      this.block(this.buf, 0);
      this.fill = 0;
    }
    for (; i + 64 <= b.length; i += 64) this.block(b, i);
    this.buf.set(b.subarray(i));
    this.fill = b.length - i;
  }

  digest() {
    const bits = this.len * 8, tail = new Uint8Array((this.fill < 56 ? 56 : 120) - this.fill + 8), v = new DataView(tail.buffer);
    tail[0] = 0x80;
    v.setUint32(tail.length - 8, bits >>> 0, true);
    v.setUint32(tail.length - 4, Math.floor(bits / 4294967296), true);
    this.update(tail);
    return new Uint8Array(this.h.buffer.slice(0));
  }
}
export const md5 = (bytes) => { const m = new Md5(); m.update(bytes); return m.digest(); };

const crcTable = (poly, bits) => Array.from({ length: 256 }, (_, i) => {
  let c = i << (bits - 8);
  for (let k = 0; k < 8; k++) c = c & (1 << (bits - 1)) ? (c << 1) ^ poly : c << 1;
  return c & ((1 << bits) - 1);
});
const CRC8 = crcTable(0x07, 8), CRC16 = crcTable(0x8005, 16);
const crc8 = (b, a, e) => { let c = 0; for (let i = a; i < e; i++) c = CRC8[c ^ b[i]]; return c; };
const crc16 = (b, a, e) => { let c = 0; for (let i = a; i < e; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]]; return c; };

const FLAC_RATE = { 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };
const U = new Uint32Array(BLOCK), MID = new Int32Array(BLOCK), SIDE = new Int32Array(BLOCK);

// x[order, n) less what a fixed predictor of that order makes of the samples before each, folded
// to whole numbers from 0 (0, -1, 1, -2, …), into U
function fold(x, n, order) {
  for (let i = order; i < n; i++) {
    const r = order === 0 ? x[i]
      : order === 1 ? x[i] - x[i - 1]
      : order === 2 ? x[i] - 2 * x[i - 1] + x[i - 2]
      : order === 3 ? x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]
      : x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    U[i - order] = (r << 1) ^ (r >> 31);
  }
}

// U's n - order numbers as Rice codes: the partitions and each one's parameter that take the
// fewest bits, counted closely enough to choose by
function rice(n, order) {
  let top = 0;
  while (top < 8 && !((n >> top) & 1) && (n >> (top + 1)) > order) top++;
  const sums = new Float64Array(1 << top);
  for (let j = 0, i = 0; j < sums.length; j++) {
    let s = 0;
    for (const e = (j + 1) * (n >> top) - order; i < e; i++) s += U[i];
    sums[j] = s;
  }
  let best = null;
  for (let p = top; p >= 0; p--) {
    const ks = new Uint8Array(1 << p);
    let bits = 6 + 5 * ks.length;
    for (let j = 0; j < ks.length; j++) {
      const m = (n >> p) - (j ? 0 : order), s = sums[j];
      const cost = (k) => m * (k + 1) + (k ? s / 2 ** k - m / 2 : s);
      let k = s > m ? Math.min(29, Math.floor(Math.log2(s / m))) : 0;
      if (cost(k + 1) < cost(k)) k += 1;
      ks[j] = k;
      bits += cost(k);
    }
    if (!best || bits < best.bits) best = { p, ks, bits };
    for (let j = 0; j < ks.length >> 1; j++) sums[j] = sums[2 * j] + sums[2 * j + 1];
  }
  return best;
}

// How a channel's n samples of `bps` bits are best written: as one value, as they are, or as the
// residual of the fixed predictor that leaves the least.
function plan(x, n, bps) {
  let i = 1;
  while (i < n && x[i] === x[0]) i++;
  if (i === n) return { kind: "one", bits: 8 + bps };
  const top = Math.min(4, n - 1), e = [0, 0, 0, 0, 0];
  for (i = top; i < n; i++) {
    const d1 = x[i] - x[i - 1], d2 = d1 - (x[i - 1] - x[i - 2]), d3 = d2 - (x[i - 1] - 2 * x[i - 2] + x[i - 3]);
    e[0] += Math.abs(x[i]);
    e[1] += Math.abs(d1);
    e[2] += Math.abs(d2);
    e[3] += Math.abs(d3);
    e[4] += Math.abs(d3 - (x[i - 1] - 3 * x[i - 2] + 3 * x[i - 3] - x[i - 4]));
  }
  let order = 0;
  for (let o = 1; o <= top; o++) if (e[o] < e[order]) order = o;
  fold(x, n, order);
  const r = rice(n, order), bits = 8 + order * bps + r.bits;
  return bits < 8 + n * bps ? { kind: "fixed", order, ...r, bits } : { kind: "raw", bits: 8 + n * bps };
}

function subframe(out, x, n, bps, how) {
  const mask = bps === 32 ? -1 : (1 << bps) - 1;
  if (how.kind === "one") {
    out.put(0, 8);
    out.long(x[0] & mask, bps);
    return;
  }
  if (how.kind === "raw") {
    out.put(2, 8);
    for (let i = 0; i < n; i++) out.long(x[i] & mask, bps);
    return;
  }
  const { order, p, ks } = how;
  out.put((8 | order) << 1, 8);
  for (let i = 0; i < order; i++) out.long(x[i] & mask, bps);
  fold(x, n, order);
  out.put(1, 2); // Rice parameters of five bits
  out.put(p, 4);
  for (let j = 0, i = 0; j < ks.length; j++) {
    const k = ks[j], low = (1 << k) - 1;
    out.put(k, 5);
    for (const e = (j + 1) * (n >> p) - order; i < e; i++) {
      const u = U[i];
      let q = u >>> k;
      for (; q >= 24; q -= 24) out.put(0, 24);
      out.put(1, q + 1);
      out.long(u & low, k);
    }
  }
}

function flacFrame(out, xs, n, number, rate) {
  const start = out.n;
  let subs;
  if (xs.length === 1) subs = [0, [xs[0], 24, plan(xs[0], n, 24)]];
  else {
    const [l, r] = xs;
    for (let i = 0; i < n; i++) {
      MID[i] = (l[i] + r[i]) >> 1;
      SIDE[i] = l[i] - r[i];
    }
    const L = [l, 24, plan(l, n, 24)], R = [r, 24, plan(r, n, 24)], M = [MID, 24, plan(MID, n, 24)], S = [SIDE, 25, plan(SIDE, n, 25)];
    subs = [[1, L, R], [8, L, S], [9, S, R], [10, M, S]].reduce((a, b) => (b[1][2].bits + b[2][2].bits < a[1][2].bits + a[2][2].bits ? b : a));
  }
  const size = n === BLOCK ? 12 : n <= 256 ? 6 : 7;
  out.put(0xff, 8);
  out.put(0xf8, 8);
  out.put((size << 4) | rate, 8);
  out.put((subs[0] << 4) | (6 << 1), 8);
  if (number < 0x80) out.put(number, 8);
  else {
    let k = 1;
    while (number >= 1 << (5 * k + 6)) k++;
    out.put(((0xff00 >> (k + 1)) & 0xff) | (number >> (6 * k)), 8);
    for (let j = k - 1; j >= 0; j--) out.put(0x80 | ((number >> (6 * j)) & 63), 8);
  }
  if (size === 6) out.put(n - 1, 8);
  else if (size === 7) out.put(n - 1, 16);
  out.put(crc8(out.b, start, out.n), 8);
  for (const [x, bps, how] of subs.slice(1)) subframe(out, x, n, bps, how);
  out.align();
  out.put(crc16(out.b, start, out.n), 16);
}

function* flac(chs, sr) {
  const rate = FLAC_RATE[sr];
  if (!rate) throw new Error(`flac: no ${sr} Hz`);
  const n = chs[0].length, c = chs.length, sum = new Md5();
  const out = new Bits(1 << 20), xs = chs.map(() => new Int32Array(BLOCK)), raw = new Uint8Array(3 * c * BLOCK);
  let least = Infinity, most = 0;
  out.n = 42;
  for (let at = 0, f = 0; at < n; at += BLOCK, f++) {
    const m = Math.min(BLOCK, n - at), start = out.n;
    chs.forEach((x, k) => fix(x, at, m, xs[k]));
    pack(xs, m, raw, 0);
    sum.update(raw.subarray(0, 3 * c * m));
    flacFrame(out, xs.map((x) => x.subarray(0, m)), m, f, rate);
    least = Math.min(least, out.n - start);
    most = Math.max(most, out.n - start);
    yield (at + m) / n;
  }
  const b = out.b.slice(0, out.n), v = new DataView(b.buffer);
  ascii(b, 0, "fLaC");
  v.setUint32(4, 0x80000022); // the stream's one block of notes, 34 bytes
  v.setUint16(8, BLOCK);
  v.setUint16(10, BLOCK);
  v.setUint32(12, least << 8);
  v.setUint32(15, most << 8);
  v.setUint32(18, (sr << 12) | ((c - 1) << 9) | (23 << 4) | Math.floor(n / 4294967296));
  v.setUint32(22, n >>> 0);
  b.set(sum.digest(), 26);
  return b;
}

// ------------------------------------------------------------------ MP3

const MP3_SR = 24000;
const MP3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
export const MP3_RATE = { 1: 96, 2: 160 }; // kbit/s for one channel and for two
// The samples by which the sound comes late out of a decoder: the two filter banks and the
// overlap of the blocks. A file's frames run this far past its sound.
export const MP3_DELAY = 1057;

// ISO/IEC 11172-3 Table C.1, the analysis window, as its first 257 values times 2^21
const WINDOW = [
  0, -1, -1, -1, -1, -1, -1, -2, -2, -2, -2, -3, -3, -4, -4, -5, -5, -6, -7, -7, -8, -9, -10, -11, -13, -14, -16, -17, -19, -21, -24, -26,
  -29, -31, -35, -38, -41, -45, -49, -53, -58, -63, -68, -73, -79, -85, -91, -97, -104, -111, -117, -125, -132, -139, -146, -154, -161, -169, -176, -183, -190, -196, -202, -208,
  213, 218, 222, 225, 227, 228, 228, 227, 224, 221, 215, 208, 200, 189, 177, 163, 146, 127, 106, 83, 57, 29, -2, -36, -72, -111, -153, -197, -244, -294, -347, -401,
  -459, -519, -581, -645, -711, -779, -848, -919, -991, -1064, -1137, -1210, -1283, -1356, -1428, -1498, -1567, -1634, -1698, -1759, -1817, -1870, -1919, -1962, -2001, -2032, -2057, -2075, -2085, -2087, -2080, -2063,
  2037, 2000, 1952, 1893, 1822, 1739, 1644, 1535, 1414, 1280, 1131, 970, 794, 605, 402, 185, -45, -288, -545, -814, -1095, -1388, -1692, -2006, -2330, -2663, -3004, -3351, -3705, -4063, -4425, -4788,
  -5153, -5517, -5879, -6237, -6589, -6935, -7271, -7597, -7910, -8209, -8491, -8755, -8998, -9219, -9416, -9585, -9727, -9838, -9916, -9959, -9966, -9935, -9863, -9750, -9592, -9389, -9139, -8840, -8492, -8092, -7640, -7134,
  6574, 5959, 5288, 4561, 3776, 2935, 2037, 1082, 70, -998, -2122, -3300, -4533, -5818, -7154, -8540, -9975, -11455, -12980, -14548, -16155, -17799, -19478, -21189, -22929, -24694, -26482, -28289, -30112, -31947, -33791, -35640,
  -37489, -39336, -41176, -43006, -44821, -46617, -48390, -50137, -51853, -53534, -55178, -56778, -58333, -59838, -61289, -62684, -64019, -65290, -66494, -67629, -68692, -69679, -70590, -71420, -72169, -72835, -73415, -73908, -74313, -74630, -74856, -74992,
  75038,
];
if (WINDOW.length !== 257) throw new Error("files: the window has not 257 values");
export const C = new Float64Array(512);
for (let i = 0; i <= 256; i++) {
  C[i] = WINDOW[i] / 2097152;
  if (i) C[512 - i] = i & 63 ? -C[i] : C[i];
}
// the 32 bands from the 64 windowed sums, folded to 32
const BANDS = Float64Array.from({ length: 1024 }, (_, i) => Math.cos((2 * (i >> 5) + 1) * (i & 31) * Math.PI / 64));
// each band's 18 lines from two blocks of its samples, under the sine window
const LINES = Float64Array.from({ length: 648 }, (_, i) => {
  const m = Math.floor(i / 36), n = i % 36;
  return Math.sin(Math.PI * (n + 0.5) / 36) * Math.cos(Math.PI / 72 * (2 * n + 19) * (2 * m + 1)) / 9;
});
// what the decoder's butterflies between neighbouring bands undo
const ALIAS = [-0.6, -0.535, -0.33, -0.185, -0.095, -0.041, -0.0142, -0.0037].map((c) => [1 / Math.sqrt(1 + c * c), c / Math.sqrt(1 + c * c)]);
// where the scalefactor bands start at 24 kHz
const SFB = [0, 6, 12, 18, 24, 30, 36, 44, 54, 66, 80, 96, 114, 136, 162, 194, 232, 278, 332, 394, 464, 540, 576];

// ISO/IEC 11172-3 Table B.7: each table's side, then its pairs' codes and their lengths
const B7 = {
  1: [2, [1, 1, 1, 0], [1, 3, 2, 3]],
  2: [3, [1, 2, 1, 3, 1, 1, 3, 2, 0], [1, 3, 6, 3, 3, 5, 5, 5, 6]],
  3: [3, [3, 2, 1, 1, 1, 1, 3, 2, 0], [2, 2, 6, 3, 2, 5, 5, 5, 6]],
  5: [4, [1, 2, 6, 5, 3, 1, 4, 4, 7, 5, 7, 1, 6, 1, 1, 0], [1, 3, 6, 7, 3, 3, 6, 7, 6, 6, 7, 8, 7, 6, 7, 8]],
  6: [4, [7, 3, 5, 1, 6, 2, 3, 2, 5, 4, 4, 1, 3, 3, 2, 0], [3, 3, 5, 7, 3, 2, 4, 5, 4, 4, 5, 6, 6, 5, 6, 7]],
  7: [6, [
    1, 2, 10, 19, 16, 10, 3, 3, 7, 10, 5, 3, 11, 4, 13, 17, 8, 4, 12, 11, 18, 15, 11, 2, 7, 6, 9, 14, 3, 1, 6, 4, 5, 3, 2, 0,
  ], [
    1, 3, 6, 8, 8, 9, 3, 4, 6, 7, 7, 8, 6, 5, 7, 8, 8, 9, 7, 7, 8, 9, 9, 9, 7, 7, 8, 9, 9, 10, 8, 8, 9, 10, 10, 10,
  ]],
  8: [6, [
    3, 4, 6, 18, 12, 5, 5, 1, 2, 16, 9, 3, 7, 3, 5, 14, 7, 3, 19, 17, 15, 13, 10, 4, 13, 5, 8, 11, 5, 1, 12, 4, 4, 1, 1, 0,
  ], [
    2, 3, 6, 8, 8, 9, 3, 2, 4, 8, 8, 8, 6, 4, 6, 8, 8, 9, 8, 8, 8, 9, 9, 10, 8, 7, 8, 9, 10, 10, 9, 8, 9, 9, 11, 11,
  ]],
  9: [6, [
    7, 5, 9, 14, 15, 7, 6, 4, 5, 5, 6, 7, 7, 6, 8, 8, 8, 5, 15, 6, 9, 10, 5, 1, 11, 7, 9, 6, 4, 1, 14, 4, 6, 2, 6, 0,
  ], [
    3, 3, 5, 6, 8, 9, 3, 3, 4, 5, 6, 8, 4, 4, 5, 6, 7, 8, 6, 5, 6, 7, 7, 8, 7, 6, 7, 7, 8, 9, 8, 7, 8, 8, 9, 9,
  ]],
  10: [8, [
    1, 2, 10, 23, 35, 30, 12, 17, 3, 3, 8, 12, 18, 21, 12, 7, 11, 9, 15, 21, 32, 40, 19, 6, 14, 13, 22, 34, 46, 23, 18, 7, 20, 19, 33, 47,
    27, 22, 9, 3, 31, 22, 41, 26, 21, 20, 5, 3, 14, 13, 10, 11, 16, 6, 5, 1, 9, 8, 7, 8, 4, 4, 2, 0,
  ], [
    1, 3, 6, 8, 9, 9, 9, 10, 3, 4, 6, 7, 8, 9, 8, 8, 6, 6, 7, 8, 9, 10, 9, 9, 7, 7, 8, 9, 10, 10, 9, 10, 8, 8, 9, 10, 10, 10, 10, 10, 9, 9,
    10, 10, 11, 11, 10, 11, 8, 8, 9, 10, 10, 10, 11, 11, 9, 8, 9, 10, 10, 11, 11, 11,
  ]],
  11: [8, [
    3, 4, 10, 24, 34, 33, 21, 15, 5, 3, 4, 10, 32, 17, 11, 10, 11, 7, 13, 18, 30, 31, 20, 5, 25, 11, 19, 59, 27, 18, 12, 5, 35, 33, 31, 58,
    30, 16, 7, 5, 28, 26, 32, 19, 17, 15, 8, 14, 14, 12, 9, 13, 14, 9, 4, 1, 11, 4, 6, 6, 6, 3, 2, 0,
  ], [
    2, 3, 5, 7, 8, 9, 8, 9, 3, 3, 4, 6, 8, 8, 7, 8, 5, 5, 6, 7, 8, 9, 8, 8, 7, 6, 7, 9, 8, 10, 8, 9, 8, 8, 8, 9, 9, 10, 9, 10, 8, 8, 9, 10,
    10, 11, 10, 11, 8, 7, 7, 8, 9, 10, 10, 10, 8, 7, 8, 9, 10, 10, 10, 10,
  ]],
  12: [8, [
    9, 6, 16, 33, 41, 39, 38, 26, 7, 5, 6, 9, 23, 16, 26, 11, 17, 7, 11, 14, 21, 30, 10, 7, 17, 10, 15, 12, 18, 28, 14, 5, 32, 13, 22, 19,
    18, 16, 9, 5, 40, 17, 31, 29, 17, 13, 4, 2, 27, 12, 11, 15, 10, 7, 4, 1, 27, 12, 8, 12, 6, 3, 1, 0,
  ], [
    4, 3, 5, 7, 8, 9, 9, 9, 3, 3, 4, 5, 7, 7, 8, 8, 5, 4, 5, 6, 7, 8, 7, 8, 6, 5, 6, 6, 7, 8, 8, 8, 7, 6, 7, 7, 8, 8, 8, 9, 8, 7, 8, 8, 8,
    9, 8, 9, 8, 7, 7, 8, 8, 9, 9, 10, 9, 8, 8, 9, 9, 9, 9, 10,
  ]],
  13: [16, [
    1, 5, 14, 21, 34, 51, 46, 71, 42, 52, 68, 52, 67, 44, 43, 19, 3, 4, 12, 19, 31, 26, 44, 33, 31, 24, 32, 24, 31, 35, 22, 14, 15, 13, 23,
    36, 59, 49, 77, 65, 29, 40, 30, 40, 27, 33, 42, 16, 22, 20, 37, 61, 56, 79, 73, 64, 43, 76, 56, 37, 26, 31, 25, 14, 35, 16, 60, 57, 97,
    75, 114, 91, 54, 73, 55, 41, 48, 53, 23, 24, 58, 27, 50, 96, 76, 70, 93, 84, 77, 58, 79, 29, 74, 49, 41, 17, 47, 45, 78, 74, 115, 94,
    90, 79, 69, 83, 71, 50, 59, 38, 36, 15, 72, 34, 56, 95, 92, 85, 91, 90, 86, 73, 77, 65, 51, 44, 43, 42, 43, 20, 30, 44, 55, 78, 72, 87,
    78, 61, 46, 54, 37, 30, 20, 16, 53, 25, 41, 37, 44, 59, 54, 81, 66, 76, 57, 54, 37, 18, 39, 11, 35, 33, 31, 57, 42, 82, 72, 80, 47, 58,
    55, 21, 22, 26, 38, 22, 53, 25, 23, 38, 70, 60, 51, 36, 55, 26, 34, 23, 27, 14, 9, 7, 34, 32, 28, 39, 49, 75, 30, 52, 48, 40, 52, 28,
    18, 17, 9, 5, 45, 21, 34, 64, 56, 50, 49, 45, 31, 19, 12, 15, 10, 7, 6, 3, 48, 23, 20, 39, 36, 35, 53, 21, 16, 23, 13, 10, 6, 1, 4, 2,
    16, 15, 17, 27, 25, 20, 29, 11, 17, 12, 16, 8, 1, 1, 0, 1,
  ], [
    1, 4, 6, 7, 8, 9, 9, 10, 9, 10, 11, 11, 12, 12, 13, 13, 3, 4, 6, 7, 8, 8, 9, 9, 9, 9, 10, 10, 11, 12, 12, 12, 6, 6, 7, 8, 9, 9, 10, 10,
    9, 10, 10, 11, 11, 12, 13, 13, 7, 7, 8, 9, 9, 10, 10, 10, 10, 11, 11, 11, 11, 12, 13, 13, 8, 7, 9, 9, 10, 10, 11, 11, 10, 11, 11, 12,
    12, 13, 13, 14, 9, 8, 9, 10, 10, 10, 11, 11, 11, 11, 12, 11, 13, 13, 14, 14, 9, 9, 10, 10, 11, 11, 11, 11, 11, 12, 12, 12, 13, 13, 14,
    14, 10, 9, 10, 11, 11, 11, 12, 12, 12, 12, 13, 13, 13, 14, 16, 16, 9, 8, 9, 10, 10, 11, 11, 12, 12, 12, 12, 13, 13, 14, 15, 15, 10, 9,
    10, 10, 11, 11, 11, 13, 12, 13, 13, 14, 14, 14, 16, 15, 10, 10, 10, 11, 11, 12, 12, 13, 12, 13, 14, 13, 14, 15, 16, 17, 11, 10, 10, 11,
    12, 12, 12, 12, 13, 13, 13, 14, 15, 15, 15, 16, 11, 11, 11, 12, 12, 13, 12, 13, 14, 14, 15, 15, 15, 16, 16, 16, 12, 11, 12, 13, 13, 13,
    14, 14, 14, 14, 14, 15, 16, 15, 16, 16, 13, 12, 12, 13, 13, 13, 15, 14, 14, 17, 15, 15, 15, 17, 16, 16, 12, 12, 13, 14, 14, 14, 15, 14,
    15, 15, 16, 16, 19, 18, 19, 16,
  ]],
  15: [16, [
    7, 12, 18, 53, 47, 76, 124, 108, 89, 123, 108, 119, 107, 81, 122, 63, 13, 5, 16, 27, 46, 36, 61, 51, 42, 70, 52, 83, 65, 41, 59, 36, 19,
    17, 15, 24, 41, 34, 59, 48, 40, 64, 50, 78, 62, 80, 56, 33, 29, 28, 25, 43, 39, 63, 55, 93, 76, 59, 93, 72, 54, 75, 50, 29, 52, 22, 42,
    40, 67, 57, 95, 79, 72, 57, 89, 69, 49, 66, 46, 27, 77, 37, 35, 66, 58, 52, 91, 74, 62, 48, 79, 63, 90, 62, 40, 38, 125, 32, 60, 56, 50,
    92, 78, 65, 55, 87, 71, 51, 73, 51, 70, 30, 109, 53, 49, 94, 88, 75, 66, 122, 91, 73, 56, 42, 64, 44, 21, 25, 90, 43, 41, 77, 73, 63,
    56, 92, 77, 66, 47, 67, 48, 53, 36, 20, 71, 34, 67, 60, 58, 49, 88, 76, 67, 106, 71, 54, 38, 39, 23, 15, 109, 53, 51, 47, 90, 82, 58,
    57, 48, 72, 57, 41, 23, 27, 62, 9, 86, 42, 40, 37, 70, 64, 52, 43, 70, 55, 42, 25, 29, 18, 11, 11, 118, 68, 30, 55, 50, 46, 74, 65, 49,
    39, 24, 16, 22, 13, 14, 7, 91, 44, 39, 38, 34, 63, 52, 45, 31, 52, 28, 19, 14, 8, 9, 3, 123, 60, 58, 53, 47, 43, 32, 22, 37, 24, 17, 12,
    15, 10, 2, 1, 71, 37, 34, 30, 28, 20, 17, 26, 21, 16, 10, 6, 8, 6, 2, 0,
  ], [
    3, 4, 5, 7, 7, 8, 9, 9, 9, 10, 10, 11, 11, 11, 12, 13, 4, 3, 5, 6, 7, 7, 8, 8, 8, 9, 9, 10, 10, 10, 11, 11, 5, 5, 5, 6, 7, 7, 8, 8, 8,
    9, 9, 10, 10, 11, 11, 11, 6, 6, 6, 7, 7, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 7, 6, 7, 7, 8, 8, 9, 9, 9, 9, 10, 10, 10, 11, 11, 11, 8,
    7, 7, 8, 8, 8, 9, 9, 9, 9, 10, 10, 11, 11, 11, 12, 9, 7, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 11, 11, 12, 12, 9, 8, 8, 9, 9, 9, 9, 10, 10,
    10, 10, 10, 11, 11, 11, 12, 9, 8, 8, 9, 9, 9, 9, 10, 10, 10, 10, 11, 11, 12, 12, 12, 9, 8, 9, 9, 9, 9, 10, 10, 10, 11, 11, 11, 11, 12,
    12, 12, 10, 9, 9, 9, 10, 10, 10, 10, 10, 11, 11, 11, 11, 12, 13, 12, 10, 9, 9, 9, 10, 10, 10, 10, 11, 11, 11, 11, 12, 12, 12, 13, 11,
    10, 9, 10, 10, 10, 11, 11, 11, 11, 11, 11, 12, 12, 13, 13, 11, 10, 10, 10, 10, 11, 11, 11, 11, 12, 12, 12, 12, 12, 13, 13, 12, 11, 11,
    11, 11, 11, 11, 11, 12, 12, 12, 12, 13, 13, 12, 13, 12, 11, 11, 11, 11, 11, 11, 12, 12, 12, 12, 12, 13, 13, 13, 13,
  ]],
  16: [16, [
    1, 5, 14, 44, 74, 63, 110, 93, 172, 149, 138, 242, 225, 195, 376, 17, 3, 4, 12, 20, 35, 62, 53, 47, 83, 75, 68, 119, 201, 107, 207, 9,
    15, 13, 23, 38, 67, 58, 103, 90, 161, 72, 127, 117, 110, 209, 206, 16, 45, 21, 39, 69, 64, 114, 99, 87, 158, 140, 252, 212, 199, 387,
    365, 26, 75, 36, 68, 65, 115, 101, 179, 164, 155, 264, 246, 226, 395, 382, 362, 9, 66, 30, 59, 56, 102, 185, 173, 265, 142, 253, 232,
    400, 388, 378, 445, 16, 111, 54, 52, 100, 184, 178, 160, 133, 257, 244, 228, 217, 385, 366, 715, 10, 98, 48, 91, 88, 165, 157, 148, 261,
    248, 407, 397, 372, 380, 889, 884, 8, 85, 84, 81, 159, 156, 143, 260, 249, 427, 401, 392, 383, 727, 713, 708, 7, 154, 76, 73, 141, 131,
    256, 245, 426, 406, 394, 384, 735, 359, 710, 352, 11, 139, 129, 67, 125, 247, 233, 229, 219, 393, 743, 737, 720, 885, 882, 439, 4, 243,
    120, 118, 115, 227, 223, 396, 746, 742, 736, 721, 712, 706, 223, 436, 6, 202, 224, 222, 218, 216, 389, 386, 381, 364, 888, 443, 707,
    440, 437, 1728, 4, 747, 211, 210, 208, 370, 379, 734, 723, 714, 1735, 883, 877, 876, 3459, 865, 2, 377, 369, 102, 187, 726, 722, 358,
    711, 709, 866, 1734, 871, 3458, 870, 434, 0, 12, 10, 7, 11, 10, 17, 11, 9, 13, 12, 10, 7, 5, 3, 1, 3,
  ], [
    1, 4, 6, 8, 9, 9, 10, 10, 11, 11, 11, 12, 12, 12, 13, 9, 3, 4, 6, 7, 8, 9, 9, 9, 10, 10, 10, 11, 12, 11, 12, 8, 6, 6, 7, 8, 9, 9, 10,
    10, 11, 10, 11, 11, 11, 12, 12, 9, 8, 7, 8, 9, 9, 10, 10, 10, 11, 11, 12, 12, 12, 13, 13, 10, 9, 8, 9, 9, 10, 10, 11, 11, 11, 12, 12,
    12, 13, 13, 13, 9, 9, 8, 9, 9, 10, 11, 11, 12, 11, 12, 12, 13, 13, 13, 14, 10, 10, 9, 9, 10, 11, 11, 11, 11, 12, 12, 12, 12, 13, 13, 14,
    10, 10, 9, 10, 10, 11, 11, 11, 12, 12, 13, 13, 13, 13, 15, 15, 10, 10, 10, 10, 11, 11, 11, 12, 12, 13, 13, 13, 13, 14, 14, 14, 10, 11,
    10, 10, 11, 11, 12, 12, 13, 13, 13, 13, 14, 13, 14, 13, 11, 11, 11, 10, 11, 12, 12, 12, 12, 13, 14, 14, 14, 15, 15, 14, 10, 12, 11, 11,
    11, 12, 12, 13, 14, 14, 14, 14, 14, 14, 13, 14, 11, 12, 12, 12, 12, 12, 13, 13, 13, 13, 15, 14, 14, 14, 14, 16, 11, 14, 12, 12, 12, 13,
    13, 14, 14, 14, 16, 15, 15, 15, 17, 15, 11, 13, 13, 11, 12, 14, 14, 13, 14, 14, 15, 16, 15, 17, 15, 14, 11, 9, 8, 8, 9, 9, 10, 10, 10,
    11, 11, 11, 11, 11, 11, 11, 8,
  ]],
  24: [16, [
    15, 13, 46, 80, 146, 262, 248, 434, 426, 669, 653, 649, 621, 517, 1032, 88, 14, 12, 21, 38, 71, 130, 122, 216, 209, 198, 327, 345, 319,
    297, 279, 42, 47, 22, 41, 74, 68, 128, 120, 221, 207, 194, 182, 340, 315, 295, 541, 18, 81, 39, 75, 70, 134, 125, 116, 220, 204, 190,
    178, 325, 311, 293, 271, 16, 147, 72, 69, 135, 127, 118, 112, 210, 200, 188, 352, 323, 306, 285, 540, 14, 263, 66, 129, 126, 119, 114,
    214, 202, 192, 180, 341, 317, 301, 281, 262, 12, 249, 123, 121, 117, 113, 215, 206, 195, 185, 347, 330, 308, 291, 272, 520, 10, 435,
    115, 111, 109, 211, 203, 196, 187, 353, 332, 313, 298, 283, 531, 381, 17, 427, 212, 208, 205, 201, 193, 186, 177, 169, 320, 303, 286,
    268, 514, 377, 16, 335, 199, 197, 191, 189, 181, 174, 333, 321, 305, 289, 275, 521, 379, 371, 11, 668, 184, 183, 179, 175, 344, 331,
    314, 304, 290, 277, 530, 383, 373, 366, 10, 652, 346, 171, 168, 164, 318, 309, 299, 287, 276, 263, 513, 375, 368, 362, 6, 648, 322, 316,
    312, 307, 302, 292, 284, 269, 261, 512, 376, 370, 364, 359, 4, 620, 300, 296, 294, 288, 282, 273, 266, 515, 380, 374, 369, 365, 361,
    357, 2, 1033, 280, 278, 274, 267, 264, 259, 382, 378, 372, 367, 363, 360, 358, 356, 0, 43, 20, 19, 17, 15, 13, 11, 9, 7, 6, 4, 7, 5, 3,
    1, 3,
  ], [
    4, 4, 6, 7, 8, 9, 9, 10, 10, 11, 11, 11, 11, 11, 12, 9, 4, 4, 5, 6, 7, 8, 8, 9, 9, 9, 10, 10, 10, 10, 10, 8, 6, 5, 6, 7, 7, 8, 8, 9, 9,
    9, 9, 10, 10, 10, 11, 7, 7, 6, 7, 7, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 10, 7, 8, 7, 7, 8, 8, 8, 8, 9, 9, 9, 10, 10, 10, 10, 11, 7, 9, 7,
    8, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 10, 10, 7, 9, 8, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 10, 10, 11, 7, 10, 8, 8, 8, 9, 9, 9, 9, 10, 10,
    10, 10, 10, 11, 11, 8, 10, 9, 9, 9, 9, 9, 9, 9, 9, 10, 10, 10, 10, 11, 11, 8, 10, 9, 9, 9, 9, 9, 9, 10, 10, 10, 10, 10, 11, 11, 11, 8,
    11, 9, 9, 9, 9, 10, 10, 10, 10, 10, 10, 11, 11, 11, 11, 8, 11, 10, 9, 9, 9, 10, 10, 10, 10, 10, 10, 11, 11, 11, 11, 8, 11, 10, 10, 10,
    10, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11, 8, 11, 10, 10, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11, 11, 11, 8, 12, 10, 10, 10, 10, 10,
    10, 11, 11, 11, 11, 11, 11, 11, 11, 8, 8, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 8, 8, 8, 8, 4,
  ]],
};
// the bits past 15 that tables 16 to 23 and 24 to 31 carry
const LIN16 = [1, 2, 3, 4, 6, 8, 10, 13], LIN24 = [4, 5, 6, 7, 8, 9, 11, 13];
const HUFF = [];
for (let t = 1; t < 32; t++) {
  const src = B7[t < 16 ? t : t < 24 ? 16 : 24];
  if (!src) continue; // there is no table 4 or 14
  const [side, code, len] = src, lin = t < 16 ? 0 : t < 24 ? LIN16[t - 16] : LIN24[t - 24];
  if (code.length !== side * side || len.length !== side * side) throw new Error(`files: table ${t} is not ${side} by ${side}`);
  // a pair's bits with its signs and the bits past 15
  const cost = Uint8Array.from(len, (l, i) => {
    const x = Math.floor(i / side), y = i % side;
    return l + (x > 0) + (y > 0) + (x === 15 ? lin : 0) + (y === 15 ? lin : 0);
  });
  HUFF[t] = { side, lin, code, len, cost };
}
// the tables that can hold a pair whose larger value is the index
const HOLDS = [[0], [1], [2, 3], [5, 6], [7, 8, 9], [7, 8, 9], [10, 11, 12], [10, 11, 12], ...new Array(8).fill([13, 15])];
const MOST = 15 + 8191; // the largest value any table holds
// the fours of values no larger than 1: table A's codes and lengths (table B is four bits, each inverted)
const QUAD_CODE = [1, 5, 4, 5, 6, 5, 4, 4, 7, 3, 6, 0, 7, 2, 3, 1], QUAD_LEN = [1, 4, 4, 5, 4, 6, 5, 6, 4, 5, 5, 6, 5, 6, 6, 6];

// the table that takes the fewest bits for the pairs of ix[a, b), and those bits
function pick(ix, a, b) {
  let max = 0;
  for (let i = a; i < b; i++) if (ix[i] > max) max = ix[i];
  if (!max) return [0, 0];
  const tables = max < 16 ? HOLDS[max] : [16 + LIN16.findIndex((l) => max - 15 < 1 << l), 24 + LIN24.findIndex((l) => max - 15 < 1 << l)];
  let best = 0, least = Infinity;
  for (const t of tables) {
    const { side, cost } = HUFF[t];
    let bits = 0;
    for (let i = a; i < b; i += 2) bits += cost[Math.min(ix[i], 15) * side + Math.min(ix[i + 1], 15)];
    if (bits < least) { best = t; least = bits; }
  }
  return [best, least];
}

class Mp3 {
  constructor(channels, kbps) {
    const rate = MP3_KBPS.indexOf(kbps);
    if (rate < 1) throw new Error(`mp3: no ${kbps} kbit/s`);
    this.c = channels;
    this.rate = rate;
    this.size = 72 * 1000 * kbps / MP3_SR; // bytes a frame: whole at every rate
    this.room = 8 * (this.size - 4 - (channels === 1 ? 9 : 17)); // bits a frame has for its lines
    const each = (make) => Array.from({ length: channels }, make);
    this.line = each(() => new Float64Array(512)); // the last 512 samples, the newest at `at`
    this.at = each(() => 0);
    this.prev = each(() => new Float64Array(576)); // the frame before's band samples
    this.xr = each(() => new Float64Array(576)); // this frame's lines
    this.pw = each(() => new Float64Array(576)); // their sizes to the power 3/4
    this.ix = each(() => new Int32Array(576)); // and quantized
    this.sb = new Float64Array(576);
    this.y = new Float64Array(64);
    this.f = new Float64Array(32);
  }

  // 576 samples of channel c from x[at] (nothing past its end) to this frame's 576 lines
  analyse(c, x, at) {
    const line = this.line[c], sb = this.sb, y = this.y, f = this.f, prev = this.prev[c], xr = this.xr[c], pw = this.pw[c];
    let o = this.at[c];
    for (let t = 0; t < 18; t++) {
      o = (o - 32) & 511;
      for (let i = 0; i < 32; i++) {
        const j = at + 32 * t + i, v = j < x.length ? x[j] : 0;
        line[o + 31 - i] = v > 1 ? 1 : v < -1 ? -1 : v;
      }
      for (let i = 0; i < 64; i++) {
        let s = 0;
        for (let j = i; j < 512; j += 64) s += C[j] * line[(o + j) & 511];
        y[i] = s;
      }
      f[0] = y[16];
      for (let m = 1; m <= 16; m++) f[m] = y[16 + m] + y[16 - m];
      for (let m = 17; m < 32; m++) f[m] = y[16 + m] - y[80 - m];
      for (let k = 0; k < 32; k++) {
        let s = 0;
        for (let m = 0; m < 32; m++) s += BANDS[32 * k + m] * f[m];
        sb[18 * k + t] = k & t & 1 ? -s : s; // every other sample of every other band turned over
      }
    }
    this.at[c] = o;
    for (let k = 0; k < 32; k++) {
      for (let m = 0; m < 18; m++) {
        let s = 0;
        for (let n = 0; n < 18; n++) s += LINES[36 * m + n] * prev[18 * k + n] + LINES[36 * m + 18 + n] * sb[18 * k + n];
        xr[18 * k + m] = s;
      }
    }
    prev.set(sb);
    for (let k = 1; k < 32; k++) {
      for (let i = 0; i < 8; i++) {
        const [cs, ca] = ALIAS[i], lo = 18 * k - 1 - i, hi = 18 * k + i, d = xr[lo], u = xr[hi];
        xr[lo] = d * cs + u * ca;
        xr[hi] = u * cs - d * ca;
      }
    }
    for (let i = 0; i < 576; i++) {
      const v = Math.abs(xr[i]);
      pw[i] = Math.sqrt(v * Math.sqrt(v));
    }
  }

  // Channel c's lines at step g, into ix, and how they are then coded: pairs up to `big` in three
  // regions, each with its table, then `quads` fours of values no larger than 1. null where a
  // value is larger than any table holds.
  shape(c, g) {
    const pw = this.pw[c], ix = this.ix[c], s = 2 ** (-0.1875 * (g - 210));
    let end = 0;
    for (let i = 0; i < 576; i++) {
      const v = pw[i] * s + 0.4054;
      if (v >= MOST + 1) return null;
      ix[i] = v | 0;
      if (ix[i]) end = i + 1;
    }
    end += end & 1;
    let big = end;
    while (big >= 4 && ix[big - 1] <= 1 && ix[big - 2] <= 1 && ix[big - 3] <= 1 && ix[big - 4] <= 1) big -= 4;
    let a = 0, b = 0;
    for (let i = big; i < end; i += 4) {
      const v = ix[i] << 3 | ix[i + 1] << 2 | ix[i + 2] << 1 | ix[i + 3], signs = ix[i] + ix[i + 1] + ix[i + 2] + ix[i + 3];
      a += QUAD_LEN[v] + signs;
      b += 4 + signs;
    }
    // the regions end at scalefactor bands, a third and two thirds of the way through those in use
    let bands = 0;
    while (SFB[bands] < big) bands++;
    const r0 = Math.max(1, Math.round(bands / 3)), r1 = Math.max(1, Math.round(2 * bands / 3) - r0);
    const e0 = Math.min(SFB[r0], big), e1 = Math.min(SFB[r0 + r1], big);
    const t = [pick(ix, 0, e0), pick(ix, e0, e1), pick(ix, e1, big)];
    return { g, big, end, ends: [e0, e1, big], tables: t.map((x) => x[0]), r0: r0 - 1, r1: r1 - 1, b: b < a, bits: t[0][1] + t[1][1] + t[2][1] + Math.min(a, b) };
  }

  // a frame: 576 samples of each channel from `at`
  frame(chs, at, out) {
    const start = out.n, n = this.c;
    for (let c = 0; c < n; c++) this.analyse(c, chs[c], at);
    // one step for the channels, the finest whose bits the frame has room for
    const fit = (g) => {
      const hows = [];
      let bits = 0;
      for (let c = 0; c < n; c++) {
        const how = this.shape(c, g);
        if (!how) return null;
        hows.push(how);
        bits += how.bits;
      }
      return bits <= this.room ? hows : null;
    };
    let lo = 0, hi = 255;
    while (lo < hi) {
      const g = (lo + hi) >> 1;
      if (fit(g)) hi = g;
      else lo = g + 1;
    }
    let hows = fit(lo);
    while (!hows) {
      if (++lo > 255) throw new Error(`mp3: the frame at sample ${at} takes more bits than ${MP3_KBPS[this.rate]} kbit/s has`);
      hows = fit(lo);
    }
    // and a step finer for a channel where the room left allows it
    for (let c = 0; c < n && n > 1 && lo > 0; c++) {
      const how = this.shape(c, lo - 1);
      if (how && how.bits + hows[1 - c].bits <= this.room) hows[c] = how;
    }
    out.put(0xff, 8);
    out.put(0xf3, 8); // MPEG-2, Layer III, no check sum
    out.put((this.rate << 4) | (1 << 2), 8); // 24 kHz, no padding
    out.put(n === 1 ? 0xc4 : 0x04, 8); // one channel or two, an original
    out.put(0, 8); // the frame's lines start with it
    out.put(0, n);
    for (const how of hows) {
      out.put(how.bits, 12);
      out.put(how.big >> 1, 9);
      out.put(how.g, 8);
      out.put(0, 9); // no scalefactors
      out.put(0, 1); // long blocks
      for (const t of how.tables) out.put(t, 5);
      out.put(how.r0, 4);
      out.put(how.r1, 3);
      out.put(0, 1);
      out.put(how.b ? 1 : 0, 1);
    }
    for (let c = 0; c < n; c++) {
      const how = hows[c], ix = this.ix[c], xr = this.xr[c];
      if (!this.shape(c, how.g)) throw new Error("mp3: a frame's lines changed under it");
      let i = 0;
      for (let r = 0; r < 3; r++) {
        if (!how.tables[r]) { i = how.ends[r]; continue; }
        const { side, lin, code, len } = HUFF[how.tables[r]];
        for (; i < how.ends[r]; i += 2) {
          const x = ix[i], y = ix[i + 1], k = Math.min(x, 15) * side + Math.min(y, 15);
          out.put(code[k], len[k]);
          if (lin && x >= 15) out.put(x - 15, lin);
          if (x) out.put(xr[i] < 0 ? 1 : 0, 1);
          if (lin && y >= 15) out.put(y - 15, lin);
          if (y) out.put(xr[i + 1] < 0 ? 1 : 0, 1);
        }
      }
      for (; i < how.end; i += 4) {
        const v = ix[i] << 3 | ix[i + 1] << 2 | ix[i + 2] << 1 | ix[i + 3];
        if (how.b) out.put(15 - v, 4);
        else out.put(QUAD_CODE[v], QUAD_LEN[v]);
        for (let j = i; j < i + 4; j++) if (ix[j]) out.put(xr[j] < 0 ? 1 : 0, 1);
      }
    }
    out.zeros(8 * (start + this.size - out.n) - out.k);
    if (out.n !== start + this.size || out.k) throw new Error("mp3: a frame is not its size");
  }
}

function* mp3(chs, sr) {
  if (sr !== MP3_SR) throw new Error(`mp3: ${sr} Hz, not ${MP3_SR}`);
  const n = chs[0].length, enc = new Mp3(chs.length, MP3_RATE[chs.length]);
  const frames = Math.ceil((n + MP3_DELAY) / 576), out = new Bits(frames * enc.size + 4);
  for (let f = 0; f < frames; f++) {
    enc.frame(chs, 576 * f, out);
    if (f % 8 === 7 || f === frames - 1) yield (f + 1) / frames;
  }
  return out.b.slice(0, out.n);
}
