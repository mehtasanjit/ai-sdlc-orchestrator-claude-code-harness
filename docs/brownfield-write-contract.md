# Brownfield write contract

> **For:** understanding how the "never touch off-limits" guarantee is enforced at the tool boundary. **Also see:** [brownfield.md](brownfield.md) · [brownfield-privacy.md](brownfield-privacy.md).

The plugin's promise for brownfield mode is: **nothing outside a confirmed file-scope gets
touched.** This document explains how that promise is enforced and answers common "will this
touch X?" questions.

## The contract

**The orchestrator MAY NOT write to any path unless:**

- The path is in the run's `allowlist` (confirmed by you at Gate 0), OR
- The path did not exist at discovery time (a new file), OR
- You re-opened Gate 0 to explicitly expand scope.

**Off-limits paths are hard-rejected** at the tool boundary — before any file-system change
happens.

## Three enforcement layers

The contract is enforced at three layers. Each has different strength and different failure
modes.

| # | Layer | Strength | What it protects against |
|---|---|---|---|
| 1 | Orchestrator prompt gate | **Soft** — instruction to the AI | AI diligence (drops if the model drifts) |
| 2 | Packet validator | **Schema-level** — `TaskPacket.artifact_path` check | Planned writes with bad paths |
| 3 | PreToolUse hook | **HARD** — refused at the tool boundary | Everything, including ad-hoc writes |

Only layer 3 is unbreakable. If the AI ever tries to write outside the allowlist — via a
planned packet OR a spur-of-the-moment `Write` — the hook refuses it at the tool boundary.
Claude Code declines the tool call. The file system is never touched.

## The hook

Implemented in [`plugin/scripts/write-contract-check.mjs`](../plugin/scripts/write-contract-check.mjs).
Registered as a `PreToolUse` matcher on `Write|Edit` in
[`plugin/hooks/hooks.json`](../plugin/hooks/hooks.json).

Behavior:

1. On every `Write` or `Edit` tool call, Claude Code invokes the hook.
2. The hook reads `.sdlc/local/write-contract.json` from an ancestor of the current directory.
3. If the file is missing or `active:false` → allow (greenfield mode or no active run — the
   hook silently no-ops so `/mmo:greenfield` in an empty folder is unaffected).
4. A contract binds its own run only, and only while that run is live. If the run has ended by its
   own log (`.sdlc/runs/<run-id>/orchestrator.log`, written by `mmo-log.mjs`; see
   [`lib/run-log.mjs`](../plugin/scripts/lib/run-log.mjs)) → allow, exactly as for `active:false`.
   Ended means: a gate answered abort, a `run.end` recorded as aborted or failed, or a completed run
   whose Gate 4 is answered accept (or approved). Any other Gate 4 answer (revise, reject) keeps the
   run, and its contract, live. The brownfield guide's close-out comes after Gate 4 is accepted, so
   its records (`.sdlc/ledger.md`, `.sdlc/ledger.json`, `.sdlc/CLAUDE-SDLC.md`) and its switch-off
   (`active:false`) go through.
5. If active and the run is live:
   - The contract file and the run's own log are refused to `Write` and `Edit`, whatever the allowlist
     says: a live run may not widen its own contract, switch it off, or log its own end by hand.
   - The run's own output directory `.sdlc/runs/<run-id>/` is allowed.
   - Check the target path against `off_limits` patterns — deny with reason if hit.
   - Check against `allowlist` patterns — allow if hit.
   - Otherwise (not in allowlist, not off-limits) — deny.
6. `contract.strict = false` (equivalent to `--strict-write=off`) downgrades every enforcement
   to a warning; the file is written but a warning is logged.
