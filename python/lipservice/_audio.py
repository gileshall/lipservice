# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Giles Hall

"""Sound out of this machine: its output devices, and a clip played through one of them.

macOS: CoreAudio lists the devices and an audio queue plays to the one named, both through ctypes.
Linux: aplay (-L lists them, -D names one). Standard library only.

    devices()                  each device's id and name, and which is the default
    Player(clip, id).wait()    the clip through that device, to its end
    player.stop()              from any thread: it stops now, and wait() returns
"""

import ctypes
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from ctypes import POINTER, Structure, byref, c_char_p, c_double, c_int32, c_long, c_ubyte, c_uint32, c_void_p

PLATFORMS = ("darwin", "linux")
# seconds a macOS device may finish ahead of the clip's length before that is called a failure;
# aplay's exit status is its own word (ALSA's null device ends at once, and that is not a failure)
_EARLY = 0.5


def _platform():
    if sys.platform not in PLATFORMS:
        raise OSError(f"lipservice plays through a named device on {' and '.join(PLATFORMS)}, not {sys.platform}: write a WAV file instead (out in the MCP server, -o on the command line, save() in Python)")
    return sys.platform


def devices():
    """This machine's output devices: id (what a Player is given), name, and default (True for one)."""
    return _mac_devices() if _platform() == "darwin" else _linux_devices()


def known(device):
    """The device with this id; refused, with the ids there are, if there is none."""
    found = devices()
    for d in found:
        if d["id"] == device:
            return d
    raise ValueError(f"no output device {device!r}: {', '.join(repr(d['id']) for d in found) or 'this machine has none'}")


class Player:
    """A clip playing through the device with this id, from the moment it is made. wait() must be
    called: it returns when the clip has played or stop() was called, and lets the device go."""

    def __init__(self, clip, device):
        known(device)
        self.seconds, self.stopped = clip.seconds, False
        self._lock = threading.Lock()
        self._play = (_MacQueue if _platform() == "darwin" else _Aplay)(clip, device)
        self._began = time.monotonic()

    def stop(self):
        with self._lock:
            self.stopped = True
            self._play.stop()

    def wait(self):
        try:
            self._play.wait()
            took = time.monotonic() - self._began
        finally:
            with self._lock:
                self._play.close()
        if not self.stopped and isinstance(self._play, _MacQueue) and took < self.seconds - _EARLY:
            raise OSError(f"the device stopped {took:.2f} s into {self.seconds:.2f} s of sound")


# Linux


def _aplay():
    if not shutil.which("aplay"):
        raise OSError("aplay is not on this machine to play it with (alsa-utils has it): write a WAV file instead (out in the MCP server, -o on the command line, save() in Python)")
    return "aplay"


def _aplay_list(text):
    """aplay -L's output as devices: a name at the left margin, its description indented under it."""
    out = []
    for line in text.splitlines():
        if not line.strip():
            continue
        if line[0].isspace():
            if not out:
                raise OSError(f"aplay -L: a description before any device: {line!r}")
            out[-1]["name"].append(line.strip())
        else:
            out.append({"id": line.strip(), "name": []})
    return [{"id": d["id"], "name": ", ".join(d["name"]) or d["id"], "default": d["id"] == "default"} for d in out]


def _linux_devices():
    return _aplay_list(subprocess.run([_aplay(), "-L"], check=True, capture_output=True, text=True).stdout)


class _Aplay:
    def __init__(self, clip, device):
        self._dir = tempfile.TemporaryDirectory()
        try:
            self._proc = subprocess.Popen([_aplay(), "-q", "-D", device, clip.save(os.path.join(self._dir.name, "clip.wav"))], stderr=subprocess.PIPE, text=True)
        except BaseException:
            self._dir.cleanup()
            raise
        self._device, self._stopped = device, False

    def stop(self):
        self._stopped = True
        if self._proc.poll() is None:
            self._proc.terminate()

    def wait(self):
        _, err = self._proc.communicate()
        if self._proc.returncode and not self._stopped:
            raise OSError(f"aplay -D {self._device}: {err.strip() or f'exit status {self._proc.returncode}'}")

    def close(self):
        self._dir.cleanup()


# macOS


def _code(s):
    return int.from_bytes(s.encode("ascii"), "big")


