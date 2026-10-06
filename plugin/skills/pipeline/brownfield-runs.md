# Brownfield runs: every job

For the `brownfield-orchestrator` agent, which runs every brownfield job: docs, bugfix, feature-extend,
feature-new, refactor, test and deps. This file adds to `${CLAUDE_PLUGIN_ROOT}/skills/pipeline/SKILL.md`;
where a part below says **instead of**, it replaces that part of SKILL.md for this run. Greenfield follows
SKILL.md alone.

**Read only these sections of SKILL.md, by their line ranges** (`Grep` its `^#{2,3} ` headings with line
numbers, then `Read` every range with `offset` and `limit` in one turn): "Phase -1 — preflight_dispatch",
"Phase 1 — requirements_analysis", "Phase 5 — execute_packets", "Phase 7 — test_run",
"Phase 9 — generate_final_report", "Intent matrix — brownfield only", "HITL gate prompt templates" up to its
first gate, "Gate 1", "Gate 2", "Gate 3", "Gate 4" and "Telemetry contract". Never read the whole file, its
"Executor mode" (greenfield only) or its "Gate 0" (it passed before this run started): every later turn
re-reads what you read once. Phases 2, 4, 6 and 8, the task types and the output ceilings are replaced below;
no other section is this run's.

## Phase -1 — preflight_dispatch

Instead of "`executor: false` on a brownfield run": pass `executor: true`, and `intent: <the run's job>`, so the
typist probe also tests a typist that a policy rule scoped to this job routes to. Every brownfield packet is typed by
greenfield's typists, the lean Opus typist through this machine's `claude` CLI included, so pre-flight checks
that CLI before anything is spent (an old or missing one halts here, with what to update) and reports how the
typists read the policy (`policy_notes`).

Instead of "Escalation to the direct tier under `estimated` stays in-session": nothing in a brownfield run is
typed in this session. A packet the policy routes to your own model, first or as the ladder's last attempt, is
typed by the server's lean Opus typist (under `estimated`, on this computer's own Claude login) and comes back
as the same receipt. A pre-flight warning that your own model is not dispatched under `estimated` is about its
API adapter, which this run does not use; the typist probe (`probe_typists`) tests the typist itself.

## The jobs

Every job runs the same flow: the architect hands over a typed change spec (Phase 2), code derives the packets
from it (Phase 4), and greenfield's typists type them under every policy (Phase 5). A job differs from another
only in what its spec holds and in the few rules code checks when it finalizes the spec
(`plan-to-packets.mjs --intent`). Instead of the Intent matrix's Phase 2, Phase 4 and Phase 8 columns in
SKILL.md, its "Skip semantics", and the SKIP of Phase 2 in "Intent routing — brownfield only", this table
holds; the matrix's Phase 1 and 7 columns still apply. No phase is skipped in a brownfield run, so no
`phase.skip` event is logged.

| Job | Gate 2 | What the spec holds | What code also checks at finalize |
|---|---|---|---|
| `feature-extend`, `feature-new` | yes | the change: new and edited files, and their tests | — |
| `refactor` | yes | the extraction and every call site it changes | `project_checks` holds at least one command |
| `deps` | yes | the manifest edit, the install as a `tooling` unit, the code the upgrade needs changed | `project_checks` holds at least one command; a `tooling` unit; every other unit is typed before the install (the manifest edit, which the install waits for) or waits for it |
| `bugfix` | when design-affecting | first the test that reproduces the bug, then the fix | the reproducing test (`red_checks`, plus a check that must pass; a red check has no `fix`) and a codegen fix that waits for it; only those units |
| `test` | no | the test files | `project_checks` holds at least one command; at least one tests unit; no `tooling` unit |
| `docs` | no | the doc files (`phase: docs`) | documentation units only (`phase: docs`); no `tooling` unit |

For refactor, test and deps the architect is told to put the full test suite (and the typecheck) in
`project_checks`; code checks that the list is not empty, and the end-of-run checks run whatever it names.
plan-lint checks what a job asks of each unit and of the header on each section as the architect hands it
over, and plan-to-packets checks every rule again over the whole spec. A `tooling` unit is a shell step that
runs through Bash, outside the write contract, so only a job that always opens Gate 2, where the person sees the
plan before anything runs, holds one.

