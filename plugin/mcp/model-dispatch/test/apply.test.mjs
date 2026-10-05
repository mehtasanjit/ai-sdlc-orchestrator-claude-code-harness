/**
 * Editor-side apply (apply.ts): input hydration, the write-contract gate,
 * the provenance-wrapped write, verify commands, the refined retry packet,
 * and the server loop's wiring. Pure file-system tests — no model is called.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const {
  HARDCODED_OFF_LIMITS,
  FILE_OUTPUT_SCHEMA,
  sliceSection,
  hydrateInputs,
  checkWriteContract,
  applyContent,
  runVerify,
  refinePacket,
  normalizeApply,
  extractFileContent,
  provenanceScriptPath,
  runApplyLoop,
  applyModelConfig,
  readsSlicesFromDisk,
  applySearchReplace,
  hasActiveWriteContract,
  applyBudget,
} = await import(join(DIST, "apply.js"));
const offLimits = await import(join(HERE, "..", "..", "..", "scripts", "lib", "off-limits.mjs"));

function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), "mmo-apply-"));
  return root;
}

const basePacket = (over = {}) => ({
  id: "tp_codegen_001",
  phase: "codegen",
  task_type: "service_method",
  module: "api",
  pass_id: "run-1",
  instruction: "Write the file.",
  inputs: [],
  outputSchema: FILE_OUTPUT_SCHEMA,
  acceptance: ["compiles"],
  budget: { maxInputTokens: 4000, maxOutputTokens: 3000 },
  artifact_path: "src/out.ts",
  ...over,
});

test("the server's hardcoded off-limits list equals the hook's", () => {
  assert.deepEqual(HARDCODED_OFF_LIMITS, offLimits.HARDCODED_OFF_LIMITS);
});

test("sliceSection returns the heading through the next heading of the same or higher level", () => {
  const md = "# Plan\n\nintro\n\n## A1 — default-avatar.ts\n\ncontent a1\n\n### detail\n\nmore\n\n## A2 — other\n\ncontent a2\n";
  assert.equal(sliceSection(md, "A1"), "## A1 — default-avatar.ts\n\ncontent a1\n\n### detail\n\nmore\n");
  assert.equal(sliceSection(md, "A2"), "## A2 — other\n\ncontent a2\n");
  assert.equal(sliceSection(md, "A9"), null);
});

test("hydrateInputs reads whole files, line ranges and sections; leaves given content alone", () => {
  const root = tmpRoot();
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "plan.md"), "# Plan\n\n## A1\n\nspec a1\n\n## A2\n\nspec a2\n");
  writeFileSync(join(root, "src.ts"), "l1\nl2\nl3\nl4\n");
  const { packet, hydrated } = hydrateInputs(
    basePacket({
      inputs: [
        { path: "docs/plan.md", reason: "spec", section: "A1" },
        { path: "src.ts", reason: "ctx", lines: [2, 3] },
        { path: "src.ts", reason: "all" },
        { path: "given.ts", reason: "pasted", content: "already here" },
      ],
    }),
    root,
  );
  assert.deepEqual(hydrated, ["docs/plan.md", "src.ts", "src.ts"]);
  assert.equal(packet.inputs[0].content, "## A1\n\nspec a1\n");
  assert.equal(packet.inputs[1].content, "l2\nl3");
  assert.equal(packet.inputs[2].content, "l1\nl2\nl3\nl4\n");
  assert.equal(packet.inputs[3].content, "already here");
  rmSync(root, { recursive: true, force: true });
});

test("hydrateInputs refuses a path outside project_root, a missing file and a missing section", () => {
  const root = tmpRoot();
  writeFileSync(join(root, "a.md"), "# only\n");
  assert.throws(() => hydrateInputs(basePacket({ inputs: [{ path: "../etc/passwd", reason: "x" }] }), root), /outside project_root/);
  assert.throws(() => hydrateInputs(basePacket({ inputs: [{ path: "nope.ts", reason: "x" }] }), root), /does not exist/);
  assert.throws(() => hydrateInputs(basePacket({ inputs: [{ path: "a.md", reason: "x", section: "B7" }] }), root), /no heading matching/);
  rmSync(root, { recursive: true, force: true });
});

test("checkWriteContract: hardcoded off-limits always apply; no contract otherwise allows", () => {
  const root = tmpRoot();
  assert.equal(checkWriteContract(root, "src/x.ts").allowed, true);
  assert.equal(checkWriteContract(root, ".env").allowed, false);
  assert.equal(checkWriteContract(root, "apps/api/.env.local").allowed, false);
  assert.equal(checkWriteContract(root, ".git/config").allowed, false);
  assert.equal(checkWriteContract(root, "../outside.ts").allowed, false);
  assert.equal(checkWriteContract(root, ".sdlc/runs/r1/report.json").allowed, true, "no contract: allowed anyway");
  rmSync(root, { recursive: true, force: true });
});

test("checkWriteContract: the contract's own run folder is writable under a contract that bans .sdlc/**; no other run's, whoever asks", () => {
  // As the write-contract hook decides (plugin/scripts/write-contract-check.mjs): the run folder that may be written
  // is the one named by the active contract's run_id, never one the caller names, so a packet cannot overwrite
  // another run's provenance.json or report.
  const root = tmpRoot();
  mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, run_id: "r1", strict: true, allowlist: ["src/**"], off_limits: [".sdlc/**"] }));
  assert.equal(checkWriteContract(root, ".sdlc/runs/r1/report.json").allowed, true);
  assert.equal(checkWriteContract(root, ".sdlc/runs/r2/report.json").allowed, false);
  assert.equal(checkWriteContract(root, ".sdlc/runs/r2/provenance.json", { runId: "r2" }).allowed, false, "a caller's own run id opens nothing");
  assert.equal(checkWriteContract(root, ".sdlc/runs/r1/../../local/write-contract.json").allowed, false);
  // A contract that names no run opens no run folder.
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, strict: true, allowlist: ["src/**"], off_limits: [".sdlc/**"] }));
  assert.equal(checkWriteContract(root, ".sdlc/runs/r1/report.json", { runId: "r1" }).allowed, false);
  rmSync(root, { recursive: true, force: true });
});

test("checkWriteContract: a contract with strict false lets an off-limits or unlisted path through, as the hook does (--strict-write=off)", () => {
  const root = tmpRoot();
  mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, run_id: "r", strict: false, allowlist: ["src/**"], off_limits: ["dist/**"] }));
  const off = checkWriteContract(root, "dist/x.js");
  assert.equal(off.allowed, true);
  assert.match(off.reason, /off-limits.*strict false/);
  assert.equal(checkWriteContract(root, "docs/x.md").allowed, true);
  assert.equal(checkWriteContract(root, ".env").allowed, false, "the always-off-limits list still applies");
  rmSync(root, { recursive: true, force: true });
});

test("checkWriteContract: an active strict contract enforces its allowlist and off_limits; inactive does not", () => {
  const root = tmpRoot();
  mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
  const contract = (active) => ({
    schema_version: 1, active, mode: "brownfield", run_id: "r", strict: true,
    allowlist: ["apps/api/src/**", "tests/api/**"],
    off_limits: [".env", "dist/**", ".sdlc/**"],
  });
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify(contract(true)));
  assert.equal(checkWriteContract(root, "apps/api/src/user/x.ts").allowed, true);
  assert.equal(checkWriteContract(root, "apps/web/src/x.ts").allowed, false);
  assert.match(checkWriteContract(root, "apps/web/src/x.ts").reason, /allowlist/);
  assert.equal(checkWriteContract(root, "dist/x.js").allowed, false);
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify(contract(false)));
  assert.equal(checkWriteContract(root, "apps/web/src/x.ts").allowed, true);
  rmSync(root, { recursive: true, force: true });
});

// The hook's run-end rules (plugin/scripts/write-contract-check.mjs, lib/run-log.mjs), which the server's writer
// follows: a contract binds its run only while the run is live by its own log, and a live run may not write its own
// contract or log. The server keeps its own copy of the end rule (src/runLog.ts); these tests keep it the hook's.
const hookRunLog = await import(join(HERE, "..", "..", "..", "scripts", "lib", "run-log.mjs"));
const { formatLine } = await import(join(HERE, "..", "..", "..", "scripts", "lib", "log.mjs"));
const RUN = "20261002-120000-feature-new-x";
const LIVE_CONTRACT = { schema_version: 1, active: true, mode: "brownfield", run_id: RUN, strict: true, allowlist: ["src/**"], off_limits: [".env", ".sdlc/**"] };
function contractedRoot(contract, events) {
  const root = tmpRoot();
  mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify(contract));
  if (events) {
    mkdirSync(join(root, ".sdlc", "runs", RUN), { recursive: true });
    writeFileSync(join(root, ".sdlc", "runs", RUN, "orchestrator.log"), events.map(([e, f]) => formatLine("info", e, { run_id: RUN, ...f })).join("\n") + "\n");
  }
  return root;
}
const RUN_LOGS = [
  ["no log", null, false],
  ["Gate 4 accepted", [["run.start", {}], ["run.end", { outcome: "completed" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]], true],
  ["Gate 4 accept", [["run.start", {}], ["run.end", { outcome: "completed" }], ["gate.resolved", { gate: "gate-4", response: "accept" }]], true],
  ["aborted at a gate", [["run.start", {}], ["gate.resolved", { gate: "gate-2", response: "abort" }]], true],
  ["run.end failed", [["run.start", {}], ["run.end", { outcome: "failed" }]], true],
  ["run.end aborted", [["run.start", {}], ["run.end", { outcome: "aborted" }]], true],
  ["completed, Gate 4 open", [["run.start", {}], ["run.end", { outcome: "completed" }]], false],
  ["Gate 4 sent back", [["run.start", {}], ["run.end", { outcome: "completed" }], ["gate.resolved", { gate: "gate-4", response: "Revise: tests" }]], false],
  ["abort with no gate", [["run.start", {}], ["gate.resolved", { response: "abort" }]], false],
  ["empty outcome", [["run.start", {}], ["run.end", { outcome: "" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]], false],
  ["ended, then started again", [["run.start", {}], ["gate.resolved", { gate: "gate-2", response: "abort" }], ["run.start", {}]], false],
];

for (const [name, events, ended] of RUN_LOGS) {
  test(`checkWriteContract: a run whose log shows "${name}" ${ended ? "has ended: its contract binds nothing" : "is live: its contract binds"}, as the hook decides`, () => {
    const root = contractedRoot(LIVE_CONTRACT, events);
    assert.equal(hookRunLog.runEnded(root, RUN), ended, "the hook's rule");
    assert.equal(checkWriteContract(root, "lib/other.ts").allowed, ended, "outside the allowlist");
    assert.equal(checkWriteContract(root, "src/a.ts").allowed, true, "inside the allowlist either way");
    rmSync(root, { recursive: true, force: true });
  });
}

test("hasActiveWriteContract: a contract is in force only while its run is live, so the apply form is refused after the run has ended", () => {
  const live = contractedRoot(LIVE_CONTRACT, [["run.start", {}]]);
  const ended = contractedRoot(LIVE_CONTRACT, [["run.start", {}], ["run.end", { outcome: "completed" }], ["gate.resolved", { gate: "gate-4", response: "approved" }]]);
  assert.equal(hasActiveWriteContract(live), true);
  assert.equal(hasActiveWriteContract(ended), false, "an ended run's contract is not in force");
  rmSync(live, { recursive: true, force: true }); rmSync(ended, { recursive: true, force: true });
});

test("checkWriteContract: a live run may not write its own contract or log, whatever its allowlist and off-limits say", () => {
  const wide = { ...LIVE_CONTRACT, allowlist: ["**"], off_limits: [".env"] };
  const root = contractedRoot(wide, [["run.start", {}]]);
  for (const path of [".sdlc/local/write-contract.json", `.sdlc/runs/${RUN}/orchestrator.log`, `.sdlc/runs/${RUN}/orchestrator.log.1`, `.SDLC/runs/${RUN.toUpperCase()}/orchestrator.log`]) {
    assert.equal(checkWriteContract(root, path).allowed, false, path);
  }
  assert.equal(checkWriteContract(root, `.sdlc/runs/${RUN}/report.md`).allowed, true, "the rest of the run's own folder");
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ ...wide, strict: false }));
  assert.equal(checkWriteContract(root, ".sdlc/local/write-contract.json").allowed, true, "strict false lets it through, as the hook does");
  rmSync(root, { recursive: true, force: true });
});

test("applyContent writes the file, returns a receipt, and records provenance when a run_id is given", () => {
  const root = tmpRoot();
  assert.ok(existsSync(provenanceScriptPath()), `provenance script must resolve from dist: ${provenanceScriptPath()}`);
  const r1 = applyContent(root, "src/new.ts", "export const a = 1;\n", { packetId: "tp_1" });
  assert.deepEqual(
    { ...r1, sha16: r1.sha16.length },
    { path: "src/new.ts", bytes: 20, lines: 2, sha16: 16, existed_before: false, provenance: "skipped" },
  );
  assert.equal(readFileSync(join(root, "src", "new.ts"), "utf8"), "export const a = 1;\n");

  const r2 = applyContent(root, "src/new.ts", "export const a = 2;\n", { packetId: "tp_2", runId: "run-x" });
  assert.equal(r2.existed_before, true);
  assert.equal(r2.provenance, "recorded");
  const prov = JSON.parse(readFileSync(join(root, ".sdlc", "runs", "run-x", "provenance.json"), "utf8"));
  const touched = prov.files_touched.find((f) => f.path === "src/new.ts");
  assert.ok(touched, "provenance must list the written file");
  assert.equal(touched.packet_id, "tp_2");
  assert.ok(touched.sha_after, "--after must have filled sha_after");
  assert.ok(touched.backup_path, "an untracked pre-existing file is backed up before the write");
  rmSync(root, { recursive: true, force: true });
});

test("runVerify substitutes {path}, stops at the first failure, and tails the output", () => {
  const root = tmpRoot();
  writeFileSync(join(root, "ok.txt"), "x");
  assert.deepEqual(runVerify(undefined, root, "ok.txt"), { ok: true, ran: 0, duration_ms: 0 });
  const pass = runVerify(["test -f {path}", "echo fine"], root, "ok.txt");
  assert.equal(pass.ok, true);
  assert.equal(pass.ran, 2);
  const fail = runVerify(["echo first", "sh -c 'echo boom-{path} >&2; exit 3'", "echo never"], root, "ok.txt");
  assert.equal(fail.ok, false);
  assert.equal(fail.ran, 2);
  assert.equal(fail.exit_code, 3);
  assert.match(fail.failed_command, /boom-\{path\}|boom-ok\.txt/);
  assert.match(fail.output_tail, /boom-ok\.txt/);
  const slow = runVerify(["sleep 5"], root, "ok.txt", 1);
  assert.equal(slow.ok, false);
  assert.equal(slow.exit_code, null);
  assert.match(slow.output_tail, /timed out/);
  rmSync(root, { recursive: true, force: true });
});

test("refinePacket bumps retry_count, re-ids the packet and appends the failure; re-refining replaces the suffix", () => {
  const p = basePacket();
  const r1 = refinePacket(p, "verify failed: tsc");
  assert.equal(r1.id, "tp_codegen_001-r1");
  assert.equal(r1.retry_count, 1);
  assert.match(r1.instruction, /Previous attempt failed verification \(attempt 1\)/);
  assert.match(r1.instruction, /verify failed: tsc/);
  const r2 = refinePacket(r1, "still failing");
  assert.equal(r2.id, "tp_codegen_001-r2");
  assert.equal(r2.retry_count, 2);
  assert.equal(r2.artifact_path, "src/out.ts");
});

// An edits-mode retry is spliced into the file as it was before the packet, so it must be asked for a corrected edit
// list, never "the complete corrected file" (which the edits contract cannot take: the reply would fail as "no edits").
test("refinePacket asks an edits-mode retry for corrected exact edits against the file as given, and a content-mode retry for the complete file", () => {
  const edits = refinePacket(basePacket(), "verify failed: tsc", "edits");
  assert.match(edits.instruction, /\{path, edits: \[\{search, replace\}\]\} against the file's current text as given/);
  assert.doesNotMatch(edits.instruction, /complete corrected file/);
  const content = refinePacket(basePacket(), "verify failed: tsc", "content");
  assert.match(content.instruction, /complete corrected file/);
  assert.equal(refinePacket(basePacket(), "x").instruction, content.instruction.replace("verify failed: tsc", "x"), "content is the default");
});

test("normalizeApply and extractFileContent", () => {
  assert.equal(normalizeApply(undefined), null);
  assert.equal(normalizeApply({ write: false }), null);
  assert.deepEqual(normalizeApply({ write: true }), { write: true, mode: "content", verify: undefined, max_retries: 2, verify_timeout_sec: 120 });
  assert.equal(normalizeApply({ write: true, mode: "edits" }).mode, "edits");
  assert.equal(normalizeApply({ write: true, mode: "bogus" }).mode, "content");
  assert.deepEqual(normalizeApply({ write: true, verify: ["a", 3], max_retries: 0.9 }).verify, ["a"]);
  assert.equal(normalizeApply({ write: true, max_retries: 0.9 }).max_retries, 0);
  assert.deepEqual(extractFileContent({ path: "a", content: "b" }), { path: "a", content: "b" });
  assert.deepEqual(extractFileContent({ result: { content: "b" } }), { path: undefined, content: "b" });
  assert.equal(extractFileContent({ text: "b" }), null);
  assert.equal(extractFileContent("b"), null);
});

/** A stub model: each call pops the next scripted reply. */
function stubModel(replies) {
  const calls = [];
  return {
    calls,
    dispatch: async (packet) => {
      calls.push(packet);
      const r = replies.shift() ?? { content: "fallback\n" };
      return {
        decision: { modelId: "flash", reason: "stub", ruleIndex: 0 },
        result: {
          success: r.fail !== true,
          error: r.fail ? "vendor down" : undefined,
          result: r.fail ? undefined : r,
          tokens: { input: 10, input_cached: 0, output: 5 },
          cost_usd: 0.001,
          terminal_reason: r.fail ? "error" : "success",
          ...(r.fail && (r.status !== undefined || r.code !== undefined || r.retryAfter !== undefined)
            ? { attempts: [{ error_status: r.status, error_code: r.code, retry_after_ms: r.retryAfter }] }
            : {}),
        },
        events: [{ task_id: packet.id, retry_count: packet.retry_count ?? 0 }],
      };
    },
  };
}
const flashUntil = (n) => (p) => ({ modelId: (p.retry_count ?? 0) >= n ? "opus" : "flash", reason: "policy", ruleIndex: 1 });
const silent = () => {};

