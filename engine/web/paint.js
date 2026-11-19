// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

// What the page's drawings share: canvases sized to their box at the screen's density, the theme's
// colours (CSS custom properties, read again when the theme changes) and the singers' colours.

let theme = null;
const watch = matchMedia("(prefers-color-scheme: dark)");
watch.addEventListener("change", () => { theme = null; });

// the colours of the page's theme: fg, mute, faint, line, bg, panel, made, head, pitch, comma, bad, note
export function colours() {
  if (theme) return theme;
  const s = getComputedStyle(document.documentElement), v = (k) => s.getPropertyValue(`--${k}`).trim();
  theme = Object.fromEntries(["fg", "mute", "faint", "line", "bg", "panel", "made", "head", "pitch", "comma", "bad", "note"].map((k) => [k, v(k)]));
  return theme;
}

// the canvas's drawing context, sized to its box (height h, CSS px, if given) at the screen's
// density, in CSS px; w and h on it are its size
export function fit(cv, h = null) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (h !== null && cv.style.height !== `${h}px`) cv.style.height = `${h}px`;
  const w = cv.clientWidth, hh = h ?? cv.clientHeight;
  const W = Math.round(w * dpr), H = Math.round(hh * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.w = w;
  g.h = hh;
  return g;
}

export function rounded(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// a singer's hue: by the part's name where it says (soprano, alto, tenor, baritone, bass, lead,
// solo, a canon's entry), else by voice: women warm, men cool
const HUES = [["soprano", 350], ["alto", 32], ["tenor", 196], ["baritone", 230], ["bass", 262], ["lead", 165], ["solo", 165]];
export function hue(name, sex) {
  const n = name.toLowerCase();
  for (const [k, h] of HUES) if (n.includes(k)) return h;
  const e = n.match(/entry (\d)/);
  if (e) return [350, 32, 196, 262][(+e[1] - 1) % 4];
  return sex === "F" ? 350 : 205;
}
export const hsl = (h, a = 1, l = 64) => `hsla(${h} 78% ${l}% / ${a})`;

// a chord tone's hue: root, third, fifth
export const ROLE = [165, 38, 280];

export const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
// to the tenth of a second
export const stamp = (s) => `${clock(s)}.${Math.floor(s * 10) % 10}`;
