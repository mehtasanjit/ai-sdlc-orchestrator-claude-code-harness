# Model-per-task routing

> **For:** understanding which model runs each phase, and what moving mechanical work off Opus measured. **Also see:** [architecture.md](architecture.md) · [brownfield.md](brownfield.md).

Where each kind of work runs. Explicit — because "which model handled this" is the top
question when reviewing a run's cost, quality, or failure.

## The rule of thumb

Routing is **phase-based**, and the same rule applies to greenfield and brownfield:

| Kind of work | Tier | Model in the default `opus-plus-flash` policy |
|---|---|---|
| **Judgment** — discovery, requirements, architecture (greenfield's typed spec, brownfield's typed change spec), senior code review, security review | premium | Claude Opus |
| **Mechanical** — typing each file: code, tests, docs, and the fixes of a repair round | mechanical | Gemini Flash |
| **Last attempt** — a file whose routed attempts all failed | premium | Claude Opus, through the lean `claude -p` typist |
| **Packet planning** — one packet per file, from the spec | local | Code, no model call |
| **Checks and tests** — your repository's own commands | local | Your machine, no model call (brownfield: each file's checks in the model server, the project checks with Bash) |

Every brownfield job runs every phase. Jobs differ in what the change spec holds and in whether Gate 2 opens;
the tier of each kind of work stays the same.

## Per job

