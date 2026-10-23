import type { WaitingItem } from "@norn/core";
import { cn } from "../lib/utils.ts";
import { answerIn } from "../wording.ts";
import { CopyCommand } from "./copy-command.tsx";

/**
 * What the developer does about an item waiting for them. An agent that asks
 * is answered in its own session, so it gets no command that takes the item:
 * under herdr, the one that brings its pane forward, and where it works.
 */
export function WaitingAction({ w, className }: { w: WaitingItem; className?: string }) {
  if (w.kind !== "agent-asks") return <CopyCommand command={w.command} />;
  return (
    <span className={cn("flex flex-col gap-1", className)}>
      {w.focus && <CopyCommand command={w.focus} />}
      <span className="break-all text-[12.5px] text-faint">{answerIn(w.worktree)}</span>
    </span>
  );
}
