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
    expect(res.stdout).toContain("Invoke the skill: merge");
    expect(res.stdout).toContain("Merge origin/123-rate-limiting into 123-rate-limiting-127, resolving conflicts if needed, and push.");
    expect(res.stdout).toContain("Then merge the PR: gh pr merge 123-rate-limiting-127 --merge");
  });

  test("done is refused while the slice PR is not merged", async () => {
    const w = storyWithSlices();
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "open" });
    await w.norn("take", "127");

    const res = await w.norn("done", "127");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("PR #50 from 123-rate-limiting-127 is not merged yet");
    expect(w.github.issues.get(127)!.state).toBe("open");
  });

  test("done is refused when the slice PR targets another branch than the story branch", async () => {
    const w = storyWithSlices();
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "main", state: "open" });
    await w.norn("take", "127");

    const res = await w.norn("done", "127");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("PR #50 from 123-rate-limiting-127 targets main, not the story branch 123-rate-limiting.");
    expect(res.stdout).toContain("gh pr edit 50 --base 123-rate-limiting");
  });

  test("a slice PR already merged into main is refused, not counted as merged into the story", async () => {
    const w = storyWithSlices();
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "main", state: "merged" });
    await w.norn("take", "127");

    const res = await w.norn("done", "127");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("norn escalate 127 'slice PR #50 was merged into main, not 123-rate-limiting'");
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
