/**
 * execute_batch through the real server with a brownfield run's Claude leaf: the lean Opus typist types every packet
 * (applyTypist.ts), and the inputs every packet carries (the plan's House style) are its cached system-prompt file,
 * sent once per call, while each packet's own unit section stays in the packet (batch.ts markSharedInputs).
 * A stand-in `claude` on PATH records what it was sent: no model is called, $0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { wireLog } from "./serverHarness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELP = "--tools --append-system-prompt-file --effort --strict-mcp-config --safe-mode --disable-slash-commands --no-session-persistence";
const POLICY = `version: 1
name: opus-solo
models:
  - id: opus
    adapter: builtin-anthropic
    model_name: claude-opus-5
rules:
  - default: opus
`;
const PLAN = `# Change plan

## House style

HOUSE-STYLE-RULES: two-space indent.

## A1 — src/a.ts

UNIT-A1-SPEC

## A2 — src/b.ts

UNIT-A2-SPEC
`;

/**
 * A stand-in claude: answers --version/--help, records the system file and the prompt of each call, and prints a
 * receipt whose answer names the file the prompt asks for (the server refuses an answer that names another file, as
 * greenfield's executor does: executor/checks.ts checkAnswer).
 */
function standInClaude() {
  const bin = mkdtempSync(join(tmpdir(), "lean-batch-bin-"));
  const receipt = (path) => ({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ path, content: "export const x = 1;\n" }), usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 20 }, modelUsage: { "claude-opus-5": { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
  writeFileSync(join(bin, "help.txt"), HELP + "\n");
  writeFileSync(join(bin, "receipt.json"), JSON.stringify(receipt("src/a.ts")));
  writeFileSync(join(bin, "receipt-b.json"), JSON.stringify(receipt("src/b.ts")));
  writeFileSync(join(bin, "claude"), `#!/bin/sh
case "$1" in
  --version) echo "2.1.300 (Claude Code)"; exit 0;;
  --help) cat "${bin}/help.txt"; exit 0;;
esac
while [ $# -gt 0 ]; do
  if [ "$1" = "--append-system-prompt-file" ]; then cat "$2" >> "${bin}/systems.log"; printf '\\n=====\\n' >> "${bin}/systems.log"; fi
  shift
done
prompt=$(mktemp)
cat > "$prompt"
cat "$prompt" >> "${bin}/prompts.log"
printf '\\n=====\\n' >> "${bin}/prompts.log"
if grep -q 'Implement src/b.ts' "$prompt"; then cat "${bin}/receipt-b.json"; else cat "${bin}/receipt.json"; fi
rm -f "$prompt"
`);
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
}

const unit = (id, path) => ({
  id: `tp_codegen_${id}`, phase: "codegen", task_type: "service_method", module: "m", pass_id: "r1", intent: "feature-new",
  instruction: `Implement ${path}. Return JSON {path, content}.`,
  inputs: [{ path: "change_plan.md", section: id, reason: "unit spec (stable run record)" }, { path: "change_plan.md", section: "House style", reason: "house style (stable run record)" }],
  acceptance: [], budget: { maxInputTokens: 8000, maxOutputTokens: 4000 }, artifact_path: path, apply: { write: true },
});

/** A project with a live run's write contract and the plan, the real server with a stand-in claude, one batch run. */
async function batchOnce(policyYaml, extraArgs = {}) {
  const root = mkdtempSync(join(tmpdir(), "lean-batch-"));
  const bin = standInClaude();
  writeFileSync(join(root, "policy.yaml"), policyYaml);
  writeFileSync(join(root, "change_plan.md"), PLAN);
  mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, run_id: "r1", allowlist: ["src/**"] }));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(HERE, "..", "dist", "server.js")], env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, MMO_LOG_LEVEL: "error" }, stderr: "ignore" });
  const client = new Client({ name: "lean-batch-test", version: "0" });
  await client.connect(transport);
  // Progress is read on the wire, where the server owes every message before the reply (serverHarness.mjs wireLog).
  const wire = wireLog(transport);
  try {
    const policy_path = join(root, "policy.yaml");
    const pre = await client.callTool({ name: "preflight_dispatch", arguments: { auth_mode: "estimated", policy_path, project_root: root } });
    assert.notEqual(pre.isError, true, pre.content[0].text);
    const from = wire.mark();
    const r = await client.callTool({ name: "execute_batch", arguments: { packets: [unit("A1", "src/a.ts"), unit("A2", "src/b.ts")], project_root: root, policy_path, run_id: "r1", auth_mode: "estimated", ...extraArgs(root) } }, undefined, { onprogress: () => {} });
    assert.notEqual(r.isError, true, r.content[0].text);
    const progress = wire.progressOf(from);
    return { root, bin, receipt: JSON.parse(r.content[0].text), text: r.content[0].text, progress };
  } finally {
    await client.close();
  }
}
const cleanup = (...dirs) => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); };

