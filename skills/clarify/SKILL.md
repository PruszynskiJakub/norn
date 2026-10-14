---
name: clarify
description: Settle a spec's open questions with the user and the people they name, folding each answer into the spec. Use when a spec has open questions.
---

# Clarify

Answers come from the user or the people each question names.

1. Read the spec's Open questions together with the Behaviour they bear on, and check the issue's comments for answers given since refinement.
2. **Interview.** Invoke the `interview` skill on the open questions. An answer often opens new branches; the interview follows them. For a question whose answerer is not here, draft it so the user can put it to them, and offer to post it on the issue, mentioning them.
3. For each settled question, write the decision into the section it affects (Problem, Behaviour, Out of scope, ...), then delete the question. The spec reads as if it had always said so.
4. A question still unanswered stays, with who is being asked.

Done when every open question is either settled into the spec or waiting on a named person, and the user agrees. The result is the spec, with Open questions empty or not.
