import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

const LOCAL = ".agents/psdd.config.local.json";

function slice(labels: string[]) {
  const w = setup();
  w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
  w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", ...labels] });
  w.github.parents.set(131, 123);
  return w;
}

describe("notifications", () => {
  test("an escalation notifies who must act on what, with the reason and the issue link", async () => {
    const w = slice(["mode:afk", "ready-for-agent"]);
    await w.psdd("take", "131");

    await w.psdd("escalate", "131", "Redis is not available in CI");

    expect(w.notifications).toEqual([
      {
        channel: "os",
        title: "psdd: #131 needs you",
        body: 'escalated: "Redis is not available in CI"\nhttps://github.com/acme/app/issues/131',
      },
    ]);
  });

  test("a mode:hil slice reaching QA notifies", async () => {
    const w = slice(["mode:hil", "needs-review"]);
    await w.psdd("take", "131");
    await w.psdd("done", "131", "approve");
    expect(w.notifications.map((n) => [n.title, n.body.split("\n")[0]])).toEqual([["psdd: #131 needs you", "QA in mode:hil"]]);
  });

  test("a story reaching story QA notifies", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-review"] });
    await w.psdd("take", "123");
    await w.psdd("done", "123", "approve");
    expect(w.notifications.map((n) => n.title)).toEqual(["psdd: #123 needs you"]);
  });

  test("an ordinary transition does not notify", async () => {
    const w = slice(["mode:afk", "needs-review"]);
    await w.psdd("take", "131");
    await w.psdd("done", "131", "approve");
    expect(w.notifications).toEqual([]);
  });

  test("when next finds nothing left, it notifies with what is waiting", async () => {
    const w = slice(["mode:hil", "needs-qa", "needs-human"]);
    w.github.commentsByIssue.set(131, ["psdd: needs-human — QA in mode:hil"]);

    await w.psdd("next", "123");

    expect(w.notifications).toEqual([
      { channel: "os", title: "psdd: story #123 is waiting for you", body: "#131 QA in mode:hil" },
    ]);
  });

  test("auto uses herdr inside herdr", async () => {
    const w = slice(["mode:afk", "ready-for-agent"]);
    w.workspace.env = { HERDR_ENV: "1" };
    await w.psdd("take", "131");
    await w.psdd("escalate", "131", "why");
    expect(w.notifications[0].channel).toBe("herdr");
  });

  test("none turns them off; the label and comment remain", async () => {
    const w = slice(["mode:afk", "ready-for-agent"]);
    w.workspace.files.set(LOCAL, JSON.stringify({ notifications: "none" }));
    await w.psdd("take", "131");
    await w.psdd("escalate", "131", "why");
    expect(w.notifications).toEqual([]);
    expect(w.github.labels(131)).toContain("needs-human");
  });

  test("a failing notifier does not fail the command", async () => {
    const w = slice(["mode:afk", "ready-for-agent"]);
    await w.psdd("take", "131");
    const res = await w.withNotify(async () => {
      throw new Error("no display");
    })("escalate", "131", "why");
    expect(res.exitCode).toBe(0);
    expect(w.github.labels(131)).toContain("needs-human");
  });

  test("notifications are chosen per developer, so the team file cannot set them", async () => {
    const w = slice(["mode:afk", "ready-for-agent"]);
    w.workspace.files.set(".agents/psdd.config.json", JSON.stringify({ notifications: "os" }));
    const res = await w.psdd("take", "131");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(`notifications is set per developer in ${LOCAL}`);
  });
});
