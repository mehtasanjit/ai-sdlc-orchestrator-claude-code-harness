#!/usr/bin/env node
/**
 * Writes a run's manifest.json from the run's own records.
 *
 * Why: a manifest typed by a model can come out in a different shape every run, with field names the
 * collector cannot read (a `policy` object instead of `policy_name`, a `rollup` block instead of
 * `total_cost_usd`), and the collector then refuses it. This script builds it from the telemetry log
 * with the server's own `buildManifest`, so the shape is always the one the collector reads.
 *
 * Usage:
 *   node write-manifest.mjs <output_dir> --pass <run id> --policy <policy name>
 *        [--project-root <dir>] [--code-dir <dir>] [--status <accepted|rejected|...>]
 *
 * Reads <output_dir>/telemetry.jsonl (every event; the collector's own `tier: "orchestrator"` event
 * is partitioned out by buildManifest), the run log's gate lines (`gate.resolved ... response=...`)
 * and, with --code-dir, counts the product's files and lines: every file under a generated code
 * folder, or, when the code folder is the project itself (brownfield), only the files the run's
 * record lists (written-files.json, provenance.json); with no such record the counts are left out.
 * A path that cannot be read never stops the manifest. Fields the collector added to an existing
 * manifest (orchestrator_overhead, true_total_cost_usd and its notes) are kept while the dispatched
 * total is the one they were computed from; when it changed they are left out until the collector
 * runs again. Prints one line with the dispatched total, then one line per note.
 */
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveProjectRoot } from "./lib/env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Keys the post-run collector writes into a manifest; kept across a rewrite while the dispatched total is unchanged. */
const COLLECTOR_KEYS = ["orchestrator_overhead", "true_total_cost_usd", "orchestrator_overhead_note", "cost_source", "pricing_basis"];

/** Folders that hold installed packages, VCS data, caches, build output, tool state or run records, never the product. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", ".sdlc", ".claude", "dist", "build", ".venv", "venv", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox", "coverage", ".nyc_output", ".next", ".nuxt",
  ".svelte-kit", ".turbo", ".parcel-cache", ".cache", "target", ".gradle", ".terraform", "vendor", "Pods",
]);
/** Files a package manager writes. */
const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "Cargo.lock",
  "poetry.lock", "Pipfile.lock", "pdm.lock", "uv.lock", "composer.lock", "Gemfile.lock", "go.sum", "Podfile.lock",
  "packages.lock.json", "gradle.lockfile", "flake.lock", "mix.lock", "pubspec.lock", "Package.resolved",
]);

function parseArgs(argv) {
  const a = { outDir: undefined, pass: undefined, policy: undefined, projectRoot: undefined, codeDir: undefined, status: undefined };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const eat = (flag) => (x.startsWith(`${flag}=`) ? x.slice(flag.length + 1) : argv[++i]);
    if (x === "--pass" || x.startsWith("--pass=")) a.pass = eat("--pass");
    else if (x === "--policy" || x.startsWith("--policy=")) a.policy = eat("--policy");
    else if (x === "--project-root" || x.startsWith("--project-root=")) a.projectRoot = eat("--project-root");
    else if (x === "--code-dir" || x.startsWith("--code-dir=")) a.codeDir = eat("--code-dir");
    else if (x === "--status" || x.startsWith("--status=")) a.status = eat("--status");
    else if (x.startsWith("--")) throw new Error(`unknown argument '${x}'`);
    else if (a.outDir === undefined) a.outDir = x;
    else throw new Error(`unexpected extra positional '${x}'`);
  }
  if (!a.outDir || !a.pass || !a.policy) throw new Error("usage: write-manifest.mjs <output_dir> --pass <run id> --policy <policy name> [--project-root <dir>] [--code-dir <dir>] [--status <status>]");
  return a;
}

/** The run log's gate answers: `gate.resolved run_id=... gate=<id> response=<answer>`. */
export function gatesFromLog(logPath) {
  if (!logPath || !existsSync(logPath)) return [];
  const gates = [];
  for (const line of readFileSync(logPath, "utf-8").split("\n")) {
    const m = /^(?:\S+\s+)?(\S+)\s+[A-Z]+\s+gate\.resolved\s.*\bgate=(\S+)\s.*\bresponse=(\S+)/.exec(line);
    if (m) gates.push({ gate: m[2], response: m[3], at: m[1] });
  }
  return gates;
}

const errCode = (e) => e?.code ?? e?.message ?? String(e);

