import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

describe("triage", () => {
  test("accept makes the issue a story in needs-refinement owned by the user, and releases the claim", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7, title: "Rate limiting" });
    await w.norn("take", "7");

    const res = await w.norn("done", "7", "accept");

    expect(res.exitCode).toBe(0);
    expect(w.github.labels(7).sort()).toEqual(["needs-refinement", "type:story"]);
    expect(w.github.issues.get(7)!.assignees).toEqual(["alice"]);
    expect(w.github.claim(7)).toBeNull();
    expect(w.github.comments(7).at(-1)).toContain("triage → needs-refinement");
    expect(res.stdout).toContain("#7 is now in needs-refinement");
  });

  test("reject closes the issue as not planned with the reason as a comment", async () => {
    const w = setup();
    w.github.seedIssue({ number: 8, title: "Dark mode for the CLI" });
    await w.norn("take", "8");

    const res = await w.norn("done", "8", "reject", "Out of scope for this product");

    expect(res.exitCode).toBe(0);
    expect(w.github.issues.get(8)!.state).toBe("closed");
    expect(w.github.issues.get(8)!.stateReason).toBe("not_planned");
    expect(w.github.comments(8).at(-1)).toContain("Out of scope for this product");
    expect(w.github.labels(8)).not.toContain("in-progress");
    expect(w.github.claim(8)).toBeNull();
  });
});

describe("done refusals", () => {
  test("done without holding the claim is refused and nothing changes", async () => {
    const w = setup();
    w.github.seedIssue({ number: 131, labels: ["type:slice", "mode:afk", "implementation"] });

    const res = await w.norn("done", "131");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("You do not hold #131");
    expect(res.stdout).toContain("norn take 131");
    expect(w.github.labels(131)).toContain("implementation");
  });

  test("done while another session holds the claim is refused", async () => {
    const w = setup();
    w.github.seedIssue({ number: 131, labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    await w.as("other")("take", "131");

    const res = await w.norn("done", "131");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#131 is held by another session");
    expect(w.github.claim(131)).toMatchObject({ session: "other" });
  });

  test("an unknown outcome is refused with the valid ones", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7 });
    await w.norn("take", "7");

    const res = await w.norn("done", "7", "approve");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('"approve" is not an outcome of triage');
    expect(res.stdout).toContain("norn done 7 accept");
    expect(res.stdout).toContain("norn done 7 reject");
    expect(w.github.claim(7)).not.toBeNull();
  });

  test("a missing outcome is refused when the step can end more than one way", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7 });
    await w.norn("take", "7");

    const res = await w.norn("done", "7");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("triage can end more than one way");
  });

  test("reject without a reason is refused", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7 });
    await w.norn("take", "7");

    const res = await w.norn("done", "7", "reject");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('norn done 7 reject "reason"');
    expect(w.github.issues.get(7)!.state).toBe("open");
  });
});
