/**
 * plan-to-packets.mjs: a linted change_plan.md becomes packets.json with no
 * model call. Fixture plan below mirrors the shape the architect contract
 * (architect.md "Per-unit sections") produces on real runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { parsePlan, parseRef, parseAnchors, editSites, splitVerify, placeholderPath, formatCommands, crlfAware, classify, moduleOf, buildPackets, main } = await import(
  join(HERE, "..", "..", "..", "scripts", "plan-to-packets.mjs")
);

const PLAN = `# Change plan

## Confirmed repo facts
- \`apps/api/src/index.ts:59\` imports getAvatar.

## House style
- Biome, 2-space, double quotes, width 80.

## A1 — apps/api/src/user/controllers/get-public-profile.ts

- **File** \`apps/api/src/user/controllers/get-public-profile.ts\` · **Action** \`new_file\` · **Depends on** —
- **Exports** \`export async function getPublicProfile(id: string): Promise<P | null>\`
- **Behavior**
  1. select id, name, image only.
- **Mirror** \`apps/api/src/user/controllers/get-avatar.ts:1-21\`; hoisted \`vi.mock\` style.
- **Verify** \`pnpm exec biome check {path}\`
- **Acceptance**
  - projection is exactly id,name,image
  - null for unknown

## A2 — apps/api/src/index.ts

- **File** \`apps/api/src/index.ts\` · **Action** \`edit\` · **Depends on** A1
- **Behavior**
  1. Add the import after line 3.
  2. Mount the route.
- **Mirror** \`apps/api/src/index.ts:8-9\`
- **Edit anchor**
  - after \`:3\` \`import getAvatar from "./user/controllers/get-avatar";\` → rule 1;
  - after \`:9\` \`  });\` → rule 2; ordering constraint: above \`:12\` \`api.use("*", async (c, next) => {\`.
- **Verify** \`pnpm exec biome check apps/api/src/index.ts\` · \`pnpm --filter @kaneo/api typecheck\`
- **Acceptance** — diff touches exactly the anchor sites.

## A3 — tests/api/user/get-public-profile.test.ts

- **File** \`tests/api/user/get-public-profile.test.ts\` · **Action** \`new_file\` · **Depends on** A1
- **Behavior**
  1. three cases.
- **Mirror** \`tests/api/user/avatar.test.ts\`
- **Verify** \`pnpm exec vitest run {path}\`
- **Acceptance** — three cases green.

## A4 — apps/web/src/routeTree.gen.ts

- **File** \`apps/web/src/routeTree.gen.ts\` · **Action** \`tooling\` · **Depends on** A3
- **Behavior** regenerate via \`pnpm --filter @kaneo/web exec vite build\`.

## A5 — i18n/en-US.json

- **File** \`i18n/en-US.json\` · **Action** \`edit\` · **Depends on** —
- **Behavior** add the publicProfile block.
- **Edit anchor** replace the closing brace of \`publicProject\` (\`:2147\`) and insert before the root \`}\` (\`:2148\`).
- **Verify** \`pnpm exec biome check i18n/en-US.json\`
- **Acceptance** JSON parses.
`;

function repo() {
  const root = mkdtempSync(join(tmpdir(), "mmo-p2p-"));
  mkdirSync(join(root, "apps", "api", "src", "user", "controllers"), { recursive: true });
  mkdirSync(join(root, "tests", "api", "user"), { recursive: true });
  mkdirSync(join(root, "i18n"), { recursive: true });
  mkdirSync(join(root, ".sdlc", "runs", "r1"), { recursive: true });
  writeFileSync(join(root, "apps", "api", "src", "user", "controllers", "get-avatar.ts"), Array.from({ length: 21 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  writeFileSync(
    join(root, "apps", "api", "src", "index.ts"),
    ["import a from \"a\";", "import b from \"b\";", "import getAvatar from \"./user/controllers/get-avatar\";", "", "const api = x();", "", "const publicProjectApi = api.get(\"/p\", async (c) => {", "  return c.json({});", "  });", "", "", "api.use(\"*\", async (c, next) => {", "});", ""].join("\n"),
  );
  writeFileSync(join(root, "tests", "api", "user", "avatar.test.ts"), "import x from 'y';\n");
  writeFileSync(join(root, "i18n", "en-US.json"), "{\n\t\"publicProject\": {\n\t}\n}\n");
  writeFileSync(join(root, ".sdlc", "runs", "r1", "change_plan.md"), PLAN);
  return root;
}

test("parsePlan finds every unit section and the House style section", () => {
  const plan = parsePlan(PLAN);
  assert.deepEqual(plan.units.map((u) => [u.id, u.path]), [
    ["A1", "apps/api/src/user/controllers/get-public-profile.ts"],
    ["A2", "apps/api/src/index.ts"],
    ["A3", "tests/api/user/get-public-profile.test.ts"],
    ["A4", "apps/web/src/routeTree.gen.ts"],
    ["A5", "i18n/en-US.json"],
  ]);
  assert.equal(plan.houseStyle, true);
  assert.equal(plan.units[0].heading, "A1 — apps/api/src/user/controllers/get-public-profile.ts");
});

test("parseRef reads path:lines forms and rejects identifiers and globs", () => {
  assert.deepEqual(parseRef("apps/api/src/index.ts:243-248,406"), { path: "apps/api/src/index.ts", ranges: [[243, 248], [406, 406]] });
  assert.deepEqual(parseRef("apps/web/public/favicon.svg"), { path: "apps/web/public/favicon.svg", ranges: [] });
  assert.deepEqual(parseRef("avatar.ts:1"), { path: "avatar.ts", ranges: [[1, 1]] });
  assert.equal(parseRef("vi.mock"), null);
  assert.equal(parseRef("useTranslation"), null);
  assert.equal(parseRef("tests/api/**"), null);
  assert.equal(parseRef("../../../apps/api/src/database"), null, "an import specifier is not a mirror");
  assert.equal(parseRef("./avatar.ts"), null);
  assert.equal(parseRef("@/components/public-project/error-view.tsx"), null);
  assert.equal(parseRef("@kaneo/libs"), null);
});

test("parseAnchors takes :line text pairs and prose :line references, deduplicated and sorted", () => {
  const b = { head: "", rest: ["  - after `:9` `  });` → rule 2; above `:12` `api.use(`.", "  - after `:3` `import x;`"] };
  assert.deepEqual(parseAnchors(b), [
    { line: 3, anchor: "import x;" },
    { line: 9, anchor: "  });" },
  ], "the `above :12` reference is an ordering constraint, not a site");
  assert.deepEqual(parseAnchors({ head: "replace the brace (`:2147`) and insert before (`:2148`).", rest: [] }), [
    { line: 2147, anchor: null },
    { line: 2148, anchor: null },
  ]);
  assert.deepEqual(parseAnchors(null), []);
  assert.deepEqual(parseAnchors({ head: "", rest: ["  - after `:248` `  });` → rule 2; ordering constraint: stays above `:250` `api.post(\"/x\", …)`."] }),
    [{ line: 248, anchor: "  });" }], "an ordering-constraint reference is not an edit site");
  assert.deepEqual(parseAnchors({ head: "", rest: ["  - after L59 `import x;` (must stay above L574 `api.use(`)"] }),
    [{ line: 59, anchor: "import x;" }]);
});

test("classify and moduleOf follow the path", () => {
  assert.deepEqual(classify("apps/api/src/user/controllers/get-public-profile.ts", "new_file"), { phase: "codegen", task_type: "controller_handler" });
  assert.deepEqual(classify("apps/api/src/index.ts", "edit"), { phase: "codegen", task_type: "module_wiring" });
  assert.deepEqual(classify("apps/api/src/schemas.ts", "edit"), { phase: "codegen", task_type: "dto" });
  assert.deepEqual(classify("tests/api/user/x.test.ts", "new_file"), { phase: "tests", task_type: "test_unit" });
  assert.deepEqual(classify("tests/api-integration/x.test.ts", "new_file"), { phase: "tests", task_type: "test_integration" });
  assert.deepEqual(classify("apps/web/src/routes/public-profile.$userId.test.tsx", "new_file"), { phase: "tests", task_type: "test_unit" });
  assert.deepEqual(classify("apps/web/src/routes/public-profile.$userId.tsx", "new_file"), { phase: "codegen", task_type: "react_page" });
  assert.deepEqual(classify("apps/web/src/components/x/card.tsx", "new_file"), { phase: "codegen", task_type: "react_component" });
  assert.deepEqual(classify("apps/web/src/fetchers/user/get.ts", "new_file"), { phase: "codegen", task_type: "api_client" });
  assert.deepEqual(classify("apps/web/src/hooks/queries/user/use.ts", "new_file"), { phase: "codegen", task_type: "frontend_util" });
  assert.deepEqual(classify("apps/web/public/default-avatar.svg", "new_file"), { phase: "codegen", task_type: "frontend_html" });
  assert.deepEqual(classify("i18n/en-US.json", "edit"), { phase: "codegen", task_type: "frontend_config" });
  assert.deepEqual(classify("apps/web/src/routeTree.gen.ts", "tooling"), { phase: "codegen", task_type: "tooling" });
  assert.equal(moduleOf("apps/api/src/user/controllers/x.ts"), "api-user");
  assert.equal(moduleOf("apps/web/src/routes/x.tsx"), "web-routes");
  assert.equal(moduleOf("tests/api/user/x.test.ts"), "api-user");
  assert.equal(moduleOf("i18n/en-US.json"), "i18n-en-US.json");
});

test("buildPackets: one packet per unit, apply form, edit lists with anchor context, deps resolved, repo-checked", () => {
  const root = repo();
  const plan = parsePlan(PLAN);
  const { packets, errors, warnings } = buildPackets(plan, { runId: "r1", intent: "feature-extend", planPath: ".sdlc/runs/r1/change_plan.md", projectRoot: root });
  assert.deepEqual(errors, []);
  assert.deepEqual(packets.map((p) => p.id), ["tp_codegen_001", "tp_codegen_002", "tp_tests_001", "tooling_001", "tp_codegen_003"]);

  const a1 = packets[0];
  assert.equal(a1.artifact_path, "apps/api/src/user/controllers/get-public-profile.ts");
  assert.equal(a1.task_type, "controller_handler");
  assert.equal(a1.subtype, "new_file_add");
  assert.equal(a1.pass_id, "r1");
  assert.equal(a1.intent, "feature-extend");
  assert.deepEqual(a1.inputs, [
    { path: ".sdlc/runs/r1/change_plan.md", section: "A1 — apps/api/src/user/controllers/get-public-profile.ts", reason: "unit spec (stable run record)" },
    { path: ".sdlc/runs/r1/change_plan.md", section: "House style", reason: "house style (stable run record)" },
    { path: "apps/api/src/user/controllers/get-avatar.ts", lines: [1, 21], reason: "mirror" },
  ]);
  assert.deepEqual(a1.apply, { write: true, mode: "content", format: ["pnpm exec biome check --write {path}"], verify: ["pnpm exec biome check {path}"], max_retries: 2 });
  assert.deepEqual(a1.acceptance, ["projection is exactly id,name,image", "null for unknown"]);
  assert.match(a1.instruction, /Implement `apps\/api\/src\/user\/controllers\/get-public-profile.ts` from change_plan section `A1`/);
  assert.equal(a1.outputSchema, undefined, "the server supplies the schema under apply");
  assert.deepEqual(a1.depends_on, []);

  const a2 = packets[1];
  assert.equal(a2.apply.mode, "edits");
  assert.equal(a2.subtype, "existing_file_edit");
  assert.equal(a2.task_type, "module_wiring");
  assert.match(a2.instruction, /Return JSON \{edits:/);
  assert.deepEqual(a2.depends_on, ["tp_codegen_001"]);
  assert.deepEqual(a2.inputs.filter((i) => i.reason === "edit anchor context").map((i) => i.lines), [[1, 13]], "anchors at 3 and 9 merge into one window");
  assert.deepEqual(a2.apply.verify, ["pnpm exec biome check apps/api/src/index.ts"], "only the file-scoped command runs in the loop");
  assert.deepEqual(a2.verify_deferred, ["pnpm --filter @kaneo/api typecheck"], "the package-wide command is deferred to the end of the phase");
  assert.equal(a2.budget.maxOutputTokens, 8000);

  const a3 = packets[2];
  assert.equal(a3.phase, "tests");
  assert.equal(a3.subtype, "test_add");
  assert.ok(a3.inputs.some((i) => i.path === "tests/api/user/avatar.test.ts" && i.lines === undefined), "a bare mirror path is the whole file");

  const a4 = packets[3];
  assert.equal(a4.task_type, "tooling");
  assert.deepEqual(a4.budget, { maxInputTokens: 0, maxOutputTokens: 0 });
  assert.match(a4.instruction, /Orchestrator shell step, no model \(change_plan A4\): regenerate via/);
  assert.deepEqual(a4.depends_on, ["tp_tests_001"]);

  const a5 = packets[4];
  assert.equal(a5.task_type, "frontend_config");
  assert.equal(a5.apply.mode, "edits", "prose :line references are enough for edits mode");
  assert.ok(warnings.some((w) => /A5: anchor :2147 is past the end/.test(w)), warnings.join("\n"));
  assert.ok(warnings.some((w) => /A1: mirror .* vi\.mock/.test(w)) === false, "identifiers in a Mirror bullet are not treated as paths");
  rmSync(root, { recursive: true, force: true });
});

test("buildPackets: errors for an unknown Action and an edit to a missing file; a missing File bullet and an unusable mirror are only warnings", () => {
  const root = repo();
  const bad = `## House style\n- x\n\n## A1 — a.ts\n\n- **Behavior** nothing\n\n## A2 — b.ts\n\n- **File** \`b.ts\` · **Action** \`rewrite\`\n\n## A3 — c.ts\n\n- **File** \`c.ts\` · **Action** \`edit\`\n- **Edit anchor** after \`:1\` \`x\`\n\n## A4 — d.ts\n\n- **File** \`d.ts\` · **Action** \`new_file\`\n- **Mirror** \`apps/x/../../../etc/passwd:1-2\` (mocks \`../../../apps/api/src/database\`)\n- **Verify** \`true\`\n`;
  const { packets, errors, warnings } = buildPackets(parsePlan(bad), { runId: "r", planPath: "p.md", projectRoot: root });
  assert.deepEqual(packets.map((p) => p.artifact_path), ["a.ts", "d.ts"], "A1 takes its path from the heading; A4 keeps its packet, only its mirror is dropped");
  assert.match(errors[0], /A2: unknown Action `rewrite`/);
  assert.match(errors[1], /A3: edit target c.ts does not exist/);
  assert.equal(errors.length, 2);
  assert.ok(warnings.some((w) => /A1: no `- \*\*File\*\*` bullet; path taken from the heading/.test(w)), warnings.join("\n"));
  assert.ok(warnings.some((w) => /A1: no Action; inferred `new_file`/.test(w)), warnings.join("\n"));
  assert.ok(warnings.some((w) => /A4: mirror .*etc\/passwd is outside the project; dropped/.test(w)), warnings.join("\n"));
  assert.ok(!warnings.some((w) => /apps\/api\/src\/database/.test(w)), "the vi.mock specifier is not read as a mirror at all");
  rmSync(root, { recursive: true, force: true });
});

test("buildPackets: common Action synonyms map to the canonical word with a warning (Run 31)", () => {
  const root = repo();
  const plan = `## House style\n- x\n\n## A1 — a.ts\n\n- **File** \`a.ts\` · **Action** \`create\` · **Depends on** —\n- **Verify** \`true\`\n`;
  const { packets, errors, warnings } = buildPackets(parsePlan(plan), { runId: "r", planPath: "p.md", projectRoot: root });
  assert.deepEqual(errors, []);
  assert.deepEqual(packets.map((p) => p.artifact_path), ["a.ts"]);
  assert.ok(warnings.some((w) => /A1: Action `create` read as `new_file`/.test(w)), warnings.join("\n"));
  rmSync(root, { recursive: true, force: true });
});

test("buildPackets: File / Action / Depends on as separate bullets, B-prefixed ids, and a path only in the heading all derive packets (Runs 19-21)", () => {
  const root = repo();
  const plan = `## House style\n- x\n\n## B1 — apps/api/src/user/new.ts\n\n- **File** \`apps/api/src/user/new.ts\`\n- **Action** \`new_file\`\n- **Depends on** —\n- **Verify** \`pnpm exec biome check {path}\`\n\n## B2 — apps/api/src/index.ts\n\n- **Depends on** B1\n- **Edit anchor** after \`:3\` \`x\`\n- **Verify** \`pnpm exec biome check {path}\`\n`;
  const { packets, errors, warnings } = buildPackets(parsePlan(plan), { runId: "r", planPath: "p.md", projectRoot: root });
  assert.deepEqual(errors, []);
  assert.deepEqual(packets.map((p) => [p.unit, p.artifact_path, p.subtype]), [
    ["B1", "apps/api/src/user/new.ts", "new_file_add"],
    ["B2", "apps/api/src/index.ts", "existing_file_edit"],
  ]);
  assert.deepEqual(packets[1].depends_on, [packets[0].id]);
  assert.ok(warnings.some((w) => /B2: no Action; inferred `edit`/.test(w)), warnings.join("\n"));
  rmSync(root, { recursive: true, force: true });
});

test("buildPackets: a unit outside the active write contract's allowlist gets no packet and its dependents drop the edge", () => {
  const root = repo();
  mkdirSync(join(root, ".sdlc", "local"), { recursive: true });
  writeFileSync(join(root, ".sdlc", "local", "write-contract.json"), JSON.stringify({ active: true, strict: true, run_id: "r", allowlist: ["apps/api/src/user/**"] }));
  const plan = `## A1 — i18n/schema.json\n\n- **File** \`i18n/schema.json\` · **Action** \`tooling\` · **Depends on** —\n- **Behavior** regenerate\n\n## A2 — apps/api/src/user/new.ts\n\n- **File** \`apps/api/src/user/new.ts\` · **Action** \`new_file\` · **Depends on** A1\n- **Verify** \`pnpm exec biome check {path}\`\n`;
  const { packets, errors, warnings } = buildPackets(parsePlan(plan), { runId: "r", planPath: "p.md", projectRoot: root });
  assert.deepEqual(errors, []);
  assert.deepEqual(packets.map((p) => p.artifact_path), ["apps/api/src/user/new.ts"]);
  assert.deepEqual(packets[0].depends_on, []);
  assert.ok(warnings.some((w) => /A1: i18n\/schema.json is outside the write contract allowlist/.test(w)), warnings.join("\n"));
  const other = buildPackets(parsePlan(plan), { runId: "another-run", planPath: "p.md", projectRoot: root });
  assert.equal(other.packets.length, 2, "a contract for another run does not apply");
  rmSync(root, { recursive: true, force: true });
});

test("buildPackets: L59 / line 59 anchor forms parse; prose in a Verify bullet is not a command; > 5 anchors split into chained chunk packets", () => {
  const root = repo();
  const plan = `## House style\n- x\n\n## A1 — apps/api/src/index.ts\n\n- **File** \`apps/api/src/index.ts\` · **Action** \`edit\` · **Depends on** —\n- **Edit anchor**\n  - after L1 \`import a from "a";\`; after line 2; after \`:3\` \`x\`; before \`L5\` \`y\`; replace \`:7\`; after \`:9\`; before \`:12\`\n- **Verify** starts with \`<svg\` and \`pnpm exec biome check apps/api/src/index.ts\` then \`pnpm --filter @kaneo/api typecheck\` (\`11\` cases)\n`;
  const { packets, errors, warnings } = buildPackets(parsePlan(plan), { runId: "r", planPath: "p.md", projectRoot: root });
  assert.deepEqual(errors, []);
  assert.deepEqual(packets.map((p) => p.id), ["tp_codegen_001-a", "tp_codegen_001-b"]);
  assert.deepEqual(packets[1].depends_on, ["tp_codegen_001-a"], "chunk b waits for chunk a");
  assert.match(packets[0].instruction, /Apply ONLY these Edit anchors.*:9; :12\./, "the chunk nearest the end of the file goes first");
  assert.match(packets[1].instruction, /:1 "import a from \\"a\\";".*:5 "y"/);
  assert.deepEqual(packets[0].apply.verify, ["pnpm exec biome check apps/api/src/index.ts"]);
  assert.deepEqual(packets[1].verify_deferred, ["pnpm --filter @kaneo/api typecheck"]);
  assert.equal(packets[0].verify_deferred, undefined, "deferred commands ride on the last chunk only");
  assert.ok(warnings.some((w) => /7 anchors split into 2 packets/.test(w)));
  rmSync(root, { recursive: true, force: true });
});

test("buildPackets: an edit with no :line references falls back to whole-file mode with a warning; a Packet bullet overrides routing", () => {
  const root = repo();
  const plan = `## A1 — apps/api/src/index.ts\n\n- **File** \`apps/api/src/index.ts\` · **Action** \`edit\`\n- **Edit anchor** after the last import.\n- **Packet** task_type=service_method, module=custom\n- **Verify** \`true\`\n`;
  const { packets, errors, warnings } = buildPackets(parsePlan(plan), { runId: "r", planPath: "p.md", projectRoot: root });
  assert.deepEqual(errors, []);
  assert.equal(packets[0].apply.mode, "content");
  assert.ok(packets[0].inputs.some((i) => i.reason === "existing file (whole)"));
  assert.equal(packets[0].task_type, "service_method");
  assert.equal(packets[0].module, "custom");
  assert.ok(warnings.some((w) => /whole-file mode/.test(w)));
  assert.ok(warnings.some((w) => /no `## House style`/.test(w)));
  rmSync(root, { recursive: true, force: true });
});

test("main writes packets.json beside the plan by default and returns 0; usage errors return 2", () => {
  const root = repo();
  const planFile = join(root, ".sdlc", "runs", "r1", "change_plan.md");
  const stdout = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { stdout.push(String(s)); return true; };
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    assert.equal(main([planFile, "--run-id", "r1", "--project-root", root, "--json"]), 0);
    assert.equal(main(["--run-id", "r1"]), 2);
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErr;
  }
  const out = JSON.parse(readFileSync(join(root, ".sdlc", "runs", "r1", "packets.json"), "utf8"));
  assert.equal(out.length, 5);
  assert.equal(out[0].inputs[0].path, ".sdlc/runs/r1/change_plan.md", "plan path is repo-relative when project root is given");
  const summary = JSON.parse(stdout[0]);
  assert.equal(summary.packets, 5);
  assert.equal(summary.edits, 2);
  rmSync(root, { recursive: true, force: true });
});

// Run 23: the architect wrote `### Edits` + `- **L939** \`text\`` items; no anchors were found and every edit
// unit fell back to a whole-file packet with exit 0.
test("editSites reads a `### Edits` sub-heading with **L<n>** items as the Edit anchor bullet", () => {
  const body = [
    "- **File** `apps/api/src/index.ts` · **Action** `edit` · **Depends on** A4",
    "",
    "### Edits",
    "",
    "- **L939** `export type AppType =` → insert a new line **after** it: `  | typeof x`",
    "- **L59** `import getAvatar from \"./user/controllers/get-avatar\";` → insert after it:",
    "  `import p from \"./user/public-profile\";` (Biome puts it before `./utils/a` on `:60`.)",
    "",
    "- **Acceptance**",
    "  - mentions `:574` but is not a site",
  ];
  assert.deepEqual(parseAnchors(editSites(body)), [
    { line: 59, anchor: 'import getAvatar from "./user/controllers/get-avatar";' },
    { line: 939, anchor: "export type AppType =" },
  ]);
  assert.equal(editSites(["- **Behavior** none"]), null);
});

test("parseAnchors ignores line references on wrapped continuation lines (prose, not sites)", () => {
  const b = { head: "", rest: [
    "  - before `:250` `  api.post(\"/w\", h);` → insert the mount block.",
    "    This lands it after the `publicProjectApi` block (`:243-248`) and above",
    "    the catch-all `api.use(\"*\", …)` at `:574`, which is what makes it public.",
  ] };
  assert.deepEqual(parseAnchors(b), [{ line: 250, anchor: '  api.post("/w", h);' }]);
});

test("buildPackets --multi-model: an edit unit with no sites is an error; without it, a whole-file warning", () => {
  const root = repo();
  const plan = parsePlan("## House style\n- x\n\n## A1 — apps/api/src/index.ts\n\n- **File** `apps/api/src/index.ts` · **Action** `edit` · **Depends on** —\n- **Edit anchor** after the last import.\n- **Verify** `pnpm exec biome check apps/api/src/index.ts`\n");
  const multi = buildPackets(plan, { runId: "r1", planPath: "p.md", projectRoot: root, multiModel: true });
  assert.equal(multi.packets.length, 0);
  assert.match(multi.errors[0], /A1: edit of apps\/api\/src\/index.ts has no edit sites/);
  const single = buildPackets(plan, { runId: "r1", planPath: "p.md", projectRoot: root });
  assert.deepEqual(single.errors, []);
  assert.equal(single.packets[0].apply.mode, "content");
  rmSync(root, { recursive: true, force: true });
});

test("splitVerify keeps a shell-escaped or quoted path file-scoped", () => {
  const path = "apps/web/src/routes/public-profile.$userId.tsx";
  const { scoped, deferred } = splitVerify([
    "pnpm exec biome check apps/web/src/routes/public-profile.\\$userId.tsx",
    "pnpm exec biome check 'apps/web/src/routes/public-profile.$userId.tsx'",
    "pnpm --filter @kaneo/web typecheck",
  ], path);
  assert.equal(scoped.length, 2);
  assert.deepEqual(deferred, ["pnpm --filter @kaneo/web typecheck"]);
});

test("placeholderPath rewrites the file's path to '{path}' in every quoting form, so the shell cannot expand $segments", () => {
  const path = "apps/web/src/routes/workspace/$workspaceId/workload.tsx";
  const out = placeholderPath([
    `pnpm exec biome check "${path}"`,
    `pnpm exec biome check '${path}'`,
    `pnpm exec biome check ${path}`,
    "pnpm exec biome check apps/web/src/routes/workspace/\\$workspaceId/workload.tsx",
    "pnpm exec biome check '{path}'",
    "pnpm exec biome check apps/web/src/routes/workspace/$workspaceId/workload.tsx.bak",
  ], path);
  assert.deepEqual(out.slice(0, 5), Array(5).fill("pnpm exec biome check '{path}'"));
  assert.equal(out[5], "pnpm exec biome check apps/web/src/routes/workspace/$workspaceId/workload.tsx.bak");
  assert.deepEqual(formatCommands([out[0]]), ["pnpm exec biome check --write '{path}'"]);
});

test("buildPackets: a double-quoted $-segment path in a Verify bullet reaches the packet as '{path}'", () => {
  const plan = PLAN + `
## A9 — apps/web/src/routes/$wid/page.tsx

- **File** \`apps/web/src/routes/$wid/page.tsx\` · **Action** \`new_file\` · **Depends on** —
- **Behavior**
  - A route page.
- **Verify** \`pnpm exec biome check "apps/web/src/routes/$wid/page.tsx"\`
`;
  const { packets } = buildPackets(parsePlan(plan), { runId: "r1", intent: "feature-extend", planPath: ".sdlc/runs/r1/change_plan.md" });
  const page = packets.find((p) => p.artifact_path === "apps/web/src/routes/$wid/page.tsx");
  assert.deepEqual(page.apply.verify, ["pnpm exec biome check '{path}'"]);
  assert.deepEqual(page.apply.format, ["pnpm exec biome check --write '{path}'"]);
});

test("formatCommands derives the write form of biome / prettier checks and nothing else", () => {
  assert.deepEqual(formatCommands([
    "pnpm exec biome check {path}",
    "pnpm exec biome format apps/x.ts",
    "npx prettier --check apps/y.ts",
    "pnpm exec biome check --write apps/z.ts",
    "pnpm --filter @kaneo/api exec vitest run tests/a.test.ts",
  ]), [
    "pnpm exec biome check --write {path}",
    "pnpm exec biome format --write apps/x.ts",
    "npx prettier --write apps/y.ts",
  ]);
});

// Run 24: the architect wrote `- **Edit**` with `` `after :280 -> rule` `` items (position word and line in
// one backtick span). No sites were read, so 5 edit units fell back to whole-file packets with a warning.
test("editSites reads a `- **Edit**` bullet and parseAnchors reads `after :N -> rule` spans", () => {
  const body = [
    "- **File** `apps/api/src/index.ts` · **Action** `edit` · **Depends on** A1",
    "- **Edit**",
    "  - `after :50 -> import { publicProfileSchema } from \"./schemas\";`",
    "  - `after :248 -> declare const publicProfileApi, directly below the publicProjectApi block`",
    "  - `replace :16 -> title ?? t(\"publicProject:error.title\")`",
    "  - `after :2110 -> insert the namespace above the publicProject key (see :2111)`",
    "- **Verify** `pnpm exec biome check apps/api/src/index.ts`",
  ];
  assert.deepEqual(parseAnchors(editSites(body)).map((a) => a.line), [16, 50, 248, 2110]);
  assert.equal(editSites(["- **Editor** x"]), null, "only an Edit / Edits / Edit anchor bullet counts");
});

test("buildPackets: every slice of the plan is marked stable, so the Anthropic adapter caches it in the system block", async () => {
  const { isStableInput } = await import(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "adapters", "BuiltinAnthropicAdapter.js"));
  for (const reason of ["unit spec (stable run record)", "house style (stable run record)", "dependency spec, its path and Exports (stable run record)"]) {
    assert.equal(isStableInput({ path: ".sdlc/runs/r1/change_plan.md", reason }), true, reason);
  }
  assert.equal(isStableInput({ path: ".sdlc/runs/r1/change_plan.md", reason: "unit spec" }), false, "the file's name alone makes nothing stable");
});

test("buildPackets: a worker packet carries the sections of the units it depends on; --multi-model puts check-imports first in a JS/TS verify", () => {
  const root = repo();
  const plan = parsePlan(PLAN);
  const single = buildPackets(plan, { runId: "r1", planPath: "p.md", projectRoot: root });
  const a3 = single.packets.find((p) => p.unit === "A3");
  assert.deepEqual(a3.inputs.filter((i) => i.reason.startsWith("dependency")), [
    { path: "p.md", section: "A1 — apps/api/src/user/controllers/get-public-profile.ts", reason: "dependency spec, its path and Exports (stable run record)" },
  ]);
  assert.ok(!single.packets.some((p) => p.apply?.verify.some((c) => c.includes("check-imports"))), "single-model packets are unchanged");

  const multi = buildPackets(plan, { runId: "r1", planPath: "p.md", projectRoot: root, multiModel: true });
  for (const p of multi.packets.filter((x) => x.apply)) {
    const js = /\.(ts|tsx|js|mjs)$/.test(p.artifact_path);
    assert.equal(/check-imports\.mjs" '\{path\}'$/.test(p.apply.verify[0] ?? ""), js, `${p.id}: check-imports first only for JS/TS`);
  }
  rmSync(root, { recursive: true, force: true });
});

test("buildPackets --multi-model: chunked edit packets keep check-imports on every chunk", () => {
  const root = repo();
  const sites = [1, 2, 3, 4, 5, 6, 7].map((n) => `  - after \`:${n}\``).join("\n");
  const plan = parsePlan(`## House style\n- x\n\n## A1 — apps/api/src/index.ts\n\n- **File** \`apps/api/src/index.ts\` · **Action** \`edit\` · **Depends on** —\n- **Edit anchor**\n${sites}\n- **Verify** \`pnpm exec biome check apps/api/src/index.ts\` · \`pnpm exec vitest run apps/api/src/index.ts\`\n`);
  const { packets } = buildPackets(plan, { runId: "r1", planPath: "p.md", projectRoot: root, multiModel: true });
  assert.equal(packets.length, 2);
  for (const p of packets) assert.match(p.apply.verify[0], /check-imports\.mjs/);
  assert.ok(!packets[0].apply.verify.some((c) => c.includes("vitest")), "tests still run on the last chunk only");
  rmSync(root, { recursive: true, force: true });
});

test("buildPackets: a File bullet soft-wrapped before **Depends on** keeps its dependencies; a unit with none anywhere warns (Run 27b)", () => {
  const root = repo();
  const plan = `## House style\n- x\n\n## A1 — apps/api/src/user/new.ts\n\n- **File** \`apps/api/src/user/new.ts\` · **Action** \`new_file\` · **Depends on** none\n- **Verify** \`pnpm exec biome check {path}\`\n\n## A2 — apps/api/src/user/other.ts\n\n- **File** \`apps/api/src/user/other.ts\` · **Action** \`new_file\` ·\n  **Depends on** A1\n- **Imports**\n  - \`import { x } from "./new";\` (A3 is not a dependency)\n- **Verify** \`pnpm exec biome check {path}\`\n\n## A3 — apps/api/src/user/third.ts\n\n- **File** \`apps/api/src/user/third.ts\` · **Action** \`new_file\`\n- **Verify** \`pnpm exec biome check {path}\`\n`;
  const { packets, errors, warnings } = buildPackets(parsePlan(plan), { runId: "r", planPath: "p.md", projectRoot: root });
  assert.deepEqual(errors, []);
  assert.deepEqual(packets[1].depends_on, [packets[0].id]);
  assert.deepEqual(packets[2].depends_on, []);
  assert.ok(warnings.some((w) => /A3: no `\*\*Depends on\*\*` found/.test(w)), warnings.join("\n"));
  assert.ok(!warnings.some((w) => /A[12]: no `\*\*Depends on/.test(w)), warnings.join("\n"));
  rmSync(root, { recursive: true, force: true });
});

test("crlfAware adds --line-ending=crlf to biome check/format only; buildPackets applies it to CRLF edit targets (Large-A / Large2-A)", () => {
  assert.deepEqual(crlfAware(["pnpm exec biome check a.ts", "pnpm exec biome format a.ts", "pnpm exec biome check --line-ending=lf a.ts", "pnpm --filter x exec vitest run a.test.ts"]), [
    "pnpm exec biome check --line-ending=crlf a.ts",
    "pnpm exec biome format --line-ending=crlf a.ts",
    "pnpm exec biome check --line-ending=lf a.ts",
    "pnpm --filter x exec vitest run a.test.ts",
  ]);
  assert.deepEqual(formatCommands(crlfAware(["pnpm exec biome check a.ts"])), ["pnpm exec biome check --write --line-ending=crlf a.ts"]);

  const root = repo();
  const idx = join(root, "apps/api/src/index.ts");
  const lf = parsePlan(PLAN);
  const before = buildPackets(lf, { runId: "r1", intent: "feature-extend", planPath: ".sdlc/runs/r1/change_plan.md", projectRoot: root });
  assert.deepEqual(before.packets[1].apply.verify, ["pnpm exec biome check apps/api/src/index.ts"], "an LF file keeps the plain command");
  writeFileSync(idx, readFileSync(idx, "utf8").replace(/\r?\n/g, "\r\n"));
  const { packets, warnings } = buildPackets(parsePlan(PLAN), { runId: "r1", intent: "feature-extend", planPath: ".sdlc/runs/r1/change_plan.md", projectRoot: root });
  assert.deepEqual(packets[1].apply.verify, ["pnpm exec biome check --line-ending=crlf apps/api/src/index.ts"]);
  assert.deepEqual(packets[1].apply.format, ["pnpm exec biome check --write --line-ending=crlf apps/api/src/index.ts"]);
  assert.deepEqual(packets[0].apply.verify, ["pnpm exec biome check {path}"], "a new file is untouched");
  assert.ok(!warnings.some((w) => /CRLF/.test(w)), "not a warning: nothing for the orchestrator to touch");
  rmSync(root, { recursive: true, force: true });
});

test("biome checks are dropped for files biome does not process (.mdx / .md / .yaml), with no warning (Large2-C)", async () => {
  const { dropUnsupportedBiome } = await import(join(HERE, "..", "..", "..", "scripts", "plan-to-packets.mjs"));
  const cmds = ["pnpm exec biome check docs/a.mdx", "node -e \"1\""];
  assert.deepEqual(dropUnsupportedBiome(cmds, "docs/a.mdx"), ['node -e "1"']);
  assert.deepEqual(dropUnsupportedBiome(["pnpm exec biome check x.yml"], "x.yml"), []);
  assert.deepEqual(dropUnsupportedBiome(["pnpm exec biome check a.ts"], "a.ts"), ["pnpm exec biome check a.ts"], "code files keep the check");
  const plan = PLAN + `
## A9 — apps/docs/core/workload.mdx

- **File** \`apps/docs/core/workload.mdx\` · **Action** \`new_file\` · **Depends on** —
- **Behavior**
  - A user guide page.
- **Verify** \`pnpm exec biome check apps/docs/core/workload.mdx\`
`;
  const { packets, warnings } = buildPackets(parsePlan(plan), { runId: "r1", intent: "feature-extend", planPath: ".sdlc/runs/r1/change_plan.md" });
  const doc = packets.find((p) => p.artifact_path === "apps/docs/core/workload.mdx");
  assert.deepEqual(doc.apply.verify, []);
  assert.equal(doc.apply.format, undefined);
  assert.ok(!warnings.some((w) => /A9.*Verify/.test(w)), "no missing-Verify warning for a docs page");
});

test("the plan's ## Verify deferred commands reach the packets once, on the last packet", () => {
  const plan = PLAN + `
## Verify deferred (run once after the last packet, not per file)

- \`pnpm --filter @kaneo/api typecheck\`
- \`pnpm --filter @kaneo/web typecheck\`
- \`pnpm --filter @kaneo/web typecheck\`
`;
  const parsed = parsePlan(plan);
  assert.deepEqual(parsed.deferred, ["pnpm --filter @kaneo/api typecheck", "pnpm --filter @kaneo/web typecheck"]);
  const { packets } = buildPackets(parsed, { runId: "r1", intent: "feature-extend", planPath: ".sdlc/runs/r1/change_plan.md" });
  const all = packets.flatMap((p) => p.verify_deferred ?? []);
  assert.equal(all.filter((c) => c === "pnpm --filter @kaneo/api typecheck").length, 1, "a command a unit already defers is not added twice");
  assert.ok(packets[packets.length - 1].verify_deferred.includes("pnpm --filter @kaneo/web typecheck"));
});

test("a plan without ## Verify deferred adds no end-of-run checks", () => {
  assert.deepEqual(parsePlan(PLAN).deferred, []);
});
