import {
  behaviourFollowUps,
  entering,
  heldRefusal,
  holds,
  leaveRefusal,
  needsBranch,
  type OutcomeInput,
  sliceType,
  slicingState,
  startState,
} from "./behaviours.js";
import { briefing, type Briefing, finishCommands } from "./briefing.js";
import { acquire } from "./claims.js";
import type { Event } from "./events.js";
import { type Flow, flowNameOf, flowStatesOf, flowStep, offerFlows, passThrough, usedIn, uses } from "./flow.js";
import { flowOf, loadFlow, triageFlows } from "./flow-loading.js";
import type { Issue } from "./github.js";
import { locate } from "./location.js";
import { type Step, TRIAGE } from "./machine.js";
import { computeNext, type NextReport, notAStory, notifyWaiting } from "./next.js";
import { notifyNeedsHuman } from "./notify.js";
import { type Refusal, type Refused, refuse } from "./refusals.js";
import { storySlug } from "./slug.js";
import { qaBranch } from "./tidy.js";
import { specPath } from "./text.js";
import {
  applyOutcome,
  type Ctx,
  ensureOwnBranch,
  ensureStateLabel,
  type Evidence,
  followRename,
  handOverLeft,
  leftState,
  needsHumanLine,
  oneLine,
  skipLine,
  stateLabels,
} from "./transitions.js";

/**
 * The commands that change an issue, as core operations: each returns what
 * happened, or why it was refused, as data. Front ends word it.
 */

export interface TakeResult {
  ok: true;
  kind: "taken";
  issue: number;
  /** The state after take, e.g. implementation for a slice that was ready-for-agent. */
  state: string | null;
  step: { name: string; skill: string; attended: boolean; outcomes: string[] };
  briefing: Briefing;
  /** This session already held the issue; its claim is refreshed. */
  reacquired: boolean;
  /** The claim taken over: from another session of the user's (`own`), or a stale one. `worktreeKept`: its worktree is there, with what it left. */
  tookOver: { own: boolean; since: string; worktreeKept: boolean } | null;
}

export interface DoneResult {
  ok: true;
  kind: "done";
  issue: number;
  from: string | null;
  /** A state of the issue's flow, closed or not-planned. */
  to: string;
  /** QA evidence pushed and embedded in the transition comment. */
  evidence?: Evidence;
  /** The fix-round limit the outcome reached, so the issue needs a human instead of another round; null when not reached. */
  fixLimit: number | null;
  /** The issue's own branch, created on GitHub before it entered a state that needs it, e.g. one waiting for its slices. */
  storyBranchCreated: string | null;
  followUps: Event[];
  /** The issue now waits for its slices, so deliver can run them unattended. */
  deliverable: boolean;
  /** A person does the next step and has been notified. */
  personNext: boolean;
}

export interface EscalateResult {
  ok: true;
  kind: "escalated";
  issue: number;
}

export interface ReleaseResult {
  ok: true;
  kind: "released";
  issue: number;
}

export interface AddSliceResult {
  ok: true;
  kind: "slice-added";
  slice: number;
  title: string;
  mode: "afk" | "hil";
  /** The blockers still open; with any, the slice starts blocked. */
  blockedBy: number[];
}

export interface NextResult {
  ok: true;
  kind: "next";
  report: NextReport;
}

/** GitHub's API takes blobs up to 100 MB; evidence is screenshots, logs and output, far smaller. */
export const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

/** The issue's step: from its flow when its type names one, else triage, which chooses its type. */
async function stepOf(ctx: Ctx, issue: Issue): Promise<{ ok: true; step: Step | null; flow: Flow | null } | Refused> {
  const loaded = await flowOf(ctx, issue);
  if (!loaded) return { ok: true, step: offerFlows(TRIAGE, await triageFlows(ctx)), flow: null };
  if (!loaded.ok) return refuse({ kind: "flow-invalid", issue: issue.number, flow: loaded.name, errors: loaded.errors });
  return { ok: true, step: flowStep(issue, loaded.flow), flow: loaded.flow };
}

/** The issue's state in its flow; null for none, or for an issue with no flow yet. */
function stateIn(issue: Issue, flow: Flow | null): string | null {
  return flow ? (flowStatesOf(issue, flow)[0] ?? null) : null;
}

