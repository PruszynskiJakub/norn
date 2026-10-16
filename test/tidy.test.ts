import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

/**
 * Story #123 with slice #127 merged into the story branch and slice #128 still
 * open, each with its worktree and branch, locally and on GitHub.
 */
function story() {
  const w = setup();
  const gh = w.github;
  gh.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
  gh.seedIssue({ number: 127, title: "Redis store", state: "closed", stateReason: "completed", labels: ["type:slice", "mode:afk"] });
  gh.seedIssue({ number: 128, title: "Headers", labels: ["type:slice", "mode:afk", "needs-review"] });
  gh.parents.set(127, 123);
  gh.parents.set(128, 123);
  gh.commentsByIssue.set(123, ["psdd: needs-slicing → implementation\n\npsdd: slug rate-limiting"]);
  gh.prs.push({ number: 50, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "merged", headSha: "merged127" });
  gh.prs.push({ number: 51, head: "123-rate-limiting-128", base: "123-rate-limiting", state: "open" });
  for (const b of ["123-rate-limiting", "123-rate-limiting-127", "123-rate-limiting-128"]) {
    gh.branches.add(b);
    w.workspace.localBranches.add(b);
    w.workspace.worktrees.add(`.agents/worktrees/${b}`);
  }
  return w;
}

/** The story merged into main and closed, after story QA left evidence. */
function mergedStory() {
  const w = story();
  const gh = w.github;
  gh.issues.get(123)!.state = "closed";
  gh.issues.get(128)!.state = "closed";
  gh.prs.find((p) => p.number === 51)!.state = "merged";
  gh.prs.push({ number: 60, head: "123-rate-limiting", base: "main", state: "merged" });
  gh.branches.add("psdd/qa/123");
  gh.branches.add("psdd/qa/128");
  return w;
}

