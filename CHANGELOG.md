# Changelog

All notable changes to norn are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and norn uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.7.0] - 2026-10-16

### Changed

- Every bundled skill is prefixed with `norn-`, so the skills are easy to tell apart from a project's own: `norn-drive <issue>`, `norn-deliver <story>`, and `norn-triage` through `norn-resolve` and `norn-tdd`. Briefings, `norn next`, the herdr hand-off prompts, the dashboard and the `AGENTS.md` section use the new names. After upgrading, run `npx norn init`, then delete the old unprefixed skill directories from `skills/` and their links from `.claude/skills/`.
- `norn-drive` and `norn-deliver` carry an argument hint, so your agent shows what each takes as you type it: `norn-drive` takes any issue, story or slice; `norn-deliver` takes a story.
- The dashboard shows the norn icon at the top of the sidebar, next to the norn name, instead of at the right of the top bar.

## [0.6.1] - 2026-10-16

### Changed

- The README is rewritten for someone new to norn, and the reference moves to `docs/`: how norn works (principles, assumptions, labels, flows as Mermaid diagrams, claims and delivery), commands, configuration and a sandbox tutorial. `PRD.html` is folded into these pages and removed. `CONTRIBUTING.md` and `SECURITY.md` are new.

### Fixed

- `norn next` on a story in merge-queue says the owner merges the story PR into the configured `baseBranch`, instead of always saying `main`.

## [0.6.0] - 2026-10-16

### Changed

- psdd is renamed to norn. The command is `npx norn`, and everything it writes uses the new name: `norn:` comments on issues, `refs/norn/claims/<issue>`, the `norn/qa/<issue>` evidence branches, `.agents/norn.config.json` and `.agents/norn.config.local.json`, `NORN_SESSION` and `NORN_SKILLS_SOURCE`, and the `<!-- norn:start -->` section in `AGENTS.md` and `CLAUDE.md`. It is a clean break: norn reads none of the old names. Finish or restart stories that are in flight under psdd. After upgrading, rename the config files, run `npx norn init`, and delete the old `<!-- psdd:start -->` section from `AGENTS.md` and `CLAUDE.md`.
- The dashboard shows the norn icon as its favicon and at the right of its top bar. Its colours follow the icon: navy and gold, with gold marking an agent at work.

### Fixed

- The dashboard heading reads "Nothing needs you right now" when nothing does, instead of "Nothing need you right now".

## [0.5.1] - 2026-10-16

### Fixed

- The dashboard shows a selected story's or slice's labels as GitHub has them, under its title; `needs-human` and `needs-human-qa` stand out in colour.

## [0.5.0] - 2026-10-16

### Added

- `psdd dashboard [--port <n>] [--interval <duration>] [--no-open]` serves a read-only page on `127.0.0.1` over your psdd work in this repository: your stories with their slices, what needs you with its `drive <issue>` command, what is worth a look (stale claims, items one fix round from `deliver.maxFixRounds`), and a feed of what happened in psdd's terms, with the agents' implement, review and QA remarks inline and QA remarks linked to their evidence on `psdd/qa/<issue>`. It reads GitHub as you every 2 minutes (at least 30s), one GraphQL query plus `git ls-remote` per read, shared by every open tab; it changes nothing. The default port 4477 moves to the next free one when taken, an explicit `--port` that is taken fails, and a second launch for the same checkout prints the running dashboard's URL. `dashboard.port` and `dashboard.interval` go in `.agents/psdd.config.local.json`; in the team file they are refused. The UI is embedded in the CLI, so there is nothing extra to install.

### Changed

- Release tags carry the built CLI, so installing psdd from a tag no longer builds it and npm 11 no longer warns about its `prepare` script. Only release tags can be installed now; a branch or commit of the repository has no built CLI.

## [0.4.0] - 2026-10-15

### Changed

