/**
 * The run's typists, tested before the run spends anything.
 *
 * Why: pre-flight builds every adapter, which catches a missing credential, but a credential that exists and cannot be
 * used is only found when a call is made. The lean Opus typist runs `claude -p` with this computer's own Claude login
 * (Claude Code does not pass a session's token to a plugin's server); when that login had expired, every file's
 * attempts failed one after another, after the requirements and design phases were already paid for. With
 * `probe_typists`, preflight_dispatch sends one minimal call through every typist the run types with — the same door,
 * login and model as the run's own calls — so such a run stops at its start, with what to fix.
 *
 * The typists of a run are the executor's (executor/tools.ts): every routed attempt of the typed stages (codegen,
 * tests, docs, and debug for fixes) and the lean Opus last attempt. Greenfield's executor and a brownfield run's apply
 * loop read the policy the same way (executorView) and type with the same typists; a brownfield run's packets also
 * carry its job (`intent`), which a policy rule can be scoped to, so its probe is given the job and covers those rules
 * too.
 *
 * Every Antigravity leaf the run can reach is probed too, typing or not (runProbeLeaves), with the cheap typist worker:
 * a policy whose only Antigravity leaf judges still has its project, location and model tested before the run. A leaf
 * with failover_locations is probed at each of its locations, each call pinned to that one location and ended by
 * Google's first answer or status (no retries of its own), so a location that refuses every call does not hold the
 * run's start.
 *
 * What stops the run: a call refused with HTTP 401/403 (the halt names the project and gives Google's message), a model
 * or location Google answers 400/404 for (the halt names them: no login fix applies), a call that brought no reply at
 * all (a login the CLI could not use, a crash, a timeout), or a typist that cannot be built on this machine. A busy
 * vendor (a transport failure, a 429 / 5xx status the door's typist reports, or a call Google held or refused past its
 * own budget) passes with a note: the run waits a busy vendor out on every call, so it is no reason to stop. A reply
 * outside the probe's contract passes: the model answered, so its door and login work.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GeminiCallRecord, ModelConfig, Policy, SelectOverrides, TaskPacket, TelemetryEvent } from "./types.js";
import type { Door, Typist, TypistResult, TypistTokens } from "./executor/typists.js";
import { LeanOpusTypist, FlashCompletionTypist, AgyTypist, isTransient, leanOpusCliProblem } from "./executor/typists.js";
import { PREFLIGHT_PHASE, cacheWriteBuckets } from "./telemetry.js";
import { ROUTED_ATTEMPTS, TRANSPORT, TYPIST_EFFORT, fallbackLeaf, typistDoorFor } from "./executor/tools.js";
import { FILE_ANSWER_SCHEMA, framedPacket } from "./executor/brief.js";
import { executorView } from "./executor/run.js";
import { pickModel, resolveNamed, unreachableModelIds } from "./routing.js";
import { resolveGcpProject, workerVertexLocation } from "./adapters/geminiTransports.js";

/**
 * How long one probe call may take, in seconds: a stated bound, under the typing call's own (TYPIST_TIMEOUT_S), so a
 * door that hangs stops pre-flight in minutes. Two minutes covers the slowest start measured, the agent door's
 * worker process and SDK session.
 */
export const PROBE_TIMEOUT_S = 120;

/** The probe's whole job: the smallest answer in the file contract. */
const PROBE_PATH = "probe.txt";
const PROBE_PACKET: TaskPacket = {
  id: "typist_probe",
  phase: "codegen",
  task_type: "typist_probe",
  module: "preflight",
  instruction: `A one-line test call before a run starts. Return ONLY the JSON object {"path": "${PROBE_PATH}", "content": "ok"} with no other text.`,
  inputs: [],
  outputSchema: FILE_ANSWER_SCHEMA,
  acceptance: [],
  budget: { maxInputTokens: 2000, maxOutputTokens: 64 },
} as unknown as TaskPacket;

/**
 * Every model the run types with: the routed attempts of the typed stages and the last attempt (the executor's
 * reading of the policy, executorView, with the run's slot choices), keeping only models a typist exists for. A
 * brownfield run passes its job (`intent`): its packets carry it, so a rule scoped to that job routes them, and only
 * that job's rules count (a rule for another job never types this run's files).
 */
export function runTypingLeaves(policy: Policy, overrides: SelectOverrides, intent?: string): ModelConfig[] {
  const view = executorView(policy).policy;
  const ids = new Set<string>();
  const add = (pick: () => string) => { try { ids.add(pick()); } catch { /* a stage the policy cannot route has no typist */ } };
  for (const phase of ["codegen", "tests", "docs", "debug"]) {
    for (let k = 0; k < ROUTED_ATTEMPTS; k++) add(() => pickModel({ phase, task_type: "", module: "spec", retry_count: k, ...(intent ? { intent } : {}) }, view, overrides).modelId);
  }
  const fb = fallbackLeaf(view, overrides);
  if (fb) ids.add(fb.id);
  return view.models.filter((m) => ids.has(m.id) && typistDoorFor(m) !== null);
}

