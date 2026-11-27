// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// A score in a link: its text (score.js write) packed into the part of a URL after `#`, which the
// browser never sends to a server. Packed is deflate-raw (CompressionStream), then base64url, after
// the packing's version: `#score=1.<base64url>`. node share_test.mjs
//
// How long a link may be. The browsers open far longer ones (Chrome up to 2 MB; Firefox and Safari
// past 64,000 characters), so the chat apps decide. Slack takes 40,000 characters a message,
// WhatsApp 65,536, Teams about 28,000 counted as HTML, where a link pasted is written twice (its
// address and its text): about 14,000 for a link. LIMIT is under all of them. Discord (2,000) and
// Telegram (4,096) are left out, as a score of a few singers is longer: CUT names them, and
// cut(n) the ones a link of n characters is too long for, so the page can say so.

import * as S from "./score.js";

export const VERSION = "1";
export const KEY = "#score=";
export const LIMIT = 12000; // characters in a whole link
export const MOST = 1 << 20; // bytes of a score's text a link holds: a small link that unpacks to more is refused
export const CUT = [
  { app: "Discord", most: 2000, does: "sends a longer message as a file" },
  { app: "Telegram", most: 4096, does: "splits a longer message" },
];

const LETTERS = /^[A-Za-z0-9_-]*$/;
const size = (n) => (n < 1 << 20 ? `${Math.ceil(n / 1024)} KB` : `${Math.round((n / (1 << 20)) * 10) / 10} MB`);

function encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(s) {
  if (!LETTERS.test(s)) {
    const at = [...s].findIndex((c) => !LETTERS.test(c));
    throw new Error(`the link's score is cut or changed: "${[...s][at]}" at its character ${at + 1} is not one a link's score is written in`);
  }
  if (s.length % 4 === 1) throw new Error(`the link's score is cut: ${s.length} characters is no whole number of bytes`);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (encode(bytes) !== s) throw new Error("the link's score is changed: its last character is not one this packing writes");
  return bytes;
}

// bytes through a compression stream, refused past `most` bytes out
async function through(stream, bytes, most) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > most) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// A score's text as the part of a link after `#score=`. Refuses text that is not a score.
export async function pack(text) {
  S.read(text);
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MOST) throw new Error(`the score is ${size(bytes.length)} of text: a link holds at most ${size(MOST)}`);
  return `${VERSION}.${encode(await through(new CompressionStream("deflate-raw"), bytes, Infinity))}`;
}

// The score's text back from what pack() made. Refuses what is not one, saying why.
export async function unpack(packed) {
  if (typeof packed !== "string") throw new Error("a link's score is text");
  const dot = packed.indexOf(".");
  if (dot < 0 || packed.slice(0, dot) !== VERSION) {
    const head = dot < 0 ? packed.slice(0, 12) : packed.slice(0, dot);
    throw new Error(`not a score link this editor reads: it starts "${head}", where one of this editor's starts "${VERSION}."`);
  }
  const body = packed.slice(dot + 1);
  if (!body) throw new Error("the link holds no score: nothing after its \"#score=1.\"");
  const bytes = decode(body);
  let out, text;
  try {
    out = await through(new DecompressionStream("deflate-raw"), bytes, MOST);
  } catch (e) {
    throw new Error(`the link's score is cut or changed: it does not unpack${e.message ? ` (${e.message})` : ""}`, { cause: e });
  }
  if (out === null) throw new Error(`the link's score unpacks to more than ${size(MOST)} of text, the most a link holds`);
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(out);
  } catch (e) {
    throw new Error("the link's score unpacks to bytes that are not text", { cause: e });
  }
  try {
    S.read(text);
  } catch (e) {
    throw new Error(`the link's score: ${e.message}`, { cause: e });
  }
  return text;
}

// A link to the page at `base` that opens the score `text`. Refused past LIMIT, saying both.
export async function link(base, text) {
  if (typeof base !== "string" || !base) throw new Error("a link needs the page's address");
  if (base.includes("#")) throw new Error(`the page's address ${base} has a "#" already`);
  try {
    new URL(base);
  } catch (e) {
    throw new Error(`the page's address ${base} is not a whole address: ${e.message}`, { cause: e });
  }
  const url = base + KEY + (await pack(text));
  if (url.length > LIMIT) throw new Error(`a link to this score is ${url.length.toLocaleString("en-US")} characters, and a link works up to ${LIMIT.toLocaleString("en-US")}: save the score as a file to send it`);
  return url;
}

// The score's text in a page's address (location, or anything with a `hash`), or null where its
// hash holds none.
export async function fromLocation(location) {
  const hash = location.hash;
  if (typeof hash !== "string") throw new Error("the page's address has no hash to read");
  if (!hash.startsWith(KEY)) return null;
  return unpack(hash.slice(KEY.length));
}

// The apps a link of n characters is too long to send whole in.
export const cut = (n) => CUT.filter((c) => n > c.most);
