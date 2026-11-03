"""thinking_worker.py — one thinking step (requirements, an architect, a reviewer, discovery) on Gemini, launched by the
MCP server (src/thinking.ts) through the agent door's adapter.

The agent worker (gemini_worker.py) with three differences:
  - the SDK's own tools are switched off but `finish`; every other tool is one of ours (scripts/thinking-tools.mjs,
    one Node process for the step): reading through the engine's read rule, and handing work in through the same
    checks the Claude helper's hand-over runs. Gemini has no tool that writes the project, runs a shell or reaches
    the network;
  - the step is done when the tools say every piece it owes is accepted, not when Gemini stops talking: a turn that
    ends with pieces missing is answered with what is missing, in the same conversation, until the step's own work
    time (--timeout, the policy's thinking_timeout_sec) runs out;
  - the conversation is saved under --save-dir and carried on with --resume-id, so a gate's revise continues the
    session that wrote the pieces instead of starting over.

Everything else is the agent worker's: the call supervisor (stall cuts, failover, busy budget, heartbeat, the time
limit counting own work only) and its usage sidecar. stdout carries one JSON line: {done, missing, accepted,
conversation_id, text}.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gemini_worker as gw  # noqa: E402
import agy_supervisor as sv  # noqa: E402
from google.antigravity import types  # noqa: E402

# A turn that ends with pieces still missing is answered this many times before the step stops; each answer is a
# turn in the same conversation, so the model keeps what it read.
MAX_NUDGES = 8


class ToolHost:
    """The Node tool process, called one line at a time (the SDK may call tools from a worker thread)."""

    def __init__(self, node: str, script: str, config: str):
        self.p = subprocess.Popen([node, script, "--config", config], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=sys.stderr, text=True, bufsize=1)
        self.lock = threading.Lock()
        self.n = 0

    def call(self, op: str, **args) -> dict:
        with self.lock:
            self.n += 1
            self.p.stdin.write(json.dumps({"id": self.n, "op": op, "args": args}) + "\n")
            self.p.stdin.flush()
            line = self.p.stdout.readline()
        if not line:
            return {"ok": False, "error": "the tool process ended"}
        return json.loads(line)

    def text(self, op: str, **args) -> str:
        r = self.call(op, **args)
        return r["result"] if r.get("ok") else f"ERROR: {r.get('error')}"

    def close(self) -> None:
        try:
            self.p.stdin.close()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def tools_for(host: ToolHost, role: str) -> list:
    """The step's tools as plain functions: the SDK builds each one's schema from its signature and docstring."""

    def read_file(path: str, from_line: int = 1, to_line: int = 0) -> str:
        """Read a project file (a path relative to the project root), optionally lines from_line..to_line. Lines come numbered."""
        return host.text("read_file", path=path, from_line=from_line, to_line=to_line or None)

    def list_files(path: str = ".") -> str:
        """List one project folder; folders end with '/'."""
        return host.text("list_files", path=path)

    def search_files(pattern: str, path: str = ".") -> str:
        """Search project files under path for a regular expression; answers path:line: text."""
        return host.text("search_files", pattern=pattern, path=path)

    def write_requirements(content: str) -> str:
        """Hand in requirements.md: the whole document, in Markdown."""
        return host.text("write_requirements", content=content)

    def write_section(name: str, section_json: str) -> str:
        """Hand in one change-spec section file (header.json, then units-001.json, units-002.json, ...): the file's JSON
        text. Checked at once; a refusal lists every problem. Send the same name again to replace a refused section."""
        return host.text("write_section", name=name, json=section_json)

    def submit_section(name: str, section_json: str) -> str:
        """Hand in one build-spec section file (header.json first, then units-001.json, ...): the file's JSON text.
        Checked at once; a refusal lists every problem and stores nothing."""
        return host.text("submit_section", name=name, json=section_json)

    def finalize() -> str:
        """Assemble the build spec from the accepted sections and check every requirement is covered."""
        return host.text("finalize")

    def registry_versions(ecosystem: str, name: str) -> str:
        """The published versions of a package: ecosystem 'npm' or 'pypi'."""
        return host.text("registry_versions", ecosystem=ecosystem, name=name)

    def git_diff(path: str = "") -> str:
        """The run's change against its starting commit: one file's diff, or every touched file's when path is empty."""
        return host.text("git_diff", path=path or None)

    def read_provenance() -> str:
        """The run's provenance.json: every file it touched."""
        return host.text("read_provenance")

    def run_file_check(path: str, check_id: str) -> str:
        """Run one of the run's declared file checks on one file, in its check form only; answers its exit code and output."""
        return host.text("run_file_check", path=path, check_id=check_id)

    def run_dependency_audit(kind: str) -> str:
        """Run a dependency check: kind 'npm-audit', 'npm-outdated' or 'pip-outdated'."""
        return host.text("run_dependency_audit", kind=kind)

    def env_keys(path: str) -> str:
        """The key names an env file declares (.env, .env.example, .env.test, ...), never its values; for .env.example
        and .env.test, each value's length and whether it is a URL. Env files are listed but their contents are kept
        from you."""
        return host.text("env_keys", path=path)

    def write_review(content: str) -> str:
        """Hand in the review: for the security review, security_review.md in Markdown; for the senior review, the review
        JSON object with its findings array (each finding with file, issue and fix)."""
        return host.text("write_review", content=content)

    def baseline_status() -> str:
        """Whether the project's discovery baseline is current, cached or stale."""
        return host.text("baseline_status")

    def write_discovery(name: str, content: str) -> str:
        """Hand in one of discovery's files: 'discovery.md', 'baseline.json', 'baseline/current.json', 'baseline/discovery.md'."""
        return host.text("write_discovery", name=name, content=content)

    every = {f.__name__: f for f in [read_file, list_files, search_files, write_requirements, write_section, submit_section,
                                     finalize, registry_versions, git_diff, read_provenance, run_file_check,
                                     run_dependency_audit, env_keys, write_review, baseline_status, write_discovery]}
    names = ["read_file", "list_files", "search_files"] + ROLE_TOOLS[role]
    return [every[n] for n in names]


