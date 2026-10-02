# Feature runs: feature-extend and feature-new

For the `brownfield-orchestrator` agent, which runs brownfield jobs whose intent is `feature-extend` or
`feature-new`. Follow `${CLAUDE_PLUGIN_ROOT}/skills/pipeline/SKILL.md` as every run does. This file adds to
it; where a part below says **instead of**, it replaces that part of SKILL.md for this run. Every other run
(greenfield, and the brownfield jobs bugfix, docs, test, refactor and deps) follows SKILL.md alone.

## Phase 2 — after the architect returns

**Brownfield: lint the plan before Gate 2.** `change_plan.md` is a spec the worker implements, not a
listing it copies (architect.md, "Per-unit sections"). When the architect returns, run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs" "<output_dir>/change_plan.md"
```

Exit 0: open Gate 2. Exit 1: re-delegate the architect **once** with the printed violation list
("Edit these sections in place to Exports / Behavior / Mirror; do not rewrite the file"), lint again, and open Gate 2 whatever the
second result — but log `phase.end` with `plan_lint=failed` and say so in the gate prompt and in
SUMMARY.md, because the run's cost will show it. Never edit the plan yourself to pass the lint: the
sections are the worker's inputs, and a hand edit here is Opus re-typing the program, which is the
cost this gate exists to remove.

## Phase 4 — plan_task_packets

**Brownfield: derive the packets, do not write them.** After the plan passes the lint (Phase 2), run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-to-packets.mjs" "<output_dir>/change_plan.md" \
  --run-id <run-id> --intent <intent> --project-root "$(pwd)" [--multi-model]
```

Pass `--multi-model` when the loaded policy names more than one model. Then an `edit` unit with no edit
sites is an error (exit 1, narrow architect Edit) instead of a silent whole-file packet. The flag catches whatever it
still cannot read. Every packet whose verify runs `biome check` / `prettier --check` on its file also
carries `apply.format` (the `--write` form); the server runs it after the write and before verify, so a
formatting-only miss is not a retry.

It writes `<output_dir>/packets.json` from the plan's unit sections with no model call: one packet per
`## An — <path>` unit in plan order, `new_file` → apply packet returning the file, `edit` → apply packet in
`edits` mode with the Edit-anchor windows as inputs, `tooling` → a shell step, test paths → the `tests`
phase; `task_type` from the path (override with a `- **Packet** task_type=…, module=…` bullet in the
unit); `inputs` = unit section + `House style` + Mirror slices; `verify` from the Verify bullet;
`depends_on` from Depends on. It also checks the plan against the repo: a mirror file that does not exist
or a line past its end is a **warning** on stderr, an edit to a missing file or a mirror outside the repo
is an **error** (exit 1). On exit 1 the plan is wrong, not the script — re-delegate the architect with
the error lines and the unit ids they name, as for a lint failure: "Edit these units in place; do not
rewrite the file". A fresh delegation that rewrote the whole plan
for a one-line fix cost ≈ 7.7k output tokens on the run this comes from. On exit 0, read the summary line and the warnings; adjust a
packet only when a warning names it (a dropped mirror the worker needs) and log the `plan_task_packets` event with the tokens you actually spent — on the run
this comes from, hand-writing the same 17 packets cost $1.03 and 9 turns.

Two more things the derived packets carry: an edit with more than five anchor sites is split into
chunk packets (`tp_codegen_004-a`, `-b`, …) chained by `depends_on` — dispatch them in order, they
edit the same file; and a package-wide verify command (`typecheck`, the full suite) is on the packet
as `verify_deferred`, not in `apply.verify`. **Run every `verify_deferred` command once, after the
last packet of the phase**, and treat a failure as a debug packet against the file whose error it
reports — a per-packet package check fails on other packets' unfinished work (measured: a
route-tree edit was retried twice for another packet's import errors). Under `--multi-model` every JS/TS packet's
`apply.verify` also starts with `check-imports.mjs '{path}'`: an import that does not resolve, or a
default/named import the target does not export, fails the packet on the mechanical tier and the
worker retries with the list of files that do exist — so a guessed sibling path is fixed there, not
in a debug round at the deferred typecheck. Declare every import edge in **Depends on**: the batch
writes dependencies first, and an import of a file not yet written fails the check.

## Output ceilings

Instead of SKILL.md's values for codegen and premium packets ("TaskPacket initial output-ceiling budgets"):

