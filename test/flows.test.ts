import { describe, expect, test } from "vitest";
import { parseTransitionComment } from "@norn/core";
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

/** The bug flow with its own branch, where fixing opens the PR. */
function prFlow() {
  const flow = bugFlow({ workspace: "own" });
  Object.assign(flow.states.fixing, { behaviours: { opensPR: {} } });
  return flow;
}

/** A task under a story: done on a branch off the story's, then checked. */
function taskFlow(over: Record<string, unknown> = {}) {
  return {
    description: "A piece of a story, merged into the story's branch.",
    start: "doing",
    workspace: "parent",
    triage: false,
    states: {
      doing: {
        skill: "task-do",
        attended: false,
        behaviours: { opensPR: {} },
        outcomes: { done: { to: "checking", means: "the PR is open, moves on to the check" } },
      },
      checking: {
        skill: "task-check",
        attended: false,
        outcomes: { ok: { to: "closed", means: "the PR is merged" } },
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
    expect(res.stdout).toContain('You now hold bug #40 "Crash on empty input". Its step is reproducing.');
    expect(res.stdout.replace(/\s+/g, " ")).toContain("This step is attended");
    expect(res.stdout).toContain("Invoke the skill: bug-repro\n");
    expect(res.stdout).toContain("norn done 40 reproduced");
    expect(res.stdout).toContain("the bug is reproduced, moves on to the fix");
    expect(res.stdout).toContain('norn done 40 cannot-reproduce "<attempts>"');
    expect(w.github.labels(40).sort()).toEqual(["in-progress", "reproducing", "type:bug"]);
  });
});

