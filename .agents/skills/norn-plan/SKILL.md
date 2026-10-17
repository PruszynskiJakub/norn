---
name: norn-plan
description: Agree a spec's test seams, prefactoring and implementation decisions with the user and write them into its Plan section. Use when planning how to build a spec.
---

# Plan

The user agrees every seam and decision.

1. Read the spec and explore the code it touches. Use the project's vocabulary, and respect any recorded architecture decisions in the area.
2. **Seams.** Sketch the seams the Behaviour will be tested at. Prefer existing seams to new ones, and the highest seam that observes the behaviour. Propose any new seam as high as it can go. The fewer seams the better; the ideal number is one. When a module's interface or the seam's placement is itself in question, invoke the `norn-codebase-design` skill for the vocabulary.
3. **Prefactor.** Look for changes that make the story easy to build: make the change easy, then make the easy change. Slicing puts them first.
4. **Interview.** Invoke the `norn-interview` skill to agree the seams, the prefactoring and any implementation decision the code does not settle. Implementation treats the agreed seams as pre-agreed and writes tests nowhere else.
5. Write the Plan section in the layout below.

Done when every Behaviour item is observable at an agreed seam and the user agrees the plan.

## Plan layout

```markdown
## Plan

### Seams
Each seam: the module and its interface, the Behaviour items it observes, and prior-art tests to follow.

### Prefactoring
Changes that make the story easy to build, each with the reason.

### Implementation decisions
The modules built or changed, their interface changes, schema changes,
API contracts, architectural decisions, technical clarifications from the user.

### Testing decisions
What a good test means here (external behaviour through the seam, never internals),
which modules are tested, and what sits at a system boundary and may be mocked.
```

Describe modules and interfaces, not file paths or code: the plan outlives refactors. Exception: when a prototype produced a snippet that encodes a decision more precisely than prose (a state machine, a schema, a type shape), inline its decision-rich part and say it came from a prototype.
