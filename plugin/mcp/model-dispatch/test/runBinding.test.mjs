/**
 * One run, one policy — per spec. A pre-flight opens a run; the spec that run's architect sends is
 * bound, at its first stage, to the auth mode and policy that pre-flight recorded, and cannot switch
 * halfway. A new run into the same folder and chat starts a new spec (even when the earlier one was
 * never finalized) and binds its own policy. A stage whose start-up fails binds nothing.
 * No model calls: every stage here has no job to type.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXECUTOR_TOOLS, handleExecutorTool } from "../dist/executor/tools.js";
import { loadPolicyFromPath } from "../dist/policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICIES = resolve(HERE, "..", "..", "..", "config", "policies");
const SOLO = loadPolicyFromPath(join(POLICIES, "opus-only-v5.yaml"));
const ORCH = loadPolicyFromPath(join(POLICIES, "opus-plus-flash-v38.yaml"));
const POLICY = { "opus-only-v5": SOLO, "opus-plus-flash-v38": ORCH };

const HEADER = { stack: ["Python 3"], commands: [], decisions: [], shared: { conventions: [], data_model: [], api: [] }, no_audit_reason: "none in this test" };
const unit = (id, path) => ({ id, path, phase: "codegen", import_line: "", exports: [], behaviour: `the ${path} file`, depends_on: [], style_from: { reason: "first" }, covers: [], tests: [], approx_lines: 1 });

/** A pre-flight: a new run state object, as server.ts records one at every preflight_dispatch. */
const preflight = (policyName) => {
  const run = { authMode: "estimated", policyName };
  return { run: () => run, policy: (r) => POLICY[r.policyName], overrides: {} };
};
const text = (r) => JSON.parse(r.content[0].text);
async function send(ctx, dir, section, value, name) {
  mkdirSync(join(dir, "spec.sections"), { recursive: true });
  writeFileSync(join(dir, "spec.sections", name), JSON.stringify(value));
  return text(await handleExecutorTool("submit_spec_section", { spec_dir: dir, section, file: `spec.sections/${name}` }, ctx));
}
async function writeSpec(ctx, dir, paths) {
  const h = await send(ctx, dir, "header", HEADER, "header.json");
  assert.equal(h.ok, true, JSON.stringify(h));
  const u = await send(ctx, dir, "units", paths.map((p, i) => unit(`U0${i + 1}`, p)), "units-001.json");
  assert.equal(u.ok, true, JSON.stringify(u));
  const f = text(await handleExecutorTool("finalize_spec", { spec_dir: dir }, ctx));
  assert.equal(f.ok, true, JSON.stringify(f));
  return h;
}
/** A stage with no job (the spec has no docs file), so nothing is typed and nothing is paid. */
const stage = (ctx, dir, codeDir = join(dir, "..", "src")) =>
  handleExecutorTool("execute_stage", { spec_path: join(dir, "spec.json"), stage: "docs", code_dir: codeDir, telemetry_path: join(dir, "t.jsonl") }, ctx);
const folder = () => { const root = mkdtempSync(join(tmpdir(), "run-binding-")); const dir = join(root, ".sdlc"); mkdirSync(dir); return dir; };

test("a new run into the same folder writes a new spec and runs it under its own policy; one spec cannot switch policy halfway", async () => {
  const dir = folder();
  const a = preflight("opus-only-v5");
  await writeSpec(a, dir, ["app/a.py"]);
  assert.notEqual((await stage(a, dir)).isError, true, "the first run's stage runs and binds its spec");

  const b = preflight("opus-plus-flash-v38");
  const h = await writeSpec(b, dir, ["app/b.py"]);
  assert.ok(h.previous, "the new run's header moved the earlier spec aside");
  const rb = await stage(b, dir);
  assert.notEqual(rb.isError, true, rb.content[0].text);

  // Another pre-flight with no new spec: the spec being run keeps the policy it started with.
  const c = preflight("opus-only-v5");
  const rc = await stage(c, dir);
  assert.equal(rc.isError, true);
  assert.match(text(rc).stopped, /cannot switch its auth mode or policy halfway/);
});

test("a header from a new run opens a new spec even when the earlier run never finalized its spec; a header sent again within one run keeps its units", async () => {
  const dir = folder();
  const a = preflight("opus-only-v5");
  assert.equal((await send(a, dir, "header", HEADER, "header.json")).ok, true);
  assert.equal((await send(a, dir, "units", [unit("U01", "app/old.py")], "units-001.json")).total_units, 1);
  // A retry of the header inside the same run: the spec being written keeps its units.
  const again = await send(a, dir, "header", HEADER, "header.json");
  assert.equal(again.previous, undefined);
  assert.equal(again.total_units, 1);

  // The earlier run aborted before finalize; a new pre-flight's architect starts over.
  const b = preflight("opus-plus-flash-v38");
  const h = await send(b, dir, "header", HEADER, "header.json");
  assert.ok(h.previous && existsSync(join(h.previous, "spec.parts")), "the earlier run's records moved under previous/");
  assert.equal(h.total_units, 0, "none of the earlier run's units is carried over");
  const u = await send(b, dir, "units", [unit("U01", "app/new.py")], "units-001.json");
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal(u.total_units, 1);
  // A unit from the earlier run cannot join the new run's spec.
  const late = await send(a, dir, "units", [unit("U02", "app/late.py")], "units-002.json");
  assert.equal(late.ok, false);
  assert.match(late.errors[0].message, /send the header section first/);
});

test("a stage whose start-up fails binds nothing: the run can start again under another pre-flight", async () => {
  const dir = folder();
  const a = preflight("opus-only-v5");
  await writeSpec(a, dir, ["app/a.py"]);
  // A code folder that cannot be made (its parent is a file): the stage fails before anything runs.
  const blocker = join(dir, "..", "not-a-folder");
  writeFileSync(blocker, "x");
  await assert.rejects(stage(a, dir, join(blocker, "src")));
  const b = preflight("opus-plus-flash-v38");
  const r = await stage(b, dir);
  assert.notEqual(r.isError, true, r.content[0].text);
});

test("submit_spec_section says a header after finalize_spec or from a new run starts a new spec, where the earlier records go, and that the whole spec is sent again", () => {
  const d = EXECUTOR_TOOLS.find((t) => t.name === "submit_spec_section").description;
  assert.match(d, /after finalize_spec/);
  assert.match(d, /new run/);
  assert.match(d, /<spec_dir>\/previous\/<time>\//);
  assert.match(d, /`previous`/);
  assert.match(d, /header, then every units file/);
});
