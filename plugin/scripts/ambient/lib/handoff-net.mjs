/**
 * Zero-touch hand-off mode, the safety net: which files a tool call would create by hand that belong to the
 * hand-off (docs/ambient-mode.md, "Hand-off mode").
 *
 * In a hand-off chat a NEW document, spec, plan or test file goes through the hand-off tools, which brief a cheaper
 * model and check its answer. A model that types such a file itself has done the expensive typing and skipped the
 * check, so the hook refuses the write and names the tool (hook.mjs, pre-any). This file only answers two
 * questions, from the tool call alone:
 *
 *   fileKind(path)         is this path a document (by its file type) or a test file (by its name)?
 *   createdByHand(call)    which paths would this Write, or this shell command, write?
 *
 * Narrow on purpose. A document is a file of a document type (Markdown and its kin); a spec or a plan kept as
 * YAML or JSON cannot be told from configuration, so it is not claimed. A test file is one its own name marks as a
 * test in the common conventions; a helper or a fixture beside the tests is not. A tool's own folder (any folder
 * whose name starts with a dot) and an agent's instruction file are not the project's documents. Whether the file
 * exists, whether a failed hand-off handed it back, and whether a hand-off can run at all are the hook's checks.
 *
 * The shell reading is conservative and covers how a file is usually written from a command: an output redirect
 * (`>`, `>>`, `>|`, `&>`) and `tee`, with every `cd` before it followed. The text of a here-document and anything
 * inside quotes is never read as a redirect. What it cannot know is left alone: a command it cannot read (an
 * unclosed quote), a path the command computes (a variable, a substitution), and a file written by a program the
 * command runs (a script, `cp`, `mv`).
 */
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

/** File types that are documents. */
const DOCUMENT = /\.(?:md|mdx|markdown|rst|adoc)$/i;
/** Instruction files an agent or a tool reads: theirs, not the project's documents. */
const AGENT_FILES = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "GEMINI.md"]);
/** A file its own name marks as a test, in the common conventions of each language. */
const TEST_NAME = [
  /\.(?:test|spec)\.[cm]?[jt]sx?$/i,            // cart.test.js, cart.spec.ts
  /^test_[^/]+\.py$/, /_test\.(?:py|go|rb|exs?)$/, // test_cart.py, cart_test.go
  /_spec\.rb$/,                                   // cart_spec.rb
  /(?:Test|Tests|Spec)\.(?:java|kt|cs|scala|swift)$/, // CartTest.java, CartTests.cs
];
/** A code file under a folder named __tests__ is a test, whatever its name. */
const IN_TESTS_FOLDER = /(?:^|\/)__tests__\/[^/]+\.[cm]?[jt]sx?$/i;
/**
 * Folders of test data, not tests or documents: a Markdown fixture for a Markdown parser, a mock,
 * a stored snapshot. The hand-off tools cannot write such a file exactly, so the net leaves it to the chat.
 */
const DATA_FOLDERS = new Set(["fixtures", "__fixtures__", "testdata", "test-data", "test_data", "__mocks__", "__snapshots__"]);

/** "document", "tests" or null for a path written from the project folder. */
export function fileKind(path) {
  const p = String(path ?? "").split(sep).join("/");
  const parts = p.split("/");
  const name = parts[parts.length - 1] ?? "";
  if (!name || parts.some((part) => part.startsWith(".") && part !== "." && part !== "..")) return null;
  if (AGENT_FILES.has(name)) return null;
  if (parts.slice(0, -1).some((part) => DATA_FOLDERS.has(part))) return null;
  if (DOCUMENT.test(name)) return "document";
  if (TEST_NAME.some((re) => re.test(name)) || IN_TESTS_FOLDER.test(p)) return "tests";
  return null;
}

/** A command's text with the bodies of its here-documents removed: they are data, not commands. */
function withoutHeredocs(command) {
  const out = [];
  let until = null;
  let stripTabs = false;
  for (const line of command.split("\n")) {
    if (until !== null) {
      if ((stripTabs ? line.replace(/^\t+/, "") : line) === until) until = null;
      continue;
    }
    out.push(line);
    const m = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (m) { until = m[3]; stripTabs = m[1] === "-"; }
  }
  return out.join("\n");
}

/**
 * The command as words and operators, quotes honoured: a word keeps the text inside its quotes, and nothing inside
 * quotes is an operator. Returns null on an unclosed quote.
 */
