/**
 * Greenfield or brownfield, decided from the folder, never from the prompt:
 * a chat that starts with no source file of its own is building something new.
 * Dependencies, build output and docs do not count as the project's code.
 * The walk stops at the first source file and after a bounded number of
 * entries, so a huge repository costs the prompt hook almost nothing.
 */
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * The extensions that count as a project's own source. Markdown is not source here.
 */
const SOURCE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".go", ".java", ".kt", ".kts", ".cs", ".rb", ".rs", ".php",
  ".c", ".h", ".cc", ".cpp", ".hpp",
]);

const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "target", ".venv", "venv", "vendor", "coverage", ".next", ".cache", ".sdlc", ".claude"]);
const MAX_ENTRIES = 4000;

export function repoKind(dir) {
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) return "brownfield"; // too big to be empty
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith(".")) stack.push(join(cur, e.name)); continue; }
      if (e.isFile() && SOURCE_EXTENSIONS.has(extname(e.name).toLowerCase())) return "brownfield";
    }
  }
  return "greenfield";
}