/** Why an issue has no step to take. */
async function noStepRefusal(issue: Issue, ctx: Ctx, flow: Flow | null = null): Promise<Refusal> {
  const { github } = ctx;
  const n = issue.number;
  if (issue.state === "closed") return { kind: "closed", issue: n };
  if (!flow) return { kind: "no-step", issue: n, state: null, story: null };
  // Work in the parent's branch is run from the parent, and an issue with slices from itself: norn next on it has something else to do.
  const story = flow.workspace === "parent" ? await github.parentOf(n) : usedIn(flow, "slices") ? n : null;
  const states = flowStatesOf(issue, flow);
  if (states.length > 1) return { kind: "ambiguous-state", issue: n, states, story };
  const state = states[0] ?? null;
  if (state !== null && holds(flow, state)) return heldRefusal({ ctx, issue, flow, flowName: flowNameOf(issue) ?? "", state }, story);
  return { kind: "no-step", issue: n, state, story };
}

export async function take(ctx: Ctx, n: number, opts: { takeover: boolean }): Promise<TakeResult | Refused> {
  const { github } = ctx;
  const before = await github.getIssue(n);
  const first = await stepOf(ctx, before);
  if (!first.ok) return first;
  // An issue left in a state its flow no longer has is moved or handed to a person under the claim.
  const left = first.flow && !first.step ? await leftState(ctx, before, first.flow) : null;
  if ((!first.step && !left) || before.state === "closed") return refuse(await noStepRefusal(before, ctx, first.flow));

  const user = await github.currentUser();
  const record = { holder: user, session: ctx.session, since: ctx.now().toISOString() };
  const claim = await acquire(github, n, record, ctx.now(), ctx.config.staleAfterMs, { takeover: opts.takeover });
  if (!claim.ok) {
    const slice = first.flow?.workspace === "parent";
    const since = claim.held?.since ?? null;
    if (claim.held?.holder === user) return refuse({ kind: "held-by-your-session", issue: n, slice, since });
    if (opts.takeover && claim.held) return refuse({ kind: "held-by-teammate", issue: n, slice, holder: claim.held.holder, since });
    return refuse({ kind: "held", issue: n, slice, since, story: slice ? await github.parentOf(n) : null });
  }
  // Re-read under the claim: labels may have moved between the first read and the claim.
  const issue = await github.getIssue(n);
  let resolved = await stepOf(ctx, issue);
  if (resolved.ok && resolved.flow && !resolved.step) {
    const from = await leftState(ctx, issue, resolved.flow);
    const to = from === null ? undefined : resolved.flow.renamed?.[from];
    const name = flowNameOf(issue)!;
    if (from !== null && to !== undefined) {
      await followRename(ctx, issue, resolved.flow, name, from, to);
      resolved = await stepOf(ctx, issue);
    } else if (from !== null) {
      try {
        await handOverLeft(ctx, issue, name, from);
      } finally {
        await github.deleteClaim(n);
      }
      return refuse({ kind: "state-left", issue: n, state: from, flow: name });
    }
  }
  if (!resolved.ok || !resolved.step) {
    await github.deleteClaim(n);
    return resolved.ok ? refuse(await noStepRefusal(issue, ctx, resolved.flow)) : resolved;
  }
  const { step, flow } = resolved;
  const state = stateIn(issue, flow);
  // The new state goes on before the old one comes off, so a failure in between never leaves the issue without a state.
  if (step.enterAs && step.enterAs !== state) {
    const old = stateLabels(issue, step.enterAs, flow);
    if (flow) await ensureStateLabel(ctx, flow, step.enterAs);
    await github.addLabels(n, [step.enterAs, "in-progress"]);
    await github.removeLabels(n, old);
    issue.labels = [...issue.labels.filter((l) => !old.includes(l)), step.enterAs];
  } else {
    await github.addLabels(n, ["in-progress"]);
  }
  let tookOver: TakeResult["tookOver"] = null;
  if (claim.tookOver) {
    // The holder may only be slow, and its worktree holds its commits: keep it, never remove it here.
    const loc = await locate(issue, ctx, flow);
    const kept = loc !== null && (await ctx.workspace.worktreeExists(loc.worktree));
    tookOver = { own: claim.ownTakeover ?? false, since: claim.tookOver.since, worktreeKept: kept };
  }
  return {
    ok: true,
    kind: "taken",
    issue: n,
    state: stateIn(issue, flow),
    step: { name: step.name, skill: step.skill, attended: step.attended, outcomes: Object.keys(step.outcomes).filter(Boolean) },
    briefing: await briefing(issue, step, ctx, state, flow),
    reacquired: claim.reacquired ?? false,
    tookOver,
  };
}

