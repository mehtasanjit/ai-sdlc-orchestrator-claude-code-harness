/**
 * Shared pieces for the tests that drive the real server (dist/server.js) over MCP stdio: a project with a live run's
 * write contract, a stand-in `claude` on PATH that records each call and answers from a queue of receipts, and one
 * connected client. No model is called, $0. Not a test file itself (node --test runs test/*.test.mjs only).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVER = join(HERE, "..", "dist", "server.js");
const HELP = "--tools --append-system-prompt-file --effort --strict-mcp-config --safe-mode --disable-slash-commands --no-session-persistence";

/** A `claude -p --output-format json` receipt that answers `answer` (an object, sent as the JSON reply text). */
export function receipt(answer, { usage = {}, error } = {}) {
  const u = { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 20, ...usage };
  const model = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadInputTokens: u.cache_read_input_tokens, cacheCreationInputTokens: u.cache_creation_input_tokens };
  if (error) return { type: "result", subtype: "error_during_execution", is_error: true, api_error_status: error.status, result: error.message, usage: u, modelUsage: { __MODEL__: model } };
  return { type: "result", subtype: "success", is_error: false, result: JSON.stringify(answer), usage: u, modelUsage: { __MODEL__: model } };
}

/**
 * A stand-in claude: answers --version/--help; for a call it appends `<model>` to models.log and the prompt to
 * prompts.log, then prints the n-th queued receipt (the last one once the queue runs out), its model usage named by
 * the --model it was given.
 */
export function standInClaude(queue) {
  const bin = mkdtempSync(join(tmpdir(), "mmo-standin-claude-"));
  writeFileSync(join(bin, "help.txt"), HELP + "\n");
  queue.forEach((r, i) => writeFileSync(join(bin, `answer-${i + 1}.json`), JSON.stringify(r)));
  writeFileSync(join(bin, "answer-last.json"), JSON.stringify(queue[queue.length - 1]));
  writeFileSync(join(bin, "claude"), `#!/bin/sh
case "$1" in
  --version) echo "2.1.300 (Claude Code)"; exit 0;;
  --help) cat "${bin}/help.txt"; exit 0;;
esac
model=""; prev=""
for a in "$@"; do [ "$prev" = "--model" ] && model="$a"; prev="$a"; done
cat >> "${bin}/prompts.log"
printf '\\n=====\\n' >> "${bin}/prompts.log"
n=$(cat "${bin}/count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${bin}/count"
echo "$model" >> "${bin}/models.log"
f="${bin}/answer-$n.json"; [ -f "$f" ] || f="${bin}/answer-last.json"
sed "s/__MODEL__/$model/" "$f"
`);
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
}

/** The --model of every call the stand-in answered, in order. */
export function calledModels(bin) {
  const f = join(bin, "models.log");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
}

/** A project folder: `files` written as given, a policy per name, and (unless `contract: false`) a live run's contract. */
export function project({ files = {}, contract = { schema_version: 1, active: true, run_id: "r1", allowlist: ["src/**", "docs/**"] } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmo-server-test-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  if (contract) {
    mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
    writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify(contract));
  }
  return root;
}

/**
 * One server process with `bin` first on PATH; `fn(call)` runs with `call(name, args, opts?)` returning
 * {isError, text, json}. `opts` goes to the client's callTool as its request options (e.g. `onprogress`, which makes
 * the call ask for progress messages).
 */
export async function withServer({ bin, home, env = {} }, fn) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, MMO_LOG_LEVEL: "error", ...env }, stderr: "ignore" });
  const client = new Client({ name: "server-harness", version: "0" });
  await client.connect(transport);
  try {
    return await fn(async (name, args, opts) => {
      const r = await client.callTool({ name, arguments: args }, undefined, opts);
      const text = r.content?.[0]?.text ?? "";
      let json;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { isError: r.isError === true, text, json };
    });
  } finally {
    await client.close();
  }
}

/** The JSONL events of a telemetry file. */
export function events(file) {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

export const cleanup = (...dirs) => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); };

/** A brownfield run's apply packet (plan-to-packets' shape). */
export function packet(id, path, over = {}) {
  return {
    id, phase: "codegen", task_type: "", module: "spec", pass_id: "r1", intent: "feature-new",
    instruction: `Write ${path}. Return JSON {path, content}.`,
    inputs: [], acceptance: [], budget: { maxInputTokens: 8000, maxOutputTokens: 4000 }, artifact_path: path,
    apply: { write: true }, ...over,
  };
}
