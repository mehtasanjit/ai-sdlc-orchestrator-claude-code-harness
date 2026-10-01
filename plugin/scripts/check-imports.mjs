#!/usr/bin/env node
/**
 * check-imports.mjs — does every import in one JS/TS file resolve, and does
 * the target export the names it imports?
 *
 * Run as a per-packet verify command on the mechanical tier (plan-to-packets
 * adds it under --multi-model), so a worker that guesses a sibling unit's
 * module path fixes it on its own retry. Measured on Run 25: three of four
 * debug rounds were guessed import specifiers; `biome check` does not resolve
 * imports and `tests/**` sits outside every tsconfig, so the error surfaced
 * only at the deferred typecheck, where the premium model debugged it.
 *
 * Checks, conservatively (anything it cannot decide passes):
 *   - relative specifiers ("./x", "../x") resolve to a file (TS extension
 *     rules, `.js` → `.ts`, `/index.*`);
 *   - tsconfig `paths` aliases (`@/x`) resolve the same way;
 *   - bare packages are not checked: pnpm installs per package and test runners
 *     resolve from their own config root, so "not installed" is unknowable here;
 *   - for a resolved JS/TS target without `export *`: a default import needs a
 *     default export, a named import needs that name exported.
 * Covers `import … from`, `export … from`, `import("…")`, `require("…")`,
 * `vi.mock` / `jest.mock` / `vi.importActual`.
 *
 * Usage: node check-imports.mjs <file> [--project-root <dir>]
 * Exit 0 ok · 1 unresolved or missing export (one line each on stdout) · 2 usage.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const BUILTINS = new Set(builtinModules);

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** The file a path-like specifier points at, or null. */
export function resolveFile(base) {
  if (isFile(base)) return base;
  // TS ESM style: `./x.js` names `./x.ts`.
  const js = base.match(/^(.*)\.(m|c)?jsx?$/);
  if (js) for (const e of [".ts", ".tsx", ".mts", ".cts"]) if (isFile(js[1] + e)) return js[1] + e;
  for (const e of EXTS) if (isFile(base + e)) return base + e;
  for (const e of EXTS) if (isFile(join(base, "index" + e))) return join(base, "index" + e);
  return null;
}

function readJsonc(p) {
  try {
    const text = readFileSync(p, "utf8")
      .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, s) => s ?? "")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `paths` maps from every tsconfig*.json between the file and the project root, nearest first. */
function aliasMaps(fileDir, root) {
  const maps = [];
  for (let d = fileDir; ; d = dirname(d)) {
    let names = [];
    try { names = readdirSync(d).filter((n) => /^tsconfig.*\.json$/.test(n)); } catch {}
    for (const n of names) {
      const j = readJsonc(join(d, n));
      const paths = j?.compilerOptions?.paths;
      if (paths) maps.push({ base: resolve(d, j.compilerOptions.baseUrl ?? "."), paths });
    }
    if (d === root || dirname(d) === d) break;
  }
  return maps;
}

function matchAlias(spec, maps) {
  for (const { base, paths } of maps) {
    for (const [pattern, targets] of Object.entries(paths)) {
      const star = pattern.indexOf("*");
      let rest = null;
      if (star === -1) { if (spec === pattern) rest = ""; }
      else if (spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) && spec.length >= pattern.length - 1) {
        rest = spec.slice(star, spec.length - (pattern.length - star - 1));
      }
      if (rest === null) continue;
      return targets.map((t) => resolve(base, t.replace("*", rest)));
    }
  }
  return null;
}

const lineOf = (src, i) => src.slice(0, i).split("\n").length;

/** Every module reference in the source, with what it imports. */
export function findImports(src) {
  const out = [];
  const code = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const stmt = /(^|[;\n}])\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"'\n]+)["']/g;
  for (let m; (m = stmt.exec(code)); ) {
    const typeOnly = !!m[3];
    const clause = m[4];
    const at = m.index + m[0].indexOf(m[2]);
    if (/\/\/[^\n]*$/.test(code.slice(code.lastIndexOf("\n", at) + 1, at))) continue;
    const item = { spec: m[5], line: lineOf(code, at), names: [], default: false };
    if (m[2] === "import" && !typeOnly) {
      const def = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(,|$)/);
      if (def) item.default = true;
    }
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces && !/^\s*\*/.test(clause)) {
      for (const part of braces[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) item.names.push(name === "default" ? null : name);
        if (name === "default") item.default = true;
      }
      item.names = item.names.filter(Boolean);
    }
    out.push(item);
  }
  const bare = /(^|[;\n])\s*import\s+["']([^"'\n]+)["']/g;
  for (let m; (m = bare.exec(code)); ) out.push({ spec: m[2], line: lineOf(code, m.index + m[1].length), names: [], default: false });
  const call = /\b(?:import|require|vi\.mock|jest\.mock|vi\.importActual|vi\.doMock|jest\.requireActual)\s*\(\s*["']([^"'\n]+)["']/g;
  for (let m; (m = call.exec(code)); ) out.push({ spec: m[1], line: lineOf(code, m.index), names: [], default: false });
  return out;
}

