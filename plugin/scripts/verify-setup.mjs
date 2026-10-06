#!/usr/bin/env node
/**
 * Offline check + repair for an installed plugin. `/plugin install` reports
 * success even when dist/ and node_modules/ are missing; this script proves
 * the dispatch path is real and, with --fix, builds it.
 *
 * Locates the plugin from its own path (<pluginRoot>/scripts/ → up one) so
 * the same file works from the plugin cache or from a git clone.
 *
 * Usage:
 *   node verify-setup.mjs                  check + report; exit 1 if unusable
 *   node verify-setup.mjs --fix            check, repair, re-check
 *   node verify-setup.mjs --enable-agent   route mechanical tier to the agent
 *                                          and build what it needs (implies --fix)
 *   node verify-setup.mjs --disable-agent  back to the model path
 *   ...--user                              machine-wide instead of this folder
 */

import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ─── pure helpers ─────────────────────────────────────────────────────

/** Major version from a `process.versions.node` string ("20.11.1" → 20). */
export function nodeMajorFrom(versionString) {
  const major = parseInt(String(versionString).split(".")[0], 10);
  return Number.isNaN(major) ? 0 : major;
}

/**
 * Path gcloud writes ADC to. Duplicated with `defaultAdcPath` in
 * geminiTransports.ts (this script runs before `npm ci` and cannot import TS).
 * Sync by hand.
 */
export function adcPath(home = homedir()) {
  return join(home, ".config", "gcloud", "application_default_credentials.json");
}

/**
 * plugin.json's declared env pass-throughs. Sync by hand with
 * PLUGIN_DECLARED_ENV in env.ts (same pre-`npm ci` constraint as adcPath).
 */
export const DECLARED_ENV = [
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GEMINI_BACKEND",
  "MMO_SELECT",
  "SDLC_SELECT", // MMO-D8 compat shim — pre-rename installs still export this
  "GEMINI_WORKER_PYTHON",
  "MMO_LOG_LEVEL",
  "MMO_VERBOSE",
  "MMO_LOG_PREFIX",
];

/** `${NAME}` and nothing else. Anchored so a real value with `$` survives. */
export function isUnexpandedPlaceholder(value) {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(String(value ?? "").trim());
}

/** Copy of `env` with unusable values dropped. Non-mutating — this script only reports. */
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

/** Declared variables that reached us as unexpanded placeholders, in declaration order. */
export function unexpandedDeclaredEnv(env = {}) {
  return DECLARED_ENV.filter((name) => isUnexpandedPlaceholder(env[name]));
}

/**
 * Where a variable must be set for the plugin to see it. One constant to
 * keep the fix strings from drifting apart — a shell export is not enough
 * on the desktop-app path.
 */
export const ENV_ADVICE =
  "the `env` block of ~/.claude/settings.json — a shell export is not enough, because " +
  "Claude Code launched from the desktop app inherits no login shell";

/**
 * Credential types google-auth accepts in an ADC-shaped JSON file, and the
 * fields each one is useless without. Answers "is the configured credential
 * ACTUALLY a credential" — existsSync accepts a truncated key. Unlisted
 * types are treated as USABLE: this list proves brokenness, never guesses it.
 */
export const CREDENTIAL_REQUIRED_FIELDS = {
  authorized_user: ["client_id", "client_secret", "refresh_token"],
  service_account: ["client_email", "private_key"],
  external_account: ["audience", "subject_token_type", "token_url"],
  impersonated_service_account: ["service_account_impersonation_url", "source_credentials"],
};

/**
 * `usable: false` only when CERTAIN (missing, unparseable, no type, or a
 * recognised type missing a required field). Unrecognised types come back
 * usable — a checker that invents failures is worse than one that misses them.
 * Expiry not checked (offline can't tell live from revoked; each run's start
 * check, which sends one test call through every typist, covers that). Readers
 * injected for offline testing.
 */
export function inspectCredentialFile(path, { exists = existsSync, read = readFileSync } = {}) {
  if (!path) return { present: false, usable: false, type: null, detail: null };
  if (!exists(path)) {
    return { present: false, usable: false, type: null, detail: `${path} does not exist` };
  }

  let parsed;
  try {
    parsed = JSON.parse(read(path, "utf8"));
  } catch (err) {
    return { present: true, usable: false, type: null, detail: `${path} is not valid JSON (${err.message})` };
  }

  const type = typeof parsed?.type === "string" ? parsed.type.trim() : null;
  if (!type) {
    return {
      present: true,
      usable: false,
      type: null,
      detail: `${path} has no "type" field, so no Google auth library can tell what kind of credential it is`,
    };
  }

  const required = CREDENTIAL_REQUIRED_FIELDS[type];
  if (!required) {
    return { present: true, usable: true, type, detail: `credential type '${type}' is not one this check knows how to verify` };
  }

  const missing = required.filter((field) => !parsed[field]);
  if (missing.length > 0) {
    return {
      present: true,
      usable: false,
      type,
      detail: `${path} is a '${type}' credential but is missing ${missing.join(", ")}`,
    };
  }

  return { present: true, usable: true, type, detail: null };
}

/**
 * Vertex/Gemini credential state in four values, not yes/no.
 *   credential   — real signing credential, looks complete.
 *   broken       — configured and definitely unusable.
 *   project-only — GOOGLE_CLOUD_PROJECT set alone. Works inside Google Cloud
 *                  (metadata server supplies the credential); laptop = dead end.
 *   none         — no door.
 *
 * Precedence matches google-auth: an explicit GOOGLE_APPLICATION_CREDENTIALS
 * wins, and a broken one is fatal (library doesn't fall back either).
 */
