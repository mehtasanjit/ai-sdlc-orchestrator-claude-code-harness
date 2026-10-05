# Feature runs: feature-extend and feature-new

For the `brownfield-orchestrator` agent, which runs brownfield jobs whose intent is `feature-extend` or
`feature-new`. Follow `${CLAUDE_PLUGIN_ROOT}/skills/pipeline/SKILL.md` as every run does. This file adds to
it; where a part below says **instead of**, it replaces that part of SKILL.md for this run. Every other run
(greenfield, and the brownfield jobs bugfix, docs, test, refactor and deps) follows SKILL.md alone.

## Phase 2 — after the architect returns

**Brownfield: finalize the change spec before Gate 2.** The architect hands over a typed change spec in
sections, each checked against the files when it writes it (`brownfield-architect`, "The change spec");
it does not write `change_plan.md`. When it returns, run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-to-packets.mjs" --spec --run-id <run-id> --intent <intent> --project-root "$(pwd)"
```

It checks the accepted spec as a whole — every reference resolves, every file a section pointed into is
unchanged since that section was accepted, every `FR-`/`AC-` id of `requirements.md` is covered by a unit
— then renders `<output_dir>/change_plan.md` (what Gate 2 shows and the reviewers read), writes the
typists' briefs to `<output_dir>/briefs/`, and writes `<output_dir>/packets.json`, with no model call.

Exit 0: read the summary line and any warnings, then open Gate 2. Exit 1: the spec is not complete or no
longer matches the files; re-delegate the architect with the printed lines ("Fix these spots in your
section files with Edit, check each changed file again with plan-lint --section, and return"), then run
the command again. Never edit the spec, the rendered plan or a packet yourself: a hand edit here is Opus
re-typing the work the typists do. On a Gate 2 `revise`, the architect edits its sections and you run the
command again.

## Phase 4 — plan_task_packets

**Brownfield: the packets are already derived** (Phase 2): `packets.json`, one packet per unit, in
dependency order. Log the `plan_task_packets` event with the tokens you actually spent (none for the
derivation). What a packet carries, all by code:

- `inputs`, paths only: `briefs/shared.md` (the conventions, the decisions, and every file of the change
  with its import line and exports — the same bytes for every packet, so both typists read it from a
  cache), `briefs/<unit>.md` (the unit and the units it depends on), the unit's style file and the files
  it uses, and for an edit the file being edited, whole (in consecutive parts when it is larger than the
  server's bound on one input, 200,000 bytes).
- An edit's sites as guidance — each site's lines, their text and its rule — and greenfield's own answer
  contract: exact edits (`{path, edits: [{search, replace}]}`, each search found once in the current text)
  or the whole file. One packet per file, however many sites it has: a reply cut off at a model's output
  limit goes to the next model in the ladder (Phase 5, "Batch the phase").
- `apply.checks`: the unit's file checks, each with its own write form (`fix`); each may run as long as the
  plan's `timeout_s` for the slowest of them (`apply.verify_timeout_sec`). Imports are not guessed:
  the spec states each new file's import line and the shared brief lists every file's, as greenfield's
  briefs do, and the project's own checks catch the rest. Before the change the server runs each check on the file as it is (on a new
  file's style file, `apply.baseline_from`); a check that already fails there is set aside for that
  file — it never judges the answer and its write form never runs — and the receipt names it
  (`set_aside`). Report those in SUMMARY.md.
- The spec's project checks (a typecheck, the full suite) as `verify_deferred` on the last packet.
  **Run every `verify_deferred` command once, after the last packet of the phase**, and send each failure
  to the file whose error it reports as a fix packet ("Fix packets by code", Phase 6) — a per-packet
  package check fails on other packets' unfinished work (measured: a route-tree edit was retried twice for
  another packet's import errors).
- `task_type` is empty and `phase` is the unit's, as greenfield's packets: the policy routes a file by its
  stage alone. A `tooling` unit is a shell step (`tooling_<unit>`, no `apply`) you run where its
  `depends_on` puts it.

## Output ceilings

Instead of SKILL.md's values for codegen and premium packets ("TaskPacket initial output-ceiling budgets"):

- **Apply packets (codegen, tests, docs):** the server asks for the routed model's documented output
  limit (its policy leaf's `max_output_tokens_absolute`), so a reply is cut off only at the model's own
  limit, and a cut-off reply goes to the next model in the ladder instead of being sent again. The
  packet's own `budget` is used only for a model that declares no limit.
- **Premium packets (design, senior_code_review, security_review):** `8000`. Design and review artifacts are the ones that historically hit the ceiling.

## Phase 5 — execute_packets

Instead of SKILL.md's direct-tier paragraph:

**Direct-tier work (subagent handles it, no MCP dispatch):** the orchestrator (Opus) writes the file directly — except a brownfield run's derived packets, which the server types under every policy ("Batch the phase", below). Estimate tokens via `chars/3.8` heuristic for both inputs and outputs; take pricing constants from this model's `effective_price.rates` in the `load_policy` result (the dated price list's card for the day, or the policy's block only under `pricing_override: true`: the price the server and the post-run collector bill at; see orchestrator rule 6); log a TelemetryEvent via `log_telemetry`.

Instead of SKILL.md's "Write the returned file content to disk at the packet's stated `artifact_path`.":

Write the returned file content to disk at the packet's stated `artifact_path` — **only for packets without `apply`**. Every brownfield codegen, tests, docs and debug packet that produces a file uses the apply form below instead.

**Wait inside your turn — never end it to wait.** When a subagent or a
long test run is in flight, block on it with a Bash until-loop on its output file
(`until [ -s <file> ]; do sleep 15; done`, `timeout: 600000`, repeated if it needs longer), or
delegate the subagent in the foreground. Do not end your turn and rely on a completion
notification to resume you: a resumed turn misses the prompt cache and re-writes the whole
context. The security review runs after the senior review's refinements and the test run (Phase 8 after
Phase 7), as greenfield orders them, so it reads the final diff.

**Batch the phase (brownfield, every policy).** Do not dispatch the derived packets one call at
a time. One `execute_batch` call carries every apply-form packet of the phase: pass
`packets_path: <output_dir>/packets.json` (plus `packet_ids` when only some should run — e.g. the
ones after a tooling step; a fix round passes its own `repairs/round-<n>.json`) with the same
`policy_name`, `project_root`, `run_id`, `telemetry_path` and `cache_context` you would pass to
`execute_with_model`. **Do not `Read` packets.json and do not paste packets inline** — the server
reads the file, skips `tooling` packets (listed as `skipped_no_apply`), and returns a receipt within
2 kB: applied packets in short form, a packet that did not apply with its decision fields and a short
`reason`, and every outcome whole in the `full_receipt` file it names (in the run's folder; `jq` the one
packet you need). Reading the file and typing it
back put ~15k tokens into every later turn. To check one packet, `jq` that one id. The server runs them in
parallel, 4 at a time (a stated bound the server fixes), in `depends_on` order, never two on one `artifact_path` at once,
and returns one receipt per packet plus totals — one turn for the phase instead of one per packet. While it
runs it sends a progress message as each packet settles and every 30 seconds between, as greenfield's stage
call does, so a long batch is not cut off as idle; nothing for you to do. Read the batch result:

| `items[].status` | What you do |
|---|---|
| `applied` | Nothing (STOP ON PASS) |
| `escalate` / `verify_failed` / `no_content` | As for a single packet (table below), one at a time, after the batch returns |
| `blocked` | Its dependency did not apply (`blocked_by`); resolve the dependency first, then re-dispatch the blocked packets in a second batch |
| `error` | The dispatch threw (`error` says why); re-dispatch after fixing the cause, or escalate |

`tooling` packets (no model) run as shell steps between batches where their `depends_on` puts them:
batch everything before the tooling step, run it, batch the rest. Then run every `verify_deferred`
command once. Every packet is typed by greenfield's own typist for the model the policy routes it to — the lean
Opus typist (one `claude -p` call per attempt, no tools, low effort, the person's own login under `estimated`),
Flash through the completion door, or the Antigravity agent, which answers from its own scratch folder while the
server writes (so the write contract and the snapshots hold for it too) — through the same loop and the same
receipt: the policies differ only in who types. The run's start check (`preflight_dispatch`) must come first; a
packet routed to the agent door without it is refused. The ladder is greenfield's:
every attempt but the last by the model the policy routes, the last by the lean Opus typist (the chat's
model, else the policy's Claude model; a policy with no Claude model keeps its own routes). Each attempt
asks for its model's documented output limit; a reply cut off there skips that model's later attempts
and goes to the next model in the ladder, in that model's own slot, so a cut-off never adds an attempt. The
typists read the batch the way they read greenfield's spec: the inputs every packet of the batch carries (the
shared brief, `briefs/shared.md`) go first, the same bytes for every packet — the lean typist's cached system
prompt, Flash's inline header (which Gemini's implicit cache reuses), the agent's system file — and each packet
keeps its own brief, style file and file; a lean typist idle longer than its five-minute cache sends one call
alone before the others start, so they read that cache instead of each writing it. Each typist call writes one
telemetry event priced from its own receipt, naming its door (`lean-opus`, `flash-completion`, `agy`).

**Apply form (brownfield, every file-producing mechanical packet).** The server writes the file, runs its checks, retries on the mechanical tier with the failure appended, and returns a receipt. The derived packets (Phase 4) and the fix packets (Phase 6, "Fix packets by code") already follow it; a packet you write by hand, when code could not route a fix, follows it too:

| Field | Value |
|---|---|
| `inputs[]` | Paths only — no `content`. Narrow with `lines: [from, to]` (or `section: "<heading>"` of a Markdown file). The server reads them; you never paste file text into a packet. A derived packet carries `briefs/shared.md`, `briefs/<unit>.md`, the unit's style and `uses` files, and an edited file whole up to 200,000 bytes (the server's bound on one input). A packet you write carries the same two briefs of the file's unit, the file itself, and the slice the failure points at. Nothing else: the worker does not need the whole plan, the requirements, or the repo facts. |
| `instruction` | Says which file changes and what the answer is (`{path, content}`, or `{edits: [...]}` in `edits` mode); the briefs carry the spec, so do not restate them. For a fix, name the failure and the lines it points at. |
| `outputSchema` | Omit it. The server supplies `{path, content}`. |
| `apply` | `{ "write": true, "mode": "content" | "edits", "checks": [{id, run, fix?}], "baseline_from"?: <style file>, "max_retries": 2 }`. Copy `checks` (and `baseline_from`) from the file's own packet in `packets.json`: each check's `fix` runs after the write and before its `run`, `{path}` is the file, and a check the file failed before the change is set aside (Phase 4). A packet with `verify` / `format` lists instead of `checks` runs exactly those, with no baseline and no write form it does not name. `mode: "edits"` (edits to an existing file): the worker answers in greenfield's contract — `{path, edits: [{search, replace}]}`, each search copied exactly from the current text and found there exactly once, applied in order, or `{path, content}` with the whole file — and the server applies it with greenfield's applier to the file as it was before the packet, keeping the file's own line ending (a whole file written over an existing one keeps its ending too; a new file takes its same-kind input's); a search found zero or several times is a retry with that reason; the file must exist. |
| `run_id` (tool argument, beside `packet`) | The run id, so the server records provenance for the write under `.sdlc/runs/<run_id>/` and `/mmo:revert` still works. Do not run `write-provenance.mjs --before/--after` yourself for an applied packet. A packet that ends with any other status has its file recorded as it is on disk, so `/mmo:revert` sees no change where the packet left the file as it was. |

Read the receipt's `status`:

| `status` | What happened | What you do |
|---|---|---|
| `applied` | Written, its checks passed (or it has none) | **STOP ON PASS.** Nothing. Do not `cat` the file, do not re-run the verify command, do not read the packet result back. Move to the next packet. `apply.path`, `apply.sha16`, `apply.lines` are the record. |
| `escalate` | Verify failed `escalate.retry_count` times on the mechanical tier and the policy routes the next attempt to `escalate.model_id` | Handle the retry exactly as an escalated packet today: under `estimated` in your own conversation with `provenance: "estimated"`, under `vendor` via `execute_with_model` with `retry_count: escalate.retry_count`. `escalate.failure` is the last verify output (in a batch receipt, its first 160 characters are the item's `reason`, and the whole of it is in the `full_receipt` file). In `content` mode the last attempt is on disk at `artifact_path`; in `edits` mode the file is back to its pre-packet state (every attempt applies to the original, and a failed one is undone), so the escalated packet redoes the edit. |
| `verify_failed` | `max_retries` spent in the server (in a feature run the last by the lean Opus typist) and no model left to escalate to | Same as `escalate`: the failure is in `attempts[].failure` (in a batch, in the `full_receipt` file). |
| `refused` | `artifact_path` is outside the write contract | Planner bug. Fix the packet's `artifact_path` or the allowlist decision; never work around it. |
| `dispatch_failed` | The vendor call failed. The server already waited out a busy vendor (429, 5xx, a dropped connection: up to 6 waits, none an attempt), so this is a failure that waiting does not fix (no price, a cap, a pause longer than a minute, a reply cut off at the output limit with no other model left in the ladder). With `halt`, the vendor refused the call's credentials (401, 403) and the batch stopped. | As today for a failed dispatch. With `halt`, tell the person the credentials need fixing; do not re-dispatch. |
| `no_content` | The model never returned a `content` string within `max_retries` | Rewrite the instruction to demand JSON `{path, content}`; re-dispatch. |
| `stopped` | The call was cancelled while it ran (the person pressed Stop), or, with `stopped_reason`, another packet's credentials were refused (the receipt's `halted`) | Nothing was written after the stop. Do not re-dispatch: carry on only when the person asks, or once the credentials are fixed. |

The receipt is small by design (≤ 2 kB; a check's output tailed to the same 2 kB, greenfield's receipt bound). One `execute_with_model` call per file is the whole cost of a mechanical packet in your context: the packet (paths + instruction, ~150 tokens) and the receipt (~80 tokens). On the run this contract comes from, the previous form put ≈ 62k tokens of file text through the orchestrator's context for 24 packets, against 8k when the same files were written inline.

`telemetry.jsonl` gets one event per attempt as before (`events_written` says how many); the events are not echoed in the receipt when `telemetry_path` is set.

## Phase 6 — senior_code_review

Invoke `brownfield-senior-reviewer` instead of `senior-reviewer`, for each module, each writing its review JSON
to `<output_dir>/review-<module>.json`. Its findings become fix packets by code (below); it writes no packets.

**Fix packets by code.** Review findings and the failures of a check you ran are turned into packets by
code, never by hand. For failures, write `<output_dir>/failures.json`: one entry per file to change,
`{path, problem, context_paths?, new_file?}` — the file, the failure verbatim (test name and error, or the
typecheck line), files to show beside it (the failing test file), and `new_file: true` when the fix
creates the file. Then run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/findings-to-packets.mjs" --run-id <run-id> --intent <intent> --project-root "$(pwd)" \
  --review <output_dir>/review-<module>.json --failures <output_dir>/failures.json
```

