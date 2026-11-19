# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""The MCP server: `lipservice mcp`. A model that connects to it can speak and sing.

It speaks the Model Context Protocol over stdin and stdout, a JSON message a line, and offers four
tools: voices, devices, say and sing. Standard library only.

Where the sound of say and sing goes is always said:

    device   the id of one of this machine's outputs (the devices tool): played there, and the
             call returns when it has played
    out      a WAV file's path: written there. A path that is not a full one is inside the
             server's folder
    neither  a new file in the server's folder

The server's folder is `--out DIR`, or LIPSERVICE_OUT. Without one, a call that names no device
and no full path is refused. Nothing is ever played that was not asked for by device.

One clip plays at a time: a second call waits for the first to finish. A call the client cancels
(notifications/cancelled) stops playing and is not answered. When stdin closes, what is playing
stops and the server ends.
"""

import json
import os
import sys
import threading
import time
import traceback

from . import MOTIONS, QUALITIES, Error, __version__, _audio, devices, say, sing, voices

# newest first: the one a client asks for if it is here, the newest if it is not
PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")

INSTRUCTIONS = """Lip Service says text aloud and sings written scores, in sixteen English voices, on this machine's own CPU.

Three things to hold on to:
1. You cannot hear what you make. A file that was written is not a song that sounds right. Say what you made and where it is, and let the person listen.
2. The engine refuses what it cannot say or sing, and says why. Read the refusal, fix that one thing, call again.
3. Give the person the score along with the song. It is plain text, and they can change it.

say and sing put the sound where you tell them: `device` plays it through one of the machine's outputs (ids from the devices tool) and returns when it has played; `out` writes a WAV file. Play through a device only when the person wants to hear it now."""

_WHERE = {
    "device": {"type": "string", "description": "Play it through this output: an id from the devices tool. The call returns when it has played."},
    "out": {"type": "string", "description": "Write a WAV file (mono, 24 kHz) here. A full path, or a name inside the server's own folder if it has one. A file already there is replaced. May be given with device."},
}
_VOICE = {
    "voice": {"type": "string", "description": "Who: a name from the voices tool. ada, cora, eve, gwen, ivy, kate, mae, opal are female; ben, dev, finn, hal, jack, leo, ned, pete are male.", "default": "ada"},
    "quality": {"type": "string", "enum": list(QUALITIES), "description": "hifi sounds best; fast is quicker.", "default": "hifi"},
    "seed": {"type": "integer", "description": "The same seed gives the same reading; another gives another take.", "default": 0},
}

_SAY = """Says a text in one of the voices. Plain text is read as written, and paragraphs are said one at a time with a pause between.

With ssml true the text is SSML and must be one <speak> element. It takes <p>, <s>, <break time="600ms"/>, <prosody rate pitch volume>, <emphasis level="strong|moderate|reduced|none">, <say-as interpret-as="characters|spell-out|cardinal|ordinal|digits|time">, <phoneme alphabet="arpabet" ph="T AH0 M AA1 T OW0"> and <sub alias="...">. Anything else is refused by name.

The answer says what was made, how many seconds of sound it is, and where it went."""

_SING = """Sings a score in one of the voices. The score is text, one word a line with the notes it is sung on:

bpm 100
twinkle C4:1 C4:1
twinkle G4:1 G4:1
little A4:1 A4:1
star G4:2
rest 1

- `bpm N`: the tempo, beats a minute. Exactly once.
- `WORD GROUP GROUP ...`: one bare word (no punctuation, no hyphens), then one group for each syllable of it.
- A group is NOTE:BEATS, or several joined by + to move one syllable through several notes: `B4:0.5+G4:0.5`.
- NOTE is a capital letter A to G, then # or b if any, then the octave (C4 is middle C), or a MIDI number 0 to 127.
- BEATS is any number above zero.
- `rest BEATS`: silence. Put one wherever the singer would breathe.
- `vibrato SIZE` or `vibrato SIZE:BEATS ...`: the vibrato's size from here on (0 straight, 1 the voice's own), jumping or gliding there. Takes no time.
- A line starting with # is a comment. To sing the word rest, bpm or vibrato, capitalise it.

One voice, one note at a time, one tempo, English words. The engine counts syllables as it says the word and refuses a miscount with the answer in it: `every: 3 syllables (EH1 V ER0 IY0), 2 notes` means one group for each sound ending in a digit. Often miscounted: every 3, family 3, fire 2, hour 2, heaven 2, world 1. When the tune has more notes than syllables, join notes with +; when the word has more syllables, divide a note between them. A note too short for its consonants is refused too: lengthen it or lower the bpm. Fix one refusal a call.

The song is sung where it is written: for a male voice keep the score and give shift -12. It lasts its beats times 60 over the bpm, plus about a quarter of a second: check the seconds in the answer against that."""

