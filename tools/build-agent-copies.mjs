#!/usr/bin/env node
/**
 * Builds the brownfield copies of the plugin's agents (plugin/agents/brownfield-*.md).
 *
 * Why copies: every brownfield job runs its own packet flow (plan lint, derived packets, batched apply, greenfield's
 * typists, lean reviews). Its rules live in these copies and in plugin/skills/pipeline/brownfield-runs.md, so the
 * agents greenfield uses keep their own text, word for word.
 *
 * Each copy is its original agent file, unchanged, with:
 *   - its own name, and a description that says which runs it serves;
 *   - the tools those runs add (the orchestrator's execute_batch; the architect's Glob and Grep), less the tools and
 *     top-level sections of a flow those runs never use (the architect's greenfield executor mode);
 *   - Claude Code's default five-minute prompt cache for a helper that waits on no long call (the architect and the
 *     reviewers): an original's one-hour block is dropped, with the header comment that explains it;
 *   - the section in tools/agent-copies/<copy>.md appended after the original's text, with each `{{NAME}}` in it
 *     replaced by FILLS[NAME] (the change spec's shape, printed by the same code plan-lint --shape prints it with,
 *     so the architect reads exactly the shape its sections are checked against).
 * So a change to an original reaches its copy on the next build, and tools/test/agent-copies.test.mjs fails while a
 * committed copy differs from what this builds. Edit the originals or the sections, never a copy.
 *
 * Usage: node tools/build-agent-copies.mjs           write the copies
 *        node tools/build-agent-copies.mjs --check   exit 1, naming each copy that differs, without writing
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changeShape } from "../plugin/scripts/lib/change-spec.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = join(ROOT, "plugin", "agents");
const SECTIONS = join(ROOT, "tools", "agent-copies");

/**
 * Each copy's description is its own, not its original's: a copy is chosen only by name (the brownfield guide and
 * /mmo:pass name brownfield-orchestrator, which names the others), and the original orchestrator's description
 * advertises it for /mmo:greenfield, which in a copy would offer the brownfield flow to greenfield runs in every
 * session's agent list.
 */
export const COPIES = [
  {
    name: "brownfield-orchestrator",
    base: "orchestrator",
    description: "Orchestrator for brownfield runs only, every job; the brownfield guide delegates it by name. Drives the run's packet flow (skills/pipeline/brownfield-runs.md): the typed change spec, packets derived from it, batched dispatch through the bundled MCP server per the loaded policy, lean reviews, and the HITL gates.",
    toolsAfter: {
      "mcp__model-dispatch__execute_with_model": ["mcp__model-dispatch__execute_batch"],
      "mcp__plugin_mmo_model-dispatch__execute_with_model": ["mcp__plugin_mmo_model-dispatch__execute_batch"],
    },
  },
  {
    name: "brownfield-architect",
    base: "architect",
    description: "Architect for brownfield runs only, every job. Hands over the run's typed change spec from requirements.md, section by section, each checked against the files on arrival; code renders change_plan.md and derives the packets from it. Delegated by brownfield-orchestrator during the architecture_design phase.",
    toolsAfter: { Edit: ["Glob", "Grep"] },
    // Executor mode is greenfield's: its text and its two spec tools would send a brownfield architect down the
    // greenfield path (spec.sections/, submit_spec_section), which a brownfield change spec cannot pass. Its spec
    // goes through plan-lint and plan-to-packets instead (the copy's own section).
    dropTools: ["mcp__model-dispatch__submit_spec_section", "mcp__model-dispatch__finalize_spec", "mcp__plugin_mmo_model-dispatch__submit_spec_section", "mcp__plugin_mmo_model-dispatch__finalize_spec"],
    dropSections: ["# Executor mode"],
    cache: "default",
    // The original's comment for its one-hour cache starts here and runs to its cacheTtl line.
    dropHeaderFrom: "# The architect writes the spec over several calls",
  },
  {
    name: "brownfield-senior-reviewer",
    base: "senior-reviewer",
    description: "Senior code reviewer for brownfield runs only, every job. Reviews the run's diff against change_plan.md and reports each defect as a finding with its file. Delegated by brownfield-orchestrator during the senior_code_review phase.",
    cache: "default",
  },
  {
    name: "brownfield-security-reviewer",
    base: "security-reviewer",
    description: "Security reviewer for brownfield runs only, every job. Reviews the run's diff for PII handling, authz coverage, audit completeness, secret leakage and dependency risk, writes security_review.md, and gates HITL Gate 3. Delegated by brownfield-orchestrator.",
    cache: "default",
  },
];

/**
 * Written into a copy with `cache: "default"`. A one-hour cache write bills 2x input against 1.25x for five minutes,
 * and pays back only when a call comes more than five minutes after the one before; these helpers wait on no build,
 * test or other helper, so their calls follow one another closely. The orchestrator, which waits on all of those,
 * keeps its original's hour.
 */
const DEFAULT_CACHE = [
  "# This copy keeps Claude Code's default five-minute prompt cache: it runs no build or test and waits on no",
  "# other helper, so its calls follow one another closely, and a one-hour write (2x input, against 1.25x)",
  "# would be paid on every write for a lifetime it does not use.",
];

