# Repo guide

This repository holds `mmo` (Multi-Model Orchestrator) v0.7.3 — a Claude Code plugin that runs a
full software-delivery pipeline against a brief (requirements → design → code → senior review →
tests → security review), routes each phase to the model that fits it, and records what each phase
cost — plus the harness, tests and documentation that ship it.

Two things live here, and telling them apart makes the rest of the layout obvious:

- **The plugin** — everything under `plugin/`. This is what gets installed into Claude Code.
- **The harness around it** — `tools/`, `docs/`, `examples/` and the root manifest. Build scripts,
  the test suite, reference briefs and recorded runs. None of it is installed; it is how the plugin
  is developed and how its results are published.

If you only want to *use* the plugin, [README.md](../README.md) is the shorter road. This page is
for reading or changing the code.

## Top-level layout

| Path | What it holds |
|---|---|
| `plugin/` | The installable plugin: slash commands, subagents, skills, routing policies, the bundled MCP server, the policy console, hooks and scripts. |
| `tools/` | Repo-side scripts and the root test suite — setup, cost reporting, log formatting. |
| `docs/` | User and contributor documentation, plus specs, planning notes and recorded walkthroughs. |
| `examples/` | Four project briefs (`unit-convert`, `quick-demo`, `workforce-ops`, `travel-ops`), plus the recorded output of two runs against `quick-demo` — one model-path, one agent-path — under `examples/quick-demo/passes/`. |
| `.claude-plugin/marketplace.json` | Marketplace manifest that makes this repo installable through `/plugin install`. |
| `package.json` | Root manifest. Owns `npm test`, `npm run setup`, `npm run report`, `npm run verify`. |
| `README.md` · `SETUP.md` · `CONTRIBUTING.md` · `CLAUDE.md` · `SECURITY.md` | What the plugin does, how to install it, how to contribute, the writing rules, the disclosure policy. |
| `.sdlc/` | Appears once you run the plugin in a folder: telemetry, manifests, per-run artifacts. Git-ignored, never source. |

## The three packages

| Package | Root | Stack | What it does |
|---|---|---|---|
| `ai-sdlc-orchestrator-claude-code-harness` | `.` | Node ESM, Node 20+, one runtime dependency (`yaml`) | The repo harness — setup, cost reporting, and the test suite that guards everything else. |
| `@mmo/model-dispatch` | `plugin/mcp/model-dispatch` | TypeScript, compiled by `tsc` into `dist/`, Node 20+ | The bundled MCP server. Loads the routing policy, picks a model per unit of work, calls the vendor SDK, records tokens and cost. |
| `@mmo/policy-console` | `plugin/policy-console` | Node ESM, Node 20+, no framework, one dependency (`yaml`) | A local web page for picking or authoring a routing policy. One HTML file plus a small http server. |

No workspace manifest ties the three together — there is no pnpm workspace, no Nx, no Turborepo,
no Lerna. Each package carries its own `package.json`, its own `node_modules/` and its own test
command, and you install and test each one where it lives. Installing at the root does not reach
into the other two.

### The optional Python worker

`plugin/mcp/model-dispatch/worker/gemini_worker.py` is a fourth, optional piece: the agent behind
the `antigravity-worker` adapter. It needs Python 3.10 or newer and the `google-antigravity`
package (floor `>=0.1.7`, not a pin), both recorded in `worker/requirements.txt`. Its virtualenv is
built on demand by `plugin/scripts/verify-setup.mjs --enable-agent` and is git-ignored.

You need it only for the agent path, where the cheap tier — the mechanical phases the policy routes
away from Claude — runs as a full agent session with tools and a working directory. On the model
path, one API call per unit of work, nothing here is installed and nothing here runs.

## Entry points

| File | Reach for it when |
|---|---|
| `tools/setup.mjs` | Installing from a clone rather than the marketplace. Checks prerequisites, installs and builds the MCP server, writes `.mcp.json`. Also `npm run setup`. |
| `tools/report.mjs` | Rendering the cost report for a finished run: `node tools/report.mjs <pass-dir>`, or `npm run report -- <pass-dir>`. Add `--markdown` for a file-ready version. |
| `plugin/mcp/model-dispatch/src/server.ts` | Reading or changing the MCP server. Claude Code launches the compiled `dist/server.js`; the source is here. One adapter per model surface sits in `src/adapters/`. |
| `plugin/policy-console/policy-server.mjs` | Serving the policy console on `127.0.0.1`. Normally started for you by `plugin/scripts/setup-policy.mjs`. |
| `plugin/mcp/model-dispatch/worker/gemini_worker.py` | Debugging the agent path. The MCP server spawns it; you do not start it by hand. |

