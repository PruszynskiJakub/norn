# Version pin and norn doctor

Issue: #95

## Problem Statement

A developer has no way to tell which norn version a repository was set up with, or whether their own norn matches it. Two people on one repository can run different versions, so the labels, claims, briefings and the committed skills in `skills/` can disagree with the norn that briefs them, and nothing says so.

When something in the setup is wrong (`gh` not logged in, labels missing, no write access, invalid config, the wrong worktree provider), it shows up as a failed command partway through a step, one problem at a time. There is no single command that checks the whole setup and says what to fix. There is not even `norn --version`.

## Solution

- **The version is recorded.** The team config records the norn version that last set the repository up, as `nornVersion`. `norn init` writes and bumps it. Every command compares it with the running norn: it stays silent on a patch difference, warns on a compatible difference, and refuses on an incompatible one, naming the fix.
- **A new `norn doctor` command** checks the whole setup in one go: `gh`, git and the remote, permissions, labels, config, version, skills, agent instructions and the worktree provider. It reports every check with the exact command that fixes it. It never refuses and never changes anything, so it is safe to run anywhere, CI included.
- **`norn --version`** prints the running version.

## User Stories

1. As a developer, I want the team config to record the norn version the repository was set up with, so that everyone can see which version the committed skills and labels belong to.
2. As a developer, I want `norn init` to write `nornVersion` when it creates the team config, so that a new repository records its version from the start.
3. As a developer, I want `norn init` on an existing repository to set `nornVersion` to my running version without touching any other setting, so that an upgrade changes the version and nothing else.
4. As a developer, I want `norn init` to report "nornVersion a → b" next to the skills it updated, so that I can see the version bump and the skill changes as one change to commit.
5. As a developer, I want `norn init` to refuse when my norn is older than the repository's `nornVersion`, so that I cannot quietly roll the team's skills back to an older version.
6. As a developer, I want commands to say nothing when only the patch version differs, so that harmless differences don't add noise.
7. As a developer whose norn is newer than the repository's (but compatible), I want a warning that tells me to run `norn init`, so that I refresh the skills and the version for the team.
8. As a developer whose norn is older than the repository's (but compatible), I want a warning that tells me to upgrade norn, so that I catch up with my teammates.
9. As a developer, I want "compatible" to mean the same major version, or the same minor version while the major is 0, so that the 0.x minor bumps that can break things are treated as breaking.
10. As a developer, I want every command except `init` and `doctor` to refuse on an incompatible version, naming both versions and the fix, so that I never act on GitHub state with a norn that reads it differently.
11. As a developer on a repository set up before this change, I want a warning (not a refusal) when `nornVersion` is missing, telling me to run `norn init`, so that upgrading norn doesn't break my existing setup.
12. As a developer in a repository with no team config at all, I want no version warning, so that a repository that has never run `init` isn't flagged for it.
13. As a developer, I want norn to refuse `nornVersion` in my local config, so that one person cannot override the team's version.
14. As a developer, I want norn to refuse a `nornVersion` that isn't a plain `x.y.z`, as a config problem, so that a typo is caught right away.
15. As a developer, I want `norn --version` to print the running version, so that I can see which norn I have.
16. As a developer onboarding to a repository, I want `norn doctor` to check the whole setup and list every problem at once, so that I fix them all before starting work, not one at a time mid-step.
17. As a developer, I want `doctor` to check that `gh` is installed and logged in to the repository's host, so that GitHub calls won't fail partway through a step.
18. As a developer, I want `doctor` to check that I'm in a git checkout whose `origin` is on GitHub, so that I know norn can work here.
19. As a developer, I want `doctor` to check that `baseBranch` exists on the remote, so that a wrong branch name is caught before a story branch is created from it.
20. As a developer, I want `doctor` to check that I have write access or higher to the repository, so that I know labels, sub-issues and pushes to `refs/norn/*` will work for me.
21. As a developer, I want `doctor` to check that all of norn's labels exist, so that I know to run `norn init` if any are missing.
22. As a developer, I want `doctor` to validate the team and local config with the same rules every command uses, and show their warnings, so that I see every config problem in one place.
23. As a developer, I want `doctor` to check that `nornVersion` is present and compatible, and show "norn x, repo y", so that I can see any version mismatch at a glance.
24. As a developer, I want `doctor` to check that every skill norn's briefings name is in `skills/` and linked from `.claude/skills/`, so that a briefing never points to a skill that isn't there.
25. As a developer, I want `doctor` to warn when an installed skill differs from the copy bundled with norn, so that I know `norn init` would update it.
26. As a developer who installs skills from `NORN_SKILLS_SOURCE`, I want `doctor` to skip the check against the bundled skills, so that my own skills aren't reported as drift.
27. As a developer, I want `doctor` to check that the norn block is in `AGENTS.md` or `CLAUDE.md`, so that agents in this repository can find the process.
28. As a developer, I want `doctor` to check that the worktree provider resolves and matches my environment, so that I find out about a herdr or Claude Code mismatch before `take` refuses.
29. As a developer, I want each check to show as ok, warning, fail or skipped (`✓`, `!`, `✗`), so that I can scan the result.
30. As a developer, I want every warning and failure to come with the exact command that fixes it, so that I (or my agent) can just run it.
31. As a developer, I want `doctor` to exit with 1 only when a check fails, and 0 when there are only warnings, so that CI can run it without failing on drift.
32. As a script author, I want `norn doctor --json` to give `{ ok, checks: [{ id, level, message, fix }] }`, so that tools can act on each check.
33. As a developer with an invalid config or an incompatible version, I want `doctor` to still run and report those as checks, so that the command that diagnoses problems is never blocked by them.
34. As a developer outside a git checkout, I want `doctor` to run and report the git check as failed, so that it explains what is wrong instead of exiting with the generic message.
35. As a developer, I want checks that depend on a failed check to be skipped with the reason (for example "needs gh"), so that one root cause gives one failure, not five.
36. As a developer, I want `doctor` to change nothing, so that it is always safe to run.
37. As a developer who hits a `gh` failure, I want the message to add "Run `norn doctor` for a full check", so that I check for other problems hiding behind it.
38. As a developer refused for an incompatible version, I want the refusal to point to `norn doctor` too, so that I check the rest of the setup while I'm fixing things.
39. As a developer who just ran `norn init`, I want it to suggest running `norn doctor`, so that I check the setup init can't fix (auth, permissions).
40. As a new user, I want the docs to describe `norn doctor` and `nornVersion`, and the README's install steps to end with `norn doctor`, so that checking the setup becomes part of getting started.

