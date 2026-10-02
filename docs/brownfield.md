# Brownfield mode — overview

> **For:** running the plugin on an existing repo — Gate 0, the seven job types, the write contract. **Also see:** [brownfield-write-contract.md](brownfield-write-contract.md) · [brownfield-routing.md](brownfield-routing.md) · [brownfield-setup-issues.md](brownfield-setup-issues.md).

The AI-SDLC Orchestrator plugin ships in two modes:

- **Greenfield** (`/mmo:greenfield`) — generates a whole new application from a project brief into an
  empty folder. This is what the plugin was originally built for.
- **Brownfield** (`/mmo:brownfield`) — extends an existing repository. Pick one of seven job
  types (docs, bugfix, feature-extend, feature-new, refactor, test, deps), confirm scope at
  one Gate 0 confirmation screen, run the pipeline with a non-destructive write contract that
  guarantees off-limits files stay untouched.

Both modes share the same install (SETUP.md), same policies (e.g. `opus-only` / `opus-plus-flash`),
same MCP dispatch layer. What differs is what happens after the setup check completes.

This doc walks brownfield end-to-end. For the greenfield equivalent see [/mmo:greenfield's operating
manual](../plugin/commands/greenfield.md).

---

## The 20-second version

Type `/mmo:brownfield` in a session opened in your project directory. Six steps run in order.
Already know the job type? Seven aliases skip step 4's job-type question — `/mmo:bugfix`,
`/mmo:docs`, `/mmo:feature-extend`, `/mmo:feature-new`, `/mmo:refactor`, `/mmo:test`,
`/mmo:deps` — each optionally taking the task description as free text, e.g.
`/mmo:bugfix the /login endpoint returns 500 on missing password`. Gate 0 still fires and still
re-confirms scope either way; these are shortcuts into the same manual, not a second pipeline.

| # | Step | What it does |
|---|---|---|
| 1 | Session-hydrate | Shows prior runs, checks for resume state. |
| 2 | Pipeline pre-check | First time in this repo (or when the baseline is stale) — six offline smoke checks: Node, git, tests, credentials, MCP server build, policy pick. |
| 3 | Discovery | Reads the repo. Tier 1 (~10s) for shipped stacks; Tier 2b adaptive when the stack is custom. |
| 4 | Intent brief interview | Pick one of the seven job types and describe the task. Or supply a pre-written brief. |
| 5 | Gate 0 | One confirmation screen: stack, test command, off-limits, intent, scope. |
| 6 | Pipeline | Requirements → (architecture) → packet plan → execute → review → tests → security → report. |

Two prompts total from installation to done: `Setup this plugin from…` then `/mmo:brownfield`. Every setup step (env checks, credential shepherd, discovery, pre-check, baseline save) folds into those two. Task-agnostic helpers exist for occasional use:

| Command | When |
|---|---|
| `/mmo:setup` | Re-verify or re-configure after `/plugin update`, a credential change, or an unexpected refusal. Idempotent. |
| `/mmo:policy` | Show the active policy; `change` opens the browser console. |
| `/mmo:revert` | Undo a brownfield run using its `provenance.json`. |
| `/mmo:pass` | Headless / scripted equivalent (`--mode=brownfield`). |

No `/sdlc-precheck` or `/sdlc-doctor` sub-commands exist — the four above cover every path.

---

## Gate 0 walkthrough

Gate 0 is the one confirmation between discovery reading your repo and the pipeline starting work. Five things appear — approve, revise, or abort:

- **Stack** — the detected stack. Confirm or override.
- **Test command** — the command detected from `package.json` scripts / `pytest.ini` / equivalent. Accept or paste your own.
- **Existing AI setup** — verbatim list of Cursor rules / `.mcp.json` / competing configs discovery found. **Default is OFF-LIMITS** for all of them — the plugin never touches them unless you explicitly move one into scope.
- **Intent** — which of the seven job types.
- **File scope** — the allowlist (paths the pipeline may write to) and off-limits (paths never touched). Two-tier: the constant off-limits from `.sdlc/project.json.off_limits_default` (`.env*`, `.mcp.json`, `node_modules/**`, etc., written once at setup time) are pre-merged; only ticket-specific paths appear as editable at Gate 0. Edit either the allowlist or the additions list.

