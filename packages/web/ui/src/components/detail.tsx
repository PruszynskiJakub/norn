import { Fragment } from "react";
import { cn } from "../lib/utils.ts";
import {
  countsFixRounds,
  type Item,
  isDone,
  isGateLabel,
  isHeld,
  isSliced,
  latestEvidenceOf,
  mergedSlices,
  pipelineNames,
  pipelineOf,
  pipelinePosition,
  stateColor,
} from "../model.ts";
import { useView } from "../view.ts";
import {
  DETAIL,
  fixRoundsUsed,
  holderSentence,
  kicker,
  onlyIn,
  progressCount,
  slicesMerged,
  stateSentence,
  waitingHeading,
  waitingReason,
} from "../wording.ts";
import { CopyCommand } from "./copy-command.tsx";
import { Badge } from "./ui/badge.tsx";
import { EvidenceBlock } from "./evidence.tsx";

const kickerClass = "text-[13px] text-faint";

/** Colour only where a label asks for the developer: needs-human escalated, a human gate theirs to QA. */
const labelTone = (x: Item, label: string) => (label === "needs-human" ? "bad" : isGateLabel(x, label) ? "warn" : "neutral");
const inlineLink = "border-0 bg-transparent p-0 text-left text-inherit hover:underline hover:underline-offset-3";

function FixPips({ used, max }: { used: number; max: number }) {
  return (
    <span className="inline-flex gap-[3px] align-middle" role="img" aria-label={fixRoundsUsed(used, max)}>
      {Array.from({ length: max }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: one pip per round, in a fixed order.
        <i key={i} className={cn("h-1 w-3.5 rounded-sm bg-border", i < used && (used >= max ? "bg-bad" : "bg-warn"))} />
      ))}
    </span>
  );
}

