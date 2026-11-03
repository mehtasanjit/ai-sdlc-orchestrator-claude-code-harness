"""A scripted stand-in for the google-antigravity SDK, for the Python workers' tests (no harness, no Google).

It replays a script of what a model call sends back, on the real clock, the way google-antigravity 0.1.22 delivers
it from its harness: each step update is a new Step appended to `agent.conversation.history` as the turn's stream is
pulled (resolve(), text(), tool_calls), an error step carries Google's HTTP status in `http_code`, a held request
sends nothing until cancel(), cancel() makes the turn raise AntigravityCancelledError and keeps the session's usage
and its connection, a turn that ends with an SDK error closes the session's connection (as 0.1.22's harness does: a
chat() after it raises ConnectionClosedOK), and the history is trimmed from the front past its size cap. A step that
calls one of the worker's own tools (its configuration's `tools`, plain functions) runs it once per call id, as
0.1.22's ToolRunner runs one: a synchronous function in a worker thread (asyncio.to_thread), so the worker's event
loop and its heartbeat go on while a long tool runs, and an asynchronous one on the loop. It records what the worker
asked of it in a log: each session (Agent) with its location, project, retry settings and the proxy settings it saw,
each chat() with its message, each tool call as it starts and ends, each cancel(), and when start-up and teardown
began and ended.

Environment:
  AGY_STANDIN_SCRIPT  the JSON script below (a session that is not scripted answers nothing and ends at once)
  AGY_STANDIN_LOG     a JSONL file this stand-in appends one line to per thing it saw

Script:
  {"sessions": [SESSION, ...],                 the n-th Agent the worker opens gets the n-th (the last one repeats)
   "by_location": {"us": [SESSION, ...]},      instead, the n-th session at that location (falls back to "sessions")
   "max_history": 10000}                       the SDK's history size cap
  SESSION = {"aenter_delay": s,                start-up time before the session is ready
             "aexit": {"raise": NAME, "message": "..."} | {"block": s},   teardown raises, or blocks the event loop
             "no_conversation_id": true,       the session reports no conversation id (conversation_id is None)
             "turns": [TURN, ...]}             the n-th chat() of the session gets the n-th (the last one repeats)
  TURN = [EVENT, ...], each at `at` seconds after its chat():
    {"at": s, "step": {type, source, status, target, content, content_delta, thinking_delta, tool_calls, error,
                       http_code, is_complete_response, trajectory_id, step_index}}
    {"at": s, "usage": {prompt_token_count, ...}}   a billed model call: added to the session's total usage
    {"at": s, "raise": NAME, "message": "...", "code": n}   the turn raises (NAME is an SDK error, or "APIError")
    {"at": s, "end": true}                    the turn's stream ends (also after the last event); with
                                              "stop_reason": NAME, the response's stop_reason is that StopReason
    {"at": s, "hold": true}                   nothing more until cancel()
    {"at": s, "os_sleep": seconds}            the computer sleeps that long (sitecustomize.py moves its clocks)
    {"at": s, "freeze": true}                 the worker's process stops itself (SIGSTOP), as a frozen worker does

A session's "agent" log line also says how its configuration was built: `validated` (true when built by its
constructor, as the SDK's pydantic models are validated there; false for a model_copy), `capabilities` (the SDK's own
tools it leaves on), `tools` (the worker's own tools, by name), `system_instructions` (their text, or null) and
`thinking_level` (the model's, from its endpoint options, or null).
"""
from __future__ import annotations

import asyncio
import inspect
import json
import os
import signal
import time

from google.antigravity import types
from google.antigravity.types import _Config

try:  # the clocks before sitecustomize.py moved them, when it is loaded
    import _agy_standin_clock as _clock
except ImportError:  # pragma: no cover - only without the fixture's sitecustomize.py
    _clock = None


def _wall() -> float:
    return _clock.real_time() if _clock else time.time()


def _script() -> dict:
    path = os.environ.get("AGY_STANDIN_SCRIPT")
    if not path:
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def log(ev: str, **fields) -> None:
    """One line per thing the stand-in saw; flushed at once, so a killed worker's log is whole up to the kill."""
    path = os.environ.get("AGY_STANDIN_LOG")
    if not path:
        return
    line = json.dumps({"ev": ev, "wall": _wall(), "mono": time.monotonic(), "pid": os.getpid(), **fields}, default=str)
    with open(path, "a", encoding="utf-8") as f:
        f.write(line + "\n")
        f.flush()


class LocalAgentConfig(_Config):
    pass


class ConnectionClosedOK(Exception):
    """The websockets library's error for a send on a connection the harness closed normally."""


_SESSIONS = {"n": 0, "per_location": {}}


def _pick(seq: list, i: int):
    return seq[min(i, len(seq) - 1)] if seq else None


def _session_script(location: str) -> dict:
    script = _script()
    by_loc = (script.get("by_location") or {}).get(location)
    if by_loc:
        k = _SESSIONS["per_location"].get(location, 0)
        _SESSIONS["per_location"][location] = k + 1
        return _pick(by_loc, k) or {}
    return _pick(script.get("sessions") or [], _SESSIONS["n"] - 1) or {}


