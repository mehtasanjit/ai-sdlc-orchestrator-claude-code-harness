# Brownfield runs (every job)

This copy of the orchestrator runs every brownfield job (docs, bugfix, feature-extend, feature-new,
refactor, test, deps). Everything above applies. This section adds to it; where it says **instead of**,
it replaces that part for this run. Read `${CLAUDE_PLUGIN_ROOT}/skills/pipeline/brownfield-runs.md` first:
it holds this run's packet flow and names the sections of the pipeline skill this run follows; read only those.
Instead of "See `${CLAUDE_PLUGIN_ROOT}/skills/pipeline/SKILL.md` for canonical examples per phase" and "See
`${CLAUDE_PLUGIN_ROOT}/skills/pipeline/SKILL.md` for the full state machine, TaskPacket examples, and HITL prompt
templates": the SKILL.md sections brownfield-runs.md names, and nothing else (this section gives the packet
fields this run uses).

**Every job runs every phase.** Instead of "Intent routing — brownfield only" skipping Phase 2: every job
delegates the architect for its change spec, and Phase 4's packets are derived from it. No phase is skipped,
so no `phase.skip` is logged (instead of Run logging's "gets `phase.skip` instead of the pair above"). Which
jobs open Gate 2, and the rules a job adds to its spec, are in brownfield-runs.md, "The jobs". The Intent
matrix's Phase 1 and 7 columns still apply; its Phase 8 column does not (brownfield-runs.md, Phase 8).

**The server types every project file, under every policy and auth mode.** Instead of "Under an all-Opus
policy (`opus-only`) every phase runs directly", rule 0's "under `estimated` only the mechanical tier" and
rule 6's "This applies to escalations too": in this run every derived and fix packet goes to the server in
`execute_batch`, a packet the policy routes to your own model included, which the server's lean Opus typist
types (under `estimated`, on this computer's own Claude login). You never type a project file or handle an
escalated packet in this conversation; what you write yourself is the run's own record. Instead of rule 7's
"Construct a refined TaskPacket from scratch with the failure mode encoded in the instruction.": a file that
fails goes to a fix round by code (brownfield-runs.md, Phase 5, the receipt's `status`). A pre-flight warning
that your own model is not dispatched under `estimated` is about its API adapter, which this run does not
use; the typist probe tests the typist.

**Pre-flight in this run.** Instead of rule 0's "`executor: false` on a brownfield run": pass `executor: true`.
This run's packets are typed by greenfield's typists, the lean Opus typist through this machine's `claude` CLI
included, so pre-flight checks that CLI before anything is spent (an old or missing one halts here, with what
to update) and reports how the typists read the policy (`policy_notes`).

**Tests in this run.** Instead of rule 8's "run `npm install && npm test` via Bash from `<code_dir>`", its
env-fixture copy and its debug packet: the test command is `baseline.test_command` from Gate 0, run from the
repository root, `.env.test` is never copied to `.env` (the pipeline skill's Phase 7, brownfield mode), and a
failure goes to a fix round by code (brownfield-runs.md, Phase 7).

**Never end your turn to wait for a subagent or a background command.** Block on it inside the turn
(a Bash until-loop on its output file, `timeout: 600000`, repeated as needed). A turn resumed by a
completion notification re-writes your whole context to the cache.
See "Wait inside your turn" in brownfield-runs.md.

**TaskPacket fields in this run.** Code writes every packet of this run; these are the fields it fills.
Instead of rule 4's smoke-test example ("used at pre-check dispatch step"): this run sends no smoke packet,
since the start check's typist probe tests every model that types the run. Instead of the TaskPacket table's
`inputs` and `outputSchema` rows:

   | `inputs` | `FileSlice[]` | **Required. Use `[]` for smoke/analysis packets that read no files.** Never omit — downstream adapters call `inputs.filter(...)`. A slice is `{path, reason}` plus either `content` (pasted text — greenfield, or a slice that exists nowhere on disk) or nothing (the server reads `path` under `project_root`, narrowed by `section: "<heading>"` or `lines: [from, to]`). Brownfield packets use paths, never pasted content. |
   | `outputSchema` | object | JSON Schema for the expected output. Omitted under `apply` — the server supplies `{path, content}` |

and three more fields:

   | `intent` | string | The run's job, as Gate 0 recorded it. The server types a packet with greenfield's typists only when it names a brownfield job and pre-flight recorded the run; code sets it on every derived and fix packet |
   | `depends_on` | string[] (optional) | Packet ids this one waits for; `plan-to-packets.mjs` fills it from the change spec. `execute_batch` schedules on it |
   | `apply` | `{ write: true, mode?: "content" or "edits", checks?: [{id, run, fix?, expect?: "fail"}], baseline_from?: string, baseline?: false, verify?: string[], format?: string[], max_retries?: number }` (optional) | Brownfield, every file-producing mechanical packet: the server writes `artifact_path`, runs each check's `fix` then its `run` (`{path}` = the artifact; `verify` and `format` when a packet has no `checks`), retries on the same tier with the failure appended, and returns a receipt instead of the file. A check typed `expect: "fail"` is a bugfix's red check; a fix round's packet carries `baseline: false`. Pass `run_id` beside `packet` so provenance is recorded. Contract and receipt statuses: brownfield-runs.md, Phase 5 "Apply form" |

**Persisting the packet plan in this run.** Instead of rule 5's "Decompose `design.md` into TaskPackets (one per file-sized unit of work)." and "Write the full list to `<output_dir>/packets.json` as a JSON array of TaskPacket objects.":

   - Brownfield: run `scripts/plan-to-packets.mjs --spec` (brownfield-runs.md, Phase 2) — it finalizes the architect's change spec, renders `change_plan.md` and writes `packets.json` with no model call; you read its summary and warnings and never edit a packet. Greenfield has no packet plan: executor mode (above) types its files from the spec.

**Existing files in this run.** Instead of the Write gate's "Diff-preview mini-gate" and its "with a diff shown
to the user at a mini-gate before the write": no diff is shown before a packet's write, since the server writes
each file inside `execute_batch`. What protects a file that existed before the run: its sites are in
`change_plan.md` (shown at Gate 2 for the jobs that open it, and read by both reviewers in every job); an
edit lands as exact search/replace edits on the file as it was, and a search found zero or several times is a
retry; the file's checks judge it; provenance keeps its pre-run state for `/mmo:revert`; and both reviewers
read its diff. The merge rules above (add, never remove or downgrade; never rewrite an existing value) still
bind what the change does: the architect plans the sites by them and the senior reviewer checks the diff
against them; the server does not check them.

9. **Keep your own session small.** Most of a run's cost is this session: every turn re-reads the whole
   conversation at the cache-read rate. Two things drive that number, and both are yours to control:

   - **Turn count.** Every Bash call is a turn, and so is every `execute_with_model` call: in brownfield
     under every policy the phase's packets go in **one `execute_batch` call** (brownfield-runs.md,
     Phase 5 "Batch the phase"), not one call each. Chain bookkeeping into one call wherever the calls
     have no decision between them: the `phase.start` / `phase.end` / `gate.*` log lines go in a single
     `cmd1 && cmd2 && cmd3` invocation. A tooling step and its provenance calls are one Bash call too, joined
     with `;` and never `&&`: `<the --before calls>; <step>; rc=$?; <the --after calls>; echo "step exit: $rc"`,
     so the `--after` calls run whether the step succeeded or not (brownfield-runs.md, Phase 5). One provenance
     pair per file is the contract; one Bash turn per bookkeeping call is not.
   - **Context per turn.** Never paste a file you did not need to decide something. Do not `cat`
     or `Read` a typed file back; an applied packet's receipt (`apply.sha16`, `verify.ok`) is the record.
     **STOP ON PASS**: a receipt with `status: "applied"` ends that packet — no re-check, no
     re-test, no read-back. Mechanical file work goes through the apply form (brownfield-runs.md,
     Phase 5) so the file never enters this conversation, where every later turn would re-read it. Read
     `discovery.md` and `baseline/current.json` in full at most once per run, and afterwards only the section
     you need; the stack profile is the architect's to read, since you plan nothing. Pass reviewers a file
     list and let them read, rather than reading the files yourself and quoting them into the delegation
     prompt.

   **Architect input contract (brownfield).** Delegate `brownfield-architect`, never `architect` (the same
   instructions with this run's planning rules, and Glob and Grep for finding files). The delegation prompt carries `mode: brownfield`,
   `intent`, `run_id`, the paths to `requirements.md` and `intent_brief.md`. No inlined file contents, and
   nothing about the policy: the spec has one form under every policy. The architect hands over the change
   spec (its sections under `<output_dir>/change.sections/`, each checked when it writes it) and returns; it
   does not write `change_plan.md`, which code renders from the spec.

   **Reviewer input contract (brownfield).** In brownfield, delegate `brownfield-senior-reviewer`
   and `brownfield-security-reviewer`, never `senior-reviewer` or `security-reviewer` (the same
   instructions with this run's review rules). When you delegate them, the delegation prompt carries exactly:
   `mode: brownfield`, `intent`, `run_id`, the path to `change_plan.md`, the path to `provenance.json`, the
   path the reviewer writes (`<output_dir>/review.json` for the senior reviewer, `<output_dir>/security_review.md`
   for the security reviewer), and a one-line-per-suite summary of the test, typecheck and check results you
   already have (counts and pass/fail, no logs). Nothing else — no inlined file contents, no packets.json, no
   discovery snapshot. The reviewer reads `provenance.json` for the touched set and reads edited files as
   `git diff <git_head_before> -- <file>`, new files in full.

**Provenance in this run.** Instead of "Do this per Write/Edit;": do this per Write/Edit you make yourself, and
around every tooling step (brownfield-runs.md, Phase 5: `--before` for each file the step writes, then the
step, then `--after` for each whether the step succeeded or not); the helper handles sha computation,
git-tracked detection, and backup placement. A packet dispatched with `apply` (brownfield-runs.md, Phase 5) is
written by the server, which runs steps 2 and 3 itself when `run_id` is passed beside the packet — do not repeat
them for that file.

**Helpers' cost in this run.** Log no estimate for a helper's phase (`architecture_design`, `senior_code_review`,
`security_review`, which the architect and the reviewers run): the post-run collector prices each helper from its
own transcript, under its phase in the manifest's `phase_breakdown`.
