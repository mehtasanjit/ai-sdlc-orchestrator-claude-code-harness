# opus+flash vs opus-only — cost plan and results ledger

> Plain-English summary of every run and the current verdict: [../cost-study/README.md](../cost-study/README.md).

Goal: `opus-plus-flash` beats `opus-only-v5` on **true total** (driver session + helper subagents + dispatched work) for the BIG brief, without changing the pipeline's phases, gates, policy format or packet contract. Every improvement below is one row in the ledger; each row records what changed, the files, the expected saving from measurement, and the measured result once the pair is re-run.

Terms (from Sriram's SWE-bench-pro notes, kept here so both studies read the same): the expensive model running the session is the **driver** (Opus); the cheap model it hands work to is the **worker** (Flash).

## 1. Results ledger

Re-run protocol for every row: same repo (`kaneo` @ `5d1fc91`), same brief, both arms, `auth_mode: estimated`, true total from `collect-orchestrator-usage.mjs` after the session closes. A row is done when both arms have a number.

| # | Improvement | Applies to | Status | opus-only true $ | opus+flash true $ | Δ vs baseline pair |
|---|---|---|---|---|---|---|
| 0 | Baseline (BIG brief, 16–17 Sep) | — | measured | 19.16 | 26.02 | opus+flash loses by $6.86 |
| 1 | Editor-side apply: server hydrates inputs, writes the file, returns a receipt | dispatching policies only (opus-only never dispatches under `estimated`, so it is unchanged) | **measured 2026-09-18 (rows 1–3 as one pair)** | 22.91 (`20260918-064950-…-opus`) | **20.75** (`20260918-080917-…-flash`, re-collected; provisional 18.77) | **opus+flash wins by 2.16 (−9%)**; vs 0.7.3 arm −5.27; vs 0.7.3 opus-only +1.59 |
| 2 | Verify-then-escalate cascade inside the server | dispatching policies only | **measured with row 1** (22/26 packets apply-form, 74% verify.ok first try, 6 in-server retries, 1 escalation) | — | — | included above |
| 3 | `subagentPromptCacheTtl: "1h"` for the study project | **both arms** (settings, not policy) | **measured with row 1** — opus-only control rose +3.75 vs its 0.7.3 baseline (short-lived helpers pay the 1h write rate, as the what-if predicted) | 22.91 | 20.75 | pass rule met: same tests, senior verdict better (0 major vs 1) |
| 4 | **Architect writes a spec, not the file** — `plan-lint.mjs` gate, per-unit Exports / Behavior / Mirror / Edit-anchor contract, `House style` section, 3-input worker packets | dispatching policies | **measured 2026-09-18** (`…-155800-…-flash-row4-b`, v38, plan 419 lines, `plan_lint=ok`, 18 server writes; the earlier `…-114000-…-flash-row4` at $24.76 carried a $7.84 driver session polluted by plugin-update chatter and is not a measurement) | 19.16 (5m control) · 17.96 (`…-150200-…-opus-row4`, `opus-only-v5-1h`) | **17.41** | **opus+flash wins: −$1.75 (−9%) vs control, −$0.55 vs opus-only at 1h.** Pass rule met: tests green, senior approve-with-nits (0 major), security pass-with-notes. `execute_packets` $5.82 → $2.03 |
| 5 | Shared prefix: requirements + architecture run once, both arms fork from it | both arms (study lever) | planned | — | — | removes ≈ ±$1.8 of noise per pair |
| 6 | **Deterministic packet planning**: `plan-to-packets.mjs` emits `packets.json` from the linted plan's unit sections — zero model calls; Opus only reviews the list. Plus `apply.mode: "edits"`: the server splices an edit list into an existing file, so the 4–5 edit packets per run stop round-tripping through Opus | both arms (the script runs under every policy; edits mode under dispatching ones) | **implemented 2026-09-18 on `feat/plan-to-packets` (0.7.6), not yet measured** — reproduces the row-4 run's 17 hand-written packets from its plan (same inputs ±1, 4 edit lists, verify commands) | 19.16 | expected ≈ 16.4 | −$1.0: `plan_task_packets` was $1.03 (9 Opus turns) on the row-4 run |
| 9 | **Batch dispatch**: `execute_batch` runs every apply-form packet of the phase in one call — parallel (default 4) in `depends_on` order, one writer per file at a time, one receipt per packet | dispatching policies | **measured 2026-09-21** (run 17 `…-134800-…-flash-row9`, 0.8.0, 43 min): opus+flash **$15.93** — 16 batch events, failed items re-sent alone; run 18 `…-150500-…-opus-row9-b` opus-only **$17.40**, but again on the local `opus-only-v5-1h` file (1h writes), so no 5m opus-only sample exists on 0.7.9+ | 17.40 (1h) · 14.86 (run 16, 0.7.9, 1h) | **15.93** | vs run 18 −$1.47 (−8 %); vs run 16 +$1.07. Opus+flash over the week: $26.02 → $15.93 (−39 %) |
| 8 | **Edit-mode hardening** (from the run-13 findings): edits retries splice from the original file and a failed edit is undone; per-packet verify keeps file-scoped commands only, package-wide ones run once after the phase (`verify_deferred`); anchors accepted as `:59` / `L59` / `line 59`; Verify spans must be commands; edit lists > 5 anchors split into chunk packets; Flash completion leaf runs at `reasoning: { tier: low }` (thinking was billed as output and hit the cap) | dispatching policies | **measured 2026-09-21** (run 14 `…-081500-…-flash-row8`, 0.7.8): opus+flash **$17.05**; first-try verify 57 → 76 %, output-cap hits 4 → 0, Flash $0.66 → $0.15, hand fixes 6 → 1, 38 min. Follow-ups 0.7.9 (`f8eb1c6`, `d0cdb94`): constraint refs not sites, chunks bottom-up, import specifiers not mirrors, scout skipped outright and brief plan under single-model — run 15 (opus-only at 1h, 0.7.8) $21.06 (collected; $20.10 provisional) had paid ≈ $1–1.5 for Flash plumbing; run 16 (opus-only, 0.7.9, still 1h) **$14.86** | 19.16 (5m) · **21.06** (run 15, 0.7.8, 1h — the row-8 pair) | 17.05 | vs run 15 −$4.01, but run 15 was a heavy run; run 16 ($14.86, 0.7.9) belongs to row 9. Inside the noise band (opus-only spans $14.86–$22.91) |
| 7 | **Flash repo scout before the architect**: `scout-candidates.mjs` picks ≤ 40 files / 250 kB by requirement-term hits (no model), one `discovery` / `repo_scout` packet on the mechanical tier reads them and writes `scout.json` (mirrors, edit anchors, facts) into the run folder; the architect starts from it | dispatching policies (every multi-model preset routes `repo_scout` to its mechanical leaf; single-model presets have no rule and skip it) | **measured 2026-09-21 with row 6** (`…-061928-…-flash-row7-c`, 0.7.7): opus+flash **$18.77** vs row-4 $17.41 — flat within noise. Architect tool uses 77 → 56 (scout worked); but Flash retries 5 → 10 (edits retried onto the edited file, package typecheck per packet, `L59` anchors hand-fixed, 4 output-cap hits on edit lists) pulled Opus supervision back up. Two earlier attempts lost to laptop sleep (Windows standby 5 min; now off) | 19.16 | expected ≈ 14.5 | −$2: the row-4 architect took 110 messages / 486k cache writes / $3.75 finding mirrors, vs 61 messages / $2.11 in opus-only |

Expected numbers are derived in §5 from the token deltas in §3, not guessed. They are filled with measurements as each row lands. **Decision 2026-09-18:** rows 1–3 are measured together in one pair (a pair costs 2–3 hours of wall clock); the ledger records the combined number against all three rows, and the per-row split stays an estimate.

## 1.1 Observations after runs 13–18 (21 Sep)

| Observation | Evidence | Consequence |
|---|---|---|
| The hand-over overhead that made opus+flash lose is gone | Codegen phase $5.82 → $2.03 (row 4), first-try verify 57 → 76 % and output-cap hits 4 → 0 (row 8), execute turns 25 → one batch call (row 9); opus+flash $26.02 → $15.93 | The remaining opus+flash bill is Opus judgment (architect ≈ $3.4, two reviews ≈ $3.9) plus bookkeeping turns |
| Opus-only got cheaper from the same clean-up | Runs 15 → 16: $21.06 → $14.86 once the scout was skipped outright, the plan kept brief and a parser re-delegation removed (0.7.9) | A single-model user benefits too; the comparison target moved down with the arm we were trying to beat |
| Every opus-only run since 18 Sep ran at the 1h cache | Runs A, 10, 15, 16, 18 all show cache writes at the 1h rate; the shipped `opus-only-v5` says 5m; a local `opus-only-v5-1h.yaml` was passed by path each time | The 5m control on current code is still unmeasured; expect it ≈ $1–1.5 under the 1h figure. Pre-flight now warns (0.7.9); the local file should stay deleted |
| Run-to-run noise exceeds the gap | Opus-only on the same brief: $14.86, $17.40, $17.96, $21.06, $22.91 | A single pair cannot settle a difference under ≈ $2; Row 5 (shared prefix) and repeated pairs are the next measurement step, not more code |
| Flash's own cost never mattered | $0.12 → $0.66 → $0.15 per run | The worker model's price is not the lever; the driver's turns and context are |
| Laptop sleep kills a run silently | Two headless attempts lost (Windows standby was 5 min on AC) | Standby disabled; any run window with a gap in the transcript is not a measurement |

## 2. Where the money goes (measured, big brief)

Both runs dispatched about $2 of Opus judgment work. Flash's whole share was $0.12. The $6.86 gap is entirely the Opus orchestrator subagent's transcript.

| Role | opus-only | opus+flash | Δ |
|---|---|---|---|
| Driver session (the `/mmo:brownfield` turn) | $2.43 | $1.70 | −0.73 |
| Helper subagents (orchestrator + architect + 2 reviewers) | $16.73 | $24.20 | **+7.47** |
| Dispatched work, all models | $2.03 (in-session) | $2.19 ($0.12 Flash) | +0.16 |
| **True total** | **$19.16** | **$26.02** | **+6.86** |

Helper token deltas, priced at Opus 5 list (input $5 / cached $0.50 / cache-write 5m $6.25 / output $25 per M):

| Token class | opus-only | opus+flash | Δ tokens | Δ $ |
|---|---|---|---|---|
| Cache reads | 19.80M | 23.73M | +3.93M | +1.97 |
| Cache writes (5m) | 523k | 1,187k | +664k | +4.15 |
| Output | 142k | 196k | +54k | +1.35 |
| Total | | | | **+7.47** |

### 2.1 Per phase (transcript-priced overhead by role, plus dispatched Opus)

Every pipeline phase, in state-machine order, nothing merged. `test_run` in the opus-only run had a 0-minute window (its debug work fell inside the senior-review window).

| Phase | opus-only | opus+flash | Δ | Model doing the work under opus+flash |
|---|---|---|---|---|
| (pre-phase: preflight, Gate 0, run.start) | $0.64 + 0.74 | $0.72 | −0.66 | Opus |
| requirements_analysis | $1.16 | $1.25 | +0.09 | Opus |
| architecture_design | $3.02 | $4.80 | +1.78 | Opus architect (12.9 min vs 7.0 min; one cache death $0.71) |
| plan_task_packets | $0.34 | $0.64 | +0.30 | Opus |
| **execute_packets** | $4.01 | **$5.82** | **+1.81** | Flash wrote every file for $0.06; Opus spent $5.82 driving it |
| senior_code_review | $3.52 | $2.37 | −1.15 | Opus |
| test_run (incl. debug) | in review window | $2.54 | +2.54 | Flash debug $0.03; Opus loop $2.54 |
| **security_review** | $1.87 | **$4.73** | **+2.86** | Opus; $1.59 of it is one cache death, the rest the hardening-packet round trip |
| generate_final_report | $0.96 | $1.32 | +0.36 | Opus |
| (tail) | $0.46 | — | | |
| Helper total | $16.73 | $24.20 | +7.47 | |

Reading the table: the phases that got more expensive are the ones where Flash *did* the work. The cost is not in the model doing the work; it is in what the Opus orchestrator has to emit and re-read to hand the work over. Routing more phases to Flash as the dispatch is wired today makes the number worse, not better.

### 2.2 Rows 1–3 measured — the 2026-09-18 pair (plugin 0.7.4, both arms with the 1h subagent cache TTL)

| | opus-only (Run A, `20260918-064950-…-opus`) | opus+flash-v38 (Run B, `20260918-080917-…-flash`) | Δ |
|---|---|---|---|
| Driver session | $2.62 | $2.38 | −0.24 |
| Helper subagents (orchestrator + architect + 2 reviewers) | $20.29 | $17.91 | −2.38 |
| Dispatched work | $3.01 (all in-session Opus, no server call) | $2.46 ($0.45 Flash / 37 events, $2.00 in-session Opus) | |
| **True total** | **$22.91** | **$20.75** (in-session provisional read $18.77) | **−2.16 (−9%)** |
| Helper cache reads | 23.9M | 19.9M | −4.0M |
| Helper cache writes (1h rate) | 554k | 549k | ≈ |
| Helper output | 217k | 194k | −23k |
| Wall clock | 71 min | 51 min | −20 min |
| Plan | 478 lines / 0 code blocks | 1,041 lines / 54 code blocks | architect still writes the program |
| Packets | 25, all inline Opus, 6 debug | 26 calls, 22 apply-form, 74% verify.ok first try, 6 in-server retries, 1 escalation | |
| Senior / security | approved-with-changes (1 major) / approve-with-notes | approved (0 major) / PASS, 2 hardenings | B no worse |
| Tests | api 393 pass + 3 known flakes; web new suites pass scoped | same | same |

Reading it against the baseline pair (§2): the Flash arm fell $26.02 → $20.75 (−20%) and the file round trip is gone — helper cache reads −3.8M and output −2k against its own baseline despite a longer plan. The opus-only control **rose** $19.16 → $22.91: row 3's 1h write rate on helpers that never wait long (+≈$2, as the §5 what-if predicted) plus a heavier run (6 debug rounds vs 0, 217k vs 142k output — reviewer variance, not policy). Rows 1–2 do not touch opus-only at all under `estimated` (it never calls the server). So the pass rule holds on the like-for-like pair, but against the 5m-TTL opus-only number Flash is still $1.59 dearer, inside the ±$2–5 run-to-run noise. Two consequences for the next pair: run each arm at its own best cache setting (5m for opus-only, 1h for opus+flash) and record both; and row 4's "architect writes a spec" is the remaining lever — every one of the plan's 54 code blocks is Opus output that two reviewers then re-read. Collector caveat: a subagent-driven run has no `/mmo:` command turn, so the window is approximate and spans every project transcript; the $20.75 may include a few parent-session status turns (over-count, not under).

## 3. The two mechanisms behind the gap

### 3.1 The file round trip

For `tp_codegen_001` the architect (Opus) had already written the complete file into `change_plan.md §A1`. The packet then said "reproduce it exactly". The same bytes crossed Opus four times:

```
 change_plan.md §A1 ──(Opus pastes it)──▶ packet.inputs[].content   [Opus output, $25/M]
                                              │
                                              ▼  execute_with_model
                                        Flash echoes it back          [Flash, $0.75/M in, $3.75/M out]
                                              │
                                              ▼  tool_result (JSON-escaped, ~1.3× tokens)
                                        Opus reads it                 [cache write $6.25/M, then read every turn]
                                              │
                                              ▼  Bash heredoc `cat > file <<EOF`
                                        Opus re-types it              [Opus output, $25/M]
```

Measured over the 24 `execute_with_model` calls in the opus+flash orchestrator:

| Traffic through the Opus orchestrator | Tokens | Note |
|---|---|---|
| Packets emitted (Opus output) | 20.0k | 9.1k of it is `outputSchema` / `acceptance` / ids repeated per packet |
| Results read back (tool_result) | 23.2k | full file content as escaped JSON |
| Files re-emitted via 20 Bash heredocs | 13.5k | Opus re-types Flash's output |
| Files emitted via Write | 5.5k | |
| **Total file traffic** | **62k** | vs **8.0k** in opus-only (12 Write + 14 Edit) |

Those 62k tokens stay in context and are re-read at $0.50/M on every later turn — average context per turn was 175k in opus+flash vs 128k in opus-only.

### 3.2 Cache deaths while waiting

The orchestrator subagent runs on the 5-minute prompt-cache TTL (Claude Code gives the 1-hour TTL to the main conversation only). When it waits on the architect (12.9 min) or a reviewer (5–9 min), no request refreshes its cache; the next turn re-writes the whole context at $6.25/M.

| Run | Full-context re-writes | Tokens | $ |
|---|---|---|---|
| opus-only | 1 (after the architect) | 93k | 0.58 |
| opus+flash | 3 (after architect, after senior review, after security review) | 604k | 3.78 |

The deaths cost more in opus+flash because the context they re-write is bigger (§3.1) and the waits were longer. Anthropic's issue tracker records the same pattern across ~1,800 subagents: 96% of parents waiting on a child hit a cache death at a median idle gap of ~9 minutes.

## 4. Research — what exists and what this plan takes from it

| Source | What it does | What this plan takes | What it leaves |
|---|---|---|---|
| [Aider architect/editor mode](https://aider.chat/2024/09/26/architect.html) | A reasoning model describes the change; a second (cheaper/faster) model turns it into well-formed edits. The editor's output goes to disk, the architect never re-types it. R1-architect + Sonnet-editor set a leaderboard SOTA at 14× lower cost than the previous one; users report 30–50% cheaper than the architect model alone. | **Row 1.** The driver hands the worker a *reference* to the plan (`inputs[].path` + `section`), the server reads it, the worker's output is written by the server, the driver gets a receipt. | Aider's editor formats (diff / whole) — not needed, the packet already returns whole files. |
| [Cursor fast-apply](https://www.cursor.com/blog/instant-apply) / Sriram's SWE-bench-pro notes | The frontier model emits a sketch; a small model expands it into the full file; plain code assembles the brief and returns a short summary to the driver. Delegation went from costing more than solo to 7–10% cheaper per attempt. | **Row 1**, same mechanism. The receipt is the "short summary". | — |
| SWE-bench Pro v1→v2 (ai-studies-console, `tools/harness-matrix/`, guide dated 2026-09-14) | v1: the driver wrote every hand-off brief and read every result back at Opus rates — every delegated arm was 14–139% dearer than solo and resolved less. v2: the driver records a 9-field analysis (`root_cause`, `fix_approach`, `change_sites`, `read_set`, … with a gate that rejects literal code), the harness renders the worker's brief from it with the named files inlined (120 kB budget, change sites first), the worker self-checks up to `self_check_rounds`, the driver reads back ≤ 6 kB (verdict + diffstat + head/tail), and retries get a harness-built evidence payload. Six "driver floor" cuts (short prompts, empty working dir, Bash+Skill only, repo read lock, STOP ON PASS, rules inlined) cut the touched phases 25.7%. Result on 531 instances: delegating the patch became 7–10% cheaper per attempt at 2–3 points lower resolve rate. | **Rows 1–2** are the same mechanism in our shape: `change_plan.md` sections are the recorded analysis, the server renders/hydrates the brief, the receipt is the bounded read-back, the verify tail is the retry payload. Three details copied verbatim into rows 1–2: a hard cap on the receipt size, STOP ON PASS for the orchestrator, and the retry payload carrying the gate's exact words. **Row 4** gets their no-code gate on the architect's output, and **Row 5** their shared-prefix fork so the two arms patch from the same analysis. | The guard/audit layer (a driver that cannot edit); our orchestrator is allowed to edit under `opus-only`, that is the arm. |
| [FrugalGPT](https://arxiv.org/abs/2305.05176) (Chen, Zaharia, Zou) | LLM cascade: cheap model first, a cheap *scorer* judges the answer, the expensive model is called only when the score is below threshold. Up to 98% cost reduction at GPT-4 quality. | **Row 2.** The scorer is the repo's own lint / typecheck / single-file test command, run by the server. A failing score re-dispatches to Flash with the error appended; Opus is called only after the policy's `retry_count ≥ 2`. Today the scorer is Opus reading the file, which is the expensive model FrugalGPT keeps out of the loop. | Learned DistilBERT scorer — deterministic tooling is a better scorer for code. |
| [RouteLLM](https://github.com/lm-sys/RouteLLM) (LMSYS) | Trains a router on preference data to send each query to the weak or strong model by predicted difficulty; ~85% cost reduction at 95% of GPT-4 quality on MT-Bench. | The idea that routing should key on *difficulty*, not only phase. Row 4 candidate: a `complexity` field on the packet from the planner. | The trained router — the policy's `task_type` rules already do the coarse version, and there is no preference dataset for SDLC packets. |
| [LiteLLM Router](https://docs.litellm.ai/docs/routing) | Model groups, fallback chains, cost-based routing, per-key budgets, context-window fallbacks — an API gateway, not an agent loop. | Confirms the policy YAML's shape (rules → model, escalation on failure, hard cost cap) is the standard one. Nothing to add. | Everything; the cost here is not at the API-gateway layer. |
| [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching), [issue #74318](https://github.com/anthropics/claude-code/issues/74318) | Main conversation gets the 1-hour TTL, subagents get 5 minutes; a parent waiting on a child past 5 minutes re-writes its whole context. `promptCacheTtl` / `subagentPromptCacheTtl` (v2.1.242+) choose the TTL per bucket. The issue's authors found 1h-for-all-subagents net *more* expensive on their general workload. | **Row 3**, as an experiment with a what-if computed on our transcripts (§5), because our workload is one long-lived orchestrator with long waits, not a fleet of short subagents. | — |
| Middle model between driver and worker (Ravi's KreditBee / Spotify note) | A mid-priced model does the packet writing and result reading so the frontier model stays thin. | Not in the opus+flash arm — this study is the two-model pair. `sonnet-plus-flash` already exists as a separate arm. | — |

## 4.1 The ceiling — what delegating codegen can save at most

SWE-bench Pro v2's measured lane found the patch phase is only 30% of a chain's cost (repro 29%, localize 41%), so delegating the patch alone can save at most 30%, and about 15% after the driver's hand-off overhead. The same arithmetic on our baseline, share of the helper bill in the phases where the worker does the work (`execute_packets` + `test_run`):

| Arm | Worker-eligible phases | Helper total | Ceiling if the worker were free and the hand-off cost nothing |
|---|---|---|---|
| opus-only | $4.01 | $16.73 | 24% |
| opus+flash | $5.82 + 2.54 = $8.36 | $24.20 | 35% |

So rows 1–3 can bring opus+flash to parity or a little under opus-only; they cannot make it 2× cheaper. A large win needs the phases that are not delegated today — `architecture_design` (18% of the helper bill) and the two reviews (22%) — to get cheaper, which is Row 4's "architect writes a spec" and the review follow-ups, or the driver floor itself to shrink.

**Pre-registered pass rule for this plan** (their campaign had one for the lane and none for the marathon, and the write-up suffered for it): after rows 1–3, on the BIG brief pair, `opus-plus-flash` must have a lower true total than `opus-only-v5`, with the same test result (all new and existing tests green, same pre-existing flakes) and a senior-review verdict no worse than `approved` with the same or fewer refinement packets. Anything else is a FAIL for the row, recorded in the ledger as such.

## 5. The improvements

### Row 1 — Editor-side apply (Aider/Cursor pattern; Sriram's point a)

**Change.** `execute_with_model` accepts `packet.apply = { write: true, verify?: [...], max_retries? }` and an optional `run_id`. When set, the server:

1. Hydrates every `inputs[]` slice that has no `content` from `project_root` (`path`, optionally narrowed by `lines: [from, to]` or `section: "<heading>"`). The orchestrator stops pasting file text into packets.
2. Substitutes the `{path, content}` output schema when `outputSchema` is omitted, so the 9.1k tokens/run of repeated schema boilerplate disappear.
3. After a successful dispatch, checks `artifact_path` against the same write contract the PreToolUse hook enforces (hardcoded off-limits + `.sdlc/local/write-contract.json`), records provenance via `write-provenance.mjs --before/--after` so `/mmo:revert` still works, and writes the file.
4. Returns a receipt — `{decision, apply: {path, bytes, lines, sha16}, verify, tokens, cost_usd, terminal_reason}` — instead of the file content. The receipt is capped at 2 kB (verify output tailed to 1,500 characters); SWE-bench Pro v2 caps its read-back at 6 kB and that cap held.
5. The orchestrator's side of the contract (pipeline skill, Phase 5): **STOP ON PASS** — when the receipt says `verify.ok: true`, do not `cat` the file, do not re-run the command, move to the next packet. Re-checking the worker by hand was the single largest v1 cost in their study.

Packets without `apply` behave exactly as today.

**Files.** `plugin/mcp/model-dispatch/src/types.ts` (FileSlice.content optional, `lines`, `section`, `ApplySpec`). `plugin/mcp/model-dispatch/src/apply.ts` (hydrate, contract check, provenance-wrapped write, verify, refine, receipt, `runApplyLoop`). `server.ts` (validator accepts the apply form, `run_id` argument, `dispatchOnce` factored out, the loop called with injected route/dispatch). `plugin/skills/pipeline/SKILL.md` Phase 5 "Apply form" + Phase 7 debug packets; `plugin/agents/orchestrator.md` packet table, rule 9 STOP ON PASS, provenance note. Tests `plugin/mcp/model-dispatch/test/apply.test.mjs` (16).

**Expected saving** (from §3.1): file traffic through Opus drops from 62k to ≈ 6k tokens (24 packets × ~150 tokens + 24 receipts × ~80). Output saved ≈ 33k × $25/M = $0.83. Cache reads saved ≈ 54k fewer context tokens × ~70 later turns × $0.50/M = $1.90. Turns saved: 20 heredoc turns ≈ 20 × 175k × $0.50/M = $1.75. Smaller context at the three cache deaths ≈ $0.9. Total ≈ **$5 → but counted with Row 2 below since the verify/debug turns overlap; Row 1 alone ≈ $3.5.**

**Fairness.** opus-only under `estimated` never calls `execute_with_model`, so its number does not move. Under `vendor` mode it would benefit equally.

### Row 2 — Verify-then-escalate cascade in the server (FrugalGPT)

**Change.** With `apply.verify` set (e.g. `["npx biome check {path}", "npx vitest run {path}"]`, taken by the orchestrator from `baseline.json`), the server runs the commands after the write. On failure it builds the refined packet itself (`retry_count + 1`; appended to the instruction: which command failed, its exit code, and the last 1,500 characters of its output — the gate's exact words, which is what SWE-bench Pro v2's `buildRetryPayload` carries; orchestrator rule 7 unchanged), routes it through the same policy, and re-dispatches. It stops and returns `status: "escalate"` with the last error as soon as the policy would route the next attempt to a different model than the first one, so the existing `retry_count: { gte: 2 } → opus` rule and the in-session escalation under `estimated` mode are untouched.

**Files.** Same as Row 1 plus the loop in `server.ts`.

**Expected saving.** The 3 Flash retries and 5 debug packets in the baseline each cost one Opus turn to read the failure and one to write the refined packet (≈ 8–10 turns × 175k × $0.50/M ≈ $0.80) plus their output. Fewer Opus-visible failures also removes the validate-by-reading step per packet. ≈ **$1.5**.

### Row 3 — `subagentPromptCacheTtl: "1h"` (Claude Code setting; Sriram's point b)

**Change.** `.claude/settings.json` in the study project (`kaneo`): `{ "subagentPromptCacheTtl": "1h" }`. Requires Claude Code ≥ 2.1.242 (installed: 2.1.276). No plugin change. Applied to both arms; the opus-only arm is re-run too.

**Decision after the 2026-09-18 pair: per-arm, not both arms.** The setting is a Claude Code session setting, not a policy field — the plugin cannot flip it per run, and it is read once when `claude` starts. The measured pair confirmed the what-if: it saved the long-waiting opus+flash orchestrator and cost the short-lived opus-only helpers (+≈$2). So each arm runs at its own best setting, which is also what a real user of that policy would do:

| Arm | `subagentPromptCacheTtl` in `kaneo/.claude/settings.local.json` | Control number to compare against |
|---|---|---|
| opus-only-v5 | line absent (5m default) | **$19.16** (`20260916-081500-…`, 0.7.3 — still valid: rows 1–2 never execute under opus-only + `estimated`) |
| opus-plus-flash-* | `"1h"` | measured per row |

Flip the line and restart `claude` before switching arms. The opus-only control does **not** need re-running for rows 4+; its $22.91 at 1h is kept in the ledger as the row-3 measurement only.

**What-if on the baseline transcripts** (all subagent cache writes re-priced at the 1h rate $10/M, the measured cache-death re-writes removed):

| Arm | Helper cost billed (5m) | What-if (1h) | Δ |
|---|---|---|---|
| opus-only | $14.34 | $15.13 | +0.79 |
| opus+flash | $20.88 | $18.92 | −1.96 |

(These two columns price cache writes, reads and output only; they differ from §2's $16.73 / $24.20 by the collector's handling of streamed usage lines. The deltas are what matter.) The 1h rate costs the short-lived architect and reviewers ≈ $0.4 each; the long-lived orchestrator saves more than that in opus+flash and about breaks even in opus-only. Confirming or refuting this is the point of the row.

### Row 4 — Follow-ups, in order of expected value

| Candidate | Mechanism | Why it is not in rows 1–3 |
|---|---|---|
| Batch dispatch: `packets: [...]` in one `execute_with_model` call, run in parallel server-side | 24 dispatch turns → ~6; each turn saved is ≈ $0.09 of cache reads at the current context size, and the wall-clock drops, which shrinks the cache-death window | New tool surface; measure rows 1–3 first |
| Architect writes a spec, not the file | `change_plan.md §A1` today *is* the complete file. If the architect writes what the file must do and the worker writes the code, the Opus output for every mechanical file disappears from the architecture phase (which is the second most expensive phase in both arms). This is the actual Aider split, and SWE-bench Pro v2's `localize-v2` contract is the template: per change site `file`, `symbol`, `line_hint`, `fix_approach` with **no literal code**, `read_set`, `constraints` marked `observed:` / `inferred:`. Their gate rejects analysis fields containing diff hunks, long code blocks or line-by-line edit instructions, and rejects undecided remedies ("either … or …"). | Changes `architect.md`'s output contract; quality risk on the worker; needs the review phase to catch it |
| `generate_final_report` on Flash | SUMMARY.md is volume writing from `manifest.json`, `provenance.json`, `review.json`; with Row 1 it is one apply packet | $0.3–0.8; do after rows 1–2 make dispatch cheap |
| Security review `light` form as a Flash packet | The light form is a secrets and dependency scan | Keep `full` on Opus; small saving |
| `complexity` on packets (RouteLLM) | Planner scores each packet; policy rule keys on it | Needs data from rows 1–3 to define the threshold |
| Middle model (Sriram's point c) | Sonnet writes packets and reads results | A separate arm, not opus+flash |

### Row 5 — Shared prefix across arms (measurement lever, from SWE-bench Pro v2)

`architecture_design` cost $3.02 in opus-only and $4.80 in opus+flash with the same model, same brief and same HEAD — the architect read 53 files in 12.9 minutes one day and 50 files in 7.0 minutes the other. That $1.78 is noise, and it is a quarter of the gap being studied. SWE-bench Pro v2 removes this by running repro + localize once per instance (the donor) and forking every arm's patch phase from it; the prefix cancels out of "P3 − P1".

**Change.** Run requirements + architecture (+ Gate 1/2) once on Opus, then run `plan_task_packets` → `generate_final_report` for each arm from the same `requirements.md` / `change_plan.md` on a fresh worktree reset. `/mmo:brownfield` already keeps run folders per run id; the fork is a `--prefix-from <run-id>` that copies the two artifacts and the gate approvals and starts at phase 4. Both arms' true totals then carry the prefix once (report it as "own phases" and "fully loaded", as their exporter does).

**Files.** `plugin/commands/brownfield.md`, `plugin/skills/pipeline/SKILL.md` (state machine entry point), `collect-orchestrator-usage.mjs` (window starts at the fork).

**Expected saving.** None on a real run — it is a study lever. It removes ≈ ±$1.8 of noise from every pair and halves the Opus spend of running a pair.

## 6. What each row changes in the diagram

```
TODAY (baseline)                                  AFTER ROWS 1–2
─────────────────────────                          ─────────────────────────
Opus orchestrator                                  Opus orchestrator
  │ writes packet (+file text, +schema)               │ writes packet (paths + instruction)   ~150 tok
  ▼                                                   ▼
MCP server ──▶ Flash ──▶ MCP server                 MCP server: read slices ──▶ Flash ──▶ write file
  │ returns full file as JSON                          │            ▲                        │
  ▼                                                    │            └── verify fails? ───────┘
Opus reads file, validates by eye                      │                (retry on Flash, ≤2)
  │ re-types file into Bash heredoc                    ▼
  ▼                                                Opus reads receipt {path, sha, verify ok}  ~80 tok
disk                                               (escalates only when the policy says so)
```

## 7. Measurement notes

- True total comes from `collect-orchestrator-usage.mjs` after the session exits; the in-session figure misses the tail.
- Per-phase attribution uses `phase.start` / `phase.end` in `orchestrator.log` against assistant-message timestamps in the helper transcripts, taking each message's final usage line. The script lives in the session scratchpad for now; it moves into `tools/` if the per-phase table becomes a standing report.
- Name the cost view. Every number in this file is *fully loaded* (driver session + helpers + dispatched, prefix included). When Row 5 lands, tables carry both "own phases" and "fully loaded", and the pair's spend is Σ arms − prefix, never the sum of the arms.
- Opus dollars are modeled at list price from the transcript (the study runs on a subscription seat); Flash dollars are vendor-reported and real. Keep the two labelled; do not add them into one "spend" figure in a headline. The study table's "True total" is modeled + $0.12 cash and says `(unverified)` for that reason.
- Sriram's note that the cost card sums worker dispatch events only describes the pre-0.7 report; since 0.7.3 `manifest.json` carries `orchestrator_overhead` and `true_total_cost_usd`, and the study table quotes the true total.

## 8. Changelog

| Date | Row | What landed | Measured |
|---|---|---|---|
| 2026-09-18 | — | Diagnosis (§2–3), research (§4), plan | — |
| 2026-09-23 | 9 | 0.8.1: `execute_batch` added to the orchestrator's `tools:` list — in run 17 it was missing, so the orchestrator handed batches to a helper (≈ $1.10 extra). Architect: `Edit` + read-only search (`Glob`, `Grep`, `Bash`) added; brief plan form under both policies (multi-model adds only verbatim anchor text and import specifiers); no re-reading scout slices or other runs' folders; the plan is written once and fixed by Edit, and lint / plan-to-packets re-delegations ask for in-place edits (runs 16–18: 65 vs 32 architect tool uses, the plan written twice for +$2.54). Ledger: run 15 corrected to the collected $21.06 (was the provisional $20.10); run 16 moved to row 9 | not yet |
| 2026-09-21 | 9 | Measured: run 17 opus+flash $15.93 (0.8.0), run 18 opus-only $17.40 (1h file again); §1.1 observations added | −8 % vs run 18 |
| 2026-09-21 | 9 | `batch.ts` (`runBatch`: depends_on scheduling, concurrency cap, one writer per path, blocked/error items, cycle refusal; 6 tests), `execute_batch` tool, `runPacket` factored out of the handler; pipeline Phase 5 "Batch the phase", orchestrator rule 9; 0.8.0 | not yet |
| 2026-09-21 | 8 | Run 14 measured $17.05; runs 15/16 opus-only; follow-ups `f8eb1c6` `e499ab4` `d0cdb94` (0.7.9) | see row 8 |
| 2026-09-21 | 8 | Edits splice from the original + restore on failure (`apply.ts`), `L59`/`line N` anchors, command-only Verify spans, `verify_deferred`, chunked edit packets (`plan-to-packets.mjs`), `thinkingConfigFor` in the Gemini completion adapter + `reasoning: { tier: low }` on the flash leaf in four presets; architect.md canonical anchor form; 0.7.8 | not yet |
| 2026-09-21 | 6+7 | Measured together (run 13): $18.77, flat vs row 4; retries doubled — see row 8 | flat |
| 2026-09-18 | 7 | `scout-candidates.mjs` (term extraction, IDF cut, hit windows for large files, allowlist / kit / test boosts, sibling cap; 4 tests), `repo_scout` rule in six presets (routing test across all presets), run-folder writes allowed under the contract, pipeline Phase 2 scout step, architect and orchestrator input contracts; 0.7.7 | not yet |
| 2026-09-18 | 6 | `plan-to-packets.mjs` (parse units → packets, repo-checked mirrors/anchors, 8 tests) + `apply.mode: "edits"` in the server (`spliceEdits`, 2 tests); pipeline Phase 4/5 and orchestrator rule 5 updated; 0.7.6 | not yet |
| 2026-09-18 | 4 | Measured on `feat/architect-spec-not-program` @ 0.7.5: opus+flash $17.41 vs opus-only $19.16 (5m control) / $17.96 (1h). Per phase (helper transcripts): architecture 4.28 vs 2.76, plan packets 1.03 vs 0.47, execute 2.03 vs 4.75, senior 1.87 vs 1.57, security 2.05 vs 1.97. Bill moved to the architect and the planner → rows 6–7 | opus+flash −9% |
| 2026-09-18 | 1 | `types.ts` and `apply.ts` drafted, not wired, not built | — |
| 2026-09-18 | 3 | `subagentPromptCacheTtl: "1h"` added to `kaneo/.claude/settings.local.json` (Claude Code 2.1.276); both arms re-run under it | not yet |
| 2026-09-18 | 1+2 | Server loop wired (`runApplyLoop` in `apply.ts`, `dispatchOnce` in `server.ts`), tool schema, validator, orchestrator + pipeline docs, 16 tests; root suite 411/411 | not yet — needs the BIG-brief pair re-run |
| 2026-09-18 | — | SWE-bench Pro v1→v2 guide folded in: §4 row, §4.1 ceiling + pre-registered rule, receipt cap + STOP ON PASS in Row 1, retry payload in Row 2, no-code gate in Row 4, Row 5 shared prefix, cost-view rules in §7 | — |
