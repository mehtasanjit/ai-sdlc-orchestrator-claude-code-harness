/**
 * Zero-touch hand-off mode, the safety net: a NEW document or test file is not typed by hand.
 *
 * In a hand-off chat the chat's model is told to hand new documents, specs, plans and tests to the hand-off tools.
 * Being told is not enough: a model that types the file itself has done the expensive typing, and nothing checked
 * the result. So the hook refuses the write and names the tool that takes it. What is refused is narrow on purpose:
 *   - only a file that does not exist yet (a change to a file that exists is the chat model's own edit);
 *   - only inside the project, and never a tool's own folder or an agent's instruction file;
 *   - only a document (by its file type) or a test file (by its name);
 *   - written with the Write tool, or through the shell (a redirect or `tee`), which is how a model in an
 *     auto-approving permission mode usually writes.
 * It stands down whenever handing off is not possible or not wanted: a file a failed hand-off handed back, a
 * hand-off policy that cannot be read, a workflow run (which has its own rules), a chat in workflow mode.
 *
 * Every case runs through the real shell shim with its own MMO_HOME and project folder. No network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const { startingChats, writeZtSettings, gitProject } = await import(join(ROOT, "tools", "test", "lib", "chat-start.mjs"));
const { serverBuilt } = await import(join(ROOT, "tools", "test", "lib", "server-built.mjs"));
const { fileKind, shellTargets } = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "handoff-net.mjs"));
// Whether a hand-off can run is asked of the workflows' own router, which needs the built server.
const SKIP = serverBuilt();
const SHIM = join(ROOT, "plugin", "hooks", "ambient.sh");

/**
 * A person who chose Hand-off ("b", Flash 3.8 typing every kind, the chat on Opus 5) or Workflows ("a") in the
 * settings box.
 */
