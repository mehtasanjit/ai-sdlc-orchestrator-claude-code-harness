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
  --timeout SECONDS   hard cap on the whole session
  --api-retries N     the SDK's own retries of transient API errors (429, 503), with
  --api-retry-initial-ms MS  its first wait; each later wait doubles. The executor passes its
                      transport rule (tools.ts TRANSPORT), so a rate limit is a wait on this
                      door as on the others. Unset: the SDK's unstated defaults.

Receipt: {"finish_output", "text", "usage", "sdk", "sdk_version",
"vertex_project", "vertex_location", "thinking", "tool_calls" (names only),
"seconds", "error", "error_type"}. Cost is NOT computed here: token counts are
recorded raw and priced by the executor with the policy leaf's rates, reading
the usage totals by the SDK version recorded here (AGY_USAGE_SEMANTICS).

"usage" is the session's cumulative usage (agent.conversation.total_usage),
read after the turn whether it finished, failed or ran out of time, so a failed
call is billed for what it spent. For this worker's one-turn sessions it equals
the turn's own usage.
"""
from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import os
import time

import google.antigravity as ag
from google.antigravity import types
from google.antigravity.hooks import policy

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


async def _maybe(v):
    return await v if inspect.isawaitable(v) else v


async def run(a) -> dict:
    brief = open(a.brief_file, encoding="utf-8").read()
    shared = open(a.system_file, encoding="utf-8").read() if a.system_file else ""
    schema = json.load(open(a.answer_schema_file, encoding="utf-8")) if a.answer_schema_file else ANSWER_SCHEMA
    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    location = a.region or os.environ.get("GOOGLE_CLOUD_LOCATION")
    if not project or not location:
        return {"error": "no Vertex project or location (set GOOGLE_CLOUD_PROJECT and a region)"}
    level = getattr(types.ThinkingLevel, a.thinking.upper(), None)
    options = types.GeminiModelOptions(thinking_level=level) if level else None
    cfg = ag.LocalAgentConfig(
        model=types.ModelTarget(
            name=a.model, types=[types.ModelType.TEXT],
            endpoint=types.VertexEndpoint(project=project, location=location, options=options),
        ),
        vertex=True, project=project, location=location,
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
    out = {"finish_output": None, "text": "", "usage": None, "tool_calls": [], "error": None, "error_type": None}
    async with ag.Agent(cfg) as agent:
        try:
            resp = await _maybe(agent.chat(brief))
            await asyncio.wait_for(_maybe(resp.resolve()), timeout=a.timeout)
            try:
                out["text"] = await _maybe(resp.text())
            except Exception as e:  # never lose usage over a text error
                out["text"] = f"<text() error: {type(e).__name__}: {e}>"
            async for tc in resp.tool_calls:
                d = tc.model_dump(mode="json") if hasattr(tc, "model_dump") else dict(tc)
                out["tool_calls"].append(d.get("name"))
                if d.get("name") == "finish":
                    out["finish_output"] = (d.get("args") or {}).get("output_string")
        except asyncio.TimeoutError:
            out["error"], out["error_type"] = f"the session did not finish within {a.timeout} s", "TimeoutError"
        except Exception as e:  # recorded with its class; the executor counts it as an attempt
            out["error"], out["error_type"] = f"{type(e).__name__}: {e}", type(e).__name__
        try:
            u = agent.conversation.total_usage
            out["usage"] = u.model_dump() if hasattr(u, "model_dump") else (dict(u) if u else None)
        except Exception as e:  # the receipt still says usage could not be read
            out["usage_error"] = f"{type(e).__name__}: {e}"
    out.update({"vertex_project": project, "vertex_location": location})
    return out


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
    a = p.parse_args()
    started = time.time()
    try:
        receipt = asyncio.run(run(a))
    except Exception as e:  # the receipt always gets written, with the reason
        receipt = {"finish_output": None, "usage": None, "tool_calls": [], "error": f"{type(e).__name__}: {e}", "error_type": type(e).__name__}
    receipt.update({"sdk": "google-antigravity", "sdk_version": SDK_VERSION, "thinking": a.thinking.upper(), "seconds": round(time.time() - started, 1)})
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(receipt, f, indent=2, default=str)


if __name__ == "__main__":
    main()
