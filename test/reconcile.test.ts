import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

/** Story #123 in implementation whose last open slice #127 has its PR merged. */
function lastSliceMerged() {
  const w = setup();
  const gh = w.github;
  gh.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
  gh.seedIssue({ number: 127, title: "Redis store", labels: ["type:slice", "mode:afk", "merge-queue"] });
  gh.seedIssue({ number: 128, title: "Headers", state: "closed", labels: ["type:slice", "mode:afk"] });
  gh.parents.set(127, 123);
  gh.parents.set(128, 123);
  gh.branches.add("123-rate-limiting");
  gh.prs.push({ number: 50, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "merged" });
  return w;
}

describe("done makes the transition; what follows is best effort", () => {
  test("a failing story PR does not undo the merge: the slice is closed, the claim released, and next retries", async () => {
    const w = lastSliceMerged();
    const create = w.github.createPullRequest.bind(w.github);
    w.github.createPullRequest = async () => {
      throw new Error("HTTP 502");
    };
    await w.psdd("take", "127");

    const res = await w.psdd("done", "127");

    expect(res.exitCode).toBe(0);
    expect(w.github.issues.get(127)!.state).toBe("closed");
    expect(w.github.claim(127)).toBeNull();
    expect(w.github.labels(123)).toContain("implementation");
    expect(res.stdout).toContain("Could not move the story on: HTTP 502. psdd next 123 will retry this.");

    w.github.createPullRequest = create;
    const next = await w.psdd("next", "123");

    expect(w.github.labels(123)).toContain("needs-review");
    expect(w.github.prs.some((p) => p.head === "123-rate-limiting")).toBe(true);
    expect(next.stdout).toContain("Every slice is merged. Story #123 is now in needs-review.");
  });

  test("the claim is released even when the transition itself fails", async () => {
    const w = lastSliceMerged();
    w.github.closeIssue = async () => {
      throw new Error("HTTP 500");
    };
    await w.psdd("take", "127");

    await expect(w.psdd("done", "127")).rejects.toThrow("HTTP 500");
    expect(w.github.claim(127)).toBeNull();
  });
});

describe("the story branch is made before slicing ends", () => {
  function slicedStory() {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-slicing"], assignees: ["alice"] });
    return w;
  }

  test("a base branch missing on GitHub refuses, with nothing changed and the claim still held", async () => {
    const w = slicedStory();
    w.workspace.files.set(".agents/psdd.config.json", JSON.stringify({ baseBranch: "master" }));
    await w.psdd("take", "123");
    await w.psdd("add-slice", "123", "Redis store", "--mode", "afk");

    const res = await w.psdd("done", "123");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("master does not exist on GitHub");
    expect(w.github.labels(123)).toContain("needs-slicing");
    expect(w.github.claim(123)).not.toBeNull();
  });

  test("next creates the story branch for a story in implementation that has none", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });

    const res = await w.psdd("next", "123");

    expect(w.github.branches.has("123-rate-limiting")).toBe(true);
    expect(res.stdout).toContain("Created the story branch 123-rate-limiting.");
  });

  test("next moves a story whose slices are all merged on to needs-review", async () => {
    const w = lastSliceMerged();
    w.github.issues.get(127)!.state = "closed";

    await w.psdd("next", "123");

    expect(w.github.labels(123)).toContain("needs-review");
  });

  test("an open sub-issue that is not a slice does not hold the story back", async () => {
    const w = lastSliceMerged();
    w.github.issues.get(127)!.state = "closed";
    w.github.seedIssue({ number: 140, title: "Update docs", labels: [] });
    w.github.parents.set(140, 123);

    const res = await w.psdd("next", "123", "--json");

    expect(w.github.labels(123)).toContain("needs-review");
    expect(JSON.parse(res.stdout).slices).toEqual({ total: 2, merged: 2 });
  });
});
