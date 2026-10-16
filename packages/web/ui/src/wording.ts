// The dashboard's renderer: every sentence the page shows is worded here, from
// the typed read model, so the rest of the UI only lays words out.
import type { BoardItem, ClaimHolder, FeedEvent, State, WaitingItem } from "@norn/core";
import type { DashboardState, PollFailure } from "../../src/contract.ts";
import { stateOf } from "./model.ts";

function unreachable(x: never): never {
  throw new Error(`no wording for ${JSON.stringify(x)}`);
}

const MINUTE = 60_000;

/** A duration in the page's short form: "4m", "1h 37m", "2d". */
export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / MINUTE));
  if (m < 60) return `${Math.max(1, m)}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(m / (60 * 24))}d`;
}

export function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  return ms < MINUTE ? "just now" : `${duration(ms)} ago`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The heading of a day in the feed, in the browser's time zone. */
export function dayLabel(iso: string, now: number): string {
  const day = new Date(iso).toDateString();
  if (day === new Date(now).toDateString()) return "Today";
  if (day === new Date(now - 24 * 60 * MINUTE).toDateString()) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

export function login(l: string | null, me: string | null): string {
  if (l === null) return "a deleted account";
  return l === me ? "you" : `@${l}`;
}

/** Who did it, small and grey under the event. Claims name the agent session that holds them. */
export function actorOf(e: FeedEvent, me: string | null): string {
  if (e.kind === "claim") return `agent ${e.session}`;
  return login(e.actor, me);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function qaWho(step: string, actor: string | null, me: string | null): string {
  if (step === "agent QA") return "Agent QA";
  return actor !== null && actor === me ? "Your QA" : "Human QA";
}

/** An outcome as a sentence: "Review asked for changes", "Agent QA passed". */
function outcomeSentence(e: Extract<FeedEvent, { kind: "outcome" }>, me: string | null): string {
  switch (e.step) {
    case "implementation":
      return e.fixRound ? `Fix round ${e.fixRound} pushed` : "Implementation pushed";
    case "fixing":
      return e.fixRound ? `Story fixes pushed, round ${e.fixRound}` : "Story fixes pushed";
    case "review":
      if (e.outcome === "approve") return "Review approved";
      if (e.outcome === "request-changes") return "Review asked for changes";
      break;
    case "agent QA":
    case "human QA":
      if (e.outcome === "pass") return `${qaWho(e.step, e.actor, me)} passed`;
      if (e.outcome === "fail") return `${qaWho(e.step, e.actor, me)} failed`;
      break;
    case "merge":
      return "Merged into the story branch";
    case "resolving needs-human":
      return "Escalation resolved";
    case "triage":
      if (e.outcome === "story") return "Accepted at triage as a story";
      if (e.outcome === "reject") return "Rejected at triage";
      break;
    case "refinement":
      if (e.outcome === "clear") return "Refined, no open questions";
      if (e.outcome === "questions") return "Refinement raised questions";
      break;
    case "clarification":
      if (e.outcome === "answered") return "Questions answered";
      if (e.outcome === "questions") return "Questions remain after clarification";
      break;
    case "planning":
      return "Plan written";
    case "slicing":
      return "Sliced";
  }
  return e.outcome === "done" ? `${capitalise(e.step)} done` : `${capitalise(e.step)}: ${e.outcome}`;
}

function otherActivity(e: Extract<FeedEvent, { kind: "other-activity" }>): string {
  if (e.detail === "IssueComment") return "commented";
  if (e.detail === "LabeledEvent" && e.label) return `labelled ${e.label}`;
  if (e.detail === "UnlabeledEvent" && e.label) return `removed label ${e.label}`;
  return `other activity: ${e.detail}${e.label ? ` (${e.label})` : ""}`;
}

/** A routine event in norn's own terms: "needs-qa → qa-failed", "claim taken". */
export function routineText(e: FeedEvent): string {
  switch (e.kind) {
    case "step":
      return `${e.from ?? "no state"} → ${e.to}`;
    case "outcome":
      return `${e.step}: ${e.outcome}${e.fixRound ? `, fix round ${e.fixRound}/${e.maxFixRounds}` : ""}`;
    case "needs-human":
      return e.action === "raised" ? `needs-human raised${e.reason ? `: ${e.reason}` : ""}` : "needs-human resolved";
    case "qa-evidence":
      return `QA evidence pushed to ${e.evidence.branch} (${files(e.evidence.files.length)})`;
    case "slice":
      return e.action === "created" ? "slice created" : "slice unblocked";
    case "pr":
      return `${e.target} PR #${e.pr} ${e.action}`;
    case "claim":
      if (e.action === "taken") return "claim taken";
      if (e.action === "released") return "claim released";
      return "claim went stale";
    case "other-activity":
      return otherActivity(e);
    default:
      return unreachable(e);
  }
}

/** A significant event as a plain sentence; anything else keeps norn's terms. */
export function sentence(e: FeedEvent, me: string | null): string {
  switch (e.kind) {
    case "outcome":
      return outcomeSentence(e, me);
    case "needs-human":
      return e.action === "raised" ? "Escalated to you" : "Escalation resolved";
    case "pr":
      return e.action === "merged" ? `${e.target === "story" ? "Story" : "Slice"} PR #${e.pr} merged` : routineText(e);
    case "claim":
      return e.action === "stale" ? `Agent ${e.session} went quiet` : routineText(e);
    case "step":
    case "qa-evidence":
    case "slice":
    case "other-activity":
      return routineText(e);
    default:
      return unreachable(e);
  }
}

/** "· round 2 of 3" after a review or QA outcome inside a fix round. */
export function roundNote(e: FeedEvent): string | null {
  if (e.kind !== "outcome" || !e.fixRound || e.step === "implementation" || e.step === "fixing") return null;
  return `round ${e.fixRound} of ${e.maxFixRounds}`;
}

/** The reason under an escalation, when norn recorded one. */
export function escalationReason(e: FeedEvent): string | null {
  return e.kind === "needs-human" && e.action === "raised" ? e.reason : null;
}

export function files(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

export function onItem(title: string | undefined, issue: number): string {
  return `on ${title ?? `#${issue}`}`;
}

export function routineRun(n: number): string {
  return `${n} routine updates`;
}

function stateWords(s: State): string {
  switch (s) {
    case "needs-refinement":
      return "Waiting for refinement";
    case "needs-clarification":
      return "Waiting for answers to its open questions";
    case "needs-plan":
      return "Waiting for a plan";
    case "needs-slicing":
      return "Waiting to be sliced";
    case "blocked":
      return "Blocked";
    case "ready-for-agent":
      return "Ready for an agent";
    case "implementation":
      return "Being implemented";
    case "needs-review":
      return "Waiting for review";
    case "changes-requested":
      return "Back for fixes after review";
    case "needs-qa":
      return "Waiting for agent QA";
    case "needs-human-qa":
      return "Waiting for your QA";
    case "qa-failed":
      return "Back for fixes after QA";
    case "merge-queue":
      return "Queued to merge";
    default:
      return unreachable(s);
  }
}

/** Where an item stands, as a sentence without its full stop. */
export function stateSentence(x: BoardItem): string {
  const s = stateOf(x);
  if (s === "merged") return "Merged";
  if (s === "closed") return "Closed without merging";
  if (s === null) return x.states.length ? `Its state labels disagree: ${x.states.join(" and ")}` : "Has no norn state label";
  return stateWords(s);
}

/** Who holds an item, as a sentence. */
export function holderSentence(h: ClaimHolder, me: string | null, now: number): string {
  const who = h.login === me ? `Agent ${h.session}` : `${login(h.login, me)}'s agent ${h.session}`;
  const since = duration(now - Date.parse(h.since));
  return h.stale ? `${who} went quiet ${since} ago.` : `${who} on it for ${since}.`;
}

export function quietFor(h: ClaimHolder, now: number): string {
  return `agent ${h.session} quiet for ${duration(now - Date.parse(h.since))}`;
}

export function fixRoundsUsed(used: number, max: number): string {
  return used ? `${used} of ${max} fix rounds used` : "No fix rounds yet";
}

export function slicesMerged(merged: number, total: number): string {
  return total ? `${merged} of ${total} slices merged` : "Not sliced yet";
}

export function progressCount(merged: number, total: number): string {
  return total ? `${merged} of ${total}` : "no slices";
}

/** The short flag beside an item in the sidebar, only where it needs attention. */
export function itemFlag(x: BoardItem): { text: string; tone: "bad" | "warn" } | null {
  if (x.needsHuman) return { text: "needs you", tone: "bad" };
  if (x.states.includes("needs-human-qa")) return { text: "your QA", tone: "warn" };
  if (x.holder?.stale) return { text: "quiet", tone: "warn" };
  return null;
}

/** Fixed labels of the page. */
export const SIDEBAR = {
  overview: "Overview",
  yourStories: "Your stories",
  noStories: "No open stories of yours.",
  closedThisWeek: "Closed this week",
};

export const DETAIL = {
  story: "Story",
  sliceOf: "Slice of",
  waitsFor: "Waits for",
  and: "and",
  humanQa: "You QA this one before it merges",
  labels: "Labels on GitHub",
  latestEvidence: "Latest QA evidence",
  openOnGitHub: "Open on GitHub ↗",
  progress: "Progress",
  noStories: "Nothing in progress.",
  pipeline: ["build", "review", "QA", "merge"],
};

export const FEED = {
  everything: "Everything",
  remarks: "Remarks",
  all: "All",
  implement: "Implement",
  review: "Review",
  qa: "QA",
  github: "GitHub ↗",
  showWhole: "Show the whole remark",
  showLess: "Show less",
  hide: "hide",
  overview: "Overview",
  loading: "Loading history…",
  refreshing: "Refreshing",
  theme: "Switch between light and dark",
};

export function waitingKind(w: WaitingItem): string {
  switch (w.kind) {
    case "needs-human":
      return "Escalated";
    case "needs-human-qa":
      return "Your QA";
    default:
      return unreachable(w.kind);
  }
}

export function waitingHeading(w: WaitingItem): string {
  switch (w.kind) {
    case "needs-human":
      return "Escalated to you";
    case "needs-human-qa":
      return "Waiting for your QA";
    default:
      return unreachable(w.kind);
  }
}

/** Why an item waits for the developer, in plain words. */
export function waitingReason(w: WaitingItem): string {
  switch (w.kind) {
    case "needs-human":
      return w.reason ?? "Someone flagged it needs-human by hand; its comments say why.";
    case "needs-human-qa":
      return w.issue === w.story ? "Every slice merged and agent QA passed. Your QA closes the story." : "Agent QA passed. A few checks need a person.";
    default:
      return unreachable(w.kind);
  }
}

const COUNTS = ["Nothing", "One thing", "Two things", "Three things", "Four things", "Five things"];

export function heroTitle(n: number): string {
  const count = COUNTS[n] ?? `${n} things`;
  return `${count} ${n <= 1 ? "needs" : "need"} you${n ? "" : " right now"}`;
}

export function heroSub(working: number, quiet: number): string {
  const agents = working === 0 ? "No agents are working" : working === 1 ? "1 agent is working" : `${working} agents are working`;
  return `${agents}${quiet ? `, ${quiet} went quiet` : ""}.`;
}

export const WORTH_A_LOOK = "Worth a look";

/** What went wrong reading GitHub, and what to do about it. */
export function failureNotice(err: NonNullable<DashboardState["lastError"]>, lastUpdated: string | null): string {
  const shown = lastUpdated ? ` Showing data from ${clock(lastUpdated)}.` : "";
  return `${failureWords(err.reason, err.detail)}${shown}`;
}

function failureWords(reason: PollFailure, detail: string): string {
  switch (reason) {
    case "auth":
      return "GitHub didn't accept norn's credentials: run gh auth login, then refresh.";
    case "rate-limit":
      return "Hit GitHub's rate limit; norn tries again at the next poll.";
    case "network":
      return "Can't reach GitHub; norn tries again at the next poll.";
    case "other":
      return `Reading GitHub failed: ${detail}`;
    default:
      return unreachable(reason);
  }
}

export const SERVER_GONE = "Can't reach the dashboard server. Is norn dashboard still running?";

export function updatedLabel(lastUpdated: string | null, now: number): string {
  return lastUpdated ? `Updated ${ago(lastUpdated, now)}` : "Not updated yet";
}

export function pollHint(intervalMs: number): string {
  return `norn reads GitHub every ${duration(intervalMs)}; click to read now`;
}

export function feedTitle(selected: boolean): string {
  return selected ? "History" : "What happened";
}

export function emptyFeed(remarksOnly: boolean): string {
  return remarksOnly ? "No remarks here." : "Nothing here yet.";
}
