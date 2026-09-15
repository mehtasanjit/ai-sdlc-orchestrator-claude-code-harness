# Troubleshooting

> **For:** hitting an error and needing symptom → cause → fix. **Also see:** [setup.md](setup.md) · [brownfield-setup-issues.md](brownfield-setup-issues.md).

Symptom → cause → fix. If the fix is a command, it is copy-paste-runnable.

## How to inspect what is happening

| Command | What it tells you |
|---|---|
| `/mmo:setup` (inside Claude Code) | Re-verify and re-configure this project. Rebuilds the MCP server, re-checks credentials, prints one line per completed step, pauses only on missing credentials or when a decision is needed. The first command to reach for. |
| `/mmo:policy` | Which policy this project uses and when it was set. `/mmo:policy change` opens the browser to change it. |
| `/plugin` | Which plugins are installed and enabled. |
| `claude --debug` | Prints the plugin's env pass-through, MCP handshake, and tool invocations. |
| `node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/scripts/verify-setup.mjs \| tail -1)"` | Full offline check. Reports blocking (`✗`) and warning (`!`) findings, plus fix commands. `/mmo:setup` wraps this. |
| `node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/scripts/probe-agent-worker.mjs \| tail -1)"` | One real Antigravity delegation, ~2¢. Only cheap way to confirm entitlement, region, and credential liveness. |

From a clone:

```bash
npm run verify --prefix /path/to/ai-sdlc-orchestrator-claude-code-harness
```

## Install and prerequisites

