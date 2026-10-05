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
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApplySpec, FileSlice, ModelConfig, TaskPacket, TelemetryEvent } from "./types.js";
import { LEGACY_GEMINI_ADAPTER_ID } from "./adapters/index.js";
import { runEnded } from "./runLog.js";
import { TRANSPORT } from "./executor/tools.js";
import { applyEdits, backoffMs, RECEIPT_MAX_BYTES } from "./executor/run.js";
import { contractShape, isTransient, parseAnswer } from "./executor/typists.js";

/** `{path, content}` — what every apply packet returns; substituted when the packet omits outputSchema. */
export const FILE_OUTPUT_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, content: { type: "string" } },
  required: ["path", "content"],
} as const;


/** Retries after the first attempt: three attempts in all, as greenfield's two routed attempts and its last one. */
export const DEFAULT_MAX_RETRIES = 2;
/**
 * Seconds a check may run when its packet states none: a safety bound, because a check that never ends would hold
 * its batch slot. A feature run's packets state the plan's own time (the architect's timeout_s per check).
 */
export const DEFAULT_VERIFY_TIMEOUT_SEC = 120;
/**
 * The most one input is read whole: a safety bound against a path that names a build output or a lockfile. A larger
 * source file is sent in consecutive parts, whole (scripts/lib/change-spec.mjs wholeFileInputs).
 */
export const MAX_SLICE_BYTES = 200_000;
/**
 * A check's output is tailed to greenfield's receipt bound, the most any receipt carries (executor/run.ts
 * RECEIPT_MAX_BYTES), before it goes into a retry instruction or a receipt: the end of the output, where the
 * failure is.
 */
export const VERIFY_OUTPUT_TAIL_CHARS = RECEIPT_MAX_BYTES;

const CONTRACT_REL_PATH = ".sdlc/local/write-contract.json";
/** A safety bound on what one check command may print before it is stopped; its retry text is tailed far below this. */
const COMMAND_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
/** The write-contract hook's own bound on the contract file (write-contract-check.mjs), so both read the same contracts. */
const CONTRACT_MAX_BYTES = 128 * 1024;

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

/**
 * The model settings an apply-form packet is dispatched with. Gemini bills its thinking as output, and the thinking
 * counts against the packet's output cap: at Google's default level a 295-byte SVG cost 5,952 output tokens and long
 * edit lists reached the 8,192 cap. So a Flash completion call of an apply-form packet thinks at "low", as the
 * greenfield executor's typists do (executor/typists.ts). A tier the policy's leaf sets is kept, and every other
 * model, the agent door included, is used as the policy writes it. Only apply-form packets get this, and only a
 * brownfield feature run sends them.
 */
export function applyModelConfig(model: ModelConfig): ModelConfig {
  const flashCompletion = model.adapter === "mcp:model-dispatch" || model.adapter === LEGACY_GEMINI_ADAPTER_ID;
  if (!flashCompletion || (model as any).reasoning?.tier) return model;
  return { ...model, reasoning: { ...(model as any).reasoning, tier: "low" } } as ModelConfig;
}

/**
 * Whether a packet's inputs[] slices without `content` are read from disk under the project folder. Only for a
 * brownfield packet: an apply-form packet, one that names its brownfield `intent` (greenfield packets carry none), or
 * one in a project whose brownfield write contract is active. Any other packet goes to the model as develop sends it.
 */
export function readsSlicesFromDisk(packet: { intent?: unknown; inputs: Array<{ content?: unknown }> }, apply: unknown, projectRoot: string | undefined): boolean {
  if (apply) return true;
  if (!packet.inputs.some((s) => typeof s.content !== "string")) return false;
  return Boolean(packet.intent) || (projectRoot !== undefined && hasActiveWriteContract(projectRoot));
}

/**
 * True when a brownfield run's write contract is in force: written at Gate 0, and its run still live by its own log
 * (runLog.ts). An ended run's contract is not in force even if it was never switched off, as the hook decides.
 */
