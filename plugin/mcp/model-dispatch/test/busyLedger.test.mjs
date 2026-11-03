/**
 * When Google truly cannot serve: the run's busy ledger (dist/busyLedger.js). A batch or stage stops on a model only
 * when no call of that model in the run was served for the whole window (300 s) while its calls kept coming back
 * `unavailable` (refused or held past their own budgets); any served call of the model resets the window. Until
 * then a call that comes back unavailable is a bounded transport wait: it is not a ladder attempt, it is not handed
 * to a Claude leaf, and it is sent again. The stop carries Google's reason. Offline: the ledger on a fake clock, and
 * the apply loop, the batch and the stage runner with stub dispatchers and typists whose calls advance that clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { runApplyLoop, normalizeApply, FILE_OUTPUT_SCHEMA } = await import(join(DIST, "apply.js"));
const { runBatch } = await import(join(DIST, "batch.js"));
const { executeStage } = await import(join(DIST, "executor", "run.js"));
const { loadPolicyFromPath } = await import(join(DIST, "policy.js"));

async function ledgerModule() {
  try {
    return await import(join(DIST, "busyLedger.js"));
  } catch (e) {
    assert.fail(`dist/busyLedger.js (src/busyLedger.ts) could not be loaded: ${e.message}`);
  }
}

const MODEL = "gemini-3.8-flash";
/** Google's reason, as the worker's receipt states it when a call's own budget is spent. */
const REFUSED = "refused at global (7 requests over 104 s; last HTTP 429 RESOURCE_EXHAUSTED)";
const HELD = "accepted the call at global twice and sent nothing back (180 s, 360 s)";
const S = 1000;
const ZERO = { input: 0, input_cached: 0, output: 0 };

// E-ledger, the rule.
test("the ledger halts a model only when nothing of it was served for the whole window while its calls kept coming back unavailable, with Google's reason", async () => {
  const { BusyLedger } = await ledgerModule();
  let t = 0;
  const all = new BusyLedger({ windowSec: 300, now: () => t });
  for (t of [0, 120 * S, 240 * S]) assert.equal(all.unavailable(MODEL, REFUSED), null, `a wait at ${t / S} s: the window is open`);
  t = 360 * S;
  const why = all.unavailable(MODEL, REFUSED);
  assert.equal(typeof why, "string", "every call refused for the whole window: the halt");
  assert.match(why, /Google could not serve/);
  assert.ok(why.includes(REFUSED), "with Google's reason");
  t = 0;
  const other = new BusyLedger({ windowSec: 300, now: () => t });
  for (t of [0, 120 * S, 240 * S]) other.unavailable(MODEL, REFUSED);
  t = 360 * S;
  assert.equal(other.unavailable("gemini-4-argon", REFUSED), null, "another model's window is its own");
});

// E-ledger-one-spent-others-served, the rule.
test("the ledger does not halt while other calls of the model are served: a served call resets the window", async () => {
  const { BusyLedger } = await ledgerModule();
  let t = 0;
  const L = new BusyLedger({ windowSec: 300, now: () => t });
  t = 0; L.served(MODEL);
  t = 120 * S; assert.equal(L.unavailable(MODEL, REFUSED), null);
  t = 200 * S; L.served(MODEL);
  t = 450 * S; assert.equal(L.unavailable(MODEL, REFUSED), null, "served 250 s ago: the window restarted");
  t = 500 * S; L.served(MODEL);
  t = 790 * S; assert.equal(L.unavailable(MODEL, REFUSED), null);
});

// E-ledger-held-twice-others-answer: a call held past both stall tries, twice, while
// the batch's other packets keep getting answers.
test("one call held twice while the other calls of the model answer does not halt the run", async () => {
  const { BusyLedger } = await ledgerModule();
  let t = 0;
  const L = new BusyLedger({ windowSec: 300, now: () => t });
  for (const s of [60, 120, 180, 240, 300, 360, 420, 480]) { t = s * S; L.served(MODEL); }
  t = 545 * S; assert.equal(L.unavailable(MODEL, HELD), null, "the first hold: others were served during it");
  for (const s of [600, 700, 800, 900, 1000]) { t = s * S; L.served(MODEL); }
  t = 1085 * S; assert.equal(L.unavailable(MODEL, HELD), null, "the second hold: others were served during it");
});

