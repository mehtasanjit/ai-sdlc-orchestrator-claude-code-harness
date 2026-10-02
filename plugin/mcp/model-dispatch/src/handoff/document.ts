/**
 * write_document: the form, the brief and the checks (zero-touch hand-off mode).
 *
 * A new document of the project (a README, a guide, an API reference, a changelog), a new spec (requirements, a
 * design document, an API spec, a data-model write-up) or new planning text (a plan, a task breakdown or tickets, a
 * status report, release notes) is mostly typing. The chat's model knows what the document must say; the hand-off
 * policy's cheaper model can write it, provided it is told everything it may state. So the chat's model fills in a
 * FORM, and code does the rest:
 *
 *  1. The form is checked before anything is sent (checkDocumentForm). Every field is filled. Every string is one
 *     line: the form is a brief, and a field that holds several lines or a code block is the finished text, which
 *     would mean the chat's model did the typing and the hand-off saved nothing. The file is new (a change to a file
 *     that exists is the chat model's own small edit) and inside the project. Every fact that names a project file
 *     carries a quote, and the quote is in that file word for word, so a fact cannot be misremembered.
 *  2. The brief (renderDocumentShared, renderDocumentInstruction) gives the typist the sections and the facts, and
 *     tells it that it cannot see the project and may state nothing else.
 *  3. The answer is checked (checkDocument) for what is certainly wrong whatever the document is about: a listed
 *     section is missing; a shell command in it is not one of the facts; a project path or a relative link in it
 *     leads nowhere. A refused answer goes back to the typist with the reason.
 *
 * What code cannot check (is the prose right, is it useful) is the chat model's reading of the written file, which
 * the receipt asks for.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FileSlice, TaskPacket } from "../types.js";
import { FILE_ANSWER_SCHEMA } from "../executor/brief.js";
import { formProblems, isProjectFile } from "./form.js";

export const DOCUMENT_KINDS = ["docs", "spec", "plan"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** A kind, as the brief names it to the typist. */
const KIND_WORDS: Record<DocumentKind, string> = {
  docs: "a document of the project",
  spec: "a specification",
  plan: "planning text",
};

export interface DocumentSection { heading: string; must_say: string }
/** One thing the document may state: from a project file (with the line that proves it) or from the person in the chat. */
export interface DocumentFact { statement: string; source: string; quote?: string }
export interface DocumentForm {
  kind: DocumentKind;
  /** The new file, relative to the project folder. */
  file: string;
  purpose: string;
  readers: string;
  sections: DocumentSection[];
  facts: DocumentFact[];
  /** An existing document whose tone and layout the new one follows. */
  style_from?: string;
}

/** A fact's source when it comes from the person, not from a file. */
export const FROM_CHAT = "chat";

/**
 * The form, checked. Returns the form, or every problem at once (so one corrected call fixes them all), each named
 * by its field.
 */
