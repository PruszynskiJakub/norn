import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

/** #42 in implementation, taken by session-1, which then asks a person and waits. */
async function waiting() {
  const w = setup();
  w.github.seedIssue({ number: 42, labels: ["type:slice", "mode:afk", "ready-for-agent"] });
  await w.norn("take", "42");
  w.setNow("2026-10-13T12:10:00Z");
  const res = await w.norn("escalate", "42", "Keep the old flag as an alias?", "--wait");
  return { w, res };
}

/** As waiting, with #42 a slice of story #123, whose spec it links. */
async function waitingInStory() {
  const w = setup();
  w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
  w.github.seedIssue({ number: 42, labels: ["type:slice", "mode:afk", "implementation"] });
  await w.github.addSubIssue(123, 42);
  await w.norn("take", "42");
  await w.norn("escalate", "42", "Keep it?", "--wait");
  return w;
}

describe("norn escalate --wait", () => {
  test("sets needs-human, comments the question and notifies as escalate does", async () => {
    const { w, res } = await waiting();

    expect(res.exitCode).toBe(0);
    expect(w.github.labels(42).sort()).toEqual(["implementation", "mode:afk", "needs-human", "type:slice"]);
    expect(w.github.comments(42).at(-1)).toBe('norn: needs-human — asked: "Keep the old flag as an alias?"');
    expect(w.notifications.at(-1)?.body).toContain("Keep the old flag as an alias?");
  });

  test("keeps a multi-line question in its own paragraph", async () => {
    const w = setup();
    w.github.seedIssue({ number: 42, labels: ["type:slice", "mode:afk", "implementation"] });
    await w.norn("take", "42");
    await w.norn("escalate", "42", "Keep the flag?\nOr drop it?", "--wait");
    expect(w.github.comments(42).at(-1)).toBe('norn: needs-human — asked: "Keep the flag? Or drop it?"\n\nKeep the flag?\nOr drop it?');
  });

  test("keeps the claim with the same session, marked waiting with the question and since when", async () => {
    const { w, res } = await waiting();

    expect(w.github.claim(42)).toMatchObject({
      session: "session-1",
      waiting: { question: "Keep the old flag as an alias?", since: "2026-10-13T12:10:00.000Z" },
    });
    expect(res.stdout).toContain('norn resume 42 "<answer>"');
  });

  test("--json says the claim waits", async () => {
    const w = setup();
    w.github.seedIssue({ number: 42, labels: ["type:slice", "mode:afk", "implementation"] });
    await w.norn("take", "42");
    const res = await w.norn("escalate", "42", "Keep it?", "--wait", "--json");
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: true, waiting: true });
  });

  test("a waiting claim never goes stale: another session's take is refused as held", async () => {
    const { w } = await waiting();
    w.setNow("2026-10-14T12:10:00Z");

    const res = await w.as("session-2")("take", "42");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("held by another session of yours");
    expect(w.github.claim(42)?.session).toBe("session-1");
  });

  test("a teammate's take is refused however long the claim waits", async () => {
    const { w } = await waiting();
    w.setNow("2027-01-01T00:00:00Z");

    const res = await w.asTeammate("bob", "bob-1")("take", "42");

    expect(res.exitCode).toBe(1);
    expect(w.github.claim(42)?.session).toBe("session-1");
  });

  test("the holder's --takeover from another session frees it into the ordinary resolve step", async () => {
    const { w } = await waiting();

    const res = await w.as("session-2")("take", "42", "--takeover");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Invoke the skill: norn-resolve");
    const claim = w.github.claim(42);
    expect(claim?.session).toBe("session-2");
    expect(claim).not.toHaveProperty("waiting");
  });
});

