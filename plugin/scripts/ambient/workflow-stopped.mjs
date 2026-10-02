#!/usr/bin/env node
/**
 * A workflow says it stopped before its run began.
 *
 * Why: a /mmo: workflow asks its first questions (the brief, the plan) before its run logs anything, so nothing on
 * disk can tell "still asking" from "stopped" (the person said no to the plan, a check failed, the folder was
 * wrong). In a zero-touch chat such a workflow would hold the chat and the project for good: every later message
 * "taken as your answer", and every other chat's workflow in that folder refused. So in a zero-touch chat, Claude is
 * told when a workflow command loads (hook.mjs, the "post-skill" moment; mmo's command texts are unchanged) to run
 * this script once at each of those stops; zero-touch's hook sees the call (the "pre-any" moment) and ends the chat's
 * workflow at the end of that turn. The script itself changes nothing and needs no arguments. Zero-touch's own
 * script, with zero-touch's other code in mmo's folder (plugin/scripts/ambient/).
 *
 * Usage: node workflow-stopped.mjs [--reason "<a few words>"]
 */
const i = process.argv.indexOf("--reason");
const reason = i > 0 ? String(process.argv[i + 1] ?? "").trim() : "";
console.log(reason ? `Stopped before the run began: ${reason}.` : "Stopped before the run began.");
