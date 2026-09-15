# Understanding the output

> **For:** reading `telemetry.jsonl`, `manifest.json`, `provenance.json`, and the cost report. **Also see:** [methodology.md](methodology.md) · [running.md](running.md).

After a pass finishes, three things live under the run's output directory — `examples/<study-id>/passes/<run-id>/` for greenfield (`/mmo:pass`, `/mmo:greenfield`), `.sdlc/runs/<YYYYMMDD-HHMMSS>-<intent>-<slug>/` for brownfield (`/mmo:brownfield`, `/mmo:pass --mode=brownfield`):

- `telemetry.jsonl` — one JSON object per line, one line per LLM call. The raw data.
- `manifest.json` — a rollup of the telemetry into totals, per-phase breakdown, and metadata.
- `orchestrator.log` — the `MMO:`-prefixed event trace: phase and gate boundaries, subagent hand-offs, routing decisions, dispatch summaries. Not cost data — see [logging.md](logging.md) and [methodology.md](methodology.md#the-mmo-log-stream-is-not-telemetry) for how it differs from `telemetry.jsonl`.
- Generated source under `app/` (greenfield) or the files named at Gate 0 (brownfield) — the actual code the run produced.

A fourth appears only on runs that delegated to the agent worker — installs that chose the agent path, via `--enable-agent` on the verify script or the wizard's question ([setup.md](setup.md#gemini-as-an-agent--antigravity-sdk)):

- `delegation/` — three files per delegated packet: the brief the worker was given, the usage sidecar it wrote, and a receipt describing what it did. See [the delegation directory](#the-delegation-directory).

Brownfield runs add three more under `.sdlc/runs/<run-id>/`:

- `provenance.json` — every file this run created or modified, keyed by path. `/mmo:revert` reads this to undo the run.
- `intent_brief.md`, `discovery.md`, `change_plan.md`, `senior-review.md`, `security-review.md`, `final_report.md` — the per-phase artifacts.
- `packets.jsonl` — the TaskPacket stream the orchestrator dispatched, one per line.

And the report emitted by `node tools/report.mjs <output-dir>` is a rendered view of the manifest.

## The report, section by section

### Header

Identifies the pass: name, policy, and start timestamp. A run invoked with `--run-id=foo` will show `foo` in the header.

### SDLC task run

A table with one row per SDLC phase. Columns:

- **Calls** — how many LLM calls occurred in that phase.
- **Tokens (in / out)** — sum of input tokens and output tokens across those calls.
- **Cost** — sum of the per-call `cost_usd` values in the telemetry.

The row order follows the SDLC state machine — requirements first, then design, planning, codegen, tests, docs, senior review, security review.

The **"SDLC task total"** at the bottom is the sum of the Cost column. This is what the study is measuring: the cost of doing the software development work.

### Delegated to an agent worker

Printed only when the run delegated. On every other run the section is absent rather than empty — an all-Opus pass made no such distinction, and a table of zeroes would suggest it did.

It opens with the division of labour, because that is the one fact this mode changes and the one a reader is most likely to get wrong:

| Tag | Who |
|---|---|
| `[C]` | Claude Code — the harness. Plans, gates, integrates. Writes no shipped code. |
| `[C→G]` | the handoff — a brief written to disk, then a worker subprocess in the working directory. |
| `[G]` | the Antigravity SDK worker — an agent with tools, which writes the code. |

Then one row per delegated packet:

- **Tools** — how many tool calls the worker made. This is the number that shows an agent was really working rather than answering once; a trailing `+` means the worker's own recording cap was hit and the figure is a floor.
- **Files** — `+` added, `~` modified, `-` removed. See the caveat below.
- **Time** — wall-clock for that worker process.
- **Cost** — from telemetry, so it covers every attempt at the packet.

Three markers can follow a packet id. `*` — the packet was retried; the cost covers all attempts, but tools, files and time describe the last one, because a retry overwrites the receipt. `!` — the worker did not finish; it was still billed and may still have edited files. `?` — no telemetry event carries this task id, so the cost shown is the receipt's own figure.

The last two rows are the point: the delegated subtotal, and a `[C]` line for everything else in the run. They add up to the SDLC + overhead total.

**What "Files" does and does not claim.** The server takes a content digest of every file in the working directory immediately before the worker starts and again immediately after it exits, and compares them. Modification means the *content* changed — a formatter that rewrote a file byte-for-byte, or an `npm install` that rewrote a lockfile identically, does not count. `.git`, `node_modules`, `dist`, `.venv` and similar are not walked, and the worker's own output directory is excluded so a delegation cannot report its own evidence as a change.

That gives you what changed *while the worker held the directory*. It is not proof the worker was the only thing writing there, and it cannot attribute any one change to any one tool call. If you need that, read the receipt's tool-call list.

### Run stats

- **Wall-clock** — end-to-end duration of the pass.
- **Model calls** — total count of LLM calls, all phases and overhead included.
- **Code files produced** — count of files under the pass's generated source tree.

### Costs

- **SDLC task cost** — the same number as "SDLC task total" above. Repeated here for the cost-focused reader.
- **Runner overhead** — the cost of *dispatched* phases that aren't SDLC-productive per se: preflight, retries, shell-adjacent packets. Despite the name, this is **not** the orchestrator's own loop — that never passes through telemetry at all.
- **Session total — dispatched work only** — SDLC + runner overhead. Every dollar above this line came through the MCP server (or was logged to it by the direct tier).

What happens next depends on whether the orchestrator-overhead collector has run:

- **Before the collector**: the report prints an `EXCLUDES ORCHESTRATOR OVERHEAD` caveat under the total — the orchestrator session's own reasoning, file reads, and re-sent conversation are missing, and on measured runs that overhead exceeded the dispatched figure by ~100×. The caveat includes the exact command to fix it.
- **After the collector** (`node plugin/scripts/collect-orchestrator-usage.mjs <pass-dir>`): two more lines appear — **Orchestrator overhead (transcript-measured)** and **True total (dispatched + orchestrator)**. The true total is the only figure that compares architectures fairly. On estimated-mode runs the report also prints the estimator-overlap note (driver-tier judgment work exists both as estimated events and inside the transcripts, so the true total is conservative by up to the estimated subtotal). When the run kept Claude Code's own result json (`claude-session.json`, the `live-run.log` of a stream-json run, or `--receipt`), a **receipt cross-check** shows the transcript against the receipt per model (names read through the price list, so the receipt's `claude-opus-5[1m]` is the transcript's `claude-opus-5`; a name the list does not carry is read when the run's policy declares it as a `model_name` under `pricing_override: true`) and per token bucket. When no bucket is above the receipt, and the window is provably the receipt's invocation or every bucket equals it, the receipt's token counts are booked at the price list and the report says *Verified against Claude Code's own receipt*. `unlogged_billed` then holds the receipt tokens no transcript message recorded, and `attribution_complete` says whether every helper's transcript was there. Claude Code's own dollars are kept as `receipt_cli_usd`, never booked. Extra work in the window, a receipt for another session, or a window below the receipt that cannot be proven is exit 3 with nothing written; a receipt that covers only the last `--resume` continuation is booked for that invocation by the same rule (the earlier invocations are added transcript-priced and unverified, and `attribution_complete` covers that invocation's helpers), and the report says *PARTLY VERIFIED*. The manifest's `orchestrator_overhead` block records `cost_source`, `receipt_cost_usd`, `per_model` (the transcript's cost per model and role, each message at its own model's list price), `unpriced` (tokens the price list could not price, with the reason), the `window` it measured (its two anchors, whether both were exact, and the session file it was pinned to) and the in-session dispatch that was subtracted so it is counted once; the report prints that window on its own line.

  Under those lines the report says which model the orchestrator's dollars ran on and how complete the figure is (since v0.7.3):

  - **By model** — `session (claude-sonnet-5): $x · helpers (claude-opus-4-8): $y`, one figure per role and model from `per_model` (entries of one model at different prices are summed), with the price list's verification date.
  - **Of the booked receipt, billed but not logged: $z (n%)** — a headless run whose receipt was booked: `unlogged_billed`, per model, with *(receipt only)* on a model no transcript message ran on (such as a Haiku side call). The overhead row then reads **Orchestrator overhead (receipt tokens at the price list)**, and the verification line names Claude Code's own figure (`receipt_cli_usd`) as a check that is never booked, with its distance from the booked part (`booked_cost_usd`: the whole receipt at the list, or on a resumed run the last invocation alone) when that exceeds 0.5%.
  - **No receipt booked, so this is a floor: excludes calls Claude Code bills but does not log (2.3%–22% on measured runs)** — any figure not booked from a receipt, which is every interactive run: the transcript cannot show those calls.
  - **Custom price** — `per_model` entries priced by a policy's `pricing_override` card instead of the price list.
  - **Unpriced, so in no figure above** — `unpriced` and `unlogged_billed.unpriced` tokens, with the reason.
  - **Attribution incomplete** — `attribution_complete: false`: the missing helper ids and unreferenced helper files, and what that changes (for a booked receipt the total is unaffected and a missing helper's tokens sit in billed but not logged; otherwise a missing helper's tokens are in no figure).

  A manifest collected before v0.7.3 has none of these fields and renders exactly as it did.

