# Delivery reliability: waiting, stuck agents, slice merges and one orchestrator

Issues: #26, #45 (the permission profile part). Evidence: the `norn-todo-sandbox` run of epic #1 on 17 Oct 2026.

## Problem

Unattended delivery of epic #1 in `norn-todo-sandbox` merged 4 of 9 slices in about two hours. It stopped for a person three times. Only one of those stops, the human QA of #3, was meant to happen. Six things went wrong:

1. **The orchestrator wrote its own monitor.** After a few rounds, `norn-deliver` replaced its loop with shell scripts. They decided when a slice was finished by grepping the English text of `norn next` and `norn status`, and slept between checks. Any change to norn's wording would break them silently, and one loop per slice replaced the single `norn next` loop the skill describes.
2. **herdr's `done` is not the end of a step.** `herdr agent wait --until done` returned three times for one review that was still running, because `done` means the agent is between turns. The orchestrator then had to check, wait and sleep again.
3. **Agents ended their turn while still holding the claim.** The merge agents for #7 and #3 were blocked, wrote a message to the user and stopped, still holding the claim. They did not escalate, so no `needs-human` label was set and nobody was notified. To norn the items looked like work in progress. The user found out only by asking.
4. **Auto mode blocked every slice merge.** The permission guard refused `gh pr merge` as "Merge Without Review" on PR #12 and PR #13. Merging a slice into the story branch is an agent's job by design, but the guard sees an unapproved PR, and the same `gh` identity cannot approve its own PR. Every slice will hit this.
5. **Two orchestrators ran on the same epic.** A second `/norn-deliver 1` in another pane started its own merge agent while the first was still driving slices. Claims kept them off the same item, but nothing told the second one that the story was already being delivered.
6. **Agents and panes piled up.** A new phase in a pane whose previous agent was still there needed a split pane and a new name. Idle agents from earlier phases stayed, and the session ended with 16 herdr workspaces.

## Solution

norn takes over the parts the orchestrator and the agents got wrong. It does the waiting, notices a stuck agent, merges the slice, and keeps one orchestrator per story.

- **`norn wait <story>`** blocks until `norn next` has something new for the orchestrator to do, then exits with one line and an exit code that says what to do. The orchestrator runs it in the background and never writes a monitor of its own.
- **No agent ends its turn holding a claim.** Every briefing ends with this rule, and a blocked agent escalates. Under herdr, `norn wait` also catches an agent that stopped anyway: an item held by a pane whose agent is idle or blocked for too long is escalated for it, and the user is notified.
- **norn merges a slice into its story branch.** The agent brings the branch up to date, resolves conflicts and runs the checks, then runs `norn done`. norn checks the PR and merges it. An agent then needs permission only to run `norn`, and `norn init` writes that permission for Claude Code. The story PR into the base branch stays the owner's to merge.
- **One orchestrator per story.** `norn deliver <story>` takes a delivery lock on the story. A second orchestrator is refused and told who holds it and since when. `norn wait` keeps the lock fresh and releases it when delivery stops.
- **Phases reuse their pane.** Under herdr, `norn next` names each phase's agent `norn-<issue>-<step>` and, when the pane still runs an earlier phase's agent, prints the command that stops it first.
- **The `norn-deliver` skill becomes a short loop**: `norn deliver`, `norn next`, start agents, `norn wait` in the background, `norn tidy`, repeat. It is told not to script around norn and to read data with `--json` only.

## Behaviour

### Waiting

1. As an orchestrator, I want `norn wait <story>` to block until there is something for me to do, so that I never write my own monitor.
   Example: two slices are being implemented and nothing else can start → `norn wait 1` stays silent. One is merged and #4 becomes ready → it prints `#4 is ready for an agent (1 slot free). Run: norn next 1` and exits 0.
2. As an orchestrator, I want `norn wait` to wake on a condition that holds now, not on a change it observed, so that a change made between my last `norn next` and my `norn wait` is never missed.
   Example: #4 became ready a second before `norn wait 1` started → it exits 0 at once.
3. As an orchestrator, I want `norn wait` to stay asleep when an agent finishes but nothing new can start, so that I am not woken for nothing.
   Example: the implement step of #5 finishes and #5 moves to review while #6 holds the only slot → no wake. The review of #5 becomes startable once #6 finishes → wake.