def _error(name: str, message: str, code: int | None = None) -> BaseException:
    if name == "APIError":
        from google.genai import errors
        return errors.APIError(code or 0, {"error": {"code": code, "message": message}})
    cls = getattr(types, name, None)
    if isinstance(cls, type) and issubclass(cls, BaseException):
        return cls(message)
    return RuntimeError(message)


def _attr(obj, name, default=None):
    return getattr(obj, name, default) if obj is not None else default


class Conversation:
    """The session's history, usage and current turn, with the SDK's public names."""

    def __init__(self, session: int, script: dict, tools=None):
        self._session = session
        self._script = script
        # The worker's own tools (its configuration's `tools`, plain functions), run when a step calls one by name.
        self._tools = {getattr(f, "__name__", ""): f for f in (tools or []) if callable(f)}
        self._ran = set()
        self._steps: list = []
        self._max = int(_script().get("max_history", 10_000))
        self._usage = types.UsageMetadata()
        self._turn_start_usage = None
        self._turns = 0
        self._cancel = asyncio.Event()
        self._turn_events: list = []
        self._idle = True
        # Set once a turn ended with an SDK error: the harness closed the session's websocket.
        self._closed = False
        # Why the last turn stopped, as ChatResponse.stop_reason reports it.
        self._last_turn_stop_reason = types.StopReason.UNSPECIFIED

    # --- what the SDK exposes -------------------------------------------------------------------------------
    @property
    def history(self) -> list:
        return list(self._steps)

    @property
    def total_usage(self):
        return self._usage.model_copy()

    @property
    def last_turn_usage(self):
        if self._turn_start_usage is None:
            return None
        diff = types.UsageMetadata(**{f: (getattr(self._usage, f) or 0) - (getattr(self._turn_start_usage, f) or 0)
                                      for f in types.UsageMetadata.FIELDS})
        diff.service_tier = self._usage.service_tier
        return diff

    @property
    def trajectory_usages(self) -> dict:
        return {"main": self._usage.model_copy()}

    @property
    def last_response(self) -> str:
        for s in reversed(self._steps):
            if s.is_complete_response:
                return s.content
        return ""

    @property
    def conversation_id(self) -> str | None:
        # A session scripted with "no_conversation_id" reports none, as an SDK that gives no id after a turn.
        return None if self._script.get("no_conversation_id") else f"standin-{self._session}"

    @property
    def is_idle(self) -> bool:
        return self._idle

    def get_last_structured_output(self):
        for s in reversed(self._steps):
            if s.type == types.StepType.FINISH:
                return s.structured_output
        return None

    async def cancel(self) -> None:
        log("cancel", session=self._session, turn=self._turns, in_flight=not self._idle)
        self._cancel.set()

    async def wait_for_idle(self) -> None:
        while not self._idle:
            await asyncio.sleep(0.05)

    async def chat(self, prompt=None, **_):
        if self._closed:
            log("chat_refused", session=self._session, message=prompt if isinstance(prompt, str) else repr(prompt))
            raise ConnectionClosedOK("received 1000 (OK); then sent 1000 (OK)")
        self._turns += 1
        self._last_turn_stop_reason = types.StopReason.UNSPECIFIED
        self._cancel = asyncio.Event()
        self._turn_start_usage = self._usage.model_copy()
        self._turn_events = _pick(self._script.get("turns") or [[]], self._turns - 1) or []
        self._idle = False
        log("chat", session=self._session, turn=self._turns, message=prompt if isinstance(prompt, str) else repr(prompt))
        return types.ChatResponse(self.receive_chunks(), conversation=self)

    async def receive_steps(self):
        """The turn's steps as they arrive, each appended to the history first (as the SDK does)."""
        t0 = time.monotonic()
        try:
            for ev in self._turn_events:
                wait = float(ev.get("at", 0)) - (time.monotonic() - t0)
                if ev.get("hold"):
                    wait = None
                if wait is None or wait > 0:
                    try:
                        await asyncio.wait_for(self._cancel.wait(), timeout=wait)
                    except asyncio.TimeoutError:
                        pass
                else:
                    # Each event arrives as its own turn of the event loop, as the harness's websocket messages do: a
                    # worker whose loop was busy then sees overdue events one by one, never as one burst.
                    await asyncio.sleep(0)
                if self._cancel.is_set():
                    raise types.AntigravityCancelledError()
                if "step" in ev:
                    step = types.Step(**ev["step"])
                    self._steps.append(step)
                    if self._max and len(self._steps) > self._max:
                        self._steps = self._steps[len(self._steps) - self._max:]
                    # A call of one of the worker's own tools runs it, once per call id, as the SDK's harness does:
                    # a synchronous tool in a worker thread, so the event loop goes on while it runs (0.1.22's
                    # ToolRunner._execute_fn: asyncio.to_thread); an asynchronous one on the loop.
                    for call in step.tool_calls:
                        fn = self._tools.get(call.name)
                        key = call.id or f"{call.name}#{len(self._steps)}"
                        if fn is not None and key not in self._ran:
                            self._ran.add(key)
                            log("tool_start", session=self._session, turn=self._turns, name=call.name)
                            if inspect.iscoroutinefunction(fn) or inspect.iscoroutinefunction(getattr(fn, "__call__", None)):
                                out = fn(**call.args)
                            else:
                                out = await asyncio.to_thread(fn, **call.args)
                            if asyncio.iscoroutine(out):
                                out = await out
                            log("tool_run", session=self._session, turn=self._turns, name=call.name, result=str(out)[:2000])
                    yield step
                if "usage" in ev:
                    self._usage = self._usage + types.UsageMetadata(**ev["usage"])
                    log("usage", session=self._session, turn=self._turns)
                if "os_sleep" in ev:
                    if _clock is None:
                        raise RuntimeError("the stand-in's sitecustomize.py is not loaded, so it cannot fake a sleep")
                    _clock.sleep(float(ev["os_sleep"]))
                    log("os_sleep", session=self._session, seconds=float(ev["os_sleep"]))
                if ev.get("freeze"):
                    log("freeze", session=self._session)
                    os.kill(os.getpid(), signal.SIGSTOP)
                if "raise" in ev:
                    log("raise", session=self._session, turn=self._turns, error=ev["raise"])
                    self._closed = True
                    raise _error(ev["raise"], ev.get("message", ""), ev.get("code"))
                if ev.get("end"):
                    if ev.get("stop_reason"):
                        self._last_turn_stop_reason = types.StopReason(ev["stop_reason"])
                    return
        finally:
            self._idle = True

    async def receive_chunks(self):
        seen = set()
        async for step in self.receive_steps():
            if step.source == types.StepSource.MODEL and step.target == types.StepTarget.USER and step.status != types.StepStatus.ERROR:
                if step.thinking_delta:
                    yield types.Thought(step_index=step.step_index, text=step.thinking_delta)
                if step.content_delta:
                    yield types.Text(step_index=step.step_index, text=step.content_delta)
            for call in step.tool_calls:
                if not call.id or call.id not in seen:
                    if call.id:
                        seen.add(call.id)
                    yield call


