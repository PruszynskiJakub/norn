<!-- norn:start -->
## norn

This repository runs its work through norn. GitHub labels, relations, comments and branches hold the state, and only norn changes them.

- To work on an issue, use the norn-drive skill: `norn-drive <issue>`. It takes the issue through the attended steps with the user.
- To run a sliced story unattended, use the norn-deliver skill: `norn-deliver <story>`.
- Without the skills: `norn next <issue>` says what can be done now, and `norn take <issue>` claims an item and gives the briefing to follow to the end. Use `npx norn` if `norn` is not on the PATH.
- Never change norn's labels, claims or branches by hand.
<!-- norn:end -->

## Developing norn with norn

This repository is norn's own source, and its process runs on the **last release**, not on the code here.

- `norn` on the PATH is the released norn, installed globally from the release's `norn-X.Y.Z.tgz` (see the README). Use it for every process command in this repository.
- The build under test, `dist/bin.js`, runs only in the sandbox (below). Never run `node dist/bin.js` in this repository.
- `skills/` holds the sources of the bundled skills; edit them there. `.agents/skills/` holds the released copies that `norn init` installs, which the process uses; never edit them.

## QA in the sandbox

A build under test runs only in the sandbox: [`PruszynskiJakub/norn-qa-sandbox`](https://github.com/PruszynskiJakub/norn-qa-sandbox), a private, throwaway repository, cloned at `~/Projects/norn-qa-sandbox`. Everything there is made with your own `gh`, as the user, on the sandbox only.

1. **Build.** In the issue's worktree: `npm ci && npm run build`. The build under test is `<worktree>/dist/bin.js`; below, `nb` stands for `node <worktree>/dist/bin.js`.
2. **Sandbox.** If `~/Projects/norn-qa-sandbox` is missing, `gh repo clone PruszynskiJakub/norn-qa-sandbox ~/Projects/norn-qa-sandbox`. Then, in it: `git switch main && git pull`.
3. **Set it up with the build.** `nb init`, then `nb doctor`. When the change touches what `init` writes, flows or labels, commit and push what `init` wrote to the sandbox's `main`: norn reads flows from the base branch on GitHub.
4. **Check each criterion** as a user would, with `nb` from the sandbox. Work only on issues created for this run, titled `[qa #<issue>] <what>`, so runs never share state. For the dashboard: `nb dashboard --no-open --port <free port>`.
5. **Evidence.** Record the exact `nb` commands and their output, and the sandbox issue and PR links, per criterion.
6. **Clean up.** Close the run's issues and PRs (`gh issue close`, `gh pr close`), then `nb tidy`. Never delete the sandbox repository, its labels or its `main` history.

A person QAs the same way: their agent follows these steps from the evidence pack.
