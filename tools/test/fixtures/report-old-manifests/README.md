# report-old-manifests

Goldens for `tools/test/report-old-manifests.test.mjs`: `tools/report.mjs` output for runs whose
manifest was written **before v0.7.3**, which must not change by a single character now that the
report prints the v0.7.3 orchestrator lines (By model, billed but not logged, the floor note,
custom price, unpriced, attribution).

| Case | Manifest | Telemetry |
|---|---|---|
| `dispatched-only` | `receivables-ops/pass1` as the run wrote it (no collector) | `receivables-ops/pass1` |
| `no-receipt-v072` | the same run after the **v0.7.2** collector (no receipt; a lower-bound window) | `receivables-ops/pass1` + the v0.7.2 orchestrator event |
| `receipt-agrees-v072` | `receivables-ops/pass3` after the **v0.7.2** collector (every bucket equal to its `claude-session.json`) | `receivables-ops/pass3` + the v0.7.2 orchestrator event |
| `telemetry-only-v072` | `receivables-ops/pass1` as the run wrote it | `receivables-ops/pass1` + the v0.7.2 orchestrator event (manifest not patched) |

`cases.json` lists each case's manifest and the telemetry files concatenated in order, relative to
the case folder; the receivables-ops telemetry is referenced, not copied.

How they were made (2026-09-14):

1. `git archive 7df9cc9` (develop, v0.7.2) was built in a scratch folder, and its
   `plugin/scripts/collect-orchestrator-usage.mjs` was run over copies of `receivables-ops/pass1`
   (`--policy-path policies/receivables-premium.yaml`) and `receivables-ops/pass3`
   (`--policy-path policies/receivables-floor.yaml`), each with `--transcripts-dir` its own
   `transcripts/`. The written `manifest.json` and the one `tier: "orchestrator"` line of
   `telemetry.jsonl` are kept here. The only edit: `orchestrator_overhead.receipt_path`, a
   machine-local absolute path the report never reads, is written as `claude-session.json`.
2. `expected.txt` / `expected.md` were written by `REPORT_GOLDEN_WRITE=1 node --test
   tools/test/report-old-manifests.test.mjs` while `tools/report.mjs` was unchanged from the
   branch base (7df9cc9 plus a comment-only edit), before any v0.7.3 report line existed.

Paths are normalised to `<ROOT>`. No message text, file content, email or user path is in any file.
