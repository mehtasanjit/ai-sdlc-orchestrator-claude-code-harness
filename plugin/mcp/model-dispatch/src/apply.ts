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

import { closeSync, constants as FS, existsSync, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApplySpec, FileSlice, ModelConfig, RetryReason, TaskPacket, TelemetryEvent } from "./types.js";
import { LEGACY_GEMINI_ADAPTER_ID } from "./adapters/index.js";
import { liveFreeze, runEnded } from "./runLog.js";
import { TRANSPORT } from "./executor/tools.js";
import { applyEdits, backoffMs, RECEIPT_MAX_BYTES } from "./executor/run.js";
import { contractShape, isTransient, parseAnswer } from "./executor/typists.js";
import { checkAnswer } from "./executor/checks.js";
import { isSafeRelativePath } from "./spec/store.js";
import { commandEnv } from "./executor/acceptance.js";

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
 * its batch slot. A brownfield run's packets state the plan's own time (the architect's timeout_s per check).
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
/**
 * The bytes of a command's output kept while it runs: enough for the tail a receipt carries (VERIFY_OUTPUT_TAIL_CHARS
 * characters, at most 4 bytes each in UTF-8). Older output is dropped as it streams, so a command that prints a lot is
 * judged by its exit status alone and never stopped for its output.
 */
const OUTPUT_KEEP_BYTES = 4 * VERIFY_OUTPUT_TAIL_CHARS;
/** setTimeout's own limit (2^31 − 1 ms): a longer delay fires at once, so a time limit is held to it. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** The write-contract hook's own bound on the contract file (write-contract-check.mjs), so both read the same contracts. */
const CONTRACT_MAX_BYTES = 128 * 1024;
/** A run id as plan-to-packets accepts one (scripts/lib/change-spec.mjs runFolder): a folder name under .sdlc/runs. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
// Paths: off-limits matching and the read rule
// ---------------------------------------------------------------------------

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/** A project-relative path that leaves the project (`..`, or another root). */
function escapes(rel: string): boolean {
  return rel.startsWith("../") || rel === ".." || isAbsolute(rel);
}

/**
 * Whether `path` matches the glob `pattern` (`**` any depth, `*` and `?` within one name). With `nocase`, letters
 * match in either case: on a case-insensitive disk (macOS's default) another spelling of a name is the same file, so
 * an off-limits pattern is matched that way. The allowlist keeps its case, so a spelling it does not list stays out.
 */
export function matchGlob(path: string, pattern: string, nocase = false): boolean {
  if (nocase ? path.toLowerCase() === pattern.toLowerCase() : path === pattern) return true;
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${re}$`, nocase ? "i" : "").test(path);
}

function matchesAtAnyDepth(target: string, pattern: string, nocase = false): boolean {
  if (matchGlob(target, pattern, nocase)) return true;
  if (pattern.startsWith("**/") || pattern.startsWith("/")) return false;
  return matchGlob(target, "**/" + pattern, nocase);
}

function firstMatch(path: string, patterns: unknown, nocase = false): string | null {
  if (!Array.isArray(patterns)) return null;
  for (const p of patterns) if (typeof p === "string" && matchGlob(path, p, nocase)) return p;
  return null;
}

/**
 * A file's bytes, read only when it is a regular file within `maxBytes`, or null: the hook's own reader
 * (plugin/scripts/ambient/lib/workflow-log.mjs readRegularFile). Opened without following a link and without waiting,
 * then judged on the open file itself: a named pipe in the contract's place would otherwise hold the server until
 * something wrote to it, and a link would let the contract be a file elsewhere.
 */
function readRegularFile(file: string, maxBytes: number): Buffer | null {
  let fd: number;
  try { fd = openSync(file, FS.O_RDONLY | (FS.O_NONBLOCK ?? 0) | (FS.O_NOFOLLOW ?? 0)); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let at = 0;
    while (at < st.size) {
      const n = readSync(fd, buf, at, st.size - at, at);
      if (n <= 0) break;
      at += n;
    }
    return buf.subarray(0, at);
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** The project's contract file's bytes as the hook reads them (readRegularFile, within the hook's size bound), or null. */
function contractBytes(projectRoot: string): Buffer | null {
  return readRegularFile(join(projectRoot, CONTRACT_REL_PATH), CONTRACT_MAX_BYTES);
}

/** The project's write contract as the hook reads it (a regular JSON file within the hook's size bound), or null. */
function readContract(projectRoot: string): any | null {
  try {
    const bytes = contractBytes(projectRoot);
    return bytes ? JSON.parse(bytes.toString("utf8")) : null;
  } catch {
    return null; /* not JSON: no contract */
  }
}

/**
 * The contract while it binds (active, and its run live by its own log: runLog.ts), with the run it binds, or null.
 * An ended run's contract binds nothing, exactly as one switched off, as the hook decides.
 */
function bindingContract(projectRoot: string): { contract: any; runId: string | null } | null {
  const contract = readContract(projectRoot);
  try {
    if (contract?.active !== true || runEnded(projectRoot, contract.run_id)) return null;
  } catch {
    return null;
  }
  return { contract, runId: typeof contract.run_id === "string" && contract.run_id ? contract.run_id : null };
}

/**
 * Why `rel` may not be read into a model's prompt, or null: the one read rule for everything sent to a model (the
 * planner's plan-lint and findings-to-packets hold a plan to the same rule; this is the last line, the only one a
 * hand-written packet passes). A file on the hardcoded off-limits list (at any depth, as the writer matches it) or on
 * the binding contract's off_limits is never sent. The live run's own folder (.sdlc/runs/<run_id>/, where its briefs
 * live) is exempt from the contract's list. Case is ignored, as the disk ignores it.
 */
export function readOffLimits(rel: string, binding: { contract: any; runId: string | null } | null): string | null {
  for (const p of HARDCODED_OFF_LIMITS) if (matchesAtAnyDepth(rel, p, true)) return `off-limits (hardcoded): ${p}`;
  if (!binding) return null;
  if (binding.runId && rel.toLowerCase().startsWith(`.sdlc/runs/${binding.runId.toLowerCase()}/`)) return null;
  const off = firstMatch(rel, binding.contract?.off_limits, true);
  return off ? `off-limits (contract): ${off}` : null;
}

// ---------------------------------------------------------------------------
// Input hydration
// ---------------------------------------------------------------------------

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
 * Fill in `content` for every slice that arrived without it. Reads relative to `projectRoot`, and only a file the read
 * rule lets a model see: a path that escapes the project, as written or through a symbolic link (the real path is judged
 * too, as greenfield's insideCodeDir judges what reaches a vendor's brief), a path that is not a file, an off-limits
 * file (readOffLimits), a missing file or a slice over MAX_SLICE_BYTES throws — those are planner bugs the
 * orchestrator should see, not silently empty inputs, and an off-limits file is the person's decision.
 */
export function hydrateInputs(packet: TaskPacket, projectRoot: string): { packet: TaskPacket; hydrated: string[] } {
  const hydrated: string[] = [];
  let realRoot: string | null = null;
  let binding: { contract: any; runId: string | null } | null | undefined;
  const inputs: FileSlice[] = packet.inputs.map((s) => {
    if (typeof s.content === "string") return s;
    const abs = resolve(projectRoot, s.path);
    const rel = toPosix(relative(projectRoot, abs));
    if (escapes(rel)) {
      throw new Error(`execute_with_model: input slice "${s.path}" resolves outside project_root.`);
    }
    if (!existsSync(abs)) {
      throw new Error(`execute_with_model: input slice "${s.path}" does not exist under project_root (${projectRoot}).`);
    }
    realRoot ??= realpathSync(projectRoot);
    const real = realpathSync(abs);
    const realRel = toPosix(relative(realRoot, real));
    if (escapes(realRel)) {
      throw new Error(`execute_with_model: input slice "${s.path}" resolves outside project_root through a symbolic link.`);
    }
    if (!statSync(real).isFile()) throw new Error(`execute_with_model: input slice "${s.path}" is not a file.`);
    if (binding === undefined) binding = bindingContract(projectRoot);
    for (const r of new Set([rel, realRel])) {
      const why = readOffLimits(r, binding);
      if (why) {
        throw new Error(
          `execute_with_model: input slice "${s.path}" is never sent to a model (${why}${r !== rel ? `, reached through a symbolic link as ${r}` : ""}). ` +
            "Whether a model may read it is the person's decision: stop and tell the person which file the work needs and why.",
        );
      }
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
 * brownfield run sends them.
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
  return bindingContract(projectRoot) !== null;
}

/**
 * Why the project's contract can no longer be trusted, or null — the hook's rule (plugin/scripts/lib/contract-lock.mjs
 * contractTampered), mirrored as checkWriteContract mirrors the rest: a run that froze a contract is live (runLog.ts
 * liveFreeze, read from the run logs, never from the contract), and the contract file is missing or its bytes no
 * longer match the SHA-256 write-contract.mjs recorded in that run's log. No freeze record: enforced as before. The
 * reason says what was refused and why, and leaves what happens next to the person.
 */
export function contractTampered(projectRoot: string): string | null {
  const live = liveFreeze(projectRoot);
  return live ? tamperReason(live, contractBytes(projectRoot)) : null;
}

/** A live freeze record as runLog.ts liveFreeze gives it: `forged` names why the records were not written by write-contract.mjs. */
export type FreezeRecord = { run_id: string; sha256: string | null; forged?: string };

/**
 * contractTampered's verdict for a live freeze record and the contract's bytes (null: gone, or not a regular file), in
 * the hook's words (lib/contract-lock.mjs contractTampered): records write-contract.mjs never writes (`forged`) refuse
 * every write; otherwise the contract must hash to the record. The refusal says what was refused and why, and that
 * the person decides what happens next; it names no way past it.
 */
export function tamperReason(live: FreezeRecord | null, bytes: Buffer | null): string | null {
  if (!live) return null;
  if (live.forged) {
    return `the write contract's freeze record cannot be trusted: ${live.forged}, so one was not written by write-contract.mjs. Every write is refused while that record is live. Stop and tell the person.`;
  }
  if (bytes !== null && createHash("sha256").update(bytes).digest("hex") === live.sha256) return null;
  return (
    `the write contract changed after it was frozen for run ${live.run_id} (${bytes === null ? "the file is gone, or is not a readable file" : "its bytes no longer match the freeze record in the run's log"}): ` +
    "every write is refused while that run is live. A contract is written only by write-contract.mjs, at Gate 0. Stop and tell the person what changed it."
  );
}