function sandbox({ mode = "b" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mmo-zt-b-net-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "package.json"), '{"name":"shop"}\n');
  gitProject(repo); // a project being changed is a git project (a change workflow needs git)
  writeFileSync(join(repo, "README.md"), "# Shop\n");
  writeFileSync(join(repo, "tests", "users.test.js"), "// tests\n");
  writeZtSettings(home, { mode: mode === "a" ? "workflows" : "handoff", handoff: { chat_model: "claude-opus-5", documents: "flash", tests: "flash", repeats: "flash" } });
  return { dir, home, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The chat's stamp names a policy that no longer exists (a damaged install): nothing can be handed off. */
function breakPolicy(s, sid) {
  const file = join(s.home, "sessions", sid, "handoff.json");
  const st = JSON.parse(readFileSync(file, "utf8"));
  for (const k of Object.keys(st.typists)) st.typists[k].policy = "no-such-policy";
  writeFileSync(file, JSON.stringify(st));
  rmSync(join(s.home, "sessions", sid, "handoff_models.json"), { force: true });
}

function runOnce(event, payload, { home, repo }, env = {}) {
  return new Promise((done) => {
    const childEnv = { PATH: process.env.PATH, HOME: home, MMO_HOME: home, CLAUDE_PROJECT_DIR: repo, ...env };
    const p = spawn("sh", [SHIM, event], { cwd: repo, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => {
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch { /* left null */ }
      done({ code, stdout, json });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
  });
}
const run = startingChats(runOnce, (s) => s.home, { envOf: (s, env) => env ?? {} });
const startOn = (s, sid) => run("session-start", { session_id: sid, cwd: s.repo, source: "startup", model: "claude-opus-5" }, s);
const write = (s, sid, path, extra = {}) => run("pre-any", { session_id: sid, cwd: s.repo, tool_name: "Write", tool_input: { file_path: path.startsWith("/") ? path : join(s.repo, path), content: "text\n" }, ...extra }, s);
const bash = (s, sid, command, extra = {}) => run("pre-any", { session_id: sid, cwd: s.repo, tool_name: "Bash", tool_input: { command }, ...extra }, s);
/**
 * A refusal carries the person's sentence as its reason (Claude Code shows it to them) and the model's
 * instruction as its additionalContext. `denied` returns the model's instruction (null when nothing was refused);
 * `shown` returns what the person reads.
 */
const denied = (r) => (r.json?.hookSpecificOutput?.permissionDecision === "deny" ? r.json.hookSpecificOutput.additionalContext ?? "" : null);
const shown = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? null;
const line = (r) => r.json?.systemMessage ?? null;

test("which files the net is about: a document by its type, a test file by its name", () => {
  const doc = ["README.md", "docs/setup.md", "docs/api/reference.mdx", "design/cache.rst", "notes.adoc", "PLAN.md"];
  const tests = ["tests/cart.test.js", "src/cart.spec.ts", "src/__tests__/cart.js", "tests/test_cart.py", "pkg/cart_test.go", "spec/cart_spec.rb", "src/test/java/CartTest.java", "CartTests.cs"];
  const neither = ["src/cart.js", "package.json", "tests/fixtures/orders.json", "tests/helpers.js", "docs/diagram.svg", "openapi.yaml", "contest.js", "src/latest.ts", "README", "test.js"];
  for (const p of doc) assert.equal(fileKind(p), "document", p);
  for (const p of tests) assert.equal(fileKind(p), "tests", p);
  for (const p of neither) assert.equal(fileKind(p), null, p);
  // A tool's own folder and an agent's instruction file are not the project's documents.
  for (const p of [".claude/notes.md", ".github/PULL_REQUEST_TEMPLATE.md", ".sdlc/design.md", "docs/.cache/x.md", "CLAUDE.md", "sub/CLAUDE.md", "AGENTS.md", "CLAUDE.local.md"]) assert.equal(fileKind(p), null, p);
});

test("what a shell command writes: its redirects and tee, never the text of a here-document", () => {
  // Each target is written as the command's starting folder sees it: a `cd` before it is already applied.
  const t = (c) => shellTargets(c);
  assert.deepEqual(t("cat > docs/setup.md <<'EOF'\n# Setup\n> a quote, not a redirect > x.md\nEOF"), ["docs/setup.md"]);
  assert.deepEqual(t("echo hi >> notes.md"), ["notes.md"]);
  assert.deepEqual(t('printf "%s" "a > b.md" > "docs/my guide.md"'), ["docs/my guide.md"], "a > inside quotes is text; a quoted target is one path");
  assert.deepEqual(t("npm test 2>&1 | tee out.log docs/run.md"), ["out.log", "docs/run.md"]);
  assert.deepEqual(t("npm test > /dev/null 2>&1"), ["/dev/null"]);
  assert.deepEqual(t("node build.js &> build.log; ls"), ["build.log"]);
  assert.deepEqual(t("echo x >| docs/clobber.md"), ["docs/clobber.md"], "the overwrite form of a redirect");
  assert.deepEqual(t("cat <<-END | tee -a CHANGELOG.md\n\tline > not.md\n\tEND"), ["CHANGELOG.md"]);
  assert.deepEqual(t("diff <(sort a) <(sort b)"), []);
  assert.deepEqual(t("git log --format='%s > %an'"), []);
  // A cd moves what follows it, wherever it stands; one inside brackets ends with them.
  assert.deepEqual(t("cd docs && cat > guide.md <<EOF\nx\nEOF"), ["docs/guide.md"]);
  assert.deepEqual(t("mkdir -p docs/api && cd docs/api && echo x > ref.md; cd .. ; echo y > index.md"), ["docs/api/ref.md", "docs/index.md"]);
  assert.deepEqual(t("(cd docs && echo x > sub.md); echo y > top.md"), ["docs/sub.md", "top.md"]);
  assert.deepEqual(t("cd /var/tmp && echo x > a.md"), ["/var/tmp/a.md"]);
  // A folder or a path the command computes cannot be known from its text: such a target is left out, never guessed.
  assert.deepEqual(t("echo a > $HOME/notes.md"), []);
  assert.deepEqual(t('cd "$DIR" && echo a > notes.md; echo b > `pwd`/x.md'), []);
  assert.deepEqual(t("cd ~/work && echo a > notes.md"), []);
  for (const odd of [undefined, "", 42, "echo 'unclosed > x.md"]) assert.deepEqual(t(odd), []);
});

test("a new document or test file typed with the Write tool is refused, and the reason names the hand-off tool", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "n1");
    const doc = await write(s, "n1", "docs/setup.md");
    assert.match(denied(doc) ?? "", /docs\/setup\.md/);
    assert.match(denied(doc), /write_document/);
    assert.match(denied(doc), /kind, file, purpose, readers, sections, facts/, "the form's fields, so the next call is the right one");
    assert.match(denied(doc), /A change to a file that exists is yours to make/);
    assert.equal(shown(doc), "Zero-touch: Opus 5 started writing the new document docs/setup.md itself. In Hand-off mode that work goes to Flash 3.8, so zero-touch stopped it and told Opus 5 to hand it off. To have it written here instead, say \"write it yourself\".");
    assert.equal(line(doc), null, "said once, as the refusal itself, not twice");
    const tests = await write(s, "n1", "tests/cart.test.js");
    assert.match(denied(tests) ?? "", /write_tests_from_cases/);
    assert.match(denied(tests), /file, target, functions, cases, test_command/);
    assert.equal(shown(tests), "Zero-touch: Opus 5 started writing the new test file tests/cart.test.js itself. In Hand-off mode that work goes to Flash 3.8, so zero-touch stopped it and told Opus 5 to hand it off. To have it written here instead, say \"write it yourself\".");
    // A helper the chat started is held to the same rule: the work is the chat's.
    assert.match(denied(await write(s, "n1", "docs/guide.md", { agent_id: "helper-1" })) ?? "", /write_document/);
  } finally { s.cleanup(); }
});

test("everything else passes untouched: existing files, code, other folders, other tools", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "p1");
    for (const path of ["README.md", "tests/users.test.js", "src/cart.js", "tests/fixtures/orders.json", ".claude/notes.md", "CLAUDE.md", join(s.dir, "elsewhere", "notes.md")]) {
      assert.equal((await write(s, "p1", path)).stdout, "", path);
    }
    assert.equal((await run("pre-any", { session_id: "p1", cwd: s.repo, tool_name: "Edit", tool_input: { file_path: join(s.repo, "README.md"), old_string: "Shop", new_string: "The shop" } }, s)).stdout, "", "an edit to a file that exists");
    assert.equal((await run("pre-any", { session_id: "p1", cwd: s.repo, tool_name: "Read", tool_input: { file_path: join(s.repo, "docs", "setup.md") } }, s)).stdout, "");
  } finally { s.cleanup(); }
});

