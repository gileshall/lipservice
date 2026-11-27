# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""The bench's tutorial films, each a few moves on the served lab with a line spoken under each.
    python3 scenes.py LAB-URL OUT-DIR ENGINE MODELS [NAME ...]
LAB-URL: the served lab (http://127.0.0.1:7794/lab/). ENGINE: the lipservice command, which speaks
the lines. MODELS: its models (LIPSERVICE_MODELS). Writes OUT-DIR/NAME.mp4 for each part, the parts end
to end as OUT-DIR/diction-bench.mp4, and OUT-DIR/index.html.
FILM_CHROMIUM names a headless Chromium to use in place of Playwright's own.
"""
import asyncio, html, os, shutil, subprocess, sys, tempfile
from pathlib import Path

from playwright.async_api import async_playwright

from film import DSF, PAGE_JS, VH, VW, Film

NARRATOR = "ben"
WHOLE = "diction-bench.mp4"
SHORT = "%bpm 84\nsilent F4:1.5+G4:0.5 F4:1\nnight D4:3\n"
LONG = SHORT + "holy F4:1.5+G4:0.5 F4:1\nnight D4:3\n"
NIGHT = '[data-sound="1.1"]'  # the vowel of the first "night"


async def given(page, song):
    """Before the film: the song is on the bench and sung."""
    await page.fill("#song", song)
    await page.locator("#song").blur()
    await page.wait_for_selector("#strip .inner")
    await page.wait_for_function("document.getElementById('status').textContent === ''")
    # a long song is drawn narrower, to fit the window without scrolling
    if song == LONG:
        b = await page.locator(":nth-match(#controls .pull, 2)").bounding_box()
        x, y = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x - 18, y, steps=4)
        await page.mouse.up()


async def start_here(f):
    p = f.page
    await f.say("This is the diction bench. One singer, one song, and everything about how it is sung.")
    await f.over("#song", at=(0.2, 0.3))
    await f.look("#song-card", left=1.5)
    await f.say("Start in the song box. The first line is the tempo. Then one word a line. After each word, a note for every syllable: the note's name, a colon, and how many beats it lasts.")
    await f.type("#song", SHORT)
    await p.wait_for_selector("#strip .inner")
    await f.scroll("#performance", top=20)
    await f.look()
    await f.listen()
    await f.look("#strip .inner")
    await f.say("When you stop typing, the engine sings it and draws it. Words along the top. Under each word, its sounds, each as wide as it is long. Blue is a vowel. Grey is a consonant.")
    await f.over('[data-word="0"]')
    await f.over('[data-sound="0.1"]', dur=1.2)
    await f.over('[data-sound="0.2"]', dur=1.2)
    await f.say("Below that, the blue line is the pitch she sang. The pale bars are the notes you wrote. The grey hill is how loud she is.")
    await f.over("#curves", at=(0.2, 0.45), dur=1.0)
    await f.over("#curves", at=(0.7, 0.75), dur=2.0)
    await f.say("Click a word to hear only that word.")
    await f.click('[data-word="1"]')
    await f.listen()
    await f.say("Or drag across the picture to mark any stretch. It plays what you marked.")
    await f.drag("#curves", 150, at=(0.08, 0.5))
    await f.listen()
    await f.look("#performance")
    await f.say("Play the whole song clears the mark. Then press Play, or the space bar.")
    await f.click("#all")
    await f.click("#play")
    await f.listen()
    await f.scroll("#song-card", top=60)
    await f.look("#song-card")
    await f.say("A number in a box is dragged. Press on the tempo and pull left to slow it down.")
    await f.drag("#song-card .pull", -72)
    await f.listen()
    await f.look()
    await f.say("Every change is sung and played at once. Next, the sounds inside a word.")


async def change_a_word(f):
    await f.scroll("#performance", top=20)
    await f.look("#performance")
    await f.say("The song has a second line now, so there are two nights in it.")
    await f.over('[data-word="3"]', dur=1.2)
    await f.say("To change how a word is sung, click one of its sounds. Here, the vowel in the first night.")
    await f.click(NIGHT)
    await f.listen()
    await f.scroll("#word", top=10)
    await f.look()
    await f.say("The chosen sound opens below the picture. This list is every sound the engine has, each with a word you hear it in.")
    await f.over('#sound [data-pick="AE"]', dur=1.0)
    await f.over('#sound [data-pick="NG"]', dur=1.8)
    await f.look('#sound [data-mode="replace"]', '#sound [data-pick="OW"]', most=1.5)
    await f.say("Replace it is lit, so the sound you click takes this one's place. Click ah, as in father.")
    await f.over('#sound [data-mode="replace"]')
    await f.click('#sound [data-pick="AA"]')
    await f.listen()
    await f.say("Now give the vowel an ending. Press End this vowel on another, then click the ending. Here, eye, as in night.")
    await f.click('#sound [data-mode="end"]')
    await f.click('#sound [data-pick="AY"]')
    await f.listen()
    await f.scroll("#performance", top=20)
    await f.look("#strip .inner")
    await f.say("In the picture, the ending is the yellow piece after the vowel. It is the chosen sound now.")
    await f.over('[data-sound="1.2"]', dur=1.0)
    await f.scroll("#word", top=10)
    await f.look("#sound h3", "#sound .pull", most=1.6)
    await f.say("An ending has a length. Drag it longer, and the vowel turns sooner.")
    await f.drag("#sound .pull", 60)
    await f.listen()
    await f.look('#sound [data-mode="replace"]', "#remove", most=1.5)
    await f.say("The other buttons put a new sound before this one, or after it. Take it away removes it.")
    await f.over('#sound [data-mode="after"]', dur=1.0)
    await f.over("#remove", dur=1.4)
    await f.look("#word .row")
    await f.say("All of that changed one word. To sing every night in the song the same way, press this button.")
    await f.click("#everywhere")
    await f.listen()
    await f.scroll("#performance", top=20)
    await f.look("#performance")
    await f.say("Play the whole song, and both nights have it.")
    await f.click("#all")
    await f.click("#play")
    await f.listen()
    await f.say("Undo steps back through every change you made. Next, rules for the whole song.")
    await f.over("#undo", dur=1.0)


async def whole_song(f):
    await f.scroll("#options", top=10)
    await f.look("#options", left=1.3)
    await f.say("How it is sung holds every setting the engine takes for singing. Each one has a line beside it saying what it does.")
    await f.over('[data-option="shift"] .help', dur=1.0)
    await f.over('[data-option="breathiness"] .help', dur=2.5)
    await f.look('[data-option="vibrato"] .name', '[data-sweep="option.vibrato"]', most=1.6)
    await f.say("Drag a number to change it. Here, more vibrato.")
    await f.drag('[data-option="vibrato"] .pull', 54)
    await f.listen()
    await f.look('[data-option="diction"] .name', '[data-sweep="option.diction"]', most=1.6)
    await f.say("Sung diction is a switch. Turned on, it uses the rules for held vowels, in the next card.")
    await f.click("#opt-diction")
    await f.listen()
    await f.scroll("#rules", top=10)
    await f.look("#rules h2", '[data-rule="AY1"]', left=1.3)
    await f.say("A rule is for every word in the song, not just one. On a long note, a vowel with a rule is held on one sound, then ends on another in the note's last moments.")
    await f.over('[data-rule="AY1"] b', dur=1.0)
    await f.look("#AY1-hold", most=1.5)
    await f.say("This rule is for the vowel in night. The lists pick the sound it is held on, and the sound it ends on.")
    await f.over("#AY1-hold", dur=1.0)
    await f.rest(1.6)
    await f.look("#AY1-close", most=1.5)
    await f.over("#AY1-close", dur=1.6)
    await f.look('[data-rule="AY1"] .pull', most=1.6)
    await f.say("Drag the length of the ending.")
    await f.drag('[data-rule="AY1"] .pull', 60)
    await f.listen()
    await f.scroll("#inside", top=300)
    await f.look("#inside", most=1.4)
    await f.say("Under the vowels: how long a note must be before a rule applies, and the dip in pitch through b, d and g. They are dragged the same way.")
    await f.over("#inside", dur=1.5)
    await f.say("The small sweep buttons come next.")


async def a_sweep(f):
    p = f.page
    await f.scroll("#options", top=10)
    await f.look('[data-option="vibrato"] .name', '[data-sweep="option.vibrato"]', most=1.6)
    await f.say("To find a value by ear, sweep it. Press the small sweep button beside a setting. Here, vibrato.")
    await f.click('[data-sweep="option.vibrato"]')
    await f.scroll("#sweep", top=30)
    await f.look("#sweep-target", "#sweep-run", most=1.0)
    await f.say("The sweep card is now set to vibrato. Drag where it starts, where it ends, and how many steps to take. Here, from none, to one semitone, in five steps.")
    await f.over("#sweep-target", dur=0.8)
    await f.look(":nth-match(#sweep .pull, 1)", "#sweep-run", most=1.6)
    await f.over(":nth-match(#sweep .pull, 1)", dur=1.0)
    await f.drag(":nth-match(#sweep .pull, 2)", -240, dur=2.0)
    await f.over(":nth-match(#sweep .pull, 3)", dur=1.0)
    await f.say("Then sing them.")
    await f.click("#sweep-run")
    await p.wait_for_function("document.querySelectorAll('[data-run]:not([disabled])').length === 5")
    await f.look('[data-run="0"]', "#run-load", most=1.6)
    await f.say("Each value is a button. Click one to hear the song sung that way.")
    await f.click('[data-run="0"]')
    await f.listen()
    await f.click('[data-run="2"]')
    await f.listen()
    await f.click('[data-run="4"]')
    await f.listen()
    await f.say("When one is right, put it on the bench. The song takes that value, and you go on from there.")
    await f.click('[data-run="2"]')
    await f.listen()
    await f.click("#run-load")
    await f.rest(1.5)
    await f.quiet()
    await f.look("#sweep-target", most=1.5)
    await f.say("A sound can be swept too. Choose it in the picture first, and it joins the list of things to sweep.")
    await f.over("#sweep-target", dur=1.2)


async def takes(f):
    p = f.page
    await f.scroll("#takes", top=40)
    await f.look("#takes", left=1.4)
    await f.say("A take keeps the song and every setting, as they are now, under a name. Type a name, and keep it.")
    await f.type("#take-name", "plain", each=0.12)
    await f.click("#keep")
    await f.scroll("#options", top=10)
    await f.look('[data-option="diction"] .name', '[data-sweep="option.diction"]', most=1.6)
    await f.say("Now change something. Here, sung diction is turned on.")
    await f.click("#opt-diction")
    await f.listen()
    await f.scroll("#takes", top=40)
    await f.look("#takes", left=1.4)
    await f.say("Keep that as a second take.")
    await f.type("#take-name", "diction", each=0.12)
    await f.click("#keep")
    await f.say("Hear plays a take.")
    await f.click(":nth-match([data-hear], 1)")
    await f.listen()
    await f.click(":nth-match([data-hear], 2)")
    await f.listen()
    await f.say("Flip, or the F key, jumps between the last two you heard, at the same spot in the song. So you compare the same moment, sung two ways.")
    await f.click(":nth-match([data-hear], 1)")
    await f.rest(1.4)
    await f.click("#flip2")
    await f.rest(1.4)
    await f.click("#flip2")
    await f.rest(0.5)
    await f.quiet()
    await f.say("Beside each take is how it differs from the bench. Put it on the bench brings a take back to work on.")
    await f.over(":nth-match([data-take] .help, 1)", dur=1.0)
    await f.over(":nth-match([data-load], 1)", dur=1.5)
    await f.click(":nth-match([data-hear], 2)")
    await f.listen()
    await f.scroll("#out", top=20)
    await f.look("#out", left=1.4)
    await f.say("At the bottom is whatever is playing, written out: the song with its rules in it, and the command line that sings it anywhere.")
    await f.over("#out-song", dur=1.0)
    await f.over("#out-command", dur=2.0)
    await f.say("Copy either one. Or save the bench and all its takes as a file.")
    await f.over("#copy-song", dur=0.8)
    await f.over("#save-session", dur=1.5)
    await f.look()
    await f.say("That is the whole bench.")


FILMS = [
    ("1-start-here", "1. Start here", "Write a song, hear it, read the picture", None, start_here),
    ("2-change-a-word", "2. Change a word", "Replace a sound, end a vowel, set its length", LONG, change_a_word),
    ("3-the-whole-song", "3. The whole song", "Settings and rules for every word", SHORT, whole_song),
    ("4-a-sweep", "4. A sweep", "Find a value by ear", SHORT, a_sweep),
    ("5-takes", "5. Takes", "Keep, compare, and get it out as text", SHORT, takes),
]


async def main(url, out, engine, models, names):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=os.environ.get("FILM_CHROMIUM"), args=["--autoplay-policy=no-user-gesture-required"])
        for name, title, sub, song, scene in FILMS:
            if names and name not in names:
                continue
            work = Path(tempfile.mkdtemp(prefix=f"film-{name}-", dir=out))
            ctx = await browser.new_context(viewport={"width": VW, "height": VH}, device_scale_factor=DSF)
            await ctx.add_init_script(PAGE_JS)
            page = await ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            await page.goto(url)
            await page.wait_for_selector("#tour-open")
            if song:
                await given(page, song)
            f = Film(page, await ctx.new_cdp_session(page), work, engine, models, NARRATOR)
            await f.start()
            await scene(f)
            await f.stop()
            if errors:
                raise RuntimeError(f"the page threw: {errors}")
            await f.cut(out / f"{name}.mp4", title, sub)
            await ctx.close()
            shutil.rmtree(work)
            print(f"{out / name}.mp4", flush=True)
        await browser.close()
    done = [(n, t, s) for n, t, s, _, _ in FILMS if (out / f"{n}.mp4").exists()]
    if len(done) != len(FILMS):
        raise RuntimeError(f"{len(done)} of {len(FILMS)} parts are made; the whole film needs them all")
    # the parts end to end, each under its own card
    parts = out / "parts.txt"
    parts.write_text("".join(f"file '{n}.mp4'\n" for n, _, _ in done))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(parts), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart", str(out / WHOLE)], check=True)
    parts.unlink()
    (out / "index.html").write_text(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Diction bench: films</title>'
        "<style>body{margin:0 auto;max-width:1000px;padding:16px 20px 60px;font:15px/1.4 system-ui,sans-serif;color:#1c1c1c;background:#faf9f6}"
        "video{width:100%;border:1px solid #d9d6cf;border-radius:10px;background:#000}h2{font-size:17px;margin:26px 0 2px}p{margin:0 0 8px;color:#6b6b6b}</style>"
        '<h1>Diction bench: how to use it</h1><p><a href="../lab/">Back to the bench</a></p>'
        f'<video controls preload="metadata" src="{WHOLE}"></video><h2>The same, part by part</h2>'
        + "".join(f'<h2>{html.escape(t)}</h2><p>{html.escape(s)}</p><video controls preload="metadata" src="{n}.mp4"></video>' for n, t, s in done))


if __name__ == "__main__":
    if len(sys.argv) < 5:
        sys.exit(__doc__)
    asyncio.run(main(*sys.argv[1:5], sys.argv[5:]))