function shellWords(text) {
  const tokens = [];
  let cur = "";
  let has = false;
  let quote = null;
  const push = () => { if (has) tokens.push({ word: cur }); cur = ""; has = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (ch === "\\" && i + 1 < text.length) { cur += text[++i]; has = true; continue; }
    if (/\s/.test(ch)) { push(); if (ch === "\n") tokens.push({ op: ";" }); continue; }
    // Operators: redirects (with an optional file-descriptor digit or & before them), pipes, separators.
    const rest = text.slice(i);
    const redirect = /^(?:&>>?|>\||>>?)/.exec(rest);
    if (redirect) {
      // "2>" is a redirect of descriptor 2: the digit is not a word of its own.
      if (has && /^\d$/.test(cur)) { cur = ""; has = false; } else push();
      // ">&2" and ">&-" copy or close a descriptor; ">(" is a process substitution: neither writes a file.
      const after = text[i + redirect[0].length];
      tokens.push({ op: after === "&" || after === "(" ? "other" : "redirect" });
      i += redirect[0].length - 1;
      continue;
    }
    const sepOp = /^(?:\|\||&&|;|\||&|\(|\))/.exec(rest);
    if (sepOp) { push(); tokens.push({ op: ["|", "(", ")"].includes(sepOp[0]) ? sepOp[0] : ";" }); i += sepOp[0].length - 1; continue; }
    if (ch === "<") { push(); tokens.push({ op: "other" }); continue; }
    cur += ch;
    has = true;
  }
  if (quote) return null;
  push();
  return tokens;
}

/** A path the command's text does not fix: it holds a variable, a command substitution, a home shorthand or a pattern. */
const COMPUTED = /[$`*?\[\]{}]|^~/;

/**
 * What a shell command writes: the targets of its output redirects (`>`, `>>`, `>|`, `&>`) and of `tee`, each as the
 * command's starting folder sees it. A `cd` moves what follows it, wherever it stands; one inside brackets ends with
 * them. A target or a folder the command computes (a variable, a substitution, `~`) cannot be known from the text,
 * so such a target is left out, never guessed. Empty for a command that cannot be read.
 */
export function shellTargets(command) {
  if (typeof command !== "string" || !command.trim()) return [];
  const tokens = shellWords(withoutHeredocs(command));
  if (!tokens) return [];
  const targets = [];
  // The folder the command is in, as written from its starting folder ("" = the starting folder itself); null once
  // a cd went somewhere the text does not fix.
  let folder = "";
  const saved = [];
  const add = (word) => {
    if (folder === null || COMPUTED.test(word)) return;
    targets.push(word.startsWith("/") ? word : posix.normalize(posix.join(folder || ".", word)));
  };
  let atCommand = true; // the next word is a command's name
  let tee = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.op === "redirect") {
      const next = tokens[i + 1];
      if (next?.word !== undefined) { add(next.word); i++; }
      continue;
    }
    if (t.op === "other") { if (tokens[i + 1]?.word !== undefined) i++; continue; }
    if (t.op === "(") { saved.push(folder); atCommand = true; tee = false; continue; }
    if (t.op === ")") { if (saved.length) folder = saved.pop(); atCommand = true; tee = false; continue; }
    if (t.op) { atCommand = true; tee = false; continue; }
    if (atCommand) {
      atCommand = false;
      tee = t.word === "tee";
      if (t.word === "cd") {
        const to = tokens[i + 1]?.word;
        if (to === undefined || COMPUTED.test(to) || to === "-") folder = null;
        else if (folder !== null) folder = to.startsWith("/") ? to : posix.normalize(posix.join(folder || ".", to));
      }
      continue;
    }
    if (tee && !t.word.startsWith("-")) add(t.word);
  }
  return targets;
}

/**
 * The project files a tool call would write, as paths from the project folder: the Write tool's file, or a shell
 * command's targets. A path outside the project is not the project's and is left out.
 */
export function createdByHand(toolName, toolInput, { cwd, projectDir }) {
  const inProject = (from, path) => {
    if (typeof path !== "string" || !path) return null;
    const abs = isAbsolute(path) ? path : resolve(from, path);
    const rel = relative(resolve(projectDir), abs);
    return !rel || rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(sep).join("/");
  };
  // Write, an edit or a notebook edit: an edit of a file that does not exist yet creates it
  // (the hook checks whether it exists).
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") return [inProject(cwd, toolInput?.file_path)].filter(Boolean);
  if (toolName === "NotebookEdit") return [inProject(cwd, toolInput?.notebook_path)].filter(Boolean);
  if (toolName === "Bash") return [...new Set(shellTargets(toolInput?.command).map((t) => inProject(cwd, t)).filter(Boolean))];
  return [];
}
