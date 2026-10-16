import { describe, expect, test } from "vitest";
import { done, next, take } from "../src/operations.js";
import { tidy } from "../src/tidy.js";
import { setup } from "./harness.js";

/**
 * Core operations return typed results with no wording: what a front end other
 * than the CLI gets. The CLI tests cover the wording; these cover the variants.
 */

/** Story #40 in implementation with its only slice #41 in merge-queue, its PR merged. */
function lastSlice() {
  const w = setup();
  w.github.seedIssue({ number: 40, title: "Last", labels: ["type:story", "implementation"] });
  w.github.seedIssue({ number: 41, title: "Only", labels: ["type:slice", "mode:afk", "merge-queue"] });
  w.github.parents.set(41, 40);
  w.github.branches.add("40-last");
  w.github.prs.push({ number: 70, head: "40-last-41", base: "40-last", state: "merged" });
  return w;
}

describe("done", () => {
  test("reports the follow-ups it ran as events", async () => {
    const w = lastSlice();
    const ctx = await w.ctx();
    await take(ctx, 41, { takeover: false });

    const res = await done(ctx, 41, {});

    expect(res).toMatchObject({ ok: true, kind: "done", issue: 41, from: "merge-queue", to: "closed" });
    expect(res.ok && res.followUps).toEqual([{ kind: "story-promoted", story: 40 }]);
  });

  test("a follow-up that fails is an event saying what failed and which psdd next retries it", async () => {
    const w = lastSlice();
    const ctx = await w.ctx();
    await take(ctx, 41, { takeover: false });
    w.github.createPullRequest = async () => {
      throw new Error("HTTP 502");
    };

    const res = await done(ctx, 41, {});

    expect(res.ok && res.followUps).toEqual([{ kind: "follow-up-failed", what: "move-story-on", issue: 40, retry: 40, detail: "HTTP 502" }]);
  });

  test("each follow-up that fails is its own event; the others still run", async () => {
    const w = lastSlice();
    w.github.seedIssue({ number: 42, title: "Next", labels: ["type:slice", "mode:afk", "blocked"] });
    w.github.parents.set(42, 40);
    w.github.blockers.set(42, [41]);
    const ctx = await w.ctx();
    await take(ctx, 41, { takeover: false });
    w.github.blockedBy = async () => {
      throw new Error("HTTP 500");
    };

    const res = await done(ctx, 41, {});

    expect(res.ok && res.followUps).toEqual([{ kind: "follow-up-failed", what: "unblock-slices", issue: 40, retry: 40, detail: "HTTP 500" }]);
  });

  test("unblocking a slice is an event", async () => {
    const w = lastSlice();
    w.github.seedIssue({ number: 42, title: "Next", labels: ["type:slice", "mode:afk", "blocked"] });
    w.github.parents.set(42, 40);
    w.github.blockers.set(42, [41]);
    const ctx = await w.ctx();
    await take(ctx, 41, { takeover: false });

    const res = await done(ctx, 41, {});

    expect(res.ok && res.followUps).toEqual([{ kind: "slice-state-changed", issue: 42, state: "ready-for-agent" }]);
  });

  test("refuses with a kind and its facts: not claimed, held elsewhere, wrong outcome", async () => {
    const w = lastSlice();
    const ctx = await w.ctx();
    expect(await done(ctx, 41, {})).toEqual({ ok: false, refusal: { kind: "not-claimed", issue: 41 } });

    w.github.claims.set(41, { holder: "bob", session: "other", since: "2026-10-13T11:30:00.000Z" });
    expect(await done(ctx, 41, {})).toEqual({ ok: false, refusal: { kind: "held-by-other-session", issue: 41, since: "2026-10-13T11:30:00.000Z" } });

    w.github.seedIssue({ number: 7, title: "New" });
    await take(ctx, 7, { takeover: false });
    const res = await done(ctx, 7, { word: "maybe" });
    expect(res).toMatchObject({ ok: false, refusal: { kind: "outcome-unknown", issue: 7, word: "maybe", step: "triage" } });
    expect(!res.ok && res.refusal.kind === "outcome-unknown" && res.refusal.finish.map((f) => f.word)).toEqual(["accept", "reject"]);
  });
});