test("a new document written through the shell is refused too", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "b1");
    const heredoc = await bash(s, "b1", "cat > docs/setup.md <<'EOF'\n# Setup\nnpm ci\nEOF");
    assert.match(denied(heredoc) ?? "", /docs\/setup\.md[\s\S]*write_document/);
    assert.match(denied(await bash(s, "b1", "cd docs && printf '# Guide' > guide.md")) ?? "", /docs\/guide\.md/, "a leading cd is followed");
    assert.match(denied(await bash(s, "b1", "echo '# tests' | tee tests/cart.test.js")) ?? "", /write_tests_from_cases/);
    for (const fine of ["npm test > out.log 2>&1", "echo '- fixed' >> README.md", "git log --oneline > /dev/null", "ls docs", "cat > src/cart.js <<'EOF'\nexport const a = 1;\nEOF"]) {
      assert.equal((await bash(s, "b1", fine)).stdout, "", fine);
    }
  } finally { s.cleanup(); }
});

test("the net stands down when handing off is not possible or not wanted", { skip: SKIP ?? false }, async () => {
  // A file a failed hand-off handed back is the chat model's to write.
  const s = sandbox();
  try {
    await startOn(s, "r1");
    writeFileSync(join(s.home, "sessions", "r1", "handoff_released.json"), JSON.stringify(["docs/setup.md"]));
    assert.equal((await write(s, "r1", "docs/setup.md")).stdout, "");
    assert.match(denied(await write(s, "r1", "docs/other.md")) ?? "", /write_document/, "only that file");
    // A workflow run has its own rules for what may be written.
    await run("prompt", { session_id: "r1", cwd: s.repo, prompt: "/mmo:docs write the API docs", prompt_id: "r1-1" }, s);
    assert.equal((await write(s, "r1", "docs/other.md")).stdout, "", "inside a workflow run");
  } finally { s.cleanup(); }
  // A hand-off policy that cannot be read: there is nothing to hand the file to.
  const broken = sandbox();
  try {
    await startOn(broken, "x1");
    breakPolicy(broken, "x1");
    assert.equal((await write(broken, "x1", "docs/setup.md")).stdout, "");
  } finally { broken.cleanup(); }
  // A chat in workflow mode has no hand-offs at all.
  const a = sandbox({ mode: "a" });
  try {
    await startOn(a, "a1");
    assert.equal((await write(a, "a1", "docs/setup.md")).stdout, "");
  } finally { a.cleanup(); }
});

test("the start note tells the chat's model which by-hand writes the net refuses: the Write tool and a shell command", () => {
  // Edit cannot create a file, and the shell can: a model told only about Write reaches for a redirect next, and
  // learns of the net by being refused. The note names the two routes the net covers, in the words the refusal uses,
  // and that a file that exists is the model's own.
  const note = readFileSync(join(ROOT, "zero-touch", "scripts", "messages.mjs"), "utf8"); // the rules note lives there
  assert.doesNotMatch(note, /with Write or Edit is refused/);
  assert.match(note, /Creating such a file yourself, with the Write tool or a shell command, is refused; a change to a file that exists is yours to make\./);
});

// ─── The net never makes work impossible, and the chat's own edit is kept ───────────────────────────────────────────

