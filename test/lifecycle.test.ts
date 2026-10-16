import { expect, test } from "vitest";
import { setup } from "@shepherd/testing";

test("a story runs from new issue to its story PR, driven only through shepherd", async () => {
  const w = setup();
  const gh = w.github;
  gh.seedIssue({ number: 123, title: "Rate limiting" });
  const step = async (...argv: string[]) => {
    const r = await w.shepherd(...argv);
    expect(r.exitCode, `${argv.join(" ")}\n${r.stdout}`).toBe(0);
    return r.stdout;
  };

  // Phase 1, attended.
  await step("take", "123");
  await step("done", "123", "accept");
  await step("take", "123");
  await step("done", "123", "questions");
  await step("take", "123");
  await step("done", "123", "answered");
  await step("take", "123");
  await step("done", "123");
  await step("take", "123");
  await step("add-slice", "123", "Redis store", "--mode", "afk");
  const [redis] = gh.subIssueNumbers(123);
  await step("add-slice", "123", "Per-key limits", "--mode", "hil", "--blocked-by", String(redis));
  const [, perKey] = gh.subIssueNumbers(123);
  await step("done", "123");
  expect(gh.labels(123)).toContain("implementation");

  // Phase 2: only the unblocked slice can start.
  expect(await step("next", "123")).toContain(`shepherd take ${redis}`);
  expect(await step("next", "123")).toContain(`#${perKey} is blocked by #${redis}.`);

  const runSlice = async (n: number, _title: string, hil: boolean) => {
    await step("take", String(n));
    gh.prs.push({ number: n + 5000, head: `123-rate-limiting-${n}`, base: "123-rate-limiting", state: "open" });
    await step("done", String(n));
    await step("take", String(n));
    await step("done", String(n), "approve");
    await step("take", String(n));
    await step("done", String(n), "pass", "Behaviour 1: passed");
    if (hil) {
      expect(gh.labels(n)).toContain("needs-human-qa");
      expect(await step("next", "123")).toContain(`#${n} needs human QA (mode:hil).`);
      await step("take", String(n));
      await step("done", String(n), "pass");
    }
    await step("take", String(n));
    gh.prs.at(-1)!.state = "merged";
    return step("done", String(n));
  };

  expect(await runSlice(redis, "redis-store", false)).toContain(`#${perKey} is now ready-for-agent.`);
  expect(await runSlice(perKey, "per-key-limits", true)).toContain("Story #123 is now in needs-review.");

  // Story review, QA by an agent and then by a person, then the owner merges.
  await step("take", "123");
  await step("done", "123", "approve");
  await step("take", "123");
  await step("done", "123", "pass", "Behaviour 1: passed");
  expect(await step("next", "123")).toContain("Waiting for a human:\n  - #123 needs human QA (story).");
  await step("take", "123");
  await step("done", "123", "pass");
  expect(gh.labels(123).sort()).toEqual(["merge-queue", "type:story"]);
  expect(await step("next", "123")).toContain("waits for its owner (@alice)");
  expect(gh.prs.find((p) => p.head === "123-rate-limiting")).toMatchObject({ base: "main" });
  expect([...gh.claims.keys()]).toEqual([]);
});