test("applyModelConfig: an apply-form packet's Flash completion call thinks at low unless the policy's leaf sets a tier; nothing else changes", async () => {
  const flash = { id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.8-flash" };
  assert.deepEqual(applyModelConfig(flash), { ...flash, reasoning: { tier: "low" } });
  const { LEGACY_GEMINI_ADAPTER_ID } = await import(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "adapters", "index.js"));
  assert.deepEqual(applyModelConfig({ ...flash, adapter: LEGACY_GEMINI_ADAPTER_ID }).reasoning, { tier: "low" }, "the legacy id builds the same adapter");
  const set = { ...flash, reasoning: { tier: "medium" } };
  assert.equal(applyModelConfig(set), set, "a tier the policy sets is kept");
  const opus = { id: "opus", adapter: "builtin:anthropic", model_name: "claude-opus-5" };
  assert.equal(applyModelConfig(opus), opus, "other models are left as the policy writes them");
  const agent = { id: "flash-agsdk-worker", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" };
  assert.equal(applyModelConfig(agent), agent, "the agent door keeps its own setting");
});

test("readsSlicesFromDisk: a content-less slice is read from disk for a brownfield packet only; any other packet goes as develop sends it", () => {
  const root = tmpRoot();
  const slice = { path: "a.md", reason: "spec" };
  const pk = (over = {}) => ({ id: "p", inputs: [slice], ...over });
  assert.equal(readsSlicesFromDisk(pk({ intent: "feature-extend" }), null, root), true, "a packet naming its brownfield intent");
  assert.equal(readsSlicesFromDisk(pk(), { write: true }, root), true, "an apply-form packet");
  assert.equal(readsSlicesFromDisk(pk(), null, root), false, "a greenfield packet (no intent, no contract): as develop");
  assert.equal(readsSlicesFromDisk(pk(), null, undefined), false, "and with no project folder at all");
  assert.equal(readsSlicesFromDisk(pk({ intent: "bugfix", inputs: [{ ...slice, content: "x" }] }), null, root), false, "every slice has content: nothing to read");
  mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ active: true, run_id: "r" }));
  assert.equal(readsSlicesFromDisk(pk(), null, root), true, "a project whose brownfield write contract is active");
  rmSync(root, { recursive: true, force: true });
});

