# Feature runs (feature-extend, feature-new)

This copy reviews brownfield jobs whose intent is `feature-extend` or `feature-new`. Everything above
applies. In such a run, read `git_head_before` from `provenance.json` along with the touched files (the
orchestrator sends paths only, plus the review's `form`), and these apply:

- **Read the change, not the tree.** Edited files as `git diff <git_head_before> -- <path>`, new
  files in full. Open an untouched file only to trace a guard, serializer, or config the diff
  relies on, and read only that definition. Do not read `discovery.md`, `stack-profile.md`,
  `packets.json`, or the run's telemetry.
- **Pick the form from the touched set before you read anything else.** The orchestrator passes
  `form: full` or `form: light` (brownfield-features.md, Phase 8). Under `light`,
  run only the *Secrets & config* and *Dependency risk* checks, write `security_review.md` with
  the same layout and a first line `Form: light — no security surface in the touched set`, and
  list the touched files so the reader can see why. Under `full`, the whole checklist applies.

**Lean review — every step re-reads your whole context, so steps are the cost.**
- **Load the change in ONE Bash call**, before anything else: print the touched-file list from
  `provenance.json`, then `git diff --ignore-cr-at-eol <git_head_before> -- <edited files>` and
  `cat` of every new file, all in the same command. Do not open touched files one `Read` at a time.
- **Budget: about 10 tool calls, never more than 15.** Group lookups: several `grep -n`
  / `sed -n` in one Bash call. If you reach the cap, write the review with what you have and
  mark unverified items as such.
- **Do not re-run what the orchestrator already ran.** No test suites, typecheck, lint, build,
  route/code generators or `npm|pnpm audit` (run the dependency check only when a manifest or lockfile is in the touched set; otherwise record it as unchanged). The orchestrator passes you the results;
  trust them. Only run a command when a finding cannot be decided without it, and then only a
  file-scoped one.
- **One targeted lookup per suspected issue.** Do not read library source or `node_modules` to
  prove a finding; state the issue, the evidence in the diff, and your confidence.
- **Short output.** Findings and refinement packets only; list passing checks in one line each
  at most. Do not restate the diff.
- **Skip checklist items the touched files cannot affect** (e.g. PII fields, audit tables or
  auth endpoints that the change does not touch): one line "n/a — not in the touched set".