Every job: requirements, the architect's change spec, senior review and security review on the premium tier;
code derives one packet per file from the spec, and the typists type them. What each spec holds and the rules
code checks for it are in ["The jobs"](../plugin/skills/pipeline/brownfield-runs.md#the-jobs). Each packet
carries a label (`subtype`) that code sets from its unit; routing does not read it. A packet is routed by its
stage (`phase`) and retry count, and by its job (`intent`) when a policy rule names one.

| Job | Gate 2 | Typed files, by packet label |
|---|---|---|
| `docs` | no | `doc_addition` (a new file), `doc_update` (an edited one: a doc, or the docstrings of a source file) |
| `bugfix` | when design-affecting | `bug_reproduce` (the test that reproduces the bug, typed first), then the fix: `existing_file_edit`, `new_file_add` |
| `feature-extend` | yes | `existing_file_edit`, `new_file_add`, `test_add`, `doc_addition`, `doc_update` |
| `feature-new` | yes | `new_file_add`, `test_add`, `doc_addition`, and the wiring edits (`existing_file_edit`) |
| `refactor` | yes | `new_file_add` (the extracted module), `existing_file_edit` (every call site) |
| `test` | no | `test_add` (a new test file), `existing_file_edit` (cases added to one) |
| `deps` | yes | `existing_file_edit` (the manifest and the code the upgrade breaks); the install is a `tooling` step the package manager runs, no model |

## Cost impact

The two policies the studies compare:

| Policy | Where the judgment tier runs | Where the mechanical tier runs |
|---|---|---|
| `opus-only` | Claude Opus | Claude Opus |
| `opus-plus-flash` (default) | Claude Opus | Gemini Flash |

### What the runs measured

Four brownfield studies on one TypeScript monorepo (three `feature-extend`, one `refactor`),
each run under every policy, dispatched cost summed from `telemetry.jsonl`:

| Study | `opus-only` | `opus-plus-flash`, completion door | `opus-plus-flash`, agent door |
|---|---|---|---|
| feature-extend 1 | $3.89 | $2.92 | $6.28 |
| feature-extend 2 | $9.55 | $5.99 | $7.83 |
| feature-extend 3 | $5.25 | $2.70 | $8.71 |
| refactor | $2.72 | $1.11 | $1.79 |

Three things the table shows:

1. **The completion door saved 25–59% of the dispatched cost.** In `opus-plus-flash` the judgment
   phases cost the same as they do under `opus-only` — the policy only moves the typing of files,
   and on these runs code and tests were 35–50% of an `opus-only` run. On the runs above the Opus
   phases were 85–90% of the `opus-plus-flash` dispatched total; Flash was $0.03–0.62.
2. **The agent door can cost more than `opus-only`.** `flash-agsdk-worker` re-sends the whole
   conversation every turn and re-reads the repo per packet: 1.7–2.9M fresh plus 4–9M cached input
   tokens per run, with the tests phase alone at $1.6–2.9 against $0.05–0.15 on the completion door.
   Leave the slot on `flash-completion` for `feature-extend`, `bugfix`, and `refactor`.
3. **Dispatched cost is not the bill.** `node plugin/scripts/collect-orchestrator-usage.mjs` on
   the most recent `opus-plus-flash` run (dispatched $2.39) reconstructed the driver session from
   its transcripts: 211 API messages, 27.6M cached-read tokens, 0.87M cache writes, 112k output —
   **$22.26 of session on top of $0.29 of Flash**, true total $22.55. The session, not the
   packets, is 99% of the true total.

### What that means for the policy choice

| Lever | Effect on the true total |
|---|---|
| Fewer driver turns — bookkeeping chained into one Bash call per packet (the brownfield-orchestrator's rule 9) | each turn removed saves one full context re-read at the cache-read rate, ~$0.07 on Opus at 130k tokens |
| Reviewers read diffs, not trees (the brownfield-orchestrator's rule 9, reviewer contract) | the two reviews read 56–87k tokens each on the measured run; the diff was under 15k |

A policy that splits the judgment tier across Opus and Sonnet is refused under `estimated` — a
single environment variable cannot honor it — and runs only under `vendor`.

Every dispatch's actual cost lands in `.sdlc/runs/<id>/telemetry.jsonl`. Rates come from the dated
price list (`plugin/mcp/model-dispatch/src/prices.ts`), or from a model's `pricing` block only under
`pricing_override: true`. The orchestrator's estimates read that same price from `load_policy`'s
`effective_price` — never hardcoded, and tokens are never estimated except when the telemetry mode
is explicitly `estimated`. The driver session's cost lands beside the dispatch events as one
`tier: "orchestrator"` event once the collector runs; `manifest.json` then carries both
`total_cost_usd` (dispatched) and `true_total_cost_usd`.

## Escalation

Every typed file follows one ladder, greenfield's and brownfield's alike: every attempt but the last goes to
the model the policy routes, and the last goes to the lean Opus typist (the policy's default model when it is a
Claude model, else its first reachable Claude model; a policy with no Claude model keeps its own routes). A rule
on `retry_count` changes which model a routed attempt goes to:

```yaml
- when: { phase: debug, retry_count: { gte: 2 } }
  use: opus
  reason: "Escalation: 2 mechanical-tier attempts failed"
```

A reply cut off at a model's documented output limit goes to the next model in the ladder and never adds an
attempt. This keeps a file Flash cannot type from being retried on the mechanical tier forever.

## How to configure

Five ways to change routing:

1. **Do nothing** — `opus-plus-flash` loads out of the box on install. Requires an Anthropic
   API key + a Gemini API key (or GCP auth for the Gemini Enterprise Agent Platform path).
2. **`/mmo:policy change`** — the everyday way. Opens the browser console, pick or author a
   policy, saved to `.sdlc/project.json.default_policy`. Every subsequent run in this folder
   uses it until changed again.
3. **Pick a different shipped policy for one run** — pass `--policy <name>` to `/mmo:pass`,
   or type it at Gate 0 in `/mmo:brownfield`. Alternatives include `opus-only` (no Gemini
   needed; it cost more per run on every measured study above). v1.5 will ship `ci-strict` (blocks writes unless
   `--allow-write`), `bedrock-claude-only`, `vertex-mixed`, and `self-hosted-only`.
4. **Author a custom policy in the browser console** — the recommended path for new
   customizations, and the same console setup uses. `plugin/policy-console/` is a single HTML
   page served by a tiny Node http server (~350 lines). On save it writes the new named YAML
   to `plugin/config/policies/` and records the choice in `.sdlc/project.json`. Full spec:
   [docs/specs/custom-policy-and-thinking-config.md](specs/custom-policy-and-thinking-config.md).
5. **Ship your own by hand** — drop a `routing-policy.yaml` at repo root OR
   `.sdlc/policy.yaml` (team-shared, committed). Point the tier names at whatever model IDs
   and endpoints you want. Bedrock, Gemini Enterprise Agent Platform, self-hosted — any
   provider the plugin's adapters know how to call.

The policy loader precedence: `--policy <name>` flag wins, then `.sdlc/policy.yaml`, then
`routing-policy.yaml` at repo root, then `project.default_policy` from `.sdlc/project.json`,
then the shipped default. Gate 0 always shows which policy is active before the run starts.

## Preflight refuses to start if the cheap tier isn't reachable

`preflight_dispatch` runs before any phase. It constructs each adapter and verifies credentials are
usable, then sends one minimal call through every typist the run types with (`probe_typists`; a few cents,
logged as the run's `preflight` events) and halts on one that cannot answer, naming what to fix. If the mechanical tier isn't reachable (missing key, wrong project,
network unreachable), preflight **halts the run cleanly** — because the whole point of routing
is falling to the cheap tier, and if that's broken, every packet escalates to premium and the
run costs MORE than opus-only while appearing to succeed. That's the one outcome the plugin
exists to disprove.

## Advanced — rules on task type or module

A policy rule may also name a `task_type`, a `module` or a job (`intent`). Brownfield reads the policy the way
greenfield's executor and the run-start probe do (`executorView`), so a custom policy sends a file to the same model
in both flows: a typed file's packet has an empty `task_type`, as greenfield's do, and a rule that narrows a stage by
task type or module is read by its stage alone, or set aside when a plain rule already routes that stage.
Pre-flight's `policy_notes` name every rule read that way. A rule that names a job still routes that job's files (a
brownfield packet carries its job; greenfield's carry none). Rules are evaluated top-to-bottom, first match wins.

## Where to look after a run

Every run's `final_report.md` includes:

- Per-phase cost breakdown
- Which model each phase ran on
- Escalations (if any) with reason
- Total cost vs the policy's default expectation

If a real run cost significantly more than expected, `final_report.md` is the first place to
look. Usually the cause is either (a) many mechanical retries that escalated, (b) discovery
ballooned tokens because the repo was very large, or (c) the policy YAML routed too much to
premium.
