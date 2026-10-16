import { blockedStates, fixStatesOf, slicesAmong } from "./behaviours.js";
import type { State, Target } from "./built-in-flows.js";
import { builtInFlowOf, type Flow, flowStep } from "./flow.js";
import type { Issue, ObservedStory } from "./github.js";
import { ENGINE_FLAGS, type Step } from "./machine.js";
import { recordedSlug } from "./slug.js";
import { sliceBranch, slugify, storyBranch } from "./text.js";
import { type Evidence, fixRounds, needsHumanIn, parseTransitionComment } from "./transitions.js";

/** What every feed event carries. `actor` is a GitHub login, null for a deleted account. */
interface FeedBase {
  /** Stable across polls, so the same event read twice is one event. */
  id: string;
  issue: number;
  /** The story the issue belongs to; the issue itself for a story. */
  story: number;
  /** ISO time. */
  at: string;
  actor: string | null;
  /** Where to see it on GitHub: the comment, the PR or the issue. */
  url: string;
}

/**
 * Something that happened on the developer's work, in norn's terms. Every
 * variant is data; the dashboard's renderer words it.
 */
export type FeedEvent =
  /** A state change norn made on its own, or a person made by hand. `to` is closed when the issue closed. */
  | (FeedBase & { kind: "step"; from: State | null; to: State | "closed" })
  /**
   * A step ended with an outcome. `step` is its name as the machine has it,
   * e.g. review, agent QA, implementation; `outcome` the word, "done" for a
   * step with a single way to end. `fixRound` is the round this outcome
   * starts or finishes, null when it is no fix round. `note` is the agent's
   * remark as markdown.
   */
  | (FeedBase & {
      kind: "outcome";
      step: string;
      outcome: string;
      from: State | null;
      to: Target;
      fixRound: number | null;
      maxFixRounds: number;
      note: string | null;
      evidence: Evidence | null;
    })
  /** `reason` is the one norn recorded, null when the flag was set by hand. */
  | (FeedBase & { kind: "needs-human"; action: "raised" | "resolved"; reason: string | null })
  | (FeedBase & { kind: "qa-evidence"; evidence: Evidence })
  | (FeedBase & { kind: "slice"; action: "created" | "unblocked" })
  | (FeedBase & { kind: "pr"; action: "opened" | "merged"; target: "story" | "slice"; pr: number })
  /** Seen by comparing claim refs between two reads; `at` is the claim's time for taken and stale, the read's for released. */
  | (FeedBase & { kind: "claim"; action: "taken" | "released" | "stale"; session: string })
  /** Anything norn does not recognise. `detail` is opaque, e.g. IssueComment or LabeledEvent; `label` names a label that changed. */
  | (FeedBase & { kind: "other-activity"; detail: string; label?: string });

export type FeedEventKind = FeedEvent["kind"];

/** What feedOf needs besides the story: facts of the read and the team's configuration. */
export interface FeedContext {
  maxFixRounds: number;
  /** Only events after this ISO time; null for all. */
  since: string | null;
}

/**
 * The story's history as feed events, newest first, translated from what
 * GitHub recorded: norn's transition comments, label changes, sub-issues and
 * linked PRs. Pure: the same story always gives the same events.
 */
