# AI-SDLC plugin — documentation

Everything the [main README](../README.md) couldn't fit. Grouped by what you're trying to do — a tutorial to learn, how-to guides to accomplish, reference to look up, concepts to understand.

Start with the tutorial if you have not run the plugin before. Skip straight to the how-to guides if you already know what you want to do. New to the codebase itself rather than the plugin's usage? Start with [Repo overview](repo-overview.md).

## Tutorial

Learn by doing. Follow along top to bottom, no prior knowledge assumed.

| Doc | For |
|---|---|
| [Your first `/mmo:greenfield`](tutorial-first-run.md) | Ten minutes from a fresh install to a completed greenfield pass with real telemetry and a cost report. |

## How-to guides

Direct, imperative. Each guide gets a specific job done.

| Doc | For |
|---|---|
| [Install & credentials](setup.md) | Setting up a fresh install: prerequisites, Anthropic and Gemini providers, the per-project policy pick. |
| [Run a pass](running.md) | Every flag on `/mmo:pass` explained — greenfield mode and brownfield mode, interactive and headless. |
| [Bring your own brief](brief-template.md) | Writing a project brief in the section layout the requirements phase expects. |
| [Brownfield walkthrough](brownfield.md) | Running `/mmo:brownfield` on an existing repo — the seven job types and the Gate 0 confirmation. |

## Reference

Look things up. Exact answers, exhaustive.

| Doc | For |
|---|---|
| [Troubleshooting](troubleshooting.md) | Symptom → cause → fix, keyed by the error message on screen. |
| [Brownfield setup issues (17 known)](brownfield-setup-issues.md) | Every install-time issue that has hit real users and how the plugin handles each. |
| [Understanding output](understanding-output.md) | Reading `telemetry.jsonl`, `manifest.json`, `provenance.json`, and the cost report. |
| [Logging](logging.md) | The `MMO:` log stream — format, levels, taxonomy, enablement, redaction. |

## Concepts

Reasoning-forward. Understand why the pieces are shaped the way they are.

| Doc | For |
|---|---|
| [Architecture](architecture.md) | Plugin surface, MCP server, adapters, telemetry, auth modes — how a request flows through the plugin. |
| [Cost study: Opus + Flash vs Opus-only](cost-study/README.md) | Every measured run (16–25 Sep 2026), what each fix changed, and the current verdict, in plain English. |
| [Methodology](methodology.md) | How tokens and costs are derived; vendor-authoritative vs estimated; what each plugin version changed about the numbers. |
| [Two Gemini paths](two-gemini-paths.md) | Model door vs agent door, side-by-side on the same brief. |
| [Brownfield write contract](brownfield-write-contract.md) | How the "never touch off-limits" guarantee is enforced at the tool boundary. |
| [Brownfield model routing](brownfield-routing.md) | Which model runs which phase and why the mechanical tier can drop cost by ~10×. |
| [Brownfield coexistence](brownfield-coexistence.md) | Living alongside Cursor, Aider, Copilot, and custom MCP servers. |
| [Brownfield privacy](brownfield-privacy.md) | What leaves the machine, per phase. On-prem routing, PII handling, audit trail. |

## For maintainers

- [Contributing](../CONTRIBUTING.md) — style rules, PR process, base branch.
- [Docs restructure v2 plan](planning/docs-restructure-v2.md) — the deeper reorganization (renames into `tutorial/how-to/reference/concepts/` + a hosted docs site) that Level 1 leaves room for. Not active work.
