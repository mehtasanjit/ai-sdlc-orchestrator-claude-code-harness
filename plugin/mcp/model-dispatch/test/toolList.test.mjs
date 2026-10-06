/**
 * The tools this server lists, read the way Claude Code reads them: the built server started over stdio, an MCP
 * `initialize`, then `tools/list`.
 *
 * The list is the pipeline's own tools, the executor's, and the tools of zero-touch's hand-off mode, and nothing else.
 *
 * The hand-off tools are listed only where a Hand-off chat can use them (handoffListing.test.mjs). A call is refused
 * unless the plugin's hook stamped it in a hand-off chat, which the second test proves through the real server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");

/**
 * Starts the server, sends one request after the handshake, stops it, and returns the request's result. Messages are
 * newline-delimited JSON-RPC (the MCP stdio transport).
 */
function ask(method, params, env = {}) {
  const project = mkdtempSync(join(tmpdir(), "mmo-tool-list-"));
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [SERVER], {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: project, CLAUDE_PROJECT_DIR: project, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stop = setTimeout(() => { p.kill(); fail(new Error(`the server did not answer ${method} within 15 s`)); }, 15000);
    let buf = "";
    p.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) + "\n");
        } else if (msg.id === 2) {
          clearTimeout(stop);
          p.kill();
          rmSync(project, { recursive: true, force: true });
          done(msg.result ?? {});
        }
      }
    });
    p.on("error", fail);
    p.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tool-list-test", version: "0" } },
    }) + "\n");
  });
}

// A machine where zero-touch may use the hand-off tools (a setup with no record of installed plugins and no
// zero-touch data folder, as this bare test home is, lists none; handoffListing.test.mjs).
const listTools = async (env = { MMO_HANDOFF_TOOLS: "on" }) => (await ask("tools/list", {}, env)).tools ?? [];

test("the server lists the pipeline's tools, the executor's and hand-off mode's, and nothing else", async () => {
  const names = (await listTools()).map((t) => t.name).sort();
  assert.deepEqual(names, [
    "execute_batch",
    "execute_stage",
    "execute_with_model",
    "finalize_spec",
    "load_policy",
    "log_telemetry",
    "preflight_dispatch",
    "repeat_edit_across_files",
    "simulate_policy",
    "submit_spec_section",
    "undo_hand_off",
    "write_document",
    "write_tests_from_cases",
  ]);
});

test("a hand-off tool call reaches the real server: refused without the hook's stamp, and its form is checked in a hand-off chat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-handoff-server-"));
  try {
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    const session = join(home, "sessions", "chat1");
    mkdirSync(session, { recursive: true });
    mkdirSync(repo);
    writeFileSync(join(repo, "README.md"), "# Shop\n");
    writeFileSync(join(session, "chat_mode"), "b");
    const typist = { typist: "flash", policy: "opus-plus-flash-v38" };
    writeFileSync(join(session, "handoff.json"), JSON.stringify({ chat_model: "claude-opus-5", pin: "setting", typists: { documents: typist, tests: typist, repeats: typist } }));
    const flash = { id: "flash-completion", model: "gemini-3.8-flash", adapter: "mcp:model-dispatch", policy: "opus-plus-flash-v38" };
    writeFileSync(join(session, "handoff_models.json"), JSON.stringify({ routes: { docs: flash, tests: flash, repeat: flash } }));
    const form = { kind: "docs", file: "README.md", purpose: "p", readers: "r", sections: [{ heading: "Install", must_say: "how" }], facts: [{ statement: "Install with `npm ci`.", source: "chat" }] };
    const call = async (args) => JSON.parse((await ask("tools/call", { name: "write_document", arguments: args }, { MMO_HOME: home })).content[0].text);

    const unstamped = await call(form);
    assert.equal(unstamped.status, "refused");
    assert.match(unstamped.reason, /carries no stamp from the plugin's hook/);

    // Stamped as the hook stamps it. The form names a file that exists, so it is refused before any model is called:
    // the whole path (the listing, the dispatch, the chat's records, the form check) ran with no network.
    const stamped = await call({ ...form, _mmo: { session_id: "chat1", project_dir: repo, auth: "estimated" } });
    assert.equal(stamped.status, "refused");
    assert.match(stamped.problems.join("\n"), /README\.md exists already/);
    assert.ok(!existsSync(join(session, "handoff-telemetry.jsonl")), "nothing was sent, so nothing is on the chat's bill");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
