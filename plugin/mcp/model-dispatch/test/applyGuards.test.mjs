/**
 * The apply form is brownfield's writer: the server refuses it without an active write contract, and
 * refuses to hand an apply packet to an Antigravity worker, which edits the folder itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const POLICY = `version: 1
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
`;

const packet = {
  id: "tp_codegen_001", phase: "codegen", task_type: "service_method", module: "api", pass_id: "r1",
  instruction: "Write the file.", inputs: [], acceptance: ["compiles"],
  budget: { maxInputTokens: 4000, maxOutputTokens: 3000 }, artifact_path: "src/out.ts",
  apply: { write: true },
};

async function callExecute(root, policy_path) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(HERE, "..", "dist", "server.js")], env: { PATH: process.env.PATH, HOME: root, MMO_LOG_LEVEL: "error" }, stderr: "ignore" });
  const client = new Client({ name: "apply-guards-test", version: "0" });
  await client.connect(transport);
  try {
    return await client.callTool({ name: "execute_with_model", arguments: { packet, project_root: root, policy_path, run_id: "r1", auth_mode: "estimated" } });
  } finally {
    await client.close();
  }
}

function project(contract) {
  const root = mkdtempSync(join(tmpdir(), "apply-guards-"));
  writeFileSync(join(root, "policy.yaml"), POLICY);
  if (contract) {
    mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify(contract));
  }
  return root;
}

test("no active write contract: the apply form is refused before any model is called", async () => {
  for (const contract of [null, { schema_version: 1, active: false, allowlist: ["src/**"] }]) {
    const root = project(contract);
    try {
      const r = await callExecute(root, join(root, "policy.yaml"));
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /apply form writes only inside a brownfield run/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an apply packet routed to an antigravity-worker leaf is refused", async () => {
  const root = project({ schema_version: 1, active: true, strict: true, allowlist: ["src/**"], off_limits: [] });
  try {
    const r = await callExecute(root, join(root, "policy.yaml"));
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /do not run agent-door workers/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
