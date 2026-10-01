/**
 * Editor-side apply — the mechanical tier's output goes from the server to
 * disk, and the orchestrator receives a receipt. Two ideas from outside:
 * Aider's architect/editor split (the reasoning model hands the editing model
 * a reference to the plan, and the editor's output is never re-typed by the
 * architect) and FrugalGPT's cascade (a cheap scorer — here, the repo's own
 * lint/typecheck/test commands — decides whether the cheap model's answer is
 * good enough before the expensive model is involved).
 *
 * Nothing here calls a model: `runApplyLoop` takes the route and dispatch
 * functions from server.ts, which keeps the loop testable with a stub model.
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApplySpec, FileSlice, TaskPacket, TelemetryEvent } from "./types.js";

/** `{path, content}` — what every apply packet returns; substituted when the packet omits outputSchema. */
export const FILE_OUTPUT_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, content: { type: "string" } },
  required: ["path", "content"],
} as const;

/** What an `apply.mode: "edits"` packet returns; substituted when the packet omits outputSchema. */
export const EDITS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line: { type: "number" },
          anchor: { type: "string" },
          position: { type: "string", enum: ["after", "before", "replace", "delete"] },
          text: { type: "string" },
          count: { type: "number" },
        },
        required: ["anchor", "position", "text"],
      },
    },
  },
  required: ["edits"],
} as const;

export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_VERIFY_TIMEOUT_SEC = 120;
/** A hydrated slice larger than this is refused — the packet wanted a section, not the file. */
export const MAX_SLICE_BYTES = 200_000;
/** Verify output is tailed to this many characters before it goes into a retry instruction or a receipt. */
export const VERIFY_OUTPUT_TAIL_CHARS = 1500;

const CONTRACT_REL_PATH = ".sdlc/local/write-contract.json";

// Same list as plugin/scripts/lib/off-limits.mjs HARDCODED_OFF_LIMITS; the
// server cannot import an .mjs from the plugin tree at runtime, and
// apply.test.mjs asserts the two stay equal.
export const HARDCODED_OFF_LIMITS = [
  ".env",
  ".env.*",
  ".mcp.json",
  ".cursor/rules/**",
  ".claude/settings.local.json",
  ".git/**",
];

// ---------------------------------------------------------------------------
// Input hydration
// ---------------------------------------------------------------------------

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function sliceLines(text: string, [from, to]: [number, number]): string {
  const lines = text.split("\n");
  const start = Math.max(1, from);
  const end = Math.min(lines.length, to);
  return lines.slice(start - 1, end).join("\n");
}

export function sliceSection(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const needle = heading.trim().toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    if (start === -1) {
      if (m[2].trim().toLowerCase().includes(needle)) {
        start = i;
        level = m[1].length;
      }
      continue;
    }
    if (m[1].length <= level) return lines.slice(start, i).join("\n");
  }
  return start === -1 ? null : lines.slice(start).join("\n");
}

/**
 * Fill in `content` for every slice that arrived without it. Reads relative
 * to `projectRoot`; a path that escapes it, a missing file or a slice over
 * MAX_SLICE_BYTES throws — those are planner bugs the orchestrator should
 * see, not silently empty inputs.
 */
export function hydrateInputs(packet: TaskPacket, projectRoot: string): { packet: TaskPacket; hydrated: string[] } {
  const hydrated: string[] = [];
  const inputs: FileSlice[] = packet.inputs.map((s) => {
    if (typeof s.content === "string") return s;
    const abs = resolve(projectRoot, s.path);
    const rel = toPosix(relative(projectRoot, abs));
    if (rel.startsWith("../") || rel === ".." || isAbsolute(rel)) {
      throw new Error(`execute_with_model: input slice "${s.path}" resolves outside project_root.`);
    }
    if (!existsSync(abs)) {
      throw new Error(`execute_with_model: input slice "${s.path}" does not exist under project_root (${projectRoot}).`);
    }
    const text = readFileSync(abs, "utf8");
    let content: string;
    if (s.lines) content = sliceLines(text, s.lines);
    else if (s.section) {
      const sec = sliceSection(text, s.section);
      if (sec === null) throw new Error(`execute_with_model: no heading matching "${s.section}" in ${s.path}.`);
      content = sec;
    } else content = text;
    if (Buffer.byteLength(content, "utf8") > MAX_SLICE_BYTES) {
      throw new Error(
        `execute_with_model: input slice "${s.path}" is ${Buffer.byteLength(content, "utf8")} bytes; narrow it with lines or section (limit ${MAX_SLICE_BYTES}).`,
      );
    }
    hydrated.push(s.path);
    return { ...s, content };
  });
  return { packet: { ...packet, inputs }, hydrated };
}