export function hasActiveWriteContract(projectRoot: string): boolean {
  const contractPath = join(projectRoot, CONTRACT_REL_PATH);
  try {
    if (!existsSync(contractPath) || statSync(contractPath).size > CONTRACT_MAX_BYTES) return false;
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    return contract?.active === true && !runEnded(projectRoot, contract.run_id);
  } catch {
    return false;
  }
}

/**
 * Decide whether the server may write `target` under `projectRoot`, in the order the PreToolUse hook that gates the
 * orchestrator's own Write/Edit decides (plugin/scripts/write-contract-check.mjs): the active contract's own run
 * folder (named by its run_id, never by the caller) is the plugin's to write; the hardcoded off-limits always apply;
 * an active contract adds its off_limits and allowlist, which a contract with `strict: false` (--strict-write=off)
 * reports instead of refusing. No contract, or an inactive one, means the hardcoded list alone.
 */
export function checkWriteContract(projectRoot: string, target: string): ContractDecision {
  const abs = resolve(projectRoot, target);
  const rel = toPosix(relative(projectRoot, abs));
  if (rel.startsWith("../") || rel === ".." || isAbsolute(rel)) {
    return { allowed: false, reason: `path escapes project_root: ${target}`, rel };
  }
  const contractPath = join(projectRoot, CONTRACT_REL_PATH);
  let contract: any = null;
  try {
    if (existsSync(contractPath) && statSync(contractPath).size <= CONTRACT_MAX_BYTES) {
      contract = JSON.parse(readFileSync(contractPath, "utf8"));
    }
  } catch {
    contract = null;
  }
  const active = contract?.active === true;
  // As the hook decides (plugin/scripts/write-contract-check.mjs): a contract binds its run only while the run is live
  // by its own log (runLog.ts); an ended run's contract binds nothing, exactly as one switched off.
  const binds = active && !runEnded(projectRoot, contract.run_id);
  const runId = binds && typeof contract.run_id === "string" && contract.run_id ? contract.run_id : null;
  // While it binds, the contract file and the run's own log are not the run's to write, whatever the allowlist says:
  // the run must not widen or switch off its own contract, or log its own end.
  if (binds) {
    const r = rel.toLowerCase();
    const runLog = runId ? `.sdlc/runs/${runId.toLowerCase()}/orchestrator.log` : null;
    if (r === CONTRACT_REL_PATH || (runLog && (r === runLog || r.startsWith(`${runLog}.`)))) {
      if (contract.strict === false) return { allowed: true, reason: "the run's own contract or log, allowed because strict false", rel };
      return { allowed: false, reason: "the run's own write contract or log, which a live run may not change", rel };
    }
  }
  // The run's own record (a report, a receipt) is the plugin's to write, whatever the contract says about .sdlc/**.
  if (runId && rel.startsWith(`.sdlc/runs/${runId}/`)) {
    return { allowed: true, reason: "run artifact", rel };
  }
  for (const p of HARDCODED_OFF_LIMITS) {
    if (matchesAtAnyDepth(rel, p)) return { allowed: false, reason: `off-limits (hardcoded): ${p}`, rel };
  }
  if (!binds) return { allowed: true, reason: active ? "the contract's run has ended" : "no active contract", rel };
  const off = firstMatch(rel, contract.off_limits);
  if (off) {
    if (contract.strict === false) return { allowed: true, reason: `off-limits (contract): ${off}, allowed because strict false`, rel };
    return { allowed: false, reason: `off-limits (contract): ${off}`, rel };
  }
  const hit = firstMatch(rel, contract.allowlist);
  if (hit) return { allowed: true, reason: `allowlist: ${hit}`, rel };
  if (contract.strict === false) return { allowed: true, reason: "not in the run's allowlist, allowed because strict false", rel };
  return { allowed: false, reason: `not in the run's allowlist (strict contract)`, rel };
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
    // A safety bound on a local bookkeeping script, so a hung one never holds the write.
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
      maxBuffer: COMMAND_OUTPUT_MAX_BYTES,
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
      maxBuffer: COMMAND_OUTPUT_MAX_BYTES,
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
/**
 * The packet for the next attempt: the failure appended to the instruction, asking for what the packet's mode takes.
 * In edits mode every attempt is spliced into the file as it was before the packet, so the retry is asked for a
 * corrected edit list; asking it for "the complete corrected file" there gets a reply the edits contract cannot take.
 */
export function refinePacket(packet: TaskPacket, failure: string, mode: "content" | "edits" = "content"): TaskPacket {
  const retry = (packet.retry_count ?? 0) + 1;
  const baseId = packet.id.replace(/-r\d+$/, "");
  const ask = mode === "edits"
    ? "Fix the cause below and return JSON {path, edits: [{search, replace}]} against the file's current text as given (your earlier edits were not kept; each search must appear exactly once), or {path, content} with the whole file."
    : "Fix the cause below and return the complete corrected file.";
  return {
    ...packet,
    id: `${baseId}-r${retry}`,
    retry_count: retry,
    instruction:
      `${packet.instruction}\n\n### Previous attempt failed verification (attempt ${retry})\n` +
      `${ask}\n\`\`\`\n${failure}\n\`\`\``,
  };
}

/**
 * An apply packet's output ceiling: the routed model's documented limit (its policy leaf's max_output_tokens_absolute),
 * so a reply is cut off only at the model's own limit and a cut-off goes to the next model in the ladder (runApplyLoop);
 * the packet's own ceiling only when the model declares none.
 */
export function applyBudget<P extends { budget: { maxInputTokens: number; maxOutputTokens: number } }>(packet: P, leaf: { max_output_tokens_absolute?: number }): P {
  const limit = leaf.max_output_tokens_absolute;
  return typeof limit === "number" && limit > 0 ? { ...packet, budget: { ...packet.budget, maxOutputTokens: limit } } : packet;
}

/** A typed check as a packet carries it: a command with `{path}`, an optional id, and its own write form. */
function typedChecks(raw: unknown): { id?: string; run: string; fix?: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as any).run === "string" && (c as any).run.trim() !== "")
    .map((c) => ({ ...(typeof c.id === "string" ? { id: c.id } : {}), run: c.run as string, ...(typeof c.fix === "string" && c.fix.trim() ? { fix: c.fix } : {}) }));
  return out.length ? out : undefined;
}

