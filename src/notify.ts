import type { Ctx } from "./transitions.js";

export type Channel = "herdr" | "os";

export interface Message {
  title: string;
  body: string;
}

export type Notify = (channel: Channel, message: Message) => Promise<void>;

/** Sends a local notification. Never fails the command: GitHub's label and comment are the record. */
export async function send(ctx: Ctx, message: Message): Promise<void> {
  if (!ctx.config.notifications) return;
  try {
    await ctx.notify(ctx.config.notifications, message);
  } catch {
    // A missing display or tool must not undo a transition already made.
  }
}

/** needs-human was set on an issue. */
export async function notifyNeedsHuman(ctx: Ctx, n: number, reason: string) {
  await send(ctx, { title: `psdd: #${n} needs you`, body: `${reason}\n${await ctx.github.repoUrl()}/issues/${n}` });
}
