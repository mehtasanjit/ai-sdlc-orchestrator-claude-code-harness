#!/bin/sh
# Runs one of zero-touch's workflow and hand-off hooks (docs/ambient-mode.md). Their code sits with zero-touch's other
# code in the mmo plugin's folder (plugin/scripts/ambient/, started by plugin/hooks/ambient.sh); they are registered
# here, in zero-touch's own hook list, so a person without zero-touch has none of them: mmo's own hook list registers
# none of them (zero-touch as a strict add-on).
# POSIX sh only: this runs on machines where bash may be missing or old.
#
# Whatever happens below, this script exits 0, and exit 0 with no output means "carry on as plain Claude Code"; mmo's
# hook decides anything as JSON on stdout.
trap "exit 0" EXIT

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
zt=$(dirname -- "$here")

# mmo's folder, the first of these that holds mmo's hook script:
#   1. MMO_PLUGIN_ROOT, for tests and a developer's checkout;
#   2. the installed mmo that zero-touch's start hook found in Claude Code's record of installed plugins at this chat's
#      start (scripts/mark.mjs mmoRoot, kept in zero-touch's data folder);
#   3. the installed mmo of the same version beside zero-touch (both install from one marketplace, at one version:
#      <cache>/<marketplace>/zero-touch/<version> and <cache>/<marketplace>/mmo/<version>), for a chat whose start
#      hook has not written 2 yet;
#   4. this repository's own layout (zero-touch/ beside plugin/).
# None: mmo is missing, and zero-touch's start message has said so; nothing to run.
# A folder counts only when it holds mmo's hook script AND says it carries zero-touch's hooks
# (scripts/ambient/api.json, "zero_touch_api" 1 or more): an mmo without zero-touch's hooks, or one with the script
# but not that file, is never run, even for the one chat in which the kept answer still names it after zero-touch
# updated mmo (scripts/mmo-update.mjs).
kept=""
[ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ -f "$CLAUDE_PLUGIN_DATA/mmo-root" ] && kept=$(head -n 1 "$CLAUDE_PLUGIN_DATA/mmo-root" 2>/dev/null)
mmo=""
for c in "${MMO_PLUGIN_ROOT:-}" "$kept" "$zt/../../mmo/$(basename -- "$zt")" "$zt/../plugin"; do
  if [ -n "$c" ] && [ -f "$c/hooks/ambient.sh" ] && grep -Eq '"zero_touch_api"[[:space:]]*:[[:space:]]*[1-9]' "$c/scripts/ambient/api.json" 2>/dev/null; then
    mmo=$(CDPATH= cd -- "$c" 2>/dev/null && pwd)
    [ -n "$mmo" ] && break
  fi
done
[ -n "$mmo" ] || exit 0

# mmo's hook script, with this hook's input on stdin and mmo's folder as the plugin folder it runs from.
CLAUDE_PLUGIN_ROOT="$mmo" exec sh "$mmo/hooks/ambient.sh" "$@"