test("runApplyLoop: a verify failure is retried on the same model with the failure appended, then applied", async () => {
  const root = tmpRoot();
  const model = stubModel([{ path: "src/out.ts", content: "bad\n" }, { path: "src/out.ts", content: "good\n" }]);
  const out = await runApplyLoop({
    packet: basePacket(),
    apply: normalizeApply({ write: true, verify: ["grep -q good {path}"] }),
    projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: model.dispatch, log: silent,
  });
  assert.equal(out.status, "applied");
  assert.equal(model.calls.length, 2);
  assert.equal(model.calls[1].retry_count, 1);
  assert.match(model.calls[1].instruction, /verify failed: grep -q good src\/out\.ts \(exit 1\)/);
  assert.equal(readFileSync(join(root, "src", "out.ts"), "utf8"), "good\n");
  assert.deepEqual(out.attempts.map((x) => [x.retry_count, x.verify_ok]), [[0, false], [1, true]]);
  assert.equal(out.cost_usd, 0.002);
  assert.equal(out.events.length, 2, "events ride in the outcome when there is no telemetry file");
  assert.equal(out.events_written, 0);
  assert.ok(!JSON.stringify(out).includes("good\\n"), "the outcome never carries the file content");
  rmSync(root, { recursive: true, force: true });
});

