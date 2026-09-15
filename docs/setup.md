# Setup

> **For:** setting up a fresh install, or adding a new provider. **Also see:** [tutorial-first-run.md](tutorial-first-run.md) · [running.md](running.md) · [troubleshooting.md](troubleshooting.md).

Everything you need to prepare your machine for a run. Failure modes and repair commands are in [troubleshooting.md](troubleshooting.md).

## Prerequisites

| Item | Verify with | Notes |
|---|---|---|
| Node.js 20+ | `node --version` | The MCP server and setup scripts. |
| Claude Code CLI | `claude --version` | `npm install -g @anthropic-ai/claude-code`. |
| macOS, Linux, or WSL2 | — | POSIX bash. |

## Where credentials must live

Claude Code launched from the desktop app does not inherit a login shell, so a variable exported in `~/.zshrc` or typed into a terminal is invisible to the plugin's MCP server. Two places do work:

- **Nowhere — the Application Default Credentials (ADC) path.** `gcloud auth application-default login` writes a credentials file that the SDK reads directly. No environment variable is involved. This is the option to reach for first with Gemini Enterprise Agent Platform (formerly Vertex AI).
- **The `env` block of `~/.claude/settings.json`**, for anything that must be a variable — `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`. Claude Code reads that file at startup and passes the values through to the bundled server.

The clone route also accepts a shell export because `claude` is launched from the same shell that wrote the export.

## Providers

The pipeline reaches four surfaces. You need at least one Anthropic surface for every run, and one Gemini surface for the `opus-plus-flash` policy.

### Anthropic

| Variable | Type | Default | Required when | Description |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | string | — | `--auth=vendor` | API key from [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys). Not needed under `--auth=estimated`, which uses the Claude Code subscription. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | string | — | `--auth=estimated` | The model the five driver subagents actually **execute** on. Must be set **before `claude` launches** (an export inside the session runs in a child shell and never reaches the CLI process) and must equal the policy's driver `model_name`. In a terminal, `export` it in the shell you launch `claude` from, or put it in the `env` block of `<project>/.claude/settings.local.json` (this folder only: the terminal CLI, headless and interactive, applies that file when it launches there — verified on Claude Code 2.1.270). From the desktop app, put it in the `env` block of `~/.claude/settings.json`: the app inherits no login shell, so it never sees a shell export, and it ignores the `env` block of a project's `.claude/settings.json` and `.claude/settings.local.json`. That user file is machine-wide — it pins the driver model for every session on this machine, including runs unrelated to this one, so remove the entry when you are done — print that with `node plugin/scripts/driver-model-check.mjs --project-root "$(pwd)" --print-only` plus the run's policy arguments. Without it the driver tier runs on whatever the session's model is while the report prices the policy's, which misattributes every driver dollar. Irrelevant under `--auth=vendor`, where every call dispatches through the server. |

**Verify:** `verify-setup.mjs`. Under `vendor` an unset key is a blocking pre-flight halt; under `estimated` it is inert. Under `estimated` the orchestrator additionally runs `plugin/scripts/driver-model-check.mjs` at run start and halts — printing where to set it for a terminal and for the desktop app, and naming any project `.claude/settings.local.json` or `.claude/settings.json` that already declares a value this session does not see — when `CLAUDE_CODE_SUBAGENT_MODEL` is unset or does not match the policy's driver model. The driver agent files deliberately carry no `model:` frontmatter pin: a pin would silently override the policy, executing one model while the pricing block priced another.

### Anthropic via Claude subscription — the `claude-cli` adapter