const ask = (s, sid, text, n) => run("prompt", { session_id: sid, cwd: s.repo, prompt: text, prompt_id: `${sid}-${n}` }, s);

test("a new file set to hand off is refused every time until it is handed off; the line says how to have it written here", { skip: SKIP ?? false }, async () => {
  // A second try never passes silently, or the person could believe Flash 3.8 wrote what Claude wrote: only a
  // deterministic way out lets it through ("write it yourself" is the next test).
  const s = sandbox();
  try {
    await startOn(s, "o1");
    const first = await write(s, "o1", "docs/setup.md");
    assert.match(denied(first) ?? "", /write_document/);
    assert.match(first.json?.hookSpecificOutput?.permissionDecisionReason ?? "", /To have it written here instead, say "write it yourself"\.$/);
    assert.match(denied(await write(s, "o1", "docs/setup.md")) ?? "", /This refusal holds every time/, "the same file again: still refused");
    assert.match(denied(await write(s, "o1", "docs/setup.md")) ?? "", /write_document/, "and again");
    assert.match(denied(await write(s, "o1", "docs/other.md")) ?? "", /write_document/);
    const yourself = await ask(s, "o1", "write it yourself", 9);
    assert.match(yourself.json?.hookSpecificOutput?.additionalContext ?? "", /do it yourself, with your own tools/);
    assert.equal((await write(s, "o1", "docs/setup.md")).stdout, "", "the person's word lets it through");
  } finally { s.cleanup(); }
});

test("\"write it yourself\" keeps this message's work in the chat: no hand-off, and Claude's own new files pass", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "y1");
    const r = await ask(s, "y1", "write a README for the shop, but write it yourself, don't hand it off", 1);
    assert.match(r.json?.hookSpecificOutput?.additionalContext ?? "", /do it yourself, with your own tools, and do not call the hand-off tools/);
    assert.equal(r.json?.systemMessage, undefined, "no hand-off line");
    assert.equal((await write(s, "y1", "docs/readme-draft.md")).stdout, "");
  } finally { s.cleanup(); }
});

test("a message that is not hand-off work: a new note or fixture Claude writes for it is its own", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "h1");
    await ask(s, "h1", "fix the rounding bug in the cart total", 1);
    assert.equal((await write(s, "h1", "NOTES.md")).stdout, "", "a note for a bug fix is not hand-off work");
    // A message that asks for a document: the net claims a new document, but not test files.
    await ask(s, "h1", "write a setup guide for new developers", 2);
    assert.match(denied(await write(s, "h1", "docs/setup.md")) ?? "", /write_document/);
    assert.equal((await write(s, "h1", "tests/cart.test.js")).stdout, "", "tests were not asked for in this message");
    // Test data is never claimed: the tools cannot write such a file exactly.
    assert.equal((await write(s, "h1", "tests/fixtures/table.md")).stdout, "");
    assert.equal((await write(s, "h1", "src/__mocks__/api.test.js")).stdout, "");
  } finally { s.cleanup(); }
});

test("an edit that creates a new file is claimed like a Write", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "e1");
    const created = await run("pre-any", { session_id: "e1", cwd: s.repo, tool_name: "Edit", tool_input: { file_path: join(s.repo, "docs", "new.md"), old_string: "", new_string: "# New\n" } }, s);
    assert.match(denied(created) ?? "", /write_document/);
    assert.deepEqual(fileKind("tests/fixtures/x.md"), null);
  } finally { s.cleanup(); }
});

test("while another chat's workflow holds the project, no hand-off lands and the net stands down; an undo still runs", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "w2");
    // Another chat (a Workflows chat) runs a workflow in the same folder.
    writeZtSettings(s.home, { mode: "workflows" });
    await run("session-start", { session_id: "w1", cwd: s.repo, source: "startup", model: "claude-opus-5" }, s);
    await run("prompt", { session_id: "w1", cwd: s.repo, prompt: "/mmo:bugfix the login page returns 500", prompt_id: "w1-1" }, s);
    const call = await run("pre-handoff", { session_id: "w2", cwd: s.repo, tool_name: "mcp__plugin_mmo_model-dispatch__write_document", tool_input: { kind: "docs", file: "docs/x.md" } }, s);
    assert.equal(call.json?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(call.json.hookSpecificOutput.permissionDecisionReason, /^Zero-touch: this can't be handed off right now, because another chat in this project folder is running a bug-fix workflow/);
    assert.equal((await write(s, "w2", "docs/x.md")).stdout, "", "Claude writes it itself");
    const undo = await run("pre-handoff", { session_id: "w2", cwd: s.repo, tool_name: "mcp__plugin_mmo_model-dispatch__undo_hand_off", tool_input: { id: "habcd" } }, s);
    assert.ok(undo.json?.hookSpecificOutput?.updatedInput?._mmo, "an undo is stamped and runs");
  } finally { s.cleanup(); }
});

