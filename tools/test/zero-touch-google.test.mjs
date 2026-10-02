/**
 * "Is this computer connected to Google?" is answered in three places, and they must never disagree:
 *   - mmo's own setup check (plugin/scripts/verify-setup.mjs), the original;
 *   - zero-touch's copy (zero-touch/scripts/google.mjs), used at a chat's start and when settings are saved; it is a
 *     copy because Claude Code gives each plugin its own files, so zero-touch carries no mmo code;
 *   - mmo's hook before it starts a workflow (plugin/scripts/ambient/lib/route-flow.mjs googleLoggedIn), which uses the
 *     original's functions.
 * The rule: a value that is only a placeholder does not count; a credential file must be readable and complete; a
 * project name alone is not a login; a configured file that cannot be used is "broken". This test runs all three on
 * the same cases.
 *
 * Offline: files in a temporary home only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const V = await import(join(ROOT, "plugin", "scripts", "verify-setup.mjs"));
const G = await import(join(ROOT, "zero-touch", "scripts", "google.mjs"));
const R = await import(join(ROOT, "plugin", "scripts", "ambient", "lib", "route-flow.mjs"));

/** The original's answer, built the way verify-setup.mjs builds it (observe), under the case's HOME. */
function original(env) {
  const real = V.usableEnv(env);
  const serviceAccountFile = real.GOOGLE_APPLICATION_CREDENTIALS ? V.inspectCredentialFile(real.GOOGLE_APPLICATION_CREDENTIALS) : null;
  const adcFile = V.inspectCredentialFile(V.adcPath(env.HOME));
  const vertex = V.vertexCredentialState({ env: real, serviceAccountFile, adcFile });
  return { connected: V.hasGeminiCredentials({ env: real, vertex }), state: vertex.state };
}

test("zero-touch's copy of the rule is the original, function for function", () => {
  for (const name of ["isUnexpandedPlaceholder", "usableEnv", "inspectCredentialFile", "vertexCredentialState", "hasGeminiCredentials"]) {
    assert.equal(typeof G[name], "function", name);
  }
  assert.deepEqual(G.CREDENTIAL_REQUIRED_FIELDS, V.CREDENTIAL_REQUIRED_FIELDS, "the same required fields for each kind of login");
});

