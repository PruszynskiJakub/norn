import { execFileSync } from "node:child_process";
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
        "Work in: /repo/.agents/worktrees/123-rate-limiting (branch 123-rate-limiting)",
        "It does not exist yet. Create it first:",
        "  git -C /repo fetch origin main && git -C /repo worktree add --no-track /repo/.agents/worktrees/123-rate-limiting -b 123-rate-limiting origin/main",
        "",
        "Invoke the skill: refine",
        "Spec to work on: .agents/specs/123-rate-limiting/spec.md",
        "Read the issue: gh issue view 123 --comments",
        "Commit the spec on 123-rate-limiting and push it, so the link psdd posts resolves.",
        "",
        "When the user agrees refinement is finished, run one of:",
        "  psdd done 123 clear       (no open questions, moves on to planning)",
        "  psdd done 123 questions   (open questions, moves to clarification)",
        "",
        "On a long step, run psdd take 123 again now and then: it keeps your claim fresh.",
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

    expect(res.stdout).toContain("Work in: /repo/.agents/worktrees/123-rate-limiting (branch 123-rate-limiting)\n\nInvoke");
    expect(res.stdout).not.toContain("does not exist");
  });

  test("a slice worktree is <story>-<slug>-<slice>, made from the story branch", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    w.github.parents.set(131, 123);

    const res = await w.psdd("take", "131");

    expect(res.stdout).toContain("Work in: /repo/.agents/worktrees/123-rate-limiting-131 (branch 123-rate-limiting-131)");
    expect(res.stdout).toContain(
      "  git -C /repo fetch origin 123-rate-limiting && git -C /repo worktree add --no-track /repo/.agents/worktrees/123-rate-limiting-131 -b 123-rate-limiting-131 origin/123-rate-limiting",
    );
    expect(res.stdout).toContain("Open one PR from 123-rate-limiting-131 into 123-rate-limiting if there is none yet:");
    expect(res.stdout).toContain("  gh pr create --base 123-rate-limiting --head 123-rate-limiting-131 --title 'Per-key limits' --body 'Part of #123. Slice #131.'");
  });

  test("a slice title is quoted in the printed gh pr create, so the shell takes it literally", async () => {
    const w = setup();
    const title = 'Handle "quoted" $(touch pwned) `id` it\'s input';
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 131, title, labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    w.github.parents.set(131, 123);

    const res = await w.psdd("take", "131");

    const line = res.stdout.split("\n").find((l) => l.trim().startsWith("gh pr create"))!.trim();
    // Run it through a real shell with printf in place of gh: each argument must come back unchanged.
    const args = execFileSync("/bin/sh", ["-c", line.replace(/^gh pr create/, "printf '%s\\n'")], { encoding: "utf8" }).split("\n");
    expect(args).toContain(title);
    expect(args).toContain("Part of #123. Slice #131.");
  });

  test("when the branch already exists locally, the worktree is added on it without -b", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan"] });
    w.workspace.localBranches.add("123-rate-limiting");

    const res = await w.psdd("take", "123");

    expect(res.stdout).toContain("  git -C /repo worktree add /repo/.agents/worktrees/123-rate-limiting 123-rate-limiting\n");
  });

  test("a branch only on GitHub, like a story branch psdd made, is fetched and then checked out", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan"] });
    w.github.branches.add("123-rate-limiting");

    const res = await w.psdd("take", "123");

    expect(res.stdout).toContain(
      "  git -C /repo fetch origin 123-rate-limiting && git -C /repo worktree add /repo/.agents/worktrees/123-rate-limiting 123-rate-limiting\n",
    );
  });

  test("a branch checked out in another checkout gets no create command, which could not work", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan"] });
    w.workspace.localBranches.add("123-rate-limiting");
    w.workspace.checkedOut.set("123-rate-limiting", "/repo");

    const res = await w.psdd("take", "123");

    expect(res.stdout).toContain(
      "Work in: /repo/.agents/worktrees/123-rate-limiting (branch 123-rate-limiting)\nBranch 123-rate-limiting is checked out at /repo; work there or switch that checkout to another branch.\n",
    );
    expect(res.stdout).not.toContain("worktree add");
  });

  test("the commands work from inside another worktree: absolute paths, git run against the main checkout", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    w.github.parents.set(131, 123);
    w.workspace.cwd = "/repo/.agents/worktrees/123-rate-limiting";

    const res = await w.psdd("take", "131");

    expect(res.stdout).toContain("Work in: /repo/.agents/worktrees/123-rate-limiting-131 (branch 123-rate-limiting-131)");
    expect(res.stdout).toContain("git -C /repo worktree add --no-track /repo/.agents/worktrees/123-rate-limiting-131");
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

  test("done on a merged slice leaves its worktree; the next psdd next removes it with the configured tool", async () => {
    const w = mergingSlice();
    await w.psdd("take", "127");

    const res = await w.psdd("done", "127");

    expect(w.workspace.removed).toEqual([]);
    expect(res.stdout).toContain("Its worktree .agents/worktrees/123-rate-limiting-127 is removed by the next psdd next 123.");

    const next = await w.psdd("next", "123");

    expect(w.workspace.removed).toEqual([{ path: ".agents/worktrees/123-rate-limiting-127", provider: "claude-code" }]);
    expect(next.stdout).toContain("Slice #127 is merged. Removed its worktree .agents/worktrees/123-rate-limiting-127.");
  });

  test("a slice with no local worktree merges without removing anything", async () => {
    const w = mergingSlice();
    w.workspace.worktrees.clear();
    await w.psdd("take", "127");
    const res = await w.psdd("done", "127");
    await w.psdd("next", "123");
    expect(w.workspace.removed).toEqual([]);
    expect(res.stdout).not.toContain("worktree");
  });

  test("a worktree that cannot be removed is reported by next, and the rest of next still runs", async () => {
    const w = mergingSlice();
    w.github.issues.get(127)!.state = "closed";
    w.workspace.removeWorktree = async () => {
      throw new Error("git worktree remove failed: locked");
    };

    const res = await w.psdd("next", "123");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Could not remove the worktree of #127: git worktree remove failed: locked");
    expect(res.stdout).toContain("Slice #128");
  });

  test("the story worktree is removed once the story has merged into main", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", state: "closed", labels: ["type:story", "merge-queue"] });
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting");

    const res = await w.psdd("next", "123");

    expect(w.workspace.removed.map((r) => r.path)).toEqual([".agents/worktrees/123-rate-limiting"]);
    expect(res.stdout).toContain("Story #123 is merged and closed. Removed its worktree .agents/worktrees/123-rate-limiting.");
  });

  test("a worktree with uncommitted changes is kept, and next says so", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 127, title: "Redis store", state: "closed", stateReason: "not_planned", labels: ["type:slice", "mode:afk"] });
    w.github.parents.set(127, 123);
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting-127");
    w.workspace.dirty.add(".agents/worktrees/123-rate-limiting-127");

    const res = await w.psdd("next", "123");

    expect(w.workspace.removed).toEqual([]);
    expect(res.stdout).toContain("Kept /repo/.agents/worktrees/123-rate-limiting-127: it has uncommitted changes. Remove it by hand when done.");
  });

  test("a closed story loses the state label GitHub left on it, and next reports no state", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", state: "closed", labels: ["type:story", "merge-queue"] });
    w.github.seedIssue({ number: 127, title: "Redis store", state: "closed", labels: ["type:slice", "mode:afk", "merge-queue"] });
    w.github.parents.set(127, 123);

    const res = await w.psdd("next", "123", "--json");

    expect(w.github.labels(123)).toEqual(["type:story"]);
    expect(w.github.labels(127)).toEqual(["type:slice", "mode:afk"]);
    expect(JSON.parse(res.stdout)).toMatchObject({ state: null, closed: true });
    expect(w.github.claims.size).toBe(0);
  });

  test("taking over a stale claim keeps the worktree the previous holder left, and says so", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan"] });
    w.setNow("2026-10-13T08:00:00Z");
    await w.as("crashed")("take", "123");
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting");
    w.workspace.localBranches.add("123-rate-limiting");
    w.setNow("2026-10-13T12:00:00Z");

    const res = await w.psdd("take", "123");

    expect(w.workspace.removed).toEqual([]);
    expect(res.stdout).toContain(
      "The previous holder's claim was stale (since 08:00); its worktree is kept with what it left. Check git status there before you start.",
    );
    expect(res.stdout).not.toContain("does not exist");
  });

  test("next never removes the worktree it is running in", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", state: "closed", labels: ["type:story", "merge-queue"] });
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting");
    w.workspace.cwd = "/repo/.agents/worktrees/123-rate-limiting/src";

    const res = await w.psdd("next", "123");

    expect(w.workspace.removed).toEqual([]);
    expect(res.stdout).toContain("Could not remove the worktree of #123: psdd is running inside it");
  });
});

