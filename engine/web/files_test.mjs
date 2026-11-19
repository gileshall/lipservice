// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// files.js: each file it writes, read back by a program that did not write it. WAV and FLAC must
// return the samples bit for bit; the MP3 must decode, in two decoders, to the sound that went in.
// Needs ffmpeg, flac and lame on the PATH, and fails without them. node files_test.mjs
import { write, md5, FORMATS, MP3_RATE, MP3_DELAY } from "./files.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };

const SR = 24000, FULL = 8388608;
const dir = mkdtempSync(join(tmpdir(), "files-test-"));
const at = (name) => join(dir, name);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });

// the generator run to its end: the file, and the shares it yielded on the way
function made(format, chs, sr = SR) {
  const g = write(format, chs, sr), shares = [];
  for (;;) {
    const r = g.next();
    if (r.done) return { ...r.value, shares };
    shares.push(r.value);
  }
}
const saved = (name, format, chs, sr) => { const m = made(format, chs, sr); writeFileSync(at(name), m.bytes); return m; };

// ------------------------------------------------------------------ sounds

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const tone = (n, hz, amp) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / SR));
const noise = (n, amp, seed) => { const r = rng(seed); return Float32Array.from({ length: n }, () => amp * (2 * r() - 1)); };
const square = (n, hz) => Float32Array.from({ length: n }, (_, i) => Math.floor(2 * hz * i / SR) % 2 ? -1 : 1);
// something like a singer: harmonics of a pitch that wavers, a swell, breath noise under it
function sung(n, hz, seed) {
  const r = rng(seed), x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += 2 * Math.PI * hz * (1 + 0.012 * Math.sin(2 * Math.PI * 5.4 * t)) / SR;
    let v = 0;
    for (let h = 1; h * hz < 9000; h++) v += Math.sin(h * ph) / (h * (1 + ((h * hz - 900) / 700) ** 2 / 6));
    x[i] = 0.3 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.7 * t)) * v + 0.004 * (2 * r() - 1);
  }
  return x;
}
const mix = (a, b, w) => Float32Array.from(a, (v, i) => w * v + (1 - w) * b[i]);

// ------------------------------------------------------------------ reading back

const whole = (x) => Int32Array.from(x, (v) => Math.max(-FULL, Math.min(FULL - 1, Math.round(v * FULL))));
// 24-bit samples, low byte first, a sample of each channel in turn
function s24(b, c) {
  const n = b.length / (3 * c), out = Array.from({ length: c }, () => new Int32Array(n));
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) { const o = 3 * (c * i + k); out[k][i] = (b[o] | b[o + 1] << 8 | b[o + 2] << 16) << 8 >> 8; }
  return out;
}
const same = (got, want) => got.length === want.length && got.every((g, k) => g.length === want[k].length && g.every((v, i) => v === want[k][i]));
const byFfmpeg = (name, c) => s24(run("ffmpeg", ["-v", "error", "-i", at(name), "-f", "s24le", "-"]), c);
const byFlac = (name, c) => s24(run("flac", ["-s", "-c", "-d", "--force-raw-format", "--endian=little", "--sign=signed", at(name)]), c);
function floats(b, c) {
  const all = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)), n = all.length / c;
  return Array.from({ length: c }, (_, k) => Float32Array.from({ length: n }, (_, i) => all[c * i + k]));
}
const mp3ByFfmpeg = (name, c) => floats(run("ffmpeg", ["-v", "error", "-i", at(name), "-f", "f32le", "-"]), c);
// lame's decoder writes a 16-bit WAV
function mp3ByLame(name, c) {
  run("lame", ["--quiet", "--decode", at(name), at(`${name}.wav`)]);
  const b = readFileSync(at(`${name}.wav`)), d = b.indexOf("data"), v = new DataView(b.buffer, b.byteOffset, b.length);
  if (d < 0) throw new Error("lame wrote no data chunk");
  const n = Math.floor((b.length - d - 8) / (2 * c));
  return Array.from({ length: c }, (_, k) => Float32Array.from({ length: n }, (_, i) => v.getInt16(d + 8 + 2 * (c * i + k), true) / 32768));
}
// how far the sound stands over what the decoder got wrong, dB, from sample a to b, the decoder
// late by `delay`
function snr(x, y, delay, a = 0, b = x.length) {
  let e = 0, p = 0;
  for (let i = a; i < b; i++) { e += (y[i + delay] - x[i]) ** 2; p += x[i] ** 2; }
  return 10 * Math.log10(p / e);
}
const LAME_DELAY = MP3_DELAY - 529; // lame's decoder drops its own lateness

