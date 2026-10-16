import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

describe("norn take", () => {
  test("a new unlabeled issue is claimed and briefed for triage", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7, title: "Rate limiting" });

    const res = await w.norn("take", "7");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('You now hold issue #7 "Rate limiting"');
    expect(res.stdout).toContain("Invoke the skill: norn-triage");
    expect(res.stdout).toContain("norn done 7 story");
    expect(res.stdout).toContain("norn done 7 reject");
    expect(res.stdout).toContain("If you have to stop, run: norn release 7");
    expect(w.github.labels(7)).toContain("in-progress");
    expect(w.github.claim(7)).toMatchObject({ holder: "alice", session: "session-1" });
  });
});

describe("norn take refusals", () => {
  test("an issue held by another session is refused, with what to do instead", async () => {
    const w = setup();
    w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "ready-for-agent"] });
    w.setNow("2026-10-13T14:02:00Z");
    await w.asTeammate("bob", "other-session")("take", "131");
    w.setNow("2026-10-13T14:30:00Z");

    const res = await w.norn("take", "131");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#131 is already held by another session (since 14:02)");
    expect(res.stdout).toContain("Do not work on it.");
    expect(w.github.claim(131)).toMatchObject({ session: "other-session" });
  });
});

describe("taking over a stopped session of your own", () => {
  function heldByMyOtherSession() {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-refinement"] });
    w.setNow("2026-10-13T14:02:00Z");
    return w;
  }

  test("a fresh claim of another session of yours is refused, with the takeover command", async () => {
    const w = heldByMyOtherSession();
    await w.as("stopped-session")("take", "123");
    w.setNow("2026-10-13T14:30:00Z");

    const res = await w.norn("take", "123");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe(
      [
        "#123 is held by another session of yours (since 14:02).",
        "If that session has stopped, take it over here: norn take 123 --takeover",
        "If it is still running, do not work on it.",
      ].join("\n"),
    );
    expect(w.github.claim(123)).toMatchObject({ session: "stopped-session" });
  });

  test("--takeover takes it over before it goes stale, keeping its worktree", async () => {
    const w = heldByMyOtherSession();
    await w.as("stopped-session")("take", "123");
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting");
    w.setNow("2026-10-13T14:30:00Z");

    const res = await w.norn("take", "123", "--takeover");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(
      "You took #123 over from another session of yours (since 14:02); its worktree is kept with what it left. Check git status there before you start.",
    );
    expect(res.stdout).toContain("Invoke the skill: norn-refine");
    expect(w.github.claim(123)).toMatchObject({ holder: "alice", session: "session-1", since: "2026-10-13T14:30:00.000Z" });
  });

  test("--takeover does not take a teammate's claim", async () => {
    const w = heldByMyOtherSession();
    await w.asTeammate("bob", "bobs-session")("take", "123");

    const res = await w.norn("take", "123", "--takeover");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe(
      ["#123 is held by @bob (since 14:02). --takeover only takes over your own sessions.", "Ask them to release it, or wait until the claim goes stale."].join(
        "\n",
      ),
    );
    expect(w.github.claim(123)).toMatchObject({ holder: "bob", session: "bobs-session" });
  });

  test("taken fresh after the earlier session released it, the briefing names its uncommitted work", async () => {
    const w = heldByMyOtherSession();
    await w.as("stopped-session")("take", "123");
    await w.norn("take", "123", "--takeover");
    await w.norn("release", "123");
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting");
    w.workspace.dirty.add(".agents/worktrees/123-rate-limiting");

    const res = await w.as("worktree-agent")("take", "123");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(
      [
        "Work in: /repo/.agents/worktrees/123-rate-limiting (branch 123-rate-limiting)",
        "It has uncommitted changes, e.g. from an earlier session. Check git status there before you start.",
      ].join("\n"),
    );
  });

  test("--takeover on an unheld issue is an ordinary take", async () => {
    const w = heldByMyOtherSession();

    const res = await w.norn("take", "123", "--takeover");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain("took #123 over");
  });
});

