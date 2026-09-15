# Workforce Ops · pass1 · receivables-floor · 2026-08-16T07:57:19.032Z

**Mode: Unknown provenance** — pre-provenance telemetry; run again with today's orchestrator to get a labeled report

**Scope: dispatched work + orchestrator overhead** — the run's own loop ($16.2354, transcript-measured) is a separate line in Costs, never blended into dispatched totals

## SDLC task run

| Phase | Prov | Calls | Tokens (in / out) | Cost |
|---|:---:|---:|---|---:|
| `requirements_analysis` | ? | 1 | 2.2K / 10.6K | $0.0415 |
| `architecture_design` | ? | 2 | 20.6K / 36.5K | $0.1525 |
| `plan_task_packets` | ? | 7 | 98.7K / 113.3K | $0.4990 |
| `codegen` | ? | 97 | 784.3K / 607.8K | $2.8674 |
| `tests` | ? | 14 | 131.7K / 171.0K | $0.7402 |
| `docs` | ? | 6 | 50.7K / 25.2K | $0.1326 |
| `senior_code_review` | ? | 24 | 268.9K / 154.2K | $0.7801 |
| `security_review` | ? | 1 | 15.7K / 9.2K | $0.0463 |
| **SDLC task total** |  |  |  | **$5.2596** |

_Prov key: V = vendor-authoritative, E = estimated, M = mixed within phase, ? = pre-provenance legacy._

## Run stats

- Wall-clock: —
- Model calls: 179
- Code files produced: —

## Costs

| Line | Amount |
|---|---:|
| SDLC task cost | $5.2596 |
| Runner overhead | $17.0521 |
| Total (unknown provenance) — dispatched work only | $22.3117 |
| Orchestrator overhead (transcript-measured) | $16.2354 |
| **True total (dispatched − in-session + orchestrator)** | **$22.3117** |

_Verified against Claude Code's own receipt ($16.2354; receipt (transcript agrees; no policy rate for a rate check))._

_Window 2026-08-16T07:52:19.032Z → 2026-08-16T09:13:02.472Z (approximate: opens at manifest started_at - 5m, closes at manifest ended_at + 5m)._

_provenance field missing from events. The overhead line is the run's own loop, reconstructed from session transcripts by collect-orchestrator-usage.mjs; only the true total compares architectures fairly._

## Methodology

- This run's telemetry pre-dates the provenance field. Rerun with
- today's orchestrator for a labeled report. See docs/methodology.md.

## Findings from this run (n=1)

> This is n=1. Generation tasks have material run-to-run variance under
> identical settings. Before drawing conclusions about a policy's cost-quality
> profile from any number on this report, run at least 5 independent passes
> and report the distribution, not a single point.

### Suggested next iterations

- **Run 5+ independent passes under identical settings and report the cost / completion-rate distribution rather than a single-point number.**
  - _Why:_ Why: n=1 conclusions about generation quality are known to be unreliable; distribution reveals whether an outcome is systematic or a tail draw.
  - _Pitfall:_ Pitfall: 5× the wall-clock and API spend per policy under study.
- **If any packets terminated as 'still truncated', re-run with a higher initial ceiling for that phase's packet template.**
  - _Why:_ Why: doubling from too-low an initial burns extra output tokens on the retries before converging; a moderate raise of the initial catches large files first-shot.
  - _Pitfall:_ Pitfall: raising the initial across the board pays extra ceiling on every packet, most of which don't need it.
- **Cross-check the report's total against the vendor dashboard for the run's time window.**
  - _Why:_ Why: the only end-to-end integrity check for vendor-authoritative mode; a material divergence means either a telemetry gap or a pricing-YAML drift.
  - _Pitfall:_ Pitfall: dashboards aggregate by API key, so mixing keys or running other work in the window contaminates the comparison.

## Artifacts

- Telemetry (JSON-lines): `<ROOT>/examples/study/passes/pass1/telemetry.jsonl`
- Manifest: `<ROOT>/examples/study/passes/pass1/manifest.json`

