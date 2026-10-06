#!/usr/bin/env node
/**
 * Brownfield write-contract PreToolUse hook.
 *
 * Refuses Write/Edit against paths outside the confirmed allowlist when
 * brownfield mode is active. Silent no-op when no contract binds, unless a
 * live freeze record says one should (a missing or switched-off contract
 * under a live record refuses every write) — that keeps greenfield
 * /mmo:greenfield and non-plugin editing behaviour unchanged (only the
 * always-off-limits safety net applies).
 *
 * Contract file: <repo-root>/.sdlc/local/write-contract.json
 *   { schema_version, active, mode, run_id, strict, allowlist, off_limits }
 *
 * write-contract.mjs writes this file at Gate 0 (`--freeze`), switches it off at
 * close-out (`--close`), and for a run the person abandons (`--abandon`); zero-touch's
 * stop (ambient/lib/workflow-log.mjs abortRun) switches it off after logging the
 * run's end. The orchestrator never writes it.
 *
 * Which contract (the project's root): only the contract at the root of the git
 * project that holds the target counts (the nearest folder, the target's or above,
 * with a `.git` file or folder). A write-contract.json anywhere else is ignored:
 * one placed in a subfolder would otherwise take over every target below it. The
 * session's own project (the git project holding the session's folder) also
 * decides every target inside it, a nested git project included (a submodule, or a
 * `.git` the run placed), and refuses a target outside it while its contract binds.
 *
 * A contract binds its own run, and only while that run is live:
 *   - Once the run has ended by its own log (lib/run-log.mjs: an abort, a failed
 *     run, or a completed run whose Gate 4 is accepted), the contract binds
 *     nothing, exactly as if it were switched off. The brownfield guide's
 *     close-out comes after Gate 4 is accepted, so its records and the switch-off
 *     go through; and a contract never switched off no longer holds the project.
 *   - While the run is live, the contract file and the run's own log
 *     (.sdlc/runs/<run-id>/orchestrator.log, written only by the plugin's scripts) are
 *     refused to Write and Edit whatever the allowlist says: the run must not
 *     widen its own contract, switch it off, or log its own end by hand. A contract
 *     frozen by write-contract.mjs keeps both refused under strict = false too: a
 *     frozen contract changed mid-run refuses every write after it.
 *   - The contract is written by write-contract.mjs, which records the SHA-256
 *     of its bytes in the run's own log (lib/contract-lock.mjs). While that run is
 *     live, a contract changed any other way (a shell command included; deleted, or
 *     rewritten to name another run) refuses every write.
 *
 * The order of the rules is the server writer's (model-dispatch apply.ts
 * checkWriteContract), so a file written by the chat's own model and one written
 * by a delegated model get one answer: the run's own folder; then the
 * always-off-limits list (credentials, MCP config, other AI tools' rules, git's
 * own store), at any depth and under any contract; then the contract's
 * off-limits and allowlist. Off-limits patterns match in any case (macOS disks
 * ignore case). A path is judged as written and as it resolves through links:
 * both must pass, and a link out of the project is a write outside it.
 *
 * A refusal says what was refused and why, and that a wider scope is the person's
 * decision; it never names a way past it.
 *
 * Fail-safe philosophy: any bug in this hook must NOT block user work.
 * Parse failures, missing fields, unresolvable paths — all allow (the
 * always-off-limits list aside). The only denials are on known off-limits or
 * non-allowlist matches when the contract file itself parses cleanly and is
 * active, and on a live run's contract that no longer matches its freeze record.
 * Files are read only when they are regular files: a named pipe where a run log or
 * the contract should be never stalls the hook.
 *
 * Exit codes (Claude Code hook contract):
 *   0 → allow
 *   2 → deny (Claude Code blocks the tool call and feeds stderr back to
 *       the model as the reason). Exit 1 is NOT a deny: the hook contract
 *       treats 1 as a non-blocking hook error — the message is surfaced
 *       but the write still goes through, making every denial advisory.
 */

