/**
 * JSON Schemas of the typed build spec, and the small validator that checks a
 * value against them.
 *
 * The spec is handed over in SECTIONS (submit_spec_section): the header first
 * (stack, commands, decisions, shared data model and API), then the units in
 * batches. A section is checked on arrival, so a refusal costs one section,
 * not the whole plan: a single-reply spec can hit the output ceiling or be
 * refused whole, and then the whole plan is sent again.
 *
 * Structure does the checking, never word scans or character counts: exports
 * are typed (name / kind / params / returns), every text field is ONE line, a
 * decision holds ONE chosen value with the rejected options kept apart, and
 * references must resolve. No size is bounded (see the note below the imports).
 * No field has a character limit: a cap refuses real content and costs a whole
 * re-send, while a longer line costs only its own tokens.
 *
 * The validator covers exactly the JSON Schema keywords these schemas use
 * (type, required, properties, additionalProperties: false, enum, minLength,
 * maxLength, pattern, items, minItems, maxItems, minimum, maximum). It is
 * written here rather than pulled from a library because the server declares
 * no JSON Schema dependency, and its error messages name the exact path.
 */
/** The pipeline phases a unit can belong to; each maps to one executor stage. */
export const SPEC_PHASES: readonly string[] = Object.freeze(["codegen", "tests", "docs"]);

type Schema = Record<string, any>;

/*
 * No file-length or units-per-call bound: a typist answer cut off at its output limit goes to the
 * typist with the larger limit (executor/run.ts), and the architect keeps a one-hour cache like the
 * orchestrator (agents/architect.md), so neither bound is needed.
 */

/** One line of text: not empty, no line break. */
const line: Schema = { type: "string", minLength: 1, pattern: "^[^\\n\\r]+$" };
const UNIT_ID = { type: "string", pattern: "^U[0-9]{2,4}$" };
/** An acceptance criterion id as requirements.md writes it (AC-3, AC-1.2): the same grammar a unit's `covers` uses. */
const AC_ID = { type: "string", pattern: "^AC-[0-9]+(\\.[0-9]+)?$" };
/**
 * What a command in the acceptance list is for, which decides who fixes it when it fails: `install` and
 * `audit` failures are version choices (the architect's), a `check` failure is code (a repair round).
 */
export const COMMAND_ROLES: readonly string[] = Object.freeze(["install", "audit", "check"]);

export const SPEC_HEADER_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["stack", "commands", "decisions", "shared"],
  properties: {
    stack: { type: "array", items: line, description: "The fixed stack, one short item each (runtime, frameworks, libraries, test tools)." },
    commands: {
      type: "array",
      description: "The acceptance list: every command that checks the finished project, in the order they run (the install first). The acceptance stage runs each in its working directory under the code directory and judges it by its pass rule.",
      items: {
        type: "object", additionalProperties: false, required: ["name", "run", "cwd", "role", "checks", "pass", "timeout_s"],
        properties: {
          name: line, run: line,
          cwd: { ...line, description: "Relative to the code directory; \".\" for the code directory itself." },
          role: { type: "string", enum: [...COMMAND_ROLES] },
          checks: { type: "array", items: AC_ID, description: "The acceptance criteria this command proves." },
          // The plan states each command's time limit: the architect knows the stack and what its
          // installs and suites take, so no limit lives in code. A command stopped at its limit is reported
          // as not checked, never as a defect to fix.
          timeout_s: { type: "integer", minimum: 1, description: "How long this command may run, in seconds, before code stops it and reports its criteria as not checked: your estimate for this stack, generous rather than tight." },
          pass: {
            type: "object", additionalProperties: false, required: ["exit_code"],
            properties: {
              exit_code: { type: "integer", minimum: 0, maximum: 255 },
              forbid_lines_starting_with: { type: "array", items: line, description: "Output lines the brief forbids, by the prefix the tool prints for them (matched without regard to case)." },
            },
          },
        },
      },
    },
    unchecked: {
      type: "array",
      description: "Acceptance criteria no command could check by running — one that needs a person, or a device this project cannot drive — each with the reason. A check whose tool may be missing on this machine is still a command: code finds out when it runs, and a command the shell cannot find is reported as not checked with that reason.",
      items: { type: "object", additionalProperties: false, required: ["id", "reason"], properties: { id: AC_ID, reason: line } },
    },
    no_audit_reason: { ...line, description: "Why the acceptance list has no dependency audit (for example, no third-party packages)." },
    decisions: {
      type: "array",
      description: "Every design decision a file writer would otherwise guess. ONE chosen value each; rejected options go in `rejected`, never in `choice`.",
      items: { type: "object", additionalProperties: false, required: ["topic", "choice", "reason"], properties: { topic: line, choice: line, rejected: { type: "array", items: line }, reason: line } },
    },
    shared: {
      type: "object", additionalProperties: false, required: ["conventions", "data_model", "api"],
      description: "What every file writer needs; sent first in every brief.",
      properties: {
        conventions: { type: "array", items: line },
        data_model: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["name", "fields"], properties: {
            name: line,
            fields: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "type"], properties: { name: line, type: line, constraints: line } } },
          } },
        },
        api: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["method", "path", "access", "request", "response", "success_status", "error_statuses"], properties: {
            method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
            path: line, access: line, request: line, response: line,
            success_status: { type: "integer", minimum: 100, maximum: 599 },
            error_statuses: { type: "array", items: { type: "integer", minimum: 400, maximum: 599 } },
          } },
        },
      },
    },
  },
};