class Agent:
    """One session: each Agent is a fresh harness in the SDK, and a fresh scripted session here."""

    def __init__(self, config=None, *args, **kwargs):
        _SESSIONS["n"] += 1
        self._n = _SESSIONS["n"]
        cfg = config if config is not None else LocalAgentConfig(**kwargs)
        model = _attr(cfg, "model")
        endpoint = _attr(model, "endpoint")
        location = _attr(endpoint, "location") or _attr(cfg, "location")
        retry = _attr(_attr(cfg, "retry_config"), "api_retry")
        caps = _attr(cfg, "capabilities")
        system = _attr(cfg, "system_instructions")
        self._script = _session_script(str(location))
        log("agent", session=self._n, location=location, project=_attr(endpoint, "project") or _attr(cfg, "project"),
            model=_attr(model, "name"),
            # Whether the configuration was built by its constructor (validated), the SDK's own tools it leaves on, and
            # the worker's own tools by name.
            validated=getattr(cfg, "_validated", None),
            capabilities=None if caps is None else {"enable_subagents": _attr(caps, "enable_subagents"),
                                                    "enabled_tools": [getattr(t, "value", t) for t in _attr(caps, "enabled_tools") or []]},
            tools=[getattr(f, "__name__", str(f)) for f in _attr(cfg, "tools") or []],
            system_instructions=system if system is None or isinstance(system, str) else _attr(system, "text"),
            thinking_level=getattr(_attr(_attr(endpoint, "options"), "thinking_level"), "value", None),
            retry=None if retry is None else {k: _attr(retry, k) for k in ("max_retries", "initial_sleep_duration_ms", "exponential_multiplier", "jitter_range")},
            http_headers=_attr(endpoint, "http_headers"),
            continuation=str(_attr(cfg, "session_continuation_mode")) if _attr(cfg, "session_continuation_mode") is not None else None,
            conversation_id=_attr(cfg, "conversation_id"), save_dir=_attr(cfg, "save_dir"),
            no_proxy=os.environ.get("NO_PROXY"), no_proxy_lower=os.environ.get("no_proxy"),
            https_proxy=os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy"))
        self.conversation = Conversation(self._n, self._script, _attr(cfg, "tools"))

    async def __aenter__(self):
        log("aenter_start", session=self._n)
        await asyncio.sleep(float(self._script.get("aenter_delay", 0)))
        log("aenter_end", session=self._n)
        return self

    async def __aexit__(self, *exc):
        log("aexit_start", session=self._n, exc=None if not exc or exc[0] is None else exc[0].__name__)
        spec = self._script.get("aexit") or {}
        if spec.get("block"):
            time.sleep(float(spec["block"]))  # the event loop is blocked, as by the SDK's synchronous wait for its harness
        log("aexit_end", session=self._n)
        if spec.get("raise"):
            raise _error(spec["raise"], spec.get("message", ""))
        return False

    async def chat(self, prompt=None, **kwargs):
        return await self.conversation.chat(prompt, **kwargs)


__version__ = "0.1.22"
