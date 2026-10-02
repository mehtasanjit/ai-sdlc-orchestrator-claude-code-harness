/**
 * Some root tests call the workflows' own run-start check (plugin/scripts/driver-model-check.mjs) and the other
 * scripts that load the server's code. They load the pre-built bundle the plugin ships
 * (plugin/mcp/model-dispatch/bundle/lib.mjs), which is committed, so a clone has it; tools/test/server-bundle.test.mjs
 * fails when it no longer matches the source. If it is missing, build it when the dependencies are installed;
 * otherwise say loudly that those tests are NOT run, as tools/test-mcp.mjs does for the server suite. Never pass
 * silently.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const SERVER = join(ROOT, "plugin", "mcp", "model-dispatch");

/** null when the server is built (or was just built); else the reason the dependent tests are skipped. */
export function serverBuilt() {
  if (existsSync(join(SERVER, "bundle", "lib.mjs")) && existsSync(join(SERVER, "bundle", "server.mjs"))) return null;
  if (!existsSync(join(SERVER, "node_modules"))) {
    const why = "NOT RUN: the server's pre-built bundle is missing and its dependencies are not installed (npm run verify -- --fix, then npm test)";
    console.log(`\n! ${why}\n`);
    return why;
  }
  execFileSync("npm", ["run", "build"], { cwd: SERVER, stdio: "ignore" });
  return null;
}