4. As an orchestrator, I want `norn wait` to exit 3 when nothing is left that I can do or the story is closed, with the same summary `norn next` gives, so that I know to stop and report.
   Example: every open item waits for a person → `Nothing left you can do: #8 needs human QA. Run norn next 1 for the report.`, exit 3.
5. As an orchestrator, I want `norn wait` to give up after `--timeout` (default 30m) with exit 4, so that I am never stuck forever and can decide to wait again.
6. As an orchestrator, I want `norn wait --json` to give the reason and the `next` report, so that I never parse text.
7. As an orchestrator, I want `norn wait` to send no notification of its own, except when it escalates a stuck item (story 13), so that waiting never spams anyone.
8. As a developer, I want `norn wait` to read GitHub sparingly, checking cheap signals first and backing off while nothing changes, so that several orchestrators stay under GitHub's rate limits.
   Example: claims are read with `git ls-remote`, the story's and slices' update times with one call. The full `next` report is computed only when those change. Checks start every 30s and slow to every 2m.
9. As an orchestrator, I want `norn wait` to refuse when another session holds the story's delivery lock, so that two loops never run on one story.

### Agents never stop holding a claim

10. As a developer, I want every briefing to end with "Never end your turn while you hold #n: finish with a command above, `norn release n`, or `norn escalate n "reason"`", so that a stopped agent always leaves a state norn can see.
11. As an agent blocked by a permission, a tool error or a decision only a person can make, I want the briefing to tell me to escalate with what blocked me, so that the user is notified and the item shows as needing a human.
    Example: auto mode refuses a command → `norn escalate 3 "auto mode refused: gh pr merge 13"`.
12. As a skill author, I want the step skills' "stop and hand it to a person" wording to mean `norn escalate`, so that skills and briefings agree.
13. As a user running delivery under herdr, I want `norn wait` to escalate an item whose holder's pane has an agent that is idle, done, gone or blocked for longer than `deliver.stuckAfter` (default 10m), so that a stuck agent is reported within minutes, not after the 2h stale window.
    Example: `norn-3-merge` in pane w3Y:p2 holds #3 and has been idle for 10 minutes → norn sets `needs-human` on #3 with `agent in pane w3Y:p2 stopped while holding the claim`, deletes the claim, notifies the user, and `norn wait` carries on.
14. As a user, I want a stuck item escalated with the agent's state and its pane, so that I can open the pane and see what happened.
    Example: blocked at a prompt → `agent in pane w3Y:p2 is waiting at a permission prompt`.
15. As a developer, I want the stuck check to apply only to claims held by herdr panes on this machine, and never to a teammate's claim or a Claude Code or git session, so that norn never escalates work it cannot observe.

### norn merges the slice

16. As an agent at a slice's merge step, I want the briefing to tell me to bring the branch up to date with the story branch, resolve conflicts, run the checks and push, then run `norn done`, so that I never run `gh pr merge` myself.
17. As a developer, I want `norn done <slice>` in the merge step to merge the slice's PR into the story branch, so that slices merge without a person and without a permission prompt.
    Example: PR #13 targets the story branch, is up to date and has no failing checks → `norn done 3` merges it with a merge commit, closes #3 and unblocks #4 and #5.
18. As a developer, I want norn to refuse the merge when the PR does not target the parent's branch, has conflicts, or has failing checks, and to say what to do, so that the guard against a bad merge lives in norn's rules.
    Example: a required check failed → `#3: check "test" failed on PR #13. Fix it and push, then run norn done 3 again.`
19. As a developer, I want norn to refuse while checks are still running, so that nothing merges red.
    Example: `#3: 2 checks on PR #13 are still running. Run norn done 3 again when they finish.`
20. As a developer, I want norn to merge only the commit the agent pushed, so that a push landing after the agent's checks is never merged unchecked.
    Example: the PR head moved since `norn done` read it → the merge is refused and the agent is told to sync and check again.