export function checkDocumentForm(raw: unknown, projectDir: string): { form: DocumentForm } | { problems: string[] } {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const f = formProblems();

  const kind = DOCUMENT_KINDS.includes(a.kind as DocumentKind) ? (a.kind as DocumentKind) : null;
  if (!kind) f.add("kind must be docs, spec or plan");
  const file = f.newFile(a.file, "file", projectDir, "write_document");
  const purpose = f.line(a.purpose, "purpose");
  const readers = f.line(a.readers, "readers");

  const sections: DocumentSection[] = [];
  if (!Array.isArray(a.sections) || !a.sections.length) f.add("sections needs at least one section");
  else {
    const seen = new Map<string, string>();
    a.sections.forEach((s: any, i: number) => {
      const heading = f.line(s?.heading, `sections[${i}].heading`);
      const must = f.line(s?.must_say, `sections[${i}].must_say`);
      if (heading) {
        const first = seen.get(heading.toLowerCase());
        if (first !== undefined) f.add(`sections[${i}].heading repeats "${first}"`);
        else seen.set(heading.toLowerCase(), heading);
      }
      if (heading && must) sections.push({ heading, must_say: must });
    });
  }

  const facts: DocumentFact[] = [];
  if (!Array.isArray(a.facts) || !a.facts.length) f.add("facts needs at least one fact: everything the document may state about the project");
  else {
    a.facts.forEach((fact: any, i: number) => {
      const statement = f.line(fact?.statement, `facts[${i}].statement`);
      const source = typeof fact?.source === "string" ? fact.source.trim() : "";
      if (!source) { f.add(`facts[${i}].source is empty: name the project file the fact comes from, or "${FROM_CHAT}" for something the person said`); return; }
      if (source === FROM_CHAT) {
        if (fact.quote !== undefined && fact.quote !== "") { f.add(`facts[${i}].quote: a fact from the chat has no quote`); return; }
        if (statement) facts.push({ statement, source });
        return;
      }
      if (!isProjectFile(projectDir, source)) { f.add(`facts[${i}].source ${source} is not a file of the project`); return; }
      if (typeof fact.quote !== "string" || !fact.quote.trim()) { f.add(`facts[${i}].quote is empty: quote the line of ${source} that shows this fact`); return; }
      const quote = f.line(fact.quote, `facts[${i}].quote`);
      if (!quote) return;
      let text = "";
      try { text = readFileSync(join(projectDir, source), "utf8"); } catch { /* unreadable: the quote cannot be in it */ }
      if (!text.includes(quote)) { f.add(`facts[${i}].quote is not in ${source}: copy the line exactly as the file has it`); return; }
      if (statement) facts.push({ statement, source, quote });
    });
  }

  let style: string | undefined;
  if (a.style_from !== undefined && a.style_from !== "") {
    if (!isProjectFile(projectDir, a.style_from)) f.add(`style_from ${String(a.style_from)} is not a file of the project`);
    else style = a.style_from;
  }

  if (f.problems.length || !kind || !file || !purpose || !readers) return { problems: f.problems };
  return { form: { kind, file, purpose, readers, sections, facts, ...(style ? { style_from: style } : {}) } };
}

/** The block every document brief starts with: what the typist is doing and the rules it writes under. */
export function renderDocumentShared(): string {
  return [
    "# Write one document of a software project",
    "You are writing ONE document for a software project. You cannot see the project: everything you may state about it is listed under Facts.",
    "",
    "## Rules",
    "- State nothing about the project that the facts do not say: no command, path, file name, setting, version or number of your own.",
    "- In a shell code block use only commands the facts give, exactly as written.",
    "- Write every section listed, in the order given, each under its own heading with exactly the heading's words. Add no other section.",
    "- When a section cannot be written from the facts, write what the facts support and nothing more.",
    "- Write for the readers named, in plain, direct sentences.",
    "- Format: Markdown, unless the file's extension says otherwise.",
  ].join("\n");
}

/** The document's own instruction: what it is, its sections, the facts, and how to answer. */
export function renderDocumentInstruction(form: DocumentForm, refusal?: string): string {
  const lines = [
    "## The document to write",
    `- path: ${form.file}`,
    `- what it is: ${KIND_WORDS[form.kind]}`,
    `- purpose: ${form.purpose}`,
    `- readers: ${form.readers}`,
    "",
    "## Sections, in this order",
    ...form.sections.map((s, i) => `${i + 1}. ${s.heading} — must say: ${s.must_say}`),
    "",
    "## Facts (the only things you may state about the project)",
    ...form.facts.map((f) => `- ${f.statement} (${f.source === FROM_CHAT ? "from the person" : `${f.source}: ${f.quote}`})`),
  ];
  if (form.style_from) lines.push("", `Follow the tone and layout of ${form.style_from}, whose text is under Inputs; take no fact from it.`);
  if (refusal) lines.push("", "## Your previous answer was refused", refusal, "Write the whole document again, correcting that.");
  lines.push("", "## Answer", `Return ONLY a JSON object {"path": "${form.file}", "content": "<the complete document>"} with no other text.`);
  return lines.join("\n");
}

