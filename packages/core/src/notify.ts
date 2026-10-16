import type { WaitItem } from "./next.js";
import type { Ctx } from "./transitions.js";

export type Channel = "herdr" | "os";

/** Something a person must act on, sent as a local notification. `url` is the issue's page. */
export type Notification =
  /** `reason` is the needs-human reason norn recorded on the issue, as written there. */
  | { kind: "needs-human"; issue: number; reason: string; url: string }
  /** `of` says why a person QAs it, as Outcome.notify does. */
  | { kind: "needs-human-qa"; issue: number; of: string; url: string }
  /** Delivery stopped: what waits for a person that no session holds; empty when nothing does. */
  | { kind: "story-waiting"; story: number; waiting: WaitItem[] };

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

/** An issue reached QA by a person. */
export async function notifyHumanQa(ctx: Ctx, n: number, of: string) {
  await send(ctx, { kind: "needs-human-qa", issue: n, of, url: `${await ctx.github.repoUrl()}/issues/${n}` });
}
