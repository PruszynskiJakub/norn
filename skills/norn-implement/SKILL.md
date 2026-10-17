---
name: norn-implement
description: Build an issue's change test-first at the seams its spec agreed, then review the diff before pushing. Use when implementing a slice or story, or reworking it after review or QA.
---

# Implement

1. Read the issue and the spec, its Seams and Testing decisions above all. For rework after review or QA, the points in the latest review or QA comment come first: each is a test to make red, and a QA failure gives its repro.
2. **Build test-first.** Invoke the `norn-tdd` skill and work red → green, one tracer bullet at a time. The seams in the spec's Plan were agreed with the user during planning: they are the pre-agreed seams the `norn-tdd` skill asks for. When a behaviour cannot be observed at any of them, use the highest existing seam that observes it and say so in the PR.
3. Run the typecheck and the test file you are in often, and the whole suite before each commit.
4. **Review pass.** Read your whole diff the way review will: every acceptance criterion (or review/QA point) met and nothing beyond it, the repo's documented standards, and the smells in [the `norn-review` skill's SMELLS.md](../norn-review/SMELLS.md). Refactor here, with the suite green after each change.

When a criterion cannot be met without a decision only a person can make, or something outside the change blocks you (a permission, a broken tool, a missing access), stop and hand it to a person with what blocked you. Never stop without saying so.

Done when every acceptance criterion (or every review/QA point) has a passing test at an agreed seam, the typecheck and the full suite are green, and the work is pushed with CI green.