/**
 * Every Antigravity leaf a rule of the policy routes to, and the run's slot choices can reach, that does not type the
 * run (not in runTypingLeaves): a leaf the run only judges with. The run-start probe calls each through the typist
 * worker (one cheap call on the same project, location, Python and harness as the agent door's).
 */
export function judgingAgentLeaves(policy: Policy, overrides: SelectOverrides, intent?: string): ModelConfig[] {
  const typing = new Set(runTypingLeaves(policy, overrides, intent).map((m) => m.id));
  const unreachable = unreachableModelIds(policy, overrides);
  const routed = new Set<string>();
  for (const rule of policy.rules) {
    const named = "use" in rule ? rule.use : rule.default;
    try { routed.add(resolveNamed(policy, named, overrides).modelId); } catch { /* an unknown name: the loader refused it already */ }
  }
  return policy.models.filter((m) => m.adapter === "antigravity-worker" && routed.has(m.id) && !unreachable.has(m.id) && !typing.has(m.id));
}

/** Every model the run-start probe calls: the typing models (runTypingLeaves, unchanged), then judgingAgentLeaves. */
export function runProbeLeaves(policy: Policy, overrides: SelectOverrides, intent?: string): ModelConfig[] {
  return runTypingLeaves(policy, overrides, intent).concat(judgingAgentLeaves(policy, overrides, intent));
}

/**
 * The agent worker's own waits on a transient API error, in milliseconds: its SDK retries TRANSPORT.maxWaits times,
 * the first wait TRANSPORT.baseMs, each doubling (the worker's exponential_multiplier, worker/typist_worker.py), with no
 * jitter — the same retry settings the run's agent typist gives it (executor/tools.ts typistForLeaf).
 */
export const AGY_SDK_WAITS_MS = TRANSPORT.baseMs * (2 ** TRANSPORT.maxWaits - 1);

/** How one probe call is made: `pinned` for a call pinned to one location of a leaf with failover_locations. */
export interface ProbeCall { pinned?: boolean }

/**
 * A typist for one probe call: the run's own typist for the leaf, waiting at most PROBE_TIMEOUT_S. The agent door's
 * worker keeps the run's retry settings, so its limit adds the SDK's own waits: a shorter one cuts the call off while
 * the SDK is still waiting out a busy vendor, which would read as a door that cannot answer. Its call gets one try
 * against a stall: a probe call Google holds is a busy Google, which passes, so a second, longer wait would only delay
 * the run's start.
 *
 * A call pinned to one location of a leaf with failover_locations (`pinned`) ends at Google's first answer or status:
 * no retry of the harness's own and no resend of a 500 (no busy budget). Google's first answer already says what the
 * probe is for (the login, the project and the model at that location work, or which of them does not), and a busy
 * location passes either way; waiting out the SDK's retries there only held the run's start, about 100 s whenever
 * one location refused every call. It is classified as every probe call is (classify below).
 */
export function probeTypist(leaf: ModelConfig, authMode: "estimated" | "vendor", call: ProbeCall = {}): Typist {
  switch (typistDoorFor(leaf)) {
    case "lean-opus":
      return new LeanOpusTypist(leaf, { authMode, effort: TYPIST_EFFORT, timeoutMs: PROBE_TIMEOUT_S * 1000 });
    case "flash-completion":
      return new FlashCompletionTypist(leaf, TYPIST_EFFORT, PROBE_TIMEOUT_S * 1000);
    case "agy":
      if (call.pinned) return new AgyTypist(leaf, { effort: TYPIST_EFFORT, maxModelCalls: 1, timeoutSec: PROBE_TIMEOUT_S, apiRetries: 0, apiRetryInitialMs: TRANSPORT.baseMs, stallTries: 1, busyBudgetSec: 0 });
      return new AgyTypist(leaf, { effort: TYPIST_EFFORT, maxModelCalls: 1, timeoutSec: PROBE_TIMEOUT_S + Math.ceil(AGY_SDK_WAITS_MS / 1000), apiRetries: TRANSPORT.maxWaits, apiRetryInitialMs: TRANSPORT.baseMs, stallTries: 1 });
    default:
      throw new Error(`no typist for adapter '${leaf.adapter}' (leaf ${leaf.id})`);
  }
}

/**
 * The calls one leaf's probe makes: one, or, for an Antigravity leaf with failover_locations, one per location, each
 * pinned to that location with failover off, so a location that does not serve the model or the project is found
 * before the run.
 */
