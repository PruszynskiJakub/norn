import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

function story() {
  const w = setup();
  const gh = w.github;
  gh.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
  gh.seedIssue({ number: 127, title: "Redis store", state: "closed", labels: ["type:slice", "mode:afk"] });
  gh.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:hil", "ready-for-agent"] });
  gh.seedIssue({ number: 132, title: "Docs", labels: ["type:slice", "mode:afk", "blocked"] });
  for (const s of [127, 131, 132]) gh.parents.set(s, 123);
  gh.blockers.set(131, [127]);
  gh.blockers.set(132, [131]);
  return w;
}

describe("psdd status", () => {
  test("is a read-only overview of the story and its slices", async () => {
    const w = story();
    w.setNow("2026-10-13T14:02:00Z");
    await w.as("other")("take", "131");
    const before = JSON.stringify([...w.github.issues.values()]);

    const res = await w.psdd("status", "123");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(
      [
        'Story #123 "Rate limiting": implementation · owner @alice · branch 123-rate-limiting',
        "Slices (1 of 3 merged):",
        '  #127 "Redis store"      merged',
        '  #131 "Per-key limits"   implementation · mode:hil · held since 14:02',
        '  #132 "Docs"             blocked by #131 · mode:afk',
      ].join("\n"),
    );
    expect(JSON.stringify([...w.github.issues.values()])).toBe(before);
  });

  test("status --json", async () => {
    const w = story();
    const data = JSON.parse((await w.psdd("status", "123", "--json")).stdout);
    expect(data.story).toMatchObject({ number: 123, state: "implementation", owner: "alice" });
    expect(data.slices[2]).toMatchObject({ number: 132, state: "blocked", mode: "afk", blockedBy: [131] });
  });
});

describe("usage", () => {
  test("an unknown command prints usage", async () => {
    const w = setup();
    const res = await w.psdd("frobnicate");
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain("psdd next <story>");
    expect(res.stdout).toContain("psdd take <issue>");
  });

  test("a missing issue number is refused with the right form", async () => {
    const w = setup();
    const res = await w.psdd("take");
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain("psdd take <issue>");
  });
});
