#!/usr/bin/env node
/**
 * The tools a Gemini thinking step works with (worker/thinking_worker.py), one process per step.
 *
 * Every read goes through readRefusal (lib/change-spec.mjs), the one read rule for everything a model is sent, so
 * credentials, MCP config, other AI tools' rules, git's own store and a brownfield contract's off-limits never leave
 * the machine, under any other name for them (a link, a hard link, another spelling). Every hand-in writes one fixed
 * path the step owns and runs the same check the Claude helper's hand-over runs: plan-lint's checkSection for the
 * change spec, the spec store for the build spec, the findings shape for a review. Nothing else writes. No command the
 * model wrote runs before the person approves the plan at Gate 2: a hand-in's file checks wait for dispatch, and a
 * reviewer's file check runs the approved plan's check as the engine runs checks.
 *
 * Protocol: one JSON object per line on stdin, {id, op, args}; one per line on stdout, {id, ok, result} or
 * {id, ok: false, error}. Started with --config <file>, a JSON object written by the server (src/thinking.ts).
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readRefusal, runFileCheck } from "./lib/change-spec.mjs";
import { holdsPrivateKey } from "./lib/off-limits.mjs";
import { loadServerLib } from "./lib/server-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A tool answer is cut here; the model reads the rest by line range. */
export const MAX_RESULT_CHARS = 60_000;
// The env files whose values are example or test fixtures by convention: env_keys gives each value's shape.
const ENV_FIXTURES = new Set([".env.example", ".env.test"]);
const MAX_FILE_BYTES = 2_000_000;
const MAX_SEARCH_HITS = 200;
const WALK_SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".turbo", ".cache", "coverage"]);
const COMMAND_TIMEOUT_MS = 300_000;

/** What each role must hand in before its step is done, and the hand-in tools it gets. */
export const ROLE_TOOLS = {
  requirements: ["write_requirements"],
  architect: ["submit_section", "finalize", "registry_versions"],
  "brownfield-architect": ["write_section"],
  "senior-reviewer": ["env_keys", "write_review"],
  "brownfield-senior-reviewer": ["git_diff", "read_provenance", "run_file_check", "env_keys", "write_review"],
  "security-reviewer": ["run_dependency_audit", "env_keys", "write_review"],
  "brownfield-security-reviewer": ["git_diff", "read_provenance", "run_dependency_audit", "env_keys", "write_review"],
  discovery: ["baseline_status", "write_discovery"],
};
export const READ_TOOLS = ["read_file", "list_files", "search_files"];

