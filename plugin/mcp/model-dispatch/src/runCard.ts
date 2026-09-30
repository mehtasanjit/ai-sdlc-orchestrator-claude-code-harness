/**
 * The run card pre-flight records: which code and which cache rules a run used.
 *
 * Two runs are comparable only when they ran the same code under the same
 * prompt-cache rules. The plugin pins them: the orchestrator helper writes a
 * one-hour cache (its frontmatter), every lean Opus typist a five-minute one
 * (its environment). Claude Code (2.1.280) lets four things override that
 * silently:
 *   - FORCE_PROMPT_CACHING_5M (every cache write becomes five minutes);
 *   - any DISABLE_PROMPT_CACHING* variable (no caching at all, or none for one
 *     model family);
 *   - CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL and the subagentPromptCacheTtl
 *     setting (they replace a helper's own cacheTtl).
 * CLAUDE_CODE_PROMPT_CACHE_TTL / promptCacheTtl set only the main
 * conversation's lifetime, which no helper or typist uses, so they are not
 * overrides.
 *
 * Pre-flight names each override it finds (the name and where it was set,
 * never a value) as a warning, and records the plugin's version and commit,
 * whether its tree had uncommitted changes, Claude Code's version, and a
 * digest of the settings files. A user who set an override on purpose still
 * gets a run; a tool that compares runs can refuse one by reading this card.
 * Making the card never stops pre-flight: a settings file it cannot read is
 * named on the card instead.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const OVERRIDE_ENV = ["FORCE_PROMPT_CACHING_5M", "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL"];
const OVERRIDE_ENV_PREFIX = "DISABLE_PROMPT_CACHING";
const OVERRIDE_SETTINGS = ["subagentPromptCacheTtl"];

const isOverrideEnv = (k: string) => OVERRIDE_ENV.includes(k) || k === OVERRIDE_ENV_PREFIX || k.startsWith(`${OVERRIDE_ENV_PREFIX}_`);

/** Each cache override found, as "where: name" — names only, sorted within each source. */
export function cacheOverrides(env: Record<string, string | undefined>, settings: { source: string; json: any }[]): string[] {
  const found = Object.keys(env).filter((k) => env[k] !== undefined && env[k] !== "" && isOverrideEnv(k)).sort().map((k) => `environment: ${k}`);
  for (const { source, json } of settings) {
    const own = [
      ...Object.keys(json?.env ?? {}).filter(isOverrideEnv).map((k) => `env.${k}`),
      ...OVERRIDE_SETTINGS.filter((k) => json?.[k] !== undefined),
    ].sort();
    found.push(...own.map((k) => `${source}: ${k}`));
  }
  return found;
}

/** The settings files Claude Code reads for a session: the user's (under CLAUDE_CONFIG_DIR when set), then the project's and the project's local file. */
export function settingsFiles(env: Record<string, string | undefined>, projectRoot?: string): string[] {
  const user = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "settings.json") : join(env.HOME ?? "", ".claude", "settings.json");
  return [user, ...(projectRoot ? [join(projectRoot, ".claude", "settings.json"), join(projectRoot, ".claude", "settings.local.json")] : [])];
}

export interface RunCard {
  plugin_version: string;
  plugin_commit: string | null;
  /** Tracked files changed since the commit (the code that runs differs from plugin_commit). */
  plugin_tree_dirty: boolean | null;
  /** Untracked files in the plugin folder: counted apart, since they are not part of the committed code. */
  plugin_untracked: number | null;
  claude_code_version: string | null;
  cache_overrides: string[];
  settings_sha256: string;
  /** Settings files that exist but could not be read or are not JSON, as "path: why": their overrides are unknown. */
  settings_problems: string[];
}