/**
 * The header without an original's one-hour cache block: from the comment line that starts with `from` through the
 * `cacheTtl` line of its `experimental:` block. Anything unexpected in that span is an error, so a change to the
 * original's header is looked at, not silently dropped.
 */
function dropCacheBlock(header, from, file) {
  const ttl = header.findIndex((l) => /^\s+cacheTtl:/.test(l));
  if (ttl < 0) return header;
  if (!from) throw new Error(`${file}: has a cacheTtl block this copy drops, but the copy names no dropHeaderFrom comment`);
  const start = header.findIndex((l) => l.startsWith(from));
  if (start < 0 || start > ttl) throw new Error(`${file}: no header comment "${from}" before its cacheTtl block`);
  const span = header.slice(start, ttl + 1);
  const expected = (l, i) => (i === span.length - 1 ? /^\s+cacheTtl:/.test(l) : i === span.length - 2 ? l === "experimental:" : l.startsWith("#"));
  if (!span.every(expected)) throw new Error(`${file}: the cacheTtl block is not a comment, experimental: and cacheTtl only`);
  if (/^\s/.test(header[ttl + 1] ?? "")) throw new Error(`${file}: experimental: holds more than cacheTtl`);
  return [...header.slice(0, start), ...header.slice(ttl + 1)];
}

/** The body without its top-level sections (`# ` headings) that start with one of `headings`, each with its rule. */
function dropBodySections(body, headings, file) {
  const parts = body.split(/\n(?=# )/);
  for (const h of headings) if (!parts.some((p) => p.startsWith(h))) throw new Error(`${file}: no section ${h}`);
  return parts.filter((p) => !headings.some((h) => p.startsWith(h))).join("\n");
}

/** Text generated into the sections at build time. */
export const FILLS = { CHANGE_SPEC_SHAPE: await changeShape() };

/** The agent file's header lines (between the two `---` lines) and its text after them. */
function split(text, file) {
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) throw new Error(`${file}: no front matter`);
  return { header: lines.slice(1, end), body: lines.slice(end + 1).join("\n") };
}

/** The copy's full text, built from its original and its section. */
export function buildCopy(copy, read = (p) => readFileSync(p, "utf8"), fills = FILLS) {
  const baseFile = join(AGENTS, `${copy.base}.md`);
  const original = split(read(baseFile), baseFile);
  const header = copy.cache === "default" ? dropCacheBlock(original.header, copy.dropHeaderFrom, baseFile) : original.header;
  const body = copy.dropSections ? dropBodySections(original.body, copy.dropSections, baseFile) : original.body;
  const out = [];
  let tools = 0, named = 0, described = 0;
  for (const line of header) {
    if (line.startsWith("name: ")) {
      out.push(`name: ${copy.name}`);
      out.push(`# Built by tools/build-agent-copies.mjs from agents/${copy.base}.md and tools/agent-copies/${copy.name}.md: edit those, then run it.`);
      named++;
    } else if (line.startsWith("description: ")) {
      out.push(`description: ${copy.description}`);
      described++;
    } else if (line.startsWith("tools: ")) {
      const list = line.slice("tools: ".length).split(",").map((t) => t.trim());
      const added = [];
      for (const t of list) {
        if (copy.dropTools?.includes(t)) continue;
        added.push(t);
        for (const extra of copy.toolsAfter?.[t] ?? []) added.push(extra);
      }
      for (const [after, extra] of Object.entries(copy.toolsAfter ?? {})) {
        if (!list.includes(after)) throw new Error(`${copy.base}.md: no tool ${after} to add ${extra.join(", ")} after`);
      }
      for (const t of copy.dropTools ?? []) if (!list.includes(t)) throw new Error(`${copy.base}.md: no tool ${t} to drop`);
      out.push(`tools: ${added.join(", ")}`);
      tools++;
      if (copy.cache === "default") out.push(...DEFAULT_CACHE);
    } else out.push(line);
  }
  if (named !== 1 || described !== 1 || tools !== 1) throw new Error(`${copy.base}.md: expected one name, description and tools line`);
  const section = read(join(SECTIONS, `${copy.name}.md`)).replace(/\s+$/, "").replace(/\{\{([A-Z_]+)\}\}/g, (m, name) => {
    if (!(name in fills)) throw new Error(`tools/agent-copies/${copy.name}.md: no fill for ${m}`);
    return fills[name];
  });
  return `---\n${out.join("\n")}\n---\n${body.replace(/\s+$/, "")}\n\n${section}\n`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.includes("--check");
  const stale = [];
  for (const copy of COPIES) {
    const file = join(AGENTS, `${copy.name}.md`);
    const text = buildCopy(copy);
    let current = null;
    try { current = readFileSync(file, "utf8"); } catch { /* missing */ }
    if (current === text) continue;
    if (check) stale.push(copy.name);
    else { writeFileSync(file, text); console.log(`built plugin/agents/${copy.name}.md`); }
  }
  if (check && stale.length) {
    console.error(`stale: ${stale.join(", ")} (run node tools/build-agent-copies.mjs)`);
    process.exit(1);
  }
}
