import { describe, expect, test } from "vitest";
import type { ClaimRecord } from "@norn/core";
import { setup } from "@norn/testing";

const TEN_MINUTES = 10 * 60_000;

/**
 * Epic #1 in implementation under herdr: the orchestrator delivers it from pane w3T:p1, and slice #3 is held by the
 * merge agent norn-3-merge in pane w3Y:p2 of this machine. #2 is held by another agent that is at work.
 */
async function delivering(claim: Partial<ClaimRecord> = {}) {
  const w = setup({ now: "2026-10-17T16:15:00Z" });
  const gh = w.github;
  gh.seedIssue({ number: 1, title: "Todo app", labels: ["type:story", "implementation"], assignees: ["alice"] });
  gh.seedIssue({ number: 2, title: "Add a task", labels: ["type:slice", "mode:afk", "implementation", "in-progress"] });
  gh.seedIssue({ number: 3, title: "List tasks", labels: ["type:slice", "mode:afk", "merge-queue", "in-progress"] });
  for (const s of [2, 3]) gh.parents.set(s, 1);
  gh.branches.add("1-todo-app");
  w.workspace.env = { HERDR_ENV: "1", HERDR_PANE_ID: "w3T:p1" };
  w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ nornVersion: "1.4.2" }));
  const since = "2026-10-17T16:10:00Z";
  gh.claims.set(2, { holder: "alice", session: "agent-2", since, pane: { id: "w3X:p1", machine: "laptop" } });
  gh.claims.set(3, { holder: "alice", session: "agent-3", since, pane: { id: "w3Y:p2", machine: "laptop" }, ...claim });
  w.workspace.activities.set("w3X:p1", { activity: "working", forMs: TEN_MINUTES * 3 });
  await w.norn("deliver", "1");
  await w.norn("next", "1");
  return w;
}

describe("norn wait escalates an item whose agent stopped while holding it", () => {
  test("an agent idle for longer than deliver.stuckAfter: needs-human with its pane, the claim deleted, the user notified, and the wait carries on", async () => {
    const w = await delivering();
    w.workspace.activities.set("w3Y:p2", { activity: "idle", forMs: TEN_MINUTES + 1 });

    const res = await w.norn("wait", "1", "--timeout", "5m");

    expect(w.github.labels(3)).toContain("needs-human");
    expect(w.github.labels(3)).not.toContain("in-progress");
    expect(w.github.comments(3).at(-1)).toBe("norn: needs-human — agent in pane w3Y:p2 stopped while holding the claim");
    expect(w.github.claim(3)).toBeNull();
    expect(w.notifications.map((n) => [n.title, n.body.split("\n")[0]])).toEqual([
      ["norn: #3 needs you", "agent in pane w3Y:p2 stopped while holding the claim"],
    ]);
    expect(res.exitCode).toBe(4);
    expect(res.stdout.split("\n")).toEqual([
      "norn escalated #3: agent in pane w3Y:p2 stopped while holding the claim. A person picks it up; the user is notified.",
      "Nothing new to start on story #1 yet. Run norn wait 1 again.",
    ]);
    expect(w.github.claim(2)?.session).toBe("agent-2");
  });

  test("an agent waiting at a permission prompt is escalated saying so", async () => {
    const w = await delivering();
    w.workspace.activities.set("w3Y:p2", { activity: "blocked", forMs: TEN_MINUTES + 1 });

    await w.norn("wait", "1", "--timeout", "1m");

    expect(w.github.comments(3).at(-1)).toBe("norn: needs-human — agent in pane w3Y:p2 is waiting at a permission prompt");
  });

  test.each(["done", "gone"] as const)("an agent %s for longer than deliver.stuckAfter is escalated too", async (activity) => {
    const w = await delivering();
    w.workspace.activities.set("w3Y:p2", { activity, forMs: TEN_MINUTES + 1 });

    await w.norn("wait", "1", "--timeout", "1m");

    expect(w.github.labels(3)).toContain("needs-human");
  });

  test("deliver.stuckAfter sets how long an agent may sit", async () => {
    const w = await delivering();
    w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ nornVersion: "1.4.2", deliver: { stuckAfter: "30m" } }));
    w.workspace.activities.set("w3Y:p2", { activity: "idle", forMs: TEN_MINUTES + 1 });

    await w.norn("wait", "1", "--timeout", "1m");

    expect(w.github.labels(3)).not.toContain("needs-human");
  });

  test("an agent at work, or idle for less than deliver.stuckAfter, is left alone", async () => {
    const w = await delivering();
    w.workspace.activities.set("w3Y:p2", { activity: "idle", forMs: TEN_MINUTES - 1 });

    await w.norn("wait", "1", "--timeout", "1m");

    expect(w.github.labels(3)).not.toContain("needs-human");
    expect(w.github.claim(3)?.session).toBe("agent-3");
  });

  test.each([
    ["a teammate's claim", { holder: "bob" }],
    ["a pane on another machine", { pane: { id: "w3Y:p2", machine: "desktop" } }],
    ["a session in no herdr pane", { pane: undefined }],
  ])("%s is never escalated: norn cannot observe it", async (_, claim) => {
    const w = await delivering(claim);
    w.workspace.activities.set("w3Y:p2", { activity: "idle", forMs: TEN_MINUTES * 6 });

    await w.norn("wait", "1", "--timeout", "1m");

    expect(w.github.labels(3)).not.toContain("needs-human");
    expect(w.github.claim(3)).not.toBeNull();
  });

  test("a stuck item norn escalated shows in --json with its pane", async () => {
    const w = await delivering();
    w.workspace.activities.set("w3Y:p2", { activity: "idle", forMs: TEN_MINUTES + 1 });

    const json = JSON.parse((await w.norn("wait", "1", "--timeout", "1m", "--json")).stdout);

    expect(json.escalated).toEqual([{ issue: 3, pane: "w3Y:p2", activity: "idle", reason: "agent in pane w3Y:p2 stopped while holding the claim" }]);
  });
});