- Under herdr, an item waiting for a person (`needs-human-qa` or `needs-human`) is done in its own worktree's pane, like every other step. `psdd next` lists, with the item, how to hand it to an agent there if the user does it now (`herdr agent start`, `prompt "drive <item>"`, `focus`), or, inside that worktree, to take it in this session; `--json` carries the item's `worktree` and `here`. `drive` follows it instead of taking the item in the pane it was started from. Delivery still stops on these items, and other worktree providers are unchanged.
- An item for a person that a session holds is listed by `psdd next` as held by it (`heldBy` in `--json`), with no hand-off, so no second agent is sent to it. When only such work is left, delivery stops without notifying the user about it; items no one holds are still notified.
- `psdd next` counts your agents already running on the story against `deliver.maxParallel` and offers only the free slots (`running` and `slots` in `--json`). At the limit it lists the ready items and says to wait. A teammate's agents and a person's work do not count.
- `deliver` goes on with its loop after the user runs `drive` in the same session, and `drive` does not offer `deliver` again from a session already running it.

## [0.3.0] - 2026-10-15

### Added

- QA has two steps. In `needs-qa` an agent runs the new `auto-qa` skill on every slice and story: it checks each criterion it can from the user's side and collects the evidence. A failure goes straight to `qa-failed` and counts as a fix round. A `mode:afk` slice that passes goes to `merge-queue`; a `mode:hil` slice and every story go to the new state `needs-human-qa`, where a person runs `qa` with their agent, starting from the agent's evidence and from any remarks of their own. Remarks outside the criteria become follow-up issues unless the person pulls them in or drops them. psdd notifies the user when an item reaches `needs-human-qa`, and `psdd next` lists it as "needs human QA". `psdd init` adds the label and the skill.
- `psdd done <issue> <outcome> "note" --evidence <dir>` on a QA step pushes the files in `<dir>` to the branch `psdd/qa/<issue>` and embeds them in the QA comment at that commit, so each round's comment keeps its own evidence. The agent's QA note is its evidence pack and is required.
- `psdd tidy [--dry-run]` removes what belongs to closed issues: QA evidence branches, worktrees, merged slice and story branches (locally and on GitHub), and claim refs. A worktree or branch with uncommitted or unpushed work, and the worktree psdd runs in, are named instead. `deliver` runs it when it starts and stops, `drive` when a story is closed.

### Changed

- Review approval no longer sets needs-human for a `mode:hil` slice or a story: they go to QA by an agent first. needs-human now always means an escalation, cleared with `resolve`, in every state.
- `psdd next` no longer removes worktrees; `psdd tidy` does.
- The slice body has a Verifier section: an agent, or an agent then a person, with what only the person can check and why.

### Upgrading

- An item waiting in `needs-qa` with needs-human for a person's QA from an earlier version is briefed as `resolve`. To give it the new person's QA step instead, run `gh issue edit <issue> --add-label needs-human-qa --remove-label needs-qa,needs-human`. Run `npx psdd init` to get the new label and skills.

## [0.2.3] - 2026-10-14

### Fixed

- Under herdr, `psdd next` lists the `herdr agent prompt` command for each item an agent runs unattended, with the prompt filled in, next to `herdr agent start`. `deliver` runs both as listed. Before, the orchestrator wrote the prompt command itself, and could pass `--timeout` without `--wait`, which herdr rejects: the agent started but never got its prompt.

## [0.2.2] - 2026-10-14

### Fixed

- `psdd init` updates the project's skills to the installed psdd version. Before, it only copied skills that were missing, so after an upgrade projects kept running the old `drive` and `deliver`. It names the skills it replaced; `git diff skills/` shows the changes. With `PSDD_SKILLS_SOURCE` set, skills already in place are kept.

## [0.2.1] - 2026-10-14

### Fixed

- `drive` no longer does an attended step in the main checkout after taking over a stopped session. It takes over and releases the item, then goes back to `psdd next`, so under herdr the story is still handed to an agent in its worktree. The hand-off reuses an agent already in the worktree's pane.
- The `take` briefing says when the worktree has uncommitted changes, e.g. from an earlier session that stopped partway.

## [0.2.0] - 2026-10-14

### Added

- `psdd take <issue> --takeover` takes over a claim held by another session of yours before it goes stale, e.g. after closing an agent partway through refinement. Without the flag, take says the claim is yours and names the command; `psdd next` lists such items as "held by another session of yours". A teammate's claim is never taken. `drive` asks whether the other session is still running and then resumes or drops the step; `deliver` never uses the flag.

### Fixed