21. As a developer, I want `norn done` to accept a slice PR that a person already merged, so that merging by hand keeps working.
22. As an owner, I want norn never to merge a PR into the base branch, so that the story PR stays mine to merge.
23. As an agent whose merge GitHub rejects, for example because of branch protection on the story branch, I want norn to tell me to escalate with GitHub's reason, so that the user sees why.

### Permissions

24. As a team lead, I want `norn init` to add a rule allowing `norn` commands to the repository's Claude Code project settings, adding it to any existing settings and never removing anything, so that agents run norn steps without prompts.
25. As a developer, I want `norn doctor` to warn when the repository uses Claude Code and the rule is missing, with the command that adds it, so that a missing rule is found before delivery stalls.
26. As a team lead, I want norn to allow nothing but `norn` itself, so that what else agents may run stays the team's decision.

### One orchestrator per story

27. As an orchestrator, I want `norn deliver <story>` to take the story's delivery lock and print the loop to follow, so that only one orchestrator delivers a story.
28. As an orchestrator started second, I want `norn deliver` to refuse and name the session holding the lock and since when, so that I stop instead of competing.
    Example: `Story #1 is being delivered by session herdr:w3T:p1 since 16:15. Do not start another delivery.`
29. As a user whose orchestrator crashed, I want the lock to go stale like a claim, after `claims.staleAfter`, and `norn deliver <story> --takeover` to take my own lock at any age, so that I can always resume.
30. As an orchestrator, I want `norn wait` to refresh the lock on every check and release it when it exits 3, and `norn deliver <story> --stop` to release it at any time, so that a finished delivery never blocks the next one.
31. As a user, I want `norn next` and `norn status` to say when a story is being delivered, by which session and since when, so that I can see it before starting one.
32. As a user running `norn-drive` on an item of a story being delivered, I want drive not to offer starting another delivery, so that drive and deliver cooperate.

### Agents and panes under herdr

33. As an orchestrator under herdr, I want `norn next` to name each phase's agent `norn-<issue>-<step>`, so that a new phase never collides with the name of the previous one.
    Example: `norn-3-review`, then `norn-3-merge`.
34. As an orchestrator under herdr, I want `norn next` to print the command that stops the earlier agent when the item's pane still runs one and nobody holds the item, so that each phase reuses its pane instead of splitting a new one.
35. As an orchestrator, I want the `norn-deliver` skill to run `norn tidy` on every turn of the loop, so that worktrees and workspaces of merged slices go away as delivery goes on, not only at the end.
36. As an orchestrator, I want the skill to forbid scripts around norn, parsing its text, and typing into agents' panes other than with `herdr agent prompt`, so that what I do stays inside what norn and herdr guarantee.

### The deliver skill

37. As a user, I want `norn-deliver` to follow this loop: `norn deliver <story>`; `norn tidy`; `norn next <story>`; start an agent per start item; run `norn wait <story>` in the background; on exit 0 loop, on 3 run `norn tidy` and report, on 4 wait again, so that every orchestrator runs the same short loop.
38. As a user, I want the report at the end to include items norn escalated for stuck agents, with their panes, so that I know what to look at.

## Out of scope

