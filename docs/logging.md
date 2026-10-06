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
| Run log — orchestrator prompt | `.sdlc/runs/<run-id>/orchestrator.log` in both modes (every `mmo-log.mjs` call passes `--run-id`). The post-run collector reads this file's `run.start` and `run.end` lines to find the run's own command turn in the session transcript (where the window opens) and the first human turn after the run (where it closes); without them the window is approximate and labelled so. It also reads the `run.start`, `run.end` and gate lines of every run's log under `.sdlc/runs/`, to tell a queued run's Skill call (zero-touch's Stop hook starts it with no turn of its own) from one that answers the person's own turn. Keep `--project-root` the same for the prompt's log calls and for `collect-orchestrator-usage.mjs`. | Once a run id exists |
| Run log — MCP server | `<output_dir>/orchestrator.log`, beside the run's `telemetry.jsonl`; in brownfield that is the same `.sdlc/runs/<run-id>/` file | Once a run directory exists |
| Pre-run fallback | `.sdlc/local/debug.log` | Events before a run directory exists: policy load, credential discovery, env bootstrap |

Rotates at 5 MB: the earlier pieces shift up by one (`.1` to `.2`, and so on) and the full file becomes `.1`; every piece is kept, since a run's oldest piece holds its start and its write contract's freeze record, and the readers take the pieces highest number first. Two processes can write the run log at once
(the long-lived MCP server and the one-shot `mmo-log.mjs` CLI the orchestrator prompt shells out
to) — appends are atomic, and rotation takes an exclusive lock so the loser of a race keeps
appending instead of corrupting the file.

## What gets redacted

Never logged, at any level, in any field: environment variable values, API keys, tokens, ADC file
contents, prompt text, file contents, model output, diff bodies. Logged instead: names, paths,
byte counts, token counts, 16-character hash prefixes, enum classifications.

Free text that can't be structured (error messages, worker stderr) is scrubbed against the
secret-pattern registry in `dispatch-sanitize.mjs` (the server carries a copy, `redact.ts`, kept equal
by `tools/test/logging.test.mjs`) — a match is replaced with `[redacted:<pattern-name>]` before the
line reaches any sink. This is the registry's only use on a run's path: no dispatch runs it on a
model's inputs, so it does not stop a secret inside a file that is not off-limits from reaching a
model ([brownfield-privacy.md](brownfield-privacy.md) says what does keep files out of a prompt).

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
| Run lifecycle | `run.start`, `phase.start`, `phase.end`, `phase.skip`, `gate.open`, `gate.resolved`, `run.end` | The orchestrator prompt, via `mmo-log.mjs` (see "Run logging" in `plugin/agents/orchestrator.md`); a `run.end outcome=aborted` also from `write-contract.mjs --abandon` and zero-touch's "Replace it" (`lib/workflow-log.mjs` `abortRun`) |
| Subagent delegation | `delegate.subagent.start`, `delegate.subagent.end` | The orchestrator prompt, via `mmo-log.mjs` |
| Model dispatch (MCP) | `tool.call.start`, `tool.call.end`, `packet.validate.fail`, `route.decide`, `adapter.construct`, `dispatch.start`, `dispatch.attempt`, `dispatch.end`, `dispatch.error`, `telemetry.append` | `plugin/mcp/model-dispatch/src/server.ts` |
| Vendor / Agent Platform API | `api.anthropic.request`, `api.anthropic.response`, `api.gemini.backend`, `api.gemini.request`, `api.gemini.response`, `api.gemini.cache.create`, `api.gemini.cache.hit` | The adapters under `plugin/mcp/model-dispatch/src/adapters/` |
| Typed-spec executor | `spec.section`, `spec.finalize`, `executor.stage.start`, `executor.stage.end` (a repair round's `stage` is `repair`; `not_routed` counts review findings that named no file inside the code directory), `executor.stage.run_switched` (WARN: a later stage of a run asked for another auth mode or policy; nothing was typed), `executor.acceptance`, `executor.policy_notes` (how the run's first stage read the policy, once) | `src/executor/tools.ts` |
| Hand-off tools (zero-touch) | `handoff.listing` (whether the four hand-off tools are listed, and why), `handoff.document`, `handoff.tests`, `handoff.repeat`, `handoff.undo` (each call's outcome; WARN when it failed), `handoff.refused` (WARN: the call was refused before any typist was paid), `handoff.stopped` (a call the person stopped: nothing landed), `handoff.appeared` (WARN: the new file was created by someone else while the hand-off ran, so nothing was written over it) | `src/handoff/tools.ts`, `server.ts` |
| AG SDK worker delegation | `agsdk.spawn`, `agsdk.inventory.before`, `agsdk.worker.stderr`, `agsdk.sidecar`, `agsdk.toolcall`, `agsdk.diff`, `agsdk.exit`, `agsdk.record.write`, `agsdk.usage_semantics_unverified` (WARN: the sidecar's SDK version has no checked usage reading, so its cost was billed on the larger one) | `AntigravityWorkerAdapter.ts` |
| Policy, preflight, credentials | `policy.load`, `policy.adapter.deprecated`, `policy.setting_ignored` (WARN: a policy key the plugin does not apply, such as `hard_cost_cap_usd`), `preflight.model`, `preflight.result`, `preflight.claude_cli` (WARN: the `claude` CLI the Claude typists need is missing or too old), `preflight.typist_probe` (one line per typist the run-start probe called: its model, door, verdict and cost; WARN when it could not answer), `run.card` (the code and cache rules the run used), `run.cache_override` (warn: a setting that overrides the pinned prompt-cache lifetimes), `run.settings_unread` (WARN: a Claude Code settings file that cannot be read or is not JSON), `credential.discover`, `env.legacy_name`, `env.placeholder.strip` | `server.ts`, `runCard.ts`, `credential-discovery.mjs`, `envBootstrap.ts` |
| Apply form and batches (brownfield) | `packet.hydrate`, `apply.baseline` (checks set aside because the file already failed them before the change), `apply.write`, `apply.verify` (WARN when a check fails), `apply.refused` (WARN: the packet was refused, before any typist call or after a reply, with the reason: for example its path is outside the write contract or not in normal form, it is an edit of a file that does not exist, it is a fix round aimed at a bugfix's reproducing test, one of its commands is denied by the person's Bash rules or hides a command, its path cannot be pasted safely into its commands, or its test file already fails before the change), `apply.escalate` (the next attempt would route to another model), `apply.cut_off` (a reply cut off at a model's output limit; the next model in the ladder takes it), `apply.transport_wait` (a busy-vendor wait, not an attempt), `apply.stopped` (the call was cancelled), `apply.error` (WARN: the packet failed on this machine outside a call, such as a refused disk write or a check that could not start; the original is back on disk), `apply.already_applied` (a re-sent packet this run already applied, its file unchanged since: settled at $0, no typist call), `batch.start`, `batch.end`, `batch.blocked` (WARN: a packet waits on a failed dependency), `batch.error` (WARN), `batch.stopped` (a packet not started because the call was cancelled or the batch halted), `batch.done` | `plugin/mcp/model-dispatch/src/apply.ts`, `batch.ts`, `server.ts` |
| Pricing | `pricing.policy_mismatch`, `pricing.custom`, `pricing.unpriced`, `pricing.cli_cost_mismatch` | `adapters/dispatchPricer.ts`, `adapters/ClaudeCliAdapter.ts`, `server.ts` |
| Write contract and provenance | `write.allow`, `write.deny`, `provenance.before`, `provenance.after`, `provenance.finalize`; `contract.freeze` (in the run's own `orchestrator.log`: the SHA-256 of the contract Gate 0 froze, which the hook and the server's writer compare the contract with) | `write-contract-check.mjs`, `write-provenance.mjs`, `write-contract.mjs` |

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
