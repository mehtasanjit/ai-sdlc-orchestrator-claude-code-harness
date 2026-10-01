#!/usr/bin/env node
/**
 * plan-to-packets — derive `packets.json` from a linted brownfield
 * `change_plan.md` with no model call.
 *
 * Why: after Row 4 (architect.md "Per-unit sections") every unit section is
 * structured — File / Action / Depends on / Mirror / Edit anchor / Verify /
 * Acceptance — and every worker packet is the same three inputs plus one
 * instruction template. Writing that by hand cost the orchestrator $1.03 on
 * the 2026-09-18 row-4 run (9 Opus turns) against $0.47 when the plan
 * carried the code. A derivation is exact, free, and checks the plan
 * against the repo on the way (a mirror that names a missing file or a line
 * past the end of it is an architect error caught before any packet is paid).
 *
 * Emits one packet per unit, in plan order (the plan's sequencing section
 * is already topological): `new_file` → an apply packet returning the whole
 * file; `edit` → an apply packet in `edits` mode (the server splices the
 * returned edit list into the file); `tooling` → an orchestrator shell step
 * with no model. Test files go to the `tests` phase. `task_type` follows the
 * path (codegen rule vocabulary in the shipped policies); a unit may override
 * with a `- **Packet** task_type=…, module=…` bullet.
 *
 * Exit 0 = packets written (warnings, if any, on stderr). 1 = a unit cannot
 * be turned into a packet (missing File/Action, unknown Action, an edit with
 * no Edit anchor, a mirror outside the repo). 2 = usage / unreadable input.
 *
 * Usage: node plan-to-packets.mjs <change_plan.md> --run-id <id> [--intent <i>]
 *          [--project-root <dir>] [--plan-path <repo-relative plan path>]
 *          [--out packets.json] [--json] [--multi-model]
 *
 * --multi-model (the policy has a mechanical tier): an edit unit with no edit
 * sites is an error, not a whole-file fallback, and every JS/TS packet verifies
 * with check-imports.mjs first, so a worker that guesses a sibling unit's
 * import path retries on its own tier instead of failing the deferred
 * typecheck (Run 25: three of four debug rounds).
 *
 * Every worker packet also carries the plan sections of the units it depends
 * on: the worker cannot open a sibling's file, and that section names its
 * path and Exports — what the import has to match.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUDGET = { maxInputTokens: 16000, maxOutputTokens: 6000 };
export const MAX_RETRIES = 2;
// Any capital letter: architects have used `B<n>` ids, and an A-only pattern dropped those units without a word (Run 20).
const UNIT_HEADING = /^## ([A-Z]\d+)\s+[—-]+\s+(\S.*?)\s*$/;
const UNIT_ID = /\b[A-Z]\d+\b/g;
const HOUSE_STYLE = "House style";
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const MAX_DEP_SECTIONS = 4;
const CHECK_IMPORTS = resolve(dirname(fileURLToPath(import.meta.url)), "check-imports.mjs");

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Every `## An — <path>` section: id, path, heading text, body lines. Plus whether `## House style` exists. */
export function parsePlan(text) {
  const lines = text.split("\n");
  const units = [];
  let houseStyle = false;
  let cur = null;
  for (const line of lines) {
    const h = line.match(/^## (.*)$/);
    if (h) {
      cur = null;
      if (h[1].trim() === HOUSE_STYLE) houseStyle = true;
      const u = line.match(UNIT_HEADING);
      if (u) {
        cur = { id: u[1], path: u[2].replace(/^`|`$/g, ""), heading: h[1].trim(), body: [] };
        units.push(cur);
      }
      continue;
    }
    if (cur) cur.body.push(line);
  }
  return { units, houseStyle };
}

/** The lines of one `- **Name**` bullet: its first line (after the label) and its indented continuation. */
function bullet(body, name) {
  const re = new RegExp(`^- \\*\\*${name}\\*\\*\\s*(.*)$`);
  for (let i = 0; i < body.length; i++) {
    const m = body[i].match(re);
    if (!m) continue;
    const rest = [];
    for (let j = i + 1; j < body.length; j++) {
      if (/^- \*\*/.test(body[j]) || /^## /.test(body[j])) break;
      rest.push(body[j]);
    }
    return { head: m[1].trim(), rest };
  }
  return null;
}

function backticked(s) {
  return [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** `path:from-to`, `path:from-to,from-to`, `path:line`, or bare `path`. */
export function parseRef(ref) {
  const m = ref.match(/^([^\s:`]+?)(?::(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*))?$/);
  if (!m) return null;
  // A path, not an identifier: has a directory separator or a source-file extension, and is not a glob.
  if (!/[\/]/.test(m[1]) && !/\.(ts|tsx|js|jsx|mjs|cjs|json|md|ya?ml|svg|html|css|scss|py|go|rs|java|kt|sql|toml|txt|env|prisma)$/i.test(m[1])) return null;
  if (/[*?]/.test(m[1])) return null;
  // An import specifier (`../../x`, `./x`, `@/x`, `@scope/pkg`) is how code names a module, not where the file is.
  if (/^["']?(\.\.?\/|@)/.test(m[1])) return null;
  const ranges = [];
  if (m[2]) {
    for (const r of m[2].split(",")) {
      const [a, b] = r.split("-").map(Number);
      ranges.push([a, b ?? a]);
    }
  }
  return { path: m[1], ranges };
}

function parseFileLine(head) {
  const path = (head.match(/^`([^`]+)`/) || [])[1];
  const action = (head.match(/\*\*Action\*\*\s*`([^`]+)`/) || [])[1];
  const depRaw = head.match(/\*\*Depends on\*\*\s*(.*)$/)?.[1];
  const depends = depRaw === undefined ? undefined : [...depRaw.matchAll(UNIT_ID)].map((m) => m[0]);
  return { path, action, depends };
}

/**
 * File, Action and Depends on for one unit. The canonical form is one bullet
 * (`- **File** \`p\` · **Action** \`x\` · **Depends on** A1`), but architects also
 * write them as separate bullets or leave the path in the heading only — Runs 19
 * and 21 each paid two re-delegations for that. Every form carries the same
 * facts, so read whichever is there: the path falls back to the heading, the
 * Action to its own bullet and then to whether the file exists.
 */
const ACTION_ALIASES = {
  create: "new_file", new: "new_file", add: "new_file", "new-file": "new_file", newfile: "new_file",
  modify: "edit", update: "edit", change: "edit",
};

function unitHeader(u, exists) {
  const file = bullet(u.body, "File");
  // A long File bullet soft-wraps (`… · **Action** \`x\` ·` / `  **Depends on** A1`); Run 27b lost 10 of
  // 15 dependency lists to that. Join the indented, non-bullet continuation lines before parsing.
  const wrapped = [];
  for (const l of file?.rest ?? []) { if (!/^\s+\S/.test(l) || /^\s*- /.test(l)) break; wrapped.push(l.trim()); }
  const fromFile = file ? parseFileLine([file.head, ...wrapped].join(" ")) : {};
  const path = fromFile.path ?? u.path;
  let action = fromFile.action ?? (bullet(u.body, "Action")?.head.match(/`([^`]+)`/) || [])[1];
  let inferred = false;
  // Common synonyms (Run 31's orchestrator told the architect `create`; 10 units failed and the plan was
  // re-edited). They are unambiguous, so map them rather than fail; the canonical words stay in architect.md.
  let aliased = null;
  if (action && ACTION_ALIASES[action.trim().toLowerCase()]) { aliased = action; action = ACTION_ALIASES[action.trim().toLowerCase()]; }
  if (!action && path) { action = exists(path) ? "edit" : "new_file"; inferred = true; }
  let depends = fromFile.depends;
  let noDepends = false;
  if (depends === undefined) {
    const d = bullet(u.body, "Depends on");
    noDepends = !d;
    depends = d ? [...[d.head, ...d.rest].join(" ").matchAll(UNIT_ID)].map((m) => m[0]) : [];
  }
  return { path, action, depends, noDepends, hadFileBullet: Boolean(file), inferred, aliased };
}

/** Same glob dialect as write-contract-check.mjs (`**`, `*`, `?`); that module runs on import, so it is not shared. */
function matchGlob(path, pattern) {
  if (path === pattern) return true;
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x00/g, ".*");
  return new RegExp(`^${re}$`).test(path);
}

/** The active strict write contract for this run, or null. A unit outside its allowlist would only be refused at write time. */
function activeContract(projectRoot, runId) {
  if (!projectRoot) return null;
  try {
    const c = JSON.parse(readFileSync(resolve(projectRoot, ".sdlc/local/write-contract.json"), "utf8"));
    if (!c.active || !c.strict || c.run_id !== runId || !Array.isArray(c.allowlist)) return null;
    return c;
  } catch { return null; }
}

/**
 * The edit sites of one unit: the `- **Edit anchor**` bullet, or — the form an
 * architect wrote on Run 23 — a `### Edits` sub-heading whose items start with
 * `**L<n>**`. That form yielded no anchors, so all five edit units fell back to
 * whole-file packets (82 kB and 65 kB files against an 8k output cap) while the
 * script still exited 0. Both forms are read here as one bullet. Run 24's architect
 * labelled the bullet `- **Edit**` instead; it is read the same way.
 */
export function editSites(body) {
  const b = bullet(body, "Edit anchor") ?? bullet(body, "Edits?");
  if (b) return b;
  const start = body.findIndex((l) => /^###\s+Edit/i.test(l));
  if (start === -1) return null;
  const rest = [];
  for (let j = start + 1; j < body.length; j++) {
    const l = body[j];
    if (/^#{2,3}\s/.test(l)) break;
    // A top-level labelled bullet (`- **Acceptance**`) ends the list; an `**L59**` item does not.
    if (/^- \*\*(?!L\d+\*\*|`?:\d+)/.test(l)) break;
    rest.push(l.replace(/^(\s*- )\*\*L(\d+)\*\*/, "$1`:$2`"));
  }
  return { head: "", rest };
}

/**
 * Every `:NNN` line reference in the Edit anchor bullet, with the quoted
 * anchor text when it directly follows (`after \`:59\` \`import …\``). A
 * reference in prose (`the closing \`});\` (\`:263\`)`) yields the line alone;
 * the worker reads the text from the context slice the line selects.
 *
 * Only the bullet's first line and the first line of each sub-item are read.
 * A wrapped continuation line is explanation: on Run 23 its "at `:574`" and
 * "on `:60`" became edit sites, and `:574` is the authenticating middleware.
 */
export function parseAnchors(b) {
  if (!b) return [];
  const out = [];
  const seen = new Set();
  const itemLines = [b.head, ...b.rest.filter((l) => /^\s*(?:[-*]|\d+\.)\s/.test(l))];
  for (const line of itemLines) {
    // An ordering constraint ("stays above `:574` `api.use(…`") names a line the edit must not
    // cross, not a site. Everything from the constraint word to the end of the sub-bullet is skipped.
    const sites = line.replace(/\b(above|below|before the|after the|ordering constraint|constraint|stays?)\b[^;]*$/i, (m, w, off) => (off > 0 ? "" : m));
    // `:59` `text` · `L59` `text` · line 59 · (`:59`) — the first two are the canonical pair form.
    // `after :59 -> rule` (position word and line inside one backtick span, Run 24) is read too.
    for (const m of sites.matchAll(/(?:`:(\d+)(?:-\d+)?`|`?\bL(\d+)(?:-\d+)?\b`?|\bline\s+(\d+)\b|\b(?:after|before|replace|insert|delete)\s+:(\d+)\b)(?:\**\s*`([^`]+)`)?/gi)) {
      const n = Number(m[1] ?? m[2] ?? m[3] ?? m[4]);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push({ line: n, anchor: m[5] ?? null });
    }
  }
  return out.sort((x, y) => x.line - y.line);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** task_type in the vocabulary the shipped codegen/tests rules route on. */
export function classify(path, action) {
  const p = path.replace(/\\/g, "/");
  if (action === "tooling") return { phase: "codegen", task_type: "tooling" };
  if (TEST_PATH.test(p)) {
    return { phase: "tests", task_type: /integration|e2e/.test(p) ? "test_integration" : "test_unit" };
  }
  const web = /(^|\/)(web|frontend|client|app)\//.test(p) || /\.(tsx|jsx|css|html|svg)$/.test(p);
  if (/\.(svg|html)$/.test(p)) return { phase: "codegen", task_type: "frontend_html" };
  if (/(^|\/)(i18n|locales?)\//.test(p)) return { phase: "codegen", task_type: "frontend_config" };
  if (/\.json$/.test(p)) return { phase: "codegen", task_type: web ? "frontend_config" : "seed_data" };
  if (/(^|\/)(migrations?|drizzle|prisma)\//.test(p)) return { phase: "codegen", task_type: "migration" };
  if (web) {
    if (/(^|\/)routes?\/.*\.tsx$/.test(p)) return { phase: "codegen", task_type: "react_page" };
    if (/\.tsx$/.test(p)) return { phase: "codegen", task_type: "react_component" };
    if (/(^|\/)(fetchers?|api|client)\//.test(p)) return { phase: "codegen", task_type: "api_client" };
    if (/routeTree|(^|\/)config\//.test(p)) return { phase: "codegen", task_type: "frontend_config" };
    return { phase: "codegen", task_type: "frontend_util" };
  }
  if (/(^|\/)controllers?\//.test(p)) return { phase: "codegen", task_type: "controller_handler" };
  if (/schemas?|dto/.test(p)) return { phase: "codegen", task_type: "dto" };
  if (/(^|\/)(index|app|main|routes?)\.[cm]?[jt]s$/.test(p) && action === "edit") return { phase: "codegen", task_type: "module_wiring" };
  if (/(^|\/)(guards?)\//.test(p)) return { phase: "codegen", task_type: "guard" };
  if (/(^|\/)(interceptors?)\//.test(p)) return { phase: "codegen", task_type: "interceptor" };
  return { phase: "codegen", task_type: "service_method" };
}

export function moduleOf(path) {
  const p = path.replace(/\\/g, "/").split("/");
  const i = p.findIndex((s) => s === "src");
  if (i > 0 && p[i + 1]) return `${p[i - 1]}-${p[i + 1].replace(/\.[^.]+$/, "")}`;
  if (p[0] === "tests" && p[1]) return `${p[1]}-${p[2]?.replace(/\.[^.]+$/, "") ?? "tests"}`;
  return p.length > 1 ? p.slice(0, 2).join("-") : "root";
}

// ---------------------------------------------------------------------------
// Packets
// ---------------------------------------------------------------------------

const NEW_FILE_INSTRUCTION = (path, id) =>
  `Implement \`${path}\` from change_plan section \`${id}\`: satisfy every Exports signature and Behavior rule; ` +
  `copy the shape of the Mirror input(s) for imports, errors and structure; follow House style. ` +
  `Return JSON {path, content} with the complete file content.`;

const EDIT_INSTRUCTION = (path, id) =>
  `Produce the edit list for \`${path}\` from change_plan section \`${id}\` (its Behavior rules and Edit anchor bullets). ` +
  `Do NOT return the file. Return JSON {edits: [{line, anchor, position, text}]} — one entry per anchor in file order: ` +
  `\`line\` is the anchor's 1-based line number, \`anchor\` the exact existing text of that line, \`position\` "after" | "before" | "replace" | "delete", ` +
  `\`text\` the lines to insert (or the replacement), formatted per House style; for replace/delete, \`count\` = lines removed from the anchor down (default 1; delete needs no text).`;

const RUNNERS = /^(pnpm|npm|npx|yarn|bun|node|deno|python3?|pip|go|cargo|make|sh|bash|cd|vitest|jest|biome|tsc|eslint|prettier|pytest|ruff|mypy|dotnet|mvn|gradle|test|grep)\b/;
/** A backticked span in a Verify bullet is a command only when it starts with a runner. Prose (`"<svg "`, `11`) is not. */
export function isCommand(span) {
  return RUNNERS.test(span.trim());
}

/**
 * A verify command that names the file (or `{path}`) checks this packet's own output and runs in the
 * loop; one that does not (a package typecheck, the full suite) sees every unfinished packet's work
 * and is deferred to the end of the phase — measured: a route-tree edit was retried for another
 * packet's import errors.
 */
export function splitVerify(cmds, path) {
  const base = path.split("/").pop();
  const scoped = [];
  const deferred = [];
  for (const c of cmds) {
    // `public-profile.\$userId.tsx` or a quoted path is still this file; unescaped, the check was silently deferred.
    const plain = c.replace(/\\(?=\$)/g, "").replace(/['"]/g, "");
    if (plain.includes("{path}") || plain.includes(path) || (base && plain.includes(base))) scoped.push(c);
    else deferred.push(c);
  }
  return { scoped, deferred };
}

/**
 * A literal path in double quotes (or bare) lets the shell expand a `$segment`, so rewrite the
 * file's own path — quoted, bare, or with `\$` escapes — to the single-quoted placeholder.
 */
export function placeholderPath(cmds, path) {
  if (!path?.includes("$")) return cmds;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Each `$` may appear escaped (`\$`) or not.
  const body = path.split("$").map(esc).join("\\\\?\\$");
  const re = new RegExp(`"${body}"|'${body}'|(?<![\\w./-])${body}(?![\\w./-])`, "g");
  return cmds.map((c) => c.replace(re, "'{path}'"));
}

/**
 * The formatter pass the server runs on a written file before verify, derived
 * from the verify commands' own check: `biome check X` → `biome check --write X`
 * (safe fixes + format), `prettier --check X` → `prettier --write X`. 4 of 6
 * retries on Run 23 were Biome line width — a model round trip for what the
 * formatter does in a second.
 */
export function formatCommands(verifyCmds) {
  const out = [];
  for (const c of verifyCmds) {
    if (/\bbiome\s+(check|format)\b/.test(c) && !/--write\b/.test(c)) out.push(c.replace(/\bbiome\s+(check|format)\b/, "biome $1 --write"));
    else if (/\bprettier\b.*--check\b/.test(c)) out.push(c.replace(/--check\b/, "--write"));
  }
  return out;
}

/**
 * Biome checks line endings, so on a checkout where the file being edited has CRLF endings
 * (autocrlf on Windows/WSL) `biome check <file>` fails before any edit is made. Large-A had
 * 11 of 26 packets hand-fixed for this; Large2-A's architect spent 21 turns (≈ $2) finding it.
 * Derive it here instead: no model turn needed.
 */
export function crlfAware(cmds) {
  return cmds.map((c) => (/\bbiome\s+(check|format)\b/.test(c) && !/--line-ending\b/.test(c) ? c.replace(/\bbiome\s+(check|format)\b/, "biome $1 --line-ending=crlf") : c));
}

/**
 * Biome does not process Markdown / MDX / YAML, so `biome check x.mdx` exits 1 on any content
 * ("no files were processed"). Large2-C spent 6 worker attempts and 2 hand-written refinement
 * packets on two docs pages whose only failure was that check. Drop it; other Verify commands stay.
 */
export const BIOME_UNSUPPORTED = /\.(mdx?|ya?ml)$/i;
export function dropUnsupportedBiome(cmds, path) {
  if (!BIOME_UNSUPPORTED.test(path)) return cmds;
  return cmds.filter((c) => !/\bbiome\s+(check|format|lint)\b/.test(c));
}

/** Edit lists longer than this are split into chunk packets: Flash's output cap is spent on reasoning first. */
export const MAX_ANCHORS_PER_PACKET = 5;

/** Merge ±pad line windows around anchors into a few ranges for hydration. */
function anchorRanges(anchors, pad = 4) {
  const rs = anchors.map((a) => [Math.max(1, a.line - pad), a.line + pad]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

export function buildPackets(plan, opts) {
  const { runId, intent, planPath, projectRoot, multiModel = false } = opts;
  const errors = [];
  const warnings = [];
  const packets = [];
  const seen = new Set();
  const counters = { codegen: 0, tests: 0, tooling: 0 };

  if (!plan.houseStyle) warnings.push("no `## House style` section; worker packets carry only the unit spec and mirrors");

  const lineCount = (p) => {
    if (!projectRoot) return null;
    const abs = resolve(projectRoot, p);
    if (!existsSync(abs)) return -1;
    return readFileSync(abs, "utf8").split("\n").length;
  };
  const inRepo = (p) => {
    if (!projectRoot) return true;
    const rel = relative(projectRoot, resolve(projectRoot, p));
    return !(rel.startsWith("..") || rel.startsWith(sep) || /^[A-Za-z]:/.test(rel));
  };

  const contract = activeContract(projectRoot, runId);
  const dropped = new Set();
  const exists = (p) => { const n = lineCount(p); return n !== null && n !== -1; };

  for (const u of plan.units) {
    const { path, action, depends, noDepends, hadFileBullet, inferred, aliased } = unitHeader(u, exists);
    if (!path || !action) { errors.push(`${u.id}: no path in the heading or a \`- **File**\` bullet`); continue; }
    if (!["new_file", "edit", "tooling"].includes(action)) { errors.push(`${u.id}: unknown Action \`${action}\``); continue; }
    if (!hadFileBullet) warnings.push(`${u.id}: no \`- **File**\` bullet; path taken from the heading`);
    if (noDepends) warnings.push(`${u.id}: no \`**Depends on**\` found; assumed none — check the plan if this unit imports another`);
    if (aliased) warnings.push(`${u.id}: Action \`${aliased}\` read as \`${action}\``);
    if (inferred) warnings.push(`${u.id}: no Action; inferred \`${action}\` from whether ${path} exists`);
    if (hadFileBullet && path !== u.path) warnings.push(`${u.id}: heading path ${u.path} differs from File ${path}; using File`);
    if (contract && !contract.allowlist.some((g) => matchGlob(path, g))) {
      warnings.push(`${u.id}: ${path} is outside the write contract allowlist; no packet (record it as a follow-up)`);
      dropped.add(u.id);
      continue;
    }
    if (seen.has(path) && action !== "tooling") warnings.push(`${u.id}: ${path} already has a packet; two units edit one file`);
    seen.add(path);
    if (!inRepo(path)) { errors.push(`${u.id}: ${path} is outside the project`); continue; }

    const override = bullet(u.body, "Packet");
    let { phase, task_type } = classify(path, action);
    let module = moduleOf(path);
    if (override) {
      const t = override.head.match(/task_type=([\w-]+)/); if (t) task_type = t[1];
      const m = override.head.match(/module=([\w-]+)/); if (m) module = m[1];
      const ph = override.head.match(/phase=(\w+)/); if (ph) phase = ph[1];
    }
    const depIds = depends.map((d) => `plan:${d}`);

    if (action === "tooling") {
      counters.tooling++;
      const behavior = bullet(u.body, "Behavior");
      const steps = behavior ? [behavior.head, ...behavior.rest].map((l) => l.trim()).filter(Boolean).join(" ") : "";
      packets.push({
        id: `tooling_${String(counters.tooling).padStart(3, "0")}`,
        unit: u.id,
        phase,
        task_type: "tooling",
        module,
        intent,
        pass_id: runId,
        artifact_path: path,
        depends_on: depIds,
        instruction: `Orchestrator shell step, no model (change_plan ${u.id}): ${steps || "see the section"}`,
        inputs: [],
        outputSchema: { type: "object", properties: { result: { type: "string" } } },
        acceptance: acceptanceOf(u.body),
        budget: { maxInputTokens: 0, maxOutputTokens: 0 },
      });
      continue;
    }

    const isTest = phase === "tests";
    const n = ++counters[isTest ? "tests" : "codegen"];
    const id = `tp_${isTest ? "tests" : "codegen"}_${String(n).padStart(3, "0")}`;
    const inputs = [
      { path: planPath, section: u.heading, reason: "unit spec" },
    ];
    if (plan.houseStyle) inputs.push({ path: planPath, section: HOUSE_STYLE, reason: "house style" });
    for (const d of depends.slice(0, MAX_DEP_SECTIONS)) {
      const dep = plan.units.find((x) => x.id === d);
      if (dep && dep.id !== u.id) inputs.push({ path: planPath, section: dep.heading, reason: "dependency spec (its path and Exports)" });
    }

    const errorsBefore = errors.length;
    const mirror = bullet(u.body, "Mirror");
    if (mirror) {
      for (const ref of backticked([mirror.head, ...mirror.rest].join(" "))) {
        const r = parseRef(ref);
        if (!r) continue;
        if (!inRepo(r.path)) { warnings.push(`${u.id}: mirror ${r.path} is outside the project; dropped`); continue; }
        const n = lineCount(r.path);
        if (n === -1) { warnings.push(`${u.id}: mirror ${r.path} does not exist; dropped`); continue; }
        if (r.ranges.length === 0) inputs.push({ path: r.path, reason: "mirror" });
        for (const [a, b] of r.ranges) {
          if (n !== null && a > n) { warnings.push(`${u.id}: mirror ${r.path}:${a}-${b} starts past the end (${n} lines); dropped`); continue; }
          inputs.push({ path: r.path, lines: [a, n !== null ? Math.min(b, n) : b], reason: "mirror" });
        }
      }
    } else if (action === "new_file") {
      warnings.push(`${u.id}: no Mirror; the worker has only the spec and House style`);
    }
    if (errors.length > errorsBefore) continue;

    let mode = "content";
    let anchorChunks = [null]; // one packet; edits mode with many anchors makes several
    let fileLines = null;
    if (action === "edit") {
      const n = lineCount(path);
      fileLines = n;
      if (n === -1) { errors.push(`${u.id}: edit target ${path} does not exist`); continue; }
      const anchors = parseAnchors(editSites(u.body));
      if (anchors.length === 0 && multiModel) {
        // A cheaper worker cannot rewrite a large file inside its output cap; stop here, where one
        // narrow architect Edit fixes it, instead of paying for a whole-file packet that fails later.
        errors.push(`${u.id}: edit of ${path} has no edit sites — give each as a sub-bullet \`after \`:N\` \`<line text>\`\` under \`- **Edit anchor**\``);
        continue;
      }
      if (anchors.length === 0) {
        // No line references: the worker gets the whole file and returns the whole file.
        warnings.push(`${u.id}: edit with no \`:line\` references in Edit anchor; whole-file mode (costlier output) — give anchors as \`:line\` \`text\``);
        inputs.push({ path, reason: "existing file (whole)" });
      } else {
        mode = "edits";
        if (projectRoot && n !== null) {
          const text = readFileSync(resolve(projectRoot, path), "utf8").split("\n");
          for (const a of anchors) {
            if (a.line > n) warnings.push(`${u.id}: anchor :${a.line} is past the end of ${path} (${n} lines)`);
            else if (a.anchor && text[a.line - 1].replace(/\s+$/, "") !== a.anchor.replace(/\s+$/, "")) {
              warnings.push(`${u.id}: anchor :${a.line} text differs from ${path}:${a.line} — the worker will search by text`);
            }
          }
        }
        // Chunks run bottom-up: the packet nearest the end of the file goes first, so no earlier
        // packet's insertions shift the line numbers the next packet carries.
        anchorChunks = [];
        for (let i = 0; i < anchors.length; i += MAX_ANCHORS_PER_PACKET) anchorChunks.push(anchors.slice(i, i + MAX_ANCHORS_PER_PACKET));
        anchorChunks.reverse();
        if (anchorChunks.length > 1) warnings.push(`${u.id}: ${anchors.length} anchors split into ${anchorChunks.length} packets of ≤ ${MAX_ANCHORS_PER_PACKET}`);
      }
    }

    const verify = bullet(u.body, "Verify");
    const spans = verify ? backticked([verify.head, ...verify.rest].join(" ")) : [];
    const cmds = spans.filter(isCommand);
    const split = splitVerify(cmds, path);
    const { deferred } = split;
    let { scoped } = split;
    scoped = placeholderPath(dropUnsupportedBiome(scoped, path), path);
    if (action === "edit" && projectRoot && lineCount(path) > 0 && readFileSync(resolve(projectRoot, path), "utf8").includes("\r\n")) {
      // Not a warning: the orchestrator touches packets a warning names, and this one needs nothing.
      scoped = crlfAware(scoped);
    }
    const format = formatCommands(scoped);
    if (scoped.length === 0 && !BIOME_UNSUPPORTED.test(path)) warnings.push(`${u.id}: no file-scoped Verify command; the server cannot check the worker's output${deferred.length ? " (package-wide commands are deferred)" : ""}`);

    // `{path}` is single-quoted: the server substitutes it into a shell, and route files carry `$userId`.
    const verifyCmds = multiModel && CODE_FILE.test(path) ? [`node ${JSON.stringify(CHECK_IMPORTS)} '{path}'`, ...scoped] : scoped;

    let prevChunkId = null;
    anchorChunks.forEach((chunk, ci) => {
      const chunkId = anchorChunks.length > 1 ? `${id}-${String.fromCharCode(97 + ci)}` : id;
      const chunkInputs = [...inputs];
      let instruction = mode === "edits" ? EDIT_INSTRUCTION(path, u.id) : NEW_FILE_INSTRUCTION(path, u.id);
      if (chunk) {
        for (const [a, b] of anchorRanges(chunk)) chunkInputs.push({ path, lines: [a, fileLines !== null && fileLines > 0 ? Math.min(b, fileLines) : b], reason: "edit anchor context" });
        if (anchorChunks.length > 1) {
          instruction += ` Apply ONLY these Edit anchors (the section's other anchors belong to another packet): ${chunk.map((a) => `:${a.line}${a.anchor ? " " + JSON.stringify(a.anchor) : ""}`).join("; ")}.`;
        }
      }
      packets.push({
        id: chunkId,
        unit: u.id,
        phase,
        task_type,
        subtype: isTest ? "test_add" : action === "edit" ? "existing_file_edit" : "new_file_add",
        module,
        intent,
        pass_id: runId,
        artifact_path: path,
        depends_on: prevChunkId ? [...depIds, prevChunkId] : depIds,
        instruction,
        inputs: chunkInputs,
        acceptance: acceptanceOf(u.body),
        budget: mode === "edits" ? { ...BUDGET, maxOutputTokens: 8000 } : { ...BUDGET },
        retry_count: 0,
        apply: { write: true, mode, ...(format.length ? { format } : {}), verify: ci === anchorChunks.length - 1 ? verifyCmds : verifyCmds.filter((c) => c.includes(CHECK_IMPORTS) || !/vitest|jest|pytest|test\b/.test(c)), max_retries: MAX_RETRIES },
        ...(deferred.length && ci === anchorChunks.length - 1 ? { verify_deferred: deferred } : {}),
      });
      prevChunkId = chunkId;
    });
  }

  // Resolve plan:An → packet ids now that every unit has one.
  const byUnit = new Map();
  for (const p of packets) byUnit.set(p.unit, p.id); // the last chunk of a unit is what dependents wait for
  for (const p of packets) {
    p.depends_on = p.depends_on.filter((d) => !dropped.has(d.slice(5))).map((d) => byUnit.get(d.slice(5)) ?? d);
  }
  return { packets, errors, warnings };
}

function acceptanceOf(body) {
  const b = bullet(body, "Acceptance");
  if (!b) return [];
  const items = [b.head, ...b.rest]
    .map((l) => l.replace(/^\s*[-—]\s*/, "").trim())
    .filter((l) => l && !/^\*\*/.test(l))
    .map((l) => (l.length > 160 ? l.slice(0, 157) + "…" : l));
  return items.slice(0, 6);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { plan: null, runId: null, intent: undefined, projectRoot: null, planPath: null, outFile: null, json: false, multiModel: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]);
    if (a.startsWith("--run-id")) out.runId = val();
    else if (a.startsWith("--intent")) out.intent = val();
    else if (a.startsWith("--project-root")) out.projectRoot = val();
    else if (a.startsWith("--plan-path")) out.planPath = val();
    else if (a.startsWith("--out")) out.outFile = val();
    else if (a === "--json") out.json = true;
    else if (a === "--multi-model") out.multiModel = true;
    else if (!a.startsWith("--") && !out.plan) out.plan = a;
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.plan || !args.runId) {
    process.stderr.write("usage: plan-to-packets.mjs <change_plan.md> --run-id <id> [--intent <i>] [--project-root <dir>] [--plan-path <rel>] [--out packets.json] [--json] [--multi-model]\n");
    return 2;
  }
  let text;
  try { text = readFileSync(args.plan, "utf8"); } catch (e) { process.stderr.write(`plan-to-packets: cannot read ${args.plan}: ${e.message}\n`); return 2; }
  const projectRoot = args.projectRoot ? resolve(args.projectRoot) : null;
  const planPath = args.planPath ?? (projectRoot ? relative(projectRoot, resolve(args.plan)).split(sep).join("/") : args.plan);
  const plan = parsePlan(text);
  if (plan.units.length === 0) { process.stderr.write("plan-to-packets: no `## An — <path>` unit sections found\n"); return 1; }
  const { packets, errors, warnings } = buildPackets(plan, { runId: args.runId, intent: args.intent, planPath, projectRoot, multiModel: args.multiModel });
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
  if (errors.length) return 1;
  const outFile = args.outFile ?? resolve(dirname(args.plan), "packets.json");
  writeFileSync(outFile, JSON.stringify(packets, null, 2) + "\n");
  const summary = { packets: packets.length, codegen: packets.filter((p) => p.phase === "codegen" && p.task_type !== "tooling").length, tests: packets.filter((p) => p.phase === "tests").length, tooling: packets.filter((p) => p.task_type === "tooling").length, edits: packets.filter((p) => p.apply?.mode === "edits").length, warnings: warnings.length, out: outFile };
  process.stdout.write(args.json ? JSON.stringify(summary) + "\n" : `plan-to-packets: ${summary.packets} packets (${summary.codegen} codegen, ${summary.tests} tests, ${summary.tooling} tooling; ${summary.edits} edit lists) → ${outFile}${warnings.length ? ` · ${warnings.length} warning(s)` : ""}\n`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main());
}
