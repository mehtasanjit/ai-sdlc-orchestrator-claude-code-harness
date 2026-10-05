/**
 * The workflow's own steps in a zero-touch run: what the hook answers for without a permission prompt, and which
 * model-server calls carry the person's policy (plugin/scripts/ambient/lib/own-steps.mjs).
 *
 *   - Every one-line script call the workflow texts tell Claude to run (plugin/agents, commands and skills) is one of
 *     the workflow's own steps. A brownfield feature run's orchestrator (brownfield-orchestrator) also wraps
 *     long calls over lines and chain bookkeeping with &&, and only their calls are read that way: every other caller
 *     keeps the one-call check, so greenfield's and the other jobs' answers are develop's.
 *   - Every model-server tool that takes a policy file reaches the stamp: the zero-touch plugin's matcher sends it to
 *     the stamp's hook, and the hook's own list leaves it to that hook, so one call never gets two answers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const PLUGIN = join(ROOT, "plugin");
const SCRIPTS = join(PLUGIN, "scripts");
const { featureRunAgent, ownScriptCall, serverCommands, STAMPED_TOOLS } = await import(join(SCRIPTS, "ambient", "lib", "own-steps.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? markdownFiles(p) : name.endsWith(".md") ? [p] : [];
  });
}

/** Each call of one of the plugin's scripts in the workflow texts, with the lines a trailing backslash continues. */
function scriptCalls() {
  const calls = [];
  for (const file of ["agents", "commands", "skills"].flatMap((d) => markdownFiles(join(PLUGIN, d)))) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[a-z0-9._-]+\.mjs"/.test(lines[i])) continue;
      const parts = [lines[i]];
      while (/\\\s*$/.test(parts[parts.length - 1]) && i + 1 < lines.length) parts.push(lines[++i]);
      calls.push({ file, where: `${relative(ROOT, file)}:${i + 2 - parts.length}`, text: parts.join("\n").trim() });
    }
  }
  return calls;
}

// The texts a feature run's agents follow: their own agent files and the packet flow the orchestrator copy reads.
const FEATURE_TEXTS = new Set(["brownfield-orchestrator.md", "brownfield-features.md"]);

test("every script call the workflow texts give Claude is a step: one-line calls for every agent, wrapped calls for a feature run's agents only", () => {
  const calls = scriptCalls();
  assert.ok(calls.length >= 30, `the texts' script calls are found (${calls.length})`);
  assert.ok(calls.some((c) => c.text.includes("\\\n") && !FEATURE_TEXTS.has(basename(c.file))), "develop's own texts wrap some calls over lines");
  for (const c of calls) {
    // As Claude runs it: the plugin's real folder, and a plain word wherever the text shows a placeholder.
    const command = c.text.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN).replace(/<[^>\n]*>/g, "x").replace(/\[([^\]\n]*)\]/g, "$1");
    if (FEATURE_TEXTS.has(basename(c.file))) assert.equal(ownScriptCall(command, SCRIPTS, { joined: true }), true, `${c.where}: ${c.text.split("\n")[0]}`);
    // Every other text is read by develop's one-call check: a one-line call is a step, a wrapped one is not (as on develop).
    else assert.equal(ownScriptCall(command, SCRIPTS), !command.includes("\n"), `${c.where}: ${c.text.split("\n")[0]}`);
  }
});

test("a feature run's agents are told apart by the hook payload's agent_type; no other caller is", () => {
  for (const t of ["mmo:brownfield-orchestrator", "brownfield-orchestrator", "Brownfield Orchestrator"]) assert.equal(featureRunAgent(t), true, t);
  for (const t of ["mmo:orchestrator", "orchestrator", "mmo:architect", "general-purpose", "", undefined]) assert.equal(featureRunAgent(t), false, String(t));
});

