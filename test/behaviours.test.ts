import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

/**
 * A bug flow with a PR, a review → fix loop and a human QA gate:
 * fixing opens the PR, review sends it back through changes-requested,
 * and a person QAs it before it closes.
 */
function bugFlow(over: Record<string, unknown> = {}) {
  return {
    description: "A defect: fix it, review it, QA it.",
    start: "fixing",
    workspace: "own",
    states: {
      fixing: {
        skill: "bug-fix",
        attended: false,
        behaviours: { opensPR: {} },
        outcomes: { fixed: { to: "reviewing", means: "the fix is pushed, moves on to review" } },
      },
      reviewing: {
        skill: "bug-review",
        attended: false,
        outcomes: {
          approve: { to: "verifying", means: "the fix is good, a person QAs it" },
          "request-changes": { to: "changes-requested", means: "the fix needs work", note: "what to change" },
        },
      },
      "changes-requested": {
        skill: "bug-fix",
        attended: false,
        enterAs: "fixing",
        behaviours: { countsFixRounds: {} },
        outcomes: { fixed: { to: "reviewing", means: "the changes are pushed, moves on to review" } },
      },
      verifying: {
        skill: "bug-verify",
        attended: true,
        behaviours: { humanGate: {} },
        outcomes: {
          pass: { to: "closed", means: "the bug is gone" },
          fail: { to: "changes-requested", means: "the bug is still there", note: "repro" },
        },
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

describe("behaviours in a flow", () => {
  test("opensPR needs a flow with a workspace of its own", async () => {
    const w = bugAt("fixing", bugFlow({ workspace: "none" }));

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('  The state fixing uses the behaviour opensPR, which needs workspace to be "own" or "parent", for its PR.\n');
  });

  test("a behaviour's parameters are an object, {} for none", async () => {
    const flow = bugFlow();
    flow.states.fixing = { ...flow.states.fixing, behaviours: { opensPR: true } } as unknown as typeof flow.states.fixing;
    const w = bugAt("fixing", flow);

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("  states.fixing.behaviours.opensPR must be an object of parameters, {} for none.\n");
  });

  test("a state using a behaviour norn does not know fails validation, naming it", async () => {
    const flow = bugFlow();
    flow.states.reviewing = { ...flow.states.reviewing, behaviours: { opensPR: {}, autoMerge: {} } } as typeof flow.states.reviewing;
    const w = bugAt("fixing", flow);

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(
      "  The state reviewing uses the behaviour autoMerge, which this norn does not know; a flow written for a newer norn needs the nornVersion pin raised.",
    );
  });
});

describe("opensPR", () => {
  test("the briefing tells the agent to open the PR, or update the one there is", async () => {
    const w = bugAt("fixing");

    const out = (await w.norn("take", "40")).stdout;

    expect(out).toContain("Commit on 40-crash-on-empty-input and push. Open one PR from 40-crash-on-empty-input into main if there is none yet:");
    expect(out).toContain("  gh pr create --base main --head 40-crash-on-empty-input --title 'Crash on empty input' --body 'Closes #40.'");
  });

  test("later states see the PR and its diff, and are not told to open one", async () => {
    const w = bugAt("fixing");
    await w.norn("take", "40");
    const pr = await w.github.createPullRequest({ head: "40-crash-on-empty-input", base: "main", title: "Crash on empty input", body: "Closes #40." });
    await w.norn("done", "40", "fixed");

    const out = (await w.norn("take", "40")).stdout;

    expect(out).toContain(`PR #${pr.number}: 40-crash-on-empty-input into main. Diff: git diff origin/main...HEAD`);
    expect(out).not.toContain("gh pr create");
  });

  test("a state without it, before any PR, gets neither", async () => {
    const w = bugAt("reviewing");

    const out = (await w.norn("take", "40")).stdout;

    expect(out).not.toContain("gh pr create");
    expect(out).not.toContain("Diff:");
  });
});

describe("countsFixRounds", () => {
  /** Review sends #40 back: the issue is in changes-requested, one round in. */
  async function sentBack(w: ReturnType<typeof setup>) {
    await w.norn("take", "40");
    return w.norn("done", "40", "request-changes", "Missing a test for empty arrays");
  }

  test("rework is detected and briefed, and the step runs in the state it enters as", async () => {
    const w = bugAt("reviewing");
    await sentBack(w);

    const res = await w.norn("take", "40");

    expect(w.github.labels(40).sort()).toEqual(["fixing", "in-progress", "type:bug"]);
    expect(res.stdout).toContain("This is rework: the latest review or QA comment on #40 lists what to fix. Read the issue: gh issue view 40 --comments");
  });

  test("rework stays briefed when the issue is taken again in the state it entered as", async () => {
    const w = bugAt("reviewing");
    await sentBack(w);
    await w.norn("take", "40");
    await w.norn("release", "40");

    const out = (await w.norn("take", "40")).stdout;

    expect(out).toContain("This is rework:");
  });

  test("the first time through is not rework", async () => {
    const w = bugAt("fixing");

    const out = (await w.norn("take", "40")).stdout;

    expect(out).not.toContain("This is rework");
  });

  test("reaching maxFixRounds turns the issue into needs-human instead of another round", async () => {
    const w = bugAt("reviewing");
    w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ deliver: { maxFixRounds: 1 } }));
    await sentBack(w);
    await w.norn("take", "40");
    await w.norn("done", "40", "fixed");

    const res = await sentBack(w);

    expect(w.github.labels(40).sort()).toEqual(["changes-requested", "needs-human", "type:bug"]);
    expect(w.github.comments(40).at(-1)).toContain('norn: needs-human — escalated: "Missing a test for empty arrays" (1 fix rounds reached)');
    expect(res.stdout).toContain("#40 has reached 1 fix rounds, so it now needs a human");
  });

  test("every state that counts fix rounds counts toward the same limit", async () => {
    const w = bugAt("reviewing");
    w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ deliver: { maxFixRounds: 1 } }));
    await sentBack(w);
    await w.norn("take", "40");
    await w.norn("done", "40", "fixed");
    await w.norn("take", "40");
    await w.norn("done", "40", "approve");

    await w.norn("take", "40");
    await w.norn("done", "40", "fail", "still crashes on []");

    expect(w.github.labels(40)).toContain("needs-human");
  });
});