The flow:

```
discovery ──► Gate 0 ──► approve ──► freeze write-contract.json ──► pipeline
                 │
                 ├── revise ──► loop back to Gate 0
                 │
                 └── abort ──► clean exit (partial record kept, source tree untouched)
```

Approve freezes the merged allowlist + off-limits into `.sdlc/local/write-contract.json`. The PreToolUse hook reads that file on every write and refuses anything outside the allowlist. See [brownfield-write-contract.md](brownfield-write-contract.md) for the enforcement details.

---

## Coexistence guarantees

The plugin will **never**:

- Modify your `.env` or any file matching `.env.*` (values are yours; the plugin only appends
  new required-key NAMES to `.env.example`).
- Modify a `routing-policy.yaml` that already exists at repo root (it silently uses yours;
  Gate 0 always shows you when this happens).
- Modify `.cursor/rules`, `.aider*`, `.continue/`, `.github/copilot-instructions.md`, or any
  file inside `.mcp.json` unless you explicitly moved them into the allowlist at Gate 0.
- Modify submodules, files marked by `.gitattributes` as LFS, or anything gitignored by your
  `.gitignore`.
- Run other developers' tools on your behalf (`prettier --write`, `eslint --fix`, etc.) — the pipeline runs the project's own format command only on files the pipeline wrote, and only right after writing them. Never on your unmodified code.
- Commit or push git changes unless you configured `commit_strategy` explicitly in
  `.sdlc/project.json` (defaults: no commits, no PRs, work on current branch).

See [brownfield-coexistence.md](brownfield-coexistence.md) for how these guarantees are enforced.

---

## What lives in `.sdlc/`

The plugin's per-project state. Split into committed (team-shared) and gitignored (personal):

```
.sdlc/
├── project.json          — canonical fingerprint + default_policy + off_limits_default (committed; team edits via PR)
├── policy.yaml           — optional team policy override (committed)
├── ledger.md             — append-only human-readable run history (committed)
├── ledger.json           — machine mirror of the ledger (committed)
├── CLAUDE-SDLC.md        — plugin-owned CLAUDE-scoped context (committed)
├── runs/                 — per-run frozen records (committed)
│   └── <YYYYMMDD-HHMMSS-<intent>-<slug>>/
│       ├── intent_brief.md
│       ├── discovery.md
│       ├── baseline.json
│       ├── requirements.md
│       ├── change_plan.md
│       ├── packets.jsonl
│       ├── provenance.json
│       ├── telemetry.jsonl
│       ├── senior-review.md
│       ├── security-review.md
│       └── final_report.md
├── baseline/             — living project baseline (committed)
│   ├── current.json
│   ├── discovery.md
│   └── stack-profile.md  — only when adaptive profile ran
└── local/                — gitignored: personal per-developer state
    ├── state.json        — live state machine
    ├── setup-status.json — shepherd resume state
    ├── write-contract.json — the run's allowlist/off-limits; binds only while that run is live
    ├── user-policy.yaml  — personal policy override
    ├── cache/            — per-run backup copies for /mmo:revert
    └── debug.log
```

Uninstalling the plugin is `rm -rf .sdlc/` plus removing the one `@import` line from your
`CLAUDE.md` (the cleanup script does both).

---

## Where to go next

- **Understand the write contract** → [brownfield-write-contract.md](brownfield-write-contract.md)
- **Coexistence with your other AI tools** → [brownfield-coexistence.md](brownfield-coexistence.md)
- **Data flow, privacy, regulated repos** → [brownfield-privacy.md](brownfield-privacy.md)
- **Setup-time issue inventory (all 17 known risks)** → [brownfield-setup-issues.md](brownfield-setup-issues.md)
- **Model-per-task routing** → [brownfield-routing.md](brownfield-routing.md)