ROLE_TOOLS = {
    "requirements": ["write_requirements"],
    "architect": ["submit_section", "finalize", "registry_versions"],
    "brownfield-architect": ["write_section"],
    "senior-reviewer": ["env_keys", "write_review"],
    "brownfield-senior-reviewer": ["git_diff", "read_provenance", "run_file_check", "env_keys", "write_review"],
    "security-reviewer": ["run_dependency_audit", "env_keys", "write_review"],
    "brownfield-security-reviewer": ["git_diff", "read_provenance", "run_dependency_audit", "env_keys", "write_review"],
    "discovery": ["baseline_status", "write_discovery"],
}


class ThinkingSession(gw.AgentSession):
    def __init__(self, args, sup, location0, fn_tools, resume_id=None):
        super().__init__(args, sup, location0)
        self.save_dir = args.save_dir
        self.fn_tools = fn_tools
        self.resume_from = resume_id

    def config(self, location, resume_id=None):
        cfg = super().config(location, resume_id or self.resume_from)
        return cfg.model_copy(update={
            "capabilities": types.CapabilitiesConfig(enable_subagents=False, enabled_tools=[types.BuiltinTools.FINISH]),
            "tools": self.fn_tools,
        })


async def run(args):
    with open(args.task_file, encoding="utf-8") as f:
        task = f.read()
    location = args.region or gw.LOCATION
    if not location or not gw.PROJECT:
        raise SystemExit("thinking_worker: no Vertex project or region (set GOOGLE_CLOUD_PROJECT; pass --region)")
    os.environ["GOOGLE_CLOUD_PROJECT"] = gw.PROJECT
    os.environ["GOOGLE_CLOUD_LOCATION"] = location
    sv.keep_loopback_off_proxy()
    os.makedirs(args.save_dir, exist_ok=True)
    locations = [x.strip() for x in args.locations.split(",") if x.strip()] if args.locations else [location]
    sup = sv.Supervisor(
        model=args.model, locations=locations, stall_sec=args.stall_sec, stall_tries=args.stall_tries,
        busy_budget_s=args.busy_budget_sec, heartbeat_s=args.heartbeat_sec, timeout_s=args.timeout,
        sdk_version=gw.SDK_VERSION,
        retry_initial_s=args.api_retry_initial_ms / 1000 if args.api_retries is not None and args.api_retry_initial_ms else None,
        work_limit_reason=(f"the step's own work time reached the policy's limit (thinking_timeout_sec): {args.timeout} s, "
                           "the time Google held or refused its calls not counted"),
    )
    host = ToolHost(args.node, args.tools_script, args.tools_config)
    fn_tools = tools_for(host, args.role)
    resume = args.resume_id or None
    message = task
    summary = {"done": False, "missing": [], "accepted": [], "conversation_id": resume, "text": ""}
    s = None
    sup.start()
    try:
        for nudge in range(MAX_NUDGES + 1):
            s = ThinkingSession(args, sup, locations[0], fn_tools, resume)
            await s.run(message)
            # The conversation the session itself ran, by the SDK's own id: never the newest file in the save folder.
            resume = s.conversation_id or resume
            summary["conversation_id"] = resume
            summary["text"] = s.text
            status = json.loads(host.text("status"))
            summary.update({k: status.get(k) for k in ("done", "missing", "accepted")})
            if not s.ok or status.get("done") or sup.stopped or sup.work_s() >= args.timeout:
                break
            message = ("Not done yet. Still owed: " + "; ".join(status.get("missing") or []) +
                       ". Hand each piece in with your tools; a refused piece answers with every problem to fix.")
    finally:
        host.close()
        await sup.close()
        if s is not None:
            s.write()
    return s, summary


def main():
    p = argparse.ArgumentParser()
    for flag in ("--task-file", "--model", "--workdir", "--out-dir", "--usage-file", "--role", "--tools-config", "--save-dir"):
        p.add_argument(flag, required=True)
    p.add_argument("--region", default=None)
    p.add_argument("--thinking", default="NONE")
    p.add_argument("--timeout", type=int, default=14400)
    p.add_argument("--resume-id", default=None)
    p.add_argument("--node", default="node")
    p.add_argument("--tools-script", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "scripts", "thinking-tools.mjs"))
    p.add_argument("--api-retries", type=int, default=None)
    p.add_argument("--api-retry-initial-ms", type=int, default=None)
    p.add_argument("--locations", default=None)
    p.add_argument("--stall-sec", type=int, default=300)
    p.add_argument("--stall-tries", type=int, default=2)
    p.add_argument("--busy-budget-sec", type=int, default=120)
    p.add_argument("--heartbeat-sec", type=int, default=10)
    args = p.parse_args()
    if args.role not in ROLE_TOOLS:
        print(f"thinking_worker failed: unknown role {args.role}", file=sys.stderr)
        sys.exit(2)
    try:
        s, summary = asyncio.run(run(args))
    except Exception as e:
        print(f"thinking_worker failed: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(summary))
    if s is None or not s.ok:
        print(f"thinking_worker failed: {s.error if s else 'no session'}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
