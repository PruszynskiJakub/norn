import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

function story(state: string) {
  const w = setup();
  w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", state], assignees: ["alice"] });
  return w;
}

describe("story phase 1", () => {
  test.each([
    ["needs-refinement", "clear", "needs-plan"],
    ["needs-refinement", "questions", "needs-clarification"],
    ["needs-clarification", "answered", "needs-plan"],
    ["needs-clarification", "questions", "needs-clarification"],
    ["needs-plan", "", "needs-slicing"],
  ])("%s finished with '%s' moves to %s", async (from, word, to) => {
    const w = story(from);
    await w.psdd("take", "123");

    const res = await w.psdd("done", "123", ...(word ? [word] : []));

    expect(res.exitCode).toBe(0);
    expect(w.github.labels(123).sort()).toEqual([to, "type:story"]);
  });

  test.each([
    ["needs-clarification", "clarify"],
    ["needs-plan", "plan"],
    ["needs-slicing", "slice"],
  ])("%s is briefed with the %s skill and the spec", async (state, skill) => {
    const w = story(state);
    const res = await w.psdd("take", "123");
    expect(res.stdout).toContain(`Invoke the skill: ${skill}\n`);
    expect(res.stdout.replace(/\s+/g, " ")).toContain("This step is attended");
    expect(res.stdout).toContain("Spec to work on: .agents/specs/123-rate-limiting/spec.md");
  });

  test("each transition comment links to the spec at its commit", async () => {
    const w = story("needs-plan");
    await w.psdd("take", "123");
    await w.psdd("done", "123");
    expect(w.github.comments(123).at(-1)).toContain(
      "https://github.com/acme/app/blob/123-rate-limiting/.agents/specs/123-rate-limiting/spec.md",
    );
  });
});
