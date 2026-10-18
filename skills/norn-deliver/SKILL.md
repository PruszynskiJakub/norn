---
name: norn-deliver
description: Runs the unattended steps of a norn story, or any issue whose flow has slices such as an epic, its slices first, until it needs a human. Invoke as `norn-deliver <issue id>` once slicing is done.
argument-hint: "<story>"
---

# Deliver

"Story" below means the issue you were given: a story, or any issue whose flow has slices, which norn names by its type, e.g. an epic.

Run `norn tidy` first: it clears what closed issues left behind. Then deliver under herdr if you are in a herdr pane (`HERDR_ENV=1`); otherwise follow [Without herdr](#without-herdr).

## Under herdr

norn delivers the story itself: `norn deliver <story>` starts a supervised run for every step an agent can do, each agent in its own herdr pane, keeps each alive, retries or escalates the ones that stop, and starts the next step when one finishes, until only people can move the story on. You start it and tell the user where it runs.

1. Start `norn deliver <story>` in a herdr tab of its own, so it outlives your turn and the user can watch it:
   - `herdr tab create --cwd <repository root> --label norn-deliver-<story> --no-focus` gives the tab's pane in `.result.root_pane.pane_id`;
   - `herdr pane run <pane> "norn deliver <story>"`.

   If your permissions do not let you start it, e.g. Claude Code's auto mode blocks starting unattended agents, ask the user to run `norn deliver <story>` themselves in a herdr pane, and stop there.
2. Check it started: `herdr pane read <pane> --source recent-unwrapped --lines 20` shows `Delivering #<story>` and a line per run it started. If it refused instead, e.g. because another `norn deliver` already delivers the story, tell the user what it said.
3. Tell the user where it runs: the tab, and that each agent works in a `norn-<issue>` tab of its item's worktree, where they can watch it and step in. `norn deliver` prints a line for every run that starts and finishes, and ends with the report: what is merged, what waits and why, and who needs to act. When something waits for a person, norn notifies the user, unless notifications are off.

Done when `norn deliver` runs and you have told the user where. If the user asks you to wait for it, `herdr pane wait-output <pane> --match "Nothing runs and nothing can start."` returns when it ends; then run `norn tidy` once more and give them its report.

### Rules

- Never do a step's work, `norn take`, `norn done` or `norn release` an item yourself, and never start agents for items: the runs hold the items.
- If `norn deliver` stopped, e.g. the machine slept or its pane was closed, start it again: it carries on from GitHub, and runs still going are left to finish.
- If the user runs norn-drive in this session, do that step with them, then start `norn deliver <story>` again.

## Without herdr

You are the orchestrator. Every phase of the story's work happens in a fresh subagent; you only call norn and start, wait for, and report on subagents.

1. Run `norn next <story>`. It lists the items you can start now, each with its worktree, how many to run at once, and how to start an agent for the tool in use.
2. Start one fresh subagent per listed item, up to the limit `norn next` gives. It counts your agents already running; if it says to wait for one to finish, go to step 3.
   - **Claude Code:** a new subagent (not worktree isolation) with the prompt below.
   - **git:** create the worktree with the listed command if needed, then start a new agent session in the worktree with the `NORN_SESSION=norn-<issue>-<random>` that `norn next` lists for it, with the prompt below. Use the value from the latest `norn next`, never an earlier one: it makes each agent its own norn session.

   Prompt for each subagent: `Work in <worktree>. Run norn take <issue>, follow its briefing to the end, and finish with the norn command it gives.`
3. Wait for the subagents to finish. Then go back to step 1.
4. When all slices are merged, `norn next` offers the story's own unattended steps, e.g. its review, the agent's QA and any fixes; run them the same way.
5. Stop when `norn next` says there is nothing left that you can do. That covers the story reaching a human gate, where a person checks the work, only human-waiting items being left (also when a person is already doing them), and the story being closed. Run `norn tidy` once more. If `norn next` says it has already notified the user, it has; if notifications are off it says nothing about it, and your report is the only notice the user gets.

Done when you have run the final `norn tidy` and given the user the report: what is merged, what is waiting and why, and who needs to act. The reasons come from `norn status <story>` and the "Waiting for a human" list.

### Rules

- Each phase goes to a new subagent; your own context stays for orchestration.
- A claim not renewed for `claims.staleAfter` (2h by default) counts as abandoned. Tell subagents on long steps to run `norn take <issue>` again now and then; it refreshes their claim.
- Change state only through norn. Labels, branches and PRs belong to norn and the subagents.
- Never use `norn take --takeover`. An item held by another session may be a sibling still at work; leave it to go stale.
- Items marked "needs a human" or "needs human QA" are for people; leave them to them and carry on with the rest.
- If the user runs norn-drive in this session, do that step with them, then go back to step 1: the norn-deliver they asked for still stands, so do not ask again or wait for a yes.
- Known limit: under Claude Code, subagents share your norn session. Give each item to exactly one subagent, and never let a subagent run `norn done`, `release` or `escalate` on an item other than its own.
