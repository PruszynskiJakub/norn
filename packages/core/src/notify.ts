import type { Mode } from "./flow.js";
import type { WaitItem } from "./waiting.js";
import type { Ctx } from "./transitions.js";

export type Channel = "herdr" | "os";

/** Where a person QAs an issue: its flow, and the mode the state runs in only, e.g. hil for a slice's human QA; null for a state of every mode. */
export interface Gate {
  flow: string;
  mode: Mode | null;
}

/** Something a person must act on, sent as a local notification. `url` is the issue's page. */
export type Notification =
  /** `reason` is the needs-human reason norn recorded on the issue, as written there. */
  | { kind: "needs-human"; issue: number; reason: string; url: string }
  /** The issue was in `state`, which the flow `flow` no longer has, so norn set needs-human on it. */
  | { kind: "state-left"; issue: number; state: string; flow: string; url: string }
  /** A person QAs it at `gate`. */
  | { kind: "needs-human-qa"; issue: number; gate: Gate; url: string }
  /** Delivery stopped on issue `story` of the flow `flow`: what waits for a person that no session holds; empty when nothing does. */
  | { kind: "story-waiting"; story: number; flow: string; waiting: WaitItem[] }
  /** A run's agent waits on a person, e.g. at a permission dialog, in the herdr pane `pane`. */
  | { kind: "run-blocked"; issue: number; pane: string; url: string };

/** The Notify port: shows a notification on a channel. The front end words it. */
export type Notify = (channel: Channel, notification: Notification) => Promise<void>;

/** Sends a local notification. Never fails the command: GitHub's label and comment are the record. */
export async function send(ctx: Ctx, notification: Notification): Promise<void> {
  if (!ctx.config.notifications) return;
  try {
    await ctx.notify(ctx.config.notifications, notification);
  } catch {
    // A missing display or tool must not undo a transition already made.
  }
}

/** needs-human was set on an issue. */
export async function notifyNeedsHuman(ctx: Ctx, n: number, reason: string) {
  await send(ctx, { kind: "needs-human", issue: n, reason, url: `${await ctx.github.repoUrl()}/issues/${n}` });
}

/** An issue in a state its flow no longer has was handed to a person. */
export async function notifyStateLeft(ctx: Ctx, n: number, state: string, flow: string) {
  await send(ctx, { kind: "state-left", issue: n, state, flow, url: `${await ctx.github.repoUrl()}/issues/${n}` });
}

/** An issue reached QA by a person. */
export async function notifyHumanQa(ctx: Ctx, n: number, gate: Gate) {
  await send(ctx, { kind: "needs-human-qa", issue: n, gate, url: `${await ctx.github.repoUrl()}/issues/${n}` });
}

/** A run's agent is waiting for input from a person in its pane. */
export async function notifyRunBlocked(ctx: Ctx, n: number, pane: string) {
  await send(ctx, { kind: "run-blocked", issue: n, pane, url: `${await ctx.github.repoUrl()}/issues/${n}` });
}
