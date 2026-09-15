# fable-session-opus-helpers fixture

One real interactive `/mmo:greenfield` run (Claude Code 2.1.260, plugin 0.6.0, 2026-09-08) whose session ran on a different model from its helpers:

| Role | Model | Messages | in | cache read | 5m writes | 1h writes | out |
|---|---|---:|---:|---:|---:|---:|---:|
| session | `claude-fable-5-1` | 31 | 874 | 2,785,324 | 0 | 147,929 | 22,750 |
| helpers (5 subagent files) | `claude-opus-5` | 102 | 204 | 4,968,432 | 544,883 | 0 | 129,661 |

Output counts follow the collector's own dedupe rule: a message's terminal (`stop_reason`) line, else its largest value.

## What each figure means

| Pricing | Overhead |
|---|---:|
| Every token at the policy driver's single rate (`claude-opus-4-7`, $5 / $0.50 / $25), what the collector did before per-message pricing | $12.577352 |
| Each message at its own model's list price (Fable 5.1: $10 / $0.25 cache read / $20 1h write / $50; Opus 5: $5 / $0.50 / $6.25 5m write / $25) | $13.933431 |

The $1.356079 difference is the Fable 5.1 session priced at Opus rates.

## What was kept

- Assistant lines: `type`, `timestamp`, `sessionId`, `agentId` (subagent files), `uuid`, `parentUuid`, `isSidechain`, and `message.{id, model, stop_reason}` plus `message.usage` reduced to the token counts, the `cache_creation` 5m/1h split, `service_tier`, `speed` and `inference_geo`. `Agent` / `Task` tool uses keep only `{type, id, name}`.
- The run's command turn, with its text reduced to the `/mmo:greenfield` command tags.
- User lines that return an `Agent` / `Task` result keep only `tool_use_id` and the helper id, written the way Claude Code wrote it: `toolUseResult.agentId` on the three results in the session file (helpers `a7de90a49669913e0`, `ad6451af4f62aeef4`, `a0fe04abc94ec3b62`), and the single `agentId: …` line of the result text on the two nested results in `agent-a7de90a49669913e0.jsonl` (helpers `a2c641503e98ecc4c` and `a3e06ad488f47acef`, lines 125 and 133 of the real file), which carry no `toolUseResult`. All five helper files are named, so the collector reports `attribution_complete: true`.
- Each `agent-<id>.meta.json` keeps `agentType`, `toolUseId`, `parentAgentId` and `spawnDepth`.

Every message text, tool input and output, path, working directory, version and attribution field is removed. Every other line is removed, including the three human prompts typed after the run, so the collector's window runs from the command turn to the end of the session file. That is the window the figures above were measured over.

## What was synthesized

The project folder no longer exists, so its manifest and telemetry are gone. `manifest.json` is written for this fixture: policy `opus-plus-flash` (driver `claude-opus-4-7`), `started_at` at the first helper spawn, `ended_at` at the last helper result, and a dispatched cost of $0 with no events, so the true total equals the overhead. `telemetry.jsonl` is empty.

The consuming suite is `plugin/mcp/model-dispatch/test/collectPerModelPricing.test.mjs`.