# what each tool does to the world, for a client deciding what to ask the person first. None reaches outside this machine.
_READS = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}
# say and sing write a file or play a sound, and an `out` that names a file there already replaces it
_MAKES = {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False, "openWorldHint": False}

TOOLS = [
    {
        "name": "voices",
        "title": "List the voices",
        "annotations": {"title": "List the voices", **_READS},
        "description": "The voices there are: each one's name, sex (F or M) and the recordings it was made from.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "devices",
        "title": "List the sound outputs",
        "annotations": {"title": "List the sound outputs", **_READS},
        "description": "The sound outputs of the machine this server runs on: each one's id (what say and sing take as device), its name, and which is the system's default. Two outputs can share a name; the id tells them apart.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "say",
        "title": "Say a text",
        "annotations": {"title": "Say a text", **_MAKES},
        "description": _SAY,
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "What to say."},
                **_VOICE,
                "rate": {"type": "number", "description": "Speed, times: 1.15 is 15% faster.", "default": 1.0},
                "shift": {"type": "number", "description": "Semitones up or down from the voice's own register.", "default": 0.0},
                "ssml": {"type": "boolean", "description": "The text is SSML.", "default": False},
                **_WHERE,
            },
            "required": ["text"],
            "additionalProperties": False,
        },
    },
    {
        "name": "sing",
        "title": "Sing a score",
        "annotations": {"title": "Sing a score", **_MAKES},
        "description": _SING,
        "inputSchema": {
            "type": "object",
            "properties": {
                "score": {"type": "string", "description": "The song, as text."},
                **_VOICE,
                "shift": {"type": "number", "description": "Semitones, the whole song: -12 puts a song written around middle C in a man's range.", "default": 0.0},
                "vibrato": {"type": "number", "description": "The vibrato's peak, semitones. 0 for none anywhere.", "default": 0.25},
                "vibrato_hz": {"type": "number", "description": "The vibrato's speed.", "default": 5.5},
                "vibrato_delay": {"type": "number", "description": "Seconds into a vowel before the vibrato starts.", "default": 0.25},
                "motion": {"type": "string", "enum": list(MOTIONS), "description": "A trained singer's pitch movement in place of the plain vibrato. The seed picks the singer."},
                "motion_scale": {"type": "number", "description": "The size of that movement, times.", "default": 1.0},
                "glide": {"type": "integer", "description": "Hundredths of a second the pitch takes between notes.", "default": 9},
                "dynamics": {"type": "number", "description": "How far loudness and brightness follow the melody. 0 is none.", "default": 0.0},
                "breathiness": {"type": "number", "description": "The breath in the sung vowels, times.", "default": 1.0},
                "diction": {"type": "boolean", "description": "Every vowel sung as a stressed one.", "default": False},
                **_WHERE,
            },
            "required": ["score"],
            "additionalProperties": False,
        },
    },
]
_TOOLS = {t["name"]: t for t in TOOLS}

_TYPES = {
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
}


