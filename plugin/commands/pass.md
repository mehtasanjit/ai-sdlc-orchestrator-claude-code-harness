---
description: "Run the AI-SDLC workflow end-to-end. Reads a project brief and drives requirements, design, codegen, tests, docs, and reviews under the loaded policy. Premium-judgment phases stay on the subagent's own tier; mechanical phases dispatch to the policy's mechanical model. Configurable via --auth, --policy, --study, --run-id."
argument-hint: "--auth=vendor|estimated [--policy=<name>] [--study=<study-id>] [--run-id=<run-id>] <path-to-brief.md>"
---

Invoke the `orchestrator` subagent to execute one full SDLC run.

**Arguments:** $ARGUMENTS

**Argument parsing (the orchestrator must do this):**
- `--auth=<vendor|estimated>` — **required**. Picks the telemetry mode for the whole run. `vendor` dispatches every LLM call via the MCP server so telemetry carries real vendor-reported tokens; `estimated` uses a char-count heuristic for direct-tier calls. If the flag is missing or carries any other value, abort — see rule 6 in the orchestrator's system prompt for the exact abort text.
- `--policy=<name>` — routing policy name. When absent, resolves to the current project's `default_policy` field from `.sdlc/project.json` (written by the setup-time policy console — see [SETUP.md](../../SETUP.md) §5b), or `opus-plus-flash` if no project default is set.
- `--study=<study-id>` — case-study identifier. Defaults to `workforce-ops`. Set this to a project-specific id when running against a brief other than the shipped `examples/workforce-ops/brief.md`, so telemetry and packets stay grouped by project.
- `--run-id=<run-id>` — run identifier within the study. Defaults to `pass1`.
- The remaining positional argument is the path to the brief file. Any markdown brief on disk works — see `docs/brief-template.md` for the section layout the requirements phase expects.

**Output paths:**
- `pass_id`: `<run-id>`
- `output_dir`: `examples/<study-id>/passes/<run-id>/`
- `telemetry_path`: `examples/<study-id>/passes/<run-id>/telemetry.jsonl`
- `manifest_path`: `examples/<study-id>/passes/<run-id>/manifest.json`
- `cache_context`: `<run-id>:<study-id>` (used to key the mechanical-tier prompt cache)

If `examples/<study-id>/passes/<run-id>/` already exists, its contents will be overwritten. Use a new `--run-id` to preserve prior data.

**Single-model runs** — to author every phase with one model (e.g. an "Opus only" baseline), pass a policy whose `rules:` list has only a default rule routing to that model. The same command flow runs; the routing table just does not fork.

**Policy resolution:** every policy tool on the MCP server (`execute_with_model`,
`preflight_dispatch`, `load_policy`, `simulate_policy`) resolves through one loader with one
precedence, and the orchestrator's job is to pass the arguments that express what the user asked
for:

1. **An explicit `--policy=<name>` flag wins over everything.** Pass it as
   `policy_path: ${CLAUDE_PLUGIN_ROOT}/config/policies/<name>.yaml` — an explicit path bypasses
   the loader's search entirely, which is what lets a flag typed for *this run* beat a repo-local
   override.
2. **Otherwise a repo-local `<project root>/routing-policy.yaml` wins over any name.** Pass
   `policy_name: <resolved default>` plus `project_root: $(pwd)`; the loader prefers the project
   file whenever it exists. Omitting `project_root` is the historical bug: the run silently fell
   back to the shipped preset while the project's own policy sat unread.
3. **Otherwise the named preset** `plugin/config/policies/<name>.yaml` loads — the project's
   `default_policy` from `.sdlc/project.json`, or `opus-plus-flash` when none is set.

Pass the same policy arguments on **every** call, `simulate_policy` included — a what-if priced
under a different policy than the run used is worse than no what-if.

