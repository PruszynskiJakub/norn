import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

/** A small bug flow: reproduce, then fix, then close. */
function bugFlow(over: Record<string, unknown> = {}) {
  return {
    description: "A defect: reproduce it, fix it, close it.",
    start: "reproducing",
    workspace: "none",
    states: {
      reproducing: {
        skill: "bug-repro",
        attended: true,
        outcomes: {
          reproduced: { to: "fixing", means: "the bug is reproduced, moves on to the fix" },
          "cannot-reproduce": { to: "not-planned", means: "no repro; give what you tried", note: "attempts" },
        },
      },
      fixing: {
        skill: "bug-fix",
        attended: false,
        outcomes: { fixed: { to: "closed", means: "the fix is merged" } },
      },
    },
    ...over,
  };
}

function bugAt(state: string, flow: unknown = bugFlow()) {
  const w = setup();
  w.github.seedFlow("bug", flow);
  w.github.seedIssue({ number: 40, title: "Crash on empty input", labels: ["type:bug", state], assignees: ["alice"] });
  return w;
}

describe("a repository flow", () => {
  test("take briefs the issue with the state's skill and the flow's outcomes", async () => {
    const w = bugAt("reproducing");

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('You now hold issue #40 "Crash on empty input". Its step is reproducing.');
    expect(res.stdout.replace(/\s+/g, " ")).toContain("This step is attended");
    expect(res.stdout).toContain("Invoke the skill: bug-repro\n");
    expect(res.stdout).toContain("norn done 40 reproduced");
    expect(res.stdout).toContain("the bug is reproduced, moves on to the fix");
    expect(res.stdout).toContain('norn done 40 cannot-reproduce "attempts"');
    expect(w.github.labels(40).sort()).toEqual(["in-progress", "reproducing", "type:bug"]);
  });
});

describe("done in a repository flow", () => {
  test("moves the issue to the outcome's state and says so on the issue", async () => {
    const w = bugAt("reproducing");
    await w.norn("take", "40");

    const res = await w.norn("done", "40", "reproduced");

    expect(res.exitCode).toBe(0);
    expect(w.github.labels(40).sort()).toEqual(["fixing", "type:bug"]);
    expect(w.github.comments(40).at(-1)).toBe("norn: reproducing → fixing (reproduced)");
  });

  test("closed closes the issue as completed and takes its state off", async () => {
    const w = bugAt("fixing");
    await w.norn("take", "40");

    await w.norn("done", "40", "fixed");

    expect(w.github.issues.get(40)!.state).toBe("closed");
    expect(w.github.issues.get(40)!.stateReason).toBe("completed");
    expect(w.github.labels(40)).toEqual(["type:bug"]);
    expect(w.github.comments(40).at(-1)).toBe("norn: fixing → closed (fixed)");
  });

  test("not-planned closes the issue as not planned, with the note", async () => {
    const w = bugAt("reproducing");
    await w.norn("take", "40");

    await w.norn("done", "40", "cannot-reproduce", "tried on 3 machines");

    expect(w.github.issues.get(40)!.stateReason).toBe("not_planned");
    expect(w.github.labels(40)).toEqual(["type:bug"]);
    expect(w.github.comments(40).at(-1)).toBe("norn: reproducing → closed as not planned (cannot-reproduce)\n\ntried on 3 machines");
  });

  test("a word the state does not have is refused with the flow's outcomes", async () => {
    const w = bugAt("fixing");
    await w.norn("take", "40");

    const res = await w.norn("done", "40", "approve");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('"approve" is not an outcome of fixing.');
    expect(res.stdout).toContain("norn done 40 fixed");
  });
});
