# Flows

A flow is the process for one type of issue, as data: its states, the skill and outcomes of each, where it starts and where its work happens. An issue labelled `type:<name>` runs the flow `<name>`. norn ships two flows, `story` and `slice` (see [how it works](how-it-works.md#story-flow)), and a repository adds its own in `.agents/flows/<name>.json`, or replaces a built-in one. The terms (flow, type, behaviour, workspace, orphaned issue) are defined in [`CONTEXT.md`](../CONTEXT.md).

- [Where flows live](#where-flows-live)
- [The format](#the-format)
- [Workspace](#workspace)
- [Behaviours](#behaviours)
- [Mode-conditional states: `when`](#mode-conditional-states-when)
- [Triage and types](#triage-and-types)
- [Replacing a built-in flow](#replacing-a-built-in-flow)
- [Labels](#labels)
- [Validation](#validation)
- [Changing a flow under issues in progress](#changing-a-flow-under-issues-in-progress)

## Where flows live

A flow is a JSON file, `.agents/flows/<name>.json`; the file name is the flow's name and its type. norn reads flows from the base branch on GitHub, never from the working tree, so a change to a flow takes effect once it is merged, and everyone runs the same process. `norn doctor` also checks the flow files in your working copy, so you can try a change before you open its PR (see [validation](#validation)).

## The format

```json
{
  "$schema": "https://raw.githubusercontent.com/PruszynskiJakub/norn/main/schema/flow.schema.json",
  "description": "A defect: reproduce it, fix it, close it.",
  "start": "reproducing",
  "workspace": "own",
  "states": {
    "reproducing": {
      "skill": "bug-repro",
      "attended": true,
      "outcomes": {
        "reproduced": { "to": "fixing", "means": "the bug is reproduced, moves on to the fix" },
        "cannot-reproduce": { "to": "not-planned", "means": "no repro; give what you tried", "note": "attempts" }
      }
    },
    "fixing": {
      "skill": "bug-fix",
      "attended": false,
      "color": "d93f0b",
      "description": "an agent fixes the bug",
      "behaviours": { "opensPR": {} },
      "outcomes": { "fixed": { "to": "verifying", "means": "the fix is pushed, a person checks it" } }
    },
    "verifying": {
      "skill": "bug-verify",
      "attended": true,
      "behaviours": { "humanGate": {} },
      "outcomes": {
        "pass": { "to": "closed", "means": "the bug is gone" },
        "fail": { "to": "changes-requested", "means": "the bug is still there", "note": "repro" }
      }
    },
    "changes-requested": {
      "skill": "bug-fix",
      "attended": false,
      "enterAs": "fixing",
      "behaviours": { "countsFixRounds": {} },
      "outcomes": { "fixed": { "to": "verifying", "means": "the fix is pushed, a person checks it again" } }
    }
  }
}
```

The top level:

- `description` says what the flow is for; triage offers the flow with it. `start` names the state an issue enters the flow in.
- `workspace` says where the work happens, `none`, `own` or `parent` (see [workspace](#workspace)).
- `triage`, `true` by default: with `false`, triage does not offer the flow, e.g. for slices, which only a story's slicing creates.
- `renamed`, optional, maps an old state name to its new one (see [changing a flow](#changing-a-flow-under-issues-in-progress)).
- `$schema`, optional, points an editor at norn's [JSON Schema](#validation).

Each state names the `skill` that runs it, whether it is `attended` (a person takes part), and its `outcomes`. Optional fields:

- `name`: the step's name in the briefing, the state's name by default, e.g. `agent QA`.
- `enterAs`: the state the issue moves to when the step is taken, e.g. `ready-for-agent` enters as `implementation`.
- `evidence`: the step may attach evidence files with `norn done --evidence <dir>`. An agent's step with `evidence` is QA: its briefing says the note is the evidence pack, and whether a person checks the work after it, in the issue's mode, or nobody does and what cannot be checked is escalated.
- `behaviours`: the built-in mechanics the state opts into (see [behaviours](#behaviours)).
- `when` and `passThrough`: the only mode the state runs in (see [`when`](#mode-conditional-states-when)).
- `color` (hex without the `#`) and `description`: the state's label. The dashboard words the state with its `description` (its name without one) and colours it with its `color` (a default by kind without one: attended, agent or human gate).

Each outcome, keyed by its word, has a target `to` and what it `means`, the line the briefing gives it. `to` is a state of the flow, `closed` or `not-planned`; those two close the issue. The empty word `""` is the single way a step ends when it has only one. Optional fields: `note`, which makes `norn done` require a note and names it, e.g. `reason`; `needsHuman`, which sets `needs-human` after the transition, saying who must do what; `notify` (`story` or `mode:hil`), which tells a person their QA is waiting; and `meansSkipped`, what the outcome means instead when the issue's mode skips the state it leads to.

`needs-human`, claims and `in-progress` are norn's own and work in every flow as they do for stories and slices.

## Workspace

`workspace` says where the work happens:

- `none`: no branch. The briefing names no branch or worktree.
- `own`: a branch of the issue's own, named from its slug like a story's, and one PR into the base branch.
- `parent`: a branch off the parent issue's branch, named like a slice's (`<parent>-<parent slug>-<n>`), and one PR into the parent's branch. The briefing names the parent's spec, which transition comments link too.

The briefing names the branch and the worktree; the PR command comes from the `opensPR` behaviour. Some behaviours need a workspace, e.g. `writesSpec` needs `own`.

## Behaviours

A state opts into norn's built-in mechanics by naming its behaviours, each with an object of its parameters, `{}` when it takes none: `"behaviours": { "opensPR": {} }`. Each one adds its lines to the briefing, its say on `norn done`, and its follow-ups. The set is closed: a flow names behaviours, it cannot define them.

| Behaviour | What it does |
| --- | --- |
| `opensPR` | The state's briefing says to commit, push and open the issue's PR into the base branch, or the parent's branch, if there is none yet. Once the PR exists, the briefing of every other state names it with its diff; a PR into the parent's branch is named in every other state, as its branch and base are known. It needs `"workspace": "own"` or `"parent"`. |
| `countsFixRounds` | Entering the state from another one counts a fix round, and taking the issue from it (or in the state it enters as, once a round is counted) briefs the step as rework. When an outcome would start a round past `deliver.maxFixRounds`, the issue gets `needs-human` instead. Every state with it counts toward the same limit. |
| `humanGate` | A person does this state's step. An outcome into it notifies the user and tells the agent to stop; `norn next` lists the issue as waiting for a person, for its type, or for its mode when the gate has `when`. The briefing carries the QA wording: run the app, tie remarks to criteria, a repro for every failure, and evidence with `--evidence <dir>`. |
| `mergesSlice` | The state's briefing says to merge the parent's branch into the issue's and merge its PR. `norn done` refuses until that PR is merged into the parent's branch. Once the issue closes, its worktree waits for `norn tidy`, the issues it blocked are released (see `syncsBlocked`), and a story whose slices are all merged moves on. It needs `"workspace": "parent"`. |
| `syncsBlocked` | `{ "to": "<state>" }`. An issue in the state has no step: it waits for its blockers, GitHub's native "blocked by" relations. Once every blocker is closed, norn moves it to the state `to` names, and back when a blocker reopens before it is taken; `norn next` on its parent and merging a sibling do this. `to` must be a state of the flow. |
| `writesSpec` | `{ "readsIssue": true }` or `{}`. The issue has a spec of its own, `.agents/specs/<n>-<slug>/spec.md` on its branch: every step's briefing names it instead of the issue, transition comments link it, and resolving `needs-human` says spec changes go there. The state's own briefing says to commit and push the spec, and with `readsIssue` to read the issue first. It needs `"workspace": "own"`. |
| `slices` | `{ "type": "<flow>" }`. The state's briefing says how to create the slices with `norn add-slice`, which works only in this state: each slice is a sub-issue labelled `type:<flow>`, in that flow's start state (or the state its `syncsBlocked` holds blocked issues in). `norn done` refuses to leave the state before there is a slice. The issue's slices are its sub-issues of that type; `norn next` on the issue runs them too. `type` must be a flow. |
| `waitsForSlices` | `{ "to": "<state>" }`. An issue in the state has no step: it waits for its slices. Entering it creates the issue's own branch on GitHub, for the slices to branch off. Once every slice is merged, norn opens the issue's PR into the base branch and moves it to the state `to` names; merging the last slice and `norn next` do this. The states after that briefing the PR and its diff, and a state with `countsFixRounds` there commits fixes straight onto the branch. It needs `"workspace": "own"`. |
| `waitsForMerge` | An issue in the state has no step: its owner merges its PR into the base branch, and `norn take` says so. `norn next` lists it as waiting for the owner, and closes it once the PR is merged, as GitHub does not for a base branch other than the default one. It needs `"workspace": "own"`. |

`norn next <issue>` works on an issue of any flow: a human gate or `needs-human` waits for a person, a state a behaviour holds waits for what it names, and any other state is offered to start, with the user when it is attended.

## Mode-conditional states: `when`

A state can run in one mode only: `"when": "hil"` or `"when": "afk"`, with `passThrough` naming one of its outcomes, e.g. `"when": "hil", "passThrough": "verified"` on a state where a person verifies the fix. When an outcome leads into it and the issue carries the other mode's label, norn never enters the state: it follows the pass-through outcome at once, through any further such states, and writes one transition comment straight to where the issue lands, e.g. `norn: fixing → closed (fixed)` followed by `Skipped verifying in mode:afk: it runs in mode:hil only.` In the state's own mode the state runs as usual, and so it does for an issue with no `mode:` label.

The built-in `slice` flow uses this for QA by a person: `needs-human-qa` has `"when": "hil"` and passes through by `pass`, so an afk slice goes from agent QA straight to the merge queue.

## Triage and types

Triage chooses an issue's type. Its briefing offers `story`, then one outcome per flow named after the flow, with the flow's `description` as what it means, then `reject`. `norn done <issue> bug` adds `type:bug`, moves the issue to the flow's `start` and assigns it to you, with a transition comment. A flow with `"triage": false` is not offered, and neither is a broken one. No flow may be named `reject`.

## Replacing a built-in flow

A repository file named like a built-in flow, `story.json` or `slice.json`, replaces that flow completely, with nothing merged from the built-in one, for triage, `take`, `done`, `next` and `add-slice` alike. `norn flows export story` writes the built-in flow there as a starting copy; unchanged, it runs exactly like the built-in.

## Labels

A flow's states are labels on GitHub, and its type is `type:<name>`. `norn init` creates the labels of every valid flow on the base branch, with each state's `color` and `description` or a default for its kind (attended or agent), and the first transition into a state whose label is missing creates it, so a merged flow works without running `init`. `norn doctor` reports missing labels, and lists as a warning the labels no flow uses any more: a `type:` with no flow, a built-in state a replacement dropped, or a state a flow renamed. norn never deletes a label, so closed issues keep their history; delete one on GitHub yourself once no issue needs it.

## Validation

norn checks a flow strictly before it runs it:

- the fields have the right types, no field is unknown (a misspelt field would otherwise be ignored), the start state exists, every target is a state, `closed` or `not-planned`, and every `renamed` target is a state;
- every state with `when` names one of its outcomes as `passThrough`;
- every state can reach `closed` or `not-planned` through its outcomes, or where its behaviour moves it (`syncsBlocked`, `waitsForSlices`, `waitsForMerge`), so no issue can be stuck in a loop, in either mode: in `mode:afk` the states for `hil` are passed through, and the other way round;
- each state's `behaviours` are ones this norn knows, each with an object of the parameters it takes (`{}` for none), allowed together and with what they need, e.g. `opensPR` needs `"workspace": "own"` or `"parent"`, any flow they name exists, and any state they name is a state of the flow. A flow written for a newer norn fails here, which is what the [`nornVersion` pin](configuration.md#the-norn-version) protects against;
- no state takes a name norn keeps for itself (`closed`, `not-planned`, `in-progress`, `needs-human`), and no flow is named `reject`, triage's outcome.

A broken flow stops only the issues of its own type. `norn take` and `norn done` refuse them with every problem found, triage stops offering the flow, and `norn next` and the dashboard show them waiting for a person, blocked by the broken flow. Issues of other types keep working.

**JSON Schema.** norn publishes the format as a JSON Schema, [`schema/flow.schema.json`](../schema/flow.schema.json), in the npm package (`node_modules/norn/schema/flow.schema.json`) and on GitHub. Point `$schema` at it, as in the example above, and an editor completes the fields and flags a mistake of the shape as you type. The schema checks the shape, the same as norn's first rule; the rules that span the flow, such as reachability, only norn checks.

**`norn doctor`.** Its `flows` check validates the flows on the base branch and every flow file in your working copy that differs from it, so a change is checked before its PR. It fails on an invalid flow, naming each problem and the file, and on a skill a flow names that is not installed in `skills/`. See [commands](commands.md#norn-doctor).

## Changing a flow under issues in progress

Flows have no versions: an issue in progress follows the current flow from its next step. Adding a state or an outcome needs nothing more. Removing or renaming a state leaves the issues in it behind. When `norn take` or `norn next` next touches an issue in a state its flow no longer has (the state norn last moved it to, by its transition comments):

- if the flow's optional `renamed` map, e.g. `"renamed": { "repro": "reproducing" }`, names the old state, norn moves the issue to the new state with a transition comment; `take` takes it there and `next` offers it there;
- otherwise the issue is orphaned: norn sets `needs-human` with a comment naming the missing state and the flow, takes the old state's label off and notifies the user. `take` answers that it handed the issue over and releases the claim; `next` lists it as waiting for a person. Taking the issue again runs `norn-resolve`, whose outcomes are the flow's states: `norn done <issue> <state>` moves it there.

`norn next` makes these changes as it makes its other housekeeping, under a short claim; an issue another session holds is only listed as in a state its flow no longer has.

Before merging such a change, run `norn doctor` on the branch with the edit: its `flows` check lists the open issues the edit would orphan, with their states, so you can add the states to `renamed` or move those issues on first. The old state's label stays on the repository, and `doctor` lists it as one no flow uses.
