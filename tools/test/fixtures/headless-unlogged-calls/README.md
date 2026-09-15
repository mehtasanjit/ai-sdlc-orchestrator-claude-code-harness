# headless-unlogged-calls fixture

One real headless `/mmo:pass` run (`claude -p --output-format stream-json`, Claude Code 2.1.245, plugin 0.6.0, 2026-09-10). The session ran on Claude Opus 5 with the 1M context option, so the receipt names it `claude-opus-5[1m]`. Four helpers ran on Claude Opus 4.8: one `mmo:orchestrator` helper (spawn depth 1), which spawned the architect, senior reviewer and security reviewer (depth 2).

| Model | Source | in | cache read | cache write | out | Dollars |
|---|---|---:|---:|---:|---:|---:|
| `claude-opus-5` | log (session file, 10 messages) | 20 | 327,898 | 20,329 (all 1-hour) | 5,295 | $0.499714 at the list |
| `claude-opus-5[1m]` | receipt | 20 | 327,898 | 20,329 | 5,295 | $0.499714 |
| `claude-opus-4-8` | log (4 helper files, 112 messages) | 224 | 12,247,927 | 404,585 (all 5-minute) | 188,601 | $13.368765 at the list |
| `claude-opus-4-8` | receipt | 228 | 12,651,407 | 423,523 | 188,968 | $13.69806225 |

The receipt bills 4 input, 403,480 cache-read, 18,938 cache-write and 367 output Opus 4.8 tokens that no transcript records. At the list, with the helpers' logged all-5-minute writes, that is $0.3292975, or 2.3% of the bill. The log priced per message comes to $13.868479. The receipt's tokens at the list come to $14.19777625, which is also Claude Code's own `total_cost_usd`.

All four helpers named by an `Agent` result have a transcript file, and no helper file is unnamed. The session file names the orchestrator helper in `toolUseResult.agentId`; that helper's own file names the other three in the result text (`agentId: <id> (use SendMessage ...)`).

## What each rule does with it

| Collector | Outcome |
|---|---|
| Exact receipt rule (0.7.2), this fixture's own `policy.yaml` (no `pricing` blocks) | exit 1: `Policy model: missing 'pricing'`. The 0.7.2 loader required a `pricing` block on every model, so no transcript is read |
| Exact receipt rule (0.7.2), the same two models with `pricing` blocks equal to the list | exit 3: `the transcript is BELOW the CLI's own receipt`, naming Opus 4.8's input (224 < 228), cache-read and cache-write buckets (output 188,601 ≤ 188,968 is allowed). The receipt's `claude-opus-5[1m]` never matched the log's `claude-opus-5`; it is printed only as a receipt model no transcript records, because that rule checks BELOW before anything else |
| Fix D (0.7.3) | books $14.197776 (the receipt's tokens at the list, $14.19777625, to the micro-dollar): the window is provably the receipt's invocation, `unlogged_billed` is the Opus 4.8 gap ($0.329297), `attribution_complete` is true |

## What was kept

- `transcripts/`: the session file and its four `subagents/agent-<id>.jsonl` files, reduced the way `fable-session-opus-helpers` is: assistant lines keep `type`, `timestamp`, `sessionId`, `agentId`, `uuid`, `parentUuid`, `isSidechain` and `message.{id, model, stop_reason}`, with `usage` reduced to the token counts, the `cache_creation` split, `service_tier`, `speed` and `inference_geo`. `Agent` tool uses keep `{type, id, name}`. A line returning an `Agent` result keeps `tool_use_id` and either `toolUseResult.agentId` or the single `agentId: …` line of the result text. The run's command turn keeps only the `/mmo:pass` command tags. Each `agent-<id>.meta.json` keeps `agentType`, `toolUseId`, `parentAgentId` and `spawnDepth`.
- `pass1/live-run.log`: the capture's last `result` line, reduced to its type, session id, turn count, `total_cost_usd`, the top-level `usage` token counts and each `modelUsage` entry's token counts and `costUSD`.
- `pass1/telemetry.jsonl`: all 53 dispatched events, reduced to identity, model, provenance, tokens, cost and outcome, with `routing` reduced to the policy name, version and rule index.
- `pass1/manifest.json`: the model-written manifest's `pass_id`, `policy`, `auth_mode` and `totals`. It has no top-level window, as on the real run, so the collector rebuilds one from `telemetry.jsonl`.

## What was removed or moved

Every message text, prompt, tool input and output, path, working directory, version, attribution field and result text is removed, and so is every other line. The run log is reduced to its `run.start` and `run.end` markers without path or policy fields; on the real run it sat at `<project>/.sdlc/runs/pass1/orchestrator.log`, and here it is in the pass directory, the second place the collector looks. `policy.yaml` is the run's repo-local policy reduced to its two models and judgment routing, with no pricing blocks (the collector prices from the list).

The consuming suite is `plugin/mcp/model-dispatch/test/collectReceiptBooking.test.mjs` (T5).