A policy model whose `adapter:` is `claude-cli` (the `opus-plus-sonnet-max` policy's mechanical tier is the shipped example) is dispatched through the local `claude -p` subprocess instead of the Anthropic API. The subscription's OAuth session backs the request, so `ANTHROPIC_API_KEY` is not involved on this path even under `--auth=vendor`.

| Requirement | Description |
|---|---|
| `claude` binary on PATH | The adapter probes `claude --version` at startup and refuses the model with an actionable error if the binary is missing. |
| Logged-in Claude Code | A Claude Pro / Max / Team subscription session (`/login`). The CLI surfaces its own auth errors; the plugin does not probe OAuth state itself. |

Cost on this path is priced from the worker's own tokens, the same way as every other dispatch. The adapter reads the result's per-model `modelUsage` counts (a `claude -p` call can bill helper sessions and side calls, a Haiku call for instance, that no transcript records) and prices each model at its rate on the dated price list. The 5-minute / 1-hour cache-write split comes from the worker session's own transcript under `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). Writes the transcript does not explain (it cannot be read, or Claude Code billed calls it never logged) take the result's top-level `usage.cache_creation` split only for the one model whose four token counts equal that `usage`, which is where Claude Code writes the session model's own usage; any other model's unexplained writes are priced at the 5-minute rate, and the attempt's `per_model[].assumed` says so. Either way the event says `ttl_split: "approximate"`. (Giving that one split to every model counted the session's 1-hour writes once per model, more than the receipt billed.) The event also carries `transcript_logged_cost_usd`, the share of that cost for the tokens the worker's transcript explains; the post-run collector subtracts only that share of a worker its transcript scan counted, so side calls and unlogged tokens stay in the run's true total. The CLI's own `total_cost_usd` is kept on the event as `cli_reported_cost_usd` and is never the cost: when it differs from the list-priced figure by more than 0.5%, a `pricing.cli_cost_mismatch` warning is logged (Claude Code's price table has been stale before; on 2026-08-24 it billed Opus at exactly 0.6× the list). A worker whose model has no price is refused before `claude` is spawned. Each call spawns a fresh `claude` process, which re-sends ~17k tokens of session context; that overhead shows up as cache-write tokens in the telemetry, priced at the cache-write rate for its TTL.

| Variable | Type | Default | Required when | Description |
|---|---|---|---|---|
| `GEMINI_API_KEY` | string | — | AI Studio path | API key from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey). |

**Verify:** `verify-setup.mjs`. A key present is a deliberate local choice, so it outranks ambient Vertex credentials — use `GEMINI_BACKEND=vertex` to override.

### Gemini as a model — Enterprise Agent Platform (ADC) {#gemini-as-a-model--enterprise-agent-platform-adc}

Gemini Enterprise Agent Platform (formerly Vertex AI) via Application Default Credentials.

| Variable | Type | Default | Required when | Description |
|---|---|---|---|---|
| — | file | `~/.config/gcloud/application_default_credentials.json` | ADC path | Written by `gcloud auth application-default login`. |
| `GOOGLE_APPLICATION_CREDENTIALS` | path | — | service-account file | Full path to a service-account JSON. Outranks the gcloud ADC file. |
| `GOOGLE_CLOUD_PROJECT` | string | project recorded inside the credentials file | account with more than one project | Billing project for Gemini calls. A project ID alone is not a credential. |
| `GOOGLE_CLOUD_LOCATION` | string | `global` | pinning a region | The platform bills non-global endpoints **+10%** on every token class for Gemini 3+, effective 2026-07-01. The plugin applies the surcharge to the reported cost automatically; the policy YAML pins the flat global rates and does not need to be edited. |
| `GEMINI_BACKEND` | `vertex` \| `api-key` | auto-detected | forcing a door | Explicit override of the credential-precedence logic. `vertex` names the ADC door (kept for backward compatibility with the older product name). |

**Verify:** `verify-setup.mjs`. On the default (unset region) the cost the plugin reports is the cost Google bills. Pin a region only when you need quota or latency the global endpoint cannot give you.

**AI Studio vs ADC precedence.** If both are present, the API key wins. Set `GEMINI_BACKEND=vertex` to force ADC.

### Gemini as an agent — Antigravity SDK

The mechanical tier can be reached either as a model (one completion call per packet) or as an agent that opens the working directory itself, runs commands, and edits files. Both bill the same Google Cloud project at the same published rates; the difference is token volume and evidence.