/** At most this many links are followed for one path (the hook's bound); more is a loop, which no write gets through. */
const MAX_LINK_HOPS = 64;

/**
 * A path with every link in it resolved, the last name included, also where a link's target does not exist yet: the
 * hook's realPath (write-contract-check.mjs), name by name. Why: a write follows a link to a file that does not exist
 * yet and creates that file (writeFileSync opens the link's target), so a dangling link that names a file outside the
 * project, or an off-limits one, would carry the write there if only the deepest folder that exists were resolved.
 * Each name is read with lstat and, when it is a link, replaced by what the link holds (readlink, relative to its
 * folder), whether or not that exists; a name that does not exist is kept as written; a loop of links is judged as given.
 */
function realPath(p: string): string {
  const given = resolve(p);
  const root = parse(given).root;
  const names = (t: string) => t.split(sep === "\\" ? /[\\/]/ : "/").filter(Boolean);
  let cur = root;
  let pending = names(given.slice(root.length));
  for (let hops = 0; pending.length > 0;) {
    const name = pending.shift()!;
    if (name === ".") continue;
    if (name === "..") { cur = dirname(cur); continue; }
    const next = join(cur, name);
    let link: string | null = null;
    try { if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next); } catch { /* not there (yet): a plain name */ }
    if (link === null) { cur = next; continue; }
    if (++hops > MAX_LINK_HOPS) return given;
    if (isAbsolute(link)) cur = parse(link).root;
    pending = [...names(isAbsolute(link) ? link.slice(cur.length) : link), ...pending];
  }
  return cur;
}

/**
 * Decide whether the server may write `target` under `projectRoot`, in the order the PreToolUse hook that gates the
 * orchestrator's own Write/Edit decides (plugin/scripts/write-contract-check.mjs). First a path that leaves the
 * project is refused; then a live freeze record that cannot be trusted, or a live run's contract that no longer
 * matches it (contractTampered), refuses every write; then a path whose real place, with every link resolved, is
 * outside the project. The path is then judged as written and where it lands (the hook's judgedPaths), and refused
 * when either is: a link inside the allowlist cannot carry a write to an off-limits folder. While the contract binds,
 * its own file and its run's log are not the run's to write; under `strict: false` that holds whenever a freeze record
 * is live, and only a contract frozen before freeze records existed lets them through. The active contract's own run
 * folder (named by its run_id, never by the caller) is the plugin's to write. The hardcoded off-limits apply at any
 * depth whether or not a contract binds; a binding contract adds its off_limits and allowlist, which a contract with
 * `strict: false` reports instead of refusing. No contract, or one that binds nothing, means the hardcoded list alone.
 * Off-limits patterns match in either case (matchGlob), as the disk does; the allowlist keeps its case.
 */
export function checkWriteContract(projectRoot: string, target: string): ContractDecision {
  const abs = resolve(projectRoot, target);
  const rel = toPosix(relative(projectRoot, abs));
  if (escapes(rel)) {
    return { allowed: false, reason: `path escapes project_root: ${target}`, rel };
  }
  // A live run's freeze record that cannot be trusted, or a contract that no longer matches it, refuses every write,
  // as the hook does.
  const live = liveFreeze(projectRoot);
  const tampered = live ? tamperReason(live, contractBytes(projectRoot)) : null;
  if (tampered) return { allowed: false, reason: tampered, rel };
  // Where the write lands with every link resolved (the hook's judgedPaths): outside the project, it is refused.
  const realRel = toPosix(relative(realPath(projectRoot), realPath(abs)));
  if (escapes(realRel)) return { allowed: false, reason: `path leads outside project_root through a link: ${target}`, rel };
  const contract = readContract(projectRoot);
  const active = contract?.active === true;
  // As the hook decides (plugin/scripts/write-contract-check.mjs): a contract binds its run only while the run is live
  // by its own log (runLog.ts); an ended run's contract binds nothing, exactly as one switched off.
  const binds = active && !runEnded(projectRoot, contract.run_id);
  const runId = binds && typeof contract.run_id === "string" && contract.run_id ? contract.run_id : null;
  const judge = (r: string): ContractDecision => {
    // While it binds, the contract file and the run's own log are not the run's to write, whatever the allowlist says:
    // the run must not widen or switch off its own contract, or log its own end. Under strict = false only a contract
    // with no live freeze record lets them through: a frozen contract changed mid-run refuses every write after it.
    if (binds) {
      const low = r.toLowerCase();
      const runLog = runId ? `.sdlc/runs/${runId.toLowerCase()}/orchestrator.log` : null;
      if (low === CONTRACT_REL_PATH || (runLog && (low === runLog || low.startsWith(`${runLog}.`)))) {
        if (contract.strict === false && !live) return { allowed: true, reason: "the run's own contract or log, allowed because strict false", rel };
        return { allowed: false, reason: "the run's own write contract or log, which a live run may not change", rel };
      }
    }
    // The run's own record (a report, a receipt) is the plugin's to write, whatever the contract says about .sdlc/**.
    if (runId && r.startsWith(`.sdlc/runs/${runId}/`)) return { allowed: true, reason: "run artifact", rel };
    for (const p of HARDCODED_OFF_LIMITS) {
      if (matchesAtAnyDepth(r, p, true)) return { allowed: false, reason: `off-limits (hardcoded): ${p}`, rel };
    }
    if (!binds) return { allowed: true, reason: active ? "the contract's run has ended" : "no active contract", rel };
    const off = firstMatch(r, contract.off_limits, true);
    if (off) {
      if (contract.strict === false) return { allowed: true, reason: `off-limits (contract): ${off}, allowed because strict false`, rel };
      return { allowed: false, reason: `off-limits (contract): ${off}`, rel };
    }
    const hit = firstMatch(r, contract.allowlist);
    if (hit) return { allowed: true, reason: `allowlist: ${hit}`, rel };
    if (contract.strict === false) return { allowed: true, reason: "not in the run's allowlist, allowed because strict false", rel };
    return { allowed: false, reason: `not in the run's allowlist (strict contract)`, rel };
  };
  const asWritten = judge(rel);
  if (!asWritten.allowed || realRel === rel) return asWritten;
  const landed = judge(realRel);
  return landed.allowed ? asWritten : { ...landed, reason: `${landed.reason} (where ${rel} leads through a link: ${realRel})` };
}

// ---------------------------------------------------------------------------
// The person's Bash deny rules — same rules as plugin/scripts/ambient/lib/bash-rules.mjs
// ---------------------------------------------------------------------------
// Why: the server runs a packet's check, write-form and reproducing commands itself, where Claude Code's own
// permission check for its Bash tool never sees them, so a command the person or their organisation has forbidden
// would run anyway, with or without zero-touch installed. The rules are read as the hook reads them; the server cannot
// import an .mjs from the plugin tree at runtime, and applyJudge.test.mjs asserts the two decide alike.