- **Codegen and test packets:** `6000` (services, controllers, DTOs, React components, test files). A ceiling is a cap, not a spend — an unused ceiling costs nothing, while every doubling re-bills the whole attempt and returns a second full copy into your context. At `3000`, one feature-extend run doubled 4 of 14 codegen packets; at `6000` none of them would have.
- **Premium packets (design, senior_code_review, security_review):** `8000`. Design and review artifacts are the ones that historically hit the ceiling.

## Phase 5 — execute_packets

Instead of SKILL.md's direct-tier paragraph:

**Direct-tier work (subagent handles it, no MCP dispatch):** the orchestrator (Opus) writes the file directly — except a brownfield single-model run's packets, which go to packet workers (below). Estimate tokens via `chars/3.8` heuristic for both inputs and outputs; take pricing constants from this model's `effective_price.rates` in the `load_policy` result (the dated price list's card for the day, or the policy's block only under `pricing_override: true`: the price the server and the post-run collector bill at; see orchestrator rule 6); log a TelemetryEvent via `log_telemetry`.

Instead of SKILL.md's "Write the returned file content to disk at the packet's stated `artifact_path`.":

Write the returned file content to disk at the packet's stated `artifact_path` — **only for packets without `apply`**. Every brownfield codegen, tests, docs and debug packet that produces a file uses the apply form below instead.

**Wait inside your turn — never end it to wait.** When a subagent or a
long test run is in flight, block on it with a Bash until-loop on its output file
(`until [ -s <file> ]; do sleep 15; done`, `timeout: 600000`, repeated if it needs longer), or
delegate the subagent in the foreground. Do not end your turn and rely on a completion
notification to resume you: a resumed turn misses the prompt cache and re-writes the whole
context. The two reviewers (Phases 6 and 8) can run at the same time: delegate both in one message, as two
foreground Agent calls; Claude Code runs them together and returns when both are done.

**Batch the phase (brownfield, multi-model policies).** Do not dispatch the derived packets one call at
a time. When the run's mechanical tier is an Antigravity worker (`antigravity-worker`, chosen as the agent
door), the server refuses apply-form and batched packets: dispatch those packets one at a time without
`apply` instead. One `execute_batch` call carries every apply-form packet of the phase: pass
`packets_path: <output_dir>/packets.json` (plus `packet_ids` when only some should run — e.g. the
ones after a tooling step, or refinement packets you wrote to a second file) with the same
`policy_name`, `project_root`, `run_id`, `telemetry_path` and `cache_context` you would pass to
`execute_with_model`. **Do not `Read` packets.json and do not paste packets inline** — the server
reads the file, skips `tooling` packets (listed as `skipped_no_apply`), and returns a compact
receipt: full detail only for packets that did not apply and verify. Reading the file and typing it
back put ~15k tokens into every later turn. To check one packet, `jq` that one id. The server runs them in
parallel (`max_parallel`, default 4) in `depends_on` order, never two on one `artifact_path` at once,
and returns one receipt per packet plus totals — one turn for the phase instead of one per packet. Read the batch result:

| `items[].status` | What you do |
|---|---|
| `applied` | Nothing (STOP ON PASS) |
| `escalate` / `verify_failed` / `no_content` | As for a single packet (table below), one at a time, after the batch returns |
| `blocked` | Its dependency did not apply (`blocked_by`); resolve the dependency first, then re-dispatch the blocked packets in a second batch |
| `error` | The dispatch threw (`error` says why); re-dispatch after fixing the cause, or escalate |

`tooling` packets (no model) run as shell steps between batches where their `depends_on` puts them:
batch everything before the tooling step, run it, batch the rest. Then run every `verify_deferred`
command once. Under a single-model policy nothing is dispatched and this paragraph does not apply.