describe("humanGate", () => {
  test("the briefing carries the QA evidence and remarks wording", async () => {
    const w = bugAt("verifying");

    const out = (await w.norn("take", "40")).stdout;

    expect(out).toContain(
      "Run the app from 40-crash-on-empty-input on this machine and walk the user through what is left, plus anything in the evidence they question.",
    );
    expect(out).toContain("Tie each remark the user brings to a criterion; a remark on a criterion fails it.");
    expect(out).toContain('  follow up (the default): gh issue create --title "<remark>" --body "From QA of #40: <remark>" (it goes through triage)');
    expect(out).toContain("Every failure needs a repro. Keep screenshots, logs and command output in a directory outside the repository");
    expect(out).toContain('norn done 40 fail "repro" [--evidence <dir>]');
  });

  test("without a workspace, the app runs where the person is", async () => {
    const flow = bugFlow({ workspace: "none" });
    // opensPR needs a workspace of its own.
    delete (flow.states.fixing as { behaviours?: unknown }).behaviours;
    const w = bugAt("verifying", flow);

    const out = (await w.norn("take", "40")).stdout;

    expect(out).toContain("Run the app on this machine and walk the user through what is left");
  });

  test("evidence can be attached when the gate finishes", async () => {
    const w = bugAt("verifying");
    w.workspace.evidence.set("/tmp/qa", [{ path: "crash.png", content: Buffer.from("png") }]);
    await w.norn("take", "40");

    const res = await w.norn("done", "40", "pass", "--evidence", "/tmp/qa");

    expect(res.exitCode).toBe(0);
    expect(w.github.comments(40).at(-1)).toContain("Evidence (");
  });

  test("an outcome into the gate notifies a person and tells the agent to stop", async () => {
    const w = bugAt("reviewing");
    await w.norn("take", "40");

    const res = await w.norn("done", "40", "approve");

    expect(res.stdout).toContain("A person does the next step, so do not take #40 again. norn has notified the user.");
    expect(w.notifications.map((n) => [n.title, n.body.split("\n")[0]])).toEqual([["norn: #40 needs you", "needs human QA (bug)"]]);
  });

  test("a gate's label without a colour of its own gets the human gate's default, not the attended one", async () => {
    const w = bugAt("reviewing");
    await w.norn("take", "40");

    await w.norn("done", "40", "approve");

    expect(w.github.labelDefs.get("verifying")).toEqual({ color: "e99695", description: "a person checks the work here (norn)" });
  });

  test("a gate for mode:afk only notifies with that mode, as one for mode:hil does", async () => {
    const flow = bugFlow();
    Object.assign(flow.states.verifying, { when: "afk", passThrough: "pass" });
    const w = bugAt("reviewing", flow);
    w.github.issues.get(40)!.labels.push("mode:afk");
    await w.norn("take", "40");

    await w.norn("done", "40", "approve");

    expect(w.notifications.map((n) => n.body.split("\n")[0])).toEqual(["needs human QA (mode:afk)"]);
  });
});

