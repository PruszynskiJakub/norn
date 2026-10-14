---
name: deliver
description: Runs a psdd story unattended from implementation until it needs a human. Invoke as `deliver <story id>` once slicing is done.
---

# Deliver

You are the orchestrator. Every phase of the story's work happens in a fresh subagent; you only call psdd and start, wait for, and report on subagents.

## Loop

1. Run `psdd next <story>`. It lists the items you can start now, each with its worktree, how many to run at once, and how to start an agent for the tool in use.
2. Start one fresh subagent per listed item, up to the limit `psdd next` gives:
   - **herdr:** create the worktree with the listed command if needed, then `herdr agent start psdd-<issue> --kind claude --pane <pane>` in the worktree's pane, with the prompt below.
   - **Claude Code:** a new subagent (not worktree isolation) with the prompt below.
   - **git:** create the worktree with the listed command if needed, then start a new agent session in the worktree with the `PSDD_SESSION=psdd-<issue>-<random>` that `psdd next` lists for it, with the prompt below. Use the value from the latest `psdd next`, never an earlier one: it makes each agent its own psdd session.

   Prompt for each subagent: `Work in <worktree>. Run psdd take <issue>, follow its briefing to the end, and finish with the psdd command it gives.`
3. Wait for the subagents to finish. Under herdr: `herdr agent wait psdd-<issue> --until done --until blocked`. Then go back to step 1.
4. When all slices are merged, `psdd next` offers story review and any story fixes; run them the same way.
5. Stop when `psdd next` says there is nothing left that you can do. That covers the story reaching story QA, only human-waiting items being left, and the story being closed. psdd has already notified the user of anything waiting for them.

Done when you have given the user the report: what is merged, what is waiting and why, and who needs to act. The reasons come from `psdd status <story>` and the "Waiting for a human" list.

## Rules

- Each phase goes to a new subagent; your own context stays for orchestration.
- A claim not renewed for `claims.staleAfter` (2h by default) counts as abandoned. Tell subagents on long steps to run `psdd take <issue>` again now and then; it refreshes their claim.
- Change state only through psdd. Labels, branches and PRs belong to psdd and the subagents.
- Items marked "needs a human" are for people; leave them to them and carry on with the rest.
- Known limit: under Claude Code, subagents share your psdd session. Give each item to exactly one subagent, and never let a subagent run `psdd done`, `release` or `escalate` on an item other than its own.