function probeTargets(leaf: ModelConfig): { leaf: ModelConfig; location?: string }[] {
  if (leaf.adapter !== "antigravity-worker" || !(leaf.failover_locations ?? []).length) return [{ leaf }];
  const own = workerVertexLocation(leaf, process.env as Record<string, string | undefined>);
  const locations = [own, ...leaf.failover_locations!.filter((l) => l !== own)];
  return locations.map((location) => {
    const { failover_locations: _f, ...pinned } = leaf;
    return { leaf: { ...pinned, region: location }, location };
  });
}

export interface ProbeOutcome {
  model_id: string;
  model_name: string;
  /** The typist's door; "unknown" only for a leaf no typist exists for (runTypingLeaves never lists one). */
  door: Door | "unknown";
  /** False stops the run (pre-flight's halt_reason). */
  ok: boolean;
  /** The vendor was busy: the call was not tested, and the run waits a busy vendor out as usual. */
  busy?: boolean;
  /** Why the call failed, in the typist's own words. */
  reason?: string;
  /** What to fix, for the door that failed. */
  fix?: string;
  /** Every token the typist reported, cache writes and reasoning included: cost_usd prices them all. */
  tokens: TypistTokens;
  cost_usd: number;
  latency_ms: number;
  price_basis?: string;
  /** The one location this call was pinned to (a leaf with failover_locations is probed at each). */
  location?: string;
  /** The Antigravity call's record: the project, location and SDK version it ran on. */
  gemini?: GeminiCallRecord;
}

/** What to do about a door that cannot answer. */
const FIX: Record<string, string> = {
  "lean-opus":
    "Under estimated auth the lean Opus typist runs this computer's own Claude login (not a token a chat was started with): in a terminal run `claude`, then /login, on a plan larger than Pro. Under vendor auth it uses ANTHROPIC_API_KEY.",
  "flash-completion":
    "Check this computer's Google credentials: `gcloud auth application-default login` with the run's project, or GEMINI_API_KEY.",
  agy: "Check this computer's Google credentials (`gcloud auth application-default login`) and the Antigravity worker's environment: run /mmo:setup, which builds it for any policy that reaches an Antigravity leaf.",
};

/**
 * What to do about a call the vendor refused with 401 or 403. On the Antigravity door the worker ran and Google
 * answered, so its environment is not the cause: the login, the project or the account's permission there is.
 */
const REFUSED_FIX: Record<string, string> = {
  ...FIX,
  agy: "Check the run's Google project (GOOGLE_CLOUD_PROJECT) and this computer's Google login (`gcloud auth application-default login`): the account needs permission to call Vertex AI in that project (the Vertex AI User role).",
};

/** What to do about a model or location Google does not serve: no login fix applies. */
const NOT_SERVED_FIX = "Check the leaf's model_name and its region (and failover_locations): Google does not serve this model there, for this project. Vertex location ids are lower case.";

function classify(leaf: ModelConfig, door: Door, r: TypistResult, location?: string): ProbeOutcome {
  const base = {
    model_id: leaf.id, model_name: leaf.model_name, door, tokens: { ...r.tokens }, cost_usd: r.cost_usd, latency_ms: r.latency_ms,
    ...(r.price_basis ? { price_basis: r.price_basis } : {}), ...(location ? { location } : {}), ...(r.gemini ? { gemini: r.gemini } : {}),
  };
  if (r.answer) return { ...base, ok: true };
  // Google held or refused the call past its own budget: a busy Google, which the run waits out, not a broken login.
  if (r.unavailable !== undefined) return { ...base, ok: true, busy: true, reason: r.error ?? r.unavailable };
  // Busy by the typist's own reading, or by the vendor's status when the typist reports one without a transport flag:
  // the agent door's SDK has already waited out its own retries by the time its error reaches the typist, so that
  // typist never sets the flag (executor/typists.ts agyOutcome).
  if (r.transport || isTransient(r.error_status)) return { ...base, ok: true, busy: true, reason: r.error ?? "the vendor was busy" };
  if (r.error_status === 401 || r.error_status === 403) {
    const project = r.gemini?.project ?? (door === "lean-opus" ? undefined : resolveGcpProject(process.env as Record<string, string | undefined>));
    const who = project ? `the login or the project '${project}' is wrong` : "the login or its permission is wrong";
    return { ...base, ok: false, reason: `refused with HTTP ${r.error_status}: ${who}: ${r.error ?? ""}`.trim(), fix: REFUSED_FIX[door] };
  }
  if (r.error_status === 400 || r.error_status === 404) {
    const where = r.gemini?.location ?? location;
    return { ...base, ok: false, reason: `the model or location is wrong: Google answered HTTP ${r.error_status} for ${leaf.model_name}${where ? ` at ${where}` : ""}: ${r.error ?? ""}`.trim(), fix: NOT_SERVED_FIX };
  }
  // The model replied, outside the probe's contract: its door and login work.
  if (r.tokens.output > 0) return { ...base, ok: true, reason: r.error };
  return { ...base, ok: false, reason: r.error ?? "no reply", fix: FIX[door] };
}

