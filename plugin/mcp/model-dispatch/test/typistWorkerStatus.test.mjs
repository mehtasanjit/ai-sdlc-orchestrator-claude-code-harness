/**
 * The agent door reports the vendor's HTTP status, as the other doors do: worker/typist_worker.py writes the status an
 * SDK error carries (google.genai's APIError `.code`, also when another error wraps it) into its receipt as
 * `error_status`, read from the error's own field and never from its words; and the agent typist (executor/typists.ts
 * AgyTypist) hands it on with its transport flag still false, because the SDK has already waited out its own retries.
 * The run-start probe then reads a 429 as a busy vendor and a 401 or 403 as a broken login, and a stage stops on a
 * refused login on this door as on the others. Offline: a stand-in SDK for the worker's Python, and a stand-in worker
 * for the typist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const WORKER = join(HERE, "..", "worker", "typist_worker.py");
const { AgyTypist } = await import(join(DIST, "executor", "typists.js"));

const PYTHON = ["python3", "python"].find((p) => spawnSync(p, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"]).status === 0);

/** A stand-in for the Antigravity SDK and google.genai's errors: the agent's chat raises what STUB_RAISE names. */
function standInSdk() {
  const dir = mkdtempSync(join(tmpdir(), "agy-sdk-stub-"));
  const pkg = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  pkg("google/__init__.py", "");
  pkg("google/genai/__init__.py", "");
  pkg("google/genai/errors.py", `class APIError(Exception):
    def __init__(self, code, response_json, response=None):
        self.code = code
        self.details = response_json
        super().__init__(f"{code} {response_json}")
class ClientError(APIError):
    pass
`);
  pkg("google/antigravity/types.py", `class _Any:
    def __init__(self, *a, **k): pass
    def __call__(self, *a, **k): return _Any()
    def __getattr__(self, name): return _Any()
def __getattr__(name): return _Any()
`);
  pkg("google/antigravity/hooks/__init__.py", "");
  pkg("google/antigravity/hooks/policy.py", "def allow_all():\n    return None\n");
  pkg("google/antigravity/__init__.py", `import os
from google.genai import errors
from google.antigravity.types import _Any
LocalAgentConfig = _Any
class _Conversation:
    total_usage = None
class Agent:
    def __init__(self, cfg):
        self.conversation = _Conversation()
    async def __aenter__(self):
        return self
    async def __aexit__(self, *a):
        return False
    async def chat(self, brief):
        mode = os.environ.get("STUB_RAISE", "")
        if mode == "client429":
            raise errors.ClientError(429, {"error": {"status": "RESOURCE_EXHAUSTED", "message": "Resource exhausted"}})
        if mode == "wrapped403":
            try:
                raise errors.APIError(403, {"error": {"status": "PERMISSION_DENIED"}})
            except Exception as e:
                raise RuntimeError("executor run failed") from e
        if mode == "code_attribute":
            e = ValueError("HTTP 429 in the words only")
            e.code = 429
            raise e
        raise RuntimeError("the session failed: 503 Service Unavailable")
`);
  return dir;
}

test("the worker writes the HTTP status an SDK error carries into its receipt, and only that", { skip: PYTHON ? false : "no python3 on this machine" }, () => {
  const sdk = standInSdk();
  const work = mkdtempSync(join(tmpdir(), "agy-worker-"));
  try {
    writeFileSync(join(work, "brief.md"), "Write the file.");
    const run = (mode) => {
      const out = join(work, `receipt-${mode}.json`);
      const r = spawnSync(PYTHON, [WORKER, "--brief-file", join(work, "brief.md"), "--model", "gemini-x", "--region", "global", "--workdir", work, "--out", out, "--timeout", "30"], {
        env: { ...process.env, PYTHONPATH: sdk, GOOGLE_CLOUD_PROJECT: "test-project", STUB_RAISE: mode }, encoding: "utf8", timeout: 30_000,
      });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(readFileSync(out, "utf8"));
    };
    const busy = run("client429");
    assert.equal(busy.error_status, 429);
    assert.match(busy.error, /ClientError/);
    assert.equal(run("wrapped403").error_status, 403, "the status of the SDK error another error wraps");
    assert.equal(run("code_attribute").error_status, undefined, "a .code on an error that is not the SDK's is no HTTP status");
    assert.equal(run("words_only").error_status, undefined, "a status in the words only is none");
  } finally {
    rmSync(sdk, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("the agent typist hands the receipt's status on, with its transport flag false", async () => {
  const fake = mkdtempSync(join(tmpdir(), "agy-typist-"));
  const saved = { p: process.env.GEMINI_WORKER_PYTHON, g: process.env.GOOGLE_CLOUD_PROJECT, l: process.env.GOOGLE_CLOUD_LOCATION };
  try {
    const py = join(fake, "python");
    const receipt = (fields) => JSON.stringify({ finish_output: null, usage: null, sdk_version: "0.1.16", tool_calls: [], error_type: "ClientError", ...fields }).replace(/'/g, "'\\''");
    const write = (fields) => writeFileSync(py, `#!/bin/sh
out=""; prev=""
for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; prev="$a"; done
printf '%s' '${receipt(fields)}' > "$out"
`);
    write({ error: "ClientError: 429 RESOURCE_EXHAUSTED", error_status: 429 });
    chmodSync(py, 0o755);
    process.env.GEMINI_WORKER_PYTHON = py;
    process.env.GOOGLE_CLOUD_PROJECT = "test-project";
    process.env.GOOGLE_CLOUD_LOCATION = "global";
    const typist = new AgyTypist({ id: "agy", adapter: "antigravity-worker", model_name: "gemini-3.8-flash" }, { effort: "LOW", maxModelCalls: 3, timeoutSec: 30, apiRetries: 0, apiRetryInitialMs: 1 });
    const shared = join(fake, "shared.txt");
    writeFileSync(shared, "");
    const req = { unit: { id: "u1", path: "a.txt" }, packet: { id: "u1", outputSchema: { type: "object" } }, framed: "brief", shared: "", sharedFile: shared, contract: "file", passId: "r" };
    const busy = await typist.type(req);
    assert.equal(busy.answer, null);
    assert.equal(busy.error_status, 429);
    assert.equal(busy.transport, false, "the SDK already waited: the typist does not wait again");
    write({ error: "RuntimeError: executor run failed", error_status: "403" });
    assert.equal((await typist.type(req)).error_status, undefined, "only a number is a status");
    write({ error: "RuntimeError: boom" });
    assert.equal((await typist.type(req)).error_status, undefined);
  } finally {
    for (const [k, v] of [["GEMINI_WORKER_PYTHON", saved.p], ["GOOGLE_CLOUD_PROJECT", saved.g], ["GOOGLE_CLOUD_LOCATION", saved.l]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(fake, { recursive: true, force: true });
  }
});
