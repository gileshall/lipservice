# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

# The editor in headless Chromium and WebKit (Playwright): it opens, the menu bar and a note's
# menu fit the window, the panel's sections fold, Find a command, the clipboard, the tools, a
# harmony, a link, Sing, Save sound, and the phone's page. python3 browser_smoke.py OUT [chromium] [webkit], with the editor served at LS_EDITOR_URL
# (the test site's by default). Prints ok and FAIL lines; screenshots and the WAV go to OUT.
# LS_CHROMIUM and LS_WEBKIT name a browser of Playwright's where its own is not the one installed.
import json, os, sys, time, traceback
from playwright.sync_api import sync_playwright

URL = os.environ.get("LS_EDITOR_URL", "http://127.0.0.1:7793/editor/")
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
fails = 0


def check(ok, what, detail=""):
    global fails
    print(("ok   " if ok else "FAIL ") + what + (f"  [{detail}]" if detail and not ok else ""), flush=True)
    if not ok:
        fails += 1


def step(name, f):
    try:
        f()
    except Exception as e:
        check(False, f"{name}: raised", f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=3)}")


POS = """(i) => {
  const e = window.editor, n = e.ed.part.notes[i], v = e.view, b = document.getElementById('canvas').getBoundingClientRect();
  const m = /^([A-G])([#b]*)(-?\\d+)/.exec(n.pitch), base = {C:0,D:2,E:4,F:5,G:7,A:9,B:11}[m[1]];
  const k = base + [...m[2]].reduce((s, c) => s + (c === '#' ? 1 : -1), 0) + 12 * (Number(m[3]) + 1);
  return [b.left + 56 + v.x(n.at) + Math.min(4, n.ticks * v.wide / 3), b.top + 30 + v.y(k) + v.tall / 2];
}"""


def watch(page, errors):
    page.on("console", lambda m: m.type == "error" and errors.append("console: " + m.text))
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("requestfailed", lambda r: errors.append(f"requestfailed: {r.url} {r.failure}"))


def ready(page):
    page.goto(URL)
    page.wait_for_function("window.editor && window.editor.ed.part.notes.length > 0", timeout=30000)
    page.evaluate("window.editor.sounds")
    page.wait_for_timeout(500)


# the roll's height under the canvas's top: the canvas less the ruler and the rows under the roll
UNDER = "(() => { const L = window.editor.layout.lanes; return 30 + (L.words ? 30 : 16) + (L.velocity ? 64 : 16) + (L.vibrato ? 92 : 16); })()"


def bar(page, *labels):
    """A command from the menu bar: the menu's name pressed, then each row by its label."""
    page.locator("#menus .cmd-title", has_text=labels[0]).first.click()
    page.wait_for_selector("body > .cmd-menu")
    box = "body > .cmd-menu"
    for i, label in enumerate(labels[1:]):
        row = page.locator(f"{box} > [role^=menuitem]", has_text=label).first
        row.click()
        box = f"{box} > [role^=menuitem] > .cmd-menu"


def inside(page, sel):
    return page.evaluate("""(sel) => [...document.querySelectorAll(sel)].map((m) => {
      const r = m.getBoundingClientRect(); return {top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: innerWidth, h: innerHeight};
    })""", sel)


EXE = {"chromium": os.environ.get("LS_CHROMIUM"), "webkit": os.environ.get("LS_WEBKIT")}


