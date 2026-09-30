# Brownfield setup-time issue inventory

> **For:** hitting an install-time problem on brownfield mode; every known risk and its handling. **Also see:** [troubleshooting.md](troubleshooting.md) · [brownfield.md](brownfield.md).

Every known risk that hits real users installing the plugin on real repos. Each gets
**detection + clear message + inline choice** — the "handle ≠ solve" principle from the design
plan (§22). Detect the problem, name it, offer the best available option; no elaborate solving
infrastructure when a good detection suffices.

The table's "handled by" column names the script or subagent that owns each issue's detection.

## Environment (detected in prompt 1)

| # | Issue | Handled by | Behavior |
|---|---|---|---|
| 1 | Node too old (< 20) | `env-checks.mjs` | Detect, print required version + install/upgrade instructions (nvm / brew / nodejs.org), exit clean. Cannot auto-upgrade — needs user action. |
| 2 | Git missing or too old (< 2.30) | `env-checks.mjs` | Same — detect, print install instructions per-platform. |
| 3 | MCP server `dist/` not built | `verify-setup.mjs` | Auto-build via `verify-setup.mjs --fix`. |
| 4 | Plugin command-name conflict | `env-checks.mjs` | Detect (best-effort scan of `~/.claude/plugins/*/plugin.json`), list conflicts, prompt for a rename or uninstall of the conflicting plugin. |
| 5 | Filesystem write permission denied on `~/.claude/` | `env-checks.mjs` | Detect, print `sudo chown -R $USER ~/.claude` (with $USER expanded), exit. |
| 5b | Filesystem write permission denied on `.sdlc/local/` | `env-checks.mjs` | Same shape — clear chmod fix. Deferred if not in a git repo. |

## Repo state (detected in prompt 1 section 5 or pre-check)

| # | Issue | Handled by | Behavior |
|---|---|---|---|
| 6 | No test infrastructure detected | `discovery` + `pre-check.mjs` | Discovery notes `test_command_proposed: "unknown"`; Gate 0 warns *"proceed without test phase? [y/n]"*. If yes, Phase 7 is skipped. |
| 7 | Failing tests before the run starts | `pre-check.mjs` step 2 | The test-command probe uses `--collect-only`/`--dry-run` so it does not run the suite. If you run the full suite first and it fails, Gate 0 shows a warning: *"Repo has N pre-existing failing tests. This run will not cause these, but Phase 7 may fail approval on them. Continue? [y/n]"* |
| 8 | Encrypted secrets manager (Vault, Doppler, `.env.enc`) | `discovery` | Detect the marker file. Gate 0 notes: *"Secrets appear to be in `<X>`. Off-limits does not cover them, but the plugin does not touch them either. No `.env` work in this run."* |
| 9 | Git-LFS files | `discovery` | Detect from `.gitattributes` (`filter=lfs` / `diff=lfs` / `merge=lfs`). Skip `Read` on LFS-marked patterns (would blow token budget). Gate 0 lists what is skipped. |
| 10 | Git submodules | `discovery` | Detect `.gitmodules`. Treat as opaque — the write contract never targets them. Gate 0 note. |
| 11 | Squash-merged history | (runtime) | If provenance rollback fails via `git log --follow`, fall back to tree-SHA. Not detected upfront in v1 — recovered at revert time. |
| 12 | Aggressive `.gitignore` hiding source | `discovery` | Detect ignored files matching common source patterns (`src/**/*.ts` etc.). Gate 0 warns which likely-source files are ignored. |
| 13 | Very large repo (> 100K tracked files) | `discovery` | Sample-based discovery instead of full walk. Gate 0 discloses the sampling strategy. |
| 14 | Non-UTF8 files | `discovery` | Skip on `Read` failure. Log to `.sdlc/local/debug.log`. Continue. |

## Runtime resilience

| # | Issue | Handled by | Behavior |
|---|---|---|---|
| 15 | Provider outage mid-dispatch | MCP server adapters | 3 retries with exponential backoff. Full outage → packet marked `failed: network`. Orchestrator prompts for the next step (retry / skip / abort). |
| 16 | Cost runaway on unexpectedly large repo | Bounded by rounds, not dollars | No policy sets a cost cap. A greenfield run makes at most three repair rounds after a failing check run, and its acceptance stage at most three re-checks; a policy that still declares `hard_cost_cap_usd` has the figure set aside at load. |
| 17 | Model deprecation mid-project | Adapter provider-error handling | Detect via provider error. Fail cleanly: *"model `<X>` is deprecated by provider — update your policy YAML to use `<Y>` (see release notes)."* No auto-fallback — you decide. |

## Out of scope

- **Auto-fix things you should decide.** Missing Node? The plugin prints the commands; it does
  not run them.
- **Auto-elevate permissions.** Filesystem or chmod issues → the plugin prints the fix; you run
  it.
- **Auto-commit / auto-push.** Ever. Default git strategy is `commit_strategy: none`.
- **Auto-upgrade dependencies during setup.** Setup checks are read-only except for building
  the MCP server dist (plugin-owned).
- **Silently reroute to public models when a private endpoint fails.** Halt cleanly instead.

## How to run just the brownfield checks

```bash
node ~/.claude/plugins/cache/tilicho-ai-labs/mmo/*/scripts/verify-setup.mjs --brownfield-check
```

Or run them independently:

```bash
# All env checks
node .../plugin/scripts/env-checks.mjs
node .../plugin/scripts/env-checks.mjs --json

# Credential discovery only (never reads secret values)
node .../plugin/scripts/credential-discovery.mjs
node .../plugin/scripts/credential-discovery.mjs --include-antigravity

# Session state / cache introspection
node .../plugin/scripts/session-hydrate.mjs
node .../plugin/scripts/pre-check.mjs --report
```

## For issues not on this list

If you hit a problem that is not described here, capture it in a support bundle (v1.5 — the
`/mmo:support-bundle` command) and file an issue. The bundle redacts secrets and includes
enough context (versions, git status, last few runs) to diagnose the report.
