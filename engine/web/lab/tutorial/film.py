# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""A film of the bench in use: a browser driven by a script with a cursor drawn on the page, the
page's own singing taken from its sound calls, a spoken line under each move and a camera that
closes in on the area in hand. scenes.py says what happens; this records and cuts it.

The page is recorded small (960x540) at three device pixels a pixel, so a camera closed in to 1.5
still shows real pixels at 1920x1080.
"""
import asyncio, base64, hashlib, io, json, subprocess, time, wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.io import wavfile
from scipy.signal import resample_poly

VW, VH, DSF = 960, 540, 3
W, H, FPS, RATE = 1920, 1080, 30, 48000
TITLE = 1.8  # seconds of title card
EASE = 0.9  # seconds a camera move takes

PAGE_JS = r"""
(() => {
  const F = window.__film = { events: [], buffers: [], ids: new WeakMap() };
  const now = () => (performance.timeOrigin + performance.now()) / 1000;
  const S = AudioBufferSourceNode.prototype, start = S.start, stop = S.stop;
  S.start = function (when, offset = 0, duration) {
    const b = this.buffer;
    if (!F.ids.has(b)) { F.ids.set(b, F.buffers.length); F.buffers.push(b); }
    const ev = { t: now(), buf: F.ids.get(b), offset, duration: duration ?? (b.duration - offset), loop: this.loop, stopped: null };
    this.__ev = ev;
    F.events.push(ev);
    return start.apply(this, arguments);
  };
  S.stop = function () {
    if (this.__ev && this.__ev.stopped === null) this.__ev.stopped = now();
    return stop.apply(this, arguments);
  };
  F.pcm = (k) => {
    const d = new Uint8Array(F.buffers[k].getChannelData(0).buffer.slice(0));
    let s = "";
    for (let i = 0; i < d.length; i += 32768) s += String.fromCharCode(...d.subarray(i, i + 32768));
    return { rate: F.buffers[k].sampleRate, data: btoa(s) };
  };
  addEventListener("DOMContentLoaded", () => {
    const css = document.createElement("style");
    css.textContent = `
      #__cursor { position: fixed; left: -40px; top: -40px; width: 22px; height: 22px; z-index: 99999; pointer-events: none; }
      .__ring { position: fixed; z-index: 99998; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; border: 2px solid #c8102e; pointer-events: none; animation: __ring 0.45s ease-out forwards; }
      @keyframes __ring { to { transform: scale(4); opacity: 0; } }`;
    document.head.append(css);
    const c = document.createElement("div");
    c.id = "__cursor";
    c.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2 L3 17 L7 13.5 L10 20 L12.6 18.8 L9.7 12.4 L15 12 Z" fill="#111" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    document.body.append(c);
    F.ring = (x, y) => {
      const r = document.createElement("div");
      r.className = "__ring";
      r.style.left = x + "px";
      r.style.top = y + "px";
      document.body.append(r);
      setTimeout(() => r.remove(), 500);
    };
    addEventListener("mousemove", (e) => { c.style.left = e.clientX - 3 + "px"; c.style.top = e.clientY - 2 + "px"; }, true);
    addEventListener("mousedown", (e) => F.ring(e.clientX, e.clientY), true);
  });
})();
"""

ease = lambda u: 3 * u * u - 2 * u * u * u


def spoken(f):
    """A spoken line's rate and samples: the engine writes one channel of floats."""
    rate, x = wavfile.read(f)
    if x.dtype != np.float32 or x.ndim != 1:
        raise RuntimeError(f"{f}: {x.dtype}, {x.ndim} channels deep; one channel of float32 expected")
    return rate, x