## Implementation Decisions

- **The version source.** The running norn version is a dependency of the CLI (a `version` value in its dependencies), so tests set it. How the real binary obtains it (embedded at build time or read from the package manifest) is left to planning; it must give the published package's version.
- **Config.**
  - `nornVersion` is a new team-only setting. In the local file it is a config problem, in the same way `dashboard` in the team file is today. A value that isn't a plain `x.y.z` is a config problem.
  - The loaded config exposes the repository's version (or that it is missing), plus whether a team file exists.
- **Compatibility.** A small pure function compares the running version with the repository's: same, patch difference, compatible (newer or older) or incompatible. Compatible means the same major version, or the same minor version while the major is 0.
  - A compatible difference adds a config-style warning to the existing `norn warning:` block.
  - A missing field with a team file present adds a warning.
  - An incompatible difference is a new refusal kind. Every command except `init` and `doctor` returns it. It names both versions, the fix ("upgrade norn" or "run `norn init`") and `norn doctor`.
- **`init`.**
  - For a new team file, `init` writes the defaults plus `nornVersion`.
  - For an existing one, it parses the file and rewrites only `nornVersion`, keeping every other key and its value. The result reports the old and new version.
  - It refuses before doing anything if the repository's version is newer than the running one.
  - It ends with a line suggesting `norn doctor`.
- **`doctor`.**
  - It is a new no-number command. It skips the config, version and provider refusals in dispatch, and runs every check itself.
  - Each check is `{ id, level: ok|warning|fail|skipped, message, fix? }`. The answer is `ok: false` only when a check fails; `skipped` never changes the exit code.
  - Rendered as text, each check is one line marked `✓`, `!` or `✗` (skipped checks named as skipped), followed by the fix command. `--json` gives `{ ok, checks }`.