/** Newlines + 1, the same figure as `split("\n").length`, read in chunks so a large file is never held whole. */
function linesOf(path, onSkip) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(1 << 16);
    let n = 0, got;
    while ((got = readSync(fd, buf, 0, buf.length, null)) > 0) for (let i = 0; i < got; i++) if (buf[i] === 10) n++;
    return n + 1;
  } catch (e) {
    onSkip(path, errCode(e));
    return 0;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** A Python virtualenv carries pyvenv.cfg whatever the folder is called (env/, .env/, py311/). */
const isVirtualenv = (dir) => { try { return lstatSync(join(dir, "pyvenv.cfg")).isFile(); } catch { return false; } };

/**
 * The product's files and lines, counted on disk: every regular file under the code directory, with
 * installed-package, VCS, cache, build-output, tool and run-record folders and lockfiles skipped.
 * Symlinks are never followed (a dangling one, a link to a parent, a link out of the tree), a folder
 * is entered once however it is reached (a bind mount can still make a cycle; inode numbers are read
 * as bigint so two never round to one), and an entry that cannot be read is passed to `onSkip` and
 * left out, so the count never throws.
 */
export function countProduct(codeDir, { onSkip = () => {} } = {}) {
  let files = 0, loc = 0;
  const entered = new Set();
  const walk = (d, st) => {
    const id = `${st.dev}:${st.ino}`;
    if (entered.has(id)) return;
    entered.add(id);
    let names;
    try { names = readdirSync(d); } catch (e) { onSkip(d, errCode(e)); return; }
    for (const name of names) {
      const full = join(d, name);
      let s;
      try { s = lstatSync(full, { bigint: true }); } catch (e) { onSkip(full, errCode(e)); continue; }
      if (s.isDirectory()) { if (!SKIP_DIRS.has(name) && !isVirtualenv(full)) walk(full, s); }
      else if (s.isFile() && !LOCKFILES.has(name)) { files++; loc += linesOf(full, onSkip); }
    }
  };
  let root;
  try { root = lstatSync(codeDir, { bigint: true }); } catch { root = undefined; }
  // The code directory itself may be a link the caller named on purpose; only links inside it are skipped.
  if (root?.isSymbolicLink()) try { root = lstatSync(realpathSync(codeDir), { bigint: true }); } catch (e) { onSkip(codeDir, errCode(e)); root = undefined; }
  if (root?.isDirectory()) walk(codeDir, root);
  return { files, loc };
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const within = (dir, p) => { const r = relative(dir, p); return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r)); };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
const provenancePath = (projectRoot, pass) => join(projectRoot, ".sdlc", "runs", pass, "provenance.json");

/**
 * The files the run's record says it wrote, as absolute paths: the executor's written-files.json (paths
 * relative to the code directory) and the brownfield provenance.json (paths relative to the project
 * root that holds it). Undefined when neither record exists.
 */
export function runFiles({ outDir, codeDir, projectRoot, pass }) {
  let recorded = false;
  const paths = new Set();
  const written = readJson(join(outDir, "written-files.json"));
  if (Array.isArray(written)) {
    recorded = true;
    for (const p of written) if (typeof p === "string") paths.add(resolve(codeDir, p));
  }
  const prov = readJson(provenancePath(projectRoot, pass));
  if (Array.isArray(prov?.files_touched)) {
    recorded = true;
    for (const f of prov.files_touched) if (typeof f?.path === "string") paths.add(resolve(projectRoot, f.path));
  }
  return recorded ? [...paths] : undefined;
}

/** The listed files that are the product: under the code directory, outside the skipped folders, not a lockfile, still on disk. */
export function countFiles(paths, codeDir, { onSkip = () => {} } = {}) {
  // Real folders on both sides: the project root and the code directory can name one place two ways (/tmp, /private/tmp).
  const root = real(codeDir);
  let files = 0, loc = 0;
  for (const p of paths) {
    const at = join(real(dirname(p)), basename(p));
    const rel = relative(root, at);
    if (rel === "" || !within(root, at)) continue;
    const parts = rel.split(sep);
    if (parts.slice(0, -1).some((x) => SKIP_DIRS.has(x)) || LOCKFILES.has(parts[parts.length - 1])) continue;
    let s;
    try { s = lstatSync(at); } catch (e) { if (e?.code !== "ENOENT") onSkip(p, errCode(e)); continue; }
    if (s.isFile()) { files++; loc += linesOf(at, onSkip); }
  }
  return { files, loc };
}

/**
 * The counts for the manifest, or undefined with a note saying why they are left out. A code directory
 * that is the project itself (a repository root, a run with a provenance record, or a folder that holds
 * the run record) is not the run's product, so only the files the run wrote are counted there.
 */