export function vertexCredentialState({ env = {}, serviceAccountFile = null, adcFile = null } = {}) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    if (serviceAccountFile?.usable) {
      return { state: "credential", source: "GOOGLE_APPLICATION_CREDENTIALS", detail: serviceAccountFile.detail };
    }
    return {
      state: "broken",
      source: "GOOGLE_APPLICATION_CREDENTIALS",
      detail:
        serviceAccountFile?.detail ??
        `GOOGLE_APPLICATION_CREDENTIALS points at ${env.GOOGLE_APPLICATION_CREDENTIALS}, which cannot be read`,
    };
  }

  if (adcFile?.usable) return { state: "credential", source: "gcloud ADC file", detail: adcFile.detail };
  if (adcFile?.present) return { state: "broken", source: "gcloud ADC file", detail: adcFile.detail };
  if (env.GOOGLE_CLOUD_PROJECT) return { state: "project-only", source: "GOOGLE_CLOUD_PROJECT", detail: null };
  return { state: "none", source: null, detail: null };
}

/** Fallback when a caller only knows "is there an ADC file". */
function assumedVertexState(env, hasAdcFile) {
  return vertexCredentialState({
    env,
    serviceAccountFile: env.GOOGLE_APPLICATION_CREDENTIALS
      ? { present: true, usable: true, type: null, detail: null }
      : null,
    adcFile: { present: hasAdcFile, usable: hasAdcFile, type: null, detail: null },
  });
}

/**
 * Any door into Gemini open. Mirrors selectGeminiBackend precedence.
 * Callers pass an env already through usableEnv() — one place to decide
 * what "real value" means.
 */
export function hasGeminiCredentials({ env = {}, vertex = null } = {}) {
  return Boolean(env.GEMINI_API_KEY || vertex?.state === "credential");
}

/**
 * The paths that decide whether the MCP dispatch path is real. The plugin ships its server and the code its scripts
 * load as pre-built, committed bundles (bundle/server.mjs, bundle/lib.mjs: see
 * mcp/model-dispatch/scripts/bundle.mjs), so a GitHub install needs nothing installed or built; dist/ and
 * node_modules/ matter only to a copy without them (a damaged install, or a clone being developed).
 */
export function mcpPaths(pluginRoot) {
  const serverDir = join(pluginRoot, "mcp", "model-dispatch");
  return {
    serverDir,
    bundleEntry: join(serverDir, "bundle", "server.mjs"),
    bundleLib: join(serverDir, "bundle", "lib.mjs"),
    distEntry: join(serverDir, "dist", "server.js"),
    nodeModules: join(serverDir, "node_modules"),
  };
}

/**
 * Agent leaf id + slot. Literal because this runs pre-`npm ci`. Sync by hand
 * with opus-plus-flash.yaml — rename there = rename here, else this check
 * silently stops firing.
 */
export const AGENT_WORKER_MODEL_ID = "flash-agsdk-worker";
export const AGENT_WORKER_SLOT = "gemini-flash";

/** Full valid spec that selects the agent path. Never assembled by hand. */
export const AGENT_WORKER_SELECT = `${AGENT_WORKER_SLOT}=${AGENT_WORKER_MODEL_ID}`;

/**
 * Mirrors parseSelectOverrides in routing.ts (same validity rule; duplication
 * forced by pre-`npm ci` constraint). Malformed → blocking, or the leaf name
 * alone would silently look "green" here and throw at policy load.
 */
