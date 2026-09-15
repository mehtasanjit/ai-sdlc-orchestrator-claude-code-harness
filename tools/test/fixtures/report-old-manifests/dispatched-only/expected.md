# Workforce Ops · pass1 · receivables-premium · 2026-08-16T05:17:06.918Z

**Mode: Unknown provenance** — pre-provenance telemetry; run again with today's orchestrator to get a labeled report

**Scope: dispatched work only — excludes orchestrator overhead** — the orchestrator's own loop never passes through the MCP server; measure and add it with the collector (see Costs)

## SDLC task run

| Phase | Prov | Calls | Tokens (in / out) | Cost |
|---|:---:|---:|---|---:|
| `requirements_analysis` | ? | 1 | 200.7K / 2.2K | $0.1903 |
| `architecture_design` | ? | 1 | 282.4K / 3.1K | $0.2678 |
| `plan_task_packets` | ? | 1 | 898.4K / 9.9K | $0.8521 |
| `codegen` | ? | 68 | 9057.3K / 99.5K | $8.5895 |
| `tests` | ? | 10 | 1690.0K / 18.6K | $1.6028 |
| `docs` | ? | 6 | 962.5K / 10.6K | $0.9128 |
| `senior_code_review` | ? | 1 | 1488.0K / 16.4K | $1.4113 |
| `security_review` | ? | 1 | 1521.9K / 16.8K | $1.4449 |
| **SDLC task total** |  |  |  | **$15.2715** |

_Prov key: V = vendor-authoritative, E = estimated, M = mixed within phase, ? = pre-provenance legacy._

## Run stats

- Wall-clock: —
- Model calls: 89
- Code files produced: —

## Costs

| Line | Amount |
|---|---:|
| SDLC task cost | $15.2715 |
| Runner overhead | $0.0000 |
| **Total (unknown provenance)** — dispatched work only | **$15.2715** |

_provenance field missing from events_

_**Excludes orchestrator overhead.** The orchestrator's own loop (reasoning, file reads, growing-conversation re-sends) never passes through the MCP server and is in no number above — on measured runs it exceeded the dispatched total ~100×. Measure and add it: `node plugin/scripts/collect-orchestrator-usage.mjs <ROOT>/examples/study/passes/pass1`_

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

