import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

/** Story #1 in implementation with two ready slices, #2 and #3, under herdr in pane w3T:p1. */
function epic() {
  const w = setup({ now: "2026-10-17T16:15:00Z" });
  const gh = w.github;
  gh.seedIssue({ number: 1, title: "Todo app", labels: ["type:story", "implementation"], assignees: ["alice"] });
  gh.seedIssue({ number: 2, title: "Add a task", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
  gh.seedIssue({ number: 3, title: "List tasks", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
  for (const s of [2, 3]) gh.parents.set(s, 1);
  gh.branches.add("1-todo-app");
  w.workspace.env = { HERDR_ENV: "1", HERDR_PANE_ID: "w3T:p1" };
  return w;
}

describe("norn deliver", () => {
  test("takes the story's delivery lock, naming the session's pane, and prints the loop to follow", async () => {
    const w = epic();

    const res = await w.norn("deliver", "1");

    expect(res.exitCode).toBe(0);
    expect(w.github.delivery(1)).toEqual({
      holder: "alice",
      session: "session-1",
      since: "2026-10-17T16:15:00.000Z",
      pane: { id: "w3T:p1", machine: "laptop" },
    });
    expect(res.stdout).toContain('You now deliver story #1 "Todo app". No other session can deliver it while you do.');
    expect(res.stdout).toContain("  1. norn tidy");
    expect(res.stdout).toContain("  2. norn next 1: start one fresh agent per item it lists, as it says. Start none of your own.");
    expect(res.stdout).toContain("  3. norn wait 1, in the background, and act on its exit code when it ends:");
    expect(res.stdout).toContain("norn wait does the waiting: never write a monitor, script or sleep loop around norn, and never match its text.");
    expect(res.stdout).toContain("If you stop delivering before norn wait exits 3, run: norn deliver 1 --stop");
    expect(w.github.claims.size).toBe(0);
  });

  test("a second orchestrator is refused, told who delivers the story and since when", async () => {
    const w = epic();
    await w.norn("deliver", "1");
    w.setNow("2026-10-17T16:40:00Z");

    const res = await w.as("session-2")("deliver", "1");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe(
      [
        "Story #1 is being delivered by session herdr:w3T:p1 since 16:15. Do not start another delivery.",
        "If that session has stopped, take its delivery over with: norn deliver 1 --takeover",
      ].join("\n"),
    );
    expect(w.github.delivery(1)?.session).toBe("session-1");
  });

  test("a teammate's delivery is refused with no takeover offered, and --takeover does not take it", async () => {
    const w = epic();
    await w.asTeammate("bob", "bob-1")("deliver", "1");

    const res = await w.norn("deliver", "1", "--takeover");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain("--takeover");
    expect(w.github.delivery(1)?.holder).toBe("bob");
  });

  test("the same session running it again refreshes its lock", async () => {
    const w = epic();
    await w.norn("deliver", "1");
    w.setNow("2026-10-17T16:30:00Z");

    const res = await w.norn("deliver", "1");

    expect(res.stdout).toContain("You already deliver story #1; the delivery lock is refreshed.");
    expect(w.github.delivery(1)?.since).toBe("2026-10-17T16:30:00.000Z");
  });

  test("the lock goes stale like a claim, after claims.staleAfter, and is then taken over", async () => {
    const w = epic();
    await w.as("crashed")("deliver", "1");
    w.setNow("2026-10-17T18:16:00Z");

    const res = await w.norn("deliver", "1");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("You took the delivery over from session herdr:w3T:p1 (since 16:15).");
    expect(w.github.delivery(1)?.session).toBe("session-1");
  });

  test("--takeover takes the user's own lock at any age", async () => {
    const w = epic();
    await w.as("crashed")("deliver", "1");

    const res = await w.norn("deliver", "1", "--takeover");

    expect(res.exitCode).toBe(0);
    expect(w.github.delivery(1)?.session).toBe("session-1");
  });

  test("--stop releases this session's lock at any time; with none it says so", async () => {
    const w = epic();
    await w.norn("deliver", "1");

    const res = await w.norn("deliver", "1", "--stop");

    expect(res.stdout).toBe("Stopped delivering story #1: its delivery lock is released, and another session may deliver it.");
    expect(w.github.delivery(1)).toBeNull();
    expect((await w.norn("deliver", "1", "--stop")).stdout).toBe("Nobody delivers story #1: there was no delivery lock to release.");
  });

  test("--stop does not release another session's live lock, unless it is the user's own and --takeover says it stopped", async () => {
    const w = epic();
    await w.as("session-2")("deliver", "1");

    expect((await w.norn("deliver", "1", "--stop")).exitCode).toBe(1);
    expect(w.github.delivery(1)).not.toBeNull();
    expect((await w.norn("deliver", "1", "--stop", "--takeover")).exitCode).toBe(0);
    expect(w.github.delivery(1)).toBeNull();
  });

  test("a slice is refused: its story is delivered", async () => {
    const w = epic();

    const res = await w.norn("deliver", "2");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("#2 is a slice of #1. Run norn next 1 instead.");
  });

  test("--json gives the story and whether the lock was refreshed or taken over", async () => {
    const w = epic();

    const json = JSON.parse((await w.norn("deliver", "1", "--json")).stdout);

    expect(json).toMatchObject({ ok: true, story: 1, reacquired: false, tookOver: null });
  });
});

describe("a story being delivered", () => {
  test("norn next says so, by which session and since when", async () => {
    const w = epic();
    await w.as("session-2")("deliver", "1");

    const out = (await w.norn("next", "1")).stdout;

    expect(out).toContain("Story #1 is being delivered by another session of yours, herdr:w3T:p1, since 16:15. Do not start another delivery.");
  });

  test("norn status says so too, and its --json carries it", async () => {
    const w = epic();
    await w.asTeammate("bob", "bob-1")("deliver", "1");

    expect((await w.norn("status", "1")).stdout).toContain("Story #1 is being delivered by another session, herdr:w3T:p1, since 16:15.");
    expect(JSON.parse((await w.norn("status", "1", "--json")).stdout).delivery).toEqual({
      session: "other",
      mine: false,
      who: "herdr:w3T:p1",
      since: "2026-10-17T16:15:00.000Z",
    });
  });

  test("the orchestrator's norn next records on the lock what it offered, so norn wait wakes only for what is new", async () => {
    const w = epic();
    await w.norn("deliver", "1");
    w.setNow("2026-10-17T16:16:00Z");

    const out = (await w.norn("next", "1")).stdout;

    expect(out).toContain("Story #1 is being delivered by this session since 16:15.");
    expect(w.github.delivery(1)?.offered).toEqual({
      at: "2026-10-17T16:16:00.000Z",
      items: [
        { issue: 2, state: "ready-for-agent" },
        { issue: 3, state: "ready-for-agent" },
      ],
    });
  });

  test("another session's norn next records nothing on the lock", async () => {
    const w = epic();
    await w.as("session-2")("deliver", "1");

    await w.norn("next", "1");

    expect(w.github.delivery(1)?.offered).toBeUndefined();
  });

  test("finishing slicing offers no second delivery of a story already being delivered", async () => {
    const w = setup();
    w.github.seedIssue({ number: 50, title: "Search", labels: ["type:story", "needs-slicing"], assignees: ["alice"] });
    await w.norn("take", "50");
    await w.norn("add-slice", "50", "Index", "--mode", "afk");
    await w.as("orchestrator")("deliver", "50");

    const out = (await w.norn("done", "50")).stdout;

    expect(out).not.toContain("norn-deliver 50");
  });
});
