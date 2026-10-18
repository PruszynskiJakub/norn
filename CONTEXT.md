# norn

norn runs a team's work through a spec-driven process on GitHub. A developer's agent asks norn what to do, does the work with a skill, and reports the result; norn records it in GitHub, the only state. This file is the canonical definition of the domain terms; [`docs/how-it-works.md`](docs/how-it-works.md) uses them for the principles and the way of working.

## Work items

**Issue**:
A GitHub issue norn works on. At triage a new issue is given its type, e.g. it becomes a story, or is closed as not planned.

**Story**:
An issue that is one feature, from triage until its story PR is merged into the base branch. It has one spec, one story branch and, once sliced, its slices. It runs the built-in `story` flow. norn runs any issue whose flow creates slices as it runs a story, but calls it by its type, e.g. an epic.
_Avoid_: epic, feature issue

**Slice**:
A sub-issue of a story that is one independently mergeable part of it. It is implemented, reviewed, QA'd and merged into the story branch on its own. Its type is the one the story's flow names for its slices, `slice` for the built-in story.
_Avoid_: task, sub-task, child issue

**Spec**:
The one document of a story, built up through refinement, clarification and planning. Its Behaviour items are numbered user stories that slices, review and QA check against.
_Avoid_: PRD, design doc

**Slug**:
The short name derived from a story's title the first time norn writes on it, then fixed. Branches, worktrees and the spec path are named from it.

**Story owner**:
The person a story is assigned to. They own its slices too, and only they merge the story PR.

## Process

**Flow**:
The process for one issue, as data: its states, the skill and outcomes of each, where it starts and its workspace. A repository defines a flow in `.agents/flows/<name>.json`, read from the base branch on GitHub. norn ships the built-in `story` and `slice` flows in the same format, and publishes the format as a JSON Schema. See [`docs/flows.md`](docs/flows.md).

**Type**:
The flow an issue runs, carried as its `type:<name>` label, e.g. `type:bug` runs the flow `bug`. Triage gives an issue its type; an issue with none is new.

**Behaviour**:
A built-in mechanic a state of a flow opts into by name, e.g. `slices`, `waitsForSlices`, `opensPR`, `humanGate` or `syncsBlocked`. It adds its lines to the briefing, its checks and changes to `norn done`, what an issue it holds waits for, and its follow-ups. The set is closed: a flow names behaviours, it cannot define them.

**Workspace**:
Where a flow's work happens: `none`, no branch; `own`, a branch of the issue's own with one PR into the base branch; `parent`, a branch off the parent issue's branch with one PR into it, as for a slice.

**Orphaned issue**:
An issue left in a state its flow no longer has. norn moves it to the new name when the flow's `renamed` map names the state, and otherwise hands it to a person through `needs-human`.
_Avoid_: stale state, migrated issue

**State**:
Where an issue is in its process, carried as exactly one state label, e.g. `needs-review`. Two state labels mean a label change failed halfway, and norn acts on neither.

**Flag**:
A label beside the state that is not a state: the type, `in-progress`, `needs-human` or the mode.

**Phase**:
One of the two halves of a story's life. Phase 1, shaping it with a person present (triage to slicing); phase 2, delivering its slices and the story itself (implementation to merge).

**Step**:
The work an issue's state calls for, done with one skill, e.g. review in `needs-review`. Every step ends with an outcome.

**Attended step**:
A step done with the user taking part, such as triage, refinement and human QA. The agent does not decide on its own.
_Avoid_: interactive step

**Outcome**:
How a step ended, reported by the agent in a word such as `approve` or `fail`. norn picks the transition from it; the agent never names a state.
_Avoid_: result, status

**Transition**:
A change of state norn makes: from an outcome, or automatically, as when every slice is merged.

**Follow-up**:
An automatic transition after an outcome, such as unblocking slices or opening the story PR. Best effort: one that fails is reported and repeated by the next `norn next`.

**Refusal**:
norn's answer when it will not do what was asked: why, and what to do instead.

**Mode**:
Whether a slice is checked by an agent only (`afk`) or by an agent then a person (`hil`), from its `mode:afk` or `mode:hil` label. A flow's state with `when` runs in that mode only; in the other mode norn passes through it by its `passThrough` outcome.

**Agent QA**:
QA by an agent that runs the app as a user would and collects evidence per criterion. Every slice and story gets it.

**Human QA**:
QA by a person with their agent, starting from the agent's evidence. Slices in mode `hil` and every story get it.

**Evidence**:
What agent or human QA records per criterion: the note on the issue, and files embedded in it from the QA evidence branch.

**Needs-human**:
The flag saying a person must act before the issue can go on: an escalation or a reached fix-round limit. Resolving it clears the flag and keeps the state.
_Avoid_: blocked (a state of its own), stuck

**Escalation**:
An agent setting needs-human on an issue it holds, with the reason.

**Fix round**:
One trip back to implement after review asks for changes or QA fails. Past the fix-round limit the issue gets needs-human instead.

## Working on an item

**Claim**:
The lock on an issue that lets one session work on it, taken for a whole step and released on handover. It goes stale after a while and can then be taken over.
_Avoid_: lock, assignment

**Session**:
One running agent as norn tells them apart, so claims know who holds them.

**Takeover**:
Taking a claim from another session: a stale one, or with `--takeover` a stopped session of one's own.

**Briefing**:
norn's answer to taking an issue: where to work, which skill to invoke, the process around it, how to finish and what not to do.

**Story branch**:
The branch a story's slices merge into, and its PR into the base branch.

**Slice branch**:
The branch a slice is implemented on, merged into the story branch by its slice PR.

**Worktree**:
The checkout a story or slice is worked in for the life of its branch, one per branch.

**Worktree provider**:
The tool that makes worktrees and starts agents in them: herdr, Claude Code or plain git.

## Skills and delivery

**Skill**:
The instructions an agent follows for a step's craft. A step skill knows nothing of norn; the briefing carries the process around it.

**Process skill**:
A skill that runs norn itself: norn-drive, which takes one issue through its steps with the user, and norn-deliver.

**Delivery**:
Running a sliced story unattended, a fresh agent per step, until only a person can move it on. Under herdr `norn deliver` does it as a loop of runs; elsewhere the norn-deliver skill orchestrates agents itself.
_Avoid_: autopilot

**Run**:
One item's step done by an agent that norn starts in a herdr pane and watches, through its supervisor, until GitHub says the step finished, the run lost the claim, or the issue needs a human.

**Supervisor**:
The process of a run that norn owns: it starts the agent, renews the run's lease, stops a stalled or timed-out agent, and settles each attempt from GitHub.

**Attempt**:
One go of a run's agent at its step. An attempt that ends without the step finished is recorded on the issue; past the attempt limit the issue gets needs-human.

**Lease**:
How long a run's claim stays fresh without renewal; the supervisor renews it while the agent lives, so a frozen run gives its item up long before a claim goes stale.

**Parallel slot**:
Room for one more of the user's agents on a story under the parallel limit. Agents already holding items use slots.

**Housekeeping**:
Removing what closed issues leave behind, done by `norn tidy`: worktrees, merged branches, QA evidence and claims.

## Relations

- A story has one spec, one story branch and many slices; a slice belongs to one story.
- A slice can be blocked by others; it becomes ready once they are closed.
- An issue's state, with needs-human, calls for at most one step; each step has one skill and ends with one outcome.
- A session holds at most one claim per issue; an issue has at most one claim.
- A story's state follows its slices in implementation: when every slice is merged, the story moves on to review.
