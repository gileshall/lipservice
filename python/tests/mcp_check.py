# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""Checks an installed lipservice's MCP server, as a client would meet it.

    python python/tests/mcp_check.py --bundle BUNDLE [--device ID]

Run it with the Python the wheel is installed in, from anywhere but python/. `lipservice mcp` is
started as a client starts it and spoken to over its stdin and stdout: the handshake, the tools,
speech and song written where each call says (the same bytes the package makes), every refusal,
and the protocol's own errors. Nothing is played. Linux's device listing is read from a sample of
what `aplay -L` prints; aplay itself is not run.

With --device, the id of one of `lipservice devices`, playing is checked too, through that device
and without a sound: a server in this process whose say makes silence plays it for its length,
plays two calls one after the other, stops a call the client cancels and does not answer it, and
stops when the client hangs up.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

SONG = "%bpm 100\ntwinkle C4:1 C4:1\ntwinkle G4:1 G4:1\nlittle A4:1 A4:1\nstar G4:2\n"
PIECE = {
    "room": "card",
    "style": {"glide": 9, "dynamics": 1.0, "breathiness": 0.6, "breath": 0.8},
    "parts": [
        {"name": "High", "voice": "cora", "song": "%bpm 90\nsing C5:1\nwith B4:1\nme C5:2\n%rest 1\n"},
        {"name": "Low", "voice": "ben", "song": "%bpm 90\nsing E4:1\nwith G4:1\nme E4:2\n%rest 1\n"},
    ],
}
count = 0


def ok(what):
    global count
    count += 1
    print(f"ok: {what}")


def want(cond, what):
    if not cond:
        raise SystemExit(f"WRONG: {what}")


class Client:
    """One end of a server's two pipes."""

    def __init__(self, writes, reads):
        self.writes, self.reads, self.n = writes, reads, 0

    def send(self, message):
        self.writes.write((message if isinstance(message, str) else json.dumps(message)).encode() + b"\n")
        self.writes.flush()

    def read(self):
        line = self.reads.readline()
        want(line, "the server hung up")
        return json.loads(line)

    def post(self, method, params=None):
        """A request sent; its id."""
        self.n += 1
        self.send({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params or {}})
        return self.n

    def ask(self, method, params=None):
        """A request's answer: its result, or its error."""
        n = self.post(method, params)
        r = self.read()
        want(r.get("id") == n and r.get("jsonrpc") == "2.0", f"{method}: answered {r}")
        return r

    def call(self, name, **arguments):
        """A tool's answer: its text, and whether it is an error."""
        r = self.ask("tools/call", {"name": name, "arguments": arguments})
        want("result" in r, f"{name}: {r}")
        (c,) = r["result"]["content"]
        want(c["type"] == "text", f"{name}: {c}")
        return c["text"], r["result"]["isError"]

    def refused(self, why, name, **arguments):
        text, error = self.call(name, **arguments)
        want(error and why in text, f"{name} {arguments}: wanted a refusal with {why!r}, got {text!r}")
        ok(f"refused: {text.splitlines()[0][:110]}")


