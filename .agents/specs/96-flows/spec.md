# Flows: configurable processes per repository

Issue: #96

## Problem Statement

norn has one process, and it is hardcoded. Every issue goes through the same states and steps (triage, refinement, clarification, planning, slicing, then implement, review, QA and merge per slice), whatever the kind of work. A team can't skip steps that a small bug fix doesn't need, add steps of its own such as a security review, or run different kinds of work through different processes.

The process is also spread through norn itself. One function decides the step for every state, but state names are also spelled out by hand in the transitions, the special cases of `done` and `add-slice`, `next`, the briefings, the feed, the label definitions in `init` and `doctor`, the dashboard's wording and pipeline, the docs and some skills. The docs say the labels "are not configurable". Even a small change to the process means changing norn.

## Solution

The process becomes data that a team owns, kept per repository and versioned with its code.

- **A flow is the process for one issue.** It's a JSON file, `.agents/flows/<name>.json`, that declares the flow's states. Each state names the skill that runs it, whether it is attended, and the outcomes it can end with, where each outcome is a word, what it means, and the state it leads to.
- **A type is a flow.** An issue labelled `type:<name>` runs the flow `<name>`. Triage, which runs before any flow, chooses the type. norn offers triage one outcome per available flow, so `norn done bug` routes the issue into the `bug` flow. Slices get their type from the flow of the story that creates them.
- **Today's process becomes the built-in `story` and `slice` flows**, written in the same format. A repository can replace either one with a file of the same name, or add new flows alongside them.
- **norn's built-in mechanics become behaviours** that a state opts into, such as creating slices, waiting for them, opening a PR, merging a slice, counting fix rounds, a human gate and releasing blocked issues. They form a closed set: flows are pure data with no scripts, and anything custom happens inside a skill.
- **Flows are read from the base branch on GitHub.** A change to a flow takes effect once it's merged, and everyone, including a future hosted norn, runs the same process. norn validates every flow strictly. A broken flow stops only the issues of its own type.
- **Issues already in progress follow the current flow.** An issue left in a state that a flow no longer has is handed to a person through `needs-human`, unless the flow declares where that state was renamed to.
- **The dashboard reads the flows.** Its wording, pipeline and colours come from each issue's flow, and a new read-only Flows page draws each flow as a graph.

## User Stories

### Defining flows

