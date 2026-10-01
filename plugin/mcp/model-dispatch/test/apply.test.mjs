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
  deriveFormat,
  extractFileContent,
  provenanceScriptPath,
  runApplyLoop,
  spliceEdits,
  extractEdits,
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

test("checkWriteContract: the run's own folder is writable under an active contract that bans .sdlc/**, other runs are not", () => {
  const root = tmpRoot();
  mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, strict: true, allowlist: ["src/**"], off_limits: [".sdlc/**"] }));
  assert.equal(checkWriteContract(root, ".sdlc/runs/r1/report.json").allowed, false);
  assert.equal(checkWriteContract(root, ".sdlc/runs/r1/report.json", { runId: "r1" }).allowed, true);
  assert.equal(checkWriteContract(root, ".sdlc/runs/r2/report.json", { runId: "r1" }).allowed, false);
  assert.equal(checkWriteContract(root, ".sdlc/runs/r1/../../local/write-contract.json", { runId: "r1" }).allowed, false);
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
        },
        events: [{ task_id: packet.id, retry_count: packet.retry_count ?? 0 }],
      };
    },
  };
}
const flashUntil = (n) => (p) => ({ modelId: (p.retry_count ?? 0) >= n ? "opus" : "flash", reason: "policy", ruleIndex: 1 });
const silent = () => {};

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

test("spliceEdits resolves anchors on the original text, applies bottom-up, and names what it cannot apply", () => {
  const src = "import a from \"a\";\nconst x = 1;\n  });\nreturn {\n  a,\n};\n  });\n";
  const ok = spliceEdits(src, [
    { anchor: "import a from \"a\";", position: "after", text: "import b from \"b\";" },
    { anchor: "  a,", position: "after", text: "  b,\n" },
    { anchor: "const x = 1;", position: "replace", text: "const x = 2;" },
    { anchor: "  });", position: "before", text: "  // second", line: 7 },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.content, "import a from \"a\";\nimport b from \"b\";\nconst x = 2;\n  });\nreturn {\n  a,\n  b,\n};\n  // second\n  });\n");
  assert.match(spliceEdits(src, [{ anchor: "nope", position: "after", text: "x" }]).reason, /anchor not found/);
  assert.match(spliceEdits(src, [{ anchor: "  });", position: "after", text: "x" }]).reason, /matches 2 lines \(3, 7\)/);
  assert.match(spliceEdits(src, [{ anchor: "  });", position: "after", text: "x", line: 2 }]).reason, /matches 2 lines/, "a wrong line hint falls back to the search");
  assert.match(spliceEdits(src, []).reason, /empty/);
  assert.deepEqual(extractEdits({ edits: [{ anchor: "a", position: "after", text: "b" }] }), [{ anchor: "a", position: "after", text: "b", line: undefined }]);
  assert.equal(extractEdits({ edits: [{ anchor: "a", position: "sideways", text: "b" }] }), null);
  assert.equal(extractEdits({ content: "whole file" }), null);
});

test("spliceEdits: delete and multi-line replace take a count; overlapping or out-of-range spans are refused (Run 30)", () => {
  const src = "a\nb\nc\nd\ne\n";
  assert.deepEqual(spliceEdits(src, [{ anchor: "b", position: "delete", text: "" }]), { ok: true, content: "a\nc\nd\ne\n" });
  assert.deepEqual(spliceEdits(src, [{ anchor: "b", position: "delete", text: "", count: 3 }]), { ok: true, content: "a\ne\n" });
  assert.deepEqual(spliceEdits(src, [{ anchor: "b", position: "replace", text: "X", count: 2 }]), { ok: true, content: "a\nX\nd\ne\n" });
  // Adjacent ops still combine: delete b..c, insert before d.
  assert.deepEqual(spliceEdits(src, [{ anchor: "b", position: "delete", text: "", count: 2 }, { anchor: "d", position: "before", text: "Y" }]), { ok: true, content: "a\nY\nd\ne\n" });
  assert.match(spliceEdits(src, [{ anchor: "b", position: "delete", text: "", count: 2 }, { anchor: "c", position: "after", text: "Y" }]).reason, /two edits target line 3/);
  assert.match(spliceEdits(src, [{ anchor: "d", position: "delete", text: "", count: 9 }]).reason, /runs past the end/);
  assert.deepEqual(extractEdits({ edits: [{ anchor: "a", position: "delete", count: 2 }] }), [{ anchor: "a", position: "delete", text: "", line: undefined, count: 2 }]);
  assert.equal(extractEdits({ edits: [{ anchor: "a", position: "after" }] }), null, "only a delete may omit text");
});

test("runApplyLoop in edits mode splices into the existing file and retries a bad anchor with the reason", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "out.ts"), "line1\nline2\n");
  const model = stubModel([
    { edits: [{ anchor: "missing", position: "after", text: "x" }] },
    { edits: [{ anchor: "line1", position: "after", text: "inserted" }] },
  ]);
  const out = await runApplyLoop({
    packet: basePacket(), apply: normalizeApply({ write: true, mode: "edits" }),
    projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: model.dispatch, log: silent,
  });
  assert.equal(out.status, "applied");
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1].instruction, /anchor not found/);
  assert.equal(readFileSync(join(root, "src", "out.ts"), "utf8"), "line1\ninserted\nline2\n");
  const missing = await runApplyLoop({
    packet: basePacket({ artifact_path: "src/absent.ts" }), apply: normalizeApply({ write: true, mode: "edits" }),
    projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: stubModel([{ edits: [] }]).dispatch, log: silent,
  });
  assert.equal(missing.status, "refused");
  rmSync(root, { recursive: true, force: true });
});