def started(*args):
    p = subprocess.Popen([sys.executable, "-m", "lipservice", "mcp", *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    return p, Client(p.stdin, p.stdout)


def read(path):
    with open(path, "rb") as f:
        return f.read()


def protocol(lip, c):
    r = c.ask("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "check", "version": "0"}})["result"]
    want(r["protocolVersion"] == "2024-11-05" and r["capabilities"] == {"tools": {}} and r["serverInfo"]["name"] == "lipservice" and r["serverInfo"]["version"] == lip.__version__, f"initialize: {r}")
    want("cannot hear" in r["instructions"], "initialize: the instructions")
    r = c.ask("initialize", {"protocolVersion": "1999-01-01", "capabilities": {}, "clientInfo": {"name": "check", "version": "0"}})["result"]
    want(r["protocolVersion"] == "2025-06-18", f"a version it does not have is answered with its newest: {r['protocolVersion']}")
    ok("the handshake: the version asked for, or the newest")

    c.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    c.send({"jsonrpc": "2.0", "method": "notifications/never-heard-of-it", "params": {}})
    want(c.ask("ping").get("result") == {}, "ping")
    ok("notifications get no answer; ping does")

    tools = c.ask("tools/list")["result"]["tools"]
    want([t["name"] for t in tools] == ["voices", "devices", "choirs", "say", "sing", "choir"], f"tools: {[t['name'] for t in tools]}")
    for t in tools:
        want(t["description"] and t["inputSchema"]["type"] == "object", f"{t['name']}: its description and schema")
        for k, v in t["inputSchema"]["properties"].items():
            want(v.get("description") and v.get("type"), f"{t['name']}.{k}: its description and type")
        a = t["annotations"]
        want(t["title"] == a["title"] and all(isinstance(a[k], bool) for k in ("readOnlyHint", "destructiveHint", "openWorldHint")), f"{t['name']}: its title and annotations")
        want(a["readOnlyHint"] == (t["name"] in ("voices", "devices", "choirs")) and a["destructiveHint"] != a["readOnlyHint"] and not a["openWorldHint"], f"{t['name']}: annotated {a}")
    ok("six tools, every argument described; the three that list are marked read-only, the three that make sound are not")

    c.send("{not json")
    r = c.read()
    want(r["id"] is None and r["error"]["code"] == -32700, f"not JSON: {r}")
    want(c.ask("tools/shout")["error"]["code"] == -32601, "an unknown method")
    want(c.ask("tools/call", {"name": "whistle"})["error"]["code"] == -32602, "an unknown tool")
    c.send({"id": 99, "method": "ping"})
    want(c.read()["error"]["code"] == -32600, "a request that is not JSON-RPC 2.0")
    c.send([{"jsonrpc": "2.0", "id": "a", "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"}, {"jsonrpc": "2.0", "id": "b", "method": "ping"}])
    r = c.read()
    want(isinstance(r, list) and [x["id"] for x in r] == ["a", "b"], f"a batch: {r}")
    ok("the protocol's errors, each by its code; a batch answered as one")


def tools(lip, c, folder, elsewhere):
    text, error = c.call("voices")
    want(not error and json.loads(text) == lip.voices(), f"voices: {text}")
    ok(f"voices: {', '.join(v['name'] for v in json.loads(text))}")

    text, error = c.call("devices")
    try:
        there = lip.devices()
    except OSError as e:
        want(error and text == str(e), f"devices: {text}")
        ok(f"devices, refused as the package refuses: {text}")
    else:
        want(not error and json.loads(text) == there, f"devices: {text}")
        ok(f"devices: {len(there)}, as the package lists them")

    def written(text, path, clip, what):
        want(text == f"{clip.made}: {clip.seconds:.2f} s of sound, written to {path}", f"{what}: answered {text!r}")
        want(read(path) == clip.wav(), f"{what}: the file is not the package's samples")
        ok(f"{what}: {text.split(', written')[0]}, the package's own bytes")

    full = os.path.join(elsewhere, "full.wav")
    text, error = c.call("say", text="Hello there, this is the server.", quality="fast", out=full)
    want(not error, text)
    written(text, full, lip.say("Hello there, this is the server.", quality="fast"), "say, to a full path")

    text, error = c.call("say", text="<speak>It is <emphasis>not</emphasis> a file name.</speak>", ssml=True, voice="ben", quality="fast", rate=1.1, shift=-1, seed=7)
    want(not error, text)
    path = text.split("written to ")[1]
    want(os.path.dirname(path) == folder and os.path.basename(path).startswith("say-ben-"), f"say, no place given: {path}")
    written(text, path, lip.say("<speak>It is <emphasis>not</emphasis> a file name.</speak>", "ben", ssml=True, quality="fast", rate=1.1, shift=-1.0, seed=7), "say, into the server's folder")

    text, error = c.call("say", text="Hello there, this is the server.", quality="fast")
    want(not error and text.split("written to ")[1] != path, f"a second file of the server's own naming: {text}")
    ok("say, again: a new name, nothing replaced")

    for q in lip.QUALITIES:
        text, error = c.call("sing", score=SONG, voice="hal", quality=q, shift=-12, motion="wide", seed=3, vibrato_delay=0.1, glide=12, dynamics=0.5, breathiness=1.2, diction=[], out=f"song-{q}.wav")
        want(not error, text)
        written(text, os.path.join(folder, f"song-{q}.wav"),
                lip.sing(SONG, "hal", quality=q, shift=-12.0, motion="wide", seed=3, vibrato_delay=0.1, glide=12, dynamics=0.5, breathiness=1.2, diction=[]), f"sing, {q}, to a name in the folder")

    text, error = c.call("choirs")
    want(not error and json.loads(text) == lip.choirs(), f"choirs: {text}")
    ok(f"choirs: {len(lip.choirs())}, as the package lists them")

    def beside(text, path, clip, what):
        j = os.path.splitext(path)[0] + ".json"
        want(text.endswith(f", written to {path}, its timing to {j}"), f"{what}: answered {text!r}")
        want(read(path) == clip.wav() and lip.load_timing(j) == json.loads(json.dumps(clip.timing)), f"{what}: the files are not the package's")
        ok(f"{what}: {text.split(', written')[0]}, the package's own bytes and timing")

    text, error = c.call("choir", piece=json.dumps(PIECE), quality="fast", seed=4, room="drier", loose=0.5, glide=12, out="piece.wav", timing=True)
    want(not error, text)
    clip = lip.choir(PIECE, quality="fast", seed=4, room="drier", loose=0.5, glide=12)
    want(clip.channels == 2 and [p["voice"] for p in clip.timing["parts"]] == ["cora", "ben"], f"a written choir: {clip}")
    beside(text, os.path.join(folder, "piece.wav"), clip, "choir, written as JSON, to a name in the folder")

    name = "Ah, Poor Bird"
    text, error = c.call("choir", piece=name, quality="fast", motion="none", timing=True)
    want(not error, text)
    path = text.split("written to ")[1].split(", its timing")[0]
    want(os.path.dirname(path) == folder and os.path.basename(path).startswith("choir-ah-poor-bird-"), f"choir, no place given: {path}")
    beside(text, path, lip.choir(name, quality="fast", motion="none"), "choir, by name, into the server's folder")

    text, error = c.call("say", text="Hello there, this is the server.", quality="fast", out="timed.wav", timing=True)
    want(not error, text)
    beside(text, os.path.join(folder, "timed.wav"), lip.say("Hello there, this is the server.", quality="fast"), "say, with its timing")

    before = sorted(os.listdir(folder))
    c.refused("no choir 'Kumbaya'", "choir", piece="Kumbaya", quality="fast")
    c.refused("a choir has parts", "choir", piece='{"room": "card"}', quality="fast")
    c.refused("High: every: 3 syllables", "choir", piece=json.dumps({**PIECE, "parts": [{**PIECE["parts"][0], "song": "%bpm 90\nevery C4:1 D4:1\n"}, PIECE["parts"][1]]}), quality="fast")
    c.refused("no voice 'zed'", "choir", piece=json.dumps({**PIECE, "parts": [{**PIECE["parts"][0], "voice": "zed"}]}), quality="fast")
    c.refused("room is \"cathedral\"", "choir", piece=name, room="cathedral")
    if not (sys.platform == "linux" and not shutil.which("aplay")):
        there = lip.devices()
        if there:
            c.refused("this call only plays", "say", text="x", device=there[0]["id"], timing=True)
    c.refused("every: 3 syllables (EH1 V AH1 R IY1), 2 notes", "sing", score="%bpm 90\nevery C4:1 D4:1\n", quality="fast")
    c.refused("line 2: g4: not a note", "sing", score="%bpm 100\nstar g4:2\n", quality="fast")
    c.refused("ssml: one root element", "say", text="No speak element.", ssml=True)
    c.refused("no voice 'zed'", "say", text="x", voice="zed")
    c.refused("quality is \"best\"", "say", text="x", quality="best")
    c.refused("motion is \"wobble\"", "sing", score=SONG, motion="wobble")
    c.refused("seed", "say", text="x", seed=-1)
    c.refused("glide", "sing", score=SONG, glide=0)
    c.refused("text is missing", "say", voice="ada")
    c.refused("no argument 'volume'", "say", text="x", volume=11)
    c.refused("rate is \"fast\": number wanted", "say", text="x", rate="fast")
    c.refused("ssml is 1: boolean wanted", "say", text="x", ssml=1)
    if sys.platform == "linux" and not shutil.which("aplay"):
        c.refused("aplay is not on this machine", "say", text="x", device="the-moon")
    else:
        c.refused("no output device 'the-moon'", "say", text="x", device="the-moon")
    c.refused("no-such-folder", "say", text="x", quality="fast", out=os.path.join(elsewhere, "no-such-folder", "x.wav"))
    want(sorted(os.listdir(folder)) == before, "a refused call left a file")
    ok("no refused call left a file")


APLAY = """null
    Discard all samples (playback) or generate zero samples (capture)
default
    Playback/recording through the PulseAudio sound server
sysdefault:CARD=PCH
    HDA Intel PCH, ALC3246 Analog
    Default Audio Device
hw:CARD=PCH,DEV=0
"""


def aplay(lip):
    """What `aplay -L` prints, read as devices. Linux's listing; the reading is checked anywhere."""
    got = lip._audio._aplay_list(APLAY)
    want(got == [
        {"id": "null", "name": "Discard all samples (playback) or generate zero samples (capture)", "default": False},
        {"id": "default", "name": "Playback/recording through the PulseAudio sound server", "default": True},
        {"id": "sysdefault:CARD=PCH", "name": "HDA Intel PCH, ALC3246 Analog, Default Audio Device", "default": False},
        {"id": "hw:CARD=PCH,DEV=0", "name": "hw:CARD=PCH,DEV=0", "default": False},
    ], f"aplay -L, read: {got}")
    ok("aplay -L's listing read as devices")


def homeless(c, elsewhere):
    c.ask("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "check", "version": "0"}})
    c.refused("nowhere to put the sound", "say", text="x")
    c.refused("not a full path", "say", text="x", out="x.wav")
    full = os.path.join(elsewhere, "homeless.wav")
    text, error = c.call("say", text="A full path needs no folder.", quality="fast", out=full)
    want(not error and os.path.getsize(full) > 10000, text)
    ok("a server with no folder: writes to a full path, and refuses the rest")


def playing(lip, device):
    """A server in this process, its say making silence, played through the device for real."""
    from lipservice import mcp

    made = []

    def quiet(text, voice="ada", **options):
        made.append(text)
        return lip.Clip(bytes(4 * int(lip.RATE * float(text))), f"silence, {text} s")

    mcp.say = quiet
    to_server, from_client = os.pipe()
    to_client, from_server = os.pipe()
    server = mcp.Server(None, os.fdopen(to_server, "rb"), os.fdopen(from_server, "wb"))
    done = threading.Event()
    threading.Thread(target=lambda: (server.run(), done.set()), daemon=True).start()
    c = Client(os.fdopen(from_client, "wb"), os.fdopen(to_client, "rb"))
    name = lip._audio.known(device)["name"]

    t = time.monotonic()
    text, error = c.call("say", text="1.5", device=device)
    took = time.monotonic() - t
    want(not error and text == f"silence, 1.5 s: 1.50 s of sound, played through {name}", text)
    want(1.5 <= took < 3.5, f"1.5 s of sound was played in {took:.2f} s")
    ok(f"played through {name}: 1.5 s of silence in {took:.2f} s, and nothing written")

    t = time.monotonic()
    a, b = c.post("tools/call", {"name": "say", "arguments": {"text": "1", "device": device}}), c.post("tools/call", {"name": "say", "arguments": {"text": "1", "device": device}})
    first = c.read()
    between = time.monotonic() - t
    want(c.ask("ping").get("result") == {}, "a ping while a clip plays")
    second = c.read()
    took = time.monotonic() - t
    want({first["id"], second["id"]} == {a, b} and between >= 1 and took >= 2, f"two calls at once: answered at {between:.2f} s and {took:.2f} s")
    ok(f"two calls at once play one after the other ({between:.2f} s, {took:.2f} s), and a ping is answered while they do")

    t = time.monotonic()
    n = c.post("tools/call", {"name": "say", "arguments": {"text": "30", "device": device}})
    while "30" not in made:
        time.sleep(0.01)
    time.sleep(0.5)
    c.send({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": n, "reason": "the check"}})
    text, error = c.call("say", text="0.5", device=device)
    took = time.monotonic() - t
    want(not error and took < 5, f"a cancelled 30 s clip held the device for {took:.2f} s: {text}")
    ok(f"a cancelled call stops playing and is not answered: the next clip was through {took:.2f} s after it began")

    t = time.monotonic()
    c.post("tools/call", {"name": "say", "arguments": {"text": "30", "device": device}})
    time.sleep(1)
    c.writes.close()
    want(done.wait(5), "the server did not end when the client hung up")
    ok(f"the client hangs up 1 s into 30 s: the server ends, {time.monotonic() - t:.2f} s in")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--bundle", required=True)
    p.add_argument("--device", metavar="ID", help="also check playing, through this device, in silence")
    a = p.parse_args()
    os.environ["LIPSERVICE_MODELS"] = os.path.abspath(a.bundle)
    import lipservice as lip

    with tempfile.TemporaryDirectory() as d:
        folder, elsewhere = os.path.join(os.path.realpath(d), "folder"), os.path.join(os.path.realpath(d), "elsewhere")
        os.mkdir(folder)
        os.mkdir(elsewhere)
        proc, c = started("--out", folder)
        protocol(lip, c)
        tools(lip, c, folder, elsewhere)
        proc.stdin.close()
        want(proc.wait(10) == 0 and proc.stdout.read() == b"", "the server's end, when the client hangs up")
        ok("the client hangs up: the server ends, status 0")

        proc, c = started()
        homeless(c, elsewhere)
        proc.stdin.close()
        want(proc.wait(10) == 0, "the server's end")

        r = subprocess.run([sys.executable, "-m", "lipservice", "mcp", "--out", os.path.join(d, "not-there")], stdin=subprocess.DEVNULL, capture_output=True, text=True)
        want(r.returncode != 0 and "not a folder" in r.stderr and r.stdout == "", f"a folder that is not there: {r}")
        ok(f"a folder that is not there: {r.stderr.strip()}")

    aplay(lip)
    if a.device:
        playing(lip, a.device)
    print(f"ok: {count} checks{'' if a.device else '; playing not checked (--device ID)'}")


if __name__ == "__main__":
    main()