test("before the chat's first edit of a file, its earlier text is kept once, for a repeated change's pattern", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "k1");
    const H = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "handoff.mjs"));
    const edit = (text) => run("pre-any", { session_id: "k1", cwd: s.repo, tool_name: "Edit", tool_input: { file_path: join(s.repo, "README.md"), old_string: "x", new_string: text } }, s);
    await edit("y");
    const kept = H.beforeSnapshotFile("k1", "README.md", { MMO_HOME: s.home, HOME: s.home });
    assert.equal(readFileSync(kept, "utf8"), "# Shop\n");
    writeFileSync(join(s.repo, "README.md"), "# Shop, edited\n");
    await edit("z");
    assert.equal(readFileSync(kept, "utf8"), "# Shop\n", "kept once: the first edit's earlier text");
  } finally { s.cleanup(); }
});

test("an interrupted hand-off: its file is handed back and its call marked; the stopped line shows at the next message", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "i1");
    await run("handoff-failed", { session_id: "i1", cwd: s.repo, tool_name: "mcp__plugin_mmo_model-dispatch__write_document", tool_input: { file: "docs/setup.md" }, tool_use_id: "tu-77", is_interrupt: true }, s);
    const dir = join(s.home, "sessions", "i1");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "handoff_interrupted.json"), "utf8")), ["tu-77"]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "handoff_released.json"), "utf8")), ["docs/setup.md"]);
    // The server, on finding it stopped, leaves its record; the next message says so once.
    writeFileSync(join(dir, "handoff_stopped.json"), JSON.stringify([{ files: ["docs/setup.md"], cost_usd: 0.003 }]));
    const r = await ask(s, "i1", "thanks", 1);
    assert.equal(r.json?.systemMessage, "Zero-touch: the hand-off of docs/setup.md was stopped, as you asked, and nothing was added to your project (estimated cost so far: $0.0030).");
    assert.equal((await ask(s, "i1", "thanks again", 2)).stdout, "", "said once");
  } finally { s.cleanup(); }
});

test("a Hand-off chat in a project without git: tests and repeated changes are Claude's own from the start, said up front, never refused one by one", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    rmSync(join(s.repo, ".git"), { recursive: true, force: true });
    await startOn(s, "g1");
    const asked = await ask(s, "g1", "write unit tests for the cart totals", 1);
    assert.match(asked.json?.systemMessage ?? "", /new tests can't be handed off here, because this project isn't set up with git, and the test copy they're checked in needs it, so Opus 5 writes them directly\./);
    assert.match(asked.json?.hookSpecificOutput?.additionalContext ?? "", /cannot use a git test copy/);
    assert.equal((await write(s, "g1", "tests/cart.test.js")).stdout, "", "the net stands down: no refuse-then-release cycle");
    const call = await run("pre-handoff", { session_id: "g1", cwd: s.repo, tool_name: "mcp__plugin_mmo_model-dispatch__write_tests_from_cases", tool_input: { file: "tests/x.test.js" } }, s);
    assert.equal(call.json?.hookSpecificOutput?.permissionDecisionReason, "Zero-touch: this can't be handed off here, because this project isn't set up with git, so Claude does it in the chat.");
    // Documents need no git: still handed off.
    await ask(s, "g1", "write a setup guide for new developers", 2);
    assert.match(denied(await write(s, "g1", "docs/setup.md")) ?? "", /write_document/);
  } finally { s.cleanup(); }
});

