import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

const WORKTREE = "/repo/.agents/worktrees/123-rate-limiting-131";

/**
 * Story #123 with slice #131, whose agent asked a person at 12:10 and waits, and slice #132,
 * escalated the plain way. `herdr` runs every command under herdr.
 */
async function story(opts: { herdr?: boolean } = {}) {
  const w = setup();
  if (opts.herdr) w.workspace.env = { HERDR_ENV: "1" };
  w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
  w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
  w.github.seedIssue({ number: 132, title: "Docs", labels: ["type:slice", "mode:afk", "needs-human", "implementation"] });
  w.github.commentsByIssue.set(132, ['norn: needs-human — escalated: "Redis is not available in CI"']);
  for (const s of [131, 132]) w.github.parents.set(s, 123);
  w.github.branches.add("123-rate-limiting");
  w.setNow("2026-10-13T12:00:00Z");
  await w.as("agent-131")("take", "131");
  w.setNow("2026-10-13T12:10:00Z");
  await w.as("agent-131")("escalate", "131", "Keep the old flag\nas an alias?", "--wait");
  w.setNow("2026-10-13T12:35:00Z");
  return w;
}

describe("norn next lists what agents ask", () => {
  test("first and apart from other needs-human items, with the full question, how long it waited and the worktree", async () => {
    const w = await story();
    w.github.seedIssue({ number: 133, title: "Metrics", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    w.github.parents.set(133, 123);

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain("norn take 133");
    const lines = res.stdout.split("\n");
    const asks = lines.indexOf("Agents wait on your answer:");
    expect(asks).toBeGreaterThan(-1);
    expect(lines[asks + 1]).toBe(
      `  - #131 waits on you, an agent asked (25m): Keep the old flag as an alias? — worktree ${WORKTREE}. Answer it in the agent's session; do not take it.`,
    );
    expect(lines.findIndex((l) => l.includes("#132 needs a human"))).toBeGreaterThan(asks + 1);
  });

  test("under herdr, with the command that focuses the agent", async () => {
    const w = await story({ herdr: true });

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain(`— worktree ${WORKTREE}, herdr agent focus norn-131.`);
  });

  test("--json gives reason agent-asks, first, with the question, since when and where to reach the agent", async () => {
    const w = await story({ herdr: true });

    const data = JSON.parse((await w.norn("next", "123", "--json")).stdout);

    expect(data.waiting[0]).toMatchObject({
      issue: 131,
      reason: "agent-asks",
      question: "Keep the old flag\nas an alias?",
      since: "2026-10-13T12:10:00.000Z",
      waitedMs: 25 * 60_000,
      worktree: WORKTREE,
      focus: "herdr agent focus norn-131",
    });
    expect(data.waiting[1]).toMatchObject({ issue: 132, reason: "needs-human" });
  });

  test("other providers give no focus command", async () => {
    const w = await story();
    const data = JSON.parse((await w.norn("next", "123", "--json")).stdout);
    expect(data.waiting[0]).toMatchObject({ reason: "agent-asks", worktree: WORKTREE, focus: null });
  });

  test("carries no take, resolve or hand-off command and is never free or stale, even past the stale limit", async () => {
    const w = await story({ herdr: true });
    w.setNow("2026-10-14T17:10:00Z");

    const res = await w.norn("next", "123");
    const data = JSON.parse((await w.norn("next", "123", "--json")).stdout);

    expect(res.stdout).toContain("an agent asked (1d 5h)");
    expect(res.stdout).not.toContain("norn take 131");
    expect(res.stdout).not.toContain("norn-drive 131");
    expect(res.stdout).not.toContain("herdr agent start norn-131");
    expect(res.stdout).not.toMatch(/#131 .*(stale|held by)/);
    expect(data.start.map((s: { issue: number }) => s.issue)).not.toContain(131);
    expect(data.waiting.filter((x: { issue: number }) => x.issue === 131)).toHaveLength(1);
  });

  test("nothing left: the agent's question comes first, before what waits for a human", async () => {
    const w = await story();

    const res = await w.norn("next", "123");

    expect(res.stdout.split("\n").slice(0, 3)).toEqual([
      'Story #123 "Rate limiting": nothing left that you can do.',
      "Agents wait on your answer:",
      `  - #131 waits on you, an agent asked (25m): Keep the old flag as an alias? — worktree ${WORKTREE}. Answer it in the agent's session; do not take it.`,
    ]);
  });

  test("once resumed, the item is held as any other", async () => {
    const w = await story();
    await w.as("agent-131")("resume", "131", "Yes");

    const data = JSON.parse((await w.norn("next", "123", "--json")).stdout);

    expect(data.waiting.find((x: { issue: number }) => x.issue === 131)).toMatchObject({ reason: "held" });
  });
});

describe("norn status lists what agents ask", () => {
  test("first, and the slice says an agent waits on your answer instead of needs-human", async () => {
    const w = await story({ herdr: true });

    const res = await w.norn("status", "123");

    expect(res.stdout.split("\n").slice(1, 3)).toEqual([
      "Agents wait on your answer:",
      `  - #131 waits on you, an agent asked (25m): Keep the old flag as an alias? — worktree ${WORKTREE}, herdr agent focus norn-131. Answer it in the agent's session; do not take it.`,
    ]);
    expect(res.stdout).toContain('#131 "Per-key limits"   implementation · mode:afk · an agent waits on your answer\n');
    expect(res.stdout).toContain("implementation · mode:afk · needs-human");
  });

  test("--json gives the asks with reason agent-asks and marks the row", async () => {
    const w = await story();
    w.setNow("2026-10-14T17:10:00Z");

    const data = JSON.parse((await w.norn("status", "123", "--json")).stdout);

    expect(data.asks).toEqual([expect.objectContaining({ issue: 131, reason: "agent-asks", question: "Keep the old flag\nas an alias?" })]);
    expect(data.slices.find((r: { number: number }) => r.number === 131)).toMatchObject({ agentAsks: true, stale: false });
  });
});

describe("notifications of what agents ask", () => {
  test("escalate --wait notifies with the question, how to reach the agent and the issue link", async () => {
    const w = await story({ herdr: true });

    expect(w.notifications.at(-1)).toEqual({
      channel: "herdr",
      title: "norn: an agent on #131 asks you",
      body: `Keep the old flag\nas an alias?\nAnswer in its session: worktree ${WORKTREE}, herdr agent focus norn-131\nhttps://github.com/acme/app/issues/131`,
    });
  });

  test("other providers give the worktree and no focus command", async () => {
    const w = await story();

    expect(w.notifications.at(-1)).toEqual({
      channel: "os",
      title: "norn: an agent on #131 asks you",
      body: `Keep the old flag\nas an alias?\nAnswer in its session: worktree ${WORKTREE}\nhttps://github.com/acme/app/issues/131`,
    });
  });

  test("delivery's story-waiting notification lists the question although a session holds the item", async () => {
    const w = await story();

    await w.norn("next", "123");

    expect(w.notifications.at(-1)).toEqual({
      channel: "os",
      title: "norn: story #123 is waiting for you",
      body: [
        `#131 waits on you, an agent asked (25m): Keep the old flag as an alias? — worktree ${WORKTREE}`,
        '#132 needs a human: escalated: "Redis is not available in CI"',
      ].join("\n"),
    });
  });
});
