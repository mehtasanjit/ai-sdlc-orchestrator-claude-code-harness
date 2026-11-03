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
 * {id, ok: false, error}, and {id, ok: false, error, setup: true} when the step's own setup keeps a hand-in from being
 * checked (nothing Gemini could fix: the worker stops the step on it). Started with --config <file>, a JSON object
 * written by the server (src/thinking.ts).
 */
import { spawnSync } from "node:child_process";
import v8 from "node:v8";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { deniedBy } from "./ambient/lib/bash-rules.mjs";
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
// A search pattern is the model's: it is compiled for V8's linear-time engine (the `l` flag), so no pattern can hold the
// tool process, and with it the step, by backtracking (review: `(\w+\s*)+:` ran past 30 s, `^(a+)+$` doubles per
// character). A pattern that engine cannot run in bounded time (a back-reference, a look-ahead) is refused.
v8.setFlagsFromString("--enable-experimental-regexp-engine");

/** What each role must hand in before its step is done, and the hand-in tools it gets. */
export const ROLE_TOOLS = {
  requirements: ["write_requirements"],
  architect: ["submit_section", "finalize", "registry_versions", "write_acceptance_fix"],
  "brownfield-architect": ["write_section"],
  "senior-reviewer": ["env_keys", "write_review"],
  "brownfield-senior-reviewer": ["git_diff", "read_provenance", "run_file_check", "env_keys", "write_review"],
  "security-reviewer": ["run_dependency_audit", "env_keys", "write_review"],
  "brownfield-security-reviewer": ["git_diff", "read_provenance", "run_file_check", "run_dependency_audit", "env_keys", "write_review"],
  discovery: ["baseline_status", "write_discovery"],
};
export const READ_TOOLS = ["read_file", "list_files", "search_files"];

// An acceptance fix answers the acceptance stage; the approved spec stays as the code was typed from it. The architect's
// tools are the same in every call (a conversation carried on keeps its tools), and refuse what the call is not for.
const ACCEPTANCE_FIX_ONLY = "this step is an acceptance fix: hand in its answer with write_acceptance_fix; it changes no spec section";

