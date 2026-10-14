# Changelog

All notable changes to psdd are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and psdd uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
