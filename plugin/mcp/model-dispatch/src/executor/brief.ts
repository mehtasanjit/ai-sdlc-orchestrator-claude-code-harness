/**
 * The briefs a typist receives, rendered from the typed spec by code.
 *
 * Two parts, in this order:
 *  1. The SHARED block — stack, commands, decisions, conventions, data model,
 *     API, and an index of every file of the project with its exports.
 *     Byte-identical for every unit of a run, and placed FIRST so each vendor
 *     can reuse it from cache: Claude Code caches it as part of the system
 *     prompt (it is passed with --append-system-prompt-file), the completion
 *     door places it first as its project header, and the Antigravity typist
 *     appends it to its system prompt.
 *  2. The UNIT block — the entries of the units this file uses, the unit
 *     itself, and the answer contract.
 *
 * The file index is there so a brief is complete on its own: a typist sees the
 * spec entries of the files it depends on, and the index tells it where every
 * other module lives and what it exports, so it never imports a module no unit
 * writes.
 *
 * Two answer contracts. Writing a file: {"path", "content"}. Fixing a file
 * (the repair stage): exact edits {"path", "edits": [{"search", "replace"}]},
 * each search found exactly once in the current text, or the whole file as
 * {"path", "content"} when most of it changes.
 *
 * Every typist gets the same words: the unit block is framed by the
 * completion door's own buildUserPrompt, the single definition of that frame.
 */
import type { FileSlice, TaskPacket } from "../types.js";
import { buildUserPrompt } from "../adapters/GeminiFlashAdapter.js";
import type { Spec, SpecExport, SpecUnit } from "../spec/store.js";

const sig = (e: SpecExport) => `${e.name}(${e.params.map((p) => `${p.name}: ${p.type}`).join(", ")}) -> ${e.returns}${e.kind ? ` [${e.kind}]` : ""}`;

/** The block every unit of the run shares, identical byte for byte. */
export function renderShared(spec: Spec): string {
  return [
    "# Write one file of a project",
    "You are writing ONE file of a larger project. Every other file is written separately from the same specification, so follow it exactly: names, types, paths and decisions must match.",
    "", "## Stack", ...spec.stack.map((s) => `- ${s}`),
    "", "## Commands", ...spec.commands.map((c) => `- ${c.name}: \`${c.run}\` (in ${c.cwd})`),
    "", "## Decisions", ...spec.decisions.map((d) => `- ${d.topic}: ${d.choice} — ${d.reason}`),
    "", "## Conventions", ...spec.shared.conventions.map((c) => `- ${c}`),
    "", "## Data model", ...spec.shared.data_model.map((t) => `- ${t.name}: ${t.fields.map((f) => `${f.name} ${f.type}${f.constraints ? ` (${f.constraints})` : ""}`).join("; ")}`),
    "", "## API", ...spec.shared.api.map((a) => `- ${a.method} ${a.path} — access: ${a.access}; request: ${a.request}; response: ${a.response}; ${a.success_status}; errors: ${a.error_statuses.join(", ") || "none"}`),
    "", "## Every file of the project, with what it exports (import only these modules and names)",
    ...spec.units.map((u) => `- ${u.path}: ${u.exports.map((e) => e.name).join(", ") || "no exports"}${u.import_line ? ` — imported as: ${u.import_line}` : ""}`),
  ].join("\n");
}

/** The spec entries a brief gives for one file: the files it uses, then the file itself. */
function entryLines(spec: Spec, unit: SpecUnit, heading: string): string[] {
  const byId = new Map(spec.units.map((u) => [u.id, u]));
  const deps = unit.depends_on.map((d) => byId.get(d)).filter((u): u is SpecUnit => !!u);
  const su = unit.style_from.unit ? byId.get(unit.style_from.unit) : undefined;
  // The style file's own spec entry: a typist never sees another typist's file,
  // so "copy its style" names what that file is, not text it cannot read.
  const style = su
    ? `follow the conventions of ${su.path} (${su.behaviour}) — ${unit.style_from.reason}`
    : `no earlier file to follow (${unit.style_from.reason})`;
  return [
    "## Files this one uses (written by others from this same specification)",
    ...(deps.length ? deps.map((d) => `- ${d.path} — ${d.behaviour}\n  exports: ${d.exports.map(sig).join("; ") || "none"}${d.import_line ? `\n  imported as: ${d.import_line} (adjust only the relative path)` : ""}`) : ["- none"]),
    "", heading,
    `- path: ${unit.path}`, `- what it does: ${unit.behaviour}`,
    `- exports: ${unit.exports.map(sig).join("; ") || "none"}`,
    ...(unit.import_line ? [`- other files import it as: ${unit.import_line} — export exactly what this line expects`] : []),
    `- style: ${style}`, `- requirements it helps satisfy: ${unit.covers.join(", ") || "none"}`,
    `- ${unit.phase === "tests" ? "test cases it must contain" : "cases it must satisfy"}:`, ...unit.tests.map((t) => `  - ${t.name}: given ${t.given} → ${t.expect}`),
    `- expected length: about ${unit.approx_lines} lines`,
  ];
}

