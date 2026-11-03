/**
 * Every shipped policy that reaches Gemini through the Antigravity SDK turns failover on: each `antigravity-worker`
 * leaf lists `failover_locations: [us, eu]`, so a call Google refuses or holds at the leaf's own location carries on
 * at us, then eu. No leaf of another adapter has the field, a policy with no Antigravity leaf is unchanged, and each
 * policy that gained the field is one version higher than before, since telemetry records the version a run used. At
 * run time a leaf's own location comes first and a listed location equal to it is skipped, never tried twice: an
 * unpinned leaf under GOOGLE_CLOUD_LOCATION=us runs at us, then eu. Offline: the engine's own policy loader on the
 * shipped files, and a stand-in worker interpreter that records the flags each door passes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeWorkerPython, flagValue, withEnv } from "./agyFakes.mjs";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const POLICIES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies");
const { loadPolicyFromPath } = await import(join(DIST, "policy.js"));
const { typistForLeaf } = await import(join(DIST, "executor", "tools.js"));
const { AntigravityWorkerAdapter } = await import(join(DIST, "adapters", "AntigravityWorkerAdapter.js"));
const { probeTypists } = await import(join(DIST, "typistProbe.js"));
const { leafLocations } = await import(join(DIST, "agsdkPreflight.js"));

/** Each shipped policy with an Antigravity leaf, and its version once failover was turned on (one higher than before). */
const FAILOVER_VERSIONS = {
  "argon4-agsdk-only": 2,
  "argon4-plus-flash38": 3,
  "argon4-plus-sonnet55": 3,
  "fable51-plus-flash-v38": 2,
  "flash-agsdk-only-v38": 2,
  "flash-agsdk-only": 2,
  "opus-plus-flash-v37": 2,
  "opus-plus-flash-v38": 2,
  "opus-plus-flash": 2,
};
/**
 * The policies whose thinking steps name Gemini went one version higher again in 0.10.0, when those steps started to
 * follow the policy (their driver: block): telemetry keeps 0.9.4's runs, where Claude planned, apart from them.
 */
const ROUTED_THINKING_VERSIONS = {
  "argon4-agsdk-only": 3,
  "argon4-plus-flash38": 4,
  "argon4-plus-sonnet55": 4,
  "flash-agsdk-only-v38": 3,
  "flash-agsdk-only": 3,
};
/** The shipped policies with no Antigravity leaf, at their versions, which do not change. */
const UNCHANGED_VERSIONS = { "opus-only-v5": 1, "opus-only": 1, "opus-plus-sonnet-max": 1, "opus-plus-sonnet": 1 };

const shipped = () => readdirSync(POLICIES).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, "")).sort();
const load = (name) => loadPolicyFromPath(join(POLICIES, `${name}.yaml`));

test("every shipped policy with an antigravity-worker leaf lists failover_locations [us, eu] on each such leaf and on no other, one version higher than before; the others are unchanged", () => {
  assert.deepEqual(shipped(), Object.keys({ ...FAILOVER_VERSIONS, ...UNCHANGED_VERSIONS }).sort(), "every shipped policy is in one of the two tables");
  for (const name of shipped()) {
    const policy = load(name);
    const agy = policy.models.filter((m) => m.adapter === "antigravity-worker");
    assert.equal(agy.length > 0, name in FAILOVER_VERSIONS, `${name}: an Antigravity leaf exactly when it is listed as one`);
    for (const m of agy) assert.deepEqual(m.failover_locations, ["us", "eu"], `${name}: leaf ${m.id}`);
    for (const m of policy.models.filter((x) => x.adapter !== "antigravity-worker")) assert.equal(m.failover_locations, undefined, `${name}: leaf ${m.id} (${m.adapter})`);
    assert.equal(policy.version, ROUTED_THINKING_VERSIONS[name] ?? FAILOVER_VERSIONS[name] ?? UNCHANGED_VERSIONS[name], `${name}: its version`);
  }
});

const PACKET = { id: "tp_x_001", phase: "codegen", task_type: "x", module: "m", instruction: "do", inputs: [], outputSchema: { type: "object" }, acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 1000 } };
const ANSWER = { finish_output: JSON.stringify({ path: "a.txt", content: "x\n" }), usage: { prompt_token_count: 10, candidates_token_count: 2 }, sdk_version: "0.1.22", tool_calls: ["finish"] };

/** The --locations each door passes for `leaf` with GOOGLE_CLOUD_LOCATION set to `location` (unset when null). */
async function locationsAt(leaf, location) {
  const fake = fakeWorkerPython({ runs: [{ receipt: ANSWER, sidecar: { sdk_version: "0.1.22", usage: { prompt_token_count: 10 } }, stdout: '{"ok":true}' }] });
  const dir = mkdtempSync(join(tmpdir(), "shipped-failover-"));
  try {
    mkdirSync(join(dir, "work"));
    writeFileSync(join(dir, "shared.txt"), "");
    return await withEnv({ GEMINI_WORKER_PYTHON: fake.python, GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: location ?? undefined }, async () => {
      await typistForLeaf(leaf, "estimated").type({ unit: { id: "u1", path: "a.txt" }, packet: { id: "u1", outputSchema: { type: "object" } }, framed: "brief", shared: "", sharedFile: join(dir, "shared.txt"), contract: "file", passId: "r" });
      await new AntigravityWorkerAdapter(leaf).execute(PACKET, undefined, { work_dir: join(dir, "work"), telemetry_path: join(dir, "t.jsonl") });
      const [typist, agent] = fake.runs().map((r) => flagValue(r.args, "--locations"));
      const probe = (await probeTypists([leaf], "estimated")).map((o) => o.location);
      return { typist, agent, probe: probe.sort(), binding: leafLocations(leaf, process.env) };
    });
  } finally {
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a shipped leaf runs at its own location first, then the listed ones that differ from it: unpinned under GOOGLE_CLOUD_LOCATION=us it is us, then eu, never us twice; pinned to global it is global, us, eu", async () => {
  const unpinned = load("flash-agsdk-only-v38").models.find((m) => m.adapter === "antigravity-worker");
  assert.equal(unpinned.region, undefined, "flash-agsdk-only-v38's leaf follows GOOGLE_CLOUD_LOCATION");
  const atUs = await locationsAt(unpinned, "us");
  assert.deepEqual(atUs, { typist: "us,eu", agent: "us,eu", probe: ["eu", "us"], binding: ["us", "eu"] });
  const atGlobal = await locationsAt(unpinned, null);
  assert.deepEqual(atGlobal, { typist: "global,us,eu", agent: "global,us,eu", probe: ["eu", "global", "us"], binding: ["global", "us", "eu"] });
  const pinned = load("argon4-agsdk-only").models.find((m) => m.adapter === "antigravity-worker");
  assert.equal(pinned.region, "global");
  const pinnedAtEu = await locationsAt(pinned, "eu");
  assert.deepEqual(pinnedAtEu, { typist: "global,us,eu", agent: "global,us,eu", probe: ["eu", "global", "us"], binding: ["global", "us", "eu"] }, "a pinned leaf keeps its region first");
});