describe("notify on an outcome", () => {
  test("notify: true tells a person their step waits, without a human gate", async () => {
    const flow = bugFlow();
    Object.assign(flow.states.reviewing.outcomes.approve, { notify: true });
    Object.assign(flow.states.verifying, { behaviours: {} });
    const w = bugAt("reviewing", flow);
    await w.norn("take", "40");

    const res = await w.norn("done", "40", "approve");

    expect(res.stdout).toContain("A person does the next step, so do not take #40 again. norn has notified the user.");
    expect(w.notifications.map((n) => n.body.split("\n")[0])).toEqual(["needs human QA (bug)"]);
  });

  test("notify is true or false, naming no flow or mode", async () => {
    const flow = bugFlow();
    Object.assign(flow.states.reviewing.outcomes.approve, { notify: "story" });
    const w = bugAt("reviewing", flow);

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("  states.reviewing.outcomes.approve.notify must be true or false.\n");
  });
});

describe("humanGate, resolving needs-human", () => {
  test("an issue that stays at the gate notifies no one again", async () => {
    const w = bugAt("verifying");
    w.github.issues.get(40)!.labels.push("needs-human");
    await w.norn("take", "40");

    const res = await w.norn("done", "40");

    expect(w.github.labels(40).sort()).toEqual(["type:bug", "verifying"]);
    expect(res.stdout).not.toContain("A person does the next step");
    expect(w.notifications).toEqual([]);
  });
});

