import { describe, expect, test } from "vitest";
import { setup } from "@psdd/testing";

function stuckStory() {
  const w = setup();
  const gh = w.github;
  gh.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
  gh.seedIssue({ number: 127, title: "Redis store", state: "closed", labels: ["type:slice", "mode:afk"] });
  gh.seedIssue({ number: 129, title: "Dashboard", labels: ["type:slice", "mode:hil", "needs-human-qa"] });
  gh.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "changes-requested", "needs-human"] });
  for (const s of [127, 129, 131]) gh.parents.set(s, 123);
  gh.branches.add("123-rate-limiting");
  gh.commentsByIssue.set(129, ["psdd: needs-qa → needs-human-qa (pass)"]);
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
        "  - #129 needs human QA (mode:hil).",
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

  test("the story reaching QA by a person ends delivery", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-human-qa"] });
    const res = await w.psdd("next", "123");
    expect(res.stdout).toContain("nothing left that you can do");
    expect(res.stdout).toContain("  - #123 needs human QA (story).");
  });

  test("the story in agent QA is started like any unattended step", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-qa"] });
    const res = await w.psdd("next", "123");
    expect(res.stdout).toContain('  - Story #123 "Rate limiting" needs QA by an agent.');
    expect(res.stdout).not.toContain("attended");
  });

  test("--json flags the end", async () => {
    const w = stuckStory();
    const report = JSON.parse((await w.psdd("next", "123", "--json")).stdout);
    expect(report.nothingLeft).toBe(true);
    expect(report.waiting[1]).toMatchObject({
      issue: 131,
      reason: "needs-human",
      detail: 'escalated: "Redis client times out in tests" (3 fix rounds reached)',
    });
  });
});

describe("psdd next on a closed story", () => {
  test("ends delivery without telling anyone to wait, and notifies no one", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", state: "closed", stateReason: "completed", labels: ["type:story", "merge-queue"] });

    const res = await w.psdd("next", "123");

    expect(res.stdout).toBe('Story #123 "Rate limiting" is closed. Nothing left that you can do.');
    expect(w.notifications).toEqual([]);
    const json = JSON.parse((await w.psdd("next", "123", "--json")).stdout);
    expect(json).toMatchObject({ closed: true, nothingLeft: true });
  });

  test("a story closed as not planned says so", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", state: "closed", stateReason: "not_planned", labels: ["type:story"] });

    const res = await w.psdd("next", "123");

    expect(res.stdout).toBe('Story #123 "Rate limiting" is closed as not planned. Nothing left that you can do.');
  });
});

describe("psdd next with notifications turned off", () => {
  test("does not claim the user was notified", async () => {
    const w = stuckStory();
    w.workspace.files.set(".agents/psdd.config.local.json", JSON.stringify({ notifications: "none" }));

    const res = await w.psdd("next", "123");

    expect(res.stdout).toContain("Stop here and report to the user.");
    expect(res.stdout).not.toContain("notified");
    expect(w.notifications).toEqual([]);
  });
});

describe("psdd next when only a person's work is left", () => {
  test("says a person is on it, and does not notify them about it", async () => {
    const w = stuckStory();
    w.github.issues.get(131)!.state = "closed";
    w.setNow("2026-10-13T14:02:00Z");
    await w.as("drive")("take", "129");

    const res = await w.as("orchestrator")("next", "123");

    expect(res.stdout).toBe(
      [
        'Story #123 "Rate limiting": nothing left that you can do.',
        "Waiting for a human:",
        "  - #129 needs human QA (mode:hil), held by another session of yours (since 14:02).",
        "Stop here and report to the user.",
      ].join("\n"),
    );
    expect(w.notifications).toEqual([]);
    expect(JSON.parse((await w.as("orchestrator")("next", "123", "--json")).stdout)).toMatchObject({ nothingLeft: true, notified: false });
  });

  test("still notifies about the items no one holds", async () => {
    const w = stuckStory();
    await w.as("drive")("take", "129");

    await w.as("orchestrator")("next", "123");

    expect(w.notifications.map((n) => n.body)).toEqual(['#131 escalated: "Redis client times out in tests" (3 fix rounds reached)']);
  });
});
