# ai-engine

## Rules

1. **The owner of an issue is responsible for it end to end.** The owner is the issue's GitHub assignee, and an issue has exactly one assignee. Responsibility covers all related issues and PRs, including slices.

## Supported agents

psdd is tested on Claude Code. Other agents are supported but not tested.

## psdd

CLI for the SDD process. The developer's LLM calls it to run work through the process; GitHub labels, native relations, comments and branches are the only state. See `PRD.html`.

psdd is not on npm. Install it from this repository (you need read access to it) by a release tag; npm builds it on install:

```sh
npm install -D github:PruszynskiJakub/ai-engine#v0.1.2
```

npm 11 warns that psdd's `prepare` script is not covered by `allowScripts`; the build still runs. `npm install-scripts approve psdd` silences it.

```sh
npx psdd init            # skills, .agents/specs/, team config, .gitignore, labels
npx psdd next 123        # what can be done on story #123 now
npx psdd take 131        # claim #131 and get its briefing
npx psdd done 131 [outcome] ["note"]
```

Run `psdd` with no arguments for every command. Add `--json` for scripts.

- Uses your own `gh` (any version with `gh api --paginate --jq`); every change is made as you.
- Claims are git refs `refs/psdd/claims/<issue>`. Running `psdd take` again on an issue you hold re-briefs you and refreshes the claim; long steps do this to stay fresh. A stale claim (default 2h) is taken over by one session only, and its worktree is kept: check `git status` there before starting.
- Each story and slice works in its own worktree under `.agents/worktrees/<branch>`. The briefing gives its absolute path and, if it is missing, the command to create it for herdr, Claude Code or plain git: it fetches first, starts new branches from `origin/<base>`, and fast-forwards an existing branch from GitHub. If the branch is checked out elsewhere, psdd says where instead.
- `psdd done` makes only the transition and releases the claim; the follow-ups (story branch, unblocking slices, story PR, needs-review) are best effort. `psdd next` catches up on any that failed and removes the worktrees of closed slices, and of the story once it is merged; a worktree with uncommitted changes is kept and named. It closes a story whose PR is merged if GitHub did not (PRs into a non-default `baseBranch`). psdd never removes the worktree it runs in.
- Branch, worktree and spec names come from a slug psdd records once on the story (`psdd: slug <slug>`), so renaming a story is safe. A story's slices are its `type:slice` sub-issues in this repository.
- Team settings: `.agents/psdd.config.json` (`baseBranch`, `worktrees.provider`, `claims.staleAfter`, `deliver.maxParallel`, `deliver.maxFixRounds`). Each developer can override in the gitignored `.agents/psdd.config.local.json`, which also picks `notifications` (`auto`, `herdr`, `os`, `none`), except `claims.staleAfter` and `deliver.maxFixRounds`, which bind the whole team and are read from the team file only: in the local file psdd ignores them with a warning, and a team `staleAfter` below `10m` is raised to `10m` with a warning.
- Once slicing is done, the `deliver` skill runs the story unattended until it needs a human. After `deliver.maxFixRounds` rounds of changes-requested or qa-failed, an issue gets needs-human instead of another round; once a person resolves it, it gets a fresh budget.
- psdd notifies you locally whenever it sets needs-human, and when `psdd next` finds nothing left to do.
- The session holding a claim is `PSDD_SESSION`, else `CLAUDE_CODE_SESSION_ID`, else the herdr pane (`HERDR_PANE_ID`), else host and repository root. Under the git provider, `psdd next` gives each agent its own `PSDD_SESSION` to start with. Known limit: Claude Code subagents share their parent's session id, so under the claude-code provider the deliver orchestrator and its subagents are one session; use herdr for per-agent isolation.
- Skills carry the craft and know nothing of psdd; the `take` briefing carries the process around them (what to read, where to commit and push, how to create slices and PRs, and which finish command each result maps to). `deliver` is the exception: it drives psdd.
- `psdd init` copies the skills bundled in `skills/`: one per step (triage, refine, clarify, plan, slice, implement, review, qa, merge, resolve, deliver) and the reference skills they use (`interview`, `codebase-design`, `tdd`). `codebase-design`, `tdd` and the step skills' approach are adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT). Set `PSDD_SKILLS_SOURCE=<repo>` to install with `npx skills add <repo>` first.

### Develop

```sh
npm test          # vitest, against an in-memory GitHub and a scripted gh
npm run build
```
