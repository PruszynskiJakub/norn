---
name: plan
description: psdd step for a story in needs-plan; writes the implementation plan into spec.md. Invoke when a psdd briefing names plan.
---

# Plan

Attended: agree the plan with the user.

1. Read the spec from your briefing and the code it touches.
2. Write the Plan section: the modules that change, the seams the tests sit at, and the order of work. Each step is something one agent can finish in one PR.
3. Note dependencies between steps; the slice skill turns them into blocked-by relations.
4. Commit spec.md and push it.
5. Done when the user agrees the plan. Finish with `psdd done <story>`.
