---
name: merge
description: psdd step for a slice in merge-queue; merges the slice PR into the story branch. Invoke when a psdd briefing names merge.
---

# Merge

1. In the slice worktree your briefing names, bring the slice branch up to date with the story branch: merge the story branch into it and resolve conflicts, keeping both sides' intent. Read the other slice's spec section when its change conflicts with yours.
2. Run the full test suite green, then push.
3. Merge the PR: `gh pr merge <pr> --merge`.
4. Done when the PR shows as merged. Finish with `psdd done <slice>`; psdd closes the slice and unblocks its dependents.
