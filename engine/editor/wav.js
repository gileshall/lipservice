// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A sound file's bytes: a WAV of 16-bit samples, two ears, at the rate the sound was made at.
// Its title and the program that made it are in its LIST INFO, beat 0 is a cue point, and the
// score that made it may ride along in a chunk of its own ("lsco"), which players pass over.
// Nothing is trimmed from its start; its end is cut where its samples are all zero after it.
//
//   wav({channels: [left, right], rate, title, cue, score})
//     -> {bytes, frames, clipped, ringing}
//        frames: those kept; clipped: samples past full scale, held at it; ringing: the sound
//        had not died away by the last frame made
//   read(bytes)    {rate, bits, frames, channels: [Int16Array, Int16Array], title, software, cue,
//                  score, chunks: [id]}; throws on what it does not read
//   scoreOf(bytes) the score's text inside, or null

const SOFTWARE = "lipservice editor";
const FULL = 32767;

const utf8 = (s) => new TextEncoder().encode(s);
const even = (n) => n + (n & 1);

export function wav({ channels, rate, title = "", cue, score = null }) {
  if (channels.length !== 2 || channels[0].length !== channels[1].length) throw new Error("a sound file is two ears of the same length");
  if (!Number.isInteger(rate) || rate <= 0) throw new Error(`a sound file at ${rate} samples a second`);
  const [l, r] = channels, made = l.length;
  // each sample to 16 bits, no dither: silence stays exactly zero
  let clipped = 0, frames = 0;
  const q = new Int16Array(2 * made);
  for (let i = 0; i < made; i++) {
    for (let c = 0; c < 2; c++) {
      const x = channels[c][i];
      if (Number.isNaN(x)) throw new Error(`the sound at frame ${i} (${(i / rate).toFixed(3)} s) is not a number`);
      if (x > 1 || x < -1) clipped++;
      const v = Math.round(Math.max(-1, Math.min(1, x)) * FULL);
      q[2 * i + c] = v;
      if (v !== 0) frames = i + 1;
    }
  }
  if (!frames) throw new Error("the sound is silence: there is nothing to save");
  if (!Number.isInteger(cue) || cue < 0 || cue >= frames) throw new Error(`beat 0 at frame ${cue}, outside the sound's ${frames} frames`);
  const name = utf8(title), soft = utf8(SOFTWARE), text = score === null ? null : utf8(score);
  const info = (bytes) => 8 + even(bytes.length + 1);
  const listSize = 4 + (name.length ? info(name) : 0) + info(soft);
  const dataSize = 4 * frames;
  const size = 4 + (8 + 16) + (8 + 28) + (8 + listSize) + (text ? 8 + even(text.length) : 0) + (8 + dataSize);
  if (8 + size > 2 ** 32 - 1) throw new Error(`a WAV holds under 4 GB; this sound would be ${Math.ceil((8 + size) / 2 ** 30)} GB`);
  const bytes = new Uint8Array(8 + size), v = new DataView(bytes.buffer);
  let at = 0;
  const id = (s) => { for (let i = 0; i < 4; i++) bytes[at++] = s.charCodeAt(i); };
  const u32 = (n) => { v.setUint32(at, n, true); at += 4; };
  const u16 = (n) => { v.setUint16(at, n, true); at += 2; };
  const put = (b) => { bytes.set(b, at); at += b.length; };
  const zstr = (tag, b) => { id(tag); u32(b.length + 1); put(b); at += 1 + ((b.length + 1) & 1); };
  id("RIFF"); u32(size); id("WAVE");
  id("fmt "); u32(16); u16(1); u16(2); u32(rate); u32(rate * 4); u16(4); u16(16);
  id("cue "); u32(28); u32(1); u32(1); u32(cue); id("data"); u32(0); u32(0); u32(cue);
  id("LIST"); u32(listSize); id("INFO");
  if (name.length) zstr("INAM", name);
  zstr("ISFT", soft);
  if (text) { id("lsco"); u32(text.length); put(text); at += text.length & 1; }
  id("data"); u32(dataSize);
  for (let i = 0; i < 2 * frames; i++) { v.setInt16(at, q[i], true); at += 2; }
  if (at !== bytes.length) throw new Error(`wav.js wrote ${at} bytes of ${bytes.length}`);
  return { bytes, frames, clipped, ringing: frames === made };
}

