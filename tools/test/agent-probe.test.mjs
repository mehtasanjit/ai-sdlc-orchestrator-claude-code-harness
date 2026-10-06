/**
 * Pins the probe's failure classifier (403 → entitlement, 404 → region;
 * confusing the two is worse than no classifier), the cost reporting (billed
 * rates ≠ policy rates when a region is pinned), and that the probe packet
 * stays trivial (one turn, no tools).
 *
 * Offline. No adapter, no policy load, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_ADAPTER,
  agentLeafFrom,
  agentLeafById,
  probePacket,
  classifyFailure,
  formatUsd,
  pricingNote,
  readFlag,
} from "../../plugin/scripts/probe-agent-worker.mjs";
import { agentProbeHint } from "../../plugin/scripts/verify-setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A policy shaped like the shipped one: one model leaf, one agent leaf. */
const twoDoorPolicy = {
  name: "test-policy",
  models: [
    { id: "opus", adapter: "builtin-anthropic", model_name: "claude-opus-4-7" },
    { id: "flash-completion", adapter: "mcp:model-dispatch", model_name: "gemini-3.5-flash" },
    { id: "flash-agsdk-worker", adapter: AGENT_ADAPTER, model_name: "gemini-3.5-flash" },
  ],
};

// ─── finding the leaf ────────────────────────────────────────────────────────

test("agentLeafFrom picks the one leaf that reaches the model as an agent", () => {
  assert.equal(agentLeafFrom(twoDoorPolicy).id, "flash-agsdk-worker");
});

test("agentLeafFrom refuses a policy with no agent leaf, and names the one that has it", () => {
  const modelOnly = { name: "opus-only", models: [twoDoorPolicy.models[0]] };
  assert.throws(() => agentLeafFrom(modelOnly), /no agent-worker leaf/);
  assert.throws(() => agentLeafFrom(modelOnly), /opus-plus-flash/);
});

test("agentLeafFrom refuses two agent leaves rather than silently probing one", () => {
  // Two agent leaves mean "does the agent path work" has two answers — possibly
  // different models in different regions. Answering one of them as if it were
  // the answer is the failure this refusal exists to prevent.
  const twoAgents = {
    name: "ambiguous",
    models: [
      { id: "flash-agent", adapter: AGENT_ADAPTER, model_name: "gemini-3.5-flash" },
      { id: "lite-agent", adapter: AGENT_ADAPTER, model_name: "gemini-3.5-flash-lite" },
    ],
  };
  assert.throws(() => agentLeafFrom(twoAgents), /--model=/);
  assert.throws(() => agentLeafFrom(twoAgents), /flash-agent, lite-agent/);
});

test("agentLeafById refuses a leaf that is not on the agent path", () => {
  // The completion leaf is reachable and healthy — probing it would "pass" and
  // prove nothing about the path the user asked about.
  assert.throws(
    () => agentLeafById(twoDoorPolicy, "flash-completion"),
    /only exercises the agent path/
  );
});

test("agentLeafById lists what is declared when the id is a typo", () => {
  assert.throws(() => agentLeafById(twoDoorPolicy, "flash-agsdk"), /flash-agsdk-worker/);
});

// ─── the probe packet stays trivial ──────────────────────────────────────────

test("the probe packet asks for one turn and forbids tools", () => {
  const p = probePacket();
  // The SDK re-sends its preamble every turn, so turn count IS the bill. An
  // instruction that lets the agent go looking would quietly turn a sub-cent
  // check into a real delegation.
  assert.match(p.instruction, /Do not read any file/);
  assert.match(p.instruction, /do not run any command/);
  assert.deepEqual(p.inputs, [], "a probe with file slices would invite the agent to open them");
  assert.ok(p.budget.maxOutputTokens <= 256);
});

