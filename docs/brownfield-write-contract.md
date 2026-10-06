# Brownfield write contract

> **For:** understanding how the "never touch off-limits" guarantee is enforced at the tool boundary. **Also see:** [brownfield.md](brownfield.md) · [brownfield-privacy.md](brownfield-privacy.md).

The plugin's promise for brownfield mode is: **nothing outside a confirmed file-scope gets
touched.** This document explains how that promise is enforced and answers common "will this
touch X?" questions.

## The contract

**A brownfield run may write a path only when:**

- the path matches the run's `allowlist`, confirmed by you at Gate 0 (a new file the change creates included), and
- it matches neither the always-off-limits list nor the run's `off_limits`.

The scope is frozen at Gate 0 for the run's whole life. A wider scope is a new run with its own Gate 0 (your
decision): a frozen contract never changes mid-run.

**Off-limits paths are refused** before any file-system change happens. Off-limits also means unread: the server
never reads an off-limits file into a model's prompt ([brownfield-privacy.md](brownfield-privacy.md)), so a file the
change must read but not change belongs outside the allowlist (never written), not in `off_limits` (which would
keep it from the typists too).

## Four enforcement layers

| # | Layer | Strength | What it protects against |
|---|---|---|---|
| 1 | Orchestrator prompt gate | **Soft** — instruction to the AI | AI diligence (drops if the model drifts) |
| 2 | Plan check (`plan-lint.mjs` as each section of the change spec arrives, `plan-to-packets.mjs` at finalize; `findings-to-packets.mjs` for a fix round) | **Refused at planning** | A unit on an off-limits or non-allowlisted file, refused by `plan-lint.mjs`, and a fix aimed at one, which `findings-to-packets.mjs` does not route: both before a model is paid for it |
| 3 | PreToolUse hook | **HARD** — refused at the tool boundary | Every `Write` and `Edit`, planned or ad hoc |
| 4 | The server's writer | **HARD** — refused before the server writes | Every file the model server writes for an apply-form packet |

Layers 3 and 4 refuse before the file system is touched. Neither sees `Bash`: a shell command can write any file,
so the contract governs `Write`, `Edit` and the server's writes, and Claude Code's own permission rules govern the
shell.

## The hook

Implemented in [`plugin/scripts/write-contract-check.mjs`](../plugin/scripts/write-contract-check.mjs).
Registered as a `PreToolUse` matcher on `Write|Edit` in
[`plugin/hooks/hooks.json`](../plugin/hooks/hooks.json).

Behavior:

1. On every `Write` or `Edit` tool call, Claude Code invokes the hook.
2. **Which contract.** Only the contract at the root of the git project that holds the target counts: the nearest
   folder, the target's or above, with a `.git` file or folder, and `.sdlc/local/write-contract.json` under it. A
   `write-contract.json` placed anywhere else is ignored, so a contract in a subfolder never takes over the targets
   below it. The session's own project contract also decides targets inside its project, nested git projects
   included (a submodule, or a `.git` placed inside it): such a write must pass both contracts. The freeze record
   (step 4) is read from the same root.
3. **No contract there** (greenfield, or a project that never ran a brownfield run) → only the always-off-limits list
   (`.env`, `.env.*`, `.mcp.json`, `.cursor/rules/**`, `.claude/settings.local.json`, `.git/**`: credentials, MCP
   config, other AI tools' rules and git's own store, at any depth) is refused; every other write is allowed, so
   `/mmo:greenfield` in an empty folder is unaffected. Under a contract the list is refused too, whatever the
   contract says (steps 5 to 7), as the server's writer refuses it.
4. **The freeze record decides first.** [`write-contract.mjs`](../plugin/scripts/write-contract.mjs) writes the
   contract (`--freeze` at Gate 0) and records the SHA-256 of its exact bytes in the run's own log (a
   `contract.freeze` line). While that run is live, a contract that no longer matches the record — widened, switched
   off, deleted, unreadable, or rewritten to name another run, by any tool, a shell command included — refuses every
   write, with the reason ([`lib/contract-lock.mjs`](../plugin/scripts/lib/contract-lock.mjs)). So do two freeze
   records in one run's log, or live records of two runs: the script never writes either.
