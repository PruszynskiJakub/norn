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
      description: "Blocked",
      behaviours: { syncsBlocked: { to: "ready-for-agent" } },
      outcomes: {},
    },
    "ready-for-agent": { ...implement, color: "0e8a16", description: "Ready for an agent" },
    implementation: { ...implement, color: "1d76db", description: "Being implemented", behaviours: { opensPR: {} } },
    "needs-review": {
      name: "review",
      skill: "norn-review",
      attended: false,
      color: "5319e7",
      description: "Waiting for review",
      outcomes: {
        approve: { to: "needs-qa", means: "no requests, moves on to QA by an agent" },
        "request-changes": { to: "changes-requested", means: "put the requests in the note", note: "requests" },
      },
    },
    "changes-requested": { ...implement, color: "d93f0b", description: "Back for fixes after review", behaviours: { countsFixRounds: {} } },
    "needs-qa": {
      name: "agent QA",
      skill: "norn-auto-qa",
      attended: false,
      evidence: true,
      color: "5319e7",
      description: "Waiting for agent QA",
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
      description: "Waiting for your QA",
      when: "hil",
      passThrough: "pass",
      behaviours: { humanGate: {} },
      outcomes: {
        pass: { to: "merge-queue", means: "the person passes QA, moves to the merge queue" },
        fail: { to: "qa-failed", means: "put the failures with their repros in the note", note: "problems" },
      },
    },
    "qa-failed": { ...implement, color: "d93f0b", description: "Back for fixes after QA", behaviours: { countsFixRounds: {} } },
    "merge-queue": {
      name: "merge",
      skill: "norn-merge",
      attended: false,
      color: "0e8a16",
      description: "Queued to merge",
      behaviours: { mergesSlice: {} },
      outcomes: { "": { to: "closed", means: "slice PR merged into the story branch" } },
    },
  },
};

/** What a story does in both states that fix what review or QA sent back: commit onto the story branch, then review again. */
const fixing = {
  name: "fixing",
  skill: "norn-implement",
  attended: false,
  behaviours: { countsFixRounds: {} },
  outcomes: { "": { to: "needs-review", means: "fixes committed on the story branch, back to review" } },
};

/**
 * A story: refined into a spec, planned, sliced, delivered slice by slice on
 * its own branch, then reviewed, QA'd by an agent and by a person, and merged
 * by its owner. Its description is what triage says of it.
 */
export const STORY_FLOW: Flow = {
  description: "a story: moves to refinement",
  start: "needs-refinement",
  workspace: "own",
  states: {
    "needs-refinement": {
      name: "refinement",
      skill: "norn-refine",
      attended: true,
      color: "c5def5",
      description: "Waiting for refinement",
      behaviours: { writesSpec: { readsIssue: true } },
      outcomes: {
        clear: { to: "needs-plan", means: "no open questions, moves on to planning" },
        questions: { to: "needs-clarification", means: "open questions, moves to clarification" },
      },
    },
    "needs-clarification": {
      name: "clarification",
      skill: "norn-clarify",
      attended: true,
      color: "fbca04",
      description: "Waiting for answers to its open questions",
      behaviours: { writesSpec: { readsIssue: true } },
      outcomes: {
        answered: { to: "needs-plan", means: "all questions answered, moves on to planning" },
        questions: { to: "needs-clarification", means: "questions remain, stays in clarification" },
      },
    },
    "needs-plan": {
      name: "planning",
      skill: "norn-plan",
      attended: true,
      color: "c5def5",
      description: "Waiting for a plan",
      behaviours: { writesSpec: {} },
      outcomes: { "": { to: "needs-slicing", means: "plan is in the spec, moves on to slicing" } },
    },
    "needs-slicing": {
      name: "slicing",
      skill: "norn-slice",
      attended: true,
      color: "c5def5",
      description: "Waiting to be sliced",
      behaviours: { slices: { type: "slice" } },
      outcomes: { "": { to: "implementation", means: "slices created, moves on to implementation" } },
    },
    implementation: {
      skill: "norn-implement",
      attended: false,
      color: "1d76db",
      description: "Being implemented",
      behaviours: { waitsForSlices: { to: "needs-review" } },
      outcomes: {},
    },
    "needs-review": {
      name: "review",
      skill: "norn-review",
      attended: false,
      color: "5319e7",
      description: "Waiting for review",
      outcomes: {
        approve: { to: "needs-qa", means: "no requests, moves on to QA by an agent" },
        "request-changes": { to: "changes-requested", means: "put the requests in the note", note: "requests" },
      },
    },
    "changes-requested": { ...fixing, color: "d93f0b", description: "Back for fixes after review" },
    "needs-qa": {
      name: "agent QA",
      skill: "norn-auto-qa",
      attended: false,
      evidence: true,
      color: "5319e7",
      description: "Waiting for agent QA",
      outcomes: {
        pass: { to: "needs-human-qa", means: "every criterion you could check passed; moves on to QA by a person", note: "evidence" },
        fail: { to: "qa-failed", means: "put the failures with their repros in the note", note: "evidence" },
      },
    },
    "needs-human-qa": {
      name: "human QA",
      skill: "norn-qa",
      attended: true,
      color: "e99695",
      description: "Waiting for your QA",
      behaviours: { humanGate: {} },
      outcomes: {
        pass: { to: "merge-queue", means: "the person passes QA, moves to the merge queue" },
        fail: { to: "qa-failed", means: "put the failures with their repros in the note", note: "problems" },
      },
    },
    "qa-failed": { ...fixing, color: "d93f0b", description: "Back for fixes after QA" },
    "merge-queue": {
      name: "merge",
      skill: "norn-merge",
      attended: true,
      color: "0e8a16",
      description: "Queued to merge",
      behaviours: { waitsForMerge: {} },
      outcomes: {},
    },
  },
};

/** The built-in flows, by name, in the order triage offers them. */
export const BUILT_IN: Record<string, Flow> = { story: STORY_FLOW, slice: SLICE_FLOW };

/** The states of the built-in flows, each once, in the flows' order. */
export const STATES: readonly string[] = [...new Set(Object.values(BUILT_IN).flatMap((flow) => Object.keys(flow.states)))];
