/**
 * Is this computer connected to Google (for Flash 3.8)? The mmo plugin's own rule, copied.
 *
 * mmo already answers this in plugin/scripts/verify-setup.mjs, and answers it well: a value that
 * is only an unexpanded placeholder does not count; a credential file is opened and read, and must hold the fields a
 * real login has; a Google Cloud project name on its own is not a login ("a project ID says where to bill, not who
 * is asking"); an explicit GOOGLE_APPLICATION_CREDENTIALS that cannot be used is "broken", because the Google library
 * does not fall back from it. Zero-touch carries no mmo code (Claude Code copies each plugin on its own), so the rule
 * is copied here function for function; tools/test/zero-touch-google.test.mjs runs both on the same cases and fails
 * if they ever disagree.
 *
 * Two checks:
 *   googleState(env)      offline and instant, at every chat start and before a workflow starts
 *   onlineCheck(env)      one real request, only when settings that use Flash are saved: for the gcloud login file,
 *                         `gcloud auth application-default print-access-token` (the application-default login is the
 *                         one the model server signs with), at most 3 seconds. Skipped when there is no gcloud, or
 *                         when the login is an API key or a service-account file (the offline check covers those).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Copied from plugin/scripts/verify-setup.mjs (keep in step; the test compares them) ───

export function isUnexpandedPlaceholder(value) {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(String(value ?? "").trim());
}

export function usableEnv(env = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const trimmed = String(value).trim();
    if (trimmed === "" || isUnexpandedPlaceholder(trimmed)) continue;
    out[key] = value;
  }
  return out;
}

export const CREDENTIAL_REQUIRED_FIELDS = {
  authorized_user: ["client_id", "client_secret", "refresh_token"],
  service_account: ["client_email", "private_key"],
  external_account: ["audience", "subject_token_type", "token_url"],
  impersonated_service_account: ["service_account_impersonation_url", "source_credentials"],
};

export function inspectCredentialFile(path, { exists = existsSync, read = readFileSync } = {}) {
  if (!path) return { present: false, usable: false, type: null, detail: null };
  if (!exists(path)) return { present: false, usable: false, type: null, detail: `${path} does not exist` };
  let parsed;
  try {
    parsed = JSON.parse(read(path, "utf8"));
  } catch (err) {
    return { present: true, usable: false, type: null, detail: `${path} is not valid JSON (${err.message})` };
  }
  const type = typeof parsed?.type === "string" ? parsed.type.trim() : null;
  if (!type) return { present: true, usable: false, type: null, detail: `${path} has no "type" field, so no Google auth library can tell what kind of credential it is` };
  const required = CREDENTIAL_REQUIRED_FIELDS[type];
  if (!required) return { present: true, usable: true, type, detail: `credential type '${type}' is not one this check knows how to verify` };
  const missing = required.filter((field) => !parsed[field]);
  if (missing.length > 0) return { present: true, usable: false, type, detail: `${path} is a '${type}' credential but is missing ${missing.join(", ")}` };
  return { present: true, usable: true, type, detail: null };
}

export function vertexCredentialState({ env = {}, serviceAccountFile = null, adcFile = null } = {}) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    if (serviceAccountFile?.usable) return { state: "credential", source: "GOOGLE_APPLICATION_CREDENTIALS", detail: serviceAccountFile.detail };
    return {
      state: "broken",
      source: "GOOGLE_APPLICATION_CREDENTIALS",
      detail: serviceAccountFile?.detail ?? `GOOGLE_APPLICATION_CREDENTIALS points at ${env.GOOGLE_APPLICATION_CREDENTIALS}, which cannot be read`,
    };
  }
  if (adcFile?.usable) return { state: "credential", source: "gcloud ADC file", detail: adcFile.detail };
  if (adcFile?.present) return { state: "broken", source: "gcloud ADC file", detail: adcFile.detail };
  if (env.GOOGLE_CLOUD_PROJECT) return { state: "project-only", source: "GOOGLE_CLOUD_PROJECT", detail: null };
  return { state: "none", source: null, detail: null };
}

export function hasGeminiCredentials({ env = {}, vertex = null } = {}) {
  return Boolean(env.GEMINI_API_KEY || vertex?.state === "credential");
}

// ─── Zero-touch's use of it ──────────────────────────────────────────────

/** Where gcloud writes its login file (verify-setup.mjs adcPath), under the HOME this process was given. */
export function adcPath(env = process.env) {
  return join(env.HOME && env.HOME.trim() ? env.HOME : homedir(), ".config", "gcloud", "application_default_credentials.json");
}

/**
 * The offline answer: { connected, state, source, detail }.
 *   state "key"          an API key (GEMINI_API_KEY): connected
 *   state "credential"   a complete login file: connected
 *   state "broken"       a login is configured but cannot be used: not connected, and the person is told why
 *   state "project-only" a project name without a login: not connected
 *   state "none"         nothing: not connected
 */
export function googleState(env = process.env) {
  const real = usableEnv(env);
  const serviceAccountFile = real.GOOGLE_APPLICATION_CREDENTIALS ? inspectCredentialFile(real.GOOGLE_APPLICATION_CREDENTIALS) : null;
  const adcFile = inspectCredentialFile(adcPath(env));
  const vertex = vertexCredentialState({ env: real, serviceAccountFile, adcFile });
  if (real.GEMINI_API_KEY) return { connected: true, state: "key", source: "GEMINI_API_KEY", detail: null };
  const connected = hasGeminiCredentials({ env: real, vertex });
  // A Google Cloud sign-in with no project chosen for it: Flash cannot run on it, so it is not "connected". The
  // project is where the model server and Google's own library look (googleProject).
  if (connected && !googleProject(env)) return { connected: false, state: "no-project", source: vertex.source, detail: "no Google Cloud project is set for this sign-in" };
  return { connected, state: vertex.state, source: vertex.source, detail: vertex.detail };
}

