/**
 * The run state is the source of truth for a brownfield run's policy (server.ts runFor), and a typist is the policy's
 * own leaf (server.ts typistApplyAdapter, keyed by the leaf's whole configuration and the auth mode): the real server,
 * one process, a stand-in `claude` that records the --model of each call. No model is called, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { calledModels, cleanup, packet, project, receipt, standInClaude, withServer } from "./serverHarness.mjs";

const policy = (name, model) => `version: 1
name: ${name}
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: ${model}
rules:
  - default: opus
`;
const OK = receipt({ path: "src/a.txt", content: "typed\n" });

// Two runs in one chat (one server process) under two policies whose leaf has the same id and another model: each
// run's files are typed by its own policy's model, as greenfield's stage builds its typists from the policy in hand.
test("a second run under another policy that reuses a leaf id is typed by that policy's model", async () => {
  const bin = standInClaude([OK]);
  const a = project(), b = project();
  writeFileSync(join(a, "policy.yaml"), policy("pol-a", "claude-opus-4-7"));
  writeFileSync(join(b, "policy.yaml"), policy("pol-b", "claude-opus-5"));
  try {
    await withServer({ bin, home: a }, async (call) => {
      for (const root of [a, b]) {
        const policy_path = join(root, "policy.yaml");
        const pre = await call("preflight_dispatch", { auth_mode: "estimated", executor: false, policy_path, project_root: root, run_id: "r1" });
        assert.equal(pre.json?.ok, true, pre.text);
        const r = await call("execute_batch", { packets: [packet("tp_codegen_A1", "src/a.txt")], policy_path, project_root: root, run_id: "r1" });
        assert.equal(r.isError, false, r.text);
        assert.equal(r.json.counts.applied, 1, r.text);
      }
    });
    assert.deepEqual(calledModels(bin), ["claude-opus-4-7", "claude-opus-5"]);
  } finally {
    cleanup(bin, a, b);
  }
});

// Pre-flight recorded and checked one policy; a call that leaves the policy out uses that one (never the shipped
// default), and a call that names another is refused before anything is typed, as execute_stage refuses a switch.
test("execute_batch and execute_with_model take the run's policy from its pre-flight and refuse another", async () => {
  // One answer per typed packet, each naming that packet's own file (an answer that names another file is refused).
  const bin = standInClaude([OK, receipt({ path: "src/b.txt", content: "typed\n" }), receipt({ path: "src/d.txt", content: "typed\n" })]);
  const root = project();
  writeFileSync(join(root, "policy.yaml"), policy("pol-a", "claude-opus-5"));
  writeFileSync(join(root, "other.yaml"), policy("pol-b", "claude-sonnet-4-5"));
  try {
    await withServer({ bin, home: root }, async (call) => {
      const pre = await call("preflight_dispatch", { auth_mode: "estimated", executor: false, policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1" });
      assert.equal(pre.json?.ok, true, pre.text);
      const batch = await call("execute_batch", { packets: [packet("tp_codegen_A1", "src/a.txt")], project_root: root, run_id: "r1" });
      assert.equal(batch.isError, false, batch.text);
      assert.equal(batch.json?.counts?.applied, 1, batch.text);
      const single = await call("execute_with_model", { packet: packet("tp_codegen_A2", "src/b.txt"), project_root: root, run_id: "r1" });
      assert.equal(single.isError, false, single.text);
      assert.equal(single.json?.status, "applied", single.text);
      assert.deepEqual(calledModels(bin), ["claude-opus-5", "claude-opus-5"], "the policy pre-flight recorded, not the shipped default");
      for (const [tool, args] of [["execute_batch", { packets: [packet("tp_codegen_A3", "src/c.txt")] }], ["execute_with_model", { packet: packet("tp_codegen_A3", "src/c.txt") }]]) {
        const other = await call(tool, { ...args, project_root: root, run_id: "r1", policy_path: join(root, "other.yaml") });
        assert.equal(other.isError, true, `${tool}: ${other.text}`);
        assert.match(other.text, /pre-flight recorded/);
        assert.match(other.text, /nothing was typed/);
      }
      const named = await call("execute_with_model", { packet: packet("tp_codegen_A4", "src/d.txt"), project_root: root, run_id: "r1", policy_name: "pol-a" });
      assert.equal(named.isError, false, `the run's own policy, named by its name: ${named.text}`);
      assert.equal(named.json?.status, "applied", named.text);
    });
    assert.equal(calledModels(bin).length, 3, "the refused calls typed nothing");
  } finally {
    cleanup(bin, root);
  }
});