**Requirements before starting:**
- Gemini credentials must be present when the policy uses any Gemini model — either Google Cloud credentials for Gemini Enterprise Agent Platform, formerly Vertex AI (`gcloud auth application-default login`, no key), or `GEMINI_API_KEY` for AI Studio. If neither is available, abort with a clear message naming both.
- `ANTHROPIC_API_KEY` env var must be set when `--auth=vendor`. If signed in to a Claude Code subscription under `--auth=estimated`, Claude Code provides direct-tier auth and the variable does not need to be exported. It IS required for `claude --print` (headless) invocations under `--auth=vendor`.
- `CLAUDE_CODE_SUBAGENT_MODEL` must be set **before `claude` launches** when `--auth=estimated`, to the policy's driver `model_name`: from a terminal, exported or in the `env` block of `<project>/.claude/settings.local.json`; from the desktop app, in the `env` block of `~/.claude/settings.json` (the app ignores project settings files). It is what the five driver subagents actually execute on, and the orchestrator's run-start driver-model check aborts (printing where to set it) when it is unset or wrong. Print the expected value ahead of a headless run with `node "${CLAUDE_PLUGIN_ROOT}/scripts/driver-model-check.mjs" --project-root "$(pwd)" --print-only` plus the run's `--policy`/`--policy-path` arguments. Irrelevant under `--auth=vendor`.
- The MCP server `model-dispatch` must be registered (it is, via the plugin manifest).

**HITL gates active:** Gate 1 (requirements), Gate 2 (design), Gate 3 (security review), Gate 4 (final acceptance).

When invoked headlessly (e.g. via `claude --print "/mmo:pass ..." --output-format stream-json --verbose`), all four HITL gates auto-approve so the session can complete end-to-end without prompts.

---

## Brownfield-mode flags (added in v1)

When `--mode=brownfield` is set, the pipeline uses the brownfield entry (equivalent to
`/mmo:brownfield` but flag-driven for scripted / CI use). Additional required + optional
flags:

| Flag | Purpose |
|---|---|
| `--mode=brownfield` | Switch to brownfield mode. Default is greenfield. |
| `--intent=<docs\|bugfix\|feature-extend\|feature-new\|refactor\|test\|deps>` | Required in brownfield. The job type. Adds a `Gate 0` before Gate 1. |
| `--brief=<path>` | Optional: pre-written intent brief (replaces the interview). Any markdown file with the section layout in [docs/brownfield.md](../../docs/brownfield.md) works. |
| `--gates=<prompt\|auto-approve\|auto-abort>` | Gate behavior. `prompt` (default) is interactive; `auto-approve` accepts every gate (headless friendly); `auto-abort` **v1.5** — approves only when the run's fingerprint matches `.sdlc/project.json`, aborts otherwise. Recommended for CI so drift never silently proceeds. |
| `--from-config=<path>` | **v1.5** — read gate answers from a committed team config file. Combined with `--gates=auto-abort`, this is the CI-safe flow. |
| `--policy=<name>` | Same as greenfield. Overrides the setup-time project default (`.sdlc/project.json.default_policy`) and, if present, any repo-local `routing-policy.yaml` — the flag is passed to the MCP server as an explicit `policy_path`, which outranks the loader's project-override search (see **Policy resolution** above). |
| `--strict-write=off` | Downgrade the write-contract PreToolUse hook from HARD-BLOCK to WARN. Every off-limits or not-in-allowlist write is logged but not refused. Use with care — this defeats the plugin's main safety guarantee. |
| `--allow-dirty` | Bypass the git-clean check when the git contract's `commit_strategy != none`. |
| `--recheck` | Force pre-check re-run even when the cached status is still valid. Useful after a plugin version bump. |
| `--adaptive-profile` | Force Tier 2b adaptive stack profile even when a matching pre-authored adapter exists. Useful when the shipped adapter's conventions don't match this repo. |
| `--refresh-profile` | Force stack-profile re-scan (implies `--recheck`). Use after a substantial repo restructure. |

**Brownfield output paths:**
- `run_id`: `<YYYYMMDD-HHMMSS>-<intent>-<slug>`
- `output_dir`: `.sdlc/runs/<run_id>/`
- `telemetry_path`: `.sdlc/runs/<run_id>/telemetry.jsonl`
- `manifest_path`: `.sdlc/runs/<run_id>/manifest.json`
- `provenance_path`: `.sdlc/runs/<run_id>/provenance.json`

**Brownfield requirements before starting:**
- Everything greenfield requires, PLUS:
- `.sdlc/local/write-contract.json` gets written after Gate 0 approval (before any packet
  dispatches). The PreToolUse hook reads it on every `Write`/`Edit`.
- The current directory MUST be a git repo (or an ancestor is). Brownfield refuses on non-git
  folders with a clear message.
- The pipeline pre-check (§7.4) must have passed or been skipped-with-user-consent for this
  run's inputs.

See [plugin/commands/brownfield.md](brownfield.md) for the interactive equivalent
of these flags (the 7-step operating manual Claude follows in the interactive flow).

Begin now.
