/**
 * The plugin ships its server and the code its scripts load as pre-built, committed bundles
 * (plugin/mcp/model-dispatch/bundle/server.mjs and bundle/lib.mjs).
 *
 * Why: a plugin installed from its marketplace gets only committed files, and dist/ and node_modules/ are not
 * committed. Without the bundles the server would not start, and the run-start check, the hand-off model lookup, the
 * cost collector and the manifest writer would all fail until a setup step built them. These tests hold that:
 *   1. the committed bundles are exactly what the current source builds to (so they can never go stale unnoticed);
 *   2. a copy of the plugin with nothing installed or built (what a GitHub install is) starts the server and lists
 *      its tools, and the scripts that load the server's code work;
 *   3. the manifest starts the bundle, and an unset variable expands to empty instead of a plugin error;
 *   4. no runtime script loads the compiled dist/.
 * Offline and free: tsc and esbuild run locally; nothing calls a model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const PLUGIN = join(ROOT, "plugin");
const SERVER = join(PLUGIN, "mcp", "model-dispatch");
const BUNDLES = ["server.mjs", "lib.mjs"].map((f) => join(SERVER, "bundle", f));
const canBuild = existsSync(join(SERVER, "node_modules", "esbuild")) && existsSync(join(SERVER, "node_modules", "typescript"));

test("the committed bundles are exactly what the current source builds to", { skip: canBuild ? false : "NOT RUN: the server's dev dependencies are not installed (cd plugin/mcp/model-dispatch && npm ci)" }, async () => {
  // Compile src/ into a temporary folder inside the package (so its libraries resolve exactly as in the real build),
  // so the check never depends on whether dist/ is fresh. Ignored by git (.gitignore: .bundle-check-*).
  const out = mkdtempSync(join(SERVER, ".bundle-check-"));
  try {
    execFileSync(process.execPath, [join(SERVER, "node_modules", "typescript", "bin", "tsc"), "-p", SERVER, "--outDir", out, "--sourceMap", "false"], { stdio: "pipe" });
    const { buildBundles } = await import(pathToFileURL(join(SERVER, "scripts", "bundle.mjs")).href);
    for (const { out: file, text } of await buildBundles({ write: false, distDir: out })) {
      assert.ok(existsSync(file), `${relative(ROOT, file)} is missing: run npm run build in plugin/mcp/model-dispatch`);
      assert.ok(readFileSync(file, "utf8") === text, `${relative(ROOT, file)} is stale: run npm run build in plugin/mcp/model-dispatch and commit bundle/`);
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

/** A copy of plugin/ the way a GitHub install has it: no node_modules, no dist. */
function githubStyleCopy() {
  const dir = mkdtempSync(join(tmpdir(), "mmo-fresh-install-"));
  cpSync(PLUGIN, join(dir, "plugin"), {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|dist|\.venv|__pycache__)([\\/]|$)/.test(relative(PLUGIN, src) ? `/${relative(PLUGIN, src)}` : ""),
  });
  return { dir, plugin: join(dir, "plugin"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a copy with nothing installed or built starts the server and lists its tools", async () => {
  const c = githubStyleCopy();
  const home = mkdtempSync(join(tmpdir(), "mmo-fresh-home-"));
  assert.ok(!existsSync(join(c.plugin, "mcp", "model-dispatch", "node_modules")), "the copy has no libraries installed");
  assert.ok(!existsSync(join(c.plugin, "mcp", "model-dispatch", "dist")), "the copy has no build");
  const p = spawn(process.execPath, [join(c.plugin, "mcp", "model-dispatch", "bundle", "server.mjs")], {
    stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), MMO_HANDOFF_TOOLS: "on" },
  });
  let stderr = "";
  p.stderr.on("data", (d) => { stderr += d; });
  try {
    const waiting = new Map();
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      }
    });
    let next = 1;
    const ask = (method, params = {}) => new Promise((done, fail) => {
      const id = next++;
      waiting.set(id, done);
      setTimeout(() => fail(new Error(`no answer to ${method} in 15 s; stderr: ${stderr.slice(0, 600)}`)), 15_000).unref();
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    const init = await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.serverInfo.name, "model-dispatch");
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const names = (await ask("tools/list")).result.tools.map((t) => t.name);
    for (const t of ["execute_with_model", "execute_stage", "load_policy", "preflight_dispatch", "write_document"]) assert.ok(names.includes(t), `${t} is listed`);
    const loaded = await ask("tools/call", { name: "load_policy", arguments: { policy_name: "opus-plus-flash-v38" } });
    assert.ok(!loaded.result.isError, `load_policy works from the bundle: ${JSON.stringify(loaded.result).slice(0, 300)}`);
    assert.doesNotMatch(stderr, /DeprecationWarning|Cannot find module|ERR_MODULE_NOT_FOUND/, "no missing module and no deprecation warning");
  } finally { p.kill(); c.cleanup(); rmSync(home, { recursive: true, force: true }); }
});