def desktop(p, engine, name):
    browser = engine.launch(executable_path=EXE[name])
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
    if name == "chromium":
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=URL.split("/editor")[0])
    page = ctx.new_page()
    errors = []
    watch(page, errors)
    ready(page)
    page.screenshot(path=f"{OUT}/{name}-desk-open.png")
    check(not errors, f"{name}: opens with nothing said wrong", "; ".join(errors))
    beat = page.evaluate("window.editor.view.wide * window.editor.ed.part.grid")
    check(beat >= 52, f"{name}: the score opens to read, a beat {beat:.0f} px wide", str(beat))
    head = page.evaluate("document.querySelector('header').getBoundingClientRect().height")
    check(head < 40, f"{name}: the header is one row ({head:.0f} px)", str(head))
    # every control in the header inside the window, however narrow it is; one row from 1280
    for width in (1024, 1135, 1280):
        page.set_viewport_size({"width": width, "height": 800})
        page.wait_for_timeout(150)
        off = page.evaluate("[...document.querySelectorAll('header > *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > innerWidth + 0.5).map(e => e.id || e.className)")
        rows = page.evaluate("document.querySelector('header').getBoundingClientRect().height")
        check(not off and (width < 1280 or rows < 40), f"{name}: at {width} px every header control is in the window ({rows:.0f} px tall)", str(off))
    page.set_viewport_size({"width": 1280, "height": 800})
    page.wait_for_timeout(150)
    mod = "Meta"
    notes = lambda: page.evaluate("window.editor.ed.part.notes.length")
    chosen = lambda: page.evaluate("window.editor.ed.selected.size")
    rows = lambda: page.evaluate("window.editor.desk.value.rows.length")
    status = lambda: page.inner_text("#status")

    def menus():
        x, y = page.evaluate(POS, 3)
        page.mouse.click(x, y, button="right")
        page.wait_for_selector("[role=menu]")
        top = page.evaluate("[...document.querySelector('[role=menu]').children].filter(c => c.getAttribute('role') === 'menuitem').map(c => c.children[0].textContent)")
        r = inside(page, "[role=menu]")[0]
        check(r["top"] >= 0 and r["bottom"] <= r["h"] and r["right"] <= r["w"], f"{name}: a note's menu fits the window ({len(top)} rows, {round(r['bottom'])} of {r['h']} px)", json.dumps(r))
        page.screenshot(path=f"{OUT}/{name}-desk-menu.png")
        subs = page.evaluate("[...document.querySelector('[role=menu]').children].filter(c => c.getAttribute('aria-haspopup')).map(c => c.children[0].textContent)")
        for s in subs:
            page.locator("[role=menu] > [role=menuitem]", has_text=s).first.click()
            boxes = inside(page, "[role=menu] [role=menuitem] > .cmd-menu")
            check(boxes and all(b["top"] >= 0 and b["bottom"] <= b["h"] and b["right"] <= b["w"] and b["left"] >= 0 for b in boxes), f"{name}: the {s} menu opens inside the window", json.dumps(boxes))
        page.screenshot(path=f"{OUT}/{name}-desk-submenu.png")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        page.wait_for_timeout(100)
        check(page.locator("[role=menu]").count() == 0, f"{name}: Escape closes the menu")
        check(not errors, f"{name}: the menus said nothing wrong", "; ".join(errors))

    def menubar():
        names = page.evaluate("[...document.querySelectorAll('#menus .cmd-title')].map(t => t.textContent)")
        check(names == ["File", "Edit", "Notes", "Singers", "View", "Sing", "Help"], f"{name}: the menu bar", str(names))
        for m in names:
            page.locator("#menus .cmd-title", has_text=m).first.click()
            page.wait_for_selector("body > .cmd-menu")
            r = inside(page, "body > .cmd-menu")[0]
            check(r["top"] >= 0 and r["bottom"] <= r["h"] and r["right"] <= r["w"], f"{name}: the {m} menu fits the window ({round(r['bottom'])} of {r['h']} px)", json.dumps(r))
            # a smaller menu whose every row cannot run now is greyed, and does not open
            subs = page.evaluate("[...document.querySelector('body > .cmd-menu').children].filter(c => c.getAttribute('aria-haspopup') && c.getAttribute('aria-disabled') !== 'true').map(c => c.children[0].textContent)")
            for s in subs:
                page.locator("body > .cmd-menu > [role^=menuitem]", has_text=s).first.hover()
                page.wait_for_timeout(50)
                boxes = inside(page, "body > .cmd-menu > [role^=menuitem] > .cmd-menu")
                check(boxes and all(b["top"] >= 0 and b["bottom"] <= b["h"] and b["right"] <= b["w"] and b["left"] >= 0 for b in boxes), f"{name}: {m}, {s} opens inside the window", json.dumps(boxes))
            page.screenshot(path=f"{OUT}/{name}-bar-{m.lower()}.png")
            page.keyboard.press("Escape")
            page.keyboard.press("Escape")
            page.wait_for_timeout(50)
        check(page.locator(".cmd-menu").count() == 0, f"{name}: Escape closes the bar's menus")
        # a menu open, the pointer on the next name opens that one
        page.locator("#menus .cmd-title", has_text="Edit").first.click()
        page.locator("#menus .cmd-title", has_text="View").first.hover()
        page.wait_for_timeout(100)
        first = page.evaluate("document.querySelector('body > .cmd-menu [role^=menuitem] .cmd-label')?.textContent")
        check(page.locator("body > .cmd-menu").count() == 1 and first == "Zoom to read: a beat wide enough for its words", f"{name}: the pointer on the next name opens its menu", str(first))
        page.keyboard.press("Escape")
        # View: the rows under the notes unfolded and folded again
        lanes0 = page.evaluate("JSON.stringify(window.editor.layout.lanes)")
        bar(page, "View", "Rows under the notes", "Vibrato")
        page.wait_for_timeout(100)
        check(page.evaluate("window.editor.layout.lanes.vibrato"), f"{name}: View, the vibrato row unfolded")
        page.screenshot(path=f"{OUT}/{name}-desk-vibrato.png")
        bar(page, "View", "Rows under the notes", "Vibrato")
        check(page.evaluate("JSON.stringify(window.editor.layout.lanes)") == lanes0, f"{name}: and folded again")
        # a panel section unfolded at its heading, and folded again
        page.click("#fold-key-head")
        check(page.is_visible("#key-tonic"), f"{name}: the Key section unfolds at its heading")
        page.click("#fold-key-head")
        check(not page.is_visible("#key-tonic"), f"{name}: and folds again")
        check(not errors, f"{name}: the menu bar said nothing wrong", "; ".join(errors))

    def clipboard():
        n0 = notes()
        for i in range(4):
            x, y = page.evaluate(POS, i)
            if i:
                page.keyboard.down("Shift")
            page.mouse.click(x, y)
            if i:
                page.keyboard.up("Shift")
        check(chosen() == 4, f"{name}: four notes chosen by click and shift click", str(chosen()))
        page.keyboard.press(f"{mod}+c")
        page.wait_for_timeout(300)
        if name == "chromium":
            text = page.evaluate("navigator.clipboard.readText()")
            check(text.startswith("lipservice part 2") and text.count("\nnote ") == 4, f"{name}: Copy puts the four notes on the clipboard as a part", text[:120])
        page.keyboard.press(f"{mod}+d")
        page.wait_for_timeout(200)
        check(notes() == n0 + 4 and chosen() == 4, f"{name}: Duplicate adds the four after them, chosen", f"{notes()} {chosen()} {status()}")
        page.keyboard.press(f"{mod}+z")
        page.wait_for_timeout(200)
        check(notes() == n0, f"{name}: Undo takes the duplicate back", str(notes()))
        if name == "chromium":
            page.keyboard.press(f"{mod}+v")
            page.wait_for_timeout(600)
            check(notes() == n0 + 4, f"{name}: Paste lays the four in", f"{notes()} {status()}")
            page.keyboard.press(f"{mod}+z")
            page.wait_for_timeout(200)
            check(notes() == n0, f"{name}: and Undo takes them back", str(notes()))
        check(not errors, f"{name}: the clipboard said nothing wrong", "; ".join(errors))

    def palette():
        x, y = page.evaluate(POS, 2)
        page.mouse.click(x, y)
        page.keyboard.press(f"{mod}+k")
        page.wait_for_selector("dialog.cmd-palette[open]")
        page.keyboard.type("quantize")
        page.wait_for_timeout(100)
        first = page.evaluate("document.querySelector('dialog.cmd-palette [role=option] .cmd-label')?.textContent")
        check(first and "uantize" in first, f"{name}: Find a command finds quantize", str(first))
        page.screenshot(path=f"{OUT}/{name}-desk-palette.png")
        page.keyboard.press("Escape")
        page.wait_for_timeout(100)
        check(page.locator("dialog.cmd-palette[open]").count() == 0, f"{name}: Escape closes Find a command")

    def tools():
        x, y = page.evaluate(POS, 2)
        page.mouse.click(x, y)
        n0 = notes()
        x, y = page.evaluate(POS, 2)
        page.mouse.click(x, y, button="right")
        page.locator("[role=menu] > [role=menuitem]", has_text="Ornament").first.click()
        page.locator("[role=menu] .cmd-menu [role=menuitem]", has_text="Trill").first.click()
        page.wait_for_timeout(300)
        check(notes() > n0 and page.evaluate("!!window.editor.tool()"), f"{name}: Trill from the menu adds notes and opens its panel", f"{n0}->{notes()} {status()}")
        page.screenshot(path=f"{OUT}/{name}-desk-trill.png")
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        check(notes() == n0 and not page.evaluate("!!window.editor.tool()"), f"{name}: Escape puts the notes back", f"{notes()}")
        r0 = rows()
        page.mouse.click(x, y)
        page.keyboard.press("h")
        page.wait_for_timeout(400)
        check(rows() == r0 + 1, f"{name}: H adds a harmony singer", f"{r0}->{rows()} {status()}")
        page.screenshot(path=f"{OUT}/{name}-desk-harmony.png")
        page.keyboard.press("Enter")
        page.wait_for_timeout(200)
        page.mouse.click(5, 5)
        page.keyboard.press(f"{mod}+z")
        page.wait_for_timeout(200)
        check(rows() == r0, f"{name}: Undo takes the harmony away", f"{rows()} {status()}")
        check(not errors, f"{name}: the tools said nothing wrong", "; ".join(errors))

    def link():
        if name != "chromium":
            return
        bar(page, "File", "Copy a link to this score")
        page.wait_for_timeout(800)
        url = page.evaluate("navigator.clipboard.readText()")
        check(url.startswith(URL.split("#")[0]) and "#" in url, f"{name}: Copy link puts a link on the clipboard ({len(url)} characters)", url[:100] + " | " + status())
        if "#" not in url:
            return
        title = page.evaluate("window.editor.desk.value.title")
        other = ctx.new_page()
        errs2 = []
        watch(other, errs2)
        other.goto(url)
        other.wait_for_function("window.editor && window.editor.ed.part.notes.length > 0", timeout=30000)
        other.wait_for_timeout(500)
        check(other.evaluate("window.editor.desk.value.title") == title and "#" not in other.url, f"{name}: the link opens the score, and the address is cleared of it", other.url)
        check(not errs2, f"{name}: the link's page said nothing wrong", "; ".join(errs2))
        other.close()

    def sing():
        page.click("#sing")
        t0 = time.time()
        page.wait_for_function("window.editor.playing() && window.editor.playing().began", timeout=60000)
        began = time.time() - t0
        page.wait_for_timeout(3000)
        at = page.evaluate("window.editor.heardAt()")
        check(at is not None and at > 0, f"{name}: Sing sounds and the playhead moves ({began:.1f} s to begin, tick {at} after 3 s)", status())
        page.click("#stop")
        page.wait_for_timeout(300)
        check(not errors, f"{name}: Sing said nothing wrong", "; ".join(errors))

    def save_sound():
        bar(page, "File", "Save the score as it sounds, as a WAV file")
        t0 = time.time()
        page.wait_for_selector("#sound-ready:not([hidden])", timeout=240000)
        made = time.time() - t0
        with page.expect_download() as d:
            page.click("#sound-save")
        f = d.value
        dest = f"{OUT}/{name}-{f.suggested_filename}"
        f.save_as(dest)
        head = open(dest, "rb").read(12)
        check(head[:4] == b"RIFF" and head[8:12] == b"WAVE" and os.path.getsize(dest) > 100000, f"{name}: Save sound made a WAV in {made:.0f} s ({os.path.getsize(dest)} bytes)", status())
        check(not errors, f"{name}: Save sound said nothing wrong", "; ".join(errors))

    def short():
        try:
            shorter()
        finally:
            page.keyboard.press("Escape")
            page.keyboard.press("Escape")
            page.set_viewport_size({"width": 1280, "height": 800})
            page.wait_for_timeout(300)
            bar(page, "View", "Fit every note in view")
            page.wait_for_timeout(200)

    def shorter():
        page.set_viewport_size({"width": 1280, "height": 560})
        page.wait_for_timeout(300)
        bar(page, "View", "Fit every note in view")
        page.wait_for_timeout(200)
        out = page.evaluate("""(pos) => { const f = eval(pos), b = document.getElementById('canvas').getBoundingClientRect(), lo = b.top + 30, hi = b.top + b.height - """ + UNDER + """ + 30;
          return window.editor.desk.value.rows.flatMap((r, s) => r.ed.part.notes.map((n, i) => [s, i])).filter(([s, i]) => { window.editor.show(s); const y = f(i)[1]; return y < lo || y > hi; }).length }""", POS)
        page.evaluate("window.editor.show(0)")
        check(out == 0, f"{name}: in a window 560 px tall, Fit puts every singer's every note in the roll", f"{out} out")
        x, y = page.evaluate(POS, 3)
        page.mouse.click(x, y, button="right")
        page.wait_for_selector("[role=menu]")
        r = inside(page, "[role=menu]")[0]
        check(r["top"] >= 0 and r["bottom"] <= r["h"], f"{name}: in a window 560 px tall the note's menu stays inside it, scrolling", json.dumps(r))
        page.locator("[role=menu] > [role=menuitem]", has_text="Ornament").first.scroll_into_view_if_needed()
        page.locator("[role=menu] > [role=menuitem]", has_text="Ornament").first.click()
        boxes = inside(page, "[role=menu] [role=menuitem] > .cmd-menu")
        check(boxes and all(b["top"] >= 0 and b["bottom"] <= b["h"] and b["left"] >= 0 and b["right"] <= b["w"] for b in boxes), f"{name}: and its Ornament menu opens inside it", json.dumps(boxes))
        page.screenshot(path=f"{OUT}/{name}-desk-short-menu.png")

    for n, f in [("menu bar", menubar), ("menus", menus), ("short window", short), ("clipboard", clipboard), ("palette", palette), ("tools", tools), ("link", link), ("sing", sing), ("save sound", save_sound)]:
        step(f"{name} {n}", f)
    page.screenshot(path=f"{OUT}/{name}-desk-end.png")
    browser.close()