1. As a team lead, I want to define my repository's process in a file committed with the code, so that changes to the process are reviewed and versioned like any other change.
2. As a team lead, I want one file per flow in `.agents/flows/`, named after the flow, so that each flow's diff is small and its name is obvious.
3. As a team lead, I want flows written in JSON with a published JSON Schema, so that my editor autocompletes fields and flags mistakes as I type.
4. As a team lead, I want to declare states of my own, such as `security-review`, so that my process can contain steps norn doesn't ship.
5. As a team lead, I want each state to name the skill that runs it, so that I can plug my own skills into the process.
6. As a team lead, I want each state to say whether it is attended, so that norn knows whether a person drives it or an agent runs it unattended.
7. As a team lead, I want each state to list its outcomes as objects, each with a word, a meaning, a target state, and optionally a required note, `needsHuman` and `notify`, so that the agent knows exactly which word to say and norn knows where it leads.
8. As a team lead, I want `closed` and `not-planned` available as targets in every flow, and reserved so no state can take those names, so that every flow can end the same way.
9. As a team lead, I want a flow to name its `start` state, so that norn knows where an issue enters the flow after triage.
10. As a team lead, I want a flow-level `description`, so that triage and the dashboard can explain what the flow is for.
11. As a team lead, I want an optional `description` on each state, so that the dashboard and the state's label explain what the state means.
12. As a team lead, I want an optional `color` on each state, so that its GitHub label and dashboard dot use our colour.
13. As a team lead, I want to opt a state into built-in behaviours by name, so that I get norn's mechanics, such as slicing, PRs, merging, fix rounds and human gates, without writing them myself.
14. As a team lead, I want flows to have no scripts or hooks, so that a flow is safe to read, validate and run anywhere, a hosted norn included.
15. As a team lead, I want custom logic to live in skills, so that there is one place for "how" and the flow stays a description of "what".
16. As a team lead, I want to choose per flow where the work happens (no branch, its own branch with a PR into the base branch, or its own branch with a PR into the parent's branch), so that a bug fix, a story and a slice each get the right branches and PRs.
17. As a team lead, I want a state to apply only in one mode (`when: hil` or `when: afk`), with a designated pass-through outcome taken automatically in the other mode, so that one flow serves both attended and unattended work.
18. As a team lead, I want to mark a flow as not offered by triage, so that a flow like `slice`, which only slicing should create, is never picked for a new issue.
19. As a team lead, I want to declare that an old state was renamed to a new one, so that issues sitting in the old state move automatically when I rename it.

### Built-in flows

20. As a team lead, I want today's process to be the built-in `story` and `slice` flows, so that nothing changes for my repository until I add or change a flow.
21. As a team lead, I want the built-in flows written in the same JSON format as mine, so that I can read exactly what they do and use them as a model.
22. As a team lead, I want to replace a built-in flow completely by adding a file with its name, so that I can change how our stories work.
23. As a team lead, I want a replaced flow to be used as written, with no merging with the built-in, so that what runs is exactly what is in the file.
24. As a team lead, I want `norn flows export <name>` to write a built-in flow into `.agents/flows/`, so that I can start from today's process instead of a blank file.
25. As a developer on a repository with no flow files, I want norn to behave exactly as it does today, so that upgrading norn changes nothing.

### Choosing a flow

26. As a person triaging, I want triage to offer one outcome per available type, each with that flow's description, so that I can pick the type, such as story or bug, with a single outcome word.
27. As a person triaging, I want `reject` to stay available beside the types, so that I can still close an issue as not planned.
28. As a skill author, I want the triage skill to know nothing about types, with norn injecting them into the briefing as outcomes, so that the skill stays norn-agnostic.
29. As a developer, I want the issue's flow recorded as its `type:<name>` label, so that GitHub stays the only state and anyone can see and filter by it.
30. As a developer, I want to change an issue's flow by changing its type label, so that a person can re-route work without new commands.
31. As a team lead, I want the slicing state of a story flow to name the type its slices get, so that slices of different stories can run different flows.
32. As an agent slicing a story, I want `norn add-slice` to label each new slice with the type its story's flow names, so that the slice starts in the right flow.
33. As a developer, I want the `norn done` interface unchanged, so that agents and humans still pick only an outcome word and never name a state or a flow.

### Running issues through flows

34. As an agent, I want `norn take` to brief me with the skill, the workspace and the outcomes of my issue's current state in its flow, so that a custom state is briefed as fully as a built-in one.
35. As an agent, I want norn's briefing to include the lines each behaviour of the state contributes (how to add slices, the rework context on a fix round, the PR and its diff, the QA evidence rules), so that I get the process mechanics without the skill knowing them.
36. As an agent, I want the briefing's branch, worktree, PR and diff lines to come from the flow's workspace setting, so that they are right for stories, slices and bugs alike.
37. As an agent, I want `norn done <word>` to move the issue to the state the outcome names in its flow, so that the transition is decided by the flow.
38. As an agent, I want the behaviours of the state I'm entering or leaving to run as part of `done`, such as checking slices exist, requiring a merged PR or counting a fix round, so that the built-in guarantees still hold in custom flows.
39. As a developer, I want the fix-round limit to still turn an issue into `needs-human` in any state that counts fix rounds, so that a custom flow can't loop forever.
40. As a developer, I want issues blocked by other issues to be released automatically to the state their flow's `syncsBlocked` behaviour names, so that dependency handling works in custom flows.
41. As a developer, I want a story's waiting state to promote it automatically when its slices are done, through the `waitsForSlices` behaviour, so that this works in any story-like flow.
42. As a developer working afk, I want states marked `when: hil` skipped with a transition comment saying why, so that the history shows the skipped step.
43. As a developer, I want `needs-human` to keep working in every state of every flow, routing the issue to `norn-resolve` and back, so that any step can call for a person when something goes wrong.
44. As a developer, I want claims and `in-progress` to work the same in every flow, so that two agents never take the same issue.
45. As a developer, I want `norn next` to split work between people and agents from each state's `attended` flag and human gate, so that custom states show up on the right list.

### Validation

46. As a team lead, I want norn to check every flow strictly (the schema, the start state, every target, that every state can reach an end, known behaviours and allowed combinations, a pass-through outcome for every `when`, existing slice types, no reserved names), so that a broken flow is caught before it misroutes work.
47. As a developer, I want a broken flow to stop only the issues of its own type, with the error, so that one mistake doesn't block the whole team.
48. As a person triaging, I want a broken flow left out of triage's outcomes, so that no new issue is routed into it.
49. As a developer, I want `norn next` and the dashboard to show the issues of a broken flow as blocked by it, so that I know why they're not moving.
50. As a team lead, I want `norn doctor` to report every problem in every flow, including the skills and labels that need checking on GitHub, so that I see them all at once.
51. As a team lead editing a flow locally, I want `norn doctor` to also validate my uncommitted flow files, so that I can check a change before I open its PR.
52. As a team lead, I want a flow that uses a behaviour my pinned norn doesn't know to fail validation, so that the version pin protects us from flows written for a newer norn.

### Flow source and changes

53. As a developer, I want norn to read flows from the base branch on GitHub, so that every person, agent and worktree runs the same process.
54. As a team lead, I want a flow change to take effect only once its PR is merged, so that the process is reviewed before it applies.
55. As a developer, I want issues already in progress to follow the current flow from their next step, so that improvements apply right away without migrating anything.
56. As a developer, I want an issue whose state no longer exists in its flow to get `needs-human` with a comment naming the missing state, so that a person decides where it goes.
57. As a developer, I want issues in a renamed state to move to the new name automatically with a transition comment, so that a rename doesn't stop work.
58. As a team lead, I want `norn doctor` to list the open issues my local flow edit would orphan, so that I see the impact before merging.

### Labels

59. As a team lead, I want the labels for my flows' states and types created for me, so that adding a flow needs no manual label setup.
60. As a developer, I want a transition into a state whose label is missing to create the label first, so that a merged flow works without running `init`.
61. As a team lead, I want `norn init` and `norn doctor` to create or report the labels of all valid flows up front, so that I can prepare the repository in one go.
62. As a team lead, I want a label's colour and description to come from its state, or from a default by kind (attended, agent or human gate), so that labels look consistent.
63. As a team lead, I want labels of removed states left in place and only listed by `doctor`, so that closed issues keep their history.

### Dashboard

64. As a dashboard user, I want an issue's state shown with its flow's wording, so that custom states read as well as the built-in ones.
65. As a dashboard user, I want an issue's pipeline drawn from its flow, so that I see where it is in the process it actually runs.
66. As a dashboard user, I want state colours to come from the flow or the state's kind, so that custom states fit the existing visual language.
67. As a team lead, I want a Flows page listing my repository's flows, each marked built-in or overridden and valid or invalid with its errors, so that I can see the process at a glance.
68. As a team lead, I want each flow drawn as a graph of states and outcome arrows, with behaviours and `when` marked, so that I can understand a flow without reading its JSON.

## Implementation Decisions

- **The flow format.** One JSON file per flow, `.agents/flows/<name>.json`, where the file name is the flow name and the type name. norn ships a JSON Schema for it. The fields are:
  - top level: `description`, `start`, `workspace` (`none` | `own` | `parent`), `triage` (default true) and an optional `renamed` map from old state to new state;
  - `states`: a map from state name to `{ skill, attended, enterAs?, description?, color?, when?, behaviours?, outcomes }`;
  - outcomes: a map from outcome word to `{ to, means, note?, needsHuman?, notify? }`, always an object, with `means` required;
  - a state with `when` designates which of its outcomes is the pass-through.

  The exact field names may be refined in planning, but the shape is decided. The shape is today's `Step` and `Outcome` types moved into data. There is no `instructions` field: skills carry the "how".
- **Reserved targets.** `closed` and `not-planned` are targets in every flow, and no state may use those names.
- **Behaviours** form a closed set built into norn, each with optional parameters. Each one contributes its checks to `done`, its automatic follow-ups and its briefing lines. The initial set, extracted from today's special cases, is:
  - `slices` (requires slices before leaving; names the slice type; `add-slice` is allowed only here);
  - `waitsForSlices` (replaces today's story promotion and opens the story PR);
  - `opensPR`;
  - `mergesSlice` (requires a merged PR);
  - `countsFixRounds` (the limit leads to `needs-human`);
  - `humanGate`;
  - `syncsBlocked` (names the state it releases to).

  The machine's if-chain, the special cases keyed by state name in `done`, `add-slice`, the refusals, `next` and `feed`, and the briefing's branching by skill name are all replaced by looking up the issue's flow and state and asking that state's behaviours.
- **Workspace.** It's a flow-level setting and replaces the branching on story and slice for branches, PR targets and diffs:
  - `none`: no branch.
  - `own`: a branch and a PR into the base branch, created when the issue first needs a workspace. This replaces today's story-branch creation on entering implementation.
  - `parent`: a branch and a PR into the parent issue's branch.
- **Engine-wide, outside flows:**
  - triage, as the entry step for issues with no type;
  - `needs-human` and `norn-resolve`;
  - claims and `in-progress`;
  - the `mode:afk|hil` label, as a property of the issue that `when` reads.
- **Triage.** Its outcomes are generated: one per valid flow with `triage` not false, with the flow's `description` as `means` and the issue's next state being that flow's `start`, plus `reject`. Accepting adds `type:<name>`, which replaces today's hardcoded `type:story`. The triage skill is unchanged and knows nothing about types.
- **Built-in flows.** `story` and `slice` ship as JSON inside the core package and pass through the same validator. A repository file with the same name replaces a built-in completely. The built-in `story` has an unconditional human gate. The built-in `slice` has its human QA state with `when: hil`. Together they reproduce today's states, labels and transitions exactly, so issues in progress need no migration on upgrade.
- **Flow source.**
  - Flows are read from the base branch on the remote through the GitHub port, which gains a read-only "read a file at a ref" query. The `gh` adapter implements it and the fake GitHub simulates it.
  - Config keeps being read locally. Only flows come from the remote, because they are the team's process.
  - Whether to cache flow reads within a command is left to planning.
- **Loading and validation.** A flow registry loads the built-in flows and the repository's flows, validates each, and resolves an issue's flow from its type label.
  - An invalid flow is kept with its errors. Commands on issues of that type refuse with them. Triage leaves the flow out. `next` and the read model mark those issues as blocked by an invalid flow.
  - Unknown behaviours fail validation. A flow using a behaviour introduced in a newer norn is caught that way, together with the `nornVersion` pin.
- **Changes to a flow while issues are in progress.** There is no flow versioning.
  - If an issue's state is missing from its flow, `renamed` is followed when it applies: a transition comment is written and the label is swapped.
  - Otherwise the issue gets `needs-human` with a comment naming the missing state and the flow.
- **Labels.**
  - Label definitions are derived from all valid flows: every state, plus `type:<flow>` for each flow. A state's `color` and `description` are used, with defaults by kind.
  - The transition code creates a missing target label before adding it.
  - `init` creates all of them and `doctor` checks them.
  - Labels are never deleted. `doctor` lists labels that no flow uses as a warning.
- **New command.** `norn flows export <name>` writes a built-in flow to `.agents/flows/<name>.json`. It refuses if the file exists.
- **`doctor`.**
  - A new flows check validates the flows on the remote and the local working copy, and reports the slice types, the skills each flow names and the missing labels.
  - It lists the open issues that the local copy would orphan.
  - It never changes anything.
- **Dashboard.**
  - The server contract includes the repository's flows, with their validity and errors, and each issue's flow name.
  - The UI derives wording from the state's `description`, falling back to its name. The pipeline is the path from `start` to `closed`, following each state's first outcome. Colours come from `color` or the state's kind.
  - A new read-only Flows page lists the flows and draws each one as a graph.
  - The hardcoded wording switch, the slice pipeline and the dot mapping go away.
- **Skills and docs.**
  - Skills that name states are reworded around behaviours, e.g. `norn-deliver` stops at a human gate, not at `needs-human-qa`.
  - The docs drop "labels are not configurable" and gain a flows page: the format, the behaviours, the workspace modes, `when`, overrides, validation and migration.
  - `CONTEXT.md` gains Flow, Behaviour and Workspace, and redefines Type.
- **Slicing (suggested).**
  1. The flow format, the validator, the built-in `story` and `slice` as JSON, and the engine driven by flows and behaviours, with built-in flows only and every existing test unchanged.
  2. Repository flows read from the base branch: the GitHub port query, the registry with overrides, type equals flow, generated triage outcomes, the scoped refusal, and on-demand labels.
  3. Workspace modes and `when` with pass-through, proven with a `bug` flow (`own` workspace, no slicing).
  4. Orphans and `renamed`.
  5. `doctor`'s flows check with the impact preview, `flows export`, the JSON Schema, and the docs and skills rewording.
  6. Dashboard: the data-driven wording, pipeline and colours, and the Flows page.

## Testing Decisions

- **What a good test is here.** Tests drive norn the way a user does, through commands, and assert on output, exit codes and GitHub state (labels, comments, sub-issues). They never assert on the registry, the validator or behaviour internals directly. A test describes a repository's flows and an issue, runs a command, and checks what norn answered and changed.
- **The main seam** is the existing harness (`setup()` and `w.norn(...)` with the fake GitHub and fake workspace). The fake GitHub gains seeding of files at the base branch, so a test can seed `.agents/flows/<name>.json`. It covers:
  - `take`, `done` and briefings in custom flows, and the behaviours' checks, follow-ups and briefing lines;
  - triage's generated outcomes, and `type:` assignment by triage and by `add-slice`;
  - `when` skips in afk and hil;
  - workspace modes;
  - invalid flows: the scoped refusal, triage omission and `next` marking;
  - orphans, `renamed` and on-demand label creation;
  - `doctor`'s flows check and impact preview, and `flows export`.
- **Today's process is the regression suite.** `characterization.test.ts`, `story-flow.test.ts`, `slice-flow.test.ts` and the other existing tests must pass unchanged against the built-in flows. Any change to the characterization snapshot needs a stated reason.
- **The GitHub adapter** gets a test for the new "read a file at a ref" query, alongside the existing adapter tests.
- **The dashboard** is tested at the server contract (flows, validity, each issue's flow) in the existing web-server tests. The UI keeps its existing test level.
- **Prior art:**
  - `story-flow.test.ts`, `slice-flow.test.ts`, `review-qa.test.ts`, `fix-rounds.test.ts` and `merge.test.ts`, for flows through commands;
  - `config.test.ts`, for problems surfaced through commands;
  - `doctor.test.ts` and `init.test.ts`, for doctor checks and files written;
  - `briefing-process.test.ts`, for briefing lines;
  - `gh-adapter.test.ts` and `web-server.test.ts`.

## Out of Scope

- The visual flow editor in the dashboard (a follow-up issue).
- Editing flows from the dashboard in any form.
- Flow versioning, or pinning an issue to the flow it started in.
- Custom behaviours, scripts or hooks in flows.
- Per-state `instructions` text in flows.
- Mapping GitHub issue types or other labels to flows automatically.
- Per-flow or per-state settings such as `maxFixRounds` or `staleAfter`. They stay global; a per-state limit on `countsFixRounds` may come later.
- Partial overrides or inheritance between flows.
- Deleting labels of removed states.
- A hosted norn itself. This work only keeps one possible: flows are pure data read through the GitHub port.

## Further Notes

- The decisions come from a design interview. The main ones:
  - a type is a flow;
  - triage sits outside flows and its outcomes are generated;
  - behaviours are a closed set;
  - there is no `instructions` field;
  - the workspace is set per flow;
  - mode is a property of the issue, read by `when`;
  - flows are read from the base branch;
  - there is no flow versioning, and orphans go to `needs-human`;
  - a broken flow stops only its own type.
- Assumptions made during the interview, open to correction in planning:
  - `maxFixRounds` and `staleAfter` stay global;
  - `next`'s split between people and agents comes from `attended` and `humanGate`;
  - skills and docs that name states are reworded;
  - no migration is needed on upgrade;
  - flows ship in a minor version bump under the `nornVersion` pin.
- #96 is the umbrella. The visual editor and anything beyond the migration described here become follow-up issues.
