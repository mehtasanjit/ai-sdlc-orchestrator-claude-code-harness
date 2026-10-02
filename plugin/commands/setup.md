---
description: "Re-verify or re-configure the SDLC plugin for this project. Runs the mechanical setup steps silently (install check, environment check, credential probe), pauses only when a human decision is genuinely needed (missing credentials, Gemini door choice, policy pick). Idempotent — safe to re-run any time after `/plugin update` or when a credential changes."
argument-hint: "[--policy=<name>] [--gemini-door=enterprise|antigravity] [--user]"
---

Re-verify the SDLC plugin for this project. Auto-by-default: run the mechanical steps silently and
pause only when a human decision is genuinely required.

**Arguments:** $ARGUMENTS

**Argument parsing:**
- `--policy=<name>` — pre-answer the policy pick (skips the browser). Must match a file in
  `${CLAUDE_PLUGIN_ROOT}/config/policies/<name>.yaml` — the directory listing is the authoritative preset set
  (`opus-plus-flash` is the recommended default; a wrong name makes the loader print the live
  list).
- `--gemini-door=<enterprise|antigravity>` — pre-answer the Gemini door choice. `enterprise` is the
  API-key / ADC path (default); `antigravity` opens the Antigravity SDK worker (requires ADC).
- `--user` — write the Gemini-door selection to `~/.claude/settings.json` (all folders on this
  machine) instead of the project-local `.claude/settings.local.json`.

# Scope

This is the RE-VERIFY / RE-CONFIGURE command. First-time install (marketplace add + `/plugin
install`) still lives in the repository's `SETUP.md` — the plugin has to exist before its slash
commands do. `/mmo:setup` covers everything from step 3 of SETUP.md onward: the install check,
environment check, credential probe, Gemini door, policy pick, and the hand-over banner.

Every step below auto-runs unless it hits a genuine decision. Print one line per completed step,
so the user can see progress. Pause only when a step actually needs a human answer.

# 1. Check the install (silent)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-setup.mjs" --fix --project-root "$(pwd)"
```

The MCP server ships pre-built inside the plugin, so on a normal install there is nothing to build
and `--fix` does nothing. It repairs only a copy whose pre-built server is missing (it installs the
server's npm deps and builds it). Report the one-line result and continue.

If the script exits non-zero, print the error, its `fix:` field, and STOP. This is a blocking
issue (Node < 20, missing Claude Code CLI, a missing pre-built server) and must be resolved before
anything downstream can work.

# 2. Read the verify result and pause only for missing credentials

The script reports three kinds of finding:

- `✗` **blocking** — already handled by step 1 above (STOP).
- `!` **warning** — usually a missing credential. **Pause here.** For each warning, print the
  finding and ask the user for the value. Do not fabricate; do not proceed to the next step until
  the credential is either supplied or explicitly skipped.
  - `ANTHROPIC_API_KEY` — required for vendor-billed runs. Not required under subscription auth.
  - Gemini access — required by any policy that routes mechanical phases to Gemini. Two doors,
    see step 3 below.
- `✓` **ok** — no action, continue.

Write supplied credentials to the `env` block of `~/.claude/settings.json` (or use
`gcloud auth application-default login` for the Google Cloud path — no env var involved). Never
write `MMO_SELECT` by hand; step 3 handles it.

# 3. Gemini door — auto-pick if only one works, ask only if both are available

The mechanical tier has two doors to the same model:

- **Gemini Enterprise Agent Platform (API)** — signs with `GEMINI_API_KEY` or Google Cloud ADC.
  This is what an untouched install already uses. No flag needed.
- **Antigravity SDK worker** — signs with Google Cloud ADC only (no API-key door). Enables
  agentic delegation with a working directory.

Decision matrix:

| `--gemini-door=` supplied? | ADC present? | `GEMINI_API_KEY` present? | Action |
|---|---|---|---|
| yes | any | any | Honor the flag. If it can't work (`antigravity` without ADC), print why and STOP. |
| no | no | no | No Gemini creds at all. Print the one-liner from SETUP.md §5 explaining how to open either door, and continue — the policy pick in step 4 can still run against Anthropic-only. |
| no | no | yes | Silently use `enterprise` (the only door that works). Continue. |
| no | yes | no | Silently use `enterprise` still (default behavior; the user can flip to `antigravity` later by re-running with `--gemini-door=antigravity`). Continue. |
| no | yes | yes | Ambiguous — **ask** which door. Two options only, no descriptions: (a) Gemini Enterprise Agent Platform (API), (b) Antigravity SDK worker. |

When switching to Antigravity:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-setup.mjs" --enable-agent --project-root "$(pwd)"
```

Add `--user` if the caller passed `--user`. This writes `MMO_SELECT=gemini-flash=flash-agsdk-worker`
to the settings file and builds the Python environment the agent path needs.

# 4. Policy pick

Read the current default: `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --print-only
--project-root "$(pwd)"`. If it prints a policy name, the project already has one — print
`current policy: <name>` and skip to step 5.

If `--policy=<name>` was supplied, honor it silently — no prompt, no browser:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --policy=<name> --project-root "$(pwd)"
```

**Otherwise, use the same terminal picker as `/mmo:policy change` Shape 2.** Skip the mid-run
guard here (no brownfield run has started yet in setup); everything else applies:

1. Enumerate policies:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --list-json --project-root "$(pwd)"
   ```
2. Ask via `AskUserQuestion`:
   - question: `Which policy do you want as this project's default?`
   - header: `Policy`
   - multiSelect: `false`
   - options: one per policy from step 1 (`label` = policy name, `description` = `""`), plus a
     final `Author a new policy (opens browser)` option with description
     `Opens the local policy console to create a custom YAML.`.
3. Handle the pick:
   - Policy name → run `--check-creds --policy=<chosen>`.
     - `ok: true` → persist with `--policy=<chosen>` and print `Policy set: <chosen>`.
     - `ok: false` → print each `missing` entry with its `fix`, then re-ask via `AskUserQuestion`
       (options: `Retry (I fixed them)`, `Pick a different policy`). Retry → re-run `--check-creds`
       with the same policy. Pick different → loop back to step 1.
   - `Author a new policy (opens browser)` → run
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-policy.mjs" --project-root "$(pwd)"`. The script
     starts the local server, opens the browser, and detects the save automatically via `fs.watch`.

Do not suggest "Type something" as a hidden option — the user's typed name may not match a
shipped preset, which fails downstream. The picker above covers every real path.

# 5. Print the next-steps banner

The script from step 1 already prints this at the end of a successful run. If for any reason it
did not (e.g. the run stopped short earlier), print it explicitly:

```
✓ Setup complete for this project.

Try one of these in a NEW session in the same folder:

  /mmo:greenfield          — generate a new app from a brief (empty folder)
  /mmo:brownfield   — work on this existing repo (docs, bugfix, feature, refactor, …)
  /mmo:policy       — change this project's model policy
  /mmo:pass         — headless/scripted run (for CI or replays)

Current policy: <policyName>   (change: /mmo:policy change)
```

Say plainly why a NEW session is required: Claude Code builds the slash-command list and starts
plugin MCP servers at session boot. In this session the setup changes are on disk but not live.

# Idempotency

Every step is safe to re-run:
- The install check changes nothing when the pre-built server is present.
- The credential probe reads env / settings; it never writes.
- The Gemini-door flip is a plain settings write.
- The policy pick reads `.sdlc/project.json` first and skips the browser if a policy is already set.

Re-run `/mmo:setup` after `/plugin update`, or whenever a credential changes.
