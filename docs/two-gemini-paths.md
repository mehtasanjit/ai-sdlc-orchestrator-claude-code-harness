# The two Gemini paths — measured comparison

> **For:** choosing between Gemini as a model vs Gemini as an agent; the actual token / cost / wall-clock numbers on the same brief. **Also see:** [setup.md](setup.md) · [methodology.md](methodology.md) · [architecture.md](architecture.md).

The `opus-plus-flash` policy can reach the mechanical tier as a model or as an agent. Same vendor, same model, same rates. This page records the numbers a single small brief produced down each door on the same machine, so the trade is a number rather than a claim.

## The two doors

| | Model path (`flash-completion`) | Agent path (`flash-agsdk-worker`) |
|---|---|---|
| Auth | Vertex ADC **or** AI Studio API key | Vertex ADC only |
| Client | `@google/genai` completion call | `google-antigravity` SDK, Python subprocess |
| Per-packet shape | one request, one response | tool loop; SDK re-sends full conversation each turn |
| Fixed per-turn overhead | none | ~11.5k prompt tokens (SDK identity preamble) |
| Extra runtime | none | Python 3.10+ |
| Evidence on disk | one telemetry event | telemetry event + task brief + worker sidecar + receipt |

Configuration and the choice mechanism are in [setup.md](setup.md#gemini-as-an-agent--antigravity-sdk).

## One brief, both doors — recorded 2026-08-05

Ping Service brief ([examples/quick-demo/](../examples/quick-demo/)), same policy, same machine, four human approval gates.

| | Model path | Agent path |
|---|---|---|
| Input tokens | 43,027 | 1,714,495 |
| — of which cache reads | — | 1,038,870 |
| Output tokens | 33,647 | 72,727 |
| Recorded cost | $0.84 | $2.18 |
| Packets dispatched | 5 | 5 |
| Delegation evidence files | — | 15 |
| Tests | 2/2 green | 3/3 green |
| Elapsed | 28 min | 63 min |

**23× the tokens for 2.6× the cost.** Context caching moves that ratio: over a million of the agent path's input tokens are cache reads at 10% of the fresh rate. Without it the volume would have been prohibitive.

**Elapsed time is not a system measurement.** Both runs stop at four human approval gates, so the clock includes reviewer time. Tokens and cost are machine-recorded.

**Costs are in estimator mode.** Treat them as the shape of the trade, not an invoice. Vendor-mode figures would reconcile to the Anthropic and Google dashboards.

**The cost row is dispatched work only — it cannot rank the doors.** Neither figure includes the orchestrator session's own loop, and the omission falls unevenly: down the model door the orchestrator reads every file and carries every worker payload through its own context, so its unrecorded overhead is far larger than the agent door's. On measured runs the exclusion was large enough to *invert* the comparison — the door that looks cheaper here was the more expensive one in true total. Only true totals (dispatched + orchestrator overhead, reconstructed from session transcripts by `plugin/scripts/collect-orchestrator-usage.mjs`) compare the doors fairly; see [methodology.md](methodology.md#the-orchestrators-own-cost-and-the-transcript-collector).

Run records:
- Model path: [examples/quick-demo/passes/model-path/](../examples/quick-demo/passes/model-path/)
- Agent path: [examples/quick-demo/passes/agent-path/](../examples/quick-demo/passes/agent-path/)

Frame-by-frame walkthroughs:
- [docs/walkthroughs/model-path.html](walkthroughs/model-path.html)
- [docs/walkthroughs/agent-path.html](walkthroughs/agent-path.html)

## What each path produces that the other does not

**Agent path — per-packet audit trail.** Each delegated packet writes three files to disk: the task brief the worker was handed, a delegation record of what it did, and the vendor usage receipt for it. Five packets → fifteen files. Answers *"what was this worker asked to do, what did it touch, and what did it cost"* from disk without re-running anything.

**Model path — no per-packet trail.** The same question has no answer beyond the run-level aggregate in `telemetry.jsonl`.

## Reproducing

Two prompts, in an empty folder with Claude Code open. This spends real money and needs credentials — see [setup.md](setup.md).

```
Setup this plugin from this repo - https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness
```

Then, in a new session:

```
/mmo:greenfield
```

Pick Ping Service. It exercises every phase in minutes and costs roughly $0.84 on the model path. To reproduce the agent-path row, enable the agent before running:

```bash
node "$(node -p 'require(require("os").homedir()+"/.claude/plugins/installed_plugins.json").plugins["mmo@tilicho-ai-labs"][0].installPath')/scripts/verify-setup.mjs" --enable-agent
```

Verify it took effect with `probe-agent-worker.mjs` (~2¢).
