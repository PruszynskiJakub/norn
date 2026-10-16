import { BUILT_IN } from "./built-in-flows.js";
import { type Flow, flowNameOf } from "./flow.js";
import type { Issue } from "./github.js";
import { checkFlowsNamed, type LoadedFlow, parseFlow, RESERVED_FLOWS, validateFlow } from "./flow-validation.js";

/**
 * Where norn finds flows: the built-in ones, and the repository's files on the
 * base branch, each read once per command and checked before use.
 */

/** Flows norn ships, which exist in every repository. */
const BUILT_IN_FLOWS = Object.keys(BUILT_IN);

/** What reading a repository's flows needs: the base branch on GitHub, and the cache of one command's reads. */
export interface FlowReader {
  github: { readFileAt(path: string, ref: string): Promise<string | null> };
  config: { baseBranch: string };
  flows?: FlowCache;
}

/** The flow when it is valid; null when there is none, or it is broken. */
export function validFlow(loaded: LoadedFlow | null): Flow | null {
  return loaded?.ok ? loaded.flow : null;
}

/** Where a flow in effect comes from: norn's own, the repository's file in place of norn's of that name, or a flow only the repository has. */
export type FlowSource = "built-in" | "overridden" | "repository";

/** A flow in effect in the repository, with where it comes from. */
export type SourcedFlow = LoadedFlow & { source: FlowSource };

/** A built-in flow by name, checked like any other; null when norn has none of that name. */
export function builtInFlow(name: string): LoadedFlow | null {
  const flow = BUILT_IN[name];
  if (!flow) return null;
  const errors = validateFlow(flow);
  return errors.length ? { ok: false, name, errors } : { ok: true, name, flow };
}

/**
 * The flow `name`: the repository's, or else the built-in one; null when there is none. A repository flow
 * replaces the built-in flow of its name wholesale, with nothing merged from it.
 */
export async function loadFlow(ctx: FlowReader, name: string): Promise<LoadedFlow | null> {
  return (await repositoryFlow(ctx, name)) ?? builtInFlow(name);
}

/** The flow the issue runs, from its type; null when its type names none, e.g. a new issue. */
export function flowOf(ctx: FlowReader, issue: Issue): Promise<LoadedFlow | null> {
  const name = flowNameOf(issue);
  return name === null ? Promise.resolve(null) : loadFlow(ctx, name);
}

/** Repository flows read during one command, by name; see repositoryFlow. */
export type FlowCache = Map<string, Promise<LoadedFlow | null>>;

/** Where a repository keeps its flows. */
export const FLOWS_DIR = ".agents/flows";

/**
 * The repository's flow `name`, read from the base branch on GitHub, never
 * from the working tree: the team's process is what is merged. Null when the
 * repository has no such flow. Read once per command.
 */
export function repositoryFlow(ctx: FlowReader, name: string): Promise<LoadedFlow | null> {
  ctx.flows ??= new Map();
  let flow = ctx.flows.get(name);
  if (!flow) {
    flow = ctx.github
      .readFileAt(`${FLOWS_DIR}/${name}.json`, ctx.config.baseBranch)
      .then((text) =>
        text === null
          ? null
          : checkFlowsNamed(
              parseFlow(name, text),
              async (other) => (await ctx.github.readFileAt(`${FLOWS_DIR}/${other}.json`, ctx.config.baseBranch)) !== null,
            ),
      );
    ctx.flows.set(name, flow);
  }
  return flow;
}

/** A flow file's name is a type name. */
const FLOW_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** The flow names of the files in a list of a flows directory, sorted; files that cannot name a type are left out. */
export function flowFileNames(files: string[]): string[] {
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .filter((name) => FLOW_NAME.test(name))
    .sort();
}

/**
 * Every flow of the repository, valid or kept with its errors: the built-in
 * ones in their order, then the repository's other files in name order. A
 * repository flow is read from the base branch, and its name must be a type;
 * one named like a built-in flow takes that flow's place. Each says where it comes from.
 */
export async function repositoryFlows(ctx: FlowReader & { github: { listFilesAt(dir: string, ref: string): Promise<string[]> } }): Promise<SourcedFlow[]> {
  const names = flowFileNames(await ctx.github.listFilesAt(FLOWS_DIR, ctx.config.baseBranch)).filter((name) => !BUILT_IN_FLOWS.includes(name));
  const loaded = await Promise.all(
    [...BUILT_IN_FLOWS, ...names].map(async (name): Promise<SourcedFlow | null> => {
      const own = await repositoryFlow(ctx, name);
      if (own) return { ...own, source: BUILT_IN_FLOWS.includes(name) ? "overridden" : "repository" };
      const builtIn = builtInFlow(name);
      return builtIn && { ...builtIn, source: "built-in" };
    }),
  );
  return loaded.filter((l) => l !== null);
}

/** The flows triage offers: the repository's flows that are valid, not named like triage's reject, and not setting triage to false. */
export async function triageFlows(ctx: Parameters<typeof repositoryFlows>[0]): Promise<{ name: string; flow: Flow }[]> {
  return (await repositoryFlows(ctx)).flatMap((l) =>
    l.ok && !RESERVED_FLOWS.includes(l.name) && l.flow.triage !== false ? [{ name: l.name, flow: l.flow }] : [],
  );
}