describe("the flow's workspace", () => {
  test("own: a branch of the issue's own and, with opensPR, one PR from it into the base branch", async () => {
    const w = bugAt("fixing", prFlow());

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
    const w = bugAt("fixing", prFlow());
    w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ baseBranch: "develop" }));
    w.github.seedFlow("bug", prFlow(), "develop");

    const out = (await w.norn("take", "40")).stdout;

    expect(out).toContain("Open one PR from 40-crash-on-empty-input into develop if there is none yet:");
  });

  test("parent: a branch off the parent issue's branch and, with opensPR, one PR into it", async () => {
    const w = setup();
    w.github.seedFlow("task", taskFlow());
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
    w.github.seedIssue({ number: 140, title: "Per-key limits", labels: ["type:task", "doing"], assignees: ["alice"] });
    w.github.parents.set(140, 123);

    const out = (await w.norn("take", "140")).stdout;

    expect(out).toContain("Work in: /repo/.agents/worktrees/123-rate-limiting-140 (branch 123-rate-limiting-140)");
    expect(out).toContain("Spec: .agents/specs/123-rate-limiting/spec.md (story #123)");
    expect(out).toContain("Commit on 123-rate-limiting-140 and push. Open one PR from 123-rate-limiting-140 into 123-rate-limiting if there is none yet:");
    expect(out).toContain("  gh pr create --base 123-rate-limiting --head 123-rate-limiting-140 --title 'Per-key limits' --body 'Part of #123. Task #140.'");
  });

  test("parent: later states see the PR into the parent's branch and its diff", async () => {
    const w = setup();
    w.github.seedFlow("task", taskFlow());
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
    w.github.seedIssue({ number: 140, title: "Per-key limits", labels: ["type:task", "checking"], assignees: ["alice"] });
    w.github.parents.set(140, 123);

    const out = (await w.norn("take", "140")).stdout;

    expect(out).toContain("Task PR: 123-rate-limiting-140 into 123-rate-limiting. Diff: git diff origin/123-rate-limiting...HEAD");
  });

  test("parent: the transition comment links the parent's spec on the parent's branch", async () => {
    const w = setup();
    w.github.seedFlow("task", taskFlow());
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
    w.github.seedIssue({ number: 140, title: "Per-key limits", labels: ["type:task", "doing"], assignees: ["alice"] });
    w.github.parents.set(140, 123);
    w.github.prs.push({ number: 70, head: "123-rate-limiting-140", base: "123-rate-limiting", state: "open" });
    await w.norn("take", "140");

    await w.norn("done", "140", "done");

    expect(w.github.comments(140).at(-1)).toBe(
      "norn: doing → checking (done)\n\nSpec: https://github.com/acme/app/blob/123-rate-limiting/.agents/specs/123-rate-limiting/spec.md",
    );
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
  test("a missing label of the built-in slice flow is created as norn init makes it", async () => {
    const w = setup();
    w.github.seedIssue({ number: 131, labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    await w.norn("take", "131");

    await w.norn("done", "131");

    expect(w.github.labelDefs.get("needs-review")).toEqual({ color: "5319e7", description: "Waiting for review (norn)" });
  });

  test("a transition into a state whose label is missing creates it from the state's colour and description", async () => {
    const flow = bugFlow();
    Object.assign(flow.states.fixing, { color: "d93f0b", description: "an agent fixes the bug" });
    const w = bugAt("reproducing", flow);
    await w.norn("take", "40");

    await w.norn("done", "40", "reproduced");

    expect(w.github.labelDefs.get("fixing")).toEqual({ color: "d93f0b", description: "an agent fixes the bug (norn)" });
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

    expect(w.github.labelDefs.get("verifying")).toEqual({ color: "c5def5", description: "a person takes part in this step (norn)" });
    expect(w.github.labelDefs.get("patching")).toEqual({ color: "bfd4f2", description: "an agent runs this step unattended (norn)" });
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
    w.github.seedFlow(
      "bug",
      bugFlow({ states: { reproducing: { skill: "develop-repro", attended: true, outcomes: { fixed: { to: "closed", means: "fixed" } } } } }),
      "develop",
    );

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
    expect(res.stdout).toContain('  The field workspace must be "none", "own" or "parent".');
    expect(w.github.labels(40).sort()).toEqual(["in-progress", "reproducing", "type:bug"]);
  });

  test("a state from which the issue can never reach closed or not-planned is refused", async () => {
    const flow = bugFlow();
    Object.assign(flow.states, {
      waiting: { skill: "bug-wait", attended: true, outcomes: { again: { to: "looping", means: "wait more" } } },
      looping: { skill: "bug-loop", attended: true, outcomes: { again: { to: "waiting", means: "loop more" } } },
    });
    const w = bugAt("reproducing", flow);

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#40 runs the flow bug, which is broken");
    expect(res.stdout).toContain(
      "  From waiting, no outcome ever leads to closed or not-planned.\n  From looping, no outcome ever leads to closed or not-planned.\n",
    );
  });

  test("behaviours must be an object of behaviour names", async () => {
    const flow = bugFlow();
    Object.assign(flow.states.fixing, { behaviours: ["opensPR"] });
    const w = bugAt("reproducing", flow);

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("  The field behaviours of the state fixing must be an object of behaviour names.\n");
  });

  test("a flow cannot take the name of triage's reject", async () => {
    const w = setup();
    w.github.seedFlow("reject", bugFlow());
    w.github.seedIssue({ number: 40, title: "Crash on empty input", labels: ["type:reject", "reproducing"] });

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#40 runs the flow reject, which is broken");
    expect(res.stdout).toContain("  The name reject is norn's own: triage uses it to close an issue as not planned.\n");
  });

  test("norn next shows its issues as blocked by the flow, with the reason, for a person", async () => {
    const w = bugAt("reproducing", "{ not json");

    const res = await w.norn("next", "40");
    const json = JSON.parse((await w.norn("next", "40", "--json")).stdout);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Waiting for a human:\n  - #40 is blocked by its flow bug, which is broken: It is not valid JSON: ");
    expect(res.stdout).toContain("Fix .agents/flows/bug.json on the base branch.\n");
    expect(res.stdout).not.toContain("Story #40");
    expect(json.nothingLeft).toBe(true);
    expect(json.waiting).toEqual([{ issue: 40, reason: "flow-invalid", detail: expect.stringContaining("is blocked by its flow bug, which is broken") }]);
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
        "  norn done 7 story               (a story: moves to refinement)",
        "  norn done 7 bug                 (A defect: reproduce it, fix it, close it.)",
        '  norn done 7 reject "<reason>"   (closed as not planned; give the reason)',
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

  test("choosing a flow creates its type label when the repository lacks it", async () => {
    const w = newIssue();
    await w.norn("take", "7");

    await w.norn("done", "7", "bug");

    expect(w.github.labelDefs.get("type:bug")).toEqual({ color: "ededed", description: "Runs the bug flow (norn)" });
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

  test("take hands an issue in a removed state to a person, naming the state and the flow, as what it did", async () => {
    const w = await leftInVerifying();

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(
      [
        "#40 was in verifying, which the flow bug no longer has, so it now needs a human. The claim is released.",
        "Do not work on it further. A person picks it up with the norn-resolve skill and moves it to a state of the flow.",
      ].join("\n"),
    );
    expect(w.github.labels(40).sort()).toEqual(["needs-human", "type:bug"]);
    expect(w.github.comments(40).at(-1)).toBe("norn: needs-human — the state verifying is no longer in the flow bug");
    expect(w.github.claim(40)).toBeNull();
  });

  test("take's hand-over is a result in --json, with the state and the flow", async () => {
    const w = await leftInVerifying();

    const json = JSON.parse((await w.norn("take", "40", "--json")).stdout);

    expect(json).toMatchObject({ ok: true, issue: 40, state: "verifying", flow: "bug" });
  });

  test("the hand-over notifies the user, naming the state and the flow", async () => {
    const w = await leftInVerifying();

    await w.norn("take", "40");

    expect(w.notifications).toEqual([
      {
        channel: "os",
        title: "norn: #40 needs you",
        body: "#40 was in verifying, which the flow bug no longer has; move it to a state of the flow\nhttps://github.com/acme/app/issues/40",
      },
    ]);
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

describe("a state for one mode only (when)", () => {
  /** The bug flow where a person verifies the fix, in mode:hil only; verified is the pass-through. */
  function verifiedFlow(verifying: Record<string, unknown> = {}) {
    const flow = bugFlow();
    Object.assign(flow.states.fixing, { outcomes: { fixed: { to: "verifying", means: "the fix is in, a person verifies it" } } });
    Object.assign(flow.states, {
      verifying: {
        skill: "bug-verify",
        attended: true,
        when: "hil",
        passThrough: "verified",
        outcomes: {
          verified: { to: "closed", means: "the fix works" },
          "still-broken": { to: "fixing", means: "back to the fix", note: "what still fails" },
        },
        ...verifying,
      },
    });
    return flow;
  }

  function fixingIn(mode: string | null, flow: unknown = verifiedFlow()) {
    const w = bugAt("fixing", flow);
    w.github.seedIssue({ number: 40, title: "Crash on empty input", labels: ["type:bug", "fixing", ...(mode ? [mode] : [])], assignees: ["alice"] });
    return w;
  }

  test("in afk the state is skipped through its pass-through outcome, with one transition comment saying why", async () => {
    const w = fixingIn("mode:afk");
    await w.norn("take", "40");

    const res = await w.norn("done", "40", "fixed");

    expect(res.exitCode).toBe(0);
    expect(w.github.issues.get(40)!.state).toBe("closed");
    expect(w.github.labels(40).sort()).toEqual(["mode:afk", "type:bug"]);
    expect(w.github.comments(40)).toEqual(["norn: fixing → closed (fixed)\n\nSkipped verifying in mode:afk: it runs in mode:hil only."]);
  });

  test("in hil the state is entered, briefed and runs", async () => {
    const w = fixingIn("mode:hil");
    await w.norn("take", "40");

    await w.norn("done", "40", "fixed");
    const res = await w.norn("take", "40");

    expect(w.github.comments(40)).toEqual(["norn: fixing → verifying (fixed)"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Its step is verifying.");
    expect(res.stdout).toContain("Invoke the skill: bug-verify\n");
    expect(res.stdout).toContain("norn done 40 verified");
  });

  test("an issue with no mode runs the state", async () => {
    const w = fixingIn(null);
    await w.norn("take", "40");

    await w.norn("done", "40", "fixed");

    expect(w.github.labels(40).sort()).toEqual(["type:bug", "verifying"]);
  });

  test("skips follow one another, and the comment names every skipped state", async () => {
    const flow = verifiedFlow({ outcomes: { verified: { to: "signing-off", means: "on to sign-off" } } });
    Object.assign(flow.states, {
      "signing-off": { skill: "bug-sign-off", attended: true, when: "hil", passThrough: "signed", outcomes: { signed: { to: "closed", means: "signed off" } } },
    });
    const w = fixingIn("mode:afk", flow);
    await w.norn("take", "40");

    await w.norn("done", "40", "fixed");

    expect(w.github.comments(40)).toEqual(["norn: fixing → closed (fixed)\n\nSkipped verifying, signing-off in mode:afk: they run in mode:hil only."]);
  });

  test("the skip note is not read back as the outcome's note", async () => {
    const w = fixingIn("mode:afk");
    await w.norn("take", "40");

    await w.norn("done", "40", "fixed", "patched the parser");

    expect(w.github.comments(40)).toEqual(["norn: fixing → closed (fixed)\n\nSkipped verifying in mode:afk: it runs in mode:hil only.\n\npatched the parser"]);
    expect(parseTransitionComment(w.github.comments(40)[0])?.note).toBe("patched the parser");
  });

  test("a pass-through that leaves a state with no way to an end in the other mode fails validation", async () => {
    const w = fixingIn(
      "mode:hil",
      verifiedFlow({ passThrough: "still-broken", outcomes: { "still-broken": { to: "fixing", means: "back" }, verified: { to: "closed", means: "done" } } }),
    );

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(
      "  In mode:afk, where the states for the other mode are passed through, no outcome from fixing ever leads to closed or not-planned.\n",
    );
    expect(res.stdout).not.toContain("from reproducing");
    expect(res.stdout).not.toContain("from verifying");
  });

  test("a when state without a valid pass-through outcome fails validation", async () => {
    const missing = fixingIn("mode:afk", verifiedFlow({ passThrough: undefined }));
    const unknown = fixingIn("mode:afk", verifiedFlow({ passThrough: "approved" }));
    const badMode = fixingIn("mode:afk", verifiedFlow({ when: "sometimes" }));

    const [a, b, c] = [await missing.norn("take", "40"), await unknown.norn("take", "40"), await badMode.norn("take", "40")];

    expect(a.exitCode).toBe(1);
    expect(a.stdout).toContain("  The state verifying runs in one mode only, so passThrough must name one of its outcomes.");
    expect(b.exitCode).toBe(1);
    expect(b.stdout).toContain("  The state verifying passes through approved, which is not one of its outcomes.");
    expect(c.exitCode).toBe(1);
    expect(c.stdout).toContain('  The field when of the state verifying must be "afk" or "hil".');
  });
});

describe("a repository flow named like a built-in one", () => {
  /** A story the team runs its own way: write it up, then close it. */
  function ownStory() {
    return bugFlow({
      description: "Our story: write it up, then ship it.",
      start: "drafting",
      states: {
        drafting: {
          skill: "our-draft",
          attended: true,
          outcomes: { drafted: { to: "closed", means: "the write-up is done" } },
        },
      },
    });
  }

  test("triage offers it with its own description and start", async () => {
    const w = setup();
    w.github.seedFlow("story", ownStory());
    w.github.seedIssue({ number: 7, title: "Rate limiting" });

    const out = (await w.norn("take", "7")).stdout;
    await w.norn("done", "7", "story");

    expect(out).toContain("norn done 7 story               (Our story: write it up, then ship it.)");
    expect(w.github.labels(7).sort()).toEqual(["drafting", "type:story"]);
  });

  test("runs in place of the built-in flow", async () => {
    const w = setup();
    w.github.seedFlow("story", ownStory());
    w.github.seedIssue({ number: 7, title: "Rate limiting", labels: ["type:story", "drafting"], assignees: ["alice"] });

    const out = (await w.norn("take", "7")).stdout;

    expect(out).toContain("Invoke the skill: our-draft\n");
    expect(out).toContain("norn done 7 drafted");
  });

  test("the built-in flow is not consulted: its states are not states of the issue's flow", async () => {
    const w = setup();
    w.github.seedFlow("story", ownStory());
    w.github.seedIssue({ number: 7, title: "Rate limiting", labels: ["type:story", "needs-refinement"], assignees: ["alice"] });

    const out = (await w.norn("take", "7")).stdout;

    expect(out).not.toContain("norn-refine");
    expect(w.github.labels(7)).not.toContain("in-progress");
  });

  test("a repository slice flow replaces the built-in slice flow", async () => {
    const w = setup();
    w.github.seedFlow("slice", taskFlow());
    w.github.seedIssue({ number: 8, title: "Part", labels: ["type:slice", "doing"], assignees: ["alice"] });

    const out = (await w.norn("take", "8")).stdout;

    expect(out).toContain("Invoke the skill: task-do\n");
  });
});
