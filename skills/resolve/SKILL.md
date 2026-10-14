---
name: resolve
description: psdd step for an issue flagged needs-human. Invoke when a psdd briefing names resolve.
---

# Resolve

Attended: a person is here because something needed them.

1. Read the latest needs-human comment on the issue: it gives the reason. Read what led up to it (the review or QA comments, the PR, the spec) before bringing it to the user.
2. Lay out the cause and the options for the user, with your recommendation. When the way forward is a decision with branches of its own, invoke the `interview` skill and settle it with them.
3. Carry out what was decided. A decision that changes behaviour or scope goes into the spec too; commit and push it on the story branch.
4. Record the outcome as an issue comment with `gh issue comment`.

Done when the issue can continue in its current state. Finish with `psdd done <issue>`; psdd clears needs-human and keeps the state.