A job with no Gate 2 still has its plan: `change_plan.md` is rendered all the same and the reviewers read it.
After `plan-to-packets.mjs` exits 0, a job with no Gate 2 goes on to Phase 4 without a gate. A bugfix opens
Gate 2 only when plan-to-packets' summary says `Gate 2: yes`: code finds it design-affecting from the spec,
never from its wording, when the spec has a decision, creates a file outside the `tests` phase, or replaces or
deletes lines of an existing test file (anything beyond the new case that reproduces the bug).

**A bugfix proves itself by its test.** The spec's first units hold the test that reproduces the bug, each with
`red_checks` (the file checks that run it and must fail on the code as it is) and at least one check in
`checks` that proves the file is well-formed (a syntax, type or load check): a red verdict is the exit code
only, so a test file that does not even load would fail too. The server types that test first and passes the
answer only when its checks pass and each red check fails on the bug — a test that passes before the fix does
not reproduce it, and a check that cannot run or times out gives no verdict; either is a retry with that reason
(Phase 4, `apply.checks`). In an existing test file, a red check that already fails before the change cannot
show that the new case reproduces the bug: plan-lint refuses that unit, and the server refuses that packet
before any typist is paid (`refused`, Phase 5) — point the red check at the new case only, or put the case in a
new test file. Every fix waits for the test (`depends_on`). The reproducing test judges the fix, so no fix round
changes it; once the fixes are in, the same checks on the test file run first among the end-of-run checks
(`verify_deferred`): the test that failed on the bug must pass.

## Phase 2 — after the architect returns

