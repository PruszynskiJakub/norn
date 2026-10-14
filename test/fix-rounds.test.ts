import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

/** A slice in needs-review whose psdd comments show `rounds` earlier failures. */
function sliceWithRounds(rounds: number, state = "needs-review") {
  const w = setup();
  w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", state] });
  const comments = ["psdd: implementation → needs-review"];
  for (let i = 0; i < rounds; i++) {
    comments.push(i % 2 ? "psdd: needs-qa → qa-failed (fail)" : "psdd: needs-review → changes-requested (request-changes)");
    comments.push(i % 2 ? "psdd: qa-failed → needs-review" : "psdd: changes-requested → needs-review");
  }
  w.github.commentsByIssue.set(131, comments);
  return w;
}

/** One fix round through psdd: implement back to review, then review requests changes. Returns the review's done. */
async function fixRound(w: ReturnType<typeof setup>) {
  await w.psdd("take", "131");
  await w.psdd("done", "131");
  await w.psdd("take", "131");
  return w.psdd("done", "131", "request-changes", "Still flaky");
}

describe("fix-round limit", () => {
  test("the third failure still goes back to implement", async () => {
    const w = sliceWithRounds(2);
    await w.psdd("take", "131");

    await w.psdd("done", "131", "request-changes", "Missing a test for burst limits");

    expect(w.github.labels(131)).toContain("changes-requested");
    expect(w.github.labels(131)).not.toContain("needs-human");
  });

  test("after 3 fix rounds, a failure sets needs-human instead of going back to implement", async () => {
    const w = sliceWithRounds(3);
    await w.psdd("take", "131");

    const res = await w.psdd("done", "131", "request-changes", "Redis client times out in tests");

    expect(w.github.labels(131).sort()).toEqual(["changes-requested", "mode:afk", "needs-human", "type:slice"]);
    expect(w.github.comments(131).at(-1)).toContain(
      'psdd: needs-human — escalated: "Redis client times out in tests" (3 fix rounds reached)',
    );
    expect(res.stdout).toContain("#131 has reached 3 fix rounds, so it now needs a human instead of another round of implement.");
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

describe("a fresh fix budget after a person resolves the limit", () => {
  test("limit reached, resolved, then rounds 1 to 3 run without escalating and round 4 escalates again", async () => {
    const w = sliceWithRounds(3, "changes-requested");
    expect((await fixRound(w)).stdout).toContain("has reached 3 fix rounds");
    expect(w.github.labels(131)).toContain("needs-human");

    await w.psdd("take", "131");
    await w.psdd("done", "131");
    expect(w.github.labels(131)).not.toContain("needs-human");

    for (let round = 1; round <= 3; round++) {
      await fixRound(w);
      expect(w.github.labels(131), `round ${round}`).not.toContain("needs-human");
    }
    const res = await fixRound(w);
    expect(res.stdout).toContain("has reached 3 fix rounds");
    expect(w.github.labels(131)).toContain("needs-human");
  });

  test("the needs-human of QA in mode:hil does not reset the budget", async () => {
    const w = sliceWithRounds(3);
    w.github.commentsByIssue.get(131)!.push("psdd: needs-review → needs-qa (approve)\n\npsdd: needs-human — QA in mode:hil");
    await w.psdd("take", "131");

    await w.psdd("done", "131", "request-changes", "Still flaky");

    expect(w.github.labels(131)).toContain("needs-human");
  });
});

describe("multi-line notes", () => {
  const bullets = "- burst limits have no test\n- Redis client times out";

  test("a bulleted review note keeps the needs-human line whole, and the budget still resets", async () => {
    const w = sliceWithRounds(3);
    await w.psdd("take", "131");
    await w.psdd("done", "131", "request-changes", bullets);

    const last = w.github.comments(131).at(-1)!;
    expect(last).toContain('psdd: needs-human — escalated: "- burst limits have no test - Redis client times out" (3 fix rounds reached)');
    expect(last).toContain(`\n\n${bullets}`);

    await w.psdd("take", "131");
    await w.psdd("done", "131");
    for (let round = 1; round <= 3; round++) {
      await fixRound(w);
      expect(w.github.labels(131), `round ${round}`).not.toContain("needs-human");
    }
  });

  test("a multi-line escalate reason gives a single-line marker and keeps the full text", async () => {
    const w = sliceWithRounds(0, "implementation");
    await w.psdd("take", "131");
    await w.psdd("escalate", "131", "CI is down\nsee the run log");

    const last = w.github.comments(131).at(-1)!;
    expect(last.split("\n")[0]).toBe('psdd: needs-human — escalated: "CI is down see the run log"');
    expect(last).toContain("\n\nCI is down\nsee the run log");
  });
});