test("the folder's missing git is said when Hand-off is saved and at a chat's start", async () => {
  const M = await import(join(ROOT, "zero-touch", "scripts", "messages.mjs"));
  const R = await import(join(ROOT, "zero-touch", "scripts", "readiness.mjs"));
  const settings = { mode: "handoff", handoff: { chat_model: "claude-opus-5", documents: "flash", tests: "sonnet", repeats: "chat" } };
  assert.equal(R.needsGitHere(settings), true);
  assert.equal(R.needsGitHere({ mode: "handoff", handoff: { documents: "flash", tests: "chat", repeats: "chat" } }), false, "only documents handed off: no git needed");
  assert.equal(M.noGitHereLine(settings), "• This project folder isn't set up with git, so new tests and repeated changes can't be checked in a test copy here; Claude does them itself in this folder. New documents are still handed off.");
  assert.match(M.savedLine(settings, { noGitHere: true }), /\n• This project folder isn't set up with git/);
  const dir = mkdtempSync(join(tmpdir(), "zt-gitproj-"));
  try {
    assert.equal(R.gitProject(dir), false);
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "packages", "web"), { recursive: true });
    assert.equal(R.gitProject(join(dir, "packages", "web")), true, "a folder inside a git project");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A hand-off refused with "Claude does the work in the chat instead" hands the file back, or the safety net would
// refuse Claude's own write of it, telling it to hand it off.
test("a hand-off refused here hands its file back: Claude's own write of it passes at once", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.repo, ".claude"), { recursive: true });
    writeFileSync(join(s.repo, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(npm test:*)"] } }));
    await startOn(s, "rf");
    await ask(s, "rf", "write tests for the cart functions in src/cart.js", 1);
    const call = await run("pre-handoff", { session_id: "rf", cwd: s.repo, tool_name: "mcp__plugin_mmo_model-dispatch__write_tests_from_cases", tool_input: { file: "tests/cart.test.js", test_command: "npm test" } }, s);
    assert.equal(call.json?.hookSpecificOutput?.permissionDecision, "deny", "the check command is one the person's settings forbid");
    assert.equal((await write(s, "rf", "tests/cart.test.js")).stdout, "", "Claude's own write of that file is not refused");
  } finally { s.cleanup(); }
});

// "To undo it, ask Claude to undo hand-off h…" keeps working after the person leaves Hand-off mode: the undo works in
// any chat outside a running workflow, with its own line.
test("an undo works in any chat outside a workflow, after leaving Hand-off mode too, and says it is taking the hand-off back", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "u1");
    const undoIn = (sid) => run("pre-handoff", { session_id: sid, cwd: s.repo, tool_name: "mcp__plugin_mmo_model-dispatch__undo_hand_off", tool_input: { id: "habcd" } }, s);
    const inHandoff = await undoIn("u1");
    assert.equal(inHandoff.json?.hookSpecificOutput?.permissionDecisionReason, "Zero-touch: taking back the hand-off you asked to undo.");
    assert.ok(inHandoff.json.hookSpecificOutput.updatedInput?._mmo?.session_id);
    writeZtSettings(s.home, { mode: "workflows" });
    await run("session-start", { session_id: "u2", cwd: s.repo, source: "startup", model: "claude-opus-5" }, s);
    const inWorkflows = await undoIn("u2");
    assert.equal(inWorkflows.json?.hookSpecificOutput?.permissionDecision, "allow", "a Workflows chat");
    assert.ok(inWorkflows.json.hookSpecificOutput.updatedInput?._mmo?.session_id);
    writeZtSettings(s.home, { mode: "off" });
    const inOff = await undoIn("u3");
    assert.ok(inOff.json?.hookSpecificOutput?.updatedInput?._mmo?.session_id, "a chat started with zero-touch Off");
    const back = await run("post-handoff", { session_id: "u3", cwd: s.repo, tool_name: "mcp__plugin_mmo_model-dispatch__undo_hand_off", tool_input: { id: "habcd" }, tool_response: JSON.stringify({ status: "undone", id: "habcd", restored: ["docs/x.md"], left_alone: [] }) }, s);
    assert.match(back.json?.systemMessage ?? "", /^Zero-touch: the hand-off of docs\/x\.md was undone: 1 file is back as it was\.$/, "its receipt line too, naming the file");
  } finally { s.cleanup(); }
});

test("a file the net refused stays claimed across messages: a reply or another message does not let Claude's own write through", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "c1");
    await ask(s, "c1", "write a setup guide for new developers", 1);
    assert.match(denied(await write(s, "c1", "docs/setup.md")) ?? "", /write_document/);
    for (const [n, reply] of [[2, "ok"], [3, "yes, hand it off"], [4, "fix the rounding bug in the cart total"]]) {
      await ask(s, "c1", reply, n);
      assert.match(denied(await write(s, "c1", "docs/setup.md")) ?? "", /write_document/, `after "${reply}": still claimed`);
    }
    // A reply keeps the hand-off asked even for a file Claude has not tried yet.
    await ask(s, "c1", "write a contributing guide", 5);
    await ask(s, "c1", "ok", 6);
    assert.match(denied(await write(s, "c1", "docs/contributing.md")) ?? "", /write_document/, "a reply asks for nothing new");
    // The person's word ends it.
    await ask(s, "c1", "write the setup guide yourself", 7);
    assert.equal((await write(s, "c1", "docs/setup.md")).stdout, "");
  } finally { s.cleanup(); }
});

