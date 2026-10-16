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