**Brownfield: finalize the change spec** (before Gate 2, for the jobs that have one). The architect hands over a typed change spec in
sections, each checked against the files when it writes it (`brownfield-architect`, "The change spec");
it does not write `change_plan.md`. When it returns, run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-to-packets.mjs" --spec --run-id <run-id> --intent <intent> --project-root "$(pwd)"
```

It checks the accepted spec as a whole — every reference resolves, every file a section pointed into is
unchanged since that section was accepted, every `FR-`/`AC-` id of `requirements.md` is covered by a unit
— then renders `<output_dir>/change_plan.md` (what Gate 2 shows and the reviewers read), writes the
typists' briefs to `<output_dir>/briefs/`, and writes `<output_dir>/packets.json`, with no model call.

Exit 0: read the summary line and any warnings, then open Gate 2 for the jobs that have one ("The jobs",
above). Exit 1: the spec is not complete, breaks one of the job's rules, or no longer matches the files; re-delegate the architect with the printed lines ("Fix these spots in your
section files with Edit, check each changed file again with plan-lint --section, and return"), then run
the command again. A line that names the write contract's allowlist is not fixed by re-delegating, and neither
is an architect that returns saying it cannot meet a printed rule (a test file the bug needs outside the
allowlist, a step its job may not hold): what the run may write is fixed at Gate 0, so stop and tell the person
what the run needs and why (the allowlist is the person's decision). Never edit the spec, the rendered plan or a
packet yourself: a hand edit here is Opus re-typing the work the typists do. On a Gate 2 `revise`, the architect
edits its sections and you run the command again.

## Phase 4 — plan_task_packets

**Brownfield: the packets are already derived** (Phase 2): `packets.json`, one packet per unit, in
dependency order. Log the `plan_task_packets` event with the tokens you actually spent (none for the
derivation). What a packet carries, all by code:

- `inputs`, paths only: `briefs/shared.md` (the conventions, the decisions, and every file of the change
  with its import line and exports — the same bytes for every packet, so both typists read it from a
  cache), `briefs/<unit>.md` (the unit and the units it depends on), the unit's style file and the files
  it uses, and for an edit the file being edited, whole (in consecutive parts when it is larger than the
  server's bound on one input, 200,000 bytes).
- An edit's sites — each site's lines, their text and its rule — which the server holds the answer to: an
  answer that changes or removes a line outside every replace or delete site, or adds lines anywhere but at an
  insert or replace site, is retried with those lines named, and nothing is written. Greenfield's own answer
  contract: exact edits (`{path, edits: [{search, replace}]}`, each search found once in the current text)
  or the whole file. One packet per file, however many sites it has: a reply cut off at a model's output
  limit goes to the next model in the ladder (Phase 5, "Batch the phase").
- `apply.checks`: the unit's file checks, each with its own write form (`fix`); each may run as long as the
  plan's `timeout_s` for the slowest of them (`apply.verify_timeout_sec`). The server runs every check, write
  form and red check itself, in its own process group, without the vendor credentials the server holds, killed
  whole at its time limit, and refused when the person's Claude settings deny it (Phase 5, `refused`). A
  bugfix's reproducing test also carries its red checks, typed `expect: "fail"`: the server runs them after the
  other checks pass, and passes the answer only when each fails by its exit code (non-zero, but not "command not
  found" or a timeout). Since the red verdict is the exit code alone, the unit also carries a check that must
  pass (one that proves the file loads), and a reproducing check's write form never runs. Imports are not
  guessed: the spec states each new file's import line and the shared brief lists every file's, as greenfield's
  briefs do, and the project's own checks catch the rest. When the architect checks a units section, plan-lint
  runs each unit's checks on its file as it is (a new file's style file) and refuses one that fails there, so a
  check that could not judge the file is fixed while the section is open. The server's baseline at dispatch
  stays as the backstop: before the change it runs each check on the file as it is (on a new file's style
  file, `apply.baseline_from`); a check that already fails there is set aside for that file — it never judges
  the answer and its write form never runs — and the receipt names it (`set_aside`). Report those in your final
  message. A fix round's packets (`apply.baseline: false`) take no baseline: every check judges the fix.
- The spec's project checks (a typecheck, the full suite) as `verify_deferred` on the last packet; in a bugfix,
  the reproducing test's own checks on its file come first among them.
  **Before the first batch, run the project checks once on the project as it is**: the header's
  `project_checks` (`jq -r '.project_checks[].run' <output_dir>/change.sections/header.json`), in one Bash
  call, keeping each command's exit status and the names of its failing tests, not the whole log.
  **Run every `verify_deferred` command once, after the last packet of the phase** (they are in the batch
  receipt's `verify_deferred`; a per-packet package check fails on other packets' unfinished work), and send
  each failure that is new against that first run as a fix packet ("Fix packets by code", Phase 6), named by
  the file whose error it reports — except a bugfix's reproducing test: name the source file the failing test
  exercises, with the test in `context_paths`, since no fix round changes the test. Then run the failing
  commands again, and repeat while the number of failures goes down, at most three fix rounds, as greenfield
  does after its tests stage. A failure that was already there before the run is not this run's to fix: it,
  and what still fails after the rounds, are reported at the next gate and in your final message, each with its
  command and its error.
- `task_type` is empty and `phase` is the unit's, as greenfield's packets, and every packet carries the run's
  `intent`: the policy routes a file by its stage, and by the run's intent when a policy rule names one. A
  `tooling` unit is a shell step (`tooling_<unit>`, no `apply`) you run where its `depends_on` puts it, under
  provenance (Phase 5).

## Output ceilings

Instead of SKILL.md's values for codegen and premium packets ("TaskPacket initial output-ceiling budgets"):

- **Apply packets (codegen, tests, docs):** the server asks for the routed model's documented output
  limit (its policy leaf's `max_output_tokens_absolute`), so a reply is cut off only at the model's own
  limit, and a cut-off reply goes to the next model in the ladder instead of being sent again. The
  packet's own `budget` is used only for a model that declares no limit.
- **Premium packets (design, senior_code_review, security_review):** `8000`.

## Phase 5 — execute_packets

Instead of SKILL.md's direct-tier paragraph:

**Direct-tier work (no MCP dispatch):** you write only the run's own record yourself (`requirements.md`,
`failures.json`), never a project file: every derived and fix packet is typed by the server under every policy, a
packet routed to your own model included ("Batch the phase", below). Estimate your own work's tokens via the
`chars/3.8` heuristic for both inputs and outputs; take pricing constants from this model's `effective_price.rates` in the `load_policy` result (the dated price list's card for the day, or the policy's block only under `pricing_override: true`: the price the server and the post-run collector bill at; see orchestrator rule 6); log a TelemetryEvent via `log_telemetry`.

Instead of SKILL.md's "Write the returned file content to disk at the packet's stated `artifact_path`.": you
write no returned content; the server writes every typed file (the apply form, below).

**Wait inside your turn — never end it to wait.** When a subagent or a
long test run is in flight, block on it with a Bash until-loop on its output file
(`until [ -s <file> ]; do sleep 15; done`, `timeout: 600000`, repeated if it needs longer), or
delegate the subagent in the foreground. Do not end your turn and rely on a completion
notification to resume you: a resumed turn misses the prompt cache and re-writes the whole
context. The security review runs after the senior review's refinements and the test run (Phase 8 after
Phase 7), as greenfield orders them, so it reads the final diff.

**Batch the phase (brownfield, every policy).** Instead of SKILL.md's "Mechanical-tier work (routed to another
model)" paragraph: do not dispatch the derived packets one call at a time. One `execute_batch` call carries every
apply-form packet of the phase: pass `packets_path: <output_dir>/packets.json` (a fix round passes its own
`repairs/round-<n>.json`; `packet_ids` narrows a call to the packets it names) with the same `policy_name`,
`project_root`, `run_id`, `telemetry_path` and `cache_context` you would pass to `execute_with_model`. Once
pre-flight recorded the `run_id`, the server types the batch under the policy pre-flight recorded, and a call
naming another policy is refused. **Do not `Read` packets.json and do not paste packets inline** — the server
reads the file, skips `tooling` packets (listed as `skipped_no_apply`, and in `tooling_steps` with each step's
instruction), and returns a receipt within 2 kB: applied packets in short form, a packet that did not apply with
its decision fields and a short `reason`, and every outcome whole in the `full_receipt` file it names (in the
run's folder; `jq` the one packet you need). Reading the file and typing it back puts the whole packet list into every later turn. The
server runs them in
parallel, 4 at a time (a stated bound the server fixes), in `depends_on` order, never two on one `artifact_path` at once,
and returns one receipt per packet plus totals — one turn for the phase instead of one per packet. While it
runs it sends a progress message as each packet settles and every 30 seconds between, as greenfield's stage
call does, so a long batch is not cut off as idle; nothing for you to do. Read the batch result:

| `items[].status` | What you do |
|---|---|
| `applied` | Nothing (STOP ON PASS) |
| `already_applied` | Applied by an earlier call of this run, and its file still holds what the run wrote there: nothing was typed, $0. Nothing |
| `escalate` / `verify_failed` / `no_content` | Every such file of the batch goes into one fix round (table below), after the batch returns |
| `refused` / `dispatch_failed` / `stopped` | As in the table below |
| `blocked` | Its dependency did not apply (`blocked_by`). A tooling step names its own id there: run it (below), and once it exits 0 send every packet it blocks, following the chain in the receipt: those whose `blocked_by` names the step, and those whose `blocked_by` names a packet the step blocks. Any other dependency: once the fix round applies it, send the blocked packets, and the packets blocked behind them, in one more batch (`packet_ids`) |
| `error` | The dispatch threw (`error` says why): send it once more in a batch of its own (`packet_ids`); if it throws again, report it at the next gate with that reason |

`items[].attempts` counts attempts only: a busy vendor's waits are in `transport_waits`, apart from them.

`tooling` packets (no model) are shell steps you run. A packet that waits for one comes back `blocked`, with the
step's id in `blocked_by`, and the receipt's `tooling_steps` gives each step's instruction (and its own
`blocked_by` when a packet the step waits for did not apply: that step waits for the fix round too). For each
step that is not blocked: run the step, then send the blocked ids in one more `execute_batch` with `packet_ids`.
**Record what the step writes**, so `/mmo:revert` and the reviewers see it: one Bash call holds
`write-provenance.mjs --before` (with `--packet-id tooling_<unit>`) for the packet's `artifact_path` and for every
other file the step writes (the package manager's lockfile, in the step's `cwd` or at the workspace root), the
step, and `--after` for each of those files, joined with `;` and never `&&`, so the `--after` calls run whether
the step succeeded or not: `<the --before calls>; <step>; rc=$?; <the --after calls>; echo "step exit: $rc"`. A
step that exits non-zero goes to the next gate with its exit code and the end of its output. Then
`git status --porcelain`: a file the step changed that `provenance.json` does not list goes in your final
message and at the next gate, since `/mmo:revert` cannot restore it. Once every packet of the phase has
settled, run every `verify_deferred` command once (Phase 4).

Every packet is typed by greenfield's own typist for the model the policy routes it to — the lean
Opus typist (one `claude -p` call per attempt, no tools, low effort, the person's own login under `estimated`),
Flash through the completion door, or the Antigravity agent, which answers from its own scratch folder while the
server writes (so the write contract and the snapshots hold for it too) — through the same loop and the same
receipt: the policies differ only in who types. The run's start check (`preflight_dispatch`) must come first; a
packet routed to the agent door without it is refused. The ladder is greenfield's:
every attempt but the last by the model the policy routes, the last by the lean Opus typist on the policy's
default model when that is a Claude model, else on its first Claude model the run can reach (a policy with no
Claude model keeps its own routes). Each attempt
asks for its model's documented output limit; a reply cut off there skips that model's later attempts
and goes to the next model in the ladder, in that model's own slot, so a cut-off never adds an attempt. The
typists read the batch the way they read greenfield's spec: the inputs every packet of the batch carries (the
shared brief, `briefs/shared.md`) go first, the same bytes for every packet — the lean typist's cached system
prompt, Flash's inline header (which Gemini's implicit cache reuses), the agent's system file — and each packet
keeps its own brief, style file and file; a lean typist idle longer than its five-minute cache sends one call
alone before the others start, so they read that cache instead of each writing it. Each typist call writes one
telemetry event priced from its own receipt, naming its door (`lean-opus`, `flash-completion`, `agy`).

**Apply form (brownfield, every file-producing mechanical packet).** The server writes the file, runs its
checks, retries on the mechanical tier with the failure appended, and returns a receipt. Code writes every
packet in this form, the derived packets (Phase 4) and the fix packets (Phase 6, "Fix packets by code"); you
never write or edit one. What a packet carries:

| Field | Value |
|---|---|
| `inputs[]` | Paths only — no `content`, narrowed with `lines: [from, to]` (or `section: "<heading>"` of a Markdown file); the server reads them. A derived packet carries `briefs/shared.md`, `briefs/<unit>.md`, the unit's style and `uses` files, and an edited file whole up to 200,000 bytes (the server's bound on one input). A fix packet carries the same two briefs of the file's unit, the file itself, and the files the failure points at. Nothing else: the worker does not need the whole plan, the requirements, or the repo facts. |
| `instruction` | Says which file changes and what the answer is (`{path, content}`, or `{edits: [...]}` in `edits` mode); the briefs carry the spec. A fix packet names the failure and the lines it points at. |
| `outputSchema` | None. The server supplies `{path, content}`. |
| `intent` | The run's job, as Gate 0 recorded it. The server types a packet with greenfield's typists only when it names a brownfield job and pre-flight recorded the run; code sets it on every derived and fix packet. |
| `apply` | `{ "write": true, "mode": "content" or "edits", "checks": [{id, run, fix?, expect?: "fail"}], "baseline_from"?: <style file>, "baseline"?: false, "max_retries": 2 }`. Each check's `fix` runs after the write and before its `run`, `{path}` is the file, and a check the file failed before the change is set aside (Phase 4). A check typed `expect: "fail"` is a bugfix's red check (Phase 4); it has no `fix`. A fix packet takes no new baseline (`"baseline": false`): it carries the file's checks less those set aside when the file was applied, and every one of them judges the fix. A packet with `verify` / `format` lists instead of `checks` runs exactly those, with no baseline and no write form it does not name. `mode: "edits"` (edits to an existing file): the worker answers in greenfield's contract — `{path, edits: [{search, replace}]}`, each search copied exactly from the current text and found there exactly once, applied in order, or `{path, content}` with the whole file — and the server applies it with greenfield's applier to the file as it was before the packet, keeping the file's own line ending (a whole file written over an existing one keeps its ending too; a new file takes its same-kind input's); a search found zero or several times is a retry with that reason; the file must exist. |
| `run_id` (tool argument, beside `packet`) | The run id, so the server records provenance for the write under `.sdlc/runs/<run_id>/` and `/mmo:revert` still works. Do not run `write-provenance.mjs --before/--after` yourself for an applied packet. A packet that ends with any other status has its file recorded as it is on disk, so `/mmo:revert` sees no change where the packet left the file as it was. |

Read the receipt's `status`:

| `status` | What happened | What you do |
|---|---|---|
| `applied` | Written, its checks passed (or it has none) | **STOP ON PASS.** Nothing. Do not `cat` the file, do not re-run the verify command, do not read the packet result back. Move to the next packet. `apply.path`, `apply.sha16`, `apply.lines` are the record. |
| `escalate` | An attempt failed and the policy routes the next one (`escalate.retry_count`) to `escalate.model_id`, which the server cannot type with | Same as `verify_failed`. `escalate.failure` is the last attempt's failure (in a batch receipt, its first 160 characters are the item's `reason`, and the whole of it is in the `full_receipt` file). In `content` mode the last attempt is on disk only when it was written (at `artifact_path`; an answer that could not be used writes nothing, and the file is then as it was before the packet); in `edits` mode the file is back to its pre-packet state (every attempt applies to the original, and a failed one is undone). |
| `verify_failed` | `max_retries` spent in the server (the last by the ladder's last-attempt model) and no model left to escalate to | **One fix round, by code.** Put the file in `<output_dir>/failures.json` with the receipt's failure as its `problem` (`attempts[].failure`; in a batch, from the `full_receipt` file) and send it through "Fix packets by code" (Phase 6), one round for every such file of the batch. What still fails after that round is reported at the next gate with its failure. Never type the file in this session and never edit a packet. |
| `refused` | The server refuses it before any typist is paid, and the `reason` says why: its `artifact_path` is outside the write contract (checked again before the write); it is a fix round aimed at a bugfix's reproducing test; one of its commands is one the person's Claude settings deny; or it adds the reproducing case to a test file that already fails before the change | Never work around it: never edit the packet, the spec, the contract or the settings. Outside the write contract: a scope change is the person's decision — stop and tell the person which path is needed and why. A denied command: stop and tell the person which command the plan needs and why. A reproducing-test refusal goes back to the architect: re-delegate `brownfield-architect` with the `reason`, as for a plan-to-packets exit 1 (Phase 2), run plan-to-packets again, and dispatch the packets that have not applied (`packet_ids`). |
| `dispatch_failed` | The last attempt's call failed. A busy vendor (429, 5xx, a dropped connection) is waited out first, up to 6 waits for each attempt, and a wait is not an attempt (the receipt counts them in `transport_waits`); every other vendor failure is an attempt on the ladder, retried with its reason by the next attempt (no price, a cap, a typist that brought no reply, a vendor still busy after its waits); a pause longer than a minute is an attempt, and the next attempt waits a minute first. A reply cut off at the output limit goes to the next model in the ladder, and ends here when no other model is left; so does a failure on this machine outside a call (a write the disk refused). Nothing of the packet stays on disk: the file is as it was before the packet. With `halt`, the vendor refused the call's credentials (401, 403) and the batch stopped. | With `halt`, tell the person the credentials need fixing; do not re-dispatch. Otherwise report it at the next gate with its `reason` (whole in the `full_receipt` file), and never type the file in this session. |
| `no_content` | The last attempt's answer could not be used: outside the contract (no `content` string, no exact edits), edits that do not apply, an answer naming another file, or an empty file. Nothing of the packet stays on disk: the file is as it was before the packet | Same as `verify_failed`. |
| `stopped` | The call was cancelled while it ran (the person pressed Stop), or, with `stopped_reason`, another packet's credentials were refused (the receipt's `halted`) | Nothing was written after the stop. Do not re-dispatch: carry on only when the person asks, or once the credentials are fixed. |

The receipt is small by design (≤ 2 kB; a check's output tailed to the same 2 kB, greenfield's receipt bound):
the packets and the files never pass through this conversation, so a batch costs one call and one short
receipt in your context however many files it types.

`telemetry.jsonl` gets one event per attempt (`events_written` says how many); the events are not echoed in the receipt when `telemetry_path` is set.

## Phase 6 — senior_code_review

Invoke `brownfield-senior-reviewer` instead of `senior-reviewer`, once for the whole change (every derived
packet's module is `spec`), writing its review JSON to `<output_dir>/review.json`. Its findings become fix
packets by code (below); it writes no packets.

**Fix packets by code.** Review findings and the failures of a check you ran are turned into packets by
code, never by hand. For failures, write `<output_dir>/failures.json`: one entry per file to change,
`{path, problem, context_paths?, new_file?}` — the file, the failure verbatim (test name and error, or the
typecheck line), files to show beside it (the failing test file), and `new_file: true` when the fix
creates the file. Then run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/findings-to-packets.mjs" --run-id <run-id> --intent <intent> --project-root "$(pwd)" \
  --review <output_dir>/review.json --failures <output_dir>/failures.json
```