// ---------------------------------------------------------------------------
// Write contract — same rules as plugin/scripts/write-contract-check.mjs
// ---------------------------------------------------------------------------

export function matchGlob(path: string, pattern: string): boolean {
  if (path === pattern) return true;
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${re}$`).test(path);
}

function matchesAtAnyDepth(target: string, pattern: string): boolean {
  if (matchGlob(target, pattern)) return true;
  if (pattern.startsWith("**/") || pattern.startsWith("/")) return false;
  return matchGlob(target, "**/" + pattern);
}

function firstMatch(path: string, patterns: unknown): string | null {
  if (!Array.isArray(patterns)) return null;
  for (const p of patterns) if (typeof p === "string" && matchGlob(path, p)) return p;
  return null;
}

export interface ContractDecision {
  allowed: boolean;
  reason: string;
  rel: string;
}

/** True when a brownfield run's write contract is in force (written at Gate 0, cleared at run end). */
export function hasActiveWriteContract(projectRoot: string): boolean {
  const contractPath = join(projectRoot, CONTRACT_REL_PATH);
  try {
    if (!existsSync(contractPath) || statSync(contractPath).size > 128 * 1024) return false;
    return JSON.parse(readFileSync(contractPath, "utf8"))?.active === true;
  } catch {
    return false;
  }
}

/**
 * Decide whether the server may write `target` under `projectRoot`. Mirrors
 * the PreToolUse hook that gates the orchestrator's own Write/Edit: the
 * hardcoded off-limits always apply; an active contract adds its own
 * off_limits and, when strict, its allowlist. No contract, or an inactive one,
 * means the hardcoded list alone — the same fail-open the hook has.
 */
export function checkWriteContract(projectRoot: string, target: string, opts: { runId?: string } = {}): ContractDecision {
  const abs = resolve(projectRoot, target);
  const rel = toPosix(relative(projectRoot, abs));
  if (rel.startsWith("../") || rel === ".." || isAbsolute(rel)) {
    return { allowed: false, reason: `path escapes project_root: ${target}`, rel };
  }
  // The run's own record (a report, a receipt) is the plugin's to write, whatever the contract says about .sdlc/**.
  if (opts.runId && rel.startsWith(`.sdlc/runs/${opts.runId}/`) && !rel.includes("/../")) {
    return { allowed: true, reason: "run artifact", rel };
  }
  for (const p of HARDCODED_OFF_LIMITS) {
    if (matchesAtAnyDepth(rel, p)) return { allowed: false, reason: `off-limits (hardcoded): ${p}`, rel };
  }
  const contractPath = join(projectRoot, CONTRACT_REL_PATH);
  let contract: any = null;
  try {
    if (existsSync(contractPath) && statSync(contractPath).size <= 128 * 1024) {
      contract = JSON.parse(readFileSync(contractPath, "utf8"));
    }
  } catch {
    contract = null;
  }
  if (!contract || contract.active !== true) return { allowed: true, reason: "no active contract", rel };
  const off = firstMatch(rel, contract.off_limits);
  if (off) return { allowed: false, reason: `off-limits (contract): ${off}`, rel };
  if (contract.strict !== false) {
    const hit = firstMatch(rel, contract.allowlist);
    if (!hit) return { allowed: false, reason: `not in the run's allowlist (strict contract)`, rel };
    return { allowed: true, reason: `allowlist: ${hit}`, rel };
  }
  return { allowed: true, reason: "contract not strict", rel };
}

// ---------------------------------------------------------------------------
// Provenance-wrapped write
// ---------------------------------------------------------------------------

/** plugin/scripts/write-provenance.mjs, resolved from this file (dist/apply.js at runtime). */
export function provenanceScriptPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "write-provenance.mjs");
}

function runProvenance(
  mode: "before" | "after",
  projectRoot: string,
  runId: string,
  rel: string,
  packetId: string,
): void {
  const script = provenanceScriptPath();
  if (!existsSync(script)) return;
  // Fail-open like the script itself: a provenance hiccup never blocks the write.
  spawnSync(
    process.execPath,
    [script, `--${mode}`, `--run-id=${runId}`, `--path=${rel}`, `--packet-id=${packetId}`, `--project-root=${projectRoot}`],
    { cwd: projectRoot, stdio: "ignore", timeout: 30_000 },
  );
}