/** Refuses unless this session holds the claim on n. */
async function checkHeld(ctx: Ctx, n: number): Promise<Refused | null> {
  const claim = await ctx.github.readClaim(n);
  if (!claim) return refuse({ kind: "not-claimed", issue: n });
  if (claim.session !== ctx.session) return refuse({ kind: "held-by-other-session", issue: n, since: claim.since });
  return null;
}

export async function done(ctx: Ctx, n: number, input: { word?: string; note?: string; evidenceDir?: string }): Promise<DoneResult | Refused> {
  const { github } = ctx;
  const { word, note, evidenceDir } = input;
  const notHeld = await checkHeld(ctx, n);
  if (notHeld) return notHeld;
  const issue = await github.getIssue(n);
  const resolved = await stepOf(ctx, issue);
  if (!resolved.ok) return resolved;
  const { step, flow } = resolved;
  if (!step) return refuse(await noStepRefusal(issue, ctx, flow));
  const outcome = step.outcomes[word ?? ""];
  if (!outcome) {
    const finish = finishCommands(n, step);
    return refuse(word ? { kind: "outcome-unknown", issue: n, word, step: step.name, finish } : { kind: "outcome-missing", issue: n, step: step.name, finish });
  }
  if (outcome.note && !note) return refuse({ kind: "note-missing", issue: n, word: word ?? "", note: outcome.note, evidence: step.evidence ?? false });
  if (evidenceDir !== undefined && !step.evidence) return refuse({ kind: "evidence-not-allowed", issue: n, step: step.name, finish: finishCommands(n, step) });
  // A state for the other mode is passed through here, so the issue lands in one transition, its comment naming what was skipped.
  const through = flow ? passThrough(flow, issue, outcome) : null;
  const skipped = through?.skipped.length && through.mode ? skipLine(through.skipped, through.mode) : null;
  const landed = through?.outcome ?? outcome;
  const inFlow: OutcomeInput | null = flow ? { ctx, issue, flow, flowName: flowNameOf(issue) ?? "", from: stateIn(issue, flow), outcome: landed, note } : null;
  if (inFlow) {
    const r = await leaveRefusal(inFlow);
    if (r) return refuse(r);
  }
  const files = evidenceDir === undefined ? undefined : await ctx.workspace.readEvidence(evidenceDir);
  if (evidenceDir !== undefined) {
    if (!files) return refuse({ kind: "evidence-not-a-directory", dir: evidenceDir });
    if (!files.length) return refuse({ kind: "evidence-empty", dir: evidenceDir });
    const big = files.filter((f) => f.content.length > MAX_EVIDENCE_BYTES);
    if (big.length) return refuse({ kind: "evidence-too-big", files: big.map((f) => f.path), limitBytes: MAX_EVIDENCE_BYTES });
  }
  // The evidence is checked before anything changes on GitHub, the issue's branch included.
  let storyBranchCreated: string | null = null;
  if (flow && needsBranch(flow, landed.to)) {
    const branch = await ensureOwnBranch(ctx, issue);
    if (!branch.ok) return refuse(branch.refusal);
    if (branch.created) storyBranchCreated = branch.branch;
  }

  let evidence: Evidence | undefined;
  if (files) {
    // Pushed before the transition, so the comment can embed the files at their commit.
    const branch = qaBranch(n);
    const sha = await github.pushFiles(branch, files, `QA evidence for #${n} (${step.name}, ${word})`);
    evidence = { branch, sha, files: files.map((f) => f.path) };
  }

  let applied = outcome;
  let fixLimit: number | null = null;
  if (inFlow) ({ outcome: applied, fixLimit } = await entering(inFlow));
  try {
    await applyOutcome(ctx, issue, applied, word ?? "", note, evidence, flow, skipped);
  } finally {
    await github.deleteClaim(n);
  }
  return {
    ok: true,
    kind: "done",
    issue: n,
    from: stateIn(issue, flow),
    to: landed.to,
    ...(evidence ? { evidence } : {}),
    fixLimit,
    storyBranchCreated,
    followUps: inFlow ? await behaviourFollowUps(inFlow, { outcome: applied, fixLimit }) : [],
    deliverable: flow !== null && uses(flow, landed.to, "waitsForSlices"),
    personNext: !!applied.notify && !applied.needsHuman,
  };
}

