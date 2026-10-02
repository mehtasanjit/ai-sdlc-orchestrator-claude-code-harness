/**
 * Where this package and the plugin around it are on disk, found the same way from the compiled files (dist/…) and
 * from the single-file bundles the plugin ships (bundle/server.mjs, bundle/lib.mjs).
 *
 * Why: a plugin installed from GitHub has only committed files, so the plugin ships the server and the code its
 * scripts load as pre-built bundles. Inside a bundle every module's `import.meta.url` is the bundle file, so a path
 * written as "two folders up from this module" would point at the wrong folder for modules deeper in dist/
 * (executor/, adapters/). Every such path is taken from this one place: walk up from this module to the folder whose
 * package.json names this package.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@mmo/model-dispatch";

/** The folder holding this package's package.json, walking up from `start` (a file path); the parent of `start`'s folder if none is found. */
export function findPackageRoot(start: string): string {
  let dir = dirname(start);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, "utf8")).name === PACKAGE_NAME) return dir;
      } catch { /* not ours: keep walking */ }
    }
    const up = dirname(dir);
    if (up === dir) return resolve(dirname(start), "..");
    dir = up;
  }
}

/** plugin/mcp/model-dispatch: the package root (package.json, worker/, bundle/, dist/). */
export const PACKAGE_ROOT = findPackageRoot(fileURLToPath(import.meta.url));
/** plugin/: the plugin root (config/policies/, .claude-plugin/, scripts/). */
export const PLUGIN_ROOT = resolve(PACKAGE_ROOT, "..", "..");
/** The Python workers (typist_worker.py, gemini_worker.py) and their .venv. */
export const WORKER_DIR = join(PACKAGE_ROOT, "worker");