export function parseSelectSpec(spec) {
  const pairs = {};
  const invalid = [];
  if (!spec || !String(spec).trim()) return { pairs, invalid };
  for (const part of String(spec).split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf("=");
    if (eq <= 0 || eq === piece.length - 1) {
      invalid.push(piece);
      continue;
    }
    pairs[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim();
  }
  return { pairs, invalid };
}

/**
 * Duplicated from workerProcess.ts's workerVenvPython (pre-`npm ci`
 * constraint). If they disagree, that one is authoritative.
 */
export function workerPaths(pluginRoot) {
  const workerDir = join(pluginRoot, "mcp", "model-dispatch", "worker");
  return {
    workerDir,
    venvPython: join(workerDir, ".venv", "bin", "python"),
    requirements: join(workerDir, "requirements.txt"),
  };
}

/**
 * Has this install selected the agent? Gates Python/venv/SDK checks so
 * model-path installs never get false alarms. Parsed as pairs, not
 * `includes()` — a slot named after the leaf would otherwise read as a
 * selection OF it.
 */
export function selectsAgentWorker(env = {}) {
  const { pairs } = parseSelectSpec(usableEnv(env).MMO_SELECT);
  return Object.values(pairs).includes(AGENT_WORKER_MODEL_ID);
}

/** Blocking finding for a spec the server will refuse to parse. */
export function selectSpecProblem(env = {}) {
  const spec = usableEnv(env).MMO_SELECT;
  const { invalid } = parseSelectSpec(spec);
  if (invalid.length === 0) return null;

  // Bare leaf name deserves a specific message — fix is "one word short",
  // not "read the syntax".
  const bareLeaf = invalid.includes(AGENT_WORKER_MODEL_ID);
  return {
    id: "select-spec",
    severity: "blocking",
    message:
      `MMO_SELECT is set to '${spec}', which is not a valid selection. ` +
      `Each entry must be spelled 'slot=option'; ${invalid
        .map((p) => `'${p}'`)
        .join(", ")} ${invalid.length === 1 ? "is" : "are"} not.` +
      (bareLeaf
        ? ` '${AGENT_WORKER_MODEL_ID}' is the option, not the whole selection — it needs the slot in front of it.`
        : ""),
    fix:
      `Set it to '${AGENT_WORKER_SELECT}' for the agent path, or remove it for the model path. ` +
      `Re-run this script with --enable-agent to have it written correctly for you.`,
  };
}

/**
 * Can the agent path work? Only `credential` counts — `project-only`
 * authenticates nothing off Google's fleet; `broken` cannot sign.
 */
export function hasVertexCredentials(vertex = null) {
  return vertex?.state === "credential";
}

// ─── the claude CLI's flags ───────────────────────────────────────────

/**
 * The flags the greenfield executor's lean Opus typist passes to `claude -p`, at the effort typing always
 * sets. The server's executor/typists.ts (LEAN_OPUS_NEEDS, leanOpusCliProblem) holds the rule; this
 * script runs before the server is built and cannot import it.
 */
export const LEAN_OPUS_FLAGS = ["--tools", "--append-system-prompt-file", "--effort"];

/**
 * Whether `claude --help` offers `flag`, read as the server's cliLists() reads it: as its own option, or
 * folded into a sibling's description as `--name[-file]`, the only way some releases list
 * --append-system-prompt-file.
 */
export function cliLists(helpText, flag) {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  if (new RegExp(`(^|\\s)${esc(flag)}(\\s|,|$)`, "m").test(helpText)) return true;
  const m = flag.match(/^(--.+)-file$/);
  return !!m && helpText.includes(`${m[1]}[-file]`);
}

/** The lean Opus typist's flags that `claude --help` does not list. */
export const missingLeanOpusFlags = (helpText) => LEAN_OPUS_FLAGS.filter((f) => !cliLists(String(helpText ?? ""), f));

/**
 * Facts → ordered problem list. Pure. `blocking` fails the exit code;
 * `warning` limits which policies run.
 */
export function evaluate({
  nodeMajor,
  hasClaudeCli,
  hasNodeModules,
  hasDist,
  /** Both pre-built bundles are present: the server and its scripts' code need nothing installed or built. */
  hasBundle = false,
  hasAdcFile = false,
  env = {},
  /** vertexCredentialState result, or null to infer from `hasAdcFile`. */
  vertex = null,
  /** Defaults to true — only observed absence is worth naming. */
  hasGcloud = true,
  /** {hasVenv, sdkImportable, detail} or null when this install didn't ask for the agent. */
  agentWorker = null,
  /** `claude --help` as read: {text}, {error} when it failed, or null when it was not read. */
  claudeHelp = null,
}) {
  const problems = [];

  if (nodeMajor < 20) {
    problems.push({
      id: "node-version",
      severity: "blocking",
      message: `Node ${nodeMajor || "unknown"} detected; this plugin needs Node 20 or newer.`,
      fix: "Install the current LTS from https://nodejs.org (or `nvm install --lts`).",
    });
  }

  if (!hasClaudeCli) {
    problems.push({
      id: "claude-cli",
      severity: "blocking",
      message: "Claude Code CLI not found (not on PATH, and no copy from the Claude app).",
      fix: "npm install -g @anthropic-ai/claude-code",
    });
  }

  // A warning, not a block: every run whose files the typists type (a new-app build, a brownfield run) types its Claude
  // attempts through this CLI, but whether a run types with Claude depends on its policy, which the run's own pre-flight
  // checks (preflight_dispatch with executor: true halts such a run before anything is spent).
  if (hasClaudeCli && claudeHelp) {
    const missing = claudeHelp.error != null ? null : missingLeanOpusFlags(claudeHelp.text);
    if (missing === null || missing.length > 0) {
      problems.push({
        id: "claude-cli-flags",
        severity: "warning",
        message:
          (missing === null
            ? `\`claude --help\` failed (${String(claudeHelp.error).slice(0, 200)}), so this check cannot tell whether the claude CLI lists ${LEAN_OPUS_FLAGS.join(", ")}. `
            : `This machine's claude CLI lists no ${missing.join(", ")} flag${missing.length > 1 ? "s" : ""}. `) +
          "A new-app build and a brownfield run type files with Claude through it — the lean Opus typist, also every file's last " +
          "attempt when the policy has a Claude model — and cannot type with Claude until the CLI lists them; the run's pre-flight " +
          "stops such a run before anything is spent.",
        fix: `Update Claude Code (\`claude update\`) until \`claude --help\` lists ${LEAN_OPUS_FLAGS.join(", ")}.`,
      });
    }
  }

  // The two artifacts a copy without the pre-built bundles lacks. --fix repairs both (npm ci, then the build, which
  // also writes the bundles). With the bundles there is nothing to repair.
  if (!hasBundle && !hasNodeModules) {
    problems.push({
      id: "mcp-dependencies",
      severity: "blocking",
      message: "The bundled MCP server has no installed dependencies.",
      fix: "Re-run this script with --fix (runs `npm ci` in the server directory).",
    });
  }

  // The plugin manifest starts bundle/server.mjs, so a copy with only dist/ still cannot dispatch.
  if (!hasBundle) {
    problems.push({
      id: "mcp-build",
      severity: "blocking",
      message:
        "The plugin's pre-built server (bundle/server.mjs and bundle/lib.mjs) is missing, so model dispatch would fail " +
        "partway through a run, and the run-start check and hand-offs cannot load.",
      fix:
        "A plugin installed from its marketplace always has it: reinstall the plugin. In a clone, re-run this script " +
        "with --fix (runs `npm ci` and `npm run build`, which writes the bundle).",
    });
  }

  // Discard placeholder-looking values once so no downstream check is fooled.
  const declaredPlaceholders = unexpandedDeclaredEnv(env);
  const realEnv = usableEnv(env);
  const vertexState = vertex ?? assumedVertexState(realEnv, hasAdcFile);

  // Every gcloud-recommending fix goes through this so a machine without
  // gcloud is told once, when it matters.
  const gcloudLogin = hasGcloud
    ? "`gcloud auth application-default login`"
    : "`gcloud auth application-default login` — but gcloud is not on this machine's PATH, " +
      "so install it first: https://cloud.google.com/sdk/docs/install";

  if (declaredPlaceholders.length > 0) {
    problems.push({
      id: "env-placeholders",
      severity: "warning",
      message:
        `${declaredPlaceholders.length} plugin environment variable(s) arrived unset and unexpanded ` +
        `(${declaredPlaceholders.join(", ")}). The server strips these at startup and falls back to ` +
        "Application Default Credentials, so this is not itself a failure — but if you meant to set " +
        "any of them, the value is not reaching the plugin.",
      fix:
        "Set them where Claude Code itself will see them — the `env` block of ~/.claude/settings.json — " +
        "not just in a terminal profile. Claude Code launched from the desktop app inherits no login shell.",
    });
  }

  // Credentials reported, never written by this script.
  if (!realEnv.ANTHROPIC_API_KEY) {
    problems.push({
      id: "anthropic-key",
      severity: "warning",
      message:
        "ANTHROPIC_API_KEY is not set. Vendor-billed runs need it; a Claude Code subscription covers " +
        "subscription-auth runs without it.",
      fix: `Get a key at https://console.anthropic.com/settings/keys and put it in ${ENV_ADVICE}.`,
    });
  }

  // Reported before the "have you got one" question below — that would answer
  // "yes" and leave a green light over a file that cannot sign.
  if (vertexState.state === "broken") {
    problems.push({
      id: "gemini-credentials-broken",
      severity: "blocking",
      message:
        `A Google credential is configured but is not usable: ${vertexState.detail}. ` +
        "This is not a missing credential — it is a present one that no Google auth library can load, " +
        "so every Gemini dispatch would fail at the moment it tries to sign.",
      fix:
        (realEnv.GOOGLE_APPLICATION_CREDENTIALS
          ? `Point GOOGLE_APPLICATION_CREDENTIALS at a complete service-account key, or unset it and run ${gcloudLogin} instead. ` +
            "An explicit GOOGLE_APPLICATION_CREDENTIALS takes precedence over the gcloud file, so leaving a broken one set " +
            "hides a working login."
          : `Run ${gcloudLogin} to write a fresh credentials file over the unusable one.`) +
        // AI Studio door named because this finding stands in for the generic
        // "no credentials" warning.
        ` The AI Studio path is the other way in, if you would rather not fix this one: get a key at ` +
        `https://aistudio.google.com/app/apikey and put it in ${ENV_ADVICE}.`,
    });
  }

  // Broken is excluded — hasGeminiCredentials returns false for it, but the
  // blocking finding above already covers it; a second finding here would
  // flatly contradict the first.
  if (
    vertexState.state !== "broken" &&
    !hasGeminiCredentials({ env: realEnv, vertex: vertexState })
  ) {
    // project-only vs nothing: the former reads as "credentials done" and is
    // the one that hurts.
    const projectOnly = vertexState.state === "project-only";
    problems.push({
      id: "gemini-credentials",
      severity: "warning",
      message: projectOnly
        ? `GOOGLE_CLOUD_PROJECT is set to '${realEnv.GOOGLE_CLOUD_PROJECT}' but no credential was found. ` +
          "A project ID says where to bill, not who is asking. On a Google-hosted machine the credential comes " +
          "from the metadata server and this check cannot see it, so this may be fine; anywhere else, policies " +
          "that route mechanical phases to Gemini will abort at the first dispatch."
        : "No Gemini credentials found. Policies that route mechanical phases to Gemini will abort at the " +
          "first dispatch; Claude-only policies are unaffected.",
      fix:
        `Either run ${gcloudLogin} for Gemini Enterprise Agent Platform (formerly Vertex AI) — it writes a ` +
        "credentials file, so it needs no environment variable at all, and GOOGLE_CLOUD_PROJECT only if the " +
        `account has several projects. Or, for the AI Studio path, get a key at ` +
        `https://aistudio.google.com/app/apikey and put it in ${ENV_ADVICE}.` +
        (projectOnly
          ? " If this machine runs inside Google Cloud, it may be fine: each run's start check sends one test call through " +
            "every model that types the run and stops the run there, before any paid phase, if the credential cannot be used."
          : ""),
    });
  }

  // A malformed spec first — while it is bad, the agent path is neither on
  // nor off and every other message about it would guess.
  const specProblem = selectSpecProblem(realEnv);
  if (specProblem) problems.push(specProblem);

  // Agent selected with no Vertex credential. The worker is ADC-only; a
  // GEMINI_API_KEY doesn't help.
  if (selectsAgentWorker(realEnv) && !hasVertexCredentials(vertexState)) {
    // project-only left non-blocking: it's a working setup inside Google Cloud
    // (metadata-server credential) and a dead end on a laptop, and this script
    // cannot tell the two apart offline.
    const unproven = vertexState.state === "project-only";
    problems.push({
      id: unproven ? "agent-worker-credentials-unproven" : "agent-worker-credentials",
      severity: unproven ? "warning" : "blocking",
      message:
        `MMO_SELECT routes the mechanical tier to '${AGENT_WORKER_MODEL_ID}', which reaches Gemini ` +
        "through Gemini Enterprise Agent Platform (formerly Vertex AI) and application default " +
        "credentials only. " +
        (unproven
          ? `This install names a project ('${realEnv.GOOGLE_CLOUD_PROJECT}') but has no credential this ` +
            "check can see. If it is not running inside Google Cloud, every delegated task will fail to " +
            "authenticate, and each run's start check stops the run on it."
          : "This install has no credential for it" +
            (realEnv.GEMINI_API_KEY
              ? " — GEMINI_API_KEY is the AI Studio path, and the agent worker has no way to use it."
              : ".") +
            " Every delegated task would fail to authenticate."),
      fix: unproven
        ? "Inside Google Cloud this may be fine: each run's start check sends one test call through the agent and stops " +
          `the run there, before any paid phase, if it cannot authenticate. Anywhere else, run ${gcloudLogin}.`
        : `Run ${gcloudLogin}, and set GOOGLE_CLOUD_PROJECT if the account has several projects. ` +
          "To stay on the model path instead, which does work with an AI Studio key, re-run this " +
          "script with --disable-agent.",
    });
  }

  // Agent-path prerequisites. Blocking — this install has already declared
  // it will route work there, and the adapter constructor throws without them.
  if (agentWorker) {
    if (!agentWorker.hasVenv) {
      problems.push({
        id: "agent-worker-python",
        severity: "blocking",
        message:
          `MMO_SELECT routes the mechanical tier to '${AGENT_WORKER_MODEL_ID}', which runs a Python ` +
          "agent worker, but the worker has no Python environment. Every mechanical task would fail.",
        // --fix first: it works on both install routes. `node tools/setup.mjs`
        // exists only in a clone.
        fix:
          "Re-run this check with --fix, which builds the environment. On a clone, " +
          "`node tools/setup.mjs` does the same and asks first. Or set GEMINI_WORKER_PYTHON " +
          "to a Python >= 3.10 that already has google-antigravity installed. " +
          "To go back to the model path instead, remove MMO_SELECT.",
      });
    } else if (!agentWorker.sdkImportable) {
      problems.push({
        id: "agent-worker-sdk",
        severity: "blocking",
        message:
          "The agent worker's Python environment exists but cannot import google.antigravity" +
          (agentWorker.detail ? ` (${agentWorker.detail})` : "") +
          ". The interpreter starts and then dies at its first import, inside a subprocess, " +
          "which is a much harder failure to read than this line.",
        // --fix rebuilds with `venv --clear`; nothing to delete by hand.
        fix:
          "Re-run this check with --fix, which rebuilds the environment from scratch. " +
          "The commonest cause is an environment built against an interpreter that has since " +
          "been upgraded or removed.",
      });
    }
  }

  return { ok: problems.every((p) => p.severity !== "blocking"), problems };
}

// ─── observation + repair ──────────────────────────────────────────────

function onPath(cmd) {
  return spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
}

/**
 * The `claude` program the model server runs (src/claudeCommand.ts findClaude, the same rule): the first on PATH, else
 * the Claude app's newest copy on macOS, else null, so on a Mac with only the Claude app this check finds the copy the
 * server runs. tools/test/zero-touch-readiness.test.mjs runs the three rules side by side.
 */
export function findClaude(env = process.env, platform = process.platform) {
  const executable = (file) => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } };
  for (const dir of String(env.PATH ?? "").split(platform === "win32" ? ";" : ":")) if (dir && executable(join(dir, "claude"))) return join(dir, "claude");
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

