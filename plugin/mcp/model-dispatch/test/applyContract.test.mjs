/**
 * The server's writer decides as the write-contract hook does (plugin/scripts/write-contract-check.mjs verdict,
 * judgedPaths; lib/contract-lock.mjs contractTampered): a freeze record that cannot be trusted refuses every write with
 * the hook's words, and a changed contract's refusal names no way around it; the contract is read only as a regular
 * file (a named pipe never blocks the server, a link is not followed); a live run's own contract and log stay refused
 * under strict = false once a freeze record exists; and a write is judged where it lands with every link resolved too,
 * so a link inside the allowlist cannot carry it to an off-limits folder or out of the project. Temp folders only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const { checkWriteContract, tamperReason, hasActiveWriteContract, contractTampered } = await import(join(DIST, "apply.js"));
const { formatLine } = await import(join(HERE, "..", "..", "..", "scripts", "lib", "log.mjs"));

const RUN = "r1";
const CONTRACT_REL = join(".sdlc", "local", "write-contract.json");
/** A project with an active contract for run r1, frozen (its fingerprint in the run's log) unless `frozen` is false. */
function project(contract, { frozen = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmo-apply-contract-"));
  mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
  mkdirSync(join(root, ".sdlc", "runs", RUN), { recursive: true });
  const text = JSON.stringify({ schema_version: 1, active: true, mode: "brownfield", run_id: RUN, strict: true, allowlist: ["src/**"], off_limits: [], ...contract });
  writeFileSync(join(root, CONTRACT_REL), text);
  const sha = createHash("sha256").update(text).digest("hex");
  writeFileSync(join(root, ".sdlc", "runs", RUN, "orchestrator.log"), frozen ? formatLine("info", "contract.freeze", { run_id: RUN, sha256: sha }) + "\n" : formatLine("info", "run.start", { run_id: RUN }) + "\n");
  mkdirSync(join(root, "src"));
  return root;
}

test("the tamper refusal: the hook's words for a record that cannot be trusted, and a changed contract's refusal names no way around it", () => {
  const forged = tamperReason({ run_id: "r1", sha256: null, forged: "freeze records of 2 runs are live (r1, r2), and only one run at a time holds a project's contract" }, null);
  assert.equal(forged, "the write contract's freeze record cannot be trusted: freeze records of 2 runs are live (r1, r2), and only one run at a time holds a project's contract, so one was not written by write-contract.mjs. Every write is refused while that record is live. Stop and tell the person.");
  const gone = tamperReason({ run_id: "r1", sha256: "a".repeat(64) }, null);
  assert.equal(gone, "the write contract changed after it was frozen for run r1 (the file is gone, or is not a readable file): every write is refused while that run is live. A contract is written only by write-contract.mjs, at Gate 0. Stop and tell the person what changed it.");
  const changed = tamperReason({ run_id: "r1", sha256: "a".repeat(64) }, Buffer.from("{}"));
  assert.match(changed, /\(its bytes no longer match the freeze record in the run's log\): every write is refused while that run is live\./);
  assert.doesNotMatch(changed, /until the run ends|abort/, "no way past the refusal");
  assert.equal(tamperReason(null, null), null, "no freeze record: nothing to compare");
  assert.equal(tamperReason({ run_id: "r1", sha256: createHash("sha256").update("{}").digest("hex") }, Buffer.from("{}")), null);
});

test("the contract is read only as a regular file: a named pipe never blocks the server, and a link is not followed", () => {
  const root = project({}, { frozen: false });
  try {
    // A named pipe in the contract's place: reading it as a file would wait forever for a writer.
    rmSync(join(root, CONTRACT_REL));
    assert.equal(spawnSync("mkfifo", [join(root, CONTRACT_REL)]).status, 0);
    const probe = `const a = await import(${JSON.stringify(join(DIST, "apply.js"))}); console.log(JSON.stringify([a.hasActiveWriteContract(${JSON.stringify(root)}), a.checkWriteContract(${JSON.stringify(root)}, "docs/x.md").allowed]));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", timeout: 10_000 });
    assert.equal(r.signal, null, "the server answered instead of blocking on the pipe");
    assert.deepEqual(JSON.parse(r.stdout), [false, true], "no readable contract: none binds");
    // A link in the contract's place is not followed, as the hook does not follow it.
    rmSync(join(root, CONTRACT_REL));
    const real = join(root, "elsewhere.json");
    writeFileSync(real, JSON.stringify({ schema_version: 1, active: true, mode: "brownfield", run_id: RUN, strict: true, allowlist: ["src/**"] }));
    symlinkSync(real, join(root, CONTRACT_REL));
    assert.equal(hasActiveWriteContract(root), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
  // With a live freeze record, a contract that is no regular file is a contract that changed.
  const frozen = project({});
  try {
    rmSync(join(frozen, CONTRACT_REL));
    symlinkSync(join(frozen, "nowhere.json"), join(frozen, CONTRACT_REL));
    assert.match(contractTampered(frozen), /the file is gone, or is not a readable file/);
  } finally { rmSync(frozen, { recursive: true, force: true }); }
});

test("under strict = false a live run's own contract and log stay refused once a freeze record exists", () => {
  const root = project({ strict: false });
  try {
    for (const rel of [".sdlc/local/write-contract.json", `.sdlc/runs/${RUN}/orchestrator.log`]) {
      const d = checkWriteContract(root, rel);
      assert.equal(d.allowed, false, rel);
      assert.match(d.reason, /the run's own write contract or log/);
    }
    assert.equal(checkWriteContract(root, "docs/x.md").allowed, true, "strict = false still lets an unlisted path through");
  } finally { rmSync(root, { recursive: true, force: true }); }
  // A contract frozen before freeze records existed (none in its log) keeps the old allowance under strict = false.
  const old = project({ strict: false }, { frozen: false });
  try {
    assert.equal(checkWriteContract(old, ".sdlc/local/write-contract.json").allowed, true);
  } finally { rmSync(old, { recursive: true, force: true }); }
});

test("a write is judged where it lands with every link resolved: a link inside the allowlist leads nowhere it may not go", () => {
  const base = mkdtempSync(join(tmpdir(), "mmo-apply-contract-"));
  const root = project({ off_limits: ["config/**"] });
  try {
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "config"));
    mkdirSync(join(base, "outside"));
    symlinkSync("../docs", join(root, "src", "d"));
    symlinkSync("../config", join(root, "src", "c"));
    symlinkSync(join(base, "outside"), join(root, "src", "out"));
    const notListed = checkWriteContract(root, "src/d/x.md");
    assert.equal(notListed.allowed, false, "docs/x.md is not in the allowlist");
    assert.match(notListed.reason, /allowlist/);
    assert.match(checkWriteContract(root, "src/c/secrets.yml").reason, /off-limits \(contract\): config\/\*\*/);
    assert.match(checkWriteContract(root, "src/out/x.ts").reason, /leads outside project_root through a link/);
    assert.equal(checkWriteContract(root, "src/a.ts").allowed, true, "a plain path is judged as before");
    assert.equal(checkWriteContract(root, "src/new/deeper/a.ts").allowed, true, "a file in folders that do not exist yet");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
  // With no contract at all, a link out of the project is refused too: the server writes only inside project_root.
  const bare = mkdtempSync(join(tmpdir(), "mmo-apply-contract-"));
  const away = mkdtempSync(join(tmpdir(), "mmo-apply-contract-away-"));
  try {
    symlinkSync(away, join(bare, "lib"));
    assert.equal(checkWriteContract(bare, "lib/x.ts").allowed, false);
    // A link to git's own store carries no write into it: the hardcoded list is judged on the real path too.
    mkdirSync(join(bare, ".git"));
    symlinkSync(".git", join(bare, "vcs"));
    assert.match(checkWriteContract(bare, "vcs/config").reason, /off-limits \(hardcoded\): \.git\/\*\*/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(away, { recursive: true, force: true });
  }
});
