# Commands

norn is run through `npx norn` in a project that has it installed. Run `norn` with no arguments to list the commands. Every command that works on an issue takes its number explicitly, and every command takes `--json` for machine-readable output; prose is the default.

norn answers in prose written as instructions to the agent, always in the same order: where you are, what to do now (including the skill to invoke), how to finish (the exact commands), and what not to do. A refusal says why and what to do instead.

| Command | What it does |
| --- | --- |
| [`norn init`](#norn-init) | Set up the project: skills, agent instructions, `.agents/`, labels |
| [`norn next <story>`](#norn-next) | What can be done on the story now |
| [`norn take <issue>`](#norn-take) | Claim the issue and get the briefing for its step |
| [`norn done <issue> [outcome] ["note"]`](#norn-done) | Finish the step; norn makes the transition |
| [`norn status <story>`](#norn-status) | Read-only overview of the story and its slices |
| [`norn tidy`](#norn-tidy) | Remove what belongs to closed issues |
| [`norn dashboard`](#norn-dashboard) | Watch your work in the browser |
| [`norn doctor`](#norn-doctor) | Check the whole setup and say what to fix |
| [`norn add-slice <story> "title"`](#norn-add-slice) | Create a slice (used by the `norn-slice` skill) |
| [`norn escalate <issue> "reason"`](#norn-escalate) | Set `needs-human` and release the claim |
| [`norn release <issue>`](#norn-release) | Give up the claim without a transition |

`norn --version` prints the running norn's version.

## norn init

```sh
npx norn init
```

Sets norn up in the current repository. Running it again is safe and refreshes what it wrote.

- **Skills.** Copies the bundled skills into `skills/` and links them into `.claude/skills/`: one per step (`norn-triage`, `norn-refine`, `norn-clarify`, `norn-plan`, `norn-slice`, `norn-implement`, `norn-review`, `norn-auto-qa`, `norn-qa`, `norn-merge`, `norn-resolve`), the process skills (`norn-drive`, `norn-deliver`) and the reference skills they use (`norn-interview`, `norn-codebase-design`, `norn-tdd`). After upgrading norn, run `init` again: it replaces any bundled skill that differs from the new version and names them; `git diff skills/` shows the changes. Set `NORN_SKILLS_SOURCE=<repo>` to install the skills with `npx skills add <repo>` instead; skills from that source already in place are kept.
- **Agent instructions.** Writes a short norn section between `<!-- norn:start -->` and `<!-- norn:end -->` into `AGENTS.md` and `CLAUDE.md`, whichever exist. With neither, it creates `AGENTS.md` and a `CLAUDE.md` that imports it.
- **Files.** Creates `.agents/specs/` and the team config `.agents/norn.config.json`, taking `baseBranch` from the repository's default branch. Adds `.agents/worktrees/` and `.agents/norn.config.local.json` to `.gitignore`.
- **Version.** Records the running norn's version as [`nornVersion`](configuration.md#the-norn-version) in the team config. On a repository set up before, it changes `nornVersion` and no other setting, and reports the change next to the skills it updated, so the two are committed together. It refuses when the repository's `nornVersion` is newer than your norn: upgrade norn instead of rolling the team's skills back.
- **Labels.** Creates norn's labels on the GitHub repository.

It ends by suggesting `norn doctor`, which checks what `init` cannot set up.

## norn next

```sh
npx norn next <story>
```

Lists what can be done on the story now, each item with the command that starts it, and what is waiting and why. It is the entry point for `norn-deliver`. On an issue of a [repository flow](how-it-works.md#repository-flows) it lists the issue itself: for a person at a human gate, else to start, attended as its state says.

```text
Story #123 "Rate limiting" is in implementation. 2 of 7 slices are merged
into 123-rate-limiting.

You can start 3 items now. They are independent, so run them in parallel, at
most 2 at a time, each in its own fresh subagent, told to work in the item's
worktree:

  - Slice #131 "Per-key limits" is ready-for-agent.
    Worktree: /repo/.agents/worktrees/123-rate-limiting-131
    Start it with: norn take 131
  - Slice #128 "Limit headers" needs review.
    Worktree: /repo/.agents/worktrees/123-rate-limiting-128
    Start it with: norn take 128
  - Slice #127 "Redis store" is in merge-queue.
    Worktree: /repo/.agents/worktrees/123-rate-limiting-127
    Start it with: norn take 127

Waiting, nothing to do for you:
  - #132 is blocked by #131.
  - #129 needs human QA (mode:hil). Do not take it.

Each phase gets a new agent. When an item is done, run norn next 123 again.
```

- It offers only the free slots under `deliver.maxParallel`, counting your agents already running on the story.
- An item for a person that a session already holds is listed as held by it, with no hand-off.
- It catches up on follow-ups a `norn done` could not finish (story branch, unblocking slices, story PR, `needs-review`), closes a story whose PR is merged if GitHub did not, and removes state labels left on closed issues.
- Under the git provider it gives each agent it lists its own `NORN_SESSION`.

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

Do not change labels yourself. Only norn changes them.
```

- Running `take` again on an issue you hold re-briefs you and refreshes the claim.
- A stale claim (older than `claims.staleAfter`) is taken over by one session only.
- `--takeover` takes over a claim of your own GitHub user at any age, for a session of yours that stopped. It never takes a teammate's claim.

## norn done

```sh
npx norn done <issue> [outcome] ["note"] [--evidence <dir>]
```

Finishes the step: norn makes the transition, posts a comment and releases the claim. The outcome word is needed only when the step can end more than one way (see [steps, skills and outcomes](how-it-works.md#steps-skills-and-outcomes)). The note carries review requests, QA results or a rejection reason. `--evidence <dir>` pushes the QA files in `<dir>` to `norn/qa/<issue>` and embeds them in the comment.

Follow-ups after the transition (story branch, unblocking slices, story PR, `needs-review`) are best effort; `norn next` catches up on any that failed.

## norn status

```sh
npx norn status <story>
```

A read-only overview of the story and its slices: the story's owner and branch, and for each item its state, mode, open blockers, `needs-human` and whether a claim holds it (and whether that claim is stale).

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
- a feed of what happened, with the agents' implement, review and QA remarks and links to their evidence.

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
| `labels` | All of norn's labels exist |
| `config` | The team and local config are valid; their warnings show as a warning |
| `version` | `nornVersion` is set and compatible with your norn; a compatible difference warns |
| `skills` | Every skill the briefings name is in `skills/` and linked from `.claude/skills/`; a skill that differs from the bundled copy warns, except under `NORN_SKILLS_SOURCE` |
| `agent-instructions` | The norn block is in `AGENTS.md` or `CLAUDE.md` |
| `provider` | The worktree provider matches the environment, as `take` requires |

Each check shows as `✓` ok, `!` warning, `✗` fail, or `-` skipped when a check it needs did not pass, e.g. `skipped, needs gh`. It exits 1 only when a check fails, so CI can run it without failing on a warning. `--json` gives `{ ok, checks: [{ id, level, message, fix }] }`.

`doctor` changes nothing and never refuses: an invalid config, an incompatible version or a run outside a checkout are reported as checks.

## norn add-slice

```sh
npx norn add-slice <story> "title" --mode afk|hil [--blocked-by <issue>]...
```

Creates a slice as a sub-issue of the story, with its labels, the story's assignee, its native "blocked by" relations and its mode. The `norn-slice` skill calls it; you rarely need it by hand.

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
