/**
 * Lines the person must read, said by Claude where the app folds them away.
 *
 * A hook's line (its `systemMessage`) shows in the terminal as it is. The Claude desktop app shows it only as a folded
 * "Claude Code notice" row that the person has to open, so they read Claude's reply and nothing else: a refusal's
 * reason and its fix would sit in a folded row while Claude, told "the person has been told why", answers without them.
 * So outside the terminal, wherever the moment lets Claude read context, Claude is also given the line and told to
 * start its reply with it, word for word. A refusal (a PreToolUse deny) is shown to the person in red already and is
 * left alone, and an end-of-turn line is never given to Claude on its own: that would start a new turn of the model
 * just to repeat it.
 *
 * zero-touch/scripts/relay.mjs is a copy for the zero-touch plugin's own hooks; tools/test/zero-touch-relay.test.mjs
 * keeps the two equal.
 */

/** The labels of runs with no screen (Claude Code's own names): no one reads a line there at all. */
const NO_SCREEN = new Set(["sdk-cli", "sdk-ts", "sdk-py"]);

/** Whether this app folds a hook's line away: every app but the terminal ("cli", or no label at all). */
export function linesFolded(env = process.env) {
  const label = String(env.CLAUDE_CODE_ENTRYPOINT ?? "").trim();
  return label !== "" && label !== "cli" && !NO_SCREEN.has(label);
}

/** What Claude is told: say the line first, exactly as written (its model and command names included). */
export function relayNote(line) {
  return `The person has not seen this line from zero-touch: this app folds such lines away under a "Claude Code notice". Start your reply with it, word for word, as a paragraph of its own (its model and command names included, whatever you are told about names below), then carry on as told: """${line}"""`;
}

/**
 * A hook's answer with the relay added, or the answer unchanged. `eventName` is Claude Code's name for the moment
 * ("UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"), or null where the model reads nothing back.
 */
export function withRelay(answer, eventName, env = process.env) {
  if (!answer || typeof answer.systemMessage !== "string" || !answer.systemMessage || !eventName || !linesFolded(env)) return answer;
  const own = answer.hookSpecificOutput ?? null;
  if (own?.permissionDecision === "deny") return answer;
  const context = typeof own?.additionalContext === "string" ? own.additionalContext : "";
  if (eventName === "Stop" && !context) return answer;
  return {
    ...answer,
    hookSpecificOutput: {
      ...(own ?? {}),
      hookEventName: own?.hookEventName ?? eventName,
      additionalContext: context ? `${relayNote(answer.systemMessage)}\n\n${context}` : relayNote(answer.systemMessage),
    },
  };
}
