---
name: triage
description: psdd step for a new, unlabeled issue. Invoke when a psdd briefing names triage.
---

# Triage

Attended: the user decides. You prepare the call.

1. Read the issue and its comments with `gh issue view <issue> --comments`.
2. Summarise for the user in a few lines: the problem, who it affects, whether it fits the product, and any duplicate you find with `gh issue list --search`.
3. Ask the user to accept or reject. Done when the user has given an answer.
4. Finish with the command from your briefing: `accept`, or `reject` with the user's reason as the note.