7. A write outside the project that holds the session's active contract is refused as a
   cross-project write. "Inside" is judged on the paths as written first; only when that says
   "outside" is it judged again with links resolved on both sides. So a project reached through a
   linked folder (macOS's `/tmp` and `/var`, a linked code folder) is judged the same whichever form
   a path takes: the session's folder always reads with links resolved, while a write's path
   arrives as written. The second look can only find a path inside, so it never refuses a write the
   first look allows.

Fail-safe: any bug in the hook (parse failures, missing fields, resolvable path issues) → allow.
Better to permit a write than to wedge user work on a plugin bug. Denials only happen when the
contract parses cleanly AND is active AND its run has not ended AND the path fails the check.

Why step 4 exists: the close-out writes under `.sdlc/`, which the contract puts off-limits, so a run
could never switch its own contract off. After a normal finish the contract went on refusing every
edit outside that run's allowlist, in every chat in the project, the next run's Gate 0 included. Now
the run's own log ends the contract. `Bash` is not matched by this hook, so the contract governs the
`Write` and `Edit` tools only.

## The server's writer (apply form and `execute_batch`)

A packet with an `apply` block is written by the MCP server, not by a `Write` or `Edit` tool call, so
the hook above never sees it. The server runs the same check itself
([`checkWriteContract`](../plugin/mcp/model-dispatch/src/apply.ts)) before every write, with its own copy of the
run-end rule ([`runLog.ts`](../plugin/mcp/model-dispatch/src/runLog.ts), kept equal to the hook's by
`test/apply.test.mjs`).

| Case | What the server does |
|---|---|
| No `.sdlc/local/write-contract.json`, `active:false`, or a contract whose run has ended by its own log | Refuses the packet before any model call. The apply form exists only inside a live brownfield run, after Gate 0. |
| Packet routed to an `antigravity-worker` leaf | Refuses the packet. An agent-door worker edits the folder itself, outside this check. |
| Path in the hardcoded off-limits list | Refuses the write (`apply.refused`). |
| Path in the contract's `off_limits` | Refuses the write. |
| Strict contract, path not in the `allowlist` | Refuses the write. |
| The contract file, or the run's own `orchestrator.log` | Refuses the write, whatever the allowlist says (`strict: false` reports instead): a live run may not change its own contract or log its own end. |
| `.sdlc/runs/<run-id>/` of the packet's own run | Allows: the run's own record. |
| Otherwise | Writes, takes the run's provenance snapshot of the file once (before the first dispatch), formats, then verifies. |

## Off-limits, two tiers

Off-limits paths come from two sources merged into the run's write contract:

| Tier | Source | Written when | Examples |
|---|---|---|---|
| **Project defaults** | `.sdlc/project.json.off_limits_default` | Once at setup by `/mmo:setup` — a fixed list every run in this folder inherits. | `.env*`, `.mcp.json`, `.cursor/`, `.aider*`, `.continue/`, `.github/copilot-instructions.md`, `.roo/`, `node_modules/**`, `dist/**`, LFS-marked files, submodules. |
| **Per-run additions** | Gate 0's off-limits list | Each brownfield run, on top of the defaults. | Anything ticket-specific — a directory you know shouldn't move for this particular change. |

The merge happens at Gate 0. The write contract at `.sdlc/local/write-contract.json` holds the merged result. The PreToolUse hook reads it and never sees the two tiers as distinct — a hit in either denies the write.

Change the project defaults by editing `.sdlc/project.json.off_limits_default` in a PR (committed, team-shared). Change per-run additions by editing Gate 0's proposal before approving.

## Merge semantics for sensitive files (deep-merge, never overwrite)

Even when a file is in the allowlist, the plugin uses deep-merge semantics for anything
sensitive:

| File | Rule |
|---|---|
| `package.json` | Add missing deps/scripts; never remove; never downgrade; new script names must not shadow existing |
| `.env` / `.env.example` | Append missing KEY names only; never rewrite values; **never `cp .env.test .env` when `.env` exists** |
| `CLAUDE.md` | Never touch (only append one `@import` line at first setup, via mini-gate with diff preview) |
| `.claude/settings.json` | Read → parse → deep-merge → write, with diff at mini-gate |
| `.mcp.json` | Same as `.claude/settings.json` |
| `routing-policy.yaml` | **Never touched if pre-existing** (surfaced at Gate 0 so its presence is visible) |
| `.cursor/rules`, `.aider*`, `.continue/`, `.github/copilot-instructions.md` | Default off-limits (from `project.json.off_limits_default`); only editable if explicitly moved into allowlist at Gate 0 |

## Diff-preview mini-gate for pre-existing files

Any packet targeting a file that existed at discovery time triggers a diff-preview:

1. Packet dispatches → returns proposed content.
2. Orchestrator computes a unified diff between the current file and the proposed content.
3. Diff is shown to you inline.
4. Approve → write. Revise → dispatch again with your comments. Abort → skip this packet.

This is the concrete answer to the "the plugin doesn't know how you use Gemini / Cursor / your own tooling" problem — even if discovery misclassified a file's role, the diff appears before the write lands.

## FAQ

| Question | Answer | Escape hatch |
|---|---|---|
| Will this touch my `.env`? | No, ever. `.env*` is in `.sdlc/project.json.off_limits_default` — the write contract refuses writes there regardless of intent. If codegen introduces a new required env var, the KEY name (not the value) is appended to `.env.example` and a mini-gate asks you to populate `.env` before Phase 7 tests run. | None. `.env` values are yours. |
| Will this touch my Cursor rules (`.cursor/`)? | No. Default off-limits. | Move `.cursor/` into the allowlist at Gate 0 by editing the proposal. |
| Will this touch my `package.json`? | Only to add missing dependencies (deep-merge, append-only) and only when a codegen packet explicitly requires it. Never removes, downgrades, or shadows existing scripts. | None needed — the merge rules already enforce safety. |
| What if I have `commit_strategy: per-gate`? | The plugin refuses to run on a dirty tree so your uncommitted work does not tangle with the plugin's commits. Defaults are safe: `branch_strategy: current`, `commit_strategy: none`, `pr: off`. | `--allow-dirty` bypasses the git-clean check. |
| Can the AI bypass the hook? | No. The hook is a Claude Code `PreToolUse` matcher — refusals happen before the tool executes. No prompt-level workaround reaches the file system. | `contract.strict = false` in `write-contract.json`, or `--strict-write=off` at run start. Both require explicit user action. |
| How do I override off-limits for one specific run? | Re-open Gate 0 with `revise:` and move the specific path from `off_limits` to `allowlist`. Ephemeral — applies to this run only. | None. `.sdlc/project.json.off_limits_default` is unchanged by this. |
| My repo has files with unusual characters — will pattern matching work? | Yes. The hook uses glob-style pattern matching (`*`, `**`, `?`, literal `/`). No shell-out, no eval on paths. Unicode, spaces, and exotic characters all work. | None needed. |
| What if I run `git checkout` or `git reset --hard` mid-run? | The plugin observes git state between phases via `git status`. If HEAD moved unexpectedly, it halts with a clear message before continuing. | None. The halt is the safety guarantee — better to stop than write against a repo that changed under it. |
