#!/bin/sh
# Runs one of this plugin's hook scripts with node: `node.sh <script in scripts/> [args...]`.
# POSIX sh only.
#
# Why: on a computer without Node.js (the desktop app brings its own runtime, so it needs none) a bare `node …` hook
# command fails with "node: command not found" on every file write, edit and helper launch, shown as a hook error,
# although zero-touch tells the person "Claude works as normal without it". Without node this exits 0 and prints
# nothing, which Claude Code reads as "carry on"; nothing these hooks guard can be running then, since every workflow
# needs node.
#
# With node, `exec` hands the script this script's input, output and exit code unchanged: the write contract refuses a
# write with exit 2, and that must reach Claude Code. So no trap here (ambient.sh has one: its decisions travel as
# JSON, never as an exit code).
command -v node >/dev/null 2>&1 || exit 0
script="$1"
shift
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$dir/../scripts/$script" "$@"
