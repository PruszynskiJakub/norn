import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

function stuckStory() {
  const w = setup();
  const gh = w.github;
  gh.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
  gh.seedIssue({ number: 127, title: "Redis store", state: "closed", labels: ["type:slice", "mode:afk"] });
  gh.seedIssue({ number: 129, title: "Dashboard", labels: ["type:slice", "mode:hil", "needs-qa", "needs-human"] });
  gh.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "changes-requested", "needs-human"] });
  for (const s of [127, 129, 131]) gh.parents.set(s, 123);
  gh.commentsByIssue.set(129, ["psdd: needs-review → needs-qa (approve)\n\npsdd: needs-human — QA in mode:hil"]);
  gh.commentsByIssue.set(131, [
    'psdd: needs-review → changes-requested (request-changes)\n\npsdd: needs-human — escalated: "Redis client times out in tests" (3 fix rounds reached)',
  ]);
  return w;
}

describe("psdd next when nothing is left", () => {
  test("says so explicitly, as in the PRD", async () => {
    const w = stuckStory();

    const res = await w.psdd("next", "123");

    expect(res.stdout).toBe(
      [
        'Story #123 "Rate limiting": nothing left that you can do.',
        "Waiting for a human:",
        "  - #129 QA in mode:hil.",
        '  - #131 escalated: "Redis client times out in tests" (3 fix rounds reached).',
        "Stop here and report to the user. psdd has already notified them.",
      ].join("\n"),
    );
  });

  test("items blocked behind the human ones are listed after them", async () => {
    const w = stuckStory();
    w.github.seedIssue({ number: 132, title: "Docs", labels: ["type:slice", "mode:afk", "blocked"] });
    w.github.parents.set(132, 123);
    w.github.blockers.set(132, [131]);

    const res = await w.psdd("next", "123");

    expect(res.stdout).toContain("Blocked until then:\n  - #132 is blocked by #131.");
  });

  test("an item held by another session means work is still running, so it is not the end", async () => {
    const w = stuckStory();
    w.github.seedIssue({ number: 133, title: "Metrics", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    w.github.parents.set(133, 123);
    await w.as("worker")("take", "133");

    const res = await w.psdd("next", "123");

    expect(res.stdout).not.toContain("nothing left");
    expect(res.stdout).toContain("Nothing can be started now. Wait for the running items to finish, then run psdd next 123 again.");
    expect(res.stdout).toContain("  - #131 needs a human: escalated");
  });

  test("the story reaching story QA ends delivery", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-qa", "needs-human"] });
    w.github.commentsByIssue.set(123, ["psdd: needs-human — story QA"]);
    const res = await w.psdd("next", "123");
    expect(res.stdout).toContain("nothing left that you can do");
    expect(res.stdout).toContain("  - #123 story QA.");
  });

  test("--json flags the end", async () => {
    const w = stuckStory();
    const report = JSON.parse((await w.psdd("next", "123", "--json")).stdout);
    expect(report.nothingLeft).toBe(true);
    expect(report.waiting[1]).toMatchObject({ issue: 131, reason: "needs-human", detail: 'escalated: "Redis client times out in tests" (3 fix rounds reached)' });
  });
});
