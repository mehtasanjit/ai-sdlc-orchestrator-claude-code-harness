#!/usr/bin/env node
/**
 * Saves a project folder with git: one starting commit, so a change workflow can run there and undo what it changes.
 *
 * Why: every change workflow (bug fix, feature, refactor, tests, docs, library upgrade) refuses a folder git does not
 * track, because its rollback points are git commits; a new app left without git would refuse the very next request
 * ("fix this bug in the app"). So a new-app run zero-touch started ends with this, run by zero-touch's own end-of-turn
 * hook (hook.mjs, "turn-end"), and a change
 * workflow zero-touch could not start for this reason tells the person they can ask Claude to do it
 * (lib/route-flow.mjs). Zero-touch's own script: it sits with zero-touch's other code in mmo's folder
 * (plugin/scripts/ambient/), and nothing of mmo's own runs it.
 *
 * What it does, and nothing else:
 *   - a folder git already tracks (here or above): says so, changes nothing;
 *   - no real git on this computer (on a Mac without the developer tools, /usr/bin/git only opens an install dialog;
 *     lib/git.mjs): says so, changes nothing;
 *   - otherwise: `git init`, then the usual things that must never be committed go in git's own exclude list
 *     (`.git/info/exclude`, inside the new .git folder: none of the person's files is written or changed), then one
 *     commit of everything else. With no git identity set on this computer, that one commit is signed "Zero-touch".
 *
 * Usage: node git-baseline.mjs [--dir <folder>]   (default: the current folder)
 * Prints one plain line. Exit 0: saved, or already saved. Exit 3: no git on this computer. Exit 1: git failed.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitInstalled, gitRoot } from "../lib/git.mjs";

/** Never committed: dependencies, secrets, machine-local run records, editor and system clutter. */
export const EXCLUDE = ["node_modules/", ".env", ".env.*", "!.env.example", ".sdlc/local/", ".DS_Store", "*.log"];

export const SAID = {
  saved: "Saved this project with git (a starting point), so later changes can be tracked and undone.",
  already: "This project is already saved with git.",
  noGit: "git isn't installed on this computer, so the project couldn't be saved with it. On a Mac, Claude can open Apple's installer for it; then ask again.",
  failed: "The project couldn't be saved with git, because git reported a problem. Claude can look into it.",
};

/** Saves `dir` with git. Returns { code, line, detail? }. `env` and `run` are for tests. */
export function baseline(dir, { env = process.env, run = spawnSync } = {}) {
  const folder = resolve(dir);
  if (gitRoot(folder)) return { code: 0, line: SAID.already };
  if (!gitInstalled({ env, run })) return { code: 3, line: SAID.noGit };
  const git = (args) => run("git", args, { cwd: folder, env, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  const init = git(["init", "-q"]);
  if (init.status !== 0) return { code: 1, line: SAID.failed, detail: String(init.stderr ?? init.error ?? "").trim() };
  mkdirSync(join(folder, ".git", "info"), { recursive: true });
  appendFileSync(join(folder, ".git", "info", "exclude"), `\n# Added when zero-touch saved this project with git\n${EXCLUDE.join("\n")}\n`);
  const add = git(["add", "-A"]);
  if (add.status !== 0) return { code: 1, line: SAID.failed, detail: String(add.stderr ?? "").trim() };
  const message = ["commit", "-q", "--allow-empty", "-m", "Starting point, before any changes"];
  let commit = git(message);
  // No name and email set for git on this computer: this one commit gets a stand-in, and nothing is configured.
  if (commit.status !== 0) commit = git(["-c", "user.name=Zero-touch", "-c", "user.email=zero-touch@localhost", "-c", "commit.gpgsign=false", ...message]);
  if (commit.status !== 0) return { code: 1, line: SAID.failed, detail: String(commit.stderr ?? "").trim() };
  return { code: 0, line: SAID.saved };
}

const i = process.argv.indexOf("--dir");
const direct = process.argv[1] && resolve(process.argv[1]).endsWith(join("ambient", "git-baseline.mjs"));
if (direct) {
  const r = baseline(i > 0 && process.argv[i + 1] ? process.argv[i + 1] : process.cwd());
  console.log(r.line);
  if (r.detail) console.error(r.detail);
  process.exit(r.code);
}