test("runApplyLoop: stopped by the person (the request's cancel signal): no attempt starts after the stop, and an answer that arrives after it is never written", async () => {
  const root = tmpRoot();
  const before = new AbortController();
  before.abort();
  const m1 = stubModel([{ path: "src/out.ts", content: "x\n" }]);
  const o1 = await runApplyLoop({ packet: basePacket(), apply: normalizeApply({ write: true }), projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: m1.dispatch, log: silent, signal: before.signal });
  assert.equal(o1.status, "stopped");
  assert.equal(m1.calls.length, 0, "nothing is dispatched after the stop");
  const during = new AbortController();
  const m2 = stubModel([{ path: "src/out.ts", content: "late\n" }]);
  const o2 = await runApplyLoop({
    packet: basePacket(), apply: normalizeApply({ write: true }), projectRoot: root, keepEvents: true, route: flashUntil(2), log: silent, signal: during.signal,
    dispatch: async (p) => { const r = await m2.dispatch(p); during.abort(); return r; },
  });
  assert.equal(o2.status, "stopped");
  assert.equal(m2.calls.length, 1);
  assert.ok(!existsSync(join(root, "src", "out.ts")), "the answer that came back after the stop is not written");
  assert.equal(o2.cost_usd, 0.001, "the attempt that ran is still counted");
  rmSync(root, { recursive: true, force: true });
});

test("runApplyLoop: a packet that ends without its write leaves a provenance record that matches the file on disk, so /mmo:revert sees no change", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "out.ts"), "line1\nline2\n");
  const record = () => JSON.parse(readFileSync(join(root, ".sdlc", "runs", "run-1", "provenance.json"), "utf8")).files_touched.find((f) => f.path === "src/out.ts");
  // Edits mode: written, verify fails, the server puts the original back.
  const edits = stubModel([{ path: "src/out.ts", edits: [{ search: "line1", replace: "bad" }] }]);
  const o1 = await runApplyLoop({ packet: basePacket({ outputSchema: undefined }), apply: normalizeApply({ write: true, mode: "edits", verify: ["false"], max_retries: 0 }), projectRoot: root, runId: "run-1", keepEvents: true, route: flashUntil(5), dispatch: edits.dispatch, log: silent });
  assert.equal(o1.status, "verify_failed");
  assert.equal(readFileSync(join(root, "src", "out.ts"), "utf8"), "line1\nline2\n", "the original is back");
  assert.equal(record().sha_after, record().sha_before, "the record says the file is as it was");
  // A failed dispatch: nothing written.
  const failed = stubModel([{ fail: true }]);
  const o2 = await runApplyLoop({ packet: basePacket({ id: "tp_codegen_002" }), apply: normalizeApply({ write: true }), projectRoot: root, runId: "run-1", keepEvents: true, route: flashUntil(5), dispatch: failed.dispatch, log: silent });
  assert.equal(o2.status, "dispatch_failed");
  assert.equal(record().sha_after, record().sha_before);
  rmSync(root, { recursive: true, force: true });
});

// A busy vendor is waited out, as greenfield's executor does (executor/tools.ts TRANSPORT, run.ts backoffMs): a wait
// is not an attempt, and a 429 bills $0. Credentials the vendor refuses (401, 403) fail every packet the same way, so
// the loop marks the outcome to stop the batch instead of handing each file to another model.
const TRANSPORT_FAST = { maxWaits: 2, baseMs: 1, capMs: 60_000 };
function sleeps() { const waited = []; return { waited, sleep: async (ms) => { waited.push(ms); } }; }

test("runApplyLoop: a rate-limited or dropped call is waited out and sent again, and the wait is no attempt", async () => {
  const root = tmpRoot();
  const s = sleeps();
  const model = stubModel([{ fail: true, status: 429, retryAfter: 7000 }, { fail: true, code: "ECONNRESET" }, { content: "ok\n" }]);
  const out = await runApplyLoop({ packet: basePacket(), apply: normalizeApply({ write: true }), projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: model.dispatch, log: silent, transport: TRANSPORT_FAST, sleep: s.sleep, random: () => 0.5 });
  assert.equal(out.status, "applied");
  assert.equal(model.calls.length, 3);
  assert.equal(s.waited[0], 7000, "the vendor's own requested pause");
  assert.equal(s.waited.length, 2);
  assert.equal(model.calls.every((p) => (p.retry_count ?? 0) === 0), true, "a wait never refines the packet");
  rmSync(root, { recursive: true, force: true });
});

