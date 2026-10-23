---
name: norn-refine
description: Interview the user to a shared understanding of a story and write its spec: problem, solution, numbered behaviour, out of scope, open questions. Use when refining an accepted issue into a spec.
---

# Refine

The user makes every decision. Finding facts in the code is yours. The spec is the contract every later step checks against: slices name its Behaviour items, review checks the diff against them, QA walks them one by one. A gap here is a gap in all of them.

## 1. Gather context

Before the first question, know the ground as well as the code can teach it.

- **The issue.** Read it and every comment. Triage's findings are a starting point, not a re-ask: what it verified, the code path it found, the related issues it linked.
- **The status quo.** Find where the code does today what the story changes, and run it if that is cheap. Note what users observe now; the Problem is written against it.
- **The vocabulary.** Read the project's glossary (e.g. `CONTEXT.md`, `GLOSSARY.md`) and the decision records (e.g. `docs/adr/`) in the area. The spec uses those terms; a decision record constrains the solution unless the user chooses to revisit it.
- **Neighbours.** Look for behaviour the story will rub against: other commands or screens on the same data, configuration, help text, docs, error paths. These are where the hidden Behaviour items live.
- **Outside facts.** A fact that lives outside the repository (a third-party API, a platform limit) is yours to look up too. Delegate long reading to a subagent and keep interviewing on the branches that do not wait on it.

## 2. Interview

Invoke the `norn-interview` skill on the story. Walk the branches in this order, since each settles ground for the next:

1. **Problem.** Who has it, when it bites, what they do today instead. A problem stated as a missing feature ("there is no X") is not yet a problem; ask what X would let them do.
2. **Solution.** The change as the user will meet it, not how it is built. If two shapes are plausible, put both with your recommendation.
3. **Behaviour.** Concrete examples, one at a time: an input or action and what the user observes. Then probe the edges the user has not mentioned (see the checklist below).
4. **Scope.** What a reader might expect the story to cover that it will not.

While interviewing, hold the language and the claims to account:

- **Challenge terms against the glossary.** "The glossary defines a *claim* as X, but you seem to mean Y. Which is it?"
- **Sharpen fuzzy words.** When a word could mean two things (*user*, *done*, *sync*), propose the precise term and ask which is meant.
- **Invent scenarios.** Stress the boundaries with specific cases: the empty list, the second run, two people at once, the item deleted halfway through.
- **Cross-check with the code.** When the user says how something works today, check it. "The code closes the whole issue, but you said partial closing is possible. Which is right?"

A decision that needs someone not present becomes an open question naming who can answer it, and its branch closes. A branch is not closed by your assumption: an assumption the user has not confirmed is an open question too.

### Edge checklist

Walk it before you call the Behaviour branch settled. Skip an item only when it plainly does not apply.

- First use, empty state, nothing to show.
- Invalid input, missing input, input at its limits.
- Failure of what the story depends on: network, permissions, a missing file or account.
- Repeating the action; undoing it; doing it twice at once.
- Existing data, configuration and users: what happens to them when this ships.
- Every place the change is visible: output, messages, help, docs, other commands or screens that show the same thing.
- Who may do it, and what the others see.

## 3. Write the spec

Write the spec in the layout below. It records the decisions from the confirmed summary; no decision appears in it that the user did not make. [EXAMPLE.md](EXAMPLE.md) shows a short spec written to this standard.

**Behaviour is the heart of it, and it should be long.** Each item:

- is one behaviour, observable by its actor without reading the code;
- has a concrete example: an input or action, and what the user sees;
- can be checked on its own, so review and QA can cite it by number;
- covers failures and edges as items of their own, not as an afterthought in another item's example.

| Weak                                              | Strong                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| As a user, I want errors handled well.            | As a user who runs `export` without a project, I want to be told which project flag is missing, so that I can rerun it. Example: `export` → "No project given. Pass --project <name>." and exit code 2. |
| As a user, I want the list to be fast and sorted. | Two items: one on sort order (with an example), one on the size limit and what happens past it.                                              |

**Out of scope** names each thing left out and, in a few words, why, so nobody gold-plates towards it later.

**Open questions** are numbered and self-contained. Each says what is undecided, why it matters (the Behaviour items it bears on), the options as you see them with your recommendation, and who can answer it.

**Glossary.** When the interview settled a new term or sharpened an existing one, tell the user and, with their agreement, update the project's glossary alongside the spec. The glossary holds definitions only, never decisions or implementation.

## 4. Check before handing over

Read the spec once more as the next step will.

- Every decision in the confirmed summary appears in the spec, and nothing appears that is not in it.
- Every Behaviour item has an example and is observable without reading the code.
- The edge checklist is reflected: covered by an item, out of scope, or an open question.
- Problem and Solution are told from the user's side, in the project's terms.
- No file paths, function names or code snippets.

Done when the user has confirmed the interview summary (every branch settled, or parked as an open question) and agrees the spec says what they meant. The result is the spec, with Open questions empty or not.

## Spec layout

Shared by refine, clarify and plan. Refine writes everything above Plan.

```markdown
# <story title> (#<issue>)

## Problem
The problem the user faces, from their perspective: who, when, and what it costs them today.

## Solution
The solution, from the user's perspective: what they will do and see.

## Behaviour
A long, numbered list of user stories covering every aspect of the change.
Later steps cite them by number: slices, review and QA all check against them.

1. As a <actor>, I want <feature>, so that <benefit>.
   Example: <a concrete case: input or action → what the user observes>

## Out of scope
- <what is left out> — <why, in a few words>

## Open questions
Numbered. Each names who can answer it. Removed once answered.

1. <the undecided point> (bears on Behaviour <n>)
   Options: <a> / <b>. Recommended: <a>, because <reason>.
   Who: <person or role>

## Plan
Written by the `norn-plan` skill.
```

Write in the project's domain vocabulary. Leave file paths and code snippets out: they go stale before the story lands.
