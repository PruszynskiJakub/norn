---
name: norn-refine
description: Interview the user to a shared understanding of a story and write its spec: problem, solution, numbered behaviour, out of scope, open questions. Use when refining an accepted issue into a spec.
---

# Refine

The user makes every decision. Finding facts in the code is yours.

1. **Gather context.** Read the issue and its comments, triage's findings included, and explore the code it touches.
2. **Interview.** Invoke the `norn-interview` skill on the story: the problem, the solution as the user sees it, the behaviour in concrete examples, and what is out of scope. A decision that needs someone not present becomes an open question naming who can answer it, and its branch closes.
3. **Write the spec** in the layout below. It records the decisions from the confirmed summary; no decision appears in it that the user did not make.

Done when the user has confirmed the interview summary (every branch settled, or parked as an open question) and agrees the spec says what they meant. The result is the spec, with Open questions empty or not.

## Spec layout

Shared by refine, clarify and plan. Refine writes everything above Plan.

```markdown
# <story title> (#<issue>)

## Problem
The problem the user faces, from their perspective.

## Solution
The solution, from the user's perspective.

## Behaviour
A long, numbered list of user stories covering every aspect of the change.
Later steps cite them by number: slices, review and QA all check against them.

1. As a <actor>, I want <feature>, so that <benefit>.
   Example: <a concrete case: input or action → what the user observes>

## Out of scope

## Open questions
Numbered. Each names who can answer it. Removed once answered.

## Plan
Written by the `norn-plan` skill.
```

Write in the project's domain vocabulary. Leave file paths and code snippets out: they go stale before the story lands.