test("\"write it yourself\" in the person's own words: the wider set of phrasings, and typed while Claude works", { skip: SKIP ?? false }, async () => {
  const H = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "handoff.mjs"));
  for (const t of ["write it yourself", "write the README yourself", "do it on your own", "write it by yourself", "just do it in the chat",
    "don’t hand it off", "don't send it to Flash", "do not pass it to another model", "no handoff please", "no hand-off", "without a hand off", "stop handing it off"]) {
    assert.ok(H.DO_IT_YOURSELF.test(t), t);
  }
  for (const t of ["write a README", "hand it off", "write the setup guide here in docs/", "yes, hand it off to Flash", "write tests for the cart"]) {
    assert.ok(!H.DO_IT_YOURSELF.test(t), t);
  }
  const s = sandbox();
  try {
    await startOn(s, "w1");
    await ask(s, "w1", "write a setup guide for new developers", 1);
    assert.match(denied(await write(s, "w1", "docs/setup.md")) ?? "", /write_document/);
    // Typed while Claude works: Claude Code puts it in the input queue (lib/transcript.mjs stillQueued).
    const transcript = join(s.dir, "w1.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), sessionId: "w1", content: "actually, write it yourself" }) + "\n");
    const r = await run("prompt", { session_id: "w1", cwd: s.repo, prompt: "actually, write it yourself", prompt_id: "w1-2", transcript_path: transcript }, s);
    assert.match(r.json?.hookSpecificOutput?.additionalContext ?? "", /do it yourself, with your own tools/);
    assert.equal((await write(s, "w1", "docs/setup.md")).stdout, "", "the person's word applies to the running work at once");
  } finally { s.cleanup(); }
});

test("\"write it yourself\" in a reply that names zero-touch counts, idle or typed while Claude works; more phrasings", { skip: SKIP ?? false }, async () => {
  // The reply the refusal line asks for often names zero-touch: it is not dropped as a message about zero-touch
  // itself, or the same refusal would come back on every write.
  const H = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "handoff.mjs"));
  for (const t of ["write it in this chat", "you write it", "ok, you write it", "just write it here", "write it directly", "skip the hand-off and write it",
    "don't use the hand-off, write it", "you can write it, no need for a hand-off"]) {
    assert.ok(H.DO_IT_YOURSELF.test(t), t);
  }
  // "here" and "directly" only after it/this/that/them: a place or a manner for new work still hands off.
  for (const t of ["write a README here", "create a config file here", "could you write tests for the parser", "can you do it", "write tests directly for the parser module"]) {
    assert.ok(!H.DO_IT_YOURSELF.test(t), t);
  }
  const s = sandbox();
  try {
    await startOn(s, "zy");
    await ask(s, "zy", "write a setup guide for new developers", 1);
    assert.match(shown(await write(s, "zy", "docs/setup.md")) ?? "", /say "write it yourself"/);
    const r = await ask(s, "zy", "zero-touch stopped it, just write it yourself", 2);
    assert.match(r.json?.hookSpecificOutput?.additionalContext ?? "", /do it yourself, with your own tools/);
    assert.equal((await write(s, "zy", "docs/setup.md")).stdout, "", "the person did what the line said");
    // Typed while Claude works, naming zero-touch too.
    await ask(s, "zy", "write a contributing guide", 3);
    assert.ok(denied(await write(s, "zy", "CONTRIBUTING.md")) !== null);
    const transcript = join(s.dir, "zy.jsonl");
    const text = "zero-touch keeps blocking it, write it yourself";
    writeFileSync(transcript, JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), sessionId: "zy", content: text }) + "\n");
    await run("prompt", { session_id: "zy", cwd: s.repo, prompt: text, prompt_id: "zy-4", transcript_path: transcript }, s);
    assert.equal((await write(s, "zy", "CONTRIBUTING.md")).stdout, "");
  } finally { s.cleanup(); }
});

test("a helper's hand-off that failed or was stopped is marked and handed back like the chat's own", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await startOn(s, "hf");
    await ask(s, "hf", "write a setup guide and a contributing guide for new developers", 1);
    assert.ok(denied(await write(s, "hf", "docs/setup.md", { agent_id: "helper-1" })) !== null, "a helper's by-hand write is refused too");
    const failed = (file, extra) => run("handoff-failed", { session_id: "hf", cwd: s.repo, agent_id: "helper-1", tool_name: "mcp__plugin_mmo_model-dispatch__write_document", tool_input: { file }, ...extra }, s);
    await failed("docs/setup.md", { tool_use_id: "tu-h1", is_interrupt: true });
    await failed("CONTRIBUTING.md", { tool_use_id: "tu-h2" });
    const dir = join(s.home, "sessions", "hf");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "handoff_interrupted.json"), "utf8")), ["tu-h1"], "the stopped call is never landed later");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "handoff_released.json"), "utf8")).sort(), ["CONTRIBUTING.md", "docs/setup.md"]);
    assert.equal((await write(s, "hf", "docs/setup.md")).stdout, "", "handed back: the chat's own write passes");
  } finally { s.cleanup(); }
});