import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { HARDCODED_OFF_LIMITS } from "./lib/off-limits.mjs";
import { log } from "./lib/log.mjs";
import { runEnded } from "./lib/run-log.mjs";
import { CONTRACT_MAX_BYTES, CONTRACT_REL_PATH, contractTampered, frozenBy } from "./lib/contract-lock.mjs";
import { readRegularFile } from "./ambient/lib/workflow-log.mjs";

/** frozenBy per project, read once per call: the run logs do not change while this hook decides. */
const frozenCache = new Map();
const liveFreeze = (root) => {
  if (!frozenCache.has(root)) frozenCache.set(root, frozenBy(root));
  return frozenCache.get(root);
};

/** What every refusal of a path outside the run's scope says: the scope is the person's, never the run's, to change. */
const SCOPE_IS_THE_PERSONS =
  "The run's scope was fixed at Gate 0 and does not change while the run is live; a wider scope is the person's " +
  "decision. Stop and tell the person which path is needed and why.";

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
 * The root of the git project that holds `start`: the nearest folder, `start` or above it, with a `.git` file or
 * folder (a worktree or submodule has a file), or null. Bounded to avoid pathological loops on unusual filesystems.
 */
function gitRoot(start) {
  let dir = resolve(start);
  for (let i = 0; i < 256; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** A path's names below its root, split as the platform splits them. */
const names = (p) => p.split(sep === "\\" ? /[\\/]/ : "/").filter(Boolean);
/** At most this many links are followed for one path; more is a loop, which no write gets through. */
const MAX_LINK_HOPS = 64;

/**
 * A path with every link in it resolved, the last name included, also where a link's target does not exist yet.
 * Why: a write follows a link to a file that does not exist yet and creates that file (Write, as Node's writeFileSync,
 * opens the link's target), so a dangling link inside the allowlist that names a file in an off-limits folder, outside
 * the allowlist or outside the project would carry the write there; resolving only the deepest folder that exists
 * judged such a write where it was written. Each name is read with lstat and, when it is a link, replaced by what the
 * link holds (read with readlink, relative to its folder), whether or not that exists. A name that does not exist is
 * kept as written. A loop of links (more than MAX_LINK_HOPS) is judged as given: no write gets through one.
 */
function realPath(p) {
  const given = resolve(p);
  const root = parse(given).root;
  let cur = root;
  let pending = names(given.slice(root.length));
  for (let hops = 0; pending.length > 0;) {
    const name = pending.shift();
    if (name === ".") continue;
    if (name === "..") { cur = dirname(cur); continue; }
    const next = join(cur, name);
    let link = null;
    try { if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next); } catch { /* not there (yet): a plain name */ }
    if (link === null) { cur = next; continue; }
    if (++hops > MAX_LINK_HOPS) return given;
    // The link's own text, name by name, read against the folder that holds it (or from its root when it is
    // absolute), so a ".." in it is taken after the links before it, as the system takes it.
    if (isAbsolute(link)) cur = parse(link).root;
    pending = [...names(isAbsolute(link) ? link.slice(cur.length) : link), ...pending];
  }
  return cur;
}

const relPosix = (from, to) => relative(from, to).split(sep).join("/");
const outsideRel = (r) => r === ".." || r.startsWith("../") || isAbsolute(r);
/** Whether two folders are one, whichever form (linked or real) their paths take. */
const sameFolder = (a, b) => !!a && !!b && realPath(a) === realPath(b);

/**
 * `absTarget`'s path inside `root` ("src/a.ts"), or null when it is outside. Judged on the paths as written first; only
 * when that says "outside" is it judged again with links resolved on both sides. Why: the session's folder comes from
 * process.cwd(), which the system gives with every link resolved (/private/var/... on macOS), while a write's path
 * arrives as written (/var/...). Compared as text only, every write in a project under a linked folder (macOS's /tmp
 * and /var, a linked code folder) would be refused as a write outside the project. The second look can only find a
 * path inside, never move one outside, so it never refuses a write the first look allows.
 */
function insidePath(root, absTarget) {
  const asWritten = relPosix(root, absTarget);
  if (!outsideRel(asWritten)) return asWritten;
  const resolved = relPosix(realPath(root), realPath(absTarget));
  return outsideRel(resolved) ? null : resolved;
}

/**
 * The paths a write is judged by inside `root`: as written, and where it lands with every link resolved. A link inside
 * the allowlist that points elsewhere would otherwise carry a write into an off-limits folder, or out of the project,
 * without touching the contract. `{ paths, leaves }`: `leaves` is true when the resolved path is outside the project.
 */
function judgedPaths(root, absTarget) {
  const asWritten = insidePath(root, absTarget);
  const resolved = relPosix(realPath(root), realPath(absTarget));
  if (outsideRel(resolved)) return { paths: asWritten ? [asWritten] : [], leaves: true };
  return { paths: [...new Set([asWritten ?? resolved, resolved])], leaves: false };
}

/**
 * Minimal glob matcher. Supports:
 *   `**` — any characters including `/`
 *   `*`  — any characters except `/`
 *   `?`  — any single character except `/`
 *   Literal `/` and other characters.
 * No brace expansion, no character classes, no negation. That's enough for
 * repo scope patterns like `src/**`, `docs/*.md`, `apps/api/**`, `.env`.
 * `ci`: without regard to case (off-limits: a disk that ignores case writes src/SECRETS into src/secrets).
 */
function matchGlob(path, pattern, { ci = false } = {}) {
  // Fast path: exact match.
  if (path === pattern || (ci && path.toLowerCase() === pattern.toLowerCase())) return true;

  // Convert glob → regex. Escape regex metachars first, then re-expand our tokens.
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00") // NUL placeholder — can't appear in real paths/patterns, so a literal space in either is preserved (an older version used " " here and mangled `Secret Files/**`).
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${re}$`, ci ? "i" : "").test(path);
}

/**
 * Match a target against a base pattern at any nesting depth, without regard to case. The always-off-limits list
 * stores patterns like `.env`, `.git/**`, `node_modules/**` — the target may arrive as a bare filename, a shallow
 * relative path, or a deep absolute path (`/home/user/proj/.git/refs/heads/main`). All three should match `.git/**`.
 * Doing the depth-neutral match here beats probing three normalized forms of the target at each call site (the old
 * approach dropped `/repo/.git/refs/heads/main` and `/repo/node_modules/pkg/file.js`).
 */
function matchesAtAnyDepth(target, pattern) {
  if (matchGlob(target, pattern, { ci: true })) return true;
  if (pattern.startsWith("**/") || pattern.startsWith("/")) return false;
  return matchGlob(target, "**/" + pattern, { ci: true });
}

function firstMatch(path, patterns, { ci = false } = {}) {
  if (!Array.isArray(patterns)) return null;
  for (const p of patterns) {
    if (typeof p === "string" && matchGlob(path, p, { ci })) return p;
  }
  return null;
}

/**
 * Whether `rel` is the contract file or the run's own log (or a rotated piece of it), which a live run may not
 * Write or Edit. Compared without case: on a case-insensitive disk `.SDLC/...` is the same file.
 */
function guardsTheRun(rel, runId) {
  const r = rel.toLowerCase();
  if (r === CONTRACT_REL_PATH) return true;
  if (typeof runId !== "string" || !runId) return false;
  const runLog = `.sdlc/runs/${runId.toLowerCase()}/orchestrator.log`;
  return r === runLog || r.startsWith(`${runLog}.`);
}

/**
 * The contract state of the git project at `root`, or null when the project has no contract (no file, and no live
 * freeze record: a live run's contract deleted by other means is a change to it, not "no contract"). Read once:
 *   { root, live (the freeze record), tampered (why the contract cannot be trusted, or null), contract (parsed, or
 *     null for a file that is no regular file, too large, or not JSON), active, binds (active and its run not ended) }
 */
function projectState(root) {
  const contractPath = join(root, CONTRACT_REL_PATH);
  const live = liveFreeze(root);
  if (!live && !existsSync(contractPath)) return null;
  const tampered = contractTampered(root, live);
  let contract = null;
  try { contract = JSON.parse(readRegularFile(contractPath, { maxBytes: CONTRACT_MAX_BYTES })?.toString("utf8") ?? "null"); } catch { contract = null; }
  if (!contract || typeof contract !== "object") contract = null;
  const active = contract?.active === true;
  const binds = active && !runEnded(root, contract.run_id);
  return { root, live, tampered, contract, active, binds };
}

/**
 * The answer one project's contract gives for one path inside it, in the server writer's order (header):
 * `{ deny: msg, ctx }`, `{ warn: msg }` (allowed under strict = false, said), or `{}` (allowed).
 */
function verdict(st, rel) {
  const c = st.contract;
  const runId = typeof c?.run_id === "string" && c.run_id ? c.run_id : null;
  const ctx = { runId: c?.run_id, path: rel, strict: c?.strict };
  // The contract and the run's own log decide what this run may write and when it is over: while the run is live,
  // neither is the run's to Write or Edit, whatever the allowlist and its own folder's carve-out below say. Under
  // strict = false only a contract with no freeze record (frozen before the record existed) lets it through with a
  // warning: a frozen contract changed mid-run refuses every write after it, so allowing that write would wedge the run.
  if (st.binds && guardsTheRun(rel, c.run_id)) {
    if (c.strict === false && !st.live) return { warn: `${rel} is the run's own contract or log. Allowed because contract.strict = false.` };
    return {
      deny: `${rel} is the run's own write contract or log (run ${runId ?? "?"}), which a live run may not ` +
        `change: the contract is switched off by the run's end, and the log is written by the plugin's scripts only.`,
      ctx: { ...ctx, matchedRule: rel },
    };
  }
  // The run's own output directory is auto-allowlisted (agents/orchestrator.md
  // requires direct-tier artifacts to land under `.sdlc/runs/<run-id>/`).
  // `.sdlc/**` is in the default off-limits list and off-limits is evaluated
  // before the allowlist, so without this the contract refuses the run the
  // artifacts it is told to write. Scoped to this contract's run_id.
  if (st.binds && runId && rel.startsWith(`.sdlc/runs/${runId}/`)) return {};
  // The always-off-limits list, at any depth and under any contract, as the server's writer refuses it (and as this
  // hook refuses it with no contract at all): a contract, strict = false included, never opens credentials, MCP
  // config, another AI tool's rules or git's own store.
  const hard = HARDCODED_OFF_LIMITS.find((p) => matchesAtAnyDepth(rel, p));
  if (hard) {
    return {
      deny: `${rel} matches off-limits pattern "${hard}" (run ${runId ?? "?"}), one of the paths no run writes, ` +
        `whatever its contract says: credentials, MCP config, another AI tool's rules, git's own store.`,
      ctx: { ...ctx, matchedRule: hard },
    };
  }
  if (!st.active || !st.binds) return {};
  // Off-limits check runs first — an off-limits path is refused even if it
  // also technically matches an allowlist glob (defensive: patterns can overlap).
  const offHit = firstMatch(rel, c.off_limits, { ci: true });
  if (offHit) {
    if (c.strict === false) return { warn: `${rel} matches off-limits pattern "${offHit}". Allowed because contract.strict = false.` };
    return { deny: `${rel} matches off-limits pattern "${offHit}" (run ${runId ?? "?"}). ${SCOPE_IS_THE_PERSONS}`, ctx: { ...ctx, matchedRule: offHit } };
  }
  if (firstMatch(rel, c.allowlist)) return {};
  // Not in allowlist, not off-limits → deny by default (allowlist-based safety).
  if (c.strict === false) return { warn: `${rel} is not in the confirmed allowlist. Allowed because contract.strict = false.` };
  return { deny: `${rel} is not in the confirmed allowlist for run ${runId ?? "?"}. ${SCOPE_IS_THE_PERSONS}`, ctx };
}

/** One project's answer for a target inside it: the tamper check, then every path the write is judged by. */
function decide(st, absTarget, target) {
  if (st.tampered) return { deny: st.tampered, ctx: { path: target } };
  const { paths, leaves } = judgedPaths(st.root, absTarget);
  if (leaves && st.binds) {
    return {
      deny: `${target} leads OUTSIDE the contract's repo root (${st.root}) through a link. Cross-project writes are ` +
        `refused — a brownfield run can only write inside the repo whose contract it holds.`,
      ctx: { runId: st.contract?.run_id, path: target },
    };
  }
  const warns = [];
  for (const rel of paths) {
    const v = verdict(st, rel);
    if (v.deny) return v;
    if (v.warn) warns.push(v.warn);
  }
  return { warns, runId: st.contract?.run_id, rel: paths[0] };
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

  // The session's own project: the git project holding the session's folder, and its contract.
  const sessionRoot = gitRoot(process.cwd());
  const session = sessionRoot ? projectState(sessionRoot) : null;

  // Escape check: while the session's project contract governs (it binds, or it is a live run's contract that no
  // longer matches its record), a target outside that project is a category error regardless of what any
  // target-anchored lookup would say. Closes the SiteNotes shape: session cwd=repoA, target=absolute path in repoB,
  // old code found repoA's contract and mislabeled the escape as "not in allowlist."
  if (session && (session.binds || session.tampered) && insidePath(sessionRoot, absTarget) === null) {
    if (session.tampered) deny(session.tampered, { path: target });
    const targetRoot = gitRoot(dirname(absTarget));
    const targetContract = targetRoot && existsSync(join(targetRoot, CONTRACT_REL_PATH)) ? join(targetRoot, CONTRACT_REL_PATH) : null;
    deny(
      `${absTarget} resolves OUTSIDE the calling session's contracted repo ` +
      `(${sessionRoot}). Cross-project writes are refused — a brownfield ` +
      `run can only write inside the repo whose contract it holds.` +
      (targetContract ? ` (Target has its own contract at ${targetContract}; ` +
        `run against that project explicitly if you meant to edit it.)` : "")
    );
  }

  // The contracts that decide this write: the one at the root of the git project that holds the target, and, for a
  // target inside the session's project but in a nested git project, the session's project contract as well.
  const targetRoot = gitRoot(dirname(absTarget));
  const states = [];
  if (targetRoot) states.push(sameFolder(targetRoot, sessionRoot) ? session : projectState(targetRoot));
  if (session && !sameFolder(targetRoot, sessionRoot) && insidePath(sessionRoot, absTarget) !== null) states.push(session);
  const deciding = states.filter(Boolean);

  // Pre-contract safety net: even without any contract, always refuse writes to a known-sensitive path (credentials,
  // MCP config, other-AI-tool state, git's own store). Old code fell through to "allow" here — the hole that let
  // setup-phase Edits overwrite `.env` files without warning.
  if (deciding.length === 0) {
    // `matchesAtAnyDepth` handles bare filenames, shallow relative paths, and deep absolute paths in one call.
    const preHit = HARDCODED_OFF_LIMITS.find((p) => matchesAtAnyDepth(targetNorm, p));
    if (preHit) {
      // No contract opens this list (verdict() refuses it under every contract too), so the refusal names no way past
      // it: the person decides whether such a file changes.
      deny(
        `${target} matches always-off-limits pattern "${preHit}" (no active brownfield contract; ` +
        `this is the safety net for credentials, MCP config, other-AI-tool state and git's own store, ` +
        `which no Write or Edit here changes, under a contract or not). If this file needs to change, ` +
        `stop and tell the person which file and why.`
      );
    }
    allow("no write contract at the root of the target's or the session's git project — greenfield or non-plugin operation");
  }

  // Every deciding contract must allow the write: the first refusal is the answer.
  const warns = [];
  let last = {};
  for (const st of deciding) {
    const v = decide(st, absTarget, target);
    if (v.deny) deny(v.deny, v.ctx);
    warns.push(...v.warns);
    last = v;
  }
  for (const w of new Set(warns)) console.error(`[mmo-brownfield write-contract] WARN: ${w}`);
  allow(`${last.rel ?? target} is allowed by the project's contract`, { runId: last.runId, path: last.rel });
}

main().catch((e) => {
  // Unhandled error — fail-open. Better to permit a write than to wedge the user.
  if (process.env.MMO_DEBUG === "1") console.error(`[mmo-brownfield write-contract] unhandled: ${e?.message ?? e}`);
  process.exit(0);
});
