import type { FeedEvent } from "@norn/core";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { type Attention, type StepGroup, attentionOf, feedFor, isSignificant, stepGroupOf } from "../model.ts";
import { useView } from "../view.ts";
import { FEED, actorOf, clock, dayLabel, emptyFeed, escalationReason, feedTitle, onItem, roundNote, routineRun, routineText, sentence } from "../wording.ts";
import { EvidenceBlock } from "./evidence.tsx";
import { Markdown } from "./markdown.tsx";
import { SegmentedControl } from "./ui/segmented-control.tsx";

type Mode = "everything" | "remarks";
type Filter = "all" | Exclude<StepGroup, "other">;

const ATT: Record<Attention, string> = { bad: "bg-bad", warn: "bg-warn", ok: "bg-ok", none: "bg-border" };

/** "What happened": the feed by day, significant events as sentences, routine runs folded. */
export function Feed() {
  const { state, selected } = useView();
  const [mode, setMode] = useState<Mode>("everything");
  const [filter, setFilter] = useState<Filter>("all");
  const feed = feedFor(state.feed, selected);
  const shown = mode === "remarks" ? feed.filter((e) => e.kind === "outcome" && e.note && (filter === "all" || stepGroupOf(e, state.flows) === filter)) : feed;
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-3">
        <h3 className="m-0 flex-1 font-medium text-[13px] text-faint">{feedTitle(selected !== null)}</h3>
        {mode === "remarks" && (
          <SegmentedControl
            label="Remarks of"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: FEED.all },
              { value: "implement", label: FEED.implement },
              { value: "review", label: FEED.review },
              { value: "qa", label: FEED.qa },
            ]}
          />
        )}
        <SegmentedControl
          label="Show"
          value={mode}
          onChange={setMode}
          options={[
            { value: "everything", label: FEED.everything },
            { value: "remarks", label: FEED.remarks },
          ]}
        />
      </div>
      <Timeline feed={shown} empty={emptyFeed(mode === "remarks")} />
    </div>
  );
}

type Chunk = { routine: true; events: FeedEvent[] } | { routine: false; event: FeedEvent };

function Timeline({ feed, empty }: { feed: FeedEvent[]; empty: string }) {
  const { now } = useView();
  if (feed.length === 0) return <p className="text-muted-foreground">{empty}</p>;
  const days: { label: string; chunks: Chunk[] }[] = [];
  for (const e of feed) {
    const label = dayLabel(e.at, now);
    let day = days[days.length - 1];
    if (!day || day.label !== label) {
      day = { label, chunks: [] };
      days.push(day);
    }
    const last = day.chunks[day.chunks.length - 1];
    if (isSignificant(e)) day.chunks.push({ routine: false, event: e });
    else if (last?.routine) last.events.push(e);
    else day.chunks.push({ routine: true, events: [e] });
  }
  return days.map((d) => (
    <div key={d.label}>
      <div className="mt-[26px] mb-2 text-[13px] text-faint">{d.label}</div>
      {d.chunks.map((c) => (c.routine ? <RoutineRun key={`r${c.events[0]!.id}`} events={c.events} /> : <Significant key={c.event.id} e={c.event} />))}
    </div>
  ));
}

const row = "grid grid-cols-[52px_1fr] gap-x-3.5";
const time = "pt-px text-[13px] text-faint tabular-nums";

/** "on <title>", unless the feed already shows only that item. */
function Where({ e }: { e: FeedEvent }) {
  const { item, selected } = useView();
  if (selected?.number === e.issue) return null;
  return <span className="text-muted-foreground"> {onItem(item(e.issue)?.title, e.issue)}</span>;
}

function Significant({ e }: { e: FeedEvent }) {
  const { state } = useView();
  const round = roundNote(e, state.flows);
  const reason = escalationReason(e);
  return (
    <div className={cn(row, "py-2.5")}>
      <span className={time}>{clock(e.at)}</span>
      <div className="min-w-0">
        <div className="text-foreground">
          <span className={cn("mr-2 inline-block size-[7px] rounded-full align-[1px]", ATT[attentionOf(e, state.flows)])} />
          {sentence(e, state.me, state.flows)}
          {round && <span className="text-muted-foreground"> · {round}</span>}
          <Where e={e} />
        </div>
        {reason && <div className="text-[14px] text-soft">{reason}</div>}
        <div className="mt-px text-[13px] text-faint">
          {actorOf(e, state.me)} ·{" "}
          <a href={e.url} target="_blank" rel="noreferrer" className="text-faint hover:text-foreground">
            {FEED.github}
          </a>
        </div>
        {e.kind === "outcome" && e.note && <Remark note={e.note} evidence={e.evidence} tone={attentionOf(e, state.flows)} />}
        {e.kind === "outcome" && !e.note && e.evidence && <EvidenceBlock evidence={e.evidence} compact />}
      </div>
    </div>
  );
}

/** A remark under its event, cut to a few lines until asked for in full. */
function Remark({ note, evidence, tone }: { note: string; evidence: Extract<FeedEvent, { kind: "outcome" }>["evidence"]; tone: Attention }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  // Short remarks fit in the clamp; offering to expand them would show nothing new.
  useLayoutEffect(() => {
    const el = body.current;
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [open]);
  return (
    <div className={cn("mt-2.5 rounded-xl bg-muted px-4 py-3", (tone === "warn" || tone === "bad") && "shadow-[inset_3px_0_0_var(--warn)]")}>
      <div ref={body} className={open || !overflows ? undefined : "clamp"}>
        <Markdown source={note} />
      </div>
      {(overflows || open) && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="mt-1.5 border-0 bg-transparent p-0 text-[13px] text-muted-foreground hover:text-foreground hover:underline hover:underline-offset-3"
        >
          {open ? FEED.showLess : FEED.showWhole}
        </button>
      )}
      {evidence && (
        <div>
          <EvidenceBlock evidence={evidence} compact={!open} />
        </div>
      )}
    </div>
  );
}

function RoutineRun({ events }: { events: FeedEvent[] }) {
  const { state } = useView();
  const [open, setOpen] = useState(false);
  const first = events[0]!;
  const toggle = "border-0 bg-transparent p-0 text-left text-[13px] text-faint hover:text-foreground";
  if (!open) {
    return (
      <div className={cn(row, "py-[3px]")}>
        <span className={time}>{clock(first.at)}</span>
        <div>
          <button type="button" className={toggle} onClick={() => setOpen(true)}>
            {events.length === 1 ? (
              <>
                {routineText(first)}
                <Where e={first} />
              </>
            ) : (
              routineRun(events.length)
            )}{" "}
            <span aria-hidden>›</span>
          </button>
        </div>
      </div>
    );
  }
  return events.map((e, i) => (
    <div key={e.id} className={cn(row, "py-[3px]")}>
      <span className={time}>{clock(e.at)}</span>
      <div className="min-w-0 text-[13.5px] text-muted-foreground">
        {routineText(e)}
        <Where e={e} /> <span className="text-faint">· {actorOf(e, state.me)} · </span>
        <a href={e.url} target="_blank" rel="noreferrer" className="text-faint hover:text-foreground">
          {FEED.github}
        </a>
        {i === 0 && (
          <>
            {" "}
            <button type="button" className={toggle} onClick={() => setOpen(false)}>
              {FEED.hide}
            </button>
          </>
        )}
        {e.kind === "qa-evidence" && (
          <div>
            <EvidenceBlock evidence={e.evidence} compact />
          </div>
        )}
      </div>
    </div>
  ));
}
