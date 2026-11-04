"""agy_supervisor.py — Gemini calls through the Antigravity SDK, run under watch.

Both workers (typist_worker.py, gemini_worker.py) run their session's turns through this module. It reads only the
SDK's public parts: `conversation.history` (each step update is appended there as `resolve()` pulls it; read every
POLL_S), each error step's `http_code` (read with getattr, as the SDK itself reads it), `ChatResponse.cancel()`
(aborts the HTTP call and keeps the session's usage), `ChatResponse.stop_reason` and `conversation.total_usage`.

Per model call:
  - a call that receives nothing from Google for its stall limit is cut and sent again, the second try with twice the
    room; a call that stalls on every try is `unavailable` (stalled). The harness's own wait before it retries a
    refused request (its first wait, doubling: the workers pass --api-retry-initial-ms) is not counted as silence;
  - Google's HTTP status is read from the SDK's error steps. 401/403 end the call. 400/404 end it, or drop that
    location when the call has others. 408/429/5xx and the harness's network code 2 are refusals: with one location
    the harness's own retries were the call's budget, except a 500, which the harness never retries and which is sent
    again in a fresh session within the busy budget; with more locations the call moves to the next one, round after
    round with the executor's backoff between rounds, until the busy budget is spent;
  - three empty-output error steps in a row cut the turn (the harness retries an empty answer at once, without a cap), or
    end it as the model's error when the harness's own call budget ended the turn first;
  - a computer that slept 5 s or more while a request was out cuts it at once and sends it again;
  - the session's time limit counts its own work only: calls Google held until they were cut, refused requests and
    their waits, and the waits between tries are left out (sleep already is: the monotonic clock does not count it);
  - SIGTERM cancels the turn in flight and ends the call, so the worker still writes its receipt.

The contract the engine reads (src/executor/stall.ts, src/executor/typists.ts, src/adapters/AntigravityWorkerAdapter.ts):

Worker flags, both workers, each optional:
  --locations L1,L2,...  the call's locations in order (default: --region)
  --stall-sec N          seconds a call may go without receiving anything (default 300)
  --stall-tries N        tries per model call against stalls (default 2)
  --busy-budget-sec N    seconds a call may keep meeting refusals (default 120)
  --heartbeat-sec N      heartbeat interval (default 10)
  The agent worker also takes --api-retries N and --api-retry-initial-ms N, as the typist worker already did.
  Every worker (typist_worker.py, gemini_worker.py, thinking_worker.py) also takes --watch-stdin and --term-grace-sec N:
  the engine holds the worker's stdin open while it waits on the worker, and once it closes (the engine is gone,
  however it ended) the worker stops its process group as the engine's kill rule would, SIGTERM, then SIGKILL N s
  later (default 10, the kill rule's own wait) if it still runs.

Receipt (typist) and usage sidecar (agent): every key they had before, plus
  tries          one entry per session (typist) or per segment of a session (agent door), in order:
                 {location, ended_by, http_codes, s, start_s, end_s, started_at, usage, served_tier[, reason]}
                 ended_by: answer | error | refused | network | stalled | work_limit | cancelled
  unavailable    the reason, when Google could not serve the call (its busy or stall budget ran out)
  stall_cuts, failovers, cut_calls, google_wait_s, work_s, slept_s (macOS only), served_tier, teardown_error
  `usage` is the sum of the tries' own usage, with the SDK's field names; `vertex_location` is the location of the
  try that ended the call; `error_status` is Google's last HTTP status when the call ended with an SDK error.

Heartbeat: one stderr line as the worker starts, every --heartbeat-sec of the worker's own clock, and as soon as a
call's billed usage changes (never two within BEAT_MIN_GAP_S), written from the event loop, so a worker whose loop is
blocked stops beating (the engine's kill rule reads that) and a worker stopped or frozen after a billed call has
already reported it:
  @mmo-heartbeat {"v":1,"state":"wait","work_s":..,"wait_s":..,"call_wait_s":..,"slept_s":..,"try":2,
                  "location":"us","usage":{"global":{..},"us":{..}},"sdk_version":"0.1.22"}

Written for Python 3.9 and newer: the engine's tests run the typist worker with the python3 a machine has.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import signal
import sys
import threading
import time

# How often a turn's steps are read. The harness re-sends an empty answer at once (5 to 40 ms apart against a fast
# endpoint), each re-send billed with the whole conversation, so the empty-output rule must see each step within a
# request or two of it; read once a second, such a loop ran 50 requests before it was cut.
POLL_S = 0.01
# How often the heartbeat task reads the usage, and the least time between two heartbeats: a billed call is reported
# at once when no heartbeat went out in the last second, else a second after the last one, so a fast stream of billed
# calls cannot flood stderr.
BEAT_POLL_S = 0.1
BEAT_MIN_GAP_S = 1.0
SLEEP_CUT_S = 5.0
EMPTY_OUTPUT_CUT = 3
# The executor's transport backoff (src/executor/tools.ts TRANSPORT): the wait between failover rounds, and before a
# 500 is sent again.
RETRY_BASE_S = 2.0
RETRY_CAP_S = 60.0
# How long a cancelled turn may take to end before the worker stops waiting for it.
CANCEL_GRACE_S = 15.0
STOP_GRACE_S = 5.0

BUSY_CODES = frozenset({408, 429, 500, 502, 503, 504})
NETWORK_CODE = 2
NOT_SERVED_CODES = frozenset({400, 404})
# The harness's own words when it continues a conversation it interrupted: the agent door sends them after cutting a
# call held after a tool has run.
CONTINUE_MESSAGE = "Please continue the task you were working on."
USAGE_FIELDS = ("prompt_token_count", "cached_content_token_count", "candidates_token_count",
                "thoughts_token_count", "total_token_count")
HEARTBEAT_PREFIX = "@mmo-heartbeat "


async def maybe(v):
    # ChatResponse methods may be sync or awaitable across SDK versions.
    return await v if inspect.isawaitable(v) else v


def _value(x) -> str:
    """An SDK enum member by its string value (StepType.TOOL_CALL → "TOOL_CALL"); anything else as ""."""
    v = getattr(x, "value", x)
    return v if isinstance(v, str) else ""


def http_code(step) -> int:
    try:
        return int(getattr(step, "http_code", 0) or 0)
    except (TypeError, ValueError):
        return 0


def usage_dict(u) -> dict:
    """A usage reading (the SDK's UsageMetadata, a dict, or nothing) as the SDK's field names, zeros for unknown."""
    out = {f: 0 for f in USAGE_FIELDS}
    out["service_tier"] = None
    if u is None:
        return out
    for f in USAGE_FIELDS:
        v = u.get(f) if isinstance(u, dict) else getattr(u, f, None)
        try:
            out[f] = int(v or 0)
        except (TypeError, ValueError):
            out[f] = 0
    tier = u.get("service_tier") if isinstance(u, dict) else getattr(u, "service_tier", None)
    out["service_tier"] = _value(tier) or None
    return out


def usage_minus(a: dict, b: dict) -> dict:
    out = {f: max(0, int(a.get(f) or 0) - int(b.get(f) or 0)) for f in USAGE_FIELDS}
    out["service_tier"] = a.get("service_tier")
    return out


def billed(by_location) -> dict:
    """The token counts of a usage-by-location reading, leaving out a location with nothing billed yet (a try just
    begun): what a heartbeat must carry."""
    out = {}
    for loc, u in (by_location or {}).items():
        counts = tuple(int((u or {}).get(f) or 0) for f in USAGE_FIELDS)
        if any(counts):
            out[loc] = counts
    return out


def usage_sum(items) -> dict:
    out = {f: 0 for f in USAGE_FIELDS}
    out["service_tier"] = None
    for u in items:
        for f in USAGE_FIELDS:
            out[f] += int((u or {}).get(f) or 0)
        out["service_tier"] = (u or {}).get("service_tier") or out["service_tier"]
    return out


def write_json_atomic(path: str, obj: dict) -> None:
    """Another process reads it: the file is whole or absent, never cut."""
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, default=str)
    os.replace(tmp, path)


def keep_loopback_off_proxy(environ=os.environ) -> None:
    """The SDK talks to its own harness over a localhost websocket, which a proxy setting without NO_PROXY breaks."""
    hosts = []
    for key in ("NO_PROXY", "no_proxy"):
        for h in (environ.get(key) or "").split(","):
            if h.strip() and h.strip() not in hosts:
                hosts.append(h.strip())
    for h in ("localhost", "127.0.0.1"):
        if h not in hosts:
            hosts.append(h)
    environ["NO_PROXY"] = environ["no_proxy"] = ",".join(hosts)


def status_name(text: str) -> str:
    """Google's status name as the harness renders it ("Status: RESOURCE_EXHAUSTED"), for a reason a person reads."""
    m = re.search(r"Status: ([A-Z_]{3,})", text or "")
    return m.group(1) if m else ""


def error_text(e: BaseException) -> str:
    return f"{type(e).__name__}: {e}"


def step_status(end: TurnEnd):
    """Google's HTTP status from the last error step of a call that ended with an SDK error, or None."""
    return end.last_code if end.exc is not None and 100 <= end.last_code <= 599 else None


def outcome_error(end: TurnEnd, sup: Supervisor, model: str):
    """(error, error_type) of a call that ended without an answer, from its last try."""
    if end.kind == "stalled" and sup.unavailable:
        return f"Google could not serve {model}: {sup.unavailable}", "Stalled"
    if end.kind == "work_limit":
        return end.reason, "TimeoutError"
    if end.kind == "cancelled":
        return end.reason, "Stopped"
    if end.reason:  # a cut with its own reason (empty output)
        return end.reason, "EmptyOutput" if "empty output" in end.reason else "Stalled"
    if end.exc is not None:
        return error_text(end.exc), type(end.exc).__name__
    return "the call ended without an answer", "NoAnswer"


class Session:
    """An `async with Agent` held open across tries. Leaving it never raises: from 0.1.21 the SDK raises while leaving
    a session whose harness exited non-zero, after the call's answer and usage are already in hand."""

    def __init__(self, agent_cm):
        self.cm = agent_cm
        self.agent = None

    async def open(self):
        self.agent = await self.cm.__aenter__()
        return self.agent

    async def close(self):
        """None, or the teardown error's text."""
        try:
            await self.cm.__aexit__(None, None, None)
            return None
        except BaseException as e:  # BaseException: the SDK's own errors include a CancelledError subclass
            if isinstance(e, (KeyboardInterrupt, SystemExit)):
                raise
            return error_text(e)


class Clock:
    """The worker's clocks. `monotonic` leaves out the computer's sleep on macOS; `asleep` says how much it left out."""

    def monotonic(self) -> float:
        return time.monotonic()

    def wall(self) -> float:
        return time.time()

    def asleep(self):
        # macOS: CLOCK_MONOTONIC counts sleep, CLOCK_UPTIME_RAW does not, so their gap grows by the time asleep.
        up = getattr(time, "CLOCK_UPTIME_RAW", None)
        mono = getattr(time, "CLOCK_MONOTONIC", None)
        if sys.platform != "darwin" or up is None or mono is None:
            return None
        return time.clock_gettime(mono) - time.clock_gettime(up)


def iso_wall(wall: float) -> str:
    """A wall-clock time as the receipts write it: UTC, to the millisecond."""
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(wall)) + f".{int((wall % 1) * 1000):03d}Z"


