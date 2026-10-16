import { describe, expect, test } from "vitest";
import { setup } from "@shepherd/testing";

function rename(w: ReturnType<typeof setup>, n: number, title: string) {
  w.github.issues.get(n)!.title = title;
}

describe("a story's names come from the slug shepherd recorded, not its live title", () => {
  test("triage records the slug in its transition comment", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting" });
    await w.shepherd("take", "123");
    await w.shepherd("done", "123", "accept");

    expect(w.github.comments(123).at(-1)).toContain("\nshepherd: slug rate-limiting");
  });

  test("renaming the story after triage keeps its spec path, branch and worktree", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting" });
    await w.shepherd("take", "123");
    await w.shepherd("done", "123", "accept");
    rename(w, 123, "Per-client rate limits");

    const res = await w.shepherd("take", "123");

    expect(res.stdout).toContain("Spec to work on: .agents/specs/123-rate-limiting/spec.md");
    expect(res.stdout).toContain("Work in: /repo/.agents/worktrees/123-rate-limiting (branch 123-rate-limiting)");
  });

  test("renaming after slicing creates no second story branch, and slices keep their PR head", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-slicing"] });
    w.github.commentsByIssue.set(123, ["shepherd: triage → needs-refinement (accept)\n\nshepherd: slug rate-limiting"]);
    w.github.seedIssue({ number: 127, title: "Redis store", labels: ["type:slice", "mode:afk", "merge-queue"] });
    w.github.parents.set(127, 123);
    await w.shepherd("take", "123");
    await w.shepherd("done", "123");
    rename(w, 123, "Per-client rate limits");
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "merged" });

    await w.shepherd("next", "123");
    await w.shepherd("take", "127");
    const res = await w.shepherd("done", "127");

    expect([...w.github.branches].filter((b) => b.startsWith("123-"))).toEqual(["123-rate-limiting"]);
    expect(res.exitCode).toBe(0);
    expect(w.github.prs.find((p) => p.base === "main")?.head).toBe("123-rate-limiting");
  });

  test("a story from before the marker records its slug on its next transition", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan"] });
    await w.shepherd("take", "123");
    await w.shepherd("done", "123");
    rename(w, 123, "Per-client rate limits");

    expect(w.github.comments(123).at(-1)).toContain("shepherd: slug rate-limiting");
    expect((await w.shepherd("take", "123")).stdout).toContain(".agents/specs/123-rate-limiting/spec.md");
  });

  test("the slug is read once per command, not once per slice", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.branches.add("123-rate-limiting");
    for (const n of [127, 128, 129]) {
      w.github.seedIssue({ number: n, title: `Slice ${n}`, labels: ["type:slice", "mode:afk", "ready-for-agent"] });
      w.github.parents.set(n, 123);
    }
    let reads = 0;
    const list = w.github.listComments.bind(w.github);
    w.github.listComments = async (n: number) => {
      if (n === 123) reads++;
      return list(n);
    };

    await w.shepherd("next", "123");

    expect(reads).toBe(1);
  });

  test("a title with no ASCII letters or digits records its empty slug once, not on every comment", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "日本語 — ✨" });
    await w.shepherd("take", "123");
    await w.shepherd("done", "123", "accept");
    await w.shepherd("take", "123");
    await w.shepherd("done", "123", "clear");

    const marked = w.github.comments(123).filter((c) => c.split("\n").some((l) => l.trimEnd() === "shepherd: slug"));
    expect(marked).toHaveLength(1);
  });

  test("a slug marker whose trailing space GitHub dropped still counts as recorded", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "✨", labels: ["type:story", "needs-refinement"] });
    w.github.commentsByIssue.set(123, ["shepherd: triage → needs-refinement (accept)\n\nshepherd: slug"]);
    await w.shepherd("take", "123");
    await w.shepherd("done", "123", "clear");

    expect(w.github.comments(123).at(-1)).not.toContain("shepherd: slug");
  });
});