describe("norn next on an issue of a flow", () => {
  test("a state an agent runs is offered to an agent", async () => {
    const w = bugAt("reviewing");

    const res = await w.norn("next", "40");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(
      [
        'Issue #40 "Crash on empty input" is in reviewing.',
        "",
        "You can start 1 item now, in its own fresh subagent, told to work in the item's worktree:",
        "",
        '  - Issue #40 "Crash on empty input" is in reviewing: reviewing.',
        "    Worktree: /repo/.agents/worktrees/40-crash-on-empty-input",
        "    Start it with: norn take 40",
        "",
        "Each phase gets a new agent. When an item is done, run norn next 40 again.",
      ].join("\n"),
    );
  });

  test("an attended state is offered to do with the user", async () => {
    const flow = bugFlow();
    flow.states.reviewing = { ...flow.states.reviewing, attended: true };
    const w = bugAt("reviewing", flow);

    const out = (await w.norn("next", "40")).stdout;

    expect(out).toContain("You can start 1 item now, with the user:");
    expect(out).toContain('  - Issue #40 "Crash on empty input" is in reviewing: reviewing (attended: the user takes part).');
  });

  test("a human gate is listed for a person, not for an agent", async () => {
    const w = bugAt("verifying");

    const res = await w.norn("next", "40");

    expect(res.stdout).toBe(
      [
        'Issue #40 "Crash on empty input": nothing left that you can do.',
        "Waiting for a human:",
        "  - #40 needs human QA (bug).",
        "Stop here and report to the user. norn has already notified them.",
      ].join("\n"),
    );
  });

  test("an item to start is worded by its state's description in the flow", async () => {
    const flow = bugFlow();
    Object.assign(flow.states.reviewing, { description: "Waiting for a second pair of eyes" });
    const w = bugAt("reviewing", flow);

    const out = (await w.norn("next", "40")).stdout;

    expect(out).toContain('  - Issue #40 "Crash on empty input" is in reviewing: Waiting for a second pair of eyes.');
  });

  test("next moves an issue in a state its flow renamed to the new state, and offers it there", async () => {
    const w = bugAt("triaged", { ...bugFlow(), renamed: { triaged: "reviewing" } });

    const out = (await w.norn("next", "40")).stdout;

    expect(out).toContain("#40 moved from triaged to reviewing: the flow bug renamed the state.");
    expect(out).toContain('  - Issue #40 "Crash on empty input" is in reviewing: reviewing.');
    expect(w.github.labels(40).sort()).toEqual(["reviewing", "type:bug"]);
    expect(w.github.comments(40)).toEqual(["norn: triaged → reviewing (automatic)\n\nThe flow bug renamed the state triaged to reviewing."]);
    expect(w.github.claim(40)).toBeNull();
  });

  test("next hands an issue in a state its flow no longer has to a person", async () => {
    const w = bugAt("testing");
    w.github.commentsByIssue.set(40, ["norn: fixing → testing (fixed)"]);

    const out = (await w.norn("next", "40")).stdout;

    expect(out).toContain("#40 was in testing, which the flow bug no longer has, so it now needs a human.");
    expect(out).toContain("Waiting for a human:\n  - #40 the state testing is no longer in the flow bug.");
    expect(w.github.labels(40).sort()).toEqual(["needs-human", "type:bug"]);
    expect(w.github.comments(40).at(-1)).toBe("norn: needs-human — the state testing is no longer in the flow bug");
    expect(w.github.claim(40)).toBeNull();
  });

  test("an issue in a state its flow no longer has that a session holds waits for a person", async () => {
    const w = bugAt("testing");
    w.github.commentsByIssue.set(40, ["norn: fixing → testing (fixed)"]);
    w.github.claims.set(40, { holder: "bob", session: "bob-1", since: "2026-10-13T11:50:00Z" });

    const out = (await w.norn("next", "40")).stdout;

    expect(out).toContain("  - #40 is in testing, which the flow bug no longer has; taking it hands it to a person.");
  });

  test("a closed issue has nothing left", async () => {
    const w = bugAt("reviewing");
    w.github.issues.get(40)!.state = "closed";

    const out = (await w.norn("next", "40")).stdout;

    expect(out).toBe('Issue #40 "Crash on empty input" is closed. Nothing left that you can do.');
  });
});

/**
 * A task under story #123, in the story's branch: waiting until its blockers
 * close, then doing it with a PR into the story's branch, then merging it.
 */
function taskFlow(over: Record<string, unknown> = {}) {
  return {
    description: "A piece of a story, merged into the story's branch.",
    start: "doing",
    workspace: "parent",
    triage: false,
    states: {
      waiting: {
        skill: "task-do",
        attended: false,
        behaviours: { syncsBlocked: { to: "doing" } },
        outcomes: {},
      },
      doing: {
        skill: "task-do",
        attended: false,
        behaviours: { opensPR: {} },
        outcomes: { done: { to: "merging", means: "the PR is open, moves on to merging" } },
      },
      merging: {
        skill: "task-merge",
        attended: false,
        behaviours: { mergesSlice: {} },
        outcomes: { "": { to: "closed", means: "the PR is merged into the story branch" } },
      },
    },
    ...over,
  };
}

/** Story #123 in implementation with task #140 in `state`, and task #141 waiting on #140. */
function taskAt(state: string, flow: unknown = taskFlow()) {
  const w = setup();
  w.github.seedFlow("task", flow);
  w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
  w.github.seedIssue({ number: 140, title: "Per-key limits", labels: ["type:task", state], assignees: ["alice"] });
  w.github.seedIssue({ number: 141, title: "Docs", labels: ["type:task", "waiting"], assignees: ["alice"] });
  for (const n of [140, 141]) w.github.parents.set(n, 123);
  w.github.blockers.set(141, [140]);
  w.github.branches.add("123-rate-limiting");
  return w;
}

