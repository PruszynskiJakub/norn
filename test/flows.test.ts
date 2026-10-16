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

describe("the flow's workspace", () => {
  test("own: a branch of the issue's own and one PR from it into the base branch", async () => {
    const w = bugAt("fixing", bugFlow({ workspace: "own" }));

    const out = (await w.norn("take", "40")).stdout;

    expect(out).toContain("Work in: /repo/.agents/worktrees/40-crash-on-empty-input (branch 40-crash-on-empty-input)");
    expect(out).toContain("git -C /repo fetch origin main && git -C /repo worktree add --no-track");
    expect(out).toContain("Commit on 40-crash-on-empty-input and push. Open one PR from 40-crash-on-empty-input into main if there is none yet:");
    expect(out).toContain("  gh pr create --base main --head 40-crash-on-empty-input --title 'Crash on empty input' --body 'Closes #40.'");
    expect(out).toContain("Diff: git diff origin/main...HEAD");
  });

  test("own: the branch keeps the name recorded on the issue's first transition, even after a rename", async () => {
    const w = bugAt("reproducing", bugFlow({ workspace: "own" }));
    await w.norn("take", "40");
    await w.norn("done", "40", "reproduced");
    w.github.issues.get(40)!.title = "Renamed";

    const out = (await w.norn("take", "40")).stdout;

    expect(w.github.comments(40)[0]).toBe("norn: reproducing → fixing (reproduced)\n\nnorn: slug crash-on-empty-input");
    expect(out).toContain("(branch 40-crash-on-empty-input)");
  });

  test("own: the PR goes into the team's base branch", async () => {
    const w = bugAt("fixing", bugFlow({ workspace: "own" }));
    w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ baseBranch: "develop" }));
    w.github.seedFlow("bug", bugFlow({ workspace: "own" }), "develop");

    const out = (await w.norn("take", "40")).stdout;

    expect(out).toContain("Open one PR from 40-crash-on-empty-input into develop if there is none yet:");
  });

  test("none: no branch, no worktree, no PR", async () => {
    const w = bugAt("fixing");

    const out = (await w.norn("take", "40")).stdout;

    expect(out).not.toContain("Work in:");
    expect(out).not.toContain("gh pr create");
    expect(out).toContain("Read the issue: gh issue view 40 --comments");
    expect(w.github.comments(40)).toEqual([]);
  });
});

describe("state labels on demand", () => {
  test("a transition into a state whose label is missing creates it from the state's colour and description", async () => {
    const flow = bugFlow();
    Object.assign(flow.states.fixing, { color: "d93f0b", description: "an agent fixes the bug" });
    const w = bugAt("reproducing", flow);
    await w.norn("take", "40");

    await w.norn("done", "40", "reproduced");

    expect(w.github.labelDefs.get("fixing")).toEqual({ color: "d93f0b", description: "an agent fixes the bug" });
  });

  test("without colour or description, the label gets the default for the state's kind", async () => {
    const w = bugAt("fixing", {
      ...bugFlow(),
      states: {
        ...bugFlow().states,
        fixing: { skill: "bug-fix", attended: false, outcomes: { fixed: { to: "verifying", means: "fixed, a person verifies" } } },
        verifying: { skill: "bug-verify", attended: true, outcomes: { ok: { to: "patching", means: "verified" } } },
        patching: { skill: "bug-patch", attended: false, outcomes: { done: { to: "closed", means: "patched" } } },
      },
    });
    await w.norn("take", "40");
    await w.norn("done", "40", "fixed");
    await w.norn("take", "40");
    await w.norn("done", "40", "ok");

    expect(w.github.labelDefs.get("verifying")).toEqual({ color: "c5def5", description: "a person takes part in this step" });
    expect(w.github.labelDefs.get("patching")).toEqual({ color: "bfd4f2", description: "an agent runs this step unattended" });
  });

  test("a label that is already there is left as it is", async () => {
    const w = bugAt("reproducing");
    await w.github.ensureLabels([{ name: "fixing", color: "000000", description: "ours" }]);
    await w.norn("take", "40");

    await w.norn("done", "40", "reproduced");

    expect(w.github.labelDefs.get("fixing")).toEqual({ color: "000000", description: "ours" });
  });
});

