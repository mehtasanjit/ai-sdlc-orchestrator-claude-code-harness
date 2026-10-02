# Methodology

> **For:** understanding how tokens and costs are counted; choosing between vendor-authoritative and estimated modes. **Also see:** [understanding-output.md](understanding-output.md) · [two-gemini-paths.md](two-gemini-paths.md) · [architecture.md](architecture.md).

How the tokens and costs on the report are derived, in plain terms.

## The `MMO:` log stream is not telemetry

`telemetry.jsonl` and the `MMO:`-prefixed log stream ([docs/logging.md](logging.md)) record
different things and neither replaces the other.

`telemetry.jsonl` is cost accounting: one `TelemetryEvent` per dispatch attempt, written once
that attempt completes, carrying exactly the fields the report ([understanding-output.md](understanding-output.md))
sums into dollars and tokens — `input_tokens`, `output_tokens`, `cost_usd`, `provenance`, and so
on. It says nothing about whether a call was *attempted*, which model routing chose and why, or
what an Antigravity SDK worker did while it held the working directory.

The log stream is an event trace: every phase and gate boundary, every subagent hand-off, every
model dispatch's routing decision, every vendor API request/response, every AG SDK worker spawn
and exit — `MMO: <timestamp> <LEVEL> <event> key=value…`, one line per event, to stderr and to
`<output_dir>/orchestrator.log`. It carries no dollar figures and is not summed into anything; it
exists to answer "what did this run actually do," which a cost ledger cannot.

The two are written independently and can diverge in count: a dispatch that fails before a vendor
call completes emits `dispatch.error` on the log stream but no `TelemetryEvent` (nothing to bill).
Cross-referencing the two by `run_id` (log) and `pass` (telemetry) reconstructs the full picture —
what ran, in what order, and what it cost.

## The mode determines everything

Every telemetry event carries a `provenance` field: `"vendor"` or `"estimated"` (a third value, `"transcript"`, is reserved for events reconstructed post-run from session transcripts). The report labels the whole run according to what's on those events. The stamp is applied where the numbers are actually measured: the dispatch server stamps `"vendor"` on every `execute_with_model` event server-side (in both auth modes — a dispatched call always returns the vendor's own usage block), and `log_telemetry` defaults direct-tier events to `"estimated"` as it normalizes them, so a model that forgets the stamp cannot produce an unlabeled event. Events written before the stamp existed lack the field; the report treats absence as "unknown" and disowns the run's cost label rather than guessing. The mode is chosen per run via the required `--auth=vendor|estimated` flag on `/mmo:pass`. The orchestrator reads the flag at startup and follows that path for every event; if the flag is missing the run aborts. Mode is not inferred from `ANTHROPIC_API_KEY` presence — the flag is the sole source of truth, so identical commands produce identical modes regardless of the shell's env-var state.

### Vendor-authoritative mode — `--auth=vendor`

The orchestrator (per [rule 6 in orchestrator.md](../plugin/agents/orchestrator.md)) dispatches **every** LLM call — including its own tier's calls — through the MCP server. The MCP server hits the vendor API directly, receives the vendor's own `usage` block in the response, and writes those exact numbers into the event:

