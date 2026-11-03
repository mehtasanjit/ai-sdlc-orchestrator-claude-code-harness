/**
 * Shared pieces for the tests that run the three Python workers (worker/typist_worker.py, worker/gemini_worker.py,
 * worker/thinking_worker.py) against the scripted stand-in SDK in test/fixtures/agy-standin: no harness, no Google,
 * $0. Not a test file itself (node --test runs test/*.test.mjs only).
 *
 * A test writes a script of what each model call sends back (recorded 0.1.22 sequences from
 * fixtures/agy-standin/recorded.json where one exists), runs a worker with it, and reads what the worker wrote (its
 * receipt or usage sidecar), what it asked of the SDK (the stand-in's log: sessions, locations, retry settings,
 * chat() messages, cancel() calls) and the heartbeat lines it printed on stderr: `beats`, each with the time this
 * process read it, and `sent`, each with the time the worker wrote it. A test that times a heartbeat, or puts it before
 * or after something the worker did, uses `sent`: its "mono" is the worker's own time.monotonic(), the clock of the
 * stand-in's other events, while the time a line is read is later by however long a busy machine takes to get to it.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const STANDIN = join(HERE, "fixtures", "agy-standin");
export const RECORDED = JSON.parse(readFileSync(join(STANDIN, "recorded.json"), "utf8"));
export const TYPIST_WORKER = join(HERE, "..", "worker", "typist_worker.py");
export const AGENT_WORKER = join(HERE, "..", "worker", "gemini_worker.py");
export const THINKING_WORKER = join(HERE, "..", "worker", "thinking_worker.py");
const THINKING_TOOLS = join(HERE, "..", "..", "..", "scripts", "thinking-tools.mjs");

/** The first Python 3.10 or newer on PATH: the workers' own minimum (google-antigravity requires it). */
export const PYTHON = ["python3", "python3.13", "python3.12", "python3.11", "python3.10"].find(
  (p) => spawnSync(p, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"]).status === 0,
);
export const NO_PYTHON = PYTHON ? false : "no Python 3.10 or newer on this machine";
/** The sleep cases read macOS clocks (CLOCK_UPTIME_RAW does not count sleep there); elsewhere they are skipped. */
export const NOT_MACOS = process.platform === "darwin" ? false : "the computer-asleep reading uses macOS clocks";

/** A FINISH-only typist's usage, as the 0.1.22 harness reports a one-call answer. */
export const TYPIST_USAGE = { prompt_token_count: 1200, cached_content_token_count: 0, candidates_token_count: 300, thoughts_token_count: 40, total_token_count: 1540, service_tier: "standard" };

/** Step updates in the shapes 0.1.22 yields them (recorded.json has whole recorded sequences). */
export const step = {
  user: (text = "Write the file.") => ({ type: "TEXT_RESPONSE", source: "USER", status: "DONE", content: text, content_delta: text }),
  error: (http_code, error = `Error ${http_code}`) => ({ type: "TEXT_RESPONSE", source: "SYSTEM", status: "ERROR", target: "TARGET_USER", http_code, error, content: error }),
  text: (delta, status = "ACTIVE", extra = {}) => ({ type: "TEXT_RESPONSE", source: "MODEL", status, target: "TARGET_USER", content: delta, content_delta: status === "DONE" ? "" : delta, ...extra }),
  thinking: (delta, status = "ACTIVE") => ({ type: "THINKING", source: "MODEL", status, target: "TARGET_USER", thinking_delta: status === "DONE" ? "" : delta }),
  tool: (name, status, args = {}, id = `${name}-1`) => ({ type: "TOOL_CALL", source: "MODEL", status, target: "TARGET_ENVIRONMENT", content: "Tool execution", tool_calls: [{ name, args, id }] }),
};

/** The recorded 429 retry sequence's texts (e06): a retried refusal, and the harness giving up. */
const R429 = RECORDED.refused_429_six_retries.events;
export const TEXT_429_RETRY = R429[1].step.error;
export const TEXT_429_UNREACHABLE = R429[R429.length - 2].step.error;
export const RAISE_429_UNREACHABLE = R429[R429.length - 1];

/** A recorded sequence, its times scaled by `factor` and moved by `offset` seconds. */
export function recorded(name, { factor = 1, offset = 0 } = {}) {
  return RECORDED[name].events.map((e) => ({ ...e, at: Math.round(((e.at ?? 0) * factor + offset) * 1000) / 1000 }));
}

/**
 * A typist's answer as the harness reports it: the finish tool call whose output_string is the answer, the call's
 * usage, the harness's closing text, the end of the turn.
 */
export function finishAnswer(at, answer = { path: "src/a.ts", content: "export const a = 1;\n" }, usage = TYPIST_USAGE) {
  const args = { output_string: JSON.stringify(answer) };
  return [
    { at, step: step.tool("finish", "ACTIVE", args, "finish-1") },
    { at, usage },
    { at, step: step.tool("finish", "DONE", args, "finish-1") },
    { at, step: step.text("Finished", "ACTIVE") },
    { at, step: step.text("Finished", "DONE", { is_complete_response: true }) },
    { at, end: true },
  ];
}

/** An agent's final text answer, with the call's usage and the end of the turn. */
export function textAnswer(at, text, usage) {
  return [
    { at, step: step.text(text, "ACTIVE") },
    ...(usage ? [{ at, usage }] : []),
    { at, step: step.text(text, "DONE", { is_complete_response: true }) },
    { at, end: true },
  ];
}

/** A request that is out and never answered: the user turn, then nothing until cancel(). */
export const held = (text = "Write the file.") => [{ at: 0, step: step.user(text) }, { at: 0, hold: true }];

const HEARTBEAT = /^@mmo-heartbeat (\{.*\})\s*$/;

/**
 * Runs one worker against `script` and collects what it left. `kind` is "typist" or "agent"; `args` are added to
 * the command line the engine built before the supervisor's flags (agyWorkerArgs, buildWorkerArgs); `killAfterMs` sends `killSignal` to the
 * worker that long after it started. Everything is in a scratch folder removed afterwards. Returns, besides what the
 * worker wrote: `beats` (heartbeats as read here), `sent` (heartbeats as written, on the worker's clock: {mono, wall,
 * hb}), and the stand-in's `log`.
 */
export async function runWorker(kind, { script, args = [], timeout = 30, env = {}, killAfterMs, killSignal = "SIGTERM", limitMs = 60_000, brief = "Write src/a.ts.", answerSchema, role = "requirements", outputs = { requirements: "out/requirements.md" } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `agy-${kind}-`));
  try {
    const work = join(dir, "work");
    mkdirSync(work);
    const scriptFile = join(dir, "script.json");
    const logFile = join(dir, "standin.jsonl");
    writeFileSync(scriptFile, JSON.stringify(script ?? {}));
    let argv;
    const out = join(dir, kind === "typist" ? "receipt.json" : "usage.json");
    if (kind === "typist") {
      writeFileSync(join(dir, "brief.md"), brief);
      writeFileSync(join(dir, "shared.txt"), "");
      const schema = join(dir, "schema.json");
      writeFileSync(schema, JSON.stringify(answerSchema ?? { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }));
      argv = [TYPIST_WORKER, "--brief-file", join(dir, "brief.md"), "--system-file", join(dir, "shared.txt"), "--answer-schema-file", schema,
        "--model", "gemini-3.8-flash", "--region", "global", "--workdir", work, "--out", out, "--thinking", "LOW", "--max-model-calls", "3",
        "--timeout", String(timeout), "--api-retries", "6", "--api-retry-initial-ms", "2000", ...args];
    } else if (kind === "thinking") {
      // A thinking step: the project is `work`, with the step's real tools (thinking-tools.mjs) over it.
      writeFileSync(join(dir, "task.md"), brief);
      mkdirSync(join(work, "out"), { recursive: true });
      const toolsConfig = join(dir, "tools.json");
      writeFileSync(toolsConfig, JSON.stringify({ role, project_root: work, run_id: "r1", output_dir: "out", outputs }));
      argv = [THINKING_WORKER, "--task-file", join(dir, "task.md"), "--model", "gemini-3.8-flash", "--region", "global", "--workdir", work,
        "--out-dir", dir, "--usage-file", out, "--role", role, "--tools-config", toolsConfig, "--save-dir", join(dir, "save"),
        "--summary-file", join(dir, "summary.json"), "--node", process.execPath, "--tools-script", THINKING_TOOLS,
        "--thinking", "NONE", "--timeout", String(timeout), ...args];
    } else {
      writeFileSync(join(dir, "task.md"), brief);
      argv = [AGENT_WORKER, "--task-file", join(dir, "task.md"), "--model", "gemini-3.8-flash", "--region", "global", "--workdir", work,
        "--out-dir", dir, "--usage-file", out, "--thinking", "NONE", "--timeout", String(timeout), ...args];
    }
    const childEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, TMPDIR: dir, LANG: "en_US.UTF-8",
      PYTHONPATH: STANDIN, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", AGY_STANDIN_SCRIPT: scriptFile, AGY_STANDIN_LOG: logFile,
      GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global", ...env,
    };
    const started = Date.now();
    const r = await new Promise((done) => {
      const child = spawn(PYTHON, argv, { env: childEnv, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", buf = "", limited = false;
      const beats = [];
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => {
        stderr += d;
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const m = line.match(HEARTBEAT);
          if (m) { try { beats.push({ atMs: Date.now() - started, wall: Date.now() / 1000, hb: JSON.parse(m[1]) }); } catch { beats.push({ atMs: Date.now() - started, wall: Date.now() / 1000, hb: null, line }); } }
        }
      });
      const kill = killAfterMs !== undefined ? setTimeout(() => { try { child.kill(killSignal); } catch { /* gone */ } }, killAfterMs) : null;
      const limit = setTimeout(() => { limited = true; try { child.kill("SIGKILL"); } catch { /* gone */ } }, limitMs);
      child.on("close", (code, signal) => { clearTimeout(limit); if (kill) clearTimeout(kill); done({ code, signal, stdout, stderr, beats, limited }); });
    });
    const read = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
    const log = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const sent = log.filter((e) => e.ev === "heartbeat").map((e) => {
      const m = e.line.match(HEARTBEAT);
      let hb = null;
      try { hb = m ? JSON.parse(m[1]) : null; } catch { /* a malformed line keeps hb null, as in beats */ }
      return { mono: e.mono, wall: e.wall, hb };
    });
    return { ...r, elapsedMs: Date.now() - started, startedWall: started / 1000, [kind === "typist" ? "receipt" : "sidecar"]: read(out), summary: read(join(dir, "summary.json")), log, sent, sessions: log.filter((e) => e.ev === "agent"), chats: log.filter((e) => e.ev === "chat"), cancels: log.filter((e) => e.ev === "cancel") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The last stderr lines without heartbeats, for an assertion's message. */
export const tail = (r) => `exit ${r.code}${r.signal ? ` (${r.signal})` : ""}${r.limited ? " (stopped by the test's limit)" : ""}; stderr: ${r.stderr.split("\n").filter((l) => !HEARTBEAT.test(l)).slice(-8).join(" | ").slice(-1200)}`;

/** The sum of the SDK usage readings, field by field, as the receipt's `usage` must be. */
export function sumUsage(...us) {
  const out = {};
  for (const u of us.filter(Boolean)) for (const [k, v] of Object.entries(u)) if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
  return out;
}
