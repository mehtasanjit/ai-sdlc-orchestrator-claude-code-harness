# Architecture

> **For:** engineers who want to understand how a request flows through the plugin end to end. **Also see:** [methodology.md](methodology.md) · [two-gemini-paths.md](two-gemini-paths.md) · [running.md](running.md).

Reference for the pieces that make up the plugin, in the order a request flows through them: install surface, MCP server, routing, adapters, the two Gemini doors, the agent path, telemetry, auth modes, install routes.

## 1. Plugin surface

Claude Code loads the plugin from `plugin/.claude-plugin/plugin.json`. The manifest declares four things.

| Field | Value | Purpose |
|---|---|---|
| `commands` | `./commands` | Slash commands the plugin registers when a session starts. |
| `skills` | `./skills` | Skill files invocable via the `Skill` tool. |
| `mcpServers.model-dispatch` | stdio server at `${CLAUDE_PLUGIN_ROOT}/mcp/model-dispatch/bundle/server.mjs` (pre-built and committed, so an install from GitHub needs no build) | Owns every dispatch, credential probe, and telemetry write. |
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
| [plugin/hooks/hooks.json](../plugin/hooks/hooks.json) | `PreToolUse`: the write-contract check, the foreground rule for the pipeline's own helpers, and the executor guard. `PostToolUse`: the telemetry heartbeat on `execute_with_model` and the executor guard's record of `execute_stage` callers, each matching the MCP tool name under both install routes. The three that run a script with node go through [`plugin/hooks/node.sh`](../plugin/hooks/node.sh), which exits 0 quietly on a computer without Node.js and otherwise passes the script's output and exit code through. Nothing else: zero-touch's sixteen hooks are registered by the `zero-touch` plugin (`zero-touch/hooks/hooks.json`), which runs them in this folder through `plugin/hooks/ambient.sh`; they act only in a chat it marked. |
| [plugin/scripts/ambient/](../plugin/scripts/ambient/) · [zero-touch/](../zero-touch/) | Zero-touch ([ambient-mode.md](ambient-mode.md)). `zero-touch/` is the switch plugin: the settings box (the person chooses the mode and the models in Claude's question box, in the chat) and the start hook that marks each new chat with them. `plugin/scripts/ambient/hook.mjs` handles every other moment. Workflow mode starts a `/mmo:` workflow from a plain-words request, on the person's chosen policy, stamped as an explicit `policy_path` on every model-server call of that run (a project's `routing-policy.yaml` is not used for it); hand-off mode leaves development to the chat's own model and hands docs, tests and repeated edits to the server's hand-off tools (§2b). |
| [plugin/config/policies/](../plugin/config/policies/) | Shipped policy YAMLs. The directory listing is the authoritative preset set (`opus-plus-flash` is the default; the loader's not-found error prints the live list). |
| [plugin/policy-console/](../plugin/policy-console/) | Single-page HTML console + tiny http server, used at setup to pick or author the per-project policy. |
| `.sdlc/project.json` | Per-project state file. Fields: `default_policy` (name of the policy every run in this folder uses when `--policy` is not passed), `off_limits_default` (constant paths never touched by brownfield writes — merged with Gate 0 additions), `last_updated_at`, `schema_version: 2`. Written by `setup-policy.mjs` and consumed by every task command. |

The hook matcher is a regex because the plugin route namespaces MCP tools with the plugin name (`mcp__plugin_mmo_model-dispatch__execute_with_model`) while the clone route registers them bare (`mcp__model-dispatch__execute_with_model`). Both forms match.

## 2. MCP server

The bundled server exposes twelve tools over stdio: the five below, the three of the typed-spec executor (§2a), and zero-touch's four hand-off tools (§2b).

| Tool | Purpose |
|---|---|
| `execute_with_model` | Dispatch a TaskPacket to the model the policy names; return result + tokens + cost. |
| `simulate_policy` | Recompute cost from an existing telemetry stream against a different policy. No LLM call. |
| `log_telemetry` | Append a TelemetryEvent the orchestrator emitted itself (direct-tier). Server stamps `ts` and nulls `latency_ms`. |
| `preflight_dispatch` | Construct every adapter this run's auth mode will use, and price every model it can reach for today. Halts on an adapter that fails or a model with no price. No API call. Records the run's auth mode and policy for `execute_stage`; a new pre-flight opens a new run and is never refused for asking for other values. Takes `executor` (optional): `true` on a new-app run, whose Claude typing (the lean Opus last attempt included) runs through this machine's `claude` CLI, halts when that CLI is missing or its `--help` does not list `--tools`, `--append-system-prompt-file` and `--effort`; `false` (brownfield) skips the check; absent, the problem is a warning. The reply adds `executor` (`claude_typists`: the Claude models the executor would type with; `claude_cli`: `ok`, `not checked`, or what is wrong and how to fix it), `policy_notes` (how the executor reads the policy, below) and `run_card` (below; `settings_problems` lists a settings file that cannot be read or is not JSON, which never halts). |
| `load_policy` | Return the policy that would be active, each model with its `effective_price` for today: the list's rates, or the model's `pricing:` block only under `pricing_override: true`. The orchestrator prices its estimated events from it. No API call. |

Two files run before anything else:

| File | Role |
|---|---|
| [envBootstrap.ts](../plugin/mcp/model-dispatch/src/envBootstrap.ts) | Side-effect import. Must be first — deletes `PLUGIN_DECLARED_ENV` entries whose value is the literal `${NAME}` placeholder. ES module evaluation order is the only ordering guarantee that keeps this before third-party SDKs read `process.env`. |
| [env.ts](../plugin/mcp/model-dispatch/src/env.ts) | Pure helpers behind the bootstrap. Importable from tests without mutating the test runner's environment. |
| [preflight.ts](../plugin/mcp/model-dispatch/src/preflight.ts) | Auth-mode-aware reachability check. Under `vendor` every model is required; under `estimated` the in-session adapter (`builtin-anthropic`) is skipped. Its price gate (`checkModelPrice` in [effectivePrice.ts](../plugin/mcp/model-dispatch/src/effectivePrice.ts)) halts on any reachable model with no price, whatever the mode, and returns policy blocks that differ from the list as `price_warnings`. |

`preflight_dispatch` reports `not_selected` for policy leaves that lost a `select:` slot decision — their prerequisites (a Python venv, a worker script) are not this run's problem, and halting on them would be a false positive.

### 2a. The typed-spec executor (greenfield: `/mmo:greenfield` and `/mmo:pass`)

The architect hands the build over as a typed spec, and code types, checks and writes every file. The same flow runs for every policy; a solo policy and a multi-model policy differ only in which typist types each file.

| Tool | Purpose |
|---|---|
| `submit_spec_section` | Takes one section of the typed spec: the header (stack, commands, decisions, shared data model and API), then units in batches. Each section is a JSON file the architect writes with the Write tool under the output directory (`spec.sections/header.json`, then `units-001.json`, ...), never inline in the tool call, where a large JSON argument can reach the tool unparseable and be discarded whole. A file that is not valid JSON is refused with the parser's line, column and text (and the line before), so the architect fixes that spot with Edit. Each section is checked on arrival (strict schema; unique ids and paths; `depends_on` / `style_from` point to earlier units); a refused section stores nothing and lists every problem by path. The tool's description carries the exact shape of both files, rendered from the schemas by code (`shapeOf` in `src/spec/schema.ts`), so what the architect reads is what the check enforces. A header sent after `finalize_spec`, or from a new run (a new `preflight_dispatch`), starts a new spec: the earlier spec's records (`spec.parts/`, `spec.json`, `design.md`, `acceptance*`, `verify/`, `written-files.json`, `shared-brief.txt`) move to `<spec_dir>/previous/<time>/` (the reply's `previous` names the folder), nothing is deleted, and the whole spec is sent again. |
| `finalize_spec` | Assembles `spec.json`, checks every FR- and AC- requirement is covered by a unit, and renders `design.md` from the spec by code. Refuses a spec whose acceptance list leaves an AC criterion without a command or a reason, or names no dependency audit (or a reason for none). |
| `execute_stage` | Runs one stage and returns one compact receipt (≤ 2 kB as sent), with MCP progress messages while it runs. `codegen`, `tests` and `docs` type every unit of that stage. `repair` types every fix of a repair round: the files named in a failing test run, and every finding of the senior reviewer's review.json that names a file. `acceptance` runs the acceptance list (below). |

**The spec.** Every unit states its `import_line`: the exact line another file writes to import it, in the project's own language, empty when nothing imports it. Code carries it into the file's own brief, every dependent's brief, the shared file index and design.md, so files typed apart agree on how they connect; code never parses it. A unit carries no file-type label (an optional free-text `kind` goes to the design table only). No size is bounded in code: `approx_lines` is an estimate, and a call carries as many units as the architect writes in one reply (the architect keeps a one-hour prompt cache, like the orchestrator). The architect's shell is for looking things up, such as a package registry: it never installs anything and never writes into the code directory. The architect takes the fixed stack from the brief and chooses the rest; the acceptance stage checks the result, and an install or audit failure comes back to it.

**Typing and fixes.**

| Rule | What happens |
|---|---|
| Who types a file | The typist the policy routes the job's stage to, at `retry_count` 0 and 1, then one lean Opus attempt when the policy has a Claude model. Routing is by stage and retry count alone, so who types a file never depends on its language, name or kind. A stage with a rule of its own (the stage, and no `task_type`, `module` or `intent`) is routed by it, and narrower rules for that stage are set aside. A stage routed only by narrower rules is routed by them read by stage alone, the first one listed first. A rule that names a `task_type` or `module` and no stage is set aside. A policy with no default rule gets one for any stage no rule routes: its first Claude model, else its first model, through the `select` slot that offers it. `policy_notes` names each rule read this way by its place in the file, counted from 1, in the `preflight_dispatch` reply and the run's first `execute_stage` receipt. The lean Opus last attempt follows the run's `select` choice: a Claude model the run did not select is never used. |
| The typists | `lean-opus`: a `claude -p` call with no tools, low effort, and the shared spec as its cached system-prompt tail. `flash-completion`: Gemini through the completion door. `agy`: Gemini through the Antigravity SDK, configured as a typist (`worker/typist_worker.py`). A cold lean Opus typist sends one job alone before fanning out. |
| Fixes | Routed as phase `debug` and answered with exact edits to the file's current text: each search must match exactly once, overlapping matches counted, or nothing changes. A fix's file is placed only on a real file under the code directory or a file of the spec. A reviewer's project-root path such as `src/x.py` is placed by dropping the code directory's own folder; anything else is reported as `not_routed`, never guessed. |
| New files | A test-run failure that needs a file that does not exist yet carries `new_file: true` and a path relative to the code directory; the file is typed whole and held to the same checks as every file. A review finding that needs one comes back in `not_routed` saying so. The receipt lists `created`. |
| Checks on an answer | An answer is refused only when it is wrong in any language: it names another path, the path is unsafe (not a relative path inside the code directory), or it is empty. No file is parsed, so no language gets a stronger or weaker check and no parser needs installing. Whether a file is right, its syntax as much as its behavior, is judged by the project's own build and tests and the repair rounds. Writes are checked on real paths, so a symlinked folder cannot carry a file out of the code directory. |
| Vendor and network failures | Read from the vendor's structured fields. They wait with jittered backoff capped at one 60 s rate-limit window; a longer requested pause is an attempt, taken after one full window; anything else is an attempt. A door that refuses the login or permission (HTTP 401/403) stops the stage (`stopped` in the receipt, returned as an error) instead of handing its files to another typist. |
| Output limit | An answer that stopped at a typist's output limit (the vendor's own stop reason: Gemini `MAX_TOKENS`, Anthropic `max_tokens`) is never retried by the same typist: the file goes to the next typist in its plan, and fails with that reason when none is left. |
| Time limit | Every typist call has the same stated limit, 540 s. The agent door hands the executor's retry count and first wait to the Antigravity SDK's own API retry (6 retries, 2 s doubling to 64 s, without jitter: the SDK does not document its jitter setting's units). |
| Run state | The auth mode and policy come from the run state `preflight_dispatch` recorded, never from the call. The first stage of a spec binds them; a later stage of the same spec whose latest pre-flight asked for different ones stops (`stopped` in the receipt) and types nothing. Another spec binds its own, so two separate `/mmo:` runs in one chat may use different policies. |
| Billing | Typing is billed to `telemetry_path`, else the pass folder's `telemetry.jsonl`: one telemetry event per typist call. |

**Tests and fixes.** After the tests stage the orchestrator runs the spec's install and check commands itself, reads what fails, and sends each file to change to `execute_stage` `repair` (`failures`: the file, the failing test and its error, the files to show beside it); the typist the policy's `debug` rule names makes the fix as exact edits. It repeats while the number of failing tests goes down, at most three repair rounds, and runs the checks once more after the senior review's repair round. The executor guard keeps it from starting other helpers to diagnose and from writing a project file itself; what still fails is reported at the next gate.

**The acceptance stage** (`stage: "acceptance"`) types nothing and needs no pre-flight:

- Code runs every command of the spec's acceptance list (`commands`: the install, the dependency audit, the checks) in order, each in its folder under the code directory, with the model vendors' credentials removed from its environment, its whole output written to a log file, and the time limit the plan states for it (`timeout_s`; no limit lives in code).
- It judges each command by its pass rule (an exit code, and output lines the brief forbids, matched by prefix without regard to case), marks every acceptance criterion pass, fail or not checked, and writes `acceptance.json` and `acceptance.md` beside spec.json.
- A command the machine cannot run (its program not found, exit 127; stopped at its time limit; or no limit stated) is `not_run`: its criteria are not checked, with that reason, and it is routed nowhere. An install that does not finish stops the commands after it; when the install itself could not run, those are not checked too.
- Each failure names its route: `architect` for an install or audit (a version choice), `repair` for a failing check.
- The stage runs at most once plus three re-checks per spec; a further call runs nothing.
- The collector copies `acceptance.md` into SUMMARY.md between `<!-- acceptance:start -->` and `<!-- acceptance:end -->` on every run, so the report's acceptance table is code's.

Code: [src/spec/](../plugin/mcp/model-dispatch/src/spec/) (schema, hand-over, rendering) and [src/executor/](../plugin/mcp/model-dispatch/src/executor/) (briefs, typists, checks, the stage runner, the acceptance stage, the tool handlers).

### 2b. Zero-touch's hand-off tools (a chat in hand-off mode)

In hand-off mode the chat's own model does the development and hands over only work that is mostly typing and that code can check. The four tools are listed only where a Hand-off chat can use them (zero-touch installed and switched on, its saved mode Hand-off or not chosen yet; listed when in doubt; added while the server runs if the mode becomes Hand-off: `handoff/listing.ts`); a call works only when zero-touch's hook stamped it (`_mmo`: the chat, the project folder, who pays for a Claude typist) in a hand-off chat, and never inside a workflow run. The typist for each kind of work and the chat's model come from the chat's own records, written once at its start from the person's settings, so nothing the model writes in a call can choose them. Work the person keeps in the chat is refused before it reaches the server. Full description: [ambient-mode.md](ambient-mode.md), "Hand-off mode".

| Tool | Purpose |
|---|---|
| `write_document` | A new document, spec or plan, from a form: purpose, readers, sections, and facts each tied to a project file by a quote found in it word for word (or to the chat). The answer is refused when a listed section has no heading, a shell command is not among the facts, or a project path or relative link leads nowhere. |
| `write_tests_from_cases` | A new test file, from named cases (`given`, `expect`) for functions of one target file. Every case must appear by name; the file is then run with the form's test command in a scratch copy of the project, and only a file whose tests pass is written. A case's expected result is never changed to make a test pass. |
| `repeat_edit_across_files` | One change, already made by hand in an example file, repeated in the target files as exact edits. Each edit must apply exactly once and may remove only lines the change is about; the optional check command runs in the scratch copy before anything lands. |
| `undo_hand_off` | Takes one landing back by its id: a changed file gets its earlier text, a created file is removed. A file changed since is left alone and named. |

| What | Rule |
|---|---|
| Who types | The executor's typists and its ladder: two attempts by the typist the person chose for that kind of work (Flash 3.8 or Sonnet 5: the model the shipped policy `opus-plus-flash-v38` or `opus-plus-sonnet` routes that stage to, `docs`, `tests` or `codegen`), then one by the chat's own model through the Claude command line (the policy's Claude model when the chat has no one model). |
| Where a command runs | A scratch copy of the project (`handoff/scratch.ts`): the project's own files copied as they are on disk, what git ignores linked in. A project that is not a git repository gets no copy, and the hand-off is refused. |
| What is recorded | Under `~/.mmo-ambient/sessions/<id>/`: one telemetry line per typist call (`handoff-telemetry.jsonl`), every landing with what each file held before (`handoff_landings.json`, `handoff_undo/`), and the files a failed hand-off handed back to the chat's model (`handoff_released.json`). Nothing is written into a run folder: a hand-off belongs to the chat, not to a run. |

Code: `plugin/mcp/model-dispatch/src/handoff/`. Tests: `test/handoffDocument.test.mjs`, `test/handoffScratch.test.mjs`, `test/handoffTestsAndEdits.test.mjs`, `test/toolList.test.mjs`.

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
| `rules[].when` | `{phase, task_type?, module?, retry_count?}` | Ordered matcher. First match wins. The shipped policies match on phase and retry count only, so who types a file never depends on its language or type; the executor reads a rule for one of its stages by `phase` and `retry_count` alone (see *Who types a file*). |
| `rules[].use` | model id **or** slot name | A slot resolves through `select` at routing time, not policy-load time. |
| `rules[].default` | model id or slot | Fell-through terminal rule. |
| `hard_cost_cap_usd` | not used | Set aside at load with a `policy.setting_ignored` warning, so no tool reply shows it: no cost cap exists, and a chat that read one took it for a real limit. |

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
| [GeminiFlashAdapter.ts](../plugin/mcp/model-dispatch/src/adapters/GeminiFlashAdapter.ts) | `GeminiFlashAdapter` | Gemini as a model, via `@google/genai`. Delegates transport to §5. Sends the leaf's `reasoning.tier` as `thinkingConfig.thinkingLevel` (none when the leaf sets no tier). |
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
| Plugin (default) | Two-prompt flow → [SETUP.md](../SETUP.md) → `/plugin install` → `verify-setup.mjs` | `plugin/` under `~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/`. The MCP server ships pre-built (`mcp/model-dispatch/bundle/server.mjs` and `bundle/lib.mjs`, tracked in git); its `dist/` and `node_modules/` are only for developing it, and `--fix` builds them in a clone. |
| Clone | `git clone` → [tools/setup.mjs](../tools/setup.mjs) | The full repo, plus a project-level `.mcp.json` that registers the built server directly. |

`.mcp.json` on the clone route holds an exhaustive `env` block, because a stdio MCP server inherits nothing from its parent. `verify-setup.mjs --enable-agent` writes the `MMO_SELECT` selection into both `.claude/settings.local.json` (read by Claude Code) and `.mcp.json` (read by the server); a settings-only write would be dropped at the server boundary.

`plugin/examples/` duplicates `examples/` so the shipped briefs are reachable from an installed plugin, which has no repo checkout beside it.
