/**
 * The cost recording a zero-touch workflow or hand-off starts with, from whether a Claude typist can log in.
 *
 * Why: zero-touch starts workflows and hand-offs with `auth=estimated` (config/ambient.default.json), which means the
 * run is on the person's Claude login: the model server's Claude typist, a `claude -p` child, is then given no
 * ANTHROPIC_API_KEY (typists.ts leanOpusEnv), so it never bills an API key the person did not mean to use. A person
 * whose only Claude credential is an API key exported in their shell (no subscription login on this computer) would
 * then have a typist with no login at all, and every Claude typist would fail. So, for such a person only, zero-touch
 * starts with `auth=vendor`, which hands the typist the key (the same bill as their own chat). Everyone else keeps
 * `auth=estimated`.
 *
 * How it is known, at no cost: `claude auth status --json` (no model call) run with exactly the environment the typist
 * gets in estimated mode. It runs only when ANTHROPIC_API_KEY is set (without one there is nothing else to use), once
 * per chat (kept in the chat's folder, `claude_login.json`); when the check cannot answer (no `claude`, a timeout,
 * output it does not understand), nothing changes. A key in `~/.claude/settings.json`'s `env`, or an `apiKeyHelper`,
 * reaches the typist through those settings, so its check says "logged in" and nothing changes either.
 *
 * mmo's typist is left as it is (zero-touch is a strict add-on: a typed `/mmo:` command keeps its own `--auth`).
 * The environment and the `claude` program are mmo's own rules, copied: TYPIST_ENV_* mirrors typists.ts
 * LEAN_OPUS_ENV_ALLOW and CLAUDE_ROUTING_PREFIXES, and findClaude mirrors claudeCommand.ts;
 * tools/test/zero-touch-claude-login.test.mjs reads typists.ts and keeps the lists equal.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { ensureSessionDir, sessionDir } from "./paths.mjs";

const CHILD_BASE = ["HOME", "PATH", "USER", "LOGNAME", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"];
const CHILD_NETWORK = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];
const CLAUDE_ROUTING = [
  "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY", "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL", "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "ANTHROPIC_VERTEX_BASE_URL", "CLOUD_ML_REGION", "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG",
  "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
];
/** The variables a Claude typist gets in estimated mode (typists.ts LEAN_OPUS_ENV_ALLOW), and the families it gets. */
export const TYPIST_ENV_ALLOW = [...CHILD_BASE, ...CHILD_NETWORK, "CLAUDE_CONFIG_DIR", ...CLAUDE_ROUTING];
export const TYPIST_ENV_PREFIXES = ["AWS_", "VERTEX_REGION_", "ANTHROPIC_FOUNDRY_"];

/** The environment a Claude typist runs with in estimated mode: no ANTHROPIC_API_KEY. */
export function typistEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (TYPIST_ENV_ALLOW.includes(k) || TYPIST_ENV_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

const executable = (file) => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } };

/** The `claude` program the model server runs (claudeCommand.ts findClaude): first on PATH, else the Claude app's newest copy. */
export function findClaude(env = process.env, platform = process.platform) {
  for (const dir of String(env.PATH ?? "").split(delimiter)) if (dir && executable(join(dir, "claude"))) return join(dir, "claude");
  if (platform !== "darwin") return null;
  const base = join(env.HOME?.trim() || homedir(), "Library", "Application Support", "Claude", "claude-code");
  let versions = [];
  try { versions = readdirSync(base).filter((v) => /^\d+(\.\d+)*$/.test(v)); } catch { return null; }
  versions.sort((a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0); return 0; });
  for (const v of versions) {
    const file = join(base, v, "claude.app", "Contents", "MacOS", "claude");
    if (executable(file)) return file;
  }
  return null;
}

/** How long the check may take: Claude Code's start-up, measured at about 0.7 s. */
export const CHECK_TIMEOUT_MS = 5000;

/**
 * Whether a Claude typist would be logged in: { loggedIn: true | false, method } from `claude auth status --json` run
 * as the typist runs, or { loggedIn: null } when that cannot be told. Never reads a credential itself.
 */
export function typistLogin(env = process.env, { run = spawnSync, claude = findClaude(env) } = {}) {
  if (!claude) return { loggedIn: null, method: null };
  let r;
  try { r = run(claude, ["auth", "status", "--json"], { env: typistEnv(env), encoding: "utf8", timeout: CHECK_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }); } catch { return { loggedIn: null, method: null }; }
  let status;
  try { status = JSON.parse(String(r?.stdout ?? "")); } catch { return { loggedIn: null, method: null }; }
  if (!status || typeof status.loggedIn !== "boolean") return { loggedIn: null, method: null };
  return { loggedIn: status.loggedIn, method: typeof status.authMethod === "string" ? status.authMethod : null };
}

const RECORD = "claude_login.json";

/**
 * The `auth` a zero-touch start in this chat carries: "vendor" when the configuration says so, or when an API key is
 * set and a typist would have no login without it; otherwise "estimated". A definite answer is kept for the chat.
 */
export function chatAuth(sid, configured, env = process.env, deps = {}) {
  if (configured === "vendor") return "vendor";
  const key = typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim() !== "";
  if (!key) return "estimated";
  let kept = null;
  try { kept = JSON.parse(readFileSync(join(sessionDir(sid, env), RECORD), "utf8")); } catch { /* not checked yet */ }
  if (!kept || typeof kept.logged_in !== "boolean") {
    const login = typistLogin(env, deps);
    if (typeof login.loggedIn !== "boolean") return "estimated";
    kept = { logged_in: login.loggedIn, method: login.method, at: new Date().toISOString() };
    try { writeFileSync(join(ensureSessionDir(sid, env), RECORD), JSON.stringify(kept), { mode: 0o600 }); } catch { /* asked again next time */ }
  }
  return kept.logged_in === false ? "vendor" : "estimated";
}