## Inside `plugin/`

| Path | What it holds |
|---|---|
| `commands/` | 13 slash commands, one Markdown file each, all namespaced `/mmo:` — `greenfield.md`, `brownfield.md`, `pass.md`, seven per-job aliases, plus `setup.md`, `policy.md` and `revert.md`. |
| `agents/` | 5 subagent definitions: `orchestrator`, `architect`, `discovery`, `senior-reviewer`, `security-reviewer`. |
| `skills/` | Playbooks a subagent reads at run time. `pipeline/SKILL.md` carries the state machine, the task-packet schema (one packet per unit of work, the unit that gets routed to a model) and the approval gates; `brownfield-guide/SKILL.md` covers work on an existing repo. Per-stack guidance lives in `skills/pipeline/stacks/`. |
| `config/policies/` | Routing policies as YAML — the directory listing is the authoritative preset set (`opus-plus-flash.yaml` is the default). A policy maps each phase to a model, prices each model, and sets the run's cost cap. |
| `config/intents.json` | The seven brownfield job types. |
| `mcp/model-dispatch/` | The MCP server package (see the table above). |
| `policy-console/` | The policy console package. |
| `scripts/` | Node scripts the commands shell out to — setup checks, credential discovery, the write-contract hook, provenance recording, run logging. |
| `hooks/` | `hooks.json` registers two: a `PreToolUse` write-contract check that refuses edits outside an approved file list, and a `PostToolUse` telemetry heartbeat. |
| `templates/` | Fragments copied into a target project, such as the `.gitignore` entry for run artifacts. |
| `examples/` | Sandbox projects you point the plugin at by hand — six tiny apps, one per brownfield job type — plus copies of the four example briefs, which live here because only `plugin/` is copied on install. |

## Running the tests

From the repo root:

```bash
npm install
npm test
```

`npm test` expands to `node --test tools/test/*.test.mjs && node tools/test-mcp.mjs`. The 17 files
under `tools/test/` cover setup, command wiring, the write-contract hook, logging, reporting and
the writing style. The suite is offline — no API key, no network call, no cost.

`tools/test-mcp.mjs` chains the MCP server's own suite onto the end. That suite compiles TypeScript
first, so it needs the server's dependencies installed:

```bash
cd plugin/mcp/model-dispatch
npm install
npm test        # npm run build && node --test test/*.test.mjs
```

When `plugin/mcp/model-dispatch/node_modules/` is absent, `tools/test-mcp.mjs` prints a notice
naming the package it skipped and exits 0. Green output alone does not mean the server was tested
— read the tail of the run, or run `npm run verify -- --fix` once, which installs the server's
dependencies, builds it, and rebuilds the Python worker's virtualenv if the agent path is enabled.

## The style gate

`CLAUDE.md` sets the writing rules for docs and source comments: second person, present tense,
tables for reference material, and a list of banned marketing words. `tools/test/style.test.mjs`
enforces them, so a documentation change can fail `npm test` on wording alone.

Excluded from the check: `SETUP.md` and everything under `plugin/commands/`, `plugin/agents/` and
`plugin/skills/`, which are instruction files addressed to Claude, where third-person phrasing is
correct. Historical records under `docs/walkthroughs/` and `examples/*/passes/` are excluded too.

Run `npm test` before you open a pull request. It is offline and free.

## Where to go next

| Doc | For |
|---|---|
| [README.md](../README.md) | What the plugin does, the install flow, the full command list. |
| [docs/README.md](README.md) | The documentation index — tutorial, how-to guides, reference, concepts. |
| [docs/architecture.md](architecture.md) | How a request flows end to end: plugin surface, MCP server, routing, adapters, telemetry, auth modes. |
| [docs/methodology.md](methodology.md) | Where the token counts and dollar figures come from, and what each auth mode changes. |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Scope, how to submit, commit messages, code and writing style. |