describe("where flows come from", () => {
  test("the flow on the base branch on GitHub runs, not a copy in the working tree", async () => {
    const w = bugAt("reproducing");
    w.workspace.files.set(
      ".agents/flows/bug.json",
      JSON.stringify(bugFlow({ states: { reproducing: { skill: "local-skill", attended: true, outcomes: {} } } })),
    );

    const out = (await w.norn("take", "40")).stdout;

    expect(out).toContain("Invoke the skill: bug-repro\n");
  });

  test("the flow is read from the team's base branch", async () => {
    const w = bugAt("reproducing");
    w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ baseBranch: "develop" }));
    w.github.seedFlow("bug", bugFlow({ states: { reproducing: { skill: "develop-repro", attended: true, outcomes: {} } } }), "develop");

    const out = (await w.norn("take", "40")).stdout;

    expect(out).toContain("Invoke the skill: develop-repro\n");
  });
});

describe("a broken flow", () => {
  test("taking an issue of its type is refused with what is wrong", async () => {
    const w = bugAt("reproducing", {
      ...bugFlow({ start: "triaging" }),
      states: {
        closed: { skill: "x", attended: true, outcomes: {} },
        reproducing: { skill: "bug-repro", attended: true, outcomes: { reproduced: { to: "fixing", means: "on to the fix" } } },
      },
    });

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe(
      [
        "#40 runs the flow bug, which is broken, so norn cannot run it:",
        "  The state closed takes a name norn keeps for itself.",
        "  The outcome reproduced of reproducing leads to fixing, which is not one of its states, closed or not-planned.",
        "  start names triaging, which is not one of its states.",
        "Fix .agents/flows/bug.json on the base branch, then run the command again. Issues of other types are not affected.",
      ].join("\n"),
    );
    expect(w.github.labels(40).sort()).toEqual(["reproducing", "type:bug"]);
    expect(w.github.claim(40)).toBeNull();
  });

  test("a flow that is not JSON is refused", async () => {
    const w = bugAt("reproducing", "{ not json");

    const res = await w.norn("take", "40", "--json");

    expect(res.exitCode).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(false);
    expect(out.refusal).toContain("#40 runs the flow bug, which is broken");
    expect(out.refusal).toContain("  It is not valid JSON: ");
  });

  test("done on an issue of its type is refused too", async () => {
    const w = bugAt("reproducing");
    await w.norn("take", "40");
    w.github.seedFlow("bug", { ...bugFlow(), workspace: "somewhere" });

    const res = await w.norn("done", "40", "reproduced");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('  workspace must be "none" or "own".');
    expect(w.github.labels(40).sort()).toEqual(["in-progress", "reproducing", "type:bug"]);
  });

  test("issues of other types are not affected", async () => {
    const w = bugAt("reproducing", "{ not json");
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan"] });

    const res = await w.norn("take", "123");

    expect(res.exitCode).toBe(0);
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

  test("needs-human is resolved in the flow's state and the issue stays there", async () => {
    const w = bugAt("fixing");
    w.github.issues.get(40)!.labels.push("needs-human");

    const out = (await w.norn("take", "40")).stdout;
    await w.norn("done", "40");

    expect(out).toContain("Invoke the skill: norn-resolve\n");
    expect(w.github.labels(40).sort()).toEqual(["fixing", "type:bug"]);
    expect(w.github.comments(40).at(-1)).toBe("norn: fixing → fixing (needs-human resolved)");
  });

  test("a state with enterAs moves the issue there on take, creating the label", async () => {
    const flow = bugFlow();
    Object.assign(flow.states, {
      queued: { skill: "bug-fix", attended: false, enterAs: "fixing", outcomes: { fixed: { to: "closed", means: "the fix is merged" } } },
    });
    const w = bugAt("queued", flow);

    await w.norn("take", "40");

    expect(w.github.labels(40).sort()).toEqual(["fixing", "in-progress", "type:bug"]);
    expect(w.github.labelDefs.has("fixing")).toBe(true);
  });

  test("an issue with no state of its flow has no step, and is not triaged", async () => {
    const w = bugAt("needs-plan");

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#40 (no state) has no step norn can brief.");
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

describe("triage offers the flows", () => {
  function newIssue() {
    const w = setup();
    w.github.seedFlow("bug", bugFlow());
    w.github.seedIssue({ number: 7, title: "Rate limiting" });
    return w;
  }

  test("the briefing lists story, each flow with its description, and reject", async () => {
    const w = newIssue();

    const out = (await w.norn("take", "7")).stdout;

    expect(out).toContain(
      [
        "  norn done 7 story             (a story: moves to refinement)",
        "  norn done 7 bug               (A defect: reproduce it, fix it, close it.)",
        '  norn done 7 reject "reason"   (closed as not planned; give the reason)',
      ].join("\n"),
    );
  });

  test("choosing a flow gives the issue its type and the flow's start, with a transition comment", async () => {
    const w = newIssue();
    await w.norn("take", "7");

    const res = await w.norn("done", "7", "bug");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("#7 is now in reproducing");
    expect(w.github.labels(7).sort()).toEqual(["reproducing", "type:bug"]);
    expect(w.github.issues.get(7)!.assignees).toEqual(["alice"]);
    expect(w.github.comments(7)).toEqual(["norn: triage → reproducing (bug)"]);
    expect(w.github.labelDefs.has("reproducing")).toBe(true);
    expect(w.github.claim(7)).toBeNull();
  });

  test("the issue then runs the flow it was given", async () => {
    const w = newIssue();
    await w.norn("take", "7");
    await w.norn("done", "7", "bug");

    const out = (await w.norn("take", "7")).stdout;

    expect(out).toContain("Invoke the skill: bug-repro\n");
  });

  test("a flow with its own workspace records the issue's slug on the first transition", async () => {
    const w = setup();
    w.github.seedFlow("bug", bugFlow({ workspace: "own" }));
    w.github.seedIssue({ number: 7, title: "Rate limiting" });
    await w.norn("take", "7");

    await w.norn("done", "7", "bug");

    expect(w.github.comments(7)).toEqual(["norn: triage → reproducing (bug)\n\nnorn: slug rate-limiting"]);
  });

  test("a flow with triage false is not offered, nor is a broken flow", async () => {
    const w = newIssue();
    w.github.seedFlow("chore", bugFlow({ description: "Housekeeping.", triage: false }));
    w.github.seedFlow("spike", "{ not json");

    const out = (await w.norn("take", "7")).stdout;
    const res = await w.norn("done", "7", "chore");

    expect(out).toContain("norn done 7 bug");
    expect(out).not.toContain("chore");
    expect(out).not.toContain("spike");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('"chore" is not an outcome of triage.');
  });

  test("without repository flows, triage offers story and reject only", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7, title: "Rate limiting" });

    const res = JSON.parse((await w.norn("take", "7", "--json")).stdout);

    expect(res.outcomes).toEqual(["story", "reject"]);
  });
});

describe("a flow that changed under issues in progress", () => {
  test("a renamed target that is not a state of the flow fails validation", async () => {
    const w = bugAt("reproducing", bugFlow({ renamed: { verifying: "checking", repro: "reproducing" } }));

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#40 runs the flow bug, which is broken");
    expect(res.stdout).toContain("  renamed moves verifying to checking, which is not one of its states.");
    expect(res.stdout).not.toContain("repro to");
  });

  test("take moves an issue in a renamed state to its new name, with a transition comment, and briefs that state", async () => {
    const w = bugAt("repro", bugFlow({ renamed: { repro: "reproducing" } }));

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Its step is reproducing.");
    expect(res.stdout).toContain("Invoke the skill: bug-repro\n");
    expect(w.github.labels(40).sort()).toEqual(["in-progress", "reproducing", "type:bug"]);
    expect(w.github.comments(40)).toEqual(["norn: repro → reproducing (automatic)\n\nThe flow bug renamed the state repro to reproducing."]);
  });

  /** A bug that norn moved into verifying, a state the bug flow has since dropped. */
  async function leftInVerifying() {
    const w = bugAt("verifying");
    await w.github.comment(40, "norn: fixing → verifying (fixed)");
    return w;
  }

  test("take hands an issue in a removed state to a person, naming the state and the flow", async () => {
    const w = await leftInVerifying();

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe(
      [
        "#40 is in verifying, which the flow bug no longer has, so it now needs a human.",
        "Run norn take 40 to resolve it: a person moves it to a state of the flow.",
      ].join("\n"),
    );
    expect(w.github.labels(40).sort()).toEqual(["needs-human", "type:bug"]);
    expect(w.github.comments(40).at(-1)).toBe("norn: needs-human — the state verifying is no longer in the flow bug");
    expect(w.github.claim(40)).toBeNull();
  });

  test("resolving it moves the issue into the state of the flow a person picks", async () => {
    const w = await leftInVerifying();
    await w.norn("take", "40");

    const out = (await w.norn("take", "40")).stdout;
    const res = await w.norn("done", "40", "fixing");

    expect(out).toContain("Invoke the skill: norn-resolve\n");
    expect(out).toContain("norn done 40 reproducing");
    expect(out).toContain("norn done 40 fixing");
    expect(res.exitCode).toBe(0);
    expect(w.github.labels(40).sort()).toEqual(["fixing", "type:bug"]);
    expect(w.github.comments(40).at(-1)).toBe("norn: verifying → fixing (fixing)");
  });
});