| Symptom | Cause | Fix |
|---|---|---|
| `claude: command not found` | Global npm bin not on `PATH`. | Add the output of `npm root -g`'s `../bin` to `PATH`, or install Node via `nvm`. |
| `Node <n> — this repo needs Node 20 or newer` | Older Node on `PATH`. | `nvm install --lts`, or install from [nodejs.org](https://nodejs.org). |
| `verify-setup.mjs`: `mcp-dependencies` or `mcp-build` (blocking) | `dist/` and `node_modules/` are not tracked in git; a fresh install carries source only. | Re-run with `--fix` — runs `npm ci` then `npm run build` in the server directory. |
| `/plugin marketplace add` reports the marketplace already exists | Cached from an earlier session. `add` is a no-op that leaves the cache stale. | `/plugin marketplace update tilicho-ai-labs`, then install again. |
| `/mmo:greenfield` isn't in the slash-command menu | Commands register at session start; the install session doesn't have it. | Open a new session in the same folder. |
| `/reload-plugins` returns "isn't available in this environment" | The command does not exist in the desktop app. | Open a new session instead. |

## Auth mode

| Symptom | Cause | Fix |
|---|---|---|
| `this run requires auth_mode=vendor\|estimated` | `/mmo:pass` invoked without `--auth`. | Add `--auth=vendor` (needs `ANTHROPIC_API_KEY`) or `--auth=estimated` (needs a Claude Code subscription sign-in). |
| Report labels a run "Mixed" | `--auth=estimated` and the policy also dispatched Gemini. Direct-tier events are estimated, Gemini events are vendor-reported. | Expected. `E` next to a phase marks the estimated ones. |
| Report totals don't match the Anthropic dashboard exactly | The run was `--auth=estimated`. | Re-run with `--auth=vendor` for numbers that reconcile to the console. |
| An `--auth=vendor` total differs from the Anthropic or Google dashboard by more than a few cents | A telemetry gap, or a stale rate: each dispatched dollar is the event's vendor tokens at the dated price list (or at a `pricing_override` card, `price_basis: "custom"`), not the vendor's own figure. | Compare each event's `model`, tokens and `price_basis` with the vendor's price page. For a stale rate, add a new period to `plugin/mcp/model-dispatch/src/prices.ts` (see [methodology.md](methodology.md#pricing-table-provenance)). |

## Pre-flight (`preflight_dispatch`)

| Symptom | Cause | Fix |
|---|---|---|
| Halts before phase 1 with `halt_reason` naming models | An adapter this run's auth mode requires cannot be constructed — usually a missing credential. | Fix each named credential and restart. Constructions run offline; nothing was billed. |
| Halts with `Cannot price N of M models` | A model the policy can route to has no price on the dated price list for today: it is not on the list (`gemini-3.6-flash`, for example), or today is outside its periods (before the model's GA day, or after a period that ends with no later one listed). Nothing was dispatched. | Add the model's verified period to `plugin/mcp/model-dispatch/src/prices.ts`, or give the model a `pricing:` block with `pricing_override: true` to bill a custom price. |
| Prints a `price_warnings` entry but the run starts | A policy `pricing:` block differs from the price list by more than 0.5% on some rate. The list is billed. | Correct the block to the list, or set `pricing_override: true` if the block is deliberate (its events then say `price_basis: "custom"`). |
| Prints a `warnings` entry but the run starts | The failed adapter belongs to a model this run's auth mode never dispatches to (typically `builtin-anthropic` under `--auth=estimated`). | Expected. Only a model this run actually dispatches to halts. |
| Lists a model under `not_selected` | The policy offers more than one way to reach a tier (a `select:` slot), and this run picked the other option. Prerequisites for the losing option are not checked. | Expected. Switch `MMO_SELECT` if you meant the other one. |

## Cost collector (`collect-orchestrator-usage.mjs`)

| Symptom | Cause | Fix |
|---|---|---|
| `WARNING: N token(s) on M message(s) in the window could not be priced`, and `cost_source` ends `INCOMPLETE — unpriced tokens excluded` | A transcript message ran on a model the dated price list does not carry, on a day outside that model's price periods, or with a `speed`, `service_tier` or `inference_geo` value the list does not price. Its tokens are listed under `orchestrator_overhead.unpriced` with the reason and are in no dollar figure. | Add the model's verified period to `plugin/mcp/model-dispatch/src/prices.ts` and re-run the collector, or give the model a `pricing:` block with `pricing_override: true` in the run's policy. |
| Exits 1 with `--strict-pricing, and N token(s) have no price on the list` | The same unpriced tokens, with `--strict-pricing` set. Nothing was written. | As above, or re-run without `--strict-pricing` to write the figure labelled incomplete. |
| `NOTE: Policy model '…' (…): its pricing block … differs … from the price list` | A policy `pricing:` block for a model in the transcript differs from the list by more than 0.5% on some rate. The list is billed. | Correct the block to the list, or set `pricing_override: true` if the block is deliberate. |
| Exits 3 with `the transcript is BELOW the CLI's own receipt (…), and the window cannot be proven to be the receipt's invocation: …` | The receipt bills more than the transcripts record, and the window is not provably that one invocation: it is not pinned to the receipt's session, does not open at the run's command turn, holds a later human turn, or is approximate. The gap could then be billed messages outside the window. Nothing was written. | Run the collector with `--project-root` set to the directory `claude` ran in, so it reads `.sdlc/runs/<run-id>/orchestrator.log` and finds the command turn. When collecting on another machine, copy the whole session: its `.jsonl` file and its directory, `subagents/` included. |
| Exits 3 with `the receipt matches neither the whole window nor its last invocation` | The window holds a `--resume` continuation, so the receipt bills only its last invocation, and that invocation does not fit the rule: a bucket is above the receipt, or it is below the receipt and cannot be proven to be the receipt's invocation (the receipt names another or no session, a human turn follows the window, or the close is approximate; the reasons are printed). Nothing was written. | Use the receipt of the session's last `--resume` leg for the run being collected, and run the collector with `--project-root` set to the directory `claude` ran in so the window closes at `run.end`. A human turn typed after the run starts a later invocation, whose receipt cannot referee this run. |
| Exits 3 with `cannot resolve model name(s) the price list does not carry` | A model name on the receipt or in the transcript is not on the dated price list, and the run's policy does not declare it as the `model_name` of an entry with `pricing_override: true` (read exactly, or with one bracketed option such as `[1m]`), so the two cannot be paired. Both name lists are printed. Nothing was written. | Add the model's verified price period to `plugin/mcp/model-dispatch/src/prices.ts` and re-run. For a name the policy uses on purpose (a gateway alias, say), give that policy model a `pricing:` block with `pricing_override: true` and that `model_name`, then re-run. |
| Exits 3 with `the receipt … carries no per-model token counts (modelUsage)` | The receipt beside the manifest (or `--receipt`) carries Claude Code's dollars and session id but no `modelUsage`, so there is nothing to check the transcript against or to price; Claude Code's dollars are never booked. | Keep the result line of `claude -p --output-format json` or `stream-json`, which carries `modelUsage`. Or move the file out of the pass directory to collect a transcript-priced figure labelled unverified. |
| `NOTE: attribution incomplete — helper <id> named by an Agent/Task result has no transcript file` (`attribution_complete: false`) | A helper's `subagents/agent-<id>.jsonl` is missing from the transcript tree, or a helper file is named by no result. A booked receipt's total is still right; the missing helper's tokens are in `unlogged_billed` instead of `per_model`. | Copy the session's whole `subagents/` directory and re-run the collector. |
| `tools/report.mjs` prints `No receipt booked, so this is a floor: excludes calls Claude Code bills but does not log` | The orchestrator figure was priced from transcripts alone: every interactive run, and a headless run whose receipt was not booked. Claude Code bills some calls it never writes to a transcript (2.3% and 22% of the bill on the two runs measured), and no transcript can show them. | Expected for an interactive run. For a figure that includes those calls, run headless, keep the `claude -p` result beside the manifest (`claude-session.json`, or the stream-json `live-run.log`), and re-run the collector after the session exits: a booked receipt prints `billed but not logged` instead. |
| `NOTE: Claude Code's own price table differs from the price list on this run` | Claude Code's `total_cost_usd` differs by more than 0.5% from the receipt's token counts priced at the list. The list figure is booked either way. | Compare `receipt_cli_usd` and the per-model figures in the NOTE with the price page, and fix `prices.ts` if the list is stale. If an `unlogged_billed` entry says `5-minute (assumed)`, the difference can be the cache-write TTL of tokens no transcript recorded. |

## Anthropic

| Symptom | Cause | Fix |
|---|---|---|
| `anthropic-key` warning | `ANTHROPIC_API_KEY` unset in the environment the plugin sees. | Get a key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys). Put it in the `env` block of `~/.claude/settings.json` — a shell export is not enough, because Claude Code launched from the desktop app inherits no login shell. |
| Vendor-mode run fails immediately | `ANTHROPIC_API_KEY` truly not set, or set to a `${...}` placeholder that arrived unexpanded (see [env-placeholders](#gemini)). | Same fix. Verify with `verify-setup.mjs`. |
| `pricing.cli_cost_mismatch` in the log after a `claude-cli` dispatch | Claude Code's own `total_cost_usd` differs from the list-priced figure by more than 0.5%. Either its price table is stale, or the worker's transcript could not be read and the cache-write split is approximate. | Nothing to fix in the run: `cost_usd` is the list figure either way. Look at the event's `ttl_split`. If it says `transcript`, compare `cli_reported_cost_usd` with the price page. |

## Gemini

| Symptom | Cause | Fix |
|---|---|---|
| `env-placeholders` warning | The host never exported a plugin-declared variable, so `plugin.json`'s `"${NAME}"` pass-through arrived as the literal string. The server discards these at startup and falls back to ADC. | If you meant to set the variable, put it in the `env` block of `~/.claude/settings.json`. Not a failure by itself. |
| `gemini-credentials` warning, nothing else set | No Gemini door open. Claude-only policies still run. | Either `gcloud auth application-default login`, or export `GEMINI_API_KEY`. |
| `gemini-credentials` warning, only `GOOGLE_CLOUD_PROJECT` set | A project ID is where to bill, not who is asking. Works inside Google Cloud (the metadata server supplies the credential); fails on a laptop. | Add a real credential: `gcloud auth application-default login`, or set `GOOGLE_APPLICATION_CREDENTIALS` to a complete service-account key. On a Cloud-hosted machine, settle for ~2¢ with `probe-agent-worker.mjs`. |
| `gemini-credentials-broken` (blocking) | `GOOGLE_APPLICATION_CREDENTIALS` points at a file that is missing, truncated, or has no recognizable `type` field. An explicit `GOOGLE_APPLICATION_CREDENTIALS` outranks the gcloud ADC file, so a broken one hides a working login. | Point it at a complete service-account key, or unset it and rely on `gcloud auth application-default login`. |
| Gemini call throws about `${GOOGLE_CLOUD_PROJECT}` as a project id | The variable arrived unexpanded and reached a code path that didn't strip it. Fixed in the current plugin version. | Update to the current plugin version. If it persists, file an issue with the `verify-setup.mjs` output. |
| Reported Gemini cost feels ~10% low | `GOOGLE_CLOUD_LOCATION` is a region name (anything other than `global`). Gemini Enterprise Agent Platform (formerly Vertex AI) bills regional endpoints +10% on Gemini 3+, effective 2026-07-01. | Expected: the plugin applies the surcharge to the reported cost automatically. Unset the variable to hit the flat global endpoint. |
| `GEMINI_BACKEND=<something>` throws | Only `vertex` and `api-key` are accepted. | Set one of those two, or unset it to let credentials decide. |

## Antigravity SDK (agent path)

| Symptom | Cause | Fix |
|---|---|---|
| `select-spec` (blocking) | `MMO_SELECT` is malformed. Commonest case: written as `flash-agsdk-worker` alone; the correct spelling is `gemini-flash=flash-agsdk-worker`. | Re-run `verify-setup.mjs --enable-agent` (writes it correctly) or `--disable-agent` (clears it). Do not edit by hand. |
| `agent-worker-credentials` (blocking) | `MMO_SELECT` selects the agent, but no Google Cloud credential is present. The Antigravity SDK is ADC-only; `GEMINI_API_KEY` cannot reach it. | `gcloud auth application-default login`. Or `verify-setup.mjs --disable-agent` to go back to the model path, which works with an AI Studio key. |
| `agent-worker-credentials-unproven` (warning) | Agent selected; only `GOOGLE_CLOUD_PROJECT` is set. Works inside Google Cloud, fails on a laptop. This state cannot be resolved offline. | Settle with `probe-agent-worker.mjs`. If it fails to authenticate, `gcloud auth application-default login`. |
| `agent-worker-python` (blocking) | Agent selected; no Python environment found. | Re-run `verify-setup.mjs --enable-agent` (or `--fix`, which builds the venv). Or set `GEMINI_WORKER_PYTHON` to a Python ≥3.10 with `google-antigravity` installed. Or `--disable-agent` to go back to the model path. |
| `agent-worker-sdk` (blocking) | Python environment exists but cannot import `google.antigravity`. Usually: the interpreter it was built against was upgraded or removed. | Re-run `verify-setup.mjs --fix` — it rebuilds with `venv --clear`, replacing the broken environment. |
| Delegated packet dies with a 403 | Billing project lacks the Antigravity / Model Garden entitlement. Not offline-checkable. | Request the entitlement in Google Cloud Console for the project. Verify with `probe-agent-worker.mjs`. |
| Delegated packet dies with a 404 | Resolved region doesn't serve `gemini-3.5-flash-lite`. | Unset `GOOGLE_CLOUD_LOCATION` to hit `global`, or pin a region that serves the model. |
| Delegated packet dies with a 401 | ADC file exists but the credential expired or was revoked. Not offline-checkable. | `gcloud auth application-default login`. |
| Report has no "Delegated to an agent worker" section on a run that should have delegated | The run did not go through the agent path. `MMO_SELECT` was missing, malformed, or applied only to a later session. | `verify-setup.mjs` should say why. Settings-file writes reach Claude Code only on the next session start. |

## Two Gemini doors — trade

The trade between the two doors is a token-volume trade at identical published rates. Same model, same bill, different session shape.

| | Model path | Agent path (Antigravity SDK) |
|---|---|---|
| One packet costs | one completion call | multiple tool-loop turns |
| Fixed per-turn overhead | none | ~11.5k tokens of SDK preamble every turn |
| Evidence on disk | telemetry event | telemetry event + task brief + worker sidecar + receipt |
| Fits in cache? | yes (explicit `cache_control`) | yes (implicit context caching does the heavy lifting) |

Recorded on the same brief: model path 43k / 34k tokens for $0.84 wall-clock 28 min; agent path 1.71M / 73k for $2.18 (of which 1.04M were cache reads), 63 min. Wall-clock includes four human approval gates, so it measures the reviewer as much as the pipeline. See the two runs under [../examples/quick-demo/passes/](../examples/quick-demo/passes/).

## Test run (codegen output)

| Symptom | Cause | Fix |
|---|---|---|
| Generated app fails to boot in tests with `Config validation error: "X" is required` | `.env.test` is missing keys the codegen's own `ConfigModule` demands. | Do not patch `.env` by hand — build a debug packet routed to `codegen` to add the keys with schema-valid values. See [plugin/skills/pipeline/SKILL.md](../plugin/skills/pipeline/SKILL.md). |
| Tests fail at load time on env vars, but `.env.test` looks complete | `.env.test` exists and `.env` does not — the orchestrator copies one to the other before `npm test`. If `.env` already existed it is not overwritten. | Delete a stale `.env`, or update it to match `.env.test`. |

## Policy

| Symptom | Cause | Fix |
|---|---|---|
| `/mmo:greenfield` or `/mmo:brownfield` refuses to start with "no default policy set" | `.sdlc/project.json` has no `default_policy` — either Skip was chosen at setup time, or the file has not been written yet. | `/mmo:policy change` (opens the browser console) or `/mmo:policy --policy=opus-plus-flash` (silent set). |
| `/mmo:policy` prints nothing / an empty line | Same as above — no policy set. | Same fix. |
| A one-off run needs a different policy | The setup-time default applies until changed. | Pass `--policy <name>` to `/mmo:pass`, or type a different policy at Gate 0 in `/mmo:brownfield`. Neither writes to `.sdlc/project.json`. |
| The browser opens but nothing happens after Save | The console watches `plugin/config/policies/` via `fs.watch`. If the save didn't land in that directory (older console versions), the script eventually times out at 10 minutes idle. | Update the plugin (`/plugin update` then `/mmo:setup`) and re-run `/mmo:policy change`. |

## Brownfield-specific

| Symptom | Cause | Fix |
|---|---|---|
| `/mmo:brownfield` refuses on a non-git folder | Brownfield requires a git repo — the write-contract and revert both need commit-level state. | `git init` first, or use `/mmo:greenfield` on an empty folder for greenfield. |
| Gate 0 shows constant off-limits paths you did not add | Setup wrote `off_limits_default` (`.env*`, `.mcp.json`, `node_modules/**`, etc.) to `.sdlc/project.json`. Gate 0 merges them with per-run additions before showing you the full list. | Expected. Edit `.sdlc/project.json.off_limits_default` if the project-wide default itself is wrong. |
| A write-contract PreToolUse hook blocked an expected write | A path outside the allowlist, or a path in off-limits. Hook is HARD-BLOCK by default. | Add the path at Gate 0's File-scope question, or re-run with `--strict-write=off` to downgrade to WARN (defeats the safety guarantee). |
| Want to undo the last brownfield run | Every brownfield run writes `provenance.json` under `.sdlc/runs/<run-id>/`. | `/mmo:revert` (interactive picker) or `/mmo:revert <run-id>`. |

## Repair after `/plugin update`

An update re-copies the plugin from source, which removes the `dist/` and `node_modules/` produced by `--fix`. Re-run:

```
/mmo:setup
```

Or, from a script:

```bash
node "$(ls -d ~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/scripts/verify-setup.mjs | tail -1)" --fix
```