/** The document as a packet: the policy's docs stage, the style file (when one is named) as its only input. */
export function documentPacket(form: DocumentForm, projectDir: string, instruction: string, passId: string, maxOutputTokens: number): TaskPacket {
  const inputs: FileSlice[] = [];
  if (form.style_from) {
    inputs.push({ path: form.style_from, content: readFileSync(join(projectDir, form.style_from), "utf8"), reason: "style: follow its tone and layout, take no fact from it" });
  }
  return {
    id: `doc:${form.file}`,
    phase: "docs",
    task_type: "",
    module: "handoff",
    instruction,
    inputs,
    outputSchema: FILE_ANSWER_SCHEMA,
    acceptance: [],
    budget: { maxInputTokens: 400_000, maxOutputTokens },
    pass_id: passId,
  };
}

// ─── the answer's checks ────────────────────────────────────────────────

/** Fence labels that mark a block of shell commands. */
const SHELL_LABELS = new Set(["bash", "sh", "shell", "zsh", "console", "terminal", "shell-session", "cmd", "bat", "powershell", "ps1", "pwsh"]);

interface Read { commands: string[]; codeSpans: string[]; links: string[] }

/** The parts of a document the checks look at: shell commands, inline code, link targets. Fenced blocks are read line by line. */
function readDocument(content: string): Read {
  const commands: string[] = [];
  const prose: string[] = [];
  let fence: { mark: string; length: number; shell: boolean } | null = null;
  let pending = "";
  const command = (text: string) => {
    // A line ending in a backslash carries on: the command is the joined line.
    if (text.endsWith("\\")) { pending += text.slice(0, -1).trimEnd() + " "; return; }
    const whole = (pending + text).trim();
    pending = "";
    // Commands joined on one line ("a && b; c") are each a command of their own. A pipe is left whole: it changes
    // what the command does.
    for (const part of whole.split(/\s*(?:&&|;)\s*/)) if (part.trim()) commands.push(part.trim());
  };
  for (const raw of content.split(/\r?\n/)) {
    const open = /^\s*(```+|~~~+)\s*([\w.+-]*)/.exec(raw);
    if (!fence && open) { fence = { mark: open[1][0], length: open[1].length, shell: SHELL_LABELS.has(open[2].toLowerCase()) }; pending = ""; continue; }
    // A fence closes on a line of the same mark, at least as long as the one that opened it, with no label.
    if (fence && open && open[1][0] === fence.mark && open[1].length >= fence.length && !open[2]) { fence = null; pending = ""; continue; }
    if (!fence) { prose.push(raw); continue; }
    if (open) continue; // a fence mark inside a longer fence is part of the block's text, never a command
    const text = raw.trim();
    const prompted = /^[$%>]\s+(.*)$/.exec(text);
    // A labelled shell block is commands throughout (comments aside); an unlabelled block only where a line carries
    // a prompt sign, since such a block is as often output or an example.
    if (fence.shell) { if (text && !text.startsWith("#")) command(prompted ? prompted[1] : text); }
    else if (prompted && text[0] === "$") command(prompted[1]);
  }
  const body = prose.join("\n");
  const codeSpans = [...body.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  const links = [...body.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]);
  return { commands, codeSpans, links };
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** File extensions of Markdown, where a section's heading is a heading line. */
const MARKDOWN = /\.(?:md|mdx|markdown)$/i;

/**
 * Whether the document has a section headed with these words. In Markdown the words stand in a heading line ("## 1.
 * Install", or a line underlined with === or ---), not just somewhere in the text: "Installation notes" is no
 * "Install" section. In any other format a line must carry them as whole words.
 */
function hasSection(content: string, heading: string, file: string): boolean {
  const want = heading.toLowerCase();
  const lines = content.split(/\r?\n/);
  const plain = (s: string) => s.replace(/[*_`]/g, "").toLowerCase();
  if (!MARKDOWN.test(file)) return lines.some((l) => standsIn(plain(l), want));
  return lines.some((l, i) => {
    const atx = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(l);
    if (atx) return standsIn(plain(atx[1]), want);
    return l.trim() !== "" && /^\s{0,3}(?:=+|-+)\s*$/.test(lines[i + 1] ?? "") && standsIn(plain(l), want);
  });
}