class Try:
    """One session (typist door), or one segment of a session (agent door)."""

    def __init__(self, location: str, start: float, wall: float, origin: float):
        self.location = location
        self.start = start
        self.end = None
        self.started_at = iso_wall(wall)
        self.origin = origin
        self.ended_by = None
        self.reason = None
        self.slept = False
        self.http_codes = []
        self.usage = usage_dict(None)
        self.usage_base = usage_dict(None)
        self.usage_error = None

    def record(self) -> dict:
        end = self.end if self.end is not None else self.start
        rec = {
            "location": self.location, "ended_by": self.ended_by, "http_codes": list(self.http_codes),
            "s": round(end - self.start, 3), "start_s": round(self.start - self.origin, 3),
            "end_s": round(end - self.origin, 3), "started_at": self.started_at,
            "usage": dict(self.usage), "served_tier": self.usage.get("service_tier"),
        }
        if self.reason:
            rec["reason"] = self.reason
        return rec


class TurnEnd:
    """How one turn ended. `kind` becomes the try's ended_by."""

    def __init__(self):
        self.kind = None
        self.reason = None
        self.exc = None
        self.resp = None
        self.last_code = 0
        self.last_error_text = ""
        self.slept = False
        self.interrupted = False
        self.cut_while_text = False
        self.tool_ran = False
        # When the turn's last model call was first sent (the supervisor's clock), or None when none was: the call a
        # refusal or a stall belongs to began then, not when the session did.
        self.call_start = None


