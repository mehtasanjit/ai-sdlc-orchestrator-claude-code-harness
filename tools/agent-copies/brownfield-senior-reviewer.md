# Feature runs (feature-extend, feature-new)

This copy reviews brownfield jobs whose intent is `feature-extend` or `feature-new`. Everything above
applies. In such a run, read `git_head_before` from `provenance.json` along with the touched files (the
orchestrator sends paths only), and instead of Brownfield mode's
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
- **Budget: about 12 tool calls, never more than 20.** Group lookups: several `grep -n`
  / `sed -n` in one Bash call. If you reach the cap, write the review with what you have and
  mark unverified items as such.
- **Do not re-run what the orchestrator already ran.** No test suites, typecheck, lint, build,
  route/code generators or `npm|pnpm audit`. The orchestrator passes you the results;
  trust them. Only run a command when a finding cannot be decided without it, and then only a
  file-scoped one.
- **One targeted lookup per suspected issue.** Do not read library source or `node_modules` to
  prove a finding; state the issue, the evidence in the diff, and your confidence.
- **Short output.** Findings and refinement packets only; list passing checks in one line each
  at most. Do not restate the diff.
