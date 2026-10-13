# psdd

CLI for the SDD process. The developer's LLM calls it to run work through the process; GitHub labels, native relations, comments and branches are the only state. See `PRD.html`.

```sh
npx psdd init            # skills/, .claude/skills/ links, .agents/specs/, labels
npx psdd next 123        # what can be done on story #123 now
npx psdd take 131        # claim #131 and get its briefing
npx psdd done 131 [outcome] ["note"]
```

Run `psdd` with no arguments for every command. Add `--json` for scripts.

- Uses your own `gh`; every change is made as you.
- Claims are git refs `refs/psdd/claims/<issue>`; a claim older than 2 hours is taken over.
- The session holding a claim is `PSDD_SESSION`, else `CLAUDE_CODE_SESSION_ID`, else host and directory.
- `psdd init` copies the skills bundled in `skills/`. Set `PSDD_SKILLS_SOURCE=<repo>` to install with `npx skills add <repo>` first.

## Develop

```sh
npm test          # vitest, against an in-memory GitHub and a scripted gh
npm run build
```
