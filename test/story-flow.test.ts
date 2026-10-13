import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

function story(state: string) {
  const w = setup();
  w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", state], assignees: ["alice"] });
  return w;
}

describe("story phase 1", () => {
  test("taking a story in needs-refinement gives the attended refine briefing", async () => {
    const w = story("needs-refinement");

    const res = await w.psdd("take", "123");

    expect(res.stdout).toBe(
      [
        'You now hold story #123 "Rate limiting". Its step is refinement. This step',
        "is attended: the user takes part, and you do not decide on your own.",
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
      "https://github.com/acme/app/blob/abc123/.agents/specs/123-rate-limiting/spec.md",
    );
  });
});