class Plan:
    """What follows a try: the location, the session ("fresh", "same" or "resume"), the message ("task" or
    "continue"), a wait before it, and the next try's stall limit."""

    def __init__(self, index: int, session: str, message: str, wait: float, limit: float):
        self.index, self.session, self.message, self.wait, self.limit = index, session, message, wait, limit


class _Trajectory:
    """One trajectory's state: a request out with nothing back (wait), streaming (stream), a tool running (tool), or
    answered (done). `retry_wait_s`: how long the harness may wait before its next retry, after a refused request."""

    def __init__(self, now: float):
        self.state = "wait"
        self.quiet_since = now
        self.request_start = now
        # When the model call in hand was first sent: kept across the harness's own retries of it (request_start is
        # each retry's), so a refusal's budget and an unserved stretch start with the call.
        self.call_sent = now
        self.prev = None
        self.text_in_request = False
        self.retry_wait_s = 0.0


class Supervisor:
    def __init__(self, *, model: str, locations, stall_sec: float, stall_tries: int, busy_budget_s: float,
                 heartbeat_s: float, timeout_s: float, work_limit_reason: str, sdk_version: str = "unknown",
                 retry_initial_s: float = None, clock: Clock = None, stream=None, watch_stdin: bool = False,
                 term_grace_s: float = 10.0):
        self.model = model
        # --watch-stdin: this worker's stdin is a pipe the engine holds open, so its end is the engine's (_watch_engine).
        self.watch_stdin = watch_stdin
        self.term_grace_s = float(term_grace_s)
        # The harness's own retry of a refused request (ModelAPIRetryConfig, multiplier 2): its first wait, or None
        # when the SDK's unstated default applies.
        self.retry_initial_s = retry_initial_s
        self.work_limit_reason = work_limit_reason
        self.locations = []
        for loc in locations:
            if loc and loc not in self.locations:
                self.locations.append(loc)
        self.stall_sec = float(stall_sec)
        self.stall_tries = max(1, int(stall_tries))
        self.busy_budget_s = float(busy_budget_s)
        self.heartbeat_s = float(heartbeat_s)
        self.timeout_s = float(timeout_s)
        self.sdk_version = sdk_version
        self.clock = clock or Clock()
        self.stream = stream
        self.origin = self.clock.monotonic()
        self.asleep0 = self.clock.asleep()
        self.excluded = 0.0
        self.call_excluded = 0.0
        self.pending_since = None
        self.tries = []
        self.current = None
        self.state = "startup"
        self.stall_cuts = 0
        self.failovers = 0
        self.cut_calls = 0
        self.call_stalls = 0
        self.first_refusal = None
        self.refusal_rounds = 0
        # When the current stretch of unserved calls began (the first refused or held call since the last answered
        # one), on the supervisor's clock and the wall's; across a thinking step's carry-ons too (carry_on).
        self.unserved_since = None
        self.unserved_since_wall = None
        self.dropped = set()
        self.unavailable = None
        self.stopped = False
        self._stop = None
        self._beat_task = None
        self._beat_at = None
        self._beat_usage = None
        self._watch = None
        self._conv = None

    # ─── time ───────────────────────────────────────────────────────────────────────────────────────────────

    def now(self) -> float:
        return self.clock.monotonic()

    def _not_yet_work(self, now: float) -> float:
        """Time not counted as work until it is known what it was: the wait between tries, and the silence of a
        request still out (a call that answers counts in full; one cut as a stall counts not at all)."""
        out = now - self.pending_since if self.pending_since is not None else 0.0
        if self._watch is not None:
            out += self._watch.silence(now)
        return out

    def work_s(self, now: float = None) -> float:
        now = self.now() if now is None else now
        return max(0.0, now - self.origin - self.excluded - self._not_yet_work(now))

    def slept_s(self):
        a = self.clock.asleep()
        return None if a is None or self.asleep0 is None else max(0.0, a - self.asleep0)

    def exclude(self, seconds: float) -> None:
        if seconds > 0:
            self.excluded += seconds
            self.call_excluded += seconds

    def call_answered(self) -> None:
        """The model call in hand has its whole answer: the next call starts with fresh stall tries and busy budget."""
        self.call_stalls = 0
        self.first_refusal = None
        self.refusal_rounds = 0
        self.call_excluded = 0.0
        self.unserved_since = None
        self.unserved_since_wall = None

    def _unserved_from(self, end: "TurnEnd", now: float) -> float:
        """When the call `end` ended belongs to began: its request's send time, else the try's start."""
        if end.call_start is not None:
            return end.call_start
        return self.current.start if self.current is not None else now

    def _stretch_from(self, start: float, now: float) -> None:
        if self.unserved_since is None:
            self.unserved_since = start
            self.unserved_since_wall = self.clock.wall() - (now - start)

    def unserved_for(self) -> float:
        """How long the current stretch of unserved calls has lasted; 0 when the last call was answered."""
        return 0.0 if self.unserved_since is None else self.now() - self.unserved_since

    def carry_on(self) -> None:
        """After an unavailable call, before a thinking step sends it again (thinking_worker.py): a new call, with its
        own stall tries and busy budget. The stretch of unserved calls since the last answered one goes on."""
        self.unavailable = None
        self.call_stalls = 0
        self.first_refusal = None
        self.refusal_rounds = 0
        self.call_excluded = 0.0

    def recovering(self) -> None:
        """Until the next request is sent, the time is not the session's work."""
        if self.pending_since is None:
            self.pending_since = self.now()
        self.state = "recovering"

    # ─── the stop signal and the heartbeat ──────────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Called inside the event loop."""
        self._stop = asyncio.Event()
        try:
            asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, self.request_stop)
        except (NotImplementedError, RuntimeError, ValueError):  # a loop without signal handlers
            pass
        self._beat_task = asyncio.ensure_future(self._beat())
        if self.watch_stdin:
            threading.Thread(target=self._watch_engine, name="engine-pipe", daemon=True).start()

    def _watch_engine(self) -> None:
        """Waits, off the event loop, for the engine's end of this worker's stdin to close: the engine is gone however
        it ended (a SIGKILL included), and nothing would stop this worker, so it stops itself as the engine's kill rule
        stops it (src/executor/stall.ts watchWorker): SIGTERM to its process group, which this worker answers by ending
        its call and writing its receipt, and its tools and the SDK's harness end with it; then SIGKILL term_grace_s
        later if it still runs, which a worker whose event loop is blocked needs. A group this worker does not lead is
        never signalled: then the signals are its own."""
        try:
            os.set_blocking(0, True)
            while os.read(0, 65536):
                pass
        except OSError:  # no stdin to read: there is no engine's end to wait for
            pass
        lead = os.getpgrp() == os.getpid()

        def send(sig) -> None:
            try:
                if lead:
                    os.killpg(os.getpid(), sig)
                else:
                    os.kill(os.getpid(), sig)
            except OSError:
                pass

        send(signal.SIGTERM)
        time.sleep(self.term_grace_s)
        send(signal.SIGKILL)

    def request_stop(self) -> None:
        self.stopped = True
        if self._stop is not None:
            self._stop.set()

    async def close(self) -> None:
        if self._beat_task is not None:
            self._beat_task.cancel()
            await asyncio.wait({self._beat_task}, timeout=1.0)
            self._beat_task = None

    async def _beat(self) -> None:
        # One as the worker starts, then every heartbeat_s, and within BEAT_POLL_S of a change of the billed usage (an
        # answered request), never two within BEAT_MIN_GAP_S: a worker that is stopped or frozen right after a billed
        # call has already told the engine what that call cost.
        self.heartbeat()
        while True:
            await asyncio.sleep(min(BEAT_POLL_S, self.heartbeat_s))
            now = self.now()
            usage = self.usage_by_location()
            if now - self._beat_at >= self.heartbeat_s or (
                    billed(usage) != billed(self._beat_usage) and now - self._beat_at >= BEAT_MIN_GAP_S):
                self.heartbeat(usage)

    def _live_usage(self, t: Try) -> dict:
        if t is self.current and self._conv is not None:
            try:
                return usage_minus(usage_dict(getattr(self._conv, "total_usage", None)), t.usage_base)
            except Exception:  # an unreadable usage: the try's last known reading
                return t.usage
        return t.usage

    def usage_by_location(self) -> dict:
        out = {}
        for t in self.tries:
            out[t.location] = usage_sum([out.get(t.location), self._live_usage(t)])
        return out

    def heartbeat(self, usage: dict = None) -> None:
        now = self.now()
        usage = self.usage_by_location() if usage is None else usage
        self._beat_at, self._beat_usage = now, usage
        slept = self.slept_s()
        hb = {
            "v": 1, "state": self.state, "work_s": round(self.work_s(now), 1), "wait_s": round(self.excluded, 1),
            "call_wait_s": round(self.call_excluded + self._not_yet_work(now), 1),
            "slept_s": None if slept is None else round(slept, 1),
            "try": len(self.tries) or 1,
            "location": self.current.location if self.current else (self.locations[0] if self.locations else None),
            "usage": {k: {f: v.get(f) for f in USAGE_FIELDS} for k, v in usage.items()},
            "sdk_version": self.sdk_version,
        }
        stream = self.stream or sys.stderr
        try:
            stream.write(HEARTBEAT_PREFIX + json.dumps(hb, separators=(",", ":")) + "\n")
            stream.flush()
        except Exception:  # a closed stderr never stops the call
            pass

    async def wait(self, seconds: float) -> None:
        """A wait between tries, which a stop ends at once."""
        if seconds <= 0 or self._stop is None:
            return
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    # ─── tries and turns ────────────────────────────────────────────────────────────────────────────────────

    def begin_try(self, location: str) -> Try:
        t = Try(location, self.now(), self.clock.wall(), self.origin)
        self.tries.append(t)
        self.current = t
        return t

    def end_try(self, t: Try, end: TurnEnd, conv) -> None:
        t.end = self.now()
        t.ended_by = end.kind
        t.reason = end.reason
        t.slept = end.slept
        if conv is not None:
            try:
                t.usage = usage_minus(usage_dict(getattr(conv, "total_usage", None)), t.usage_base)
            except Exception as e:  # the receipt says the usage could not be read
                t.usage_error = error_text(e)
        self._conv = None

    async def run_turn(self, agent, message, t: Try, *, limit_s: float, collect=None) -> TurnEnd:
        """Sends `message` in `agent`'s session, then watches the turn until it ends, is cut, or the worker is stopped.

        `collect`, when given, sees every new step (the agent door keeps the tool calls the session made)."""
        end = TurnEnd()
        conv = getattr(agent, "conversation", None)
        self._conv = conv
        try:
            t.usage_base = usage_dict(getattr(conv, "total_usage", None))
        except Exception:  # no readable usage: zeros
            t.usage_base = usage_dict(None)
        watch = _Watch(self, conv, limit_s, collect)
        if self.stopped:
            end.kind, end.reason = "cancelled", "the worker was stopped before the call was sent"
            return end
        try:
            resp = await maybe(agent.chat(message))
        except BaseException as e:  # BaseException: the SDK's own cancellation error is one
            if isinstance(e, (KeyboardInterrupt, SystemExit)):
                raise
            end.exc = e
            watch.scan(self.now())
            watch.finish(end, t)
            end.kind = watch.classify(end)
            return end
        sent = self.now()
        if self.pending_since is not None:
            self.exclude(sent - self.pending_since)
            self.pending_since = None
        watch.sent(sent)
        self._watch = watch
        self.state = "wait"
        end.resp = resp
        task = asyncio.ensure_future(maybe(resp.resolve()))
        stop_wait = asyncio.ensure_future(self._stop.wait()) if self._stop is not None else None
        cut = None
        cut_at = 0.0
        try:
            while True:
                waiting = {task}
                if stop_wait is not None and not stop_wait.done():
                    waiting.add(stop_wait)
                await asyncio.wait(waiting, timeout=POLL_S, return_when=asyncio.FIRST_COMPLETED)
                now = self.now()
                watch.scan(now)
                if task.done():
                    break
                if cut is None:
                    cut = watch.check(now)
                    if cut is not None:
                        cut_at = now
                        watch.cut(cut, now, end)
                        try:
                            await maybe(resp.cancel())
                        except BaseException as e:  # a failing cancel() never ends the worker
                            if isinstance(e, (KeyboardInterrupt, SystemExit)):
                                raise
                elif now - cut_at > (STOP_GRACE_S if cut[0] == "cancelled" else CANCEL_GRACE_S):
                    # The SDK did not end the cancelled turn: stop waiting for it.
                    task.cancel()
                    await asyncio.wait({task}, timeout=1.0)
                    break
        finally:
            if stop_wait is not None:
                stop_wait.cancel()
            self._watch = None
        if task.done():
            if task.cancelled():
                end.exc = asyncio.CancelledError()
            elif task.exception() is not None:
                end.exc = task.exception()
        watch.scan(self.now())
        watch.finish(end, t)
        if cut is not None:
            end.kind, end.reason = cut
        else:
            end.kind = watch.classify(end)
        return end

    # ─── what follows a try ─────────────────────────────────────────────────────────────────────────────────

    def next_location(self, i: int):
        """(index, wrapped): the next location after `i` that is not dropped, and whether the order went round; or
        None when every location is dropped."""
        n = len(self.locations)
        for step in range(1, n + 1):
            j = (i + step) % n
            if self.locations[j] not in self.dropped:
                return j, i + step >= n
        return None

    def limit(self) -> float:
        return self.stall_sec * (2 ** self.call_stalls)

    def decide(self, end: TurnEnd, i: int, *, tool_ran: bool):
        """After a try at location `i`: a Plan for the next try, or None when the call has ended. `tool_ran`: a tool
        has run in this session, so it is continued, or resumed, rather than replaced by a fresh one. A stall cut with
        cancel() leaves the session open, so it is continued as it is; an SDK error (a refusal, a 500, the network)
        ends the harness's connection with the turn, so the session's saved conversation is resumed in a new harness,
        at the next location or, with no other, at the same one."""
        now = self.now()
        failover = len(self.locations) > 1
        moved = "resume" if tool_ran else "fresh"
        message = "continue" if tool_ran else "task"
        if end.kind == "stalled":
            self.stall_cuts += 1
            if not end.slept:
                # A held call is unserved from when it was sent (busyLedger.ts); a sleep of the computer is not Google's.
                self._stretch_from(self._unserved_from(end, now), now)
                self.call_stalls += 1
                if self.call_stalls >= self.stall_tries:
                    self.unavailable = self.stalled_reason()
                    return None
            if tool_ran:
                return Plan(i, "same", "continue", 0.0, self.limit())
            if failover and not end.slept:
                nxt = self.next_location(i)
                if nxt is not None and nxt[0] != i:
                    self.failovers += 1
                    return Plan(nxt[0], "fresh", "task", 0.0, self.limit())
            return Plan(i, "fresh", "task", 0.0, self.limit())
        if end.kind in ("refused", "network"):
            if self.first_refusal is None:
                # The budget is the call's: counted from when the refused request was sent, not from the session's
                # start, which a thinking step or an agent packet reaches many answered calls earlier (review: a call
                # refused late in a long session was given none of its budget and tried at no other location).
                self.first_refusal = self._unserved_from(end, now)
            self._stretch_from(self.first_refusal, now)
            left = self.busy_budget_s - (now - self.first_refusal)
            if not failover:
                # The harness waited out every busy answer itself, except a 500, which it never retries.
                if end.last_code == 500 and left > 0:
                    wait = min(left, self.backoff(self.refusal_rounds))
                    self.refusal_rounds += 1
                    return Plan(i, moved, message, wait, self.limit())
                self.unavailable = self.refused_reason(end)
                return None
            nxt = self.next_location(i) if left > 0 else None
            if nxt is None:
                self.unavailable = self.refused_reason(end)
                return None
            j, wrapped = nxt
            wait = 0.0
            if wrapped:
                wait = min(left, self.backoff(self.refusal_rounds))
                self.refusal_rounds += 1
            if j != i:
                self.failovers += 1
            return Plan(j, moved, message, wait, self.limit())
        if end.kind == "error" and end.last_code in NOT_SERVED_CODES and failover:
            # This location does not serve the model, or refuses the request: the call goes on at the others.
            self.dropped.add(self.locations[i])
            nxt = self.next_location(i)
            if nxt is None or nxt[0] == i:
                return None
            self.failovers += 1
            return Plan(nxt[0], moved, message, 0.0, self.limit())
        return None

    @staticmethod
    def backoff(k: int) -> float:
        return min(RETRY_CAP_S, RETRY_BASE_S * (2 ** k))

    def retry_wait_after(self, refused: int) -> float:
        """The harness's wait before its next retry once `refused` requests of the try were refused (its first wait
        doubled `refused` times), or 0 when its retry settings are not known."""
        return self.retry_initial_s * (2 ** refused) if self.retry_initial_s else 0.0

    def _where(self, tries) -> str:
        locs = []
        for t in tries:
            if t.location not in locs:
                locs.append(t.location)
        return ", ".join(locs) or (self.locations[0] if self.locations else "?")

    def refused_reason(self, end: TurnEnd) -> str:
        refused = [t for t in self.tries if t.ended_by in ("refused", "network")]
        requests = sum(len([c for c in t.http_codes if c in BUSY_CODES or c == NETWORK_CODE]) for t in refused) or len(refused)
        span = round(((refused[-1].end or self.now()) - refused[0].start) if refused else 0)
        if end.last_code == NETWORK_CODE:
            return f"network: no connection to Google at {self._where(refused)} ({requests} tries over {span} s)"
        name = status_name(end.last_error_text)
        return f"refused at {self._where(refused)} ({requests} requests over {span} s; last HTTP {end.last_code}{(' ' + name) if name else ''})"

    def stalled_reason(self) -> str:
        held = [t for t in self.tries if t.ended_by == "stalled" and not t.slept]
        times = ", ".join(f"{round((t.end or t.start) - t.start)} s" for t in held)
        n = len(held)
        how_often = {1: "once", 2: "twice"}.get(n, f"{n} times")
        return f"stalled at {self._where(held)}: accepted the call {how_often} and sent nothing back ({times})"

    def receipt_fields(self) -> dict:
        now = self.now()
        out = {
            "usage": usage_sum(t.usage for t in self.tries),
            "tries": [t.record() for t in self.tries],
            "stall_cuts": self.stall_cuts, "failovers": self.failovers, "cut_calls": self.cut_calls,
            "google_wait_s": round(self.excluded + self._not_yet_work(now), 3), "work_s": round(self.work_s(now), 3),
            "served_tier": self.tries[-1].usage.get("service_tier") if self.tries else None,
        }
        if self.unavailable:
            out["unavailable"] = self.unavailable
            if self.unserved_since_wall is not None:
                out["unserved_since"] = iso_wall(self.unserved_since_wall)
        slept = self.slept_s()
        if slept is not None:
            out["slept_s"] = round(slept, 1)
        unread = [t.usage_error for t in self.tries if t.usage_error]
        if unread:
            out["usage_error"] = unread[-1]
        return out


