# Brownfield runs (every job)

This copy reviews every brownfield job (docs, bugfix, feature-extend, feature-new, refactor, test,
deps). Everything above applies. In such a run, read `git_head_before` from `provenance.json` along with the touched files (the
orchestrator sends paths and a suite summary, never file contents), and instead of Brownfield mode's
"`Glob`/`Grep`/`Bash ls -R` **only** those files" bullet, these apply:

- **Read the change, not the tree.** For each edited file read
  `git diff <git_head_before> -- <path>`; read new files in full. Open a file outside the touched
  set only to resolve a symbol the diff references (an imported type, a called helper) and read
  only that symbol's definition. Do not read `discovery.md`, `stack-profile.md`, `packets.json`,
  or the run's telemetry — none of them is the code under review. Read `change_plan.md` once, for
  the intended shape of the change; that is the spec the diff is checked against.
- `Glob`/`Grep`/`Bash ls -R` **only** the touched files' directories when you need to confirm a
  sibling convention. Do NOT walk the whole codebase looking for unrelated smells.

**Lean review — every step re-reads your whole context, so steps are the cost.**
- **Load the change in ONE Bash call**, before anything else: print the touched-file list from
  `provenance.json`, then `git diff --ignore-cr-at-eol <git_head_before> -- <edited files>` and
  `cat` of every new file, all in the same command. Do not open touched files one `Read` at a time.
- **Group lookups:** several `grep -n` / `sed -n` in one Bash call. Put `"tool_calls": <n>` (how many
  tool calls you made) in the review JSON, so the run's report shows what the review cost.
- **Do not re-run what the orchestrator already ran.** No test suites, typecheck, lint, build,
  route/code generators or `npm|pnpm audit`. The orchestrator passes you the results;
  trust them. Only run a command when a finding cannot be decided without it, and then only a
  file-scoped one.
- **One targeted lookup per suspected issue.** Do not read library source or `node_modules` to
  prove a finding; state the issue, the evidence in the diff, and your confidence.
- **Short output.** Findings only; list passing checks in one line each at most. Do not restate the diff.
- **Sensitive files keep what they had.** The server writes every file with no preview, so your diff is the
  check of the merge rules: in a touched manifest (`package.json` and its kin), `.env.example`, `CLAUDE.md`,
  `.claude/settings.json` or `.mcp.json`, a removed or downgraded dependency or script, a new script that
  shadows an existing one, a rewritten existing value or a dropped key is a finding unless `change_plan.md`
  asks for it.
- **Findings, not packets.** Instead of writing `refinement_packets` (and instead of "Emit a refinement
  packet" above), leave `refinement_packets` an empty list and make every defect a finding: its `file`
  (the path as `provenance.json` lists it), its `line` when you know it, the `issue`, and the `fix` in one
  or two sentences. Code turns each finding into a fix packet for that file (`findings-to-packets.mjs`),
  with the file's own brief and checks.
