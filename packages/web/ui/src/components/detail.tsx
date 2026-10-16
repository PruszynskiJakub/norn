import { Fragment } from "react";
import { cn } from "../lib/utils.ts";
import { type Item, PIPELINE, isDone, latestEvidenceOf, mergedSlices, pipelinePosition } from "../model.ts";
import { useView } from "../view.ts";
import { DETAIL, fixRoundsUsed, holderSentence, progressCount, slicesMerged, stateSentence, waitingHeading, waitingReason } from "../wording.ts";
import { CopyCommand } from "./copy-command.tsx";
import { EvidenceBlock } from "./evidence.tsx";

const kickerClass = "text-[13px] text-faint";
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

/** The selected story or slice, in sentences. */
export function Detail({ x }: { x: Item }) {
  const { state, item, now, select } = useView();
  const story = state.board.find((s) => s.number === x.story);
  const waiting = state.waiting.find((w) => w.issue === x.number);
  const evidence = latestEvidenceOf(x, state.feed);
  const at = pipelinePosition(x);
  const blocked = x.states.includes("blocked");
  return (
    <div>
      <div className={kickerClass}>
        {x.isStory ? (
          DETAIL.story
        ) : (
          <>
            {DETAIL.sliceOf}{" "}
            <button type="button" className={cn(inlineLink, "text-muted-foreground")} onClick={() => select(x.story)}>
              {story?.title ?? `#${x.story}`}
            </button>
          </>
        )}
      </div>
      <h3 className="mt-1 mb-1.5 font-semibold text-[18px] leading-[1.35] tracking-[-0.01em]">{x.title}</h3>
      <p className="mt-0 mb-[18px] text-soft">
        {stateSentence(x)}.{x.holder && !isDone(x) && ` ${holderSentence(x.holder, state.me, now)}`}
      </p>
      {waiting && (
        <div className="mb-[22px] rounded-xl bg-warn-bg px-4 py-3.5">
          <b className="mb-0.5 block font-medium text-[14px] text-warn">{waitingHeading(waiting)}</b>
          <p className="mt-0 mb-2.5 text-[14px] text-soft">{waitingReason(waiting)}</p>
          <CopyCommand command={waiting.command} />
        </div>
      )}
      {!x.isStory && !blocked && (
        <>
          <div className="mb-1.5 flex gap-[3px]">
            {PIPELINE.map((s, i) => (
              <span key={s} className={cn("h-1 flex-1 rounded-sm bg-border", i < at && "bg-ok", i === at && "bg-live")} />
            ))}
          </div>
          <div className="mb-[22px] flex justify-between text-[11.5px] text-faint">
            {DETAIL.pipeline.map((l) => (
              <span key={l}>{l}</span>
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
        {(!x.isStory || x.fixRounds > 0) && (
          <li>
            <FixPips used={x.fixRounds} max={x.maxFixRounds} /> {fixRoundsUsed(x.fixRounds, x.maxFixRounds)}
          </li>
        )}
        {x.humanQa && !isDone(x) && <li>{DETAIL.humanQa}</li>}
        {x.isStory && story && (
          <>
            <li>{slicesMerged(mergedSlices(story), story.slices.length)}</li>
            <li>
              <span className="font-mono text-[12.5px] text-muted-foreground">{story.branch}</span>
            </li>
          </>
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

/** With nothing selected: one progress bar per open story. */
export function Progress() {
  const { state, select } = useView();
  const open = state.board.filter((s) => !isDone(s));
  return (
    <div>
      <div className={cn(kickerClass, "mb-4")}>{DETAIL.progress}</div>
      {open.length === 0 && <p className="text-[14px] text-muted-foreground">{DETAIL.noStories}</p>}
      {open.map((s) => {
        const merged = mergedSlices(s);
        return (
          <button key={s.number} type="button" onClick={() => select(s.number)} className="mb-[18px] block w-full border-0 bg-transparent p-0 text-left">
            <span className="flex justify-between gap-2.5 text-[14px]">
              <span>{s.title}</span>
              <span className="whitespace-nowrap text-[13px] text-faint">{progressCount(merged, s.slices.length)}</span>
            </span>
            <span className="mt-1.5 block h-1 overflow-hidden rounded-sm bg-border">
              <i className="block h-full rounded-sm bg-ok" style={{ width: `${s.slices.length ? (merged / s.slices.length) * 100 : 0}%` }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