/** `claude --help`, read as the server reads it (its standard output, a zero exit), for evaluate's claudeHelp. */
function readClaudeHelp(claude = "claude") {
  const r = spawnSync(claude, ["--help"], { encoding: "utf8", timeout: 30_000 });
  if (r.error) return { error: r.error.message };
  if (r.status !== 0) return { error: `exit ${r.status ?? r.signal}${r.stderr?.trim() ? `: ${r.stderr.trim().split("\n").pop()}` : ""}` };
  return { text: r.stdout ?? "" };
}

/**
 * Import attempted, not inferred from directory presence — a venv built
 * against an upgraded/uninstalled interpreter looks healthy on disk and
 * fails on its first import.
 */
function observeAgentWorker(pluginRoot, env) {
  if (!selectsAgentWorker(env)) return null;

  const override = usableEnv(env).GEMINI_WORKER_PYTHON;
  const python = override || workerPaths(pluginRoot).venvPython;
  if (!existsSync(python)) return { hasVenv: false, sdkImportable: false, detail: null };

  const probe = spawnSync(python, ["-c", "import google.antigravity"], { encoding: "utf8" });
  if (probe.status === 0) return { hasVenv: true, sdkImportable: true, detail: null };
  // Last line of a traceback is the exception.
  const stderr = (probe.stderr || "").trim().split("\n").filter(Boolean).pop() ?? null;
  return { hasVenv: true, sdkImportable: false, detail: stderr };
}

