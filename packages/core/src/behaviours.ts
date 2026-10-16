/**
 * norn's built-in mechanics that a flow's state opts into by name, e.g.
 * `"behaviours": { "opensPR": {} }`. The set is closed: a name not here fails
 * validation, which also catches a flow written for a newer norn.
 */

/** A behaviour's parameters, as written in the flow. */
export type BehaviourParams = Record<string, unknown>;

/** What validation asks of a behaviour; every hook is optional. */
export interface BehaviourRule {
  /** What is wrong with its parameters: the parameter's name and what it must be. */
  params?(params: BehaviourParams): { param: string; expected: string }[];
  /** Behaviours the same state cannot also have. */
  excludes?: readonly string[];
  /** The flows its parameters name, e.g. the type slices get; each must exist. */
  flowsNamed?(params: BehaviourParams): string[];
}

/** Every behaviour this norn knows, by name. */
export const BEHAVIOURS: Readonly<Record<string, BehaviourRule>> = {};