The report's header also carries a **Scope** line stating which of the two states the numbers are in. The dispatched breakdown exists so the total is not surprising; the scope labeling exists so the total is not *misread*. Full method in [methodology.md](methodology.md#the-orchestrators-own-cost-and-the-transcript-collector).

### Methodology

A short reminder of which numbers are vendor-reported and which are estimated. Full details in [methodology.md](methodology.md).

### Artifacts

Paths to the raw files, for direct inspection.

## The raw files

### `telemetry.jsonl`

One JSON object per line. Key fields:

```json
{
  "ts": "2026-07-09T14:22:03.123Z",
  "phase": "codegen",
  "task_type": "controller_handler",
  "task_id": "tp_codegen_012",
  "module": "auth",
  "model": "claude-opus-4-7",
  "model_id": "opus",
  "input_tokens": 3421,
  "input_tokens_cached": 0,
  "output_tokens": 2103,
  "cost_usd": 0.069,
  "latency_ms": 8241,
  "success": true,
  "artifact_path": "src/auth/auth.controller.ts"
}
```

Fields the report reads: `phase`, `input_tokens`, `input_tokens_cached`, `input_tokens_cache_write`, `output_tokens`, `cost_usd`, `success`. Everything else is available for downstream analysis. `input_tokens_cache_write` is the cache-*write* bucket — every prompt token written into the vendor's cache, billed at a premium over fresh input — kept separate from `input_tokens` precisely so that premium prices correctly. When the 5-minute / 1-hour split is known (a `claude-cli` worker, or the collector's line), `input_tokens_cache_write_1h` holds the 1-hour share, which bills at 2× input instead of 1.25×.