/**
 * `env` is a parameter so `--enable-agent` can pass in the selection it just
 * wrote (settings files aren't read until the next Claude Code session).
 */
function observe(pluginRoot, env = process.env) {
  const { nodeModules, distEntry, bundleEntry, bundleLib } = mcpPaths(pluginRoot);
  // Credential files are opened and read, not merely stat-ed — a truncated
  // key or a path to a deleted file passes existsSync and fails a real call.
  const realEnv = usableEnv(env);
  const adcFile = adcPath();
  const claude = findClaude(env);
  const hasClaudeCli = Boolean(claude);
  return {
    nodeMajor: nodeMajorFrom(process.versions.node),
    hasClaudeCli,
    claudeHelp: claude ? readClaudeHelp(claude) : null,
    hasGcloud: onPath("gcloud"),
    hasNodeModules: existsSync(nodeModules),
    hasDist: existsSync(distEntry),
    hasBundle: existsSync(bundleEntry) && existsSync(bundleLib),
    hasAdcFile: existsSync(adcFile),
    vertex: vertexCredentialState({
      env: realEnv,
      serviceAccountFile: realEnv.GOOGLE_APPLICATION_CREDENTIALS
        ? inspectCredentialFile(realEnv.GOOGLE_APPLICATION_CREDENTIALS)
        : null,
      adcFile: inspectCredentialFile(adcFile),
    }),
    env,
    agentWorker: observeAgentWorker(pluginRoot, env),
  };
}

/** `npm ci`, not `npm install` — resolve exactly the verified lockfile. */
function repair(pluginRoot, log) {
  const { serverDir } = mcpPaths(pluginRoot);
  for (const [label, args] of [
    ["installing dependencies", ["ci"]],
    ["building the server", ["run", "build"]],
  ]) {
    log(`  → ${label} (npm ${args.join(" ")})`);
    const result = spawnSync("npm", args, { cwd: serverDir, encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) {
      log(`  ✗ ${label} failed:\n${(result.stderr || result.stdout || "").trim()}`);
      return false;
    }
  }
  return true;
}

/** google-antigravity requires-python >= 3.10; macOS /usr/bin/python3 is 3.9. */
export const MIN_PYTHON = [3, 10];

/**
 * Version-suffixed names before bare `python3` — the bare one is whatever's
 * first on PATH, often the system 3.9. Each candidate is asked its own
 * version rather than trusted by name (a `python3.12` symlink can point
 * anywhere).
 */
export function findWorkerPython(run = spawnSync, resolve = onPath) {
  for (const name of ["python3.13", "python3.12", "python3.11", "python3.10", "python3"]) {
    if (!resolve(name)) continue;
    const probe = run(name, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
      encoding: "utf8",
    });
    if (probe.status !== 0) continue;
    const [major, minor] = String(probe.stdout).trim().split(".").map(Number);
    if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) {
      return { command: name, version: `${major}.${minor}` };
    }
  }
  return null;
}

