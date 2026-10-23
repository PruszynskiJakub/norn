import type { FlowError } from "./flow-validation.js";
import type { Gate } from "./notify.js";

/**
 * What norn next lists as waiting, as data: the behaviours that hold an issue
 * say what it waits for, and norn next and the notifications report it.
 */

/** The live claim on an item: which session holds it, since when, and whether it is one of the user's. */
export interface Holder {
  session: "this" | "yours" | "other";
  mine: boolean;
  since: string;
}

/** Under herdr, an item for a person is done in its worktree's pane: these say where, as for a StartItem. */
export interface HumanPlace {
  branch?: string | null;
  worktree?: string | null;
  createWorktree?: string | null;
  checkedOutAt?: string | null;
  here?: boolean;
  /** An item for a person that a session holds. No hand-off is offered for it. */
  heldBy?: Holder;
}

/** Where a person reaches the agent that holds an item: its worktree and, under herdr only, the command that focuses its pane. */
export interface AgentPlace {
  worktree: string | null;
  focus: string | null;
}

export type WaitItem = { issue: number } & (
  | { reason: "blocked"; blockers: number[] }
  /** Its agent asked a person `question` with escalate --wait at `since`, `waitedMs` ago, and waits in its session for the answer. */
  | ({ reason: "agent-asks"; question: string; since: string; waitedMs: number; holder: Holder } & AgentPlace)
  /** `why` is the reason norn recorded when it set needs-human, as written; null when none is found. */
  | ({ reason: "needs-human"; why: string | null } & HumanPlace)
  /** A person QAs it at `gate`. */
  | ({ reason: "human-qa"; gate: Gate } & HumanPlace)
  /** Held by one of the user's own sessions (`holder.mine`): an agent of theirs at work, using a parallel slot. */
  | { reason: "held"; holder: Holder }
  /** Its owner merges its PR into `into`; `flow` is its type, e.g. story. */
  | { reason: "owner-merge"; owner: string | null; into: string; flow: string }
  | { reason: "no-state" }
  | { reason: "ambiguous-state"; states: string[] }
  /** The issue is in a state its flow no longer has; taking it hands it to a person. */
  | { reason: "state-left"; state: string; flow: string }
  /** The issue's type names a repository flow that is broken, so norn cannot run it until a person fixes the flow. */
  | { reason: "flow-invalid"; flow: string; errors: FlowError[] }
);
