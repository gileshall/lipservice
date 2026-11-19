// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// The listener's notes: each pinned to a place in a take and kept, by the server the page comes
// from (serve.py, /notes), with how the take was made and a clip of its sound either side. A site
// says it keeps notes in models/site.json ({notes: true}). No DOM: the page and node both use it.

import { SR } from "./take.js";

export const BEFORE = 5; // s of sound before a note kept with it
export const AFTER = 2; // and after

// a short name for a long string (FNV-1a, 32 bits)
export function digest(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

// channels (Float32Arrays of one length) as a 16-bit wav, base64
export function wav(chs) {
  const n = chs[0].length, c = chs.length, b = new DataView(new ArrayBuffer(44 + 2 * n * c));
  const str = (at, s) => { for (let i = 0; i < s.length; i++) b.setUint8(at + i, s.charCodeAt(i)); };
  str(0, "RIFF"); b.setUint32(4, 36 + 2 * n * c, true); str(8, "WAVEfmt ");
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, c, true);
  b.setUint32(24, SR, true); b.setUint32(28, SR * 2 * c, true); b.setUint16(32, 2 * c, true); b.setUint16(34, 16, true);
  str(36, "data"); b.setUint32(40, 2 * n * c, true);
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) b.setInt16(44 + 2 * (i * c + k), Math.round(32767 * Math.max(-1, Math.min(1, chs[k][i]))), true);
  const u = new Uint8Array(b.buffer);
  let s = "";
  for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768));
  return btoa(s);
}

// the take's sound about sample s, as far either side as it is made: {from (s), wav}; null where
// s is not made
export function clip(take, s) {
  const span = take.spans.find(([a, b]) => s >= a && s < b);
  if (!span) return null;
  const a = Math.max(span[0], s - BEFORE * SR), b = Math.min(span[1], s + AFTER * SR);
  return { from: a / SR, wav: wav(take.cut(a, b).filter(Boolean)) };
}

export class Notes {
  // url: where the server keeps them; fetch: the browser's
  constructor({ url = "notes", fetch = (...a) => globalThis.fetch(...a) } = {}) {
    Object.assign(this, { url, fetch });
    this.all = [];
  }

  async ask(init) {
    const r = await this.fetch(this.url, init);
    if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${this.url}: ${r.status} ${(await r.text()).trim() || r.statusText}`);
    return r.json();
  }

  async load() {
    this.all = await this.ask();
  }

  // a piece's notes, in the order they come in it
  of(piece) {
    return this.all.filter((n) => n.piece === piece).sort((a, b) => a.at - b.at);
  }

  // A note at sample s of the take: {piece, kind, text, recipe} and the take's sound about it.
  async add({ piece, kind, text, recipe }, take, s) {
    const key = digest(JSON.stringify(recipe));
    const note = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), piece, kind, at: s / SR, text, key, recipe, created: new Date().toISOString() };
    const kept = await this.ask({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note, clip: clip(take, s) }) });
    this.all.push(kept);
    return kept;
  }

  async remove(id) {
    await this.ask({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gone: id }) });
    this.all = this.all.filter((n) => n.id !== id);
  }
}
