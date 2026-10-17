# Configuration

norn reads two files at the repository root. Both are optional; `norn init` creates the team file with the defaults.

| File | Committed | Holds |
| --- | :-: | --- |
| `.agents/norn.config.json` | yes | Team settings, the same for everyone |
| `.agents/norn.config.local.json` | no (gitignored) | Your own overrides, notifications and dashboard settings |

The local file wins over the team file, except for `claims.staleAfter` and `deliver.maxFixRounds`. Those bind everyone's claims and fix rounds, so norn reads them from the team file only; in the local file they are ignored with a warning.

An unknown key or an invalid value makes norn refuse every command and name the problem, until the file is fixed. `norn doctor` reports these, and every other setup problem, at once.

```jsonc
// .agents/norn.config.json (committed)
{
  "nornVersion": "0.10.0",
  "baseBranch": "main",
  "worktrees": { "provider": "auto" },
  "claims": { "staleAfter": "2h" },
  "deliver": { "maxParallel": 2, "maxFixRounds": 3 }
}
```

```jsonc
// .agents/norn.config.local.json (gitignored, per developer)
{
  "worktrees": { "provider": "herdr" },
  "notifications": "auto",
  "dashboard": { "port": 4477, "interval": "2m" }
}
```

## Settings

| Setting | Default | Where | Meaning |
| --- | --- | --- | --- |
| `nornVersion` | written by `norn init` | team only | The norn version that last set the repository up; see [the norn version](#the-norn-version) |
| `baseBranch` | the repository's default branch | team or local | The branch stories merge into |
| `worktrees.provider` | `auto` | team or local | `auto`, `herdr`, `claude-code` or `git`; see [providers](#worktree-providers) |
| `claims.staleAfter` | `2h` | team only | Age after which a claim counts as abandoned. A duration such as `30m` or `2h`; below `10m` it is raised to `10m` with a warning |
| `deliver.maxParallel` | `2` | team or local | How many of your agents `deliver` runs at once on a story |
| `deliver.maxFixRounds` | `3` | team only | Rounds of `changes-requested` or `qa-failed` before an issue gets `needs-human` |
| `notifications` | `auto` | local only | Where notifications go; see [notifications](#notifications) |
| `dashboard.port` | `4477` | local only | The dashboard's port |
| `dashboard.interval` | `2m` | local only | How often the dashboard reads GitHub; at least `30s` |

Durations are a number followed by `s`, `m`, `h` or `d`.

## The norn version

`nornVersion` records the norn version the committed skills and labels belong to. `norn init` writes it, and on an upgrade changes it and nothing else. It is a plain version such as `0.10.0`; anything else, or `nornVersion` in the local file, is a config problem.

Every command except `init` and `doctor` compares it with the norn that runs:

| Your norn against `nornVersion` | norn |
| --- | --- |
| The same, or only the patch version differs | Says nothing |
| Newer, but compatible | Warns: run `norn init` to update the skills and `nornVersion` for the team |
| Older, but compatible | Warns: upgrade norn |
| Not compatible | Refuses, naming both versions and the fix |
| `nornVersion` missing from the team file | Warns: run `norn init` |

Compatible means the same major version, or, while the major version is 0, the same minor version. A repository without a team file is not flagged. `norn init` refuses to run when `nornVersion` is newer than your norn, so it never rolls the team's skills back.

## Worktree providers

The provider decides how norn names worktrees and how a new agent is started in one.

| Provider | Picked in `auto` mode | New agent per step |
| --- | --- | --- |
| `herdr` | Inside [herdr](https://herdr.dev) | A new herdr agent in the worktree's pane |
| `claude-code` | Inside Claude Code | A new subagent told to work in the worktree; Claude Code's own worktree isolation is not used |
| `git` | Otherwise | A new agent session started in the worktree |

`auto` checks in that order. The environment is a safety check: if the provider is `herdr` but norn is not running inside herdr, norn refuses and says to start from a herdr pane or switch the provider in your local file.

The worktree location is fixed at `.agents/worktrees/`.

## Notifications

| Value | Delivery |
| --- | --- |
| `auto` (default) | herdr inside herdr, otherwise the operating system |
| `herdr` | A herdr notification, with a sound |
| `os` | The operating system's notifications on macOS, Linux and Windows |
| `none` | Off. The GitHub label and comment remain |

See [how it works](how-it-works.md#notifications) for when norn notifies.

## Dashboard

`dashboard.port` and `dashboard.interval` set the defaults for `norn dashboard`; the `--port` and `--interval` flags override them. They go in the local file only, since each developer runs their own dashboard.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `NORN_SESSION` | The session that holds claims. Falls back to `CLAUDE_CODE_SESSION_ID`, then the herdr pane (`HERDR_PANE_ID`), then host and repository root |
| `NORN_SKILLS_SOURCE` | A repository to install the skills from with `npx skills add`, instead of the bundled ones |
