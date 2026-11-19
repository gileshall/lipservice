# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""The model files: the engine's own (lipservice::home, engine/src/home.rs) finds, fetches, checks
and keeps them, as it does for the command line built from the crate. This side only moves bytes:
the engine hands it a URL and a file path, and urllib fetches it there. Where the models are
served, where they are kept, LIPSERVICE_MODELS, LIPSERVICE_CACHE and LIPSERVICE_SOURCES are all
the engine's to read.
"""

import ctypes
import json
import threading
import urllib.request

from . import _engine

_lock = threading.Lock()
_manifest = None


@_engine.GET
def _get(url_p, url_n, path_p, path_n):
    """The engine's request: the bytes at a URL written to a path. 0, or the reason and 1."""
    try:
        url = ctypes.string_at(url_p, url_n).decode()
        path = ctypes.string_at(path_p, path_n).decode()
        req = urllib.request.Request(url, headers={"User-Agent": "lipservice"})
        with urllib.request.urlopen(req) as r, open(path, "wb") as f:
            while b := r.read(1 << 20):
                f.write(b)
        return 0
    except BaseException as e:  # handed to the engine, which says it and tries the next source
        msg = str(e).encode()
        _engine._library().ls_home_fail(msg, len(msg))
        return 1


def _answer(n):
    lib = _engine._library()
    if n < 0:
        raise RuntimeError(ctypes.string_at(lib.ls_error(), lib.ls_error_len()).decode())
    return ctypes.string_at(lib.ls_home_out(), n).decode()


def manifest():
    """The served manifest (or LIPSERVICE_MODELS's): the voices and every file's size and hash."""
    global _manifest
    with _lock:
        if _manifest is None:
            _manifest = json.loads(_answer(_engine._library().ls_home_manifest(_get)))
    return _manifest


def home():
    """The folder the model files are read from."""
    return _answer(_engine._library().ls_home_dir(_get))


def path(name):
    """Where model file `name` is, fetched first if it is not kept or has changed."""
    b = name.encode()
    return _answer(_engine._library().ls_home_path(b, len(b), _get))


def read(name):
    with open(path(name), "rb") as f:
        return f.read()
