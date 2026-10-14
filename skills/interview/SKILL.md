---
name: interview
description: Relentless one-question-at-a-time interview that reaches shared understanding on a plan, design or task before any action is taken. Ends in a summary the user confirms.
argument-hint: "[topic]"
---

Interview the user relentlessly about $ARGUMENTS until we reach a shared understanding.
No topic → the task pending in this conversation; nothing pending → first ask what we are deciding.

Before the first question, explore the project (and the issue, spec or PR being discussed, if any) for a foundational understanding. Never ask what the exploration already answered — ask only for decisions and preferences.

Walk down each branch of the design tree, resolving decisions one by one. Ask **one question per turn** — never lettered sub-questions — in plain text, each with your recommended answer, and wait for the reply before continuing. When showing is easier than describing, the caller may use the `prototype` skill; the interview itself enacts nothing.

When no branch remains open, post a summary of decisions in chat — one line each, grouped by branch, assumptions marked — and ask for confirmation. A correction reopens only its branch. Confirmation ends the interview; it does not approve the work. If another skill called this one (refine, clarify, plan), hand back to it: it folds the decisions into its own document. A "go ahead" to the summary is not a request to do anything else.

Write nothing and change nothing: the interview only talks.