test("a feature run's wrapped call is joined as the shell joins it; any other backslash or line end is not a step", () => {
  const log = `node "${SCRIPTS}/mmo-log.mjs" --event=phase.start --level=info`;
  const fr = { joined: true };
  assert.equal(ownScriptCall(`${log} \\\n  --run-id=r1 --project-root "$(pwd)"`, SCRIPTS, fr), true, "a backslash just before a line feed joins the lines");
  assert.equal(ownScriptCall(`${log} \\\n  --run-id=r1`, SCRIPTS), false, "for every other caller the wrapped form stays develop's: not a step");
  assert.equal(ownScriptCall(`${log} \\\r\n  --run-id=r1`, SCRIPTS, fr), false, "after a backslash and a carriage return the line feed still ends the command");
  assert.equal(ownScriptCall(`${log} \\\r\ntouch x`, SCRIPTS, fr), false, "so a second command cannot ride on a Windows line end");
  assert.equal(ownScriptCall(`${log}\n--run-id=r1`, SCRIPTS, fr), false, "a line feed without a backslash is two commands");
  assert.equal(ownScriptCall(`${log} \\\n; rm -rf ~`, SCRIPTS, fr), false, "the joined call is checked like any other");
  assert.equal(ownScriptCall(`${log} --title=a\\b`, SCRIPTS, fr), false, "a backslash inside a line is not a step");
  assert.equal(ownScriptCall(`${log} \\`, SCRIPTS, fr), false, "a backslash with nothing after it is not a step");
});

test("a feature run's chain of step calls joined by && is one step; any other part or operator, or any other caller, is not", () => {
  const log = (e) => `node "${SCRIPTS}/mmo-log.mjs" --event=${e} --level=info --run-id=r1 --project-root "$(pwd)"`;
  const prov = `node "${SCRIPTS}/write-provenance.mjs" --after --run-id=r1 --path=src/a.ts --project-root "$(pwd)"`;
  const fr = { joined: true };
  assert.equal(ownScriptCall(`${prov} && ${log("phase.end")} && ${log("gate.open")}`, SCRIPTS, fr), true);
  assert.equal(ownScriptCall(`${prov} && ${log("phase.end")}`, SCRIPTS), false, "not for any other caller (develop's answer)");
  assert.equal(ownScriptCall(`${log("phase.end")} && \\\n  ${log("gate.open")}`, SCRIPTS, fr), true, "wrapped over lines too");
  assert.equal(ownScriptCall(`${log("phase.end")} && rm -rf ~`, SCRIPTS, fr), false, "every part must be a step");
  assert.equal(ownScriptCall(`${log("phase.end")} && && ${log("gate.open")}`, SCRIPTS, fr), false, "an empty part");
  assert.equal(ownScriptCall(`${log("phase.end")} &&`, SCRIPTS, fr), false, "a trailing &&");
  assert.equal(ownScriptCall(`${log("phase.end")} &&& ${log("gate.open")}`, SCRIPTS, fr), false, "&&&");
  assert.equal(ownScriptCall(`${log("phase.end")} || ${log("gate.open")}`, SCRIPTS, fr), false, "|| is not &&");
  assert.equal(ownScriptCall(`${log("phase.end")} & ${log("gate.open")}`, SCRIPTS, fr), false, "a lone & runs in the background");
  assert.equal(ownScriptCall(`${log("phase.end")}; ${log("gate.open")}`, SCRIPTS, fr), false, "; is not &&");
});

// The change spec's steps write only inside the run's own folder, .sdlc/runs/<run-id> (lib/change-spec.mjs
// runFolder; planLint.test.mjs refuses any other), so they are steps like the other bookkeeping scripts.
test("the change spec's section check, its finalize and the fix packets are steps", () => {
  assert.equal(ownScriptCall(`node "${SCRIPTS}/plan-lint.mjs" --section .sdlc/runs/r1/change.sections/units-001.json --run-id r1`, SCRIPTS), true);
  assert.equal(ownScriptCall(`node "${SCRIPTS}/plan-to-packets.mjs" --spec --run-id r1 --intent feature-extend --project-root "$(pwd)"`, SCRIPTS), true);
  assert.equal(ownScriptCall(`node "${SCRIPTS}/findings-to-packets.mjs" --run-id r1 --intent feature-extend --review .sdlc/runs/r1/review-api.json`, SCRIPTS), true);
  assert.equal(ownScriptCall(`node "${SCRIPTS}/plan-lint.mjs" --shape; rm -rf src`, SCRIPTS), false);
});

