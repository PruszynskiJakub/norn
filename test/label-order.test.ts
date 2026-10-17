import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

/** Story #123 in implementation with slice #127 in implementation, its PR open, held by this session. */
async function sliceInImplementation() {
  const w = setup();
  const gh = w.github;
  gh.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
  gh.seedIssue({ number: 127, title: "Redis store", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
  gh.parents.set(127, 123);
  gh.branches.add("123-rate-limiting");
  gh.prs.push({ number: 70, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "open" });
  await w.norn("take", "127");
  return w;
}

function failRemovals(w: ReturnType<typeof setup>) {
  const remove = w.github.removeLabels.bind(w.github);
  w.github.removeLabels = async () => {
    throw new Error("HTTP 502");
  };
  return () => (w.github.removeLabels = remove);
}

describe("a failure between label calls never leaves an issue without a state", () => {
  test("done writes the new state before removing the old one", async () => {
    const w = await sliceInImplementation();
    const restore = failRemovals(w);

    await expect(w.norn("done", "127")).rejects.toThrow("HTTP 502");

    expect(w.github.labels(127)).toContain("needs-review");
    expect(w.github.claim(127)).toBeNull();
    restore();
  });

  test("an issue left with two state labels is refused and reported, never briefed as its old step", async () => {
    const w = await sliceInImplementation();
    const restore = failRemovals(w);
    await w.norn("done", "127").catch(() => {});
    restore();
    // Left with implementation and needs-review: either could be real, so norn briefs neither.
    expect(w.github.labels(127)).toEqual(expect.arrayContaining(["implementation", "needs-review"]));

    const take = await w.norn("take", "127");
    expect(take.exitCode).toBe(1);
    expect(take.stdout).toContain("#127 has more than one state label (implementation, needs-review); a person must remove the stale one.");
    expect(w.github.claim(127)).toBeNull();

    const next = JSON.parse((await w.norn("next", "123", "--json")).stdout);
    expect(next.waiting).toContainEqual({
      issue: 127,
      reason: "ambiguous-state",
      detail: "has more than one state label (implementation, needs-review); a person must remove the stale one",
    });
    expect(next.start.map((s: { issue: number }) => s.issue)).not.toContain(127);
    expect(next.message).toContain("Waiting for a human:");

    const status = await w.norn("status", "123");
    expect(status.stdout).toContain("implementation + needs-review (more than one state label)");
  });

  test("take adds the step's state before removing the old one", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 127, title: "Redis store", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    w.github.parents.set(127, 123);
    failRemovals(w);

    await expect(w.norn("take", "127")).rejects.toThrow("HTTP 502");

    expect(w.github.labels(127)).toContain("implementation");
  });

  test("closing a slice closes it before removing labels", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 127, title: "Redis store", labels: ["type:slice", "mode:afk", "merge-queue"] });
    w.github.parents.set(127, 123);
    w.github.branches.add("123-rate-limiting");
    w.github.prs.push({ number: 50, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "merged" });
    await w.norn("take", "127");
    failRemovals(w);

    await expect(w.norn("done", "127")).rejects.toThrow("HTTP 502");

    expect(w.github.issues.get(127)!.state).toBe("closed");
  });
});

describe("norn next reports an open item with no state label", () => {
  test("it waits for a person instead of being skipped, so nothing left names it", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 127, title: "Redis store", labels: ["type:slice", "mode:afk"] });
    w.github.parents.set(127, 123);
    w.github.branches.add("123-rate-limiting");

    const res = await w.norn("next", "123", "--json");
    const report = JSON.parse(res.stdout);

    expect(report.waiting).toContainEqual({ issue: 127, reason: "no-state", detail: "has no state label; a person must set one" });
    expect(report.message).toContain("#127 has no state label; a person must set one.");
  });
});
