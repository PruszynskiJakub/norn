---
name: resolve
description: psdd step for an issue flagged needs-human. Invoke when a psdd briefing names resolve.
---

# Resolve

Attended: a person is here because something needed them.

1. Read the latest needs-human comment on the issue: it gives the reason.
2. Work through it with the user until the cause is fixed or a decision is made. Record the outcome as an issue comment with `gh issue comment`.
3. Done when the issue can continue in its current state. Finish with `psdd done <issue>`; psdd clears needs-human and keeps the state.
