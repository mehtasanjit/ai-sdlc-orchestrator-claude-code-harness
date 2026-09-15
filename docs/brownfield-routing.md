# Model-per-task routing

> **For:** understanding which model runs each phase and why the mechanical tier can drop cost ~10×. **Also see:** [architecture.md](architecture.md) · [brownfield.md](brownfield.md).

Where each kind of work runs. Explicit — because "which model handled this" is the top
question when reviewing a run's cost, quality, or failure.

## The rule of thumb

Routing is **phase-based**, not per-intent by default. Same rule applies to greenfield and
brownfield:

| Kind of work | Tier | Model in the default `opus-plus-flash` policy |
|---|---|---|
| **Judgment** — discovery, requirements, architecture / change_plan, packet planning, senior code review, security review | premium | Claude Opus |
| **Mechanical** — codegen packets, doc packets, test-code packets, debug packets | mechanical | Gemini Flash |
| **Escalation** — after 2 mechanical retries fail on a packet | premium | Claude Opus (auto) |
| **Test execution** — running your test command | local | Bash on your machine, no model call |

Only which phases FIRE changes per intent (per the intent matrix in
`plugin/skills/pipeline/SKILL.md`). Tier assignment stays stable.

## Per intent — which phases fire, at which tier

| Intent | Judgment phases (premium) | Mechanical phases (Flash) |
|---|---|---|
| `docs` | requirements, senior review, security review | doc_addition, doc_update |
| `bugfix` | requirements (reproduce + diagnose), senior review, security review | bug_reproduce, bug_diagnose, bug_fix_apply, test_add |
| `feature-extend` | requirements, architecture (change_plan), senior review, security review | mixed `existing_file_edit` + `new_file_add` |
| `feature-new` | requirements, architecture (full subsystem design), senior review, security review | full codegen mix (`new_file_add`, `test_add`, `doc_addition`, wiring packets) |
| `refactor` | requirements (delta), architecture (refactor plan), senior review, security review | `refactor_extract`, `patch_apply` |
| `test` | requirements (coverage target), senior review, security review | `test_backfill`, `test_add` |
| `deps` | requirements (upgrade list), architecture (dep-swap plan), senior review, security review | `dependency_add`, adjacent-code patches |

## Cost impact

Two shipped policies represent the two ends of the trade-off:

| Policy | Where everything runs | Typical mid-size run cost |
|---|---|---|
| `opus-only` | Every phase on Claude Opus | **$10 – 30** |
| `opus-plus-flash` (default) | Judgment on Opus, mechanical on Gemini Flash | **$0.30 – 3** |

~10× reduction on the same output because 60-80% of a full run is mechanical work that fits
what Flash is good at (pattern-matching, in-context generation, filling schema-driven
templates). Judgment work (understanding the repo, decomposing into packets, reviewing the
output) stays on premium because that's where quality matters most.

Every dispatch's actual cost lands in `.sdlc/runs/<id>/telemetry.jsonl`. Rates come from the dated
price list (`plugin/mcp/model-dispatch/src/prices.ts`), or from a model's `pricing` block only under
`pricing_override: true`. The orchestrator's estimates read that same price from `load_policy`'s
`effective_price` — never hardcoded, and tokens are never estimated except when the telemetry mode
is explicitly `estimated`.

## Escalation

The policy YAML supports a rule matching on `retry_count`:

```yaml
- when: { phase: debug, retry_count: { gte: 2 } }
  use: opus
  reason: "Escalation: 2 mechanical-tier attempts failed"
```

Behavior: a `debug` packet dispatched to Gemini Flash that fails validation twice
auto-escalates to Opus on the third attempt. Prevents infinite mechanical-tier retries when
Flash can't solve a particular puzzle.

## How to configure

Five ways to change routing:

1. **Do nothing** — `opus-plus-flash` loads out of the box on install. Requires an Anthropic
   API key + a Gemini API key (or GCP auth for the Gemini Enterprise Agent Platform path).
2. **`/mmo:policy change`** — the everyday way. Opens the browser console, pick or author a
   policy, saved to `.sdlc/project.json.default_policy`. Every subsequent run in this folder
   uses it until changed again.
3. **Pick a different shipped policy for one run** — pass `--policy <name>` to `/mmo:pass`,
   or type it at Gate 0 in `/mmo:brownfield`. Alternatives include `opus-only` (no Gemini
   needed, ~10× more per run). v1.5 will ship `ci-strict` (blocks writes unless
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

`preflight_dispatch` runs before the first paid call. It constructs each adapter and verifies
credentials are usable. If the mechanical tier isn't reachable (missing key, wrong project,
network unreachable), preflight **halts the run cleanly** — because the whole point of routing
is falling to the cheap tier, and if that's broken, every packet escalates to premium and the
run costs MORE than opus-only while appearing to succeed. That's the one outcome the plugin
exists to disprove.

## Advanced — per-task-type overrides (v1.5)

The policy YAML supports rules matching on `task_type` in addition to `phase`, so you can
route a specific task inside a "mechanical" phase to premium:

```yaml
# Example — not shipping in v1
- when:
    phase: codegen
    task_type: bug_diagnose
  use: opus
  reason: "Diagnosis is judgment work, not codegen"
```

v1 uses phase-level defaults only. If you want per-task-type overrides, add them to your own
policy YAML. Rules are evaluated top-to-bottom, first match wins — put more-specific rules
above less-specific ones.

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