/** A dispatcher stub for the apply loop whose calls advance a shared fake clock by how long each one took. */
function dispatcher(clock, plan) {
  const calls = [];
  const dispatch = async (packet, force) => {
    calls.push({ id: packet.id, retry_count: packet.retry_count ?? 0, force: force?.modelId, at: clock.ms });
    const n = calls.filter((c) => c.id === packet.id).length;
    const kind = plan(packet, n);
    const decision = { modelId: "flash", reason: "policy", ruleIndex: 0 };
    if (kind === "answer") {
      clock.ms += 5 * S;
      const content = `export const ${packet.id} = ${n};\n`;
      return { decision, result: { success: true, result: { path: packet.artifact_path, content }, tokens: { input: 100, input_cached: 0, output: 20 }, cost_usd: 0.0001, latency_ms: 5 * S, terminal_reason: "success", attempts: [{ attempt_number: 1, ceiling_used: 100, hit_output_cap: false, tokens: { input: 100, input_cached: 0, output: 20 }, cost_usd: 0.0001, latency_ms: 5 * S, success: true, transient: false }] }, events: [{ task_id: packet.id, kind }] };
    }
    const reason = kind === "held" ? HELD : REFUSED;
    clock.ms += (kind === "held" ? 540 : 120) * S;
    return { decision, result: { success: false, error: `Google could not serve ${MODEL}: ${reason}`, result: null, tokens: ZERO, cost_usd: 0, latency_ms: 120 * S, terminal_reason: "vendor_error", attempts: [{ attempt_number: 1, ceiling_used: 100, hit_output_cap: false, tokens: ZERO, cost_usd: 0, latency_ms: 120 * S, success: false, error: reason, error_status: kind === "held" ? undefined : 429, transient: false, unavailable: reason }] }, events: [{ task_id: packet.id, kind }] };
  };
  return { calls, dispatch };
}

const packetFor = (id) => ({ id, phase: "codegen", task_type: "x", module: "m", pass_id: "run-1", instruction: `Write src/${id}.ts.`, inputs: [], outputSchema: FILE_OUTPUT_SCHEMA, acceptance: [], budget: { maxInputTokens: 1000, maxOutputTokens: 1000 }, artifact_path: `src/${id}.ts`, apply: { write: true } });

