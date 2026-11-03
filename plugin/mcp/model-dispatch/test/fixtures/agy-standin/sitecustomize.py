"""Lets the stand-in SDK fake the computer sleeping (loaded by Python at start-up, from PYTHONPATH).

A real sleep moves the wall clock and the macOS clocks that count sleep (CLOCK_REALTIME, CLOCK_MONOTONIC,
CLOCK_MONOTONIC_RAW), while CLOCK_UPTIME_RAW, time.monotonic() and time.perf_counter() (mach_absolute_time) and so
asyncio's own clock stand still. The stand-in's "os_sleep" event adds its seconds to the first group only, through
the `_agy_standin_clock` module this installs; until a script asks for a sleep, every clock reads as it really is.
Python's own sitecustomize, when there is one further along sys.path (Homebrew ships one), still runs.
"""
import importlib.machinery
import importlib.util
import os
import sys
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

for _entry in sys.path:
    if os.path.abspath(_entry or os.getcwd()) == _here:
        continue
    _spec = importlib.machinery.PathFinder.find_spec("sitecustomize", [_entry])
    if _spec and _spec.origin and os.path.dirname(os.path.abspath(_spec.origin)) != _here:
        _mod = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
        break
