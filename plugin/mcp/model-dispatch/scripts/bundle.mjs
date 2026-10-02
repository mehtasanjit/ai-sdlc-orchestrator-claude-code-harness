#!/usr/bin/env node
/**
 * Builds the two single-file bundles the plugin ships, from the compiled dist/ (run after `tsc`):
 *   bundle/server.mjs  the MCP server (plugin.json starts it)
 *   bundle/lib.mjs     the server code the plugin's scripts load (src/lib.ts; starts nothing)
 *
 * Why: a plugin installed from GitHub gets only committed files, and dist/ and node_modules/ are not committed. The
 * bundles carry their libraries inside and are committed, so an install works with nothing to build.
 *
 * The bundles are committed build output, so they must always match the source: tools/test/server-bundle.test.mjs
 * rebuilds them in memory and fails when the committed files differ. After changing anything under src/, run
 * `npm run build` here and commit bundle/ with the change.
 *
 * Usage: node scripts/bundle.mjs            write bundle/server.mjs and bundle/lib.mjs
 *        import { buildBundles } ...        { write: false } returns the outputs without writing (the test);
 *                                           { distDir } bundles a compiled copy other than dist/ (the test
 *                                           compiles src/ into a temporary folder)
 */
import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Each bundle: the compiled entry (relative to the compiled folder) and the file it is written to. */
export const ENTRIES = [
  { entry: "server.js", out: join(PACKAGE, "bundle", "server.mjs") },
  { entry: "lib.js", out: join(PACKAGE, "bundle", "lib.mjs") },
];

// CommonJS libraries inside an ES-module bundle still call require() for Node's own modules and read
// __dirname/__filename; these three lines give them what Node gives a CommonJS file.
const BANNER = [
  'import { createRequire as __mmoCreateRequire } from "node:module";',
  'import { fileURLToPath as __mmoFileURLToPath } from "node:url";',
  'import { dirname as __mmoDirname } from "node:path";',
  "const require = __mmoCreateRequire(import.meta.url);",
  "const __filename = __mmoFileURLToPath(import.meta.url);",
  "const __dirname = __mmoDirname(__filename);",
].join("\n");

/** The esbuild options for one entry. Fixed, so the same source always gives the same bytes. */
export function bundleOptions(entry, outfile, write = true) {
  return {
    entryPoints: [entry],
    outfile,
    write,
    // Paths are resolved from the package, whoever runs the build, so the bytes never depend on the caller's folder.
    absWorkingDir: PACKAGE,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    minify: true,
    keepNames: true,
    legalComments: "eof",
    charset: "utf8",
    banner: { js: BANNER },
    // Two old libraries inside (tr46 and whatwg-url, under node-fetch) require Node's own punycode module, which
    // prints a deprecation warning on stderr when loaded. The scripts' first stderr line is the reason a check
    // shows, so the bundles carry the same code from the userland punycode package instead.
    alias: { punycode: "punycode/" },
    logLevel: "warning",
  };
}

/** Builds both bundles; with write false, returns [{ out, text }] instead of writing. */
export async function buildBundles({ write = true, distDir = join(PACKAGE, "dist") } = {}) {
  const results = [];
  for (const { entry, out } of ENTRIES) {
    const r = await build(bundleOptions(join(distDir, entry), out, write));
    results.push({ out, text: write ? null : r.outputFiles[0].text });
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await buildBundles();
  for (const { out } of ENTRIES) console.log(`built ${out}`);
}