/** The organisation's managed settings file (the same places zero-touch reads). */
function managedSettingsFile(env: NodeJS.ProcessEnv): string {
  if (env.MMO_MANAGED_SETTINGS && env.MMO_MANAGED_SETTINGS.trim()) return env.MMO_MANAGED_SETTINGS;
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/** Every Bash deny rule in the settings Claude Code reads for this project: the text inside "Bash(…)", or "" for all. */
function bashDenyRules(projectDir: string, env: NodeJS.ProcessEnv): string[] {
  const config = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : join(env.HOME && env.HOME.trim() ? env.HOME : homedir(), ".claude");
  const files = [managedSettingsFile(env), join(config, "settings.json"), join(projectDir, ".claude", "settings.json"), join(projectDir, ".claude", "settings.local.json")];
  const rules: string[] = [];
  for (const f of files) {
    let deny: unknown;
    try { deny = JSON.parse(readFileSync(f, "utf8"))?.permissions?.deny; } catch { continue; }
    if (!Array.isArray(deny)) continue;
    for (const r of deny) {
      if (typeof r !== "string") continue;
      const t = r.trim();
      if (t === "Bash") rules.push("");
      const m = /^Bash\((.*)\)$/s.exec(t);
      if (m) rules.push(m[1].trim());
    }
  }
  return rules;
}

/**
 * Whether one simple command matches one rule's text: all of Bash, a prefix (`:*`), `*` wildcards, or exactly. Both
 * are read with every run of blanks as one space, as zero-touch's hook reads them (bash-rules.mjs), so a rule written
 * with two spaces, or a command written with a tab, decides the same way in both places.
 */
function denyMatches(command: string, ruleText: string): boolean {
  const oneSpace = (t: string) => t.replace(/[ \t]+/g, " ").trim();
  command = oneSpace(command);
  const rule = oneSpace(ruleText);
  if (rule === "" || rule === "*") return true;
  if (rule.endsWith(":*")) {
    const prefix = rule.slice(0, -2).trim();
    return command === prefix || command.startsWith(`${prefix} `);
  }
  if (rule.includes("*")) {
    const re = new RegExp(`^${rule.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
    return re.test(command);
  }
  return command === rule;
}

/**
 * A command line as the shell reads it, cut into the simple commands it runs, each as its words with the quotes and
 * escapes the shell removes removed: `'rm'`, `r''m` and `r\m` all read `rm`. A command ends at `&&`, `||`, `;`, `|`,
 * a lone `&`, a new line, and either bracket of a subshell (`(`, `)`), so a command after a lone `&` or inside
 * `( … )` is checked like any other. A redirect's target is no word of the command. Words the shell reads as no command
 * at the start of one (`!`, `{`, `}`, `if`, `then`, `else`, `elif`, `fi`, `do`, `done`, `while`, `until`, `time`) and
 * leading `NAME=value` assignments are dropped, as Claude Code checks the command they run. Returns `{ hidden }`
 * instead when the line runs a command no reading of its text can name before it runs: a substitution (`$(…)`,
 * backquotes, `<(…)`, `>(…)`), any `$` expansion outside single quotes (a variable can hold a command), a brace
 * expansion, or a quote left open.
 */
export function shellCommands(command: string): { commands: string[] } | { hidden: string } {
  const commands: string[] = [];
  let words: { text: string; assignment: boolean }[] = [];
  // `head`: the word's start up to its first quoted or escaped character, which decides whether it is an assignment.
  let word = "", head = "", inWord = false, plain = true, braces = false, redirect = false;
  const endWord = (): string | null => {
    if (!inWord) return null;
    // An unquoted brace inside a word ({a,b}, {1..3}) is a brace expansion: the shell builds words no text shows.
    if (braces && word !== "{" && word !== "}") return "{…} expansion";
    if (redirect) redirect = false;
    else words.push({ text: word, assignment: /^[A-Za-z_][A-Za-z0-9_]*=/.test(head) });
    word = ""; head = ""; inWord = false; plain = true; braces = false;
    return null;
  };
  const endCommand = (): string | null => {
    const hidden = endWord();
    if (hidden) return hidden;
    let i = 0;
    while (i < words.length && (words[i].assignment || NOT_A_COMMAND.has(words[i].text))) i++;
    const rest = words.slice(i).map((w) => w.text);
    if (rest.length) commands.push(rest.join(" "));
    words = [];
    return null;
  };
  const add = (c: string, quoted: boolean) => { word += c; inWord = true; if (quoted) plain = false; else if (plain) head += c; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (c === "\\") {
      // An escaped character is itself; a backslash before a line end joins the two lines.
      if (next === undefined) { add("\\", true); continue; }
      i++;
      if (next !== "\n") add(next, true);
      continue;
    }
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return { hidden: "a quote left open" };
      word += command.slice(i + 1, close); inWord = true; plain = false;
      i = close;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j];
        if (d === "`") return { hidden: "`…`" };
        if (d === "$" && j + 1 < command.length && !/\s|"/.test(command[j + 1])) return { hidden: command[j + 1] === "(" ? "$(…)" : "a $ expansion" };
        if (d === "\\" && j + 1 < command.length && '$`"\\\n'.includes(command[j + 1])) { j++; if (command[j] !== "\n") add(command[j], true); continue; }
        add(d, true);
      }
      if (j >= command.length) return { hidden: "a quote left open" };
      inWord = true; plain = false;
      i = j;
      continue;
    }
    if (c === "`") return { hidden: "`…`" };
    if (c === "$") {
      if (next === undefined || /\s/.test(next)) { add("$", false); continue; }
      return { hidden: next === "(" ? "$(…)" : "a $ expansion" };
    }
    if (c === "<" || c === ">") {
      if (next === "(") return { hidden: `${c}(…)` };
      // A file descriptor's number before the operator (2>, 1<) belongs to the redirect, not to the command.
      if (inWord && plain && /^\d+$/.test(word)) { word = ""; head = ""; inWord = false; }
      else { const h = endWord(); if (h) return { hidden: h }; }
      while (command[i + 1] === "<" || command[i + 1] === ">" || command[i + 1] === "|" || command[i + 1] === "&") i++;
      redirect = true;
      continue;
    }
    if (c === "&" && next === ">") {
      const h = endWord(); if (h) return { hidden: h };
      i++;
      if (command[i + 1] === ">") i++;
      redirect = true;
      continue;
    }
    if (c === "&" || c === "|" || c === ";" || c === "\n" || c === "(" || c === ")") {
      const h = endCommand(); if (h) return { hidden: h };
      if ((c === "&" && next === "&") || (c === "|" && (next === "|" || next === "&")) || (c === ";" && next === ";")) i++;
      continue;
    }
    if (c === " " || c === "\t") { const h = endWord(); if (h) return { hidden: h }; continue; }
    // A comment runs to the end of its line.
    if (c === "#" && !inWord) { const nl = command.indexOf("\n", i); i = nl < 0 ? command.length : nl - 1; continue; }
    if (c === "{" || c === "}") braces = true;
    add(c, false);
  }
  const h = endCommand();
  if (h) return { hidden: h };
  // A command string another shell runs (sh -c '…', bash -lc "…") or eval runs is text no reading of this line names
  // before it runs, as a substitution is: hidden. The shells are the POSIX ones a check could start.
  for (const c of commands) {
    const w = c.split(" ");
    const name = w[0].slice(w[0].lastIndexOf("/") + 1);
    if (name === "eval") return { hidden: "eval" };
    if (STRING_SHELLS.has(name) && w.slice(1).some((x) => /^-[A-Za-z]*c[A-Za-z]*$/.test(x))) return { hidden: `${name} -c` };
  }
  return { commands };
}

/** Shells that run a command string given with -c (shellCommands reads such a string as hidden). */
const STRING_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);

/** Words the shell reads at the start of a command as no command of their own (shellCommands drops them there). */
const NOT_A_COMMAND = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "time"]);

/**
 * The deny rule a command breaks, as written in the settings ("Bash(rm:*)"), or null. Every simple command the shell
 * would run is checked (shellCommands), each without its leading VAR=value assignments, as Claude Code checks one. A
 * command shellCommands cannot read is not a match here: commandUnchecked says so, and the caller refuses it while any
 * rule exists.
 */
export function commandDeniedBy(command: string, projectDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return deniedByRules(command, bashDenyRules(projectDir, env));
}

/**
 * What hides a command in this line from the deny check (a substitution, an expansion, a quote left open), or null when
 * every command it runs can be read (shellCommands). Zero-touch's hook leaves such a call to Claude Code's prompt; the
 * server has no prompt, so it does not run such a command while any rule forbids a command.
 */
export function commandUnchecked(command: string): string | null {
  const read = shellCommands(command);
  return "hidden" in read ? read.hidden : null;
}

/** commandDeniedBy with the rules already read, so a packet's commands are checked against one reading of the settings. */
function deniedByRules(command: string, rules: string[]): string | null {
  if (!rules.length || typeof command !== "string") return null;
  const read = shellCommands(command);
  if ("hidden" in read) return null;
  for (const rule of rules) for (const part of read.commands) if (denyMatches(part, rule)) return rule === "" ? "Bash" : `Bash(${rule})`;
  return null;
}

/**
 * A file path the shell reads as a name wherever a command pastes it: plain path characters only, and not starting
 * with "-" (which a command reads as an option). The same set as zero-touch's hook (lib/own-steps.mjs PLAIN_PATH).
 */
const PLAIN_PATH = /^(?!-)[\p{L}\p{N}._\/@+,=:%-]+$/u;

/**
 * Whether every `{path}` in a command template stands inside single quotes ('{path}', as plan-to-packets writes every
 * one: scripts/lib/change-spec.mjs quotePath), where fill pastes any path exactly: the shell reads nothing inside them
 * but the closing quote, which fill writes as '\''. Inside double quotes, ANSI-C quotes ($'…') or none, a path's `$`,
 * backquotes, spaces or quotes are read as shell syntax.
 */
function pathOnlyInSingleQuotes(template: string): boolean {
  let state: "none" | "single" | "double" | "ansi" = "none";
  for (let i = 0; i < template.length; i++) {
    if (template.startsWith("{path}", i)) {
      if (state !== "single") return false;
      i += "{path}".length - 1;
      continue;
    }
    const c = template[i];
    if (state === "single") { if (c === "'") state = "none"; continue; }
    if (state === "ansi") { if (c === "\\") i++; else if (c === "'") state = "none"; continue; }
    if (state === "double") { if (c === "\\") i++; else if (c === '"') state = "none"; continue; }
    if (c === "\\") { i++; continue; }
    if (c === "$" && template[i + 1] === "'") { state = "ansi"; i++; continue; }
    if (c === "'") state = "single";
    else if (c === '"') state = "double";
  }
  return true;
}

/**
 * Why `path` may not be pasted into these command templates, or null. A path that starts with "-" is read as an option
 * however it is quoted; any other path is pasted exactly inside single quotes, and outside them only a plain path is
 * (PLAIN_PATH): `$(…)`, backquotes, `;` or spaces in a path would run, or change, commands no check of the template
 * sees. Zero-touch's hook keeps such a call at Claude Code's prompt (lib/own-steps.mjs serverCommandUnchecked); this is
 * the server's own line, which holds with or without zero-touch.
 */
function pathPasteProblem(path: string, templates: string[]): string | null {
  const pasted = templates.filter((t) => t.includes("{path}"));
  if (!pasted.length) return null;
  if (path.startsWith("-")) return `${path} is pasted into a shell command, and a path that starts with "-" is read as an option`;
  if (PLAIN_PATH.test(path)) return null;
  // Only the whole single-quoted word '{path}' keeps a path that is not plain a name: inside a longer quoted string
  // (sh -c '… {path}', 'x{path}') the path is pasted into text another shell may read again.
  const wholeWords = (t: string) => t.split("{path}").slice(0, -1).every((before, i, parts) => before.endsWith("'") && t.split("{path}")[i + 1].startsWith("'"));
  const outside = pasted.find((t) => !pathOnlyInSingleQuotes(t) || !wholeWords(t));
  return outside ? `${path} is pasted into a shell command as written (${outside}), and this path holds characters a shell reads as syntax` : null;
}

// ---------------------------------------------------------------------------
// Provenance-wrapped write
// ---------------------------------------------------------------------------

/** plugin/scripts/write-provenance.mjs, resolved from this file (dist/apply.js at runtime). */
export function provenanceScriptPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "write-provenance.mjs");
}

/**
 * One write-provenance.mjs call. Synchronous on purpose: the script reads, changes and writes the run's one
 * provenance.json, so two packets of a batch must never run it at once; it is a short local script, never a check.
 */
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