test("the commands a server call runs are the ones the server will run: typed checks and their write forms, only packets it applies, only the ids a batch names", async () => {
  const pk = (id, apply) => ({ id, artifact_path: `src/${id}.ts`, apply });
  const tool = "mcp__plugin_mmo_model-dispatch__execute_batch";
  const runs = (input) => serverCommands(tool, input, ROOT).commands.map((c) => c.run);
  assert.deepEqual(runs({ packets: [pk("a", { write: true, verify: ["npx biome check '{path}'"] })] }), ["npx biome check 'src/a.ts'"], "no write form is guessed from a check's text");
  assert.deepEqual(runs({ packets: [pk("a", { write: true, verify: ["npx prettier --check {path}"], format: ["npx prettier --write {path} --log-level warn"] })] }), ["npx prettier --check src/a.ts", "npx prettier --write src/a.ts --log-level warn"], "a format the packet names is checked");
  assert.deepEqual(
    runs({ packets: [pk("a", { write: true, checks: [{ id: "lint", run: "lint '{path}'", fix: "lint --write '{path}'" }], baseline_from: "src/style.ts", verify: ["ignored {path}"] })] }),
    ["lint 'src/a.ts'", "lint --write 'src/a.ts'", "lint 'src/style.ts'"],
    "typed checks: each run and its write form on the file, and each run on the style file the server tries first",
  );
  assert.deepEqual(runs({ packets: [pk("a", { write: false, verify: ["rm -rf {path}"] })] }), [], "an apply block the server ignores runs nothing");
  const { mkdtempSync: mk, writeFileSync: wf } = await import("node:fs");
  const dir = mk(join(tmpdir(), "zt-servercmd-"));
  try {
    wf(join(dir, "packets.json"), JSON.stringify([pk("a", { write: true, verify: ["rm -rf {path}"] }), pk("b", { write: true, verify: ["npx tsc --noEmit"] })]));
    assert.deepEqual(serverCommands(tool, { packets_path: "packets.json", packet_ids: ["b"] }, dir).commands.map((c) => c.run), ["npx tsc --noEmit"], "only the packets the call runs");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("every model-server tool that takes a policy file reaches the stamp: the plugin's matcher and the hook's own list name it", { skip: serverBuilt() ?? false }, async () => {
  const home = mkdtempSync(join(tmpdir(), "zt-own-steps-"));
  const p = spawn(process.execPath, [join(PLUGIN, "mcp", "model-dispatch", "dist", "server.js")], { env: { PATH: process.env.PATH, HOME: home, MMO_HANDOFF_TOOLS: "on" }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const waiting = new Map();
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      }
    });
    let next = 1;
    const ask = (method, params = {}) => new Promise((done, fail) => {
      const id = next++;
      waiting.set(id, done);
      setTimeout(() => fail(new Error(`no answer to ${method}`)), 15_000).unref();
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = (await ask("tools/list")).result.tools;
    const takesPolicy = tools.filter((t) => t.inputSchema?.properties?.policy_path).map((t) => t.name);
    assert.ok(takesPolicy.includes("execute_with_model"), `the server's policy-taking tools are found (${takesPolicy.join(", ")})`);
    const groups = JSON.parse(readFileSync(join(ROOT, "zero-touch", "hooks", "hooks.json"), "utf8")).hooks.PreToolUse;
    const stamp = groups.find((g) => g.hooks.some((h) => /\bpre-dispatch$/.test(h.command)));
    assert.ok(stamp, "the zero-touch plugin registers the stamp's hook");
    for (const name of takesPolicy) {
      for (const full of [`mcp__plugin_mmo_model-dispatch__${name}`, `mcp__model-dispatch__${name}`]) {
        assert.match(full, new RegExp(`^(?:${stamp.matcher})$`), `${full} reaches the stamp's hook`);
        assert.match(full, STAMPED_TOOLS, `${full} is left to the stamp's hook`);
      }
    }
  } finally { p.kill(); rmSync(home, { recursive: true, force: true }); }
});
