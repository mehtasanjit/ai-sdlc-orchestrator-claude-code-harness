# Coexistence with other AI tools and existing tooling

> **For:** teams already using Cursor, Aider, Copilot, custom MCP servers. **Also see:** [brownfield.md](brownfield.md) · [brownfield-write-contract.md](brownfield-write-contract.md).

The plugin is a guest in a house that may already have residents. Cursor, Aider, GitHub
Copilot, a custom internal MCP server, existing pre-commit hooks, existing CI, existing
linters and formatters — all of these are things this plugin **coexists with, never replaces
or reconfigures**.

## Four types of coexistence

Real repos have four flavors of overlap with what the plugin does:

| Type | Example | Behavior |
|---|---|---|
| **Adjacent** | You use Cursor for editor autocomplete; the plugin handles SDLC | Zero conflict. Both tools run in different contexts. |
| **Overlapping** | You also use Aider or a custom code-gen script | Coexists at rest; **don't run them simultaneously on the same files.** The plugin does not detect a concurrent Aider session. |
| **Layered** | Your existing Claude Code setup already registers MCP servers (custom Gemini adapter, etc.) | Claude Code namespaces plugin MCP tools separately (`mcp__plugin_mmo_...`). Both coexist. |
| **Configured** | Your repo ships `routing-policy.yaml` at root, overriding the plugin's default policy | The plugin's policy loader **silently honors your file** — discovery surfaces this at Gate 0 so it's never a surprise. |

## Per-tool detection (v1 — presence only)

Tier 1 discovery detects the **presence** of these paths but does not deep-parse them in v1
(per §7.9 C7 cut — deep parsing lands in v1.5). Anything detected defaults to OFF-LIMITS at
Gate 0:

- `.claude/` — your Claude Code project config
- `.claude/settings.json`, `.claude/settings.local.json`
- `CLAUDE.md`, `CLAUDE.local.md`
- `.mcp.json`
- `.cursor/`, `.cursor/rules/`, `.cursorrules`
- `.aider.conf.yml`, `.aider.conf.yaml`, any `.aider*` dotfile
- `.continue/`
- `.github/copilot-instructions.md`
- `.roo/`
- `**/routing-policy.yaml` — surfaced at Gate 0 because it silently changes plugin routing
- `**/gemini*.{yaml,json}` outside `node_modules/` / `dist/`

**Default off-limits means:** the write contract refuses any `Write` or `Edit` against these
paths regardless of what an intent's file scope says. If you explicitly want the plugin to
edit one — say, updating `CLAUDE.md` with new project notes — you move it from off-limits to
allowlist by editing Gate 0's proposal.

## v1.5 deep-parsing preview

Planned for v1.5:

- **Cursor** — parse `.cursor/rules/*.mdc` for `globs:` frontmatter. When any rule's glob
  intersects the plugin's file scope for this run, print a warning at Gate 0 so Cursor
  autocomplete does not silently fight the plugin's edits.
- **Aider** — check `.aider.conf.yml` for `auto_commits: true`. If enabled, warn that running
  Aider alongside the plugin may tangle git history.
- **Copilot** — read `.github/copilot-instructions.md` for length + basic content. Note at
  Gate 0 that Copilot suggestions in an editor session will still fire during the plugin's
  run.
- **Custom MCP servers** — parse `.mcp.json` server names and flag any that look generation-
  related (`codegen`, `gemini`, `openai`, `codellama`, etc.).
- **`routing-policy.yaml` diff** — print the specific rules that differ between yours and the
  plugin's default, so the routing change is visible before the run starts.

None of these are v1. In v1, presence detection + default off-limits is enough to guarantee
safety.

## Non-AI tools

The plugin coexists with your normal development tools too:

- **`.gitignore`** — honored. Discovery skips ignored paths via `git check-ignore`. Writes
  into ignored paths are refused unless you explicitly override at Gate 0.
- **Formatters / linters** — if your repo has `prettier`, `eslint`, `black`, `ruff`, `gofmt`,
  etc. configured, the plugin runs the **project's own** format command on files it wrote
  before closing a packet. The plugin ships no formatters of its own — it uses whatever you
  use.
- **Pre-commit hooks** — fire normally through `git commit` when `commit_strategy != none`.
  The plugin **never** uses `--no-verify`.
- **CODEOWNERS** — read by discovery only for regulated-repo signals (owners such as a
  security, compliance or privacy team), which Gate 0 then names. No step checks a packet's
  file against its owners, and nothing is held for them: merge governance stays with GitHub,
  and the plugin does not enforce ownership.
- **Existing CI** — the plugin never installs workflow files unless the intent explicitly
  asks for it (e.g. `feature-new` intent producing `.github/workflows/deploy.yml`). When it
  does add CI, it deep-merges into existing files per the write-contract merge rules — never
  replaces.

## Concerns and what to do

| Concern | What actually happens | What to do |
|---|---|---|
| I use Cursor for autocomplete and the plugin edits `src/` — will they fight? | In v1 the two tools do not detect each other. Running both simultaneously (Cursor's edit session open while the plugin writes) can produce merge conflicts in Cursor. | Close Cursor's edit session during a plugin run, or run the plugin on a different branch. |
| I have a custom MCP server that also uses Gemini — will they compete? | No. Claude Code namespaces plugin MCP tools (`mcp__plugin_mmo_...`). Your MCP server keeps its own tool names. The plugin's dispatcher never calls your MCP — it uses the bundled server. | Nothing. |
| I have a `routing-policy.yaml` at repo root for other AI tooling. | The plugin's policy loader picks it up and honors it. Discovery surfaces this at Gate 0 so the override is visible before the run starts. | To use the shipped default instead, pass `--policy opus-plus-flash` at run start, or write `.sdlc/project.json.default_policy` via `/mmo:policy change`. |
| My pre-commit hooks are strict (typecheck, format-check, security-scan) — will the plugin's writes pass? | The plugin runs the project's own format command on written files before closing a packet, so what lands is already formatted. Typecheck and security scan run at commit time when `commit_strategy != none`. | Failures halt the plugin cleanly and print the error. Fix, then re-run. |
