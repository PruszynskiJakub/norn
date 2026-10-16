import type { BoardItem, BoardStory, FeedEvent, State } from "@shepherd/core";

/** A board item with the story it belongs to. */
export interface Item extends BoardItem {
  isStory: boolean;
  story: number;
}

/** Every story and slice on the board, stories first within their group. */
export function allItems(board: BoardStory[]): Item[] {
  const out: Item[] = [];
  for (const s of board) {
    out.push({ ...s, isStory: true, story: s.number });
    for (const x of s.slices) out.push({ ...x, isStory: false, story: s.number });
  }
  return out;
}

/** Where an item stands: its single state label, or how it closed. Null for no label, or more than one. */
export function stateOf(x: BoardItem): State | "merged" | "closed" | null {
  if (x.status !== "open") return x.status;
  return x.states.length === 1 ? x.states[0]! : null;
}

export function isDone(x: BoardItem): boolean {
  return x.status !== "open";
}

/** The colour that an item's dot in the sidebar gets. */
export type Dot = "bad" | "warn" | "done" | "blocked" | "live" | "none";

export function dotOf(x: BoardItem): Dot {
  if (x.needsHuman) return "bad";
  if (x.states.includes("needs-human-qa")) return "warn";
  if (x.holder?.stale) return "warn";
  if (isDone(x)) return "done";
  if (x.states.includes("blocked")) return "blocked";
  if (x.holder) return "live";
  return "none";
}

/** How much a feed event asks for the developer's eye. */
export type Attention = "bad" | "warn" | "ok" | "none";

export function attentionOf(e: FeedEvent): Attention {
  if (e.kind === "needs-human") return e.action === "raised" ? "bad" : "ok";
  if (e.kind === "claim") return e.action === "stale" ? "warn" : "none";
  if (e.kind === "pr") return e.action === "merged" ? "ok" : "none";
  if (e.kind === "outcome") {
    if (sentBack(e.outcome)) return "warn";
    return stepGroupOf(e.step) === "implement" ? "none" : "ok";
  }
  return "none";
}

/** Outcomes that send work back or stop it. */
function sentBack(outcome: string): boolean {
  return outcome === "fail" || outcome === "request-changes" || outcome === "reject";
}

/** Outcomes, escalations, merges and quiet agents stand out; everything else folds into routine runs. */
export function isSignificant(e: FeedEvent): boolean {
  return e.kind === "outcome" || e.kind === "needs-human" || (e.kind === "pr" && e.action === "merged") || (e.kind === "claim" && e.action === "stale");
}

export type StepGroup = "implement" | "review" | "qa" | "other";

/** The Remarks filter an outcome's step belongs to. */
export function stepGroupOf(step: string): StepGroup {
  if (step === "implementation" || step === "fixing") return "implement";
  if (step === "review") return "review";
  if (step === "agent QA" || step === "human QA") return "qa";
  return "other";
}

/** The feed narrowed to a story's history (every event of it and its slices) or one slice's. */
export function feedFor(feed: FeedEvent[], selected: Item | null): FeedEvent[] {
  if (!selected) return feed;
  return selected.isStory ? feed.filter((e) => e.story === selected.number) : feed.filter((e) => e.issue === selected.number);
}

/** Open items whose agent stopped. */
export function quietItems(items: Item[]): Item[] {
  return items.filter((x) => !isDone(x) && x.holder?.stale);
}

/** Open items one fix round away from needs-human. */
export function nearLimitItems(items: Item[]): Item[] {
  return items.filter((x) => !isDone(x) && !x.needsHuman && x.fixRounds > 0 && x.fixRounds === x.maxFixRounds - 1);
}

/** The latest QA evidence of an item: the board's, else the newest in the feed. */
export function latestEvidenceOf(x: BoardItem, feed: FeedEvent[]) {
  if (x.latestEvidence) return x.latestEvidence;
  for (const e of feed) {
    if (e.issue !== x.number) continue;
    if (e.kind === "qa-evidence") return e.evidence;
    if (e.kind === "outcome" && e.evidence) return e.evidence;
  }
  return null;
}

/** The QA pipeline of a slice, as five stops and how far it got; -1 when it has not started. */
export const PIPELINE: readonly State[] = ["ready-for-agent", "implementation", "needs-review", "needs-qa", "merge-queue"];

export function pipelinePosition(x: BoardItem): number {
  if (isDone(x)) return PIPELINE.length;
  const s = stateOf(x);
  if (s === "changes-requested" || s === "qa-failed") return 1;
  if (s === "needs-human-qa") return 3;
  return s ? PIPELINE.indexOf(s as State) : -1;
}

export function mergedSlices(s: BoardStory): number {
  return s.slices.filter((x) => x.status === "merged").length;
}

/** Links into the repository; null when the read model has no repository URL yet. */
export const links = {
  branch: (repoUrl: string | null, branch: string) => (repoUrl ? `${repoUrl}/tree/${branch}` : null),
  commit: (repoUrl: string | null, sha: string) => (repoUrl ? `${repoUrl}/tree/${sha}` : null),
  file: (repoUrl: string | null, sha: string, path: string) => (repoUrl ? `${repoUrl}/blob/${sha}/${path.split("/").map(encodeURIComponent).join("/")}` : null),
};
