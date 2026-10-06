#!/usr/bin/env node
/**
 * Clone-route setup wizard. Checks Node / CLI / keys, builds the MCP server,
 * copies commands + subagents into ./.claude/, writes .mcp.json.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// Imports from verify-setup.mjs so this wizard shares the credential-state
// logic instead of drifting into a second copy.
import {
  buildWorkerEnvironment,
  workerPaths,
  vertexCredentialState,
  inspectCredentialFile,
} from "../plugin/scripts/verify-setup.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Duplicated with verify-setup.mjs's adcPath and the server's defaultAdcPath
// (three package roots that cannot import each other). Sync by hand.
const ADC_FILE = join(homedir(), ".config", "gcloud", "application_default_credentials.json");

// ─── small helpers ────────────────────────────────────────────────────
const c = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", amber: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
const ok    = (m) => console.log(`  ${c.green}✓${c.reset} ${m}`);
const warn  = (m) => console.log(`  ${c.amber}!${c.reset} ${m}`);
const fail  = (m) => console.log(`  ${c.red}✗${c.reset} ${m}`);
// Steps number themselves; one is conditional (agent path).
let stepNo = 0;
const step  = (m) => console.log(`\n${c.bold}[${++stepNo}]${c.reset} ${m}`);
const hint  = (m) => console.log(`  ${c.dim}${m}${c.reset}`);

const rl = createInterface({ input, output });
const ask = (q) => rl.question(`  ${c.dim}?${c.reset} ${q} `);

async function askYesNo(q, defaultYes = true) {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const a = (await ask(`${q} ${suffix}`)).trim().toLowerCase();
  if (a === "") return defaultYes;
  return a === "y" || a === "yes";
}

function which(cmd) {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function nodeMajor() {
  return parseInt(process.versions.node.split(".")[0], 10);
}

// ─── main flow ────────────────────────────────────────────────────────
console.log(`\n${c.bold}AI-SDLC orchestrator — setup${c.reset}`);
console.log(`${c.dim}This wizard checks prerequisites and prepares your machine to run the pipeline.${c.reset}`);

step("Node.js version");
const nv = nodeMajor();
if (nv >= 20) {
  ok(`Node ${process.versions.node}`);
} else {
  fail(`Node ${process.versions.node} — this repo needs Node 20 or newer.`);
  hint("Install the latest LTS from https://nodejs.org, or via nvm: nvm install --lts");
  process.exit(1);
}

step("Claude Code CLI");
if (which("claude")) {
  try {
    const v = execSync("claude --version", { encoding: "utf8" }).trim();
    ok(`Claude Code detected: ${v}`);
  } catch {
    ok("Claude Code CLI detected");
  }
} else {
  fail("Claude Code CLI not found on PATH.");
  hint("Install it and re-run this wizard:");
  hint("  npm install -g @anthropic-ai/claude-code");
  const proceed = await askYesNo("Continue setup anyway (you'll install it before running)?", false);
  if (!proceed) { rl.close(); process.exit(1); }
}

// Auth mode is per-run via /mmo:pass --auth=. This just reports.
step("API keys — availability");
if (process.env.ANTHROPIC_API_KEY) {
  ok("ANTHROPIC_API_KEY is set — --auth=vendor is available.");
} else {
  hint("ANTHROPIC_API_KEY not set — --auth=vendor will abort until it is exported.");
  hint("  Get a key at https://console.anthropic.com/settings/keys, then:");
  hint("  export ANTHROPIC_API_KEY=sk-ant-...");
  hint("--auth=estimated works without an API key when signed in to a Claude Code subscription.");
}
// State computed once and reused by the question below.
const vertex = vertexCredentialState({
  env: process.env,
  serviceAccountFile: process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? inspectCredentialFile(process.env.GOOGLE_APPLICATION_CREDENTIALS)
    : null,
  adcFile: inspectCredentialFile(ADC_FILE),
});
const hasVertex = vertex.state === "credential";

if (hasVertex) {
  ok(`Google Cloud credentials found (${vertex.source}) — opus-plus-flash routes Gemini`);
  hint("  through Gemini Enterprise Agent Platform, the service formerly called Vertex AI.");
} else if (process.env.GEMINI_API_KEY) {
  ok("GEMINI_API_KEY is set — opus-plus-flash routes Gemini through AI Studio.");
} else if (vertex.state === "broken") {
  // Reported ahead of "no credentials" — different problem, different fix.
  warn("A Google credential is configured but cannot be used:");
  hint(`  ${vertex.detail}`);
  hint("  Fix that file, or run: gcloud auth application-default login");
} else {
  hint("No Gemini credentials. Only needed for the opus-plus-flash policy.");
  hint("  Google Cloud (no key): gcloud auth application-default login");
  hint("  AI Studio key:         https://aistudio.google.com/app/apikey");
  if (vertex.state === "project-only") {
    hint(`  GOOGLE_CLOUD_PROJECT is set ('${process.env.GOOGLE_CLOUD_PROJECT}'), but a project ID`);
    hint("  says where to bill, not who is asking — it is not a credential on its own.");
  }
}

// Only asked when Vertex credentials are visible — the Antigravity SDK is
// ADC-only, so this question cannot resolve on an AI-Studio-only install.
step("How Gemini works on the mechanical tier");
let geminiAsAgent = false;
if (!hasVertex) {
  hint("No Google Cloud credentials, so the mechanical tier has one door for now.");
  hint("  The other one — Gemini as an agent, through the Antigravity SDK — signs with");
  hint("  Google Cloud credentials only. To open it later:");
  hint("    gcloud auth application-default login");
  hint("    npm run verify -- --enable-agent");
} else {
  console.log(`
  Gemini can work two ways here. Both bill the same Google Cloud project.

    ${c.bold}As a model${c.reset}  — through ${c.bold}Gemini Enterprise Agent Platform${c.reset} (formerly Vertex AI),
                  Google's own API for the model. Claude reads your code and sends
                  it over, Gemini sends text back. Cheap and predictable: one
                  request, one answer, per task. Nothing to install.

    ${c.bold}As an agent${c.reset} — through Google's ${c.bold}Antigravity SDK${c.reset}, signing against that same
                  project. Gemini opens the folder itself, runs commands and edits
                  files, and Claude reviews the result. It needs Python 3.10+ and
                  the Antigravity SDK, a Python package this wizard installs for
                  you. It costs several times more per task: an agent re-sends the
                  whole conversation on every tool call, on top of a fixed
                  multi-thousand-token preamble it carries every turn.

  The model path is the default, and it is the right answer for most work. Pick
  the agent path when you want Gemini to do the work rather than describe it.
`);
  hint("You can change this later, either way round:");
  hint("  npm run verify -- --enable-agent    # agent path (builds what it needs)");
  hint("  npm run verify -- --disable-agent   # back to the model path");
  geminiAsAgent = await askYesNo("Set up the Antigravity SDK agent path as well?", false);
  if (geminiAsAgent) {
    ok("Antigravity SDK agent path selected — this wizard will build the Python worker environment.");
  } else {
    ok("Model path selected — no Python needed.");
  }
}

step("Bundled MCP server dependencies");
const mcpDir = join(ROOT, "plugin", "mcp", "model-dispatch");
// The server ships pre-built and committed (bundle/server.mjs and bundle/lib.mjs), so a clone
// needs no install or build to run it; npm install + build are only for a copy whose bundle is missing.
if (existsSync(join(mcpDir, "bundle", "server.mjs")) && existsSync(join(mcpDir, "bundle", "lib.mjs"))) {
  ok("MCP server ready (it ships pre-built).");
} else {
  console.log(`  Installing dependencies and building the MCP server...`);
  try {
    execSync("npm install", { cwd: mcpDir, stdio: "inherit" });
    execSync("npm run build", { cwd: mcpDir, stdio: "inherit" });
    ok("MCP server built successfully.");
  } catch {
    fail("MCP server build failed. See the output above.");
    hint("You can retry with: cd plugin/mcp/model-dispatch && npm install && npm run build");
    rl.close();
    process.exit(1);
  }
}

// buildWorkerEnvironment lives in verify-setup.mjs — one implementation used
// by both install routes.
if (geminiAsAgent) {
  step("Antigravity agent worker (Python)");
  const { venvPython } = workerPaths(join(ROOT, "plugin"));
  if (existsSync(venvPython)) {
    // Present ≠ working; `npm run verify` probes it and repairs.
    ok("Worker environment already present.");
    hint("If the agent path later fails to start: npm run verify -- --fix");
  } else {
    const built = buildWorkerEnvironment(join(ROOT, "plugin"), (m) => console.log(m));
    if (built.ok) {
      ok(`Antigravity SDK installed into the worker's own environment — ${built.detail}.`);
    } else {
      fail(built.detail.split("\n")[0]);
      for (const line of built.detail.split("\n").slice(1)) hint(line);
      if (built.reason === "no-python") hint("  brew install python@3.12   # then: npm run setup");
      warn("Continuing on the model path — nothing else in this wizard needs Python.");
      // Load-bearing: also gates the MMO_SELECT write below.
      geminiAsAgent = false;
    }
  }
}

step("Project-install the slash command + all subagents");
// Copied into ./.claude/ so plain `claude` (no --plugin-dir) discovers them
// in both interactive and headless modes.
const projClaude = join(ROOT, ".claude");
mkdirSync(join(projClaude, "commands"), { recursive: true });
mkdirSync(join(projClaude, "agents"),   { recursive: true });
copyFileSync(
  join(ROOT, "plugin", "commands", "pass.md"),
  join(projClaude, "commands", "pass.md"),
);
for (const a of ["orchestrator", "architect", "senior-reviewer", "security-reviewer", "brownfield-orchestrator", "brownfield-architect", "brownfield-senior-reviewer", "brownfield-security-reviewer"]) {
  copyFileSync(
    join(ROOT, "plugin", "agents", `${a}.md`),
    join(projClaude, "agents",   `${a}.md`),
  );
}
ok("Slash command + all subagents installed under ./.claude/");

// Bare `model-dispatch` key: clone-route servers keep their key
// verbatim (mcp__model-dispatch__*). Plugin route namespaces to
// mcp__plugin_mmo_model-dispatch__*. The
// orchestrator's frontmatter grants both spellings.
const mcpJsonPath = join(ROOT, ".mcp.json");
const mcpEntry = {
  mcpServers: {
    "model-dispatch": {
      command: "node",
      args: [join(ROOT, "plugin", "mcp", "model-dispatch", "bundle", "server.mjs")],
      // Stdio MCP servers inherit nothing — every variable the server reads
      // must be forwarded explicitly.
      env: {
        ...Object.fromEntries(
          [
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "GOOGLE_CLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
            "GEMINI_BACKEND",
            "MMO_SELECT",
            "SDLC_SELECT", // MMO-D8 compat shim — pre-rename installs still export this
            "GEMINI_WORKER_PYTHON",
            "MMO_LOG_LEVEL",
            "MMO_VERBOSE",
            "MMO_LOG_PREFIX",
          ]
            .filter((name) => process.env[name])
            .map((name) => [name, process.env[name]]),
        ),
        // Answer to the agent-path question, persisted for the future Claude
        // Code session. Written only when agent selected, so model-path
        // .mcp.json is unchanged from before this question existed. Spread
        // order: this wins over an inherited MMO_SELECT (more recent intent).
        ...(geminiAsAgent ? { MMO_SELECT: "gemini-flash=flash-agsdk-worker" } : {}),
      },
    },
  },
};
writeFileSync(mcpJsonPath, JSON.stringify(mcpEntry, null, 2) + "\n");
ok(".mcp.json written — plain `claude` will discover the MCP server.");
if (geminiAsAgent) {
  ok("Mechanical tier set to the agent path (MMO_SELECT=gemini-flash=flash-agsdk-worker).");
  hint("  To go back to the model path: npm run verify -- --disable-agent");
}

step("Ready");
console.log(`
  ${c.bold}Setup complete.${c.reset} Pick an auth mode per run via --auth on /mmo:pass.

  ${c.bold}Interactive${c.reset} (recommended for first run — you see HITL gates):
    ${c.dim}# --permission-mode acceptEdits auto-approves file reads/writes${c.reset}
    ${c.dim}# inside this repo so the run only stops at the four HITL gates.${c.reset}
    claude --permission-mode acceptEdits
    ${c.dim}# then at the prompt (vendor mode — needs ANTHROPIC_API_KEY):${c.reset}
    > /mmo:pass --auth=vendor --run-id=pass1 examples/workforce-ops/brief.md
    ${c.dim}# or estimator mode (subscription auth, no API key required):${c.reset}
    > /mmo:pass --auth=estimated --run-id=pass1 examples/workforce-ops/brief.md

  ${c.bold}Headless${c.reset} (unattended, captured to a log file):
    ${c.dim}# opus-only baseline under vendor mode${c.reset}
    claude --print "/mmo:pass --auth=vendor --run-id=pass1 examples/workforce-ops/brief.md" \\
      --permission-mode acceptEdits \\
      --output-format stream-json --verbose \\
      > examples/workforce-ops/passes/pass1/live-run.log
    ${c.dim}# keep live-run.log: its last line is Claude Code's own cost receipt. It is written when${c.reset}
    ${c.dim}# claude exits, so verify the run's true cost against it AFTER the command returns (idempotent):${c.reset}
    node plugin/scripts/collect-orchestrator-usage.mjs examples/workforce-ops/passes/pass1 --project-root "$(pwd)"

    ${c.dim}# opus + Gemini Flash multi-model under vendor mode${c.reset}
    claude --print "/mmo:pass --auth=vendor --policy=opus-plus-flash --run-id=pass2 examples/workforce-ops/brief.md" \\
      --permission-mode acceptEdits \\
      --output-format stream-json --verbose \\
      > examples/workforce-ops/passes/pass2/live-run.log

  ${c.dim}Wall-clock per pass: about 1 – 1.5 hours.${c.reset}

  After a run finishes, print a summary with:
    node tools/report.mjs examples/workforce-ops/passes/pass1

  To run the pipeline against a brief other than the shipped one, copy
  docs/brief-template.md, fill it in, and invoke:
    /mmo:pass --auth=vendor --study=<your-project> --run-id=pass1 path/to/your-brief.md

  Full docs are in docs/. Start with docs/running.md.
`);

rl.close();