describe("stale claims", () => {
  test("a claim older than 2 hours is treated as abandoned and taken over", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7, title: "Rate limiting" });
    w.setNow("2026-10-13T10:00:00Z");
    await w.as("crashed-session")("take", "7");
    w.setNow("2026-10-13T12:00:01Z");

    const res = await w.norn("take", "7");

    expect(res.exitCode).toBe(0);
    expect(w.github.claim(7)).toMatchObject({ session: "session-1", since: "2026-10-13T12:00:01.000Z" });
  });

  test("a claim just under 2 hours old still blocks", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7 });
    w.setNow("2026-10-13T10:00:00Z");
    await w.as("busy-session")("take", "7");
    w.setNow("2026-10-13T11:59:59Z");

    expect((await w.norn("take", "7")).exitCode).toBe(1);
  });
});

describe("taking an issue this session already holds", () => {
  test("briefs again and refreshes the claim instead of refusing", async () => {
    const w = setup();
    w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    w.setNow("2026-10-13T10:00:00Z");
    await w.norn("take", "131");
    w.setNow("2026-10-13T11:30:00Z");

    const res = await w.norn("take", "131");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^You already held #131; the claim is refreshed\. Here is its briefing again\.\n\nYou now hold slice #131/);
    expect(w.github.claim(131)).toMatchObject({ session: "session-1", since: "2026-10-13T11:30:00.000Z" });
  });

  test("a refreshed claim is not stale two hours after it was first taken", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7 });
    w.setNow("2026-10-13T10:00:00Z");
    await w.as("slow-session")("take", "7");
    w.setNow("2026-10-13T11:30:00Z");
    await w.as("slow-session")("take", "7");
    w.setNow("2026-10-13T12:30:00Z");

    const res = await w.norn("take", "7");

    expect(res.exitCode).toBe(1);
    expect(w.github.claim(7)).toMatchObject({ session: "slow-session" });
  });
});

describe("the documented refusal", () => {
  test("a slice held elsewhere is refused with the documented wording", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    w.github.parents.set(131, 123);
    w.setNow("2026-10-13T14:02:00Z");
    await w.asTeammate("bob", "other")("take", "131");

    const res = await w.norn("take", "131");

    expect(res.stdout).toBe(
      ["Slice #131 is already held by another session (since 14:02).", "Do not work on it. Run norn next 123 and pick a different item."].join("\n"),
    );
  });
});

describe("a claim that changes between reading and replacing it", () => {
  test("a takeover that finds the stale claim already released creates a fresh one", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7, title: "Rate limiting" });
    w.setNow("2026-10-13T10:00:00Z");
    await w.as("crashed-session")("take", "7");
    w.setNow("2026-10-13T12:00:01Z");
    // The old holder releases just after norn read its stale claim.
    w.github.beforeReplace = (n) => w.github.claims.delete(n);

    const res = await w.norn("take", "7");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain("already held");
    expect(w.github.claim(7)).toMatchObject({ session: "session-1" });
  });

  test("a refresh that loses to another session's takeover is refused, not forced over it", async () => {
    const w = setup();
    w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    w.setNow("2026-10-13T10:00:00Z");
    await w.norn("take", "131");
    w.setNow("2026-10-13T12:30:00Z");
    // Another session takes over the (by now stale) claim just after this session read it as its own.
    w.github.beforeReplace = (n) => {
      w.github.beforeReplace = null;
      w.github.claims.delete(n);
      w.github.claimShas.delete(n);
      void w.github.createClaim(n, { holder: "bob", session: "other-session", since: "2026-10-13T12:29:59.000Z" });
    };

    const res = await w.norn("take", "131");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#131 is already held by another session (since 12:29)");
    expect(w.github.claim(131)).toMatchObject({ session: "other-session" });
  });
});
