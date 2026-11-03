/**
 * The Antigravity SDK's part of pre-flight.
 *
 *  - The SDK that will run: the worker's own Python is asked which google-antigravity it has. A known version other
 *    than the one worker/requirements.txt pins stops the run (its harness and its usage reading are not the ones this
 *    engine was tested with); a version that cannot be read is a warning, billed on the larger usage reading as before.
 *  - A stray Vertex redirect: GOOGLE_VERTEX_BASE_URL in the server's environment sends every Antigravity call there
 *    instead of Google, so pre-flight says so (every Gemini event also records it, as gemini.endpoint_override).
 *  - The run's Google project: the first passing pre-flight of a run writes run-binding.json beside the run's telemetry
 *    (the project, each Gemini leaf's locations, the policy, the auth mode, the plugin and SDK versions); a later
 *    pre-flight of the same run that resolves another project stops, so a server restarted under another project
 *    cannot bill it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelConfig } from "./types.js";
import { WORKER_DIR } from "./paths.js";
import { AGY_USAGE_SEMANTICS, resolveWorkerPython } from "./delegation/workerProcess.js";
import { agyEnv } from "./executor/typists.js";
import { resolveGcpLocation, resolveGcpProject, workerVertexLocation } from "./adapters/geminiTransports.js";
import { log } from "./log.js";

/** The google-antigravity version worker/requirements.txt pins, or null when it pins none. */
export function pinnedSdkVersion(workerDir: string = WORKER_DIR): string | null {
  try {
    return /^google-antigravity==(\S+)/m.exec(readFileSync(join(workerDir, "requirements.txt"), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The version query, the one the worker itself makes when it records `sdk_version`. */
const VERSION_QUERY = "import importlib.metadata as m; print(m.version('google-antigravity'))";

/** A passing answer per interpreter, kept for the server process; any other answer is asked again next time. */
const KNOWN = new Map<string, string>();

/** The google-antigravity version `python` has, asked in the worker's own environment, or why it could not be read. */
export function installedSdkVersion(python: string, env: Record<string, string>, pin: string | null): { version: string | null; error?: string } {
  const cached = KNOWN.get(python);
  if (cached !== undefined) return { version: cached };
  const r = spawnSync(python, ["-c", VERSION_QUERY], { cwd: WORKER_DIR, env, encoding: "utf8", timeout: 30_000 });
  const version = r.status === 0 ? String(r.stdout ?? "").trim().split("\n").pop()?.trim() ?? "" : "";
  if (!version) {
    const why = r.error ? r.error.message : (String(r.stderr ?? "").trim().split("\n").pop() || `exit ${r.status ?? r.signal}`);
    return { version: null, error: why.slice(0, 200) };
  }
  if (version === pin) KNOWN.set(python, version);
  return { version };
}

export interface AgsdkCheck {
  /** For the pre-flight output: the version that will run, the interpreter, the pin, and the usage reading applied. */
  agsdk: { version: string | null; interpreter: string; pin: string | null; usage_reading: string } | null;
  halt: string | null;
  warnings: string[];
}

/** The SDK check for the run's reachable antigravity-worker leaves (none: no check, no output). */
export function checkAgsdk(agentLeaves: ModelConfig[], env: Record<string, string | undefined>): AgsdkCheck {
  const warnings: string[] = [];
  const base = env.GOOGLE_VERTEX_BASE_URL?.trim();
  if (agentLeaves.length && base) {
    warnings.push(`GOOGLE_VERTEX_BASE_URL is set (${base}): every Antigravity call of this run goes there instead of Google, and every Gemini event records it (gemini.endpoint_override).`);
  }
  if (!agentLeaves.length) return { agsdk: null, halt: null, warnings };
  let python: string;
  try {
    python = resolveWorkerPython({ env, workerDir: WORKER_DIR, exists: existsSync });
  } catch {
    // No interpreter: the adapter's own construction has already failed this run's check with the fix.
    return { agsdk: null, halt: null, warnings };
  }
  const pin = pinnedSdkVersion();
  const project = resolveGcpProject(env) ?? "";
  const got = installedSdkVersion(python, agyEnv(env, project, workerVertexLocation(agentLeaves[0], env)), pin);
  const usageReading = got.version ? AGY_USAGE_SEMANTICS[got.version] ?? "unverified" : "unverified";
  const agsdk = { version: got.version, interpreter: python, pin, usage_reading: usageReading };
  log("info", "preflight.agsdk", { version: got.version, pin, interpreter: python, usage_reading: usageReading, error: got.error });
  if (got.version === null) {
    warnings.push(`The google-antigravity version of the worker's Python (${python}) could not be read (${got.error}); its calls are billed on the larger usage reading. Run /mmo:setup to rebuild the worker's environment at google-antigravity ${pin ?? "the pinned version"}.`);
    return { agsdk, halt: null, warnings };
  }
  if (pin && got.version !== pin) {
    return {
      agsdk,
      halt: `The Antigravity worker's environment has google-antigravity ${got.version}; this engine runs ${pin} (${python}). Run /mmo:setup to rebuild it, or point GEMINI_WORKER_PYTHON at an environment with google-antigravity ${pin}.`,
      warnings,
    };
  }
  if (usageReading === "unverified") {
    warnings.push(`google-antigravity ${got.version}'s usage reading has not been checked against Google's token counter yet: its calls are billed on the larger reading (never under-reported).`);
  }
  return { agsdk, halt: null, warnings };
}

/** One Gemini leaf's binding: where its calls run. */
export interface BoundLeaf { id: string; model_name: string; adapter: string; locations: string[] }

/** The locations a reachable Gemini leaf's calls run at, in order. */
export function leafLocations(m: ModelConfig, env: Record<string, string | undefined>): string[] {
  if (m.adapter === "antigravity-worker") {
    const own = workerVertexLocation(m, env);
    return [own, ...(m.failover_locations ?? []).filter((l) => l !== own)];
  }
  return [resolveGcpLocation(env)];
}

export interface RunBinding {
  run_id: string | null;
  project: string | null;
  policy: { name: string; version: number };
  auth_mode: string;
  plugin_version: string;
  sdk_version: string | null;
  leaves: BoundLeaf[];
  written_at: string;
}

const BINDING_FILE = "run-binding.json";

/**
 * Why this pre-flight must stop because the run it belongs to was bound to another Google project, or null. The
 * binding is per run: a file written under another run id (a new run reusing the folder) binds nothing here.
 */
export function bindingConflict(telemetryPath: string, runId: string | undefined, project: string | null): string | null {
  const file = join(dirname(telemetryPath), BINDING_FILE);
  let prev: RunBinding;
  try { prev = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  if ((prev.run_id ?? null) !== (runId ?? null)) return null;
  if (!prev.project || !project || prev.project === project) return null;
  return `This run${runId ? ` (${runId})` : ""} started on Google project '${prev.project}', and this server resolves '${project}' (${file}). A server restarted under another project must not bill it: set GOOGLE_CLOUD_PROJECT back to '${prev.project}', or start a new run.`;
}

/** Writes the run's binding once: a run already bound keeps its first binding. */
export function writeBinding(telemetryPath: string, binding: Omit<RunBinding, "written_at">): void {
  const file = join(dirname(telemetryPath), BINDING_FILE);
  try {
    if (existsSync(file)) {
      const prev = JSON.parse(readFileSync(file, "utf8"));
      if ((prev.run_id ?? null) === (binding.run_id ?? null)) return;
    }
  } catch { /* unreadable: written again */ }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...binding, written_at: new Date().toISOString() }, null, 2) + "\n");
    log("info", "preflight.run_binding", { path: file, project: binding.project, run_id: binding.run_id });
  } catch (err: any) {
    log("warn", "preflight.run_binding", { path: file, ok: false, error: err?.message ?? String(err) });
  }
}
