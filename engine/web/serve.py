# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""The page served from a built site, with the listener's notes kept beside it.

    serve.py SITE PORT NOTES [HOST]

HOST: the address listened on. Without it 127.0.0.1, this machine alone; 0.0.0.0 is every network
the machine is on, and anyone who reaches it can read the site and post notes.

SITE: the built site (index.html, lipservice.wasm, models/, and build.json: what it was built from).
NOTES: a directory. Each note the page posts (notes.js) is a line of NOTES/notes.jsonl, stamped with
the site's build.json as it is then, its clip in NOTES/clips/ID.wav. A note taken back is a line too
({"gone": ID}); nothing is rewritten. GET /notes gives the notes not taken back. Nothing is cached, so
a reload shows the site as it is."""
import base64
import functools
import json
import os
import re
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ID = re.compile(r"^[a-z0-9]{8,24}$")
MAX_BODY = 8 << 20
LOCK = threading.Lock()


def notes(log):
    """The notes in the log not taken back."""
    kept = {}
    if not os.path.exists(log):
        return []
    with open(log) as f:
        for k, line in enumerate(f, 1):
            try:
                r = json.loads(line)
            except ValueError as e:
                raise ValueError(f"{log} line {k}: {e}") from e
            if "gone" in r:
                kept.pop(r["gone"], None)
            else:
                kept[r["id"]] = r
    return list(kept.values())


class Handler(SimpleHTTPRequestHandler):
    kept = ""  # NOTES

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def answer(self, code, body, kind="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def refuse(self, code, why):
        self.answer(code, (why + "\n").encode(), "text/plain; charset=utf-8")

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/notes":
            return super().do_GET()
        try:
            with LOCK:
                body = json.dumps(notes(os.path.join(self.kept, "notes.jsonl"))).encode()
        except (OSError, ValueError) as e:
            return self.refuse(500, str(e))
        self.answer(200, body)

    def do_POST(self):
        if self.path != "/notes":
            return self.refuse(404, "not found")
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 < n <= MAX_BODY:
            return self.refuse(413, f"a body of {n} bytes")
        try:
            got = json.loads(self.rfile.read(n))
            line, clip = self.line(got)
        except (ValueError, KeyError, TypeError) as e:
            return self.refuse(400, f"not a note: {e}")
        except OSError as e:
            return self.refuse(500, str(e))
        try:
            with LOCK:
                if clip is not None:
                    os.makedirs(os.path.join(self.kept, "clips"), exist_ok=True)
                    with open(os.path.join(self.kept, "clips", line["clip"]["file"]), "wb") as f:
                        f.write(clip)
                with open(os.path.join(self.kept, "notes.jsonl"), "a") as f:
                    f.write(json.dumps(line) + "\n")
                    f.flush()
                    os.fsync(f.fileno())
        except OSError as e:
            return self.refuse(500, str(e))
        self.answer(200, json.dumps(line).encode())

    def line(self, got):
        """The log's line for what the page posted, and its clip's bytes (None for none)."""
        if set(got) == {"gone"}:
            if not ID.match(got["gone"]):
                raise ValueError("gone: not a note's id")
            return got, None
        note, clip = got["note"], got["clip"]
        if not ID.match(note["id"]):
            raise ValueError("id")
        if not isinstance(note["text"], str) or not note["text"].strip():
            raise ValueError("text")
        if not isinstance(note["at"], (int, float)) or isinstance(note["at"], bool) or note["at"] < 0:
            raise ValueError("at")
        for k in ("piece", "kind", "key", "created"):
            if not isinstance(note[k], str):
                raise ValueError(k)
        if not isinstance(note["recipe"], dict):
            raise ValueError("recipe")
        with open(os.path.join(self.directory, "build.json")) as f:
            note["build"] = json.load(f)
        if clip is None:
            note["clip"] = None
            return note, None
        if not isinstance(clip["from"], (int, float)):
            raise ValueError("clip.from")
        data = base64.b64decode(clip["wav"], validate=True)
        if data[:4] != b"RIFF":
            raise ValueError("clip.wav")
        note["clip"] = {"file": note["id"] + ".wav", "from": clip["from"]}
        return note, data

    def log_message(self, fmt, *args):
        # the page's files fetched are not worth a line each
        if not (fmt == '"%s" %s %s' and self.command == "GET" and str(args[1])[:1] in "23"):
            super().log_message(fmt, *args)


def main():
    if len(sys.argv) not in (4, 5):
        sys.exit(__doc__)
    site, port, kept = os.path.abspath(sys.argv[1]), int(sys.argv[2]), os.path.abspath(sys.argv[3])
    host = sys.argv[4] if len(sys.argv) == 5 else "127.0.0.1"
    if not os.path.isfile(os.path.join(site, "build.json")):
        sys.exit(f"{site}: no build.json")
    os.makedirs(kept, exist_ok=True)
    Handler.kept = kept
    ThreadingHTTPServer((host, port), functools.partial(Handler, directory=site)).serve_forever()


if __name__ == "__main__":
    main()
