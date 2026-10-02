#!/bin/sh
# Front door for every zero-touch hook (workflow routing; docs/ambient-mode.md).
# POSIX sh only: this runs on machines where bash may be missing or old.
#
# The trap is the first line on purpose. Whatever happens below (node missing,
# a crash, a kill) this script exits 0, and exit 0 with no output means "carry
# on as plain Claude Code". Decisions travel as JSON on stdout, never as an
# exit code, so nothing here can block a prompt, a tool call or a model switch
# by accident.
trap "exit 0" EXIT

event="$1"
home="${MMO_HOME:-$HOME/.mmo-ambient}"

# Cheap exits before node starts. Zero-touch acts only in a chat whose start the
# zero-touch plugin marked (it writes sessions/<chat id>/chat_mode; see
# lib/chat-mode.mjs), or for one run under MMO_AMBIENT=on|observe (a developer or
# a measuring setup); no settings file switches it. So without
# MMO_AMBIENT, a chat with no record ends here: its id is read from the start of
# the hook input, where Claude Code puts it; an id that cannot be read with
# certainty (not first, or not a plain token) goes on to node, which decides.
[ "${MMO_AMBIENT:-}" = "off" ] && exit 0
input=$(cat)
if [ -z "${MMO_AMBIENT:-}" ]; then
  sid=$(printf '%s' "$input" | head -c 512 | sed -n 's/^{[[:space:]]*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]\{1,80\}\)".*/\1/p' | head -n 1)
  if [ -n "$sid" ] && [ ! -f "$home/sessions/$sid/chat_mode" ]; then
    # A chat without zero-touch's record: nothing to do, except undoing a hand-off, which works in any
    # chat (hook.mjs main), so a person who left Hand-off mode can still take one back.
    case "$event" in
      pre-handoff|post-handoff)
        printf '%s' "$input" | grep -Eq '"tool_name"[[:space:]]*:[[:space:]]*"mcp__[A-Za-z0-9_-]*undo_hand_off"' || exit 0
        ;;
      *) exit 0 ;;
    esac
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  # Say it once per machine, at a session start, and stay quiet afterwards.
  if [ "$event" = "session-start" ] && [ ! -f "$home/node-missing-said" ]; then
    mkdir -p "$home" 2>/dev/null && : > "$home/node-missing-said" 2>/dev/null
    # Each apostrophe is written '\'' (close the quote, a quoted apostrophe, reopen): a bare one would end the quoting
    # and run the words together (the test runs this script without node and reads what it prints).
    printf '%s' '{"systemMessage":"Zero-touch can'\''t run on this computer, because a program it needs, Node.js, isn'\''t installed. Claude works as normal without it. To use zero-touch, install Node.js from nodejs.org, then start a new chat."}'
  fi
  exit 0
fi

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s' "$input" | node "$dir/../scripts/ambient/hook.mjs" "$event"
