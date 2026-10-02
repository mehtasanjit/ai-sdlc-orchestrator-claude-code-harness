#!/usr/bin/env node
/**
 * Brownfield write-contract PreToolUse hook.
 *
 * Refuses Write/Edit against paths outside the confirmed allowlist when
 * brownfield mode is active. Silent no-op when no active contract file
 * exists — that keeps greenfield /mmo:greenfield and non-plugin editing
 * behaviour unchanged.
 *
 * Contract file: <repo-root>/.sdlc/local/write-contract.json
 *   { schema_version, active, mode, run_id, strict, allowlist, off_limits }
 *
 * The orchestrator writes/updates this file after Gate 0 approval and
 * clears it (sets active:false) when the run closes. See plan §4 / §26.
 *
 * Fail-safe philosophy: any bug in this hook must NOT block user work.
 * Parse failures, missing fields, unresolvable paths — all allow. The
 * only denials are on known off-limits or non-allowlist matches when the
 * contract file itself parses cleanly and is active.
 *
 * Exit codes (Claude Code hook contract):
 *   0 → allow
 *   2 → deny (Claude Code blocks the tool call and feeds stderr back to
 *       the model as the reason). Exit 1 is NOT a deny: the hook contract
 *       treats 1 as a non-blocking hook error — the message is surfaced
 *       but the write still goes through, making every denial advisory.
 */

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HARDCODED_OFF_LIMITS } from "./lib/off-limits.mjs";
import { log } from "./lib/log.mjs";

const CONTRACT_REL_PATH = ".sdlc/local/write-contract.json";

async function readStdinJson() {
  return await new Promise((resolveP) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => {
      try {
        resolveP(JSON.parse(buf));
      } catch {
        resolveP(null);
      }
    });
    // Some environments never close stdin; give up after a short beat and allow.
    setTimeout(() => resolveP(null), 1500).unref();
  });
}

/**
 * Walk from `start` up the filesystem until we find a directory containing
 * the given relative path. Returns the absolute contract path if found, else null.
 * Bounded to avoid pathological loops on unusual filesystems.
 */
