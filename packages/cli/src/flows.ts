import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUILT_IN, FLOWS_DIR } from "@norn/core";

/** A built-in flow written into the project as a starting copy. */
export interface FlowExported {
  ok: true;
  kind: "flow-exported";
  flow: string;
  /** Where it was written, relative to the project. */
  file: string;
}

export type FlowsRefusal =
  | { kind: "flows-usage" }
  | { kind: "flow-not-built-in"; flow: string; builtIn: string[] }
  | { kind: "flow-file-exists"; flow: string; file: string };

/**
 * norn flows export <name>: writes the built-in flow `name` to .agents/flows/<name>.json, which then
 * replaces the built-in once it is on the base branch. A file already there is the team's, so it is left alone.
 */
export function flows(cwd: string, args: string[]): FlowExported | { ok: false; refusal: FlowsRefusal } {
  const [sub, name] = args;
  if (sub !== "export" || !name) return { ok: false, refusal: { kind: "flows-usage" } };
  const flow = Object.hasOwn(BUILT_IN, name) ? BUILT_IN[name] : null;
  if (!flow) return { ok: false, refusal: { kind: "flow-not-built-in", flow: name, builtIn: Object.keys(BUILT_IN) } };
  const file = `${FLOWS_DIR}/${name}.json`;
  const path = join(cwd, file);
  if (existsSync(path)) return { ok: false, refusal: { kind: "flow-file-exists", flow: name, file } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(flow, null, 2)}\n`);
  return { ok: true, kind: "flow-exported", flow: name, file };
}
