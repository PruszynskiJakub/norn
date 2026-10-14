---
name: clarify
description: psdd step for a story in needs-clarification; settles the spec's open questions. Invoke when a psdd briefing names clarify.
---

# Clarify

Attended: answers come from the user or the people each question names.

1. Open the spec from your briefing. Read Open questions together with the Behaviour they bear on, and check the issue comments for answers given since refinement.
2. **Interview.** Invoke the `interview` skill on the open questions. An answer often opens new branches; the interview follows them. For a question whose answerer is not here, draft it so the user can put it to them, and offer to post it on the issue with `gh issue comment`, mentioning them.
3. For each settled question, write the decision into the section it affects (Problem, Behaviour, Out of scope, ...), then delete the question. The spec reads as if it had always said so.
4. A question still unanswered stays, with who is being asked.
5. Commit spec.md on the story branch in the story worktree and push it.

Done when every open question is either settled into the spec or waiting on a named person, and the user agrees. Finish with `answered` when Open questions is empty, otherwise `questions`.