test("runApplyLoop: waits stop at the stated bound, and a pause longer than one rate-limit window ends the packet", async () => {
  const root = tmpRoot();
  const s = sleeps();
  const busy = stubModel([{ fail: true, status: 503 }, { fail: true, status: 503 }, { fail: true, status: 503 }]);
  const a = await runApplyLoop({ packet: basePacket(), apply: normalizeApply({ write: true }), projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: busy.dispatch, log: silent, transport: TRANSPORT_FAST, sleep: s.sleep, random: () => 0.5 });
  assert.equal(a.status, "dispatch_failed");
  assert.equal(busy.calls.length, 3, "maxWaits 2: two waits, then the third failure ends it");
  const long = stubModel([{ fail: true, status: 429, retryAfter: 120_000 }]);
  const b = await runApplyLoop({ packet: basePacket(), apply: normalizeApply({ write: true }), projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: long.dispatch, log: silent, transport: TRANSPORT_FAST, sleep: s.sleep, random: () => 0.5 });
  assert.equal(b.status, "dispatch_failed");
  assert.equal(long.calls.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test("runApplyLoop: credentials refused (401, 403) end the packet with a halt that stops the batch, and no wait", async () => {
  const root = tmpRoot();
  for (const status of [401, 403]) {
    const s = sleeps();
    const model = stubModel([{ fail: true, status }]);
    const out = await runApplyLoop({ packet: basePacket(), apply: normalizeApply({ write: true }), projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: model.dispatch, log: silent, transport: TRANSPORT_FAST, sleep: s.sleep, random: () => 0.5 });
    assert.equal(out.status, "dispatch_failed");
    assert.match(out.halt ?? "", new RegExp(`HTTP ${status}`));
    assert.equal(s.waited.length, 0);
  }
  rmSync(root, { recursive: true, force: true });
});

// The in-server ladder (greenfield's rule): when the policy routes a retry to another model the server can type with
// (the lean Opus typist for a feature run's Claude leaf), the loop carries on with it instead of handing the file back
// to the orchestrator to type in its own long context. Only a model it cannot type with is an `escalate`.
test("runApplyLoop: a retry the policy routes to a model the server can type with stays in the loop", async () => {
  const root = tmpRoot();
  const model = stubModel([{ content: "bad\n" }, { content: "bad\n" }, { content: "good\n" }]);
  const verify = ["node -e \"process.exit(require('fs').readFileSync(process.argv[1],'utf8')==='good\\n'?0:1)\" {path}"];
  const out = await runApplyLoop({ packet: basePacket(), apply: normalizeApply({ write: true, verify, max_retries: 2 }), projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: model.dispatch, log: silent, typesInServer: (d) => d.modelId === "opus" });
  assert.equal(out.status, "applied");
  assert.equal(model.calls.length, 3, "flash, flash, then the routed model in the same loop");
  assert.equal(readFileSync(join(root, "src", "out.ts"), "utf8"), "good\n");
  rmSync(root, { recursive: true, force: true });
});

// Greenfield's ladder (executor/run.ts): the routed typist for every attempt but the last, then one attempt by its
// last-attempt model (the lean Opus typist) when the server can type with it. A reply cut off at a model's own output
// limit (the packet starts there: applyBudget) skips that model's later attempts and goes to the next different typist
// in the ladder; it never adds an attempt, and with no other typist left it fails.
test("applyBudget: an apply packet asks for the routed model's documented output limit, and keeps its own when the model declares none", () => {
  const p = basePacket({ budget: { maxInputTokens: 1000, maxOutputTokens: 6000 } });
  assert.equal(applyBudget(p, { max_output_tokens_absolute: 8192 }).budget.maxOutputTokens, 8192);
  assert.equal(applyBudget(p, {}).budget.maxOutputTokens, 6000);
  assert.equal(applyBudget(p, { max_output_tokens_absolute: 8192 }).budget.maxInputTokens, 1000);
});

/** A dispatch that answers each call from `replies` ("cut", "bad", "good"), as the model it was sent to. */
function ladderModel(replies, route = flashUntil(5)) {
  const calls = [];
  const dispatch = async (packet, force) => {
    calls.push({ packet, force });
    const decision = force ?? route(packet);
    const r = replies.shift() ?? "good";
    const result = r === "cut"
      ? { success: false, error: "cut off", result: null, tokens: { input: 1, input_cached: 0, output: 8192 }, cost_usd: 0.01, terminal_reason: "output_cap_at_model_absolute" }
      : { success: true, result: { path: "src/out.ts", content: `${r}\n` }, tokens: { input: 1, input_cached: 0, output: 5 }, cost_usd: 0.01, terminal_reason: "success" };
    return { decision, result, events: [] };
  };
  return { calls, dispatch };
}
const GOOD_ONLY = ["node -e \"process.exit(require('fs').readFileSync(process.argv[1],'utf8')==='good\\n'?0:1)\" {path}"];
const LAST = () => ({ modelId: "opus", reason: "the ladder's last attempt", ruleIndex: -1 });

test("runApplyLoop: the ladder's last attempt goes to greenfield's last-attempt model, once", async () => {
  const root = tmpRoot();
  const m = ladderModel(["bad", "bad", "good"]);
  const out = await runApplyLoop({ packet: basePacket(), apply: normalizeApply({ write: true, verify: GOOD_ONLY, max_retries: 2 }), projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: m.dispatch, log: silent, lastAttempt: LAST });
  assert.equal(out.status, "applied");
  assert.deepEqual(m.calls.map((c) => c.force?.modelId ?? "routed"), ["routed", "routed", "opus"]);
  const failed = ladderModel(["bad", "bad", "bad", "good"]);
  const f = await runApplyLoop({ packet: basePacket({ id: "tp_2" }), apply: normalizeApply({ write: true, verify: GOOD_ONLY, max_retries: 2 }), projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: failed.dispatch, log: silent, lastAttempt: LAST });
  assert.equal(f.status, "verify_failed");
  assert.equal(failed.calls.length, 3, "no attempt past the ladder");
  // A packet with no retries is typed by its routed model only.
  const once = ladderModel(["good"]);
  await runApplyLoop({ packet: basePacket({ id: "tp_0" }), apply: normalizeApply({ write: true, max_retries: 0 }), projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: once.dispatch, log: silent, lastAttempt: LAST });
  assert.equal(once.calls[0].force, undefined);
  rmSync(root, { recursive: true, force: true });
});

test("runApplyLoop: a reply cut off at the model's limit skips that model's later attempts and never adds one", async () => {
  const root = tmpRoot();
  const m = ladderModel(["cut", "good"]);
  const out = await runApplyLoop({ packet: basePacket(), apply: normalizeApply({ write: true, max_retries: 2 }), projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: m.dispatch, log: silent, lastAttempt: LAST });
  assert.equal(out.status, "applied");
  assert.deepEqual(m.calls.map((c) => c.force?.modelId ?? "routed"), ["routed", "opus"]);
  assert.match(m.calls[1].packet.instruction, /cut off at the model's output limit/);
  // The last-attempt model gets its one attempt only: a bad answer there ends the packet.
  const bad = ladderModel(["cut", "bad", "good"]);
  const b = await runApplyLoop({ packet: basePacket({ id: "tp_2" }), apply: normalizeApply({ write: true, verify: GOOD_ONLY, max_retries: 2 }), projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: bad.dispatch, log: silent, lastAttempt: LAST });
  assert.equal(b.status, "verify_failed");
  assert.equal(bad.calls.length, 2);
  // A later route to another model the server types with is the next typist; the jump keeps the route's own slot.
  const routed = ladderModel(["cut", "good"], flashUntil(2));
  const r = await runApplyLoop({ packet: basePacket({ id: "tp_3" }), apply: normalizeApply({ write: true, max_retries: 3 }), projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: routed.dispatch, log: silent, typesInServer: (d) => d.modelId === "opus" });
  assert.equal(r.status, "applied");
  assert.equal(routed.calls.length, 2);
  assert.equal(routed.calls[1].packet.retry_count, 2, "flash's slot 1 skipped; opus's slot 2");
  // No other typist (a policy with no Claude model, or the last-attempt model itself cut off): the packet fails.
  const none = ladderModel(["cut", "good"]);
  const n = await runApplyLoop({ packet: basePacket({ id: "tp_4" }), apply: normalizeApply({ write: true, max_retries: 2 }), projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: none.dispatch, log: silent });
  assert.equal(n.status, "dispatch_failed");
  assert.equal(none.calls.length, 1);
  const same = ladderModel(["cut", "good"], () => LAST());
  const s = await runApplyLoop({ packet: basePacket({ id: "tp_5" }), apply: normalizeApply({ write: true, max_retries: 2 }), projectRoot: root, keepEvents: true, route: () => LAST(), dispatch: same.dispatch, log: silent, lastAttempt: LAST, typesInServer: () => true });
  assert.equal(s.status, "dispatch_failed");
  assert.equal(same.calls.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test("runApplyLoop: stops with 'escalate' as soon as the policy routes the next retry to another model", async () => {
  const root = tmpRoot();
  const model = stubModel([{ content: "bad\n" }, { content: "bad\n" }, { content: "bad\n" }]);
  const out = await runApplyLoop({
    packet: basePacket(),
    apply: normalizeApply({ write: true, verify: ["false"], max_retries: 5 }),
    projectRoot: root, keepEvents: false, route: flashUntil(2), dispatch: model.dispatch, log: silent,
  });
  assert.equal(out.status, "escalate");
  assert.equal(model.calls.length, 2, "retry_count 2 routes to opus, so the server never spends it on flash");
  assert.deepEqual(out.escalate.retry_count, 2);
  assert.equal(out.escalate.model_id, "opus");
  assert.match(out.escalate.failure, /verify failed: false/);
  assert.equal(out.events_written, 2);
  assert.equal(out.events, undefined);
  rmSync(root, { recursive: true, force: true });
});

test("runApplyLoop: max_retries bounds the loop when the policy never re-routes", async () => {
  const root = tmpRoot();
  const model = stubModel([{ content: "a" }, { content: "b" }, { content: "c" }, { content: "d" }]);
  const out = await runApplyLoop({
    packet: basePacket(),
    apply: normalizeApply({ write: true, verify: ["false"], max_retries: 1 }),
    projectRoot: root, keepEvents: true, route: () => ({ modelId: "flash", reason: "only", ruleIndex: 0 }), dispatch: model.dispatch, log: silent,
  });
  assert.equal(out.status, "verify_failed");
  assert.equal(model.calls.length, 2);
  assert.equal(readFileSync(join(root, "src", "out.ts"), "utf8"), "b", "the last attempt is left on disk for the orchestrator to inspect");
  rmSync(root, { recursive: true, force: true });
});

test("runApplyLoop: a write outside the contract is refused, not retried; a dispatch failure stops the loop", async () => {
  const root = tmpRoot();
  const model = stubModel([{ content: "x" }]);
  const refused = await runApplyLoop({
    packet: basePacket({ artifact_path: ".env" }),
    apply: normalizeApply({ write: true }),
    projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: model.dispatch, log: silent,
  });
  assert.equal(refused.status, "refused");
  assert.match(refused.refusal, /off-limits/);
  assert.equal(existsSync(join(root, ".env")), false);
  assert.equal(model.calls.length, 1);

  const down = stubModel([{ fail: true }]);
  const failed = await runApplyLoop({
    packet: basePacket(), apply: normalizeApply({ write: true }),
    projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: down.dispatch, log: silent,
  });
  assert.equal(failed.status, "dispatch_failed");
  assert.equal(failed.attempts[0].failure, "vendor down");
  rmSync(root, { recursive: true, force: true });
});

test("runApplyLoop: a reply without content is retried with that told to the model", async () => {
  const root = tmpRoot();
  const model = stubModel([{ text: "here is your file" }, { content: "ok\n" }]);
  const out = await runApplyLoop({
    packet: basePacket(), apply: normalizeApply({ write: true }),
    projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: model.dispatch, log: silent,
  });
  assert.equal(out.status, "applied");
  assert.match(model.calls[1].instruction, /no `content` string/);
  rmSync(root, { recursive: true, force: true });
});

// The writer keeps each file's own line ending: lines spliced into a CRLF file get CRLF, untouched lines keep theirs,
// a whole file written over a CRLF file is written with CRLF, and a new file takes the ending of the first file it was
// shown of its own kind (its mirror). Otherwise every edit to a CRLF file changes line endings it never meant to.
test("applySearchReplace applies greenfield's exact edits and keeps a CRLF file's own line ending", () => {
  const crlf = "a\r\nb\r\nc\r\n";
  const r = applySearchReplace(crlf, { path: "x", edits: [{ search: "b\nc", replace: "b\nx\ny\nz" }] });
  assert.equal(r.content, "a\r\nb\r\nx\r\ny\r\nz\r\n", "the search matches across the CRLF lines; inserted lines take CRLF");
  assert.equal(applySearchReplace("a\nb\n", { path: "x", edits: [{ search: "a", replace: "a\r\nx" }] }).content, "a\nx\nb\n", "an LF file stays LF");
  assert.equal(applySearchReplace(crlf, { path: "x", content: "new\nfile\n" }).content, "new\r\nfile\r\n", "a whole file takes the file's ending");
});

test("runApplyLoop writes a whole file over a CRLF file with CRLF, and a new file with its mirror's ending", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "out.ts"), "old\r\nfile\r\n");
  const over = stubModel([{ content: "new\nfile\n" }]);
  const a = await runApplyLoop({ packet: basePacket(), apply: normalizeApply({ write: true }), projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: over.dispatch, log: silent });
  assert.equal(a.status, "applied");
  assert.equal(readFileSync(join(root, "src", "out.ts"), "utf8"), "new\r\nfile\r\n");
  writeFileSync(join(root, "src", "mirror.ts"), "m\r\n");
  const fresh = stubModel([{ content: "one\ntwo\n" }]);
  const b = await runApplyLoop({ packet: basePacket({ id: "tp_new", artifact_path: "src/new.ts", inputs: [{ path: "docs/plan.md" }, { path: "src/mirror.ts" }] }), apply: normalizeApply({ write: true }), projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: fresh.dispatch, log: silent });
  assert.equal(b.status, "applied");
  assert.equal(readFileSync(join(root, "src", "new.ts"), "utf8"), "one\r\ntwo\r\n", "the mirror is CRLF; the plan (another kind of file) does not count");
  const plain = stubModel([{ content: "p\r\nq\r\n" }]);
  await runApplyLoop({ packet: basePacket({ id: "tp_new2", artifact_path: "src/plain.ts", inputs: [] }), apply: normalizeApply({ write: true }), projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: plain.dispatch, log: silent });
  assert.equal(readFileSync(join(root, "src", "plain.ts"), "utf8"), "p\r\nq\r\n", "no file to follow: written as the model gave it");
  rmSync(root, { recursive: true, force: true });
});

test("applySearchReplace refuses what greenfield's applier refuses, naming the edit", () => {
  const src = "a\n  });\nb\n  });\n";
  assert.match(applySearchReplace(src, { path: "x", edits: [{ search: "  });", replace: "x" }] }).reason, /edit 1: its search text appears 2 times/);
  assert.match(applySearchReplace(src, { path: "x", edits: [{ search: "nope", replace: "x" }] }).reason, /appears 0 times/);
  assert.equal(applySearchReplace(src, { path: "x", edits: [{ search: "b\n  });", replace: "c\n  });" }] }).content, "a\n  });\nc\n  });\n");
  assert.match(applySearchReplace(src, { edits: [] }).reason, /\{path, edits\} or \{path, content\}/, "greenfield's contract check");
});

test("runApplyLoop in edits mode applies exact edits to the existing file and retries a search that is not found, with the reason", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "out.ts"), "line1\nline2\n");
  const model = stubModel([
    { path: "src/out.ts", edits: [{ search: "missing", replace: "x" }] },
    { path: "src/out.ts", edits: [{ search: "line1\n", replace: "line1\ninserted\n" }] },
  ]);
  const out = await runApplyLoop({
    packet: basePacket(), apply: normalizeApply({ write: true, mode: "edits" }),
    projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: model.dispatch, log: silent,
  });
  assert.equal(out.status, "applied");
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1].instruction, /appears 0 times/);
  assert.equal(readFileSync(join(root, "src", "out.ts"), "utf8"), "line1\ninserted\nline2\n");
  const missing = await runApplyLoop({
    packet: basePacket({ artifact_path: "src/absent.ts" }), apply: normalizeApply({ write: true, mode: "edits" }),
    projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: stubModel([{ edits: [] }]).dispatch, log: silent,
  });
  assert.equal(missing.status, "refused");
  rmSync(root, { recursive: true, force: true });
});

