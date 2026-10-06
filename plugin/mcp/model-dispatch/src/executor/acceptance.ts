/**
 * The acceptance stage: code, not a model, decides whether the finished project meets the brief.
 *
 * It runs every command of the plan's acceptance list, in order, in its folder under the code
 * directory, keeps each command's whole output on disk, and judges it by the pass rule the plan
 * states (an exit code, and output lines the brief forbids). Every acceptance criterion is then
 * pass, fail, or not checked with the reason the plan gives. The table it writes is the one the
 * final report carries (the collector copies it into SUMMARY.md).
 *
 * A failure names who can fix it: an install or audit failure is a version choice, so it goes back
 * to the architect, which has the registry; a failing check is code, so it goes to a repair round.
 * The stage runs at most once plus ACCEPTANCE_RECHECKS times per plan; a further call runs nothing.
 * The count belongs to the spec it ran for: a different spec in the same folder starts at run 1, and
 * the earlier spec's results are moved under previous/, not deleted.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { moveAside, specKey, type Spec, type SpecCommand } from "../spec/store.js";
import { insideCodeDir, RECEIPT_MAX_BYTES } from "./run.js";
// apply.ts imports commandEnv from here and this file imports commandDeniedBy from there: each uses the other's export
// only when called, never while the modules load, so the cycle is safe.
import { commandDeniedBy } from "../apply.js";

/**
 * A command's time limit is the plan's own (`timeout_s` on each command): the architect knows the
 * stack and what its installs and suites take. A slow suite is not a defect, so a command stopped at
 * its limit, or one the shell cannot find (exit 127, POSIX's "command not found"), is `not run`: its
 * criteria are not checked, with that reason, and nothing is sent for repair.
 */
/** POSIX: a shell that cannot find the command exits 127; the run reads that as the machine's own answer. */
export const NOT_FOUND_EXIT = 127;
/** Re-checks after the first run: the pipeline skill's stated bound on repair rounds, enforced here. */
export const ACCEPTANCE_RECHECKS = 3;
/** What one spec's acceptance runs leave in the output folder. */
const ACCEPTANCE_RECORDS = ["acceptance", "acceptance.json", "acceptance.md"];
/** Lines of a failure's output the receipt carries; the whole output stays in its log file. */
const RECEIPT_LINES = 8;
const LINE_CHARS = 200;

export type Verdict = "pass" | "fail" | "not checked";
export interface CommandResult {
  name: string; run: string; cwd: string; role: SpecCommand["role"]; checks: string[];
  ran: boolean; exit_code: number | null; timed_out: boolean; seconds: number;
  passed: boolean; reason: string; forbidden_count: number; forbidden_lines: string[]; log_path: string | null;
  /**
   * The machine, not the project, decided this one: the shell found no such program (exit 127),
   * the plan's time limit stopped it, the plan gives it no time limit, the person's Bash deny rules
   * forbid it, or the install it needs could not run. Its criteria are not checked, with the reason;
   * nothing about it is sent for repair.
   */
  not_run?: boolean;
}
export interface CriterionResult { id: string; verdict: Verdict; by: string[]; evidence: string }
export interface AcceptanceFailure {
  command: string; role: SpecCommand["role"]; route: "architect" | "repair"; checks: string[];
  reason: string; lines: string[]; log_path: string | null;
}
export interface AcceptanceReceipt {
  stage: "acceptance"; round: number; final: boolean; rechecks_left: number;
  passed: number; failed: AcceptanceFailure[]; failed_not_listed?: number; not_checked: string[];
  /** Commands the machine could not run (program not found, time limit, no limit stated, denied by the person's settings, an install that could not run): their criteria are not checked. */
  not_run?: { command: string; reason: string }[];
  table_path: string; results_path: string; refused?: string;
}
export interface AcceptanceOptions {
  codeDir: string;
  /** Where acceptance.json, acceptance.md and the logs go: beside spec.json. */
  outDir: string;
  env?: Record<string, string | undefined>;
}

/**
 * The credentials of the model vendors this plugin itself calls, which no product command needs.
 * Everything else passes through, so a command runs as it would in the developer's own shell.
 */
const VENDOR_CREDENTIAL = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH)|^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS)$/;
export function commandEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !VENDOR_CREDENTIAL.test(k)) env[k] = v;
  return env;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const cut = (s: string) => (s.length > LINE_CHARS ? `${s.slice(0, LINE_CHARS)}…` : s);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "command";