- **The checks in v1 and what they depend on:**
  1. `gh` installed and logged in to the repository's host. Everything GitHub-related depends on this.
  2. Git checkout, with `origin` on GitHub. Everything GitHub-related depends on this.
  3. `baseBranch` exists on the remote.
  4. Write access or higher.
  5. All norn labels exist.
  6. Team and local config valid (reusing the config checks, warnings included).
  7. `nornVersion` present and compatible.
  8. Skills present in `skills/` and linked from `.claude/skills/`, with drift from the bundled copy as a warning. Drift isn't checked under `NORN_SKILLS_SOURCE`.
  9. The norn block in `AGENTS.md` or `CLAUDE.md`.
  10. The provider resolves and matches the environment (the same rule as the provider refusal).
- **The GitHub port.** It gains read-only queries for what `doctor` needs and the port lacks today: `gh` presence and login status for the host, the user's permission level on the repository, and the names of the existing labels. `baseBranch` on the remote reuses the existing branch lookup. The `gh` adapter implements these and the fake GitHub simulates them.
- **Outside a checkout.** The entry point, which today exits on a root error before any command runs, lets `doctor` through: `doctor` runs without a repository root and reports the git check as failed, with the checks that depend on it skipped.
- **`norn --version`** prints the plain version and exits 0, before any config is loaded.
- **Messages.** The generic `gh` failure message gains "Run `norn doctor` for a full check."
- **Docs.** `docs/commands.md` gets a `norn doctor` section and `--version`, `docs/configuration.md` gets a `nornVersion` row, and the README's install steps end with `norn doctor`.
- **Slicing (suggested).**
  1. `nornVersion`, the compatibility check and its warnings and refusal, the `init` changes, `--version`, and the config docs.
  2. `norn doctor`, the new GitHub port queries, the entry-point change for running outside a checkout, the message pointers, and the doctor docs.

## Testing Decisions

- **What a good test is here.** Tests drive norn the way a user does, through the command-line entry point, and assert on its output, exit code and side effects (files written, GitHub state). They don't assert on internal functions. A test describes a situation and what norn answers.
- **The main seam** is the existing `run()` harness (`setup()` and `w.norn(...)` from the testing package, with the fake GitHub and fake workspace). It covers:
  - config validation of `nornVersion`: the local file, a bad format, a missing field, no team file;
  - every compatibility outcome, across commands;
  - `init`, writing, bumping, preserving other keys and refusing a downgrade, using the temporary-directory project pattern from the init tests;
  - `--version`;
  - every `doctor` check at each level, the skips between dependent checks, the exit codes and the `--json` shape.

  It needs the running version to be injectable, and the fake GitHub to simulate `gh` login state, permission level and existing labels.
- **The second seam** is the entry-point test, which runs the real binary in a temporary directory. It is used only for `doctor` outside a checkout, alongside the existing "outside a checkout norn prints why and exits 1" test.
- **Prior art:**
  - `config.test.ts`, for config problems and warnings through commands;
  - `init.test.ts`, for init in a temporary project;
  - `bin.test.ts`, for the real entry point;
  - `gh-failure.test.ts`, for the `gh` failure message;
  - `gh-adapter.test.ts`, for the new adapter queries;
  - `dashboard-command.test.ts`, for a no-number command with flags.

## Out of Scope

- Whether a project-local install should win over a global binary (#32's open question). There is no global binary yet; this belongs with #30.
- `doctor --fix` or any automatic repair. The fixes are `norn init` or things only the user can do.
- Checking token scopes and a minimum `gh` version: the permission check covers what scopes are for, and no minimum `gh` version is defined.
- Checking stack commands (#34), which don't exist yet.
- Semver ranges in `nornVersion`.

## Further Notes

- This supersedes #32 (Pin the psdd version per repository) and #33 (Add psdd doctor), which were written under the old name psdd.
- The decisions come from a design interview: a plain version instead of a range, a missing field warns instead of refusing, `init` refuses to downgrade, and `doctor` is read-only and never refuses.
