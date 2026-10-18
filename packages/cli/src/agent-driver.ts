import type { AttemptEnd } from "@norn/core";

/**
 * How a run's supervisor reaches its agent. The supervisor owns the rules
 * (lease, stall, timeout, attempts, settling from GitHub); a driver only
 * starts the agent and says what it looks like. norn's one driver puts each
 * agent in a herdr pane; tests drive scripted agents through the same seam.
 */
export interface AgentDriver {
  /** Starts an agent working in `worktree` as `session`, the run's own norn session, with `env` set for it. `log` is the attempt's log file. */
  start(a: { prompt: string; worktree: string; session: string; env: Record<string, string>; log: string }): Promise<AgentAttempt>;
}

/** How a driver's agent turn ends; the supervisor adds the ends it causes itself, such as a stall. */
export type AgentEnd = Extract<AttemptEnd, { kind: "exited" | "not-started" | "stopped-early" | "gone" }>;

/** One agent, started by a driver, across the turns it is nudged into. */
export interface AgentAttempt {
  /** The herdr pane the agent runs in, where a person can watch it; null for an agent without one. */
  readonly pane: string | null;
  /** Resolves when the agent's current turn ends: it exited, stopped early, went away, or was stopped. */
  ended(): Promise<AgentEnd>;
  /** The agent as it is now. The supervisor looks on every tick, and the look drives the stall rule. */
  look(): Promise<AgentLook>;
  /** Gives the agent a new turn in place, keeping its context. False when it cannot take one, e.g. it is gone. */
  nudge(text: string): Promise<boolean>;
  /** Ends the agent. Its current turn, if any, ends too. */
  stop(): Promise<void>;
}

export interface AgentLook {
  /** When the agent last showed activity, in ms since the epoch: a changed screen, or new output. */
  activityAt: number;
  /** It waits on a person, e.g. at an approval or a question: not a stall, so the clocks pause. */
  blocked: boolean;
}