describe("a fix round's briefing", () => {
  test("a slice sent back by review is briefed as rework, even though take relabels it implementation", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "changes-requested"] });
    w.github.parents.set(131, 123);

    const res = await w.psdd("take", "131");

    expect(w.github.labels(131)).toContain("implementation");
    expect(res.stdout).toContain("This is rework: the latest review or QA comment on #131 lists what to fix.");
    expect(res.stdout).toContain("Open one PR from 123-rate-limiting-131 into 123-rate-limiting if there is none yet:");
  });

  test("a story that failed QA is briefed as rework", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "qa-failed"] });

    const res = await w.psdd("take", "123");

    expect(res.stdout).toContain("This is rework: the latest review or QA comment on #123 lists what to fix.");
    expect(res.stdout).toContain("Commit the fixes straight onto the story branch 123-rate-limiting and push them.");
  });
});

describe("an existing worktree", () => {
  test("whose branch is on GitHub is brought up to date before work starts", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-review"] });
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting");
    w.github.branches.add("123-rate-limiting");

    const res = await w.psdd("take", "123");

    expect(res.stdout).toContain(
      [
        "Work in: /repo/.agents/worktrees/123-rate-limiting (branch 123-rate-limiting)",
        "Bring it up to date first:",
        "  git -C /repo/.agents/worktrees/123-rate-limiting fetch origin 123-rate-limiting && git -C /repo/.agents/worktrees/123-rate-limiting merge --ff-only origin/123-rate-limiting",
      ].join("\n"),
    );
  });

  test("whose branch is only local is just named", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan"] });
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting");

    const res = await w.psdd("take", "123");

    expect(res.stdout).not.toContain("Bring it up to date");
  });
});
