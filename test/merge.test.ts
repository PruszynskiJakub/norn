import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

/** Story #123 in implementation with slices 127 → 131 → 132 chained by blocked-by, plus independent 128. */
function storyWithSlices() {
  const w = setup();
  const gh = w.github;
  gh.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
  gh.seedIssue({ number: 127, title: "Redis store", labels: ["type:slice", "mode:afk", "merge-queue"] });
  gh.seedIssue({ number: 128, title: "Limit headers", labels: ["type:slice", "mode:afk", "needs-review"] });
  gh.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "blocked"] });
  gh.seedIssue({ number: 132, title: "Docs", labels: ["type:slice", "mode:afk", "blocked"] });
  for (const s of [127, 128, 131, 132]) gh.parents.set(s, 123);
  gh.blockers.set(131, [127]);
  gh.blockers.set(132, [131, 127]);
  gh.branches.add("123-rate-limiting");
  return w;
}

describe("merge-queue on a slice", () => {
  test("is briefed with the merge skill and the PR into the story branch", async () => {
    const w = storyWithSlices();
    const res = await w.norn("take", "127");
    expect(res.stdout).toContain("Invoke the skill: norn-merge");
    expect(res.stdout).toContain("Bring 123-rate-limiting-127 up to date: merge origin/123-rate-limiting into it, resolving conflicts if needed.");
    expect(res.stdout).toContain("Run the repository's checks, fix what the merge broke, and push.");
    expect(res.stdout).toContain("Then finish with norn done 127: norn merges the PR into 123-rate-limiting once its checks pass on the commit you pushed.");
    expect(res.stdout).toContain("Do not merge the PR yourself, with gh pr merge or otherwise.");
    expect(res.stdout).not.toContain("gh pr merge 123");
  });

  test("done merges an open slice PR that is up to date and green, at the head it checked, then closes the slice", async () => {
    const w = storyWithSlices();
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "open" });
    w.github.readiness.set(50, { headSha: "abc123", checks: [{ name: "test", state: "passed" }] });
    await w.norn("take", "127");

    const res = await w.norn("done", "127");

    expect(res.exitCode).toBe(0);
    expect(w.github.merges).toEqual([{ number: 50, headSha: "abc123" }]);
    expect(w.github.prs.find((p) => p.number === 50)!.state).toBe("merged");
    expect(w.github.issues.get(127)!.state).toBe("closed");
    expect(w.github.labels(131)).toContain("ready-for-agent");
    expect(w.github.claim(127)).toBeNull();
  });

  test("a repository without checks merges once the PR is mergeable", async () => {
    const w = storyWithSlices();
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "open" });
    await w.norn("take", "127");

    expect((await w.norn("done", "127")).exitCode).toBe(0);
    expect(w.github.merges.map((m) => m.number)).toEqual([50]);
  });

  test.each([
    ["a failed check", { checks: [{ name: "test", state: "failed" }] }, '#127: check "test" failed on PR #50. Fix it and push, then run norn done 127 again.'],
    [
      "checks still running",
      {
        checks: [
          { name: "test", state: "pending" },
          { name: "lint", state: "passed" },
          { name: "e2e", state: "pending" },
        ],
      },
      "#127: 2 checks on PR #50 are still running. Run norn done 127 again when they finish.",
    ],
    ["conflicts", { mergeable: "conflicting" }, "#127: PR #50 has conflicts with 123-rate-limiting."],
    ["a PR behind the story branch", { behind: true }, "#127: PR #50 is behind 123-rate-limiting"],
    ["mergeability GitHub has not worked out", { mergeable: "unknown" }, "#127: GitHub is still working out whether PR #50 can merge."],
  ] as const)("with %s, done refuses, says what to do, and changes nothing", async (_, readiness, says) => {
    const w = storyWithSlices();
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "open" });
    w.github.readiness.set(50, structuredClone(readiness) as never);
    await w.norn("take", "127");
    const labels = [...w.github.labels(127)];

    const res = await w.norn("done", "127");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(says);
    expect(w.github.merges).toEqual([]);
    expect(w.github.labels(127)).toEqual(labels);
    expect(w.github.claim(127)).toMatchObject({ session: "session-1" });
  });

  test("a push after norn read the checks is never merged: done refuses and says to sync and check again", async () => {
    const w = storyWithSlices();
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "open" });
    w.github.readiness.set(50, { headSha: "checked" });
    w.github.afterReadiness = (n) => {
      w.github.afterReadiness = null;
      w.github.pushTo(n, "pushed-later");
    };
    await w.norn("take", "127");

    const res = await w.norn("done", "127");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#127: PR #50 moved to a new commit while norn read its checks, so norn did not merge it.");
    expect(w.github.prs.find((p) => p.number === 50)!.state).toBe("open");
    expect(w.github.issues.get(127)!.state).toBe("open");
  });

  test("a merge GitHub refuses, e.g. for branch protection, tells the agent to escalate with GitHub's reason", async () => {
    const w = storyWithSlices();
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "open" });
    w.github.mergeRefusals.set(50, "Protected branch rules not satisfied");
    await w.norn("take", "127");

    const res = await w.norn("done", "127");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#127: GitHub refused to merge PR #50: Protected branch rules not satisfied");
    expect(res.stdout).toContain("norn escalate 127 'GitHub refused to merge PR #50: Protected branch rules not satisfied'");
    expect(w.github.issues.get(127)!.state).toBe("open");
    expect(w.github.claim(127)).toMatchObject({ session: "session-1" });
  });

  test("a slice PR a person already merged is accepted, and norn merges nothing", async () => {
    const w = storyWithSlices();
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "merged" });
    await w.norn("take", "127");

    expect((await w.norn("done", "127")).exitCode).toBe(0);
    expect(w.github.merges).toEqual([]);
    expect(w.github.issues.get(127)!.state).toBe("closed");
  });

  test("norn never merges into the base branch: a slice PR into main is refused, and the story PR is left alone", async () => {
    const w = storyWithSlices();
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "main", state: "open" });
    w.github.prs.push({ number: 60, head: "123-rate-limiting", base: "main", state: "open" });
    await w.norn("take", "127");

    const res = await w.norn("done", "127");

    expect(res.exitCode).toBe(1);
    expect(w.github.merges).toEqual([]);
    expect(w.github.prs.map((p) => p.state)).toEqual(["open", "open"]);
  });

  test("done is refused when the slice PR targets another branch than the story branch", async () => {
    const w = storyWithSlices();
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "main", state: "open" });
    await w.norn("take", "127");

    const res = await w.norn("done", "127");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("PR #50 from 123-rate-limiting-127 targets main, not the parent's branch 123-rate-limiting.");
    expect(res.stdout).toContain("gh pr edit 50 --base 123-rate-limiting");
    expect(w.github.merges).toEqual([]);
  });

  test("a slice PR already merged into main is refused, not counted as merged into the story", async () => {
    const w = storyWithSlices();
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "main", state: "merged" });
    await w.norn("take", "127");

    const res = await w.norn("done", "127");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("norn escalate 127 'PR #50 was merged into main, not 123-rate-limiting'");
    expect(w.github.issues.get(127)!.state).toBe("open");
  });

  test("done closes the slice and unblocks dependents with no open blockers", async () => {
    const w = storyWithSlices();
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "merged" });
    await w.norn("take", "127");

    const res = await w.norn("done", "127");

    expect(res.exitCode).toBe(0);
    const s127 = w.github.issues.get(127)!;
    expect(s127.state).toBe("closed");
    expect(s127.stateReason).toBe("completed");
    expect(s127.labels).not.toContain("merge-queue");
    expect(w.github.labels(131)).toContain("ready-for-agent");
    expect(w.github.labels(131)).not.toContain("blocked");
    expect(w.github.labels(132)).toContain("blocked");
    expect(res.stdout).toContain("#131 is now ready-for-agent");
    expect(w.github.labels(123)).toContain("implementation");
  });

  test("when the last slice merges, the story goes to needs-review and gets its PR into main", async () => {
    const w = storyWithSlices();
    for (const s of [128, 131, 132]) w.github.issues.get(s)!.state = "closed";
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "merged" });
    await w.norn("take", "127");

    await w.norn("done", "127");

    expect(w.github.labels(123).sort()).toEqual(["needs-review", "type:story"]);
    const pr = w.github.prs.find((p) => p.head === "123-rate-limiting")!;
    expect(pr).toMatchObject({ base: "main", state: "open" });
    expect(pr.body).toContain("Closes #123");
    expect(w.github.comments(123).at(-1)).toContain("implementation → needs-review");
  });
});

describe("story transitions around slices", () => {
  test("finishing slicing creates the story branch from main", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-slicing"], assignees: ["alice"] });
    await w.norn("take", "123");
    await w.norn("add-slice", "123", "Redis store", "--mode", "afk");

    await w.norn("done", "123");

    expect(w.github.branches.has("123-rate-limiting")).toBe(true);
  });

  test("a story in implementation cannot be taken; its label follows its slices", async () => {
    const w = storyWithSlices();
    const res = await w.norn("take", "123");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("follows its slices");
    expect(res.stdout).toContain("norn next 123");
    expect(w.github.claim(123)).toBeNull();
  });

  test("a story in merge-queue is merged by its owner, not by an agent step", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "merge-queue"], assignees: ["bob"] });
    const res = await w.norn("take", "123");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Only the story owner (@bob) merges the story PR;");
    expect(res.stdout).toContain("norn next 123 closes the story if GitHub has not");
    expect(w.github.claim(123)).toBeNull();
  });

  test("a blocked slice cannot be taken", async () => {
    const w = storyWithSlices();
    const res = await w.norn("take", "131");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#131 is blocked by #127");
    expect(w.github.claim(131)).toBeNull();
  });
});