const cut = (s) => (s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n[cut at ${MAX_RESULT_CHARS} characters: read the rest by line range]` : s);

/** A JSON value as text with every object's keys in order, so the same content compares equal however its keys were typed. */
const canonical = (value) => JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

export class ThinkingTools {
  /**
   * cfg: {role, project_root, run_id, intent, output_dir (relative to project_root), outputs: {requirements,
   * sections_dir, review, security_review, discovery}, spec_dir, requirements_path, code_dir, run_token (the token the
   * spec store knows the run's pre-flight by), revise (the step answers a gate's changes), acceptance_fix (the
   * architect answers the acceptance stage)}
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.root = realpathSync(cfg.project_root);
    this.accepted = new Map();
    this.refused = new Map();
    this.written = new Set();
    // What the step starts from, read once before its first tool runs (loadAccepted); on a revise, the id of the spec
    // it answers.
    this.loading = null;
    this.revised = undefined;
  }

  /**
   * What this step had handed in and had accepted before this process started, so a step called again in the same run
   * (its worker stopped, the server restarted) resumes from it instead of owing it again: for the greenfield architect,
   * this run's spec as the spec store holds it on disk, the record the Claude architect resumes from too. Its header
   * counts as handed in, and so does each units file of the step whose every unit the spec holds as the file stands.
   * Only the spec this run's pre-flight opened counts (runSpec): a run started again with a new preflight_dispatch has a
   * new run token, so its header opens a new spec and its whole spec goes again, at full cost. That is by design: the
   * token is what keeps one run's units out of another run's spec. finalize is never carried over: each call ends with
   * its own, which checks the spec against the requirements as they are then.
   */
  async loadAccepted() {
    if (this.cfg.role !== "architect" || this.cfg.acceptance_fix) return;
    const { specStore } = await loadServerLib();
    const specDir = join(this.root, this.cfg.spec_dir);
    // A revise answers the finalized spec in the folder as it starts, and hands in a new one: that spec is never resumed.
    if (this.cfg.revise && existsSync(join(specDir, "spec.json"))) this.revised = specStore.openedSpec(specDir)?.id;
    const held = await this.runSpec();
    if (!held) return;
    this.accepted.set("header.json", true);
    const sections = join(this.root, this.cfg.outputs.sections_dir);
    for (const name of existsSync(sections) ? readdirSync(sections).filter((f) => /^units-\d{3}\.json$/.test(f)).sort() : []) {
      const loaded = specStore.readSectionFile(specDir, relative(specDir, join(sections, name)), "units");
      if (!loaded.error && held.holds(loaded.value)) this.accepted.set(name, true);
    }
  }

  /**
   * The spec this run is writing in spec_dir, as the store holds it, or null when there is none of this run's: none yet,
   * another run's (its pre-flight's token differs), no run token to tell, or, on a revise, the spec the revise answers
   * (it hands in a new spec; the approved one counts only through approvedUnits), until its header opens that new one.
   * `holds(units)`: whether every one of these units is in it exactly as given.
   */
  async runSpec() {
    if (!this.cfg.run_token) return null;
    const { specStore } = await loadServerLib();
    const specDir = join(this.root, this.cfg.spec_dir);
    const opened = specStore.openedSpec(specDir);
    if (opened?.run !== this.cfg.run_token || (this.revised !== undefined && opened.id === this.revised)) return null;
    const stored = new Map(specStore.storedUnits(specDir).map((u) => [u.id, canonical(u)]));
    return { holds: (units) => Array.isArray(units) && units.length > 0 && units.every((u) => u && typeof u === "object" && stored.get(u.id) === canonical(u)) };
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
    // A named pipe, a socket or a device would hold the read, and the step, until something writes to it.
    if (!st.isFile()) return { error: `${path} is not a regular file` };
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
    if (typeof pattern !== "string" || pattern === "") return { error: "give a regular expression to search for" };
    let re;
    try { re = new RegExp(pattern, "l"); } catch (e) {
      try { new RegExp(pattern); } catch (e2) { return { error: `not a regular expression: ${e2.message}` }; }
      return { error: "this pattern cannot be searched in bounded time (a back-reference or a look-ahead): search for it without one" };
    }
    const start = this.readable(path);
    if (start.error) return { error: start.error };
    const hits = [];
    // What the walk passed over is said, never silent (review: a key under src/coverage was not found, and one
    // unreadable file failed the whole search): a skipped folder can be searched by naming it as the path.
    const skipped = [];
    const unread = [];
    const walk = (abs, rel) => {
      if (hits.length >= MAX_SEARCH_HITS) return;
      let st;
      try { st = lstatSync(abs); } catch { return; }
      if (st.isSymbolicLink()) return;
      const posix = rel.split(sep).join("/");
      if (posix && readRefusal(this.root, this.cfg.run_id, posix)) return;
      if (st.isDirectory()) {
        let names;
        try { names = readdirSync(abs).sort(); } catch { unread.push(`${posix || "."}/`); return; }
        for (const name of names) {
          const child = rel ? join(rel, name) : name;
          if (WALK_SKIP.has(name)) { try { if (lstatSync(join(abs, name)).isDirectory()) skipped.push(child.split(sep).join("/")); } catch {} continue; }
          walk(join(abs, name), child);
        }
        return;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
      let text;
      try { text = readFileSync(abs, "utf8"); } catch { unread.push(posix); return; }
      if (text.includes("\u0000") || holdsPrivateKey(text)) return;
      text.split("\n").forEach((line, i) => { if (hits.length < MAX_SEARCH_HITS && re.test(line)) hits.push(`${posix}:${i + 1}: ${line.slice(0, 300)}`); });
    };
    walk(start.abs, start.rel === "" ? "" : start.rel);
    const notes = [
      ...(hits.length >= MAX_SEARCH_HITS ? [`[first ${MAX_SEARCH_HITS} matches only: narrow the pattern or the path]`] : []),
      ...(skipped.length ? [`[not searched, as dependency, tool or cache folders (name one as the path to search it): ${skipped.slice(0, 20).join(", ")}${skipped.length > 20 ? ` and ${skipped.length - 20} more` : ""}]`] : []),
      ...(unread.length ? [`[could not read: ${unread.slice(0, 20).join(", ")}${unread.length > 20 ? ` and ${unread.length - 20} more` : ""}]`] : []),
    ];
    return { result: cut([hits.join("\n"), ...notes].filter(Boolean).join("\n")) };
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

  /**
   * A section hand-in's verdict, as status reads it, the same for both architects: an accepted section clears an
   * earlier refusal of that name, and a refused one (its check's problems, or JSON that does not parse) is owed until a
   * hand-in of that name is accepted. Review: the greenfield architect's refusals were never kept, so a step whose
   * units file was refused finalized without it and was done.
   */
  verdict(name, ok, lines = []) {
    if (ok) { this.accepted.set(name, true); this.refused.delete(name); } else { this.accepted.delete(name); this.refused.set(name, lines); }
  }

  /** A refused section: kept as owed, and answered with `text` (its problems, one per line, by default). */
  refuse(name, lines, text = `refused:\n${lines.join("\n")}`) {
    this.verdict(name, false, lines);
    return { error: text };
  }

  /** Brownfield: the change spec's section, checked by plan-lint's own checkSection. */
  async write_section({ name, json }) {
    const n = this.sectionName(name);
    if (n.error) return { error: n.error };
    try { JSON.parse(json); } catch (e) { const why = `${name} is not valid JSON: ${e.message}`; return this.refuse(name, [why], why); }
    this.own(n.rel, json);
    const { checkSection } = await import(pathToFileURL(join(HERE, "plan-lint.mjs")).href);
    // No command the model wrote runs here, and none of its output comes back: the checks wait for dispatch, after
    // the person approves the plan at Gate 2 (lib/change-spec.mjs baselineErrors).
    const r = await checkSection(this.root, this.cfg.run_id, n.rel, { intent: this.cfg.intent, runCommands: false });
    // A usage error is the step's own setup, not the section: a run id or run folder plan-lint cannot use, a job that is
    // not the run's, a section outside the run's folder. Gemini cannot fix any of them, so it is answered as a setup
    // error, on which the worker stops the step, never as a refusal to fix (review: Gemini was sent such errors to fix).
    if (r.usage) return { error: `plan-lint could not check ${n.rel.split(sep).join("/")}: ${r.lines.join("; ")}`, setup: true };
    if (!r.ok) return this.refuse(name, r.lines);
    this.verdict(name, true);
    return { result: r.lines.join("\n") };
  }

  /**
   * Greenfield: the build spec's section, handed to the spec store as submit_spec_section does. The name alone hands in
   * the section file as it stands, as submitting the same file again does there: a revise sends every units file again,
   * and an unchanged one need not be typed out again.
   */
  async submit_section({ name, json }) {
    if (this.cfg.acceptance_fix) return { error: ACCEPTANCE_FIX_ONLY };
    const n = this.sectionName(name);
    if (n.error) return { error: n.error };
    if (json === undefined || json === "") {
      if (!existsSync(join(this.root, n.rel))) return { error: `no ${name} was handed in for this spec: hand it in with its JSON` };
    } else {
      try { JSON.parse(json); } catch (e) { const why = `${name} is not valid JSON: ${e.message}`; return this.refuse(name, [why], why); }
      this.own(n.rel, json);
    }
    const { specStore } = await loadServerLib();
    const specDir = join(this.root, this.cfg.spec_dir);
    const kind = name === "header.json" ? "header" : "units";
    const loaded = specStore.readSectionFile(specDir, relative(specDir, join(this.root, n.rel)), kind);
    if (loaded.error) return this.refuse(name, [loaded.error], loaded.error);
    // A units file handed in again as this run's spec already holds it (the step called again in the same run, its
    // earlier hand-ins on disk) is accepted as unchanged; one with a changed or new unit goes to the store, which
    // refuses an id it already holds (review: the same units sent again were refused as duplicates, so a step called
    // again could never be done).
    if (kind === "units" && (await this.runSpec())?.holds(loaded.value)) {
      this.verdict(name, true);
      return { result: `accepted ${name}: unchanged, its ${loaded.value.length} unit(s) already in the spec` };
    }
    // With the run's token, as submit_spec_section sends it: a new run's header opens a new spec, and units go only
    // into the spec this run opened.
    const r = specStore.submitSpecSection(specDir, kind === "header" ? { section: "header", header: loaded.value } : { section: "units", units: loaded.value }, this.cfg.run_token ? { run: this.cfg.run_token } : {});
    if (!r.ok) return this.refuse(name, r.errors.map((e) => `${e.path} ${e.message}`));
    // A header that opened a new spec moved the earlier one aside, its units with it: none of them is in this spec.
    if (r.previous) for (const k of [...this.accepted.keys()]) if (/^units-\d{3}\.json$/.test(k)) this.accepted.delete(k);
    this.verdict(name, true);
    this.accepted.delete("finalize");
    return { result: `accepted ${name}: ${r.total_units} unit(s) in the spec` };
  }

  /**
   * On a design revise, the units of the spec the person reviewed: the newest spec this run finalized, still in the
   * folder or moved aside by the revise's header. None when the step answers no revise, or this run finalized none.
   */
  approvedUnits(specStore) {
    if (this.cfg.role !== "architect" || !this.cfg.revise) return [];
    const specDir = join(this.root, this.cfg.spec_dir);
    const previous = join(specDir, specStore.PREVIOUS_DIR);
    // Newest first: each folder under previous/ is named by the time its spec was moved aside.
    const folders = [specDir, ...(existsSync(previous) ? readdirSync(previous).sort().reverse().map((d) => join(previous, d)) : [])];
    for (const f of folders) {
      if (!existsSync(join(f, "spec.json")) || specStore.openedSpec(f)?.run !== this.cfg.run_token) continue;
      return JSON.parse(readFileSync(join(f, "spec.json"), "utf8")).units.map((u) => ({ id: u.id, path: u.path }));
    }
    return [];
  }

  /**
   * The approved spec's units the spec being written does not hold. A header after finalize opens a new spec, so a
   * revise that hands in only what changed would finalize without the rest (review: an approved unit was dropped).
   */
  unaccounted(specStore) {
    const approved = this.approvedUnits(specStore);
    if (!approved.length) return [];
    const held = new Set(specStore.storedUnits(join(this.root, this.cfg.spec_dir)).map((u) => u.id));
    return approved.filter((u) => !held.has(u.id));
  }

  /**
   * `drop`: on a revise, the approved spec's units the changes remove, by id; every other approved unit must be in. A
   * refusal lists every problem the store finds, the requirements no unit covers among them.
   */
  async finalize({ drop } = {}) {
    if (this.cfg.acceptance_fix) return { error: ACCEPTANCE_FIX_ONLY };
    const { specStore } = await loadServerLib();
    const gone = this.unaccounted(specStore);
    const dropped = Array.isArray(drop) ? drop.map(String) : [];
    const notGone = dropped.filter((id) => !gone.some((u) => u.id === id));
    if (notGone.length) return { error: `drop names only units of the approved spec that this spec leaves out; not one of them: ${notGone.join(", ")}` };
    const owed = gone.filter((u) => !dropped.includes(u.id));
    if (owed.length) {
      return { error: `the approved spec's ${owed.map((u) => `${u.id} (${u.path})`).join(", ")} ${owed.length === 1 ? "is" : "are"} not in this spec: hand each one's units file in again (by its name alone if unchanged), or name the ones the changes remove in drop; then finalize again` };
    }
    const r = specStore.finalizeSpec(join(this.root, this.cfg.spec_dir), this.cfg.requirements_path ? join(this.root, this.cfg.requirements_path) : undefined);
    if (r.ok) { this.accepted.set("finalize", true); return { result: `finalized: ${r.units} unit(s); design.md rendered${dropped.length ? `; removed from the approved spec: ${dropped.join(", ")}` : ""}` }; }
    // Every problem in one answer, one line each with where it is, as a section refusal lists them and as finalize_spec
    // answers the Claude architect (review: a coverage gap hid the store's other errors, each then found a round later).
    const lines = [
      ...(r.missing_coverage?.length ? [`/units no unit covers ${r.missing_coverage.join(", ")}: hand in a units file that covers them`] : []),
      ...(r.errors ?? []).map((e) => `${e.path} ${e.message}`),
    ];
    return { error: `refused:\n${lines.join("\n")}` };
  }

  /**
   * An acceptance fix's answer, as the architect's instructions say to reply it: the failures entries for a repair
   * round, checked against the entry execute_stage repair declares (REPAIR_FAILURE_SCHEMA), or the one line why the
   * brief's fixed stack cannot pass.
   */
  async write_acceptance_fix({ failures_json, cannot_pass }) {
    if (!this.cfg.acceptance_fix) return { error: "only an acceptance fix hands in write_acceptance_fix: this step hands in the spec's sections" };
    const given = (v) => typeof v === "string" && v !== "";
    if (given(failures_json) === given(cannot_pass)) return { error: "hand in exactly one of failures_json or cannot_pass" };
    let answer;
    if (given(cannot_pass)) {
      if (/[\r\n]/.test(cannot_pass) || !cannot_pass.trim()) return { error: "cannot_pass is one line: why the brief's fixed stack cannot pass" };
      answer = { cannot_pass: cannot_pass.trim() };
    } else {
      let entries;
      try { entries = JSON.parse(failures_json); } catch (e) { return { error: `failures_json is not valid JSON: ${e.message}` }; }
      const { specSchema } = await loadServerLib();
      const errors = specSchema.validate({ type: "array", minItems: 1, items: specSchema.REPAIR_FAILURE_SCHEMA }, entries);
      if (errors.length) return { error: `refused:\n${errors.map((e) => `${e.path} ${e.message}`).join("\n")}` };
      answer = { failures: entries };
    }
    this.own(this.cfg.outputs.acceptance_fix, JSON.stringify(answer, null, 2));
    this.accepted.set("acceptance_fix", true);
    const n = answer.failures?.length;
    return { result: answer.failures ? `accepted: ${n} failures ${n === 1 ? "entry" : "entries"} for a repair round` : "accepted: the criterion is reported as failed, with that line" };
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
        const shown = `git diff --name-only ${head} -- ${r.rel || "."}`;
        const rule = deniedBy(shown, this.root);
        if (rule) return { error: `\`${shown}\` was not run: the person's Claude settings deny it (${rule})` };
        const names = spawnSync("git", [...git, "diff", "--name-only", "--relative", "-z", head, "--", r.rel || "."], { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 20_000_000 });
        if (names.status !== 0) return { error: `git could not list the changes under ${path}: ${(names.stderr ?? "").trim()}` };
        // A folder's files the run created are its changes too, and git diff lists none of them (they are not tracked).
        const created = touched.filter((f) => f.startsWith(r.rel ? `${r.rel.split(sep).join("/")}/` : ""));
        files = [...new Set([...names.stdout.split("\0").filter(Boolean), ...created])].filter(allowed);
      } else {
        files = [r.rel.split(sep).join("/")];
      }
    } else {
      files = touched.filter(allowed);
    }
    if (!files.length) return { result: "nothing to show: no changed file here is one the read rule lets you see" };
    // As the reviewers' own command runs it (git diff --ignore-cr-at-eol <git_head_before> -- <files>). A file the run
    // created is not tracked, and git diff shows nothing for it (review: a new endpoint's code never reached the
    // reviewer), so each such file is shown whole, as a diff from nothing.
    const tracked = new Set(this.gitLines(["ls-files", "-z", "--", ...files]));
    const created = files.filter((f) => !tracked.has(f) && existsSync(join(this.root, f)));
    const old = files.filter((f) => !created.includes(f));
    const parts = [];
    if (old.length) {
      const d = this.fixed("git", [...git, "diff", "--ignore-cr-at-eol", head, "--", ...old], this.root, `git diff --ignore-cr-at-eol ${head} -- ${old.join(" ")}`);
      if (d.error) return d;
      parts.push(d.result);
    }
    for (const f of created) {
      const shown = `git diff --no-index --ignore-cr-at-eol -- /dev/null ${f}`;
      const rule = deniedBy(shown, this.root);
      if (rule) return { error: `\`${shown}\` was not run: the person's Claude settings deny it (${rule})` };
      // --no-index answers 1 when the two differ, which a new file always does.
      const res = spawnSync("git", [...git, "diff", "--no-index", "--ignore-cr-at-eol", "--", "/dev/null", f], { cwd: this.root, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 20_000_000 });
      if (res.error || (res.status !== 0 && res.status !== 1)) return { error: `git could not show the new file ${f}: ${(res.stderr ?? res.error?.message ?? "").trim()}` };
      parts.push(`(created by the run)\n${res.stdout}`);
    }
    return { result: cut(parts.join("\n")) };
  }

  /** The NUL-separated lines a read-only git command prints in the project, or none when it cannot answer. */
  gitLines(args) {
    const r = spawnSync("git", ["-C", this.root, "--literal-pathspecs", ...args], { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 20_000_000 });
    return r.status === 0 ? (r.stdout ?? "").split("\0").filter(Boolean) : [];
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

  /**
   * One of the step's fixed commands, run only if the person's own Claude settings allow it: their Bash deny rules
   * refuse it here as plan-lint and the hooks refuse a command (lib/bash-rules.mjs), matched against `shown`, the
   * command as a person types it. Review: only run_file_check honoured the rules, and zero-touch approves a thinking
   * step's call without seeing any command, so the others ran whatever the person had denied.
   */
  fixed(cmd, args, cwd, shown = [cmd, ...args].join(" ")) {
    const rule = deniedBy(shown, this.root);
    if (rule) return { error: `\`${shown}\` was not run: the person's Claude settings deny it (${rule})` };
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
  async missing() {
    const role = this.cfg.role;
    if (role === "requirements") return this.accepted.has("requirements") ? [] : ["requirements.md (write_requirements)"];
    if (role === "discovery") return ["discovery.md", "baseline.json"].filter((n) => !this.accepted.has(`discovery:${n}`)).map((n) => `the run's ${n} (write_discovery)`);
    if (role.endsWith("reviewer")) return this.accepted.has("review") ? [] : ["the review (write_review)"];
    if (role === "architect" && this.cfg.acceptance_fix) return this.accepted.has("acceptance_fix") ? [] : ["the acceptance fix: its failures entries, or the one line why it cannot pass (write_acceptance_fix)"];
    const out = [];
    if (!this.accepted.has("header.json")) out.push("header.json, accepted");
    if (![...this.accepted.keys()].some((k) => k.startsWith("units-"))) out.push("at least one units file, accepted");
    for (const [name, lines] of this.refused) out.push(`${name} was refused: ${lines.slice(0, 3).join("; ")}`);
    if (role === "architect") {
      const { specStore } = await loadServerLib();
      for (const u of this.unaccounted(specStore)) out.push(`${u.id} (${u.path}) of the approved spec, not in this spec yet: hand its units file in again (by its name alone if unchanged), or name it in finalize's drop if the changes remove it`);
      if (!this.accepted.has("finalize")) out.push("finalize, after every section is accepted");
    }
    return out;
  }

  async status() {
    const missing = await this.missing();
    return { result: JSON.stringify({ done: missing.length === 0, missing, accepted: [...this.accepted.keys()], written: [...this.written] }) };
  }

  async call(op, args) {
    const allowed = new Set([...READ_TOOLS, ...(ROLE_TOOLS[this.cfg.role] ?? []), "status"]);
    if (!allowed.has(op)) return { error: `${op} is not a tool of the ${this.cfg.role} step` };
    try {
      await (this.loading ??= this.loadAccepted());
      return await this[op](args ?? {});
    } catch (e) { return { error: e?.message ?? String(e) }; }
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
    process.stdout.write(JSON.stringify(r.error !== undefined ? { id: msg.id, ok: false, error: r.error, ...(r.setup ? { setup: true } : {}) } : { id: msg.id, ok: true, result: r.result }) + "\n");
  }
  return 0;
}

const invokedDirectly = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? "")).href === import.meta.url; } catch { return false; } })();
if (invokedDirectly) main(process.argv.slice(2)).then((code) => process.exit(code));
