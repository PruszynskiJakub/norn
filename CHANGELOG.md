# Changelog

All notable changes to psdd are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and psdd uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- `claims.staleAfter` and `deliver.maxFixRounds` can only be set in the team config; `staleAfter` must be at least `10m`.
- Branch, worktree and spec names come from a slug recorded once on the story, not from its current title.
- Spec links point at the story branch, not the local HEAD.

### Fixed

- A multi-line review or QA note no longer stops the fix budget from resetting after a person resolves the escalation.
- A failed label change no longer leaves an issue without a state; `psdd next` lists an issue with no state label as waiting for a person.
- Two sessions taking over the same stale claim can no longer both hold it.
- `psdd done` on a merge refuses a slice PR that does not target the story branch.
- Lists are read without `gh api --slurp`, so gh older than 2.48 works.
- Printed commands are shell-quoted; worktree paths compare correctly on Windows; the main checkout is found for submodules and `--separate-git-dir` clones.
- An existing worktree is brought up to date in the briefing; a slice relabelled by `take` is still briefed as rework.
- `psdd next` no longer says the user was notified when notifications are off, gives the create command under plain git, clears state labels from closed issues, keeps worktrees with uncommitted changes, ignores sub-issues that are not slices, and closes a story whose PR merged into a non-default base.
- The resolve step's comment says `needs-human resolved`.
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

[Unreleased]: https://github.com/PruszynskiJakub/ai-engine/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/PruszynskiJakub/ai-engine/releases/tag/v0.1.0