// ─── The chat's model in Hand-off mode, as in Workflows ─────────────────────────────────────────────────────────────
// The chat's real model is read wherever it can be seen, and while it is not the one the person chose nothing is
// handed off.

const handoffTool = (s, sid, file, extra = {}) => run("pre-handoff", { session_id: sid, cwd: s.repo, tool_name: "mcp__plugin_mmo_model-dispatch__write_document", tool_input: { file, kind: "guide", purpose: "x", readers: "x", sections: ["x"], facts: ["x"] }, ...extra }, s);

test("Hand-off on another model than the person chose: nothing is handed off, nothing is typed by hand, and the line says why and how", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await run("session-start", { session_id: "m1", cwd: s.repo, source: "startup", model: "claude-sonnet-5" }, s);
    const r = await ask(s, "m1", "write a setup guide for new developers", 1);
    assert.equal(r.json?.systemMessage, "Zero-touch: this chat is on Sonnet 5, but you chose Opus 5 to do the development in Hand-off mode, so nothing is handed off until you switch this chat to Opus 5 with the model menu next to the message box (in the terminal, type /model claude-opus-5). Then ask again.");
    assert.match(r.json?.hookSpecificOutput?.additionalContext ?? "", /Do not do this work yourself and do not call the hand-off tools/);
    assert.match(r.json?.hookSpecificOutput?.additionalContext ?? "", /If asked which model you are, you are claude-sonnet-5/);
    const call = await handoffTool(s, "m1", "docs/setup.md");
    assert.equal(call.json?.hookSpecificOutput?.permissionDecision, "deny", "the hand-off tool is refused");
    assert.match(call.json?.hookSpecificOutput?.permissionDecisionReason ?? "", /^Zero-touch: this chat is on Sonnet 5, but you chose Opus 5/);
    assert.match(denied(await write(s, "m1", "docs/setup.md")) ?? "", /write_document/, "and typing it by hand is refused: the file was not handed back");
    // The person switches the chat to Opus 5 (Claude Code reports it): the same ask is handed off.
    await run("post-model-switch", { session_id: "m1", cwd: s.repo, to_model: "claude-opus-5" }, s);
    const again = await ask(s, "m1", "write a setup guide for new developers", 2);
    assert.match(again.json?.systemMessage ?? "", /Flash 3\.8/, "handed off now");
    assert.ok((await handoffTool(s, "m1", "docs/setup.md")).json?.hookSpecificOutput?.updatedInput?._mmo, "the tool is stamped and runs");
  } finally { s.cleanup(); }
});

test("Hand-off on another model: any other message gets the warning once per model, and Claude is told its real model", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await run("session-start", { session_id: "m2", cwd: s.repo, source: "startup", model: "claude-haiku-4-5" }, s);
    const first = await ask(s, "m2", "what does parseDate do?", 1);
    assert.equal(first.json?.systemMessage, "Zero-touch: this chat is on Haiku 4.5, but you chose Opus 5 to do the development in Hand-off mode. Switch it with the model menu next to the message box (in the terminal, type /model claude-opus-5); until then, nothing is handed off.");
    assert.match(first.json?.hookSpecificOutput?.additionalContext ?? "", /you are claude-haiku-4-5, not claude-opus-5/);
    assert.equal((await ask(s, "m2", "and what does formatDate do?", 2)).stdout, "", "said once for this model");
  } finally { s.cleanup(); }
});

test("a new chat's model unknown at its first message is checked at the hand-off call, from the chat's own answer", { skip: SKIP ?? false }, async () => {
  const s = sandbox();
  try {
    await run("session-start", { session_id: "m3", cwd: s.repo, source: "startup" }, s); // the desktop app says no model
    const r = await ask(s, "m3", "write a setup guide for new developers", 1);
    assert.match(r.json?.systemMessage ?? "", /Flash 3\.8/, "not known yet: the hand-off line, as before");
    const transcript = join(s.dir, "m3.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "Gathering the facts." }] } }) + "\n");
    const call = await handoffTool(s, "m3", "docs/setup.md", { transcript_path: transcript });
    assert.equal(call.json?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(call.json?.hookSpecificOutput?.permissionDecisionReason ?? "", /this chat is on Haiku 4\.5, but you chose Opus 5/);
  } finally { s.cleanup(); }
});