class _Refused(Exception):
    """A message that is not one this protocol has: answered as a JSON-RPC error."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class _Cancelled(Exception):
    """The client took the call back: it gets no answer."""


def _arguments(tool, given):
    """A call's arguments against the tool's schema: every one known and of its type, none missing."""
    schema = tool["inputSchema"]
    if not isinstance(given, dict):
        raise ValueError(f"{tool['name']}: the arguments are an object")
    for k, v in given.items():
        if k not in schema["properties"]:
            raise ValueError(f"{tool['name']}: no argument {k!r}: {', '.join(schema['properties']) or 'it takes none'}")
        want = schema["properties"][k]
        if not _TYPES[want["type"]](v):
            raise ValueError(f"{tool['name']}: {k} is {json.dumps(v)}: {want['type']} wanted")
        if "enum" in want and v not in want["enum"]:
            raise ValueError(f"{tool['name']}: {k} is {json.dumps(v)}: {', '.join(want['enum'])}")
    for k in schema.get("required", []):
        if k not in given:
            raise ValueError(f"{tool['name']}: {k} is missing")
    return given


class _Call:
    """A tool call in flight, and what it is playing."""

    def __init__(self):
        self.cancelled, self._player, self._lock = False, None, threading.Lock()

    def cancel(self):
        with self._lock:
            self.cancelled = True
            if self._player:
                self._player.stop()

    def play(self, clip, device):
        with self._lock:
            if self.cancelled:
                raise _Cancelled()
            player = self._player = _audio.Player(clip, device)
        try:
            player.wait()
        finally:
            with self._lock:
                self._player = None
        if self.cancelled:
            raise _Cancelled()


class Server:
    """The server on a pair of byte streams. out is its folder for sound, or None."""

    def __init__(self, out, reads, writes):
        self.out, self._reads, self._writes = out, reads, writes
        self._send_lock, self._play_lock, self._calls_lock = threading.Lock(), threading.Lock(), threading.Lock()
        self._calls, self._made = {}, 0

    def run(self):
        """Serves until the client closes its end; what is playing then stops."""
        try:
            for line in self._reads:
                if not line.strip():
                    continue
                try:
                    message = json.loads(line)
                except ValueError as e:
                    self._send(self._error(None, -32700, f"not JSON: {e}"))
                    continue
                if isinstance(message, list):
                    # a batch is answered as one, in order
                    answers = [a for a in (self._handle(m) for m in message) if a is not None]
                    if answers:
                        self._send(answers)
                elif isinstance(message, dict) and message.get("method") == "tools/call" and "id" in message:
                    # off this thread, so a long clip does not hold up a ping or its own cancelling
                    threading.Thread(target=lambda m=message: self._send(self._handle(m)), name="lipservice-call", daemon=True).start()
                else:
                    self._send(self._handle(message))
        finally:
            with self._calls_lock:
                calls = list(self._calls.values())
            for c in calls:
                c.cancel()

    def _send(self, message):
        if message is None:
            return
        with self._send_lock:
            self._writes.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode() + b"\n")
            self._writes.flush()

    @staticmethod
    def _error(id, code, message):
        return {"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}

    def _handle(self, m):
        """A message's answer, or None if it gets none."""
        if not isinstance(m, dict) or m.get("jsonrpc") != "2.0" or not isinstance(m.get("method"), str):
            if isinstance(m, dict) and "method" not in m and ("result" in m or "error" in m):
                return None  # an answer to something; this server asks nothing
            return self._error(m.get("id") if isinstance(m, dict) else None, -32600, "not a JSON-RPC 2.0 request")
        method, params, asked = m["method"], m.get("params", {}), "id" in m
        if not asked:
            if method == "notifications/cancelled" and isinstance(params, dict):
                with self._calls_lock:
                    call = self._calls.get(json.dumps(params.get("requestId")))
                if call:
                    call.cancel()
            return None
        id = m["id"]
        try:
            if not isinstance(params, dict):
                raise _Refused(-32602, "params is an object")
            return {"jsonrpc": "2.0", "id": id, "result": self._answer(id, method, params)}
        except _Cancelled:
            return None
        except _Refused as e:
            return self._error(id, e.code, str(e))
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            return self._error(id, -32603, f"{type(e).__name__}: {e}")

    def _answer(self, id, method, params):
        if method == "initialize":
            asked = params.get("protocolVersion")
            return {
                "protocolVersion": asked if asked in PROTOCOLS else PROTOCOLS[0],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "lipservice", "title": "Lip Service", "version": __version__},
                "instructions": INSTRUCTIONS,
            }
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": TOOLS}
        if method == "tools/call":
            name = params.get("name")
            if name not in _TOOLS:
                raise _Refused(-32602, f"no tool {name!r}: {', '.join(_TOOLS)}")
            call, key = _Call(), json.dumps(id)
            with self._calls_lock:
                self._calls[key] = call
            try:
                text = getattr(self, f"_{name}")(call, **_arguments(_TOOLS[name], params.get("arguments", {})))
            except (Error, ValueError, OSError, RuntimeError) as e:
                # the model's to read and mend: the engine's refusal, a voice or device there is not, a path that cannot be written
                return {"content": [{"type": "text", "text": str(e)}], "isError": True}
            finally:
                with self._calls_lock:
                    del self._calls[key]
            return {"content": [{"type": "text", "text": text}], "isError": False}
        raise _Refused(-32601, f"no method {method!r}")

    # the tools

    def _voices(self, call):
        return json.dumps(voices(), indent=1)

    def _devices(self, call):
        return json.dumps(devices(), indent=1, ensure_ascii=False)

    def _say(self, call, text, voice="ada", quality="hifi", rate=1.0, shift=0.0, seed=0, ssml=False, device=None, out=None):
        return self._give(call, "say", voice, device, out, lambda: say(text, voice, quality=quality, rate=rate, shift=shift, seed=seed, ssml=ssml))

    def _sing(self, call, score, voice="ada", quality="hifi", device=None, out=None, **options):
        return self._give(call, "sing", voice, device, out, lambda: sing(score, voice, quality=quality, **options))

    def _file(self, kind, voice, device, out):
        """Where a call's WAV file goes, and whether the name is this server's own; None if it is only played."""
        if out is not None:
            out = os.path.expanduser(out)
            if os.path.isabs(out):
                return out, False
            if not self.out:
                raise ValueError(f"out is {out!r}, which is not a full path, and this server has no folder of its own to put it in: give a full path (the server's folder is `lipservice mcp --out DIR`, or LIPSERVICE_OUT)")
            return os.path.join(self.out, out), False
        if device is not None:
            return None, False
        if not self.out:
            raise ValueError("nowhere to put the sound: give device (an id from the devices tool) to play it, or out (a full path) to write a WAV file. This server has no folder of its own (`lipservice mcp --out DIR`, or LIPSERVICE_OUT)")
        with self._calls_lock:
            self._made += 1
            n = self._made
        return os.path.join(self.out, f"{kind}-{voice}-{time.strftime('%Y%m%d-%H%M%S')}-{n}.wav"), True

    def _give(self, call, kind, voice, device, out, make):
        """Makes the clip and puts it where the call said. Where is settled first, so nothing is made for nowhere."""
        through = _audio.known(device) if device is not None else None
        path, own = self._file(kind, voice, device, out)
        clip = make()
        if call.cancelled:
            raise _Cancelled()
        said = f"{clip.made}: {clip.seconds:.2f} s of sound"
        if path:
            # a name of this server's own never replaces a file; one the caller gave does
            with open(path, "xb" if own else "wb") as f:
                f.write(clip.wav())
            said += f", written to {path}"
        if through:
            with self._play_lock:
                call.play(clip, device)
            said += f", played through {through['name']}"
        return said


def serve(out):
    """The server on this process's stdin and stdout, until stdin closes."""
    if out is not None and not os.path.isdir(out):
        raise OSError(f"{out}: the folder for sound is not a folder")
    # the protocol keeps the real stdout; anything else that prints lands on stderr, not in a message
    writes = os.fdopen(os.dup(sys.stdout.fileno()), "wb")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    Server(out and os.path.abspath(out), sys.stdin.buffer, writes).run()
