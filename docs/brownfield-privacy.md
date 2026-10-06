# Brownfield mode — data, privacy, compliance

> **For:** compliance officers and regulated environments (SOC2, HIPAA, PCI). What leaves the machine per phase; on-prem routing; audit trail. **Also see:** [brownfield.md](brownfield.md) · [brownfield-write-contract.md](brownfield-write-contract.md) · [methodology.md](methodology.md).

## What data leaves the machine

Two kinds of model see your code in a brownfield run, by two routes:

- **Claude, through Claude Code.** The run's orchestrator and its helpers (discovery, the architect, the two
  reviewers) are Claude Code subagents on the session's Claude model. A file one of them opens with `Read`, `Grep`
  or `Bash` reaches Claude, as any file a Claude Code session reads does. Claude Code's own permission rules govern
  those tools; the plugin adds instructions to its agents, not a guard on what they read.
- **The typists, through the plugin's model server.** Each file of the change is typed by the model the policy
  routes it to (Gemini Flash, one call per attempt or through the Antigravity agent, or Claude through the lean
  `claude -p` typist), from a packet the server builds by reading files from disk under the project root.

| Phase | What reaches a model | Notes |
|---|---|---|
| Discovery | What the discovery agent reads, to Claude | It lists env files' key names; opening an env file sends its whole text, values included, and the agent records names only |
| Requirements, change spec, senior review, security review | The intent brief, the earlier phases' artifacts, and the files and diffs each Claude subagent opens, to Claude | The reviewers read the change as a diff against the run's starting commit |
| Run start (`preflight_dispatch`) | One fixed one-line test call per typist the run types with | No project content |
| Typed files (codegen, tests, docs) | The run's shared brief (conventions, decisions, and every file of the change with its import line and exports), the file's own brief, its style file and the files it uses (whole, or the lines the spec names), and for an edit the file being edited, whole, in consecutive parts when it is larger than the server's bound on one input (200,000 bytes) | To the model the policy routes the file to |
| Fix rounds and retries | The same, plus the failure: a review finding, or the failing check's output (its last 2 kB) | A retry carries the previous attempt's failure |
| Checks and tests | Nothing: they run on your machine ("Commands the run executes on your machine", below) | Their output reaches a model only as a failure above |

**What the server never reads into a model's prompt.** One read rule covers everything the server sends: a project
file is never read into a model's prompt when it matches the always-off-limits list (`.env`, `.env.*`, `.mcp.json`,
`.cursor/rules/**`, `.claude/settings.local.json`, `.git/**`, at any depth) or the run's `off_limits` from Gate 0.
Matching ignores letter case, as macOS disks do, and a path that goes through a link is judged by the file it reaches
as well. Only the run's own folder, `.sdlc/runs/<run-id>/`, where its briefs live, is exempt. The rule is applied
three times: `plan-lint.mjs` refuses a unit whose `style_from` or `uses` path is off-limits as the architect hands
each section of the change spec over; `findings-to-packets.mjs` leaves an off-limits file out of what a fix shows beside it
(naming it under not routed), and does not route a fix aimed at one; and the server's `hydrateInputs` refuses one as it reads each input, the
last line, which a hand-written packet passes too. So a folder of regulated data put in `off_limits` at Gate 0 is
never sent to a typist.

What this rule does not cover, said exactly:

- **The Claude subagents' own reads.** A helper that opens a file with `Read` sends it to Claude; the write
  contract governs writes only. Keep files Claude may not see out of the repository, or deny `Read` on them in
  Claude Code's own permission settings.
- **Secrets inside files that are not off-limits.** A key pasted into a source file goes wherever that file goes.
  `plugin/scripts/dispatch-sanitize.mjs` holds a registry of narrow secret patterns (known vendor prefixes, PEM key
  blocks, JWTs, explicit `AWS_SECRET_ACCESS_KEY=` and sensitive env-var assignments; see the script for the list),
  but no dispatch path runs it today: the registry is used to redact the plugin's own log lines
  ([logging.md](logging.md)), and as a command-line scanner you can run on a file (`node
  plugin/scripts/dispatch-sanitize.mjs <file>`, exit 1 on a finding). It deliberately does no broad
  "high-entropy string" matching, which would flag legitimate hashes and IDs.
