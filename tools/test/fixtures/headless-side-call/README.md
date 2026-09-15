# headless-side-call fixture

One real minimal headless run (`claude -p --output-format json`, Claude Code 2.1.270, 2026-09-14). The session ran on Claude Opus 5 with the 1M context option and spawned one general-purpose helper on Claude Opus 4.8. Claude Code also billed a Claude Haiku 4.5 side call that no transcript records.

| Receipt name | Price-list id | in | cache read | cache write | out | Receipt dollars | In the log |
|---|---|---:|---:|---:|---:|---:|---|
| `claude-opus-5[1m]` | `claude-opus-5` | 34 | 28,810 | 8,837 (1-hour) | 154 | $0.106795 | equal, 2 session messages |
| `claude-opus-4-8` | `claude-opus-4-8` | 2 | 0 | 12,202 (5-minute) | 4 | $0.0763725 | equal, 1 helper message |
| `claude-haiku-4-5-20251001` | `claude-haiku-4-5` | 928 | 0 | 0 | 15 | $0.001003 | absent |

`total_cost_usd` is $0.1841705. The log priced per message is $0.183168. Adding Haiku's tokens at the list ($0.001003) gives $0.184171.

The 0.7.2 collector refuses this fixture, with an exit code that depends on the policy it is given:

| Policy given to the 0.7.2 collector | Exit | What it prints |
|---|---|---|
| This fixture's own `policy.yaml` (no `pricing` block) | 1 | `Policy model: missing 'pricing'`: the 0.7.2 loader required a `pricing` block on every model, so no transcript is read |
| The same entry with a `pricing` block equal to the list (5 / 0.50 / 6.25 5-minute write / 10 1-hour write / 25) | 3 | The exact receipt rule: `claude-opus-5[1m]` never matched the log's `claude-opus-5`, so the log's two Opus 5 messages read as `claude-opus-5: 37835 tokens in the transcript, none on the receipt` |

From 0.7.3 names are resolved through the price list, the run is booked, and the Haiku call is priced from the list inside `unlogged_billed`.

## What was kept

- `transcripts/`: the session file and `subagents/agent-a43eadf6d73315739.jsonl`, reduced the same way as `headless-unlogged-calls`: assistant token usage, message ids, models and stop reasons, the `Agent` tool use `{type, id, name}`, the result line's `tool_use_id` and `toolUseResult.agentId`, and the helper's `meta.json` fields `agentType`, `toolUseId` and `spawnDepth`.
- `claude-session.json`: the receipt's session id, turn count, `total_cost_usd`, top-level `usage` token counts and each `modelUsage` entry's token counts and `costUSD`.

## What was synthesized

The run was a plain prompt, not an mmo run. Its one human turn is replaced by a `/mmo:pass` command turn at the same timestamp, so the collector anchors the window there, as it does on a real run. `manifest.json` (window from the first to the last assistant message, $0 dispatched), an empty `telemetry.jsonl` and `policy.yaml` (one in-session Opus 5 entry, no pricing block) are written for the fixture. Every message text, prompt, path, working directory, version and attribution field is removed.

The consuming suite is `plugin/mcp/model-dispatch/test/collectReceiptBooking.test.mjs` (T6).