export async function escalate(ctx: Ctx, n: number, reason: string | undefined): Promise<EscalateResult | Refused> {
  if (!reason) return refuse({ kind: "reason-missing", issue: n });
  const notHeld = await checkHeld(ctx, n);
  if (notHeld) return notHeld;
  const { github } = ctx;
  await github.addLabels(n, ["needs-human"]);
  await github.removeLabels(n, ["in-progress"]);
  const why = `escalated: "${oneLine(reason)}"`;
  // The full reason keeps its line breaks in its own paragraph; the marker line stays single-line.
  await github.comment(n, [needsHumanLine(why), ...(reason.includes("\n") ? ["", reason] : [])].join("\n"));
  await notifyNeedsHuman(ctx, n, why);
  await github.deleteClaim(n);
  return { ok: true, kind: "escalated", issue: n };
}

export async function release(ctx: Ctx, n: number): Promise<ReleaseResult | Refused> {
  const notHeld = await checkHeld(ctx, n);
  if (notHeld) return notHeld;
  await ctx.github.removeLabels(n, ["in-progress"]);
  await ctx.github.deleteClaim(n);
  return { ok: true, kind: "released", issue: n };
}

export async function addSlice(ctx: Ctx, story: number, input: { title?: string; mode?: string; blockedBy: number[] }): Promise<AddSliceResult | Refused> {
  const { github } = ctx;
  const { title, mode } = input;
  if (!title || (mode !== "afk" && mode !== "hil")) return refuse({ kind: "add-slice-usage", story });
  const notHeld = await checkHeld(ctx, story);
  if (notHeld) return notHeld;
  const parent = await github.getIssue(story);
  const of = await flowOf(ctx, parent);
  if (of && !of.ok) return refuse({ kind: "flow-invalid", issue: story, flow: of.name, errors: of.errors });
  const state = of ? (flowStatesOf(parent, of.flow)[0] ?? null) : null;
  // Slices are added only in the state of the parent's flow with the slices behaviour, which names their type.
  if (!of || !uses(of.flow, state, "slices")) return refuse({ kind: "story-not-slicing", story, state, slicing: of ? slicingState(of.flow) : null });
  const type = sliceType(of.flow)!;
  const blockers = await Promise.all(input.blockedBy.map((b) => github.getIssue(b)));
  const open = blockers.filter((b) => b.state === "open");
  // The slices run the flow of their type, starting held while a blocker is open.
  const flow = (await loadFlow(ctx, type))!;
  if (!flow.ok) return refuse({ kind: "flow-invalid", issue: story, flow: flow.name, errors: flow.errors });
  const slice = await github.createIssue({
    title,
    body: `Slice of #${story}. Spec: ${specPath(story, await storySlug(ctx, parent))}`,
    labels: [`type:${type}`, `mode:${mode}`, startState(flow.flow, open.length > 0)],
    assignees: parent.assignees,
  });
  await github.addSubIssue(story, slice.number);
  for (const b of blockers) await github.addBlockedBy(slice.number, b.number);
  return { ok: true, kind: "slice-added", slice: slice.number, title, mode, blockedBy: open.map((b) => b.number) };
}

/**
 * What can be done on an issue of a flow, and on its slices, now; when nothing
 * is left, the user is notified of what waits for them.
 */
export async function next(ctx: Ctx, n: number): Promise<NextResult | Refused> {
  const issue = await ctx.github.getIssue(n);
  // An issue of a broken flow is not refused: next shows it blocked by the flow.
  const loaded = await flowOf(ctx, issue);
  const r = await notAStory(ctx.github, issue, loaded);
  if (r || !loaded) return refuse(r ?? { kind: "not-a-story", issue: n });
  const report = await computeNext(ctx, n, loaded);
  if (report.nothingLeft && !report.closed) await notifyWaiting(ctx, report);
  return { ok: true, kind: "next", report };
}