async function batchOf(ids, { plan, maxParallel, ledger, clock }) {
  const root = mkdtempSync(join(tmpdir(), "ledger-batch-"));
  const d = dispatcher(clock, plan);
  const outcomes = {};
  try {
    const out = await runBatch({
      packets: ids.map(packetFor), maxParallel, log: () => {},
      run: async (p) => (outcomes[p.id] = await runApplyLoop({
        packet: p, apply: normalizeApply(p.apply), projectRoot: root, keepEvents: true, ledger,
        route: () => ({ modelId: "flash", reason: "policy", ruleIndex: 0 }),
        lastAttempt: () => ({ modelId: "opus", reason: "the ladder's last attempt", ruleIndex: -1 }),
        typesInServer: () => true, dispatch: d.dispatch, log: () => {},
        transport: { maxWaits: 6, baseMs: 2_000, capMs: 60_000 }, sleep: async (ms) => { clock.ms += ms; }, random: () => 0.5,
      })),
    });
    const files = Object.fromEntries(ids.map((id) => { try { return [id, readFileSync(join(root, "src", `${id}.ts`), "utf8")]; } catch { return [id, null]; } }));
    return { out, outcomes, calls: d.calls, files };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// E-ledger-one-spent-others-served, the batch.
test("four packets, one call spends its budget while the others are served: no halt; that call is a wait, not an attempt, and is sent again unchanged", async () => {
  const { BusyLedger } = await ledgerModule();
  const clock = { ms: 0 };
  const ledger = new BusyLedger({ windowSec: 300, now: () => clock.ms });
  const r = await batchOf(["a", "b", "c", "d"], { maxParallel: 4, ledger, clock, plan: (p, n) => (p.id === "c" && n === 1 ? "refused" : "answer") });
  assert.equal(r.out.halted, undefined, `halted: ${r.out.halted}`);
  assert.deepEqual(r.out.items.map((i) => [i.id, i.status]), [["a", "applied"], ["b", "applied"], ["c", "applied"], ["d", "applied"]]);
  const c = r.calls.filter((x) => x.id === "c");
  assert.equal(c.length, 2, "sent again while the window is open");
  assert.ok(c.every((x) => x.retry_count === 0 && x.force === undefined), "unchanged, never handed to the ladder's last attempt");
  assert.equal(r.outcomes.c.attempts.length, 1, "the spent call is not an attempt");
  assert.ok(r.outcomes.c.transport_waits >= 1, "it is a wait");
});

// E-ledger-all-refused-halts.
test("every call refused for the whole window halts the batch with Google's reason; the waiting packets stop with it and nothing goes to the Claude leaf", async () => {
  const { BusyLedger } = await ledgerModule();
  const clock = { ms: 0 };
  const ledger = new BusyLedger({ windowSec: 300, now: () => clock.ms });
  const r = await batchOf(["a", "b", "c", "d"], { maxParallel: 2, ledger, clock, plan: () => "refused" });
  assert.match(String(r.out.halted), /Google could not serve/, JSON.stringify(r.out));
  assert.ok(r.out.halted.includes(REFUSED), "Google's own reason");
  const by = Object.fromEntries(r.out.items.map((i) => [i.id, i]));
  assert.deepEqual([by.c.status, by.d.status], ["stopped", "stopped"], "the packets that had not started");
  assert.equal(by.c.stopped_reason, r.out.halted);
  assert.ok(!r.calls.some((x) => x.force === "opus"), "never handed to the Claude leaf");
  assert.ok(r.calls.length >= 3 && r.calls.length <= 10, `${r.calls.length} calls: about the window's worth, not an attempt each`);
  assert.ok(Object.values(r.files).every((f) => f === null), "nothing was written");
});

/** A stage typist stub (executor/run.ts) whose calls advance the fake clock. */
function stageTypist(clock, plan, door = "agy", modelId = "flash-agsdk") {
  const calls = [];
  return {
    door, modelId, modelName: MODEL, calls,
    async type(req) {
      calls.push(req.unit.id);
      const kind = plan(req, calls.length);
      if (kind === "answer") { clock.ms += 5 * S; return { answer: { path: req.unit.path, content: "def thing():\n    return 1\n" }, transport: false, tokens: { input: 100, input_cached: 0, output: 20 }, cost_usd: 0.0001, latency_ms: 5 * S }; }
      clock.ms += 120 * S;
      return { answer: null, error: `Google could not serve ${MODEL}: ${REFUSED}`, transport: false, error_status: 429, unavailable: REFUSED, tokens: ZERO, cost_usd: 0, latency_ms: 120 * S };
    },
  };
}
const POLICY = loadPolicyFromPath(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "policies", "opus-only-v5.yaml"));
const unit = (id, path) => ({ id, path, phase: "codegen", import_line: "", exports: [{ name: "thing", params: [], returns: "int" }], behaviour: "does a thing", depends_on: [], style_from: { reason: "first" }, covers: [], tests: [], approx_lines: 5 });
const SPEC = (n) => ({ spec_version: "1", stack: ["Python 3"], commands: [], decisions: [], shared: { conventions: [], data_model: [], api: [] }, units: Array.from({ length: n }, (_, i) => unit(`U0${i + 1}`, `app/m${i + 1}.py`)) });

// E-unavailable-stops-stage: the stage runner follows the same ledger.
test("a stage whose calls come back unavailable for the whole window stops with Google's reason, types nothing more and never reaches the lean Opus attempt; one unavailable call between answers is a wait", async () => {
  const { BusyLedger } = await ledgerModule();
  const run = async (n, plan) => {
    const clock = { ms: 0 };
    const typist = stageTypist(clock, plan);
    const opus = stageTypist(clock, () => "answer", "lean-opus", "opus");
    const dir = mkdtempSync(join(tmpdir(), "ledger-stage-"));
    try {
      const receipt = await executeStage(SPEC(n), { stage: "codegen", codeDir: dir, passId: "p1", policy: POLICY, concurrency: 1, routedAttempts: 2, transport: { maxWaits: 3, baseMs: 1000, capMs: 8000 } },
        { typistFor: () => typist, fallback: opus, shared: "S", sharedFile: "/dev/null", emit: () => {}, check: () => ({ ok: true }), sleep: async (ms) => { clock.ms += ms; }, random: () => 0.5, now: () => clock.ms, ledger: new BusyLedger({ windowSec: 300, now: () => clock.ms }) });
      return { receipt, typist, opus };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const down = await run(3, () => "refused");
  assert.match(String(down.receipt.stopped), /Google could not serve/, JSON.stringify(down.receipt));
  assert.ok(down.receipt.stopped.includes(REFUSED));
  assert.ok(down.receipt.not_typed >= 1, "the files not started are counted");
  assert.equal(down.opus.calls.length, 0, "the outage is never typed by Claude at Claude's price");
  const blip = await run(1, (req, n) => (n === 1 ? "refused" : "answer"));
  assert.equal(blip.receipt.stopped, undefined, blip.receipt.stopped);
  assert.equal(blip.receipt.written, 1);
  assert.equal(blip.opus.calls.length, 0, "the file is typed by its own typist after the wait");
  assert.equal(blip.typist.calls.length, 2);
  assert.ok(blip.receipt.transport_waits >= 1, "counted as a wait");
});
