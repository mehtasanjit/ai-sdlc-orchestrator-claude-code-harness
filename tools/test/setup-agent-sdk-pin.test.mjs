/**
 * Setup builds and checks the Antigravity worker's Python environment for every install that will use it: when the
 * project's default policy has an antigravity-worker leaf, not only when MMO_SELECT selects the agent slot. It reads
 * the environment's installed google-antigravity version and treats any version other than requirements.txt's pin
 * as blocking; --fix rebuilds the environment from the hash-locked requirements. requirements.txt pins 0.1.22 and
 * every package it installs, each with its hashes.
 *
 * Offline: the real plugin/scripts/verify-setup.mjs runs from a scratch copy of the plugin's layout, with stand-in
 * interpreters that answer the version questions, "build" a virtualenv and log what pip was asked to install.
 * Nothing is downloaded and no environment is built.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERIFY = join(ROOT, "plugin", "scripts", "verify-setup.mjs");
const REQUIREMENTS = join(ROOT, "plugin", "mcp", "model-dispatch", "worker", "requirements.txt");
const POLICIES = join(ROOT, "plugin", "config", "policies");
const STAND_INS = [join(ROOT, "tools", "test", "lib", "stand-in-bin"), join(ROOT, "tools", "test", "lib", "stand-in-gcloud")];
const pinOf = (text) => text.match(/^google-antigravity==(\S+)/m)?.[1];

/**
 * A stand-in Python: `-c` probes (its version, the SDK import, the installed google-antigravity version, also by
 * `pip show`), `-m venv --clear <dir>` (writes a stand-in interpreter there with the version requirements.txt pins in
 * its working directory) and `-m pip install ...` (logged). Every call is logged to `log`.
 */
const PROGRAM = String.raw`
const { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join, dirname } = require("node:path");
const cfg = JSON.parse(readFileSync(__CFG, "utf8"));
const args = process.argv.slice(2);
appendFileSync(cfg.log, JSON.stringify({ exe: cfg.self, args, cwd: process.cwd() }) + "\n");
const code = args[args.indexOf("-c") + 1] || "";
if (args[0] === "-c" || (args[0] === "-I" && args[1] === "-c")) {
  if (/sys\.version_info/.test(code)) { process.stdout.write(cfg.python + "\n"); process.exit(0); }
  if (/importlib|metadata/.test(code)) { if (!cfg.sdk) { process.stderr.write("PackageNotFoundError: google-antigravity\n"); process.exit(1); } process.stdout.write(cfg.sdk + "\n"); process.exit(0); }
  if (/import google\.antigravity/.test(code)) process.exit(cfg.sdk ? 0 : 1);
  process.exit(0);
}
if (args[0] === "-m" && args[1] === "pip" && args[2] === "show") { if (!cfg.sdk) process.exit(1); process.stdout.write("Name: google-antigravity\nVersion: " + cfg.sdk + "\n"); process.exit(0); }
if (args[0] === "-m" && args[1] === "pip") process.exit(0);
if (args[0] === "-m" && args[1] === "venv") {
  const dir = join(process.cwd(), args[args.length - 1]);
  const pin = (readFileSync(join(process.cwd(), "requirements.txt"), "utf8").match(/^google-antigravity==(\S+)/m) || [])[1] || null;
  const made = join(dir, "bin", "python");
  mkdirSync(dirname(made), { recursive: true });
  const cfgPath = join(dir, "bin", "standin.json");
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, sdk: pin, self: made }));
  writeFileSync(join(dir, "bin", "standin.cjs"), readFileSync(__filename, "utf8").replace(JSON.stringify(__CFG), JSON.stringify(cfgPath)));
  writeFileSync(made, "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(join(dir, "bin", "standin.cjs")) + ' "$@"\n');
  chmodSync(made, 0o755);
  process.exit(0);
}
process.exit(0);
`;