def phone(p, engine, name, device):
    browser = engine.launch(executable_path=EXE[name])
    ctx = browser.new_context(**p.devices[device])
    page = ctx.new_page()
    errors = []
    watch(page, errors)
    ready(page)
    page.screenshot(path=f"{OUT}/{name}-phone-open.png")
    check(not errors, f"{name} phone: opens with nothing said wrong", "; ".join(errors))
    w = page.evaluate("[document.documentElement.className, document.documentElement.scrollWidth, innerWidth]")
    check(w[0] == "phone" and w[1] <= w[2], f"{name} phone: dressed as a phone, nothing wider than the screen", str(w))
    hidden = page.evaluate("""[...document.querySelectorAll('header button, #side button')].filter(b => b.offsetParent).map(b => {
      const r = b.getBoundingClientRect(); return r.right > innerWidth + 1 ? b.id || b.textContent : null }).filter(Boolean)""")
    check(not hidden, f"{name} phone: no button runs off the screen", str(hidden))
    shown = page.evaluate("['make-harmony','make-round','copy-link','sound-make','s-way'].map(id => [id, !!document.getElementById(id).offsetParent])")
    check(all(s for _, s in shown), f"{name} phone: harmony, round, copy link, save sound and the ways are shown", str(shown))

    def tap():
        c0 = page.evaluate("window.editor.cursor()")
        x, y = page.evaluate(POS, 2)
        page.touchscreen.tap(x, y)
        page.wait_for_timeout(300)
        check(page.evaluate("window.editor.ed.selected.size") == 1 and page.evaluate("window.editor.cursor()") == c0, f"{name} phone: a tap on a note chooses it, the start stays", page.inner_text("#status"))
        r0 = page.evaluate("window.editor.desk.value.rows.length")
        page.locator("#make-harmony").scroll_into_view_if_needed()
        page.locator("#make-harmony").tap()
        page.wait_for_timeout(500)
        check(page.evaluate("window.editor.desk.value.rows.length") == r0 + 1, f"{name} phone: Add a harmony at a tap", page.inner_text("#status"))
        page.screenshot(path=f"{OUT}/{name}-phone-harmony.png", full_page=True)
        check(not errors, f"{name} phone: said nothing wrong", "; ".join(errors))

    step(f"{name} phone tap", tap)
    browser.close()


with sync_playwright() as p:
    which = sys.argv[2:] or ["chromium", "webkit"]
    for name in which:
        engine = getattr(p, name)
        step(f"{name} desk", lambda: desktop(p, engine, name))
        step(f"{name} phone", lambda: phone(p, engine, name, "iPhone 13"))
print("all ok" if not fails else f"{fails} FAIL")
sys.exit(1 if fails else 0)