export async function applyContent(
  projectRoot: string,
  rel: string,
  content: string,
  opts: { runId?: string; packetId: string; format?: string[]; timeoutSec?: number },
): Promise<WriteReceipt> {
  const abs = resolve(projectRoot, rel);
  const existed = existsSync(abs);
  if (opts.runId) runProvenance("before", projectRoot, opts.runId, rel, opts.packetId);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  // Format before provenance "after", so the recorded hash is the file as it stays on disk.
  if (opts.format?.length) {
    await runFormat(opts.format, projectRoot, rel, opts.timeoutSec);
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
// Running a packet's commands
// ---------------------------------------------------------------------------

/** What one command did: its exit code or the signal that ended it, whether its time limit stopped it, and the end of its output. */
export interface ShellResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  output: string;
  ms: number;
  /** The command could not be started at all (the folder is gone, no shell). */
  error?: string;
}

/**
 * Runs one command line with /bin/sh, as greenfield's acceptance runner does (executor/acceptance.ts runCommand):
 * asynchronously, so a batch's checks run side by side and the server keeps answering while they run (its progress
 * heartbeat, the person's Stop); in its own process group, killed whole at the time limit, so nothing the command
 * started outlives it; and without the vendor credentials the server holds (acceptance.ts commandEnv), because a
 * check runs the project's own code and its failing output goes into the next attempt's prompt. Once the command
 * ends, whatever it left running in its group is stopped too. Its output (stdout and stderr, in the order written) is
 * kept as a tail while it streams.
 */
export function runShell(cmd: string, cwd: string, timeoutSec: number): Promise<ShellResult> {
  return new Promise((done) => {
    const t0 = Date.now();
    let kept = Buffer.alloc(0);
    const keep = (b: Buffer) => {
      kept = Buffer.concat([kept, b]);
      if (kept.length > OUTPUT_KEEP_BYTES) kept = kept.subarray(kept.length - OUTPUT_KEEP_BYTES);
    };
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", cmd], { cwd, env: commandEnv(process.env), stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e: any) {
      done({ code: null, signal: null, timedOut: false, output: "", ms: Date.now() - t0, error: e?.message ?? String(e) });
      return;
    }
    let code: number | null = null;
    let signal: string | null = null;
    let exited = false, timedOut = false, finished = false;
    let error: string | undefined;
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* the group is gone */ } };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({ code, signal, timedOut, output: kept.toString("utf8"), ms: Date.now() - t0, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => {
      if (!exited) timedOut = true;
      killGroup();
      // Whatever still holds the output open (something that left the group) no longer delays the verdict.
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish();
    }, Math.min(Math.max(1, timeoutSec) * 1000, MAX_TIMER_MS));
    child.stdout!.on("data", keep);
    child.stderr!.on("data", keep);
    child.on("error", (e) => { error = e.message; finish(); });
    child.on("exit", (c, s) => { exited = true; code = c; signal = s; killGroup(); });
    child.on("close", finish);
  });
}

/**
 * A command template with the file filled in. Every `{path}` of a plan's check stands inside single quotes
 * (plan-to-packets quotePath; any other placement of a path that is not plain is refused before anything runs:
 * pathPasteProblem), so each quote in the path is written '\'' (close, an escaped quote, reopen) and the shell reads the
 * path exactly; a path with no quote is pasted as it is. The same filling as scripts/lib/change-spec.mjs fillPath.
 */
