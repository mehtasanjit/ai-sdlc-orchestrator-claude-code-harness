/**
 * The plain-language guide, docs/zero-touch-guide.md, reaches every new user. Installing a plugin copies only its own
 * folder, so the guide is not on their computer: the first chat's welcome (zero-touch/scripts/messages.mjs), which
 * every new install shows, carries its address, in the terminal's start lines and in the paragraph Claude writes
 * before the settings box in the desktop app. The address must lead to the file, and the repository's own front pages
 * link the guide too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const M = await import(join(ROOT, "zero-touch", "scripts", "messages.mjs"));
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

test("the guide's address is this repository's develop branch, at a file that exists", () => {
  const home = JSON.parse(read("zero-touch", ".claude-plugin", "plugin.json")).homepage;
  assert.equal(typeof M.GUIDE_URL, "string");
  assert.ok(M.GUIDE_URL.startsWith(`${home}/blob/develop/`), `${M.GUIDE_URL} is in ${home}, on the branch zero-touch installs from`);
  const path = M.GUIDE_URL.slice(`${home}/blob/develop/`.length);
  assert.equal(path, "docs/zero-touch-guide.md");
  assert.ok(existsSync(join(ROOT, path)), `${path} exists`);
});

test("the first chat's welcome carries the guide's address, on every screen", () => {
  assert.ok(M.welcomeMessage().includes(M.GUIDE_URL), "the welcome zero-touch shows (the terminal's start lines)");
  assert.ok(M.WELCOME_SAY.includes(M.GUIDE_URL), "the paragraph Claude writes before the box (the desktop app folds the welcome)");
});

test("the repository's front pages link the guide", () => {
  for (const [file, link] of [["README.md", "docs/zero-touch-guide.md"], ["docs/README.md", "zero-touch-guide.md"], ["zero-touch/README.md", "../docs/zero-touch-guide.md"], ["docs/ambient-mode.md", "zero-touch-guide.md"]]) {
    assert.ok(read(file).includes(`](${link})`), `${file} links ${link}`);
  }
});
