---
name: merge
description: psdd step for a slice in merge-queue; merges the slice PR into the story branch, resolving conflicts by intent. Invoke when a psdd briefing names merge.
---

# Merge

1. In the slice worktree your briefing names, fetch and merge `origin/<story branch>` into the slice branch.
2. **Resolve each conflict by intent.** For each hunk, find the primary sources on both sides: the commit messages, both PRs, both slice issues and their acceptance criteria. Preserve both intents where possible. Where they are incompatible, follow the spec and note the trade-off in the merge commit. Resolve to existing behaviour only; when no resolution fits without new behaviour, run `psdd escalate`. Always finish the merge.
3. Run the repo's checks (typecheck, the full test suite, formatting) and fix anything the merge broke. Push.
4. Merge the PR: `gh pr merge <pr> --merge`.

Done when the PR shows as merged. Finish with `psdd done <slice>`; psdd closes the slice and unblocks its dependents.
