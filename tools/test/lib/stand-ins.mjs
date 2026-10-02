/**
 * Loaded before every root test file (package.json "test": node --test --import), for this test process and every
 * process it starts. The tests are offline and must not depend on what the computer has installed:
 *   - `gcloud`: a stand-in (stand-in-gcloud/gcloud) is always first on PATH, so no test contacts Google. It answers
 *     like a computer that cannot reach Google ("unknown"). Tests of a working or refused sign-in put their own fake
 *     gcloud ahead of it.
 *   - `claude`: zero-touch checks for Claude Code's program before a new-app workflow or a Claude hand-off, and tests
 *     of those paths expect a computer with Claude Code, as every person using zero-touch has. When none is on PATH
 *     (GitHub's test runner), a stand-in (stand-in-bin/claude) is added; a real `claude` is never replaced. Tests of
 *     the "not installed" case set their own PATH.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(import.meta.url), "..");
const dirs = String(process.env.PATH ?? "").split(delimiter).filter(Boolean);
const hasClaude = dirs.some((dir) => { try { accessSync(join(dir, "claude"), constants.X_OK); return true; } catch { return false; } });
process.env.PATH = [join(here, "stand-in-gcloud"), ...(hasClaude ? [] : [join(here, "stand-in-bin")]), ...dirs].join(delimiter);
