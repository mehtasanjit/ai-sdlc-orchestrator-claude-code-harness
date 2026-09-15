/**
 * T11 (Fix E, v0.7.3): the orchestrator-overhead fields the collector writes
 * and the TypeScript types that describe them are the same set, and the report
 * renders what the collector wrote.
 *
 * collect-orchestrator-usage.mjs is plain JavaScript outside this package, so
 * nothing stopped it from writing a field `Manifest` or `TelemetryEvent` never
 * declared: until v0.7.3 the orchestrator event carried per_model, unpriced,
 * unlogged_billed and four more fields that `TelemetryEvent` did not know, and
 * it lacked price_list_verified, pricing_complete and the attribution lists
 * the manifest block carried. The check here type-checks the collector's REAL
 * output for two real runs (a booked headless receipt and a transcript-priced
 * interactive session) as object literals with tsc --noEmit, so:
 *   - a written key the type does not declare is an excess-property error;
 *   - for the manifest block, a declared key the writer does not write is a
 *     missing-property error (Record<keyof …, true>);
 *   - the event must carry every Fix E field the manifest block carries.
 *
 * Offline; temp dirs only; tsc is this package's own devDependency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const SCRIPT = join(PKG, "..", "..", "scripts", "collect-orchestrator-usage.mjs");
const REPO = join(PKG, "..", "..", "..");
const REPORT = join(REPO, "tools", "report.mjs");
const TSC = join(PKG, "node_modules", "typescript", "bin", "tsc");
const ENV = { ...process.env, MMO_SELECT: "" };

/** The Fix E fields: on the manifest's orchestrator_overhead block AND on the orchestrator telemetry event. */
const FIX_E_FIELDS = [
  "per_model",
  "unpriced",
  "pricing_complete",
  "price_list_verified",
  "unlogged_billed",
  "attribution_complete",
  "missing_helper_ids",
  "unreferenced_helper_files",
  "receipt_cli_usd",
  // v0.7.3 review fix: the booked part's list figure, which Claude Code's receipt_cli_usd is checked against.
  "booked_cost_usd",
];

const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
const orchestratorEvent = (p) =>
  readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.tier === "orchestrator");

/** Copy a fixture, run the collector over it, and return the written block, event and pass dir. */
function collect(fixture, passRel, extraArgs) {
  const root = mkdtempSync(join(tmpdir(), "mmo-overhead-fields-"));
  cpSync(join(REPO, "tools", "test", "fixtures", fixture), root, { recursive: true });
  const passDir = join(root, passRel);
  const r = spawnSync(process.execPath, [SCRIPT, passDir, "--project-root", root, "--transcripts-dir", join(root, "transcripts"), ...extraArgs(root)], { encoding: "utf-8", env: ENV });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return { root, passDir, overhead: readJson(join(passDir, "manifest.json")).orchestrator_overhead, event: orchestratorEvent(join(passDir, "telemetry.jsonl")) };
}

const RUNS = [
  { name: "headless-unlogged-calls (booked receipt)", fixture: "headless-unlogged-calls", pass: "pass1", args: (root) => ["--policy-path", join(root, "policy.yaml")] },
  { name: "fable-session-opus-helpers (transcript-priced, no receipt)", fixture: "fable-session-opus-helpers", pass: ".", args: () => [] },
];

for (const run of RUNS) {
  test(`T11: ${run.name}: the collector's manifest block and event type-check against Manifest and TelemetryEvent, key for key`, () => {
    const { root, overhead, event } = collect(run.fixture, run.pass, run.args);
    try {
      for (const f of FIX_E_FIELDS) {
        assert.ok(f in overhead, `manifest orchestrator_overhead lacks ${f}`);
        assert.ok(f in event, `the orchestrator telemetry event lacks ${f}`);
        assert.deepEqual(event[f], overhead[f], `event.${f} must equal the manifest block's`);
      }
      // One literal per shape. `keys` lists exactly the written top-level keys of the manifest
      // block, typed as a Record over the type's keys, so a key declared but not written fails too.
      const keys = Object.fromEntries(Object.keys(overhead).map((k) => [k, true]));
      const check = join(root, "check.ts");
      writeFileSync(
        check,
        `import type { Manifest } from ${JSON.stringify(join(PKG, "src", "telemetry.js"))};\n` +
          `import type { TelemetryEvent } from ${JSON.stringify(join(PKG, "src", "types.js"))};\n` +
          `type Overhead = NonNullable<Manifest["orchestrator_overhead"]>;\n` +
          `export const overhead: Overhead = ${JSON.stringify(overhead, null, 1)};\n` +
          `export const keys: Record<keyof Overhead, true> = ${JSON.stringify(keys)};\n` +
          `export const event: TelemetryEvent = ${JSON.stringify(event, null, 1)};\n`,
      );
      // The package tsconfig's compiler options, applied to this one file.
      const tsc = spawnSync(process.execPath, [TSC, "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--types", "node", check], { cwd: PKG, encoding: "utf-8" });
      assert.equal(tsc.status, 0, `tsc rejected the collector's output:\n${tsc.stdout}${tsc.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("T11: the report renders the collector's real per-model, billed-but-not-logged and attribution output", () => {
  const headless = collect("headless-unlogged-calls", "pass1", (root) => ["--policy-path", join(root, "policy.yaml")]);
  const fable = collect("fable-session-opus-helpers", ".", () => []);
  try {
    const out = spawnSync(process.execPath, [REPORT, headless.passDir], { encoding: "utf-8" }).stdout;
    // $0.499714 + $13.368765 logged, $0.329297 billed but not logged: $14.197776 booked.
    assert.match(out, /session \(claude-opus-5\): \$0\.4997 · helpers \(claude-opus-4-8\): \$13\.3688/);
    assert.match(out, /billed but not logged: \$0\.3293 \(2\.32%\) — claude-opus-4-8 \$0\.3293/);
    assert.match(out, /Orchestrator overhead \(receipt tokens at the price list\)\s+\$14\.1978/);
    assert.doesNotMatch(out, /floor: excludes calls/, "a booked receipt includes the unlogged calls");
    assert.doesNotMatch(out, /Attribution incomplete/);

    const fableOut = spawnSync(process.execPath, [REPORT, fable.passDir], { encoding: "utf-8" }).stdout;
    assert.match(fableOut, /session \(claude-fable-5-1\): \$4\.8012 · helpers \(claude-opus-5\): \$9\.1323/);
    assert.match(fableOut, /floor: excludes calls Claude Code bills but does not log \(2\.3%–22% on measured runs\)/);
    // Every helper file in the real session is named by an Agent result (two of
    // them only in a nested result's text), so no attribution line is printed.
    // This used to expect "Attribution incomplete: 2 helper file(s)": the
    // fixture had dropped those two result texts, and the test pinned the defect.
    assert.equal(fable.overhead.attribution_complete, true);
    assert.doesNotMatch(fableOut, /Attribution incomplete/);
    assert.doesNotMatch(fableOut, /billed but not logged:/);
  } finally {
    rmSync(headless.root, { recursive: true, force: true });
    rmSync(fable.root, { recursive: true, force: true });
  }
});