// the file's chunks: [{id, at (of its body), size}]
function chunks(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file: it does not start RIFF ... WAVE");
  const end = 8 + v.getUint32(4, true);
  if (end > bytes.length) throw new Error(`the file says it is ${end} bytes and is ${bytes.length}`);
  const out = [];
  for (let at = 12; at < end;) {
    if (at + 8 > end) throw new Error(`a chunk's head cut short at byte ${at}`);
    const size = v.getUint32(at + 4, true);
    if (at + 8 + size > end) throw new Error(`the ${tag(at)} chunk runs past the file's end`);
    out.push({ id: tag(at), at: at + 8, size });
    at += 8 + even(size);
  }
  return out;
}

export function scoreOf(bytes) {
  const c = chunks(bytes).find((x) => x.id === "lsco");
  return c ? new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(c.at, c.at + c.size)) : null;
}

export function read(bytes) {
  const list = chunks(bytes), v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const one = (id) => {
    const found = list.filter((c) => c.id === id);
    if (found.length > 1) throw new Error(`two ${id.trim()} chunks`);
    return found[0] ?? null;
  };
  const fmt = one("fmt "), data = one("data");
  if (!fmt || !data) throw new Error(`a WAV with no ${fmt ? "data" : "fmt"} chunk`);
  if (fmt.size < 16) throw new Error(`a fmt chunk of ${fmt.size} bytes`);
  const [format, count, rate, perSec, align, bits] = [v.getUint16(fmt.at, true), v.getUint16(fmt.at + 2, true), v.getUint32(fmt.at + 4, true), v.getUint32(fmt.at + 8, true), v.getUint16(fmt.at + 12, true), v.getUint16(fmt.at + 14, true)];
  if (format !== 1 || bits !== 16) throw new Error(`samples of format ${format}, ${bits} bits: this reads 16-bit PCM`);
  if (count < 1 || align !== 2 * count || perSec !== rate * align) throw new Error(`a fmt chunk that does not add up: ${count} channels, ${align} bytes a frame, ${perSec} bytes a second at ${rate}`);
  if (data.size % align) throw new Error(`${data.size} bytes of samples, not whole frames of ${align}`);
  const frames = data.size / align, channels = Array.from({ length: count }, () => new Int16Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < count; c++) channels[c][i] = v.getInt16(data.at + i * align + 2 * c, true);
  const text = (c) => new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(c.at, c.at + c.size)).replace(/\0+$/, "");
  let title = null, software = null;
  const infoList = list.find((c) => c.id === "LIST" && String.fromCharCode(...bytes.subarray(c.at, c.at + 4)) === "INFO");
  if (infoList) {
    for (let at = infoList.at + 4; at < infoList.at + infoList.size;) {
      if (at + 8 > infoList.at + infoList.size) throw new Error("the INFO list cut short");
      const id = String.fromCharCode(...bytes.subarray(at, at + 4)), size = v.getUint32(at + 4, true);
      if (at + 8 + size > infoList.at + infoList.size) throw new Error(`INFO ${id} runs past its list`);
      if (id === "INAM") title = text({ at: at + 8, size });
      else if (id === "ISFT") software = text({ at: at + 8, size });
      at += 8 + even(size);
    }
  }
  let cue = null;
  const c = one("cue ");
  if (c) {
    if (c.size < 4 || c.size !== 4 + 24 * v.getUint32(c.at, true)) throw new Error(`a cue chunk of ${c.size} bytes`);
    if (v.getUint32(c.at, true) !== 1) throw new Error(`${v.getUint32(c.at, true)} cue points: this reads one`);
    cue = v.getUint32(c.at + 4 + 20, true);
  }
  return { rate, bits, frames, channels, title, software, cue, score: scoreOf(bytes), chunks: list.map((x) => x.id) };
}