- Under herdr, an attended story step no longer leaves an empty worktree workspace while the work goes on in the main checkout. `psdd next` tells `drive` to hand the story to a new agent in the worktree's pane (`herdr agent start`, then `prompt "drive <story>"` and `focus`), and inside that worktree it says to take the step in this session. Attended items are listed as started with the user, not by a fresh agent.

## [0.1.3] - 2026-10-14

### Added

- The `drive` skill: `drive <issue>` takes an issue through its attended steps with the user, from triage to slicing, then offers `deliver`.
- `psdd init` writes a psdd section into `AGENTS.md` and `CLAUDE.md` (creating `AGENTS.md` and a `CLAUDE.md` that imports it when neither exists), so agents find the process without being told.

## [0.1.2] - 2026-10-14

### Added

- psdd builds itself when installed from git (`npm install -D github:PruszynskiJakub/ai-engine#<tag>`).

## [0.1.1] - 2026-10-14

### Changed

- `claims.staleAfter` and `deliver.maxFixRounds` are read from the team config only. In the local config they are ignored with a warning (in `--json`, a `warnings` field), and a team `staleAfter` below `10m` is raised to `10m` with a warning. Commands still run.
- Branch, worktree and spec names come from a slug recorded once on the story, not from its current title.
- Spec links point at the story branch, not the local HEAD.

### Fixed

- A multi-line review or QA note no longer stops the fix budget from resetting after a person resolves the escalation.
- A failed label change no longer leaves an issue without a state; `psdd next` lists an issue with no state label as waiting for a person. An issue left with two state labels is refused by `take` and listed by `psdd next` and `psdd status` for a person to fix, instead of being briefed as its old step.
- Two sessions taking over the same stale claim can no longer both hold it, and refreshing your own claim can no longer overwrite another session's takeover. A takeover that finds the claim already released takes it instead of reporting it held.
- `psdd done` on a merge refuses a slice PR that does not target the story branch.
- Lists are read without `gh api --slurp`, so gh older than 2.48 works.
- Printed commands are shell-quoted, including the slice title in the briefing's `gh pr create`; worktree paths compare correctly on Windows; the main checkout is found from anywhere in a submodule. In a `--separate-git-dir` clone or a bare repository with worktrees, psdd runs from the main checkout only, and elsewhere says so instead of crashing.
- An existing worktree is brought up to date in the briefing; a slice relabelled by `take` is still briefed as rework.
- `psdd next` no longer says the user was notified when notifications are off, gives the create command under plain git, clears state labels from closed issues, keeps worktrees with uncommitted changes, ignores sub-issues that are not slices, and closes a story whose PR merged into a non-default base.
- The resolve step's comment says `needs-human resolved`.
- A story whose title has no ASCII letters or digits records its slug once, not on every comment.
- The deliver skill no longer says the user was notified when notifications are off.
- Windows notifications pass their text through the environment, so quotes in it cannot break out of the script.

## [0.1.0] - 2026-10-14

First release.

### Added

- `psdd` CLI that runs work through the SDD process. GitHub labels, native relations, comments and branches are its only state.
- Commands: `init`, `next`, `take`, `done`, `add-slice`, `escalate`, `release` and `status`, with `--json` output for scripts.
- Claims held as git refs `refs/psdd/claims/<issue>`, refreshed by taking again and taken over once stale (default 2h).
- One worktree per story and slice under `.agents/worktrees/<branch>`, created through herdr, Claude Code or plain git.
- `psdd next` keeps `blocked` and `ready-for-agent` labels in line with native relations, catches up on failed follow-ups and removes worktrees of closed slices and merged stories.
- Team config in `.agents/psdd.config.json`, overridable per developer in the gitignored `.agents/psdd.config.local.json`.
- `deliver` skill that runs a story unattended until it needs a human, with a fix-round limit (`deliver.maxFixRounds`) that escalates to needs-human.
- Local notifications through herdr or the OS when an issue needs a human or nothing is left to do.
- Bundled skills, one per step (triage, refine, clarify, plan, slice, implement, review, qa, merge, resolve, deliver), plus the reference skills `interview`, `codebase-design` and `tdd`, installed by `psdd init`.

[Unreleased]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/PruszynskiJakub/ai-engine/releases/tag/v0.1.0