/**
 * A virtualenv (not the machine's Python): PEP 668 refuses `pip install` into
 * Homebrew/system interpreters, and pinning the SDK here can't disturb the
 * user's environment. Both install routes reach this — plugin route via
 * `--fix`, clone route by import.
 */
export function buildWorkerEnvironment(pluginRoot, log = () => {}) {
  const { workerDir, venvPython } = workerPaths(pluginRoot);
  const python = findWorkerPython();
  if (!python) {
    return {
      ok: false,
      reason: "no-python",
      detail: `No Python ${MIN_PYTHON.join(".")} or newer found. macOS ships 3.9, which is too old. Install one (e.g. \`brew install python@3.12\`) and retry.`,
    };
  }

  log(`  → creating the worker environment with ${python.command} (${python.version})`);
  for (const [label, cmd, args] of [
    // --clear empties an existing .venv so this can rebuild a broken
    // environment. Callers only reach here when it's missing or known broken.
    ["creating the virtual environment", python.command, ["-m", "venv", "--clear", ".venv"]],
    ["installing the Antigravity SDK", venvPython, ["-m", "pip", "install", "--quiet", "-r", "requirements.txt"]],
  ]) {
    const result = spawnSync(cmd, args, { cwd: workerDir, encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) {
      return {
        ok: false,
        reason: "failed",
        detail: `${label} failed:\n${(result.stderr || result.stdout || "").trim()}`,
      };
    }
  }
  return { ok: true, reason: null, detail: `${python.command} (${python.version})` };
}

/**
 * Tell a green agent-path install what the offline checks here leave to the run: they can't see 403
 * (entitlement), 404 (region) or 401 (stale credential), and each run's start check (preflight_dispatch with
 * probe_typists) sends one test call through the agent, which stops the run on any of them before any paid
 * phase. No separate paid probe is offered: it would ask the person an extra question and pay twice for one
 * answer. Null on model-path or non-green installs.
 */
export function agentProbeHint(pluginRoot, env = {}, ok = true) {
  if (!ok || !selectsAgentWorker(env)) return null;
  return (
    `\n  This install selects the agent path, and the checks above are all offline.\n` +
    `  They cannot tell whether this project carries the Antigravity entitlement,\n` +
    `  whether its region serves the model, or whether a well-formed credential is\n` +
    `  still live. Each run's start check sends one test call through the agent\n` +
    `  and stops the run there, before any paid phase, if any of them fails:\n` +
    `  nothing to run beforehand.`
  );
}

/**
 * End-of-successful-setup hand-off. Names the four task commands the user can
 * run in a new session and, when the project already has one set, the current
 * policy. Suppressed on any check failure — a failing install shouldn't tell
 * you to "try /mmo:greenfield next."
 */
export function nextStepsBanner(cwd = process.cwd(), ok = true) {
  if (!ok) return null;
  let currentPolicy = null;
  try {
    const raw = readFileSync(join(cwd, ".sdlc", "project.json"), "utf8");
    currentPolicy = JSON.parse(raw).default_policy ?? null;
  } catch { /* no project.json yet — banner still worth printing */ }

  const policyLine = currentPolicy
    ? `\n  Current policy: ${currentPolicy}   (change: /mmo:policy change)`
    : `\n  No policy set yet — run /mmo:policy change to pick one, or /mmo:setup --policy=<name>.`;

  return (
    `\n✓ Setup complete for this project.\n\n` +
    `  Try one of these in a NEW session in the same folder:\n\n` +
    `    /mmo:greenfield  — generate a new app from a brief (empty folder)\n` +
    `    /mmo:brownfield  — work on this existing repo (docs, bugfix, feature, refactor, …)\n` +
    `    /mmo:policy      — show / change this project's model policy\n` +
    `    /mmo:pass        — headless/scripted run (for CI or replays)\n` +
    policyLine + `\n\n` +
    `  A NEW session is required: Claude Code builds the slash-command list and\n` +
    `  starts plugin MCP servers at session boot. In this session the setup\n` +
    `  changes are on disk but not live.`
  );
}

/**
 * Note when the agent door has opened since the wizard ran. The wizard asks
 * once at install; someone running `gcloud auth application-default login` a
 * week later would otherwise never be told. Not a `problem` — the model path
 * is a valid choice.
 */
export function agentPathAvailableHint(pluginRoot, vertex = null, env = {}) {
  if (!hasVertexCredentials(vertex)) return null;
  if (selectsAgentWorker(env)) return null;
  // Absolute path — the reader is not standing in the plugin-cache scripts dir.
  return (
    `\n  This machine now has credentials for the Antigravity SDK agent path, which\n` +
    `  the mechanical tier is not using. The model path is the cheaper default and\n` +
    `  staying on it is fine — but if you want Gemini to open the folder and run\n` +
    `  commands itself:\n` +
    `    node ${join(pluginRoot, "scripts", "verify-setup.mjs")} --enable-agent`
  );
}

/**
 * Default = .claude/settings.local.json (per-project, not committed).
 * User-level would silently change every folder. The shared project file is
 * committed and a teammate would inherit a selection that may be wrong for
 * their machine. `--user` opts into machine-wide.
 */
export function settingsPathFor(scope, cwd, home = homedir()) {
  return scope === "user"
    ? join(home, ".claude", "settings.json")
    : join(cwd, ".claude", "settings.local.json");
}

/**
 * Pure merge. Preserves every other key and env variable (the file is the
 * user's; often holds their API keys). Disabling removes only our slot;
 * removes MMO_SELECT entirely when nothing is left (empty and absent must
 * behave identically). Malformed existing spec is discarded, not merged.
 */
export function withAgentSelection(settings, enabled) {
  const next = { ...(settings ?? {}) };
  const env = { ...(next.env ?? {}) };
  const { pairs } = parseSelectSpec(env.MMO_SELECT);

  if (enabled) pairs[AGENT_WORKER_SLOT] = AGENT_WORKER_MODEL_ID;
  else if (pairs[AGENT_WORKER_SLOT] === AGENT_WORKER_MODEL_ID) delete pairs[AGENT_WORKER_SLOT];

  const spec = Object.entries(pairs)
    .map(([slot, option]) => `${slot}=${option}`)
    .join(",");

  if (spec) env.MMO_SELECT = spec;
  else delete env.MMO_SELECT;

  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;
  return next;
}

/**
 * Match by server script, not entry key — the key is the user's to choose,
 * only the script identifies the program.
 */
export function isBundledServerEntry(server) {
  const argv = Array.isArray(server?.args) ? server.args.join(" ") : "";
  // The pre-built bundle, or the compiled dist/ entry an existing .mcp.json may name.
  return argv.includes(join("model-dispatch", "bundle", "server.mjs")) || argv.includes(join("model-dispatch", "dist", "server.js"));
}

/**
 * On the clone route, .mcp.json's `env` block is EXHAUSTIVE (stdio MCP
 * servers inherit nothing). A selection written only to a settings file
 * would be dropped at the server boundary, so both files are updated.
 * Plugin route has no .mcp.json of ours; `updated` comes back empty there.
 */
export function withMcpSelection(config, enabled) {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== "object") return { config, updated: [] };

  const nextServers = { ...servers };
  const updated = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!isBundledServerEntry(server)) continue;
    // Same merge rules as a settings file — preserves API keys tools/setup.mjs
    // forwarded into `env`.
    nextServers[name] = withAgentSelection(server, enabled);
    updated.push(name);
  }
  return { config: updated.length ? { ...config, mcpServers: nextServers } : config, updated };
}

