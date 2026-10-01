/**
 * check-imports.mjs: the per-packet import check plan-to-packets adds under
 * --multi-model. It must fail a guessed path or a missing export, and pass
 * everything it cannot decide (packages, aliases it cannot map, `export *`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "..", "scripts", "check-imports.mjs");
const { checkFile, findImports, missingExports } = await import(SCRIPT);

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "chkimp-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

const BASE = {
  "apps/web/tsconfig.json": '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] }, }\n}',
  "apps/web/src/hooks/use-profile.ts": "export function useProfile() {}\nexport type Profile = { id: string };\n",
  "apps/web/src/components/error-view.tsx": "export function ErrorView() {}\n",
  "apps/web/src/components/index.ts": 'export * from "./error-view";\n',
  "apps/web/src/lib/reexport.ts": 'export { default } from "./def";\n',
  "apps/web/src/lib/def.ts": "export default 1;\n",
  "apps/api/src/database/index.ts": "export const db = {};\n",
};

test("resolved relative, alias, index, .js→.ts and re-exported imports pass; packages and builtins are not checked", () => {
  const root = repo({
    ...BASE,
    "apps/web/src/routes/ok.tsx": [
      'import { useProfile, type Profile } from "@/hooks/use-profile";',
      'import { ErrorView as EV } from "../components/error-view";',
      'import { Anything } from "../components";',
      'import d from "@/lib/reexport";',
      'import x from "react";',
      'import fs from "node:fs";',
      'import "./styles.css?inline";',
      'export { useProfile } from "../hooks/use-profile.js";',
    ].join("\n"),
    "tests/api/db.test.ts": 'import { db } from "../../apps/api/src/database";\nvi.mock("../../apps/api/src/database");\n',
  });
  assert.deepEqual(checkFile("apps/web/src/routes/ok.tsx", root).filter((p) => !p.includes("styles.css")), []);
  assert.deepEqual(checkFile("tests/api/db.test.ts", root), []);
  rmSync(root, { recursive: true, force: true });
});

test("a guessed path, a wrong vi.mock target, a default import of a named export and a missing name fail with the folder's files", () => {
  const root = repo({
    ...BASE,
    "apps/web/src/routes/bad.tsx": [
      'import { useProfile } from "@/hooks/queries/use-profile";',
      'import ErrorView from "@/components/error-view";',
      'import { useProfil } from "@/hooks/use-profile";',
    ].join("\n"),
    "tests/api/bad.test.ts": 'vi.mock("../../apps/api/src/databse");\n',
  });
  const web = checkFile("apps/web/src/routes/bad.tsx", root);
  assert.equal(web.length, 3);
  assert.match(web[0], /bad\.tsx:1: cannot resolve "@\/hooks\/queries\/use-profile".*that folder does not exist/);
  assert.match(web[1], /:2: .*has no default export/);
  assert.match(web[2], /:3: .*has no export named useProfil/);
  const t = checkFile("tests/api/bad.test.ts", root);
  assert.equal(t.length, 1);
  assert.match(t[0], /files in that folder: .*apps\/api\/src\/database/);
  rmSync(root, { recursive: true, force: true });
});

test("CLI: exit 1 with one line per problem, 0 when clean or not JS/TS, 2 without a file; a $ in the name is fine when quoted", () => {
  const root = repo({ ...BASE, "apps/web/src/routes/p.$id.tsx": 'import { nope } from "@/hooks/use-profile";\n', "a.json": "{}" });
  const run = (args) => spawnSync("node", [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
  const bad = run(["apps/web/src/routes/p.$id.tsx"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /has no export named nope/);
  assert.equal(run(["a.json"]).status, 0);
  assert.equal(run([]).status, 2);
  const sh = spawnSync(`node "${SCRIPT}" 'apps/web/src/routes/p.$id.tsx'`, { cwd: root, shell: true, encoding: "utf8" });
  assert.equal(sh.status, 1, "the single-quoted {path} form plan-to-packets emits reaches the real file");
  rmSync(root, { recursive: true, force: true });
});

test("findImports / missingExports: type-only imports check names only; commented-out imports are skipped; export * is undecidable", () => {
  const found = findImports('// import x from "./gone";\nimport type D from "./t";\nimport def, { a as b } from "./m";\n');
  assert.deepEqual(found.map((f) => [f.spec, f.default, f.names]), [["./t", false, []], ["./m", true, ["a"]]]);
  assert.equal(missingExports('export * from "./x";', { default: true, names: ["q"] }), null);
  assert.deepEqual(missingExports("export const { a, b } = obj;\nexport default 1;", { default: true, names: ["a", "c"] }), ["c"]);
});
