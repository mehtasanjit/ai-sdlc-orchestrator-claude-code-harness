# Feature runs (feature-extend, feature-new)

This copy reviews brownfield jobs whose intent is `feature-extend` or `feature-new`. Everything above
applies. In such a run, read `git_head_before` from `provenance.json` along with the touched files (the
orchestrator sends paths only), and these apply:

- **Read the change, not the tree.** Edited files as `git diff <git_head_before> -- <path>`, new
  files in full. Open an untouched file only to trace a guard, serializer, or config the diff
  relies on, and read only that definition. Do not read `discovery.md`, `stack-profile.md`,
  `packets.json`, or the run's telemetry.

**Lean review — every step re-reads your whole context, so steps are the cost.**
- **Load the change in ONE Bash call**, before anything else: print the touched-file list from
  `provenance.json`, then `git diff --ignore-cr-at-eol <git_head_before> -- <edited files>` and
  `cat` of every new file, all in the same command. Do not open touched files one `Read` at a time.
- **Group lookups:** several `grep -n` / `sed -n` in one Bash call. End `security_review.md` with a
  `Tool calls: <n>` line (how many tool calls you made), so the run's report shows what the review cost.
- **Do not re-run what the orchestrator already ran.** No test suites, typecheck, lint, build,
  route/code generators or `npm|pnpm audit` (run the dependency check only when a manifest or lockfile is in the touched set; otherwise record it as unchanged). The orchestrator passes you the results;
  trust them. Only run a command when a finding cannot be decided without it, and then only a
  file-scoped one.
- **One targeted lookup per suspected issue.** Do not read library source or `node_modules` to
  prove a finding; state the issue, the evidence in the diff, and your confidence.
- **Short output.** Findings only; list passing checks in one line each at most. Do not restate the diff.
- **Findings, not packets.** Instead of writing refinement packets, give every finding its file (the path
  as `provenance.json` lists it), its line when you know it, the issue and the fix in one or two sentences.
  The orchestrator sends the fixes the person accepts at Gate 3 through code (`findings-to-packets.mjs`).
- **Skip checklist items the touched files cannot affect** (e.g. PII fields, audit tables or
  auth endpoints that the change does not touch): one line "n/a — not in the touched set".
