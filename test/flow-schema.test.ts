import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { BEHAVIOURS, BUILT_IN, validateFlow } from "@norn/core";

/** The JSON Schema norn publishes for .agents/flows/<name>.json, as it ships in the package. */
const SCHEMA_FILE = join(import.meta.dirname, "..", "schema", "flow.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8"));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

/** A valid flow with its own branch, so that every behaviour's workspace rule can be met by changing one field. */
function flow(over: Record<string, unknown> = {}, state: Record<string, unknown> = {}) {
  return {
    description: "A defect: reproduce it, fix it, close it.",
    start: "fixing",
    workspace: "own",
    states: {
      fixing: { skill: "bug-fix", attended: false, outcomes: { fixed: { to: "closed", means: "the fix is merged" } }, ...state },
    },
    ...over,
  };
}

const outcome = (o: Record<string, unknown>) => ({ outcomes: { fixed: { to: "closed", means: "fixed", ...o } } });

describe("the flow JSON Schema", () => {
  test.each(Object.entries(BUILT_IN))("the built-in %s flow, as norn flows export writes it, matches it", (_, f) => {
    expect(validate(JSON.parse(JSON.stringify(f)))).toBe(true);
  });

  test("ships in the npm package, at the path its $id names", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(pkg.files).toContain("schema");
    expect(schema.$id).toMatch(/\/schema\/flow\.schema\.json$/);
  });

  test("names every behaviour norn knows, with each one's parameters", () => {
    const behaviours = schema.$defs.behaviours.properties as Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
    expect(Object.keys(behaviours)).toEqual(Object.keys(BEHAVIOURS));
    for (const [name, b] of Object.entries(BEHAVIOURS)) {
      const params = "params" in b ? (b.params as Record<string, { required?: boolean }>) : {};
      expect(Object.keys(behaviours[name].properties ?? {}), name).toEqual(Object.keys(params));
      expect(behaviours[name].required ?? [], name).toEqual(Object.keys(params).filter((p) => params[p].required));
    }
  });

  // Each case is a mistake of the shape: the schema flags it as the team lead types, and norn refuses it too.
  test.each([
    ["a valid flow", flow(), true],
    ["a $schema field, for the editor", flow({ $schema: "https://example.com/flow.schema.json" }), true],
    [
      "every optional field",
      flow(
        { triage: false, renamed: { old: "fixing" } },
        {
          name: "fix",
          enterAs: "fixing",
          description: "Being fixed",
          color: "1d76db",
          evidence: true,
          when: "afk",
          passThrough: "fixed",
          behaviours: { opensPR: {}, writesSpec: { readsIssue: true } },
          ...outcome({ note: "what", needsHuman: "who", notify: true, meansSkipped: "skipped" }),
        },
      ),
      true,
    ],
    ["a missing description", { ...flow(), description: undefined }, false],
    ["an unknown workspace", flow({ workspace: "elsewhere" }), false],
    ["triage that is not a boolean", flow({ triage: "yes" }), false],
    ["an unknown top-level field", flow({ stats: {} }), false],
    ["renamed to something that is not a name", flow({ renamed: { old: 3 } }), false],
    ["a state without a skill", flow({}, { skill: undefined }), false],
    ["a state with an unknown field", flow({}, { behaviors: {} }), false],
    ["a colour that is not hex", flow({}, { color: "blue" }), false],
    ["evidence that is not a boolean", flow({}, { evidence: "yes" }), false],
    ["an unknown mode", flow({}, { when: "sometimes", passThrough: "fixed" }), false],
    ["when without passThrough", flow({}, { when: "hil" }), false],
    ["an unknown behaviour", flow({}, { behaviours: { deploys: {} } }), false],
    ["a behaviour's parameters that are not an object", flow({}, { behaviours: { opensPR: true } }), false],
    ["a missing parameter", flow({}, { behaviours: { slices: {} } }), false],
    ["a parameter of the wrong type", flow({}, { behaviours: { slices: { type: 3 } } }), false],
    ["an unknown parameter", flow({}, { behaviours: { opensPR: { draft: true } } }), false],
    ["an outcome without means", flow({}, outcome({ means: undefined })), false],
    ["an outcome with an unknown field", flow({}, outcome({ goto: "x" })), false],
    ["a notify that names who, not true or false", flow({}, outcome({ notify: "story" })), false],
  ])("%s: the schema and norn's validator agree", (_, data, valid) => {
    const json = JSON.parse(JSON.stringify(data));
    expect(validate(json), JSON.stringify(validate.errors)).toBe(valid);
    expect(validateFlow(json).length === 0, JSON.stringify(validateFlow(json))).toBe(valid);
  });
});
