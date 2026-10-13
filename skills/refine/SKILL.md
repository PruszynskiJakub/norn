---
name: refine
description: psdd step for a story in needs-refinement; writes the story's spec.md. Invoke when a psdd briefing names refine.
---

# Refine

Attended: the user takes part in every decision.

The spec lives at the path in your briefing. Its layout, shared by refine, clarify and plan:

```markdown
# <story title> (#<issue>)

## Problem
## Behaviour        <!-- what the user observes, as concrete examples -->
## Out of scope
## Open questions   <!-- numbered; removed once answered -->
## Plan             <!-- written by the plan skill -->
```

1. Read the issue with `gh issue view <issue> --comments`, and the code it touches.
2. Draft Problem, Behaviour and Out of scope with the user. Behaviour is a set of concrete examples the user agrees with.
3. Put every unknown you cannot settle with the user now under Open questions. Each question names who can answer it.
4. Commit spec.md and push it, so the link psdd posts resolves.
5. Done when the user agrees refinement is finished. Finish with `clear` when Open questions is empty, otherwise `questions`.