export function normalizeApply(spec: unknown): ApplySpec | null {
  if (!spec || typeof spec !== "object") return null;
  const s = spec as Record<string, unknown>;
  if (s.write !== true) return null;
  // Typed checks carry their own write forms; otherwise verify and format are taken as given. A formatter command is
  // never guessed from a check's text: that was one tool's spelling, and a packet that wants one says so.
  const checks = typedChecks(s.checks);
  const verify = checks ? checks.map((c) => c.run) : Array.isArray(s.verify) ? s.verify.filter((v): v is string => typeof v === "string") : undefined;
  const given = Array.isArray(s.format) ? s.format.filter((v): v is string => typeof v === "string") : undefined;
  const format = checks ? checks.flatMap((c) => (c.fix ? [c.fix] : [])) : given;
  return {
    write: true,
    mode: s.mode === "edits" ? "edits" : "content",
    verify,
    ...(format && format.length ? { format } : {}),
    ...(checks ? { checks } : {}),
    ...(checks && typeof s.baseline_from === "string" && s.baseline_from ? { baseline_from: s.baseline_from } : {}),
    max_retries: typeof s.max_retries === "number" ? Math.max(0, Math.floor(s.max_retries)) : DEFAULT_MAX_RETRIES,
    verify_timeout_sec:
      typeof s.verify_timeout_sec === "number" ? Math.max(1, s.verify_timeout_sec) : DEFAULT_VERIFY_TIMEOUT_SEC,
  };
}

