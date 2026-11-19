# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""The build backend (PEP 517): cargo builds the engine's C ABI (engine/wasm) as a shared library
for this machine (or the target LIPSERVICE_TARGET names), and the wheel is the Python package with
that library in it. Standard library only from Python 3.11; tomli before. A wheel is tagged
py3-none-PLATFORM: any Python 3, one platform.

On Linux the tag is linux_ARCH, which an index refuses; auditwheel retags it to manylinux or
musllinux (cibuildwheel runs it).
"""

import base64
import hashlib
import io
import os
import platform
import subprocess
import sys
import tarfile
import zipfile

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib  # pyproject.toml asks for it on these

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKAGE = os.path.join(ROOT, "python", "lipservice")
CRATE = os.path.join(ROOT, "engine", "wasm")

# rust target: wheel platform, the library cargo leaves, its name in the wheel, env
TARGETS = {
    "aarch64-apple-darwin": ("macosx_11_0_arm64", "liblipservice_wasm.dylib", "liblipservice.dylib", {"MACOSX_DEPLOYMENT_TARGET": "11.0"}),
    "x86_64-apple-darwin": ("macosx_10_12_x86_64", "liblipservice_wasm.dylib", "liblipservice.dylib", {"MACOSX_DEPLOYMENT_TARGET": "10.12"}),
    "x86_64-unknown-linux-gnu": ("linux_x86_64", "liblipservice_wasm.so", "liblipservice.so", {}),
    "aarch64-unknown-linux-gnu": ("linux_aarch64", "liblipservice_wasm.so", "liblipservice.so", {}),
    "x86_64-unknown-linux-musl": ("linux_x86_64", "liblipservice_wasm.so", "liblipservice.so", {}),
    "aarch64-unknown-linux-musl": ("linux_aarch64", "liblipservice_wasm.so", "liblipservice.so", {}),
    "x86_64-pc-windows-msvc": ("win_amd64", "lipservice_wasm.dll", "lipservice.dll", {}),
}
# this machine's target; LIPSERVICE_TARGET names another to build across
HOSTS = {
    ("Darwin", "arm64", ""): "aarch64-apple-darwin",
    ("Darwin", "x86_64", ""): "x86_64-apple-darwin",
    ("Linux", "x86_64", "glibc"): "x86_64-unknown-linux-gnu",
    ("Linux", "aarch64", "glibc"): "aarch64-unknown-linux-gnu",
    ("Linux", "x86_64", "musl"): "x86_64-unknown-linux-musl",
    ("Linux", "aarch64", "musl"): "aarch64-unknown-linux-musl",
    ("Windows", "AMD64", ""): "x86_64-pc-windows-msvc",
}

# what an sdist carries, from the repo's root
SOURCES = ["pyproject.toml", "python", "engine/Cargo.toml", "engine/Cargo.lock", "engine/src", "engine/wasm/Cargo.toml", "engine/wasm/Cargo.lock", "engine/wasm/src"]
SKIP = ("__pycache__", ".pyc", ".DS_Store")


def _project():
    with open(os.path.join(ROOT, "pyproject.toml"), "rb") as f:
        return tomllib.load(f)["project"]


def _metadata(p):
    lines = ["Metadata-Version: 2.4", f"Name: {p['name']}", f"Version: {p['version']}", f"Summary: {p['description']}"]
    lines += [f"Keywords: {','.join(p['keywords'])}", f"License-Expression: {p['license']}"]
    lines += [f"License-File: {f}" for f in p["license-files"]]
    lines += [f"Classifier: {c}" for c in p["classifiers"]]
    lines += [f"Project-URL: {k}, {v}" for k, v in p["urls"].items()]
    lines += [f"Requires-Python: {p['requires-python']}", "Description-Content-Type: text/markdown", ""]
    with open(os.path.join(ROOT, p["readme"]), encoding="utf-8") as f:
        return "\n".join(lines) + "\n" + f.read()


def _libc():
    """This Python's C library on Linux: glibc or musl. Nothing elsewhere."""
    if platform.system() != "Linux":
        return ""
    if platform.libc_ver()[0] == "glibc":
        return "glibc"
    if os.path.exists(f"/lib/ld-musl-{platform.machine()}.so.1"):
        return "musl"
    raise RuntimeError("this Linux's C library is neither glibc nor musl")


