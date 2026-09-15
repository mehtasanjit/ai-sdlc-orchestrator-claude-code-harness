# Logging

> **For:** watching what a run is actually doing — delegations, model dispatches, routing decisions, AG SDK worker sessions. **Also see:** [understanding-output.md](understanding-output.md) · [methodology.md](methodology.md) · [troubleshooting.md](troubleshooting.md).

Every phase boundary, gate, subagent hand-off, model dispatch, vendor API call, and Antigravity SDK
worker session emits a line prefixed `MMO:`. This is a trace of what a run did, not a cost ledger —
see [methodology.md](methodology.md#the-mmo-log-stream-is-not-telemetry) for how it differs from
`telemetry.jsonl`.

## Turning it on

Default level is `info` — phase and gate boundaries, routing decisions, dispatch summaries, AG SDK
spawn and exit. Nothing per-call, nothing at the vendor-API level.

| To get | Set |
|---|---|
| Per-call detail: adapter internals, env/credential resolution | `MMO_VERBOSE=1` or `MMO_DEBUG=1` |
| A specific level | `MMO_LOG_LEVEL=trace\|debug\|info\|warn\|error` |
| Worker stderr passthrough, payload byte counts | `MMO_LOG_LEVEL=trace` |
| One run, without changing the environment | pass `log_level` or `verbose: true` on the MCP tool call |

`MMO_LOG_LEVEL` outranks `MMO_VERBOSE`/`MMO_DEBUG`; the per-call argument outranks everything —
it's the only way a `--verbose` on one run reaches a server process that started when the session
did. Legacy `SDLC_DEBUG=1` still works as an alias for `MMO_DEBUG=1`, with a one-time warning.

For the model-dispatch MCP server specifically, `MMO_LOG_LEVEL`, `MMO_VERBOSE`, and
`MMO_LOG_PREFIX` have to be forwarded through `plugin.json`'s `mcpServers.model-dispatch.env`
block same as any credential — a stdio server inherits nothing from its parent. Both shipped
install routes (`plugin.json` and `tools/setup.mjs`) already forward all three.

## Reading it

```bash
tail -f .sdlc/runs/<run-id>/orchestrator.log
```

or, live, since every line also goes to stderr:

```bash
claude --print "/mmo:pass --auth=vendor --run-id=pass1 my-brief.md" 2>&1 | grep "MMO:"
```

## Line format

```
MMO: 2026-08-18T11:04:22.418Z INFO  dispatch.end packet_id=tp_codegen_004 model_id=flash-completion ok=true tokens_in=8214 tokens_out=1902 cost_usd=0.0031 latency_ms=4180
```

Greppable by the `MMO:` prefix, parseable as logfmt after it.

| Element | Rule |
|---|---|
| Prefix | `MMO: ` — overridable via `MMO_LOG_PREFIX` |
| Timestamp | ISO 8601, UTC, millisecond precision |
| Level | Upper case, column-padded so `INFO` and `ERROR` align |
| Event name | A dotted verb — `phase.start`, `dispatch.end`, `agsdk.worker.stderr` |
| Field order | Insertion order of the emitting call. Never sorted, so two runs diff meaningfully |
| Values | Bare when they match `^[A-Za-z0-9_./:@+-]+$`; double-quoted with `\`/`"` escaped otherwise |
| Newlines/tabs in a value | Escaped to `\n` / `\t` — a log line is always exactly one line |
| `null` / `undefined` fields | Omitted entirely, never printed as `key=null` |

## Levels

| Level | Emitted | Contents |
|---|---|---|
| `ERROR` | always | dispatch failures, halts, worker crashes |
| `WARN` | always | write-contract denials, preflight warnings, price mismatches and unpriced models, retired names still in use |
| `INFO` | always | phase and gate boundaries, routing decisions, dispatch summaries, AG SDK spawn and exit |
| `DEBUG` | verbose only | per-call detail, adapter internals, env and credential resolution |
| `TRACE` | verbose only, explicit `MMO_LOG_LEVEL=trace` | worker stderr passthrough, payload byte counts, inventory detail |

## Sinks

| Sink | Path | When |
|---|---|---|
| stderr | — | Always. Never stdout — stdout is the MCP stdio JSON-RPC transport, and one stray byte corrupts the framing. |
| Run log — orchestrator prompt | `.sdlc/runs/<run-id>/orchestrator.log` in both modes (every `mmo-log.mjs` call passes `--run-id`). The post-run collector reads this file's `run.start` and `run.end` lines to find the run's own command turn in the session transcript (where the window opens) and the first human turn after the run (where it closes); without them the window is approximate and labelled so. Keep `--project-root` the same for the prompt's log calls and for `collect-orchestrator-usage.mjs`. | Once a run id exists |
| Run log — MCP server | `<output_dir>/orchestrator.log`, beside the run's `telemetry.jsonl`; in brownfield that is the same `.sdlc/runs/<run-id>/` file | Once a run directory exists |
| Pre-run fallback | `.sdlc/local/debug.log` | Events before a run directory exists: policy load, credential discovery, env bootstrap |

Rotates at 5 MB, keeping one previous file as `.1`. Two processes can write the run log at once
(the long-lived MCP server and the one-shot `mmo-log.mjs` CLI the orchestrator prompt shells out
to) — appends are atomic, and rotation takes an exclusive lock so the loser of a race keeps
appending instead of corrupting the file.

## What gets redacted

Never logged, at any level, in any field: environment variable values, API keys, tokens, ADC file
contents, prompt text, file contents, model output, diff bodies. Logged instead: names, paths,
byte counts, token counts, 16-character hash prefixes, enum classifications.

Free text that can't be structured (error messages, worker stderr) is scrubbed against the same
secret-pattern registry `dispatch-sanitize.mjs` uses to block a dispatch outright — a match is
replaced with `[redacted:<pattern-name>]` before the line reaches any sink. This is a second,
independent check: redaction runs on the log path even though a secret-shaped input would
normally already have been refused before dispatch.

Check any run for a leak with:

```bash
grep -iE "sk-ant-|AIza|BEGIN PRIVATE KEY|api[_-]?key=[^ ]" .sdlc/runs/*/orchestrator.log .sdlc/local/debug.log
```

This should always return nothing.

## Event taxonomy

Grouped by what emits them. Full field lists live in the source next to each emitter; this is the
event-name index for `grep`.

| Group | Events | Emitted by |
|---|---|---|
| Run lifecycle | `run.start`, `phase.start`, `phase.end`, `phase.skip`, `gate.open`, `gate.resolved`, `run.end` | The orchestrator prompt, via `mmo-log.mjs` (see "Run logging" in `plugin/agents/orchestrator.md`) |
| Subagent delegation | `delegate.subagent.start`, `delegate.subagent.end` | The orchestrator prompt, via `mmo-log.mjs` |
| Model dispatch (MCP) | `tool.call.start`, `tool.call.end`, `packet.validate.fail`, `route.decide`, `adapter.construct`, `dispatch.start`, `dispatch.attempt`, `dispatch.end`, `dispatch.error`, `telemetry.append` | `plugin/mcp/model-dispatch/src/server.ts` |
| Vendor / Agent Platform API | `api.anthropic.request`, `api.anthropic.response`, `api.gemini.backend`, `api.gemini.request`, `api.gemini.response`, `api.gemini.cache.create`, `api.gemini.cache.hit` | The adapters under `plugin/mcp/model-dispatch/src/adapters/` |
| AG SDK worker delegation | `agsdk.spawn`, `agsdk.inventory.before`, `agsdk.worker.stderr`, `agsdk.sidecar`, `agsdk.toolcall`, `agsdk.diff`, `agsdk.exit`, `agsdk.record.write` | `AntigravityWorkerAdapter.ts` |
| Policy, preflight, credentials | `policy.load`, `policy.adapter.deprecated`, `preflight.model`, `preflight.result`, `credential.discover`, `env.legacy_name`, `env.placeholder.strip` | `server.ts`, `credential-discovery.mjs`, `envBootstrap.ts` |
| Pricing | `pricing.policy_mismatch`, `pricing.custom`, `pricing.unpriced`, `pricing.cli_cost_mismatch` | `adapters/dispatchPricer.ts`, `adapters/ClaudeCliAdapter.ts`, `server.ts` |
| Write contract and provenance | `write.allow`, `write.deny`, `provenance.before`, `provenance.after`, `provenance.finalize` | `write-contract-check.mjs`, `write-provenance.mjs` |

## Implementation, if you're changing it

Two independent implementations, because the MCP server (TypeScript, compiled) and the scripts
the orchestrator prompt shells out to (plain ESM) cannot import each other:

| Layer | Files |
|---|---|
| Server | `plugin/mcp/model-dispatch/src/log.ts`, `redact.ts` |
| Scripts | `plugin/scripts/lib/log.mjs`, `plugin/scripts/lib/env.mjs`, `plugin/scripts/mmo-log.mjs` |

Changing the line format, a level rule, or a redaction pattern means changing both.
`tools/test/logging.test.mjs` asserts the two emit byte-identical lines and agree on which strings
are secret-shaped for the same input — a change to only one side fails that test.
