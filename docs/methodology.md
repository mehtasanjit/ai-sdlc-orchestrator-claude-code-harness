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