test("runApplyLoop in edits mode: a verify failure restores the original, and the retry applies to it (no duplicate insert)", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "out.ts"), "a\nb\nc\n");
  const model = stubModel([
    { path: "src/out.ts", edits: [{ search: "a\n", replace: "a\ninserted-bad\n" }] },
    { path: "src/out.ts", edits: [{ search: "a\n", replace: "a\ninserted-good\n" }] },
  ]);
  const out = await runApplyLoop({
    packet: basePacket(), apply: normalizeApply({ write: true, mode: "edits", verify: ["grep -q inserted-good {path}"] }),
    projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: model.dispatch, log: silent,
  });
  assert.equal(out.status, "applied");
  assert.equal(readFileSync(join(root, "src", "out.ts"), "utf8"), "a\ninserted-good\nb\nc\n", "exactly one insertion; attempt 0's line is gone");
  const failed = await runApplyLoop({
    packet: basePacket(), apply: normalizeApply({ write: true, mode: "edits", verify: ["false"], max_retries: 0 }),
    projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: stubModel([{ path: "src/out.ts", edits: [{ search: "b\n", replace: "b\nx\n" }] }]).dispatch, log: silent,
  });
  assert.equal(failed.status, "verify_failed");
  assert.equal(readFileSync(join(root, "src", "out.ts"), "utf8"), "a\ninserted-good\nb\nc\n", "a failed edit leaves the file as it was");
  rmSync(root, { recursive: true, force: true });
});

