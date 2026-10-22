import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

describe("norn escalate", () => {
  test("sets needs-human with the reason as a comment and releases the claim; state is kept", async () => {
    const w = setup();
    w.github.seedIssue({ number: 131, labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    await w.norn("take", "131");

    const res = await w.norn("escalate", "131", "Redis is not available in CI");

    expect(res.exitCode).toBe(0);
    expect(w.github.labels(131).sort()).toEqual(["implementation", "mode:afk", "needs-human", "type:slice"]);
    expect(w.github.comments(131).at(-1)).toBe('norn: needs-human — escalated: "Redis is not available in CI"');
    expect(w.github.claim(131)).toBeNull();
    expect(res.stdout).toContain("The claim is released.");
  });

  test("needs a reason", async () => {
    const w = setup();
    w.github.seedIssue({ number: 131, labels: ["type:slice", "implementation"] });
    await w.norn("take", "131");
    const res = await w.norn("escalate", "131");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('norn escalate 131 "reason"');
  });

  test("needs the claim", async () => {
    const w = setup();
    w.github.seedIssue({ number: 131, labels: ["type:slice", "implementation"] });
    const res = await w.norn("escalate", "131", "why");
    expect(res.exitCode).toBe(1);
    expect(w.github.labels(131)).not.toContain("needs-human");
  });
});

describe("resolving needs-human", () => {
  test("an issue with needs-human is briefed with resolve; done clears the flag and keeps the state", async () => {
    const w = setup();
    w.github.seedIssue({ number: 131, labels: ["type:slice", "mode:afk", "implementation", "needs-human"] });

    const take = await w.norn("take", "131");
    expect(take.stdout).toContain("Invoke the skill: norn-resolve");
    expect(take.stdout.replace(/\s+/g, " ")).toContain("This step is attended");
    expect(w.github.labels(131)).toContain("implementation");

    await w.norn("done", "131");

    expect(w.github.labels(131).sort()).toEqual(["implementation", "mode:afk", "type:slice"]);
    expect(w.github.claim(131)).toBeNull();
    expect(w.github.comments(131).at(-1)).toMatch(/^norn: implementation → implementation \(needs-human resolved\)/);
  });
});

describe("norn release", () => {
  test("gives up the claim without a transition", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7, labels: ["type:story", "needs-plan"] });
    await w.norn("take", "7");

    const res = await w.norn("release", "7");

    expect(res.exitCode).toBe(0);
    expect(w.github.labels(7).sort()).toEqual(["needs-plan", "type:story"]);
    expect(w.github.claim(7)).toBeNull();
  });

  test("refuses to release another session's claim", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7, labels: ["type:story", "needs-plan"] });
    await w.as("other")("take", "7");
    const res = await w.norn("release", "7");
    expect(res.exitCode).toBe(1);
    expect(w.github.claim(7)).not.toBeNull();
  });
});
