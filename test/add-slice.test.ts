import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

async function slicingStory() {
  const w = setup();
  w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-slicing"], assignees: ["alice"] });
  await w.norn("take", "123");
  return w;
}

describe("norn add-slice", () => {
  test("creates an unblocked slice as a sub-issue, ready for an agent, owned by the story owner", async () => {
    const w = await slicingStory();

    const res = await w.norn("add-slice", "123", "Redis store", "--mode", "afk");

    expect(res.exitCode).toBe(0);
    const slice = [...w.github.issues.values()].find((i) => i.title === "Redis store")!;
    expect(slice.labels.sort()).toEqual(["mode:afk", "ready-for-agent", "type:slice"]);
    expect(slice.assignees).toEqual(["alice"]);
    expect(w.github.subIssueNumbers(123)).toEqual([slice.number]);
    expect(res.stdout).toContain(`Created slice #${slice.number} "Redis store"`);
  });

  test("a slice blocked by open slices starts blocked, with native blocked-by relations", async () => {
    const w = await slicingStory();
    await w.norn("add-slice", "123", "Redis store", "--mode", "afk");
    await w.norn("add-slice", "123", "Limit headers", "--mode", "afk");
    const [a, b] = w.github.subIssueNumbers(123);

    await w.norn("add-slice", "123", "Per-key limits", "--blocked-by", String(a), "--blocked-by", String(b), "--mode", "hil");

    const slice = [...w.github.issues.values()].find((i) => i.title === "Per-key limits")!;
    expect(slice.labels.sort()).toEqual(["blocked", "mode:hil", "type:slice"]);
    expect(w.github.blockerNumbers(slice.number)).toEqual([a, b]);
  });

  test("is refused without a mode", async () => {
    const w = await slicingStory();
    const res = await w.norn("add-slice", "123", "Redis store");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("--mode afk|hil");
    expect(w.github.subIssueNumbers(123)).toEqual([]);
  });

  test("is refused when the story is not in needs-slicing", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, labels: ["type:story", "needs-plan"] });
    await w.norn("take", "123");
    const res = await w.norn("add-slice", "123", "Redis store", "--mode", "afk");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Story #123 is in needs-plan, not needs-slicing");
  });

  test("is refused when this session does not hold the story", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, labels: ["type:story", "needs-slicing"] });
    const res = await w.norn("add-slice", "123", "Redis store", "--mode", "afk");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("norn take 123");
  });
});

describe("finishing slicing", () => {
  test("done on a sliced story moves it to implementation", async () => {
    const w = await slicingStory();
    await w.norn("add-slice", "123", "Redis store", "--mode", "afk");

    const res = await w.norn("done", "123");

    expect(res.exitCode).toBe(0);
    expect(w.github.labels(123).sort()).toEqual(["implementation", "type:story"]);
  });

  test("done with no slices yet is refused", async () => {
    const w = await slicingStory();
    const res = await w.norn("done", "123");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Story #123 has no slices yet");
    expect(res.stdout).toContain('norn add-slice 123 "<title>" --mode afk|hil');
    expect(w.github.labels(123)).toContain("needs-slicing");
  });

  test("a sub-issue a person attached by hand is not a slice", async () => {
    const w = await slicingStory();
    w.github.seedIssue({ number: 140, title: "Update docs", labels: [] });
    w.github.parents.set(140, 123);
    const res = await w.norn("done", "123");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Story #123 has no slices yet");
  });
});

describe("after slicing", () => {
  test("finishing slicing points the user to the norn-deliver skill", async () => {
    const w = await slicingStory();
    await w.norn("add-slice", "123", "Redis store", "--mode", "afk");

    const res = await w.norn("done", "123");

    expect(res.stdout).toContain("To run the story unattended until it needs a human, the user can start the norn-deliver skill: norn-deliver 123");
  });
});
