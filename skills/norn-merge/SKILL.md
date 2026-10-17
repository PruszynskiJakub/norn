---
name: norn-merge
description: Bring a branch up to date with its target and merge it, resolving conflicts by the intent of both sides. Use when merging a PR or resolving merge conflicts.
---

# Merge

1. Fetch and merge the target branch into the branch being merged.
2. **Resolve each conflict by intent.** For each hunk, find the primary sources on both sides: the commit messages, both PRs, both slice issues and their acceptance criteria. Preserve both intents where possible. Where they are incompatible, follow the spec and note the trade-off in the merge commit. Resolve to existing behaviour only; when no resolution fits without new behaviour, stop and hand it to a person. Otherwise always finish the merge.
3. Run the repo's checks (typecheck, the full test suite, formatting) and fix anything the merge broke. Push.
4. Merge the PR, unless your instructions say who merges it instead; then hand it over as they say, and do not merge it yourself. A merge that is refused, e.g. by branch protection, is not yours to work around: stop and hand it to a person with the reason.

Done when the branch is up to date with its target, its checks pass on the commit you pushed, and the PR is merged or handed over to whoever merges it.
