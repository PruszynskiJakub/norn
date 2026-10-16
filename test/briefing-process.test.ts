import { describe, expect, test } from "vitest";
import { setup } from "@shepherd/testing";

/** The briefing carries the process around each skill, so the skills need not know shepherd. */
describe("briefing carries the process", () => {
  function storyAt(state: string) {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", state] });
    return w;
  }

  function sliceAt(state: string) {
    const w = storyAt("implementation");
    w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", state] });
    w.github.parents.set(131, 123);
    return w;
  }

  test("triage: read the issue, and post findings before accepting", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7, title: "Something", labels: [] });
    const res = await w.shepherd("take", "7");
    expect(res.stdout).toContain("Read the issue: gh issue view 7 --comments");
    expect(res.stdout).toContain("On accept, post what triage established on the issue first: gh issue comment 7");
  });

  test("plan: commit and push the spec on the story branch", async () => {
    const res = await storyAt("needs-plan").shepherd("take", "123");
    expect(res.stdout).toContain("Commit the spec on 123-rate-limiting and push it, so the link shepherd posts resolves.");
  });

  test("slice: how to create slices and their bodies, then push the story branch", async () => {
    const res = await storyAt("needs-slicing").shepherd("take", "123");
    expect(res.stdout).toContain('  shepherd add-slice 123 "title" --mode afk|hil [--blocked-by <slice>]...');
    expect(res.stdout).toContain("  --mode afk when an agent can verify every criterion, hil when a person must also look at it.");
    expect(res.stdout).toContain("Then give each slice its body: gh issue edit <slice> --body-file <file>");
    expect(res.stdout).toContain("Push 123-rate-limiting once the slices exist, so slice PRs can target it.");
  });

  test("rework on a slice points at the latest review or QA comment", async () => {
    const w = sliceAt("changes-requested");
    w.github.commentsByIssue.set(131, ["shepherd: implementation → needs-review", "shepherd: needs-review → changes-requested (request-changes)"]);
    const res = await w.shepherd("take", "131");
    expect(res.stdout).toContain("This is rework: the latest review or QA comment on #131 lists what to fix.");
  });

  test("first implementation of a slice is not called rework", async () => {
    const res = await sliceAt("ready-for-agent").shepherd("take", "131");
    expect(res.stdout).not.toContain("This is rework");
  });

  test("slice review names the PR and the diff against the story branch", async () => {
    const res = await sliceAt("needs-review").shepherd("take", "131");
    expect(res.stdout).toContain("Slice PR: 123-rate-limiting-131 into 123-rate-limiting. Diff: git diff origin/123-rate-limiting...HEAD");
  });

  test("resolve on a story: the reason, the record, and where spec changes go", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan", "needs-human"] });
    const out = (await w.shepherd("take", "123")).stdout;
    expect(out).toContain("Invoke the skill: resolve");
    expect(out).toContain("The latest needs-human comment gives the reason. Read the issue: gh issue view 123 --comments");
    expect(out).toContain("Record the outcome on the issue: gh issue comment 123");
    expect(out).toContain("Spec changes go in .agents/specs/123-rate-limiting/spec.md; commit and push them on 123-rate-limiting.");
  });
});
