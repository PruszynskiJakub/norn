---
name: norn-clarify
description: Settle a spec's open questions with the user and the people they name, folding each answer into the spec. Use when a spec has open questions.
---

# Clarify

Answers come from the user or the people each question names. Facts are still yours: never ask a person what the code, the docs or the issue can tell you.

## 1. Take stock

Read the whole spec, not only Open questions: each answer lands in another section, and you must know what is there. Then read the issue's comments since refinement, and sort every open question into one of these:

- **Answered already.** Someone replied on the issue, or the user settled it elsewhere. Confirm the reading with the user, then fold it in.
- **A fact, not a decision.** The code, the docs or a third-party API can answer it. Look it up (a subagent for long reading), and bring back what you found; if a decision still follows from the fact, it stays open as that decision.
- **Gone.** Another answer, or a change in the code since, has made it moot. Tell the user and, once they agree, delete it.
- **For the user.** Theirs to decide now.
- **For someone else.** Only the person it names can decide.

Order what is left by dependency: a question whose answer changes others comes first.

## 2. Interview

Invoke the `norn-interview` skill on the questions that are the user's. Give each with its context (what it bears on, the options, your recommendation), so the user does not have to reread the spec to answer.

An answer often opens new branches: an edge nobody thought of, a Behaviour item it now contradicts, a term it puts in doubt. The interview follows them to the end; they are part of this step, not the next one. When an answer contradicts a decision already in the spec, say so and let the user choose which stands.

When an answer grows the story well past what refinement agreed, say so. Offer to put the extra part out of scope, as a follow-up issue the user files, rather than letting the story swell.

## 3. Ask the people who are not here

For each question whose answerer is not present, draft it so the user can put it to them as it stands. The person has not read the spec: the draft carries everything they need.

```markdown
@<person> a decision for <story title>: <the question, in one sentence>

Context: <two or three sentences: what the story does and where this point comes up>
Options:
- <a>: <what it means for users>
- <b>: <what it means for users>
Recommended: <a>, because <reason>.
```

Offer to post it on the issue, mentioning them. Post only when the user agrees. In the spec, the question stays, with who is being asked and where.

## 4. Fold the answers in

For each settled question, write the decision into the section it affects, then delete the question. The spec reads as if it had always said so.

- **Behaviour.** Add the items the answer creates, each with its example; rewrite the items it changes; drop the ones it removes. Nothing cites the numbers yet, so keep the list in a readable order.
- **Out of scope.** An answer of "not now" is an out-of-scope entry with its reason, not a deleted question.
- **Problem and Solution.** Rewrite when the answer changes who the story is for or what they will see.
- **Glossary.** A term the answer settled goes into the project's glossary, with the user's agreement.

Then read the whole spec again. An answer in one place often breaks a sentence in another: an example that no longer holds, an out-of-scope entry that is now in scope, two items that now say the same thing. Fix them with the user.

| Weak fold                                                     | Strong fold                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appends "Q1: Marta says archived projects do not count." to Behaviour 1. | Adds Behaviour 10: "As an owner on a plan with a project limit, I want archived projects not to count, so that archiving frees a slot. Example: limit 5, 5 live → archive one → can create a new project." Deletes Q1. |

## 5. Check before handing over

- Every question is folded in, gone with the user's agreement, or waiting on a named person.
- No answer survives only as a note: each one changed the section it affects.
- The spec reads as one consistent document, with no trace of the question-and-answer.

Done when every open question is either settled into the spec or waiting on a named person, and the user agrees. The result is the spec, with Open questions empty or not.
