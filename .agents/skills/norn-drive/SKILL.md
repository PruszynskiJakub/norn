---
name: norn-drive
description: Takes a norn issue through its attended steps with the user, from triage to slicing and QA by a person, and hands the rest to norn-deliver. Invoke as `norn-drive <issue id>` to work on any issue in norn: a new issue, a story or one of its slices.
argument-hint: "<issue | story | slice>"
---

# Drive

You take the issue through norn one step at a time, with the user. norn says what the step is; the step's skill says how to do it. The user makes every call.

## Loop

1. Run `norn next <issue>`.
   - If it says the issue is not a story yet, its step is triage: go to step 2 with the issue.
   - If it says the issue is a slice, carry on with the story it names: run `norn next <story>`.
   - If it lists an item marked attended, go to step 2 with that item. Work one item at a time.
   - If it lists only items that are not attended, go to step 4.
   - If it says there is nothing left that you can do, go to step 5.
   - If the item says to hand the story to an agent in its worktree, go to step 6.
   - If it lists an item waiting for the user that says to hand it to an agent in its worktree, and the user does it now, go to step 6 with that item.
   - If it lists an item as held by another session of yours, go to step 7 with that item.
2. Run `norn take <item>` and follow its briefing to the end. If take says the item is held by another session of yours, go to step 7. Otherwise: invoke the skill it names, do the step with the user, and finish with the `norn done` command the user's decision maps to. Do not finish a step the user has not agreed is finished.
3. Go back to step 1 with the story.
4. The rest runs without the user. If this session is running norn-deliver on the story, go back to its loop. Otherwise tell them what `norn next` lists and offer to start the norn-deliver skill: `norn-deliver <story>`. Start it only when they agree.
5. Report: where the story is, what is waiting and why, and who needs to act. The reasons come from `norn status <story>` and the "Waiting for a human" list. If the story is closed, run `norn tidy` first: it removes the story's worktrees, merged branches and QA evidence.
6. Hand over (herdr only), the story or an item for the user. Create the worktree with the listed command if needed. Find its pane: `herdr worktree list --cwd <repo root>` gives the worktree's `open_workspace_id`, and `herdr pane list --workspace <id>` its pane. Run the listed `herdr agent start`, `herdr agent prompt` and `herdr agent focus` commands with that pane. If the pane list shows an agent in the pane already, skip `agent start` and use the pane id in place of the agent name. Tell the user the work goes on with the agent in that workspace, and stop. The new agent runs this skill from the worktree.
7. Pick up a stopped session. An earlier session of the user's holds the item, e.g. one they closed partway through a step. Ask the user whether that session is still running.
   - Still running: tell them to carry on there, and stop.
   - Stopped: run `norn take <item> --takeover`, then `norn release <item>`. The item is free again, in the same state, with the earlier session's work kept in its worktree. If the user wants to go on, go back to step 1: `norn next` says where to take it, which under herdr is a hand-off to the worktree. Otherwise stop.

Done when the user has the report, has started norn-deliver, or the story has been handed over or left to a running session.

## Rules

- Work in the worktree each briefing names, not where you started.
- Attended steps happen in your own context with the user, not in subagents.
- An item that needs a human, or needs human QA, is for the person it names. If that is the user and they want to do it now: where `norn next` says to hand it to an agent in its worktree, go to step 6; otherwise run `norn take <item>` and go on as in step 2: it briefs the resolve step, or the qa step, which starts from the agent's evidence on the issue and takes any remarks of the user's own. Otherwise leave it.
- Prompted `norn-drive <item>` for an item for the user, in its worktree, you were handed it because the user does it now: take it.
- If the user stops partway, run `norn release <item>` so the claim does not go stale.
- Use `--takeover` only when the user says the other session has stopped.
- Change state only through norn. Labels, claims and branches belong to norn.