- **Files under `.gitignore`.** Ignored files are not off-limits by being ignored; put the ones that matter in
  `off_limits` at Gate 0.

## Commands the run executes on your machine

A brownfield run runs your repository's own commands, by these routes:

| Command | Who runs it | Under Claude Code's Bash rules? |
|---|---|---|
| Each file's checks from the change spec (its `run`), their write forms (`fix`, a formatter's `--write`), the run of each check on the file before the change, and a bugfix's red checks (the reproducing test, which must fail on the bug) | The plugin's model server, in the project folder | No |
| The same file checks, on each file as it is before the change, when the architect hands over a section of the change spec | `plan-lint.mjs`, which the architect starts with `Bash` | The `node plan-lint.mjs` call is, and plan-lint matches each check it would start against your deny rules first: a command they deny is not run, and the section is refused with the rule named. A command it cannot read is not run here; the server judges it before any packet runs |
| The end-of-run project checks (`verify_deferred`: the project checks the spec names, which the architect is told to make the typecheck and the full suite, and in a bugfix the reproducing test once more), the test run, and `tooling` units (a deps run's install) | The orchestrator, with its `Bash` tool | Yes |

The server and `plan-lint.mjs` run a command with a shell, in its own process group, and stop the whole group at its
time limit, so a runner's own children do not outlive it. `plan-lint.mjs` stops each at its own `timeout_s`. The
server runs every command of a file (its checks, their write forms, their run on the file before the change, and the
red checks) under one limit, the largest `timeout_s` the spec gives that file's checks, which the file's packet
carries; a fix round's packet keeps its unit's. A command gets their environment minus the vendor credentials they
hold (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS` and the
other `*_API_KEY` variables the plugin reads), so a check's output cannot carry them into the next attempt's prompt.

Claude Code's sandbox never applies to the server's commands, and Claude Code's own permission check for its `Bash`
tool never sees them. So the server holds them to your Bash deny rules itself: it reads the deny rules of the settings
Claude Code reads for the project (managed settings, `~/.claude/settings.json`, the project's `.claude/settings.json`
and `.claude/settings.local.json`) and refuses a packet whose check, write form or red check one of them forbids,
before any model call; a different check is your decision. An "ask" rule is not asked by this check. With the separate
zero-touch plugin installed, a workflow running in a zero-touch chat also has each server call checked before it is
made ([ambient-mode.md](ambient-mode.md), `pre-dispatch`). Every one of these commands is one the architect typed into the
change spec: when Gate 2 opens (feature-extend, feature-new, refactor and deps, and a bugfix that code finds
design-affecting) the rendered plan you approve lists them under "Checks"; for docs and test runs, and any other
bugfix, no gate shows them before they run.

## Never sent, ever

- **Prompt content** — telemetry records model + phase + token counts + cost + timing. Not
  the prompt itself.
- **Response content** — same. Telemetry never captures what a model returned.
- **File paths beyond `artifact_path`** — telemetry records the path the packet wrote to;
  it doesn't record every file the model saw as input.

The support bundle (a v1.5 feature) further redacts: env-key names only (no values), no file
contents, only allowlist/off-limits paths (not their contents).

## On-prem / private-cloud routing

The plugin's routing is policy-driven. You can point it at private endpoints instead of
public model providers:

- **AWS Bedrock** — configure a Bedrock-specific policy YAML (`bedrock-claude-only.yaml`
  ships in v1.5) mapping the plugin's tier names to Bedrock model IDs.
- **Gemini Enterprise Agent Platform, formerly Vertex AI (Google Cloud)** — same, via a
  `vertex-*.yaml` policy pointing at your GCP project's endpoint.
- **Self-hosted models** — any provider the plugin's adapters know about. Adding a new
  adapter is a plugin-level extension.

Drop your policy YAML at `.sdlc/policy.yaml` (project scope) or at repo root as
`routing-policy.yaml`. The policy loader picks it up automatically; Gate 0 surfaces which
policy is active before the run starts.

**No fallback to public models.** Once your policy names a private endpoint, the plugin
refuses to fall back to a public one when that endpoint is unavailable. The `preflight_dispatch`
check runs before any phase; if a private endpoint isn't reachable, the run halts cleanly rather
than silently using a public alternative.

## PII in source

The plugin does **not** try to detect PII in your source code (out of scope; false-positive
risk too high, and there's no widely-agreed definition of "PII in code"). If your codebase
contains PII in comments, fixtures, or test data, that content may reach a model when a
packet includes it as input.

If you're in a regulated environment (SOC2, GDPR, HIPAA, PCI, etc.):

- **Prefer on-prem routing.** See above — configure a policy pointing at your regulated-
  cloud endpoint (BAA-covered Bedrock, PHI-eligible Vertex, etc.).
- **Off-limits your regulated data folders.** At Gate 0, move any directory containing PII
  into the run's `off_limits` list. The write contract refuses writes there, and the server
  never reads a file from there into a typist's prompt. Discovery runs before Gate 0, and the
  Claude subagents' own reads are not guarded ("What data leaves the machine", above): a
  folder Claude may not see belongs outside the repository, or under a `Read` deny rule in
  Claude Code's settings. (Gate 0's proposal already off-limits `.env*`, `.cursor/`, etc. —
  add your PII folders manually.)
- **The plugin surfaces a Gate 0 warning** if it detects a `SECURITY.md`, `PRIVACY.md`, or a
  path segment like `SOC2/`, `HIPAA/`, `PCI/`, or `regulated/`:
  > *"This repo appears regulated. Confirm the active policy uses only compliant endpoints,
  > and that off-limits protects your regulated data folders."*

## Audit trail

Every run produces:

- **`provenance.json`** — per-file record: `path`, `sha_before`, `sha_after`, `model`,
  `phase`, `tokens_in`, `tokens_out`, `cost_usd`, `git_sha_at_write`, `plugin_version`,
  `packet_id`, `written_at`.
- **`telemetry.jsonl`** — one line per model call: `ts`, `model`, `phase`, `task_id`,
  `tokens_*`, `cost_usd`, `latency_ms`, `success`.
- **`ledger.json` / `ledger.md`** — one row per run: timestamp, intent, branch, HEAD before /
  after, packet count, files touched, gates passed, outcome, spend, plugin version.
- **Gate answers** logged with each run.

These are what a compliance officer asks for: "what data went where, when, at whose
direction." `/mmo:audit` (v1.5) exports these into a single `.sdlc/audit-export.md` +
`.json` suitable for ingestion into your compliance tooling.

## Data locality guarantees

- All plugin state is local — under your repo (`.sdlc/`) or your home directory
  (`~/.claude/projects/`). No plugin-owned cloud storage.
- Model calls go to whatever endpoint the active policy names.
- **No call-home. No usage tracking. No analytics. Ever.**

The plugin has no license-server ping, no anonymous telemetry, no crash reporting. If
you disconnect from the network, it fails at the first model dispatch and does nothing else.

## Model input by job

Every job runs the same flow, so jobs differ in what reaches a model only through the files the
change spec names:

- **The Claude subagents** (requirements, the architect, the two reviewers) read the intent brief
  and whatever files they open to plan or review the change. A wide job (a refactor's call sites, a
  docs run over a module) opens more of the repository than a narrow one (a bugfix's failing path).
- **Each typist** is sent only its own file's packet: the shared brief, the file's brief, its style
  file and the files the spec says it uses, and the file itself when it is edited ("What data leaves
  the machine", above). A typist never sees the whole repository, the requirements or the plan.

If your compliance policy bounds which jobs may run against which repos, bracket accordingly,
and use `off_limits` at Gate 0 for what no typist may be sent.
