"""typist_worker.py — the Antigravity SDK as a TYPIST: one call writes one file.

Launched by the executor's agent-door typist (src/executor/typists.ts), one
process per unit. Unlike gemini_worker.py (a full agent that explores, runs
commands and edits files), this worker is configured so the agent does nothing
but hand the file back:

  - the only enabled tool is FINISH, whose schema is the job's answer schema
    ({path, content} to write a file; {path, edits | content} to fix one);
  - a short custom system prompt, followed by the run's shared specification,
    replaces the SDK's default identity preamble;
  - sub-agents are off and the session is limited to --max-model-calls calls;
  - thinking is set by --thinking (the executor passes LOW).

The call runs under the call supervisor (agy_supervisor.py): each try is a
fresh one-call session with the identical brief, at the location the
supervisor picks; a call that receives nothing for --stall-sec is cut and sent
again, Google's status is read from the SDK's error steps, and a call whose
refusals or stalls use up its budget ends `unavailable`.

Contract:
  --brief-file PATH   the unit's framed brief (the user turn)
  --system-file PATH  the shared specification, appended to the system prompt
  --answer-schema-file PATH  the JSON schema the FINISH call must follow (default: {path, content})
  --model NAME        SDK model id (from the policy leaf)
  --region NAME       Vertex location; wins over GOOGLE_CLOUD_LOCATION
  --workdir PATH      an empty scratch directory (the agent needs one; it never writes there)
  --out PATH          the receipt this worker writes (JSON, see below)
  --thinking LEVEL    HIGH|MEDIUM|LOW|MINIMAL
  --max-model-calls N the session's model-call budget
  --timeout SECONDS   the session's own work time: calls Google held until they
                      were cut, refused requests and the waits between tries are
                      not counted
  --api-retries N     the SDK's own retries of transient API errors (429, 503), with
  --api-retry-initial-ms MS  its first wait; each later wait doubles. The executor passes its
                      transport rule (tools.ts TRANSPORT), or 1 retry after 1 s for a
                      leaf with failover_locations (no retry for the run-start probe's
                      call pinned to one of its locations). Unset: the SDK's unstated
                      defaults.
  --locations, --stall-sec, --stall-tries, --busy-budget-sec, --heartbeat-sec
                      the call supervisor's settings (agy_supervisor.py)

Receipt: {"finish_output", "text", "usage", "sdk", "sdk_version",
"vertex_project", "vertex_location", "thinking", "tool_calls" (names only),
"seconds", "error", "error_type", "error_status"}, plus the supervisor's keys
(agy_supervisor.py: "tries", "unavailable", "stall_cuts", "failovers",
"cut_calls", "google_wait_s", "work_s", "slept_s", "served_tier",
"teardown_error"). "error_status" is Google's HTTP status, read from the SDK's
error steps, else from a google.genai APIError the error carries (`.code`):
the executor reads a refused login (401, 403) and a busy vendor (429, 5xx)
from it, as on the other doors. Cost is NOT computed here: token counts are
recorded raw and priced by the executor with the policy leaf's rates, try by
try at each try's location, reading the usage by the SDK version recorded
here (AGY_USAGE_SEMANTICS).

"usage" is the sum of the tries' own usage (each try's session's
agent.conversation.total_usage), read whether the try answered, failed, was
cut or ran out of time, so a failed call is billed for what it spent. The
receipt is written before the SDK's teardown.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import google.antigravity as ag  # noqa: E402
from google.antigravity import types  # noqa: E402
from google.antigravity.hooks import policy  # noqa: E402

import agy_supervisor as sv  # noqa: E402

try:
    from importlib.metadata import version as _dist_version
    SDK_VERSION = _dist_version("google-antigravity")
except Exception:
    SDK_VERSION = "unknown"

SYSTEM = (
    "You write one source file of a software project from a specification. "
    "Answer by calling the finish tool once with the file's path and its complete content. "
    "Do not explore, read or run anything."
)
ANSWER_SCHEMA = {
    "type": "object",
    "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
    "required": ["path", "content"],
}


def _http_status(err):
    """The HTTP status a vendor SDK error carries, or None.

    Why: the executor classifies a failed call from the vendor's own fields,
    never from an error's words (executor/typists.ts). google.genai's
    APIError holds the status in `.code`; the SDK may raise another error that
    wraps it, so the chain of causes is followed. An error of any other class
    is not read, whatever attributes it has. The SDK's own error steps are
    read first (agy_supervisor.py); this is the second source.
    """
    try:
        from google.genai import errors as genai_errors
    except Exception:  # the SDK's errors module is not there: no status to read
        return None
    seen = set()
    e = err
    while e is not None and id(e) not in seen:
        seen.add(id(e))
        if isinstance(e, genai_errors.APIError):
            code = getattr(e, "code", None)
            if isinstance(code, int) and not isinstance(code, bool) and 100 <= code <= 599:
                return code
        e = e.__cause__ or e.__context__
    return None


class Typist:
    def __init__(self, a, sup: sv.Supervisor):
        self.a = a
        self.sup = sup
        self.out = {"finish_output": None, "text": "", "usage": None, "tool_calls": [], "error": None, "error_type": None}
        self.project = os.environ.get("GOOGLE_CLOUD_PROJECT")
        self.started = time.time()
        self.written = False
        self.location = sup.locations[0] if sup.locations else None

    def config(self, location: str, schema: dict, shared: str):
        a = self.a
        level = getattr(types.ThinkingLevel, a.thinking.upper(), None)
        options = types.GeminiModelOptions(thinking_level=level) if level else None
        return ag.LocalAgentConfig(
            model=types.ModelTarget(
                name=a.model, types=[types.ModelType.TEXT],
                endpoint=types.VertexEndpoint(project=self.project, location=location, options=options),
            ),
            vertex=True, project=self.project, location=location,
            system_instructions=types.CustomSystemInstructions(text=SYSTEM + ("\n\n" + shared if shared else "")),
            capabilities=types.CapabilitiesConfig(enable_subagents=False, enabled_tools=[types.BuiltinTools.FINISH]),
            response_schema=schema,
            budget_config=types.BudgetConfig(max_model_calls=a.max_model_calls),
            retry_config=(types.RetryConfig(api_retry=types.ModelAPIRetryConfig(
                max_retries=a.api_retries, initial_sleep_duration_ms=a.api_retry_initial_ms, exponential_multiplier=2.0))
                if a.api_retries is not None else None),
            policies=[policy.allow_all()],
            workspaces=[a.workdir],
            save_dir=os.path.join(a.workdir, "_save"),
        )

    def receipt(self) -> dict:
        r = dict(self.out)
        r.update(self.sup.receipt_fields())
        r.update({"vertex_project": self.project, "vertex_location": self.location, "sdk": "google-antigravity",
                  "sdk_version": SDK_VERSION, "thinking": self.a.thinking.upper(),
                  "seconds": round(time.time() - self.started, 1)})
        return r

    def write(self) -> None:
        sv.write_json_atomic(self.a.out, self.receipt())
        self.written = True

    async def answer_of(self, resp) -> None:
        try:
            self.out["text"] = await sv.maybe(resp.text())
        except Exception as e:  # never lose usage over a text error
            self.out["text"] = f"<text() error: {type(e).__name__}: {e}>"
        try:
            async for tc in resp.tool_calls:
                d = tc.model_dump(mode="json") if hasattr(tc, "model_dump") else dict(tc)
                self.out["tool_calls"].append(d.get("name"))
                if d.get("name") == "finish":
                    self.out["finish_output"] = (d.get("args") or {}).get("output_string")
        except Exception as e:  # the answer's tool calls could not be read: no answer, with the reason
            self.out["error"], self.out["error_type"] = sv.error_text(e), type(e).__name__

    def settle(self, end: sv.TurnEnd) -> None:
        """The call's outcome into the receipt, from its last try."""
        if end.kind == "answer":
            return
        self.out["error"], self.out["error_type"] = sv.outcome_error(end, self.sup, self.a.model)
        status = sv.step_status(end)
        if status is None and end.exc is not None:
            status = _http_status(end.exc)
        if status is not None:
            self.out["error_status"] = status

    async def run(self) -> None:
        a, sup = self.a, self.sup
        brief = open(a.brief_file, encoding="utf-8").read()
        shared = open(a.system_file, encoding="utf-8").read() if a.system_file else ""
        schema = json.load(open(a.answer_schema_file, encoding="utf-8")) if a.answer_schema_file else ANSWER_SCHEMA
        if not self.project or not sup.locations:
            self.out["error"] = "no Vertex project or location (set GOOGLE_CLOUD_PROJECT and a region)"
            return
        sv.keep_loopback_off_proxy()
        i, limit = 0, sup.stall_sec
        while True:
            location = sup.locations[i]
            self.location = location
            t = sup.begin_try(location)
            session = sv.Session(ag.Agent(self.config(location, schema, shared)))
            try:
                agent = await session.open()
            except BaseException as e:  # the harness did not start: the call ends here, with the reason
                if isinstance(e, (KeyboardInterrupt, SystemExit)):
                    raise
                end = sv.TurnEnd()
                end.kind, end.exc = "error", e
                sup.end_try(t, end, None)
                self.settle(end)
                status = _http_status(e)
                if status is not None:
                    self.out["error_status"] = status
                return
            end = await sup.run_turn(agent, brief, t, limit_s=limit)
            sup.end_try(t, end, getattr(agent, "conversation", None))
            plan = sup.decide(end, i, tool_ran=False)
            if plan is None:
                if end.kind == "answer":
                    await self.answer_of(end.resp)
                self.settle(end)
                # Written before the SDK's teardown: from 0.1.21 leaving the session can raise, after the answer.
                self.write()
            torn = await session.close()
            if torn:
                self.out["teardown_error"] = torn
                if plan is None:
                    self.write()
            if plan is None:
                return
            sup.recovering()
            await sup.wait(plan.wait)
            if sup.stopped:
                end = sv.TurnEnd()
                end.kind, end.reason = "cancelled", "the worker was stopped before the call finished"
                self.settle(end)
                return
            i, limit = plan.index, plan.limit