/** Runs one command line in its own process group, output to a file; the group is killed at the limit. */
function runCommand(run: string, cwd: string, env: Record<string, string>, logPath: string, timeoutMs: number): Promise<{ code: number | null; timedOut: boolean; seconds: number }> {
  return new Promise((done) => {
    const t0 = Date.now();
    const fd = openSync(logPath, "w");
    const child = spawn("/bin/sh", ["-c", run], { cwd, env, stdio: ["ignore", fd, fd], detached: true });
    let timedOut = false, finished = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { closeSync(fd); } catch { /* closed */ }
      done({ code, timedOut, seconds: Math.round((Date.now() - t0) / 100) / 10 });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

/**
 * The person's Bash deny rule a plan command breaks, or null: the rules the server holds a brownfield packet's checks
 * to (apply.ts commandDeniedBy: the organisation's managed settings, the person's own, and a project's .claude
 * settings), read for the code directory and for the session's project (CLAUDE_PROJECT_DIR, else the folder Claude
 * Code started this server in, as handoff/listing.ts reads it). Why: the server runs these commands itself, where
 * Claude Code's own permission check for its Bash tool never sees them, so greenfield and brownfield hold their
 * commands to the same rules.
 */
function deniedRule(run: string, codeDir: string, env: Record<string, string | undefined>): string | null {
  const session = env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();
  for (const dir of new Set([resolve(codeDir), resolve(session)])) {
    const rule = commandDeniedBy(run, dir, env as NodeJS.ProcessEnv);
    if (rule) return rule;
  }
  return null;
}

/** The program a command line starts: its first word after any leading VAR=value assignments. */
export function programOf(run: string): string {
  const words = run.trim().split(/\s+/);
  return words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? run.trim();
}

function judge(c: SpecCommand, out: { code: number | null; timedOut: boolean }, text: string, timeoutMs: number): { passed: boolean; reason: string; forbidden: string[]; notRun: boolean } {
  const lines = text.replace(ANSI, "").split(/\r?\n/);
  const prefixes = (c.pass.forbid_lines_starting_with ?? []).map((p) => p.toLowerCase());
  const forbidden = prefixes.length ? lines.filter((l) => prefixes.some((p) => l.trimStart().toLowerCase().startsWith(p))) : [];
  // The machine's own answers come first: they are not a verdict on the project's files.
  if (out.timedOut) return { passed: false, reason: `not run to the end: stopped at the plan's time limit (${Math.round(timeoutMs / 1000)} s)`, forbidden, notRun: true };
  if (out.code === NOT_FOUND_EXIT && c.pass.exit_code !== NOT_FOUND_EXIT) return { passed: false, reason: `not run: command not found (exit code 127 from the shell): ${programOf(c.run)}`, forbidden, notRun: true };
  const reasons: string[] = [];
  if (out.code !== c.pass.exit_code) reasons.push(`exit code ${out.code ?? "none"}, expected ${c.pass.exit_code}`);
  for (const p of c.pass.forbid_lines_starting_with ?? []) {
    const n = forbidden.filter((l) => l.trimStart().toLowerCase().startsWith(p.toLowerCase())).length;
    if (n) reasons.push(`${n} output line${n === 1 ? "" : "s"} start${n === 1 ? "s" : ""} with "${p}"`);
  }
  return { passed: !reasons.length, reason: reasons.join("; ") || `exit code ${out.code}`, forbidden, notRun: false };
}

/**
 * Runs the acceptance list once. A command whose folder leaves the code directory is never run; an
 * install that does not finish (wrong exit code or time limit) stops the commands after it, which are
 * reported as not run. An install that finishes but prints forbidden lines does not stop them.
 */
export async function runAcceptance(spec: Spec, opts: AcceptanceOptions): Promise<AcceptanceReceipt> {
  const base = join(opts.outDir, "acceptance");
  const statePath = join(base, "state.json");
  const tablePath = join(opts.outDir, "acceptance.md");
  const resultsPath = join(opts.outDir, "acceptance.json");
  const key = specKey(spec);
  let state: { runs?: unknown; spec?: unknown } = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) ?? {} : {};
  // A count without a spec key is read as this spec's, so the bound is never loosened by a missing field.
  if (typeof state.spec === "string" && state.spec !== key) {
    moveAside(opts.outDir, ACCEPTANCE_RECORDS);
    state = {};
  }
  mkdirSync(base, { recursive: true });
  const runs = Number(state.runs) || 0;
  if (runs >= 1 + ACCEPTANCE_RECHECKS) {
    const last = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : null;
    return {
      stage: "acceptance", round: runs, final: true, rechecks_left: 0, passed: 0, failed: [], not_checked: [],
      table_path: tablePath, results_path: resultsPath,
      refused: `the acceptance check already ran ${runs} times (the first run and ${ACCEPTANCE_RECHECKS} re-checks); its last results are final${last ? "" : " (no results file was found)"}`,
    };
  }
  const round = runs + 1;
  writeFileSync(statePath, JSON.stringify({ runs: round, spec: key }) + "\n");
  const roundDir = join(base, `round-${round}`);
  mkdirSync(roundDir, { recursive: true });
  const results = await runCommandList(spec.commands, { codeDir: opts.codeDir, logDir: roundDir, env: opts.env });

  const criteria = criteriaOf(spec, results);
  const final = round === 1 + ACCEPTANCE_RECHECKS;
  writeFileSync(resultsPath, JSON.stringify({ round, final, commands: results, criteria }, null, 2) + "\n");
  writeFileSync(tablePath, renderTable(spec, results, criteria, round, final));

  // A command the machine could not run is not a failure of the project: it is listed apart, routed
  // nowhere, and its criteria are not checked. A command that ran and failed is routed by its role.
  const failed: AcceptanceFailure[] = results.filter((r) => !r.passed && !r.not_run).map((r) => ({
    command: r.name, role: r.role, route: r.role === "check" ? "repair" : "architect", checks: r.checks, reason: r.reason,
    lines: (r.forbidden_count ? r.forbidden_lines.slice(0, RECEIPT_LINES) : tail(r.log_path)).map(cut), log_path: r.log_path,
  }));
  const notRun = results.filter((r) => r.not_run).map((r) => ({ command: r.name, reason: r.reason }));
  return boundAcceptance({
    stage: "acceptance", round, final, rechecks_left: 1 + ACCEPTANCE_RECHECKS - round,
    passed: results.filter((r) => r.passed).length, failed, not_checked: criteria.filter((c) => c.verdict === "not checked").map((c) => c.id),
    ...(notRun.length ? { not_run: notRun } : {}),
    table_path: tablePath, results_path: resultsPath,
  });
}

/**
 * Runs a list of the plan's commands in order, each in its folder under the code directory, each one's
 * whole output in its own log file under logDir, each judged by the pass rule the plan states. A command
 * whose folder leaves the code directory is never run, nor is one the person's Bash deny rules forbid
 * (deniedRule: not run, with the rule, its criteria not checked: the person's decision, not a failure to
 * repair); an install that does not finish stops the commands after it (reported as not run).
 */
export async function runCommandList(commands: SpecCommand[], o: { codeDir: string; logDir: string; env?: Record<string, string | undefined> }): Promise<CommandResult[]> {
  const env = commandEnv(o.env ?? process.env);
  const codeRoot = resolve(o.codeDir);
  mkdirSync(o.logDir, { recursive: true });
  const results: CommandResult[] = [];
  // An install that did not finish stops the commands after it. When the machine could not run the
  // install (not found, time limit), those commands are not run for the machine's reason and their
  // criteria are not checked; when the install ran and failed, they are not run because of a failure.
  let stoppedBy: { name: string; notRun: boolean } | null = null;
  for (const [i, c] of commands.entries()) {
    const r: CommandResult = { name: c.name, run: c.run, cwd: c.cwd, role: c.role, checks: c.checks ?? [], ran: false, exit_code: null, timed_out: false, seconds: 0, passed: false, reason: "", forbidden_count: 0, forbidden_lines: [], log_path: null };
    results.push(r);
    if (stoppedBy) { r.reason = `not run: ${stoppedBy.name} did not finish`; if (stoppedBy.notRun) { r.reason = `not run: ${stoppedBy.name} could not run on this machine`; r.not_run = true; } continue; }
    const dir = resolve(codeRoot, c.cwd);
    if (!existsSync(codeRoot) || !insideCodeDir(codeRoot, c.cwd)) { r.reason = `not run: ${c.cwd} is outside the code directory`; continue; }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) { r.reason = `not run: no folder ${c.cwd} under the code directory`; continue; }
    // A command the person's settings deny never runs, as a brownfield packet's checks never do.
    const rule = deniedRule(c.run, codeRoot, o.env ?? process.env);
    if (rule) { r.reason = `not run: the person's Claude settings deny it (${rule})`; r.not_run = true; if (c.role === "install") stoppedBy = { name: c.name, notRun: true }; continue; }
    // No limit is guessed: a command the plan gives no time limit is not run, and the result says so.
    if (!(Number.isInteger(c.timeout_s) && c.timeout_s > 0)) { r.reason = "not run: the plan states no time limit for this command (timeout_s)"; r.not_run = true; if (c.role === "install") stoppedBy = { name: c.name, notRun: true }; continue; }
    const timeoutMs = c.timeout_s * 1000;
    r.log_path = join(o.logDir, `${String(i + 1).padStart(2, "0")}-${slug(c.name)}.log`);
    const out = await runCommand(c.run, dir, env, r.log_path, timeoutMs);
    const verdict = judge(c, out, readFileSync(r.log_path, "utf8"), timeoutMs);
    Object.assign(r, { ran: true, exit_code: out.code, timed_out: out.timedOut, seconds: out.seconds, passed: verdict.passed, reason: verdict.reason, forbidden_count: verdict.forbidden.length, forbidden_lines: verdict.forbidden, ...(verdict.notRun ? { not_run: true } : {}) });
    if (c.role === "install" && !verdict.passed && (verdict.notRun || out.code !== c.pass.exit_code)) stoppedBy = { name: c.name, notRun: verdict.notRun };
  }
  return results;
}

function tail(logPath: string | null): string[] {
  if (!logPath || !existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").replace(ANSI, "").split(/\r?\n/).filter((l) => l.trim()).slice(-RECEIPT_LINES);
}

/**
 * Every criterion the plan names. A command that ran and failed fails its criteria. Otherwise a
 * command the machine could not run (not found, time limit, no limit stated, its install could not
 * run) leaves them not checked, with that reason — the machine's answer, not the plan's word. Every
 * command passed: pass. No command at all: not checked, with the plan's reason.
 */
function criteriaOf(spec: Spec, results: CommandResult[]): CriterionResult[] {
  const ids: string[] = [];
  for (const r of results) for (const id of r.checks) if (!ids.includes(id)) ids.push(id);
  for (const u of spec.unchecked ?? []) if (!ids.includes(u.id)) ids.push(u.id);
  return ids.map((id) => {
    const by = results.filter((r) => r.checks.includes(id));
    if (!by.length) return { id, verdict: "not checked" as Verdict, by: [], evidence: spec.unchecked?.find((u) => u.id === id)?.reason ?? "" };
    const bad = by.filter((r) => !r.passed && !r.not_run);
    if (bad.length) return { id, verdict: "fail" as Verdict, by: by.map((r) => r.name), evidence: bad.map((r) => r.reason).join("; ") };
    const notRun = by.filter((r) => r.not_run);
    if (notRun.length) return { id, verdict: "not checked" as Verdict, by: by.map((r) => r.name), evidence: notRun.map((r) => `${r.name}: ${r.reason}`).join("; ") };
    return { id, verdict: "pass" as Verdict, by: by.map((r) => r.name), evidence: by.map((r) => r.reason).join("; ") };
  });
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
function renderTable(spec: Spec, results: CommandResult[], criteria: CriterionResult[], round: number, final: boolean): string {
  const lines = [
    "## Acceptance criteria (checked by code)", "",
    `Each criterion's verdict comes from the commands below, run by the acceptance stage in the code directory with their whole output kept (run ${round} of ${1 + ACCEPTANCE_RECHECKS}${final ? ", final" : ""}).`, "",
    "| Criterion | Verdict | Checked by | Evidence |", "|---|---|---|---|",
    ...criteria.map((c) => `| ${c.id} | ${c.verdict} | ${c.by.length ? cell(c.by.join(", ")) : "—"} | ${cell(c.evidence || "—")} |`),
    "", "| Command | Role | Result | Output |", "|---|---|---|---|",
    ...results.map((r) => `| ${cell(r.name)} | ${r.role} | ${r.passed ? "pass" : r.not_run ? "not run" : "fail"}: ${cell(r.reason)} | ${r.log_path ? cell(r.log_path) : "—"} |`),
  ];
  if (spec.no_audit_reason) lines.push("", `No dependency audit: ${spec.no_audit_reason}`);
  return lines.join("\n") + "\n";
}

/** The receipt as sent, within RECEIPT_MAX_BYTES: failures past the bound are counted, not listed (each is in acceptance.json). */
function boundAcceptance(r: AcceptanceReceipt): AcceptanceReceipt {
  const out = { ...r, failed: r.failed.map((f) => ({ ...f, lines: [...f.lines] })) };
  for (const f of out.failed) while (JSON.stringify(out).length > RECEIPT_MAX_BYTES && f.lines.length > 2) f.lines.pop();
  while (JSON.stringify(out).length > RECEIPT_MAX_BYTES && out.failed.length) {
    out.failed.pop();
    out.failed_not_listed = (out.failed_not_listed ?? 0) + 1;
  }
  return out;
}
