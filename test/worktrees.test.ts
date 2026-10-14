import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

describe("take names the worktree", () => {
  test("the PRD's briefing: a story worktree that does not exist yet, under Claude Code", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-refinement"] });

    const res = await w.psdd("take", "123");

    expect(res.stdout).toBe(
      [
        'You now hold story #123 "Rate limiting". Its step is refinement. This step',
        "is attended: the user takes part, and you do not decide on your own.",
        "",
        "Work in: .agents/worktrees/123-rate-limiting (branch 123-rate-limiting)",
        "It does not exist yet. Create it first:",
        "  git worktree add .agents/worktrees/123-rate-limiting -b 123-rate-limiting main",
        "",
        "Invoke the skill: refine",
        "Spec to work on: .agents/specs/123-rate-limiting/spec.md",
        "",
        "When the user agrees refinement is finished, run one of:",
        "  psdd done 123 clear       (no open questions, moves on to planning)",
        "  psdd done 123 questions   (open questions, moves to clarification)",
        "",
        "If you have to stop, run: psdd release 123",
        'If something is wrong and a person is needed, run: psdd escalate 123 "reason"',
        "",
        "Do not change labels yourself. Only psdd changes them.",
      ].join("\n"),
    );
  });

  test("an existing worktree is just named", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan"] });
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting");

    const res = await w.psdd("take", "123");

    expect(res.stdout).toContain("Work in: .agents/worktrees/123-rate-limiting (branch 123-rate-limiting)\n\nInvoke");
    expect(res.stdout).not.toContain("does not exist");
  });

  test("a slice worktree is <story>-<slug>-<slice>, made from the story branch", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    w.github.parents.set(131, 123);

    const res = await w.psdd("take", "131");

    expect(res.stdout).toContain("Work in: .agents/worktrees/123-rate-limiting-131 (branch 123-rate-limiting-131)");
    expect(res.stdout).toContain(
      "  git worktree add .agents/worktrees/123-rate-limiting-131 -b 123-rate-limiting-131 123-rate-limiting",
    );
    expect(res.stdout).toContain("Open one PR from 123-rate-limiting-131 into 123-rate-limiting.");
  });

  test("when the branch already exists locally, the worktree is added on it without -b", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan"] });
    w.workspace.localBranches.add("123-rate-limiting");

    const res = await w.psdd("take", "123");

    expect(res.stdout).toContain("  git worktree add .agents/worktrees/123-rate-limiting 123-rate-limiting\n");
  });
});

describe("worktree cleanup", () => {
  function mergingSlice() {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 127, title: "Redis store", labels: ["type:slice", "mode:afk", "merge-queue"] });
    w.github.seedIssue({ number: 128, title: "Headers", labels: ["type:slice", "mode:afk", "needs-review"] });
    w.github.parents.set(127, 123);
    w.github.parents.set(128, 123);
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "merged" });
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting-127");
    return w;
  }

  test("when a slice merges, psdd removes its worktree with the configured tool", async () => {
    const w = mergingSlice();
    await w.psdd("take", "127");

    const res = await w.psdd("done", "127");

    expect(w.workspace.removed).toEqual([{ path: ".agents/worktrees/123-rate-limiting-127", provider: "claude-code" }]);
    expect(res.stdout).toContain("Removed the worktree .agents/worktrees/123-rate-limiting-127.");
  });

  test("a slice with no local worktree merges without removing anything", async () => {
    const w = mergingSlice();
    w.workspace.worktrees.clear();
    await w.psdd("take", "127");
    await w.psdd("done", "127");
    expect(w.workspace.removed).toEqual([]);
  });

  test("the story worktree is removed once the story has merged into main", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", state: "closed", labels: ["type:story", "merge-queue"] });
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting");

    const res = await w.psdd("next", "123");

    expect(w.workspace.removed.map((r) => r.path)).toEqual([".agents/worktrees/123-rate-limiting"]);
    expect(res.stdout).toContain("Story #123 is merged and closed. Removed its worktree .agents/worktrees/123-rate-limiting.");
  });

  test("taking over a stale claim cleans up the worktree the crashed session left behind", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan"] });
    w.setNow("2026-10-13T08:00:00Z");
    await w.as("crashed")("take", "123");
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting");
    w.workspace.localBranches.add("123-rate-limiting");
    w.setNow("2026-10-13T12:00:00Z");

    const res = await w.psdd("take", "123");

    expect(w.workspace.removed.map((r) => r.path)).toEqual([".agents/worktrees/123-rate-limiting"]);
    expect(res.stdout).toContain("The previous holder's claim was stale (since 08:00); its worktree was removed.");
    expect(res.stdout).toContain("  git worktree add .agents/worktrees/123-rate-limiting 123-rate-limiting\n");
  });
});