test("the probe packet is a well-formed TaskPacket", () => {
  const p = probePacket("smoke");
  for (const field of [
    "id",
    "phase",
    "task_type",
    "module",
    "instruction",
    "inputs",
    "outputSchema",
    "acceptance",
    "budget",
    "pass_id",
  ]) {
    assert.ok(p[field] !== undefined, `missing ${field}`);
  }
  assert.equal(p.pass_id, "smoke");
  // evidenceStem() derives the receipt filenames from packet.id, so an id with
  // characters it strips would produce files nobody can map back to this probe.
  assert.match(p.id, /^[A-Za-z0-9._-]+$/);
});

// ─── classification: the sentence someone acts on ────────────────────────────

test("403 reads as an entitlement problem, not as a generic permission error", () => {
  const v = classifyFailure(
    "google.api_core.exceptions.PermissionDenied: 403 Permission denied on resource project"
  );
  assert.equal(v.id, "entitlement");
  assert.match(v.headline, /Model Garden/);
  // The escape hatch matters as much as the diagnosis: someone blocked on an
  // entitlement request can still run today on the completion door.
  assert.match(v.fix, /flash-completion/);
});

test("404 reads as a region problem, because that is what it nearly always is", () => {
  const v = classifyFailure(
    "google.api_core.exceptions.NotFound: 404 Publisher Model `gemini-3.5-flash` was not found"
  );
  assert.equal(v.id, "region");
  assert.match(v.fix, /GOOGLE_CLOUD_LOCATION/);
});

test("403 and 404 never collapse into each other", () => {
  // The two fixes are days apart in effort. This is the assertion that keeps a
  // future pattern edit from making one swallow the other.
  assert.notEqual(
    classifyFailure("403 PERMISSION_DENIED").id,
    classifyFailure("404 NOT_FOUND").id
  );
});

test("a missing SDK is not reported as a credentials problem", () => {
  const v = classifyFailure("ModuleNotFoundError: No module named 'google.antigravity'");
  assert.equal(v.id, "sdk-missing");
  assert.match(v.fix, /verify-setup\.mjs --fix/);
});

test("absent credentials and stale credentials get different fixes", () => {
  const absent = classifyFailure(
    "google.auth.exceptions.DefaultCredentialsError: Could not automatically determine credentials"
  );
  const stale = classifyFailure("RefreshError: ('invalid_grant: Token has been expired or revoked.')");
  assert.equal(absent.id, "adc-missing");
  assert.equal(stale.id, "adc-stale");
  // Both are `gcloud auth application-default login`, and they are still kept
  // apart: "you never logged in" and "your login lapsed" mean different things
  // to someone deciding whether their setup was ever right.
  assert.notEqual(absent.headline, stale.headline);
});

test("a quota error is reported as capacity, not as a broken setup", () => {
  const v = classifyFailure("429 RESOURCE_EXHAUSTED: Quota exceeded for aiplatform.googleapis.com");
  assert.equal(v.id, "quota");
  assert.match(v.headline, /wired correctly/);
});

test("the adapter's own timeout message is recognised", () => {
  // Pinned against the real wording in AntigravityWorkerAdapter.spawnWorker —
  // if that string changes, this test is the thing that notices.
  const v = classifyFailure("The agent worker was killed after 570s (its own deadline is 540s...)");
  assert.equal(v.id, "timeout");
});

test("an unrecognised failure says so instead of guessing", () => {
  const v = classifyFailure("Segmentation fault");
  assert.equal(v.id, "unknown");
  assert.match(v.fix, /last line/);
});

test("classification never throws on a missing or empty error", () => {
  for (const input of [undefined, null, "", 0]) {
    assert.equal(classifyFailure(input).id, "unknown");
  }
});

// ─── cost reporting ──────────────────────────────────────────────────────────