test("the three answers agree on every case: nothing, a key, a placeholder, a project alone, complete and broken files", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-google-"));
  try {
    const home = join(dir, "home");
    const adcDir = join(home, ".config", "gcloud");
    mkdirSync(adcDir, { recursive: true });
    const adc = join(adcDir, "application_default_credentials.json");
    const sa = join(dir, "sa.json");
    const cases = [
      ["nothing", {}, null, null, false],
      ["an API key", { GEMINI_API_KEY: "k" }, null, null, true],
      ["a key that is only a placeholder", { GEMINI_API_KEY: "${GEMINI_API_KEY}" }, null, null, false],
      ["a project name alone", { GOOGLE_CLOUD_PROJECT: "p1" }, null, null, false],
      ["the backend switch alone", { GEMINI_BACKEND: "vertex" }, null, null, false],
      ["a complete gcloud login, with a project", { GOOGLE_CLOUD_PROJECT: "p1" }, { type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" }, null, true],
      ["a complete gcloud login whose file names its project", {}, { type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c", quota_project_id: "p2" }, null, true],
      ["a gcloud login missing its refresh token", {}, { type: "authorized_user", client_id: "a", client_secret: "b" }, null, false],
      ["a gcloud login file that is not JSON", {}, "{ half", null, false],
      ["a complete service account", { GOOGLE_APPLICATION_CREDENTIALS: sa }, null, { type: "service_account", client_email: "x@y", private_key: "k", project_id: "p3" }, true],
      ["a broken service account, even beside a good gcloud login", { GOOGLE_APPLICATION_CREDENTIALS: sa }, { type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" }, { type: "service_account" }, false],
      ["a service account path that does not exist", { GOOGLE_APPLICATION_CREDENTIALS: join(dir, "gone.json") }, null, null, false],
    ];
    for (const [name, vars, adcBody, saBody, expected] of cases) {
      rmSync(adc, { force: true });
      rmSync(sa, { force: true });
      if (adcBody !== null) writeFileSync(adc, typeof adcBody === "string" ? adcBody : JSON.stringify(adcBody));
      if (saBody !== null) writeFileSync(sa, JSON.stringify(saBody));
      const env = { HOME: home, ...vars };
      const o = original(env);
      const z = G.googleState(env);
      assert.equal(o.connected, expected, `${name}: the original`);
      assert.equal(z.connected, o.connected, `${name}: zero-touch's copy agrees`);
      assert.equal(R.googleLoggedIn(env), o.connected, `${name}: mmo's start check agrees`);
      if (!vars.GEMINI_API_KEY || vars.GEMINI_API_KEY.startsWith("${")) assert.equal(z.state, o.state, `${name}: the same state (${o.state})`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the one real check runs only for a gcloud login, and never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-google-online-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".config", "gcloud"), { recursive: true });
    writeFileSync(join(home, ".config", "gcloud", "application_default_credentials.json"), JSON.stringify({ type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c", quota_project_id: "p1" }));
    const calls = [];
    const run = (answer) => (cmd, args) => { calls.push([cmd, ...args].join(" ")); return answer; };
    assert.deepEqual(G.onlineCheck({ HOME: home }, { run: run({ status: 0, stdout: "ya29.x\n" }) }), { result: "works", detail: null });
    assert.deepEqual(calls, ["gcloud auth application-default print-access-token"], "the application-default login: the one the model server signs with");
    assert.equal(G.onlineCheck({ HOME: home }, { run: run({ status: 1, stdout: "", stderr: "ERROR: Reauthentication failed.\n" }) }).result, "refused");
    assert.equal(G.onlineCheck({ HOME: home }, { run: run({ error: new Error("spawn gcloud ENOENT") }) }).result, "unknown", "no gcloud installed: nothing to test with");
    assert.equal(G.onlineCheck({ HOME: home }, { run: () => { throw new Error("boom"); } }).result, "unknown");
    calls.length = 0;
    assert.equal(G.onlineCheck({ HOME: home, GEMINI_API_KEY: "k" }, { run: run({ status: 0, stdout: "x" }) }).result, "unknown", "a key is not tested online");
    assert.deepEqual(calls, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a Google Cloud sign-in with no project is not connected for zero-touch; mmo's own setup check keeps its own rule", () => {
  // A login file alone is not connected: a workflow would start and stop at its first Flash step.
  const dir = mkdtempSync(join(tmpdir(), "zt-google-project-"));
  try {
    const home = join(dir, "home");
    const gcloud = join(home, ".config", "gcloud");
    mkdirSync(join(gcloud, "configurations"), { recursive: true });
    writeFileSync(join(gcloud, "application_default_credentials.json"), JSON.stringify({ type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" }));
    const env = { HOME: home };
    assert.equal(original(env).connected, true, "mmo's setup check: unchanged");
    assert.deepEqual([G.googleState(env).connected, G.googleState(env).state], [false, "no-project"]);
    assert.equal(R.googleLoggedIn(env), false, "mmo's start check, zero-touch's rule");
    // gcloud's own configuration names the project: connected, by both copies of the rule.
    writeFileSync(join(gcloud, "active_config"), "work\n");
    writeFileSync(join(gcloud, "configurations", "config_work"), "[core]\naccount = a@b\nproject = my-proj\n");
    assert.equal(G.googleProject(env), "my-proj");
    assert.equal(R.googleProject(env), "my-proj");
    assert.equal(G.googleState(env).connected, true);
    assert.equal(R.googleLoggedIn(env), true);
    // An AI Studio key needs no project.
    assert.equal(G.googleState({ HOME: join(dir, "empty"), GEMINI_API_KEY: "k" }).connected, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
