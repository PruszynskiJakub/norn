import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

function issue(labels: string[], number = 131) {
  const w = setup();
  w.github.seedIssue({ number, title: "Per-key limits", labels });
  return w;
}

describe("review", () => {
  test.each([
    [["type:slice", "mode:afk"], "approve", ["mode:afk", "needs-qa", "type:slice"]],
    [["type:slice", "mode:afk"], "request-changes", ["changes-requested", "mode:afk", "type:slice"]],
    [["type:story"], "request-changes", ["changes-requested", "type:story"]],
  ])("%j in needs-review finished with %s", async (labels, word, after) => {
    const w = issue([...labels, "needs-review"]);
    const take = await w.psdd("take", "131");
    expect(take.stdout).toContain("Invoke the skill: review");

    const res = await w.psdd("done", "131", word, "Review notes");

    expect(res.exitCode).toBe(0);
    expect(w.github.labels(131).sort()).toEqual(after);
    expect(w.github.comments(131).at(-1)).toContain("Review notes");
  });

  test("approving a mode:hil slice hands QA to a human via needs-human", async () => {
    const w = issue(["type:slice", "mode:hil", "needs-review"]);
    await w.psdd("take", "131");

    await w.psdd("done", "131", "approve");

    expect(w.github.labels(131).sort()).toEqual(["mode:hil", "needs-human", "needs-qa", "type:slice"]);
    expect(w.github.comments(131).at(-1)).toContain("psdd: needs-human — QA in mode:hil");
  });

  test("approving a story hands QA to a human, since story QA is always human", async () => {
    const w = issue(["type:story", "needs-review"]);
    await w.psdd("take", "131");
    await w.psdd("done", "131", "approve");
    expect(w.github.labels(131).sort()).toEqual(["needs-human", "needs-qa", "type:story"]);
  });
});

describe("qa", () => {
  test.each([
    ["pass", "merge-queue"],
    ["fail", "qa-failed"],
  ])("an afk slice in needs-qa, %s → %s", async (word, to) => {
    const w = issue(["type:slice", "mode:afk", "needs-qa"]);
    const take = await w.psdd("take", "131");
    expect(take.stdout).toContain("Invoke the skill: qa");
    expect(take.stdout).not.toContain("attended");

    await w.psdd("done", "131", word, "QA notes");

    expect(w.github.labels(131).sort()).toEqual(["mode:afk", to, "type:slice"].sort());
  });

  test("a human records hil QA through their agent; the result clears needs-human", async () => {
    const w = issue(["type:slice", "mode:hil", "needs-qa", "needs-human"]);
    const take = await w.psdd("take", "131");
    expect(take.stdout).toContain("Invoke the skill: qa");
    expect(take.stdout.replace(/\s+/g, " ")).toContain("This step is attended");

    await w.psdd("done", "131", "pass");

    expect(w.github.labels(131).sort()).toEqual(["merge-queue", "mode:hil", "type:slice"]);
  });

  test.each([
    ["pass", "merge-queue"],
    ["fail", "qa-failed"],
  ])("a story's human QA, %s → %s", async (word, to) => {
    const w = issue(["type:story", "needs-qa", "needs-human"]);
    await w.psdd("take", "131");
    await w.psdd("done", "131", word, "QA notes");
    expect(w.github.labels(131).sort()).toEqual([to, "type:story"]);
  });
});

describe("story fixes", () => {
  test.each(["changes-requested", "qa-failed"])(
    "a story in %s is fixed on the story branch with tdd, then goes back to needs-review",
    async (state) => {
      const w = issue(["type:story", state], 123);
      w.github.issues.get(123)!.title = "Rate limiting";
      const take = await w.psdd("take", "123");
      expect(take.stdout).toContain("Invoke the skill: tdd");
      expect(take.stdout).toContain("123-rate-limiting");
      expect(w.github.labels(123)).toContain(state);

      await w.psdd("done", "123");

      expect(w.github.labels(123).sort()).toEqual(["needs-review", "type:story"]);
    },
  );
});
