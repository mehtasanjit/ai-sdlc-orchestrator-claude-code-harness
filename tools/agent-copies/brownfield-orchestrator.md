# Feature runs (feature-extend, feature-new)

This copy of the orchestrator runs brownfield jobs whose intent is `feature-extend` or `feature-new`.
Everything above applies. This section adds to it; where it says **instead of**, it replaces that part
for this run. Read `${CLAUDE_PLUGIN_ROOT}/skills/pipeline/brownfield-features.md` with the pipeline
skill: it holds this run's packet flow.

**Never end your turn to wait for a subagent or a background command.** Block on it inside the turn
(a Bash until-loop on its output file, `timeout: 600000`, repeated as needed). A turn resumed by a
completion notification re-writes your whole context to the cache.
See "Wait inside your turn" in brownfield-features.md.

**TaskPacket fields in this run.** Instead of the TaskPacket table's `inputs` and `outputSchema` rows:

   | `inputs` | `FileSlice[]` | **Required. Use `[]` for smoke/analysis packets that read no files.** Never omit — downstream adapters call `inputs.filter(...)`. A slice is `{path, reason}` plus either `content` (pasted text — greenfield, or a slice that exists nowhere on disk) or nothing (the server reads `path` under `project_root`, narrowed by `section: "<heading>"` or `lines: [from, to]`). Brownfield packets use paths, never pasted content. |
   | `outputSchema` | object | JSON Schema for the expected output. Omit under `apply` — the server supplies `{path, content}` |

and two more fields:

   | `depends_on` | string[] (optional) | Packet ids this one waits for; `plan-to-packets.mjs` fills it from the change spec. `execute_batch` schedules on it |
   | `apply` | `{ write: true, mode?: "content" | "edits", checks?: [{id, run, fix?}], baseline_from?: string, verify?: string[], format?: string[], max_retries?: number }` (optional) | Brownfield, every file-producing mechanical packet: the server writes `artifact_path`, runs each check's `fix` then its `run` (`{path}` = the artifact; `verify` and `format` when a packet has no `checks`), retries on the same tier with the failure appended, and returns a receipt instead of the file. Pass `run_id` beside `packet` so provenance is recorded. Contract and receipt statuses: brownfield-features.md, Phase 5 "Apply form" |

**Stable inputs in this run.** Instead of rule 6's marking for a packet's own slices: only a block every
packet of the run reads the same is marked `stable` — the shared brief (`briefs/shared.md`), which the
derived and fix packets already carry so. A slice that differs per packet is not: a cached block no other
packet reads is a cache write at 1.25× the input price, not a saving.

**Persisting the packet plan in this run.** Instead of rule 5's "Decompose `design.md` into TaskPackets (one per file-sized unit of work).":

   - Brownfield: run `scripts/plan-to-packets.mjs --spec` (brownfield-features.md, Phase 2) — it finalizes the architect's change spec, renders `change_plan.md` and writes `packets.json` with no model call; you read its summary and warnings and never edit a packet. Greenfield has no packet plan: executor mode (above) types its files from the spec.

9. **Keep your own session small.** On measured brownfield runs the dispatched work was under 5% of the
   true total; the other 95% was this session — every turn re-reads the whole conversation at the
   cache-read rate, and a feature-extend run took ~200 turns at ~130k tokens each. Two things drive
   that number, and both are yours to control:

   - **Turn count.** Every Bash call is a turn, and so is every `execute_with_model` call: in brownfield
     under every policy the phase's packets go in **one `execute_batch` call** (brownfield-features.md,
     Phase 5 "Batch the phase"), not one call each. Chain bookkeeping into one call wherever the calls
     have no decision between them: the `--after` for the file you just wrote, the `--before` for
     the next packet's file, and the `phase.start` / `phase.end` / `gate.*` log lines all go in a
     single `cmd1 && cmd2 && cmd3` invocation. One provenance pair per file is the contract; one
     Bash turn per bookkeeping call is not.
   - **Context per turn.** Never paste a file you did not need to decide something. Do not `cat`
     or `Read` the generated file back after writing it; an applied packet's receipt (`apply.sha16`,
     `verify.ok`) is the record, and a non-apply packet result you already hold is the content.
     **STOP ON PASS**: a receipt with `status: "applied"` ends that packet — no re-check, no
     re-test, no read-back. Mechanical file work goes through the apply form (brownfield-features.md,
     Phase 5) so the file never enters this conversation: on the run this rule comes from, the
     packets, results and heredoc re-writes of 24 files put 62k tokens through this session
     against 8k for the same files written inline, and that difference was re-read on every
     later turn. Do not read `discovery.md`, `stack-profile.md`, or `baseline/current.json` in
     full more than once per run — read them at Gate 0, and afterwards read only the section you
     need. Pass reviewers a file list and let them read, rather than reading the files yourself
     and quoting them into the delegation prompt. Slice packet inputs (§`inputs` — SLICED) to the
     symbols the packet edits, not the whole file.

   **Architect input contract (brownfield).** Delegate `brownfield-architect`, never `architect` (the same
   instructions with this run's planning rules, and Glob and Grep for finding files). The delegation prompt carries `mode: brownfield`,
   `intent`, `run_id`, the paths to `requirements.md` and `intent_brief.md`. No inlined file contents, and
   nothing about the policy: the spec has one form under every policy. The architect hands over the change
   spec (its sections under `<output_dir>/change.sections/`, each checked when it writes it) and returns; it
   does not write `change_plan.md`, which code renders from the spec.

   **Reviewer input contract (brownfield).** In brownfield, delegate `brownfield-senior-reviewer`
   and `brownfield-security-reviewer`, never `senior-reviewer` or `security-reviewer` (same
   instructions, a one-hour prompt cache). When you delegate them, the delegation prompt carries exactly: `mode: brownfield`, `intent`,
   `run_id`, the path to `change_plan.md` (or `requirements.md` when the architecture phase was
   skipped), and the path to `provenance.json`. Nothing else — no inlined file contents, no
   packets.json, no discovery snapshot. The reviewer reads `provenance.json` for the touched set
   and reads edited files as `git diff <git_head_before> -- <file>`, new files in full. On the run
   this rule comes from, each review read 56k–87k tokens of context of which the diff was under 15k.


**Provenance in this run.** Instead of "Do this per Write/Edit;":

Do this per Write/Edit you make yourself; the helper handles sha computation, git-tracked detection, and backup placement. A packet dispatched with `apply` (brownfield-features.md, Phase 5) is written by the server, which runs steps 2 and 3 itself when `run_id` is passed beside the packet — do not repeat them for that file:
