/**
 * The run-start check's command, with the person's policy file added.
 *
 * A run zero-touch started must be checked against the person's chosen policy, never a project's own
 * routing-policy.yaml. The orchestrator runs the check as a shell command (`node …/driver-model-check.mjs
 * --project-root "$(pwd)"`, agents/orchestrator.md) and is told to pass the run's policy file; this is the backstop
 * for a model that does not. Rewriting a shell command is only safe when there is no doubt what it is, so the rule is
 * narrow on purpose (a looser one breaks a command with two check calls, or puts the flag into `sed`/`grep` commands
 * that merely name the script):
 *   - the command must be ONE plain call: `node <…/driver-model-check.mjs> <words>`, where a word is plain text or a
 *     quoted string, and a backslash-newline counts as a space. Anything else (`;`, `&&`, `|`, a redirect, a subshell,
 *     backticks, `$(…)` outside quotes, another program, a newline) leaves the command untouched;
 *   - a command that already names a policy file (`--policy-path`) keeps it: the model passed one;
 *   - when the run's helpers follow the chat's model (zero-touch is a strict add-on: mmo's helper agents name no
 *     model, so with no CLAUDE_CODE_SUBAGENT_MODEL setting Claude Code runs them on the chat's own model), the command
 *     is told that model as `CLAUDE_CODE_SUBAGENT_MODEL=<the chat's model>` in front of it. That states a fact, it
 *     does not choose anything: the check, mmo's own, then compares it with the policy's planning model and stops the
 *     run when they differ, exactly as for a typed run whose setting differs;
 *   - a command that already starts with a setting of its own is left as it is;
 *   - the file goes right after the script's own word, and nothing else in the command changes (the script puts an
 *     explicit file ahead of `--policy` and of a project's file, as the model server does).
 * Returns the new command, or null to leave it as it is.
 */

const OPERATORS = new Set([";", "&", "|", "<", ">", "(", ")", "`", "\n"]);

/** The command's words, with where each ends, or null when it is not one plain command. */
export function plainWords(command) {
  const words = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === " " || ch === "\t") { i++; continue; }
    if (ch === "\\" && command[i + 1] === "\n") { i += 2; continue; }
    const start = i;
    let text = "";
    while (i < n) {
      const c = command[i];
      if (c === " " || c === "\t") break;
      if (c === "\\" && command[i + 1] === "\n") break;
      if (OPERATORS.has(c)) return null;
      if (c === "$" && command[i + 1] === "(") return null;
      if (c === "\\") { if (i + 1 >= n) return null; text += command[i + 1]; i += 2; continue; }
      if (c === "'") {
        const close = command.indexOf("'", i + 1);
        if (close < 0) return null;
        text += command.slice(i + 1, close);
        i = close + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        let inner = "";
        while (j < n && command[j] !== '"') {
          if (command[j] === "\\" && j + 1 < n) { inner += command[j + 1]; j += 2; continue; }
          if (command[j] === "`") return null;
          inner += command[j];
          j++;
        }
        if (j >= n) return null;
        text += inner;
        i = j + 1;
        continue;
      }
      text += c;
      i++;
    }
    words.push({ text, end: i, start });
  }
  return words;
}

/**
 * The shapes the orchestrator usually writes around the check (the strict rule above leaves them all untouched): a
 * leading `cd <folder> &&`, a trailing redirect (`2>&1`, `> file`), a following `; echo "exit=$?"`, an
 * unquoted `$(pwd)` after the script. Stamped only when there is no doubt: the script is named exactly once in the
 * whole command, outside quotes, as the word right after a `node` word that starts a simple command (the command's
 * start, or right after `&&`, `||`, `;` or `|`); no here-document anywhere; no `$(` or backquote before that `node`
 * word. The file goes right after the script word, the model in front of the `node` word; nothing else changes. A
 * command that only names the script (`sed`, `grep`, `cat`), or names it twice, is left as it is.
 */
function looseStamp(command, policyFile, helperModel) {
  if (command.includes("<<")) return null;
  const hits = command.split("driver-model-check.mjs").length - 1;
  if (hits !== 1) return null;
  // Words outside quotes, with their positions; operators end a simple command.
  const tokens = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    const op = /^(?:&&|\|\||;|\||&)/.exec(command.slice(i));
    if (op) { tokens.push({ op: op[0], start: i, end: i + op[0].length }); i += op[0].length; continue; }
    const start = i;
    let text = "";
    let substitution = false;
    while (i < n && !/[\s;&|]/.test(command[i])) {
      const ch = command[i];
      if (ch === "'") { const close = command.indexOf("'", i + 1); if (close < 0) return null; text += command.slice(i + 1, close); i = close + 1; continue; }
      if (ch === '"') {
        let j = i + 1;
        while (j < n && command[j] !== '"') { if (command[j] === "\\") j++; j++; }
        if (j >= n) return null;
        text += command.slice(i + 1, j); i = j + 1; continue;
      }
      if (ch === "`" || (ch === "$" && command[i + 1] === "(")) substitution = true;
      if (ch === "\\" && i + 1 < n) { text += command[i + 1]; i += 2; continue; }
      text += ch; i++;
    }
    tokens.push({ text, start, end: i, substitution });
  }
  const at = tokens.findIndex((t) => !t.op && /(^|\/)driver-model-check\.mjs$/.test(t.text));
  if (at < 1) return null;
  const node = tokens[at - 1];
  if (node.op || !/(^|\/)node$/.test(node.text)) return null;
  // The `node` word starts a simple command, after any settings in front of it (NAME=value words).
  let k = at - 2;
  while (k >= 0 && !tokens[k].op && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[k].text)) k--;
  if (k >= 0 && !tokens[k].op) return null;
  if (tokens.slice(0, at).some((t) => t.substitution)) return null;
  const settings = tokens.slice(k + 1, at - 1).map((t) => t.text);
  const has = (flag) => tokens.slice(at + 1).some((t) => !t.op && (t.text === flag || t.text.startsWith(`${flag}=`)));
  const file = has("--policy-path") ? "" : ` --policy-path "${policyFile}"`;
  const model = typeof helperModel === "string" && MODEL_ID.test(helperModel) && !settings.some((w) => w.startsWith("CLAUDE_CODE_SUBAGENT_MODEL=")) ? `CLAUDE_CODE_SUBAGENT_MODEL=${helperModel} ` : "";
  if (!file && !model) return null;
  const script = tokens[at];
  return `${command.slice(0, node.start)}${model}${command.slice(node.start, script.end)}${file}${command.slice(script.end)}`;
}

/** A model id safe to put in a command as it is: never anything the shell could read as more than one word. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/**
 * `helperModel`: the model the run's helpers follow when it is the chat's own (no setting), or null to add none.
 * Returns the new command, or null to leave it as it is.
 */
export function stampedRunCheck(command, policyFile, { helperModel = null } = {}) {
  if (typeof command !== "string" || typeof policyFile !== "string" || !policyFile) return null;
  // Never a path the shell could read as more than a path.
  if (/["$`\\\n]/.test(policyFile)) return null;
  const words = plainWords(command);
  if (!words) return looseStamp(command, policyFile, helperModel);
  if (words.length < 2) return null;
  if (!/(^|\/)node$/.test(words[0].text)) return null;
  if (!/(^|\/)driver-model-check\.mjs$/.test(words[1].text)) return null;
  const has = (flag) => words.some((w) => w.text === flag || w.text.startsWith(`${flag}=`));
  const file = has("--policy-path") ? "" : ` --policy-path "${policyFile}"`;
  const model = typeof helperModel === "string" && MODEL_ID.test(helperModel) ? `CLAUDE_CODE_SUBAGENT_MODEL=${helperModel} ` : "";
  if (!file && !model) return null;
  const at = words[1].end;
  const lead = command.slice(0, words[0].start);
  return `${lead}${model}${command.slice(words[0].start, at)}${file}${command.slice(at)}`;
}