- Running delivery off the laptop: GitHub Actions runners (#47), the webhook dispatcher (#68) and the identity question (#64). `norn wait`'s wake condition is written so the dispatcher can reuse it.
- Automations and triggers (#122) and Slack notifications (#67).
- Stuck detection for Claude Code subagents and the git provider. They rely on the briefing rule and stale claims.
- Merging the story PR into the base branch. It stays the owner's.
- Approving PRs, and branch protection setup (#43).
- Cutting down fresh sessions per phase. One fresh agent per step stays by design.
- Delivery metrics such as fix rounds per slice (#48).

## Open questions

1. Does auto mode let `norn done` through once the merge happens inside norn, or does its classifier infer the merge and block that too? Check it in the sandbox in the first slice of the merge work. If it is blocked, the permission rule in story 24 is needed before the merge slice is useful. (Jakub)
2. Is `Bash(norn:*)` the right Claude Code rule for both a global `norn` and `npx norn`, or are two rules needed? Check against Claude Code's permission docs. (Jakub)
3. Is 10m the right default for `deliver.stuckAfter`? An agent can sit idle at the end of a long tool call without being stuck. (Jakub)

## Plan

### Seams and tests

- **GitHub** gains three operations: read a PR's mergeability and its checks, and merge a PR at an expected head commit. The `gh` adapter implements them with `gh pr view --json mergeable,mergeStateStatus,statusCheckRollup,headRefOid` and `gh pr merge --merge --match-head-commit <sha>`. `FakeGitHub` gets the same, with seeded check states, so every refusal in stories 18–23 is a unit test.
- **Workspace** gains one read: the activity of the agent in a session's pane (`working`, `idle`, `blocked`, `gone`, `unknown`) and how long it has been in that state. The herdr implementation reads `herdr agent list`. Every other provider returns `unknown`. `FakeWorkspace` scripts it.
- **The wake condition** is one pure function over the `next` report: start now, stop, or keep waiting. It is tested on its own, without timers.
- **The wait loop** takes the clock and a sleep from the dependencies, so tests run it with a fake clock: timeout, back-off, lock refresh and stuck escalation all without real time.
- **Delivery locks** reuse the claim machinery under a second ref namespace, `refs/norn/deliveries/<story>`, with the same record and stale rule. Claims tests are the model.
- CLI behaviour is covered the usual way, through `w.norn(...)`, and the characterization snapshots gain `wait` and `deliver` in text and `--json`.

### Prefactoring

- Split `computeNext` from its notifications completely. The `settleLeftState` path can notify from inside `computeNext` today, so `norn wait` would notify on every check. Move that notification behind the same switch as `notifyWaiting`.
- Lift the claim functions so they take the ref namespace, so delivery locks need no copy of them.

### Decisions

- `norn wait` is level-triggered. It computes the full `next` report only when the cheap fingerprint changes, and it never writes beyond the follow-ups `next` already makes.
- Exit codes: 0 work to start, 3 stop, 4 timeout, 1 error, 2 refusal. They are documented in `docs/commands.md`.
- An item escalated for a stuck agent loses its claim, like `norn escalate`, so a person can take it with `norn-drive`. The pane is left as it is, for the person to read.
- norn merges a slice with a merge commit, as the briefing does today. It refuses when GitHub reports conflicts or a failing or pending check. A repository with no checks merges once the PR is mergeable.
- The merge happens inside the merge step's `done`, before the transition to `closed`. A failed merge changes no state and keeps the claim.
- `norn init` touches only the `permissions.allow` list of `.claude/settings.json` and creates the file when missing. `norn doctor` checks the rule only when `.claude/` exists.
- herdr agent names gain the step. The prompt text is unchanged.
- Skills change in `skills/`, never `.agents/skills/`. The release carries them, and `nornVersion` bumps the minor version.

### Slices

| # | Slice | Stories | Blocked by |
|---|---|---|---|
| 1 | Briefing rule and escalate wording in briefings and step skills | 10–12 | — |
| 2 | Permission rule in `init`, warning in `doctor` | 24–26 | — |
| 3 | GitHub mergeability, checks and merge at head, in the adapter and the fake | 18–20 (seam) | — |
| 4 | norn merges the slice in the merge step; briefing and `norn-merge` skill updated | 16–23 | 3 |
| 5 | Prefactor: `computeNext` sends no notifications; claim functions take a namespace | — | — |
| 6 | Delivery lock: `norn deliver`, `--stop`, `--takeover`, shown in `next` and `status`, respected by drive | 27–32 | 5 |
| 7 | `norn wait`: wake condition, polling with back-off, exit codes, timeout, lock refresh and release | 1–9 | 5, 6 |
| 8 | herdr agent activity in the workspace, stuck escalation in `norn wait` | 13–15 | 7 |
| 9 | herdr phase names and the stop-the-previous-agent line in `next` | 33–34 | — |
| 10 | `norn-deliver` skill rewritten around `deliver`, `wait` and `tidy`; report lists stuck escalations | 35–38 | 1, 6, 7, 9 |

Slices 1, 2, 3, 5 and 9 can start at once. Slice 4's QA answers open question 1. The whole story is QA'd in `norn-todo-sandbox` with a fresh epic, delivered end to end under herdr with auto mode on. It passes when it stops only for human QA.
