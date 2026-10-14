---
name: review
description: Review a change on two axes, Spec (does it do what was asked) and Standards (does it follow the repo's standards and a smell baseline), in parallel subagents. Use when reviewing a PR or branch.
---

# Review

Two axes, kept apart so one cannot mask the other:

- **Spec**: does the change do what the issue and the spec ask, and nothing else?
- **Standards**: does it follow this repo's documented standards and the smell baseline?

1. **Pin the diff** against the branch the change targets: `git diff <base>...HEAD` and `git log <base>..HEAD --oneline`. An empty diff stops the review: report it instead.
2. **Gather the sources.** Spec: the issue with its acceptance criteria, and the spec's Behaviour and Plan (reviewing a whole story covers the whole spec). Standards: whatever the repo documents about how code is written (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, coding-standard docs), plus [SMELLS.md](SMELLS.md).
3. **Run both axes as parallel subagents**, each given the diff command, the commit list and its sources in full:
   - Spec: "Report (a) acceptance criteria or Behaviour items missing or partial; (b) behaviour in the diff nobody asked for; (c) criteria that look implemented but wrongly; (d) criteria without a test at a seam the Plan agreed, and tests that check internals or recompute their expected value. Quote the spec line for each finding. Under 400 words."
   - Standards: "Report (a) every breach of a documented standard, citing the file and the rule; (b) each smell from the baseline you spot, named, with the hunk quoted. Breaches of documented standards can be hard; smells are always judgement calls, and a documented standard overrides the baseline. Skip what tooling enforces. Under 400 words."
4. **Decide.** Every Spec finding and every hard Standards breach is a request. Add a smell only when it is worth a round of rework on its own.
5. Write each request as a concrete, checkable point (file, problem, expected result) under `## Spec` and `## Standards` headings. Keep the axes separate; do not merge or rerank them.

Done when both axes have reported and every finding is either a request or consciously dropped. The result is a verdict: approve, or request changes with the points.
