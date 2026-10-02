#!/usr/bin/env node
/**
 * handoff-models: which model a policy gives each kind of hand-off work, in zero-touch's hand-off mode.
 *
 * In a hand-off chat the chat's own model does the development, and three kinds of work go to a policy's models:
 * documents, specs and planning text (the policy's `docs` stage), tests (its `tests` stage) and the same change
 * repeated across files (its `codegen` stage). The zero-touch hook asks this script once per chat, so the line the
 * person sees names the model that will really do the work, and the hand-off tools use that same answer.
 *
 * The models are derived by the SAME routing code the dispatch server uses (pickModel / loadPolicy, from the
 * pre-built bundle the plugin ships: lib/server-lib.mjs), for the same reason
 * driver-model-check.mjs does: rule matching written a second time here could disagree with the real router. The
 * policy is read the way the executor reads it for a whole stage (executorView: a stage's files are routed by the
 * stage alone), which is how the hand-off tools read it too. MMO_SELECT slot choices are honoured the way the server
 * honours them.
 *
 * Usage:
 *   node handoff-models.mjs --policy <name>          a shipped policy, by name
 *   node handoff-models.mjs --policy-path <file>     a policy file (a project's own routing-policy.yaml)
 *
 * Prints one line of JSON: { policy, routes: { docs, tests, repeat } }, each route { id, model, adapter }.
 * Exit codes: 0 = printed. 2 = the server is not built. 1 = the policy cannot be read or routed; the first line of
 * stderr says why.
 */
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadServerLib } from "./lib/server-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The policy stage each kind of hand-off work is routed as. */
export const HANDOFF_STAGES = { docs: "docs", tests: "tests", repeat: "codegen" };

/** The model a policy gives each hand-off stage. `routing` is the server's routing module (passed in so tests can call this directly). */
export function handoffRoutes(policy, routing, overrides = {}) {
  const routes = {};
  for (const [work, phase] of Object.entries(HANDOFF_STAGES)) {
    // Stage-level routing, as for a whole stage of a workflow: no task type, no module, first attempt.
    const decision = routing.pickModel({ phase, task_type: "", module: "", retry_count: 0 }, policy, overrides);
    const model = policy.models.find((m) => m.id === decision.modelId);
    if (!model) throw new Error(`policy '${policy.name}': the ${phase} stage resolved to model id '${decision.modelId}', which is not in its models list`);
    routes[work] = { id: model.id, model: model.model_name, adapter: model.adapter };
  }
  return routes;
}

function parseArgs(argv) {
  const args = { policy: undefined, policyPath: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eat = (flag) => (a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : argv[++i]);
    if (a === "--policy" || a.startsWith("--policy=")) args.policy = eat("--policy");
    else if (a === "--policy-path" || a.startsWith("--policy-path=")) args.policyPath = eat("--policy-path");
    else throw new Error(`unknown argument '${a}' (expected --policy or --policy-path)`);
  }
  if (!args.policy && !args.policyPath) throw new Error("name a policy: --policy <name> or --policy-path <file>");
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let policyMod, routingMod, executorMod;
  try {
    // The server's own code, from the bundle the plugin ships (lib/server-lib.mjs: dist/ is not in a GitHub install).
    // Exit 2 means "this copy of the plugin can't load it".
    ({ policy: policyMod, routing: routingMod, executorRun: executorMod } = await loadServerLib());
  } catch (err) {
    console.error(`could not load the dispatch server's code: ${err.message}`);
    return 2;
  }
  const asWritten = args.policyPath
    ? policyMod.loadPolicyFromPath(resolve(args.policyPath))
    : policyMod.loadPolicy({ policyName: args.policy });
  const policy = executorMod.executorView(asWritten).policy;
  const overrides = routingMod.parseSelectOverrides(process.env.MMO_SELECT);
  console.log(JSON.stringify({ policy: policy.name, routes: handoffRoutes(policy, routingMod, overrides) }));
  return 0;
}

// Both sides with links followed: for a plugin folder reached through a link (e.g. /var → /private/var) the plain
// comparison is false, and the script would print nothing at all.
const isDirectRun = (() => { try { return realpathSync(resolve(process.argv[1] ?? "")) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isDirectRun) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(String(err?.message ?? err).split("\n")[0]);
    process.exit(1);
  });
}