/** Whether `needle` stands in `text` as a whole thing: not as a piece of a longer word. */
function standsIn(text: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + needle.length] ?? "";
    if (!/[\w-]/.test(before) && !/[\w-]/.test(after)) return true;
    from = at + 1;
  }
}

/**
 * The checks on a typist's document, run by code before it is written. Each refuses only what is certainly wrong:
 *  - a listed section's heading is nowhere in the document;
 *  - a shell command is not one of the facts (the typist cannot see the project, so a command of its own is a guess);
 *  - inline code naming a path under one of the project's own top-level folders, or a relative link, leads to
 *    nothing in the project (the document itself aside). A word with a slash that is no project path ("text/html")
 *    is left alone.
 * Returns ok with what was checked, or every reason at once for the typist's next attempt.
 */
export function checkDocument(form: DocumentForm, content: string, projectDir: string): { ok: true; checked: string[] } | { ok: false; reason: string } {
  if (!content.trim()) return { ok: false, reason: "the document is empty" };
  const reasons: string[] = [];
  for (const s of form.sections) if (!hasSection(content, s.heading, form.file)) reasons.push(`the section "${s.heading}" is missing: give it its own heading with exactly those words`);

  const doc = readDocument(content);
  const factText = collapse(form.facts.map((f) => `${f.statement} ${f.quote ?? ""}`).join(" \n "));
  for (const c of new Set(doc.commands.map(collapse))) {
    if (!standsIn(factText, c)) reasons.push(`the command \`${c}\` is not among the facts: in a shell block use only commands the facts give`);
  }

  const root = resolve(projectDir);
  const own = resolve(root, form.file);
  const exists = (abs: string) => abs === own || existsSync(abs);
  let paths = 0;
  for (const span of new Set(doc.codeSpans)) {
    // A path, possibly with a line number ("src/cart.js:12"); nothing with spaces, globs, placeholders or options.
    const token = span.replace(/:\d+(?:-\d+)?$/, "").replace(/^\.\//, "");
    if (!token.includes("/") || /[\s*<>{}$|=]/.test(token) || /^(?:\/|~|-|@|\.\.|[a-z][a-z0-9+.-]*:)/i.test(token)) continue;
    const top = token.split("/")[0];
    if (!top || !existsSync(join(root, top))) continue; // not under one of the project's own top-level folders
    paths++;
    if (!exists(resolve(root, token)) && !factText.includes(token)) reasons.push(`the document names \`${token}\`, which is not in the project`);
  }
  for (const target of new Set(doc.links)) {
    if (/^(?:#|\/\/|[a-z][a-z0-9+.-]*:)/i.test(target)) continue; // an anchor, or a link out of the project
    const path = target.replace(/[#?].*$/, "");
    if (!path) continue;
    paths++;
    const abs = path.startsWith("/") ? join(root, path) : resolve(dirname(own), path);
    const rel = relative(root, abs);
    if (rel.startsWith("..") || isAbsolute(rel) || !exists(abs)) reasons.push(`the document links to ${target}, which is not in the project`);
  }

  if (reasons.length) return { ok: false, reason: reasons.join("; ") };
  return { ok: true, checked: [`${form.sections.length} section${form.sections.length === 1 ? "" : "s"} present`, `${doc.commands.length} shell command${doc.commands.length === 1 ? "" : "s"} among the facts`, `${paths} project path${paths === 1 ? "" : "s"} exist`] };
}