Every dispatched line also says where its dollars' rates came from. `price_basis` is `list` (the dated price list; see [methodology.md](methodology.md#pricing-table-provenance)) or `custom` (the policy's `pricing:` block under `pricing_override: true`). `unpriced_models` names any billed model that had no price; its tokens are not in `cost_usd`. A `claude-cli` worker's line adds `cli_reported_cost_usd` (Claude Code's own figure, kept as a check) and `ttl_split` (`transcript`, `approximate` or `no_cache_writes`).

One line is special: after the post-run collector has run, the file gains a single `tier: "orchestrator"` event (`provenance: "transcript"`, phase `orchestrator_overhead`) holding the orchestrator session's own usage, with the same per-model, receipt and attribution fields as the manifest block (`per_model`, `unpriced`, `pricing_complete`, `price_list_verified`, `unlogged_billed`, `attribution_complete`, `missing_helper_ids`, `unreferenced_helper_files`, `receipt_cli_usd`); the report reads them from this line when the manifest has not been patched. Every dispatched aggregation — report tables, manifest totals, breakdowns — partitions that line out; it surfaces only in the report's overhead/true-total lines and the manifest's `orchestrator_overhead` block.

`model` is the vendor's model name and `model_id` is the policy leaf that dispatched. They are usually redundant, and there is one case where they are not: a policy can offer two ways of reaching the same model — Gemini as a completion call or as an Antigravity agent — and both carry `"model": "gemini-3.5-flash"`. `model_id` (`flash-completion` or `flash-agsdk-worker`) is the only field that says which, and a `routing.select` object alongside it records the choice that led there. Group by `model_id`, not `model`, when the distinction matters. See [methodology.md](methodology.md#two-doors-to-the-mechanical-tier-and-how-the-report-tells-them-apart).