const run = (cmd: string, args: string[]): string | null => {
  try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
};

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * The git checkout whose commit is the plugin's code: the plugin folder when
 * it is the top of its own repository, or the repository that holds the
 * plugin's source (its marketplace file names the plugin folder, the clone
 * route); else null. A repository that merely contains the folder — an
 * installed copy inside a git-tracked home folder — says nothing about the
 * plugin's code.
 */
function pluginCheckout(pluginDir: string, exec: (cmd: string, args: string[]) => string | null): string | null {
  const top = exec("git", ["-C", pluginDir, "rev-parse", "--show-toplevel"]);
  if (top === null) return null;
  const root = real(top.trim());
  const dir = real(pluginDir);
  if (root === dir) return root;
  try {
    const market = JSON.parse(readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"));
    const sources = (market?.plugins ?? []).map((p: any) => p?.source).filter((x: unknown): x is string => typeof x === "string");
    if (sources.some((src: string) => real(resolve(root, src)) === dir)) return root;
  } catch { /* no marketplace file: not the plugin's own checkout */ }
  return null;
}

export function runCard(opts: { pluginDir: string; pluginVersion: string; env: Record<string, string | undefined>; projectRoot?: string; exec?: (cmd: string, args: string[]) => string | null }): RunCard {
  const exec = opts.exec ?? run;
  const files = settingsFiles(opts.env, opts.projectRoot).filter((f) => existsSync(f));
  const settings: { source: string; json: any }[] = [];
  const problems: string[] = [];
  const digest = createHash("sha256");
  for (const f of files) {
    let text: string;
    try { text = readFileSync(f, "utf8"); } catch (e: any) {
      problems.push(`${f}: unreadable (${e?.code ?? "error"})`);
      digest.update(`${f}\n(unreadable)\n`);
      continue;
    }
    digest.update(`${f}\n${text}\n`);
    try { settings.push({ source: f, json: JSON.parse(text) }); } catch { problems.push(`${f}: not JSON`); settings.push({ source: f, json: {} }); }
  }
  const checkout = pluginCheckout(opts.pluginDir, exec);
  const commit = checkout === null ? null : exec("git", ["-C", opts.pluginDir, "rev-parse", "HEAD"]);
  // Only changes inside the plugin folder make its code differ from the commit.
  const status = commit === null ? null : exec("git", ["-C", opts.pluginDir, "status", "--porcelain", "--", "."]);
  const cli = exec("claude", ["--version"]);
  return {
    plugin_version: opts.pluginVersion,
    plugin_commit: commit === null ? null : commit.trim(),
    plugin_tree_dirty: status === null ? null : status.split("\n").some((l) => l.trim() && !l.startsWith("??")),
    plugin_untracked: status === null ? null : status.split("\n").filter((l) => l.startsWith("??")).length,
    claude_code_version: cli === null ? null : cli.trim(),
    cache_overrides: cacheOverrides(opts.env, settings),
    settings_sha256: digest.digest("hex"),
    settings_problems: problems,
  };
}

/**
 * Why a run's next executor stage must not run: its first stage ran under one
 * auth mode and policy, and the latest pre-flight recorded different ones, so
 * the run would change midway. The same values again (a pre-flight repeated
 * after a context compaction, say) are fine. Checked per run, by the executor
 * (executor/tools.ts, RUN_BINDINGS); a new run is never refused.
 */
export function runStateConflict(prev: { authMode: string; policyName?: string; policyPath?: string } | undefined, next: { authMode: string; policyName?: string; policyPath?: string }): string | null {
  if (!prev) return null;
  if (prev.authMode !== next.authMode) return `this run started its stages under auth mode ${prev.authMode}; the latest pre-flight asked for ${next.authMode}`;
  if ((prev.policyName ?? "") !== (next.policyName ?? "") || (prev.policyPath ?? "") !== (next.policyPath ?? "")) return `this run started its stages under policy ${prev.policyName ?? prev.policyPath ?? "(default)"}; the latest pre-flight asked for ${next.policyName ?? next.policyPath ?? "(default)"}`;
  return null;
}