export function feedOf(story: ObservedStory, fc: FeedContext): FeedEvent[] {
  const storyFlow = builtInFlowOf(story);
  const slices = storyFlow ? slicesAmong(story.subIssues, storyFlow) : [];
  const slug = recordedSlug(story.nornComments.map((c) => c.body)) ?? slugify(story.title);
  const events: FeedEvent[] = [];
  for (const issue of [story, ...slices]) {
    // Each issue runs its flow, read without GitHub so the feed stays pure.
    const flow = builtInFlowOf(issue);
    const states: readonly string[] = flow ? Object.keys(flow.states) : [];
    const fixStates: readonly string[] = flow ? fixStatesOf(flow) : [];
    const blocked = flow ? blockedStates(flow) : null;
    /** Whether norn released the issue from being held by its blockers. */
    const released = (from: string | null, to: string) => blocked !== null && from === blocked.held && to === blocked.release;
    const base = { issue: issue.number, story: story.number };
    const ofIssue = { ...base, url: issue.url };
    const bodies = issue.nornComments.map((c) => c.body);
    const transitions = issue.timeline.flatMap((t) => {
      const c = t.kind === "comment" && t.body !== null ? parseTransitionComment(t.body) : null;
      return c && t.kind === "comment" ? [{ t, c }] : [];
    });
    /** norn's comment that goes with a change at `at`: norn comments within a minute of changing labels. */
    const near = <T extends { t: { at: string } }>(list: T[], at: string, ok: (x: T) => boolean) =>
      list.find((x) => Math.abs(Date.parse(x.t.at) - Date.parse(at)) <= MATCH_MS && ok(x));
    const markers = issue.timeline.flatMap((t) => (t.kind === "comment" && t.body !== null ? [{ t, reason: needsHumanIn(t.body) }] : []));

    // The PR from the issue's branch, as its workspace names it: the story PR on the story, a slice PR on its slice.
    // A PR comes before what norn does about it at the same time, e.g. closing the story it merged.
    const branch = flow?.workspace === "parent" ? sliceBranch(story.number, slug, issue.number) : storyBranch(issue.number, slug);
    const target = issue === story ? "story" : "slice";
    for (const pr of issue.pullRequests.filter((p) => p.head === branch)) {
      const at = { ...base, url: pr.url, target, pr: pr.number } as const;
      events.push({ ...at, id: `pr-opened:${pr.number}`, kind: "pr", action: "opened", at: pr.createdAt, actor: pr.author });
      if (pr.mergedAt) events.push({ ...at, id: `pr-merged:${pr.number}`, kind: "pr", action: "merged", at: pr.mergedAt, actor: pr.mergedBy });
    }
    for (const [i, t] of issue.timeline.entries()) {
      if (t.kind === "comment") {
        if (t.body === null) {
          events.push({ ...base, id: `other:${t.url}`, kind: "other-activity", at: t.at, actor: t.actor, url: t.url, detail: "IssueComment" });
          continue;
        }
        const c = parseTransitionComment(t.body);
        if (!c || c.why === "needs-human resolved") continue;
        const from = states.includes(c.from) ? (c.from as State) : null;
        const to = targetOf(c.to);
        const at = { ...base, at: t.at, actor: t.actor, url: t.url };
        if (c.why === "automatic") {
          events.push(
            released(from, to)
              ? { ...at, id: `slice:${t.url}`, kind: "slice", action: "unblocked" }
              : { ...at, id: `step:${t.url}`, kind: "step", from, to: to === "not-planned" ? "closed" : (to as State | "closed") },
          );
          continue;
        }
        // Rounds counted up to this comment, as done counted them when it wrote it.
        // By the comment's URL: norn writes the same words for, say, every implement done without a note.
        const upTo = bodies.slice(0, issue.nornComments.findIndex((pc) => pc.url === t.url) + 1);
        const step = stepAt(issue, from, flow);
        // Review or QA sending the issue back starts a round; the implement after it finishes that round.
        const entersFix = fixStates.includes(to) && from !== to;
        const fixRound = entersFix ? fixRounds(upTo.slice(0, -1), fixStates) + 1 : fixes(from, flow) ? fixRounds(upTo, fixStates) || null : null;
        events.push({
          ...at,
          id: `outcome:${t.url}`,
          kind: "outcome",
          step: step?.name ?? from ?? "triage",
          outcome: c.why ?? "done",
          from,
          to,
          fixRound,
          maxFixRounds: fc.maxFixRounds,
          note: c.note,
          evidence: c.evidence,
        });
        if (c.evidence) events.push({ ...at, id: `qa-evidence:${t.url}`, kind: "qa-evidence", evidence: c.evidence });
        continue;
      }
      const id = `${t.kind}:${issue.number}:${t.at}:${i}`;
      if (t.kind === "labeled" || t.kind === "unlabeled") {
        if (t.label === "needs-human") {
          const raised = t.kind === "labeled";
          const said = raised ? near(markers, t.at, (m) => m.reason !== null) : near(transitions, t.at, (x) => x.c.why === "needs-human resolved");
          const reason = raised ? ((said as { reason: string | null } | undefined)?.reason ?? null) : null;
          events.push({
            ...ofIssue,
            id,
            kind: "needs-human",
            action: raised ? "raised" : "resolved",
            reason,
            at: t.at,
            actor: t.actor,
            url: said?.t.url ?? issue.url,
          });
          continue;
        }
        if (states.includes(t.label)) {
          // A state change shows as the new label added, then the old one removed; norn's own come with a comment that says more.
          if (t.kind === "unlabeled") continue;
          const old = issue.timeline
            .slice(i + 1)
            .find((u) => u.kind === "unlabeled" && states.includes(u.label) && Date.parse(u.at) - Date.parse(t.at) <= MATCH_MS);
          if (old?.kind !== "unlabeled") continue;
          if (near(transitions, t.at, (x) => x.c.to === t.label)) continue;
          const from = old.label as State;
          const to = t.label as State;
          events.push(
            released(from, to)
              ? { ...ofIssue, id, kind: "slice", action: "unblocked", at: t.at, actor: t.actor }
              : { ...ofIssue, id, kind: "step", from, to, at: t.at, actor: t.actor },
          );
          continue;
        }
        if ((ENGINE_FLAGS as readonly string[]).includes(t.label) || t.label.startsWith("type:")) continue;
        events.push({
          ...ofIssue,
          id,
          kind: "other-activity",
          detail: t.kind === "labeled" ? "LabeledEvent" : "UnlabeledEvent",
          label: t.label,
          at: t.at,
          actor: t.actor,
        });
        continue;
      }
      if (t.kind === "closed") {
        if (near(transitions, t.at, (x) => x.c.to.startsWith("closed"))) continue;
        events.push({ ...ofIssue, id, kind: "step", from: null, to: "closed", at: t.at, actor: t.actor });
        continue;
      }
      if (t.kind === "sub-issue-added") {
        const child = slices.find((s) => s.number === t.child);
        if (child) events.push({ issue: child.number, story: story.number, url: child.url, id, kind: "slice", action: "created", at: t.at, actor: t.actor });
        continue;
      }
      if (t.kind === "other") events.push({ ...ofIssue, id, kind: "other-activity", detail: t.detail, at: t.at, actor: t.actor, url: t.url ?? issue.url });
      else events.push({ ...ofIssue, id, kind: "other-activity", detail: "ReopenedEvent", at: t.at, actor: t.actor });
    }
  }
  return newestFirst(events.filter((e) => fc.since === null || e.at > fc.since));
}

