#!/bin/sh
# The zero-touch plugin's start hook (SessionStart): it marks the chat with the person's zero-touch mode and models
# and shows what the person needs to know (scripts/start-chat.mjs). POSIX sh only: this runs on machines where bash
# may be missing or old.
#
# The trap is the first line on purpose. Whatever happens below (node missing, a crash, a kill) this script exits 0
# and prints nothing else, which Claude Code reads as "carry on": a failure here can only leave the chat without
# zero-touch, never block it.
trap "exit 0" EXIT

home="${MMO_HOME:-$HOME/.mmo-ambient}"

if ! command -v node >/dev/null 2>&1; then
  # Zero-touch cannot run without Node.js, so the chat stays plain; the person is told once per chat. Here only
  # where a start hook's message is shown (the terminal, with no label or "cli"; a run with no screen, "sdk-*"), and
  # the chat is marked as told; everywhere else the message hook says it at the chat's first message
  # (hooks/settings.sh). The rule is scripts/mark.mjs startMessageShown, and the words are scripts/messages.mjs
  # NODE_MISSING and NODE_MISSING_NOTE (tools/test/zero-touch-plugin.test.mjs runs this script and compares).
  case "${CLAUDE_CODE_ENTRYPOINT:-cli}" in
    cli|sdk-cli|sdk-ts|sdk-py)
      sid=$(head -c 512 | sed -n 's/^{[[:space:]]*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]\{1,80\}\)".*/\1/p' | head -n 1)
      chat="$home/sessions/$sid"
      if [ -n "$sid" ] && [ ! -f "$chat/zt_node_said" ]; then
        # Each apostrophe is written '\'' (close the quote, a quoted apostrophe, reopen): a bare one would end the
        # quoting and run the words together.
        (umask 077 && mkdir -p "$chat") 2>/dev/null && : > "$chat/zt_node_said" 2>/dev/null &&
          printf '%s' '{"systemMessage":"Zero-touch can'\''t run on this computer, because a program it needs, Node.js, isn'\''t installed. Claude works as normal without it. To use zero-touch, install Node.js from nodejs.org, then start a new chat.","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Zero-touch, a plugin installed here, cannot run because Node.js is not installed on this computer, so it does nothing in this chat. The person has been shown a line saying so. Answer their message normally. If they ask about zero-touch, tell them to install Node.js from nodejs.org and then start a new chat."}}'
      fi
      ;;
  esac
  exit 0
fi

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$dir/../scripts/start-chat.mjs"