/** Which of `names` (and default) the target module does not visibly export; null when it cannot tell. */
export function missingExports(targetSrc, item) {
  if (/export\s*\*\s*from/.test(targetSrc) || /module\.exports|export\s*=/.test(targetSrc)) return null;
  const missing = [];
  const listed = new Set();
  for (const m of targetSrc.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const p = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      listed.add((p[1] ?? p[0]).trim());
    }
  }
  if (item.default && !/export\s+default\b/.test(targetSrc) && !listed.has("default")) missing.push("default");
  for (const n of item.names) {
    if (listed.has(n)) continue;
    const decl = new RegExp(`export\\s+(?:declare\\s+)?(?:default\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:function\\*?|const|let|var|class|type|interface|enum|namespace)\\s+${n.replace(/\$/g, "\\$")}\\b`);
    const destructured = new RegExp(`export\\s+(?:const|let|var)\\s+[{\\[][^=]*\\b${n.replace(/\$/g, "\\$")}\\b[^=]*[}\\]]\\s*=`);
    if (!decl.test(targetSrc) && !destructured.test(targetSrc)) missing.push(n);
  }
  return missing;
}

function siblings(dir, root) {
  try {
    return readdirSync(dir).slice(0, 12).map((n) => relative(root, join(dir, n)).replace(/\\/g, "/"));
  } catch {
    return [];
  }
}

export function checkFile(file, root) {
  const abs = resolve(root, file);
  const src = readFileSync(abs, "utf8");
  const dir = dirname(abs);
  const problems = [];
  let maps = null;
  const rel = relative(root, abs).replace(/\\/g, "/");

  for (const item of findImports(src)) {
    const spec = item.spec.replace(/[?#].*$/, "");
    if (!spec || spec.includes(":") || BUILTINS.has(spec)) continue;
    let target = null;
    let tried = null;
    if (spec.startsWith(".") || spec.startsWith("/")) {
      tried = resolve(dir, spec);
      target = resolveFile(tried);
    } else {
      maps ??= aliasMaps(dir, root);
      const candidates = matchAlias(spec, maps);
      if (candidates) {
        tried = candidates[0];
        for (const c of candidates) if ((target = resolveFile(c))) break;
      } else continue;
    }
    if (!target) {
      const near = siblings(dirname(tried), root);
      problems.push(
        `${rel}:${item.line}: cannot resolve "${item.spec}" (looked for ${relative(root, tried).replace(/\\/g, "/")}[.ts|.tsx|/index.ts…])` +
          (near.length ? `; files in that folder: ${near.join(", ")}` : `; that folder does not exist`),
      );
      continue;
    }
    if (!CODE.test(target) || (!item.default && item.names.length === 0)) continue;
    const missing = missingExports(readFileSync(target, "utf8"), item);
    if (missing?.length) {
      problems.push(
        `${rel}:${item.line}: "${item.spec}" (${relative(root, target).replace(/\\/g, "/")}) has no ${missing
          .map((n) => (n === "default" ? "default export" : `export named ${n}`))
          .join(", ")}`,
      );
    }
  }
  return problems;
}

function main(argv) {
  let file = null;
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project-root") root = resolve(argv[++i] ?? ".");
    else if (!file) file = argv[i];
  }
  if (!file) {
    process.stderr.write("usage: check-imports.mjs <file> [--project-root <dir>]\n");
    return 2;
  }
  if (!CODE.test(file)) return 0;
  if (!isFile(resolve(root, file))) {
    process.stdout.write(`${file}: file does not exist\n`);
    return 1;
  }
  const problems = checkFile(file, root);
  for (const p of problems) process.stdout.write(p + "\n");
  return problems.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-imports.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
