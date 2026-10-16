import { describe, expect, test } from "vitest";
import { builtInFlow, sliceType } from "@norn/core";
import { setup } from "@norn/testing";

/** A story-like flow: shaped into tasks, then waits for them, then is checked on its own PR. */
function epicFlow(slices: Record<string, unknown> = { type: "task" }) {
  return {
    description: "A larger piece of work, split into tasks.",
    start: "shaping",
    workspace: "own",
    states: {
      shaping: {
        skill: "epic-shape",
        attended: true,
        behaviours: { slices },
        outcomes: { "": { to: "waiting", means: "tasks created, moves on to the tasks" } },
      },
      waiting: {
        skill: "epic-wait",
        attended: false,
        behaviours: { waitsForSlices: { to: "checking" } },
        outcomes: {},
      },
      checking: {
        skill: "epic-check",
        attended: false,
        outcomes: { ok: { to: "closed", means: "the epic PR is merged" } },
      },
    },
  };
}

/** A task of an epic: done on a branch off the epic's. */
function taskFlow() {
  return {
    description: "A piece of an epic.",
    start: "doing",
    workspace: "parent",
    triage: false,
    states: {
      doing: {
        skill: "task-do",
        attended: false,
        behaviours: { opensPR: {} },
        outcomes: { done: { to: "closed", means: "the PR is merged" } },
      },
    },
  };
}

function epicAt(state: string, slices?: Record<string, unknown>) {
  const w = setup();
  w.github.seedFlow("epic", epicFlow(slices));
  w.github.seedFlow("task", taskFlow());
  w.github.seedIssue({ number: 50, title: "Search", labels: ["type:epic", state], assignees: ["alice"] });
  return w;
}

describe("the slices behaviour", () => {
  test("add-slice labels each new slice with the type the behaviour names, in that flow's start state", async () => {
    const w = epicAt("shaping");
    await w.norn("take", "50");

    const res = await w.norn("add-slice", "50", "Index", "--mode", "afk");

    expect(res.exitCode).toBe(0);
    const [task] = w.github.subIssueNumbers(50);
    expect(w.github.labels(task).sort()).toEqual(["doing", "mode:afk", "type:task"]);
  });

  test("add-slice says the state the slice starts in, its flow's start", async () => {
    const w = epicAt("shaping");
    await w.norn("take", "50");

    const res = await w.norn("add-slice", "50", "Index", "--mode", "afk");

    const [task] = w.github.subIssueNumbers(50);
    expect(res.stdout).toBe(`Created slice #${task} "Index" (mode:afk, doing).`);
  });

  test("add-slice creates the labels of the slice's start state and type when the repository lacks them", async () => {
    const w = epicAt("shaping");
    await w.norn("take", "50");

    await w.norn("add-slice", "50", "Index", "--mode", "afk");

    expect(w.github.labelDefs.get("doing")).toEqual({ color: "bfd4f2", description: "an agent runs this step unattended (norn)" });
    expect(w.github.labelDefs.get("type:task")).toEqual({ color: "ededed", description: "Runs the task flow (norn)" });
  });

  test("add-slice is refused outside the state with slices, naming that state", async () => {
    const w = epicAt("checking");
    await w.norn("take", "50");

    const res = await w.norn("add-slice", "50", "Index", "--mode", "afk");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Story #50 is in checking, not shaping.");
    expect(w.github.subIssueNumbers(50)).toEqual([]);
  });

  test("leaving the state needs a slice of the type", async () => {
    const w = epicAt("shaping");
    await w.norn("take", "50");

    const res = await w.norn("done", "50");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Story #50 has no slices yet.");
    expect(w.github.labels(50)).toContain("shaping");
  });

  test("a sub-issue of another type is no slice", async () => {
    const w = epicAt("shaping");
    w.github.seedIssue({ number: 51, labels: ["type:slice", "ready-for-agent"] });
    w.github.parents.set(51, 50);
    await w.norn("take", "50");

    expect((await w.norn("done", "50")).exitCode).toBe(1);
  });

  test("the type must be a flow the repository has", async () => {
    const w = epicAt("shaping", { type: "chore" });
    const res = await w.norn("take", "50");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("The behaviour slices of shaping names the flow chore, which the repository does not have.");
  });

  test("the behaviour needs a type", async () => {
    const w = epicAt("shaping", {});
    const res = await w.norn("take", "50");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("states.shaping.behaviours.slices.type must be a flow's name.");
  });
});

