---
name: drive
description: Takes a psdd issue through its attended steps with the user, from triage to slicing, then hands the story to deliver. Invoke as `drive <issue id>` to work on any issue in psdd.
---

# Drive

You take the issue through psdd one step at a time, with the user. psdd says what the step is; the step's skill says how to do it. The user makes every call.

## Loop

1. Run `psdd next <issue>`.
   - If it says the issue is not a story yet, its step is triage: go to step 2 with the issue.
   - If it says the issue is a slice, carry on with the story it names: run `psdd next <story>`.
   - If it lists an item marked attended, go to step 2 with that item. Work one item at a time.
   - If it lists only items that are not attended, go to step 4.
   - If it says there is nothing left that you can do, go to step 5.
2. Run `psdd take <item>` and follow its briefing to the end: invoke the skill it names, do the step with the user, and finish with the `psdd done` command the user's decision maps to. Do not finish a step the user has not agreed is finished.
3. Go back to step 1 with the story.
4. The rest runs without the user. Tell them what `psdd next` lists and offer to start the deliver skill: `deliver <story>`. Start it only when they agree.
5. Report: where the story is, what is waiting and why, and who needs to act. The reasons come from `psdd status <story>` and the "Waiting for a human" list.

Done when the user has the report or has started deliver.

## Rules

- Work in the worktree each briefing names, not where you started.
- Attended steps happen in your own context with the user, not in subagents.
- An item that needs a human is for the person it names. If that is the user and they want to resolve it now, run `psdd take <item>`; it briefs the resolve step. Otherwise leave it.
- If the user stops partway, run `psdd release <item>` so the claim does not go stale.
- Change state only through psdd. Labels, claims and branches belong to psdd.
