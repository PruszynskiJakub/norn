---
name: norn-plan
description: Agree a spec's test seams, prefactoring and implementation decisions with the user and write them into its Plan section. Use when planning how to build a spec.
---

# Plan

The user agrees every seam and decision. The plan is what implementation builds to: it writes tests only at the agreed seams, and treats every decision here as settled. Anything left vague is decided later, by an agent, without the user.

## 1. Explore

Read the whole spec, then map it onto the code.

- **Where each Behaviour item lives.** For each item, find the module that does that work today, or the nearest one that will. Items that land in the same module usually share a seam.
- **The tests already there.** Find how this area is tested today: which interface the tests drive, their helpers and fixtures, what they fake. That is prior art to follow, and it shows which seams already exist.
- **The constraints.** Read the decision records (e.g. `docs/adr/`) and the glossary in the area. A decision record holds unless the user chooses to revisit it; say when the story would cut across one.
- **The friction.** Note what would make the story awkward to build: logic spread over several callers, a module whose interface is as wide as its body, a missing seam that would force tests onto internals, a name that disagrees with the glossary.

## 2. Seams

Sketch the seams the Behaviour will be tested at.

- Prefer an existing seam to a new one, and the highest seam that observes the behaviour: the one closest to what the user does. A test there survives refactors below it.
- Propose any new seam as high as it can go. The fewer seams the better; the ideal number is one.
- A seam is too low when the test must reach past the interface to check the result, or when it would mock the project's own modules. Move it up.
- A seam is too high when it cannot observe the result without a real network, a real clock or a real person. Keep the seam and fake only that boundary.

Build a coverage table: every Behaviour item against the seam that observes it. An item with no seam is a gap; close it with a seam, or take it to the user (step 5).

When a module's interface or the seam's placement is itself in question, invoke the `norn-codebase-design` skill for the vocabulary. When a new interface is central to the story, offer to design it twice ([DESIGN-IT-TWICE.md](../norn-codebase-design/DESIGN-IT-TWICE.md)): several radically different interfaces from parallel subagents, compared, with your recommendation.

## 3. Prefactor

Look for changes that make the story easy to build: make the change easy, then make the easy change. Slicing puts them first.

- Each prefactor changes no behaviour, lands green on its own, and is worth it for this story, not for tidiness.
- Typical ones: extract the module the story will grow; deepen a shallow interface the story would widen further; add the seam the tests need; rename to the glossary's term before the story spreads the old one.
- Say what each one buys: which Behaviour items get easier, and how.

No prefactor is a fine answer. Do not invent one.

## 4. Decide

List what the code does not settle and the implementation will need: interface changes, schema or file-format changes, contracts with other systems, error handling, migration of existing data or configuration, anything that is costly to change once shipped. For each, have a recommendation and its reason.

Name the risks too: the part most likely to go wrong, or not known to work. If a question can only be answered by trying (does the library do X, is it fast enough), propose a quick spike or prototype before the plan is agreed, rather than a guess in it.

A decision that is hard to reverse, surprising without its context, and the result of a real trade-off deserves a decision record. Offer one when all three hold, and only then.

## 5. Interview

Invoke the `norn-interview` skill to agree, in this order: the seams (with the coverage table), the prefactoring, then each decision. Implementation treats the agreed seams as pre-agreed and writes tests nowhere else.

If planning shows a Behaviour item is ambiguous, contradicts another, or costs far more than the user may expect, take it to the user rather than planning around it. With their agreement, amend the item in the spec. If it needs someone not present, it becomes an open question again, and the plan waits for it.

## 6. Write the Plan

Write the Plan section in the layout below. Do not renumber Behaviour from here on: the plan, slices, review and QA cite the numbers.

Then check it as implementation will read it:

- Every Behaviour item appears under exactly one seam.
- Every seam names its interface and the prior-art tests to copy, or says there are none.
- Every decision says what was chosen and why; none says "to be decided".
- What may be faked is named, and it is only system boundaries.
- No file paths or code, except a prototype snippet as below.

Done when every Behaviour item is observable at an agreed seam and the user agrees the plan.

## Plan layout

```markdown
## Plan

### Seams
Each seam: the module and its interface, the Behaviour items it observes, and prior-art tests to follow.

- **<module>, through <its interface>.** Observes Behaviour 1–4, 7.
  Prior art: <the existing tests in this area that drive the same interface>.

### Prefactoring
Changes that make the story easy to build, each with the reason.

1. <the change> — <what it makes easier, for which Behaviour items>

### Implementation decisions
The modules built or changed, their interface changes, schema changes,
API contracts, architectural decisions, technical clarifications from the user.

- <decision> — <why, and the alternative it beat when that matters>

### Testing decisions
What a good test means here (external behaviour through the seam, never internals),
which modules are tested, and what sits at a system boundary and may be mocked.

### Risks
What is most likely to go wrong or is not yet known to work, and how the slices meet it early.
```

Describe modules and interfaces, not file paths or code: the plan outlives refactors. Exception: when a prototype produced a snippet that encodes a decision more precisely than prose (a state machine, a schema, a type shape), inline its decision-rich part and say it came from a prototype.