`latency_ms` is `null` on phases that ran on the direct tier — those execute inside Claude Code rather than being dispatched through the MCP server, so nothing ever timed them. `null` means "not measured", as distinct from a real measured `0`. Phases dispatched to a mechanical-tier model (Gemini) carry a real wall-clock figure. To compare tiers on speed, use the gaps between consecutive `ts` values, which are stamped server-side for every event.

To sum costs by phase using standard shell tools:

```bash
jq -r 'select(.phase=="codegen") | .cost_usd' examples/workforce-ops/passes/pass1/telemetry.jsonl \
  | awk '{s+=$1} END {print s}'
```

### `manifest.json`

Aggregated form of the telemetry. Useful fields:

- `total_cost_usd`, `total_input_tokens`, `total_output_tokens`, `total_input_tokens_cache_write` — dispatched work only, always
- `phase_breakdown`, `module_breakdown`, `task_type_breakdown` — sub-rollups (dispatched only)
- `orchestrator_overhead` — present only after the collector has run: the transcript-measured cost and token buckets of the orchestrator's own session, kept in its own labeled block so it never blends into the dispatched figures. Inside it:

  | Field | Meaning |
  |---|---|
  | `per_model` | One entry per model, role and price: `model`, `role` (`session` for the top-level session file, `helper` for a file under `subagents/`), `price_basis` (`list` or `custom`), `price_period`, `applied_modifiers`, `rates`, `messages`, `tokens` (`input`, `input_cached`, `input_cache_write_5m`, `input_cache_write_1h`, `output`) and `cost_usd`. The transcript figure is the sum of the entries' `cost_usd`. An entry whose messages made web searches also carries `web_search_requests` and `web_search_cost_usd` (their fee at the list's per-search price, inside `cost_usd`). |
  | `unpriced` | Tokens the price list could not price (`model`, `role`, `reason`, `messages`, `tokens`), or web search requests with no per-search price (`web_search_requests`, with zero tokens). They are in no dollar figure. |
  | `pricing_complete` | `false` when `unpriced` is non-empty, or, for a booked receipt, `unlogged_billed.unpriced`; `cost_source` then ends `INCOMPLETE — unpriced tokens excluded`. |
  | `price_list_verified` | The verification date of the price list used. |
  | `unlogged_billed` | Present when a receipt was booked: the receipt's tokens that no transcript message recorded. `per_model` entries carry `model`, `reported_as`, `receipt_only`, `tokens`, `rates`, `ttl_split` (`logged mix`, `receipt usage`, `5-minute (assumed)` or `none`), `assumed` and `cost_usd`, plus `web_search_requests` and `web_search_cost_usd` when the receipt bills searches beyond the logged ones; `unpriced` lists tokens the list could not price; `cost_usd` is their total and `pct_of_booked` its share of the figure. The block's `cost_usd` = `transcript_cost_usd` + this `cost_usd`. `null` when no receipt was booked. |
  | `attribution_complete` | `true` when every helper named by an `Agent`/`Task` result in the pinned session has its `subagents/agent-<id>.jsonl` and every such file is named; `false` otherwise, with `missing_helper_ids` and `unreferenced_helper_files`; `null` when the scan was not pinned to a session file. |
  | `receipt_cli_usd` | Claude Code's own `total_cost_usd` from the receipt: a check on the booked figure, never booked. |
  | `booked_cost_usd` | The booked part at the price list: the whole receipt, or on a resumed run the last invocation alone, which is all `receipt_cli_usd` bills. The report measures `receipt_cli_usd` against it. `null` when no receipt was booked. |