test("in that copy, the scripts that load the server's code work, and say nothing on stderr", () => {
  const c = githubStyleCopy();
  try {
    const run = (script, args) => execFileSync(process.execPath, [join(c.plugin, "scripts", script), ...args], { cwd: c.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    // Run through a link to the copy as well: handoff-models.mjs must answer in a plugin folder reached through a link
    // (on a Mac, /var is one).
    const link = join(c.dir, "linked-plugin");
    symlinkSync(c.plugin, link);
    const linked = JSON.parse(execFileSync(process.execPath, [join(link, "scripts", "handoff-models.mjs"), "--policy", "opus-plus-flash-v38"], { encoding: "utf8" }));
    assert.equal(linked.policy, "opus-plus-flash-v38", "handoff-models works through a linked folder");
    // The workflows' run-start check: the judgment model the policy needs.
    assert.equal(run("driver-model-check.mjs", ["--project-root", c.dir, "--policy", "opus-plus-flash-v38", "--print-only"]).trim(), "claude-opus-5");
    // Hand-off's model lookup: one model per kind of work.
    const routes = JSON.parse(run("handoff-models.mjs", ["--policy", "opus-plus-flash-v38"]));
    assert.equal(routes.policy, "opus-plus-flash-v38");
    assert.ok(Object.keys(routes.routes).length >= 3, "a model for each kind of hand-off work");
    // The run-end manifest writer.
    const out = mkdtempSync(join(c.dir, "run-"));
    run("write-manifest.mjs", [out, "--pass", "p1", "--policy", "opus-plus-flash-v38", "--project-root", c.dir]);
    assert.ok(existsSync(join(out, "manifest.json")), "the manifest is written");
    // A feature run's spec check prints greenfield's schema shapes from the bundle.
    assert.match(run("plan-lint.mjs", ["--shape"]), /^units-NNN\.json: \{id: /m, "plan-lint loads the spec schema from the bundle");
  } finally { c.cleanup(); }
});

// The scripts' bundle gained greenfield's spec schema and store for the feature run's change spec (lib.ts). Every
// namespace the other scripts load must export exactly what its compiled module does, so nothing they use changed.
test("each namespace of the scripts' bundle exports exactly its server module's names", { skip: existsSync(join(SERVER, "dist", "lib.js")) ? false : "NOT RUN: dist/ is not built (cd plugin/mcp/model-dispatch && npm run build)" }, async () => {
  const lib = await import(pathToFileURL(join(SERVER, "bundle", "lib.mjs")).href);
  const modules = { policy: "policy.js", routing: "routing.js", executorRun: "executor/run.js", telemetry: "telemetry.js", pricing: "pricing.js", prices: "prices.js", effectivePrice: "effectivePrice.js", adapters: "adapters/index.js", specSchema: "spec/schema.js", specStore: "spec/store.js" };
  assert.deepEqual(Object.keys(lib).sort(), Object.keys(modules).sort());
  for (const [ns, file] of Object.entries(modules)) {
    const mod = await import(pathToFileURL(join(SERVER, "dist", file)).href);
    assert.deepEqual(Object.keys(lib[ns]).sort(), Object.keys(mod).sort(), ns);
  }
});

test("the manifest starts the shipped bundle, and an unset variable expands to empty instead of a plugin error", () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
  const server = manifest.mcpServers["model-dispatch"];
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/mcp/model-dispatch/bundle/server.mjs"]);
  for (const f of BUNDLES) assert.ok(existsSync(f), `${relative(ROOT, f)} is in the repo`);
  // Claude Code lists a bare "${NAME}" that is unset as a plugin error ("Missing environment variables"), on nearly
  // every install; "${NAME:-}" expands to empty, which the server treats as unset (envBootstrap.ts).
  for (const [name, value] of Object.entries(server.env)) assert.equal(value, `\${${name}:-}`, `${name} has an empty default`);
});

test("no runtime script loads the compiled dist/", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === "node_modules") continue;
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|js|sh)$/.test(name)) continue;
      const text = readFileSync(p, "utf8");
      // verify-setup.mjs names dist/ only to repair a copy without the bundle (a clone being developed).
      if (name === "verify-setup.mjs") continue;
      if (/model-dispatch["'`\/,\s]+(?:[^\n]*?)["'`\/]dist["'`\/]/.test(text)) offenders.push(relative(ROOT, p));
    }
  };
  walk(join(PLUGIN, "scripts"));
  walk(join(PLUGIN, "hooks"));
  walk(join(ROOT, "zero-touch"));
  assert.deepEqual(offenders, [], "these still load dist/, which a GitHub install does not have");
});