test("execute_batch, brownfield run, Claude leaf: the lean typist gets the shared House style as its system file and each unit in its packet", async () => {
  const { root, bin, receipt, text, progress } = await batchOnce(POLICY, () => ({}));
  try {
    assert.equal(receipt.counts?.applied ?? receipt.applied?.length, 2, text);
    assert.deepEqual(progress.map((p) => [p.progress, p.total]), [[1, 2], [2, 2]], "a progress message per finished packet");
    assert.ok(existsSync(join(root, "src", "a.ts")) && existsSync(join(root, "src", "b.ts")));
    const systems = readFileSync(join(bin, "systems.log"), "utf8").split("\n=====\n").filter(Boolean);
    const prompts = readFileSync(join(bin, "prompts.log"), "utf8").split("\n=====\n").filter(Boolean);
    assert.equal(systems.length, 2);
    assert.equal(systems[0], systems[1], "the same system file for both packets: the second call reads the cache");
    assert.match(systems[0], /HOUSE-STYLE-RULES/);
    assert.doesNotMatch(systems[0], /UNIT-A/);
    assert.ok(prompts.some((p) => /UNIT-A1-SPEC/.test(p)) && prompts.some((p) => /UNIT-A2-SPEC/.test(p)));
    assert.ok(prompts.every((p) => !/HOUSE-STYLE-RULES/.test(p)), "the shared input is not sent again in the packet");
  } finally {
    cleanup(root, bin);
  }
});

// Greenfield's rule for its typists' events: each names its door, so the run's true total never subtracts it as a
// claude-cli worker whose own session transcript was scanned (collect-orchestrator-usage.mjs inSessionDispatched): the
// lean typist runs `claude -p` with no session file.
test("execute_batch: every lean typist call writes one vendor-priced event naming its door, which the true total keeps", async () => {
  const CLI = POLICY.replace("adapter: builtin-anthropic", "adapter: claude-cli");
  const { root, bin } = await batchOnce(CLI, (r) => ({ telemetry_path: join(r, "telemetry.jsonl") }));
  try {
    const events = readFileSync(join(root, "telemetry.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events.length, 2);
    for (const ev of events) {
      assert.equal(ev.door, "lean-opus");
      assert.equal(ev.provenance, "vendor");
      assert.ok(ev.cost_usd > 0, "priced from the call's own receipt");
    }
    const { inSessionDispatched } = await import(join(HERE, "..", "..", "..", "scripts", "collect-orchestrator-usage.mjs"));
    const policy = { models: [{ id: "opus", model_name: "claude-opus-5", adapter: "claude-cli" }] };
    const total = events.reduce((a, ev) => a + ev.cost_usd, 0);
    assert.equal(inSessionDispatched(events, policy, { totals: { models_used: ["claude-opus-5"] } }, total).cost, 0, "nothing subtracted");
  } finally {
    cleanup(root, bin);
  }
});

// The agent door, greenfield's way: the Antigravity agent answers from its own scratch folder and the server writes the
// file through the apply loop (write contract, provenance, checks), so a brownfield run can route to it. A stand-in for the
// worker's Python writes the receipt the real worker writes (typist_worker.py: finish_output, usage): no model, $0.
test("execute_batch, brownfield run, agent-door leaf: greenfield's agent typist answers and the server writes the file", async () => {
  const fake = mkdtempSync(join(tmpdir(), "agy-fake-"));
  const py = join(fake, "python");
  writeFileSync(py, `#!/bin/sh
out=""; prev=""
for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; prev="$a"; done
printf '%s' '{"finish_output":"{\\"path\\":\\"src/a.ts\\",\\"content\\":\\"export const fromAgent = 1;\\\\n\\"}","usage":{"prompt_tokens":120,"cached_tokens":0,"completion_tokens":30},"sdk_version":"0.1.16","tool_calls":[]}' > "$out"
`);
  chmodSync(py, 0o755);
  const AGY_POLICY = `version: 1
name: agy-solo
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
`;
  const root = mkdtempSync(join(tmpdir(), "agy-batch-"));
  const bin = standInClaude();
  writeFileSync(join(root, "policy.yaml"), AGY_POLICY);
  writeFileSync(join(root, "change_plan.md"), PLAN);
  mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ schema_version: 1, active: true, run_id: "r1", allowlist: ["src/**"] }));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(HERE, "..", "dist", "server.js")], env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, MMO_LOG_LEVEL: "error", GEMINI_WORKER_PYTHON: py, GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global" }, stderr: "ignore" });
  const client = new Client({ name: "agy-batch-test", version: "0" });
  await client.connect(transport);
  try {
    const policy_path = join(root, "policy.yaml");
    const pre = await client.callTool({ name: "preflight_dispatch", arguments: { auth_mode: "estimated", policy_path, project_root: root } });
    assert.notEqual(pre.isError, true, pre.content[0].text);
    const r = await client.callTool({ name: "execute_batch", arguments: { packets: [unit("A1", "src/a.ts")], project_root: root, policy_path, run_id: "r1", auth_mode: "estimated", telemetry_path: join(root, "telemetry.jsonl") } });
    assert.notEqual(r.isError, true, r.content[0].text);
    assert.equal(readFileSync(join(root, "src", "a.ts"), "utf8"), "export const fromAgent = 1;\n", r.content[0].text);
    const events = readFileSync(join(root, "telemetry.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events[0].door, "agy");
  } finally {
    await client.close();
    cleanup(root, bin, fake);
  }
});
