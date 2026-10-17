---
name: norn-deliver
description: Runs the unattended steps of a norn story, or any issue whose flow has slices such as an epic, its slices first, until it needs a human. Invoke as `norn-deliver <issue id>` once slicing is done.
argument-hint: "<story>"
---

# Deliver

You are the orchestrator. Every phase of the story's work happens in a fresh agent; you only run norn, start agents, and report.

"Story" below means the issue you were given: a story, or any issue whose flow has slices, which norn names by its type, e.g. an epic.

## Loop

1. Run `norn deliver <story>`. It takes the story's delivery lock, so only one orchestrator delivers it. If it says another session is delivering the story, stop and tell the user which session and since when; start nothing.
2. Run `norn tidy`. It removes the worktrees and workspaces of merged slices as delivery goes on.
3. Run `norn next <story>`. Start one fresh agent per item it lists, up to the number it gives, exactly as it says:
   - **herdr:** create the worktree with the listed command if needed. If it says the pane still runs an earlier agent, stop that agent with the listed command first. Then run the listed `herdr agent start` and `herdr agent prompt` as they are. Add no flags.
   - **Claude Code:** a new subagent (not worktree isolation) with the prompt below.
   - **git:** create the worktree with the listed command if needed, then start a new agent session in the worktree with the `NORN_SESSION` the latest `norn next` lists for it, with the prompt below.

   Prompt for each agent: `Work in <worktree>. Run norn take <issue>, follow its briefing to the end, and finish with the norn command it gives.`

   If it lists nothing to start, go on to step 4.
4. Run `norn wait <story>` in the background, and act on its exit code when it ends:
   - **0**: something new can start. Go back to step 2.
   - **3**: nothing is left that you can do. Run `norn tidy`, then `norn next <story>` for the report, and stop.
   - **4**: it timed out. Run `norn wait <story>` again.
   - Anything else: it says why. Do what it says, or report to the user and stop.

`norn wait` holds the delivery lock while it waits and releases it when it exits 3. If you stop before that, run `norn deliver <story> --stop`.

Done when `norn wait` has exited 3, you have run the final `norn tidy`, and given the user the report: what is merged, what is waiting and why, who needs to act, and each item norn escalated because its agent stopped, with the agent's pane. The reasons come from `norn status <story>`, the "Waiting for a human" list of `norn next`, and the escalations `norn wait` printed. If `norn next` says it has already notified the user, it has; if notifications are off it says nothing about it, and your report is the only notice the user gets.

## Rules

- `norn wait` does the waiting. Never write a monitor, a script or a sleep loop around norn, and never decide what to do by matching norn's text: read it as instructions, and add `--json` when you need its data.
- Type into an agent's pane only with `herdr agent prompt`. Never send keys or text to a pane any other way.
- Each phase goes to a new agent; your own context stays for orchestration.
- Change state only through norn. Labels, branches and PRs belong to norn and the agents. norn merges slice PRs itself; the story PR into the base branch is its owner's to merge.
- Never use `norn take --takeover`. An item held by another session may be a sibling still at work. If its agent stopped, `norn wait` escalates it.
- Items marked "needs a human" or "needs human QA" are for people; leave them to them and carry on with the rest.
- If the user runs norn-drive in this session, do that step with them, then go back to step 2: the norn-deliver they asked for still stands, so do not ask again or wait for a yes.
- Known limit: under Claude Code, subagents share your norn session. Give each item to exactly one subagent, and never let a subagent run `norn done`, `release` or `escalate` on an item other than its own.
