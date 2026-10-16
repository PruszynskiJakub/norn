import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";
import { type Dot, dotOf, type Item, isDone } from "../model.ts";
import { useView } from "../view.ts";
import { SIDEBAR, itemFlag } from "../wording.ts";
import { Skeletons } from "./ui/skeleton.tsx";

const DOT: Record<Dot, string> = {
  bad: "bg-bad",
  warn: "bg-warn",
  done: "border-[1.5px] border-ok bg-transparent",
  blocked: "border-[1.5px] border-dashed border-faint bg-transparent",
  live: "bg-live shadow-[0_0_0_3px_var(--live-bg)]",
  none: "bg-border",
};

export function StateDot({ dot, className }: { dot: Dot; className?: string }) {
  return <span className={cn("size-[7px] flex-none rounded-full", DOT[dot], className)} />;
}

function Flag({ n }: { n: number }) {
  const { item } = useView();
  const x = item(n);
  const flag = x ? itemFlag(x) : null;
  if (!flag) return null;
  return <span className={cn("whitespace-nowrap text-[12px]", flag.tone === "bad" ? "text-bad" : "text-warn")}>{flag.text}</span>;
}

function NavRow({ n, kind, children }: { n: number | null; kind: "top" | "story" | "child"; children: ReactNode }) {
  const { selected, select } = useView();
  const on = (selected?.number ?? null) === n;
  return (
    <button
      type="button"
      onClick={() => select(n)}
      aria-current={on ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-[5px] text-left text-[14px] text-soft hover:bg-muted",
        kind === "story" && "mt-1.5 font-medium text-foreground",
        kind === "child" && "pl-3.5 text-[13.5px] text-muted-foreground",
        on && "bg-muted font-medium text-foreground",
      )}
    >
      {children}
    </button>
  );
}

const title = "flex-1 truncate";

export function Sidebar({ loading }: { loading: boolean }) {
  const { state, item } = useView();
  const open = state.board.filter((s) => !isDone(s));
  const closed = state.board.filter((s) => isDone(s));
  const waiting = state.waiting.length;
  return (
    <nav aria-label="Stories">
      <div className="flex items-center gap-2.5 px-2.5 pb-[18px]">
        <img src="/favicon.svg" alt="" width={64} height={64} className="flex-none rounded-[16px]" />
        <div className="flex min-w-0 flex-col">
          <b className="text-[15px] tracking-[-0.01em]">norn</b>
          <span className="truncate text-[12px] text-faint">{state.repoUrl?.replace(/^https?:\/\/(www\.)?github\.com\//, "") ?? ""}</span>
        </div>
      </div>
      <NavRow n={null} kind="top">
        <span className={title}>{SIDEBAR.overview}</span>
        {waiting > 0 && <span className="rounded-full bg-warn-bg px-[7px] font-medium text-[12px] text-warn">{waiting}</span>}
      </NavRow>
      {loading ? (
        <Skeletons count={8} height={22} />
      ) : (
        <>
          <div className="px-2.5 pt-[18px] pb-1.5 text-[12px] text-faint">{SIDEBAR.yourStories}</div>
          {open.length === 0 && <p className="px-2.5 text-[13px] text-muted-foreground">{SIDEBAR.noStories}</p>}
          {open.map((s) => (
            <div key={s.number}>
              <NavRow n={s.number} kind="story">
                <span className={title}>{s.title}</span>
                <Flag n={s.number} />
              </NavRow>
              {s.slices
                .flatMap((slice) => item(slice.number) ?? [])
                .map((x: Item) => (
                  <NavRow key={x.number} n={x.number} kind="child">
                    <StateDot dot={dotOf(x)} />
                    <span className={title}>{x.title}</span>
                    <Flag n={x.number} />
                  </NavRow>
                ))}
            </div>
          ))}
          {closed.length > 0 && (
            <>
              <div className="px-2.5 pt-[18px] pb-1.5 text-[12px] text-faint">{SIDEBAR.closedThisWeek}</div>
              {closed.map((s) => (
                <NavRow key={s.number} n={s.number} kind="child">
                  <StateDot dot="done" />
                  <span className={title}>{s.title}</span>
                </NavRow>
              ))}
            </>
          )}
        </>
      )}
    </nav>
  );
}