describe("take", () => {
  test("returns the briefing as a structure", async () => {
    const w = lastSlice();
    const ctx = await w.ctx();

    const res = await take(ctx, 41, { takeover: false });

    if (!res.ok) throw new Error("refused");
    expect(res.briefing).toMatchObject({
      issue: 41,
      noun: "slice",
      title: "Only",
      step: { name: "merge", skill: "merge", attended: false },
      workIn: { path: "/repo/.agents/worktrees/40-last-41", branch: "40-last-41", worktree: { kind: "missing" } },
      finish: [{ issue: 41, word: "", evidence: false, means: "slice PR merged into the story branch" }],
    });
    expect(res.briefing.instructions).toContain("Then merge the PR: gh pr merge 40-last-41 --merge");
  });

  test("a blocked slice is refused with its open blockers and its story", async () => {
    const w = lastSlice();
    w.github.seedIssue({ number: 42, title: "Next", labels: ["type:slice", "mode:afk", "blocked"] });
    w.github.parents.set(42, 40);
    w.github.blockers.set(42, [41]);

    expect(await take(await w.ctx(), 42, { takeover: false })).toEqual({
      ok: false,
      refusal: { kind: "blocked", issue: 42, blockers: [41], story: 40 },
    });
  });
});

describe("next", () => {
  test("waiting items carry their facts, not sentences", async () => {
    const w = lastSlice();
    w.github.seedIssue({ number: 42, title: "Next", labels: ["type:slice", "mode:afk", "blocked"] });
    w.github.parents.set(42, 40);
    w.github.blockers.set(42, [43]);
    w.github.seedIssue({ number: 43, title: "Stuck", labels: ["type:slice", "mode:afk", "needs-review", "needs-human"] });
    w.github.parents.set(43, 40);
    w.github.commentsByIssue.set(43, ['psdd: needs-review → needs-review\n\npsdd: needs-human — escalated: "flaky"']);

    const res = await next(await w.ctx(), 40);

    if (!res.ok) throw new Error("refused");
    expect(res.report.waiting).toEqual([
      { issue: 42, reason: "blocked", blockers: [43] },
      { issue: 43, reason: "needs-human", why: 'escalated: "flaky"' },
    ]);
  });

  test("housekeeping is reported as events", async () => {
    const w = setup();
    w.github.seedIssue({ number: 30, title: "Ship", labels: ["type:story", "merge-queue"] });
    w.github.prs.push({ number: 99, head: "30-ship", base: "main", state: "merged" });

    const res = await next(await w.ctx(), 30);

    expect(res.ok && res.report.notes).toEqual([{ kind: "story-closed", story: 30 }]);
  });

  test("a slice is refused, naming its story", async () => {
    const w = lastSlice();
    expect(await next(await w.ctx(), 41)).toEqual({ ok: false, refusal: { kind: "is-a-slice", issue: 41, story: 40 } });
  });
});

describe("tidy", () => {
  test("says what it removed and kept as typed entries", async () => {
    const w = lastSlice();
    w.github.issues.get(41)!.state = "closed";
    w.github.branches.add("40-last-41");
    w.workspace.localBranches.add("40-last-41");
    w.workspace.worktrees.add(".agents/worktrees/40-last-41");
    w.workspace.dirty.add(".agents/worktrees/40-last-41");

    const res = await tidy(await w.ctx(), false);

    expect(res.kept).toEqual([{ kind: "worktree-dirty", path: "/repo/.agents/worktrees/40-last-41" }]);
    expect(res.removed).toEqual([]);
  });
});