(either flag alone is fine). It places each file as greenfield's repair round does (a path written from above
the project is found under it), merges every problem of one file into one `debug` packet with the file whole
and the file's own briefs from the spec, and writes `<output_dir>/repairs/round-<n>.json`. A fix packet carries
`apply.baseline: false` and the unit's checks less those set aside when it was applied: no new baseline is
taken, so every check it carries judges the fix. A failure on a file a tooling step writes (an install's lockfile) goes back
to that step, not to a typist, unless a typed unit owns the file. Lines on stderr name what it could not route, each with its
reason: a finding with no file; a path outside the project or the write contract (an off-limits or
non-allowlisted file); an off-limits file shown beside the failure (its text is never sent to a model); a
bugfix's reproducing test, which judges the fix and no fix round changes (name the source file it exercises
instead, Phase 4); and a tooling step's file (run that step again, under provenance, Phase 5). Never route those
by hand: list them in your final message and at the next gate, with their reasons. Dispatch the round in
**one** `execute_batch` call with `packets_path` set to that file, and read the receipt as in Phase 5.

In brownfield the delegation carries what the brownfield-orchestrator's reviewer contract lists (rule 9):
`change_plan.md`, `provenance.json`, the path the reviewer writes and the suite summary below; the reviewer
reads diffs against `git_head_before`, not whole files.