function interpreter(path, { python = "3.12", sdk, log }) {
  mkdirSync(dirname(path), { recursive: true });
  const cfgPath = `${path}.standin.json`;
  writeFileSync(cfgPath, JSON.stringify({ python, sdk, log, self: path }));
  writeFileSync(`${path}.standin.cjs`, PROGRAM.replaceAll("__CFG", JSON.stringify(cfgPath)));
  writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(`${path}.standin.cjs`)} "$@"\n`);
  chmodSync(path, 0o755);
}

/** A scratch copy of what verify-setup.mjs reads of the plugin, a project folder, and stand-in interpreters. */
function scratch({ venvSdk, defaultPolicy } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "setup-pin-"));
  const plugin = join(dir, "plugin");
  const server = join(plugin, "mcp", "model-dispatch");
  mkdirSync(join(plugin, "scripts"), { recursive: true });
  copyFileSync(VERIFY, join(plugin, "scripts", "verify-setup.mjs"));
  for (const f of ["bundle/server.mjs", "bundle/lib.mjs", "dist/server.js"]) { mkdirSync(dirname(join(server, f)), { recursive: true }); writeFileSync(join(server, f), ""); }
  mkdirSync(join(server, "node_modules"), { recursive: true });
  mkdirSync(join(server, "worker"), { recursive: true });
  copyFileSync(REQUIREMENTS, join(server, "worker", "requirements.txt"));
  cpSync(POLICIES, join(plugin, "config", "policies"), { recursive: true });
  const log = join(dir, "python-calls.jsonl");
  if (venvSdk !== undefined) interpreter(join(server, "worker", ".venv", "bin", "python"), { sdk: venvSdk, log });
  const bin = join(dir, "bin");
  interpreter(join(bin, "python3.12"), { sdk: null, log });
  const proj = join(dir, "project");
  mkdirSync(join(proj, ".sdlc"), { recursive: true });
  if (defaultPolicy) writeFileSync(join(proj, ".sdlc", "project.json"), JSON.stringify({ default_policy: defaultPolicy }));
  const home = join(dir, "home");
  mkdirSync(home);
  const adc = join(dir, "adc.json");
  writeFileSync(adc, JSON.stringify({ type: "authorized_user", client_id: "test-client", client_secret: "test-secret", refresh_token: "test-refresh" }));
  const run = (args = [], env = {}) => {
    const r = spawnSync(process.execPath, [join(plugin, "scripts", "verify-setup.mjs"), "--project-root", proj, ...args], {
      cwd: proj, encoding: "utf8", timeout: 60_000,
      env: { PATH: [bin, ...STAND_INS, dirname(process.execPath), "/usr/bin", "/bin"].join(":"), HOME: home, GOOGLE_APPLICATION_CREDENTIALS: adc, GOOGLE_CLOUD_PROJECT: "test-project", ...env },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, run, calls, requirements: readFileSync(join(server, "worker", "requirements.txt"), "utf8"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The report's blocking findings ("  ✗ message\n    fix: ..."), one string each. */
const blocking = (out) => out.split(/\n(?=  [✗!✓] )/).filter((b) => b.trimStart().startsWith("✗"));

// S-verify-setup-version.
test("an agent worker environment holding a google-antigravity other than the pin is a blocking finding naming both versions, and --fix rebuilds it from the hash-locked requirements", () => {
  const s = scratch({ venvSdk: "0.1.9" });
  try {
    const pin = pinOf(s.requirements);
    assert.ok(pin, "requirements.txt pins google-antigravity");
    const env = { MMO_SELECT: "gemini-flash=flash-agsdk-worker" };
    const check = s.run([], env);
    const found = blocking(check.out).find((b) => /google-antigravity/.test(b) && b.includes("0.1.9") && b.includes(pin));
    assert.ok(found, `no blocking finding for google-antigravity 0.1.9 against the pin ${pin}:\n${check.out}`);
    assert.match(found, /--fix/);
    assert.notEqual(check.code, 0);
    const fixed = s.run(["--fix"], env);
    const pip = s.calls().find((c) => c.args[0] === "-m" && c.args[1] === "pip" && c.args[2] === "install");
    assert.ok(pip, `--fix did not install anything:\n${fixed.out}`);
    assert.ok(pip.args.includes("--require-hashes"), `pip install ${pip.args.join(" ")}`);
    assert.ok(pip.args.includes("-r") && pip.args[pip.args.indexOf("-r") + 1] === "requirements.txt");
    assert.ok(s.calls().some((c) => c.args[0] === "-m" && c.args[1] === "venv" && c.args.includes("--clear")), "the environment is rebuilt, not added to");
    assert.ok(!blocking(fixed.out).some((b) => /google-antigravity/.test(b)), `the version finding is gone after --fix:\n${fixed.out}`);
    // An interpreter the person chose (GEMINI_WORKER_PYTHON) is never rebuilt: the finding says to unset it or point
    // it at an environment with the pinned version.
    const own = join(s.dir, "own", "python");
    interpreter(own, { sdk: "0.1.9", log: join(s.dir, "own-calls.jsonl") });
    const chosen = s.run([], { ...env, GEMINI_WORKER_PYTHON: own });
    const named = blocking(chosen.out).find((b) => /google-antigravity/.test(b) && b.includes("0.1.9"));
    assert.ok(named, `no finding for GEMINI_WORKER_PYTHON's 0.1.9:\n${chosen.out}`);
    assert.match(named, /GEMINI_WORKER_PYTHON/);
  } finally {
    s.cleanup();
  }
});

// S-verify-setup-policy-gate.
test("with no MMO_SELECT, a project whose default policy has an antigravity-worker leaf gets the agent worker checks; one whose policy has none does not", () => {
  const agy = scratch({ defaultPolicy: "flash-agsdk-only-v38" });
  try {
    const r = agy.run();
    assert.ok(blocking(r.out).some((b) => /Python/.test(b) && /environment/i.test(b)), `the agent worker's missing environment was not reported:\n${r.out}`);
  } finally {
    agy.cleanup();
  }
  const opus = scratch({ defaultPolicy: "opus-only-v5" });
  try {
    const r = opus.run();
    assert.ok(!blocking(r.out).some((b) => /Python|google-antigravity/.test(b)), `a policy with no agent leaf was asked about Python:\n${r.out}`);
  } finally {
    opus.cleanup();
  }
});

// S-requirements-lock: the versions of the venv every measurement ran on.
test("requirements.txt pins google-antigravity 0.1.22 and every package it installs, each with its hashes, at the measured versions", () => {
  const text = readFileSync(REQUIREMENTS, "utf8");
  assert.equal(pinOf(text), "0.1.22");
  const lines = text.replace(/\\\n\s*/g, " ").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.ok(lines.length >= 10, `the whole closure is locked, not only the SDK (${lines.length} lines)`);
  for (const l of lines) {
    assert.match(l, /^[A-Za-z0-9_.-]+(\[[^\]]+\])?==\S+/, `an exact pin: ${l}`);
    assert.match(l, /--hash=sha256:[0-9a-f]{64}/, `with a hash: ${l}`);
  }
  const pinned = Object.fromEntries(lines.map((l) => l.split(/\s/)[0].split("==")).map(([n, v]) => [n.toLowerCase().replace(/_/g, "-"), v]));
  for (const [name, version] of [["google-genai", "2.33.0"], ["websockets", "17.3"], ["protobuf", "7.36.2"], ["pydantic", "2.14.1"], ["mcp", "2.3.0"]]) {
    assert.equal(pinned[name], version, `${name}`);
  }
});