/**
 * The baseline rule for typed checks: each check's `run` on the file before the change — the file itself for an
 * edit, `baseline_from` (a new file's style file) otherwise. A check that fails there, or cannot run, is set aside
 * for this packet: it would judge the repo's own state, not the answer, and its write form would rewrite lines the
 * change does not touch. Returns the apply spec to use and what was set aside; no baseline file, no change.
 */
export function baselineChecks(apply: ApplySpec, projectRoot: string, artifactPath: string): { apply: ApplySpec; set_aside?: { id?: string; run: string; output?: string }[] } {
  if (!apply.checks?.length) return { apply };
  const target = apply.mode === "edits" ? artifactPath : apply.baseline_from;
  if (!target) return { apply };
  const abs = resolve(projectRoot, target);
  const rel = toPosix(relative(projectRoot, abs));
  if (rel.startsWith("../") || rel === ".." || isAbsolute(rel) || !existsSync(abs)) return { apply };
  const kept: { id?: string; run: string; fix?: string }[] = [];
  const setAside: { id?: string; run: string; output?: string }[] = [];
  for (const c of apply.checks) {
    const r = runVerify([c.run], projectRoot, rel, apply.verify_timeout_sec);
    if (r.ok) kept.push(c);
    else setAside.push({ ...(c.id ? { id: c.id } : {}), run: c.run, output: `exit ${r.exit_code ?? "timeout"}: ${r.output_tail ?? ""}` });
  }
  if (!setAside.length) return { apply };
  const format = kept.flatMap((c) => (c.fix ? [c.fix] : []));
  const { format: _all, ...rest } = apply;
  return { apply: { ...rest, checks: kept, verify: kept.map((c) => c.run), ...(format.length ? { format } : {}) }, set_aside: setAside };
}

/** The file content a model returned, whatever wrapper the adapter left around it. */
export function extractFileContent(result: unknown): { content: string; path?: string } | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.content === "string") return { content: r.content, path: typeof r.path === "string" ? r.path : undefined };
  if (r.result && typeof r.result === "object") return extractFileContent(r.result);
  return null;
}


/**
 * A text's line ending: the one most of its line breaks use, or null when it has none. The writer keeps a file's own
 * ending, so an edit never rewrites the line endings of lines it did not mean to change.
 */