describe("mergesSlice", () => {
  test("needs a flow that works in the parent's branch", async () => {
    const w = taskAt("merging", taskFlow({ workspace: "own" }));

    const res = await w.norn("take", "140");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(
      '  The state merging uses the behaviour mergesSlice, which needs workspace to be "parent", for the PR into the parent\'s branch.\n',
    );
  });

  test("the briefing says how to merge the PR into the parent's branch", async () => {
    const w = taskAt("merging");

    const out = (await w.norn("take", "140")).stdout;

    expect(out).toContain("Merge origin/123-rate-limiting into 123-rate-limiting-140, resolving conflicts if needed, and push.");
    expect(out).toContain("Then merge the PR: gh pr merge 123-rate-limiting-140 --merge");
    expect(out).not.toContain("Task PR:");
  });

  test("done is refused until the PR is merged into the parent's branch", async () => {
    const w = taskAt("merging");
    w.github.prs.push({ number: 50, head: "123-rate-limiting-140", base: "123-rate-limiting", state: "open" });
    await w.norn("take", "140");

    const res = await w.norn("done", "140");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("PR #50 from 123-rate-limiting-140 is not merged yet");
    expect(w.github.issues.get(140)!.state).toBe("open");
  });

  test("resolving needs-human in the state needs no merged PR", async () => {
    const w = taskAt("merging");
    w.github.issues.get(140)!.labels.push("needs-human");
    await w.norn("take", "140");

    const res = await w.norn("done", "140");

    expect(res.exitCode).toBe(0);
    expect(w.github.labels(140).sort()).toEqual(["merging", "type:task"]);
  });

  test("with the PR merged, done closes the issue and leaves its worktree for tidy", async () => {
    const w = taskAt("merging");
    w.github.prs.push({ number: 50, head: "123-rate-limiting-140", base: "123-rate-limiting", state: "merged" });
    await w.norn("take", "140");
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting-140");

    const res = await w.norn("done", "140");

    expect(res.exitCode).toBe(0);
    expect(w.github.issues.get(140)!.state).toBe("closed");
    expect(w.github.labels(140)).toEqual(["type:task"]);
    expect(res.stdout).toContain(".agents/worktrees/123-rate-limiting-140");
  });
});

describe("syncsBlocked", () => {
  test("names a state of the flow to release to", async () => {
    const flow = taskFlow();
    flow.states.waiting.behaviours = { syncsBlocked: { to: "nowhere" } };
    const w = taskAt("doing", flow);

    const res = await w.norn("take", "140");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("  states.waiting.behaviours.syncsBlocked.to must be a state of the flow.\n");
  });

  test("an issue in the state has no step while blocked", async () => {
    const w = taskAt("doing");

    const res = await w.norn("take", "141");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#141 is blocked by #140");
    expect(w.github.labels(141).sort()).toEqual(["type:task", "waiting"]);
  });

  test("closing the last blocker releases the issue to the state syncsBlocked names", async () => {
    const w = taskAt("merging");
    w.github.prs.push({ number: 50, head: "123-rate-limiting-140", base: "123-rate-limiting", state: "merged" });
    await w.norn("take", "140");

    await w.norn("done", "140");

    expect(w.github.labels(141).sort()).toEqual(["doing", "type:task"]);
    expect(w.github.comments(141).at(-1)).toBe("norn: waiting → doing (automatic)\n\nAll blockers are closed.");
  });

  test("norn next on the parent releases an issue whose blockers closed", async () => {
    const w = taskAt("doing");
    w.github.issues.get(140)!.state = "closed";
    w.github.issues.get(140)!.labels = ["type:task"];

    await w.norn("next", "123");

    expect(w.github.labels(141).sort()).toEqual(["doing", "type:task"]);
  });

  test("an issue released whose blocker reopens is blocked again", async () => {
    const w = taskAt("doing");
    w.github.issues.get(141)!.labels = ["type:task", "doing"];

    await w.norn("next", "123");

    expect(w.github.labels(141).sort()).toEqual(["type:task", "waiting"]);
    expect(w.github.comments(141).at(-1)).toBe("norn: doing → waiting (automatic)\n\nBlocked by #140.");
  });
});