test("a sub-cent cost is not rounded away to zero", () => {
  // A measured probe costs about two cents, and a delegation that fails before
  // the session starts costs a small fraction of one. Two decimal places would
  // print the second as $0.00 — the one number a reader most needs to be exact,
  // because "it cost nothing" and "it never ran" are the same reading.
  assert.equal(formatUsd(0.0035), "$0.003500");
  assert.equal(formatUsd(0.0000121), "$0.000012");
  assert.equal(formatUsd(0), "$0.000000");
});

test("pricingNote says plainly when the billed rates are the pinned rates", () => {
  const pinned = { input: 1.5, input_cached: 0.15, output: 9.0 };
  const note = pricingNote(pinned, pinned, "global");
  assert.match(note, /pinned rates/);
  assert.doesNotMatch(note, /surcharge, because/);
});

test("pricingNote explains the regional surcharge rather than leaving a discrepancy", () => {
  // A reader who sees the report bill 1.65 while the YAML pins 1.50 and is told
  // nothing reads it as a bug. This is the line that stops that.
  const pinned = { input: 1.5, input_cached: 0.15, output: 9.0 };
  const billed = { input: 1.65, input_cached: 0.165, output: 9.9 };
  const note = pricingNote(pinned, billed, "asia-south1");
  assert.match(note, /surcharge/);
  assert.match(note, /asia-south1/);
  assert.match(note, /1\.65/);
});

// ─── flags ───────────────────────────────────────────────────────────────────

test("readFlag reads a value and tolerates its absence", () => {
  assert.equal(readFlag(["--policy=opus-plus-flash"], "policy"), "opus-plus-flash");
  assert.equal(readFlag([], "policy"), undefined);
  // A path with an '=' in it must survive intact.
  assert.equal(readFlag(["--model=a=b"], "model"), "a=b");
});

// ─── the bridge from the offline check to this one ───────────────────────────

const AGENT_SELECTED = { MMO_SELECT: "gemini-flash=flash-agsdk-worker" };

// The run's start check (preflight_dispatch with probe_typists) sends one test call through the agent, so a missing
// entitlement, a region that does not serve the model or a dead credential stops the run before anything is billed.
// A separate paid probe on top asks the person an extra question and pays twice for one answer.
test("a green offline check on the agent path says what the run's start check tests, and offers no separate paid probe", () => {
  const hint = agentProbeHint("/plug", AGENT_SELECTED, true);
  assert.ok(hint);
  assert.doesNotMatch(hint, /probe-agent-worker\.mjs|two cents/);
  // Both invisible failure modes are named, so the person knows what the offline checks leave to the run.
  assert.match(hint, /entitlement/);
  assert.match(hint, /region/);
  assert.match(hint, /start check/);
});

test("the model path is never told to run a paid probe", () => {
  // The commonest install. A probe suggestion here would be an invitation to
  // spend money proving a path this install does not use.
  assert.equal(agentProbeHint("/plug", {}, true), null);
  assert.equal(agentProbeHint("/plug", { MMO_SELECT: "gemini-flash=flash-completion" }, true), null);
});

test("a broken install is not sent to the probe", () => {
  // It would fail on the same cause and charge for the privilege.
  assert.equal(agentProbeHint("/plug", AGENT_SELECTED, false), null);
});

// ─── the fact this file cannot import: the shipped policy ────────────────────

test("the shipped policy still declares exactly one agent leaf, so the probe resolves", () => {
  // agentLeafFrom() is only useful if the real policy satisfies it. The policy
  // is YAML and this suite has no parser, so the check is a text one — narrow
  // on purpose: it asserts the adapter string appears once, which is the single
  // condition agentLeafFrom() refuses on.
  const yaml = readFileSync(
    join(ROOT, "plugin", "config", "policies", "opus-plus-flash.yaml"),
    "utf8"
  );
  const declarations = yaml
    .split("\n")
    .filter((line) => /^\s*adapter:\s*antigravity-worker\s*$/.test(line));
  assert.equal(declarations.length, 1, "opus-plus-flash must declare exactly one agent-worker leaf");
});