/**
 * The Google Cloud project a sign-in uses, or null: GOOGLE_CLOUD_PROJECT; else the sign-in file's
 * own (quota_project_id for a gcloud login, project_id for a service account), as the model server reads it
 * (plugin/mcp/model-dispatch/src/adapters/geminiTransports.ts resolveGcpProject); else gcloud's own configuration
 * (`gcloud config set project`), where Google's auth library looks next. Read from files only; nothing is run. A copy
 * of the mmo plugin's rule (plugin/scripts/ambient/lib/route-flow.mjs googleProject); tools/test/zero-touch-google.test.mjs
 * keeps them agreeing.
 */
export function googleProject(env = process.env) {
  const real = usableEnv(env);
  if (real.GOOGLE_CLOUD_PROJECT) return real.GOOGLE_CLOUD_PROJECT;
  try {
    const file = JSON.parse(readFileSync(real.GOOGLE_APPLICATION_CREDENTIALS || adcPath(env), "utf8"));
    const p = file?.quota_project_id ?? file?.project_id;
    if (typeof p === "string" && p.trim()) return p.trim();
  } catch { /* no file, or not one this can read */ }
  try {
    const home = env.HOME && env.HOME.trim() ? env.HOME : homedir();
    const dir = env.CLOUDSDK_CONFIG && env.CLOUDSDK_CONFIG.trim() ? env.CLOUDSDK_CONFIG : join(home, ".config", "gcloud");
    let name = "default";
    try { name = readFileSync(join(dir, "active_config"), "utf8").trim() || "default"; } catch { /* the default configuration */ }
    const ini = readFileSync(join(dir, "configurations", `config_${name}`), "utf8");
    let core = false;
    for (const line of ini.split("\n")) {
      const t = line.trim();
      if (t.startsWith("[")) core = t === "[core]";
      else if (core) { const m = /^project\s*=\s*(\S+)/.exec(t); if (m) return m[1]; }
    }
  } catch { /* no gcloud configuration */ }
  return null;
}

/**
 * What gcloud says when Google itself turned the sign-in down (an expired, revoked or reset login), as opposed to
 * not being reached at all (no network, a proxy, a timeout), which says nothing about the sign-in.
 */
const SIGN_IN_REFUSED = /invalid_grant|invalid_rapt|reauth|re-?authenticat|expired|revoked|has been disabled|please run|gcloud auth (application-default )?login/i;

/**
 * The one real check, when settings that use Flash are saved: "works", "refused" (Google turned the sign-in down) or
 * "unknown" (nothing to test with: no gcloud, a login this test does not cover, or Google could not be reached).
 * Never throws. `detail` (gcloud's first line) is for Claude's notes only: the person never reads raw output.
 */
export function onlineCheck(env = process.env, { run = spawnSync } = {}) {
  const s = googleState(env);
  // A sign-in with no project is not a refused sign-in: nothing here to test it with.
  if (!s.connected) return s.state === "no-project" ? { result: "unknown", detail: null } : { result: "refused", detail: s.detail };
  if (s.state !== "credential" || s.source !== "gcloud ADC file") return { result: "unknown", detail: null };
  try {
    const r = run("gcloud", ["auth", "application-default", "print-access-token"], { encoding: "utf8", timeout: 3000, env, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error) return { result: "unknown", detail: null };
    if (r.status === 0 && String(r.stdout ?? "").trim()) return { result: "works", detail: null };
    const detail = String(r.stderr ?? "").trim().split("\n").find(Boolean)?.slice(0, 200) ?? null;
    return { result: SIGN_IN_REFUSED.test(String(r.stderr ?? "")) ? "refused" : "unknown", detail };
  } catch {
    return { result: "unknown", detail: null };
  }
}

/** The Google settings the model server reads (plugin/mcp/model-dispatch/src/adapters/geminiEndpoint.ts). */
export const GOOGLE_VARS = ["GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "GEMINI_BACKEND"];
/** The shell's own start-up files, where a terminal user usually sets them. */
const SHELL_FILES = [".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc", ".profile"];

/**
 * The Google settings set in the shell's start-up files but not in this process: they reach a chat started from a
 * terminal, never one in the Claude app, which reads Claude's own settings file only. Only the names are read, never
 * a value.
 */
export function shellOnlyGoogle(env = process.env, { read = readFileSync } = {}) {
  const home = env.HOME && env.HOME.trim() ? env.HOME : homedir();
  const found = new Set();
  for (const f of SHELL_FILES) {
    let text;
    try { text = read(join(home, f), "utf8"); } catch { continue; }
    for (const name of GOOGLE_VARS) {
      if (!usableEnv(env)[name] && new RegExp(`^\\s*(?:export\\s+)?${name}=`, "m").test(text)) found.add(name);
    }
  }
  return [...found];
}

/** Everything the setup check says about Google: the offline answer, plus the settings only the terminal sees. */
export function googleReadiness(env = process.env) {
  const g = googleState(env);
  return g.connected ? g : { ...g, shellOnly: shellOnlyGoogle(env) };
}