class _Watch:
    """One turn, read from the session's step history as it arrives."""

    def __init__(self, sup: Supervisor, conv, limit_s: float, collect):
        self.sup = sup
        self.conv = conv
        self.limit_s = limit_s
        self.collect = collect
        self.main = None
        self.main_tid = None
        self.subs = {}
        self.codes = []
        self.last_code = 0
        self.last_error_text = ""
        self.refused_steps = 0
        self.empty_run = 0
        self.interrupted = False
        self.tool_ran = False
        self.slept_mark = sup.clock.asleep()
        hist = self._history()
        # A resumed conversation's history is seeded with its earlier steps: only what arrives from now on is new.
        self.last = hist[-1] if hist else None

    def _history(self):
        try:
            h = getattr(self.conv, "history", None)
            # The SDK's history is a new list on every read (it is read every POLL_S): used as it is, not copied again.
            return h if isinstance(h, list) else list(h or [])
        except Exception:  # an SDK without a readable history: nothing to watch
            return []

    def sent(self, now: float) -> None:
        self.main = _Trajectory(now)

    def silence(self, now: float) -> float:
        m = self.main
        return now - m.quiet_since if m is not None and m.state in ("wait", "stream") else 0.0

    def _trajectory(self, step, now: float) -> _Trajectory:
        tid = getattr(step, "trajectory_id", "") or ""
        if self.main is None:
            self.main = _Trajectory(now)
        if self.main_tid is None and tid:
            self.main_tid = tid
        if not tid or tid == self.main_tid:
            return self.main
        if tid not in self.subs:
            self.subs[tid] = _Trajectory(now)
        return self.subs[tid]

    def scan(self, now: float) -> None:
        # New steps are found by identity from the end: the SDK trims its history from the front past its cap, so an
        # index would drift. A last step no longer there was trimmed, and then every step there is new.
        hist = self._history()
        new = []
        for s in reversed(hist):
            if s is self.last:
                break
            new.append(s)
        if hist:
            self.last = hist[-1]
        for s in reversed(new):
            self._step(s, now)

    def _step(self, s, now: float) -> None:
        tr = self._trajectory(s, now)
        src, typ, st = _value(getattr(s, "source", "")), _value(getattr(s, "type", "")), _value(getattr(s, "status", ""))
        to_user = _value(getattr(s, "target", "")) == "TARGET_USER"
        text = getattr(s, "content", "") or ""
        if self.collect is not None:
            self.collect(s)
        if src == "SYSTEM" and st == "ERROR":
            code = http_code(s)
            refused = code in BUSY_CODES or code == NETWORK_CODE
            if code > 0:
                self.codes.append(code)
                self.last_code = code
                self.last_error_text = str(getattr(s, "error", "") or text)
                prev = tr.prev
                # An error straight after answer text: the harness continues that answer, and text() joins both.
                if prev is not None and _value(getattr(prev, "source", "")) == "MODEL" \
                        and _value(getattr(prev, "type", "")) == "TEXT_RESPONSE" \
                        and _value(getattr(prev, "target", "")) == "TARGET_USER" and (getattr(prev, "content", "") or ""):
                    self.interrupted = True
                if refused:
                    # A refused request, from its send to the step the harness emits as it sends its retry.
                    self.sup.exclude(now - tr.request_start)
                    self.refused_steps += 1
            else:
                self.empty_run += 1
            tr.state, tr.request_start, tr.quiet_since, tr.text_in_request = "wait", now, now, False
            # The harness emits a refusal's step as it sends its next try, once it has waited the refusal out; a refusal
            # of that try is waited out twice as long. So the silence until the next step may be that wait, and only
            # silence beyond it is Google holding the call.
            tr.retry_wait_s = self.sup.retry_wait_after(self.refused_steps) if refused else 0.0
        elif src == "MODEL":
            self.empty_run = 0
            tr.quiet_since = now
            tr.retry_wait_s = 0.0
            if typ == "TOOL_CALL":
                self.tool_ran = True
                calls = getattr(s, "tool_calls", None) or []
                finish = bool(calls) and all(getattr(c, "name", "") == "finish" for c in calls)
                if st == "ACTIVE":
                    if tr.state != "tool":
                        self._answered(tr)
                    tr.state = "tool"
                elif finish:
                    tr.state = "done"
                else:
                    if tr is self.main:
                        # The main trajectory's tool ended: the sub-agents it was running are done.
                        self.subs = {}
                    tr.state, tr.request_start, tr.call_sent, tr.text_in_request = "wait", now, now, False
            elif typ == "TEXT_RESPONSE" and st == "DONE" and text and (to_user or tr is not self.main):
                # The main trajectory's final text goes to the user; a sub-agent's goes to the agent that ran it, whatever
                # its target. Either settles its trajectory, so a sub-agent that has answered never holds the stall check
                # while the main tool call runs on.
                tr.state = "done"
                self._answered(tr)
            else:
                if tr.state != "tool":
                    tr.state = "stream"
                if typ == "TEXT_RESPONSE" and to_user and text:
                    tr.text_in_request = True
        else:
            tr.quiet_since = now
        tr.prev = s
        if tr is self.main:
            self.sup.state = tr.state

    def _answered(self, tr: _Trajectory) -> None:
        if tr is self.main:
            self.sup.call_answered()
            self.limit_s = self.sup.stall_sec

    def in_flight(self):
        """The trajectories with a request out to Google: waiting on it, or streaming it."""
        return [t for t in [self.main, *self.subs.values()] if t is not None and t.state in ("wait", "stream")]

    def check(self, now: float):
        """A reason to cut the turn now, as (ended_by, reason), or None."""
        sup = self.sup
        if sup.stopped:
            return ("cancelled", "the worker was stopped before the call finished")
        flight = self.in_flight()
        slept = sup.clock.asleep()
        if slept is not None and self.slept_mark is not None:
            grew, self.slept_mark = slept - self.slept_mark, slept
            if grew >= SLEEP_CUT_S and flight:
                return ("stalled", f"the computer slept for {round(grew)} s while the call was out")
        if self.empty_run >= EMPTY_OUTPUT_CUT:
            return ("error", "the model returned empty output 3 times")
        for t in flight:
            if now - t.quiet_since >= self.limit_s + t.retry_wait_s:
                return ("stalled", f"nothing from Google for {round(now - t.quiet_since)} s")
        if sup.work_s(now) >= sup.timeout_s:
            return ("work_limit", sup.work_limit_reason)
        return None

    def cut(self, cut, now: float, end: TurnEnd) -> None:
        kind, reason = cut
        flight = self.in_flight()
        if kind == "stalled":
            # A call cut as a stall is not the session's work, from its send to the cut.
            self.sup.exclude(now - min(t.request_start for t in flight) if flight else 0.0)
            end.slept = reason.startswith("the computer slept")
        if flight and kind in ("stalled", "work_limit", "cancelled"):
            self.sup.cut_calls += 1
        end.cut_while_text = self.main is not None and self.main.state == "stream" and self.main.text_in_request
        # The cut call's state is settled: it is no longer a silence of unknown kind.
        if self.main is not None:
            self.main.state = "cut"
        for t in self.subs.values():
            t.state = "cut"

    def finish(self, end: TurnEnd, t: Try) -> None:
        t.http_codes.extend(self.codes)
        end.call_start = self.main.call_sent if self.main is not None else None
        end.last_code = self.last_code
        end.last_error_text = self.last_error_text
        end.interrupted = self.interrupted
        end.tool_ran = self.tool_ran

    def classify(self, end: TurnEnd) -> str:
        # Empty answers end the call as the model's error whether the SDK raised or the harness's own model-call
        # budget (the typist door's --max-model-calls) ended the turn quietly after them. That budget halts the turn
        # on its last empty answer without the error step the earlier ones had (0.1.22: three empty answers, two
        # steps, then the response's stop reason MAX_MODEL_CALLS_EXCEEDED), so that answer is counted too.
        empties = self.empty_run
        if empties and end.exc is None and _value(getattr(end.resp, "stop_reason", None)) == "MAX_MODEL_CALLS_EXCEEDED":
            empties += 1
        if empties >= EMPTY_OUTPUT_CUT:
            end.reason = "the model returned empty output 3 times"
            return "error"
        if end.exc is None:
            return "answer"
        if self.last_code in BUSY_CODES:
            return "refused"
        if self.last_code == NETWORK_CODE:
            return "network"
        return "error"