/**
 * Write the selection to a settings file (creating it if missing) and to
 * this folder's .mcp.json when it registers our bundled server. An
 * unparseable existing file is refused BEFORE anything is written — it may
 * hold the user's only copy of a key.
 */
export function enableAgentPath({ scope = "project", cwd = process.cwd(), enabled = true } = {}) {
  const path = settingsPathFor(scope, cwd);
  const mcpJsonPath = join(cwd, ".mcp.json");
  const documents = [];

  for (const target of [path, mcpJsonPath]) {
    if (!existsSync(target)) {
      documents.push({ target, current: {} });
      continue;
    }
    try {
      documents.push({ target, current: JSON.parse(readFileSync(target, "utf8")) });
    } catch (err) {
      return {
        ok: false,
        path: target,
        mcpPath: null,
        spec: null,
        detail: `${target} is not valid JSON (${err.message}). Fix or move it, then retry — this script will not overwrite a file it cannot read.`,
      };
    }
  }

  const [settingsDoc, mcpDoc] = documents;
  const next = withAgentSelection(settingsDoc.current, enabled);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (err) {
    return {
      ok: false,
      path,
      mcpPath: null,
      spec: null,
      detail: `Could not write ${path}: ${err.message}`,
    };
  }

  // Only when the file already exists. Creating a .mcp.json from a routing
  // flag would guess a server path; `npm run setup` writes that file.
  let mcpPath = null;
  if (existsSync(mcpJsonPath)) {
    const { config, updated } = withMcpSelection(mcpDoc.current, enabled);
    if (updated.length > 0) {
      try {
        writeFileSync(mcpJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        mcpPath = mcpJsonPath;
      } catch (err) {
        return {
          ok: false,
          path: mcpJsonPath,
          mcpPath: null,
          spec: null,
          detail: `Could not write ${mcpJsonPath}: ${err.message}`,
        };
      }
    }
  }

  return { ok: true, path, mcpPath, spec: next.env?.MMO_SELECT ?? null, detail: null };
}

function report({ ok, problems }, log) {
  const blocking = problems.filter((p) => p.severity === "blocking");
  const warnings = problems.filter((p) => p.severity === "warning");

  for (const p of blocking) log(`  ✗ ${p.message}\n    fix: ${p.fix}`);
  for (const p of warnings) log(`  ! ${p.message}\n    fix: ${p.fix}`);

  if (ok && warnings.length === 0) log("  ✓ Setup is complete. The plugin is ready to run.");
  else if (ok) log("  ✓ The plugin can run. Warnings above limit which policies will work.");
  return ok;
}

/**
 * Brownfield-mode setup checks. Delegates to env-checks.mjs (Node/git
 * versions, ~/.claude and .sdlc writability, plugin command-name
 * conflicts) and credential-discovery.mjs (Anthropic/Gemini/Antigravity
 * scan across shell env, home configs, shell rc, repo .env* and code
 * references — names only, never values).
 *
 * Both are standalone .mjs so they can also run independently (env-checks
 * in CI headless mode, credential-discovery from the shepherd's inline
 * remediation dialog). Here we just spawn them and merge their reports
 * so the setup-check output has one unified section.
 *
 * Returns { ok, blockers, advisories, env, credentials } — the caller
 * combines this with the existing greenfield-check verdict to decide
 * the process exit code.
 */
export function runBrownfieldChecks(pluginRoot, { spawn = spawnSync } = {}) {
  const envCheckPath = join(pluginRoot, "scripts", "env-checks.mjs");
  const credDiscoveryPath = join(pluginRoot, "scripts", "credential-discovery.mjs");

  const envResult = spawn(process.execPath, [envCheckPath, "--json"], {
    encoding: "utf8",
    timeout: 10000,
  });
  let envReport;
  try { envReport = JSON.parse(envResult.stdout ?? "{}"); }
  catch { envReport = { schema_version: 1, ok: false, blockers: 1, error: "env-checks did not emit parseable JSON" }; }

  const credResult = spawn(process.execPath, [credDiscoveryPath, "--include-antigravity"], {
    encoding: "utf8",
    timeout: 10000,
  });
  let credReport;
  try { credReport = JSON.parse(credResult.stdout ?? "{}"); }
  catch { credReport = { schema_version: 1, providers: [], error: "credential-discovery did not emit parseable JSON" }; }

  return {
    ok: envReport.ok !== false,
    blockers: envReport.blockers ?? 0,
    advisories: envReport.advisories ?? 0,
    env: envReport,
    credentials: credReport,
  };
}

// Direct-execution gate so the test suite can import the pure helpers. import.meta.url is the module's
// real path; argv[1] keeps the caller's spelling (a symlinked plugin folder, /var against /private/var),
// so it is compared by its real path too. A skipped check exits 0, which would read as a pass.
const invokedDirectly = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? "")).href === import.meta.url; } catch { return false; } })();
if (invokedDirectly) {
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const log = (m) => console.log(m);
  const shouldFix = process.argv.includes("--fix");
  const enableAgent = process.argv.includes("--enable-agent");
  const disableAgent = process.argv.includes("--disable-agent");
  const scope = process.argv.includes("--user") ? "user" : "project";
  const brownfieldCheck = process.argv.includes("--brownfield-check");
  const headless = process.argv.includes("--headless");
  // --project-root=<abs-path> or --project-root <abs-path> overrides
  // process.cwd() when the caller (a /mmo:* command file) has already resolved
  // which project this run is against — see setup.md, policy.md. Passing it
  // forward closes the cwd-drift hole between the command layer and any
  // subsequent settings write. Accept BOTH forms — command files write the
  // space form (`--project-root "$(pwd)"`); the `=` form is what CI uses.
  const projectRootEq = process.argv.find((a) => a.startsWith("--project-root="));
  const projectRootSpaceIdx = process.argv.indexOf("--project-root");
  const projectRoot = projectRootEq
    ? projectRootEq.slice("--project-root=".length)
    : (projectRootSpaceIdx >= 0 ? process.argv[projectRootSpaceIdx + 1] : process.cwd());

  log("\nAI-SDLC orchestrator — setup check");

  // Real env, replaced below when a selection is written — so --enable-agent
  // can also build what the selection needs.
  let env = process.env;

  if (enableAgent && disableAgent) {
    log("  ✗ --enable-agent and --disable-agent contradict each other. Pass one.");
    process.exit(1);
  }

  if (enableAgent || disableAgent) {
    const written = enableAgentPath({ scope, enabled: enableAgent });
    if (!written.ok) {
      log(`  ✗ ${written.detail}`);
      process.exit(1);
    }
    env = { ...process.env };
    if (written.spec) env.MMO_SELECT = written.spec;
    else delete env.MMO_SELECT;

    log(
      enableAgent
        ? `  ✓ Mechanical tier set to the Antigravity SDK agent path (MMO_SELECT=${written.spec}) in ${written.path}.`
        : `  ✓ Mechanical tier set back to the model path in ${written.path}.`
    );
    log(
      scope === "user"
        ? "    This is machine-wide — it applies to every folder you open from now on."
        : "    This applies to this folder only. Add --user to set it machine-wide."
    );
    // Named because on a clone route this is the file that actually decides.
    if (written.mcpPath) log(`    Also updated ${written.mcpPath}, which is what this folder's server reads.`);
    // Settings files are read at session start; the current session has the old value.
    log("    It reaches Claude Code when you start a new session in this folder.");
  }

  // --enable-agent implies --fix so a single command sets the selection AND
  // builds what it needs.
  const repairing = shouldFix || enableAgent;

  // Keep the observation, not just the verdict — the end-of-run hints need
  // the credential state and re-deriving it could give two different answers.
  let observed = observe(pluginRoot, env);
  let state = evaluate(observed);
  const needsRepair = state.problems.some(
    (p) => p.id === "mcp-dependencies" || p.id === "mcp-build"
  );

  if (needsRepair && repairing) {
    log("  The bundled MCP server needs building. Repairing:");
    if (repair(pluginRoot, log)) {
      observed = observe(pluginRoot, env);
      state = evaluate(observed);
    }
  }

  // Conditional: an install that never selected the agent worker must not
  // have a virtualenv built for it.
  const needsWorker = state.problems.some(
    (p) => p.id === "agent-worker-python" || p.id === "agent-worker-sdk"
  );
  if (needsWorker && repairing) {
    log("  The agent worker needs a Python environment. Repairing:");
    const built = buildWorkerEnvironment(pluginRoot, log);
    if (built.ok) {
      observed = observe(pluginRoot, env);
      state = evaluate(observed);
    } else log(`  ✗ ${built.detail}`);
  }

  const passed = report(state, log);
  for (const hint of [
    agentProbeHint(pluginRoot, env, passed),
    // Only shown to model-path installs with the agent door open.
    agentPathAvailableHint(pluginRoot, observed.vertex, env),
    // Next-steps banner — only when everything upstream passed.
    nextStepsBanner(projectRoot, passed),
  ]) {
    if (hint) log(hint);
  }

  // Brownfield-mode checks — opt-in via --brownfield-check. When used from
  // the setup shepherd this is always set; the existing --fix / --enable-agent
  // flows keep their current behaviour untouched. Headless (CI) mode passes
  // both --brownfield-check and --headless.
  let brownfieldOk = true;
  if (brownfieldCheck) {
    log("");
    log("Brownfield-mode setup checks:");
    const bf = runBrownfieldChecks(pluginRoot);
    brownfieldOk = bf.ok;
    for (const c of bf.env?.checks ?? []) {
      const mark = c.ok ? "  ✓" : (c.severity === "blocker" ? "  ✗" : "  ⚠");
      log(`${mark} ${c.id}${c.ok ? "" : " — " + (c.error ?? c.severity)}`);
      if (!c.ok && Array.isArray(c.remediation)) {
        for (const line of c.remediation) log("      " + line);
      } else if (c.note) log("      " + c.note);
    }
    log("");
    log("  Credentials scan (names only, values never read):");
    for (const p of bf.credentials?.providers ?? []) {
      const found = p.found ? "found" : "not found";
      const flavors = p.flavors ? " [" + Object.entries(p.flavors).filter(([, v]) => v).map(([k]) => k).join(", ") + "]" : "";
      log(`    ${p.name}: ${found}${flavors}${p.required ? " (required)" : (p.optional_and_opt_in ? " (opt-in)" : " (optional)")}`);
    }
    if (headless && !brownfieldOk) {
      log("");
      log("Headless mode: a blocker check needs human action. Fix the reported items and re-run.");
    }
  }

  process.exit((passed && brownfieldOk) ? 0 : 1);
}
