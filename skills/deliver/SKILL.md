---
name: deliver
description: Runs a shepherd story unattended from implementation until it needs a human. Invoke as `deliver <story id>` once slicing is done.
---

# Deliver

You are the orchestrator. Every phase of the story's work happens in a fresh subagent; you only call shepherd and start, wait for, and report on subagents.

## Loop

Run `shepherd tidy` once before the loop: it clears what closed issues left behind.

1. Run `shepherd next <story>`. It lists the items you can start now, each with its worktree, how many to run at once, and how to start an agent for the tool in use.
2. Start one fresh subagent per listed item, up to the limit `shepherd next` gives. It counts your agents already running; if it says to wait for one to finish, go to step 3.
   - **herdr:** create the worktree with the listed command if needed, then run the listed `herdr agent start` with the worktree's pane and the listed `herdr agent prompt` as they are. Add no flags: step 3 does the waiting, and `--timeout` without `--wait` fails.
   - **Claude Code:** a new subagent (not worktree isolation) with the prompt below.
   - **git:** create the worktree with the listed command if needed, then start a new agent session in the worktree with the `SHEPHERD_SESSION=shepherd-<issue>-<random>` that `shepherd next` lists for it, with the prompt below. Use the value from the latest `shepherd next`, never an earlier one: it makes each agent its own shepherd session.

   Prompt for each subagent: `Work in <worktree>. Run shepherd take <issue>, follow its briefing to the end, and finish with the shepherd command it gives.`
3. Wait for the subagents to finish. Under herdr: `herdr agent wait shepherd-<issue> --until done --until blocked`. Then go back to step 1.
4. When all slices are merged, `shepherd next` offers story review, the agent's story QA and any story fixes; run them the same way.
5. Stop when `shepherd next` says there is nothing left that you can do. That covers the story reaching QA by a person, only human-waiting items being left (also when a person is already doing them), and the story being closed. Run `shepherd tidy` once more. If `shepherd next` says it has already notified the user, it has; if notifications are off it says nothing about it, and your report is the only notice the user gets.

Done when you have run the final `shepherd tidy` and given the user the report: what is merged, what is waiting and why, and who needs to act. The reasons come from `shepherd status <story>` and the "Waiting for a human" list.

## Rules

- Each phase goes to a new subagent; your own context stays for orchestration.
- A claim not renewed for `claims.staleAfter` (2h by default) counts as abandoned. Tell subagents on long steps to run `shepherd take <issue>` again now and then; it refreshes their claim.
- Change state only through shepherd. Labels, branches and PRs belong to shepherd and the subagents.
- Never use `shepherd take --takeover`. An item held by another session may be a sibling still at work; leave it to go stale.
- Items marked "needs a human" or "needs human QA" are for people; leave them to them and carry on with the rest.
- If the user runs drive in this session, do that step with them, then go back to step 1: the deliver they asked for still stands, so do not ask again or wait for a yes.
- Known limit: under Claude Code, subagents share your shepherd session. Give each item to exactly one subagent, and never let a subagent run `shepherd done`, `release` or `escalate` on an item other than its own.
