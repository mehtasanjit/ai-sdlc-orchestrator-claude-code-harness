# claude-cli worker fixture

A token-only copy of one real headless `claude -p --output-format json` run
(2026-09-14, Claude Code 2.1.270), used by `test/claudeCliPricing.test.mjs`
to prove that a `claude-cli` worker is priced from its own token ledger.

## What the run did

| Model (as the result names it) | Where it is recorded | Tokens | Cache writes |
|---|---|---|---|
| `claude-opus-5[1m]` | session transcript + `modelUsage` | in 34 · cache read 28,810 · out 154 | 8,837, all 1-hour |
| `claude-opus-4-8` | helper transcript (`subagents/agent-*.jsonl`) + `modelUsage` | in 2 · out 4 | 12,202, all 5-minute |
| `claude-haiku-4-5-20251001` | `modelUsage` only (billed, never logged) | in 928 · out 15 | none |

Claude Code's own figure is `total_cost_usd` 0.1841705. Priced from the list
with the transcript's TTL split, the three models come to the same amount
within $0.000001.

## What was kept

- `result.json`: the result object's status fields, `session_id`,
  `total_cost_usd`, the token fields of `usage` (including `cache_creation`,
  `service_tier`, `speed`, `inference_geo`), and per model in `modelUsage`
  only the token counts and `costUSD`. `result` is replaced by `{"ok":true}`.
- `projects/-fixture-worker-project/<session>.jsonl` and
  `<session>/subagents/agent-<id>.jsonl`: assistant lines with `type`,
  `timestamp`, `sessionId`, `uuid`, `parentUuid`, `isSidechain`, `agentId`,
  and `message.{id, model, stop_reason, usage}`; the `Agent` tool call's
  `name` and `id`; the tool result's `agentId`.

## What was removed

All message text and tool input, the working directory, git branch, CLI
version, request ids, and every other line type. The project directory name
is neutral: the real one encoded a local path.