| Variable | Type | Default | Required when | Description |
|---|---|---|---|---|
| `MMO_SELECT` | `slot=option,...` | unset (→ `flash-completion`, the model path) | selecting the agent | Written by `verify-setup.mjs --enable-agent` as `gemini-flash=flash-agsdk-worker`. Do not set by hand — writing just the option (`flash-agsdk-worker`) passes offline checks and throws at policy load, after premium phases are billed. |
| `GEMINI_WORKER_PYTHON` | path | plugin-built venv at `plugin/mcp/model-dispatch/worker/.venv/bin/python` | using your own interpreter | Python ≥ 3.10 with `google-antigravity` installed. Skips the built-in venv. |

**Constraints.**

- **ADC only.** The Antigravity SDK signs with Application Default Credentials and has no API-key door. `GEMINI_API_KEY` cannot reach this path.
- **Python 3.10+.** `google-antigravity` declares that minimum. macOS ships 3.9 as `/usr/bin/python3`, so the default interpreter is the one that will not work. `verify-setup.mjs --enable-agent` searches by explicit version name (`python3.13`, `python3.12`, …) rather than trusting the bare `python3`.
- **Cost.** Several times more per packet than the model path. The SDK re-sends the full conversation on every tool call plus a ~11.5k-token identity preamble every turn. Same rates, many more tokens.

**Choosing it.** Both installation routes ask, and only when the setup check finds real Google Cloud credentials — offering it otherwise would offer something that cannot work.

On the plugin route, [SETUP.md](../SETUP.md) puts the question to you as step 5 and a yes runs `verify-setup.mjs --enable-agent`. On the clone route, `node tools/setup.mjs` asks as part of the wizard.

You can run the flag yourself at any time, on either route:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/scripts/verify-setup.mjs | tail -1)" --enable-agent
```

Or, from a clone:

```bash
npm run verify -- --enable-agent
```

`--enable-agent` writes the selection into `.claude/settings.local.json` in the current folder — this folder only. Add `--user` to write `~/.claude/settings.json` and apply it machine-wide. On the clone route it also updates `.mcp.json`, because a stdio MCP server does not inherit the parent environment. `--disable-agent` reverses the selection; the venv can stay unused or be deleted.

Settings files are read by Claude Code when a session starts, so the selection reaches the session after the one you ran the command in.

**Confirming the choice took effect.** A run that used the agent path leaves evidence a run that did not, does not:

- `node tools/report.mjs <pass-dir>` prints a **Delegated to an agent worker** section.
- The pass directory contains `delegation/` — three files per delegated packet: the task brief, the worker's own usage sidecar, and a receipt joining them to the on-disk diff.

If neither appears, the run went through the model path regardless of what the variable says.

**Confirming reachability before a real run.** `verify-setup.mjs` is offline. Three failure modes are invisible to it, because none is a missing file: entitlement (403), region (404), and credential liveness (401). All three surface at the first delegated packet, after the premium phases are billed. One trivial delegation settles them:

```bash
node plugin/scripts/probe-agent-worker.mjs
```

Or on the plugin route:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/scripts/probe-agent-worker.mjs | tail -1)"
```

Cost: about two cents (~12k input, ~150 output — almost entirely the SDK preamble). `verify-setup.mjs` prints this command at the end of its own output when the install selects the agent path and every offline check passes.

### Every credential combination

The setup check reads five things — `GEMINI_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, the gcloud ADC file, `GOOGLE_CLOUD_PROJECT`, and `MMO_SELECT` — and the combinations they form are enumerated below. Rows 5, 6 and 8 are the ones worth knowing by name: each looks like a working install to a naive check and each fails at the first Gemini call rather than at setup, so each is flagged explicitly.

To walk a row, set what its second column names and run:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/scripts/verify-setup.mjs | tail -1)"
```

