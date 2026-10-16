import type { Flow } from "./flow.js";

/**
 * The flows norn ships, written in the format of a repository's flow files and
 * checked by the same validator. They reproduce norn's process as it was before
 * flows, state for state, so issues in progress need no migration.
 */

/** What a slice does in every state it is implemented in: the same step, entered as implementation. */
const implement = {
  name: "implementation",
  skill: "norn-implement",
  attended: false,
  enterAs: "implementation",
  outcomes: { "": { to: "needs-review", means: "implementation done, PR open" } },
};

/** A slice of a story: implemented on a branch off the story's, reviewed, QA'd and merged into the story branch. */
export const SLICE_FLOW: Flow = {
  description: "A slice of a story: implemented on its own branch, reviewed, QA'd and merged into the story branch.",
  start: "ready-for-agent",
  workspace: "parent",
  triage: false,
  states: {
    blocked: {
      ...implement,
      color: "b60205",
      description: "Has an open native blocked-by relation",
      behaviours: { syncsBlocked: { to: "ready-for-agent" } },
      outcomes: {},
    },
    "ready-for-agent": { ...implement, color: "0e8a16", description: "Unblocked, can be picked up" },
    implementation: { ...implement, color: "1d76db", description: "Story: slices in progress. Slice: implement", behaviours: { opensPR: {} } },
    "needs-review": {
      name: "review",
      skill: "norn-review",
      attended: false,
      color: "5319e7",
      description: "Code review of the slice PR or the story PR",
      outcomes: {
        approve: { to: "needs-qa", means: "no requests, moves on to QA by an agent" },
        "request-changes": { to: "changes-requested", means: "put the requests in the note", note: "requests" },
      },
    },
    "changes-requested": { ...implement, color: "d93f0b", description: "Review asked for changes", behaviours: { countsFixRounds: {} } },
    "needs-qa": {
      name: "agent QA",
      skill: "norn-auto-qa",
      attended: false,
      evidence: true,
      color: "5319e7",
      description: "QA by an agent, with evidence",
      outcomes: {
        pass: {
          to: "needs-human-qa",
          means: "every criterion you could check passed; moves on to QA by a person",
          meansSkipped: "every criterion passed, moves to the merge queue",
          note: "evidence",
        },
        fail: { to: "qa-failed", means: "put the failures with their repros in the note", note: "evidence" },
      },
    },
    "needs-human-qa": {
      name: "human QA",
      skill: "norn-qa",
      attended: true,
      color: "e99695",
      description: "QA by a person, after the agent's",
      when: "hil",
      passThrough: "pass",
      behaviours: { humanGate: {} },
      outcomes: {
        pass: { to: "merge-queue", means: "the person passes QA, moves to the merge queue" },
        fail: { to: "qa-failed", means: "put the failures with their repros in the note", note: "problems" },
      },
    },
    "qa-failed": { ...implement, color: "d93f0b", description: "QA found problems", behaviours: { countsFixRounds: {} } },
    "merge-queue": {
      name: "merge",
      skill: "norn-merge",
      attended: false,
      color: "0e8a16",
      description: "Implementation done, review has no requests, QA passed",
      behaviours: { mergesSlice: {} },
      outcomes: { "": { to: "closed", means: "slice PR merged into the story branch" } },
    },
  },
};

/** The built-in flows, by name. */
export const BUILT_IN: Record<string, Flow> = { slice: SLICE_FLOW };