export interface WriteReceipt {
  path: string;
  bytes: number;
  lines: number;
  sha16: string;
  existed_before: boolean;
  provenance: "recorded" | "skipped";
}

export function applyContent(
  projectRoot: string,
  rel: string,
  content: string,
  opts: { runId?: string; packetId: string; format?: string[]; timeoutSec?: number },
): WriteReceipt {
  const abs = resolve(projectRoot, rel);
  const existed = existsSync(abs);
  if (opts.runId) runProvenance("before", projectRoot, opts.runId, rel, opts.packetId);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  // Format before provenance "after", so the recorded hash is the file as it stays on disk.
  if (opts.format?.length) {
    runFormat(opts.format, projectRoot, rel, opts.timeoutSec);
    content = readFileSync(abs, "utf8");
  }
  if (opts.runId) runProvenance("after", projectRoot, opts.runId, rel, opts.packetId);
  return {
    path: rel,
    bytes: Buffer.byteLength(content, "utf8"),
    lines: content.split("\n").length,
    sha16: createHash("sha256").update(content).digest("hex").slice(0, 16),
    existed_before: existed,
    provenance: opts.runId ? "recorded" : "skipped",
  };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  ran: number;
  failed_command?: string;
  exit_code?: number | null;
  output_tail?: string;
  duration_ms: number;
}

