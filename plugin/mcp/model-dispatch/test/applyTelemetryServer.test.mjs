/**
 * A brownfield packet's telemetry through the real server (dist/server.js over MCP stdio, a stand-in `claude`, $0):
 * a typist's retry reaches the telemetry file with the reason the apply loop gave it (`verify` after a failed check,
 * `refused` after an answer the writer could not take), never the output-cap label a dispatcher gives every attempt
 * past the first, and the first attempt's event carries its check's failure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, events, packet, project, receipt, standInClaude, withServer } from "./serverHarness.mjs";

const SOLO = `version: 1
name: solo
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
rules:
  - default: opus
`;

test("a typist's retry is written with the loop's reason: verify after a failed check, refused after an answer naming another file", async () => {
  const bin = standInClaude([
    receipt({ path: "src/a.txt", content: "BAD\n" }),
    receipt({ path: "src/other.txt", content: "GOOD\n" }),
    receipt({ path: "src/a.txt", content: "GOOD\n" }),
  ]);
  const root = project();
  writeFileSync(join(root, "policy.yaml"), SOLO);
  const telemetry_path = join(root, "telemetry.jsonl");
  try {
    await withServer({ bin, home: root }, async (call) => {
      const pre = await call("preflight_dispatch", { auth_mode: "estimated", executor: false, policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1" });
      assert.equal(pre.json?.ok, true, pre.text);
      const p = packet("tp_codegen_U01", "src/a.txt", { apply: { write: true, checks: [{ id: "good", run: "grep -q GOOD {path}" }] } });
      const r = await call("execute_batch", { packets: [p], policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1", telemetry_path });
      assert.equal(r.json?.counts?.applied, 1, r.text);
    });
    const evs = events(telemetry_path);
    assert.deepEqual(evs.map((e) => [e.task_id, e.attempt_number, e.success, e.retry_reason]), [
      ["tp_codegen_U01", 1, false, undefined],
      ["tp_codegen_U01", 2, false, "verify"],
      ["tp_codegen_U01", 3, true, "refused"],
    ]);
    assert.match(evs[0].error, /verify failed: grep -q GOOD src\/a\.txt/);
    assert.match(evs[1].error, /the answer names src\/other\.txt, not src\/a\.txt/);
  } finally {
    cleanup(bin, root);
  }
});
