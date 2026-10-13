---
name: slice
description: psdd step for a story in needs-slicing; creates slice issues from the plan. Invoke when a psdd briefing names slice.
---

# Slice

Attended: agree the slices with the user before creating them.

1. Turn the Plan section of the spec into vertical slices: each is one PR that leaves the story branch working, with its own tests.
2. Decide each slice's mode with the user: `afk` when an agent can verify it with tests, `hil` when a person must look at it.
3. Create slices in dependency order, so blockers exist before the slices they block:

   ```
   psdd add-slice <story> "title" --mode afk|hil [--blocked-by <slice>]...
   ```

4. Add a body to each slice with `gh issue edit <slice> --body` that names its part of the plan and its acceptance examples.
5. Done when every plan step is covered by a slice. Finish with `psdd done <story>`.
