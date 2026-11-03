"""Lets the stand-in SDK fake the computer sleeping (loaded by Python at start-up, from PYTHONPATH).

A real sleep moves the wall clock and the macOS clocks that count sleep (CLOCK_REALTIME, CLOCK_MONOTONIC,
CLOCK_MONOTONIC_RAW), while CLOCK_UPTIME_RAW, time.monotonic() and time.perf_counter() (mach_absolute_time) and so
asyncio's own clock stand still. The stand-in's "os_sleep" event adds its seconds to the first group only, through
the `_agy_standin_clock` module this installs; until a script asks for a sleep, every clock reads as it really is.
Python's own sitecustomize, when there is one further along sys.path (Homebrew ships one), still runs.

It also logs each heartbeat line the worker writes to stderr, as it writes it (_StampedStderr), so the tests time
heartbeats on the worker's own clock.
"""
import importlib.machinery
import importlib.util
import json
import os
import sys
import threading
import time
import types

_here = os.path.dirname(os.path.abspath(__file__))
_state = types.ModuleType("_agy_standin_clock")
_state.offset = 0.0
_real_time, _real_time_ns = time.time, time.time_ns
_real_cg, _real_cg_ns = time.clock_gettime, time.clock_gettime_ns
_SLEEPING = {getattr(time, n) for n in ("CLOCK_REALTIME", "CLOCK_MONOTONIC", "CLOCK_MONOTONIC_RAW", "CLOCK_MONOTONIC_RAW_APPROX") if hasattr(time, n)}


def _time():
    return _real_time() + _state.offset


def _time_ns():
    return _real_time_ns() + int(_state.offset * 1e9)


def _clock_gettime(clk):
    v = _real_cg(clk)
    return v + _state.offset if clk in _SLEEPING else v


def _clock_gettime_ns(clk):
    v = _real_cg_ns(clk)
    return v + int(_state.offset * 1e9) if clk in _SLEEPING else v


def _sleep(seconds):
    _state.offset += float(seconds)


_state.real_time = _real_time
_state.sleep = _sleep
time.time, time.time_ns, time.clock_gettime, time.clock_gettime_ns = _time, _time_ns, _clock_gettime, _clock_gettime_ns
sys.modules["_agy_standin_clock"] = _state


class _StampedStderr:
    """The worker's stderr, unchanged, with each heartbeat line also logged (AGY_STANDIN_LOG) as the worker writes it.

    The log line has the stand-in's own clocks ("mono" is time.monotonic(), as in its other events), so a test times a
    heartbeat by when the worker sent it. The time the test's process reads the line is later by however long a busy
    machine takes to get round to it: a heartbeat written before the worker's call was once read after it.
    """

    PREFIX = "@mmo-heartbeat "

    def __init__(self, inner, path):
        self._inner, self._path, self._partial = inner, path, ""
        self._lock = threading.Lock()

    def write(self, text):
        mono, wall = time.monotonic(), _real_time()
        n = self._inner.write(text)
        with self._lock:
            self._partial += text
            *lines, self._partial = self._partial.split("\n")
            for line in lines:
                if line.startswith(self.PREFIX):
                    with open(self._path, "a", encoding="utf-8") as f:
                        f.write(json.dumps({"ev": "heartbeat", "wall": wall, "mono": mono, "pid": os.getpid(), "line": line}) + "\n")
        return n

    def __getattr__(self, name):
        return getattr(self._inner, name)


if os.environ.get("AGY_STANDIN_LOG"):
    sys.stderr = _StampedStderr(sys.stderr, os.environ["AGY_STANDIN_LOG"])

for _entry in sys.path:
    if os.path.abspath(_entry or os.getcwd()) == _here:
        continue
    _spec = importlib.machinery.PathFinder.find_spec("sitecustomize", [_entry])
    if _spec and _spec.origin and os.path.dirname(os.path.abspath(_spec.origin)) != _here:
        _mod = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
        break