describe("psdd tidy", () => {
  test("removes a merged slice's worktree with the configured tool and its branch, locally and on GitHub", async () => {
    const w = story();

    const res = await w.psdd("tidy");

    expect(res.exitCode).toBe(0);
    expect(w.workspace.removed).toEqual([{ path: ".agents/worktrees/123-rate-limiting-127", provider: "claude-code" }]);
    expect(w.workspace.deletedBranches).toEqual(["123-rate-limiting-127"]);
    expect(w.github.branches.has("123-rate-limiting-127")).toBe(false);
    expect(res.stdout).toBe(
      [
        "psdd tidy removed:",
        "  - worktree .agents/worktrees/123-rate-limiting-127 (slice #127 is closed)",
        "  - local branch 123-rate-limiting-127 (merged into 123-rate-limiting)",
        "  - branch 123-rate-limiting-127 on GitHub (merged into 123-rate-limiting)",
      ].join("\n"),
    );
  });

  test("leaves open items alone: their worktrees, branches and QA evidence", async () => {
    const w = story();
    w.github.branches.add("psdd/qa/128");
    await w.psdd("tidy");
    expect(w.workspace.worktrees.has(".agents/worktrees/123-rate-limiting-128")).toBe(true);
    expect(w.workspace.worktrees.has(".agents/worktrees/123-rate-limiting")).toBe(true);
    expect([...w.github.branches].sort()).toEqual(["123-rate-limiting", "123-rate-limiting-128", "main", "psdd/qa/128"]);
  });

  test("once the story has merged into main, removes everything it left: worktrees, branches, QA evidence and claims", async () => {
    const w = mergedStory();
    w.github.claims.set(128, { holder: "alice", session: "gone", since: "2026-10-13T08:00:00Z" });

    const res = await w.psdd("tidy");

    expect(w.workspace.worktrees.size).toBe(0);
    expect([...w.github.branches]).toEqual(["main"]);
    expect([...w.workspace.localBranches]).toEqual(["main"]);
    expect(w.github.claims.size).toBe(0);
    expect(res.stdout).toContain("  - QA evidence branch psdd/qa/123 (#123 is closed)");
    expect(res.stdout).toContain("  - branch 123-rate-limiting on GitHub (merged into main)");
    expect(res.stdout).toContain("  - claim on #128 (#128 is closed)");
  });

  test("is idempotent: a second run finds nothing", async () => {
    const w = mergedStory();
    await w.psdd("tidy");
    const res = await w.psdd("tidy");
    expect(res.stdout).toBe("Nothing to tidy: nothing is left of closed issues.");
  });

  test("--dry-run lists what it would remove and changes nothing", async () => {
    const w = mergedStory();

    const res = await w.psdd("tidy", "--dry-run");

    expect(res.stdout.split("\n")[0]).toBe("psdd tidy would remove (dry run, nothing was changed):");
    expect(res.stdout).toContain("  - QA evidence branch psdd/qa/128 (#128 is closed)");
    expect(w.workspace.removed).toEqual([]);
    expect(w.workspace.deletedBranches).toEqual([]);
    expect(w.github.branches.size).toBe(6);
  });

  test("keeps and names a worktree with uncommitted changes, and its branch with it", async () => {
    const w = story();
    w.workspace.dirty.add(".agents/worktrees/123-rate-limiting-127");

    const res = await w.psdd("tidy");

    expect(w.workspace.removed).toEqual([]);
    expect(w.workspace.deletedBranches).toEqual([]);
    expect(w.github.branches.has("123-rate-limiting-127")).toBe(true);
    expect(res.stdout).toContain(
      "Kept, so no work is lost:\n  - /repo/.agents/worktrees/123-rate-limiting-127: it has uncommitted changes. Commit and push them, or remove it by hand when done.",
    );
  });

  test("keeps and names a branch with commits that are not on GitHub", async () => {
    const w = story();
    w.workspace.unpushed.add("123-rate-limiting-127");

    const res = await w.psdd("tidy");

    expect(w.workspace.removed).toEqual([]);
    expect(w.workspace.deletedBranches).toEqual([]);
    expect(w.github.branches.has("123-rate-limiting-127")).toBe(true);
    expect(res.stdout).toContain("branch 123-rate-limiting-127 has commits that are not on GitHub");
  });

  test("counts commits as pushed when the branch is where its PR merged from, e.g. after a squash merge", async () => {
    const w = story();
    w.workspace.unpushed.add("123-rate-limiting-127");
    w.workspace.heads.set("123-rate-limiting-127", "merged127");

    await w.psdd("tidy");

    expect(w.workspace.deletedBranches).toEqual(["123-rate-limiting-127"]);
  });

  test("never removes the worktree it runs in, and names it", async () => {
    const w = story();
    w.workspace.cwd = "/repo/.agents/worktrees/123-rate-limiting-127/src";

    const res = await w.psdd("tidy");

    expect(w.workspace.removed).toEqual([]);
    expect(res.stdout).toContain(
      "/repo/.agents/worktrees/123-rate-limiting-127: psdd is running inside it. Run psdd tidy from another directory to remove it.",
    );
  });

  test("reports a removal that fails, and the rest still runs", async () => {
    const w = mergedStory();
    w.workspace.removeWorktree = async () => {
      throw new Error("git worktree remove failed: locked");
    };

    const res = await w.psdd("tidy");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(
      "Could not remove, the rest still ran:\n  - worktree .agents/worktrees/123-rate-limiting (story #123 is closed): git worktree remove failed: locked",
    );
    expect(w.workspace.deletedBranches).toEqual([]);
    expect(w.github.branches.has("psdd/qa/123")).toBe(false);
  });

  test("a branch checked out in the main checkout is kept locally and named, and removed on GitHub", async () => {
    const w = mergedStory();
    w.workspace.worktrees.delete(".agents/worktrees/123-rate-limiting");
    w.workspace.checkedOut.set("123-rate-limiting", "/repo");

    const res = await w.psdd("tidy");

    expect(w.workspace.localBranches.has("123-rate-limiting")).toBe(true);
    expect(w.github.branches.has("123-rate-limiting")).toBe(false);
    expect(res.stdout).toContain("branch 123-rate-limiting: it is checked out at /repo.");
  });

  test("a story closed as not planned loses its worktree, but its unmerged branch stays", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", state: "closed", stateReason: "not_planned", labels: ["type:story"] });
    w.github.branches.add("123-rate-limiting");
    w.workspace.localBranches.add("123-rate-limiting");
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting");

    await w.psdd("tidy");

    expect(w.workspace.removed.map((r) => r.path)).toEqual([".agents/worktrees/123-rate-limiting"]);
    expect(w.workspace.localBranches.has("123-rate-limiting")).toBe(true);
    expect(w.github.branches.has("123-rate-limiting")).toBe(true);
  });

  test("touches no branch that is not psdd's, even one named like a story's", async () => {
    const w = mergedStory();
    w.github.seedIssue({ number: 45, title: "Old bug", state: "closed" });
    for (const b of ["123-rate-limiting-hotfix", "45-old-bug", "999-no-such-issue"]) {
      w.github.branches.add(b);
      w.workspace.localBranches.add(b);
      w.github.prs.push({ number: 70, head: b, base: "main", state: "merged" });
    }

    await w.psdd("tidy");

    expect([...w.github.branches].sort()).toEqual(["123-rate-limiting-hotfix", "45-old-bug", "999-no-such-issue", "main"]);
  });

  test("a story renamed after its slug was recorded is still tidied by its recorded slug", async () => {
    const w = mergedStory();
    w.github.issues.get(123)!.title = "Throttling";
    await w.psdd("tidy");
    expect(w.workspace.worktrees.size).toBe(0);
  });

  test("--json gives what was removed and kept", async () => {
    const w = story();
    w.workspace.dirty.add(".agents/worktrees/123-rate-limiting-127");
    const report = JSON.parse((await w.psdd("tidy", "--json")).stdout);
    expect(report).toMatchObject({ ok: true, dryRun: false, removed: [], failed: [], notes: [] });
    expect(report.kept).toHaveLength(1);
  });

  test("a failed fetch is noted, and tidy still runs on what was fetched before", async () => {
    const w = story();
    w.workspace.fetchRemote = async () => {
      throw new Error("could not resolve host");
    };
    const res = await w.psdd("tidy");
    expect(res.stdout.split("\n")[0]).toBe(
      "Could not fetch from GitHub, so work pushed since the last fetch counts as unpushed and is kept: could not resolve host",
    );
    expect(w.workspace.removed.map((r) => r.path)).toEqual([".agents/worktrees/123-rate-limiting-127"]);
  });
});