describe("the built-in story flow", () => {
  test("passes the validator, and its slices are of the built-in slice type", () => {
    const story = builtInFlow("story");
    expect(story?.ok).toBe(true);
    expect(story?.ok && sliceType(story.flow)).toBe("slice");
  });
});

describe("the waitsForSlices behaviour", () => {
  test("entering it creates the issue's own branch on GitHub, for its slices to branch off", async () => {
    const w = epicAt("shaping");
    await w.norn("take", "50");
    await w.norn("add-slice", "50", "Index", "--mode", "afk");

    const res = await w.norn("done", "50");

    expect(res.exitCode).toBe(0);
    expect(w.github.labels(50)).toContain("waiting");
    expect(w.github.branches.has("50-search")).toBe(true);
    expect(res.stdout).toContain("Created the story branch 50-search.");
  });

  test("an issue waiting for its slices has no step", async () => {
    const w = epicAt("waiting");
    const res = await w.norn("take", "50");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Story #50 is in waiting. Its label follows its slices");
  });

  test("once every slice is merged, norn next opens the PR and moves the issue on", async () => {
    const w = epicAt("waiting");
    w.github.branches.add("50-search");
    w.github.seedIssue({ number: 51, title: "Index", state: "closed", labels: ["type:task"] });
    w.github.parents.set(51, 50);

    await w.norn("next", "50");

    expect(w.github.labels(50)).toContain("checking");
    expect(w.github.labels(50)).not.toContain("waiting");
    const pr = w.github.prs.find((p) => p.head === "50-search")!;
    expect(pr.base).toBe("main");
    expect(w.github.comments(50).at(-1)).toContain("norn: waiting → checking (automatic)");
    expect(w.github.comments(50).at(-1)).toContain(`Every slice is merged into 50-search. Epic PR: #${pr.number}.`);
  });

  test("norn next says the state the issue moved on to, as its flow names it", async () => {
    const w = epicAt("waiting");
    w.github.branches.add("50-search");
    w.github.seedIssue({ number: 51, title: "Index", state: "closed", labels: ["type:task"] });
    w.github.parents.set(51, 50);

    const res = await w.norn("next", "50");

    expect(res.stdout).toContain("Every slice is merged. Story #50 is now in checking.");
  });

  test("is not entered while a slice is open", async () => {
    const w = epicAt("waiting");
    w.github.seedIssue({ number: 51, title: "Index", labels: ["type:task", "doing"] });
    w.github.parents.set(51, 50);

    await w.norn("next", "50");

    expect(w.github.labels(50)).toContain("waiting");
  });
});

describe("the waitsForMerge behaviour", () => {
  function releaseAt() {
    const w = setup();
    w.github.seedFlow("release", {
      description: "A release, merged by its owner.",
      start: "shipping",
      workspace: "own",
      states: { shipping: { skill: "release-ship", attended: true, behaviours: { waitsForMerge: {} }, outcomes: {} } },
    });
    w.github.seedIssue({ number: 60, title: "Ship it", labels: ["type:release", "shipping"], assignees: ["alice"] });
    return w;
  }

  test("an issue waiting for its owner to merge has no step", async () => {
    const res = await releaseAt().norn("take", "60");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Story #60 is in shipping. Only the story owner (@alice) merges the story PR;");
  });

  test("norn next closes it once its PR is merged", async () => {
    const w = releaseAt();
    w.github.prs.push({ number: 61, head: "60-ship-it", base: "main", state: "merged" });

    await w.norn("next", "60");

    expect(w.github.issues.get(60)?.state).toBe("closed");
    expect(w.github.labels(60)).not.toContain("shipping");
    expect(w.github.comments(60).at(-1)).toBe("norn: shipping → closed (automatic)\n\nThe release PR #61 is merged into main.");
  });
});