function findContractPath(start) {
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    const candidate = resolve(dir, CONTRACT_REL_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * A path with every link in it resolved, also for a file that does not exist yet: the deepest folder that exists is
 * resolved and the rest appended. Anything that cannot be resolved stays as given.
 */
function realPath(p) {
  let head = resolve(p);
  const rest = [];
  for (let i = 0; i < 256; i++) {
    try { return join(realpathSync(head), ...rest); } catch { /* not there (yet): try its folder */ }
    const parent = dirname(head);
    if (parent === head) break;
    rest.unshift(basename(head));
    head = parent;
  }
  return resolve(p);
}

/**
 * `absTarget`'s path inside `root` ("src/a.ts"), or null when it is outside. Judged on the paths as written first; only
 * when that says "outside" is it judged again with links resolved on both sides. Why: the session's folder comes from
 * process.cwd(), which the system gives with every link resolved (/private/var/... on macOS), while a write's path
 * arrives as written (/var/...). Compared as text only, every write in a project under a linked folder (macOS's /tmp
 * and /var, a linked code folder) would be refused as a write outside the project. The second look can only find a
 * path inside, never move one outside, so it never refuses a write the first look allows.
 */
function insidePath(root, absTarget) {
  const rel = (from, to) => relative(from, to).split(sep).join("/");
  const outside = (r) => r === ".." || r.startsWith("../") || isAbsolute(r);
  const asWritten = rel(root, absTarget);
  if (!outside(asWritten)) return asWritten;
  const resolved = rel(realPath(root), realPath(absTarget));
  return outside(resolved) ? null : resolved;
}

/**
 * Repo-relative path resolution + escape detection. Returns `{ rel, escapes }`
 * where `escapes: true` means the target resolves OUTSIDE the contract's repo
 * root. An escape is a category error — the run is trying to write outside
 * its own project — and gets a distinct deny message.
 */
function toRepoRelative(target, contractPath) {
  const repoRoot = resolve(contractPath, "..", "..", ".."); // .sdlc/local/write-contract.json → repo root
  const abs = resolve(repoRoot, target);
  const inside = insidePath(repoRoot, abs);
  return { rel: inside ?? relative(repoRoot, abs).split(sep).join("/"), escapes: inside === null };
}

/**
 * Minimal glob matcher. Supports:
 *   `**` — any characters including `/`
 *   `*`  — any characters except `/`
 *   `?`  — any single character except `/`
 *   Literal `/` and other characters.
 * No brace expansion, no character classes, no negation. That's enough for
 * repo scope patterns like `src/**`, `docs/*.md`, `apps/api/**`, `.env`.
 */
function matchGlob(path, pattern) {
  // Fast path: exact match.
  if (path === pattern) return true;

  // Convert glob → regex. Escape regex metachars first, then re-expand our tokens.
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00") // NUL placeholder — can't appear in real paths/patterns, so a literal space in either is preserved (an older version used " " here and mangled `Secret Files/**`).
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${re}$`).test(path);
}

/**
 * Match a target against a base pattern at any nesting depth. The pre-contract
 * safety net stores patterns like `.env`, `.git/**`, `node_modules/**` — the
 * target may arrive as a bare filename, a shallow relative path, or a deep
 * absolute path (`/home/user/proj/.git/refs/heads/main`). All three should
 * match `.git/**`. Doing the depth-neutral match here beats probing three
 * normalized forms of the target at each call site (the old approach dropped
 * `/repo/.git/refs/heads/main` and `/repo/node_modules/pkg/file.js`).
 */
function matchesAtAnyDepth(target, pattern) {
  if (matchGlob(target, pattern)) return true;
  if (pattern.startsWith("**/") || pattern.startsWith("/")) return false;
  return matchGlob(target, "**/" + pattern);
}

function firstMatch(path, patterns) {
  if (!Array.isArray(patterns)) return null;
  for (const p of patterns) {
    if (typeof p === "string" && matchGlob(path, p)) return p;
  }
  return null;
}

/**
 * Sync JSON-read used for pre-decision checks (escape gate). Returns the
 * parsed object or null — same fail-open shape as the async path further down.
 */
function readContractSafe(path) {
  try {
    const st = statSync(path);
    if (st.size > 128 * 1024) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function allow(msg, ctx = {}) {
  if (msg && process.env.MMO_DEBUG === "1") {
    console.error(`[mmo-brownfield write-contract] ALLOW: ${msg}`);
  }
  log("debug", "write.allow", { run_id: ctx.runId, path: ctx.path, matched_rule: ctx.matchedRule });
  process.exit(0);
}

function deny(msg, ctx = {}) {
  console.error(`[mmo-brownfield write-contract] DENY: ${msg}`);
  log("warn", "write.deny", {
    run_id: ctx.runId,
    path: ctx.path,
    matched_off_limits_rule: ctx.matchedRule,
    strict: ctx.strict,
  });
  // Exit 2 is Claude Code's PreToolUse "block" code: the tool call is
  // refused and stderr is fed back to the model as the reason. The old
  // exit(1) was the NON-blocking hook-error code, so every DENY above was
  // advisory — the off-limits/allowlist write went through anyway.
  process.exit(2);
}

async function main() {
  const call = await readStdinJson();
  if (!call || typeof call !== "object") allow("no parseable tool call on stdin");

  // Extract the file path being written. Both Write and Edit use `file_path`.
  const target =
    call?.tool_input?.file_path ??
    call?.tool_input?.path ??
    call?.input?.file_path;
  if (typeof target !== "string" || target.length === 0) {
    allow("no file_path in tool call");
  }

  const absTarget = isAbsolute(target) ? target : resolve(process.cwd(), target);
  const targetNorm = absTarget.split(sep).join("/");

  // Read cwd's contract early so both the escape check and the contract-active
  // check below can consult its `active` field. A stale (active:false)
  // contract left over from a prior brownfield run must NOT block cross-repo
  // writes — old behavior was `contract.active !== true → allow`; keep that.
  const cwdContractPath = findContractPath(process.cwd());
  const cwdContract = cwdContractPath ? readContractSafe(cwdContractPath) : null;

  // Escape check: if cwd has an ACTIVE contract and the target resolves
  // outside its tree, that's a category error regardless of what any
  // target-anchored lookup would say. Closes the SiteNotes shape:
  // session cwd=repoA, target=absolute path in repoB, old code found repoA's
  // contract and mislabeled the escape as "not in allowlist."
  if (cwdContract && cwdContract.active === true) {
    const cwdRepoRoot = resolve(cwdContractPath, "..", "..", "..");
    if (insidePath(cwdRepoRoot, absTarget) === null) {
      const targetContract = findContractPath(dirname(absTarget));
      deny(
        `${absTarget} resolves OUTSIDE the calling session's contracted repo ` +
        `(${cwdRepoRoot}). Cross-project writes are refused — a brownfield ` +
        `run can only write inside the repo whose contract it holds.` +
        (targetContract ? ` (Target has its own contract at ${targetContract}; ` +
          `run against that project explicitly if you meant to edit it.)` : "")
      );
    }
  }

  // Contract selection: prefer target-anchored (correct even if the shell
  // has drifted). Fall back to cwd-anchored, then to no contract.
  const contractPath = findContractPath(dirname(absTarget)) ?? cwdContractPath;

  // Pre-contract safety net: even without any active contract, always refuse
  // writes to a known-sensitive path (credentials, MCP config, other-AI-tool
  // state, plugin bookkeeping). Old code fell through to "allow" here — the
  // hole that let setup-phase Edits overwrite `.env` files without warning.
  if (!contractPath) {
    // `matchesAtAnyDepth` handles bare filenames, shallow relative paths, and
    // deep absolute paths in one call — no need to probe three normalized
    // forms of the target (the old approach dropped `/repo/.git/refs/heads/main`
    // and `/repo/node_modules/pkg/file.js`).
    const preHit = HARDCODED_OFF_LIMITS.find((p) => matchesAtAnyDepth(targetNorm, p));
    if (preHit) {
      deny(
        `${target} matches always-off-limits pattern "${preHit}" (no active brownfield contract; ` +
        `this is the pre-contract safety net for credentials, MCP config, other-AI-tool state, ` +
        `and plugin bookkeeping). If this write is legitimate, run /mmo:setup or /mmo:brownfield ` +
        `first to establish an explicit contract, then re-issue.`
      );
    }
    allow("no .sdlc/local/write-contract.json in ancestors of target or cwd — greenfield or non-plugin operation");
  }

  // Only trust files small enough to be our contract; a huge file is more likely
  // to be a coincidence or a corruption we don't want to block on.
  try {
    const st = statSync(contractPath);
    if (st.size > 128 * 1024) allow("contract file suspiciously large; treating as unreadable");
  } catch {
    allow("contract file stat failed");
  }

  let contract;
  try {
    contract = JSON.parse(await readFile(contractPath, "utf8"));
  } catch {
    allow("contract file did not parse as JSON");
  }

  if (!contract || contract.active !== true) {
    allow("contract not active");
  }

  // The upfront cwd-anchored escape check has already fired if the target
  // resolves outside cwd's contract. If we reach here with a contract, either
  // it's the same as cwd's (and target is inside it) or it's target-anchored
  // (and target is by definition inside it). `escapes` cannot be true here.
  const { rel } = toRepoRelative(target, contractPath);

  // The run's own output directory is auto-allowlisted (agents/orchestrator.md
  // requires direct-tier artifacts to land under `.sdlc/runs/<run-id>/`).
  // `.sdlc/**` is in the default off-limits list and off-limits is evaluated
  // before the allowlist, so without this the contract refuses the run the
  // artifacts it is told to write. Scoped to this contract's run_id.
  const ownRunDir = typeof contract.run_id === "string" && contract.run_id
    ? `.sdlc/runs/${contract.run_id}/`
    : null;
  if (ownRunDir && rel.startsWith(ownRunDir)) {
    allow(`${rel} is inside the run's own auto-allowlisted output directory`, {
      runId: contract.run_id,
      path: rel,
      matchedRule: `${ownRunDir}**`,
    });
  }

  // Off-limits check runs first — an off-limits path is refused even if it
  // also technically matches an allowlist glob (defensive: patterns can overlap).
  const offHit = firstMatch(rel, contract.off_limits);
  if (offHit) {
    if (contract.strict === false) {
      console.error(
        `[mmo-brownfield write-contract] WARN: ${rel} matches off-limits pattern "${offHit}". Allowed because contract.strict = false.`
      );
      allow("off-limits hit, but strict=false", { runId: contract.run_id, path: rel, matchedRule: offHit });
    }
    deny(
      `${rel} matches off-limits pattern "${offHit}" (run ${contract.run_id ?? "?"}). ` +
      `Re-open Gate 0 to move this path out of off-limits, or set contract.strict = false ` +
      `(equivalent to --strict-write=off) to bypass.`,
      { runId: contract.run_id, path: rel, matchedRule: offHit, strict: contract.strict }
    );
  }

  // Allowlist check.
  const allowHit = firstMatch(rel, contract.allowlist);
  if (allowHit) allow(`${rel} matches allowlist pattern "${allowHit}"`, { runId: contract.run_id, path: rel, matchedRule: allowHit });

  // Not in allowlist, not off-limits → deny by default (allowlist-based safety).
  if (contract.strict === false) {
    console.error(
      `[mmo-brownfield write-contract] WARN: ${rel} is not in the confirmed allowlist. Allowed because contract.strict = false.`
    );
    allow("not in allowlist, but strict=false", { runId: contract.run_id, path: rel });
  }
  deny(
    `${rel} is not in the confirmed allowlist for run ${contract.run_id ?? "?"}. ` +
    `Re-open Gate 0 to expand scope to include this path, or set contract.strict = false ` +
    `(equivalent to --strict-write=off) to bypass.`,
    { runId: contract.run_id, path: rel, strict: contract.strict }
  );
}

main().catch((e) => {
  // Unhandled error — fail-open. Better to permit a write than to wedge the user.
  if (process.env.MMO_DEBUG === "1") console.error(`[mmo-brownfield write-contract] unhandled: ${e?.message ?? e}`);
  process.exit(0);
});