/**
 * One call through each typist, all at once. `build` makes the typist (probeTypist, or a stand-in in tests); a typist
 * that cannot be built on this machine fails its probe with the reason. A lean Opus typist that cannot be built is a
 * problem of this machine's claude CLI, not of its login, so its fix is what `cliProblem` (leanOpusCliProblem) says to
 * change, the CLI's own remedy (update Claude Code, or put `claude` on the PATH); the login's fix only when the CLI
 * shows no problem.
 */
export async function probeTypists(
  leaves: ModelConfig[],
  authMode: "estimated" | "vendor",
  build: (leaf: ModelConfig, authMode: "estimated" | "vendor", call?: ProbeCall) => Typist = probeTypist,
  cliProblem: () => string | null = () => leanOpusCliProblem(),
): Promise<ProbeOutcome[]> {
  return Promise.all(leaves.flatMap(probeTargets).map(async ({ leaf, location }): Promise<ProbeOutcome> => {
    const door = typistDoorFor(leaf) ?? "unknown";
    const at = location ? { location } : {};
    let typist: Typist;
    // A target with a location is one location of a failover leaf (probeTargets): its call is pinned there.
    try { typist = build(leaf, authMode, location ? { pinned: true } : {}); } catch (err: any) {
      const fix = (door === "lean-opus" ? cliProblem() : null) ?? FIX[door];
      return { model_id: leaf.id, model_name: leaf.model_name, door, ok: false, reason: err?.message ?? String(err), fix, tokens: { input: 0, input_cached: 0, output: 0 }, cost_usd: 0, latency_ms: 0, ...at };
    }
    const dir = mkdtempSync(join(tmpdir(), "mmo-typist-probe-"));
    try {
      const sharedFile = join(dir, "shared.txt");
      writeFileSync(sharedFile, "");
      const r = await typist.type({ unit: { id: PROBE_PACKET.id, path: PROBE_PATH }, packet: PROBE_PACKET, framed: framedPacket(PROBE_PACKET), shared: "", sharedFile, contract: "file", passId: "typist_probe" });
      return classify(leaf, typist.door, r, location);
    } catch (err: any) {
      return { model_id: leaf.id, model_name: leaf.model_name, door, ok: false, reason: err?.message ?? String(err), fix: FIX[door], tokens: { input: 0, input_cached: 0, output: 0 }, cost_usd: 0, latency_ms: 0, ...at };
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* left for the system's temp cleanup */ }
    }
  }));
}

/**
 * The probe calls as telemetry events of the run, so their cost is in the run's record like every other call's. Typed
 * as TelemetryEvent itself (phase "preflight" is one of its phases), so the compiler holds them to the event's shape.
 */
export function probeEvents(outcomes: ProbeOutcome[], ctx: { pass: string; policy: { name: string; version: number } }): TelemetryEvent[] {
  return outcomes.map((o): TelemetryEvent => ({
    ts: new Date().toISOString(),
    pass: ctx.pass,
    phase: PREFLIGHT_PHASE,
    task_type: "typist_probe",
    task_id: `typist_probe_${o.model_id}`,
    module: "preflight",
    model: o.model_name,
    model_id: o.model_id,
    ...(o.door !== "unknown" ? { door: o.door } : {}),
    routed_by: "orchestrator",
    provenance: "vendor",
    routing: { policy_name: ctx.policy.name, policy_version: ctx.policy.version, rule_index: -1, rule_reason: "pre-flight: one test call through each typist of the run" },
    // One call, never a retry: every event states its retry count (types.ts TelemetryEvent).
    retry_count: 0,
    input_tokens: o.tokens.input,
    input_tokens_cached: o.tokens.input_cached,
    // Cache writes and reasoning, as every typist event stores them (executor/run.ts): the dollars price them.
    ...cacheWriteBuckets(o.tokens),
    output_tokens: o.tokens.output,
    output_tokens_reasoning: o.tokens.output_reasoning,
    cost_usd: o.cost_usd,
    latency_ms: o.latency_ms,
    success: o.ok && !o.busy,
    ...(o.reason ? { error: o.reason } : {}),
    ...(o.price_basis ? { price_basis: o.price_basis as TelemetryEvent["price_basis"] } : {}),
    ...(o.gemini ? { gemini: o.gemini } : {}),
  }));
}
