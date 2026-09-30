# Repo overview

A plain-language map of this repository — what it is, how a run works, and where each piece of code lives. If you want to *use* the plugin, start with the [main README](../README.md) instead; this doc is for orienting yourself in the codebase.

## What this repo builds

A Claude Code plugin named `mmo` (Multi-Model Orchestrator). You install it into Claude Code, point it at a project brief or an existing repo, and it runs a full software-delivery pipeline — requirements, design, code, tests, docs, code review, security review — asking Claude Opus for the parts that need judgment and Gemini Flash for the parts that don't.

Three things ship out of this repo:

| Thing | What it is |
|---|---|
| The plugin | Slash commands, subagents, and a pipeline skill that Claude Code loads at session start. Lives in [plugin/](../plugin/). |
| The MCP server | A small Node/TypeScript server bundled inside the plugin that routes each phase to the right model and records what it cost. Lives in [plugin/mcp/model-dispatch/](../plugin/mcp/model-dispatch/). |
| The docs and examples | Everything under [docs/](.) and [examples/](../examples/) — setup guides, architecture notes, and full recorded runs you can read without spending anything. |

## How a run works, in one paragraph

You type `/mmo:greenfield` (new app) or `/mmo:brownfield` (existing repo). An **orchestrator subagent** reads your brief, breaks the work into phases, and for each phase decides: does this need judgment (Claude Opus, called directly) or is it mechanical (routed through the bundled MCP server to Gemini Flash)? Judgment phases are things like requirements analysis and architecture design. Mechanical phases are things like writing the code for an already-designed module, or generating docs. Every model call — win or fail — gets logged with its token count and cost. At a few points the run stops and asks you to confirm before continuing (a **HITL gate** — human-in-the-loop).

## Repo layout

| Path | What's there |
|---|---|
| [plugin/commands/](../plugin/commands/) | The `.md` files defining each slash command (`/mmo:greenfield`, `/mmo:brownfield`, `/mmo:setup`, the seven brownfield job shortcuts, etc.). |
| [plugin/agents/](../plugin/agents/) | Subagent definitions — orchestrator, architect, discovery, senior-reviewer, security-reviewer. |
| [plugin/skills/pipeline/](../plugin/skills/pipeline/) | The pipeline state machine itself: phases, TaskPacket schema, HITL gates, telemetry contract. The orchestrator reads this to know what to do at each step. |
| [plugin/skills/brownfield-guide/](../plugin/skills/brownfield-guide/) | Guidance specific to running against an existing repo. |
| [plugin/mcp/model-dispatch/](../plugin/mcp/model-dispatch/) | The MCP server: routes a phase to a model per the active policy, calls the Gemini adapter (API key or ADC), logs telemetry. |
| [plugin/config/policies/](../plugin/config/policies/) | YAML policy files — which model runs which phase, retry/escalation rules and fix rounds. `opus-plus-flash.yaml` is the shipped default. |
| [plugin/policy-console/](../plugin/policy-console/) | The small local Next.js app `/mmo:policy change` opens in your browser to author or edit a policy. |
| [plugin/scripts/](../plugin/scripts/) | Node scripts run outside the model loop: setup verification, credential discovery, the brownfield write-contract check, provenance writer, session hydration. |
| [plugin/hooks/](../plugin/hooks/) | Claude Code hooks — currently a telemetry heartbeat written alongside every `execute_with_model` call. |
| [plugin/templates/](../plugin/templates/) | Boilerplate the plugin writes into a target project (a `.gitignore` fragment, a CI settings fragment). |
| [tools/](../tools/) | Repo-level tooling: `setup.mjs` (clone-route installer), `report.mjs` (cost report from a pass directory), and the test suite in `tools/test/`. |
| [docs/](.) | Everything you're reading now — see [docs/README.md](README.md) for the full index. |
| [examples/](../examples/) | Real recorded runs (briefs plus their full `.sdlc/` output) you can read or replay without spending anything: `unit-convert`, `quick-demo`, `workforce-ops`, `travel-ops`. |
| [.sdlc/](../.sdlc/) | Where a run against *this* repo would write its own output — telemetry, manifest, generated files. Present here because this repo has been used to test itself. |

## Key terms

| Term | Meaning |
|---|---|
| **Policy** | A YAML file saying which model tier runs which phase, plus retry and cost-cap rules. Chosen once per project, changeable with `/mmo:policy change`. |
| **TaskPacket** | The unit of work the orchestrator hands to a phase — self-contained instructions plus the context that phase needs. |
| **Tier** | `premium` (Claude Opus, judgment work), `mechanical` (Gemini Flash, routed through the MCP server), or `local` (a plain script, no model call — e.g. running the test suite). |
| **HITL gate** | A stop-and-confirm point. Greenfield has four; brownfield adds a fifth (Gate 0, confirming job scope) before the rest. |
| **Provenance** | The record of every file a run touched, with a pre-run hash, so `/mmo:revert` can undo it cleanly. |

## Where to go next

| If you want to… | Read |
|---|---|
| Install and run the plugin | [README.md](../README.md) |
| Walk through your first run | [docs/tutorial-first-run.md](tutorial-first-run.md) |
| Understand the full plugin file inventory | [docs/architecture.md](architecture.md) |
| See which model runs which phase and why | [docs/brownfield-routing.md](brownfield-routing.md) |
| Read the raw output of a real run | [examples/quick-demo/](../examples/quick-demo/) |
| Contribute a change | [CONTRIBUTING.md](../CONTRIBUTING.md) |