- `true_total_cost_usd` — `total_cost_usd` + the overhead block's cost; the architecture-comparison number
- `duration_sec`
- `pass`, `policy_name`

### The delegation directory

Present only on runs that delegated. Three files per delegated packet, all named after the packet's task id:

- **`worker-task-<packet>.md`** — the brief the worker was given, exactly as it was written to disk. This is the prompt: what the packet asked for, which files it excerpted, and the output contract. Nothing was added to it out of band.
- **`worker-usage-<packet>.json`** — written by the worker process itself, in its own words: the model it reached, the SDK version, the Google Cloud project and region, its token usage, and its tool calls.
- **`worker-delegation-<packet>.json`** — the receipt, written by the server. Joins the two above to what changed on disk.

The receipt carries `schema: "delegation-record/1"` and these fields:

| Field | Meaning |
|---|---|
| `task_id`, `phase`, `task_type`, `module` | the packet, and the join key back to `telemetry.jsonl` |
| `cable` | sdk, sdk_version, vertex_project, vertex_location, thinking — **copied from the worker's sidecar**, so it records what the run used rather than what it intended. All null if the worker died before writing one. |
| `duration_ms`, `success`, `error` | the worker process's outcome |
| `cost_usd`, `tokens` | this delegation's own spend |
| `tool_calls` | `count` (the full total), `truncated`, and `sample` (capped) |
| `files` | `added`, `modified`, `removed` as path lists, plus `unchanged`, `scanned`, `truncated`, `unreadable` |
| `artifacts` | filenames of the brief and the sidecar |

A receipt is written for failed delegations too — that is the case a reader most needs one for. Writing it can never fail the delegation: if the file cannot be written, the server warns on stderr and the run continues.

A retried packet overwrites all three files, so what survives describes the final attempt. The report marks those rows with `*`.

### The Claude Code session transcript

Claude Code writes a JSONL transcript of every session to `~/.claude/projects/<project-hash>/<session-id>.jsonl`, and per-subagent transcripts to `~/.claude/projects/<project-hash>/<session-id>/subagents/agent-<id>.jsonl`. When `CLAUDE_CONFIG_DIR` is set, both live under `$CLAUDE_CONFIG_DIR/projects/` instead, and the report's Artifacts list and the cost collector look there. These files are the underlying source of truth for what the subagent said and did.

For audits at that level of detail, the files are on disk. The `<session-id>` for a given run is printed at the top of the Claude Code session output.

## Other files that may appear

- **`.hook-logs/hook.jsonl`** — a one-line-per-invocation heartbeat log written by the plugin's PostToolUse hook. Records timestamp and payload size for every `execute_with_model` call the MCP server handled. Independent of `telemetry.jsonl`; useful only for cross-checking that the hook fired for each expected MCP call. Safe to delete after a run.
- **`.claude/`** — created by the setup wizard and by Claude Code itself. Holds the project-installed slash command, the orchestrator agent, and Claude Code's own project state. Not intended for git (already in `.gitignore`).
