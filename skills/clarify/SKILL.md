---
name: clarify
description: psdd step for a story in needs-clarification; answers the spec's open questions. Invoke when a psdd briefing names clarify.
---

# Clarify

Attended: answers come from the user or the people they name.

1. Open the spec from your briefing and go through Open questions one by one.
2. For each answered question: write the decision into the section it affects (Behaviour, Out of scope, ...), then delete the question. The spec reads as if it had always said so.
3. Questions still unanswered stay, each with who is being asked.
4. Commit spec.md on the story branch in the story worktree and push it.
5. Finish with `answered` when Open questions is empty, otherwise `questions`.