export function lineEndingOf(text: string): "\r\n" | "\n" | null {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  if (crlf + lf === 0) return null;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * The line ending a whole-file write takes: the file's own when it exists; for a new file, that of the first input the
 * packet shows that is a file of the same kind (same extension: its mirror); otherwise null, and the text is written
 * as the model gave it.
 */
export function targetLineEnding(projectRoot: string, packet: TaskPacket): "\r\n" | "\n" | null {
  const read = (rel: string) => { try { return readFileSync(resolve(projectRoot, rel), "utf8"); } catch { return null; } };
  const own = packet.artifact_path ? read(packet.artifact_path) : null;
  if (own !== null) return lineEndingOf(own);
  const ext = packet.artifact_path ? extname(packet.artifact_path) : "";
  for (const s of packet.inputs ?? []) {
    if (!ext || typeof s?.path !== "string" || extname(s.path) !== ext) continue;
    const text = read(s.path);
    if (text !== null) return lineEndingOf(text);
  }
  return null;
}

/**
 * An edits-mode answer applied to the file as it was before the packet: greenfield's contract and applier
 * (executor/typists.ts parseAnswer, executor/run.ts applyEdits) — {path, edits: [{search, replace}]}, each search found
 * exactly once in the text as it stands, or {path, content} with the whole file. Greenfield writes new files; a
 * brownfield file can have CRLF endings (a Windows checkout), so the edits apply to the text with LF endings and the
 * result takes the file's own ending back (a file with mixed endings comes back with its dominant one).
 */
export function applySearchReplace(base: string, answer: unknown): { content?: string; reason?: string } {
  const a = parseAnswer(answer, "edit");
  if (!a) return { reason: `the answer was not ${contractShape("edit")}` };
  const lf = (s: string) => s.replace(/\r\n/g, "\n");
  const own = (s: string) => (lineEndingOf(base) === "\r\n" ? lf(s).replace(/\n/g, "\r\n") : lf(s));
  if (a.content !== undefined) return { content: own(a.content) };
  const r = applyEdits(lf(base), a.edits!.map((e) => ({ search: lf(e.search), replace: lf(e.replace) })));
  return r.content !== undefined ? { content: own(r.content) } : { reason: r.reason };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export type ApplyStatus = "applied" | "verify_failed" | "escalate" | "dispatch_failed" | "refused" | "no_content" | "stopped";

export interface ApplyAttemptSummary {
  id: string;
  retry_count: number;
  model_id: string;
  dispatch_ok: boolean;
  verify_ok?: boolean;
  cost_usd: number;
  failure?: string;
  /** A busy vendor's reply (429, 5xx, a dropped connection) that was waited out: no attempt. */
  transport_wait?: boolean;
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
  /** Set when the vendor refused the call's credentials (401, 403): every packet would fail the same way, so the batch stops. */
  halt?: string;
  /** Typed checks the file failed before the change (baselineChecks): set aside, never judging this packet. */
  set_aside?: { id?: string; run: string; output?: string }[];
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
    /** The vendor's own account of the last call (types.ts AttemptRecord): a failure is classified from these, never from words. */
    attempts?: Array<{ error_status?: number; error_code?: string; retry_after_ms?: number; transient?: boolean }>;
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
  /** One call; `force` names the model for this attempt instead of the policy's route (a cut-off's next typist). */
  dispatch: (packet: TaskPacket, force?: RouteDecision) => Promise<DispatchResult>;
  log: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void;
  /**
   * The request's own cancel signal (Claude Code cancels the call when the person stops it): no attempt starts after
   * it, and an answer that arrives after it is not written, so a stopped run writes nothing more into the project.
   */
  signal?: AbortSignal;
  /**
   * Whether the server can type with the model a routing decision names (the server's applyTypist.ts lean typist for
   * a feature run's Claude leaf). A retry the policy routes to such a model stays in this loop, as greenfield's ladder
   * does; one routed to any other model ends the loop as `escalate`, for the orchestrator. Absent: every change of
   * model is an escalate, as before.
   */
  typesInServer?: (decision: RouteDecision) => boolean;
  /**
   * The model of the ladder's last attempt (greenfield's: the lean Opus typist, executor/tools.ts fallbackLeaf), or
   * null when the server cannot type with one. Every attempt but the last goes where the policy routes it; the last
   * goes here. Absent or null: every attempt goes where the policy routes it, as before.
   */
  lastAttempt?: () => RouteDecision | null;
  /** Waits for a busy vendor: greenfield's stated bounds (executor/tools.ts TRANSPORT) unless a test passes its own. */
  transport?: { maxWaits: number; baseMs: number; capMs: number };
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** HTTP statuses that mean the credentials or permission are wrong, not that the vendor is busy (RFC 9110). */
const CREDENTIAL_REFUSALS = new Set([401, 403]);

/**
 * The editor loop: dispatch → write → verify → refine → dispatch, on one
 * model, until verify passes, the mechanical retries run out, or the policy
 * would route the next attempt to a different model. The orchestrator gets
 * the receipt; the file never enters its context.
 */
export async function runApplyLoop(deps: ApplyLoopDeps): Promise<ApplyOutcome> {
  const { packet, projectRoot, runId, keepEvents, route, dispatch, log, signal } = deps;
  let apply = deps.apply;
  const transport = deps.transport ?? TRANSPORT;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  let waits = 0;
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
  const baseRetry = packet.retry_count ?? 0;
  // The ladder's model for attempt `slot` (0 … maxRetries) of packet `p`: the policy's route, the last-attempt model
  // for the last slot when it is a retry (the routed model always types first). `forced` says the decision is not the
  // policy's own, so dispatch is told it.
  const ladder = (p: TaskPacket, slot: number): { decision: RouteDecision; forced: boolean } => {
    const last = slot > 0 && slot >= maxRetries ? deps.lastAttempt?.() ?? null : null;
    return last ? { decision: last, forced: true } : { decision: route(p), forced: false };
  };
  // Edits are spliced into the file as it was before this packet, on every attempt: a retry
  // onto the already-edited file finds its anchors shifted or duplicated (measured: "anchor
  // matches 3 lines" after attempt 0 had inserted eleven lines above them).
  let editsBase: string | null = null;
  // A whole-file write keeps the file's own line ending (or its mirror's, for a new file); edits keep it in spliceEdits.
  const contentEol = apply.mode === "edits" ? null : targetLineEnding(projectRoot, packet);
  if (apply.mode === "edits") {
    const abs = resolve(projectRoot, packet.artifact_path!);
    if (!existsSync(abs)) return { status: "refused", decision: route(packet), attempts, tokens, cost_usd: 0, events_written: 0, events: keepEvents ? [] : undefined, refusal: `${packet.artifact_path}: edits mode needs an existing file` };
    editsBase = readFileSync(abs, "utf8");
  }
  // Typed checks: before any typist is paid, a check the file already fails is set aside for this packet
  // (baselineChecks), so it neither judges the answer nor runs its write form; the receipt names it.
  const baseline = baselineChecks(apply, projectRoot, packet.artifact_path!);
  apply = baseline.apply;
  if (baseline.set_aside) log("info", "apply.baseline", { packet_id: packet.id, set_aside: baseline.set_aside.map((c) => c.id ?? c.run).join(",") });
  let snapshot: string | null = null;
  // Snapshot the file before anything is dispatched, so the backup is the original even if a worker
  // touches the file itself.
  if (runId) {
    const allowed = checkWriteContract(projectRoot, packet.artifact_path!);
    if (allowed.allowed) { runProvenance("before", projectRoot, runId, allowed.rel, packet.id); snapshot = allowed.rel; }
  }

  const finish = (status: ApplyStatus, extra: Partial<ApplyOutcome> = {}): ApplyOutcome => {
    // A packet that ends without its write standing (the original put back, or nothing written) records the file as
    // it is now, so the run's provenance matches the disk and /mmo:revert does not flag an unchanged file.
    // write-provenance fills sha_after only while it is empty, and a failed attempt's write already filled it; a
    // second --before keeps the run's first snapshot and empties sha_after, so the --after that follows records the
    // file on disk now.
    if (status !== "applied" && runId && snapshot) {
      runProvenance("before", projectRoot, runId, snapshot, current.id);
      runProvenance("after", projectRoot, runId, snapshot, current.id);
    }
    return outcome(status, extra);
  };
  const outcome = (status: ApplyStatus, extra: Partial<ApplyOutcome> = {}): ApplyOutcome => ({
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
    ...(baseline.set_aside ? { set_aside: baseline.set_aside } : {}),
    ...extra,
  });

  const stopped = () => {
    log("info", "apply.stopped", { packet_id: current.id, attempts: attempts.length });
    return finish("stopped", { decision: firstDecision ?? route(current) });
  };
  for (;;) {
    if (signal?.aborted) return stopped();
    const step = ladder(current, retriesUsed);
    const decision = step.decision;
    // The last-attempt model is one the server types with by its definition (lastAttempt); any other change of model
    // the server cannot type with goes back to the orchestrator.
    if (!step.forced && firstDecision && decision.modelId !== firstDecision.modelId && !deps.typesInServer?.(decision)) {
      const last = attempts[attempts.length - 1];
      log("info", "apply.escalate", { packet_id: current.id, retry_count: current.retry_count, from: firstDecision.modelId, to: decision.modelId });
      return finish("escalate", {
        escalate: { retry_count: current.retry_count ?? 0, model_id: decision.modelId, failure: last?.failure ?? "" },
      });
    }
    const one = await dispatch(current, step.forced ? decision : undefined);
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
      const last = one.result.attempts?.[one.result.attempts.length - 1];
      summary.failure = one.result.error;
      // Credentials the vendor refuses fail every packet the same way: the batch stops here, as greenfield's executor
      // stops its stage, instead of handing each file to another model.
      if (last?.error_status !== undefined && CREDENTIAL_REFUSALS.has(last.error_status)) {
        return finish("dispatch_failed", { halt: `the ${one.decision.modelId} call was refused with HTTP ${last.error_status} (its login or permission is broken); the batch stopped here` });
      }
      // Cut off at the model's own output limit (the packet starts there: applyBudget). Greenfield's rule
      // (executor/run.ts): the same model cannot return the whole answer at the same limit, so its later attempts are
      // skipped and the packet goes to the next different model in the ladder, in that model's own slot; a cut-off
      // never adds an attempt. With no other model left the packet fails with the cut-off as its reason.
      if (one.result.terminal_reason === "output_cap_at_model_absolute" || one.result.terminal_reason === "output_cap_doubling_budget_exhausted") {
        let slot = retriesUsed + 1;
        while (slot <= maxRetries && ladder({ ...current, retry_count: baseRetry + slot }, slot).decision.modelId === one.decision.modelId) slot++;
        if (slot > maxRetries) return finish("dispatch_failed");
        const to = ladder({ ...current, retry_count: baseRetry + slot }, slot).decision.modelId;
        log("info", "apply.cut_off", { packet_id: current.id, from: one.decision.modelId, to });
        retriesUsed = slot;
        current = refinePacket({ ...current, retry_count: baseRetry + slot - 1 }, "The previous answer was cut off at the model's output limit; give the whole answer.", apply.mode === "edits" ? "edits" : "content");
        continue;
      }
      // A busy vendor (429, 5xx, a dropped connection) is waited out and the same packet sent again, as greenfield's
      // executor does: a wait is not an attempt, and a rate-limited call bills $0. A pause longer than one rate-limit
      // window (both vendors meter per minute) means the quota is spent for longer than a batch waits: that ends it.
      const longPause = last?.retry_after_ms !== undefined && last.retry_after_ms > transport.capMs;
      // A typist that read the vendor's own fields says so itself (greenfield's TypistResult.transport).
      if ((last?.transient === true || isTransient(last?.error_status, last?.error_code)) && !longPause && waits < transport.maxWaits) {
        summary.transport_wait = true;
        log("info", "apply.transport_wait", { packet_id: current.id, status: last?.error_status, code: last?.error_code, wait: waits + 1 });
        await sleep(last?.retry_after_ms ?? backoffMs(waits, transport.baseMs, transport.capMs, random));
        waits++;
        continue;
      }
      return finish("dispatch_failed");
    }
    if (signal?.aborted) return stopped();

    let failure = "";
    let content: string | null = null;
    if (apply.mode === "edits") {
      // Every attempt applies to the file as it was before the packet (editsBase), as greenfield's fixes apply to the
      // current text they were shown.
      const r = applySearchReplace(editsBase!, one.result.result);
      if (r.content !== undefined) content = r.content;
      else failure = `the edits could not be applied: ${r.reason}`;
    } else {
      const file = extractFileContent(one.result.result);
      if (file) content = contentEol ? file.content.replace(/\r?\n/g, contentEol) : file.content;
      else failure = "the response had no `content` string; return JSON {path, content} with the complete file in `content`";
    }
    if (content === null) {
      summary.failure = failure;
      if (retriesUsed >= maxRetries) return finish("no_content");
    } else {
      const contract = checkWriteContract(projectRoot, current.artifact_path!);
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
    current = refinePacket(current, failure, apply.mode === "edits" ? "edits" : "content");
  }
}