| # | What is set | Finding | Runs? |
|---|---|---|---|
| 1 | Nothing | `gemini-credentials` (warning) | Claude-only policies run. The multi-model policy has no door open. |
| 2 | `GEMINI_API_KEY` | — | Model path, through AI Studio. The agent question is not asked: that path cannot use a key. |
| 3 | `gcloud auth application-default login` | — | Model path, through Vertex. The agent path is available and offered. |
| 4 | `GOOGLE_APPLICATION_CREDENTIALS` → a complete service-account file | — | Same as row 3. |
| 5 | `GOOGLE_CLOUD_PROJECT` only | `gemini-credentials` (warning) | A project ID says where to bill, not who is asking. Inside Google Cloud the credential arrives from the metadata server and this works; on a laptop it does not. Not offline-resolvable — hence a warning. |
| 6 | `GOOGLE_APPLICATION_CREDENTIALS` → a file that is missing, truncated, or not a credential | `gemini-credentials-broken` (blocking) | Nothing. `GOOGLE_APPLICATION_CREDENTIALS` outranks the gcloud ADC file, so a broken one hides a working login. |
| 7 | `GEMINI_API_KEY` **and** Google Cloud credentials | — | Model path through AI Studio — the key wins. `GEMINI_BACKEND` overrides. The agent path is still available. |
| 8 | `MMO_SELECT=gemini-flash=flash-agsdk-worker` with only `GEMINI_API_KEY` | `agent-worker-credentials` (blocking) | Nothing. The run is routed to the agent path and the key cannot reach it — the wrong door, not a partial credential. |

Two combinations are absent because they are not credential states. A variable that arrived as the literal `${NAME}` is reported separately as `env-placeholders` and treated as unset. Row 8 with a named project but no credential downgrades to `agent-worker-credentials-unproven` (warning), for the same reason row 5 does.

What none of these rows tells you is whether a well-formed credential is still live, whether the project carries the Antigravity entitlement, or whether the region serves the model. Those need one real call — the probe above.

## Per-project policy pick

The one and only step in the whole flow that opens a browser. Every run in this folder — `/mmo:greenfield`, `/mmo:brownfield`, `/mmo:pass` without `--policy` — uses the policy picked here, unless the flag overrides it for one run.

Written to `.sdlc/project.json.default_policy` in the current repo. Per-project, so a compliance-sensitive repo can pin Opus everywhere while a side project runs on Flash.

On the plugin route, [SETUP.md](../SETUP.md) §5b puts the choice to you. Four options in this order:

| Option | What happens | When to pick it |
|---|---|---|
| **Open the browser to author or customize a policy** | Starts `plugin/policy-console/` (a single HTML page served by a tiny Node http server) on the first free port from 3000, opens the browser, watches `plugin/config/policies/` via `fs.watch`. Clicking Save writes a new YAML and the script auto-detects the write. The save lands inside the installed plugin's `config/policies/`, which `/plugin update` replaces wholesale — to keep a custom policy across updates, copy it to `<project root>/routing-policy.yaml`, which the loader prefers automatically. | Any non-preset policy — different thinking budgets per phase, custom model per task-type, a policy that pins a region. |
| **`opus-plus-flash`** (recommended) | Silent set. Claude Opus for judgment phases, Gemini 3.5 Flash for mechanical (codegen, tests, docs). | The cost-efficient default. |
| **`opus-only`** | Silent set. Claude Opus for every phase. | Single-model baseline, or when Gemini access is unavailable. |
| **Skip** | Leaves `default_policy` unset. `/mmo:greenfield` and `/mmo:brownfield` refuse to start until a policy is picked. | Almost never. Prefer picking `opus-plus-flash` and changing later. |

Change the choice at any time from a running session:

```
/mmo:policy           # show the current policy and when it was set
/mmo:policy change    # opens the browser console again
/mmo:policy --policy=opus-only    # silent set to a shipped preset
```

Prior runs' `provenance.json` records the policy that was in effect at run time; those are not rewritten when the default changes. Overriding a single run without touching the default: type a different policy name at Gate 0 in `/mmo:brownfield`, or pass `--policy <name>` to `/mmo:pass`.

## Install dependencies (clone route)

From the repo root:

```bash
node tools/setup.mjs
```

The wizard verifies each prerequisite, installs and builds the bundled MCP server, and copies the slash command + subagents into `./.claude/` so Claude Code finds them in interactive and headless modes. Nothing is written outside this repo except the newly built `plugin/mcp/model-dispatch/node_modules/` and `dist/`.

The plugin route runs the same checks through [SETUP.md](../SETUP.md).