/** The unit's own instruction: what it uses, what it must be, how to answer. */
export function renderUnitInstruction(spec: Spec, unit: SpecUnit, refusal?: string): string {
  const lines = entryLines(spec, unit, "## The file to write");
  if (refusal) lines.push("", "## Your previous answer was refused", refusal, "Write the whole file again, correcting that.");
  lines.push("", "## Answer", `Return ONLY a JSON object {"path": "${unit.path}", "content": "<the complete file>"} with no other text.`);
  return lines.join("\n");
}

/**
 * A fix's instruction: the file's spec entry (when the spec has one), what must
 * change, and the edit contract. The file's current text travels as an input,
 * so every typist reads it inside the same frame.
 */
export function renderRepairInstruction(spec: Spec, target: { path: string; unit?: SpecUnit }, problems: string[], refusal?: string): string {
  const lines = target.unit
    ? entryLines(spec, target.unit, "## The file to fix")
    : ["## The file to fix", `- path: ${target.path}`, "- a supporting file the specification does not list; keep it consistent with the specification"];
  lines.push("", "## What must change", ...problems.map((p) => `- ${p}`));
  lines.push("", "The file's current text is under Inputs, marked \"current text\"; your edits apply to exactly that text.");
  if (refusal) lines.push("", "## Your previous answer was refused", refusal, "Answer again from the current text, correcting that.");
  lines.push(
    "", "## Answer",
    `Return ONLY a JSON object {"path": "${target.path}", "edits": [{"search": "<text copied exactly from the current text>", "replace": "<its replacement>"}]} with no other text. Each search must appear exactly once in the current text; the edits apply in order.`,
    `If the file does not exist yet, or the change rewrites most of it, return {"path": "${target.path}", "content": "<the complete file>"} instead.`,
  );
  return lines.join("\n");
}

/** A packet-shaped view of a unit, for the completion door and for framing. */
export function unitPacket(unit: SpecUnit, instruction: string, passId: string, maxOutputTokens: number): TaskPacket {
  return {
    id: unit.id,
    phase: unit.phase,
    // No task type: a file is routed by its stage alone, and the brief names no kind of file.
    task_type: "",
    module: "spec",
    instruction,
    inputs: [],
    outputSchema: FILE_ANSWER_SCHEMA,
    acceptance: [],
    budget: { maxInputTokens: 400_000, maxOutputTokens },
    pass_id: passId,
  };
}

/** A fix as a packet: phase `debug` (the policies' own rule for fixes), the file's current text and any reference files as inputs. */
export function repairPacket(id: string, instruction: string, passId: string, inputs: FileSlice[], maxOutputTokens: number): TaskPacket {
  return {
    id,
    phase: "debug",
    task_type: "",
    module: "spec",
    instruction,
    inputs,
    outputSchema: EDIT_ANSWER_SCHEMA,
    acceptance: [],
    budget: { maxInputTokens: 400_000, maxOutputTokens },
    pass_id: passId,
  };
}

/** A packet framed exactly as the completion door frames it, with no header inlined. */
export function framedPacket(packet: TaskPacket): string {
  return buildUserPrompt(packet, "");
}

/** The unit block framed exactly as the completion door frames it, with no header inlined. */
export function framedUnit(unit: SpecUnit, instruction: string, passId: string): string {
  return framedPacket(unitPacket(unit, instruction, passId, 0));
}

/** The answer when writing a file. */
export const FILE_ANSWER_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, content: { type: "string" } },
  required: ["path", "content"],
};

/** The answer when fixing a file: exact edits, or the whole file. parseAnswer enforces "one of the two". */
export const EDIT_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string" },
    edits: {
      type: "array",
      items: { type: "object", properties: { search: { type: "string" }, replace: { type: "string" } }, required: ["search", "replace"] },
    },
    content: { type: "string" },
  },
  required: ["path"],
};