5. **A contract that binds nothing** → allow, except the always-off-limits list, which every contract refuses as
   step 3 does. That is a contract switched off (`active:false`) with no live freeze record against it, or one
   whose run has ended by its own log (`.sdlc/runs/<run-id>/orchestrator.log`; see
   [`lib/run-log.mjs`](../plugin/scripts/lib/run-log.mjs)). Ended means: a gate answered abort, a `run.end`
   recorded as aborted or failed, or a completed run whose Gate 4 is answered accept (or approved). Any other Gate 4
   answer (revise, reject) keeps the run, and its contract, live. The brownfield guide's close-out comes after
   Gate 4 is accepted, so its records (`.sdlc/ledger.md`, `.sdlc/ledger.json`, `.sdlc/CLAUDE-SDLC.md`) and its
   switch-off (`write-contract.mjs --close`, which it refuses until the run's end is in its log) go through.
6. **A live run's contract binds:**
   - The contract file and the run's own log are refused to `Write` and `Edit`, whatever the allowlist says: a live
     run may not widen its own contract, switch it off, or log its own end by hand. The log is written only by the
     plugin's own code: `mmo-log.mjs` and the model server's log lines, `write-contract.mjs`'s freeze record and an
     abandoned run's end, and zero-touch's stop.
   - The run's own output directory `.sdlc/runs/<run-id>/` is allowed.
   - The always-off-limits list (at any depth), then the contract's `off_limits` — deny with the reason if hit.
   - The `allowlist` — allow if hit.
   - Otherwise (not in the allowlist, not off-limits) — deny.

   Off-limits patterns match in any letter case on every disk: on macOS's (case-insensitive by default) another
   spelling is the same file, and on a case-sensitive disk (Linux's) the rule stays the stricter one. A path is judged as written and as it resolves
   through links: both must pass, so a project reached through a linked folder (macOS's `/tmp` and `/var`) is judged
   the same whichever form a path takes, and a link that leads out of the project is a write outside it.
7. **`strict: false`.** `--strict-write=off`, passed by you at the start (Gate 0's freeze writes the contract with
   `strict: false`), downgrades the contract's off-limits and allowlist refusals to warnings. It never opens the
   always-off-limits list, and never the run's own contract or log while its freeze record is live. The run never
   edits the contract: changing `strict` in a frozen contract is a change to the contract (step 4).
8. A write outside the project that holds the session's active contract is refused as a cross-project write.
9. A refusal says what was refused and why, and that a wider scope is your decision; it never names a way past it.

Fail-safe: a bug in the hook itself (an input it cannot parse, a missing field, a path it cannot resolve) → allow,
the always-off-limits list aside: better to permit a write than to wedge your work on a plugin bug. A contract that
does not parse is not such a bug: under a live freeze record it refuses every write (step 4); with none, it binds
nothing.

Why step 5 exists: the close-out writes under `.sdlc/`, which the contract puts off-limits, so a run could never
switch its own contract off, and after a normal finish the contract would go on refusing every edit outside that
run's allowlist, in every chat in the project, the next run's Gate 0 included. The run's own log ends the contract.

## The freeze record, said exactly

The record lives only in the run's own log (`.sdlc/runs/<run-id>/orchestrator.log`, the pieces the logger rotates
out included). Deleting or emptying that log, or the run folder, frees the run, and so does putting anything but a
regular file in the log's place: that is destruction of the run's own record, not a cleanup. A shell can do it, as a
shell can write any record: an end record in the run's log frees the run too. Clearing the contract's own folder
(`.sdlc/local/`) frees nothing, since the record is never read from beside the contract.

A run freezes once. `--freeze` refuses a run id whose log already holds a freeze record or an end record, and a
project root that is not a git project's root (the only place the hook reads a contract); it also refuses while
another run's contract binds the project. So "end the run, then freeze a wider contract under the same id" fails:
only a new run, with its own Gate 0, freezes again.

## Ending a run that will never end by itself

Gate 0 freezes the contract before the orchestrator logs `run.start`. A run that stops after that without an end
record — its start check halted, its chat was closed, it crashed, a usage limit cut it off — leaves a live record
that nothing in the run will ever end, and the project stays held: writes outside that run's allowlist, the next
run's Gate 0 and `--close` are refused. Ending such a run is your decision:

```bash
node "$(node -p 'require(require("os").homedir()+"/.claude/plugins/installed_plugins.json").plugins["mmo@tilicho-ai-labs"][0].installPath')/scripts/write-contract.mjs" --abandon --run-id <run-id> --reason "<why>"
```

`write-contract.mjs --abandon --run-id <run-id> [--reason "<text>"]` appends `run.end outcome=aborted reason=<text>`
to the run's own log (unless the run has already ended), then switches the run's contract off. It is the only
documented way to free a project from such a run. The brownfield guide offers it when you answer `discard` for an
interrupted run, and when a run stops after Gate 0 froze its contract; zero-touch never runs it without your
approval.

## The server's writer (apply form and `execute_batch`)

A packet with an `apply` block is written by the MCP server, not by a `Write` or `Edit` tool call, so
the hook above never sees it. The server runs the same check itself
([`checkWriteContract`](../plugin/mcp/model-dispatch/src/apply.ts)) before every write, with its own copy of the
run-end rule ([`runLog.ts`](../plugin/mcp/model-dispatch/src/runLog.ts), kept equal to the hook's by
`test/apply.test.mjs`). Off-limits patterns match in any letter case. It reads a packet's inputs by the read rule
(`hydrateInputs`): an off-limits path is never read into a model's prompt, judged as written and by the file it
reaches through links. The path as written is judged before the server looks for the file, so an off-limits path is
refused as off-limits whether or not it exists, on every disk, and the refusal never tells whether such a file is there.

| Case | What the server does |
|---|---|
| No `.sdlc/local/write-contract.json`, `active:false`, or a contract whose run has ended by its own log | Refuses the packet before any model call. The apply form exists only inside a live brownfield run, after Gate 0. |
| A live run's contract no longer matches the freeze record in the run's log | Refuses every write, with the reason (the hook's rule, mirrored by `contractTampered` and `runLog.ts` `liveFreeze`). |
| Packet routed to an `antigravity-worker` leaf | Typed by greenfield's agent typist, which answers from its own scratch folder; the server writes the file inside this check and the snapshots. Refused when the run's start check (`preflight_dispatch`) has not run, or when the packet names no brownfield job (`intent`): without them the agent would edit the project folder itself. |
| A fix-round packet (phase `debug`) on the path of a unit with red checks | Refuses it: a bugfix's reproducing test is the judge of the fix, and a problem in it goes back to the architect. |
| A check, write form or red check of the packet that your Bash deny rules forbid | Refuses the packet before any model call: the server holds its own commands to the deny rules Claude Code's `Bash` check would apply. |
| Path in the always-off-limits list (at any depth) | Refuses the write (`apply.refused`), under every contract, `strict: false` included. |
| Path in the contract's `off_limits` | Refuses the write (under `strict: false`, allows it). |
| Strict contract, path not in the `allowlist` | Refuses the write (under `strict: false`, allows it). |
| The contract file, or the run's own `orchestrator.log` | Refuses the write, whatever the allowlist says, under `strict: false` too while the run's freeze record is live: a live run may not change its own contract or log its own end. |
| `.sdlc/runs/<run-id>/` of the packet's own run | Allows: the run's own record. |
| Otherwise | Takes the run's provenance snapshot of the file once (before the first dispatch), writes, runs the file's write forms (`fix`), then its checks. |

The commands the server runs for a packet — each file's checks, their write forms, the run of each check on the
file before the change, and a bugfix's red checks — run in the server, outside Claude Code's Bash rules and sandbox:
the server holds them to your Bash deny rules itself, and runs them with the vendor credentials it holds removed from
their environment
([brownfield-privacy.md](brownfield-privacy.md), "Commands the run executes on your machine").

## Off-limits, two tiers

Off-limits paths come from two sources merged into the run's write contract:

| Tier | Source | Written when | Examples |
|---|---|---|---|
| **Project defaults** | `.sdlc/project.json.off_limits_default` | Once at setup by `/mmo:setup` — a fixed list every run in this folder inherits (`lib/off-limits.mjs` `OFF_LIMITS_DEFAULT`). | `.env`, `.env.*`, `.mcp.json`, `.cursor/rules/**`, `.claude/settings.local.json`, `node_modules/**`, `dist/**`, `build/**`, `.next/**`, `.sdlc/**`, `.git/**`. |
| **Per-run additions** | Gate 0's off-limits list | Each brownfield run, on top of the defaults: discovery's proposal, then your edits. | Other AI tools' folders discovery finds (such as `.cursor/**` and `.claude/**`), a pre-existing `routing-policy.yaml`, and anything ticket-specific — a directory you know shouldn't move for this particular change. |

The merge happens at Gate 0. The write contract at `.sdlc/local/write-contract.json` holds the merged result. The PreToolUse hook and the server's writer read it and never see the two tiers as distinct — a hit in either denies the write. The always-off-limits list (`.env`, `.env.*`, `.mcp.json`, `.cursor/rules/**`, `.claude/settings.local.json`, `.git/**`) is applied on top of both, at any depth, and cannot be moved into an allowlist.

Change the project defaults by editing `.sdlc/project.json.off_limits_default` in a PR (committed, team-shared). Change per-run additions by editing Gate 0's proposal before approving.

## Merge semantics for sensitive files (deep-merge, never overwrite)

Even when a file is in the allowlist, a change to anything sensitive adds and never removes. These rules bind what a
change does: the architect plans an edit's sites by them and the senior reviewer checks the diff against them; code
does not check them. The always-off-limits list overrides every row: a run never writes `.env`, `.env.*` or
`.mcp.json`.

| File | Rule |
|---|---|
| `package.json` | Add missing deps/scripts; never remove; never downgrade; new script names must not shadow existing |
| `.env`, `.env.*` (`.env.example` included) | Never written by a run (always off-limits); a new required key is named for you to add; **never `cp .env.test .env` when `.env` exists** |
| `CLAUDE.md` | Add, never remove or rewrite a line; written only when it is in the allowlist and the change spec has a unit for it. The plugin's own setup and close-out never write it |
| `.claude/settings.json` | Deep-merge: add keys, never remove one or rewrite an existing value |
| `.mcp.json` | Never written by a run (always off-limits) |
| `routing-policy.yaml` | **Never touched if pre-existing** (surfaced at Gate 0 so its presence is visible) |
| `.cursor/rules/**` | Always off-limits |
| `.aider*`, `.continue/`, `.github/copilot-instructions.md` | Off-limits when discovery proposes them; editable only if you move them into the allowlist at Gate 0 |

## What protects a file that existed before the run

The server writes a typed file inside `execute_batch` without showing a diff first. What protects an existing file:

1. **The plan.** Every edit's sites, by line range and the text of their lines, and every check that will run are in
   `change_plan.md`, which both reviewers read in every job. **Gate 2** shows it to you before anything is typed for
   feature-extend, feature-new, refactor and deps, and for a bugfix that code finds design-affecting (the spec has a
   decision, creates a file that is not a test, or replaces or deletes lines of an existing test file).
2. **Exact edits.** An edit is answered as search/replace edits, each found exactly once in the text it applies to
   (the file as it was before the change, with the answer's earlier edits applied), applied in order, or the whole
   file; the answer must also keep to the edit's planned sites; a search found zero or several times is a retry, never a
   guess.
3. **Checks.** The file's checks run after each write; an edit that fails them is undone before the next attempt.
4. **Provenance.** The run's first snapshot of every file it writes is kept for **`/mmo:revert <run-id>`**, which
   restores it. A tooling step (a deps run's install, which the package manager runs in a shell) is recorded the same
   way: the orchestrator runs `write-provenance.mjs --before` for each file the step writes (the manifest, the
   lockfile), then the step, then `--after`, and a file the step changed that provenance does not list is reported
   at the next gate, since `/mmo:revert` cannot restore it.
5. **Review.** Both reviewers read the file's diff against the run's starting commit, and the senior reviewer checks
   it against the merge rules above.

## FAQ

| Question | Answer | Escape hatch |
|---|---|---|
| Will this touch my `.env`? | No, ever. `.env` and `.env.*` are on the always-off-limits list: the hook and the server's writer refuse writes there, with or without a contract, and the server never reads them into a model's prompt. If the change needs a new environment variable, the run names it and you add it. | None. `.env` values are yours. |
| Will this touch my Cursor rules (`.cursor/`)? | No. `.cursor/rules/**` is always off-limits, and discovery proposes `.cursor/**` for the run's off-limits. | The rest of `.cursor/` can be moved into the allowlist at Gate 0 by editing the proposal; `.cursor/rules/**` cannot. |
| Will this touch my `package.json`? | Only when it is in the allowlist and the change spec has a unit for it (a deps run's manifest edit, a new dependency). The edit is exact search/replace on the lines the spec names, and the file's checks run after it. | None needed. |
| What if I have `commit_strategy: per-gate`? | The plugin refuses to run on a dirty tree so your uncommitted work does not tangle with the plugin's commits. Defaults are safe: `branch_strategy: current`, `commit_strategy: none`, `pr: off`. | `--allow-dirty` bypasses the git-clean check. |
| Can the AI bypass the contract? | Not through `Write`, `Edit` or the server's writer: each write is checked before anything reaches the disk. `Bash` is not guarded by the contract: a shell command that rewrites the contract changes its bytes, and from then on every write of the run is refused; one that deletes or empties the run's own log destroys the freeze record and frees the run ("The freeze record, said exactly"). Claude Code's own permission rules for `Bash` stand between a run and such commands. | `--strict-write=off`, passed by you at the start. Mid-run: none; a wider scope is a new run with its own Gate 0. The flag never opens the always-off-limits list, and editing a frozen contract refuses every write. |
| How do I override off-limits for one specific run? | Before you approve Gate 0, answer `revise:` and move the path from `off_limits` to `allowlist` (the always-off-limits list cannot be moved). After Gate 0 the scope is frozen for the run: abort it and start a new run with the wider scope. | None. `.sdlc/project.json.off_limits_default` is unchanged by this. |
| A run stopped after Gate 0 (its start check halted, its chat was closed, it crashed) and the project stays held | `write-contract.mjs --abandon --run-id <run-id> [--reason "<text>"]` logs the run's end (aborted) and switches its contract off; the full command is in "Ending a run that will never end by itself". Deleting the contract does not free it: under the run's live freeze record, that refuses every write. | Your decision; zero-touch never runs it on its own. |
| My repo has files with unusual characters — will pattern matching work? | Yes. The hook uses glob-style pattern matching (`*`, `**`, `?`, literal `/`), and off-limits patterns match in any letter case. No shell-out, no eval on paths. Unicode, spaces, and exotic characters all work. | None needed. |
| What if I run `git checkout` or `git reset --hard` mid-run? | The plugin observes git state between phases via `git status`. If HEAD moved unexpectedly, it halts with a clear message before continuing. | None. The halt is the safety guarantee — better to stop than write against a repo that changed under it. |