const fill = (template: string, artifactPath: string) => template.split("{path}").join(artifactPath.replace(/'/g, "'\\''"));

export interface VerifyResult {
  ok: boolean;
  ran: number;
  failed_command?: string;
  /** The failing command's exit code; null when it did not exit by itself (its time limit, a signal) or never started. */
  exit_code?: number | null;
  /** The signal that ended the failing command, when one did and its time limit did not. */
  signal?: string;
  /** The failing command was stopped at its time limit. */
  timed_out?: boolean;
  output_tail?: string;
  duration_ms: number;
}

/** How a failed check ended, as the retry instruction and the receipt state it: its exit code, its signal, or its limit. */
export function exitText(v: Pick<VerifyResult, "exit_code" | "signal" | "timed_out">): string {
  if (v.timed_out) return "timed out";
  if (v.signal) return `signal ${v.signal}`;
  return v.exit_code === null || v.exit_code === undefined ? "could not start" : `exit ${v.exit_code}`;
}

/**
 * A failed run as a VerifyResult: its cause, and the end of its output, prefixed by what the output cannot say (its
 * time limit, a start that failed), or by the caller's own `note` when it states that already.
 */
function failed(r: ShellResult, cmd: string, ran: number, started: number, timeoutSec: number, note = ""): VerifyResult {
  const prefix = note || (r.timedOut ? `[timed out after ${timeoutSec}s]\n` : "") + (r.error ? `[the command could not start: ${r.error}]\n` : "");
  return {
    ok: false,
    ran,
    failed_command: cmd,
    exit_code: r.timedOut ? null : r.code,
    ...(r.signal && !r.timedOut ? { signal: r.signal } : {}),
    ...(r.timedOut ? { timed_out: true } : {}),
    output_tail: prefix + r.output.trim().slice(-VERIFY_OUTPUT_TAIL_CHARS),
    duration_ms: Date.now() - started,
  };
}

/** Formatter commands on the written file; failures are left for verify to report. */
export async function runFormat(commands: string[], projectRoot: string, artifactPath: string, timeoutSec = DEFAULT_VERIFY_TIMEOUT_SEC): Promise<void> {
  for (const template of commands) await runShell(fill(template, artifactPath), projectRoot, timeoutSec);
}

/** The checks that must pass, in order: the first one that does not exit 0 is the verdict. */
export async function runVerify(
  commands: string[] | undefined,
  projectRoot: string,
  artifactPath: string,
  timeoutSec = DEFAULT_VERIFY_TIMEOUT_SEC,
): Promise<VerifyResult> {
  const started = Date.now();
  if (!commands || commands.length === 0) return { ok: true, ran: 0, duration_ms: 0 };
  let ran = 0;
  for (const template of commands) {
    const cmd = fill(template, artifactPath);
    ran++;
    const r = await runShell(cmd, projectRoot, timeoutSec);
    if (r.code !== 0 || r.timedOut) return failed(r, cmd, ran, started, timeoutSec);
  }
  return { ok: true, ran, duration_ms: Date.now() - started };
}

/** Exit codes a POSIX shell gives when it could not run the command at all: found but not executable, not found. */
const SHELL_COULD_NOT_RUN = new Set([126, 127]);

/**
 * A reproducing check's own verdict on one run, read from its exit code only: "fails" (exited with a code other than
 * 0, 126 or 127), "passes" (exit 0), or no verdict ("none": the shell could not run it, its time limit stopped it, a
 * signal ended it). The exit code cannot tell a failing assertion from a test file that does not load, which is why a
 * unit with reproducing checks also carries a check that must pass on the same file (a syntax, type or load check:
 * plan-lint requires one), and why an edit of a test file that already fails is refused (runApplyLoop).
 */
function redVerdict(r: ShellResult): "fails" | "passes" | "none" {
  if (r.timedOut || r.code === null || SHELL_COULD_NOT_RUN.has(r.code)) return "none";
  return r.code === 0 ? "passes" : "fails";
}

/**
 * A bugfix's reproducing checks (checks typed `expect: "fail"`), on the test file typed before the fix: each must
 * fail on the bug, by its own exit code (redVerdict). Exit 0 is the failure here — a test that passes before the fix
 * does not reproduce the bug. A command the shell could not run (126, 127), one stopped at its time limit, or one
 * ended by a signal gives no verdict, so it is a failure too, with that reason. The same command must pass once the
 * fix is in: plan-to-packets puts it among the end-of-run checks.
 */
export async function runRed(
  commands: string[] | undefined,
  projectRoot: string,
  artifactPath: string,
  timeoutSec = DEFAULT_VERIFY_TIMEOUT_SEC,
): Promise<VerifyResult> {
  const started = Date.now();
  if (!commands || commands.length === 0) return { ok: true, ran: 0, duration_ms: 0 };
  let ran = 0;
  for (const template of commands) {
    const cmd = fill(template, artifactPath);
    ran++;
    const r = await runShell(cmd, projectRoot, timeoutSec);
    const verdict = redVerdict(r);
    if (verdict === "fails") continue;
    const why = r.timedOut
      ? `it did not finish within ${timeoutSec}s`
      : verdict === "passes"
        ? "it passed, so it does not reproduce the bug: make it fail on the behaviour the brief describes"
        : `it could not run (${r.code !== null ? `exit ${r.code}` : r.signal ? `signal ${r.signal}` : "it did not start"})`;
    return failed(r, cmd, ran, started, timeoutSec, `[a reproducing check must fail before the fix: ${why}]\n`);
  }
  return { ok: true, ran, duration_ms: Date.now() - started };
}

/**
 * Whether any reproducing check already fails, by its own verdict, on the test file as it is before an edit. Such a
 * file's failure cannot show that the new case reproduces the bug (an old failing case gives the same exit code), so
 * the packet is refused before any typist is paid (runApplyLoop). A new file has nothing to try.
 */
async function redFailsBefore(commands: string[], projectRoot: string, artifactPath: string, timeoutSec: number): Promise<boolean> {
  for (const template of commands) {
    if (redVerdict(await runShell(fill(template, artifactPath), projectRoot, timeoutSec)) === "fails") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Retry packet
// ---------------------------------------------------------------------------

/**
 * The packet for the next attempt: the failure appended to the instruction, asking for what the packet's mode takes.
 * In edits mode every attempt is spliced into the file as it was before the packet, so the retry is asked for a
 * corrected edit list; asking it for "the complete corrected file" there gets a reply the edits contract cannot take.
 * Stateless by design (orchestrator rule 7) — the model sees the failure, not a conversation. The packet keeps its
 * planned id, so every attempt at one file is one task in telemetry with attempt numbers 1, 2, 3, as greenfield
 * records a job (executor/run.ts); `retry_count` is the ladder's slot and `retry_reason` says why this attempt follows
 * the last.
 */
export function refinePacket(packet: TaskPacket, failure: string, mode: "content" | "edits" = "content", reason: RetryReason = "verify"): TaskPacket {
  const retry = (packet.retry_count ?? 0) + 1;
  const ask = mode === "edits"
    ? "Fix the cause below and return JSON {path, edits: [{search, replace}]} against the file's current text as given (your earlier edits were not kept; each search must appear exactly once), or {path, content} with the whole file."
    : "Fix the cause below and return the complete corrected file.";
  return {
    ...packet,
    retry_count: retry,
    retry_reason: reason,
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

/**
 * A typed check as a packet carries it: a command with `{path}`, an optional id, its own write form, and `expect:
 * "fail"` for a reproducing check (a bugfix's test, which must fail before the fix).
 */
type TypedCheck = { id?: string; run: string; fix?: string; expect?: "fail" };
function typedChecks(raw: unknown): TypedCheck[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as any).run === "string" && (c as any).run.trim() !== "")
    .map((c) => ({
      ...(typeof c.id === "string" ? { id: c.id } : {}),
      run: c.run as string,
      ...(typeof c.fix === "string" && c.fix.trim() ? { fix: c.fix } : {}),
      ...(c.expect === "fail" ? { expect: "fail" as const } : {}),
    }));
  return out.length ? out : undefined;
}

export function normalizeApply(spec: unknown): ApplySpec | null {
  if (!spec || typeof spec !== "object") return null;
  const s = spec as Record<string, unknown>;
  if (s.write !== true) return null;
  // Typed checks carry their own write forms; otherwise verify and format are taken as given. A formatter command is
  // never guessed from a check's text: that was one tool's spelling, and a packet that wants one says so. A
  // reproducing check (`expect: "fail"`) is kept apart in `red`: it is not a check the answer must pass, so it is
  // neither in `verify` nor in `checks`, which the baseline rule tries on the file before the change. Its write form
  // never runs: a formatter must not rewrite the test that judges the fix.
  const typed = typedChecks(s.checks);
  const sites: EditSite[] = s.mode === "edits" && Array.isArray(s.sites)
    ? s.sites.filter((x: any): x is EditSite => !!x && typeof x.id === "string" && SITE_KINDS.has(x.at) && Number.isInteger(x.from) && Number.isInteger(x.to) && x.from >= 1 && x.to >= x.from)
        .map((x) => ({ id: x.id, at: x.at, from: x.from, to: x.to }))
    : [];
  const checks = typed?.filter((c) => c.expect !== "fail");
  const red = typed?.filter((c) => c.expect === "fail").map((c) => c.run);
  const verify = checks ? checks.map((c) => c.run) : Array.isArray(s.verify) ? s.verify.filter((v): v is string => typeof v === "string") : undefined;
  const given = Array.isArray(s.format) ? s.format.filter((v): v is string => typeof v === "string") : undefined;
  const format = checks ? checks.flatMap((c) => (c.fix ? [c.fix] : [])) : given;
  return {
    write: true,
    mode: s.mode === "edits" ? "edits" : "content",
    verify,
    ...(format && format.length ? { format } : {}),
    ...(checks ? { checks } : {}),
    ...(red?.length ? { red } : {}),
    ...(typed && typeof s.baseline_from === "string" && s.baseline_from ? { baseline_from: s.baseline_from } : {}),
    // An edit unit's sites (plan-to-packets): the answer is held to them (siteProblem). Only well-formed ones count.
    ...(sites.length ? { sites } : {}),
    // A fix round's packet (findings-to-packets): its file fails a check, which is why the round exists, so no check
    // is set aside for it and every one judges the answer.
    ...(s.baseline === false ? { baseline: false } : {}),
    max_retries: typeof s.max_retries === "number" ? Math.max(0, Math.floor(s.max_retries)) : DEFAULT_MAX_RETRIES,
    verify_timeout_sec:
      typeof s.verify_timeout_sec === "number" ? Math.max(1, s.verify_timeout_sec) : DEFAULT_VERIFY_TIMEOUT_SEC,
  };
}

/**
 * The baseline rule for typed checks: each check's `run` on the file before the change — the file itself for an
 * edit, `baseline_from` (a new file's style file) otherwise. A check that fails there, or cannot run, is set aside
 * for this packet: it would judge the repo's own state, not the answer, and its write form would rewrite lines the
 * change does not touch. Returns the apply spec to use and what was set aside; no baseline file, no change. A fix
 * round's packet (`baseline: false`) never comes here.
 */
export async function baselineChecks(apply: ApplySpec, projectRoot: string, artifactPath: string): Promise<{ apply: ApplySpec; set_aside?: { id?: string; run: string; output?: string }[] }> {
  if (!apply.checks?.length) return { apply };
  const target = apply.mode === "edits" ? artifactPath : apply.baseline_from;
  if (!target) return { apply };
  const abs = resolve(projectRoot, target);
  const rel = toPosix(relative(projectRoot, abs));
  if (escapes(rel) || !existsSync(abs)) return { apply };
  const kept: { id?: string; run: string; fix?: string }[] = [];
  const setAside: { id?: string; run: string; output?: string }[] = [];
  for (const c of apply.checks) {
    const r = await runVerify([c.run], projectRoot, rel, apply.verify_timeout_sec);
    if (r.ok) kept.push(c);
    else setAside.push({ ...(c.id ? { id: c.id } : {}), run: c.run, output: `${exitText(r)}: ${r.output_tail ?? ""}` });
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
 * result takes the file's own ending back (a file with mixed endings comes back with its dominant one). The path the
 * answer names comes back with the text, for greenfield's answer check (runApplyLoop).
 */
export function applySearchReplace(base: string, answer: unknown): { content?: string; path?: string; reason?: string } {
  const a = parseAnswer(answer, "edit");
  if (!a) return { reason: `the answer was not ${contractShape("edit")}` };
  const lf = (s: string) => s.replace(/\r\n/g, "\n");
  const own = (s: string) => (lineEndingOf(base) === "\r\n" ? lf(s).replace(/\n/g, "\r\n") : lf(s));
  if (a.content !== undefined) return { content: own(a.content), path: a.path };
  const r = applyEdits(lf(base), a.edits!.map((e) => ({ search: lf(e.search), replace: lf(e.replace) })));
  return r.content !== undefined ? { content: own(r.content), path: a.path } : { reason: r.reason };
}

/** Where an edit unit changes its file (scripts/lib/change-spec.mjs sites): lines of the file before the change. */
export type EditSite = { id: string; at: "replace" | "delete" | "insert_before" | "insert_after"; from: number; to: number };
const SITE_KINDS = new Set(["replace", "delete", "insert_before", "insert_after"]);

/** A text's lines, each with its own line end (a CRLF counts as LF), so a last line without one differs from one with it. */
function linesWithEnds(text: string): string[] {
  return text.replace(/\r\n/g, "\n").match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Where `needle` first stands in `hay` at or after `from`, ending by `to`, or -1 (Knuth–Morris–Pratt over lines). */
function indexOfLines(hay: string[], needle: string[], from: number, to: number): number {
  if (!needle.length) return from <= to ? from : -1;
  const fail = new Int32Array(needle.length);
  for (let i = 1, k = 0; i < needle.length; i++) {
    while (k > 0 && needle[i] !== needle[k]) k = fail[k - 1];
    if (needle[i] === needle[k]) k++;
    fail[i] = k;
  }
  for (let i = from, k = 0; i < to; i++) {
    while (k > 0 && hay[i] !== needle[k]) k = fail[k - 1];
    if (hay[i] === needle[k]) k++;
    if (k === needle.length) return i - needle.length + 1;
  }
  return -1;
}

/**
 * The most edits a shortest edit script is searched for when naming the lines of a refused answer: a safety bound on
 * the time and memory spent on the message (the search holds about edits² numbers). The verdict never depends on it;
 * past it the answer's changed region is named instead.
 */
const SITE_REPORT_MAX_EDITS = 1000;

/**
 * A shortest edit script from `a` to `b` (Myers, "An O(ND) Difference Algorithm", 1986), or null past `maxEdits`:
 * the indexes of `a` it removes, and the positions in `a` (0 … a.length) before which it adds lines of `b`.
 */
function shortestEdit(a: string[], b: string[], maxEdits: number): { removed: number[]; addedAt: number[] } | null {
  const n = a.length, m = b.length, max = Math.min(n + m, maxEdits), off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x < n || y < m) continue;
      // Walk back through each step's frontier (trace[e] is v before step e, kept from k = -e - 1 to e + 1).
      const removed: number[] = [], addedAt: number[] = [];
      let cx = n, cy = m;
      for (let e = d; e > 0; e--) {
        const t = trace[e], at = (kk: number) => t[kk + e + 1];
        const ck = cx - cy;
        const down = ck === -e || (ck !== e && at(ck - 1) < at(ck + 1));
        const pk = down ? ck + 1 : ck - 1;
        const px = at(pk), py = px - pk;
        while (cx > px && cy > py) { cx--; cy--; }
        if (down) addedAt.push(px); else removed.push(px);
        cx = px; cy = py;
      }
      return { removed, addedAt };
    }
  }
  return null;
}

/** Line numbers as a person reads them: "3, 7-9", the first twenty entries and how many more. */
function lineList(numbers: number[]): string[] {
  const sorted = [...new Set(numbers)].sort((x, y) => x - y);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j;
  }
  return out;
}

/**
 * Why an edit's answer goes beyond its sites, or null (the check behind "at these sites only": a docstring edit that
 * also changes code, or a stray line, is never written). `before` is the file before the change and `after` the answer
 * applied to it; `sites` are line ranges of `before`. A line outside every replace or delete site must stay, unchanged
 * and in order; new lines may stand only at an insert site (just before line `from` for insert_before, just after line
 * `to` for insert_after) or where a replace or delete site's lines stood. The verdict asks whether ANY alignment of the
 * two texts keeps to the sites — the kept lines in order, with new text only where a site allows it — so a block whose
 * lines repeat its neighbours' (a blank line, a closing brace) is never refused for where a diff would put it. The lines
 * named in a refusal come from a shortest edit script (shortestEdit): lines of `before` the answer changes or removes,
 * and the lines after which it adds lines no site allows.
 */
export function siteProblem(before: string, after: string, sites: EditSite[]): string | null {
  // A final line end alone is no change of any line: both texts are compared as ending in one, so appending after the
  // last line of a file that has none, or a whole-file answer that adds it, keeps to its sites.
  const withEnd = (t: string) => (t.length === 0 || /\r?\n$/.test(t) ? t : `${t}\n`);
  const old = linesWithEnds(withEnd(before)), neu = linesWithEnds(withEnd(after));
  const n = old.length;
  // free[i]: line i (1-based) may change or go; open[i]: new lines may stand just before line i (open[n + 1]: at the end).
  const free = new Array<boolean>(n + 2).fill(false), open = new Array<boolean>(n + 2).fill(false);
  for (const s of sites) {
    if (s.at === "replace" || s.at === "delete") {
      for (let i = s.from; i <= Math.min(s.to, n); i++) free[i] = true;
      if (s.to > n) open[n + 1] = true;
    } else open[Math.min(s.at === "insert_before" ? s.from : s.to + 1, n + 1)] = true;
  }
  const gapBefore = (i: number) => open[i] || free[i] || free[i - 1];
  // The lines that must stay, as runs between the places new text may stand.
  const runs: string[][] = [];
  let run: string[] = [];
  for (let i = 1; i <= n + 1; i++) {
    if (gapBefore(i)) { runs.push(run); run = []; }
    if (i <= n && !free[i]) run.push(old[i - 1]);
  }
  runs.push(run);
  // runs = R0 (gap) R1 (gap) … Rk: R0 must open the answer and Rk close it; the ones between stand in order, each
  // wherever it is found first (leftmost first fit finds an alignment whenever one exists).
  let ok: boolean;
  if (runs.length === 1) ok = runs[0].length === neu.length && runs[0].every((l, i) => l === neu[i]);
  else {
    const head = runs[0], tail = runs[runs.length - 1];
    let lo = head.length, hi = neu.length - tail.length;
    ok = lo <= hi && head.every((l, i) => l === neu[i]) && tail.every((l, i) => l === neu[hi + i]);
    for (let r = 1; ok && r < runs.length - 1; r++) {
      const at = indexOfLines(neu, runs[r], lo, hi);
      if (at < 0) ok = false;
      else lo = at + runs[r].length;
    }
  }
  if (ok) return null;
  // Name the lines: those of a shortest edit script that no site allows, a changed line named once.
  let p = 0;
  while (p < n && p < neu.length && old[p] === neu[p]) p++;
  let q = 0;
  while (q < n - p && q < neu.length - p && old[n - 1 - q] === neu[neu.length - 1 - q]) q++;
  const edit = shortestEdit(old.slice(p, n - q), neu.slice(p, neu.length - q), SITE_REPORT_MAX_EDITS);
  let named: string[];
  if (edit) {
    const changed = edit.removed.map((x) => x + p + 1).filter((i) => !free[i]);
    const hit = new Set(changed);
    // A line added at old position k stands between lines k and k + 1.
    const added = edit.addedAt.map((x) => x + p).filter((k) => !gapBefore(k + 1) && !hit.has(k) && !hit.has(k + 1));
    named = [...lineList(changed), ...lineList(added).map((k) => `new lines after ${k}`)];
  } else {
    const kept: number[] = [];
    for (let i = p + 1; i <= n - q; i++) if (!free[i]) kept.push(i);
    named = lineList(kept).map((r) => `within ${r}`);
  }
  const shown = named.length > 20 ? [...named.slice(0, 20), `and ${named.length - 20} more`] : named;
  return `the answer changes lines outside its sites: ${shown.join(", ")}; change only the planned sites`;
}

/**
 * The paths of a bugfix run's reproducing tests: the packets in the run's packets.json that carry a check typed
 * `expect: "fail"`. Lower-cased, as the disk compares names. Empty when the run has none or no packets file.
 */
function reproducingTestPaths(projectRoot: string, runId: string): Set<string> {
  const out = new Set<string>();
  if (!RUN_ID.test(runId)) return out;
  let raw: any;
  try { raw = JSON.parse(readFileSync(join(projectRoot, ".sdlc", "runs", runId, "packets.json"), "utf8")); } catch { return out; }
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.packets) ? raw.packets : [];
  for (const p of list) {
    const checks = p?.apply?.checks;
    if (typeof p?.artifact_path !== "string" || !Array.isArray(checks) || !checks.some((c: any) => c?.expect === "fail")) continue;
    out.add(toPosix(relative(projectRoot, resolve(projectRoot, p.artifact_path))).toLowerCase());
  }
  return out;
}

/** The command templates the server would fill with the packet's own file: its checks, their write forms, its reproducing checks. */
function fileTemplates(apply: ApplySpec): string[] {
  return [...(apply.verify ?? []), ...(apply.format ?? []), ...(apply.red ?? [])];
}

/**
 * Every command the server would run for a packet, with `{path}` filled in as it will be: the file's own commands, and,
 * for a new file with a style file, each check on that style file first (baselineChecks).
 */
function packetCommands(apply: ApplySpec, artifactPath: string): string[] {
  const own = fileTemplates(apply).map((t) => fill(t, artifactPath));
  const style = apply.baseline_from && apply.baseline !== false ? (apply.verify ?? []).map((t) => fill(t, apply.baseline_from!)) : [];
  return [...own, ...style];
}

/** A file as it was before a packet wrote it, so a packet whose write does not stand can put it back. */
interface FileBefore { existed: boolean; bytes: Buffer | null; deepestExisting: string }
function fileBefore(abs: string): FileBefore {
  if (existsSync(abs)) return { existed: true, bytes: readFileSync(abs), deepestExisting: dirname(abs) };
  let d = dirname(abs);
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  return { existed: false, bytes: null, deepestExisting: d };
}
function restoreFile(abs: string, before: FileBefore): void {
  if (before.existed) { writeFileSync(abs, before.bytes!); return; }
  try { unlinkSync(abs); } catch { /* not there */ }
  // The folders made for the file, deepest first, while empty.
  for (let d = dirname(abs); d !== before.deepestExisting && d.startsWith(before.deepestExisting); d = dirname(d)) {
    try { rmdirSync(d); } catch { break; }
  }
}

/** An error's own message, for a reason a person reads. */
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
}

export interface ApplyOutcome {
  status: ApplyStatus;
  decision: RouteDecision;
  apply?: WriteReceipt;
  verify?: VerifyResult;
  /** One entry per attempt. A busy vendor's reply that was waited out is no attempt: it is counted in `transport_waits`. */
  attempts: ApplyAttemptSummary[];
  /** Busy-vendor replies (429, 5xx, a dropped connection) waited out and sent again, as greenfield's receipt counts them. Absent when none. */
  transport_waits?: number;
  tokens: { input: number; input_cached: number; output: number };
  cost_usd: number;
  terminal_reason?: string;
  /** Set on "escalate": the retry_count the policy routed elsewhere, and the failure to carry to that model. */
  escalate?: { retry_count: number; model_id: string; failure: string };
  /** Set on "refused": why the packet was refused before or instead of a write. Not retried — a planner bug, or the person's decision. */
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
   * Called once per call with its telemetry events, as soon as that call's verdict is known and before the next call
   * starts, as greenfield's stage runner emits each of its own (executor/run.ts): a server that dies mid-ladder has
   * written every call it finished. A busy reply that was waited out is tagged `transport` and failed; an attempt says
   * `success` only when its answer was written and passed its checks (its own file, applied, not empty, every check
   * and reproducing check), with the cause as its `error` otherwise; and each attempt's event carries the reason the
   * loop gave it (judgeEvents). When given, dispatch leaves the writing of the events to it.
   */
  record?: (events: TelemetryEvent[]) => void;
  /**
   * The request's own cancel signal (Claude Code cancels the call when the person stops it): no attempt starts after
   * it, and an answer that arrives after it is not written, so a stopped run writes nothing more into the project.
   */
  signal?: AbortSignal;
  /**
   * Whether the server can type with the model a routing decision names (the server's applyTypist.ts lean typist for
   * a brownfield run's Claude leaf). A retry the policy routes to such a model stays in this loop, as greenfield's ladder
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

/** The statuses that keep the packet's last written attempt on disk, as the status table says; any other end puts the file back. */
const KEEPS_ITS_WRITE = new Set<ApplyStatus>(["applied", "verify_failed", "escalate"]);

/**
 * Marks one judged call's events as greenfield's stage runner writes its own (executor/run.ts event): the verdict goes
 * on the call's last event (the ones before it are the adapter's own output-cap retries inside the call, which keep
 * their own record), `success` only when the answer was written and passed every check that judges it, with the cause
 * as `error` (its first line: the check's output stays in the receipt); and the call's first event carries why the loop
 * made this call (`transport` for a busy reply waited out, else the reason the loop gave the attempt, none for a first
 * attempt), whatever label the dispatcher put there, since the dispatcher cannot tell a ladder's retry from an
 * adapter's own output-cap retry.
 */
function judgeEvents(events: TelemetryEvent[], ok: boolean, why: string | undefined, reason: RetryReason | undefined): void {
  const first = events[0], last = events[events.length - 1];
  if (!first || !last) return;
  if (reason) first.retry_reason = reason;
  else delete first.retry_reason;
  last.success = ok;
  if (ok) delete last.error;
  else last.error = (why ?? "").split("\n")[0] || "the attempt failed";
}

/**
 * The editor loop: dispatch → write → verify → refine → dispatch, on greenfield's ladder (every attempt but the last
 * by the model the policy routes, the last by the ladder's last-attempt model; a retry routed to a model the server
 * cannot type with ends as `escalate`, for the orchestrator), until verify passes or the attempts run out. Before any
 * typist is paid, the packet is refused when it cannot stand: its file is outside the write contract or not named in
 * its normal form, its path would be read as shell syntax where a check pastes it, it is a fix round aimed at a
 * bugfix's reproducing test, the person's settings deny one of its commands (or, while they deny any, a command hides
 * what it runs), or it adds a reproducing case to a test file that already fails. An answer is written only once it
 * names the packet's file, applies, is not empty and keeps to the edit's sites. Each call's telemetry events are judged
 * and handed to `record` as soon as the call's verdict is known. The orchestrator gets the receipt; the file never
 * enters its context.
 */
export async function runApplyLoop(deps: ApplyLoopDeps): Promise<ApplyOutcome> {
  const { packet, projectRoot, runId, keepEvents, route, dispatch, log, signal } = deps;
  let apply = deps.apply;
  const mode: "content" | "edits" = apply.mode === "edits" ? "edits" : "content";
  const target = packet.artifact_path!;
  const abs = resolve(projectRoot, target);
  const transport = deps.transport ?? TRANSPORT;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  // Busy-vendor waits: `waits` for the attempt in hand (greenfield counts them per call, from 0), `transportWaits` for
  // the packet, for the receipt.
  let waits = 0;
  let transportWaits = 0;
  const attempts: ApplyAttemptSummary[] = [];
  const allEvents: TelemetryEvent[] = [];
  const tokens = { input: 0, input_cached: 0, output: 0 };
  let cost = 0;
  let firstDecision: RouteDecision | null = null;
  let receipt: WriteReceipt | undefined;
  let verify: VerifyResult | undefined;
  let terminalReason: string | undefined;
  let setAside: ApplyOutcome["set_aside"];
  let retriesUsed = 0;
  let current = packet;
  const maxRetries = apply.max_retries ?? DEFAULT_MAX_RETRIES;
  const baseRetry = packet.retry_count ?? 0;
  let snapshot: string | null = null;
  // Edits are spliced into the file as it was before this packet, on every attempt: a retry onto the already-edited
  // file finds its search text shifted or duplicated.
  let editsBase: string | null = null;
  // A whole-file write: the file as it was before the packet, and whether the packet's last attempt is what is on disk.
  let before: FileBefore | null = null;
  let lastAttemptWrote = false;

  const outcome = (status: ApplyStatus, extra: Partial<ApplyOutcome> = {}): ApplyOutcome => ({
    status,
    decision: firstDecision ?? route(packet),
    apply: receipt,
    verify,
    attempts,
    ...(transportWaits ? { transport_waits: transportWaits } : {}),
    tokens,
    cost_usd: cost,
    terminal_reason: terminalReason,
    events_written: keepEvents ? 0 : allEvents.length,
    events: keepEvents ? allEvents : undefined,
    ...(setAside ? { set_aside: setAside } : {}),
    ...extra,
  });
  const refuse = (refusal: string): ApplyOutcome => {
    log("warn", "apply.refused", { packet_id: packet.id, path: target, reason: refusal });
    return outcome("refused", { refusal });
  };
  const finish = (status: ApplyStatus, extra: Partial<ApplyOutcome> = {}): ApplyOutcome => {
    // A whole-file packet that ends with no answer standing (no content, a failed dispatch, a refusal, a stop) puts the
    // file back as it was before the packet, as edits mode does after every failed attempt: an earlier attempt that
    // failed its check never stays behind as the packet's work. verify_failed and escalate keep the last attempt on
    // disk when it was written, as the status table says, for the fix round or the escalation that follows.
    if (before && receipt && !(KEEPS_ITS_WRITE.has(status) && lastAttemptWrote)) restoreFile(abs, before);
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

  // ---- Before any typist is paid: what would make the packet's answer worthless whatever it says. ----
  // The write contract: the same answer it gives after the call, so a refused path costs no call.
  const allowed = checkWriteContract(projectRoot, target);
  if (!allowed.allowed) return refuse(`${allowed.rel}: ${allowed.reason}`);
  // The answer must name the packet's file exactly, in its normal form (greenfield's answer check, checkAnswer): a
  // packet that names it any other way ("./src/a.ts", "src//a.ts") could never be written, so it is refused before any
  // typist is paid, as greenfield's stage fails such a job before it types it.
  if (!isSafeRelativePath(target)) {
    return refuse(`${target}: not a path inside the project in its normal form (no ./, //, .. or leading /); name the file as ${allowed.rel}`);
  }
  // A path the shell would read as syntax where a check pastes it (pathPasteProblem): the file's own commands, and a
  // new file's style file in the checks its baseline runs.
  const pasteProblem = pathPasteProblem(target, fileTemplates(apply)) ?? (apply.baseline_from && apply.baseline !== false ? pathPasteProblem(apply.baseline_from, apply.verify ?? []) : null);
  if (pasteProblem) return refuse(`${pasteProblem}. Nothing was run and no typist was paid.`);
  // A bugfix's reproducing test is the judge of the fix: a fix round never edits it. A problem in it is the
  // architect's (findings-to-packets never routes one there; this is the writer's own line for a hand-written packet).
  if (packet.phase === "debug" && runId && reproducingTestPaths(projectRoot, runId).has(allowed.rel.toLowerCase())) {
    return refuse(`${allowed.rel}: the reproducing test judges the fix; a problem in it goes back to the architect`);
  }
  // The person's Bash deny rules hold for every command the server would run for this packet, wherever in a command
  // line the shell would run it (shellCommands). While any rule forbids a command, a line that runs a command no reading
  // of its text can name first (a substitution, an expansion) is not run either: the server has no prompt to ask.
  const denyRules = bashDenyRules(projectRoot, process.env);
  const holdsTheRules = "The server runs a packet's checks itself, where Claude Code's own Bash check does not reach, so it holds them to the same deny rules. " +
    "A different check is the person's decision: stop and tell the person which command the plan needs and why.";
  for (const cmd of denyRules.length ? packetCommands(apply, allowed.rel) : []) {
    const hidden = commandUnchecked(cmd);
    if (hidden) return refuse(`${cmd}: the person's Claude settings deny some shell commands, and the server cannot read which commands this line runs before it runs them (${hidden}). ${holdsTheRules}`);
    const rule = deniedByRules(cmd, denyRules);
    if (rule) return refuse(`${cmd}: the person's Claude settings deny it (${rule}). ${holdsTheRules}`);
  }
  if (mode === "edits") {
    if (!existsSync(abs)) return refuse(`${target}: edits mode needs an existing file`);
    editsBase = readFileSync(abs, "utf8");
  } else {
    before = fileBefore(abs);
  }
  // A whole-file write keeps the file's own line ending (or its mirror's, for a new file); edits keep it in applySearchReplace.
  const contentEol = mode === "edits" ? null : targetLineEnding(projectRoot, packet);
  // A reproducing case added to a test file that already fails proves nothing: the old failure gives the same exit code.
  if (mode === "edits" && apply.red?.length && (await redFailsBefore(apply.red, projectRoot, allowed.rel, apply.verify_timeout_sec ?? DEFAULT_VERIFY_TIMEOUT_SEC))) {
    return refuse(`${allowed.rel}: the test file already fails before the change, so its failure cannot show that the new case reproduces the bug: point the red check at the new case only, or put the case in a new test file`);
  }
  // Typed checks: a check the file already fails is set aside for this packet (baselineChecks), so it neither judges
  // the answer nor runs its write form; the receipt names it. A fix round's packet has no baseline: its file fails a
  // check, which is why the round exists, so every check judges the fix.
  if (apply.baseline !== false) {
    const baseline = await baselineChecks(apply, projectRoot, target);
    apply = baseline.apply;
    setAside = baseline.set_aside;
    if (setAside) log("info", "apply.baseline", { packet_id: packet.id, set_aside: setAside.map((c) => c.id ?? c.run).join(",") });
  }
  // Snapshot the file before anything is dispatched, so the backup is the original even if a worker touches the file itself.
  if (runId) { runProvenance("before", projectRoot, runId, allowed.rel, packet.id); snapshot = allowed.rel; }

  // The ladder's model for attempt `slot` (0 … maxRetries) of packet `p`: the policy's route, the last-attempt model
  // for the last slot when it is a retry (the routed model always types first). `forced` says the decision is not the
  // policy's own, so dispatch is told it.
  const ladder = (p: TaskPacket, slot: number): { decision: RouteDecision; forced: boolean } => {
    const last = slot > 0 && slot >= maxRetries ? deps.lastAttempt?.() ?? null : null;
    return last ? { decision: last, forced: true } : { decision: route(p), forced: false };
  };
  // The next attempt: its own waits, and the failure it must fix.
  const nextAttempt = (failure: string, reason: RetryReason) => {
    retriesUsed++;
    waits = 0;
    current = refinePacket(current, failure, mode, reason);
  };
  const stopped = () => {
    log("info", "apply.stopped", { packet_id: current.id, attempts: attempts.length });
    return finish("stopped");
  };
  // The events of the call in hand until its verdict is known; then they are judged (judgeEvents) and handed to
  // `record` at once, before the next call starts, as greenfield's runner emits each call's event.
  let pending: TelemetryEvent[] | null = null;
  const settle = (ok: boolean, why: string | undefined, reason: RetryReason | undefined): void => {
    const evs = pending;
    pending = null;
    if (!evs?.length) return;
    judgeEvents(evs, ok, why, reason);
    deps.record?.(evs);
  };

  try {
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
      let one: DispatchResult;
      try {
        one = await dispatch(current, step.forced ? decision : undefined);
      } catch (e) {
        // A call that throws (an adapter that cannot start, a typist that throws) is a failed attempt with no reply, as
        // greenfield's stage runner counts a typist that throws (executor/run.ts call); the packet keeps what it spent.
        const why = `the call failed: ${messageOf(e)}`.slice(0, 300);
        one = { decision, result: { success: false, error: why, result: null, tokens: { input: 0, input_cached: 0, output: 0 }, cost_usd: 0, terminal_reason: "no_answer" }, events: [] };
      }
      if (!firstDecision) firstDecision = one.decision;
      allEvents.push(...one.events);
      pending = one.events;
      // Why this call was made, for its event: the reason the loop gave this attempt (none for a first attempt).
      const attemptReason = current.retry_reason;
      tokens.input += one.result.tokens.input;
      tokens.input_cached += one.result.tokens.input_cached;
      tokens.output += one.result.tokens.output;
      cost += one.result.cost_usd;
      terminalReason = one.result.terminal_reason;
      lastAttemptWrote = false;
      const summary: ApplyAttemptSummary = {
        id: current.id,
        retry_count: current.retry_count ?? 0,
        model_id: one.decision.modelId,
        dispatch_ok: one.result.success,
        cost_usd: one.result.cost_usd,
      };

      if (!one.result.success) {
        const last = one.result.attempts?.[one.result.attempts.length - 1];
        let reason = one.result.error ?? "the typist returned no answer";
        // Credentials the vendor refuses fail every packet the same way: the batch stops here, as greenfield's executor
        // stops its stage, instead of handing each file to another model.
        if (last?.error_status !== undefined && CREDENTIAL_REFUSALS.has(last.error_status)) {
          settle(false, reason, attemptReason);
          summary.failure = reason;
          attempts.push(summary);
          return finish("dispatch_failed", { halt: `the ${one.decision.modelId} call was refused with HTTP ${last.error_status} (its login or permission is broken); the batch stopped here` });
        }
        // Cut off at the model's own output limit (the packet starts there: applyBudget). Greenfield's rule
        // (executor/run.ts): the same model cannot return the whole answer at the same limit, so its later attempts are
        // skipped and the packet goes to the next different model in the ladder, in that model's own slot; a cut-off
        // never adds an attempt. With no other model left the packet fails with the cut-off as its reason.
        if (one.result.terminal_reason === "output_cap_at_model_absolute" || one.result.terminal_reason === "output_cap_doubling_budget_exhausted") {
          settle(false, reason, attemptReason);
          summary.failure = reason;
          attempts.push(summary);
          let slot = retriesUsed + 1;
          while (slot <= maxRetries && ladder({ ...current, retry_count: baseRetry + slot }, slot).decision.modelId === one.decision.modelId) slot++;
          if (slot > maxRetries) return finish("dispatch_failed");
          const to = ladder({ ...current, retry_count: baseRetry + slot }, slot).decision.modelId;
          log("info", "apply.cut_off", { packet_id: current.id, from: one.decision.modelId, to });
          retriesUsed = slot - 1;
          current = { ...current, retry_count: baseRetry + slot - 1 };
          nextAttempt("The previous answer was cut off at the model's output limit; give the whole answer.", "cut_off");
          continue;
        }
        // A busy vendor (429, 5xx, a dropped connection) is waited out and the same packet sent again, as greenfield's
        // executor does: a wait is not an attempt, and a rate-limited call bills $0. Each attempt has the stated number
        // of waits; past them the failure is the attempt's. A pause longer than one rate-limit window (both vendors
        // meter per minute) means the quota is spent for longer than an attempt waits: that is an attempt, and the next
        // one waits one full window first, so it does not hit the same wall at once.
        // A typist states its own reading of the vendor's fields (greenfield's TypistResult.transport, which
        // applyTypist.ts typistResult always sets as `transient`), and only that decides, as in greenfield's runner: the
        // agent door's SDK has already waited out its own retries, so a status it reports without the flag is an attempt.
        // Only a dispatcher that states no reading is read from the vendor's status and network code.
        const busy = last?.transient !== undefined ? last.transient === true : isTransient(last?.error_status, last?.error_code);
        const longPause = busy && last?.retry_after_ms !== undefined && last.retry_after_ms > transport.capMs;
        if (busy && !longPause && waits < transport.maxWaits) {
          // A wait's event is failed and tagged `transport`, as greenfield tags its waits (executor/run.ts call).
          settle(false, reason, "transport");
          log("info", "apply.transport_wait", { packet_id: current.id, status: last?.error_status, code: last?.error_code, wait: waits + 1 });
          await sleep(last?.retry_after_ms ?? backoffMs(waits, transport.baseMs, transport.capMs, random));
          waits++;
          transportWaits++;
          continue;
        }
        if (longPause) reason = `${reason} — the vendor asked for a ${Math.round(last!.retry_after_ms! / 1000)} s pause, longer than one ${Math.round(transport.capMs / 1000)} s rate-limit window`;
        // Any other failure (no reply, a reply in no contract, a vendor error that is neither busy nor a refused login,
        // waits used up) is a failed attempt, as in greenfield's stage runner (executor/run.ts typeJob): retried with its
        // reason by the ladder's next model, and when the attempts run out the packet ends as a failed dispatch, or as
        // no content when the model replied outside the contract.
        settle(false, reason, attemptReason);
        summary.failure = reason;
        attempts.push(summary);
        if (retriesUsed >= maxRetries) return finish(one.result.terminal_reason === "invalid_answer" ? "no_content" : "dispatch_failed");
        if (longPause) await sleep(transport.capMs);
        nextAttempt(`the previous attempt failed: ${reason}`, "error");
        continue;
      }
      attempts.push(summary);
      if (signal?.aborted) {
        settle(false, "the run was stopped before this answer was written", attemptReason);
        return stopped();
      }

      // The answer, judged as greenfield's stage runner judges one before it writes (executor/run.ts typeJob,
      // executor/checks.ts checkAnswer): it is in the contract, it applies, it names the packet's own file, and the file
      // is not empty. Anything else is a failed attempt with that reason, never a write.
      let failure = "";
      let content: string | null = null;
      let named: string | undefined;
      if (mode === "edits") {
        // Every attempt applies to the file as it was before the packet (editsBase), as greenfield's fixes apply to the
        // current text they were shown.
        const r = applySearchReplace(editsBase!, one.result.result);
        if (r.content !== undefined) { content = r.content; named = r.path; }
        else failure = `the edits could not be applied: ${r.reason}`;
      } else {
        const file = extractFileContent(one.result.result);
        if (file) { content = contentEol ? file.content.replace(/\r?\n/g, contentEol) : file.content; named = file.path; }
        else failure = "the response had no `content` string; return JSON {path, content} with the complete file in `content`";
      }
      if (content !== null) {
        const check = checkAnswer({ path: target }, { path: named ?? target, content });
        if (!check.ok) { failure = check.reason ?? "the answer was refused"; content = null; }
      }
      // An edit typed "at these sites only" changes nothing else in its file (siteProblem): no write otherwise.
      if (content !== null && editsBase !== null && apply.sites?.length) {
        const beyond = siteProblem(editsBase, content, apply.sites);
        if (beyond) { failure = beyond; content = null; }
      }
      if (content === null) {
        settle(false, failure, attemptReason);
        summary.failure = failure;
        if (retriesUsed >= maxRetries) return finish("no_content");
        nextAttempt(failure, "refused");
        continue;
      }
      const contract = checkWriteContract(projectRoot, target);
      if (!contract.allowed) {
        log("warn", "apply.refused", { packet_id: current.id, path: contract.rel, reason: contract.reason });
        settle(false, contract.reason, attemptReason);
        summary.failure = contract.reason;
        return finish("refused", { refusal: `${contract.rel}: ${contract.reason}` });
      }
      receipt = await applyContent(projectRoot, contract.rel, content, { runId, packetId: current.id, format: apply.format, timeoutSec: apply.verify_timeout_sec });
      lastAttemptWrote = true;
      log("info", "apply.write", { packet_id: current.id, path: receipt.path, bytes: receipt.bytes, sha16: receipt.sha16 });
      verify = await runVerify(apply.verify, projectRoot, contract.rel, apply.verify_timeout_sec);
      // A bugfix's reproducing test is judged only once the checks that must pass have passed (runRed).
      if (verify.ok && apply.red?.length) {
        const red = await runRed(apply.red, projectRoot, contract.rel, apply.verify_timeout_sec);
        verify = { ...red, ran: verify.ran + red.ran, duration_ms: verify.duration_ms + red.duration_ms };
      }
      summary.verify_ok = verify.ok;
      log(verify.ok ? "info" : "warn", "apply.verify", {
        packet_id: current.id,
        ok: verify.ok,
        ran: verify.ran,
        failed_command: verify.failed_command,
        exit_code: verify.exit_code,
        signal: verify.signal,
        timed_out: verify.timed_out,
        duration_ms: verify.duration_ms,
      });
      // The attempt's verdict is known once its checks have run, and its event says so now (judgeEvents): success only
      // when the answer was written and passed the file's checks, the failed check as its error otherwise. Greenfield's
      // typing events can say only whether the answer was usable, because its checks run later as their own stage; a
      // brownfield attempt is judged here, before its event, so its event carries the full verdict and a rollup of
      // successful calls never counts an answer its file's checks refused.
      failure = verify.ok ? "" : `verify failed: ${verify.failed_command} (${exitText(verify)})\n${verify.output_tail ?? ""}`;
      settle(verify.ok, failure, attemptReason);
      if (verify.ok) return finish("applied");
      if (editsBase !== null) writeFileSync(abs, editsBase, "utf8");
      summary.failure = failure;
      if (retriesUsed >= maxRetries) return finish("verify_failed");
      nextAttempt(failure, "verify");
    }
  } catch (e) {
    // Something on this machine failed outside a call (the disk refused a write, a check could not be started): the
    // packet ends here with what it spent and its attempts, the original back on disk, and its provenance matching it.
    const why = `the packet failed: ${messageOf(e)}`.slice(0, 300);
    log("warn", "apply.error", { packet_id: current.id, message: why });
    // The call in hand, if its verdict was not yet given, failed with this reason.
    settle(false, why, current.retry_reason);
    if (editsBase !== null) { try { writeFileSync(abs, editsBase, "utf8"); } catch { /* left as it is */ } }
    const last = attempts[attempts.length - 1];
    if (last) last.failure = last.failure ?? why;
    else attempts.push({ id: current.id, retry_count: current.retry_count ?? 0, model_id: firstDecision?.modelId ?? "", dispatch_ok: false, cost_usd: 0, failure: why });
    lastAttemptWrote = false;
    return finish("dispatch_failed");
  }
}