_SYSTEM = 1  # kAudioObjectSystemObject
_GLOBAL, _OUTPUT = _code("glob"), _code("outp")
_DEVICES, _DEFAULT_OUT, _STREAMS, _NAME, _UID = _code("dev#"), _code("dOut"), _code("stm#"), _code("lnam"), _code("uid ")
_QUEUE_DEVICE, _QUEUE_RUNNING = _code("aqcd"), _code("aqrn")
_UTF8 = 0x08000100
_FLOAT_PACKED = 1 | 8  # kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked


class _Address(Structure):
    _fields_ = [("selector", c_uint32), ("scope", c_uint32), ("element", c_uint32)]


class _Format(Structure):  # AudioStreamBasicDescription
    _fields_ = [("rate", c_double), ("format", c_uint32), ("flags", c_uint32), ("packet_bytes", c_uint32), ("packet_frames", c_uint32), ("frame_bytes", c_uint32),
                ("channels", c_uint32), ("bits", c_uint32), ("reserved", c_uint32)]


class _Buffer(Structure):  # AudioQueueBuffer
    _fields_ = [("capacity", c_uint32), ("data", c_void_p), ("size", c_uint32), ("user", c_void_p), ("descriptions_capacity", c_uint32), ("descriptions", c_void_p),
                ("descriptions_count", c_uint32)]


_PLAYED = ctypes.CFUNCTYPE(None, c_void_p, c_void_p, POINTER(_Buffer))
_CHANGED = ctypes.CFUNCTYPE(None, c_void_p, c_void_p, c_uint32)

_mac = None
_mac_lock = threading.Lock()