class Film:
    def __init__(self, page, cdp, work, engine, models, narrator):
        self.page, self.cdp, self.work = page, cdp, Path(work)
        self.engine, self.models, self.narrator = engine, models, narrator
        self.frames, self.cams, self.lines = [], [], []
        self.t0 = None
        self.said_at = 0.0
        self.mouse = (VW / 2, VH / 2)
        self.heard = 0
        (self.work / "frames").mkdir(parents=True, exist_ok=True)
        (self.work / "say").mkdir(exist_ok=True)

    # ---------------------------------------------------------------- recording
    async def roll(self):
        # a still at a time, about twenty a second: the browser's own screencast is not at the device's pixels
        last = None
        while self.rolling:
            t = time.time()
            data = await self.page.screenshot(type="jpeg", quality=92, caret="initial")
            if data != last:
                f = self.work / "frames" / f"{len(self.frames):06d}.jpg"
                f.write_bytes(data)
                self.frames.append((t, f))
                last = data
            await asyncio.sleep(max(0, 1 / 30 - (time.time() - t)))

    async def start(self):
        self.rolling = True
        self.reel = asyncio.ensure_future(self.roll())
        await self.page.mouse.move(*self.mouse)
        await asyncio.sleep(0.4)
        self.t0 = time.time()
        self.heard = await self.page.evaluate("__film.events.length")
        self.first = self.heard
        self.cams.append((self.t0 - EASE, (0, 0, VW, VH)))

    async def stop(self):
        await self.said()
        await asyncio.sleep(0.9)
        self.t1 = time.time()
        self.rolling = False
        await self.reel

    # ---------------------------------------------------------------- the spoken line
    def voice(self, text):
        f = self.work / "say" / f"{hashlib.sha1((self.narrator + text).encode()).hexdigest()[:16]}.wav"
        if not f.exists():
            subprocess.run([self.engine, "say", text, "-o", str(f), "--voice", self.narrator], check=True,
                           env={"LIPSERVICE_MODELS": self.models, "PATH": "/usr/bin:/bin"})
        rate, x = spoken(f)
        return f, len(x) / rate

    async def say(self, text):
        """The line starts now, after the one before it; moves made next run under it."""
        await self.said()
        await self.quiet()
        f, dur = self.voice(text)
        now = time.time()
        self.lines.append((now, f))
        self.said_at = now + dur + 0.3

    async def said(self):
        await asyncio.sleep(max(0, self.said_at - time.time()))

    # ---------------------------------------------------------------- the page's own sound
    async def quiet(self):
        """Wait out whatever the page is playing."""
        until = await self.page.evaluate("Math.max(0, ...__film.events.map((e) => e.stopped ?? (e.loop ? Infinity : e.t + e.duration)))")
        await asyncio.sleep(max(0, until - time.time()) + 0.25 if until else 0)

    async def listen(self, timeout=40):
        """The page starts to play something new, and it is heard to its end."""
        t = time.time()
        while await self.page.evaluate("__film.events.length") <= self.heard:
            if time.time() - t > timeout:
                raise RuntimeError("the page played nothing")
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.15)
        self.heard = await self.page.evaluate("__film.events.length")
        await self.quiet()

    async def seen(self):
        """Plays so far count as heard: the next listen waits for a new one."""
        self.heard = await self.page.evaluate("__film.events.length")

    # ---------------------------------------------------------------- the camera
    async def box(self, sel):
        b = await self.page.locator(sel).first.bounding_box()
        if b is None:
            raise RuntimeError(f"{sel}: not on the page")
        return b

    async def look(self, *sels, pad=14, most=2.0, left=None):
        """The camera closes on these areas (on the whole page with none), as tight as `most`; with
        `left`, that tight on their left end."""
        if not sels:
            self.cams.append((time.time(), (0, 0, VW, VH)))
            return
        bs = [await self.box(s) for s in sels]
        x0 = min(b["x"] for b in bs) - pad
        y0 = min(b["y"] for b in bs) - pad
        x1 = max(b["x"] + b["width"] for b in bs) + pad
        y1 = max(b["y"] + b["height"] for b in bs) + pad
        w = max(x1 - x0, (y1 - y0) * VW / VH, VW / most)
        w = min(w, VW) if left is None else VW / left
        h = w * VH / VW
        cx, cy = ((x0 + x1) / 2 if left is None else x0 + w / 2), (y0 + y1) / 2
        x = min(max(cx - w / 2, 0), VW - w)
        y = min(max(cy - h / 2, 0), VH - h)
        self.cams.append((time.time(), (x, y, w, h)))

    async def scroll(self, sel, top=70):
        """The page scrolls to put the area `top` pixels down the window."""
        await self.page.evaluate("""([sel, top]) => {
            const r = document.querySelector(sel).getBoundingClientRect();
            scrollTo({ top: Math.max(0, scrollY + r.top - top), behavior: "smooth" });
        }""", [sel, top])
        await asyncio.sleep(0.8)

    # ---------------------------------------------------------------- the hand
    async def move(self, x, y, dur=0.7):
        x0, y0 = self.mouse
        n = max(2, int(dur * 60))
        for i in range(1, n + 1):
            u = ease(i / n)
            await self.page.mouse.move(x0 + (x - x0) * u, y0 + (y - y0) * u)
            await asyncio.sleep(dur / n)
        self.mouse = (x, y)

    async def over(self, sel, dur=0.7, at=(0.5, 0.5)):
        b = await self.box(sel)
        await self.move(b["x"] + b["width"] * at[0], b["y"] + b["height"] * at[1], dur)

    async def click(self, sel, at=(0.5, 0.5)):
        """The cursor goes to it under the line, and presses when the line is said."""
        await self.over(sel, at=at)
        await self.said()
        await self.seen()
        await self.page.mouse.down()
        await asyncio.sleep(0.07)
        await self.page.mouse.up()
        await asyncio.sleep(0.25)

    async def drag(self, sel, dx, at=(0.5, 0.5), dur=1.1):
        """Pressed on it and pulled `dx` pixels sideways."""
        await self.over(sel, at=at)
        await self.said()
        await self.seen()
        x, y = self.mouse
        await self.page.mouse.down()
        await asyncio.sleep(0.15)
        await self.move(x + dx, y, dur)
        await asyncio.sleep(0.35)
        await self.page.mouse.up()
        await asyncio.sleep(0.25)

    async def type(self, sel, text, each=0.06):
        """Typed into it so the last key lands as the line ends. No key waits long enough for the
        page to take the text as finished."""
        await self.over(sel, at=(0.3, 0.5))
        await self.page.mouse.down()
        await self.page.mouse.up()
        left = self.said_at - time.time()
        each = min(0.3, max(each, left / len(text)))
        await asyncio.sleep(max(0, left - each * len(text)))
        await self.seen()
        for ch in text:
            await self.page.keyboard.type(ch)
            await asyncio.sleep(each)

    async def key(self, k):
        await self.said()
        await self.seen()
        await self.page.keyboard.press(k)

    async def rest(self, s):
        await asyncio.sleep(s)

    # ---------------------------------------------------------------- the cut
    def sound(self, events, buffers):
        n = int((self.t1 - self.t0 + TITLE) * RATE) + RATE
        out = np.zeros(n, np.float32)
        def put(x, rate, at):
            if rate != RATE:
                x = resample_poly(x, RATE, rate).astype(np.float32)
            i = int((at - self.t0 + TITLE) * RATE)
            if i < 0:
                raise RuntimeError("a sound from before the film began")
            x = x[: max(0, n - i)]
            out[i : i + len(x)] += x
        for at, f in self.lines:
            rate, x = spoken(f)
            put(x, rate, at)
        for e in events:
            if e["loop"]:
                raise RuntimeError("a looped play is not cut")
            rate, pcm = buffers[e["buf"]]
            a = int(e["offset"] * rate)
            dur = e["duration"] if e["stopped"] is None else min(e["duration"], e["stopped"] - e["t"])
            x = pcm[a : a + int(dur * rate)].copy()
            fade = min(len(x), int(0.012 * rate))
            if e["stopped"] is not None and fade:
                x[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
            put(x, rate, e["t"])
        return out

    def camera(self, t):
        k = max(i for i, c in enumerate(self.cams) if c[0] <= t)
        at, to = self.cams[k]
        if k == 0:
            return to
        # from where the camera was when this move began
        was = self.camera(at - 1e-6)
        u = ease(min(1, (t - at) / EASE))
        return tuple(a + (b - a) * u for a, b in zip(was, to))

    async def cut(self, out, title, sub):
        events = (await self.page.evaluate("__film.events"))[self.first:]
        buffers = {}
        for k in {e["buf"] for e in events}:
            p = await self.page.evaluate(f"__film.pcm({k})")
            buffers[k] = (int(p["rate"]), np.frombuffer(base64.b64decode(p["data"]), np.float32))
        wav = self.work / "sound.wav"
        with wave.open(str(wav), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes((np.clip(self.sound(events, buffers), -1, 1) * 32767).astype(np.int16).tobytes())
        ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                               "-i", str(wav), "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
                               "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", str(out)], stdin=subprocess.PIPE)
        card = Image.new("RGB", (W, H), "#faf9f6")
        d = ImageDraw.Draw(card)
        big = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 92, index=1)
        small = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 44)
        d.text((W / 2, H / 2 - 40), title, font=big, fill="#1c1c1c", anchor="mm")
        d.text((W / 2, H / 2 + 70), sub, font=small, fill="#6b6b6b", anchor="mm")
        for _ in range(int(TITLE * FPS)):
            ff.stdin.write(card.tobytes())
        frames = [f for f in self.frames]
        j, shown, img = 0, None, None
        for i in range(int((self.t1 - self.t0) * FPS)):
            t = self.t0 + i / FPS
            while j + 1 < len(frames) and frames[j + 1][0] <= t:
                j += 1
            if shown != j:
                img = Image.open(frames[j][1]).convert("RGB")
                if img.size != (VW * DSF, VH * DSF):
                    raise RuntimeError(f"a frame of {img.size}, not {VW * DSF}x{VH * DSF}")
                shown = j
            x, y, w, h = self.camera(t)
            ff.stdin.write(img.resize((W, H), Image.LANCZOS, box=(x * DSF, y * DSF, (x + w) * DSF, (y + h) * DSF)).tobytes())
        ff.stdin.close()
        if ff.wait():
            raise RuntimeError("ffmpeg failed")
