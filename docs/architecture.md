# Architecture

> **For:** engineers who want to understand how a request flows through the plugin end to end. **Also see:** [methodology.md](methodology.md) · [two-gemini-paths.md](two-gemini-paths.md) · [running.md](running.md).

Reference for the pieces that make up the plugin, in the order a request flows through them: install surface, MCP server, routing, adapters, the two Gemini doors, the agent path, telemetry, auth modes, install routes.

## 1. Plugin surface

Claude Code loads the plugin from `plugin/.claude-plugin/plugin.json`. The manifest declares four things.

| Field | Value | Purpose |
|---|---|---|
| `commands` | `./commands` | Slash commands the plugin registers when a session starts. |
| `skills` | `./skills` | Skill files invocable via the `Skill` tool. |
| `mcpServers.model-dispatch` | stdio server at `${CLAUDE_PLUGIN_ROOT}/mcp/model-dispatch/dist/server.js` | Owns every dispatch, credential probe, and telemetry write. |
| `mcpServers.model-dispatch.env` | 9 pass-through vars, incl. the deprecated `SDLC_SELECT` (MMO-D8 compat shim) | Values arrive as `${NAME}` placeholders when the host never set them. See §2. |

Additional plugin content:

| Path | Contents |
|---|---|
| [plugin/agents/](../plugin/agents/) | Subagents: `orchestrator`, `architect`, `senior-reviewer`, `security-reviewer`, `discovery` (brownfield only). |
| [plugin/commands/greenfield.md](../plugin/commands/greenfield.md) | Greenfield two-prompt-flow entry point. Takes no arguments; asks for what it needs. |
| [plugin/commands/pass.md](../plugin/commands/pass.md) | Every setting as a flag; the form used for scripting and repeat runs. Covers both greenfield and brownfield via `--mode=`. |
| [plugin/commands/brownfield.md](../plugin/commands/brownfield.md) | Brownfield two-prompt-flow entry point. Picks an intent, adds Gate 0. Thin caller into `brownfield-guide/SKILL.md` with no handover set. |
| [plugin/commands/{bugfix,docs,feature-extend,feature-new,refactor,test,deps}.md](../plugin/commands/) | Seven aliases into brownfield with the job type pre-selected via the handover — see `plugin/config/intents.json` and `intent-commands.test.mjs`. |
| [plugin/commands/revert.md](../plugin/commands/revert.md) | Reverts a brownfield run using `.sdlc/runs/<run-id>/provenance.json`. |
| [plugin/commands/setup.md](../plugin/commands/setup.md) | Re-verify or re-configure the plugin for this project. Wraps `verify-setup.mjs` and `setup-policy.mjs`. |
| [plugin/commands/policy.md](../plugin/commands/policy.md) | Show the active policy; `change` opens the browser console. |
| [plugin/config/intents.json](../plugin/config/intents.json) | The seven-intent registry — id, title, example, argument hint, summary, interview questions. Single source for the job commands, the interview, and this table's own accuracy. |
| [plugin/skills/pipeline/](../plugin/skills/pipeline/) | Skill body loaded by the orchestrator. |
| [plugin/skills/brownfield-guide/](../plugin/skills/brownfield-guide/) | The shared seven-step brownfield manual. Every brownfield entry point (`brownfield.md` and the seven job commands) points here; step 4 branches on the `intent` / `seed_description` handover. |
| [plugin/hooks/hooks.json](../plugin/hooks/hooks.json) | `PostToolUse` hook matching the MCP tool name under both install routes. |
| [plugin/config/policies/](../plugin/config/policies/) | Shipped policy YAMLs. The directory listing is the authoritative preset set (`opus-plus-flash` is the default; the loader's not-found error prints the live list). |
| [plugin/policy-console/](../plugin/policy-console/) | Single-page HTML console + tiny http server, used at setup to pick or author the per-project policy. |
| `.sdlc/project.json` | Per-project state file. Fields: `default_policy` (name of the policy every run in this folder uses when `--policy` is not passed), `off_limits_default` (constant paths never touched by brownfield writes — merged with Gate 0 additions), `last_updated_at`, `schema_version: 2`. Written by `setup-policy.mjs` and consumed by every task command. |

The hook matcher is a regex because the plugin route namespaces MCP tools with the plugin name (`mcp__plugin_mmo_model-dispatch__execute_with_model`) while the clone route registers them bare (`mcp__model-dispatch__execute_with_model`). Both forms match.

## 2. MCP server

The bundled server exposes five tools over stdio.

| Tool | Purpose |
|---|---|
| `execute_with_model` | Dispatch a TaskPacket to the model the policy names; return result + tokens + cost. |
| `simulate_policy` | Recompute cost from an existing telemetry stream against a different policy. No LLM call. |
| `log_telemetry` | Append a TelemetryEvent the orchestrator emitted itself (direct-tier). Server stamps `ts` and nulls `latency_ms`. |
| `preflight_dispatch` | Construct every adapter this run's auth mode will use, and price every model it can reach for today. Halts on an adapter that fails or a model with no price. No API call. |
| `load_policy` | Return the policy that would be active, each model with its `effective_price` for today: the list's rates, or the model's `pricing:` block only under `pricing_override: true`. The orchestrator prices its estimated events from it. No API call. |

Two files run before anything else:

| File | Role |
|---|---|
| [envBootstrap.ts](../plugin/mcp/model-dispatch/src/envBootstrap.ts) | Side-effect import. Must be first — deletes `PLUGIN_DECLARED_ENV` entries whose value is the literal `${NAME}` placeholder. ES module evaluation order is the only ordering guarantee that keeps this before third-party SDKs read `process.env`. |
| [env.ts](../plugin/mcp/model-dispatch/src/env.ts) | Pure helpers behind the bootstrap. Importable from tests without mutating the test runner's environment. |
| [preflight.ts](../plugin/mcp/model-dispatch/src/preflight.ts) | Auth-mode-aware reachability check. Under `vendor` every model is required; under `estimated` the in-session adapter (`builtin-anthropic`) is skipped. Its price gate (`checkModelPrice` in [effectivePrice.ts](../plugin/mcp/model-dispatch/src/effectivePrice.ts)) halts on any reachable model with no price, whatever the mode, and returns policy blocks that differ from the list as `price_warnings`. |

`preflight_dispatch` reports `not_selected` for policy leaves that lost a `select:` slot decision — their prerequisites (a Python venv, a worker script) are not this run's problem, and halting on them would be a false positive.

## 3. Routing

Policies live under [plugin/config/policies/](../plugin/config/policies/) as YAML. Each declares models, optional `select:` slots, and ordered rules.

| Field | Shape | Notes |
|---|---|---|
| `models[].id` | string | Referenced by rules and by `MMO_SELECT`. |
| `models[].adapter` | `builtin-anthropic` \| `claude-cli` \| `mcp:model-dispatch` \| `antigravity-worker` | Selects the adapter class. |
| `models[].pricing` | `{input, input_cached, output, input_cache_write?, input_cache_write_1h?}` USD per 1M; optional | Not what a dispatch bills by default: adapters price from [prices.ts](../plugin/mcp/model-dispatch/src/prices.ts) through [effectivePrice.ts](../plugin/mcp/model-dispatch/src/effectivePrice.ts), and a block more than 0.5% off the list is ignored with a warning. Otherwise it is documentation: the orchestrator's estimated telemetry reads `effective_price` from `load_policy`, not the block. A shipped block must still equal the model's list period for today's date (`test/prices.test.mjs` fails otherwise). Flat global/AI-Studio rates; the Vertex regional surcharge is applied at dispatch, not written in the file. |
| `models[].pricing_override` | boolean; optional | `true` bills `pricing` instead of the list for this leaf's own model; its events say `price_basis: "custom"`. Refused at load without a block. |
| `models[].pricing_source`, `pricing_last_verified` | URL, ISO date | Vendor page and last verify date. |
| `models[].max_output_tokens_absolute` | number | Doubling-loop clamp for completion adapters. Absent on `antigravity-worker`. |
| `select.<slot>.default` | model id | Used when no `MMO_SELECT` names this slot. |
| `select.<slot>.options` | model id[] | The vetted set the run may pick from. |
| `rules[].when` | `{phase, task_type?, module?, retry_count?}` | Ordered matcher. First match wins. |
| `rules[].use` | model id **or** slot name | A slot resolves through `select` at routing time, not policy-load time. |
| `rules[].default` | model id or slot | Fell-through terminal rule. |

`MMO_SELECT` is spelled `slot=option[,slot=option...]`. Parsing lives in [routing.ts](../plugin/mcp/model-dispatch/src/routing.ts) (`parseSelectOverrides`) and is duplicated in [verify-setup.mjs](../plugin/scripts/verify-setup.mjs) (`parseSelectSpec`), which cannot import TypeScript. Both refuse malformed specs. `unreachableModelIds` excludes losing options from pre-flight without dropping ones a rule names directly.

Two pre-rename spellings still work, each warning once to stderr instead of failing (MMO-D8): the env var `SDLC_SELECT` (read when `MMO_SELECT` is unset) and the adapter id `mcp:gemini-flash-server` (accepted anywhere `mcp:model-dispatch` is).

`simulate_policy` replays events against a different policy using the current run's slot choices, so a what-if on a slotted policy prices the tier this install would actually dispatch to. It takes the same policy arguments as its siblings — `policy_name`, `project_root`, `policy_path` — and resolves them through the same loader, so a project with a repo-local `routing-policy.yaml` simulates against the policy its runs actually use (the handler used to drop `project_root`, silently pricing the shipped preset instead). Replayed events are priced by the same effective price and `computeCostUsd` the live path uses, on the day in each event's `ts`, and a Gemini event adds the +10% Vertex regional surcharge the adapters bill at the endpoint this server would dispatch it to (a worker leaf's `region:`, else `GOOGLE_CLOUD_LOCATION`; none through an AI Studio key, at `global`, or on a day before 2026-07-01; the rules live in [geminiEndpoint.ts](../plugin/mcp/model-dispatch/src/adapters/geminiEndpoint.ts)), so a what-if run in the run's own Gemini environment agrees with the dollars the run logged for the same tokens; events the list cannot price are left out of the total and listed under `unpriced`. `input_tokens` is already the fresh count, and `input_tokens_cache_write_1h` is read as the 1-hour share of `input_tokens_cache_write`, the way both producers of that field write it (reading it as a separate count priced those writes twice). It used to subtract `input_tokens_cached` from `input_tokens` before pricing — a second subtraction that under-priced every cache-hit event and sent cache-heavy replays negative — and it never priced the 1-hour cache-write tier.

## 4. Adapters

One interface, four implementations, plus a factory.

| File | Adapter class | Model tier |
|---|---|---|
| [ModelAdapter.ts](../plugin/mcp/model-dispatch/src/adapters/ModelAdapter.ts) | interface | — |
| [BuiltinAnthropicAdapter.ts](../plugin/mcp/model-dispatch/src/adapters/BuiltinAnthropicAdapter.ts) | `BuiltinAnthropicAdapter` | Anthropic direct SDK. Under `vendor`, dispatched here; under `estimated`, never constructed. |
| [ClaudeCliAdapter.ts](../plugin/mcp/model-dispatch/src/adapters/ClaudeCliAdapter.ts) | `ClaudeCliAdapter` | Claude through a local `claude -p` subprocess on the subscription's OAuth session. Priced per model from its result's token ledger ([claudeCliLedger.ts](../plugin/mcp/model-dispatch/src/adapters/claudeCliLedger.ts)); the CLI's own `total_cost_usd` is kept only as a check. |
| [GeminiFlashAdapter.ts](../plugin/mcp/model-dispatch/src/adapters/GeminiFlashAdapter.ts) | `GeminiFlashAdapter` | Gemini as a model, via `@google/genai`. Delegates transport to §5. |
| [AntigravityWorkerAdapter.ts](../plugin/mcp/model-dispatch/src/adapters/AntigravityWorkerAdapter.ts) | `AntigravityWorkerAdapter` | Gemini as an agent. Launches the Python worker. See §6. |
| [index.ts](../plugin/mcp/model-dispatch/src/adapters/index.ts) | `createAdapter(model)` | Factory keyed on `model.adapter`. |
| [pricing.ts](../plugin/mcp/model-dispatch/src/pricing.ts) | — | `computeCostUsd(tokens, pricing)` on disjoint cached/fresh counts. |
| [prices.ts](../plugin/mcp/model-dispatch/src/prices.ts) | — | Dated price list. `resolveModel(name)` and `lookupPrice(name, date, modifiers)`; an unknown model, a date outside every period, or a modifier with no price returns `unpriced`, never a borrowed rate. |
| [effectivePrice.ts](../plugin/mcp/model-dispatch/src/effectivePrice.ts) | — | `effectivePrice(model, date, modifiers)`: the list price, the policy block under `pricing_override: true` (basis `custom`), or `unpriced`; a block more than 0.5% off the list comes back as a warning naming both. `checkModelPrice` is pre-flight's price gate. |
| [dispatchPricer.ts](../plugin/mcp/model-dispatch/src/adapters/dispatchPricer.ts) | — | Per-adapter wrapper: the dispatch-date clock, and `pricing.*` log lines (a mismatch once per adapter, an unpriced result every time). |

The two completion adapters share an **output-cap doubling loop**: on a vendor `max_tokens` signal, retry with `2×` the previous ceiling, up to 3 doublings or `max_output_tokens_absolute`. Every attempt emits its own TelemetryEvent with `attempt_number` and `ceiling_used`, all sharing the packet's `task_id`. The agent adapter has no such loop — an agent session sets its own per-turn limits and a retry would be a fresh, fully-billed session.

## 5. The two Gemini doors

Both live in [geminiTransports.ts](../plugin/mcp/model-dispatch/src/adapters/geminiTransports.ts) and run on `@google/genai`. They differ only in how a request is signed and which endpoint receives it.

| Door | Backend name | Auth | Env-var trigger |
|---|---|---|---|
| AI Studio | `api-key` | API key in an env var | `GEMINI_API_KEY` |
| Gemini Enterprise Agent Platform, formerly Vertex AI (ADC) | `vertex-adc` | Application Default Credentials | ADC file, `GOOGLE_APPLICATION_CREDENTIALS`, or `GOOGLE_CLOUD_PROJECT` |

`selectGeminiBackend` precedence (pure function; unit-tested):

1. `GEMINI_BACKEND=vertex|api-key` — explicit override.
2. Policy's key env var is set → `api-key`. A key is a deliberate local choice; ADC is often ambient machine state.
3. Any Vertex signal (`GOOGLE_APPLICATION_CREDENTIALS`, ADC file, or `GOOGLE_CLOUD_PROJECT`) → `vertex-adc`.
4. Nothing → throw, naming both doors.

**Regional surcharge.** `GOOGLE_CLOUD_LOCATION` defaults to `global`. The platform bills non-global endpoints **+10%** on every token class for Gemini 3 and later, effective 2026-07-01. `applyVertexSurcharge` multiplies the dispatch's effective rates (the dated price list, or the policy block under `pricing_override: true`) at dispatch when the backend is `vertex-adc`, the location is not `global`, and the model family is `gemini-3+`. The `flash-agsdk-worker` leaf in `opus-plus-flash.yaml` deliberately does not pin `region:`, so both leaves follow the same env var and both hit the flat global endpoint by default.

**Billed output tokens.** `billedOutputTokens(usage) = candidatesTokenCount + thoughtsTokenCount`. Gemini 3.x reports reasoning tokens in `thoughtsTokenCount` — a sibling of the candidate count, billed at the output rate. `cachedContentTokenCount`, by contrast, is a subset of `promptTokenCount` and is subtracted before pricing. Getting either wrong moves the headline number.

## 6. Agent path (Antigravity SDK)

Selecting this path routes the mechanical tier to `flash-agsdk-worker`.

| Piece | File / detail |
|---|---|
| Adapter | [AntigravityWorkerAdapter.ts](../plugin/mcp/model-dispatch/src/adapters/AntigravityWorkerAdapter.ts) |
| Worker | [worker/gemini_worker.py](../plugin/mcp/model-dispatch/worker/gemini_worker.py) — Python 3.10+, `google-antigravity` |
| Auth | Application Default Credentials only. No API-key branch. |
| Timeout | `worker_timeout_sec: 540` in the policy YAML — 9 minutes, then the process group is killed. |
| Interpreter resolution | `resolveWorkerPython`: `GEMINI_WORKER_PYTHON` override, else the plugin-built venv at `plugin/mcp/model-dispatch/worker/.venv/bin/python`. |
| Delegation records | [evidence.ts](../plugin/mcp/model-dispatch/src/delegation/evidence.ts) — three files per packet (task brief, worker usage sidecar, receipt). |

For each delegated packet the server takes an inventory of the working directory before and after the worker runs. The diff (added / modified / removed) lands on the receipt; it establishes what changed while the worker held the directory, not who wrote each byte.

Session state is written by the SDK as opaque SQLite containing absolute local paths and is excluded from published evidence. The JSON delegation record and usage sidecar carry everything an auditor needs.

## 7. Telemetry

One JSON object per LLM call, appended to `<pass-dir>/telemetry.jsonl`. `manifest.json` is a rollup derived from it.

| Field | Notes |
|---|---|
| `ts` | ISO timestamp. Stamped server-side for `execute_with_model` and re-stamped by `normalizeDirectTierEvent` for `log_telemetry` events (a model has no clock). |
| `phase`, `task_type`, `task_id`, `module` | Join keys back to the TaskPacket. |
| `model` | Vendor's model name. Same across both Gemini doors. |
| `model_id` | Policy leaf that dispatched: `opus` / `flash-completion` / `flash-agsdk-worker`. The only field that distinguishes the two Gemini doors. |
| `input_tokens`, `input_tokens_cached`, `output_tokens` | Vendor-reported under `vendor`; char-count-estimated under `estimated`. |
| `output_tokens_reasoning` | Gemini only; already counted in `output_tokens`. Absent on adapters that do not report it (JSON.stringify drops undefined). |
| `cost_usd` | Dispatched events: `(tokens × effective price) / 1M`, the dated price list or the policy block under `pricing_override`. Estimated events: `(tokens × effective_price.rates from load_policy) / 1M`, the same effective price. Cached fraction subtracted before pricing. Vertex regional surcharge applied at dispatch. |
| `input_tokens_cache_write`, `input_tokens_cache_write_1h` | Total cache writes, and the 1-hour share of them when known (`claude-cli` workers, the collector's orchestrator line). |
| `price_basis` | `list` or `custom` (policy block under `pricing_override: true`). Absent on direct-tier events. |
| `unpriced_models` | `[{model, reason}]` for billed models with no price; their tokens are not in `cost_usd`. Absent when everything was priced. |
| `cli_reported_cost_usd`, `ttl_split` | `claude-cli` only: Claude Code's own dollars (a check, never the cost), and whether the 5-minute / 1-hour split came from the worker's transcript (`transcript`), was not fully explained by it (`approximate`: the result's top-level `usage` split, taken only by the one model whose four counts equal it, and the 5-minute rate for any other model's writes no transcript line explains, noted in `per_model[].assumed`), or was not needed (`no_cache_writes`). |
| `transcript_logged_cost_usd` | `claude-cli` only, when the worker's transcript was read: the share of `cost_usd` for the tokens that transcript explains. The rest is what the result billed that no transcript line logged (side calls, unlogged tokens). The collector subtracts only this share of a worker its scan swept in, so the rest stays in the true total. |
| `attempt_number`, `ceiling_used`, `retry_reason` | Doubling-loop attempts share a `task_id`. |
| `routing.select` | `{slot, chosen, overridden}` when the matched rule went through a slot. Absent on unslotted policies. |
| `latency_ms` | `null` for direct-tier events (the server never saw the call). Real ms for MCP-dispatched calls. |

`buildManifest` sorts by `ts`, derives `started_at` / `ended_at` / `duration_sec`, and rolls up per-model, per-phase, per-module, per-task-type. The `PostToolUse` hook writes `.hook-logs/hook.jsonl` — one line per MCP call, size + timestamp — as an independent cross-check.

## 8. Auth modes

Chosen per run. `/mmo:greenfield` asks; `/mmo:pass --auth=<mode>` requires the flag.

| Mode | Billed to | Every event | Direct-tier tokens | Mechanical-tier tokens |
|---|---|---|---|---|
| `vendor` | Anthropic API key + Google (Gemini calls) | dispatched through the MCP server | vendor-reported | vendor-reported |
| `estimated` | Claude Code subscription (direct-tier) + Google (Gemini) | mixed | char/3.8 heuristic, `latency_ms: null` | vendor-reported |

Under `estimated` the orchestrator runs the direct tier inside the Claude Code loop, where per-call `usage` is not visible. The report labels it "Estimator mode" and marks affected phases with `E`. Totals will not match a vendor-billed run exactly.

`preflight_dispatch` respects the mode: under `estimated`, an unset `ANTHROPIC_API_KEY` is a warning, not a halt. Its price gate does not depend on the mode: a reachable model with no price halts either way. The orchestrator's estimates read each model's `effective_price` from `load_policy`, so an in-session model needs no `pricing:` block.

## 9. Install routes

Two ways in. Both end up running the same MCP server.

| Route | Entry | What arrives |
|---|---|---|
| Plugin (default) | Two-prompt flow → [SETUP.md](../SETUP.md) → `/plugin install` → `verify-setup.mjs --fix` | `plugin/` under `~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/`. The MCP server's `dist/` and `node_modules/` are not tracked in git; `--fix` builds them. |
| Clone | `git clone` → [tools/setup.mjs](../tools/setup.mjs) | The full repo, plus a project-level `.mcp.json` that registers the built server directly. |

`.mcp.json` on the clone route holds an exhaustive `env` block, because a stdio MCP server inherits nothing from its parent. `verify-setup.mjs --enable-agent` writes the `MMO_SELECT` selection into both `.claude/settings.local.json` (read by Claude Code) and `.mcp.json` (read by the server); a settings-only write would be dropped at the server boundary.

`plugin/examples/` duplicates `examples/` so the shipped briefs are reachable from an installed plugin, which has no repo checkout beside it.
