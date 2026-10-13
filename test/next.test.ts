import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

/** The PRD's example: story #123 with 5 slices, 2 merged. */
function prdExample() {
  const w = setup();
  const gh = w.github;
  gh.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
  gh.seedIssue({ number: 125, title: "Config", state: "closed", labels: ["type:slice", "mode:afk"] });
  gh.seedIssue({ number: 126, title: "Errors", state: "closed", labels: ["type:slice", "mode:afk"] });
  gh.seedIssue({ number: 127, title: "Redis store", labels: ["type:slice", "mode:afk", "merge-queue"] });
  gh.seedIssue({ number: 128, title: "Limit headers", labels: ["type:slice", "mode:afk", "needs-review"] });
  gh.seedIssue({ number: 129, title: "Dashboard", labels: ["type:slice", "mode:hil", "needs-qa", "needs-human"] });
  gh.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
  gh.seedIssue({ number: 132, title: "Docs", labels: ["type:slice", "mode:afk", "blocked"] });
  for (const s of [125, 126, 131, 128, 127, 132, 129]) gh.parents.set(s, 123);
  gh.blockers.set(131, [125]);
  gh.blockers.set(132, [131]);
  return w;
}

describe("psdd next", () => {
  test("lists what can start now and what is waiting, as in the PRD", async () => {
    const w = prdExample();

    const res = await w.psdd("next", "123");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(
      [
        'Story #123 "Rate limiting" is in implementation. 2 of 7 slices are merged',
        "into story/123-rate-limiting.",
        "",
        "You can start 3 items now. They are independent, so run them in parallel,",
        "each in its own subagent:",
        "",
        '  - Slice #131 "Per-key limits" is ready-for-agent.',
        "    Start it with: psdd take 131",
        '  - Slice #128 "Limit headers" needs review.',
        "    Start it with: psdd take 128",
        '  - Slice #127 "Redis store" is in merge-queue.',
        "    Start it with: psdd take 127",
        "",
        "Waiting, nothing to do for you:",
        "  - #132 is blocked by #131.",
        "  - #129 needs a human: QA in mode:hil. Do not take it.",
      ].join("\n"),
    );
  });

  test("a slice held by another session is waiting, not startable", async () => {
    const w = prdExample();
    w.setNow("2026-10-13T14:02:00Z");
    await w.as("other")("take", "131");

    const res = await w.psdd("next", "123");

    expect(res.stdout).toContain("You can start 2 items now.");
    expect(res.stdout).toContain("  - #131 is held by another session (since 14:02).");
  });

  test("a story in phase 1 offers the story itself, marked as attended", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-refinement"] });

    const res = await w.psdd("next", "123");

    expect(res.stdout).toContain('Story #123 "Rate limiting" is in needs-refinement.');
    expect(res.stdout).toContain("You can start 1 item now:");
    expect(res.stdout).toContain("refinement (attended: the user takes part)");
    expect(res.stdout).toContain("Start it with: psdd take 123");
  });

  test("a story waiting for its owner to merge has nothing to start", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "merge-queue"], assignees: ["bob"] });

    const res = await w.psdd("next", "123");

    expect(res.stdout).toContain("Nothing can be started now.");
    expect(res.stdout).toContain("#123 waits for its owner (@bob) to merge the story PR into main.");
  });

  test("blocked labels are brought in line with native relations", async () => {
    const w = prdExample();
    w.github.issues.get(131)!.state = "closed";

    const res = await w.psdd("next", "123");

    expect(w.github.labels(132)).toContain("ready-for-agent");
    expect(res.stdout).toContain('Slice #132 "Docs" is ready-for-agent.');
  });

  test("refuses a number that is not a story", async () => {
    const w = prdExample();
    const res = await w.psdd("next", "131");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#131 is a slice of story #123. Run psdd next 123");
  });
});

describe("--json", () => {
  test("psdd next --json gives the same facts for scripts", async () => {
    const w = prdExample();
    const res = await w.psdd("next", "123", "--json");
    const report = JSON.parse(res.stdout);
    expect(report.slices).toEqual({ total: 7, merged: 2 });
    expect(report.start.map((s: { issue: number; skill: string }) => [s.issue, s.skill])).toEqual([
      [131, "tdd"],
      [128, "review"],
      [127, "merge"],
    ]);
    expect(report.waiting.map((x: { issue: number; reason: string }) => [x.issue, x.reason])).toEqual([
      [132, "blocked"],
      [129, "needs-human"],
    ]);
  });

  test("take and done --json report the issue, step and outcome", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7, title: "Rate limiting" });

    const take = JSON.parse((await w.psdd("take", "7", "--json")).stdout);
    expect(take).toMatchObject({ ok: true, issue: 7, step: "triage", skill: "triage", attended: true });
    expect(take.outcomes).toEqual(["accept", "reject"]);

    const done = JSON.parse((await w.psdd("done", "7", "accept", "--json")).stdout);
    expect(done).toMatchObject({ ok: true, issue: 7, to: "needs-refinement" });
  });

  test("refusals are JSON too, with the instruction", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7 });
    const res = await w.psdd("done", "7", "--json");
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: false, refusal: expect.stringContaining("psdd take 7") });
  });
});
