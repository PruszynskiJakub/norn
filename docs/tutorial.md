# Try norn in a sandbox

This walkthrough takes one small issue from triage to a merged story in a throwaway repository, so you can see the whole process without touching a real project.

## Before you start

You need Node 20+, git, [Claude Code](https://claude.com/claude-code), [`gh`](https://cli.github.com) logged in (`gh auth status`), and read access to the norn repository while it is private.

## 1. Create a throwaway repository

Create it with a first commit on `main`:

```sh
gh repo create norn-sandbox --private --clone --add-readme && cd norn-sandbox
npm init -y && echo node_modules >> .gitignore
```

## 2. Install and set up norn

```sh
npm install -D github:PruszynskiJakub/norn#v0.10.1
npx norn init
git add -A && git commit -m "Set up norn" && git push
```

`init` installs the skills into `.agents/skills/` (linked into `.claude/skills/`), writes the norn section into `AGENTS.md` and `CLAUDE.md`, creates `.agents/specs/` and `.agents/norn.config.json`, gitignores `.agents/worktrees/` and the local config, and creates the labels on the repository.

## 3. Open an issue

Pick something small:

```sh
gh issue create --title "Add a greet command" --body "Print Hello, <name>" --assignee @me
```

## 4. Shape the story with `norn-drive`

Start Claude Code in the sandbox and ask:

```text
norn-drive <issue>
```

Triage, refine, clarify, plan and slice are attended: the agent prepares each decision and you make it. Each step ends with the `norn done <issue> <outcome>` the briefing gives (triage `story`, refine `clear` or `questions`), and `norn-drive` moves on to the next step. Slicing creates the slices as sub-issues and moves the story to implementation.

## 5. Deliver it unattended

When `norn-drive` offers it, agree to start `norn-deliver <story>`, or ask for it yourself. It implements, reviews, QAs and merges the slices into the story branch in fresh subagents, then reviews and QAs the story.

It stops when the story reaches `needs-human-qa`, which is always yours, or when only items waiting for a person are left. `npx norn status <story>` shows them, and so does the dashboard:

```sh
npx norn dashboard
```

For a `needs-human` issue or an item in `needs-human-qa`, ask your agent `norn-drive <issue>`. When the dashboard says an agent asks, it waits for your answer in its own session: answer it there, and it carries on. Under herdr, `herdr agent focus norn-<issue>` takes you to it.

## 6. Merge the story

After story QA passes, merge the story PR into `main` yourself:

```sh
gh pr merge <pr>
```

The next `npx norn tidy` removes the worktrees, branches and QA evidence.

## Clean up

Delete the repository:

```sh
gh repo delete norn-sandbox --yes
```

This needs the `delete_repo` scope once: `gh auth refresh -s delete_repo`.

## Next steps

- [How norn works](how-it-works.md): the process, labels, claims and delivery in detail.
- [Flows](flows.md): how a repository defines its own process.
- [Commands](commands.md) and [configuration](configuration.md).