Also in brownfield, pass a one-line-per-suite summary of the tests, typecheck and verify results
you already have (counts and pass/fail, no logs), so the reviewer does not re-run them. The same
summary goes to the security reviewer in Phase 8. Both brownfield reviewers follow their "Lean
review" budget.

## Phase 7 — test_run

Instead of step 1's "Append the new keys to `.env.example`" in SKILL.md's brownfield mode: `.env.example` is on the
always-off-limits list (`.env.*`), so no unit, fix round or write of this run changes it. List the new keys the change
reads (from the spec's decisions) at the mini-gate (steps 2 and 3); the person adds them.

Instead of SKILL.md's "Any other failure" bullet:

- Any other failure → name each failing file with its failure in `<output_dir>/failures.json`, except a
  bugfix's reproducing test: name the source file the failing test exercises, with the test in
  `context_paths`. Send the round through "Fix packets by code" (Phase 6): one `execute_batch` call, the
  server's ladder and checks.
  Then run the failing tests once more: one fix round, as greenfield allows after its senior review. A test
  that already failed before the run (the project checks' first run, Phase 4) is not this run's to fix. What
  still fails is reported at the next gate with the failing command and its error; no file is fixed by hand.

## Phase 8 — security_review

Invoke `brownfield-security-reviewer` instead of `security-reviewer`, and instead of the Intent matrix's
Phase 8 column: it reviews every file the run touched by the file's kind, whatever the job (a test or docs run
that edits a source file gets that file's full review). Writes `<output_dir>/security_review.md`: findings
only, each with its file. The fixes the person accepts at Gate 3 go through "Fix packets by code" (Phase 6):
one `failures.json` entry per file (the finding as its `problem`), one `execute_batch` call.
