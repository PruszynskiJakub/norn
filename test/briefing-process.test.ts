import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

/** The briefing carries the process around each skill, so the skills need not know norn. */
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

  test("triage: read the issue, and post findings before choosing the type", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7, title: "Something", labels: [] });
    const res = await w.norn("take", "7");
    expect(res.stdout).toContain("Read the issue: gh issue view 7 --comments");
    expect(res.stdout).toContain("Unless you reject it, post what triage established on the issue before norn done: gh issue comment 7 --body-file <file>");
  });

  test("plan: commit and push the spec on the story branch", async () => {
    const res = await storyAt("needs-plan").norn("take", "123");
    expect(res.stdout).toContain("Commit the spec on 123-rate-limiting and push it, so the link norn posts resolves.");
  });

  test("slice: how to create slices and their bodies, then push the story branch", async () => {
    const res = await storyAt("needs-slicing").norn("take", "123");
    expect(res.stdout).toContain('  norn add-slice 123 "<title>" --mode afk|hil [--blocked-by <slice>]...');
    expect(res.stdout).toContain("  --mode afk when an agent can verify every criterion, hil when a person must also look at it.");
    expect(res.stdout).toContain("Then give each slice its body: gh issue edit <slice> --body-file <file>");
    expect(res.stdout).toContain("Push 123-rate-limiting once the slices exist, so slice PRs can target it.");
  });

  test("rework on a slice points at the latest review or QA comment", async () => {
    const w = sliceAt("changes-requested");
    w.github.commentsByIssue.set(131, ["norn: implementation → needs-review", "norn: needs-review → changes-requested (request-changes)"]);
    const res = await w.norn("take", "131");
    expect(res.stdout).toContain("This is rework: the latest review or QA comment on #131 lists what to fix.");
  });

  test("first implementation of a slice is not called rework", async () => {
    const res = await sliceAt("ready-for-agent").norn("take", "131");
    expect(res.stdout).not.toContain("This is rework");
  });

  test("slice review names the PR and the diff against the story branch", async () => {
    const res = await sliceAt("needs-review").norn("take", "131");
    expect(res.stdout).toContain("Slice PR: 123-rate-limiting-131 into 123-rate-limiting. Diff: git diff origin/123-rate-limiting...HEAD");
  });

  test("resolve on a story: the reason, the record, and where spec changes go", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan", "needs-human"] });
    const out = (await w.norn("take", "123")).stdout;
    expect(out).toContain("Invoke the skill: norn-resolve");
    expect(out).toContain("The latest needs-human comment gives the reason. Read the issue: gh issue view 123 --comments");
    expect(out).toContain("Record the outcome on the issue: gh issue comment 123");
    expect(out).toContain("Spec changes go in .agents/specs/123-rate-limiting/spec.md; commit and push them on 123-rate-limiting.");
  });
});

/** Unattended, nobody reads a question the agent leaves in its session, so it asks where norn sees it. */
describe("how a briefing says to ask a person", () => {
  const askLine = 'When you need a person, run: norn escalate 131 "<question>" --wait, and wait for the answer in this session.';

  test("an unattended step asks with escalate --wait and never ends a turn on a question", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    w.github.parents.set(131, 123);

    const out = (await w.norn("take", "131")).stdout;

    expect(out).toContain(askLine);
    expect(out).toContain("Never end a turn on a question.");
    expect(out).toContain('If something is wrong and a person is needed, run: norn escalate 131 "<reason>"');
  });

  test("an attended step asks the user directly, so it has no --wait line", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan"] });

    const out = (await w.norn("take", "123")).stdout;

    expect(out).not.toContain("--wait");
    expect(out).not.toContain("Never end a turn on a question.");
    expect(out).toContain('If something is wrong and a person is needed, run: norn escalate 123 "<reason>"');
  });
});