- `input_tokens`, `input_tokens_cached`, `output_tokens` — Anthropic-reported (or Google-reported for Gemini calls under `opus-plus-flash`)
- `cost_usd` — (vendor tokens × the model's effective price) / 1M: the dated price list's rates on the dispatch day, or the policy YAML's `pricing:` block when the model sets `pricing_override: true` (see [Pricing table provenance](#pricing-table-provenance))
- `provenance: "vendor"`

These numbers reconcile to the Anthropic and Google dashboards for the API key and time window the run used. An independent run under vendor-authoritative mode should land within a few percent of the published figures; residual variance is LLM non-determinism in packet decomposition, not measurement drift.

### Estimator mode — `--auth=estimated`

Claude Code handles auth via a Pro / Team / Enterprise subscription. Direct-tier calls (the judgment phases, under any policy) run inside the subagent's conversation loop, which doesn't expose per-call `usage` to the subagent. The orchestrator therefore estimates tokens using a character-count heuristic:

```
tokens ≈ characters / 3.8
```

- `input_tokens`, `output_tokens` — char-count estimated
- `cost_usd` — (estimated tokens × the model's `effective_price.rates` from `load_policy`) / 1M: the dated price list's card for the day, or the policy's `pricing:` block only under `pricing_override: true`, the same price a dispatch bills (see [Pricing table provenance](#pricing-table-provenance))
- `provenance: "estimated"`

MCP-dispatched calls in this mode (Gemini under `opus-plus-flash`) still carry vendor tokens; only the direct-tier events are estimated. The report labels the whole run "Mixed" in that case.

Which model that direct-tier work *executes* on is a separate question from how it is priced, and the two must be the same model for the estimate to mean anything. Execution is decided by Claude Code from the `CLAUDE_CODE_SUBAGENT_MODEL` environment variable, set before the `claude` process launches (from a terminal, exported or in the `env` block of the project's `.claude/settings.local.json`; from the desktop app, in the `env` block of `~/.claude/settings.json`, since the app ignores project settings files — verified on Claude Code 2.1.270); pricing comes from the policy's driver `model_name`. The orchestrator verifies they agree at run start via `plugin/scripts/driver-model-check.mjs` — the script derives the driver model by routing every judgment phase through the loaded policy with the same compiled routing the dispatch server uses, and stops the run (printing where to set it for a terminal and for the desktop app, and naming any project settings file that already declares a value) on unset or mismatch. The driver agent files carry no `model:` frontmatter pin, because a pin silently overrides the policy: the run executes the pinned model while the report prices the policy's.

The 3.8 midpoint is fine for order-of-magnitude reasoning; it will not exactly match an Anthropic bill.

## Which mode were the published numbers produced in?

The numbers on this repo's public README were produced under **vendor-authoritative mode** — the run used `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` (for the `opus-plus-flash` variant). Every published cost line is Anthropic- or Google-billed. Material divergence on a same-mode reproduction can be filed as an issue.

## Trade-off between the modes

| | Vendor-authoritative | Estimator |
|---|---|---|
| API key needed | Yes — Anthropic (and Gemini for opus-plus-flash) | No — Claude Code subscription handles direct-tier auth |
| Cost per run | Higher — no free automatic prompt caching from Claude Code; caching handled via explicit `cache_control` in the MCP adapter (~10% input rate on hits) | Lower — Claude Code applies its own caching under the hood |
| Numbers on report | Match the Anthropic and Google dashboards for the API key used | Order-of-magnitude approximation of a vendor-billed run |
| Recommended for | Publishing, cross-checking against the bill, Google-style audit | Casual runs, exploring the tool without an API key |

## Cross-checking against the Anthropic dashboard

To verify the report against reality:

1. Note the timestamps at which the pass started and ended.
2. Open [console.anthropic.com/settings/usage](https://console.anthropic.com/settings/usage).
3. Filter to the API key and time window matching the run.
4. Compare Anthropic's charge to the report's "Total session cost" line.

The two should match to within a few cents. Larger divergences can be filed as issues.

## Output-ceiling doubling

Every TaskPacket carries a `budget.maxOutputTokens` — the initial output-token ceiling the adapter dispatches under. When the vendor terminates a response with the max-tokens signal (Anthropic `stop_reason: "max_tokens"` or Gemini `finishReason: "MAX_TOKENS"`), the adapter re-dispatches the identical packet with 2× the previous ceiling, up to 3 doublings or the model's absolute output limit (declared in the policy YAML as `max_output_tokens_absolute`), whichever comes first. Input caching (Anthropic ephemeral / Gemini Context Cache) is warm across the retries, so re-input is billed at the cache-read rate; only the extra output tokens accrue full cost.

Every attempt emits its own TelemetryEvent with `attempt_number`, `ceiling_used`, and (on retries) `retry_reason: "output_cap"`, all sharing the packet's `task_id`. The report collapses them into one row per packet under **Packets that needed output-ceiling doublings** — the raw JSONL preserves the full attempt chain for full audit at that level.

**Why doubling instead of raising the ceiling unilaterally.** Under a well-chosen initial ceiling, most packets fit first-shot and pay nothing extra; only the packets that actually need the room double. Under a uniformly-raised ceiling, every packet pays the higher rate. For SDLC codegen — where the file-size distribution is heavily skewed toward small files with a few large outliers — doubling wins in aggregate. It costs roughly 1.75× a perfectly-tuned unilateral raise on the specific packets that need multiple doublings.

**Detection is strict.** Only the vendor's explicit max-tokens signal triggers doubling. Anything else (semantic completion, safety filter, recitation guard) is treated as a genuine termination and the response is accepted as-is. This avoids retries that would have returned identical output.

**Terminal states.** A packet's ExecutionResult carries `terminal_reason`:
- `success` — an attempt returned without hitting the max-tokens signal.
- `output_cap_doubling_budget_exhausted` — every attempt terminated at max-tokens, but the model still had headroom under its declared absolute ceiling. The doubling loop simply ran out of retries. Actionable: raise the packet's initial `budget.maxOutputTokens`, or lift the doubling cap for this phase.
- `output_cap_at_model_absolute` — the loop reached the model's declared absolute output limit and the response was still truncated. The packet is genuinely too big for this model under this prompt; raising the initial ceiling won't help. Actionable: split the packet, use a model with a larger absolute ceiling, or accept the truncated deliverable.
- `vendor_error` — a non-4xx error interrupted the chain; the packet fails.

## Where the numbers come from

- **Token counts pass through unchanged from the source.** In vendor mode, the numbers on every event are exactly what the vendor's `usage` block returned. In estimated mode, they're exactly what the char/3.8 heuristic computed at the moment of the call. Report totals are those per-event counts summed — nothing between measurement and display.
- **Cost is computed and written at the moment of each call.** A dispatched event's `cost_usd` is (that event's tokens × the model's effective price on the dispatch day) / 1M; an estimated event's is (its tokens × the same effective price, which `load_policy` returns as `effective_price`) / 1M. Either is stamped into `telemetry.jsonl` at write time, and a dispatched event also records `price_basis` (`list` or `custom`) and any billed model it could not price (`unpriced_models`). The report's totals are those per-event costs summed.
- **The report shows what the run produced.** Every figure on the report comes from summing that run's own telemetry events.
- **Telemetry covers dispatched work only.** The orchestrator's own loop — reasoning, file reads, re-sending the growing conversation every turn — never passes through the MCP server, so no event above contains it. It is measured separately, post-run, from session transcripts; see [The orchestrator's own cost](#the-orchestrators-own-cost-and-the-transcript-collector).

To verify any of these, walk `telemetry.jsonl` by hand — every line is inspectable.

## How Gemini's token counts are read

Google's `usageMetadata` has two fields that look alike and behave in opposite ways. Both are handled explicitly, because getting either wrong moves the headline number.

**`cachedContentTokenCount` is a *subset* of `promptTokenCount`.** The prompt count is the whole prompt, cached portion included. Cost is computed on disjoint counts — fresh input at the full rate, cached input at the read rate — so the cached count is subtracted from the prompt count before pricing. Skipping that subtraction bills the cached tokens twice and makes an effective cache look more expensive than no cache at all. That subtraction happens exactly once, in the adapter: the `input_tokens` written to telemetry is already the fresh count, and every reader — live pricing, the report, and the `simulate_policy` what-if replay — prices the stored buckets as they are and never subtracts again. (The replay used to, which under-priced every cache-hit event and could report a negative what-if.)

**`thoughtsTokenCount` is a *sibling* of `candidatesTokenCount`.** Gemini 3.x reasons before it answers, and Google bills that reasoning at the output rate — but reports it outside the candidate count. Billed output is therefore `candidatesTokenCount + thoughtsTokenCount`. This is not a rounding correction: a single-token answer from `gemini-3.5-flash` can come with ~100 thinking tokens. Reading the candidate count alone would report 1 output token where Google bills ~100, at the output tier's $9/M — understating precisely the model whose lower cost the multi-model pass exists to demonstrate.

Two consequences worth knowing when reading a report:

- **Thinking tokens count against the packet's output ceiling.** A packet can spend its whole ceiling reasoning and return no text, which the vendor reports as `MAX_TOKENS`. That is a genuine truncation and the doubling loop handles it as one — the attempt is billed, because the reasoning happened.
- **Gemini also caches implicitly, without being asked.** A packet resembling one sent minutes earlier can come back with a non-zero cached count under no explicit cache. Costs stay correct either way, since the cached count is read from the response rather than inferred from whether a cache was requested. But it means a cold-vs-warm pair measured back to back understates the gap: the "cold" call may already be partly warm.

## Two doors to the mechanical tier, and how the report tells them apart

`opus-plus-flash` declares two ways of reaching Gemini 3.5 Flash. The default calls it as a **model**: one request per packet, with the orchestrator reading the files and writing the answer back. The alternative runs it as an **agent** through the Antigravity SDK, working in the directory itself. Which one an install uses is chosen once, outside the policy file, by the setup wizard or by `--enable-agent` on the verify script — see [setup.md](setup.md#gemini-as-an-agent--antigravity-sdk).

Both leaves bill the same price-list entry and carry the same `pricing:` block, because they reach the same model at the same published rates. That is deliberate, and it is the reason the vendor model name alone cannot tell you which one ran — `gemini-3.5-flash` appears on both. Two fields on every event carry the distinction:

- **`model_id`** — the policy leaf that executed: `flash-completion` or `flash-agsdk-worker`. This is the field to group by when comparing the two.
- **`routing.select`** — the slot that resolved, what it resolved to, and whether the run asked (`overridden: true`) or inherited the default. Absent entirely on policies that declare no slots, so events from `opus-only` are byte-for-byte what they were before slots existed.

Those two fields are for querying. For reading, `node tools/report.mjs` renders a **Delegated to an agent worker** section on any run that used the agent door — one row per delegated packet with its tool-call count, its wall-clock, and what changed in the working directory while it held it, against a `[C]` line for everything the harness did itself. The section is absent on runs that did not delegate. Its inputs are the per-delegation receipts under `delegation/`, described in [understanding-output.md](understanding-output.md#the-delegation-directory).

**Identical rates do not mean identical cost, and the difference is not small.** An agent re-sends the accumulated conversation on every tool call, and each of its turns carries the SDK's own multi-thousand-token instruction preamble. A packet that a single completion call answers in one request can cost an agent several times as much for the same deliverable — entirely in token volume, at unchanged rates. The costs on the report are still exact: an agent dispatch is priced from the token counts the Antigravity SDK's `usage_metadata` reports, read through the same disjoint cached/fresh arithmetic described above, with the same `provenance: "vendor"`. A run comparing the two doors is measuring how many tokens each approach needs, which is the honest question.

**Door comparisons are only valid on true totals.** Dispatched-work totals exclude the orchestrator's own loop (next section), and that exclusion does not fall evenly on the two doors — the driver does more in-session coordination for some shapes of work than others. On measured runs the omission was large enough to invert which door looked cheaper. Compare doors only after the collector has run, from the report's *True total* line; the report prints a warning on the delegation table until then.

## The orchestrator's own cost, and the transcript collector

Everything telemetry records is **dispatched work** — calls that passed through the MCP server (or were logged to it by the direct tier). The orchestrator itself runs as a Claude Code session, and that session's own loop — reasoning between phases, reading files, re-sending the ever-growing conversation on every turn — is invisible to telemetry in **both** auth modes. The omission is not a rounding error: on real measured runs the plugin reported **$1.87** of dispatched work while the session's transcripts summed to **≈$236** — a ~100× undercount, and (because the omission falls unevenly across architectures) large enough to invert model-door-vs-agent-door comparisons drawn from dispatched-only numbers.

`plugin/scripts/collect-orchestrator-usage.mjs` closes the gap after the run:

```bash
node plugin/scripts/collect-orchestrator-usage.mjs <pass-dir>
```

**Method.** Claude Code writes session transcripts under `~/.claude/projects/<hash>/`, or under `$CLAUDE_CONFIG_DIR/projects/<hash>/` when `CLAUDE_CONFIG_DIR` is set to a non-empty value (`<hash>` = the absolute project path with every character that is not a letter or digit replaced by `-`, so `/Users/you/repro-v0.6.0` becomes `-Users-you-repro-v0-6-0`), plus per-session `subagents/*.jsonl`. The collector, the report's Artifacts list and the `claude-cli` worker's ledger all read that same directory; `--transcripts-dir` overrides it for the collector. Every `"type": "assistant"` line carries the vendor's own `usage` block. The collector sums those, windowed to the run, and appends one `tier: "orchestrator"` event to `telemetry.jsonl`; the manifest gains an `orchestrator_overhead` block and a `true_total_cost_usd`, while `total_cost_usd` stays dispatched-only forever — the two spends are never blended silently, and `buildManifest` structurally partitions `tier: "orchestrator"` events out of every dispatched sum.

**Referee, tiers, and the in-session share.** Three things the transcript sum is checked against and corrected for:

- **The receipt.** When the run kept Claude Code's own end-of-session result (`claude -p --output-format json`, the last `result` line of a `--output-format stream-json` capture, or a runner's `claude-session.json` beside the manifest; `--receipt <file>`), its `modelUsage` is Anthropic's per-model token count for the one invocation it billed, including calls Claude Code bills but never writes to a transcript. Model names are read with the price list's name reader on both sides first: the receipt writes `claude-opus-5[1m]` for a 1M-context session where the transcript writes `claude-opus-5`. A name the list does not carry is also read when the run's policy declares it as the `model_name` of an entry with `pricing_override: true`, exactly or with one bracketed option (`acme-gateway-opus`, `acme-gateway-opus[1m]`), and that entry's card prices it; that declaration counts for that run's policy only. Any other name the list cannot read is exit 3, with both sides' names printed and both fixes named: a verified period in `prices.ts`, or a `pricing_override: true` entry with that `model_name`. Then, per model and per token bucket (input, cache read, cache write, output):
  - A transcript bucket **above** the receipt, or a transcript model the receipt does not bill, means the window holds messages the receipt never billed. If the pinned session file shows a second human turn inside the window — a `--resume` continuation restarts the bill — the last invocation alone (from that turn to the window's close) is checked by the same rule as a whole window, in the next two bullets: no bucket above the receipt, and either every bucket equal or the last invocation provably the receipt's invocation (pinned to the receipt's session, opened at its own human turn, no later human turn, an exact close). That books the receipt for the last invocation: its token counts at the list, its gap in `unlogged_billed` (`pct_of_booked` is the gap's share of that invocation), and `attribution_complete` checked over that invocation's helpers only. The earlier invocations are added transcript-priced and unverified, so `cost_usd` is still `transcript_cost_usd` plus `unlogged_billed.cost_usd`, and the label is `receipt for the last invocation (Anthropic token counts priced at the price list); N% of it billed but not logged; K earlier invocation(s) transcript-priced, unverified`. A last invocation above the receipt, or below it without that proof, is exit 3, nothing written. With no second human turn: exit 3, nothing written. Treating the receipt as a floor once booked a preamble's eight messages onto a real run (fixture `receivables-ops/pass1`, +5.8%).
  - A transcript **at or below** the receipt on every bucket **books the receipt**: its token counts priced from the list. The logged part is priced message by message as above. The gap (receipt minus log, per bucket, output included) is priced at that model's logged cache-write and modifier mix, and recorded per model in `orchestrator_overhead.unlogged_billed` with its dollars and its share of the figure. Web searches the receipt bills (`modelUsage[*].webSearchRequests`) beyond the ones the transcript logged are in the gap too, at the list's per-search price ($10 per 1,000 searches for every Claude model); a model with no per-search price lists them under `unlogged_billed.unpriced`, and the figure is labelled `INCOMPLETE`. The label is `receipt (Anthropic token counts priced at the price list); N% billed but not logged`. There is no percentage limit: the gap was 2.3% on one real headless run (two Opus 4.8 calls no transcript recorded; fixture `headless-unlogged-calls`: Claude Code's own $14.19777625, booked $14.197776) and 22% on another.
  - When some bucket is **below** the receipt, booking also needs the window to be provably the receipt's invocation: pinned to the receipt's session, opened at the run's command turn, no later human turn, and exact. Without that proof the gap may be billed messages outside the window (a window that opens late, a run log with no `run.start` line), so it is exit 3, nothing written. A transcript **equal** to the receipt on every bucket is its own proof, as before.
  - `attribution_complete` tells the two causes of a gap apart. It is true when every helper named by an `Agent`/`Task` result in the session has its `subagents/agent-<id>.jsonl` and no such file is unnamed (the gap is then calls Claude Code never logs). It is false, with `missing_helper_ids` / `unreferenced_helper_files`, when a helper transcript is missing: the total is still right, only the breakdown is incomplete.
  - Claude Code's own dollars are never booked: its price table priced Opus 5 at Sonnet rates on Aug 24 2026. They are kept as `receipt_cli_usd`, and a NOTE says when the booked figure differs from them by more than 0.5%. The booked part's list figure is kept beside them as `booked_cost_usd`; on a resumed run that is the last invocation alone, the span Claude Code's figure bills, and the report's check uses it. A receipt with no `modelUsage` is refused (exit 3) with a message that names the receipt, whatever the window holds.
  - A model on the receipt with no logged message (a CLI side call such as a Haiku title, or a missing helper) is priced at the list's API-default modifiers, with 5-minute cache writes unless the receipt's top-level `usage` equals that model's counts exactly and so supplies its split; each such assumption is written into its `unlogged_billed` entry. With a receipt but no transcript line in the window at all, the whole receipt is priced this way (`receipt-only (Anthropic token counts priced at the price list)`).

  A receipt for another session is refused. Both numbers are always printed.
- **Cache-write TTL.** `usage.cache_creation` splits writes into the 5-minute tier (1.25× input) and the 1-hour tier (2× input). Long sessions use the 1-hour tier exclusively; pricing every write at 1.25× was measured 6% low against the receipt on a real 32-minute session. Each tier is priced at its own rate; a transcript without the split is booked at 5-minute, as before.
- **In-session dispatch.** Packets the session executed itself (provenance `estimated` or `apportioned_from_measured_total`, or a `claude-cli` worker whose own `claude -p` session shares the project's transcript tree) are already inside the transcript overhead. Their dispatched dollars are subtracted once — `true_total = dispatched − in-session + overhead` — never more than the dispatched figure, and only for models the manifest's `models_used` names. Without this a real run reported 21% over the receipt. A `claude-cli` event's `cost_usd` also holds what its result billed that the worker's transcript never logged (a side call such as a Haiku title, unlogged tokens), which the scan cannot see, so such an event subtracts only its `transcript_logged_cost_usd`: the dollars for the tokens its own transcript explains. The unlogged part stays in the true total. An event written before that field existed subtracts its whole `cost_usd`.

Regression fixtures, taken from real runs, live under `tools/test/fixtures/`: `receivables-ops/` (the receipt check, the cache-write TTL and the in-session share, from three runs with their receipts), `headless-unlogged-calls/` (a booked receipt with 2.3% billed but not logged), `headless-side-call/` (a `[1m]` receipt name and a Haiku side call no transcript records) and `fable-session-opus-helpers/` (a session and its helpers on different models, no receipt).

The load-bearing details, each verified against a real transcript before the tool was written:

- **Dedupe by `message.id`.** One API message is written as several JSONL lines (one per content block), each repeating identical usage. Naive per-line summing roughly *doubles* the figure; each id is counted once.
- **Window anchor.** Claude Code bills per invocation, and an invocation begins at its human turn. Transcripts carry no run id, but they do carry the run's own **command turn** — the `"type": "user"` line that invoked `/mmo:pass` (or the runner's `ai-sdlc-*` command) with this run's `--run-id` — so the window opens at that turn's own timestamp, exact. The turn chosen is the latest one at or before the driver's `run.start` line in `.sdlc/runs/<run-id>/orchestrator.log` (the last `run.start` at or before the first dispatch, so a reused run id never reaches back into an earlier run), preferring the receipt's own session and a turn naming this run id. The window closes at the first human turn after the driver's `run.end` line — that turn starts the next invocation — or at the end of the session file when none follows; both exact, because assistant messages only ever follow a human turn. The CLI's own bookkeeping lines (`isMeta`, tool results) are not human turns, and neither are the `"type": "user"` lines Claude Code writes without a person typing them: compaction summaries (`isCompactSummary`, `isVisibleInTranscriptOnly`) and harness-injected lines whose `origin.kind` is not `human`, such as a background-task notification (a line with no `origin`, as older transcripts write, is still a turn). Counted as turns, a compaction inside the window refused a provable run as "2 human turns", and one just after `run.end` closed the window early and moved the session's closing messages into billed but not logged. Without a command turn the window opens at `run.start` minus 5 minutes, else at the manifest's `started_at` minus 5 minutes — `started_at` is the first *dispatched* event, not the driver's start, and opening the window there dropped every driver message before the first dispatch: 22% of the driver's spend on a real run (v37-agsdk-1, 2026-09-05). Without `run.end`, or without a pinned session file to read turns from, it closes at `run.end` or `ended_at` plus 5 minutes. Every fallback is labelled *approximate* in `cost_source` and in the manifest's `orchestrator_overhead.window` block, and the receipt rule above is what decides whether it held — a wrong window fails that rule; nothing is guessed. File-level pruning uses an mtime **lower bound only** — an upper bound would silently drop the run's messages whenever the session kept going after the run ended. Those two anchors, `started_at` and `ended_at`, are read from the manifest's top level — and when it does not carry them there, **the manifest is rebuilt from the run's own `telemetry.jsonl` with `buildManifest` and read from the rebuild instead**. `manifest.json` is written by the model by hand (`buildManifest`, the function written to produce it, had no caller that wrote a manifest — Phase 9 names it as a *shape* for the model to copy and hands the model the write; the collector is now its first production caller), so its shape drifts: the two greenfield runs in this repo nest the window under `run` and disagree on every field that matters — `run.pass`/`run.policy`/`run.finished_at` in one, `run.pass_id`/`run.policy_name`/`run.ended_at` in the other. Chasing those names would never end, so none of them is read. `telemetry.jsonl` is written by code, one line per dispatched call, and is the same source `buildManifest` derives every figure from, so the rebuild is the repo's own builder run on the run's own call log — not a guess. Only the run's id and policy name come from elsewhere, because they are `buildManifest`'s inputs rather than its outputs: the manifest first, then the dispatched lines, which each carry `pass` and `routing.policy_name`. The collector's own orchestrator line is excluded there, or its previous answer would become its next input. The rebuild is only ever READ — the two figures the collector books are written onto the model's own file, which is never replaced. Without an id, or without a dispatched line to rebuild from, the collector stops; nothing is assumed.
- **Synthetic lines excluded.** `model: "<synthetic>"` lines are CLI error placeholders, not billed traffic.
- **Per-message pricing.** Transcripts carry tokens, not dollars. Each assistant message is priced on its own: its `message.model` (read with the price list's name reader, so `claude-opus-5[1m]` and `claude-haiku-4-5-20251001` resolve to their list entries), the UTC day of its timestamp, its own `speed`, `service_tier` and `inference_geo`, and its own 5-minute / 1-hour cache-write split, at the rates of the dated price list that also bills dispatched work (see [Pricing table provenance](#pricing-table-provenance)). Web searches (`usage.server_tool_use.web_search_requests`, counted once per message) bill per request on top of the tokens, at the list's per-search price: $10 per 1,000 for every Claude model, not scaled by fast mode or US-only inference; web fetch has no charge. Searches with no per-search price are listed under `unpriced` with zero tokens, and the tokens stay priced. A policy `pricing:` block prices a transcript model only under `pricing_override: true`; a name the list does not carry that such an entry declares as its `model_name` (exactly, or with one bracketed option) is keyed as that one model, so `acme-gateway-opus` and `acme-gateway-opus[1m]` share one custom-priced entry. `orchestrator_overhead.per_model` in the manifest lists the cost per model and role (`session` for the top-level session file, `helper` for a file under `subagents/`), one entry per price, and the transcript figure is their sum. One rate for every token charged a Claude Fable 5.1 session with Claude Opus 5 helpers $12.577352 instead of $13.933431 (fixture `tools/test/fixtures/fable-session-opus-helpers`). A model, day or modifier value the list cannot price is never borrowed from a similar model: its tokens are listed in `orchestrator_overhead.unpriced` with the reason and left out of the figure, `pricing_complete` is `false`, and `cost_source` says `INCOMPLETE`. Pass `--strict-pricing` to refuse instead (exit 1, nothing written).
- **Idempotent.** Re-running replaces the prior orchestrator event and re-patches the manifest; it never accumulates.

**Limits, stated rather than hidden.** The transcript sum is what the CLI logged, each message at its own model's list price — subscription (Max/Pro) sessions are not literally billed per-token, so read it as *what this session would cost at API rates*, which is the number architecture comparisons need. And under `--auth=estimated`, the driver-tier judgment phases exist twice: as char-count `provenance: "estimated"` telemetry events *and* inside the transcripts. The true total therefore double-counts up to the estimated subtotal in that mode; the collector and the report both print the overlap's size. Vendor-mode runs have no overlap — every dispatched call is an out-of-session API call.

The report (`node tools/report.mjs`) renders three numbers once the collector has run — dispatched, orchestrator overhead, true total — and labels every dispatched-only dollar with its scope until then. Under the true total it prints the orchestrator figure by role and model (`per_model`: `session (claude-sonnet-5): $x · helpers (claude-opus-4-8): $y`), then either what a booked receipt billed that no transcript logged (`unlogged_billed`, with its share) or, for a figure not booked from a receipt, that it is a floor: an interactive run cannot see the calls Claude Code bills without logging, which were 2.3% and 22% of the bill on the two runs measured. Custom policy prices, unpriced tokens and incomplete helper attribution each get their own line. Manifests collected before v0.7.3 carry none of these fields and render as before.

## Pricing table provenance

The rates that turn dispatched tokens into dollars live in one dated price list, [`plugin/mcp/model-dispatch/src/prices.ts`](../plugin/mcp/model-dispatch/src/prices.ts). Each policy YAML under `plugin/config/policies/` still carries a `pricing:` block per model as a readable copy of the list: documentation, billed only under `pricing_override: true`, and not what the orchestrator's estimates read (last paragraph below). Beside it:

- `pricing_source:` — the vendor URL these rates were taken from. It starts with the page the list's period cites: `https://platform.claude.com/docs/en/about-claude/pricing` for Claude, `https://ai.google.dev/gemini-api/docs/pricing` for Gemini
- `pricing_last_verified:` — the ISO date the maintainer last checked the source page, which equals the list period's `verified` date

The list gives each model one or more periods (`from`, `to`, the five token rates, `source_url`, `verified`) and prices a model name on a day:

| Call | Returns |
|---|---|
| `resolveModel(name)` | The list id for an exact id, an id plus `-YYYYMMDD`, or either followed by one bracketed option such as `[1m]`. `null` for anything else. The longest id wins, so `claude-fable-5-1` never reads as `claude-fable-5`. |
| `lookupPrice(name, date, {speed, service_tier, inference_geo})` | The period's rates, with fast mode (Opus 5 and Opus 4.8) or US-only inference (×1.1, Claude 4.6 and later) applied. Otherwise `unpriced` with the reason: an unknown model, no period for the date, or a modifier value the list has no price for. A rate is never borrowed from a similar model. It also returns the period's fee per web search, `web_search_per_request` ($0.01 on every Claude period; `null` where the list has none, so searches there are unpriced). |

The Claude rows were verified on 2026-09-14 against [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing). The list carries every model on that page except Mythos, which has limited availability. Each Claude model has one period, from 2026-01-01 with no end date. Rates are USD per 1M tokens: a 5-minute cache write is 1.25× input, a 1-hour cache write is 2× input, and a cache read is 0.1× input (0.025× on Fable 5.1).

| Model | Input | Cache read | Cache write, 5 min | Cache write, 1 h | Output | Fast mode (input / output) | US-only inference ×1.1 |
|---|---|---|---|---|---|---|---|
| `claude-fable-5-1` | 10.00 | 0.25 | 12.50 | 20.00 | 50.00 | — | yes |
| `claude-fable-5` | 10.00 | 1.00 | 12.50 | 20.00 | 50.00 | — | yes |
| `claude-opus-5` | 5.00 | 0.50 | 6.25 | 10.00 | 25.00 | 10.00 / 50.00 | yes |
| `claude-opus-4-8` | 5.00 | 0.50 | 6.25 | 10.00 | 25.00 | 10.00 / 50.00 | yes |
| `claude-opus-4-7` | 5.00 | 0.50 | 6.25 | 10.00 | 25.00 | — | yes |
| `claude-opus-4-6` | 5.00 | 0.50 | 6.25 | 10.00 | 25.00 | — | yes |
| `claude-opus-4-5` | 5.00 | 0.50 | 6.25 | 10.00 | 25.00 | — | — |
| `claude-opus-4-1` | 15.00 | 1.50 | 18.75 | 30.00 | 75.00 | — | — |
| `claude-opus-4` | 15.00 | 1.50 | 18.75 | 30.00 | 75.00 | — | — |
| `claude-sonnet-5` | 2.00 | 0.20 | 2.50 | 4.00 | 10.00 | — | yes |
| `claude-sonnet-4-6` | 3.00 | 0.30 | 3.75 | 6.00 | 15.00 | — | yes |
| `claude-sonnet-4-5` | 3.00 | 0.30 | 3.75 | 6.00 | 15.00 | — | — |
| `claude-sonnet-4` | 3.00 | 0.30 | 3.75 | 6.00 | 15.00 | — | — |
| `claude-haiku-4-5` | 1.00 | 0.10 | 1.25 | 2.00 | 5.00 | — | — |
| `claude-3-5-haiku` | 0.80 | 0.08 | 1.00 | 1.60 | 4.00 | — | — |

Fast mode (`usage.speed: "fast"`) is priced on Opus 5 and Opus 4.8 only, with the cache rates scaled by the same ratio; a fast message on any other model is unpriced. US-only inference (`inference_geo: "us"`) multiplies every token rate by 1.1 on the models marked. Web search bills $10 per 1,000 searches on every Claude model, on top of tokens. Before v0.7.3 the shipped Sonnet 5 card said 3.00 / 0.30 / 15.00; the list price is 2.00 / 0.20 / 10.00.

The Gemini periods on the list were verified on 2026-09-14 against both of Google's pages, the [AI Studio](https://ai.google.dev/gemini-api/docs/pricing) Standard paid tier and the [Vertex AI](https://cloud.google.com/vertex-ai/generative-ai/pricing) Global rows, which agree on every rate. Each model's first period starts on its GA day in the [Gemini API changelog](https://ai.google.dev/gemini-api/docs/changelog). Rates are USD per 1M tokens. Gemini has no cache-write premium, so cache writes bill at the input rate.

| Model | Period | Input | Cached input | Output |
|---|---|---|---|---|
| `gemini-3.8-flash` | 2 Sep 2026 – 31 Dec 2026 (introductory) | 0.75 | 0.075 | 3.75 |
| `gemini-3.8-flash` | from 1 Jan 2027 | 1.50 | 0.15 | 7.50 |
| `gemini-3.7-flash` | 13 Aug 2026 – 31 Dec 2026 (introductory) | 0.75 | 0.075 | 3.75 |
| `gemini-3.7-flash` | from 1 Jan 2027 | 1.50 | 0.15 | 7.50 |
| `gemini-3.5-flash` | from 19 May 2026 | 1.50 | 0.15 | 9.00 |
| `gemini-3.5-flash-lite` | from 21 Jul 2026 | 0.30 | 0.03 | 2.50 |

Vertex's non-global rows for these models are the rates above ×1.10, the surcharge applied at dispatch (below): 3.5 Flash 1.65 / 0.165 / 9.90, 3.5 Flash-Lite 0.33 / 0.033 / 2.75, and 3.7 and 3.8 Flash 0.825 / 0.0825 / 4.125 through 31 Dec 2026 and 1.65 / 0.165 / 8.25 from 1 Jan 2027. `test/geminiAdapterPricing.test.mjs` checks every Gemini period on the list against both Vertex rows and fails when a period is added without them. A Gemini model Google prices but the list does not carry (Gemini 3.6 Flash or 3.1 Flash-Lite, for example) is unpriced, and so is any day before a listed model's first period.

`npm test` fails when a shipped card differs from the list for today's date, when today falls outside every period for a card's model, or when a card's `pricing_source` or `pricing_last_verified` does not match that period. The shipped Gemini 3.7 Flash and 3.8 Flash cards carry the introductory rates, so from 1 Jan 2027, when the list moves to 1.50 / 0.15 / 7.50, the suite stays red until those cards are changed to match. A run on those days does not halt: it bills the list's 2027 card, and a card still carrying the introductory rates draws a `pricing.policy_mismatch` warning.

**Which price a dispatch bills** ([`effectivePrice.ts`](../plugin/mcp/model-dispatch/src/effectivePrice.ts)). Every adapter prices a dispatch on the day it starts:

| The policy model entry | Billed at | Event says |
|---|---|---|
| No `pricing:` block, or a block within 0.5% of the list on every rate it declares | The list | `price_basis: "list"` |
| A block more than 0.5% off the list on any rate it declares | The list. A `pricing.policy_mismatch` warning names both prices; `preflight_dispatch` returns it under `price_warnings` | `price_basis: "list"` |
| `pricing_override: true` with a block (the loader refuses the flag without one) | The block | `price_basis: "custom"` |
| No list price for the model on that day, and no override | Nothing. `preflight_dispatch` halts the run before it starts, and an adapter refuses the dispatch before any call | — |

The Vertex regional surcharge (+10% on Gemini 3+ at a non-`global` endpoint) is applied on top of the list or custom rates exactly as before, so a shipped Gemini leaf bills the same dollars it did when its block was the price. A `claude-cli` worker is priced per model from its result's `modelUsage`, so a helper or side call on another model bills at that model's own rate, and each model's `webSearchRequests` bill at the list's per-search price on top (unpriced where there is none); Claude Code's own `total_cost_usd` is kept as `cli_reported_cost_usd`, and a difference of more than 0.5% logs `pricing.cli_cost_mismatch`. A response billed under a modifier the list has no price for (a `service_tier` other than `standard`, say) records its model under `unpriced_models` instead of billing the standard card. The `simulate_policy` replay prices each event at the same effective price on its `ts` day, adds the regional surcharge to a Gemini event at the endpoint the server's environment (or a worker leaf's `region:`) would dispatch it to, and lists what it cannot price under `unpriced`.

The orchestrator's own session cost ([The orchestrator's own cost](#the-orchestrators-own-cost-and-the-transcript-collector)) follows the same rule, message by message: each transcript message bills at the list price for its own model, day and modifiers, or at a policy block only under `pricing_override: true`. A transcript message the list cannot price has already been billed, so the collector cannot refuse it the way a dispatch is refused: it lists the tokens under `orchestrator_overhead.unpriced`, labels the figure `INCOMPLETE`, and exits 1 under `--strict-pricing`.

Before publishing a study that relies on these numbers, check both fields, and the list's `verified` date, against the current vendor page. When a vendor changes a rate, add a new period to `prices.ts` instead of editing the old one: set the old period's `to` (inclusive) to the day before the change and start the new period on the change day, so runs before the change keep their price. Update the matching YAML cards in the same PR. Telemetry events already written keep the `cost_usd` stamped at dispatch, and the report sums those as they are; dispatches on or after the new period's `from` day bill the new rates. The collector prices each transcript message on its own day, so re-running it over an older pass reproduces that pass's prices.

Under `--auth=estimated`, the orchestrator subagent prices its own in-session estimates from `load_policy` (`plugin/agents/orchestrator.md` rule 6), never from its own trained knowledge and never from a block's text. `load_policy` returns the policy with each model's `effective_price` for the day it is called (`withEffectivePrices` in [`effectivePrice.ts`](../plugin/mcp/model-dispatch/src/effectivePrice.ts)): `rates` for all five token buckets, `basis` (`list` or `custom`), the list `period`, and `pricing_block`, which says whether the entry's block is absent (`none`), equal to the list (`equals_list`), ignored because it differs (`ignored_differs_from_list`), billed under `pricing_override: true` (`billed_pricing_override`), or ignored because the model has no price (`ignored_model_unpriced`). The rates come from the same `effectivePrice` that bills every dispatch, so an estimate and a bill for one model on one day use the same numbers even when a hand-written block differs from the list: the governance demo policy's `flash-lite` block says 0.50 / 0.05 / 3.00, and `load_policy` shows, and a dispatch bills, the list's 0.30 / 0.03 / 2.50. No model needs a block for its estimates, so `preflight_dispatch` no longer halts an estimated run whose in-session model has none; a model with no price still halts it in both modes. Shipped blocks still equal the list, and `npm test` fails when one drifts, because they document the card. If a block is malformed, the policy does not load.

## Version notes

What each plugin version changed about how the numbers are produced. A dispatched event's `cost_usd` is stamped at dispatch and keeps the rules of the version that ran it. The orchestrator figure is rewritten each time the collector runs, so re-running the current collector over an older pass applies the current rules to that figure.

### v0.9.1

Brownfield single-model runs only. Multi-model brownfield runs (`opus-plus-flash` and the others) and greenfield are unchanged.

| Area | v0.9.0 | v0.9.1 |
|---|---|---|
| Who writes a single-model run's packets | The orchestrator wrote every packet in its own conversation, so each file re-read the whole run's context (Large2-J, `opus-only-v5`, 28 files: 119 orchestrator turns, 20.6M cached tokens, ≈ $13.50 of ≈ $20.19). | `packet-groups.mjs` splits the derived packets into groups of at most six in dependency order, with tooling steps where a later packet needs them, and the orchestrator delegates each group to the new `packet-worker` agent. A worker starts with an empty context, writes, formats, verifies, records provenance and telemetry, and returns one receipt line per packet. Workers use the default five-minute prompt cache. |
| Format before verify | Single-model packets carried `apply.format`, but nothing ran it in-session, so a formatting-only miss cost a fix-up turn (Large2-J: 3). | The worker runs `apply.format` before `apply.verify`, and provenance `--after` after the format. |

### v0.9.0

Brownfield cost work, on top of v0.7.12. Greenfield is unchanged from v0.7.12. The work was built on a separate branch in the steps below, newest first.

| Area | v0.9.0 |
|---|---|
| Helper prompt cache | The run-start `cache-ttl-check.mjs` step and the policies' `subagent_cache_ttl` key are gone; nothing writes `.claude/settings.local.json`. Brownfield keeps one hour on every helper through agent frontmatter: the orchestrator and architect (as in v0.7.12), discovery, and the brownfield reviewer copies `brownfield-senior-reviewer` and `brownfield-security-reviewer`. Greenfield's reviewers are unchanged. |
| Apply form | `execute_with_model` and `execute_batch` refuse an apply-form packet unless `.sdlc/local/write-contract.json` is active, so only a brownfield run past Gate 0 writes through it. |
| Repo scout | Removed from every policy and from the pipeline. |
| Policies | `sonnet-plus-flash` is not shipped. |

#### Brownfield step 0.8.12

| Area | Before | From v0.8.12 |
|---|---|---|
| Verify on Markdown, MDX and YAML files | `plan-to-packets` passed a unit's `biome check <file>.mdx` through as its verify. Biome does not process those files and exits 1 on any content, so Large2-C spent 6 worker attempts and 2 hand-written refinement packets on two docs pages that were already correct. | Biome check / format / lint commands are dropped for `.md`, `.mdx`, `.yml` and `.yaml` targets. Any other Verify command on the unit stays, and no warning is raised. |
| `apply.format` on hand-written packets | Only packets from `plan-to-packets` carried `format`. Debug and refinement packets the orchestrator wrote by hand left it out, so a Biome spacing difference failed verify and escalated to Opus (Large2-C: 2 escalations). | When `format` is absent, the server derives it from the verify commands with the same rule `plan-to-packets` uses (`biome check X` → `biome check --write X`, `prettier --check` → `--write`). An explicit `format` still wins. |
| Gate 0 file scope | The proposed allowlist covered the files that carry the feature. Large2-D's senior reviewer raised two major findings the run could not act on: the API spec and the MCP tool catalogues were outside the allowlist. | Step 4b proposes the companion files a change needs to be complete as well: the generated API spec and every catalogue of the surface being extended, when discovery finds them. You still edit the list at Gate 0. |

#### Brownfield step 0.8.11

| Area | Before | From v0.8.11 |
|---|---|---|
| Plan length | The architect trimmed a written plan toward the ≈ 400-line soft target (Large2-A: 34 turns, ≈ $3.86). | The line target applies to the one Write only; `long_plan` is informational. |
| Biome on CRLF files | `biome check` failed on edit targets with CRLF endings before any edit, and the architect rewrote verify lines by hand (Large2-A: 21 turns, ≈ $2.07). | `plan-to-packets` adds `--line-ending=crlf` to biome verify and format for CRLF edit targets. |

#### Brownfield step 0.8.10

| Area | Before | From v0.8.10 |
|---|---|---|
| Subagent cache TTL | Multi-model policies declared `subagent_cache_ttl: 1h`; `opus-only` and `opus-only-v5` declared `5m`, `flash-agsdk-only` declared nothing, and preflight warned when a single-model policy asked for 1h. The study's opus-only runs (Runs 22–35) were all measured at 1h through a local policy copy, so a new user's opus-only run did not match the published numbers. | Every shipped policy declares `1h` and the warning is gone. Since 0.8.8 the orchestrator waits for reviewers and test suites inside its turn, so single-model runs wait too; the one 5m opus-only run on 0.8.x (Run 21, $17.43) cost more than every 1h opus-only run after it. `cache-ttl-check --fix` still writes the value and asks for one relaunch when it changes. |

#### Brownfield step 0.8.9

| Area | Before | From v0.8.9 |
|---|---|---|
| Edit lists (`apply.mode: "edits"`) | Positions were `after` / `before` / `replace`, and `replace` covered exactly one line, so a deletion could not be expressed. Run 30's one refinement (an 8-line block cut to 3) ran as a hand splice by the orchestrator instead of a Flash packet. | `position: "delete"` (no `text` needed) and an optional `count` on `replace` / `delete` cover a run of lines from the anchor down. Overlapping spans and spans past the end of the file are refused with a reason the retry carries. The architect writes `×N` after the quoted anchor text for a multi-line site. |
| Action word in the plan | `plan-to-packets` accepted only `new_file` / `edit` / `tooling`; Run 31's orchestrator told the architect `create`, 10 units failed derivation and the plan was edited and re-derived. | Unambiguous synonyms (`create` / `new` / `add` → `new_file`; `modify` / `update` / `change` → `edit`) are mapped, with a warning naming the unit. |
| Collector run id on the single-model path | The run id was read only from a dispatched line's `pass`; hand-logged in-session lines carry `pass_id`, so Run 31's collector stopped with "no run id" until the orchestrator added a `pass` field. | `pass_id` is read as well. |

#### Brownfield step 0.8.8

| Area | Before | From v0.8.8 |
|---|---|---|
| Waiting on subagents and long tests | The orchestrator sometimes ended its turn and was resumed by a completion notification; each resume missed the prompt cache and re-wrote the whole context (Run 28: three resumes, 408k cache-write tokens, ≈ $4.1) | The orchestrator waits inside its turn (a Bash until-loop on the output file). Rates and telemetry fields are unchanged; the saving shows as fewer 1h cache-write tokens. |
| `execute_batch` input and receipt | The orchestrator read `packets.json` (~15k tokens) and typed every packet back as tool input; the receipt restated routing and token counts for every applied packet (~8k tokens) | `packets_path` (+ optional `packet_ids`) lets the server read the file; tooling packets are skipped and listed. The receipt is one line, and an applied, verified packet keeps only path, lines, cost, attempts, verify and any non-routine field. Telemetry still records every figure. |

#### Brownfield step 0.8.7

| Area | Before | From v0.8.7 |
|---|---|---|
| Brownfield reviewers | The senior and security reviewers opened touched files one `Read` at a time, re-ran tests, typecheck, route generators and `pnpm audit`, and read library source to prove findings (Run 28: 49 + 30 tool uses). Every tool use re-reads the whole context, which is most of an Opus run's cost | Same two phases, same checklists. Each reviewer loads the whole change in one Bash call, keeps to a tool-call budget (senior about 12, at most 20; security about 10, at most 15), does not re-run commands the orchestrator already ran (it passes a one-line-per-suite summary), and runs the dependency check only when a manifest or lockfile changed. |
| Collector without `manifest.json` | A single-model run handled in-session never calls the server, so no manifest was written and `collect-orchestrator-usage.mjs` exited 1 (Run 29) | The collector rebuilds the window from `telemetry.jsonl` and writes a manifest carrying the run id, policy and booked figures. Rates and telemetry fields are unchanged. |

#### Brownfield step 0.8.6

| Area | Before | From v0.8.6 |
|---|---|---|
| Wrapped `- **File**` bullet in `plan-to-packets` | Only the bullet's first physical line was parsed, so a bullet soft-wrapped before `**Depends on**` gave `depends_on: []` with exit 0 (Run 27b: 10 of 15 units) | Indented continuation lines are joined before parsing, and a unit with no `Depends on` anywhere gets a warning. Rates, telemetry fields and the collector are unchanged. |

#### Brownfield step 0.8.5

| Area | Before | From v0.8.5 |
|---|---|---|
| Repo scout under `opus-plus-flash-v38` | Flash scouted candidate files for the architect; its anchors were mostly wrong four rows running, so the architect re-read every slice | The preset has no `repo_scout` rule, so the scout is skipped and the architect reads the repo itself, as under opus-only. Other multi-model presets keep the scout. |
| Cross-unit imports | The worker guessed a sibling unit's module path; the error surfaced only at the deferred typecheck and was debugged by the premium model (Run 25: three of four debug rounds) | The multi-model plan carries an `- **Imports**` bullet with each statement as written; each worker packet also receives the sections of the units it depends on; and under `--multi-model` every JS/TS packet's verify starts with `check-imports.mjs`, so an unresolvable import or a missing default/named export fails on the mechanical tier and the worker retries with the files that do exist. Rates, telemetry fields and the collector are unchanged. |

#### Brownfield step 0.8.4

| Area | Before | From v0.8.4 |
|---|---|---|
| Edit sites in `plan-to-packets` | Read only a `- **Edit anchor**` bullet (or a `### Edits` heading) with `` `:N` `` / `L<n>` / "line N" references. A `- **Edit**` bullet with `` `after :280 -> rule` `` items found no sites, so edit units fell back to whole-file packets (Run 24: 5 of 5) | `- **Edit**` / `- **Edits**` bullets are read like `- **Edit anchor**`, and `after` / `before` / `replace` / `insert` / `delete` followed by `:N` is an edit site. Run 24's plan now derives 8 edit lists instead of 0. Rates, telemetry fields and the collector are unchanged. |

#### Brownfield step 0.8.1

| Area | Before | From v0.8.1 |
|---|---|---|
| Batched dispatch under a multi-model policy | `execute_batch` was missing from the orchestrator's `tools:` list, so the orchestrator handed each batch to a helper subagent, whose transcript counted toward `orchestrator_overhead` | The orchestrator calls `execute_batch` itself. Rates, telemetry fields and the collector are unchanged. |
| Architect tools and plan form | `Read, Write` only: files were found by guessing paths, and any fix rewrote the whole plan; the multi-model plan carried the full per-unit form | `Edit` and read-only search added. The plan is written once and fixed section by section; both policies use the brief form, and multi-model adds only verbatim anchor text and import specifiers. Architecture-phase cost per run is expected to fall; the pricing rules are unchanged. |

### v0.7.12

A greenfield run goes through the typed-spec executor: `/mmo:greenfield` and `/mmo:pass` alike (before v0.7.12 `/mmo:pass` needed `--executor`; the flag is still accepted and changes nothing). Every brownfield run keeps the packet flow and change only by the rows under **Every run**.

**The greenfield executor**

| Area | From v0.7.12 |
|---|---|
| Who writes the product's files | Code. The architect hands a typed spec over in sections, each a JSON file it writes with the Write tool (`submit_spec_section`, then `finalize_spec`, which renders `design.md`). `execute_stage` types, checks and writes every file, one stage at a time (codegen, tests, docs), and returns one short receipt per stage. No file passes through the orchestrator's conversation, where in the packet flow every file does |
| Who types a file | The typist the policy routes the file's stage to, at `retry_count` 0 and 1, then one lean Opus attempt when the policy has a Claude model (a policy without one types with its own models only). `lean-opus` is a `claude -p` call with no tools and the shared spec as its cached system-prompt tail (it keeps the session's login and provider settings: an OAuth token, a gateway address and token, Claude on Bedrock, Vertex AI or Foundry; an API key reaches it only under `--auth=vendor`, from the Claude leaf's `auth.env`, else `ANTHROPIC_API_KEY`), `flash-completion` is Gemini through the completion door, and `agy` is Gemini through the Antigravity SDK. Every typist types at low effort. The executor sends no task type; how it reads a rule that names one is under *A policy written for the packet flow*. An answer cut off at a typist's output limit goes to the next typist in the plan, never the same one again |
| Checks on a typed file | The same for every language: the path it names, a safe path inside the code directory, not empty. No file is parsed. Whether a file is right, syntax included, is judged by the project's own build and tests and the repair rounds |
| Fixes | Review and test fixes are routed as phase `debug` and typed by the same ladder, as exact edits to the file's current text. A fix may create a file the spec does not list (`new_file: true`); the receipt lists it under `created` |
| Tests and fixes | The orchestrator runs the spec's install and check commands itself, reads what fails, and sends each file to change to `execute_stage` stage `repair` (`failures`: the file, the failing test and its error, the files to show beside it). It repeats while the number of failing tests goes down, at most three repair rounds, and runs the checks once more after the senior review's repair round. It reads the failing output itself: it starts no other helper to diagnose and writes no project file (the executor guard refuses both). What still fails is reported at the next gate |
| A check the machine cannot run | Each spec command states its own `timeout_s`; no limit lives in code. A command stopped at that limit, one whose program the shell cannot find (exit 127), or one with no stated limit is `not_run`: acceptance marks its criteria not checked and routes it nowhere |
| Acceptance | Code's verdict, not the orchestrator's. The spec's acceptance list gives every acceptance criterion a command with a pass rule in the brief's own words (an exit code, and output lines the brief forbids, matched by prefix without regard to case), or a reason no command can check it (a person, a device). `finalize_spec` refuses a list that leaves a criterion out or names no dependency audit (or a reason for none). After the security review, `execute_stage` stage `acceptance` runs every command with its whole output kept and the model vendors' credentials removed from its environment, marks each criterion pass, fail or not checked, and writes `acceptance.json` and `acceptance.md`. An install or audit failure goes back to the architect, whose turns run on the policy's judgment model; a failing check goes to a repair round. The stage runs at most once plus three re-checks. The collector copies `acceptance.md` into SUMMARY.md between `<!-- acceptance:start -->` and `<!-- acceptance:end -->` on every run |
| A policy written for the packet flow | Runs as it is. Every setting the executor reads has a default: a stage with a rule of its own (the stage, and no `task_type`, `module` or `intent`) is routed by it and narrower rules for that stage are set aside; a stage routed only by narrower rules is routed by them read by stage alone, the first one listed first; a rule naming a `task_type` or `module` and no stage is set aside; a policy with no default rule gets one for any stage no rule routes (its first Claude model, else its first model, through the `select` slot that offers it); the lean Opus last attempt follows the run's `select` choice. The `preflight_dispatch` reply and the run's first receipt list each default applied under `policy_notes`, naming rules by their place in the file, counted from 1 (`test/policyDefaults.test.mjs` runs every policy of the release before the executor through these checks) |
| One run, one policy | `preflight_dispatch` records the run's auth mode and policy, and a spec's first stage binds them. A later stage of the same spec whose latest pre-flight asked for different ones stops (`stopped` in the receipt) and types nothing. Another spec binds its own, so two `/mmo:` runs in one chat may use different policies |
| What the orchestrator may do | An orchestrator that has called `execute_stage` may launch only the pipeline's own helpers and write only inside its own run's record folder (`plugin/scripts/executor-guard.mjs`), so every change to the product is typed by the typist the policy names. Brownfield runs and the main chat are untouched |

**How executor calls are billed**

| Call | Recorded as | Priced from |
|---|---|---|
| A `lean-opus` typist call | One dispatched event, `door: "lean-opus"` | Its own `claude -p` result's per-model tokens at the list, like any `claude-cli` worker |
| A `flash-completion` typist call | One dispatched event, `door: "flash-completion"` | Its tokens at the list, by the completion door's rules (**Every run**, below) |
| An `agy` typist call | One dispatched event, `door: "agy"` | The session usage its worker records, also when the call failed or ran out of time |
| A call that left no receipt: a `lean-opus` call killed at the 540 s typist limit or one that crashed, or an `agy` worker killed when it hangs past that limit | One dispatched event at $0, its error saying its usage is unknown | — |
| A command the acceptance stage runs | No event: no model is called | — |

Typist events sum into `total_cost_usd` like every dispatched event, and the collector adds the orchestrator session as before. Typists run in scratch directories and write no transcript, so the transcript scan never counts them, and the collector never subtracts their events from the true total, even on a `claude-cli` model.

**Every run**

| Area | Before | From v0.7.12 |
|---|---|---|
| Who types a code file in the two-model policies | A code packet went to the cheaper model only when its `task_type` was on a list written for NestJS/React projects (`controller_handler`, `dto`, `react_component`, ...); any other type, and the catch-all `other`, fell to the default rule (Opus) | By stage alone, whatever the file's language, name or type: the codegen rule of `opus-plus-flash`, `-v37`, `-v38`, `opus-plus-sonnet` and `-max` matches on phase only (`test/stageRouting.test.mjs`) |
| The orchestrator's and architect's prompt cache | Claude Code's helper default of five minutes, so a wait longer than that wrote the whole conversation again | `experimental.cacheTtl: 1h` in `plugin/agents/orchestrator.md` and `plugin/agents/architect.md`. Each cache write bills at 2× input instead of 1.25×, and a wait of up to an hour no longer re-writes the conversation. The transcript records each write's lifetime, and the collector prices each at its own rate |
| The pipeline helpers' effort | Inherited from the launching session | `effort: high` in the orchestrator, architect, senior-reviewer, security-reviewer and discovery agent files, so it no longer depends on how a run was launched |
| Background launches of the pipeline's own helpers | Allowed | Refused with a reason by a PreToolUse hook (`scripts/foreground-helpers.mjs`), and the model launches the helper again in the foreground. Refused: a helper named `mmo:<name>`, or one named by its bare name from inside the plugin's own orchestrator. A person's own agent with the same bare name, and every other agent, is untouched |
| Completion-door (`flash-completion`) thinking level | The adapter never read the leaf's `reasoning.tier`, so every call ran at Google's default | The tier is sent as `thinkingConfig.thinkingLevel`, as written (`minimal`, `low`, `medium`, `high`), the value the agent door already sends. A leaf with no tier sends none, and no shipped policy sets one. Thinking tokens bill at the output rate, so a lower tier lowers a call's output dollars |
| A completion-door call Google answered with an error status (429, any other 4xx, 5xx), or that never reached Google (no address, refused, no route) | Billed the prompt as input, estimated from its length | Billed $0. Vertex AI charges "only for requests that return a 200 response code" (its pricing page), and the Gemini API does not charge for a request that fails with a 400 or 500 error (its billing page). A connection that failed with no response keeps the prompt billed as input, since the request may have been answered. Each failed attempt records the HTTP status (`error_status`), a network error code (`error_code`) and any retry delay Google asked for (`retry_after_ms`) |
| Run card | — | `preflight_dispatch` returns `run_card`: the plugin version and git commit (only when the plugin folder is its own repository's top, or the clone its marketplace file names; a repository that merely contains an installed copy says nothing about the plugin's code, so no commit is given), whether its tree had uncommitted changes, Claude Code's version, a digest of the settings files, and every setting that overrides the pinned prompt-cache lifetimes (`FORCE_PROMPT_CACHING_5M`, `DISABLE_PROMPT_CACHING*`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, `subagentPromptCacheTtl`), named and never valued. An override logs `run.cache_override`; it never halts a run. A settings file that cannot be read or is not JSON is listed under `settings_problems` and skipped; it never halts pre-flight |
| manifest.json at Phase 9 | Typed by the orchestrator from a prose description of the shape, so its field names could differ from one run to the next | Written by `scripts/write-manifest.mjs` from `telemetry.jsonl` with the server's `buildManifest`, plus the run log's gate answers, file and line counts and a status. The counts are the product's files under `code_dir` for a new app; in brownfield, the files the run's record lists (`written-files.json`, `provenance.json`), left out when there is no record. A file that cannot be read (a dangling link, a locked folder, a link loop) is skipped and named on a `note:` line, never fatal. The collector's own fields are kept while the dispatched total they were computed from is unchanged; otherwise they are left out, with a `note:` line printing the collector command to run again. The orchestrator writes SUMMARY.md (total cost, breakdown by phase and model, links) from it |
| Typed gate answers (collector) | A gate answered by typing in the chat ("accept") read as the start of another invocation, so the receipt rule refused the run | A human turn between a gate's `gate.open` and `gate.resolved` lines in the run log is that gate's answer (exactly one turn inside the gate) and counts as part of the run. A gate with no `gate.resolved` line takes as its answer only a turn before `run.end` (else the run ends at its last dispatched event), so a request typed after an unanswered gate still closes the window; and when the receipt bills only a later leg, a gate answer sent by `--resume` is read as a new invocation, as before. The receipt rule is otherwise unchanged |
| Where `mmo-log.mjs` writes without `--project-root` | The git root, else the current folder, so a call from inside a greenfield product (not a git repository) wrote a new `.sdlc/` into the product | Inside a git repository: the nearest folder holding `.sdlc/`, never above the git root, then the git root. Outside any git repository: the current folder, never an ancestor's `.sdlc/`. `--project-root <dir>` and `--project-root=<dir>` both name the folder (`tools/test/logging.test.mjs`) |

No cost total on screen before the run ends: `/mmo:greenfield` and `/mmo:pass` tell the chat to show the person no cost total at a gate or between gates. In interactive runs the chat kept a "Running total" of its own, summed from stage receipts and its estimates, and gate messages carried a "Cost so far"; both leave out what the session and its helpers cost, so the figure read several times lower than the run's real cost (a run showing $6 had cost about $26 by then). The run's cost is reported once, when the run ends. No figure the run books is affected: the collector never read those lines (`tools/test/command.test.mjs`).

No cost cap: no shipped policy declares `hard_cost_cap_usd` any more, and a policy that does has the figure set aside at load with a warning. Nothing ever enforced it, and a chat that read the figure took it for a real limit and paused a run to ask about it. The orchestrator makes at most three repair rounds after a failing check run, and the acceptance stage at most three re-checks; neither is bounded by dollars.

Figures that move on the same tokens:

| Case | Before | From v0.7.12 |
|---|---|---|
| A completion-door call to Gemini 3.8 Flash (global, $0.75 per M input) with a 10,000-token prompt, answered with HTTP 429 or 503 | $0.0075 | $0 |
| Any completion-door call that succeeded, any agent-door call, and any Claude token | Unchanged | Unchanged |

No rate on the price list changed. A run's bill changes through what the run does: in an executor run every file is typed by a dispatched typist call and never enters the orchestrator's conversation, and the orchestrator and architect write one-hour caches.

### v0.7.4

| Area | Before | From v0.7.4 |
|---|---|---|
| Agent-door (Antigravity SDK) input tokens | Every sidecar read as Gemini's API convention: fresh input = `prompt_token_count` − `cached_content_token_count`, floored at zero | Read by the SDK version recorded in the sidecar ([`AGY_USAGE_SEMANTICS`](../plugin/mcp/model-dispatch/src/delegation/workerProcess.ts)): 0.1.9 counts cached input inside `prompt_token_count` (unchanged reading); 0.1.16 counts it on top, so fresh input = `prompt_token_count`. Each listed version was checked against Google's own token counter (Cloud Monitoring `aiplatform.googleapis.com/publisher/online_serving/token_count`) for a real job. A version not listed is billed on the larger reading and logs `agsdk.usage_semantics_unverified`. |
| Worker SDK install | `google-antigravity>=0.1.7`, so a new install took whatever was newest | Pinned `google-antigravity==0.1.16`; raise it only after the same check adds the new version to `AGY_USAGE_SEMANTICS`. |

Figures that move on the same tokens:

| Case | Before | From v0.7.4 |
|---|---|---|
| An agent-door job on SDK 0.1.16 with 39,439 fresh and 128,714 cached input tokens and 4,240 output tokens (Gemini 3.8 Flash, global) | $0.025554 — the fresh input billed as zero | $0.055133 |
| Any agent-door job on SDK 0.1.9 | Unchanged | Unchanged |

Delegated agent-door costs recorded by v0.7.3 or earlier with SDK 0.1.16 are low by the fresh input they dropped; re-pricing a sidecar with v0.7.4's `mapSidecarTokens` gives the corrected figure. Completion-door (MCP) dispatches, Claude costs and the orchestrator figure are unchanged.

### v0.7.3

| Area | Before | From v0.7.3 |
|---|---|---|
| Where rates come from | Each policy YAML's `pricing:` block, with no dates | One dated price list, [`prices.ts`](../plugin/mcp/model-dispatch/src/prices.ts). A policy block bills only under `pricing_override: true` (`price_basis: "custom"`); a block more than 0.5% off the list is ignored with a warning naming both prices. Shipped blocks equal the list, and `npm test` fails when one drifts. |
| Rates for the orchestrator's estimated events | The orchestrator read the policy YAML's `pricing:` block, even when pre-flight warned that the block differed from the list, and pre-flight halted an estimated run whose in-session model had no block | `load_policy` returns each model's `effective_price` for the day, the price a dispatch bills, and the orchestrator prices its estimates from it. A block is documentation unless `pricing_override: true`, and an in-session model needs none. |
| A model or day with no price | Every leaf carried a block, so any number in it was billed | Unpriced, never borrowed from a similar model. `preflight_dispatch` halts before the run, an adapter refuses the dispatch, and the collector lists the tokens under `unpriced` and labels the figure `INCOMPLETE` (exit 1 with `--strict-pricing`). |
| Model names | Compared as written, so the receipt's `claude-opus-5[1m]` never matched the transcript's `claude-opus-5` | Read through `resolveModel`: an exact id, an id plus `-YYYYMMDD`, or either plus a bracketed Claude Code option such as `[1m]`. A name the list does not carry is also read when the run's policy declares it as a `model_name` under `pricing_override: true` (exactly, or with one bracketed option), priced at that card. With a receipt, a name on either side that neither reads stops the collector (exit 3); without one, that model's tokens are listed under `unpriced` and the figure is labelled `INCOMPLETE` (exit 1 with `--strict-pricing`). |
| `claude-cli` worker cost | Claude Code's own `total_cost_usd`, copied | The result's per-model `modelUsage` tokens at the list. Claude Code's figure is kept as `cli_reported_cost_usd`, and a difference past 0.5% logs `pricing.cli_cost_mismatch`. |
| Orchestrator transcript | Every token at the policy driver model's one rate | Each message at its own model's list price for its day, `speed`, `service_tier`, `inference_geo` and cache-write TTL, recorded per model and role in `per_model`. |
| Headless receipt | Booked at Claude Code's own dollars only when input, cache read and cache write equalled the receipt for every model and output did not exceed it; a shortfall exited 3 | Booked at the receipt's token counts priced from the list when no transcript bucket is above the receipt and the window is provably the receipt's invocation (or every bucket is equal). The gap is `unlogged_billed`, `attribution_complete` says whether every helper transcript was read, and Claude Code's dollars are kept as `receipt_cli_usd`. A receipt with no `modelUsage` exits 3. |
| Resumed run (a second human turn inside the window) | The last invocation had to equal the receipt on every bucket, else exit 3, and the whole window was then written transcript-priced as `transcript (receipt covers only the last invocation, verified …)` | The last invocation is checked by the headless-receipt rule above, opening at its own human turn, and its receipt is booked at the list as `receipt for the last invocation (…); N% of it billed but not logged; K earlier invocation(s) transcript-priced, unverified`, with `unlogged_billed` and `attribution_complete` for that invocation only. The earlier invocations stay transcript-priced and unverified, and the report still says PARTLY VERIFIED. An equal last invocation books the same dollars as before; one below the receipt, which exited 3, is now booked when it is provably the receipt's invocation. |
| Report | One orchestrator figure | The figure by role and model, what a booked receipt billed that no transcript logged or a floor note when none was booked, and lines for custom prices, unpriced tokens and incomplete helper attribution. |
| Shipped policies | Gemini 3.7 Flash was the newest Gemini model in a shipped policy (`opus-plus-flash-v37`) | `opus-plus-flash-v38` added: the same routing, doors and cap as `opus-plus-flash-v37`, with both Gemini leaves on Gemini 3.8 Flash (GA 2 Sep 2026, introductory 0.75 / 0.075 / 3.75 through 31 Dec 2026). A dispatch dated before 2 Sep 2026 is refused as unpriced. |
| Policy console | Required a `pricing:` block on every model: a block-less policy threw when opened and could not be previewed or saved, and a block's rates were shown as the rate | A model with no block opens, previews and saves (the save check matches the loader's), its rate reads "list price", and a block's rates carry a note that runs bill the price list unless `pricing_override: true` |
| `simulate_policy` what-if | Each event at the policy block, with no Vertex regional surcharge, so a regional install's Gemini what-if read 10% below the run's logged dollars | Each event at its effective price on its `ts` day, and a Gemini event adds the +10% regional surcharge at the endpoint this server would dispatch it to (a worker leaf's `region:`, else `GOOGLE_CLOUD_LOCATION`; none through an AI Studio key, at `global`, or before 1 Jul 2026), by the rules the adapters bill with |
| Driver-model start check | Said a project's settings files are never applied | Gives the terminal routes (an `export`, or the project's `.claude/settings.local.json`) and the desktop route (`~/.claude/settings.json`), and reads `settings.local.json` when it looks for a value this session does not see. |

Figures that move on the same tokens:

| Case | Before | From v0.7.3 |
|---|---|---|
| Sonnet 5 dispatched through the API (`opus-plus-sonnet`) | Card 3.00 / 0.30 / 15.00 | List 2.00 / 0.20 / 10.00 (verified 2026-09-14: the launch price became the standing price), so two thirds of the earlier dollars |
| Claude Fable 5.1 session with Claude Opus 5 helpers (fixture `fable-session-opus-helpers`) | $12.577352 | $13.933431 |
| Headless run with two Opus 4.8 calls no transcript recorded (fixture `headless-unlogged-calls`) | exit 3, nothing written, under a policy whose `pricing` blocks equal the list (the fixture's own block-less `policy.yaml` exits 1 on v0.7.2, whose loader required a block) | $14.197776, 2.32% billed but not logged |
| Gemini 3.5 Flash-Lite leaf whose block says 0.50 / 0.05 / 3.00 (the governance demo policy's `flash-lite`) | Billed at the block | List 0.30 / 0.03 / 2.50 (GA 21 Jul 2026, verified 2026-09-14); the block draws a `pricing.policy_mismatch` warning |
| A run using Gemini 3.7 Flash or 3.8 Flash on or after 1 Jan 2027 | Billed at the policy block (the introductory card, in the shipped 3.7 Flash policies; no 3.8 Flash policy shipped) | Billed at the list's 2027 card, 1.50 / 0.15 / 7.50, published on both Google pages; a block still carrying the introductory card draws a `pricing.policy_mismatch` warning and does not halt |

Apart from the 2027 row above, the Opus and Gemini leaves of the policies v0.7.2 shipped bill the same dollars as before (`opus-plus-flash-v38` is new in v0.7.3 and has no earlier figure): their cards already equalled the list, and the Vertex regional surcharge is still applied at dispatch.

Gemini models on the list, with their periods in [Pricing table provenance](#pricing-table-provenance): 3.5 Flash, 3.5 Flash-Lite, 3.7 Flash and 3.8 Flash, each from its GA day. Gemini 3.5 Flash-Lite (from 21 Jul 2026) and Gemini 3.8 Flash (introductory 0.75 / 0.075 / 3.75 from 2 Sep 2026 through 31 Dec 2026) were added on 2026-09-14, together with the 1.50 / 0.15 / 7.50 period from 1 Jan 2027 for both 3.7 and 3.8 Flash. At a non-`global` Vertex endpoint each of these periods bills Google's published Non-global row, the list rate ×1.10. A Gemini model Google prices but the list does not carry (Gemini 3.6 Flash, for example) halts pre-flight with `Cannot price N of M models`, naming the policy model, the file to add its verified period to, and the `pricing_override: true` alternative.

### v0.7.2

- When `manifest.json` has no top-level `started_at` / `ended_at`, the collector rebuilds the window from the run's own `telemetry.jsonl` with `buildManifest` instead of stopping.
- A window opened at the first dispatched call is labelled a lower bound (`window.lower_bound`), not approximate: it leaves out everything the driver did before that call.

### v0.7.1

- The collector's window opens at the run's own command turn and closes at the first human turn after `run.end`, or at the end of the session file; both anchors are exact.
- The receipt check compares every token bucket per model, and `--receipt-tolerance` (a 5% shortfall allowance) is removed.