describe("while a claim waits", () => {
  test.each([
    ["done", ["done", "42", "implemented"]],
    ["escalate", ["escalate", "42", "something else"]],
    ["take", ["take", "42"]],
  ])("%s from the same session is refused, saying to resume first; nothing changes", async (_, argv) => {
    const { w } = await waiting();
    const labels = w.github.labels(42).sort();
    const comments = w.github.comments(42).length;
    const claim = w.github.claim(42);

    const res = await w.norn(...argv);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#42 waits on a person");
    expect(res.stdout).toContain('norn resume 42 "<answer>"');
    expect(w.github.labels(42).sort()).toEqual(labels);
    expect(w.github.comments(42)).toHaveLength(comments);
    expect(w.github.claim(42)).toEqual(claim);
  });

  test("release gives the item up; it keeps needs-human and the resolve step is next", async () => {
    const w = await waitingInStory();

    const res = await w.norn("release", "42");

    expect(res.exitCode).toBe(0);
    expect(w.github.claim(42)).toBeNull();
    expect(w.github.labels(42)).toContain("needs-human");
    const next = await w.norn("next", "123");
    // Listed as any needs-human item, for a person to resolve.
    expect(next.stdout).toContain('#42 needs a human: asked: "Keep it?".');
    const take = await w.as("session-2")("take", "42");
    expect(take.stdout).toContain("Invoke the skill: norn-resolve");
  });
});

describe("norn resume", () => {
  test("records the answer, clears needs-human, puts in-progress back and refreshes the claim", async () => {
    const { w } = await waiting();
    w.setNow("2026-10-13T12:35:00Z");

    const res = await w.norn("resume", "42", "Yes, keep the old flag as an alias");

    expect(res.exitCode).toBe(0);
    expect(w.github.comments(42).at(-1)).toBe("norn: implementation → implementation (needs-human answered)\n\nYes, keep the old flag as an alias");
    expect(w.github.labels(42).sort()).toEqual(["implementation", "in-progress", "mode:afk", "type:slice"]);
    expect(w.github.claim(42)).toEqual({ holder: "alice", session: "session-1", since: "2026-10-13T12:35:00.000Z" });
    expect(res.stdout).toContain("Carry on");
  });

  test("the answered comment links the spec, as every transition comment does", async () => {
    const w = await waitingInStory();

    await w.norn("resume", "42", "Yes");

    expect(w.github.comments(42).at(-1)).toBe(
      "norn: implementation → implementation (needs-human answered)\n\nSpec: https://github.com/acme/app/blob/123-rate-limiting/.agents/specs/123-rate-limiting/spec.md\n\nYes",
    );
  });

  test("the step carries on without a new take: done finishes it", async () => {
    const { w } = await waiting();
    await w.norn("resume", "42", "Yes");

    const res = await w.norn("done", "42");

    expect(res.exitCode).toBe(0);
    expect(w.github.labels(42)).not.toContain("needs-human");
  });

  test("needs the answer", async () => {
    const { w } = await waiting();

    const res = await w.norn("resume", "42");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("answer is required");
    expect(res.stdout).toContain('norn resume 42 "<answer>"');
    expect(w.github.labels(42)).toContain("needs-human");
  });

  test("is refused when the claim is not waiting", async () => {
    const w = setup();
    w.github.seedIssue({ number: 42, labels: ["type:slice", "mode:afk", "implementation", "needs-human"] });
    await w.norn("take", "42");

    const res = await w.norn("resume", "42", "Yes");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#42 does not wait on a person");
    expect(w.github.labels(42)).toContain("needs-human");
  });

  test("is refused when the session does not hold the claim", async () => {
    const { w } = await waiting();

    const res = await w.as("session-2")("resume", "42", "Yes");

    expect(res.exitCode).toBe(1);
    expect(w.github.labels(42)).toContain("needs-human");
    expect(w.github.claim(42)).toHaveProperty("waiting");
  });

  test("is refused when nobody holds the claim", async () => {
    const w = setup();
    w.github.seedIssue({ number: 42, labels: ["type:slice", "implementation", "needs-human"] });
    const res = await w.norn("resume", "42", "Yes");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("You do not hold #42");
  });
});
