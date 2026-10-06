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
 * alone would let a path spelt in other letters through to the same bytes.
 */
export function offLimitsMatch(rel, contractOffLimits = []) {
  const path = String(rel).toLowerCase();
  for (const pattern of HARDCODED_OFF_LIMITS) {
    if (matchesAtAnyDepth(path, pattern.toLowerCase())) return { pattern, source: "hardcoded" };
  }
  for (const pattern of Array.isArray(contractOffLimits) ? contractOffLimits : []) {
    if (typeof pattern === "string" && matchGlob(path, pattern.toLowerCase())) return { pattern, source: "contract" };
  }
  return null;
}
