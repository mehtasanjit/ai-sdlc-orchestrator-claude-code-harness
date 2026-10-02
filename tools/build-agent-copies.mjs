#!/usr/bin/env node
/**
 * Builds the brownfield feature-run copies of the plugin's agents (plugin/agents/brownfield-*.md).
 *
 * Why copies: a brownfield job whose intent is feature-extend or feature-new runs its own packet flow (plan lint,
 * derived packets, batched apply, packet workers, lean reviews). Its rules live in these copies and in
 * plugin/skills/pipeline/brownfield-features.md, so the agents every other run uses (greenfield, and the brownfield
 * jobs bugfix, docs, test, refactor and deps) keep their own text, word for word.
 *
 * Each copy is its original agent file, unchanged, with:
 *   - its own name, and a description that says which runs it serves;
 *   - the tools those runs add (the orchestrator's execute_batch; the architect's Glob and Grep);
 *   - a one-hour prompt cache where the original has none (the reviewers);
 *   - the section in tools/agent-copies/<copy>.md appended after the original's text.
 * So a change to an original reaches its copy on the next build, and tools/test/agent-copies.test.mjs fails while a
 * committed copy differs from what this builds. Edit the originals or the sections, never a copy.
 *
 * Usage: node tools/build-agent-copies.mjs           write the copies
 *        node tools/build-agent-copies.mjs --check   exit 1, naming each copy that differs, without writing
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = join(ROOT, "plugin", "agents");
const SECTIONS = join(ROOT, "tools", "agent-copies");

/**
 * Each copy's description is its own, not its original's: a copy is chosen only by name (the brownfield guide and
 * /mmo:pass name brownfield-orchestrator, which names the others), and the original orchestrator's description
 * advertises it for /mmo:greenfield, which in a copy would offer the feature-run flow to greenfield runs in every
 * session's agent list.
 */
export const COPIES = [
  {
    name: "brownfield-orchestrator",
    base: "orchestrator",
    description: "Orchestrator for brownfield feature-extend and feature-new runs only; the brownfield guide delegates it by name for those two intents. Drives the run's packet flow (skills/pipeline/brownfield-features.md): the change plan, packets derived from it, batched dispatch through the bundled MCP server per the loaded policy, lean reviews, and the HITL gates.",
    toolsAfter: {
      "mcp__model-dispatch__execute_with_model": ["mcp__model-dispatch__execute_batch"],
      "mcp__plugin_mmo_model-dispatch__execute_with_model": ["mcp__plugin_mmo_model-dispatch__execute_batch"],
    },
  },
  {
    name: "brownfield-architect",
    base: "architect",
    description: "Architect for brownfield feature-extend and feature-new runs only. Writes change_plan.md from requirements.md: the change, unit by unit, that the run's packets are derived from. Delegated by brownfield-orchestrator during the architecture_design phase.",
    toolsAfter: { Edit: ["Glob", "Grep"] },
  },
  {
    name: "brownfield-senior-reviewer",
    base: "senior-reviewer",
    description: "Senior code reviewer for brownfield feature-extend and feature-new runs only. Reviews the run's diff against change_plan.md and emits refinement TaskPackets for any defects. Delegated by brownfield-orchestrator during the senior_code_review phase.",
  },
  {
    name: "brownfield-security-reviewer",
    base: "security-reviewer",
    description: "Security reviewer for brownfield feature-extend and feature-new runs only. Reviews the run's diff for PII handling, authz coverage, audit completeness, secret leakage and dependency risk, writes security_review.md, and gates HITL Gate 3. Delegated by brownfield-orchestrator.",
  },
];

const HOUR_CACHE = [
  "# A feature run's reviews read a large change over many calls; with a helper's default five-minute prompt",
  "# cache, a call that takes longer re-writes the whole context. The one-hour lifetime keeps it.",
  "experimental:",
  "  cacheTtl: 1h",
];

/** The agent file's header lines (between the two `---` lines) and its text after them. */
function split(text, file) {
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) throw new Error(`${file}: no front matter`);
  return { header: lines.slice(1, end), body: lines.slice(end + 1).join("\n") };
}

/** The copy's full text, built from its original and its section. */
export function buildCopy(copy, read = (p) => readFileSync(p, "utf8")) {
  const baseFile = join(AGENTS, `${copy.base}.md`);
  const { header, body } = split(read(baseFile), baseFile);
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
        added.push(t);
        for (const extra of copy.toolsAfter?.[t] ?? []) added.push(extra);
      }
      for (const [after, extra] of Object.entries(copy.toolsAfter ?? {})) {
        if (!list.includes(after)) throw new Error(`${copy.base}.md: no tool ${after} to add ${extra.join(", ")} after`);
      }
      out.push(`tools: ${added.join(", ")}`);
      tools++;
      if (!header.some((l) => /^\s*cacheTtl:/.test(l))) out.push(...HOUR_CACHE);
    } else out.push(line);
  }
  if (named !== 1 || described !== 1 || tools !== 1) throw new Error(`${copy.base}.md: expected one name, description and tools line`);
  const section = read(join(SECTIONS, `${copy.name}.md`)).replace(/\s+$/, "");
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
