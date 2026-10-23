import type { ConfigWarning, Refusal, Row, WaitItem } from "@norn/core";
import {
  type Answer,
  type CliRefusal,
  holderText,
  unreachable,
  renderAnswer,
  renderCheck,
  renderEvent,
  renderFailure,
  renderKept,
  renderRefusal,
  renderRemoval,
  renderWarning,
  rowState,
  tidyNotes,
  waitDetail,
} from "./render-text.js";
import { doctorFailed } from "./doctor.js";

/**
 * --json: `{ ok: true, ...data, message }` or `{ ok: false, refusal }`, plus
 * any warnings. The message and refusal are the text renderer's, so the two
 * outputs cannot drift apart; the data is picked from the result.
 */
export function renderJson(answer: Answer | { ok: false; refusal: Refusal | CliRefusal }, warnings: ConfigWarning[]): string {
  // doctor answers with its checks instead: ok is false when one failed, and the config warnings are a check.
  if (answer.ok && answer.kind === "doctor") {
    const checks = answer.checks.map((c) => ({ id: c.id, level: c.level, ...renderCheck(c) }));
    return JSON.stringify({ ok: !doctorFailed(answer), checks }, null, 2);
  }
  const body = answer.ok
    ? { ok: true, ...data(answer), message: renderAnswer(answer).join("\n") }
    : { ok: false, refusal: renderRefusal(answer.refusal).join("\n") };
  return JSON.stringify(warnings.length ? { ...body, warnings: warnings.map(renderWarning) } : body, null, 2);
}

function data(a: Answer): Record<string, unknown> {
  switch (a.kind) {
    case "taken":
      return { issue: a.issue, state: a.state, step: a.step.name, skill: a.step.skill, attended: a.step.attended, outcomes: a.step.outcomes };
    case "handed-over":
      return { issue: a.issue, state: a.state, flow: a.flow };
    case "done":
      return { issue: a.issue, from: a.from, to: a.to, ...(a.evidence ? { evidence: a.evidence } : {}) };
    case "status":
      return { story: { ...row(a.story), owner: a.story.owner, branch: a.story.branch }, slices: a.slices.map(row), asks: a.asks.map(wait) };
    case "tidy":
      return {
        dryRun: a.dryRun,
        removed: a.removed.map(renderRemoval),
        kept: a.kept.map(renderKept),
        failed: a.failed.map(renderFailure),
        notes: tidyNotes(a),
      };
    case "next":
      return { ...a.report, waiting: a.report.waiting.map(wait), notes: a.report.notes.flatMap(renderEvent) };
    case "dashboard":
      return a.launch.kind === "started"
        ? { url: a.launch.url, port: a.launch.port, intervalMs: a.intervalMs, opened: a.launch.opened }
        : { url: a.launch.url, alreadyRunning: true };
    case "escalated":
      return a.waiting ? { waiting: true } : {};
    case "resumed":
    case "released":
    case "slice-added":
    case "initialized":
      return {};
    case "doctor":
      return { checks: a.checks };
    case "flow-exported":
      return { flow: a.flow, file: a.file };
    default:
      return unreachable(a);
  }
}

function row(r: Row) {
  return {
    number: r.number,
    title: r.title,
    state: rowState(r),
    mode: r.mode,
    blockedBy: r.blockedBy,
    needsHuman: r.needsHuman,
    agentAsks: r.agentAsks,
    heldSince: r.heldSince,
    stale: r.stale,
  };
}

/** A waiting item as `{ issue, reason, detail }`, with where a person does it or who holds it. */
function wait(w: WaitItem) {
  const base = { issue: w.issue, reason: w.reason, detail: waitDetail(w) };
  if (w.reason === "held") return { ...base, mine: w.holder.mine };
  if (w.reason === "agent-asks") {
    const { question, since, waitedMs, worktree, focus } = w;
    return { ...base, question, since, waitedMs, heldBy: holderText(w.holder), mine: w.holder.mine, worktree, focus };
  }
  if (w.reason !== "needs-human" && w.reason !== "human-qa") return base;
  if (w.heldBy) return { ...base, heldBy: holderText(w.heldBy) };
  if (w.branch === undefined) return base;
  return { ...base, branch: w.branch, worktree: w.worktree, createWorktree: w.createWorktree, checkedOutAt: w.checkedOutAt, here: w.here };
}
