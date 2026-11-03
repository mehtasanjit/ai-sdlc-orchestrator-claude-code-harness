/**
 * Thinking steps routed by the policy (judgment.ts). Pinned:
 *   - a Claude rule spends nothing and hands the step back to the session;
 *   - an agent works in a clone: its outputs come back, any other edit does not, the clone is removed;
 *   - one fix round with the problems sent back, then a fallback marked in telemetry;
 *   - a brownfield step writes only under .sdlc/;
 *   - the architects' sections go through code's own checks, the header first, none sent twice.
 *
 * Real temp git repositories and a fake agent; no model call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cloneWorkspace, executeJudgment, outputProblem, roleInstructions, JUDGMENT_ROLES } from "../dist/judgment.js";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const CLAUDE = { id: "opus", adapter: "builtin-anthropic", model_name: "claude-opus-5-5" };
const AGENT = { id: "argon", adapter: "antigravity-worker", model_name: "gemini-4-argon" };
const COMPLETION = { id: "flash", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" };

function repo() {
  const root = mkdtempSync(join(tmpdir(), "mmo-judg-repo-"));
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(root, "src.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return root;
}

const result = (over = {}) => ({ result: null, tokens: { input: 10, input_cached: 0, output: 5 }, cost_usd: 0.01, latency_ms: 1, cache_hit: false, success: true, ...over });

function deps(model, agent, over = {}) {
  const calls = { dispatch: [], record: [], submit: [], lint: [], finalize: 0 };
  const scratch = mkdtempSync(join(tmpdir(), "mmo-judg-scratch-"));
  return {
    calls,
    scratch,
    d: {
      pluginRoot: PLUGIN_ROOT,
      route: () => ({ model, reason: "test rule" }),
      dispatch: async (packet, workDir) => {
        calls.dispatch.push({ packet, workDir });
        const r = await agent(workDir, calls.dispatch.length, packet);
        return { result: r ?? result(), events: [{ phase: packet.phase, model: model.model_name, cost_usd: 0.01 }] };
      },
      record: (evs) => calls.record.push(...evs),
      submitSection: async (_dir, section, file) => { calls.submit.push([section, file]); return { ok: true, problems: [] }; },
      finalizeSpec: async () => { calls.finalize++; return { ok: true, problems: [] }; },
      lintSection: (file) => { calls.lint.push(file); return { ok: true, problems: [] }; },
      log: () => {},
      scratchParent: scratch,
      ...over,
    },
  };
}

const args = (root, over = {}) => ({ role: "senior-reviewer", prompt: "review it", outputs: ["out/review.json"], project_root: root, run_id: "r1", ...over });

test("a Claude rule hands the step back to the session and spends nothing", async () => {
  const root = repo();
  const { d, calls } = deps(CLAUDE, () => assert.fail("no dispatch"));
  const r = await executeJudgment(args(root), d);
  assert.equal(r.route, "claude");
  assert.equal(r.fallback, false);
  assert.equal(r.model, "claude-opus-5-5");
  assert.equal(calls.dispatch.length, 0);
});

test("a leaf called as a model, not an agent, is a fallback with nothing spent", async () => {
  const root = repo();
  const { d, calls } = deps(COMPLETION, () => assert.fail("no dispatch"));
  const r = await executeJudgment(args(root), d);
  assert.equal(r.route, "claude");
  assert.equal(r.fallback, true);
  assert.match(r.reason, /cannot read the project as an agent/);
  assert.equal(calls.dispatch.length, 0);
});

test("an agent's declared outputs come back; any other edit stays in the clone, which is removed", async () => {
  const root = repo();
  writeFileSync(join(root, "src.ts"), "export const a = 2; // uncommitted\n");
  const { d, calls, scratch } = deps(AGENT, (work) => {
    assert.equal(readFileSync(join(work, "src.ts"), "utf8"), "export const a = 2; // uncommitted\n");
    mkdirSync(join(work, "out"), { recursive: true });
    writeFileSync(join(work, "out", "review.json"), JSON.stringify({ verdict: "approved", findings: [] }));
    writeFileSync(join(work, "src.ts"), "hacked\n");
  });
  const r = await executeJudgment(args(root), d);
  assert.equal(r.route, "done");
  assert.equal(r.rounds, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "out", "review.json"), "utf8")).verdict, "approved");
  assert.equal(readFileSync(join(root, "src.ts"), "utf8"), "export const a = 2; // uncommitted\n");
  assert.deepEqual(readdirSync(scratch), []);
  assert.equal(calls.record[0].judgment_role, "senior-reviewer");
  assert.equal(calls.record[0].judgment_fallback, undefined);
  // The agent reads the helper's own instructions and the orchestrator's prompt.
  assert.match(calls.dispatch[0].packet.instruction, /senior code reviewer/);
  assert.match(calls.dispatch[0].packet.instruction, /review it/);
  assert.equal(calls.dispatch[0].packet.phase, "senior_code_review");
});

test("a failed check gets one fix round with the problem sent back", async () => {
  const root = repo();
  const { d, calls } = deps(AGENT, (work, n) => {
    mkdirSync(join(work, "out"), { recursive: true });
    writeFileSync(join(work, "out", "review.json"), n === 1 ? "{not json" : "{}");
  });
  const r = await executeJudgment(args(root), d);
  assert.equal(r.route, "done");
  assert.equal(r.rounds, 2);
  assert.match(calls.dispatch[1].packet.instruction, /Fix these problems[\s\S]*out\/review\.json is not valid JSON/);
  assert.equal(calls.dispatch[0].workDir, calls.dispatch[1].workDir);
  assert.equal(r.cost_usd, 0.02);
});

test("still failing after the fix round: a fallback, marked on the telemetry events", async () => {
  const root = repo();
  const { d, calls } = deps(AGENT, () => {});
  const r = await executeJudgment(args(root), d);
  assert.equal(r.route, "claude");
  assert.equal(r.fallback, true);
  assert.match(r.reason, /out\/review\.json was not written/);
  assert.equal(calls.dispatch.length, 2);
  assert.match(calls.record.at(-1).judgment_fallback, /was not written/);
  assert.equal(existsSync(join(root, "out")), false);
});

test("an agent that fails outright is a fallback after one call", async () => {
  const root = repo();
  const { d, calls } = deps(AGENT, () => result({ success: false, error: "worker timed out" }));
  const r = await executeJudgment(args(root), d);
  assert.equal(r.fallback, true);
  assert.match(r.reason, /worker timed out/);
  assert.equal(calls.dispatch.length, 1);
  assert.equal(calls.record[0].judgment_fallback, "worker timed out");
});

test("a brownfield step writes only under .sdlc/", () => {
  assert.match(outputProblem("/p", "src/x.md", true), /outside \.sdlc/);
  assert.equal(outputProblem("/p", ".sdlc/runs/r1/review.json", true), null);
  assert.match(outputProblem("/p", "../x.md", false), /outside project_root/);
  assert.match(outputProblem("/p", "/abs.md", false), /relative/);
});

test("the brownfield architect's sections are linted in the project after they come back", async () => {
  const root = repo();
  const dir = ".sdlc/runs/r1/change.sections/";
  const { d, calls } = deps(AGENT, (work) => {
    mkdirSync(join(work, dir), { recursive: true });
    writeFileSync(join(work, dir, "header.json"), "{}");
    writeFileSync(join(work, dir, "units-001.json"), "[]");
  });
  const r = await executeJudgment(args(root, { role: "brownfield-architect", outputs: [dir] }), d);
  assert.equal(r.route, "done");
  assert.deepEqual(calls.lint.map((f) => f.slice(root.length + 1)), [`${dir}header.json`, `${dir}units-001.json`]);
  assert.ok(existsSync(join(root, dir, "units-001.json")));
});

test("the greenfield architect's sections are handed over header first, and an accepted one is not sent again", async () => {
  const root = repo();
  const dir = "out/spec.sections/";
  let refuse = true;
  const { d, calls } = deps(AGENT, (work) => {
    mkdirSync(join(work, dir), { recursive: true });
    writeFileSync(join(work, dir, "units-001.json"), "[]");
    writeFileSync(join(work, dir, "header.json"), "{}");
  }, {
    submitSection: async (_d, section, file) => {
      calls.submit.push([section, file]);
      if (section === "units" && refuse) { refuse = false; return { ok: false, problems: ["/units/0/id duplicate"] }; }
      return { ok: true, problems: [] };
    },
  });
  const r = await executeJudgment(args(root, { role: "architect", outputs: [dir], spec_dir: join(root, "out") }), d);
  assert.equal(r.route, "done");
  assert.deepEqual(calls.submit, [["header", "spec.sections/header.json"], ["units", "spec.sections/units-001.json"], ["units", "spec.sections/units-001.json"]]);
  assert.equal(calls.finalize, 1);
});

test("the clone shares the project's HEAD and leaves installed dependencies behind", () => {
  const root = repo();
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  writeFileSync(join(root, "node_modules", "x", "i.js"), "");
  const scratch = mkdtempSync(join(tmpdir(), "mmo-judg-scratch-"));
  const clone = cloneWorkspace(root, scratch);
  const head = (dir) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(head(clone), head(root));
  assert.equal(execFileSync("git", ["-C", clone, "status", "--porcelain"], { encoding: "utf8" }), "");
  assert.equal(existsSync(join(clone, "node_modules")), false);
  rmSync(scratch, { recursive: true, force: true });
});

test("every role's instructions resolve from the shipped plugin", () => {
  for (const [name, role] of Object.entries(JUDGMENT_ROLES)) {
    const text = roleInstructions(PLUGIN_ROOT, role);
    assert.ok(text.length > 200, name);
    assert.doesNotMatch(text, /^---\n/, name);
  }
});

test("the server resolves a relative telemetry_path against project_root before the agent runs in its clone", () => {
  const src = readFileSync(resolve(PLUGIN_ROOT, "mcp", "model-dispatch", "src", "server.ts"), "utf8");
  const at = src.indexOf('case "execute_judgment"');
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 600), /telemetry_path: resolvePath\(a0j\.project_root, a0j\.telemetry_path\)/);
});