test("the compiled server wires the apply loop and stops before a routed model change", () => {
  const src = readFileSync(join(DIST, "server.js"), "utf8");
  assert.match(src, /runApplyLoop\(\{/);
  const loop = readFileSync(join(DIST, "apply.js"), "utf8");
  assert.match(loop, /decision\.modelId !== firstDecision\.modelId/, "escalation is decided by comparing the routed model to the first attempt's");
  assert.match(src, /apply\.write requires artifact_path/, "apply without artifact_path is refused up front");
  assert.match(src, /applying && k === "outputSchema"/, "outputSchema is optional under apply");
  const fn = src.indexOf("async function runPacket(");
  assert.ok(src.indexOf("hydrateInputs(packet0", fn) > fn, "inputs are hydrated in runPacket before dispatch");
  assert.ok(src.indexOf("runBatch({", src.indexOf('case "execute_batch"')) > 0, "execute_batch schedules through runBatch");
});

test("applyContent runs format commands before provenance, and the receipt describes the formatted file", () => {
  const root = tmpRoot();
  const r = applyContent(root, "src/f.ts", "export const a = 1;   \n", {
    packetId: "tp_f",
    runId: "run-f",
    format: ["perl -pi -e 's/[ \\t]+$//' {path}", "false"],
  });
  assert.equal(readFileSync(join(root, "src", "f.ts"), "utf8"), "export const a = 1;\n", "format ran on the written file");
  assert.equal(r.bytes, 20, "the receipt is the file as it stays on disk");
  const prov = JSON.parse(readFileSync(join(root, ".sdlc", "runs", "run-f", "provenance.json"), "utf8"));
  const touched = prov.files_touched.find((f) => f.path === "src/f.ts");
  assert.ok(touched.sha_after.endsWith(createHash("sha256").update("export const a = 1;\n").digest("hex")), "provenance hashes the formatted file");
  rmSync(root, { recursive: true, force: true });
});

// Typed checks (a feature run's change spec): each check's run and its own write form, so no command is guessed from
// another's text; a packet with no format and no checks runs no formatter.
test("a check's output is kept up to greenfield's receipt bound, the most any receipt carries", async () => {
  const { VERIFY_OUTPUT_TAIL_CHARS } = await import(join(DIST, "apply.js"));
  const { RECEIPT_MAX_BYTES } = await import(join(DIST, "executor", "run.js"));
  assert.equal(VERIFY_OUTPUT_TAIL_CHARS, RECEIPT_MAX_BYTES);
});

test("normalizeApply: typed checks give verify and format; nothing is derived from a verify command's text", () => {
  const a = normalizeApply({ write: true, checks: [{ id: "lint", run: "lint '{path}'", fix: "lint --write '{path}'" }, { id: "types", run: "tc '{path}'" }], baseline_from: "src/style.ts" });
  assert.deepEqual(a.verify, ["lint '{path}'", "tc '{path}'"]);
  assert.deepEqual(a.format, ["lint --write '{path}'"]);
  assert.deepEqual(a.checks.map((c) => c.id), ["lint", "types"]);
  assert.equal(a.baseline_from, "src/style.ts");
  assert.equal(normalizeApply({ write: true, verify: ["pnpm exec biome check {path}"] }).format, undefined, "no write form guessed from a check's text");
  assert.deepEqual(normalizeApply({ write: true, verify: ["x {path}"], format: ["x --fix {path}"] }).format, ["x --fix {path}"], "an explicit format stays");
  assert.equal(normalizeApply({ write: true, checks: [{ run: 3 }] }).checks, undefined, "a malformed check is dropped");
});

// The baseline rule: before any typist is paid, each typed check runs on the file as it is (an edit) or on its style
// file (a new file with one). A check that already fails there is set aside for this file: it never judges the answer
// and its write form never runs, so a formatter never rewrites a file the repo does not keep formatted, and a check
// that cannot handle this file (a CRLF checkout, a file type the tool does not read) costs no retries.
const CRLF_CHECK = "node -e \"process.exit(require('fs').readFileSync(process.argv[1],'utf8').includes('\\r\\n')?1:0)\" {path}";
const MARK = (name) => `node -e "require('fs').appendFileSync('${name}','x')"`;
test("runApplyLoop: a check that fails on the untouched file is set aside, and its write form never runs", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "out.ts"), "const a = 1;\r\nconst b = 2;\r\n");
  const model = stubModel([{ path: "src/out.ts", edits: [{ search: "const a = 1;\n", replace: "const a = 1;\nconst c = 3;\n" }] }]);
  const apply = normalizeApply({ write: true, mode: "edits", checks: [
    { id: "crlf", run: CRLF_CHECK, fix: MARK("fix-crlf") },
    { id: "ok", run: "node -e \"process.exit(0)\" {path}", fix: MARK("fix-ok") },
  ] });
  const out = await runApplyLoop({ packet: basePacket(), apply, projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: model.dispatch, log: silent });
  assert.equal(out.status, "applied", JSON.stringify(out.attempts));
  assert.deepEqual(out.set_aside.map((c) => c.id), ["crlf"]);
  assert.match(out.set_aside[0].output ?? "", /exit 1|^$/);
  assert.equal(existsSync(join(root, "fix-crlf")), false, "a set-aside check's write form never runs");
  assert.equal(existsSync(join(root, "fix-ok")), true, "a check that passed before keeps its write form");
  assert.equal(model.calls.length, 1, "no retry spent on a check the file failed before the change");
  rmSync(root, { recursive: true, force: true });
});