// ------------------------------------------------------------------ md5

{
  const r = rng(7), bad = [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70001].filter((n) => {
    const b = Uint8Array.from({ length: n }, () => Math.floor(256 * r()));
    return Buffer.from(md5(b)).toString("hex") !== createHash("md5").update(b).digest("hex");
  });
  check(bad.length === 0, `md5: node's own at every length tried${bad.length ? ` (not ${bad.join(", ")})` : ""}`);
}

// ------------------------------------------------------------------ the two that lose nothing

const voice = sung(30000, 196, 1), other = sung(30000, 293.66, 2);
const SOUNDS = {
  "one sample": [Float32Array.of(0.25)],
  "five samples": [noise(5, 0.5, 3)],
  "a block exactly": [sung(4096, 220, 4)],
  "a block and one": [sung(4097, 220, 5)],
  "one voice": [voice],
  "two voices": [mix(voice, other, 0.7), mix(voice, other, 0.3)],
  "two voices, odd in length": [mix(voice, other, 0.7).subarray(0, 10001), mix(voice, other, 0.3).subarray(0, 10001)],
  "the same on both sides": [voice, voice],
  "one side only": [voice, new Float32Array(voice.length)],
  "silence": [new Float32Array(SR)],
  "a level held": [new Float32Array(9000).fill(-0.37)],
  "noise at full scale": [noise(9000, 1, 6)],
  "noise at full scale, two sides": [noise(9000, 1, 7), noise(9000, 1, 8)],
  "a square wave at full scale": [square(9000, 441), square(9000, 3000)],
  "full scale turning every sample": [Float32Array.from({ length: 5000 }, (_, i) => i % 2 ? -1 : 1)],
  "beyond full scale": [Float32Array.from(tone(6000, 330, 1.4))],
};

{
  const wrong = { wav: [], wavByFlac: [], flacTest: [], flac: [], flacByFfmpeg: [], size: [] };
  let n = 0;
  for (const [name, chs] of Object.entries(SOUNDS)) {
    const c = chs.length, want = chs.map(whole), len = chs[0].length;
    const w = saved(`${n}.wav`, "wav", chs), f = saved(`${n}.flac`, "flac", chs);
    if (w.bytes.length !== 68 + 3 * c * len + (3 * c * len & 1)) wrong.size.push(name);
    if (!same(byFfmpeg(`${n}.wav`, c), want)) wrong.wav.push(name);
    // flac reads the WAV as a WAV, and its own decoder gives it back
    run("flac", ["-s", "-f", "-o", at(`${n}.ref.flac`), at(`${n}.wav`)]);
    if (!same(byFlac(`${n}.ref.flac`, c), want)) wrong.wavByFlac.push(name);
    if (threw(() => run("flac", ["-t", "-s", at(`${n}.flac`)])) !== null) wrong.flacTest.push(name);
    if (!same(byFlac(`${n}.flac`, c), want)) wrong.flac.push(name);
    if (!same(byFfmpeg(`${n}.flac`, c), want)) wrong.flacByFfmpeg.push(name);
    n++;
  }
  const said = (l) => l.length ? ` (not ${l.join("; ")})` : "";
  const count = Object.keys(SOUNDS).length;
  check(!wrong.size.length, `wav: ${count} sounds, each file its header and three bytes a sample, an odd one padded${said(wrong.size)}`);
  check(!wrong.wav.length, `wav: ffmpeg reads every sample back as it was rounded${said(wrong.wav)}`);
  check(!wrong.wavByFlac.length, `wav: flac reads the same from it${said(wrong.wavByFlac)}`);
  check(!wrong.flacTest.length, `flac: flac -t passes each file, its frames' sums and the samples' md5${said(wrong.flacTest)}`);
  check(!wrong.flac.length, `flac: flac decodes every sample back${said(wrong.flac)}`);
  check(!wrong.flacByFfmpeg.length, `flac: ffmpeg decodes every sample back${said(wrong.flacByFfmpeg)}`);
}

