import { isStale } from "./claims.js";
import type { GitHub, Issue } from "./github.js";
import { slicesOf, statesOf, type State } from "./machine.js";
import { storySlug } from "./slug.js";
import { storyBranch } from "./text.js";
import type { Ctx } from "./transitions.js";

export interface Row {
  number: number;
  title: string;
  /** Closed issues: merged, or closed without merging. */
  status: "open" | "merged" | "closed";
  /** The state labels of an open issue. More than one means norn cannot tell which is real; none, that it is untriaged. */
  states: State[];
  mode: "afk" | "hil" | null;
  blockedBy: number[];
  needsHuman: boolean;
  heldSince: string | null;
  stale: boolean;
}

export interface StatusResult {
  ok: true;
  kind: "status";
  story: Row & { owner: string | null; branch: string };
  slices: Row[];
}

/** Read-only overview. Makes no changes. */
export async function status(ctx: Ctx, n: number): Promise<StatusResult> {
  const { github } = ctx;
  const now = ctx.now();
  const staleAfterMs = ctx.config.staleAfterMs;
  const story = await github.getIssue(n);
  const slices = await slicesOf(github, n);
  const rows: Row[] = [];
  for (const s of slices) rows.push(await row(github, s, now, staleAfterMs));
  const head = await row(github, story, now, staleAfterMs);
  return {
    ok: true,
    kind: "status",
    story: { ...head, owner: story.assignees[0] ?? null, branch: storyBranch(n, await storySlug(ctx, story)) },
    slices: rows,
  };
}

async function row(github: GitHub, issue: Issue, now: Date, staleAfterMs: number): Promise<Row> {
  const closed = issue.state === "closed";
  const claim = closed ? null : await github.readClaim(issue.number);
  const blockers = closed ? [] : await github.blockedBy(issue.number);
  return {
    number: issue.number,
    title: issue.title,
    status: closed ? (issue.stateReason === "not_planned" ? "closed" : "merged") : "open",
    states: closed ? [] : statesOf(issue),
    mode: issue.labels.includes("mode:hil") ? "hil" : issue.labels.includes("mode:afk") ? "afk" : null,
    blockedBy: blockers.filter((b) => b.state === "open").map((b) => b.number),
    needsHuman: issue.labels.includes("needs-human"),
    heldSince: claim?.since ?? null,
    stale: claim ? isStale(claim, now, staleAfterMs) : false,
  };
}