/** How far apart a label change and the norn comment that explains it can be. */
const MATCH_MS = 60_000;

function targetOf(to: string): Target {
  return to === "closed as not planned" ? "not-planned" : (to as Target);
}

/** The step an issue of the flow in `from` was in; null for none, e.g. triage, before it had the flow. */
function stepAt(issue: Issue, from: State | null, flow: Flow | null): Step | null {
  if (!flow || !from) return null;
  const flags = issue.labels.filter((l) => !Object.hasOwn(flow.states, l) && l !== "needs-human");
  return flowStep({ ...issue, state: "open" as const, labels: [...flags, from] }, flow);
}

/** Whether the step taken in `from` fixes what a fix round sent back: a step in a state that counts rounds, or in the one such a state enters as. */
function fixes(from: string | null, flow: Flow | null): boolean {
  return flow !== null && from !== null && fixStatesOf(flow).some((s) => s === from || flow.states[s].enterAs === from);
}

/** Newest-first lists merged into one, newest first; events at the same time keep their order. */
export function byTime(events: FeedEvent[]): FeedEvent[] {
  return [...events].sort((a, b) => b.at.localeCompare(a.at));
}

/** Newest first. Events at the same time come in the reverse of the order they were given, as if each came after the one before. */
export function newestFirst(events: FeedEvent[]): FeedEvent[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.at.localeCompare(a.e.at) || b.i - a.i)
    .map((x) => x.e);
}
