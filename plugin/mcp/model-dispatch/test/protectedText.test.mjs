/**
 * The read rule's text, put out of what goes to a model, in its two copies: the server's (apply.ts
 * withoutProtectedText, for a typist's retry and a thinking step's task) and the plugin's tools' (scripts/lib/
 * change-spec.mjs withoutProtectedText, for every tool's answer and every check's output). The two cannot import each
 * other (one is compiled into the server, the other runs in the tools' own process), so both are held to the same
 * answer here for the same project and text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

import { HOME_SECRET_FILES as serverHome, READ_OFF_LIMITS, withoutProtectedText as serverCopy } from "../dist/apply.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const { HOME_SECRET_FILES: toolsHome, withoutProtectedText: toolsCopy } = await import(pathToFileURL(resolve(HERE, "..", "..", "..", "scripts", "lib", "change-spec.mjs")).href);
const { matchesAtAnyDepth } = await import(pathToFileURL(resolve(HERE, "..", "..", "..", "scripts", "lib", "off-limits.mjs")).href);

test("both copies put out the same text: an env file's values and lines, a token file's token, a key file, a remote's token, any private key block; and leave the rest as it was", () => {
  const root = mkdtempSync(join(tmpdir(), "mmo-protected-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://user:ghp_REMOTETOKEN123456@example.invalid/o/r.git"]);
  writeFileSync(join(root, ".env"), "DB_URL=postgres://u:pw@db\nexport API_KEY=\"sk-live-abcdef123456\"\nSHORT=abc\nNODE_ENV=production\nPORT=3000\n");
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", ".npmrc"), "//registry.npmjs.org/:_authToken=npm_TOKEN1234567\n");
  writeFileSync(join(root, "config", "service-account.json"), JSON.stringify({ type: "service_account", private_key_id: "0123456789abcdef0123" }));
  writeFileSync(join(root, "README.md"), "# a project\n");
  const texts = [
    "connecting to postgres://u:pw@db ... failed",
    "API_KEY is sk-live-abcdef123456 and SHORT is abc",
    "token npm_TOKEN1234567 refused",
    "key id 0123456789abcdef0123",
    "fetching https://user:ghp_REMOTETOKEN123456@example.invalid/o/r.git",
    "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIFAKE\n-----END EC PRIVATE KEY-----\nafter",
    "-----BEGIN PRIVATE KEY-----\ncut off before its end",
    "running in production on port 3000",
    "nothing protected here: 3 passed, 0 failed",
  ];
  const secrets = ["postgres://u:pw@db", "sk-live-abcdef123456", "npm_TOKEN1234567", "0123456789abcdef0123", "ghp_REMOTETOKEN123456", "MHcCAQEEIFAKE", "cut off before its end"];
  for (const text of texts) {
    const a = serverCopy(root, text), b = toolsCopy(root, text);
    assert.equal(a, b, `the two copies differ on ${JSON.stringify(text)}`);
    for (const s of secrets) assert.ok(!a.includes(s), `${s} kept in ${JSON.stringify(a)}`);
  }
  assert.equal(serverCopy(root, texts.at(-1)), texts.at(-1), "text with nothing protected is returned as it is");
  assert.equal(serverCopy(root, texts.at(-2)), texts.at(-2), "a value no secret is kept under (NODE_ENV, PORT) is ordinary text, never put out");
  assert.match(serverCopy(root, texts[1]), /SHORT is abc/, "a value under six characters is no secret worth hiding, and stays");
  assert.match(serverCopy(root, texts[5]), /after$/, "only the key block goes");
});

test("the home folder's credential files are the same in both copies, and each is a file the read rule protects", () => {
  assert.deepEqual(serverHome, toolsHome);
  for (const f of serverHome) assert.ok(READ_OFF_LIMITS.some((g) => matchesAtAnyDepth(f, g)), `${f} is not on the read list`);
});
