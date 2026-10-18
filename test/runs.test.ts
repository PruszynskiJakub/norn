import { describe, expect, test } from "vitest";
import { abandonedAttempts, loadConfig, RUN_MARK, renewLease, settleRun } from "@norn/core";
import { setup } from "@norn/testing";

const TEAM = ".agents/norn.config.json";
const LOCAL = ".agents/norn.config.local.json";
const exited = (code: number) => ({ end: { kind: "exited" as const, code, signal: null }, minutes: 4 });
// A new issue: norn take claims it for triage, as a run's agent would any step.
const issue = { number: 131, title: "Per-key limits" };

/** A run's session whose agent has taken the issue. */
async function taken() {
  const w = setup({ session: "run-131-a" });
  w.github.seedIssue(issue);
  expect((await w.norn("take", "131")).exitCode).toBe(0);
  return { w, ctx: await w.ctx(), before: w.github.comments(131).length };
}

describe("settling a run's attempt from GitHub", () => {
  test("an agent that finished its step with norn done has finished", async () => {
    const { w, ctx, before } = await taken();
    expect((await w.norn("done", "131", "story")).exitCode).toBe(0);

    expect(await settleRun(ctx, 131, exited(0), before)).toEqual({ kind: "finished" });
  });

  test("an agent that escalated has finished its attempt: a person has the issue now", async () => {
    const { w, ctx, before } = await taken();
    await w.norn("escalate", "131", "only a person can decide");

    expect(await settleRun(ctx, 131, exited(0), before)).toEqual({ kind: "finished" });
  });

  test("labels norn take moved do not count as finished", async () => {
    const w = setup({ session: "run-131-a" });
    w.github.seedIssue({ number: 140, title: "Slice", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    w.github.seedIssue({ number: 123, title: "Story", labels: ["type:story", "implementation"] });
    w.github.parents.set(140, 123);
    w.github.branches.add("123-story");
    const labels = [...w.github.labels(140)];
    await w.norn("take", "140");
    expect(w.github.labels(140)).not.toEqual(labels);
    await w.norn("release", "140");

    expect(await settleRun(await w.ctx(), 140, exited(0), 0)).toMatchObject({ kind: "retry" });
  });

  test("an agent that ends holding the claim is retried, and the attempt is recorded on the issue", async () => {
    const { w, ctx, before } = await taken();

    const s = await settleRun(ctx, 131, exited(1), before);

    expect(s).toMatchObject({ kind: "retry", attempts: 1 });
    expect(w.github.comments(131).at(-1)).toBe(`${RUN_MARK}attempt 1 of 3: the agent exited 1 without finishing its step, after 4m`);
    expect(w.github.claim(131)?.session).toBe("run-131-a");
  });

  test("an agent that released the claim without moving the issue has not finished: the run takes the claim back and retries", async () => {
    const { w, ctx, before } = await taken();
    await w.norn("release", "131");

    const s = await settleRun(ctx, 131, { end: { kind: "stopped-early", state: "idle" }, minutes: 2 }, before);

    expect(s).toMatchObject({ kind: "retry", attempts: 1 });
    expect(w.github.claim(131)).toMatchObject({ session: "run-131-a", leaseMs: 10 * 60_000 });
  });

  test("the last attempt of the budget escalates to a person and gives up the claim", async () => {
    const { w, ctx, before } = await taken();
    await settleRun(ctx, 131, exited(0), before);
    await settleRun(ctx, 131, exited(0), before);

    const s = await settleRun(ctx, 131, { end: { kind: "stalled", afterMs: 180_000 }, minutes: 9 }, before);

    expect(s).toMatchObject({ kind: "escalated", attempts: 3 });
    expect(w.github.labels(131)).toContain("needs-human");
    expect(w.github.claim(131)).toBeNull();
    expect(w.github.comments(131).at(-1)).toContain("3 runs ended without finishing the step; the last: stalled: its screen did not change for 3m");
  });

  test("an agent that waited on a person too long escalates at once: the dialog would only come back", async () => {
    const { w, ctx, before } = await taken();

    const s = await settleRun(ctx, 131, { end: { kind: "blocked", afterMs: 30 * 60_000 }, minutes: 31 }, before);

    expect(s).toMatchObject({ kind: "escalated", attempts: 1 });
    expect(w.github.comments(131).at(-1)).toContain("the run's agent waited for a person in its herdr pane for 30m");
  });

  test("an agent that died before norn take counts as an attempt, under a claim taken back", async () => {
    const w = setup({ session: "run-131-a" });
    w.github.seedIssue(issue);
    const ctx = await w.ctx();

    const s = await settleRun(ctx, 131, { end: { kind: "not-started", detail: "no such agent" }, minutes: 0 }, 0);

    expect(s).toMatchObject({ kind: "retry", attempts: 1 });
    expect(w.github.claim(131)?.session).toBe("run-131-a");
  });

  test("a stale claim of a dead run, which this run's agent never took over, is taken over and the attempt recorded", async () => {
    const w = setup({ session: "run-131-b" });
    w.github.seedIssue(issue);
    await w.github.createClaim(131, { holder: "alice", session: "run-131-a", since: "2026-10-13T11:00:00Z", leaseMs: 60_000 });

    const s = await settleRun(await w.ctx(), 131, { end: { kind: "not-started", detail: "no such agent" }, minutes: 0 }, 0);

    expect(s).toMatchObject({ kind: "retry", attempts: 1 });
    expect(w.github.claim(131)?.session).toBe("run-131-b");
  });

  test("a claim another session holds now means the run lost it, and nothing is written", async () => {
    const { w, ctx, before } = await taken();
    await w.github.deleteClaim(131);
    await w.github.createClaim(131, { holder: "alice", session: "elsewhere", since: "2026-10-13T12:00:00Z" });
    const comments = w.github.comments(131).length;

    expect(await settleRun(ctx, 131, exited(0), before)).toMatchObject({ kind: "lost", session: "elsewhere" });
    expect(w.github.comments(131)).toHaveLength(comments);
  });

  test("the attempt budget is the team's run.maxAttempts", async () => {
    const { w, before } = await taken();
    w.workspace.files.set(TEAM, JSON.stringify({ run: { maxAttempts: 1 } }));

    expect(await settleRun(await w.ctx(), 131, exited(0), before)).toMatchObject({ kind: "escalated", attempts: 1 });
  });
});

describe("counting abandoned attempts", () => {
  test("a transition or a needs-human starts a fresh budget", () => {
    const run = `${RUN_MARK}attempt 1 of 3: the agent exited 1 without finishing its step, after 2m`;
    expect(abandonedAttempts([run, run])).toBe(2);
    expect(abandonedAttempts([run, "norn: implementation → needs-review", run])).toBe(1);
    expect(abandonedAttempts([run, run, "norn: needs-human — escalated", "a person's reply"])).toBe(0);
  });
});

describe("a run's lease", () => {
  test("renewing moves the claim's time forward and writes the run's own lease into it", async () => {
    const { w, ctx } = await taken();
    w.setNow("2026-10-13T12:08:00Z");

    expect(await renewLease(ctx, 131, true)).toBe("renewed");
    expect(w.github.claim(131)).toMatchObject({ since: "2026-10-13T12:08:00.000Z", leaseMs: 10 * 60_000 });
  });

  test("a run's claim goes stale after its own lease, not claims.staleAfter, so a frozen run gives its item up", async () => {
    const { w, ctx } = await taken();
    await renewLease(ctx, 131, true);
    w.setNow("2026-10-13T12:11:00Z");

    expect(await w.as("another-session")("take", "131")).toMatchObject({ exitCode: 0 });
    expect(w.github.claim(131)?.session).toBe("another-session");
  });

  test("an ordinary claim keeps claims.staleAfter", async () => {
    const { w } = await taken();
    w.setNow("2026-10-13T12:11:00Z");

    expect((await w.as("another-session")("take", "131")).exitCode).toBe(1);
  });

  test("a renewal that loses a race with the agent's own norn take is not a lost claim", async () => {
    const { w, ctx } = await taken();
    const replace = w.github.replaceClaim.bind(w.github);
    let raced = false;
    w.github.replaceClaim = async (n, sha, record) => {
      if (!raced) {
        raced = true;
        // The agent refreshes the claim with norn take just before the renewal lands.
        await w.as("run-131-a")("take", "131");
      }
      return replace(n, sha, record);
    };

    expect(await renewLease(ctx, 131, true)).toBe("renewed");
  });

  test("says not-taken before the agent's take, released after it gave the claim up, and lost once another session holds it", async () => {
    const w = setup({ session: "run-131-a" });
    w.github.seedIssue(issue);
    const ctx = await w.ctx();
    expect(await renewLease(ctx, 131, false)).toBe("not-taken");
    expect(await renewLease(ctx, 131, true)).toBe("released");
    await w.github.createClaim(131, { holder: "alice", session: "elsewhere", since: "2026-10-13T12:00:00Z" });
    // Before its agent's take, a stale claim of another session is one the agent may take over, not the run's to lose.
    expect(await renewLease(ctx, 131, false)).toBe("not-taken");
    expect(await renewLease(ctx, 131, true)).toBe("lost");
  });
});

describe("the run settings", () => {
  test("default to claude, a 10m lease and stall, a 2h timeout, 30m blocked and 3 attempts", async () => {
    expect((await setup().ctx()).config.run).toEqual({
      agent: "claude",
      agents: {},
      env: {},
      leaseMs: 10 * 60_000,
      stallAfterMs: 10 * 60_000,
      timeoutMs: 2 * 3_600_000,
      blockedAfterMs: 30 * 60_000,
      maxAttempts: 3,
    });
  });

  test("the developer's agent, agents and clocks win; the lease and the attempt budget are the team's", async () => {
    const w = setup();
    w.workspace.files.set(
      TEAM,
      JSON.stringify({ run: { agent: "a", agents: { a: { kind: "claude" }, b: { kind: "codex" } }, lease: "5m", timeout: "1h", maxAttempts: 2 } }),
    );
    w.workspace.files.set(
      LOCAL,
      JSON.stringify({
        run: { agent: "b", agents: { b: { kind: "codex", args: ["--full-auto"] } }, timeout: "3h", stallAfter: "20m", lease: "1h", maxAttempts: 9 },
      }),
    );

    const loaded = await loadConfig(w.workspace);

    expect(loaded.ok && loaded.config.run).toMatchObject({
      agent: "b",
      agents: { a: { kind: "claude", args: [] }, b: { kind: "codex", args: ["--full-auto"] } },
      leaseMs: 5 * 60_000,
      timeoutMs: 3 * 3_600_000,
      stallAfterMs: 20 * 60_000,
      maxAttempts: 2,
    });
    expect(loaded.ok && loaded.warnings).toEqual([
      { kind: "team-setting-in-local-file", file: LOCAL, setting: "run.lease", team: TEAM },
      { kind: "team-setting-in-local-file", file: LOCAL, setting: "run.maxAttempts", team: TEAM },
    ]);
  });

  test("run.env is refused in the team file, where a token would be committed", async () => {
    const w = setup();
    w.github.seedIssue(issue);
    w.workspace.files.set(TEAM, JSON.stringify({ run: { env: { GH_TOKEN: "x" } } }));

    const res = await w.norn("take", "131");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(`${TEAM}: run.env is each developer's own, since it may hold a token; set it in ${LOCAL}`);
  });

  test("a bad setting is refused with what it should be", async () => {
    const w = setup();
    w.github.seedIssue(issue);
    w.workspace.files.set(LOCAL, JSON.stringify({ run: { agents: { opus: { args: ["--x"] } }, stallAfter: "soon", maxAttempts: 0, driver: "process" } }));

    const res = await w.norn("take", "131");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(`${LOCAL}: run.agents must map names to agents like { "kind": "claude", "args": ["--model", "opus"] }`);
    expect(res.stdout).toContain(`${LOCAL}: run.stallAfter must be a duration like 10m`);
    expect(res.stdout).toContain(`${LOCAL}: run.maxAttempts must be a whole number above 0`);
    expect(res.stdout).toContain(`${LOCAL}: unknown setting "run.driver"`);
  });
});
