# Commands

norn is run through `npx norn` in a project that has it installed. Run `norn` with no arguments to list the commands. Every command that works on an issue takes its number explicitly, and every command takes `--json` for machine-readable output; prose is the default.

Commands exit 0 with an answer, 1 on a refusal and 2 on a usage error. `norn doctor` exits 1 when a check fails, and `norn wait` says by its exit code what to do next (see [norn wait](#norn-wait)).

norn answers in prose written as instructions to the agent, always in the same order: where you are, what to do now (including the skill to invoke), how to finish (the exact commands), and what not to do. A refusal says why and what to do instead.

| Command | What it does |
| --- | --- |
| [`norn init`](#norn-init) | Set up the project: skills, agent instructions, `.agents/`, labels |
| [`norn next <story>`](#norn-next) | What can be done on the story now |
| [`norn deliver <story>`](#norn-deliver) | Take the story's delivery lock and get the deliver loop |
| [`norn wait <story>`](#norn-wait) | Block until there is something new to do on the story |
| [`norn take <issue>`](#norn-take) | Claim the issue and get the briefing for its step |
| [`norn done <issue> [outcome] ["note"]`](#norn-done) | Finish the step; norn makes the transition |
| [`norn status <story>`](#norn-status) | Read-only overview of the story and its slices |
| [`norn tidy`](#norn-tidy) | Remove what belongs to closed issues |
| [`norn dashboard`](#norn-dashboard) | Watch your work in the browser |
| [`norn doctor`](#norn-doctor) | Check the whole setup and say what to fix |
| [`norn flows export <name>`](#norn-flows-export) | Copy a built-in flow into the repository to change it |
| [`norn add-slice <story> "title"`](#norn-add-slice) | Create a slice (used by the `norn-slice` skill) |
| [`norn escalate <issue> "reason"`](#norn-escalate) | Set `needs-human` and release the claim |
| [`norn release <issue>`](#norn-release) | Give up the claim without a transition |

`norn --version` prints the running norn's version. `norn --help`, or `--help` (`-h`) after any command, prints the list of commands and runs nothing.

norn calls an issue by its type, the flow it runs: a story is `Story #123`, an issue of a repository flow `bug` is `Bug #40`, its PR the bug PR.

## norn init

```sh
npx norn init
```

Sets norn up in the current repository. Running it again is safe and refreshes what it wrote.

- **Skills.** Copies the bundled skills into `.agents/skills/` and links them into `.claude/skills/`: one per step (`norn-triage`, `norn-refine`, `norn-clarify`, `norn-plan`, `norn-slice`, `norn-implement`, `norn-review`, `norn-auto-qa`, `norn-qa`, `norn-merge`, `norn-resolve`), the process skills (`norn-drive`, `norn-deliver`) and the reference skills they use (`norn-interview`, `norn-codebase-design`, `norn-tdd`). After upgrading norn, run `init` again: it replaces any bundled skill that differs from the new version and names them; `git diff .agents/skills/` shows the changes. A `skills/` directory is left alone: it is the project's own. Set `NORN_SKILLS_SOURCE=<repo>` to install the skills with `npx skills add <repo>` instead; skills from that source already in place are kept.
- **Agent instructions.** Writes a short norn section between `<!-- norn:start -->` and `<!-- norn:end -->` into `AGENTS.md` and `CLAUDE.md`, whichever exist. With neither, it creates `AGENTS.md` and a `CLAUDE.md` that imports it.
- **Files.** Creates `.agents/specs/` and the team config `.agents/norn.config.json`, taking `baseBranch` from the repository's default branch. Adds `.agents/worktrees/` and `.agents/norn.config.local.json` to `.gitignore`.
- **Version.** Records the running norn's version as [`nornVersion`](configuration.md#the-norn-version) in the team config. On a repository set up before, it changes `nornVersion` and no other setting, and reports the change next to the skills it updated, so the two are committed together. It refuses when the repository's `nornVersion` is newer than your norn: upgrade norn instead of rolling the team's skills back.
- **Claude Code permissions.** Adds `Bash(norn:*)` and `Bash(npx norn:*)` to `permissions.allow` in `.claude/settings.json`, creating the file when it is missing, so agents run norn's commands without a permission prompt. It adds to what is there and never removes anything, and allows nothing but norn: what else agents may run stays the team's decision. A settings file that is not valid JSON is left as it is, and `init` says what to add.
- **Labels.** Creates norn's labels on the GitHub repository: every state of the valid [flows](flows.md) on the base branch, built-in or the repository's, `type:<flow>` for each flow, and the flags `in-progress`, `needs-human`, `mode:afk` and `mode:hil`. A state's label takes its `color` and `description`, or a default for its kind. An invalid flow is skipped; `norn doctor` reports it. Labels are never deleted.

It ends by suggesting `norn doctor`, which checks what `init` cannot set up.

## norn next

```sh
npx norn next <story>
```

Lists what can be done on the story now, each item with the command that starts it, and what is waiting and why. It is the entry point for `norn-deliver`. On an issue of a [repository flow](flows.md) it lists the issue itself: for a person at a human gate, else to start, attended as its state says.

```text
Story #123 "Rate limiting" is in implementation. 2 of 7 slices are merged
into 123-rate-limiting.

You can start 3 items now. They are independent, so run them in parallel, at
most 2 at a time, each in its own fresh subagent, told to work in the item's
worktree:

  - Slice #131 "Per-key limits" is in ready-for-agent: Ready for an agent.
    Worktree: /repo/.agents/worktrees/123-rate-limiting-131
    Start it with: norn take 131
  - Slice #128 "Limit headers" is in needs-review: Waiting for review.
    Worktree: /repo/.agents/worktrees/123-rate-limiting-128
    Start it with: norn take 128
  - Slice #127 "Redis store" is in merge-queue: Queued to merge.
    Worktree: /repo/.agents/worktrees/123-rate-limiting-127
    Start it with: norn take 127

Waiting, nothing to do for you:
  - #132 is blocked by #131.
  - #129 needs human QA (mode:hil). Do not take it.

Each phase gets a new agent. Then run norn wait 123: it ends when something new can start.
```

- It offers only the free slots under `deliver.maxParallel`, counting your agents already running on the story.
- An item for a person that a session already holds is listed as held by it, with no hand-off.
- It catches up on follow-ups a `norn done` could not finish (story branch, unblocking slices, story PR, `needs-review`), closes a story whose PR is merged if GitHub did not, and removes state labels left on closed issues.
- Under the git provider it gives each agent it lists its own `NORN_SESSION`.
- Under herdr each phase's agent is named for its issue and step, e.g. `norn-3-review`, then `norn-3-merge`, so a new phase never collides with the last one's name. When the item's worktree pane still runs an earlier phase's agent, it prints the command that stops it, and the new agent starts in that pane instead of a new one.
- When a session delivers the story it says which one and since when, e.g. `Story #1 is being delivered by another session of yours, herdr:w3T:p1, since 16:15. Do not start another delivery.` The delivering session's own `next` records on its delivery lock what it offered, so `norn wait` wakes only for what is new.

## norn deliver

```sh
npx norn deliver <story> [--stop] [--takeover]
```

Takes the story's delivery lock for this session and prints the loop the `norn-deliver` skill follows. Only one orchestrator delivers a story: a second one is refused and told who holds the lock and since when.

```text
Story #1 is being delivered by session herdr:w3T:p1 since 16:15. Do not start another delivery.
If that session has stopped, take its delivery over with: norn deliver 1 --takeover
```

- The lock is a claim on the story under `refs/norn/deliveries/<story>`, with the same rules: running `deliver` again refreshes it, it goes stale after `claims.staleAfter`, and `--takeover` takes your own at any age, never a teammate's.
- `norn wait` keeps it fresh while it waits and releases it when delivery stops; `--stop` releases it at any time.
- `norn next` and `norn status` show it.
- `--json` gives `{ ok, story, reacquired, tookOver, message }`.

## norn wait

```sh
npx norn wait <story> [--timeout 30m]
```

Blocks until `norn next` has something new for the orchestrator to do, then prints one line and exits with a code that says what to do. The orchestrator runs it in the background instead of a monitor of its own.

```text
#4 is ready for an agent (1 slot free). Run: norn next 1
```

| Exit code | Meaning |
| --- | --- |
| 0 | Something new can start: run `norn next <story>`. |
| 3 | Nothing is left that you can do, or the story is closed: `Nothing left you can do: #8 needs human QA (mode:hil). Run norn next 1 for the report.` The delivery lock is released. |
| 4 | `--timeout` (default `30m`) passed first. Run it again. |
| 1 | An error, e.g. GitHub failed. |
| 2 | A refusal or a usage error, e.g. another session delivers the story. |

- **It wakes on a condition, not a change.** It holds on what `norn next` would answer now: an unattended item can start with a slot free, and the delivering session's last `norn next` did not offer it in that state. So a change made before the wait started wakes it at once, an agent finishing a step while no slot is free does not, and an item offered but never taken wakes it again after `deliver.stuckAfter`.
- **It reads GitHub sparingly.** Each check reads one cheap stamp (the update times of the story and its sub-issues in one GraphQL query, and the claims with `git ls-remote`), and works out `norn next` only when it changed, or every 10 minutes for claims gone stale. Checks start every 30s and slow to every 2m while nothing changes.
- **It escalates a stuck agent.** Under herdr, an item held by one of your sessions in a herdr pane of this machine whose agent has been idle, done, gone or waiting at a prompt for longer than `deliver.stuckAfter` (default `10m`) is escalated for it: `needs-human` with what the agent is doing and its pane, e.g. `agent in pane w3Y:p2 stopped while holding the claim`, the claim deleted and you notified. The pane is left as it is, for you to read. A teammate's claim, or one of a Claude Code subagent or a git session, is never touched: norn cannot observe them.
- It sends no notification of its own except for such an escalation, and writes nothing beyond the follow-ups `norn next` makes and its delivery lock.
- `--json` gives `{ ok, story, wake, items, escalated, next, message }`, `next` being the `norn next --json` report.

## norn take

```sh
npx norn take <issue> [--takeover]
```

Claims the issue and prints the briefing for its current step: the worktree and branch to work in (with the command to create the worktree if it is missing), the skill to invoke, what to read, where to commit and push, and the `norn done` commands that finish the step.

```text
You now hold story #123 "Rate limiting". Its step is refinement. This step
is attended: the user takes part, and you do not decide on your own.

Work in: /repo/.agents/worktrees/123-rate-limiting (branch 123-rate-limiting)
It does not exist yet. Create it first:
  git -C /repo fetch origin main && git -C /repo worktree add --no-track /repo/.agents/worktrees/123-rate-limiting -b 123-rate-limiting origin/main

Invoke the skill: refine
Spec to work on: .agents/specs/123-rate-limiting/spec.md
Read the issue: gh issue view 123 --comments
Commit the spec on 123-rate-limiting and push it, so the link norn posts resolves.

When the user agrees refinement is finished, run one of:
  norn done 123 clear       (no open questions, moves on to planning)
  norn done 123 questions   (open questions, moves to clarification)

On a long step, run norn take 123 again now and then: it keeps your claim fresh.
If you have to stop, run: norn release 123
If something is wrong and a person is needed, run: norn escalate 123 "reason"
That covers a permission or a tool error that blocks you, a decision only a person can make, and a skill telling
you to stop and hand it to a person. Say what blocked you, e.g. norn escalate 123 "auto mode refused: gh pr merge 13"

Do not change labels yourself. Only norn changes them.
Never end your turn while you hold #123: finish with a command above, norn release 123, or norn escalate 123 "reason".
```

Every briefing ends with that rule, so an agent that stops always leaves a state norn can see: the step finished, the claim released, or the issue escalated.

- Running `take` again on an issue you hold re-briefs you and refreshes the claim.
- A stale claim (older than `claims.staleAfter`) is taken over by one session only.
- `--takeover` takes over a claim of your own GitHub user at any age, for a session of yours that stopped. It never takes a teammate's claim.

## norn done

```sh
npx norn done <issue> [outcome] ["note"] [--evidence <dir>]
```

Finishes the step: norn makes the transition, posts a comment and releases the claim. The outcome word is needed only when the step can end more than one way (see [steps, skills and outcomes](how-it-works.md#steps-skills-and-outcomes)). The note carries review requests, QA results or a rejection reason. `--evidence <dir>` pushes the QA files in `<dir>` to `norn/qa/<issue>` and embeds them in the comment.

It refuses, changing nothing, while the step's work is not where the flow needs it: leaving a state with `opensPR` needs the issue's PR open, closing an issue of a flow with `opensPR` needs that PR merged, and leaving a state with `slices` needs a slice. When the outcome sets `needs-human`, from the flow's `needsHuman` or the fix-round limit, `done` says so and why.

At a slice's merge step (`mergesSlice`), `done` merges the slice PR into the story branch itself, with a merge commit, so an agent needs no permission to merge. The agent brings the branch up to date, resolves conflicts, runs the checks and pushes first. norn refuses, changing nothing and keeping the claim, while the PR targets another branch than the story branch, has conflicts, is behind the story branch, or has a check that failed or is still running, and says what to do:

```text
#3: check "test" failed on PR #13. Fix it and push, then run norn done 3 again.
#3: 2 checks on PR #13 are still running. Run norn done 3 again when they finish.
```

It merges only the commit whose checks it read: a push landing in between is refused, and the agent syncs and checks again. A merge GitHub refuses, e.g. for branch protection on the story branch, is refused with GitHub's reason and the `norn escalate` to run. A slice PR a person already merged is accepted. norn never merges into the base branch: the story PR stays its owner's to merge.

Follow-ups after the transition (story branch, unblocking slices, story PR, `needs-review`) are best effort; `norn next` catches up on any that failed.

## norn status

```sh
npx norn status <story>
```

A read-only overview of the issue and its slices: its owner and, when its flow gives it one, its branch, and for each item its state, mode, open blockers, `needs-human` and whether a claim holds it (and whether that claim is stale). An issue whose flow has no slices shows on its own. When a session delivers the story, it says which one and since when.

## norn tidy

```sh
npx norn tidy [--dry-run]
```

Removes what belongs to closed issues: QA evidence branches, worktrees, merged branches and claim refs. Anything with uncommitted or unpushed work is named and kept. `--dry-run` only lists. `norn-deliver` and `norn-drive` run it for you.

## norn dashboard

```sh
npx norn dashboard [--port <n>] [--interval <duration>] [--no-open]
```

Serves a read-only page on `127.0.0.1` over your norn work in this repository and opens it in your browser:

- what needs you (`needs-human` and `needs-human-qa`), each with its `norn-drive` command;
- what is worth a look: stale claims and items one fix round from the limit;
- your stories with their slices and progress;
- a feed of what happened, with the agents' implement, review and QA remarks and links to their evidence;
- a Flows page (`#flows`): every flow of the repository, marked built-in, overridden or the repository's own, and valid or invalid with its errors, each drawn as a graph of its states and the outcomes between them, with each state's behaviours and `when` mode. It only shows the flows; you change one by merging a change to its file.

![The norn dashboard](assets/dashboard.png)

It reads GitHub as you every 2 minutes (30s at the least), with one GraphQL query plus `git ls-remote` per read, shared by every open tab. It changes nothing and keeps no state, and runs until Ctrl-C.

- Port 4477 moves to the next free one when taken, unless you gave `--port`.
- A second launch for the same checkout prints the running one's URL.
- `--interval` takes a duration such as `30s`, `2m` or `1h`.
- Set defaults in your local config: see [configuration](configuration.md#dashboard).

## norn doctor

```sh
npx norn doctor [--json]
```

Checks the whole setup at once and lists every check, each with the exact command that fixes it:

| Check | Passes when |
| --- | --- |
| `gh` | `gh` is installed and logged in to the host of `origin` |
| `git` | You are in a git checkout whose `origin` is on GitHub |
| `base-branch` | `baseBranch` exists on GitHub |
| `permission` | You have write access or higher to the repository |
| `labels` | The labels of every valid flow and norn's flags exist, as `init` creates them; a label of norn's that no flow uses, on the base branch or in your working copy's flow files, (one norn created, by the `(norn)` at the end of its description, a `type:`, or a state a flow renamed) warns, and is never deleted |
| `flows` | The flows on the base branch, and every flow file in your working copy that differs from it, are valid; every `.json` file in `.agents/flows/` is named as a type can be, e.g. not `Bug.json`; the skills they name are installed. It names the type of the slices each flow makes, and lists, as warnings, the labels your local flow edits need that the repository lacks and the open issues they would orphan: those in a state the edit drops without naming it in `renamed` |
| `config` | The team and local config are valid; their warnings show as a warning |
| `version` | `nornVersion` is set and compatible with your norn; a compatible difference warns |
| `skills` | Every skill the briefings name is in `.agents/skills/` and linked from `.claude/skills/`; a skill that differs from the bundled copy warns, except under `NORN_SKILLS_SOURCE` |
| `agent-instructions` | The norn block is in `AGENTS.md` or `CLAUDE.md` |
| `agent-permissions` | Claude Code's settings (`.claude/settings.json` or `.claude/settings.local.json`) allow `Bash(norn:*)` and `Bash(npx norn:*)`; a missing rule warns, fixed by `norn init`. Checked only when the repository has `.claude/` |
| `provider` | The worktree provider matches the environment, as `take` requires |

Each check shows as `✓` ok, `!` warning, `✗` fail, or `-` skipped when a check it needs did not pass, e.g. `skipped, needs gh`. A check with several problems lists each on a line of its own. It exits 1 only when a check fails, so CI can run it without failing on a warning. `--json` gives `{ ok, checks: [{ id, level, message, fix }] }`.

The `flows` check validates your uncommitted `.agents/flows/*.json` before you open the PR, so a broken flow never reaches the base branch. A local file the same as the base branch's is reported once, as the base branch's.

`doctor` changes nothing and never refuses: an invalid config, an incompatible version or a run outside a checkout are reported as checks.

## norn flows export

```sh
npx norn flows export <name>
```

Writes norn's built-in flow `<name>`, `story` or `slice`, to `.agents/flows/<name>.json` as a starting copy for the team's own version. Once that file is merged into the base branch, it replaces the built-in flow of its name completely: norn takes nothing from the built-in one, for triage, `take`, `done`, `next` and `add-slice` alike. Unchanged, the copy runs exactly like the built-in flow. See [Repository flows](flows.md) for the format.

```text
Wrote .agents/flows/story.json, a copy of the built-in story flow.
Change it there and merge it into the base branch; from then on it runs in place of the built-in story flow, with nothing taken from it.
```

It refuses when the file exists, leaving it as it is, and names the built-in flows when `<name>` is not one of them. It works in the current directory and needs neither GitHub nor the team config. `--json` gives `{ ok, flow, file, message }`.

## norn add-slice

```sh
npx norn add-slice <story> "title" --mode afk|hil [--blocked-by <issue>]...
```

Creates a slice as a sub-issue of the story, with its labels, the story's assignee, its native "blocked by" relations and its mode. The slice gets the type the story's flow names and starts in that type's start state, or held while a blocker is open; the answer names that state. A missing label for either is created first, with its colour and description. The `norn-slice` skill calls it; you rarely need it by hand.

## norn escalate

```sh
npx norn escalate <issue> "reason"
```

Sets `needs-human` with the reason as a comment and releases the claim. A person clears it with `norn-drive <issue>`, which runs the `norn-resolve` skill.

## norn release

```sh
npx norn release <issue>
```

Gives up the claim without a transition, for an agent that has to stop.
