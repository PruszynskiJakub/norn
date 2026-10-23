import { isStale } from "./claims.js";
import { slicesOf } from "./behaviours.js";
import { flowNameOf, flowStatesOf, usedIn } from "./flow.js";
import { flowOf, validFlow } from "./flow-loading.js";
import type { Issue } from "./github.js";
import { locate } from "./location.js";
import { agentAsks } from "./next.js";
import type { WaitItem } from "./waiting.js";
import type { Ctx } from "./transitions.js";

export interface Row {
  number: number;
  title: string;
  /** Closed issues: merged, or closed without merging. */
  status: "open" | "merged" | "closed";
  /** The state labels of its flow on an open issue. More than one means norn cannot tell which is real; none, that it is untriaged. */
  states: string[];
  mode: "afk" | "hil" | null;
  blockedBy: number[];
  needsHuman: boolean;
  /** The agent holding it waits on a person's answer; `asks` on the result says what it asked. */
  agentAsks: boolean;
  heldSince: string | null;
  stale: boolean;
}

export interface StatusResult {
  ok: true;
  kind: "status";
  /**
   * The issue asked about: its type (`flow`, null before triage), owner, and branch (null when its flow gives it none).
   * `makesSlices` says whether its flow has slices at all.
   */
  story: Row & { flow: string | null; owner: string | null; branch: string | null; makesSlices: boolean };
  slices: Row[];
  /** What agents holding the issue or its slices ask a person, listed first: items of reason agent-asks. */
  asks: WaitItem[];
}

/** Read-only overview. Makes no changes. */
export async function status(ctx: Ctx, n: number): Promise<StatusResult> {
  const { github } = ctx;
  const now = ctx.now();
  const staleAfterMs = ctx.config.staleAfterMs;
  const story = await github.getIssue(n);
  const flow = validFlow(await flowOf(ctx, story));
  const slices = flow ? await slicesOf(github, n, flow) : [];
  const rows: Row[] = [];
  for (const s of slices) rows.push(await row(ctx, s, now, staleAfterMs));
  const head = await row(ctx, story, now, staleAfterMs);
  const asks: WaitItem[] = [];
  for (const i of [story, ...slices]) {
    if (i.state !== "open") continue;
    const item = await agentAsks(ctx, i, i === story ? flow : validFlow(await flowOf(ctx, i)));
    if (item) asks.push(item);
  }
  return {
    ok: true,
    kind: "status",
    story: {
      ...head,
      flow: flowNameOf(story),
      owner: story.assignees[0] ?? null,
      branch: (await locate(story, ctx, flow))?.branch ?? null,
      makesSlices: flow !== null && usedIn(flow, "slices"),
    },
    slices: rows,
    asks,
  };
}

async function row(ctx: Ctx, issue: Issue, now: Date, staleAfterMs: number): Promise<Row> {
  const { github } = ctx;
  const closed = issue.state === "closed";
  const flow = closed ? null : validFlow(await flowOf(ctx, issue));
  const claim = closed ? null : await github.readClaim(issue.number);
  const blockers = closed ? [] : await github.blockedBy(issue.number);
  return {
    number: issue.number,
    title: issue.title,
    status: closed ? (issue.stateReason === "not_planned" ? "closed" : "merged") : "open",
    states: flow ? flowStatesOf(issue, flow) : [],
    mode: issue.labels.includes("mode:hil") ? "hil" : issue.labels.includes("mode:afk") ? "afk" : null,
    blockedBy: blockers.filter((b) => b.state === "open").map((b) => b.number),
    needsHuman: issue.labels.includes("needs-human"),
    agentAsks: claim?.waiting !== undefined,
    heldSince: claim?.since ?? null,
    stale: claim ? isStale(claim, now, staleAfterMs) : false,
  };
}