const cut = (s) => (s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n[cut at ${MAX_RESULT_CHARS} characters: read the rest by line range]` : s);

export class ThinkingTools {
  /**
   * cfg: {role, project_root, run_id, intent, output_dir (relative to project_root), outputs: {requirements,
   * sections_dir, review, security_review, discovery}, spec_dir, requirements_path, code_dir}
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.root = realpathSync(cfg.project_root);
    this.accepted = new Map();
    this.refused = new Map();
    this.written = new Set();
  }

  /** A path the model names, as a project-relative path, or why it may not be read. */
  readable(p) {
    if (typeof p !== "string" || p === "") return { error: "name a path relative to the project root" };
    const abs = resolve(this.root, p);
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) return { error: `${p} is outside the project` };
    let real;
    // The disk's own spelling (realpathSync keeps the one it is given: macOS opens .MCP.JSON as .mcp.json).
    try { real = realpathSync.native(abs); } catch { return { error: `${p} does not exist` }; }
    const realRel = relative(this.root, real);
    if (realRel.startsWith("..") || isAbsolute(realRel)) return { error: `${p} leads outside the project` };
    const refusal = readRefusal(this.root, this.cfg.run_id, rel.split(sep).join("/")) ?? (realRel !== rel ? readRefusal(this.root, this.cfg.run_id, realRel.split(sep).join("/")) : null);
    if (refusal) return { error: refusal };
    return { rel, abs: real };
  }

  read_file({ path, from_line, to_line }) {
    const r = this.readable(path);
    if (r.error) return { error: r.error };
    const st = statSync(r.abs);
    if (st.isDirectory()) return { error: `${path} is a folder: use list_files` };
    if (st.size > MAX_FILE_BYTES) return { error: `${path} is ${st.size} bytes; read it by line range is not possible above ${MAX_FILE_BYTES}` };
    const text = readFileSync(r.abs, "utf8");
    if (holdsPrivateKey(text)) return { error: `${path} holds a private key: the read rule keeps it from models` };
    const lines = text.split("\n");
    const a = Math.max(1, Number(from_line) || 1), b = Math.min(lines.length, Number(to_line) || lines.length);
    return { result: cut(lines.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join("\n")) };
  }

  list_files({ path = "." }) {
    const r = this.readable(path);
    if (r.error) return { error: r.error };
    if (!statSync(r.abs).isDirectory()) return { error: `${path} is a file` };
    const out = [];
    for (const name of readdirSync(r.abs).sort()) {
      const childRel = join(r.rel, name).split(sep).join("/");
      let st;
      try { st = lstatSync(join(r.abs, name)); } catch { continue; }
      // A refused entry is named, so a reviewer knows it exists (its env check needs .env.example and .env.test);
      // its contents stay refused (env_keys gives an env file's key names).
      const shown = st.isDirectory() ? `${name}/` : name;
      out.push(readRefusal(this.root, this.cfg.run_id, childRel) ? `${shown}  (kept from you by the read rule)` : shown);
    }
    return { result: cut(out.join("\n")) };
  }

  /**
   * An env file's key names, never its values, as discovery records them (agents/discovery.md, group 7). For the
   * fixture files (.env.example, .env.test) each value's shape too, its length and whether it is a URL: what a
   * reviewer's env check asks (a 32-character secret, a valid URL) without any value leaving the machine.
   */
  env_keys({ path }) {
    if (typeof path !== "string" || !/^\.env(\..+)?$/i.test(basename(path))) return { error: "name an env file: .env, .env.example, .env.test or .env.<anything>" };
    const abs = resolve(this.root, path);
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) return { error: `${path} is outside the project` };
    let real;
    try { real = realpathSync.native(abs); } catch { return { error: `${path} does not exist` }; }
    const realRel = relative(this.root, real);
    if (realRel.startsWith("..") || isAbsolute(realRel)) return { error: `${path} leads outside the project` };
    if (!statSync(real).isFile()) return { error: `${path} is not a file` };
    const fixture = ENV_FIXTURES.has(basename(realRel).toLowerCase());
    const out = [];
    for (const line of readFileSync(real, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
      if (!m) continue;
      if (!fixture) { out.push(m[1]); continue; }
      const value = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
      let url = false;
      try { url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) && Boolean(new URL(value)); } catch { url = false; }
      out.push(`${m[1]}  (${value === "" ? "empty" : `${value.length} characters`}${url ? ", a URL" : ""})`);
    }
    return { result: out.length ? out.join("\n") : `${path} declares no keys` };
  }

  search_files({ pattern, path = "." }) {
    let re;
    try { re = new RegExp(pattern); } catch (e) { return { error: `not a regular expression: ${e.message}` }; }
    const start = this.readable(path);
    if (start.error) return { error: start.error };
    const hits = [];
    const walk = (abs, rel) => {
      if (hits.length >= MAX_SEARCH_HITS) return;
      let st;
      try { st = lstatSync(abs); } catch { return; }
      if (st.isSymbolicLink()) return;
      const posix = rel.split(sep).join("/");
      if (posix && readRefusal(this.root, this.cfg.run_id, posix)) return;
      if (st.isDirectory()) {
        for (const name of readdirSync(abs).sort()) if (!WALK_SKIP.has(name)) walk(join(abs, name), rel ? join(rel, name) : name);
        return;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
      const text = readFileSync(abs, "utf8");
      if (text.includes("\u0000") || holdsPrivateKey(text)) return;
      text.split("\n").forEach((line, i) => { if (hits.length < MAX_SEARCH_HITS && re.test(line)) hits.push(`${posix}:${i + 1}: ${line.slice(0, 300)}`); });
    };
    walk(start.abs, start.rel === "" ? "" : start.rel);
    return { result: cut(hits.join("\n") + (hits.length >= MAX_SEARCH_HITS ? `\n[first ${MAX_SEARCH_HITS} matches only: narrow the pattern or the path]` : "")) };
  }

  /** Write one file the step owns, inside the step's own folder (output_dir) and never through a link. */
  own(rel, text) {
    const abs = join(this.root, rel);
    const inOwn = relative(resolve(this.root, this.cfg.output_dir), abs);
    if (inOwn === "" || inOwn.startsWith("..") || isAbsolute(inOwn)) {
      throw new Error(`${rel} is outside the step's own folder (${this.cfg.output_dir}); nothing is written there`);
    }
    let at = this.root;
    for (const part of relative(this.root, dirname(abs)).split(sep).filter(Boolean)) {
      at = join(at, part);
      try { if (lstatSync(at).isSymbolicLink()) throw new Error(`${relative(this.root, at)} is a link; nothing is written through it`); } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    try { if (lstatSync(abs).isSymbolicLink()) throw new Error(`${rel} is a link; nothing is written through it`); } catch (e) { if (e.code !== "ENOENT") throw e; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text.endsWith("\n") ? text : text + "\n");
    this.written.add(rel);
  }

  write_requirements({ content }) {
    if (typeof content !== "string" || !content.trim()) return { error: "content is empty" };
    this.own(this.cfg.outputs.requirements, content);
    this.accepted.set("requirements", true);
    return { result: `wrote ${this.cfg.outputs.requirements}` };
  }

  sectionName(name) {
    if (typeof name !== "string" || !/^(header|units-\d{3})\.json$/.test(name)) return { error: "name the section header.json, or units-001.json, units-002.json, …" };
    return { rel: join(this.cfg.outputs.sections_dir, name) };
  }

  /** Brownfield: the change spec's section, checked by plan-lint's own checkSection. */
  async write_section({ name, json }) {
    const n = this.sectionName(name);
    if (n.error) return { error: n.error };
    try { JSON.parse(json); } catch (e) { return { error: `${name} is not valid JSON: ${e.message}` }; }
    this.own(n.rel, json);
    const { checkSection } = await import(pathToFileURL(join(HERE, "plan-lint.mjs")).href);
    // No command the model wrote runs here, and none of its output comes back: the checks wait for dispatch, after
    // the person approves the plan at Gate 2 (lib/change-spec.mjs baselineErrors).
    const r = await checkSection(this.root, this.cfg.run_id, n.rel, { intent: this.cfg.intent, runCommands: false });
    if (r.ok) { this.accepted.set(name, true); this.refused.delete(name); } else { this.accepted.delete(name); this.refused.set(name, r.lines); }
    return r.ok ? { result: r.lines.join("\n") } : { error: `refused:\n${r.lines.join("\n")}` };
  }

  /** Greenfield: the build spec's section, handed to the spec store as submit_spec_section does. */
  async submit_section({ name, json }) {
    const n = this.sectionName(name);
    if (n.error) return { error: n.error };
    try { JSON.parse(json); } catch (e) { return { error: `${name} is not valid JSON: ${e.message}` }; }
    this.own(n.rel, json);
    const { specStore } = await loadServerLib();
    const specDir = join(this.root, this.cfg.spec_dir);
    const kind = name === "header.json" ? "header" : "units";
    const loaded = specStore.readSectionFile(specDir, relative(specDir, join(this.root, n.rel)), kind);
    if (loaded.error) return { error: loaded.error };
    const r = specStore.submitSpecSection(specDir, kind === "header" ? { section: "header", header: loaded.value } : { section: "units", units: loaded.value });
    if (r.ok) { this.accepted.set(name, true); this.accepted.delete("finalize"); return { result: `accepted ${name}: ${r.total_units} unit(s) in the spec` }; }
    return { error: `refused:\n${r.errors.map((e) => `${e.path} ${e.message}`).join("\n")}` };
  }

  async finalize() {
    const { specStore } = await loadServerLib();
    const r = specStore.finalizeSpec(join(this.root, this.cfg.spec_dir), this.cfg.requirements_path ? join(this.root, this.cfg.requirements_path) : undefined);
    if (r.ok) { this.accepted.set("finalize", true); return { result: `finalized: ${r.units} unit(s); design.md rendered` }; }
    return { error: r.missing_coverage?.length ? `no unit covers ${r.missing_coverage.join(", ")}: add a new units file that covers them, then finalize again` : JSON.stringify(r.errors ?? r) };
  }

  registry_versions({ ecosystem, name }) {
    if (typeof name !== "string" || !/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._~-]*$/.test(name)) return { error: "not a package name" };
    const cmd = ecosystem === "pypi" ? ["pip", ["index", "versions", name]] : ["npm", ["view", name, "versions", "--json"]];
    return this.fixed(cmd[0], cmd[1], this.root);
  }

  provenance() {
    const p = join(this.root, this.cfg.output_dir, "provenance.json");
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
  }

  read_provenance() {
    const p = this.provenance();
    return p ? { result: cut(JSON.stringify(p, null, 1)) } : { error: "this run has no provenance.json" };
  }

  git_diff({ path }) {
    const head = this.provenance()?.git_head_before;
    if (!/^[0-9a-f]{7,64}$/.test(head ?? "")) return { error: "provenance.json names no git_head_before" };
    // git reads a path as a pattern, a folder as its whole tree and no path as the whole project, so the read rule
    // judges each file git is given, never the argument: paths are literal, a folder is its changed files, one by one,
    // and nothing is ever diffed unscoped.
    const touched = (this.provenance()?.files_touched ?? []).map((f) => (typeof f === "string" ? f : f?.path)).filter((f) => typeof f === "string");
    const allowed = (rel) => !readRefusal(this.root, this.cfg.run_id, rel);
    const git = ["-C", this.root, "--literal-pathspecs"];
    let files;
    if (path) {
      const r = this.readable(path);
      if (r.error) {
        // A file the run deleted no longer exists: it is shown when the run touched it and the rule allows it.
        const rel = typeof path === "string" ? relative(this.root, resolve(this.root, path)).split(sep).join("/") : "";
        if (!/does not exist/.test(r.error) || !touched.includes(rel)) return { error: r.error };
        const refusal = readRefusal(this.root, this.cfg.run_id, rel);
        if (refusal) return { error: refusal };
        files = [rel];
      } else if (statSync(r.abs).isDirectory()) {
        const names = spawnSync("git", [...git, "diff", "--name-only", "--relative", "-z", head, "--", r.rel || "."], { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 20_000_000 });
        if (names.status !== 0) return { error: `git could not list the changes under ${path}: ${(names.stderr ?? "").trim()}` };
        files = names.stdout.split("\0").filter(Boolean).filter(allowed);
      } else {
        files = [r.rel.split(sep).join("/")];
      }
    } else {
      files = touched.filter(allowed);
    }
    if (!files.length) return { result: "nothing to show: no changed file here is one the read rule lets you see" };
    return this.fixed("git", [...git, "diff", head, "--", ...files], this.root);
  }

  /**
   * One of the run's declared file checks, in its check form only (never its fix form): a check of the plan the
   * person approved at Gate 2, run as the engine runs checks (lib/change-spec.mjs runFileCheck): no vendor
   * credentials, the person's deny rules, the whole process group stopped at the limit.
   */
  async run_file_check({ path, check_id }) {
    const r = this.readable(path);
    if (r.error) return { error: r.error };
    let header;
    try { header = JSON.parse(readFileSync(join(this.root, this.cfg.output_dir, "change-spec.json"), "utf8")); } catch { return { error: "this run has no change-spec.json" }; }
    const check = (header.file_checks ?? header.header?.file_checks ?? []).find((c) => c.id === check_id);
    if (!check) return { error: `no file check '${check_id}' in this run's spec` };
    const ran = await runFileCheck(this.root, check, r.rel.split(sep).join("/"), MAX_RESULT_CHARS);
    if (ran.refused) return { error: ran.refused };
    return { result: cut(`${ran.verdict}\n${ran.output}`) };
  }

  run_dependency_audit({ kind }) {
    const cwd = this.cfg.code_dir ? join(this.root, this.cfg.code_dir) : this.root;
    const commands = { "npm-audit": ["npm", ["audit", "--omit=dev", "--json"]], "npm-outdated": ["npm", ["outdated", "--json"]], "pip-outdated": ["pip", ["list", "--outdated", "--format=json"]] };
    const c = commands[kind];
    if (!c) return { error: `kind is one of ${Object.keys(commands).join(", ")}` };
    return this.fixed(c[0], c[1], cwd);
  }

  fixed(cmd, args, cwd) {
    const res = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 20_000_000 });
    if (res.error) return { error: `${cmd} could not run: ${res.error.message}` };
    return { result: cut(`exit ${res.status}\n${res.stdout ?? ""}${res.stderr ? `\n${res.stderr}` : ""}`) };
  }

  /** The review: Markdown for the security reviewer; the findings JSON for the senior reviewer, in the shape the repair stage reads. */
  write_review({ content }) {
    if (typeof content !== "string" || !content.trim()) return { error: "content is empty" };
    const security = this.cfg.role.includes("security");
    const rel = security ? this.cfg.outputs.security_review : this.cfg.outputs.review;
    if (!security) {
      let review;
      try { review = JSON.parse(content); } catch (e) { return { error: `the review is JSON (an object with a findings array): ${e.message}` }; }
      if (!review || typeof review !== "object" || !Array.isArray(review.findings)) return { error: "the review needs a findings array (empty when there is nothing to fix)" };
      const bad = review.findings.map((f, i) => (f && typeof f.file === "string" && f.file && typeof f.issue === "string" ? null : `findings[${i}] needs file and issue`)).filter(Boolean);
      if (bad.length) return { error: bad.join("\n") };
    }
    this.own(rel, content);
    this.accepted.set("review", true);
    return { result: `wrote ${rel}` };
  }

  baseline_status() {
    return this.fixed(process.execPath, [join(HERE, "discovery-refresh.mjs"), "--baseline", ".sdlc/baseline/current.json"], this.root);
  }

  /** Discovery's four files: the run's discovery.md and baseline.json, and the project baseline beside them. */
  write_discovery({ name, content }) {
    const where = { "discovery.md": join(this.cfg.output_dir, "discovery.md"), "baseline.json": join(this.cfg.output_dir, "baseline.json"), "baseline/current.json": join(".sdlc", "baseline", "current.json"), "baseline/discovery.md": join(".sdlc", "baseline", "discovery.md") };
    const rel = where[name];
    if (!rel) return { error: `name is one of ${Object.keys(where).join(", ")}` };
    if (typeof content !== "string" || !content.trim()) return { error: "content is empty" };
    if (name.endsWith(".json")) { try { JSON.parse(content); } catch (e) { return { error: `${name} is not valid JSON: ${e.message}` }; } }
    this.own(rel, content);
    this.accepted.set(`discovery:${name}`, true);
    return { result: `wrote ${rel}` };
  }

  /** What the step still owes. The step is done only when this is empty. */
  missing() {
    const role = this.cfg.role;
    if (role === "requirements") return this.accepted.has("requirements") ? [] : ["requirements.md (write_requirements)"];
    if (role === "discovery") return ["discovery.md", "baseline.json"].filter((n) => !this.accepted.has(`discovery:${n}`)).map((n) => `the run's ${n} (write_discovery)`);
    if (role.endsWith("reviewer")) return this.accepted.has("review") ? [] : ["the review (write_review)"];
    const out = [];
    if (!this.accepted.has("header.json")) out.push("header.json, accepted");
    if (![...this.accepted.keys()].some((k) => k.startsWith("units-"))) out.push("at least one units file, accepted");
    for (const [name, lines] of this.refused) out.push(`${name} was refused: ${lines.slice(0, 3).join("; ")}`);
    if (role === "architect" && !this.accepted.has("finalize")) out.push("finalize, after every section is accepted");
    return out;
  }

  status() {
    const missing = this.missing();
    return { result: JSON.stringify({ done: missing.length === 0, missing, accepted: [...this.accepted.keys()], written: [...this.written] }) };
  }

  async call(op, args) {
    const allowed = new Set([...READ_TOOLS, ...(ROLE_TOOLS[this.cfg.role] ?? []), "status"]);
    if (!allowed.has(op)) return { error: `${op} is not a tool of the ${this.cfg.role} step` };
    try { return await this[op](args ?? {}); } catch (e) { return { error: e?.message ?? String(e) }; }
  }
}

async function main(argv) {
  const at = argv.indexOf("--config");
  if (at < 0 || !argv[at + 1]) { process.stderr.write("usage: thinking-tools.mjs --config <file>\n"); return 2; }
  const tools = new ThinkingTools(JSON.parse(readFileSync(argv[at + 1], "utf8")));
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ id: null, ok: false, error: "not JSON" }) + "\n"); continue; }
    const r = await tools.call(msg.op, msg.args);
    process.stdout.write(JSON.stringify(r.error !== undefined ? { id: msg.id, ok: false, error: r.error } : { id: msg.id, ok: true, result: r.result }) + "\n");
  }
  return 0;
}

const invokedDirectly = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? "")).href === import.meta.url; } catch { return false; } })();
if (invokedDirectly) main(process.argv.slice(2)).then((code) => process.exit(code));