export const SPEC_UNIT_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "path", "phase", "import_line", "exports", "behaviour", "depends_on", "style_from", "covers", "tests", "approx_lines"],
  properties: {
    id: UNIT_ID,
    path: { type: "string", pattern: "^[A-Za-z0-9_.][A-Za-z0-9_./-]*$", description: "Relative to the code directory; no leading slash, no '..'." },
    phase: { type: "string", enum: [...SPEC_PHASES] },
    // Optional free text for the design table only: never a list to pick from, never refused, never
    // routed on — who types a file depends on its stage and the policy alone, whatever its language.
    kind: { ...line, description: "Optional: a few words on what kind of file this is, for the design table only." },
    // How other files import this one, stated once so two typists cannot read an export name two different
    // ways. Written by the architect in the project's own language; code only carries it — into this file's
    // brief, every dependent's brief, the shared index and design.md — and never parses it, so no language
    // rule is involved.
    import_line: { type: "string", pattern: "^[^\\n\\r]*$", description: "The exact line another file of this project writes to import this file, in the project's own language, as written by a file at the project root (a file elsewhere adjusts only the relative path). Empty when no other file imports this file." },
    exports: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["name", "params", "returns"], properties: {
        name: { type: "string", pattern: "^[A-Za-z_$][A-Za-z0-9_$]*(\\.[A-Za-z_$][A-Za-z0-9_$]*)*$", description: "The name other files use: a top-level name, or Class.method for a member." },
        kind: { ...line, description: "Optional: function, class, trait, ... — whatever the language calls it." },
        params: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "type"], properties: { name: line, type: line } } },
        returns: line,
      } },
    },
    behaviour: { ...line, description: "One line: what the file does." },
    depends_on: { type: "array", items: UNIT_ID },
    style_from: {
      type: "object", additionalProperties: false, required: ["reason"],
      description: "An EARLIER unit whose style this file copies, with the reason; or no unit and the reason there is none.",
      properties: { unit: UNIT_ID, reason: line },
    },
    covers: { type: "array", items: { type: "string", pattern: "^(FR|NFR|AC)-[0-9]+(\\.[0-9]+)?$" } },
    tests: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["name", "given", "expect"], properties: { name: line, given: line, expect: line } },
    },
    approx_lines: { type: "integer", minimum: 1, description: "The file's estimated length in lines; an estimate for the brief and the design table, not a bound." },
  },
};

export const SPEC_UNITS_SECTION_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["units"],
  properties: { units: { type: "array", minItems: 1, items: SPEC_UNIT_SCHEMA } },
};

/**
 * A schema's shape in one line, TypeScript-like: `{name: type, optional?: type}`, `type[]` for an
 * array, `"A"|"B"` for an enum. It is what submit_spec_section's description shows the architect:
 * the tool's input names a section file, so it does not carry these schemas itself. Rendered from
 * the schema itself, so what the architect reads can never drift from what `validate` enforces.
 */
const ONE_LINE_PATTERNS = new Set(["^[^\\n\\r]+$", "^[^\\n\\r]*$"]);
export function shapeOf(schema: Schema): string {
  if (schema.enum) return schema.enum.map((v: unknown) => JSON.stringify(v)).join("|");
  if (schema.type === "array") {
    const item = shapeOf(schema.items);
    // An enum or a patterned string is bracketed, so `[]` reads as applying to the whole item.
    return (/[|]| matching /.test(item) && !item.startsWith("{") ? `(${item})` : item) + "[]";
  }
  // A pattern is shown unless it only says "one line", which the description states once for all.
  if (schema.type === "string" && schema.pattern && !ONE_LINE_PATTERNS.has(schema.pattern)) return `string matching ${schema.pattern}`;
  if (schema.type === "object") {
    const req = new Set<string>(schema.required ?? []);
    return "{" + Object.entries(schema.properties ?? {}).map(([k, sub]) => `${k}${req.has(k) ? "" : "?"}: ${shapeOf(sub as Schema)}`).join(", ") + "}";
  }
  return String(schema.type);
}

/** One problem found by `validate`, with the JSON path it applies to. */
export interface SchemaError {
  path: string;
  message: string;
}

/** Checks `value` against `schema`; returns every problem found (empty = valid). */
export function validate(schema: Schema, value: unknown, path = ""): SchemaError[] {
  const errors: SchemaError[] = [];
  const at = path || "/";
  const t = schema.type;
  if (t === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [{ path: at, message: "must be an object" }];
    const v = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in v)) errors.push({ path: at, message: `is missing required field '${k}'` });
    for (const [k, sub] of Object.entries(v)) {
      const s = schema.properties?.[k];
      if (!s) {
        if (schema.additionalProperties === false) errors.push({ path: `${path}/${k}`, message: "is not an allowed field" });
        continue;
      }
      errors.push(...validate(s, sub, `${path}/${k}`));
    }
    return errors;
  }
  if (t === "array") {
    if (!Array.isArray(value)) return [{ path: at, message: "must be an array" }];
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path: at, message: `must have at least ${schema.minItems} item(s)` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path: at, message: `must have at most ${schema.maxItems} items (has ${value.length})` });
    value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}/${i}`)));
    return errors;
  }
  if (t === "string") {
    if (typeof value !== "string") return [{ path: at, message: "must be a string" }];
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path: at, message: `must not be empty` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path: at, message: `must be at most ${schema.maxLength} characters (has ${value.length})` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push({ path: at, message: `must match ${schema.pattern}` });
    if (schema.enum !== undefined && !schema.enum.includes(value)) errors.push({ path: at, message: `must be one of: ${schema.enum.join(", ")}` });
    return errors;
  }
  if (t === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return [{ path: at, message: "must be an integer" }];
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path: at, message: `must be ≥ ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path: at, message: `must be ≤ ${schema.maximum}` });
    return errors;
  }
  throw new Error(`validate: unsupported schema type '${t}' at ${at}`);
}
