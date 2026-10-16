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
        behaviours: ["opensPR"],
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
        behaviours: ["countsFixRounds"],
        outcomes: { fixed: { to: "reviewing", means: "the changes are pushed, moves on to review" } },
      },
      verifying: {
        skill: "bug-verify",
        attended: true,
        behaviours: ["humanGate"],
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
  test("a state using a behaviour norn does not know fails validation, naming it", async () => {
    const flow = bugFlow();
    flow.states.reviewing = { ...flow.states.reviewing, behaviours: ["opensPR", "autoMerge"] } as typeof flow.states.reviewing;
    const w = bugAt("fixing", flow);

    const res = await w.norn("take", "40");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("  The state reviewing uses the behaviour autoMerge, which norn does not know.");
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
    expect(res.stdout).toContain("This is rework: the latest comment that sent #40 back lists what to fix.");
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
    const w = bugAt("verifying", bugFlow({ workspace: "none" }));

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
    expect(w.notifications.map((n) => [n.title, n.body.split("\n")[0]])).toEqual([["norn: #40 needs you", "needs human QA (type:bug)"]]);
  });
});