(either flag alone is fine; `--review` once per review file). It places each file as greenfield's repair
round does (a path written from above the project is found under it), merges every problem of one file
into one `debug` packet with the file whole and the file's own briefs and checks from the spec, and writes
`<output_dir>/repairs/round-<n>.json`; lines on stderr name what it could not route (a finding with no
file, a path outside the project or the write contract) — handle those yourself or list them in
SUMMARY.md. Dispatch the round in **one** `execute_batch` call with `packets_path` set to that file, and
read the receipt as in Phase 5.

In brownfield the delegation carries paths only — `change_plan.md` (or `requirements.md`) and
`provenance.json` — per the brownfield-orchestrator's rule 9; the reviewer reads diffs against
`git_head_before`, not whole files.

Also in brownfield, pass a one-line-per-suite summary of the tests, typecheck and verify results
you already have (counts and pass/fail, no logs), so the reviewer does not re-run them. The same
summary goes to the security reviewer in Phase 8. Both brownfield reviewers follow their "Lean
review" budget.

## Phase 7 — test_run

Instead of SKILL.md's "Any other failure" bullet:

- Any other failure → name each failing file with its failure in `<output_dir>/failures.json` and send the
  round through "Fix packets by code" (Phase 6): one `execute_batch` call, the server's ladder and checks.
  Then run the failing tests once more.

## Phase 8 — security_review

Invoke `brownfield-security-reviewer` instead of `security-reviewer`. Writes `<output_dir>/security_review.md`:
findings only, each with its file. The fixes the person accepts at Gate 3 go through "Fix packets by code"
(Phase 6): one `failures.json` entry per file (the finding as its `problem`), one `execute_batch` call.