test("runApplyLoop in edits mode: a verify failure restores the original, and the retry splices from it (no duplicate insert)", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "out.ts"), "a\nb\nc\n");
  const model = stubModel([
    { edits: [{ anchor: "a", position: "after", text: "inserted-bad" }] },
    { edits: [{ anchor: "a", position: "after", text: "inserted-good" }] },
  ]);
  const out = await runApplyLoop({
    packet: basePacket(), apply: normalizeApply({ write: true, mode: "edits", verify: ["grep -q inserted-good {path}"] }),
    projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: model.dispatch, log: silent,
  });
  assert.equal(out.status, "applied");
  assert.equal(readFileSync(join(root, "src", "out.ts"), "utf8"), "a\ninserted-good\nb\nc\n", "exactly one insertion; attempt 0's line is gone");
  const failed = await runApplyLoop({
    packet: basePacket(), apply: normalizeApply({ write: true, mode: "edits", verify: ["false"], max_retries: 0 }),
    projectRoot: root, keepEvents: true, route: flashUntil(2), dispatch: stubModel([{ edits: [{ anchor: "b", position: "after", text: "x" }] }]).dispatch, log: silent,
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
    format: ["sed -i 's/[[:space:]]*$//' {path}", "false"],
  });
  assert.equal(readFileSync(join(root, "src", "f.ts"), "utf8"), "export const a = 1;\n", "format ran on the written file");
  assert.equal(r.bytes, 20, "the receipt is the file as it stays on disk");
  const prov = JSON.parse(readFileSync(join(root, ".sdlc", "runs", "run-f", "provenance.json"), "utf8"));
  const touched = prov.files_touched.find((f) => f.path === "src/f.ts");
  assert.ok(touched.sha_after.endsWith(createHash("sha256").update("export const a = 1;\n").digest("hex")), "provenance hashes the formatted file");
  rmSync(root, { recursive: true, force: true });
});

test("normalizeApply derives format from verify when a hand-written packet omits it (Large2-C debug packets)", () => {
  assert.deepEqual(normalizeApply({ write: true, verify: ["pnpm exec biome check {path}", "pnpm test"] }).format, ["pnpm exec biome check --write {path}"]);
  assert.deepEqual(normalizeApply({ write: true, verify: ["pnpm exec biome check a.ts"], format: ["x --fix a.ts"] }).format, ["x --fix a.ts"], "an explicit format wins");
  assert.equal(normalizeApply({ write: true, verify: ["pnpm test"] }).format, undefined);
  assert.deepEqual(deriveFormat(["npx prettier --check a.ts"]), ["npx prettier --write a.ts"]);
  assert.equal(deriveFormat(["pnpm exec biome check --write a.ts"]), undefined);
});
