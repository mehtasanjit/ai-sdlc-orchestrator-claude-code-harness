/**
 * Shared off-limits pattern lists. Two consumers:
 *   - plugin/scripts/setup-policy.mjs writes OFF_LIMITS_DEFAULT to
 *     `.sdlc/project.json` so Gate 0 can name them once and skip repeating
 *     the constants each ticket.
 *   - plugin/scripts/write-contract-check.mjs uses HARDCODED_OFF_LIMITS as
 *     the pre-contract safety net: even without an active brownfield contract,
 *     always-sensitive paths (credentials, MCP config, other-AI-tool state)
 *     are refused.
 *
 *   - plugin/scripts/lib/change-spec.mjs and findings-to-packets.mjs refuse to
 *     plan a write to, or send a model the text of, a path offLimitsMatch()
 *     below names: the same rule as the server's writer, applied before a
 *     model is paid or shown the file.
 *
 * HARDCODED_OFF_LIMITS is a strict subset of OFF_LIMITS_DEFAULT, and
 * off-limits.test.mjs asserts that containment so the two cannot drift apart.
 * Everything in this file is a pattern matchesAtAnyDepth() below matches
 * against a target at any nesting depth.
 */

/** The full project-wide default list, written to project.json by setup. */
export const OFF_LIMITS_DEFAULT = [
  ".env",
  ".env.*",
  ".mcp.json",
  ".cursor/rules/**",
  ".claude/settings.local.json",
  "node_modules/**",
  "dist/**",
  "build/**",
  ".next/**",
  ".sdlc/**",
  ".git/**",
];

/**
 * The pre-contract safety-net subset — enforced when no contract exists, so it
 * holds only paths unsafe to write with no run to scope them: credentials,
 * machine config, another tool's rules, and git's object store.
 *
 * Build output (`dist/**`, `build/**`, `.next/**`, `node_modules/**`) and the
 * plugin's own `.sdlc/**` stay out of this list. A contracted run still
 * enforces them from OFF_LIMITS_DEFAULT; blocking them with no contract
 * refuses ordinary edits in every repository the plugin is installed in.
 */
export const HARDCODED_OFF_LIMITS = [
  ".env",
  ".env.*",
  ".mcp.json",
  ".cursor/rules/**",
  ".claude/settings.local.json",
  ".git/**",
];

/**
 * Files that hold credentials, kept from every model on top of HARDCODED_OFF_LIMITS: registry and git tokens, private
 * keys and key stores, cloud credentials, infrastructure state, and Claude Code's shared settings (its env block can
 * carry an API key). A read list only: whether a run may write one stays the write rule's (HARDCODED_OFF_LIMITS and the
 * contract), unchanged. The server keeps the same list (model-dispatch apply.ts), and apply.test.mjs asserts it.
 */
export const CREDENTIAL_FILES = [
  ".claude/settings.json",
  ".npmrc",
  ".yarnrc.yml",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".vault-token",
  ".terraformrc",
  ".docker/config.json",
  ".kube/config",
  ".ssh/**",
  ".aws/**",
  ".azure/**",
  ".gnupg/**",
  ".config/gcloud/**",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "credentials.json",
  "*-credentials.json",
  "*service-account*.json",
  "*service_account*.json",
  "application_default_credentials.json",
  "*.tfstate",
  "*.tfstate.backup",
];

/** What no model is ever sent: the always-off-limits list and every credential file. */
export const READ_OFF_LIMITS = [...HARDCODED_OFF_LIMITS, ...CREDENTIAL_FILES];

/** A private key's own marker, in any file: the read rule keeps such a file from models whatever its name. */
export function holdsPrivateKey(text) {
  return /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(String(text));
}

/**
 * The write contract's glob dialect (`**` any depth, `*` within one folder, `?` one character), as the hook
 * (write-contract-check.mjs) and the server's writer (model-dispatch apply.ts) match it.
 */
export function matchGlob(path, pattern) {
  if (path === pattern) return true;
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${re}$`).test(path);
}

/** A base pattern (`.env`, `.git/**`) matched at any depth, as the hook and the server's writer match the hardcoded list. */
export function matchesAtAnyDepth(target, pattern) {
  if (matchGlob(target, pattern)) return true;
  if (pattern.startsWith("**/") || pattern.startsWith("/")) return false;
  return matchGlob(target, "**/" + pattern);
}

/**
 * The off-limits pattern a project path (relative, `/`-separated) matches, or null: the hardcoded list at any depth
 * first, then the run contract's own `off_limits` as written — the order the server's writer refuses in.
 *
 * Why case-insensitive: macOS and Windows disks treat `.ENV` and `.env` as one file, so a pattern matched by case
 * alone would let a path spelt in other letters through to the same bytes. Names are compared in one Unicode form
 * with case folded (`ſ` is `s`, as macOS's disk treats it); a file that exists is also judged by its own name on the
 * disk (lib/change-spec.mjs realRel). `base` is the always-off-limits list: HARDCODED_OFF_LIMITS for a write, and
 * READ_OFF_LIMITS for what a model reads.
 */
export function offLimitsMatch(rel, contractOffLimits = [], base = HARDCODED_OFF_LIMITS) {
  const path = foldName(rel);
  for (const pattern of base) {
    if (matchesAtAnyDepth(path, foldName(pattern))) return { pattern, source: "hardcoded" };
  }
  for (const pattern of Array.isArray(contractOffLimits) ? contractOffLimits : []) {
    if (typeof pattern === "string" && matchGlob(path, foldName(pattern))) return { pattern, source: "contract" };
  }
  return null;
}

/** A name in the one form the off-limits match compares: Unicode NFC with case folded both ways (`ſ` to `s`). */
export function foldName(s) {
  return String(s).normalize("NFC").toUpperCase().toLowerCase();
}