def _target():
    target = os.environ.get("LIPSERVICE_TARGET")
    if not target:
        key = (platform.system(), platform.machine(), _libc())
        if key not in HOSTS:
            raise RuntimeError(f"no lipservice build for {' '.join(key)}: {', '.join(' '.join(k).strip() for k in HOSTS)}")
        target = HOSTS[key]
    if target not in TARGETS:
        raise RuntimeError(f"LIPSERVICE_TARGET {target}: not one of {', '.join(TARGETS)}")
    return target


def _library():
    target = _target()
    tag, built, name, env = TARGETS[target]
    # the engine's source paths out of the library's panic messages
    flags = f"--remap-path-prefix={ROOT}=lipservice"
    if target.endswith("-musl"):
        # a shared library needs musl linked dynamically
        flags += " -C target-feature=-crt-static"
    env = {**os.environ, **env, "RUSTFLAGS": flags}
    subprocess.run(["cargo", "build", "--release", "--locked", "--target", target, "--manifest-path", os.path.join(CRATE, "Cargo.toml")], check=True, env=env)
    with open(os.path.join(CRATE, "target", target, "release", built), "rb") as f:
        return tag, name, f.read()


def _tree(top):
    """The files under top (or top itself), as paths from the repo's root with / between their
    parts on every system (a wheel's and an sdist's names are written so), sorted."""
    full = os.path.join(ROOT, top)
    if os.path.isfile(full):
        return [top]
    if not os.path.isdir(full):
        raise FileNotFoundError(full)
    out = []
    for d, _, files in os.walk(full):
        out += [os.path.relpath(os.path.join(d, f), ROOT).replace(os.sep, "/") for f in files]
    return sorted(f for f in out if not any(s in f for s in SKIP))


def _read(rel):
    with open(os.path.join(ROOT, rel), "rb") as f:
        return f.read()


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    p = _project()
    tag, lib, code = _library()
    info = f"{p['name']}-{p['version']}.dist-info"
    files = {f[len("python/"):]: _read(f) for f in _tree("python/lipservice")}
    files[f"lipservice/_native/{lib}"] = code
    files[f"{info}/METADATA"] = _metadata(p).encode()
    files[f"{info}/WHEEL"] = f"Wheel-Version: 1.0\nGenerator: lipservice\nRoot-Is-Purelib: false\nTag: py3-none-{tag}\n".encode()
    files[f"{info}/entry_points.txt"] = ("[console_scripts]\n" + "".join(f"{k} = {v}\n" for k, v in p["scripts"].items())).encode()
    for f in p["license-files"]:
        files[f"{info}/licenses/{f}"] = _read(f)
    record = "".join(f"{n},sha256={base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b'=').decode()},{len(b)}\n" for n, b in sorted(files.items()))
    files[f"{info}/RECORD"] = (record + f"{info}/RECORD,,\n").encode()
    name = f"{p['name']}-{p['version']}-py3-none-{tag}.whl"
    with zipfile.ZipFile(os.path.join(wheel_directory, name), "w", zipfile.ZIP_DEFLATED) as z:
        for n, b in sorted(files.items()):
            zi = zipfile.ZipInfo(n, (1980, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = (0o755 if n.startswith("lipservice/_native/") else 0o644) << 16
            z.writestr(zi, b)
    return name


def build_sdist(sdist_directory, config_settings=None):
    p = _project()
    top = f"{p['name']}-{p['version']}"
    files = {f: _read(f) for s in SOURCES + p["license-files"] for f in _tree(s)}
    files["PKG-INFO"] = _metadata(p).encode()
    name = f"{top}.tar.gz"
    with tarfile.open(os.path.join(sdist_directory, name), "w:gz", format=tarfile.PAX_FORMAT) as t:
        for n, b in sorted(files.items()):
            ti = tarfile.TarInfo(f"{top}/{n}")
            ti.size, ti.mode = len(b), 0o644
            t.addfile(ti, io.BytesIO(b))
    return name
