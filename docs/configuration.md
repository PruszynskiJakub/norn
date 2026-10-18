# Configuration

norn reads two files at the repository root. Both are optional; `norn init` creates the team file with the defaults.

| File | Committed | Holds |
| --- | :-: | --- |
| `.agents/norn.config.json` | yes | Team settings, the same for everyone |
| `.agents/norn.config.local.json` | no (gitignored) | Your own overrides, notifications and dashboard settings |

The local file wins over the team file, except for `claims.staleAfter`, `deliver.maxFixRounds`, `run.lease` and `run.maxAttempts`. Those bind everyone's claims, fix rounds and runs, so norn reads them from the team file only; in the local file they are ignored with a warning.

An unknown key or an invalid value makes norn refuse every command and name the problem, until the file is fixed. `norn doctor` reports these, and every other setup problem, at once.

```jsonc
// .agents/norn.config.json (committed)
{
  "nornVersion": "0.10.1",
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
  "dashboard": { "port": 4477, "interval": "2m" },
  "run": {
    "agent": "opus",
    "agents": { "opus": { "kind": "claude", "args": ["--model", "opus"] } },
    "env": { "GH_TOKEN": "$NORN_AGENT_GH_TOKEN" }
  }
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
| `run.agent` | `claude` | team or local | The agent `norn run` and `norn deliver` start: a name from `run.agents`, or a herdr agent kind such as `claude` or `codex` |
| `run.agents` | none | team or local, merged | Agents by name, each `{ "kind": "<herdr agent kind>", "args": [...] }`: how `herdr agent start` starts it |
| `run.env` | none | local only | Variables set in each agent's pane, e.g. a token; a value `$NAME` is read from norn's own environment |
| `run.lease` | `10m` | team only | How long a run's claim stays fresh without renewal; see [runs](#runs) |
| `run.stallAfter` | `10m` | team or local | An agent whose pane does not change for this long has stalled and is stopped |
| `run.timeout` | `2h` | team or local | An attempt longer than this is stopped; time blocked on a person does not count |
| `run.blockedAfter` | `30m` | team or local | An agent that waits on a person this long, e.g. at a permission dialog, gets the issue escalated |
| `run.maxAttempts` | `3` | team only | Attempts at one step that end without finishing it before the issue gets `needs-human` |

Durations are a number followed by `s`, `m`, `h` or `d`.

## The norn version

`nornVersion` records the norn version the committed skills and labels belong to. `norn init` writes it, and on an upgrade changes it and nothing else. It is a plain version such as `0.10.1`; anything else, or `nornVersion` in the local file, is a config problem.

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

## Runs

`norn run` and `norn deliver` start each agent in a herdr pane of its item's worktree and watch it; they need herdr and refuse outside it. A run's agent works as the run's own session (`NORN_SESSION=run-<issue>-<nonce>` in its pane), so its claims are the run's.

- **Lease.** Once the agent has taken its item, the supervisor writes `run.lease` into the claim and renews it while the agent lives. A run whose machine sleeps or whose supervisor dies gives its item up after the lease, not after `claims.staleAfter`.
- **Stall and timeout.** An agent whose pane shows no change for `run.stallAfter`, or whose attempt runs past `run.timeout`, is stopped with Ctrl-C twice and its pane closed. An agent busy in a single long tool call can keep its screen changing, so only the timeout catches it.
- **Blocked.** herdr tells when an agent waits on a person, e.g. at a permission or trust dialog. norn notifies you once and pauses both clocks; after `run.blockedAfter` the issue gets `needs-human` and the pane is left for you.
- **Attempts.** An attempt that ends without the step finished, as GitHub sees it, is recorded on the issue (`norn: run — attempt 1 of 3: …`) and tried again: in the same pane when the agent is still there, else in a fresh one. After `run.maxAttempts` the issue gets `needs-human`. A transition or a person resolving the escalation starts a fresh count.

Whether a step finished comes from GitHub only, never from what herdr says the agent is doing. Each run keeps its record and logs in `.agents/runs/<issue>/` on your machine, never committed.

### Sandboxing agents

An unattended agent runs commands on your machine with no one watching, so give it a sandbox rather than turning its permission checks off. `norn doctor` warns when `run.agents` passes `bypassPermissions`, `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox` or `--yolo`.

- **A token for the repository only.** Create a fine-grained GitHub token with access to this repository alone (contents, issues and pull requests: read and write), keep it in your environment, e.g. `NORN_AGENT_GH_TOKEN`, and pass it as `GH_TOKEN` through `run.env`, as in the example above. The agent's `gh` and `norn` then reach nothing else. `run.env` goes in the local file only, so a token is never committed.
- **Claude Code.** Turn on its sandbox, with commands inside the sandbox allowed without asking, and allow the network hosts the work needs (`github.com`, `api.github.com`, your package registry). A worktree's git data lives in the main checkout's `.git`, outside the worktree, so the sandbox must allow writes to `<repository>/.git`, or commits fail. Allow `norn` itself in the project's permissions.
- **Codex.** Start it with `--full-auto`, which keeps its workspace sandbox, with network access allowed: `{ "kind": "codex", "args": ["--full-auto", "-c", "sandbox_workspace_write.network_access=true"] }`. The same `.git` note applies.

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