/** Formatter commands on the written file; failures are left for verify to report. */
export function runFormat(commands: string[], projectRoot: string, artifactPath: string, timeoutSec = DEFAULT_VERIFY_TIMEOUT_SEC): void {
  for (const template of commands) {
    spawnSync(template.split("{path}").join(artifactPath), {
      cwd: projectRoot,
      shell: true,
      encoding: "utf8",
      timeout: timeoutSec * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
  }
}

export function runVerify(
  commands: string[] | undefined,
  projectRoot: string,
  artifactPath: string,
  timeoutSec = DEFAULT_VERIFY_TIMEOUT_SEC,
): VerifyResult {
  const started = Date.now();
  if (!commands || commands.length === 0) return { ok: true, ran: 0, duration_ms: 0 };
  let ran = 0;
  for (const template of commands) {
    const cmd = template.split("{path}").join(artifactPath);
    ran++;
    const r = spawnSync(cmd, {
      cwd: projectRoot,
      shell: true,
      encoding: "utf8",
      timeout: timeoutSec * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const timedOut = r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    if (r.status !== 0 || timedOut) {
      const combined = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
      return {
        ok: false,
        ran,
        failed_command: cmd,
        exit_code: timedOut ? null : r.status,
        output_tail: (timedOut ? `[timed out after ${timeoutSec}s]\n` : "") + combined.slice(-VERIFY_OUTPUT_TAIL_CHARS),
        duration_ms: Date.now() - started,
      };
    }
  }
  return { ok: true, ran, duration_ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Retry packet
// ---------------------------------------------------------------------------

/**
 * The refined packet for the next mechanical attempt: a new id, retry_count
 * + 1, and the failure spelled out at the end of the instruction. Stateless
 * by design (orchestrator rule 7) — the model sees the failure, not a
 * conversation.
 */
export function refinePacket(packet: TaskPacket, failure: string): TaskPacket {
  const retry = (packet.retry_count ?? 0) + 1;
  const baseId = packet.id.replace(/-r\d+$/, "");
  return {
    ...packet,
    id: `${baseId}-r${retry}`,
    retry_count: retry,
    instruction:
      `${packet.instruction}\n\n### Previous attempt failed verification (attempt ${retry})\n` +
      `Fix the cause below and return the complete corrected file.\n\`\`\`\n${failure}\n\`\`\``,
  };
}

/** The write form of each verify formatter check (same rule as plan-to-packets' formatCommands). */
export function deriveFormat(verify: string[] | undefined): string[] | undefined {
  const out: string[] = [];
  for (const c of verify ?? []) {
    if (/\bbiome\s+(check|format)\b/.test(c) && !/--write\b/.test(c)) out.push(c.replace(/\bbiome\s+(check|format)\b/, "biome $1 --write"));
    else if (/\bprettier\b.*--check\b/.test(c)) out.push(c.replace(/--check\b/, "--write"));
  }
  return out.length ? out : undefined;
}

export function normalizeApply(spec: unknown): ApplySpec | null {
  if (!spec || typeof spec !== "object") return null;
  const s = spec as Record<string, unknown>;
  if (s.write !== true) return null;
  const verify = Array.isArray(s.verify) ? s.verify.filter((v): v is string => typeof v === "string") : undefined;
  const given = Array.isArray(s.format) ? s.format.filter((v): v is string => typeof v === "string") : undefined;
  // Packets from plan-to-packets carry `format`; hand-written debug / refinement packets often
  // omit it, and on Large2-C two of them escalated to Opus over Biome spacing the formatter fixes.
  const format = given && given.length ? given : deriveFormat(verify);
  return {
    write: true,
    mode: s.mode === "edits" ? "edits" : "content",
    verify,
    ...(format && format.length ? { format } : {}),
    max_retries: typeof s.max_retries === "number" ? Math.max(0, Math.floor(s.max_retries)) : DEFAULT_MAX_RETRIES,
    verify_timeout_sec:
      typeof s.verify_timeout_sec === "number" ? Math.max(1, s.verify_timeout_sec) : DEFAULT_VERIFY_TIMEOUT_SEC,
  };
}

/** The file content a model returned, whatever wrapper the adapter left around it. */
export function extractFileContent(result: unknown): { content: string; path?: string } | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.content === "string") return { content: r.content, path: typeof r.path === "string" ? r.path : undefined };
  if (r.result && typeof r.result === "object") return extractFileContent(r.result);
  return null;
}

export interface EditOp {
  anchor: string;
  position: "after" | "before" | "replace" | "delete";
  text: string;
  line?: number;
  /** replace / delete only: how many lines, starting at the anchor, the op covers (default 1). */
  count?: number;
}

export function extractEdits(result: unknown): EditOp[] | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.edits)) {
    const ops: EditOp[] = [];
    for (const e of r.edits) {
      if (!e || typeof e !== "object") return null;
      const o = e as Record<string, unknown>;
      if (typeof o.anchor !== "string") return null;
      if (o.position !== "after" && o.position !== "before" && o.position !== "replace" && o.position !== "delete") return null;
      // A delete carries no text; every other op must.
      if (typeof o.text !== "string" && o.position !== "delete") return null;
      const count = typeof o.count === "number" && Number.isInteger(o.count) && o.count >= 1 ? o.count : undefined;
      ops.push({
        anchor: o.anchor,
        position: o.position,
        text: typeof o.text === "string" ? o.text : "",
        line: typeof o.line === "number" ? o.line : undefined,
        ...(count ? { count } : {}),
      });
    }
    return ops;
  }
  if (r.result && typeof r.result === "object") return extractEdits(r.result);
  return null;
}

/**
 * Splice an edit list into `original`. Every anchor is resolved against the
 * ORIGINAL text (so later inserts never shift earlier line numbers): the
 * `line` hint wins when that line's text equals the anchor (trailing
 * whitespace ignored), otherwise the anchor must match exactly one line.
 * Returns the new text, or the reason it could not be applied — which is
 * what the retry packet carries back to the model.
 */
const removes = (op: EditOp) => op.position === "replace" || op.position === "delete";

export function spliceEdits(original: string, edits: EditOp[]): { ok: true; content: string } | { ok: false; reason: string } {
  if (edits.length === 0) return { ok: false, reason: "the edit list was empty" };
  const lines = original.split("\n");
  const norm = (s: string) => s.replace(/\s+$/, "");
  const resolved: Array<{ index: number; op: EditOp }> = [];
  for (const op of edits) {
    const want = norm(op.anchor);
    let index = -1;
    if (op.line && op.line >= 1 && op.line <= lines.length && norm(lines[op.line - 1]) === want) index = op.line - 1;
    else {
      const hits: number[] = [];
      lines.forEach((l, i) => { if (norm(l) === want) hits.push(i); });
      if (hits.length === 1) index = hits[0];
      else if (hits.length === 0) return { ok: false, reason: `anchor not found in the file: ${JSON.stringify(op.anchor)}` };
      else return { ok: false, reason: `anchor matches ${hits.length} lines (${hits.map((h) => h + 1).join(", ")}); give \`line\` to pick one: ${JSON.stringify(op.anchor)}` };
    }
    const span = removes(op) ? (op.count ?? 1) : 0;
    if (index + span > lines.length) {
      return { ok: false, reason: `${op.position} of ${span} line(s) from line ${index + 1} runs past the end of the file (${lines.length} lines)` };
    }
    // Two ops clash when either removes lines the other touches.
    const clash = resolved.find((r) => {
      const rSpan = removes(r.op) ? (r.op.count ?? 1) : 0;
      if (span === 0 && rSpan === 0) return false;
      const lo = Math.max(index, r.index), hi = Math.min(index + Math.max(span, 1), r.index + Math.max(rSpan, 1));
      return lo < hi;
    });
    if (clash) return { ok: false, reason: `two edits target line ${Math.max(index, clash.index) + 1}` };
    resolved.push({ index, op });
  }
  // Bottom-up so earlier indices stay valid; stable for same-line before/after pairs.
  resolved.sort((x, y) => y.index - x.index);
  for (const { index, op } of resolved) {
    if (op.position === "delete") { lines.splice(index, op.count ?? 1); continue; }
    const ins = op.text.replace(/\n$/, "").split("\n");
    if (op.position === "replace") lines.splice(index, op.count ?? 1, ...ins);
    else if (op.position === "after") lines.splice(index + 1, 0, ...ins);
    else lines.splice(index, 0, ...ins);
  }
  return { ok: true, content: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export type ApplyStatus = "applied" | "verify_failed" | "escalate" | "dispatch_failed" | "refused" | "no_content";

export interface ApplyAttemptSummary {
  id: string;
  retry_count: number;
  model_id: string;
  dispatch_ok: boolean;
  verify_ok?: boolean;
  cost_usd: number;
  failure?: string;
}

export interface ApplyOutcome {
  status: ApplyStatus;
  decision: RouteDecision;
  apply?: WriteReceipt;
  verify?: VerifyResult;
  attempts: ApplyAttemptSummary[];
  tokens: { input: number; input_cached: number; output: number };
  cost_usd: number;
  terminal_reason?: string;
  /** Set on "escalate": the retry_count the policy routed elsewhere, and the failure to carry to that model. */
  escalate?: { retry_count: number; model_id: string; failure: string };
  /** Set on "refused": why the write contract said no. Not retried — a planner bug. */
  refusal?: string;
  events_written: number;
  /** Only when no telemetry_path was given, so the events are not lost. */
  events?: TelemetryEvent[];
}

export interface RouteDecision {
  modelId: string;
  reason: string;
  ruleIndex: number;
  selection?: unknown;
}

export interface DispatchResult {
  decision: RouteDecision;
  result: {
    success: boolean;
    error?: string;
    result: unknown;
    tokens: { input: number; input_cached: number; output: number };
    cost_usd: number;
    terminal_reason?: string;
  };
  events: TelemetryEvent[];
}

export interface ApplyLoopDeps {
  packet: TaskPacket;
  apply: ApplySpec;
  projectRoot: string;
  runId?: string;
  /** True when no telemetry file is written, so the events ride in the outcome instead of being lost. */
  keepEvents: boolean;
  route: (packet: TaskPacket) => RouteDecision;
  dispatch: (packet: TaskPacket) => Promise<DispatchResult>;
  log: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void;
}

/**
 * The editor loop: dispatch → write → verify → refine → dispatch, on one
 * model, until verify passes, the mechanical retries run out, or the policy
 * would route the next attempt to a different model. The orchestrator gets
 * the receipt; the file never enters its context.
 */
export async function runApplyLoop(deps: ApplyLoopDeps): Promise<ApplyOutcome> {
  const { packet, apply, projectRoot, runId, keepEvents, route, dispatch, log } = deps;
  const attempts: ApplyAttemptSummary[] = [];
  const allEvents: TelemetryEvent[] = [];
  const tokens = { input: 0, input_cached: 0, output: 0 };
  let cost = 0;
  let firstDecision: RouteDecision | null = null;
  let receipt: WriteReceipt | undefined;
  let verify: VerifyResult | undefined;
  let terminalReason: string | undefined;
  let retriesUsed = 0;
  let current = packet;
  const maxRetries = apply.max_retries ?? 2;
  // Edits are spliced into the file as it was before this packet, on every attempt: a retry
  // onto the already-edited file finds its anchors shifted or duplicated (measured: "anchor
  // matches 3 lines" after attempt 0 had inserted eleven lines above them).
  let editsBase: string | null = null;
  if (apply.mode === "edits") {
    const abs = resolve(projectRoot, packet.artifact_path!);
    if (!existsSync(abs)) return { status: "refused", decision: route(packet), attempts, tokens, cost_usd: 0, events_written: 0, events: keepEvents ? [] : undefined, refusal: `${packet.artifact_path}: edits mode needs an existing file` };
    editsBase = readFileSync(abs, "utf8");
  }
  // Snapshot the file before anything is dispatched, so the backup is the original even if a worker
  // touches the file itself.
  if (runId) {
    const allowed = checkWriteContract(projectRoot, packet.artifact_path!, { runId });
    if (allowed.allowed) runProvenance("before", projectRoot, runId, allowed.rel, packet.id);
  }

  const finish = (status: ApplyStatus, extra: Partial<ApplyOutcome> = {}): ApplyOutcome => ({
    status,
    decision: firstDecision!,
    apply: receipt,
    verify,
    attempts,
    tokens,
    cost_usd: cost,
    terminal_reason: terminalReason,
    events_written: keepEvents ? 0 : allEvents.length,
    events: keepEvents ? allEvents : undefined,
    ...extra,
  });

  for (;;) {
    const decision = route(current);
    if (firstDecision && decision.modelId !== firstDecision.modelId) {
      const last = attempts[attempts.length - 1];
      log("info", "apply.escalate", { packet_id: current.id, retry_count: current.retry_count, from: firstDecision.modelId, to: decision.modelId });
      return finish("escalate", {
        escalate: { retry_count: current.retry_count ?? 0, model_id: decision.modelId, failure: last?.failure ?? "" },
      });
    }
    const one = await dispatch(current);
    if (!firstDecision) firstDecision = one.decision;
    allEvents.push(...one.events);
    tokens.input += one.result.tokens.input;
    tokens.input_cached += one.result.tokens.input_cached;
    tokens.output += one.result.tokens.output;
    cost += one.result.cost_usd;
    terminalReason = one.result.terminal_reason;
    const summary: ApplyAttemptSummary = {
      id: current.id,
      retry_count: current.retry_count ?? 0,
      model_id: one.decision.modelId,
      dispatch_ok: one.result.success,
      cost_usd: one.result.cost_usd,
    };
    attempts.push(summary);

    if (!one.result.success) {
      summary.failure = one.result.error;
      return finish("dispatch_failed");
    }

    let failure = "";
    let content: string | null = null;
    if (apply.mode === "edits") {
      const edits = extractEdits(one.result.result);
      if (!edits) failure = "the response had no `edits` array; return JSON {edits: [{anchor, position, text, line?, count?}]}";
      else {
        const spliced = spliceEdits(editsBase!, edits);
        if (spliced.ok) content = spliced.content;
        else failure = `edit list could not be applied: ${spliced.reason}`;
      }
    } else {
      const file = extractFileContent(one.result.result);
      if (file) content = file.content;
      else failure = "the response had no `content` string; return JSON {path, content} with the complete file in `content`";
    }
    if (content === null) {
      summary.failure = failure;
      if (retriesUsed >= maxRetries) return finish("no_content");
    } else {
      const contract = checkWriteContract(projectRoot, current.artifact_path!, { runId });
      if (!contract.allowed) {
        log("warn", "apply.refused", { packet_id: current.id, path: contract.rel, reason: contract.reason });
        summary.failure = contract.reason;
        return finish("refused", { refusal: `${contract.rel}: ${contract.reason}` });
      }
      receipt = applyContent(projectRoot, contract.rel, content, { runId, packetId: current.id, format: apply.format, timeoutSec: apply.verify_timeout_sec });
      log("info", "apply.write", { packet_id: current.id, path: receipt.path, bytes: receipt.bytes, sha16: receipt.sha16 });
      verify = runVerify(apply.verify, projectRoot, contract.rel, apply.verify_timeout_sec);
      summary.verify_ok = verify.ok;
      log(verify.ok ? "info" : "warn", "apply.verify", {
        packet_id: current.id,
        ok: verify.ok,
        ran: verify.ran,
        failed_command: verify.failed_command,
        exit_code: verify.exit_code,
        duration_ms: verify.duration_ms,
      });
      if (verify.ok) return finish("applied");
      if (editsBase !== null) writeFileSync(resolve(projectRoot, contract.rel), editsBase, "utf8");
      failure = `verify failed: ${verify.failed_command} (exit ${verify.exit_code ?? "timeout"})\n${verify.output_tail ?? ""}`;
      summary.failure = failure;
      if (retriesUsed >= maxRetries) return finish("verify_failed");
    }
    retriesUsed++;
    current = refinePacket(current, failure);
  }
}

