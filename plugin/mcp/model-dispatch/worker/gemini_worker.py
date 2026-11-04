"""gemini_worker.py — one subprocess per delegated call, launched by the MCP
server's AntigravityWorkerAdapter. Runs Gemini as an AGENT via
`google-antigravity`: given a task and a working directory, explores the
directory, runs shell commands, and edits files itself.

Only the Gemini path is served; the SDK's Anthropic path returns tool results
as `assistant` messages, which the Anthropic API rejects with 400.

The session runs under the call supervisor (agy_supervisor.py). A model call
that receives nothing for --stall-sec, or that Google refuses, is recovered:
before any tool has run, by a fresh session with the identical task (at the
next location with --locations); after one, the same session is continued
with the harness's own words after a stall, and resumed (its saved
conversation, in a new harness) after a refusal or a 500, at the next location
or, with no other, at the same one: an SDK error closes the harness's
connection with the turn. No fresh session ever starts over a folder a tool
has changed. An answer the harness interrupted part-way and continued is not
passed off as an answer: text() would join both halves.

Contract:
  --task-file PATH   task description
  --model NAME       SDK model id (supplied by the policy leaf; no worker default)
  --region NAME      OPTIONAL Vertex location. When given it WINS over
                     GOOGLE_CLOUD_LOCATION (see LOCATION precedence below).
  --workdir PATH     the only directory the worker may act in
  --out-dir PATH     usage sidecar + SDK save dir
  --usage-file PATH  sidecar this worker WRITES, on every outcome (see _sidecar)
  --thinking LEVEL   HIGH|MEDIUM|LOW|NONE
  --timeout SECONDS  the session's own work time (default 540): calls Google
                     held until they were cut, refused requests and the waits
                     between tries are not counted
  --api-retries N, --api-retry-initial-ms MS   the harness's own retry of a
                     busy answer; unset, the SDK's unstated defaults
  --locations, --stall-sec, --stall-tries, --busy-budget-sec, --heartbeat-sec,
  --watch-stdin, --term-grace-sec
                     the call supervisor's settings (agy_supervisor.py)

stdout carries the reply, and only on success (exit 0); a failed session exits
1. Cost is NOT computed here. Token counts are recorded raw; dollars applied
by the server against the policy leaf's rates.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import google.antigravity as ag  # noqa: E402
from google.antigravity import types  # noqa: E402
from google.antigravity.hooks import policy  # noqa: E402

import agy_supervisor as sv  # noqa: E402

# SDK identity, recorded into every sidecar. Wrapped because the dist name
# can be absent in an editable install — degrade to "unknown", never fail
# the call over evidence.
try:
    from importlib.metadata import version as _dist_version
    SDK_VERSION = _dist_version("google-antigravity")
except Exception:
    SDK_VERSION = "unknown"
SDK_NAME = "google-antigravity"

# NO DEFAULTS for project or region. A default project silently bills someone
# else; a default region silently sends tokens to the wrong place.
#
# REGION PRECEDENCE: --region > GOOGLE_CLOUD_LOCATION > hard error. The flag
# outranks the env because the policy leaf declares the region and the
# manifest records it — if the env could win, the receipt and the actual call
# could disagree with no artifact contradicting either. Some models are served
# `global` only and return 404 elsewhere, so this matters concretely.
PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT")
LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION")

# Prior value of 50 was binding on live delegated calls (some sat exactly at 50
# with receipts reading as complete). The cap only bounds a runaway list.
TOOL_CALL_CAP = 1000

# Per-arg character ceiling. A create_file call carries an entire file body;
# what landed is on disk. The receipt needs the SHAPE (which tool, path,
# command), not the payload.
ARG_VALUE_CAP = 2000

INTERRUPTED = "the answer stream was interrupted part-way; its text cannot be trusted"


def _project_tool_call(tc):
    """One ToolCall reduced to what a reader needs.

    A bare `tool_call_count` cannot answer "which files did it touch" or
    "what commands did it run"; the projection can.

    Every arg value is stringified and clipped at ARG_VALUE_CAP so the
    consumer never has to type-switch and a file body can't blow up the
    receipt. `args_clipped` marks it, mirroring `tool_calls_truncated` at
    list level.
    """
    d = tc.model_dump(mode="json") if hasattr(tc, "model_dump") else dict(tc)
    args, clipped = {}, False
    for k, v in (d.get("args") or {}).items():
        s = v if isinstance(v, str) else json.dumps(v, default=str)
        if len(s) > ARG_VALUE_CAP:
            s, clipped = s[:ARG_VALUE_CAP], True
        args[k] = s
    return {
        "name": d.get("name"),
        "args": args,
        "canonical_path": d.get("canonical_path"),
        "args_clipped": clipped,
    }


def _thinking_level(name):
    name = (name or "NONE").upper()
    if name in ("", "NONE"):
        return None
    # getattr, not a module-level dict — referencing an unknown ThinkingLevel
    # member at import time would crash the whole worker.
    level = getattr(types.ThinkingLevel, name, None)
    if level is None:
        raise SystemExit(f"gemini_worker: unknown --thinking level {name!r}")
    return level


class ToolLog:
    """The session's tool calls, as the SDK's chunk stream yields them: once per call id (a call without one each
    time it appears), up to TOOL_CALL_CAP."""

    def __init__(self):
        self.calls = []
        self.ids = set()
        self.truncated = False

    def collect(self, step) -> None:
        for call in getattr(step, "tool_calls", None) or []:
            cid = getattr(call, "id", "") or ""
            if cid and cid in self.ids:
                continue
            if cid:
                self.ids.add(cid)
            if len(self.calls) >= TOOL_CALL_CAP:
                self.truncated = True
                return
            self.calls.append(call)


class AgentSession:
    def __init__(self, args, sup: sv.Supervisor, location0: str):
        self.args = args
        self.sup = sup
        self.tools = ToolLog()
        self.text = ""
        self.error = None
        self.error_type = None
        self.error_status = None
        self.teardown_error = None
        self.location = location0
        self.ok = False
        self.written = False
        # The SDK's own id of the conversation the session last ran: a caller that carries it on later (a thinking
        # step's revise) resumes this one, never another found by guessing.
        self.conversation_id = None
        self.save_dir = os.path.join(args.out_dir, "_gemini_worker_save")
        self.thinking = _thinking_level(args.thinking)

    def config(self, location: str, resume_id=None, extra=None):
        """The session's SDK configuration, built by LocalAgentConfig's constructor, which validates it (a pydantic
        model_copy(update=) would not). `extra`: more of its fields, for a worker with its own (the thinking worker's
        capabilities, tools and system instructions)."""
        a = self.args
        opts = types.GeminiModelOptions(thinking_level=self.thinking) if self.thinking else None
        fields = {}
        if a.api_retries is not None:
            fields["retry_config"] = types.RetryConfig(api_retry=types.ModelAPIRetryConfig(
                max_retries=a.api_retries, initial_sleep_duration_ms=a.api_retry_initial_ms, exponential_multiplier=2.0))
        if resume_id:
            # The conversation the harness saved, carried on at another location (its contents and thought signatures
            # included): settled on the fake endpoint before this was built.
            fields["conversation_id"] = resume_id
            fields["session_continuation_mode"] = types.SessionContinuationMode.RESUME
        return ag.LocalAgentConfig(
            model=types.ModelTarget(
                name=a.model, types=[types.ModelType.TEXT],
                endpoint=types.VertexEndpoint(project=PROJECT, location=location, options=opts),
            ),
            vertex=True, project=PROJECT, location=location,
            policies=[policy.allow_all()],
            workspaces=[a.workdir],
            save_dir=self.save_dir,
            **fields,
            **(extra or {}),
        )

    def sidecar(self) -> dict:
        # The location the session last ran at: the one it used, after any failover (each try's is in `tries`).
        location = self.location
        # cost_usd deliberately absent — priced by the server, never here.
        out = {
            "model": self.args.model,
            "thinking": (self.args.thinking or "NONE").upper(),
            "sdk": SDK_NAME,
            "sdk_version": SDK_VERSION,
            "vertex_project": PROJECT,
            "vertex_location": location,
            "tool_call_count": len(self.tools.calls),
            "tool_calls_truncated": self.tools.truncated,
            "tool_calls": [_project_tool_call(tc) for tc in self.tools.calls],
            "text": self.text,
        }
        out.update(self.sup.receipt_fields())
        if not self.ok:
            out.update({"error": self.error, "error_type": self.error_type})
            if self.error_status is not None:
                out["error_status"] = self.error_status
        if self.teardown_error:
            out["teardown_error"] = self.teardown_error
        return out

    def write(self) -> None:
        sv.write_json_atomic(self.args.usage_file, self.sidecar())
        self.written = True

    def fail(self, end: sv.TurnEnd, error=None, error_type=None) -> None:
        self.ok = False
        if error is None:
            error, error_type = sv.outcome_error(end, self.sup, self.args.model)
        self.error, self.error_type = error, error_type
        self.error_status = sv.step_status(end)

    async def run(self, task: str) -> None:
        sup = self.sup
        i, limit, message = 0, sup.stall_sec, task
        tool_ran = False
        session = None
        resume_id = None
        try:
            while True:
                location = sup.locations[i]
                self.location = location
                t = sup.begin_try(location)
                if session is None:
                    session = sv.Session(ag.Agent(self.config(location, resume_id)))
                    try:
                        await session.open()
                    except BaseException as e:  # the harness did not start: the dispatch fails with the reason
                        if isinstance(e, (KeyboardInterrupt, SystemExit)):
                            raise
                        end = sv.TurnEnd()
                        end.kind, end.exc = "error", e
                        sup.end_try(t, end, None)
                        session = None
                        self.fail(end)
                        return
                agent = session.agent
                end = await sup.run_turn(agent, message, t, limit_s=limit, collect=self.tools.collect)
                conv = getattr(agent, "conversation", None)
                self.conversation_id = getattr(conv, "conversation_id", None) or getattr(agent, "conversation_id", None) or self.conversation_id
                sup.end_try(t, end, conv)
                tool_ran = tool_ran or end.tool_ran
                plan = None
                if end.kind == "answer":
                    try:
                        self.text = await sv.maybe(end.resp.text())
                    except Exception as e:  # never lose usage over a text error
                        self.text = f"<worker text() error: {type(e).__name__}: {e}>"
                    if end.interrupted:
                        self.fail(end, INTERRUPTED, "Interrupted")
                    else:
                        self.ok = True
                elif end.kind == "stalled" and end.cut_while_text:
                    # Cut while it streamed answer text: a continued answer would be joined to the cut one.
                    sup.stall_cuts += 1
                    self.fail(end, INTERRUPTED, "Interrupted")
                else:
                    plan = sup.decide(end, i, tool_ran=tool_ran)
                    if plan is None:
                        self.fail(end)
                if plan is None:
                    # Written before the SDK's teardown: from 0.1.21 leaving the session can raise, after the answer.
                    self.write()
                    return
                if plan.session != "same":
                    resume_id = None
                    if plan.session == "resume":
                        resume_id = getattr(conv, "conversation_id", None) or getattr(agent, "conversation_id", None)
                    torn = await session.close()
                    session = None
                    if torn:
                        self.teardown_error = torn
                sup.recovering()
                await sup.wait(plan.wait)
                if sup.stopped:
                    stop = sv.TurnEnd()
                    stop.kind, stop.reason = "cancelled", "the worker was stopped before the call finished"
                    self.fail(stop)
                    return
                i, limit = plan.index, plan.limit
                message = task if plan.message == "task" else sv.CONTINUE_MESSAGE
        finally:
            if session is not None:
                torn = await session.close()
                if torn:
                    self.teardown_error = torn
                    if self.written:
                        self.write()


async def run(args) -> AgentSession:
    with open(args.task_file, encoding="utf-8") as f:
        task = f.read()

    # Bound ONCE and used for endpoint, agent config, and sidecar so region
    # in the call and region in the receipt cannot drift.
    location = args.region or LOCATION
    if not location:
        raise SystemExit(
            "gemini_worker: no Vertex region. Pass --region (the policy leaf's "
            "`region:`) or set GOOGLE_CLOUD_LOCATION. This worker pins no "
            "default because a wrong region is a silent billing and 404 hazard."
        )
    if not PROJECT:
        raise SystemExit(
            "gemini_worker: no Vertex project. Set GOOGLE_CLOUD_PROJECT to the "
            "project your application default credentials are authorised for. "
            "This worker pins no default because a wrong project bills the "
            "wrong account."
        )
    os.environ["GOOGLE_CLOUD_PROJECT"] = PROJECT
    os.environ["GOOGLE_CLOUD_LOCATION"] = location
    sv.keep_loopback_off_proxy()

    locations = [x.strip() for x in args.locations.split(",") if x.strip()] if args.locations else [location]
    sup = sv.Supervisor(
        model=args.model, locations=locations, stall_sec=args.stall_sec, stall_tries=args.stall_tries,
        busy_budget_s=args.busy_budget_sec, heartbeat_s=args.heartbeat_sec, timeout_s=args.timeout,
        sdk_version=SDK_VERSION, watch_stdin=args.watch_stdin, term_grace_s=args.term_grace_sec,
        retry_initial_s=args.api_retry_initial_ms / 1000 if args.api_retries is not None and args.api_retry_initial_ms else None,
        work_limit_reason=(f"the session's own work time reached the policy's limit (worker_timeout_sec): {args.timeout} s, "
                           "the time Google held or refused its calls not counted"),
    )
    s = AgentSession(args, sup, locations[0])
    sup.start()
    try:
        await s.run(task)
    finally:
        await sup.close()
        if not s.written:
            s.write()
    return s


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--task-file", required=True)
    p.add_argument("--model", required=True)
    # Optional; when passed it WINS over GOOGLE_CLOUD_LOCATION.
    p.add_argument("--region", default=None)
    p.add_argument("--workdir", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--usage-file", required=True)
    p.add_argument("--thinking", default="NONE")
    p.add_argument("--timeout", type=int, default=540)
    p.add_argument("--api-retries", type=int, default=None)
    p.add_argument("--api-retry-initial-ms", type=int, default=None)
    p.add_argument("--locations", default=None)
    p.add_argument("--stall-sec", type=int, default=300)
    p.add_argument("--stall-tries", type=int, default=2)
    p.add_argument("--busy-budget-sec", type=int, default=120)
    p.add_argument("--heartbeat-sec", type=int, default=10)
    # The engine holds this worker's stdin open; once it closes, the worker stops as the engine's kill rule would, its
    # SIGKILL --term-grace-sec after its SIGTERM (agy_supervisor.py).
    p.add_argument("--watch-stdin", action="store_true")
    p.add_argument("--term-grace-sec", type=float, default=10)
    args = p.parse_args()
    try:
        s = asyncio.run(run(args))
    except Exception as e:
        print(f"gemini_worker failed: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
    if not s.ok:
        print(f"gemini_worker failed: {s.error}", file=sys.stderr)
        sys.exit(1)
    print(s.text)  # caller reads the reply on stdout


if __name__ == "__main__":
    main()
