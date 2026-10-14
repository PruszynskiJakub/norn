# psdd

CLI for the SDD process. The developer's LLM calls it to run work through the process; GitHub labels, native relations, comments and branches are the only state. See `PRD.html`.

```sh
npx psdd init            # skills, .agents/specs/, team config, .gitignore, labels
npx psdd next 123        # what can be done on story #123 now
npx psdd take 131        # claim #131 and get its briefing
npx psdd done 131 [outcome] ["note"]
```

Run `psdd` with no arguments for every command. Add `--json` for scripts.

- Uses your own `gh`; every change is made as you.
- Claims are git refs `refs/psdd/claims/<issue>`; a stale claim (default 2h) is taken over and its left-behind worktree removed.
- Each story and slice works in its own worktree under `.agents/worktrees/<branch>`; the briefing names it and gives the command to create it for herdr, Claude Code or plain git. psdd removes a slice's worktree when it merges, and the story's once the story is merged into main.
- Team settings: `.agents/psdd.config.json` (`baseBranch`, `worktrees.provider`, `claims.staleAfter`). Each developer can override in the gitignored `.agents/psdd.config.local.json`.
- The session holding a claim is `PSDD_SESSION`, else `CLAUDE_CODE_SESSION_ID`, else host and directory.
- `psdd init` copies the skills bundled in `skills/`. Set `PSDD_SKILLS_SOURCE=<repo>` to install with `npx skills add <repo>` first.

## Develop

```sh
npm test          # vitest, against an in-memory GitHub and a scripted gh
npm run build
```