async def _main(a, sup: sv.Supervisor, typist: Typist) -> None:
    sup.start()
    try:
        await typist.run()
    finally:
        await sup.close()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--brief-file", required=True)
    p.add_argument("--system-file", default=None)
    p.add_argument("--answer-schema-file", default=None)
    p.add_argument("--model", required=True)
    p.add_argument("--region", default=None)
    p.add_argument("--workdir", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--thinking", default="LOW")
    p.add_argument("--max-model-calls", type=int, default=3)
    p.add_argument("--timeout", type=int, default=540)
    p.add_argument("--api-retries", type=int, default=None)
    p.add_argument("--api-retry-initial-ms", type=int, default=None)
    p.add_argument("--locations", default=None)
    p.add_argument("--stall-sec", type=int, default=300)
    p.add_argument("--stall-tries", type=int, default=2)
    p.add_argument("--busy-budget-sec", type=int, default=120)
    p.add_argument("--heartbeat-sec", type=int, default=10)
    a = p.parse_args()
    region = a.region or os.environ.get("GOOGLE_CLOUD_LOCATION")
    locations = [x.strip() for x in a.locations.split(",") if x.strip()] if a.locations else ([region] if region else [])
    sup = sv.Supervisor(
        model=a.model, locations=locations, stall_sec=a.stall_sec, stall_tries=a.stall_tries,
        busy_budget_s=a.busy_budget_sec, heartbeat_s=a.heartbeat_sec, timeout_s=a.timeout, sdk_version=SDK_VERSION,
        retry_initial_s=a.api_retry_initial_ms / 1000 if a.api_retries is not None and a.api_retry_initial_ms else None,
        work_limit_reason=f"the session did not finish within {a.timeout} s of work (time Google held or refused it excluded)",
    )
    typist = Typist(a, sup)
    try:
        asyncio.run(_main(a, sup, typist))
    except Exception as e:  # the receipt always gets written, with the reason
        if not typist.written:
            typist.out.update({"finish_output": None, "error": sv.error_text(e), "error_type": type(e).__name__})
            status = _http_status(e)
            if status is not None:
                typist.out["error_status"] = status
    if not typist.written:
        typist.write()


if __name__ == "__main__":
    main()
