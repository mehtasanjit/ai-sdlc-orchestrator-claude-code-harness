/**
 * The paths the brownfield writer reads into a model's prompt and writes (apply.ts hydrateInputs, checkWriteContract).
 * One read rule for everything sent to a model: never an off-limits file (the hardcoded list at any depth, the live
 * contract's off_limits), judged on the path as written and on the real path a symlink leads to, and never anything
 * outside the project. Off-limits matching ignores case, because the disks it runs on (macOS's by default) do: a
 * name in another case is the same file. Temp folders only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { hydrateInputs, checkWriteContract, FILE_OUTPUT_SCHEMA } = await import(join(HERE, "..", "dist", "apply.js"));
const { formatLine } = await import(join(HERE, "..", "..", "..", "scripts", "lib", "log.mjs"));

const RUN = "20261006-120000-bugfix-x";
const packet = (inputs) => ({
  id: "tp_1", phase: "codegen", task_type: "", module: "spec", pass_id: "r", instruction: "x", inputs, outputSchema: FILE_OUTPUT_SCHEMA,
  acceptance: [], budget: { maxInputTokens: 1, maxOutputTokens: 1 }, artifact_path: "src/a.ts",
});
const slice = (path) => ({ path, reason: "context" });

/** A project, a folder beside it (outside), and optionally a live run whose contract binds. */
function setup(contract) {
  const base = mkdtempSync(join(tmpdir(), "mmo-apply-paths-"));
  const root = join(base, "proj");
  const outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, ".env"), "KEY=1\n");
  if (contract) {
    mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, mode: "brownfield", run_id: RUN, strict: true, ...contract }));
    mkdirSync(join(root, ".sdlc", "runs", RUN, "briefs"), { recursive: true });
    writeFileSync(join(root, ".sdlc", "runs", RUN, "orchestrator.log"), formatLine("info", "run.start", { run_id: RUN }) + "\n");
    writeFileSync(join(root, ".sdlc", "runs", RUN, "briefs", "shared.md"), "# Shared\n");
  }
  return { base, root, outside };
}

test("a slice that leads outside the project through a symlinked file or folder is never read", () => {
  const { base, root, outside } = setup();
  symlinkSync(join(outside, "secret.txt"), join(root, "src", "link.ts"));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(outside, join(root, "node_modules", "linked-pkg"));
  assert.throws(() => hydrateInputs(packet([slice("src/link.ts")]), root), /outside project_root/);
  assert.throws(() => hydrateInputs(packet([slice("node_modules/linked-pkg/secret.txt")]), root), /outside project_root/);
  assert.throws(() => hydrateInputs(packet([slice("src")]), root), /not a file/);
  // A symlink that stays inside the project is read as its target.
  symlinkSync(join(root, "src", "a.ts"), join(root, "src", "alias.ts"));
  assert.equal(hydrateInputs(packet([slice("src/alias.ts")]), root).packet.inputs[0].content, "export const a = 1;\n");
  rmSync(base, { recursive: true, force: true });
});

test("an off-limits file is never read into a prompt: the hardcoded list at any depth and in any case, and through a symlink", () => {
  const { base, root } = setup();
  mkdirSync(join(root, "apps", "api"), { recursive: true });
  writeFileSync(join(root, "apps", "api", ".env.local"), "K=2\n");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  for (const p of [".env", "apps/api/.env.local", ".git/config", ".ENV", "apps/api/.Env.Local", ".GIT/config"]) {
    assert.throws(() => hydrateInputs(packet([slice(p)]), root), /off-limits/, p);
  }
  symlinkSync(join(root, ".env"), join(root, "src", "settings.ts"));
  assert.throws(() => hydrateInputs(packet([slice("src/settings.ts")]), root), /off-limits/, "the real path is judged too");
  rmSync(base, { recursive: true, force: true });
});

test("the live contract's off_limits are never read either; the live run's own folder is, whatever off_limits says", () => {
  const { base, root } = setup({ allowlist: ["src/**"], off_limits: [".sdlc/**", "secrets/**"] });
  mkdirSync(join(root, "secrets"));
  writeFileSync(join(root, "secrets", "k.pem"), "PEM\n");
  assert.throws(() => hydrateInputs(packet([slice("secrets/k.pem")]), root), /off-limits.*secrets\/\*\*/);
  assert.throws(() => hydrateInputs(packet([slice("SECRETS/k.pem")]), root), /off-limits/);
  const ok = hydrateInputs(packet([slice(`.sdlc/runs/${RUN}/briefs/shared.md`), slice("src/a.ts")]), root);
  assert.deepEqual(ok.hydrated, [`.sdlc/runs/${RUN}/briefs/shared.md`, "src/a.ts"]);
  assert.throws(() => hydrateInputs(packet([slice(".sdlc/local/write-contract.json")]), root), /off-limits/);
  rmSync(base, { recursive: true, force: true });
});

test("the writer's off-limits ignore case: a name in another case is the same file on the disk", () => {
  const { base, root } = setup({ allowlist: ["config/**", "**"], off_limits: ["config/secrets.json"] });
  for (const p of ["config/secrets.json", "config/SECRETS.json", "Config/Secrets.JSON", ".ENV", ".GIT/config", ".Git/hooks/pre-commit", "apps/x/.Env.Local"]) {
    assert.equal(checkWriteContract(root, p).allowed, false, p);
  }
  assert.equal(checkWriteContract(root, "config/app.json").allowed, true);
  rmSync(base, { recursive: true, force: true });
  const none = setup();
  for (const p of [".ENV", ".GIT/config", ".MCP.json"]) assert.equal(checkWriteContract(none.root, p).allowed, false, `no contract: ${p}`);
  rmSync(none.base, { recursive: true, force: true });
});

// Greenfield's answer check needs the file's own path, exactly (checks.ts checkAnswer): a packet that names its file
// in any other form could never be written whatever the model answers, so it is refused before any typist is paid, as
// greenfield's stage fails a job whose path is not safe before it types anything.
test("a packet whose file is not named in its normal form is refused before any typist is paid", async () => {
  const { runApplyLoop, normalizeApply } = await import(join(HERE, "..", "dist", "apply.js"));
  const root = mkdtempSync(join(tmpdir(), "mmo-apply-paths-"));
  for (const target of ["./src/out.ts", "src//out.ts", "src/../src/out.ts"]) {
    let calls = 0;
    const out = await runApplyLoop({
      projectRoot: root, keepEvents: true, log: () => {}, route: () => ({ modelId: "flash", reason: "policy", ruleIndex: 0 }),
      packet: { ...packet([]), artifact_path: target }, apply: normalizeApply({ write: true }),
      dispatch: async (p) => { calls++; return { decision: { modelId: "flash", reason: "policy", ruleIndex: 0 }, events: [], result: { success: true, result: { path: p.artifact_path, content: "x\n" }, tokens: { input: 1, input_cached: 0, output: 1 }, cost_usd: 0.01, terminal_reason: "success" } }; },
    });
    assert.equal(out.status, "refused", target);
    assert.match(out.refusal, /normal form/, target);
    assert.equal(calls, 0, `${target}: no typist paid`);
    assert.equal(out.cost_usd, 0);
  }
  rmSync(root, { recursive: true, force: true });
});
