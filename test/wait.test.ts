import { describe, expect, test } from "vitest";
import { MAX_CHECK_MS, MIN_CHECK_MS, type NextReport, wakeOf } from "@norn/core";
import { setup } from "@norn/testing";

type World = ReturnType<typeof setup>;

/**
 * Epic #1 in implementation: #2 and #3 ready, #4 blocked by #2, under plain git. The orchestrator ran norn deliver and
 * norn next, and an agent took each of #2 and #3.
 */
async function delivering(config: Record<string, unknown> = {}) {
  const w = setup({ now: "2026-10-17T16:15:00Z" });
  const gh = w.github;
  gh.seedIssue({ number: 1, title: "Todo app", labels: ["type:story", "implementation"], assignees: ["alice"] });
  gh.seedIssue({ number: 2, title: "Add a task", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
  gh.seedIssue({ number: 3, title: "List tasks", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
  gh.seedIssue({ number: 4, title: "Done tasks", labels: ["type:slice", "mode:afk", "blocked"] });
  for (const s of [2, 3, 4]) gh.parents.set(s, 1);
  gh.blockers.set(4, [2]);
  gh.branches.add("1-todo-app");
  w.workspace.env = {};
  w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ nornVersion: "1.4.2", ...config }));
  await w.norn("deliver", "1");
  await w.norn("next", "1");
  await w.as("agent-2")("take", "2");
  await w.as("agent-3")("take", "3");
  return w;
}

/** An item norn next offered whose agent has not taken it yet: still in the state it was offered in, with no claim. */
function notTakenYet(w: World, n: number) {
  w.github.claims.delete(n);
  w.github.issues.get(n)!.labels = ["type:slice", "mode:afk", "ready-for-agent"];
}

/** An agent finishing its slice the way norn records it: its PR merged and the slice closed. */
async function merged(w: World, n: number) {
  w.github.prs.push({ number: 100 + n, head: `1-todo-app-${n}`, base: "1-todo-app", state: "merged" });
  w.github.issues.get(n)!.labels = ["type:slice", "mode:afk", "merge-queue"];
  w.github.claims.delete(n);
  await w.as(`merger-${n}`)("take", String(n));
  await w.as(`merger-${n}`)("done", String(n));
}

describe("norn wait", () => {
  test("stays silent while the running items run, and wakes when one is merged and a new item is ready", async () => {
    const w = await delivering();
    w.whileSleeping = async (slept) => {
      if (slept === 3) await merged(w, 2);
    };

    const res = await w.norn("wait", "1");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("#4 is ready for an agent (1 slot free). Run: norn next 1");
    expect(w.sleeps.length).toBe(3);
    expect(w.github.labels(4)).toContain("ready-for-agent");
  });

  test("wakes at once on a condition that holds already: a change before the wait started is not missed", async () => {
    const w = await delivering();
    await merged(w, 2);

    const res = await w.norn("wait", "1");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("#4 is ready for an agent (1 slot free). Run: norn next 1");
    expect(w.sleeps).toEqual([]);
  });

  test("stays asleep when an agent finishes but nothing new can start, and wakes once its next step can", async () => {
    const w = await delivering({ deliver: { maxParallel: 1 } });
    // Only #2 runs: #3 waits for the one slot. The implement step of #2 ends while #3's agent takes the slot.
    w.github.claims.delete(3);
    w.whileSleeping = async (slept) => {
      if (slept === 1) {
        w.github.prs.push({ number: 102, head: "1-todo-app-2", base: "1-todo-app", state: "open" });
        await w.as("agent-2")("done", "2");
        await w.as("agent-3")("take", "3");
      }
      if (slept === 4) await w.as("agent-3")("release", "3");
    };

    const res = await w.norn("wait", "1");

    expect(res.exitCode).toBe(0);
    expect(w.sleeps.length).toBe(4);
    expect(res.stdout).toBe("#2, #3 are ready for agents (1 slot free). Run: norn next 1");
  });

  test("an item the last norn next offered, still waiting for its agent, is no reason to wake", async () => {
    const w = await delivering();
    notTakenYet(w, 3);
    w.whileSleeping = async (slept) => {
      if (slept === 2) await w.as("agent-3")("take", "3");
      if (slept === 4) await merged(w, 2);
    };

    const res = await w.norn("wait", "1");

    expect(res.stdout).toBe("#4 is ready for an agent (1 slot free). Run: norn next 1");
    expect(w.sleeps.length).toBe(4);
  });

  test("an offered item no agent took within deliver.stuckAfter wakes the orchestrator to start it again", async () => {
    const w = await delivering({ deliver: { stuckAfter: "5m" } });
    notTakenYet(w, 3);

    const res = await w.norn("wait", "1");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("#3 is ready for an agent (1 slot free). Run: norn next 1");
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThan(5 * 60_000);
  });

  test("exits 3 when nothing is left that the orchestrator can do, releasing the delivery lock and notifying nobody", async () => {
    const w = await delivering();
    w.whileSleeping = async (slept) => {
      if (slept !== 1) return;
      for (const n of [2, 3, 4]) {
        w.github.claims.delete(n);
        w.github.issues.get(n)!.labels = ["type:slice", "mode:hil", "needs-human-qa"];
      }
    };

    const res = await w.norn("wait", "1");

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe(
      "Nothing left you can do: #2 needs human QA (mode:hil); #3 needs human QA (mode:hil); #4 needs human QA (mode:hil). Run norn next 1 for the report.",
    );
    expect(w.github.delivery(1)).toBeNull();
    expect(w.notifications).toEqual([]);
  });

  test("exits 3 on a closed story", async () => {
    const w = await delivering();
    w.github.issues.get(1)!.state = "closed";

    const res = await w.norn("wait", "1");

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("Story #1 is closed. Run norn next 1 for the report.");
  });

  test("gives up after --timeout, 30m by default, with exit 4 and the lock kept", async () => {
    const w = await delivering();

    const res = await w.norn("wait", "1");

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("Nothing new to start on story #1 yet. Run norn wait 1 again.");
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBe(30 * 60_000);
    expect(w.github.delivery(1)?.session).toBe("session-1");

    const short = await w.norn("wait", "1", "--timeout", "5m");
    expect(short.exitCode).toBe(4);
  });

  test("a --timeout that is not a duration is a usage error", async () => {
    const w = await delivering();

    const res = await w.norn("wait", "1", "--timeout", "soon");

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("--timeout soon is not a duration. Give one like 30m or 1h: norn wait <story> --timeout 30m");
  });

  test("checks every 30s, slowing to every 2m while nothing changes, and works out norn next only on a change", async () => {
    const w = await delivering();
    // Reads of the story's sub-issues by norn wait itself, not by the agents' commands while it sleeps.
    let reads = 0;
    let first = 0;
    let asleep = false;
    const subIssues = w.github.subIssues.bind(w.github);
    w.github.subIssues = async (parent) => {
      if (!asleep) reads++;
      return subIssues(parent);
    };
    w.whileSleeping = async (slept) => {
      if (slept === 1) first = reads;
      asleep = true;
      if (slept === 5) await w.as("agent-3")("take", "3");
      if (slept === 7) await merged(w, 2);
      asleep = false;
    };

    await w.norn("wait", "1");

    expect(w.sleeps).toEqual([MIN_CHECK_MS, 60_000, MAX_CHECK_MS, MAX_CHECK_MS, MAX_CHECK_MS, MIN_CHECK_MS, 60_000]);
    // norn next is worked out on start, once the claim was refreshed and once the merge landed: never when nothing changed.
    expect(reads).toBe(3 * first);
    expect(w.github.stamped).toBeGreaterThanOrEqual(w.sleeps.length);
  });

  test("refreshes the delivery lock while it waits, keeping what norn next offered", async () => {
    const w = await delivering();
    const offered = w.github.delivery(1)?.offered;

    await w.norn("wait", "1", "--timeout", "20m");

    expect(w.github.delivery(1)?.since).not.toBe("2026-10-17T16:15:00.000Z");
    expect(w.github.delivery(1)?.offered).toEqual(offered);
  });

  test("refuses with exit 2 while another session delivers the story", async () => {
    const w = await delivering();

    const res = await w.as("session-2")("wait", "1");

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe(
      [
        "Story #1 is being delivered by session session-1 since 16:15. Do not start another delivery.",
        "If that session has stopped, take its delivery over with: norn deliver 1 --takeover",
      ].join("\n"),
    );
  });

  test("--json gives the wake, the new items and the next report", async () => {
    const w = await delivering();
    await merged(w, 2);

    const json = JSON.parse((await w.norn("wait", "1", "--json")).stdout);

    expect(json).toMatchObject({ ok: true, story: 1, wake: "start", escalated: [] });
    expect(json.items.map((i: { issue: number }) => i.issue)).toEqual([4]);
    expect(json.next).toMatchObject({ issue: 1, slots: 1, nothingLeft: false });
    expect(json.message).toBe("#4 is ready for an agent (1 slot free). Run: norn next 1");
  });
});

/** A next report with only what the wake condition reads. */
function report(over: Partial<NextReport>): NextReport {
  return {
    issue: 1,
    flow: "story",
    provider: "git",
    maxParallel: 2,
    title: "Todo app",
    state: "implementation",
    branch: "1-todo-app",
    slices: { total: 3, merged: 0 },
    notes: [],
    nothingLeft: false,
    closed: false,
    notPlanned: false,
    notified: false,
    running: 0,
    slots: 2,
    start: [],
    waiting: [],
    delivery: null,
    ...over,
  };
}

const item = (issue: number, state: string, attended = false) =>
  ({
    issue,
    state,
    attended,
    kind: "slice",
    flow: "slice",
    title: "t",
    description: null,
    step: "s",
    skill: "k",
    command: "",
    branch: null,
    worktree: null,
    createWorktree: null,
    checkedOutAt: null,
    here: false,
    session: null,
  }) as const;
const running = { issue: 9, reason: "held", holder: { session: "yours", mine: true, since: "2026-10-17T16:00:00Z" } } as const;
const now = new Date("2026-10-17T16:20:00Z");

describe("the wake condition", () => {
  test("a startable item the last norn next did not offer wakes; one it offered in the same state does not", () => {
    const offered = { at: "2026-10-17T16:15:00Z", items: [{ issue: 2, state: "ready-for-agent" }] };
    const r = report({ start: [item(2, "ready-for-agent"), item(4, "ready-for-agent")], waiting: [running] });

    expect(wakeOf(r, offered, now, 600_000)).toEqual({ kind: "start", items: [item(4, "ready-for-agent")] });
    expect(wakeOf(report({ start: [item(2, "ready-for-agent")], waiting: [running] }), offered, now, 600_000)).toEqual({ kind: "wait" });
  });

  test("an offered item in a new state is new", () => {
    const offered = { at: "2026-10-17T16:15:00Z", items: [{ issue: 2, state: "ready-for-agent" }] };
    expect(wakeOf(report({ start: [item(2, "needs-review")], waiting: [running] }), offered, now, 600_000).kind).toBe("start");
  });

  test("no slot free: wait", () => {
    expect(wakeOf(report({ start: [item(4, "ready-for-agent")], waiting: [running], slots: 0 }), null, now, 600_000)).toEqual({ kind: "wait" });
  });

  test("nothing left, a closed story, or only attended steps with nothing running: stop", () => {
    expect(wakeOf(report({ nothingLeft: true }), null, now, 600_000)).toEqual({ kind: "stop" });
    expect(wakeOf(report({ closed: true, nothingLeft: true }), null, now, 600_000)).toEqual({ kind: "stop" });
    expect(wakeOf(report({ start: [item(4, "needs-slicing", true)] }), null, now, 600_000)).toEqual({ kind: "stop" });
  });

  test("an item offered longer ago than the grace and still not taken wakes again", () => {
    const offered = { at: "2026-10-17T16:00:00Z", items: [{ issue: 2, state: "ready-for-agent" }] };
    expect(wakeOf(report({ start: [item(2, "ready-for-agent")] }), offered, now, 600_000).kind).toBe("start");
  });
});
