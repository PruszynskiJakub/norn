# Changelog

All notable changes to psdd are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and psdd uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/PruszynskiJakub/ai-engine/releases/tag/v0.1.0
