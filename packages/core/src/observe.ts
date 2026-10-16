import { fixStatesOf, slicesAmong, uses } from "./behaviours.js";
import type { State } from "./built-in-flows.js";
import { isStale } from "./claims.js";
import { byTime, type FeedEvent, feedOf } from "./feed.js";
import { builtInFlowOf, type Flow, flowStatesOf, modeOf } from "./flow.js";
import type { ObservedIssue, ObservedStory } from "./github.js";
import { recordedSlug } from "./slug.js";
import { slugify, storyBranch } from "./text.js";
import { type Ctx, fixRounds, lastNeedsHumanReason, needsHumanIn, parseTransitionComment } from "./transitions.js";

/** Who holds an item's claim now. */
export interface ClaimHolder {
  /** GitHub login. */
  login: string;
  session: string;
  since: string;
  stale: boolean;
}

/** One story or slice on the board. */
export interface BoardItem {
  number: number;
  title: string;
  url: string;
  /** Closed issues: merged, or closed without merging. */
  status: "open" | "merged" | "closed";
  /** The state labels of an open issue. More than one means norn cannot tell which is real. */
  states: State[];
  /** Every label on the issue, as GitHub has them, in its order. */
  labels: string[];
  mode: "afk" | "hil" | null;
  /** Open blockers. */
  blockedBy: number[];
  holder: ClaimHolder | null;
  /** Fix rounds counting toward the limit. */
  fixRounds: number;
  maxFixRounds: number;
  needsHuman: boolean;
  /** The reason norn recorded for needs-human, opaque; null without one. */
  needsHumanReason: string | null;
  /** A person QAs it before it merges: its flow has a human gate for its mode, e.g. every story, and a slice in mode:hil. */
  humanQa: boolean;
  /** The QA evidence of its latest run, if any. */
  latestEvidence: { branch: string; sha: string; files: string[] } | null;
  closedAt: string | null;
}

export interface BoardStory extends BoardItem {
  owner: string | null;
  branch: string;
  slices: BoardItem[];
}

/** An item waiting for the developer, with the command that picks it up. */
export interface WaitingItem {
  issue: number;
  story: number;
  title: string;
  kind: "needs-human" | "needs-human-qa";
  /** The reason norn recorded for needs-human, opaque; null for needs-human-qa or a flag set by hand. */
  reason: string | null;
  /** When it started waiting, as norn's comments record it; null when unknown. */
  since: string | null;
  /** What to tell an agent, e.g. "norn-drive 61". */
  command: string;
}

/** The claim refs of one read, passed back to the next so it can tell what changed. */
export type ClaimSnapshot = { issue: number; sha: string; login: string; session: string; since: string }[];

/** One read of the developer's work, for the dashboard. */
export interface Observation {
  ok: true;
  kind: "observation";
  /** The developer's login. */
  me: string;
  repoUrl: string;
  /** When this read was made, ISO. */
  at: string;
  board: BoardStory[];
  waiting: WaitingItem[];
  /** Newest first; only events after `since` when one was given. */
  feed: FeedEvent[];
  claims: ClaimSnapshot;
}

const WEEK_MS = 7 * 86_400_000;

/**
 * The developer's norn work in this repository, read in one go: the board,
 * what waits for them and what happened. Makes no changes. With `since`, the
 * feed holds only what happened after it; with `previous`, the last read, it
 * also says which claims were taken, released or went stale.
 * Without one, claim history is unknown and no claim event is made up.
 */
