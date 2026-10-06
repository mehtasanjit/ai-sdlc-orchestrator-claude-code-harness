# Your first `/mmo:greenfield`

Ten minutes end to end. You install the plugin, run it against the shipped one-endpoint demo brief, and end with a small NestJS + Prisma + SQLite app in `./src/`, per-phase telemetry, and a cost report you can read.

**For:** anyone who has not run the plugin before. Follow along top to bottom, no branching.

## What you'll need

- **Node.js 20+** and the **Claude Code CLI** installed. Verify with `node --version` and `claude --version`.
- An **Anthropic API key** (get one at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)) with at least $2 of budget. The demo brief typically costs $0.30–$1 on `opus-plus-flash`, up to $3 on `opus-only`.
- **Optional but recommended:** a **Gemini API key** from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey). Only needed if you want the cost-optimized `opus-plus-flash` policy. Skip for `opus-only`, which needs Anthropic only.

## 1. Install the plugin

Open Claude Code, then paste this exact prompt:

```
Setup this plugin from this repo - https://github.com/tl-ai-labs/ai-sdlc-orchestrator-claude-code-harness
```

Claude Code follows [SETUP.md](../SETUP.md): it registers the marketplace, installs the plugin, builds the bundled MCP server, checks your credentials, and asks whether to enable the Antigravity SDK agent path (only if Google Cloud credentials are present — skip on your first run). At the end, a browser tab opens for the per-project policy pick — click **Save** on `opus-plus-flash` if you have both keys, otherwise pick `opus-only`.

Total time: about 2 minutes on a fresh laptop. Nothing has been spent yet.

## 2. Open a NEW session in an empty folder

Slash commands and plugin MCP servers register when a session starts, not during install. The session that installed the plugin does not yet see `/mmo:greenfield`. Open a fresh one in an empty directory:

```bash
mkdir first-run && cd first-run && claude
```

## 3. Kick off the run

At the Claude Code prompt:

```
/mmo:greenfield
```

The command takes no arguments — it asks. Two questions:

1. **Which brief?** Pick the shipped **quick-demo** brief (a one-endpoint ping service on Express, no database). It's the cheapest and fastest option and the best way to see the pipeline end to end without waiting for large phases.
2. **Which auth mode?** Pick `vendor` — every LLM call is dispatched through the MCP server so telemetry carries real, reconcilable token counts. Requires `ANTHROPIC_API_KEY`.

Before any money is spent, the orchestrator shows you the phase list and the model each phase will run on. Confirm to proceed.

## 4. Approve at the human-in-the-loop gates

The pipeline pauses at four points:

- **Gate 1** — after `requirements.md` is written.
- **Gate 2** — after `design.md` is written.
- **Gate 3** — after `security_review.md` is written.
- **Gate 4** — after the final report.

At each gate, the artifact prints on screen. Read it, then approve to continue or type feedback to redirect the phase. For the quick-demo brief you can approve every gate as-is.

**Wall-clock for the whole run:** about 10 minutes for quick-demo. Longer briefs (`workforce-ops`, `travel-ops`) take an hour or more.

## 5. When it finishes

The output lives under `.sdlc/` (telemetry, manifest, cost report) and `./src/` (the generated application code). Read the cost report:

```bash
node "$(node -p 'require(require("os").homedir()+"/.claude/plugins/installed_plugins.json").plugins["mmo@tilicho-ai-labs"][0].installPath')/../tools/report.mjs" .sdlc
```

Or, if you cloned the repo:

```bash
node tools/report.mjs .sdlc
```

The report shows:

- **Per-phase cost table** — one row per SDLC phase, tokens in / out, cost.
- **Total session cost** — the number this run produced, labeled with its scope. Fresh off a run this is **dispatched work only**: the orchestrator session's own loop (its reasoning, file reads, the growing conversation) never passes through telemetry, and the report says so under the total along with the collector command that measures it. Run that command and the report grows a **true total** — the only figure to quote when comparing setups.
- **Which model ran which phase** — one column shows the policy leaf that dispatched each phase.

Every LLM call is in `.sdlc/telemetry.jsonl` for audit. Every field is documented in [understanding-output.md](understanding-output.md).

## 6. Try the generated app

The `./src/` tree is a runnable NestJS project. From the same folder:

```bash
cd src
npm install
npm run start
```

Then `curl http://localhost:3000/ping` — the response is what the brief asked for.

## What next

- **Understand the numbers.** [understanding-output.md](understanding-output.md) walks every field in `telemetry.jsonl` and the report.
- **Understand the cost.** [methodology.md](methodology.md) explains how tokens and costs are counted, and [brownfield-routing.md](brownfield-routing.md) what `opus-plus-flash` measured against `opus-only`.
- **Run on an existing repo.** [brownfield.md](brownfield.md) covers `/mmo:brownfield`, which extends real code with a non-destructive write contract.
- **Script it.** [running.md](running.md) documents `/mmo:pass`, the headless equivalent — every setting exposed as a flag, for CI or repeat runs.

**See also:** [running.md](running.md) · [understanding-output.md](understanding-output.md) · [troubleshooting.md](troubleshooting.md)