test("runApplyLoop: a new file's checks run first on its style file; with none, every check judges the answer", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "style.ts"), "x\r\n");
  const crlfOnly = normalizeApply({ write: true, checks: [{ id: "crlf", run: CRLF_CHECK }], baseline_from: "src/style.ts" });
  const a = await runApplyLoop({ packet: basePacket(), apply: crlfOnly, projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: stubModel([{ content: "y\r\n" }]).dispatch, log: silent });
  assert.equal(a.status, "applied");
  assert.deepEqual(a.set_aside.map((c) => c.id), ["crlf"]);
  const noStyle = normalizeApply({ write: true, checks: [{ id: "crlf", run: CRLF_CHECK }], max_retries: 0 });
  const b = await runApplyLoop({ packet: basePacket({ id: "tp_2", artifact_path: "src/b.ts" }), apply: noStyle, projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: stubModel([{ content: "y\r\n" }]).dispatch, log: silent });
  assert.equal(b.status, "verify_failed", "no style file: the check judges the answer");
  assert.equal(b.set_aside, undefined);
  rmSync(root, { recursive: true, force: true });
});

test("runApplyLoop: a check that passed before the change still judges the answer, and its failure is a retry", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "out.ts"), "const a = 1;\n");
  const model = stubModel([{ path: "src/out.ts", edits: [{ search: "const a = 1;\n", replace: "const a = 1;\nbad\n" }] }, { path: "src/out.ts", edits: [{ search: "const a = 1;\n", replace: "const a = 1;\nconst b = 2;\n" }] }]);
  const NO_BAD = "node -e \"process.exit(require('fs').readFileSync(process.argv[1],'utf8').includes('bad')?1:0)\" {path}";
  const apply = normalizeApply({ write: true, mode: "edits", checks: [{ id: "no-bad", run: NO_BAD }] });
  const out = await runApplyLoop({ packet: basePacket(), apply, projectRoot: root, keepEvents: true, route: flashUntil(5), dispatch: model.dispatch, log: silent });
  assert.equal(out.status, "applied");
  assert.equal(model.calls.length, 2);
  assert.equal(out.set_aside, undefined);
  rmSync(root, { recursive: true, force: true });
});
