/**
 * A brownfield run's packets through the real server (dist/server.js over MCP stdio), with a stand-in `claude` that
 * answers from a queue and records each call: no model, $0. Covers what the server adds around the apply loop:
 * routing by greenfield's reading of the policy (executorView), telemetry that records each attempt's verdict, waits
 * that are no attempt, a re-sent batch that types nothing already applied, the plan's tooling steps and end-of-run
 * checks in the receipt, and the agent-door refusals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calledModels, cleanup, events, packet, project, receipt, standInClaude, withServer } from "./serverHarness.mjs";

const SOLO = `version: 1
name: solo
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
rules:
  - default: opus
`;
const preflight = (call, root, extra = {}) => call("preflight_dispatch", { auth_mode: "estimated", executor: false, policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1", ...extra });

// A policy whose codegen rule names a task_type: greenfield's executor and the run-start probe read it by its stage
// alone (executorView), so a brownfield packet (task_type "", its stage) is routed the same way, never to the default.
test("a brownfield packet is routed by greenfield's reading of the policy: a task_type-narrowed stage rule applies by stage", async () => {
  const bin = standInClaude([receipt({ path: "src/a.txt", content: "x\n" })]);
  const root = project();
  writeFileSync(join(root, "policy.yaml"), `version: 1
name: narrowed
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
  - id: son
    adapter: builtin-anthropic
    model_name: claude-sonnet-4-5
rules:
  - when: { phase: codegen, task_type: [dto] }
    use: son
  - default: opus
`);
  try {
    await withServer({ bin, home: root }, async (call) => {
      assert.equal((await preflight(call, root)).json?.ok, true);
      const r = await call("execute_batch", { packets: [packet("tp_codegen_U01", "src/a.txt")], policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1" });
      assert.equal(r.json?.counts?.applied, 1, r.text);
    });
    assert.deepEqual(calledModels(bin), ["claude-sonnet-4-5"]);
  } finally {
    cleanup(bin, root);
  }
});

// One event per typist call, as greenfield writes them, keeping the job's id and numbered 1..n with the reason each
// follows. A brownfield attempt is judged before its event is written (apply.ts runApplyLoop, through the record hook
// server.ts passes): success only when its answer was written and passed the file's checks, with the failed check as
// its error. Greenfield's events can say only whether the answer was usable, since its checks run later as a stage.
test("each attempt's event carries its verdict, its file's checks included, and keeps the packet's id, its number and its reason", async () => {
  const bin = standInClaude([
    receipt({ path: "src/z.txt", content: "elsewhere\n" }),
    receipt({ path: "src/a.txt", content: "BAD\n" }),
    receipt({ path: "src/a.txt", content: "GOOD\n" }),
  ]);
  const root = project();
  writeFileSync(join(root, "policy.yaml"), SOLO);
  const telemetry_path = join(root, "telemetry.jsonl");
  try {
    await withServer({ bin, home: root }, async (call) => {
      assert.equal((await preflight(call, root)).json?.ok, true);
      const p = packet("tp_codegen_U01", "src/a.txt", { apply: { write: true, checks: [{ id: "good", run: "grep -q GOOD {path}" }] } });
      const r = await call("execute_batch", { packets: [p], policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1", telemetry_path });
      assert.equal(r.json?.counts?.applied, 1, r.text);
      assert.equal(r.json.items[0].attempts, 3);
    });
    const evs = events(telemetry_path);
    assert.deepEqual(evs.map((e) => e.success), [false, false, true], "an answer that names another file, and one its file's check refuses, are failed attempts");
    assert.match(evs[0].error, /the answer names src\/z\.txt, not src\/a\.txt/);
    assert.match(evs[1].error, /^verify failed: grep -q GOOD/);
    assert.deepEqual(evs.map((e) => e.task_id), ["tp_codegen_U01", "tp_codegen_U01", "tp_codegen_U01"], "a retry keeps the planned packet's id");
    assert.deepEqual(evs.map((e) => e.attempt_number), [1, 2, 3]);
    assert.deepEqual(evs.map((e) => e.retry_reason), [undefined, "refused", "verify"], "each retry says why it follows; none is an output-cap doubling");
  } finally {
    cleanup(bin, root);
  }
});

// A busy vendor's reply is waited out and is no attempt: its event says so (retry_reason "transport", as greenfield's
// wait events do) and the receipt counts it apart from the attempts.
test("a busy-vendor wait is tagged as a transport retry and counted apart from the attempts", async () => {
  const bin = standInClaude([receipt(null, { error: { status: 429, message: "rate limited" }, usage: { input_tokens: 0, output_tokens: 0 } }), receipt({ path: "src/a.txt", content: "x\n" })]);
  const root = project();
  writeFileSync(join(root, "policy.yaml"), SOLO);
  const telemetry_path = join(root, "telemetry.jsonl");
  try {
    await withServer({ bin, home: root }, async (call) => {
      assert.equal((await preflight(call, root)).json?.ok, true);
      const r = await call("execute_batch", { packets: [packet("tp_codegen_U01", "src/a.txt")], policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1", telemetry_path });
      assert.equal(r.json?.counts?.applied, 1, r.text);
      assert.equal(r.json.items[0].attempts, 1, r.text);
      assert.equal(r.json.items[0].transport_waits, 1, r.text);
    });
    const evs = events(telemetry_path);
    assert.deepEqual(evs.map((e) => [e.success, e.retry_reason]), [[false, "transport"], [true, undefined]]);
  } finally {
    cleanup(bin, root);
  }
});

// A batch re-sent after an interruption (or for "carry on") types nothing that already applied: a packet whose file is
// still as the earlier call left it settles `already_applied` at $0, so an edit is never applied twice. A tooling step
// the call skips blocks what waits for it, and the receipt carries the step and the plan's end-of-run checks.
test("a re-sent packets file types nothing already applied, blocks what waits for a skipped tooling step, and carries the end-of-run checks", async () => {
  const bin = standInClaude([
    receipt({ path: "src/b.mjs", content: "export const b = () => 2;\n" }),
    receipt({ path: "docs/guide.md", edits: [{ search: "## Usage\n", replace: "## Usage\n\nCall `b()` to get two.\n" }] }),
    receipt({ path: "src/d.mjs", content: "export const d = 4;\n" }),
    // The fourth call: src/b.mjs typed again once someone else changed it (the last step below).
    receipt({ path: "src/b.mjs", content: "export const b = () => 2;\n" }),
  ]);
  const root = project({ files: { "docs/guide.md": "# Guide\n\n## Usage\n", ".sdlc/runs/r1/briefs/shared.md": "shared brief\n" } });
  writeFileSync(join(root, "policy.yaml"), SOLO);
  const brief = { path: ".sdlc/runs/r1/briefs/shared.md", reason: "shared brief (stable run record)" };
  const packets = [
    packet("tp_codegen_U01", "src/b.mjs", { inputs: [brief] }),
    packet("tp_docs_U02", "docs/guide.md", { phase: "docs", depends_on: ["tp_codegen_U01"], inputs: [brief, { path: "docs/guide.md", reason: "current text" }], apply: { write: true, mode: "edits" } }),
    { id: "tooling_U03", phase: "codegen", task_type: "tooling", module: "spec", intent: "feature-new", pass_id: "r1", depends_on: ["tp_docs_U02"], instruction: "Orchestrator shell step, no model (unit U03): run `npm install`.", inputs: [], acceptance: [], budget: { maxInputTokens: 0, maxOutputTokens: 0 } },
    packet("tp_codegen_U04", "src/d.mjs", { depends_on: ["tooling_U03"], inputs: [brief], verify_deferred: ["npm test"] }),
  ];
  const packets_path = join(root, ".sdlc", "runs", "r1", "packets.json");
  writeFileSync(packets_path, JSON.stringify({ packets }));
  const batch = (call, extra = {}) => call("execute_batch", { packets_path, policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1", telemetry_path: join(root, ".sdlc", "runs", "r1", "telemetry.jsonl"), ...extra });
  try {
    const first = await withServer({ bin, home: root }, async (call) => { await preflight(call, root); return batch(call); });
    const by = (r) => Object.fromEntries(r.json.items.map((i) => [i.id, i]));
    assert.equal(by(first).tp_codegen_U01.status, "applied", first.text);
    assert.equal(by(first).tp_docs_U02.status, "applied", first.text);
    assert.equal(by(first).tp_codegen_U04.status, "blocked", first.text);
    assert.deepEqual(by(first).tp_codegen_U04.blocked_by, ["tooling_U03"]);
    assert.deepEqual(first.json.tooling_steps, [{ id: "tooling_U03", instruction: "Orchestrator shell step, no model (unit U03): run `npm install`." }]);
    assert.deepEqual(first.json.verify_deferred, ["npm test"]);
    assert.equal(calledModels(bin).length, 2, "the packet that waits for the install is not typed");

    // The session dies after the batch returns; the next one re-sends the same file to a fresh server.
    const again = await withServer({ bin, home: root }, async (call) => { await preflight(call, root); return batch(call); });
    assert.equal(by(again).tp_codegen_U01.status, "already_applied", again.text);
    assert.equal(by(again).tp_docs_U02.status, "already_applied", again.text);
    assert.equal(by(again).tp_codegen_U01.cost_usd, 0);
    assert.equal(calledModels(bin).length, 2, "nothing already applied is typed again");
    assert.equal(readFileSync(join(root, "docs", "guide.md"), "utf8"), "# Guide\n\n## Usage\n\nCall `b()` to get two.\n", "the edit is in the file once");

    // The orchestrator runs the install, then sends the packets that waited for it.
    const after = await withServer({ bin, home: root }, async (call) => { await preflight(call, root); return batch(call, { packet_ids: ["tp_codegen_U04"] }); });
    assert.equal(by(after).tp_codegen_U04.status, "applied", after.text);
    assert.equal(calledModels(bin).length, 3);

    // The whole file re-sent once more (the session died after that call): the packet that waited for the install
    // applied after it, so the install has run. Nothing is blocked by it, nothing is typed, and the receipt asks for
    // no shell step.
    const whole = await withServer({ bin, home: root }, async (call) => { await preflight(call, root); return batch(call); });
    assert.deepEqual(whole.json.items.map((i) => [i.id, i.status]), [["tp_codegen_U01", "already_applied"], ["tp_docs_U02", "already_applied"], ["tp_codegen_U04", "already_applied"]], whole.text);
    assert.equal(whole.json.tooling_steps, undefined, whole.text);
    assert.equal(whole.json.status, "applied");
    assert.equal(calledModels(bin).length, 3);

    // A file changed since its packet applied is the packet's to type again: the record holds only while the file is
    // exactly as the packet left it.
    writeFileSync(join(root, "src", "b.mjs"), "export const b = () => 3;\n");
    const changed = await withServer({ bin, home: root }, async (call) => { await preflight(call, root); return batch(call, { packet_ids: ["tp_codegen_U01"] }); });
    assert.equal(by(changed).tp_codegen_U01.status, "applied", changed.text);
    assert.equal(calledModels(bin).length, 4);
    assert.equal(readFileSync(join(root, "src", "b.mjs"), "utf8"), "export const b = () => 2;\n");
  } finally {
    cleanup(bin, root);
  }
});

// The agent door edits the project folder itself. While a brownfield run's write contract is active, nothing is sent
// to it outside the apply form (no snapshot, no contract check would see its writes), and a refusal never suggests it.
test("under an active write contract, a packet routed to the agent door is refused with or without apply, and no refusal suggests dispatching without apply", async () => {
  const bin = standInClaude([receipt({ path: "src/a.txt", content: "x\n" })]);
  const root = project();
  writeFileSync(join(root, "policy.yaml"), `version: 1
name: agy-codegen
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
  - id: agy
    adapter: antigravity-worker
    model_name: gemini-3.8-flash
rules:
  - when: { phase: codegen }
    use: agy
  - default: opus
`);
  try {
    await withServer({ bin, home: root }, async (call) => {
      const policy_path = join(root, "policy.yaml");
      const noIntent = packet("tp_codegen_U01", "src/a.txt");
      delete noIntent.intent;
      const applyNoIntent = await call("execute_with_model", { packet: noIntent, policy_path, project_root: root, run_id: "r1" });
      assert.equal(applyNoIntent.isError, true, applyNoIntent.text);
      assert.doesNotMatch(applyNoIntent.text, /without apply/);
      assert.match(applyNoIntent.text, /an apply packet names its job/);
      const { apply: _apply, ...plain } = noIntent;
      const nonApply = await call("execute_with_model", { packet: { ...plain, outputSchema: { type: "object" } }, policy_path, project_root: root, run_id: "r1" });
      assert.equal(nonApply.isError, true, nonApply.text);
      assert.match(nonApply.text, /write contract/);
      assert.doesNotMatch(nonApply.text, /without apply/);
    });
  } finally {
    cleanup(bin, root);
  }
});

// The apply form types a brownfield run's packet, on every door, with greenfield's typists: such a packet names its
// job (intent), and the run's pre-flight recorded how it is billed. Anything else is refused before any call, so no
// packet falls back to another way of typing (an API adapter, a door without the lean Opus last attempt).
test("an apply packet that names no job, or comes before its run's pre-flight, is refused on every door and nothing is typed", async () => {
  const bin = standInClaude([receipt({ path: "src/a.txt", content: "x\n" })]);
  const root = project();
  writeFileSync(join(root, "policy.yaml"), SOLO);
  const policy_path = join(root, "policy.yaml");
  try {
    await withServer({ bin, home: root }, async (call) => {
      const p = packet("tp_codegen_U01", "src/a.txt");
      const before = await call("execute_with_model", { packet: p, policy_path, project_root: root, run_id: "r1" });
      assert.equal(before.isError, true, before.text);
      assert.match(before.text, /call preflight_dispatch for this run first/);
      assert.match(before.text, /Nothing was typed/);
      assert.doesNotMatch(before.text, /names its job/, "the packet names its job");
      assert.equal((await preflight(call, root)).json?.ok, true);
      const noIntent = { ...p };
      delete noIntent.intent;
      for (const [tool, args] of [["execute_with_model", { packet: noIntent }], ["execute_batch", { packets: [noIntent] }]]) {
        const r = await call(tool, { ...args, policy_path, project_root: root, run_id: "r1" });
        const text = r.isError ? r.text : JSON.stringify(r.json);
        assert.match(text, /an apply packet names its job \(intent: one of docs, bugfix, feature-extend, feature-new, refactor, test, deps\)/, `${tool}: ${text}`);
        assert.match(text, /Nothing was typed/);
      }
      const otherJob = await call("execute_with_model", { packet: { ...p, intent: "rewrite" }, policy_path, project_root: root, run_id: "r1" });
      assert.match(otherJob.text, /names its job/);
    });
    assert.deepEqual(calledModels(bin), [], "no packet was typed");
  } finally {
    cleanup(bin, root);
  }
});

// A packet typed through execute_with_model alone gets the progress execute_batch sends (one message when it settles,
// a heartbeat between): its checks and typist calls can run past Claude Code's idle limit for a silent MCP call. The
// message is read on the wire, where the server owes it before the reply (serverHarness.mjs wireLog: the client drops a
// progress message that arrives in the same read as the reply).
test("execute_with_model with an apply packet sends progress when asked for it", async () => {
  const bin = standInClaude([receipt({ path: "src/a.txt", content: "x\n" })]);
  const root = project();
  writeFileSync(join(root, "policy.yaml"), SOLO);
  try {
    await withServer({ bin, home: root }, async (call) => {
      assert.equal((await preflight(call, root)).json?.ok, true);
      const r = await call("execute_with_model", { packet: packet("tp_codegen_U01", "src/a.txt"), policy_path: join(root, "policy.yaml"), project_root: root, run_id: "r1" }, { onprogress: () => {} });
      assert.equal(r.json?.status, "applied", r.text);
      assert.ok(r.progress.some((p) => /tp_codegen_U01 applied/.test(p.message ?? "")), JSON.stringify(r.progress));
    });
  } finally {
    cleanup(bin, root);
  }
});