export async function observe(ctx: Ctx, opts: { since?: string | null; previous?: Pick<Observation, "at" | "claims"> | null }): Promise<Observation> {
  const now = ctx.now();
  const me = await ctx.github.currentUser();
  const closedSince = new Date(now.getTime() - WEEK_MS).toISOString();
  const work = await ctx.github.observeWork({ user: me, closedSince, since: opts.since ?? null });
  const claims = new Map(work.claims.flatMap((c) => (c.record ? [[c.issue, { ...c.record, sha: c.sha }] as const] : [])));
  const holder = (n: number): ClaimHolder | null => {
    const c = claims.get(n);
    return c ? { login: c.holder, session: c.session, since: c.since, stale: isStale(c, now, ctx.config.staleAfterMs) } : null;
  };
  const item = (i: ObservedIssue): BoardItem => {
    const closed = i.state === "closed";
    const bodies = i.nornComments.map((c) => c.body);
    const flow = builtInFlowOf(i);
    return {
      number: i.number,
      title: i.title,
      url: i.url,
      status: closed ? (i.stateReason === "not_planned" ? "closed" : "merged") : "open",
      states: closed || !flow ? [] : (flowStatesOf(i, flow) as State[]),
      labels: [...i.labels],
      mode: i.labels.includes("mode:hil") ? "hil" : i.labels.includes("mode:afk") ? "afk" : null,
      blockedBy: closed ? [] : i.blockedBy.filter((b) => b.state === "open").map((b) => b.number),
      holder: closed ? null : holder(i.number),
      fixRounds: flow ? fixRounds(bodies, fixStatesOf(flow)) : 0,
      maxFixRounds: ctx.config.maxFixRounds,
      needsHuman: i.labels.includes("needs-human"),
      needsHumanReason: i.labels.includes("needs-human") ? lastNeedsHumanReason(bodies) : null,
      humanQa: flow !== null && gated(flow, i),
      latestEvidence:
        [...bodies]
          .reverse()
          .map((b) => parseTransitionComment(b)?.evidence)
          .find((e) => e) ?? null,
      closedAt: i.closedAt,
    };
  };
  // An adapter may read more than asked, e.g. stories updated rather than closed in the window.
  const mine = (s: ObservedStory) =>
    [s, ...s.subIssues].some((i) => claims.get(i.number)?.holder === me) ||
    (s.assignees.includes(me) && (s.state === "open" || (s.closedAt ?? "") >= closedSince));
  const board: BoardStory[] = work.stories.filter(mine).map((s) => {
    const slug = recordedSlug(s.nornComments.map((c) => c.body)) ?? slugify(s.title);
    return {
      ...item(s),
      owner: s.assignees[0] ?? null,
      branch: storyBranch(s.number, slug),
      slices: slicesOfStory(s).map(item),
    };
  });
  const waiting: WaitingItem[] = [];
  for (const s of work.stories.filter((s) => s.assignees.includes(me) && s.state === "open")) {
    for (const i of [s, ...slicesOfStory(s)]) {
      if (i.state !== "open") continue;
      const flow = builtInFlowOf(i);
      const states = flow ? flowStatesOf(i, flow) : [];
      // At a human gate, a person QAs it.
      const gate = flow && states.length === 1 && uses(flow, states[0], "humanGate") ? states[0] : null;
      const kind = i.labels.includes("needs-human") ? "needs-human" : gate ? "needs-human-qa" : null;
      if (!kind) continue;
      const bodies = i.nornComments.map((c) => c.body);
      const entered = [...i.nornComments]
        .reverse()
        .find((c) => (kind === "needs-human" ? needsHumanIn(c.body) !== null : parseTransitionComment(c.body)?.to === gate));
      waiting.push({
        issue: i.number,
        story: s.number,
        title: i.title,
        kind,
        reason: kind === "needs-human" ? lastNeedsHumanReason(bodies) : null,
        since: entered?.at ?? null,
        command: `norn-drive ${i.number}`,
      });
    }
  }
  // Escalations first, then the longest waiting.
  waiting.sort((a, b) => (a.kind === b.kind ? (a.since ?? "").localeCompare(b.since ?? "") : a.kind === "needs-human" ? -1 : 1));

  const snapshot: ClaimSnapshot = [...claims].map(([issue, c]) => ({ issue, sha: c.sha, login: c.holder, session: c.session, since: c.since }));
  const feed = board.length ? work.stories.filter(mine).flatMap((s) => feedOf(s, { maxFixRounds: ctx.config.maxFixRounds, since: opts.since ?? null })) : [];
  if (opts.previous) feed.push(...claimEvents(board, opts.previous, snapshot, now, ctx.config.staleAfterMs));

  return {
    ok: true,
    kind: "observation",
    me,
    repoUrl: work.repoUrl,
    at: now.toISOString(),
    board,
    waiting,
    feed: byTime(feed),
    claims: snapshot,
  };
}

/** A story's slices on the board: the sub-issues of the type its flow's slices behaviour names. */
function slicesOfStory(s: ObservedStory): ObservedIssue[] {
  const flow = builtInFlowOf(s);
  return flow ? slicesAmong(s.subIssues, flow) : [];
}

/** Whether a person QAs an issue of the flow: it has a human gate that runs in the issue's mode. An issue with no mode runs every state. */
function gated(flow: Flow, issue: ObservedIssue): boolean {
  const mode = modeOf(issue);
  return Object.entries(flow.states).some(([name, s]) => uses(flow, name, "humanGate") && (!s.when || s.when === mode));
}

/**
 * Claim events from two reads of the claim refs, for items on the board. A
 * claim is taken when its ref is new or points at a new commit, released when
 * its ref is gone, and stale once it outlives staleAfter after the last read.
 */
function claimEvents(board: BoardStory[], last: Pick<Observation, "at" | "claims">, current: ClaimSnapshot, now: Date, staleAfterMs: number): FeedEvent[] {
  const previous = last.claims;
  const items = new Map(board.flatMap((s) => [s, ...s.slices].map((i) => [i.number, { story: s.number, url: i.url }] as const)));
  const before = new Map(previous.map((c) => [c.issue, c]));
  const after = new Map(current.map((c) => [c.issue, c]));
  const events: FeedEvent[] = [];
  const event = (c: ClaimSnapshot[number], action: "taken" | "released" | "stale", at: string) => {
    const item = items.get(c.issue);
    if (item)
      events.push({ id: `claim-${action}:${c.issue}:${c.sha}`, kind: "claim", action, issue: c.issue, ...item, at, actor: c.login, session: c.session });
  };
  // A session refreshing its own claim moves the ref but keeps holding it.
  for (const c of previous) if (after.get(c.issue)?.session !== c.session) event(c, "released", now.toISOString());
  for (const c of current) {
    if (before.get(c.issue)?.sha !== c.sha) event(c, "taken", c.since);
    const staleAt = new Date(Date.parse(c.since) + staleAfterMs).toISOString();
    // Stale since the last read, not since the feed's `since`: that reaches back before it, and the claim was stale then already.
    if (staleAt <= now.toISOString() && staleAt > last.at) event(c, "stale", staleAt);
  }
  return events;
}
