/**
 * A packets file re-sent to the real server (dist/server.js over MCP stdio, a fresh process per call, a stand-in
 * `claude` that answers from a queue): the run's applied record (batch.ts alreadyApplied) settles every packet that
 * already applied, also when a later packet of the plan edited a file it read. And telemetry survives a server that is
 * killed partway through a packet's ladder. No model is called, $0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER, calledModels, cleanup, events, packet, project, receipt, standInClaude, withServer } from "./serverHarness.mjs";

const SOLO = `version: 1
name: solo
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
rules:
  - default: opus
`;
const brief = { path: ".sdlc/runs/r1/briefs/shared.md", reason: "shared brief (stable run record)" };

/** Writes the plan's packets file and returns a function that sends it whole to a fresh server after its pre-flight. */
function resender(root, packets) {
  writeFileSync(join(root, "policy.yaml"), SOLO);
  const packets_path = join(root, ".sdlc", "runs", "r1", "packets.json");
  writeFileSync(packets_path, JSON.stringify({ packets }));
  return (bin) => withServer({ bin, home: root }, async (call) => {
    await call("preflight_dispatch", { auth_mode: "estimated", executor: false, policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1" });
    return call("execute_batch", { packets_path, policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1", telemetry_path: join(root, ".sdlc", "runs", "r1", "telemetry.jsonl") });
  });
}
const statuses = (r) => r.json?.items?.map((i) => [i.id, i.status]);

// The canonical bugfix plan: the reproducing test reads the module under fault (`uses`), and the fix then edits that
// module. What a packet asks for is the packet as planned, not the bytes it read from a project file another packet
// may change since, so the re-sent reproducing test is not typed again (its red check would pass on the fixed code,
// every attempt would fail, and the applied fix would be reported blocked).
test("a re-sent bugfix plan types nothing: the reproducing test that reads the module under fault, and the fix of that module", async () => {
  const testEdit = receipt({ path: "test/x.test.mjs", edits: [{ search: "// cases\n", replace: "// cases\nif (two() !== 2) throw new Error('two() should be 2');\n" }] });
  const fixEdit = receipt({ path: "src/x.mjs", edits: [{ search: "export const two = () => 3;\n", replace: "export const two = () => 2;\n" }] });
  const bin = standInClaude([testEdit, fixEdit, testEdit]);
  const root = project({
    contract: { schema_version: 1, active: true, run_id: "r1", allowlist: ["src/**", "test/**"] },
    files: { "src/x.mjs": "export const two = () => 3;\n", "test/x.test.mjs": "import { two } from '../src/x.mjs';\n// cases\n", ".sdlc/runs/r1/briefs/shared.md": "shared brief\n" },
  });
  const node = JSON.stringify(process.execPath);
  const send = resender(root, [
    packet("tp_tests_U01", "test/x.test.mjs", { phase: "tests", intent: "bugfix", inputs: [brief, { path: "src/x.mjs", reason: "uses: the module under fault" }, { path: "test/x.test.mjs", reason: "current text" }], apply: { write: true, mode: "edits", checks: [{ id: "load", run: `${node} --check {path}` }, { id: "red", run: `${node} {path}`, expect: "fail" }] } }),
    packet("tp_codegen_U02", "src/x.mjs", { intent: "bugfix", depends_on: ["tp_tests_U01"], inputs: [brief, { path: "src/x.mjs", reason: "current text" }], apply: { write: true, mode: "edits", checks: [{ id: "load", run: `${node} --check {path}` }] } }),
  ]);
  try {
    const first = await send(bin);
    assert.deepEqual(statuses(first), [["tp_tests_U01", "applied"], ["tp_codegen_U02", "applied"]], first.text);
    assert.equal(calledModels(bin).length, 2);
    const testFile = readFileSync(join(root, "test", "x.test.mjs"), "utf8");
    const again = await send(bin);
    assert.deepEqual(statuses(again), [["tp_tests_U01", "already_applied"], ["tp_codegen_U02", "already_applied"]], again.text);
    assert.equal(again.json.cost_usd, 0);
    assert.equal(calledModels(bin).length, 2, "nothing is typed again");
    assert.equal(readFileSync(join(root, "test", "x.test.mjs"), "utf8"), testFile, "the reproducing case is in the test file once");
  } finally {
    cleanup(bin, root);
  }
});

// A docs insert that reads a source file, then an edit of that source file: the re-sent docs packet is not typed
// again, so its paragraph is not inserted a second time and reported as applied.
test("a re-sent plan whose later packet edited a file an earlier one read types nothing and inserts nothing twice", async () => {
  const guideEdit = receipt({ path: "docs/guide.md", edits: [{ search: "## Usage\n", replace: "## Usage\n\nCall `b()` to get two.\n" }] });
  const bEdit = receipt({ path: "src/b.mjs", edits: [{ search: "export const b = () => 2;\n", replace: "export const b = () => 2; // two\n" }] });
  const bin = standInClaude([guideEdit, bEdit, guideEdit]);
  const root = project({ files: { "docs/guide.md": "# Guide\n\n## Usage\n", "src/b.mjs": "export const b = () => 2;\n", ".sdlc/runs/r1/briefs/shared.md": "shared brief\n" } });
  const send = resender(root, [
    packet("tp_docs_U01", "docs/guide.md", { phase: "docs", inputs: [brief, { path: "src/b.mjs", reason: "uses: the function the guide documents" }, { path: "docs/guide.md", reason: "current text" }], apply: { write: true, mode: "edits" } }),
    packet("tp_codegen_U02", "src/b.mjs", { depends_on: ["tp_docs_U01"], inputs: [brief, { path: "src/b.mjs", reason: "current text" }], apply: { write: true, mode: "edits" } }),
  ]);
  try {
    const first = await send(bin);
    assert.deepEqual(statuses(first), [["tp_docs_U01", "applied"], ["tp_codegen_U02", "applied"]], first.text);
    const again = await send(bin);
    assert.deepEqual(statuses(again), [["tp_docs_U01", "already_applied"], ["tp_codegen_U02", "already_applied"]], again.text);
    assert.equal(calledModels(bin).length, 2, "nothing is typed again");
    assert.equal(readFileSync(join(root, "docs", "guide.md"), "utf8"), "# Guide\n\n## Usage\n\nCall `b()` to get two.\n");
  } finally {
    cleanup(bin, root);
  }
});

// Greenfield writes each attempt's event when the attempt is judged (executor/run.ts deps.emit). A brownfield
// packet's finished attempts are on the bill the same way, before the packet ends: a server closed or killed while
// a later attempt is in flight has already written them.
test("a server killed partway through a packet's ladder has already written the finished attempt's event", async () => {
  const bin = standInClaude([receipt({ path: "src/a.txt", content: "BAD\n" }), receipt({ path: "src/a.txt", content: "GOOD\n" })]);
  // The second call hangs until the server is gone: the stand-in sleeps on it.
  const script = join(bin, "claude");
  writeFileSync(script, readFileSync(script, "utf8").replace(`echo "$model" >> "${bin}/models.log"`, `echo "$model" >> "${bin}/models.log"\n[ "$n" = "2" ] && sleep 5`));
  chmodSync(script, 0o755);
  const root = project();
  writeFileSync(join(root, "policy.yaml"), SOLO);
  const telemetry_path = join(root, "telemetry.jsonl");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "kill-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, MMO_LOG_LEVEL: "error" }, stderr: "ignore" }));
  try {
    await client.callTool({ name: "preflight_dispatch", arguments: { auth_mode: "estimated", executor: false, policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1" } });
    const p = packet("tp_codegen_U01", "src/a.txt", { apply: { write: true, checks: [{ id: "good", run: "grep -q GOOD {path}" }] } });
    client.callTool({ name: "execute_batch", arguments: { packets: [p], policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1", telemetry_path } }).catch(() => {});
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && calledModels(bin).length < 2) await new Promise((r) => setTimeout(r, 50));
    assert.equal(calledModels(bin).length, 2, "the second attempt is in flight");
    await client.close();
    await new Promise((r) => setTimeout(r, 300));
    const evs = events(telemetry_path);
    assert.equal(evs.length, 1, JSON.stringify(evs));
    assert.equal(evs[0].task_id, "tp_codegen_U01");
    assert.ok(evs[0].cost_usd > 0, "the finished attempt's spend is on the bill");
  } finally {
    try { await client.close(); } catch { /* closed above */ }
    cleanup(bin, root);
  }
});