{
  const two = SOUNDS["two voices"], w = made("wav", two), f = made("flac", two);
  run("flac", ["-s", "-f", "-8", "-o", at("best.flac"), at("5.wav")]);
  const best = readFileSync(at("best.flac")).length;
  check(f.bytes.length < 0.75 * w.bytes.length && f.bytes.length < 1.1 * best,
    `flac: two voices take ${(100 * f.bytes.length / w.bytes.length).toFixed(0)}% of the WAV, ${(100 * f.bytes.length / best).toFixed(0)}% of flac -8's file`);
  const still = made("flac", SOUNDS.silence), same2 = made("flac", SOUNDS["the same on both sides"]), one = made("flac", SOUNDS["one voice"]);
  check(still.bytes.length < 200, `flac: a second of silence is ${still.bytes.length} bytes`);
  check(same2.bytes.length < 1.01 * one.bytes.length, `flac: a voice on both sides costs no more than the voice alone (${same2.bytes.length} bytes, ${one.bytes.length})`);
  const loud = made("flac", SOUNDS["noise at full scale"]);
  check(loud.bytes.length < 3 * 9000 + 200, `flac: noise at full scale costs no more than its samples as they are (${loud.bytes.length} bytes for ${3 * 9000})`);
  const info = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", at("5.flac")])).streams[0];
  check(info.sample_rate === "24000" && info.channels === 2 && info.bits_per_raw_sample === "24" && Math.abs(info.duration - 30000 / SR) < 1e-6,
    `flac: the stream says what it holds (${info.sample_rate} Hz, ${info.channels} channels, ${info.bits_per_raw_sample} bits, ${info.duration} s)`);
  const head = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", at("5.wav")])).streams[0];
  check(head.codec_name === "pcm_s24le" && head.sample_rate === "24000" && head.channels === 2 && Math.abs(head.duration - 30000 / SR) < 1e-6,
    `wav: the header says what it holds (${head.codec_name}, ${head.sample_rate} Hz, ${head.channels} channels, ${head.duration} s)`);
  const at48 = saved("48.flac", "flac", [voice], 48000);
  check(JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", at("48.flac")])).streams[0].sample_rate === "48000" && at48.over === 0, "flac: another rate is written as that rate");
}

// ------------------------------------------------------------------ MP3

{
  const frames = (n) => Math.ceil((n + MP3_DELAY) / 576);
  const sizes = [1, 575, 576, 577, 10000, 30000].filter((n) => {
    const m = made("mp3", [tone(n, 440, 0.3)]), s = made("mp3", [tone(n, 440, 0.3), tone(n, 550, 0.3)]);
    return m.bytes.length !== frames(n) * 3 * MP3_RATE[1] || s.bytes.length !== frames(n) * 3 * MP3_RATE[2];
  });
  check(sizes.length === 0, `mp3: frames enough to carry the sound out of a decoder, each ${3 * MP3_RATE[1]} bytes for one channel and ${3 * MP3_RATE[2]} for two${sizes.length ? ` (not at ${sizes.join(", ")} samples)` : ""}`);

  const n = 48000;
  for (const hz of [110, 1000, 3210, 9300]) {
    const x = tone(n, hz, 0.5);
    saved(`t${hz}.mp3`, "mp3", [x]);
    // away from its two ends, where a tone cut off is no tone
    const a = snr(x, mp3ByFfmpeg(`t${hz}.mp3`, 1)[0], MP3_DELAY, 4000, n - 4000), b = snr(x, mp3ByLame(`t${hz}.mp3`, 1)[0], LAME_DELAY, 4000, n - 4000);
    check(a > 70 && b > 70, `mp3: a held tone at ${hz} Hz comes back ${a.toFixed(1)} dB clean from ffmpeg, ${b.toFixed(1)} dB from lame`);
  }

  const one = sung(n, 196, 11), two = [mix(one, sung(n, 293.66, 12), 0.7), mix(one, sung(n, 293.66, 12), 0.3)];
  saved("one.mp3", "mp3", [one]);
  saved("two.mp3", "mp3", two);
  {
    const f = mp3ByFfmpeg("one.mp3", 1), l = mp3ByLame("one.mp3", 1);
    const a = snr(one, f[0], MP3_DELAY), b = snr(one, l[0], LAME_DELAY);
    check(f[0].length === 576 * frames(n) && a > 35 && b > 35, `mp3: one voice at ${MP3_RATE[1]} kbit/s comes back ${a.toFixed(1)} dB clean from ffmpeg, ${b.toFixed(1)} dB from lame`);
  }
  {
    const f = mp3ByFfmpeg("two.mp3", 2), l = mp3ByLame("two.mp3", 2);
    const a = [0, 1].map((k) => snr(two[k], f[k], MP3_DELAY)), b = [0, 1].map((k) => snr(two[k], l[k], LAME_DELAY));
    check(Math.min(...a, ...b) > 35, `mp3: two voices at ${MP3_RATE[2]} kbit/s come back ${a.map((v) => v.toFixed(1)).join(" and ")} dB clean from ffmpeg, ${b.map((v) => v.toFixed(1)).join(" and ")} dB from lame`);
    // each side is its own: the left has not leaked into the right
    const swapped = snr(two[0], f[1], MP3_DELAY);
    check(swapped < 15, `mp3: the sides are kept apart (the left against the decoded right, ${swapped.toFixed(1)} dB)`);
  }
  {
    saved("still.mp3", "mp3", [new Float32Array(n)]);
    const peak = mp3ByFfmpeg("still.mp3", 1)[0].reduce((a, v) => Math.max(a, Math.abs(v)), 0);
    check(peak === 0, `mp3: silence decodes to silence (peak ${peak})`);
  }
  // the loudest and busiest a take could be still fits its frames at both rates
  const hard = { "noise at full scale": (s) => noise(n, 1, s), "a square wave at full scale": (s) => square(n, 441 * s), "a click every frame": (s) => Float32Array.from({ length: n }, (_, i) => i % 576 === 7 * s ? 1 : 0) };
  for (const [name, f] of Object.entries(hard)) {
    const why = threw(() => { saved("h1.mp3", "mp3", [f(1)]); saved("h2.mp3", "mp3", [f(1), f(2)]); });
    const got = why === null ? [mp3ByFfmpeg("h1.mp3", 1), mp3ByFfmpeg("h2.mp3", 2)] : null;
    const a = got ? snr(f(1), got[0][0], MP3_DELAY) : NaN, b = got ? Math.min(snr(f(1), got[1][0], MP3_DELAY), snr(f(2), got[1][1], MP3_DELAY)) : NaN;
    check(why === null && a > 6 && b > 6, `mp3: ${name} fits its frames (${why ?? `${a.toFixed(1)} dB clean for one channel, ${b.toFixed(1)} dB for two`})`);
  }
}

// ------------------------------------------------------------------ what it tells its caller

{
  const x = Float32Array.from(tone(6000, 330, 1.4)), beyond = x.reduce((a, v) => a + (Math.abs(v) > 1), 0);
  const got = Object.keys(FORMATS).map((f) => made(f, [x]).over);
  check(beyond > 0 && got.every((o) => o === beyond), `over: the ${beyond} samples beyond full scale are counted in every format (${got.join(", ")})`);
  check(made("wav", [Float32Array.of(1, -1, 0.5)]).over === 0, "over: full scale itself is not beyond it");
  const rising = Object.keys(FORMATS).filter((f) => {
    const s = made(f, [voice, other]).shares;
    return !(s.length > 5 && s.every((v, i) => v > (i ? s[i - 1] : 0) && v <= 1) && s[s.length - 1] === 1);
  });
  check(rising.length === 0, `shares: each format's rise to 1 as it writes${rising.length ? ` (not ${rising.join(", ")})` : ""}`);
  const x1 = Float32Array.of(0.1, 0.2), x2 = Float32Array.of(0.1);
  const refused = [
    [() => made("ogg", [x1]), "no format ogg"],
    [() => made("wav", []), "0 channels: one or two"],
    [() => made("wav", [x1, x1, x1]), "3 channels: one or two"],
    [() => made("flac", [x1, x2]), "the channels differ in length"],
    [() => made("wav", [new Float32Array(0)]), "nothing to write"],
    [() => made("mp3", [Float32Array.of(0.1, NaN)]), "sample 1 is not a number"],
    [() => made("wav", [Float32Array.of(Infinity)]), "sample 0 is not a number"],
    [() => made("mp3", [x1], 44100), "mp3: 44100 Hz, not 24000"],
    [() => made("flac", [x1], 12345), "flac: no 12345 Hz"],
  ].filter(([f, why]) => threw(f) !== why).map(([f, why]) => `${why}: ${threw(f)}`);
  check(refused.length === 0, `refusals: a format it has not, no channel or three, differing lengths, nothing, a sample that is no number, a rate it cannot write${refused.length ? ` (${refused.join("; ")})` : ""}`);
}

rmSync(dir, { recursive: true });
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
