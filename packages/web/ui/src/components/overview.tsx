import type { WaitingItem } from "@norn/core";
import { cn } from "../lib/utils.ts";
import { isDone, nearLimitItems, quietItems } from "../model.ts";
import { useView } from "../view.ts";
import { WORTH_A_LOOK, ago, fixRoundsUsed, heroSub, heroTitle, quietFor, waitingKind, waitingReason } from "../wording.ts";
import { StateDot } from "./sidebar.tsx";
import { WaitingAction } from "./waiting-action.tsx";

/** An agent that asks stands apart from the escalations it also counts as. */
const KIND_TONE: Record<WaitingItem["kind"], string> = { "agent-asks": "text-live", "needs-human": "text-bad", "needs-human-qa": "text-warn" };

/** The one thing the page wants read first: what needs the developer, then what looks stuck. */
export function Hero() {
  const { state, items, item, now, select } = useView();
  const open = items.filter((x) => !isDone(x));
  const working = open.filter((x) => x.holder && !x.holder.stale).length;
  const quiet = quietItems(items);
  const close = nearLimitItems(items);
  return (
    <div>
      <h1 className="mt-0 mb-1.5 font-semibold text-[26px] leading-[1.25] tracking-[-0.02em]">{heroTitle(state.waiting.length)}</h1>
      <p className="mt-0 mb-[22px] text-muted-foreground">{heroSub(working, quiet.length)}</p>
      {state.waiting.map((w) => (
        // biome-ignore lint/a11y/useSemanticElements: the card holds a copy button, and a button cannot contain another.
        <div
          key={w.issue}
          role="button"
          tabIndex={0}
          onClick={() => select(w.issue)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              select(w.issue);
            }
          }}
          className="mb-2.5 grid cursor-pointer grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 rounded-[14px] border border-border bg-card px-[18px] py-4 transition-[border-color,box-shadow] hover:border-faint hover:shadow-[0_2px_10px_rgba(0,0,0,.04)]"
        >
          <div className="font-medium text-[15.5px]">{w.title}</div>
          <div className="col-start-1 text-[14px] text-muted-foreground">{waitingReason(w, item(w.issue))}</div>
          <div className="col-start-2 row-span-2 row-start-1 flex flex-col items-end gap-1.5">
            <span className={cn("font-medium text-[12.5px]", KIND_TONE[w.kind])}>
              {waitingKind(w)}
              {w.since && ` · ${ago(w.since, now)}`}
            </span>
            <WaitingAction w={w} className="items-end text-right" />
          </div>
        </div>
      ))}
      {(quiet.length > 0 || close.length > 0) && (
        <div className="mt-[26px]">
          <h3 className="mt-0 mb-2.5 font-medium text-[13px] text-faint">{WORTH_A_LOOK}</h3>
          {quiet.map((x) => (
            <LookRow key={`q${x.number}`} n={x.number} title={x.title} note={quietFor(x.holder!, now)} dot="warn" />
          ))}
          {close.map((x) => (
            <LookRow key={`f${x.number}`} n={x.number} title={x.title} note={fixRoundsUsed(x.fixRounds, x.maxFixRounds)} dot="faint" />
          ))}
        </div>
      )}
    </div>
  );
}

function LookRow({ n, title, note, dot }: { n: number; title: string; note: string; dot: "warn" | "faint" }) {
  const { select } = useView();
  return (
    <button
      type="button"
      onClick={() => select(n)}
      className="group flex w-full items-baseline gap-2.5 border-0 bg-transparent px-0 py-1.5 text-left text-[14px] text-soft"
    >
      <StateDot dot={dot === "warn" ? "warn" : "none"} className={cn("self-center", dot === "faint" && "bg-faint")} />
      <span className="group-hover:underline group-hover:underline-offset-3">{title}</span>
      <span className="text-[13px] text-faint">{note}</span>
    </button>
  );
}