**Hand the phase to packet workers (brownfield, single-model policies).** Do not write the derived
packets in your own conversation: each file written here re-reads the whole run's context (measured:
119 turns and 20.6M cached tokens, two thirds of an opus-only run's cost). Group them instead:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/packet-groups.mjs" "<output_dir>/packets.json"
```

It prints `steps` in dependency order: `{kind: "worker", packet_ids}` groups of at most six packets,
and `{kind: "tooling", packet_id}` shell steps placed where a later packet needs them. Walk the steps
in order. For a worker step, delegate the `packet-worker` agent in the foreground with exactly:
`run_id`, `intent`, `packets_path`, `packet_ids`, `project_root`, `plugin_root` (the value of
`CLAUDE_PLUGIN_ROOT`), `telemetry_path`, `policy_name`, `model` and the model's
`effective_price.rates` from `load_policy`. Nothing else: no packet bodies, no plan text, no file
contents. The worker writes, formats, verifies, records provenance and telemetry, and returns one
receipt line per packet. Its receipt is the record — do not read its files back. A tooling step
runs as a shell step, as above.

Read each receipt: `applied` needs nothing; `verify_failed` or `blocked` go to the next worker step
as the first packets (or to one more worker after the last step) with the receipt's failure appended
to the packet's `instruction` in a second packets file; handle a packet in your own conversation only
after a worker failed it twice. Then run every `verify_deferred` command once and send a failure to
one packet-worker as a debug packet. Refinement packets from the reviewers go to a packet-worker the
same way: write them to `<output_dir>/refinement-packets.json` and pass that file as `packets_path`.

**Format before verify (single-model).** A packet's `apply.format` (the `--write` form of its
formatter) runs after the write and before `apply.verify` — the server already does this for a
dispatched packet; under a single-model policy the worker does it, and so do you for a
single-model packet you write yourself. A formatting-only miss is then never a retry. Record provenance `--after` once the format
has run, so the recorded hash is the file on disk.

**Apply form (brownfield, every file-producing mechanical packet).** The server writes the file, runs the verify commands, retries on the mechanical tier with the failure appended, and returns a receipt. Your side of the contract:

| Field | Value |
|---|---|
| `inputs[]` | Paths only — no `content`. Narrow with `section: "<heading>"` (a `change_plan.md` section such as `"A1"`) or `lines: [from, to]`. The server reads them; you never paste file text into a packet. **The standard set for a codegen / test packet is three:** the unit section (`change_plan.md` § `An — …`), the plan's `House style` section, and the unit's **Mirror** slice (`path` + `lines` from the section — the existing file whose shape the new one copies). Add the **Edit anchor** lines for an edit, and the section of each unit it **Depends on** (≤ 4; their path and Exports are what its imports must match — `plan-to-packets.mjs` adds them). Nothing else: the worker does not need the whole plan, the requirements, or the repo facts. |
| `instruction` | Names the section and says *implement*, not *reproduce*: "Implement `<artifact_path>` from change_plan section `An`: satisfy every Exports signature and Behavior rule; copy the shape of the Mirror input for imports, errors and structure; follow House style. Return JSON {path, content}." Do not restate the section's content in the instruction — the section is the input. |
| `outputSchema` | Omit it. The server supplies `{path, content}`. |
| `apply` | `{ "write": true, "mode": "content" | "edits", "format"?: [<commands>], "verify": [<commands>], "max_retries": 2 }`. `mode: "edits"` (edits to an existing file): the worker returns `{edits: [{line, anchor, position: "after" | "before" | "replace" | "delete", text, count?}]}` (`count` = lines a replace/delete removes from the anchor down, default 1) instead of the file and the server splices them in — an anchor that is not found, or matches more than one line without a `line`, is a retry with that reason; the file must exist. `plan-to-packets.mjs` picks the mode from the unit's Action. Verify commands come from `baseline.json` (the package's lint / typecheck / test commands), scoped to the file where the tool allows it: `{path}` is replaced by `artifact_path`. Typical: `["npx biome check {path}"]` for a source file, `["npx biome check {path}", "npx vitest run {path}"]` for a test file. Leave `verify` out only when no cheap check exists. |
| `run_id` (tool argument, beside `packet`) | The run id, so the server records provenance for the write under `.sdlc/runs/<run_id>/` and `/mmo:revert` still works. Do not run `write-provenance.mjs --before/--after` yourself for an applied packet. A packet that ends with any other status has its file recorded as it is on disk, so `/mmo:revert` sees no change where the packet left the file as it was. |

Read the receipt's `status`:

| `status` | What happened | What you do |
|---|---|---|
| `applied` | Written, verify passed (or no verify) | **STOP ON PASS.** Nothing. Do not `cat` the file, do not re-run the verify command, do not read the packet result back. Move to the next packet. `apply.path`, `apply.sha16`, `apply.lines` are the record. |
| `escalate` | Verify failed `escalate.retry_count` times on the mechanical tier and the policy routes the next attempt to `escalate.model_id` | Handle the retry exactly as an escalated packet today: under `estimated` in your own conversation with `provenance: "estimated"`, under `vendor` via `execute_with_model` with `retry_count: escalate.retry_count`. `escalate.failure` is the last verify output. In `content` mode the last attempt is on disk at `artifact_path`; in `edits` mode the file is back to its pre-packet state (every attempt splices into the original, and a failed one is undone), so the escalated packet redoes the edit. |
| `verify_failed` | `max_retries` spent and the policy never re-routed | Same as `escalate`: the failure is in `attempts[].failure`. |
| `refused` | `artifact_path` is outside the write contract | Planner bug. Fix the packet's `artifact_path` or the allowlist decision; never work around it. |
| `dispatch_failed` | The vendor call failed (network, no price, cap) | As today for a failed dispatch. |
| `no_content` | The model never returned a `content` string within `max_retries` | Rewrite the instruction to demand JSON `{path, content}`; re-dispatch. |
| `stopped` | The call was cancelled while it ran (the person pressed Stop) | Nothing was written after the stop. Do not re-dispatch: carry on only when the person asks. |

The receipt is small by design (≤ 2 kB; verify output tailed to 1,500 characters). One `execute_with_model` call per file is the whole cost of a mechanical packet in your context: the packet (paths + instruction, ~150 tokens) and the receipt (~80 tokens). On the run this contract comes from, the previous form put ≈ 62k tokens of file text through the orchestrator's context for 24 packets, against 8k when the same files were written inline.

`telemetry.jsonl` gets one event per attempt as before (`events_written` says how many); the events are not echoed in the receipt when `telemetry_path` is set.

## Phase 6 — senior_code_review

Invoke `brownfield-senior-reviewer` instead of `senior-reviewer`, for each module. Collect refinement packets. Re-dispatch them via Phase 5 mechanics.

In brownfield the delegation carries paths only — `change_plan.md` (or `requirements.md`) and
`provenance.json` — per the brownfield-orchestrator's rule 9; the reviewer reads diffs against
`git_head_before`, not whole files.

Also in brownfield, pass a one-line-per-suite summary of the tests, typecheck and verify results
you already have (counts and pass/fail, no logs), so the reviewer does not re-run them. The same
summary goes to the security reviewer in Phase 8. Both brownfield reviewers follow their "Lean
review" budget.

## Phase 7 — test_run

Instead of SKILL.md's "Any other failure" bullet:

- Any other failure → parse the output, build a `debug` TaskPacket with the failing test name + error + relevant source slice (as `inputs[]` paths with `lines`, not pasted text). Route via policy. In brownfield use the apply form with `verify` set to the failing test command scoped to the file, so the mechanical-tier retries and the check happen in the server; you see the receipt. Retry up to 2 cost-efficient tier attempts; escalate to Opus.

## Phase 8 — security_review

Invoke `brownfield-security-reviewer` instead of `security-reviewer`. Writes `<output_dir>/security_review.md`.

**Brownfield: pick `form: full` or `form: light` from the touched set, then delegate.** Read the
`files` list in `provenance.json` and match each path against the security surface below. Any
match → `full`. No match → `light`, and the reviewer runs only the secrets and dependency checks.
Log the phase with `--form=<full|light>` so the report shows which one ran.

| Surface | Path or content signal |
|---|---|
| Auth and authz | path contains `auth`, `guard`, `session`, `permission`, `role`, `middleware`, `policy` |
| Route registration | new or edited controller, router, `urls.py`, `routes/`, `index.ts` that registers handlers, `include_router` |
| Data layer | `migration`, `schema`, `prisma`, `models.py`, `entity`, `repository`, `db/` |
| Serialization of user data | `dto`, `serializer`, `interceptor`, `transform`, `mask` |
| Config and secrets | `.env*`, `config/`, `settings.py`, `package.json`, lockfiles, `Dockerfile`, CI workflow files |
| Audit | `audit`, `log` in a path under the API or server tree |

A pure presentation change — a React component, a stylesheet, an i18n file, a docs page, a test file for existing code — matches none of these. A run that adds an unauthenticated endpoint matches *Route registration* and gets the full checklist. When in doubt, `full`; the light form is for the case where there is nothing for the checklist to find.
