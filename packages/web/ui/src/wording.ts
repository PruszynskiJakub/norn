// The dashboard's renderer: every sentence the page shows is worded here, from
// the typed read model, so the rest of the UI only lays words out.
import type { ClaimHolder, Expected, FeedEvent, FieldAt, Flow, FlowError, FlowSource, LoadedFlow, WaitingItem } from "@norn/core";
import type { DashboardState, PollFailure } from "../../src/contract.ts";
import { atGate, atGateStep, type Item, isSliced, stateOf, stepGroupOf } from "./model.ts";

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

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * An outcome as a sentence, from its step and word as its flow names them: "Review: request-changes", "Your QA: pass",
 * "Implementation done, fix round 2". Triage and resolving needs-human are norn's own steps in every flow.
 */
function outcomeSentence(e: Extract<FeedEvent, { kind: "outcome" }>, me: string | null, flows: LoadedFlow[]): string {
  if (e.flow === null) return e.to === "not-planned" ? "Rejected at triage" : `Accepted at triage as a ${e.outcome}`;
  if (e.step === "resolving needs-human") return "Escalation resolved";
  // At a human gate, the developer's own check is theirs.
  const step = atGateStep(e, flows) && e.actor !== null && e.actor === me ? "Your QA" : capitalise(e.step);
  const round = e.fixRound && stepGroupOf(e, flows) === "implement" ? `, fix round ${e.fixRound}` : "";
  return e.outcome === "done" ? `${step} done${round}` : `${step}: ${e.outcome}${round}`;
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
export function sentence(e: FeedEvent, me: string | null, flows: LoadedFlow[]): string {
  switch (e.kind) {
    case "outcome":
      return outcomeSentence(e, me, flows);
    case "needs-human":
      return e.action === "raised" ? "Escalated to you" : "Escalation resolved";
    case "pr":
      return e.action === "merged" ? `${capitalise(e.target)} PR #${e.pr} merged` : routineText(e);
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
export function roundNote(e: FeedEvent, flows: LoadedFlow[]): string | null {
  if (e.kind !== "outcome" || !e.fixRound || stepGroupOf(e, flows) === "implement") return null;
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

/** Where an item stands, as a sentence without its full stop: its state's description in its flow, else the state's name. */
export function stateSentence(x: Item): string {
  const s = stateOf(x);
  if (s === "merged") return x.flowDef?.workspace === "none" ? "Done" : "Merged";
  if (s === "closed") return "Closed without merging";
  if (x.flowInvalid) return `Stopped: its flow, ${x.flow}, is invalid`;
  if (s === null) return x.states.length ? `Its state labels disagree: ${x.states.join(" and ")}` : "Has no norn state label";
  return x.flowDef?.states[s]?.description ?? s;
}

/** What the item is, above its title: its flow, e.g. Story, or Slice of its story. */
export function kicker(x: Item): string {
  const flow = x.flow === null ? "Issue" : capitalise(x.flow);
  return x.isStory ? flow : `${flow} of`;
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
export function itemFlag(x: Item): { text: string; tone: "bad" | "warn" } | null {
  if (x.needsHuman) return { text: "needs you", tone: "bad" };
  if (atGate(x)) return { text: "your QA", tone: "warn" };
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
  waitsFor: "Waits for",
  and: "and",
  humanQa: "You QA this one before it merges",
  labels: "Labels on GitHub",
  latestEvidence: "Latest QA evidence",
  openOnGitHub: "Open on GitHub ↗",
  progress: "Progress",
  noStories: "Nothing in progress.",
};

/** A stop of the pipeline that runs in one mode only. */
export function onlyIn(when: "afk" | "hil"): string {
  return `only in mode:${when}`;
}

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
    case "agent-asks":
      return "An agent asks";
    case "needs-human":
      return "Escalated";
    case "needs-human-qa":
      return "Your QA";
    default:
      return unreachable(w);
  }
}

export function waitingHeading(w: WaitingItem): string {
  switch (w.kind) {
    case "agent-asks":
      return "An agent asks you, and waits in its session";
    case "needs-human":
      return "Escalated to you";
    case "needs-human-qa":
      return "Waiting for your QA";
    default:
      return unreachable(w);
  }
}

/** Why an item waits for the developer, in plain words; `x` is the item, when on the board. */
export function waitingReason(w: WaitingItem, x: Item | undefined): string {
  switch (w.kind) {
    case "agent-asks":
      return w.question;
    case "needs-human":
      return w.reason ?? "Someone flagged it needs-human by hand; its comments say why.";
    case "needs-human-qa":
      if (w.issue !== w.story) return "Agent QA passed. A few checks need a person.";
      return x && isSliced(x) ? `Every slice merged and agent QA passed. Your QA closes the ${x.flow}.` : "A few checks need a person.";
    default:
      return unreachable(w);
  }
}

/** Where to answer an agent that asks: its worktree, when the dashboard has no command that brings it forward. */
export function answerIn(worktree: string | null): string {
  return worktree ? `Answer in the agent's session, in ${worktree}.` : "Answer in the agent's session.";
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

export const FLOWS = {
  nav: "Flows",
  title: "Flows",
  sub: "The processes this repository's issues run, as norn reads them from .agents/flows on the base branch. Read-only: a flow changes when a change to its file merges.",
  none: "No flows read yet.",
  valid: "valid",
  invalid: "invalid",
  graph: "States and the outcomes between them",
  states: "States",
  attended: "attended",
  agent: "agent",
  start: "start",
};

export function invalidFlows(n: number): string {
  return n === 1 ? "1 flow is invalid" : `${n} flows are invalid`;
}

/** Where a flow comes from, as its badge says it. */
export function flowSourceLabel(source: FlowSource): string {
  switch (source) {
    case "built-in":
      return "built-in";
    case "overridden":
      return "overridden";
    case "repository":
      return "repository";
    default:
      return unreachable(source);
  }
}

/** Where a flow comes from, as a sentence for its badge's hint. */
export function flowSourceHint(source: FlowSource, name: string): string {
  switch (source) {
    case "built-in":
      return "Ships with norn.";
    case "overridden":
      return `Ships with norn; the repository's .agents/flows/${name}.json replaces it.`;
    case "repository":
      return `The repository's own, from .agents/flows/${name}.json.`;
    default:
      return unreachable(source);
  }
}

/** A flow's facts under its description: where it starts, where its work happens, whether triage offers it. */
export function flowFacts(flow: Flow): string {
  const where =
    flow.workspace === "none" ? "no branch" : flow.workspace === "own" ? "its own branch, PR into the base branch" : "a branch off its parent's, PR into it";
  return `Starts in ${flow.start} · works on ${where}${flow.triage === false ? " · triage doesn't offer it" : ""}`;
}

/** A behaviour's parameters, e.g. "to ready-for-agent"; empty for none. */
export function behaviourParams(params: Record<string, unknown> | undefined): string {
  return Object.entries(params ?? {})
    .map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

/** What a field of a flow must be. */
function expectedText(e: Expected): string {
  switch (e.kind) {
    case "string":
      return "text";
    case "boolean":
      return "true or false";
    case "object":
      return "an object";
    case "hex-colour":
      return "a hex colour like 1d76db";
    case "state":
      return "a state of the flow";
    case "outcome-word":
      return "one of the state's outcomes";
    case "flow-name":
      return "a flow's name";
    case "behaviours":
      return "an object of behaviours";
    case "params":
      return "an object of parameters, {} for none";
    case "one-of":
      return e.values.map((v) => `"${v}"`).join(" or ");
    default:
      return unreachable(e);
  }
}

/** Where a field is in a flow file, as the subject of a sentence. */
function fieldText(at: FieldAt): string {
  switch (at.in) {
    case "flow":
      return at.field === null ? "The flow" : `The field ${at.field}`;
    case "state":
      return at.field === null ? `The state ${at.state}` : `${at.field} of ${at.state}`;
    case "outcome":
      return at.field === null ? `The outcome ${at.word} of ${at.state}` : `${at.field} of the outcome ${at.word} of ${at.state}`;
    case "behaviour":
      return at.param === null ? `The parameters of ${at.behaviour} on ${at.state}` : `${at.param} of ${at.behaviour} on ${at.state}`;
    case "renamed":
      return `What renamed moves ${at.from} to`;
    default:
      return unreachable(at);
  }
}

/** What is wrong with a flow, as a sentence. */
export function flowErrorText(e: FlowError): string {
  switch (e.kind) {
    case "not-json":
      return `The file isn't JSON: ${e.detail}`;
    case "field-invalid":
      return `${fieldText(e.at)} must be ${expectedText(e.expected)}.`;
    case "field-unknown":
      return `${fieldText(e.at)} is no field of the flow format.`;
    case "start-unknown":
      return `start names ${e.start}, which is no state of the flow.`;
    case "target-unknown":
      return `The outcome ${e.word} of ${e.state} leads to ${e.to}, which is no state of the flow and no end.`;
    case "notify-agent-state":
      return `The outcome ${e.word} of ${e.state} notifies a person, but ${e.to} is an agent's step.`;
    case "renamed-unknown":
      return `renamed moves ${e.from} to ${e.to}, which is no state of the flow.`;
    case "state-reserved":
      return `The state ${e.state} takes a name norn keeps for itself.`;
    case "pass-through-invalid":
      return e.word === null
        ? `${e.state} runs in one mode only but has no passThrough.`
        : `The passThrough of ${e.state}, ${e.word}, is not one of its outcomes.`;
    case "end-unreachable":
      return `No outcomes lead from ${e.state} to closed or not-planned${e.mode ? ` in mode:${e.mode}` : ""}, so an issue there could never end.`;
    case "behaviour-unknown":
      return `${e.state} uses ${e.behaviour}, a behaviour this norn doesn't have${e.like ? `; did you mean ${e.like}?` : "."}`;
    case "behaviours-conflict":
      return `${e.state} uses ${e.behaviours[0]} and ${e.behaviours[1]}, which can't go together.`;
    case "flow-unknown":
      return `${e.behaviour} of ${e.state} names the flow ${e.flow}, which the repository doesn't have.`;
    case "behaviour-needs":
      return `${e.behaviour} of ${e.state} needs workspace to be ${e.workspace.map((w) => `"${w}"`).join(" or ")}.`;
    case "flow-reserved":
      return `The name ${e.flow} is one norn keeps for itself.`;
    default:
      return unreachable(e);
  }
}
