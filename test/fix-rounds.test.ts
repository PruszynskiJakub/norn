import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

/** A slice in needs-review whose label history shows `rounds` earlier failures. */
function sliceWithRounds(rounds: number, state = "needs-review") {
  const w = setup();
  w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", state] });
  const history = ["ready-for-agent", "implementation", "needs-review"];
  for (let i = 0; i < rounds; i++) history.push(i % 2 ? "qa-failed" : "changes-requested", "implementation", "needs-review");
  w.github.labelEvents.set(131, history);
  return w;
}

describe("fix-round limit", () => {
  test("the third failure still goes back to tdd", async () => {
    const w = sliceWithRounds(2);
    await w.psdd("take", "131");

    await w.psdd("done", "131", "request-changes", "Missing a test for burst limits");

    expect(w.github.labels(131)).toContain("changes-requested");
    expect(w.github.labels(131)).not.toContain("needs-human");
  });

  test("after 3 fix rounds, a failure sets needs-human instead of going back to tdd", async () => {
    const w = sliceWithRounds(3);
    await w.psdd("take", "131");

    const res = await w.psdd("done", "131", "request-changes", "Redis client times out in tests");

    expect(w.github.labels(131).sort()).toEqual(["changes-requested", "mode:afk", "needs-human", "type:slice"]);
    expect(w.github.comments(131).at(-1)).toContain(
      'psdd: needs-human — escalated: "Redis client times out in tests" (3 fix rounds reached)',
    );
    expect(res.stdout).toContain("#131 has reached 3 fix rounds, so it now needs a human instead of another round of tdd.");
  });

  test("QA failures count toward the same limit", async () => {
    const w = sliceWithRounds(3, "needs-qa");
    await w.psdd("take", "131");
    await w.psdd("done", "131", "fail", "Limits reset on restart");
    expect(w.github.labels(131)).toContain("needs-human");
  });

  test("deliver.maxFixRounds sets the limit", async () => {
    const w = sliceWithRounds(1);
    w.workspace.files.set(".agents/psdd.config.json", JSON.stringify({ deliver: { maxFixRounds: 1 } }));
    await w.psdd("take", "131");
    await w.psdd("done", "131", "request-changes", "Still flaky");
    expect(w.github.labels(131)).toContain("needs-human");
  });

  test("resolving needs-human after the limit clears it and is no new round", async () => {
    const w = sliceWithRounds(4, "changes-requested");
    w.github.issues.get(131)!.labels.push("needs-human");
    await w.psdd("take", "131");

    const res = await w.psdd("done", "131");

    expect(res.exitCode).toBe(0);
    expect(w.github.labels(131)).toContain("changes-requested");
    expect(w.github.labels(131)).not.toContain("needs-human");
    expect(res.stdout).not.toContain("fix rounds");
    expect(w.github.comments(131).join("\n")).not.toContain("undefined");
  });
});