class _Mac:
    def __init__(self):
        self.audio = ctypes.CDLL("/System/Library/Frameworks/CoreAudio.framework/CoreAudio")
        self.queue = ctypes.CDLL("/System/Library/Frameworks/AudioToolbox.framework/AudioToolbox")
        self.cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        u32, ptr = c_uint32, c_void_p
        for lib, name, args, res in [
            (self.audio, "AudioObjectGetPropertyDataSize", [u32, POINTER(_Address), u32, ptr, POINTER(u32)], c_int32),
            (self.audio, "AudioObjectGetPropertyData", [u32, POINTER(_Address), u32, ptr, POINTER(u32), ptr], c_int32),
            (self.cf, "CFStringGetLength", [ptr], c_long),
            (self.cf, "CFStringGetMaximumSizeForEncoding", [c_long, u32], c_long),
            (self.cf, "CFStringGetCString", [ptr, c_char_p, c_long, u32], c_ubyte),
            (self.cf, "CFStringCreateWithCString", [ptr, c_char_p, u32], ptr),
            (self.cf, "CFRelease", [ptr], None),
            (self.queue, "AudioQueueNewOutput", [POINTER(_Format), _PLAYED, ptr, ptr, ptr, u32, POINTER(ptr)], c_int32),
            (self.queue, "AudioQueueSetProperty", [ptr, u32, ptr, u32], c_int32),
            (self.queue, "AudioQueueGetProperty", [ptr, u32, ptr, POINTER(u32)], c_int32),
            (self.queue, "AudioQueueAddPropertyListener", [ptr, u32, _CHANGED, ptr], c_int32),
            (self.queue, "AudioQueueAllocateBuffer", [ptr, u32, POINTER(POINTER(_Buffer))], c_int32),
            (self.queue, "AudioQueueEnqueueBuffer", [ptr, POINTER(_Buffer), u32, ptr], c_int32),
            (self.queue, "AudioQueueStart", [ptr, ptr], c_int32),
            (self.queue, "AudioQueueStop", [ptr, c_ubyte], c_int32),
            (self.queue, "AudioQueueDispose", [ptr, c_ubyte], c_int32),
        ]:
            f = getattr(lib, name)
            f.argtypes, f.restype = args, res

    def check(self, status, what):
        if status:
            b = (status & 0xFFFFFFFF).to_bytes(4, "big")
            raise OSError(f"{what}: CoreAudio error {b.decode('ascii') if all(32 <= c < 127 for c in b) else status}")

    def data(self, obj, selector, scope, kind, what):
        """An audio object's property, as an array of kind."""
        a, n = _Address(selector, scope, 0), c_uint32(0)
        self.check(self.audio.AudioObjectGetPropertyDataSize(obj, byref(a), 0, None, byref(n)), what)
        out = (kind * (n.value // ctypes.sizeof(kind)))()
        self.check(self.audio.AudioObjectGetPropertyData(obj, byref(a), 0, None, byref(n), out), what)
        return list(out)[: n.value // ctypes.sizeof(kind)]

    def text(self, obj, selector, what):
        """An audio object's string property."""
        (s,) = self.data(obj, selector, _GLOBAL, c_void_p, what)
        try:
            size = self.cf.CFStringGetMaximumSizeForEncoding(self.cf.CFStringGetLength(s), _UTF8) + 1
            buf = ctypes.create_string_buffer(size)
            if not self.cf.CFStringGetCString(s, buf, size, _UTF8):
                raise OSError(f"{what}: not text")
            return buf.value.decode()
        finally:
            self.cf.CFRelease(s)


def _macos():
    global _mac
    with _mac_lock:
        if _mac is None:
            _mac = _Mac()
    return _mac


def _mac_devices():
    m = _macos()
    (default,) = m.data(_SYSTEM, _DEFAULT_OUT, _GLOBAL, c_uint32, "the default output device")
    out = []
    for d in m.data(_SYSTEM, _DEVICES, _GLOBAL, c_uint32, "the audio devices"):
        if m.data(d, _STREAMS, _OUTPUT, c_uint32, f"audio device {d}'s output streams"):
            out.append({"id": m.text(d, _UID, f"audio device {d}'s id"), "name": m.text(d, _NAME, f"audio device {d}'s name"), "default": d == default})
    return out


class _MacQueue:
    """An audio queue on one device with the whole clip in it: started, and told to stop at its end."""

    def __init__(self, clip, device):
        m = self._m = _macos()
        self._done, self._q = threading.Event(), None
        # called on the queue's own thread; kept here so they outlive the queue
        self._played = _PLAYED(lambda user, q, buf: None)
        self._changed = _CHANGED(self._running)
        data, rate = clip._data, clip.rate
        fmt = _Format(rate, _code("lpcm"), _FLOAT_PACKED, 4, 1, 4, 1, 32, 0)
        q = c_void_p()
        m.check(m.queue.AudioQueueNewOutput(byref(fmt), self._played, None, None, None, 0, byref(q)), "a queue to play through")
        self._q = q
        try:
            uid = m.cf.CFStringCreateWithCString(None, device.encode(), _UTF8)
            try:
                ref = c_void_p(uid)
                m.check(m.queue.AudioQueueSetProperty(q, _QUEUE_DEVICE, byref(ref), ctypes.sizeof(ref)), f"output device {device!r}")
            finally:
                m.cf.CFRelease(uid)
            m.check(m.queue.AudioQueueAddPropertyListener(q, _QUEUE_RUNNING, self._changed, None), "the queue's listener")
            # a second of sound a buffer
            for at in range(0, len(data), 4 * rate):
                part = data[at : at + 4 * rate]
                buf = POINTER(_Buffer)()
                m.check(m.queue.AudioQueueAllocateBuffer(q, len(part), byref(buf)), "a buffer of sound")
                ctypes.memmove(buf.contents.data, part, len(part))
                buf.contents.size = len(part)
                m.check(m.queue.AudioQueueEnqueueBuffer(q, buf, 0, None), "a buffer of sound, queued")
            m.check(m.queue.AudioQueueStart(q, None), f"output device {device!r}, starting")
            # not at once: when what is queued has played
            m.check(m.queue.AudioQueueStop(q, 0), f"output device {device!r}")
        except BaseException:
            self.close()
            raise

    def _running(self, user, q, prop):
        on, n = c_uint32(0), c_uint32(4)
        if self._m.queue.AudioQueueGetProperty(q, _QUEUE_RUNNING, byref(on), byref(n)) or not on.value:
            self._done.set()

    def stop(self):
        if self._q is not None:
            self._m.check(self._m.queue.AudioQueueStop(self._q, 1), "stopping the queue")
            self._done.set()

    def wait(self):
        self._done.wait()

    def close(self):
        if self._q is not None:
            q, self._q = self._q, None
            self._m.check(self._m.queue.AudioQueueDispose(q, 1), "letting the queue go")