function productCounts({ codeDir, outDir, projectRoot, pass }, notes) {
  const skipped = [];
  const onSkip = (p, why) => skipped.push(`${relative(codeDir, p) || "."} (${why})`);
  const isProject = existsSync(join(codeDir, ".git")) || existsSync(provenancePath(projectRoot, pass)) || within(real(codeDir), real(outDir));
  let counts;
  if (isProject) {
    const listed = runFiles({ outDir, codeDir, projectRoot, pass });
    if (!listed) {
      notes.push(`file counts left out: the code directory ${codeDir} is the project itself, and no run record lists the files this run wrote (written-files.json in ${outDir}, or files_touched in ${provenancePath(projectRoot, pass)})`);
      return undefined;
    }
    counts = countFiles(listed, codeDir, { onSkip });
  } else {
    counts = countProduct(codeDir, { onSkip });
  }
  if (skipped.length > 0) {
    notes.push(`${skipped.length} path(s) could not be read and are left out of the file counts: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}`);
  }
  return counts;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * The dispatched total an existing manifest's collector figures were computed from. The collector
 * writes true total = dispatched − in-session + overhead, so the figures themselves give it back,
 * even on a manifest whose total_cost_usd was rewritten since; without them, the total it read.
 */
export function collectorBasis(m) {
  const oh = m?.orchestrator_overhead;
  if (Number.isFinite(m?.true_total_cost_usd) && Number.isFinite(oh?.cost_usd)) {
    return m.true_total_cost_usd - oh.cost_usd + (Number.isFinite(oh.dispatched_in_session_cost_usd) ? oh.dispatched_in_session_cost_usd : 0);
  }
  const read = m?.totals?.dispatched_cost_usd ?? m?.total_cost_usd;
  return Number.isFinite(read) ? read : undefined;
}

export async function writeManifest(a) {
  const outDir = resolve(a.outDir);
  const telemetryPath = join(outDir, "telemetry.jsonl");
  const events = existsSync(telemetryPath)
    ? readFileSync(telemetryPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  // A file URL, not a path: a '#' or '%' in the plugin's folder would otherwise be read as URL syntax.
  const { buildManifest } = await import(pathToFileURL(join(HERE, "..", "mcp", "model-dispatch", "dist", "telemetry.js")).href);
  const manifestPath = join(outDir, "manifest.json");
  let existing = {};
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
  } catch { /* first write */ }
  const projectRoot = resolveProjectRoot(a.projectRoot);
  const notes = [];
  let product;
  if (a.codeDir) {
    try { product = productCounts({ codeDir: resolve(a.codeDir), outDir, projectRoot: resolve(projectRoot), pass: a.pass }, notes); }
    catch (e) { notes.push(`file counts left out: ${e?.message ?? e}`); }
  }
  const built = buildManifest(events, { pass: a.pass, policy_name: a.policy, ...(product ? { artifacts: { files: product.files, loc: product.loc } } : {}) });
  const gates = gatesFromLog(join(projectRoot, ".sdlc", "runs", a.pass, "orchestrator.log"));
  const manifest = {
    ...built,
    run_id: a.pass,
    gates,
    status: a.status ?? existing.status ?? "provisional",
    written_by: "plugin/scripts/write-manifest.mjs",
    written_at: new Date().toISOString(),
  };
  if (COLLECTOR_KEYS.some((k) => existing[k] !== undefined)) {
    const before = collectorBasis(existing);
    if (before !== undefined && Math.abs(before - built.total_cost_usd) < 1e-6) {
      for (const k of COLLECTOR_KEYS) if (existing[k] !== undefined) manifest[k] = existing[k];
    } else {
      // buildManifest's own overhead block comes from the same collector event, so it goes too.
      for (const k of COLLECTOR_KEYS) delete manifest[k];
      const why = before !== undefined
        ? `the dispatched total changed since the collector ran ($${round6(before)} → $${built.total_cost_usd})`
        : `the manifest the collector patched records no dispatched total to check its figures against`;
      notes.push(`${why}: its orchestrator_overhead and true_total_cost_usd are left out until it runs again: node "${join(HERE, "collect-orchestrator-usage.mjs")}" "${outDir}" --project-root "${projectRoot}"`);
    }
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { manifestPath, dispatched: built.total_cost_usd, events: events.length, gates: gates.length, status: manifest.status, notes };
}

// The main module's URL is its real path, so a plugin folder reached through a symlink compares real paths.
const entry = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1] ?? "")); } catch { return false; } })();
if (entry) {
  writeManifest(parseArgs(process.argv.slice(2)))
    .then((r) => {
      console.log(`manifest written: ${r.manifestPath} — dispatched $${r.dispatched} over ${r.events} event(s), ${r.gates} gate answer(s) recorded, status ${r.status}`);
      for (const n of r.notes) console.log(`note: ${n}`);
    })
    .catch((e) => { console.error(`write-manifest failed: ${e?.message ?? e}`); process.exit(1); });
}
