#!/bin/sh
# The zero-touch settings box (scripts/settings-hook.mjs): $1 is the moment, pre-ask | post-ask | prompt | pre-any.
# POSIX sh only. Exits 0 whatever happens (the trap), so a failure never blocks the chat.
#
# Speed: "pre-any" runs before every tool call and "prompt" before every message, in every chat, so both leave before
# starting node unless there is work. "pre-any" has work only in a chat waiting for its first settings
# (zt_setup.json). "prompt" also has work when a box sequence is under way (zt_flow.json), when start lines wait for
# the chat's first message (zt_say.json), or when the message names zero-touch (a generous text match here; node
# decides exactly, with the same rule as the mmo plugin's routing). The chat id is read from the first 512 bytes of
# the input, where Claude Code puts it; when it cannot be read, node decides.
#
# Node.js missing: zero-touch cannot run, so the chat stays plain. "prompt" says so once per chat, at the
# chat's first message, which every Claude Code screen shows: the desktop app hides a start hook's message. In the
# terminal the start hook (start-chat.sh) has said it already and left the same mark, so it is not said twice.
trap "exit 0" EXIT

event="$1"
home="${MMO_HOME:-$HOME/.mmo-ambient}"
input=$(cat)
sid=$(printf '%s' "$input" | head -c 512 | sed -n 's/^{[[:space:]]*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]\{1,80\}\)".*/\1/p' | head -n 1)
chat="$home/sessions/$sid"

if ! command -v node >/dev/null 2>&1; then
  if [ "$event" = "prompt" ] && [ -n "$sid" ] && [ ! -f "$chat/zt_node_said" ]; then
    # The mark first, and the words only once it is written: a folder that cannot be written would otherwise say it
    # at every message. The words are scripts/messages.mjs NODE_MISSING and NODE_MISSING_NOTE
    # (tools/test/zero-touch-plugin.test.mjs runs this script without node and compares). Each apostrophe is written
    # '\'' (close the quote, a quoted apostrophe, reopen): a bare one would end the quoting.
    (umask 077 && mkdir -p "$chat") 2>/dev/null && : > "$chat/zt_node_said" 2>/dev/null &&
      printf '%s' '{"systemMessage":"Zero-touch can'\''t run on this computer, because a program it needs, Node.js, isn'\''t installed. Claude works as normal without it. To use zero-touch, install Node.js from nodejs.org, then start a new chat.","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Zero-touch, a plugin installed here, cannot run because Node.js is not installed on this computer, so it does nothing in this chat. The person has been shown a line saying so. Answer their message normally. If they ask about zero-touch, tell them to install Node.js from nodejs.org and then start a new chat."}}'
  fi
  exit 0
fi

if [ -n "$sid" ]; then
  if [ "$event" = "pre-any" ] && [ ! -f "$chat/zt_setup.json" ]; then exit 0; fi
  if [ "$event" = "prompt" ] && [ ! -f "$chat/zt_setup.json" ] && [ ! -f "$chat/zt_flow.json" ] && [ ! -f "$chat/zt_say.json" ]; then
    printf '%s' "$input" | grep -qiE 'zero.{0,6}touch' || exit 0
  fi
fi

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s' "$input" | node "$dir/../scripts/settings-hook.mjs" "$event"