/** The selected item, e.g. a story or a slice, in sentences. */
export function Detail({ x }: { x: Item }) {
  const { state, item, now, select } = useView();
  const story = state.board.find((s) => s.number === x.story);
  const waiting = state.waiting.find((w) => w.issue === x.number);
  const evidence = latestEvidenceOf(x, state.feed);
  const sliced = isSliced(x);
  const stops = pipelineOf(x);
  const at = pipelinePosition(x, stops);
  return (
    <div>
      <div className={kickerClass}>
        {x.isStory ? (
          kicker(x)
        ) : (
          <>
            {kicker(x)}{" "}
            <button type="button" className={cn(inlineLink, "text-muted-foreground")} onClick={() => select(x.story)}>
              {story?.title ?? `#${x.story}`}
            </button>
          </>
        )}
      </div>
      <h3 className="mt-1 mb-1.5 font-semibold text-[18px] leading-[1.35] tracking-[-0.01em]">{x.title}</h3>
      {x.labels.length > 0 && (
        <div className="mb-2.5 flex flex-wrap gap-1" title={DETAIL.labels}>
          {x.labels.map((l) => {
            const color = stateColor(x, l);
            return (
              <Badge key={l} tone={labelTone(x, l)}>
                {color && <i className="mr-1 inline-block size-[7px] rounded-full" style={{ background: color }} />}
                {l}
              </Badge>
            );
          })}
        </div>
      )}
      <p className="mt-0 mb-[18px] text-soft">
        {stateSentence(x)}.{x.holder && !isDone(x) && ` ${holderSentence(x.holder, state.me, now)}`}
      </p>
      {waiting && (
        <div className="mb-[22px] rounded-xl bg-warn-bg px-4 py-3.5">
          <b className="mb-0.5 block font-medium text-[14px] text-warn">{waitingHeading(waiting)}</b>
          <p className="mt-0 mb-2.5 text-[14px] text-soft">{waitingReason(waiting, x)}</p>
          <CopyCommand command={waiting.command} />
        </div>
      )}
      {!sliced && !isHeld(x) && stops.length > 0 && (
        <>
          <div className="mb-1.5 flex gap-[3px]">
            {stops.map((s, i) => (
              <span
                key={s.state}
                title={s.when ? `${s.state}, ${onlyIn(s.when)}` : s.state}
                className={cn("h-1 flex-1 rounded-sm bg-border", i < at && "bg-ok", i === at && "bg-live", s.when && i > at && "opacity-50")}
              />
            ))}
          </div>
          <div className="mb-[22px] flex justify-between text-[11.5px] text-faint">
            {pipelineNames(stops).map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a name can come back later in a flow, at another place.
              <span key={i}>{l}</span>
            ))}
          </div>
        </>
      )}
      <ul className="m-0 mb-[22px] list-none p-0 [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:gap-2.5 [&>li]:border-border [&>li]:border-t [&>li]:py-[9px] [&>li]:text-[14px] [&>li]:text-soft [&>li:last-child]:border-b">
        {x.blockedBy.length > 0 && (
          <li>
            <span>
              {DETAIL.waitsFor}{" "}
              {x.blockedBy.map((b, i) => (
                <Fragment key={b}>
                  {i > 0 && ` ${DETAIL.and} `}
                  <button type="button" className={inlineLink} onClick={() => select(b)}>
                    {item(b)?.title ?? `#${b}`}
                  </button>
                </Fragment>
              ))}
            </span>
          </li>
        )}
        {(x.fixRounds > 0 || (countsFixRounds(x) && !sliced)) && (
          <li>
            <FixPips used={x.fixRounds} max={x.maxFixRounds} /> {fixRoundsUsed(x.fixRounds, x.maxFixRounds)}
          </li>
        )}
        {x.humanQa && !isDone(x) && <li>{DETAIL.humanQa}</li>}
        {x.isStory && story && sliced && <li>{slicesMerged(mergedSlices(story), story.slices.length)}</li>}
        {x.isStory && story?.branch && (
          <li>
            <span className="font-mono text-[12.5px] text-muted-foreground">{story.branch}</span>
          </li>
        )}
      </ul>
      {evidence && (
        <>
          <div className={cn(kickerClass, "-mb-1")}>{DETAIL.latestEvidence}</div>
          <EvidenceBlock evidence={evidence} />
        </>
      )}
      <p className="mt-[22px]">
        <a className="text-[13px] text-muted-foreground" href={x.url} target="_blank" rel="noreferrer">
          {DETAIL.openOnGitHub}
        </a>
      </p>
    </div>
  );
}

/** How far a top-level issue got: its slices merged when its flow slices, else its pipeline's stops passed. */
function progressOf(x: Item, slices: number, merged: number): { done: number; of: number } {
  if (isSliced(x)) return { done: merged, of: slices };
  const stops = pipelineOf(x);
  return { done: Math.max(0, pipelinePosition(x, stops)), of: stops.length };
}

/** With nothing selected: one progress bar per open top-level issue. */
export function Progress() {
  const { state, item, select } = useView();
  const open = state.board.filter((s) => !isDone(s));
  return (
    <div>
      <div className={cn(kickerClass, "mb-4")}>{DETAIL.progress}</div>
      {open.length === 0 && <p className="text-[14px] text-muted-foreground">{DETAIL.noStories}</p>}
      {open.map((s) => {
        const x = item(s.number);
        const { done, of } = x ? progressOf(x, s.slices.length, mergedSlices(s)) : { done: 0, of: 0 };
        return (
          <button key={s.number} type="button" onClick={() => select(s.number)} className="mb-[18px] block w-full border-0 bg-transparent p-0 text-left">
            <span className="flex justify-between gap-2.5 text-[14px]">
              <span>{s.title}</span>
              <span className="whitespace-nowrap text-[13px] text-faint">{x && isSliced(x) ? progressCount(done, of) : `${done} of ${of}`}</span>
            </span>
            <span className="mt-1.5 block h-1 overflow-hidden rounded-sm bg-border">
              <i className="block h-full rounded-sm bg-ok" style={{ width: `${of ? (done / of) * 100 : 0}%` }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
