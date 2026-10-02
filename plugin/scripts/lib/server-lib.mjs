/**
 * The dispatch server's code, for the plugin's scripts: loaded from the pre-built bundle the plugin ships
 * (plugin/mcp/model-dispatch/bundle/lib.mjs, built from src/lib.ts by `npm run build` in that folder).
 *
 * Why: a plugin installed from GitHub has only committed files, and the compiled dist/*.js is not committed. The
 * bundle is committed and carries its libraries inside, so the run-start check, the hand-off model lookup, the cost
 * collector and the manifest writer work on a fresh install. One loader, so every script reads the same code the
 * server runs.
 *
 * Exports: SERVER_PACKAGE, SERVER_BUNDLE (the server the plugin starts), SERVER_LIB, serverBuilt(), loadServerLib().
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** plugin/mcp/model-dispatch. */
export const SERVER_PACKAGE = join(HERE, "..", "..", "mcp", "model-dispatch");
/** The server plugin.json starts. */
export const SERVER_BUNDLE = join(SERVER_PACKAGE, "bundle", "server.mjs");
/** The server code the scripts load. */
export const SERVER_LIB = join(SERVER_PACKAGE, "bundle", "lib.mjs");

/** Whether this copy of the plugin has its pre-built server parts (false only for a damaged or partial copy). */
export function serverBuilt() {
  return existsSync(SERVER_BUNDLE) && existsSync(SERVER_LIB);
}

let cached;
/**
 * The namespaces the scripts use: { policy, routing, executorRun, telemetry, pricing, prices, effectivePrice,
 * adapters }, each the server module of the same name. Throws a plain error when the bundle is missing.
 */
export async function loadServerLib() {
  if (cached) return cached;
  if (!existsSync(SERVER_LIB)) {
    throw new Error(`this copy of the plugin is missing its pre-built server code (${SERVER_LIB}); reinstall the plugin`);
  }
  // A file URL, not a path: a '#' or '%' in the plugin's folder would otherwise be read as URL syntax.
  cached = await import(pathToFileURL(SERVER_LIB).href);
  return cached;
}
