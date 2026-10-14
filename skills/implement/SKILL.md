---
name: implement
description: psdd step for implementation, changes-requested and qa-failed; builds the change test-first at the plan's seams. Invoke when a psdd briefing names implement.
---

# Implement

Work in the worktree your briefing names; create it with the command the briefing gives when it is missing. For a slice: one PR from the slice branch into the story branch. For a story: commits go straight onto the story branch.

1. Read the issue and the spec, its Seams and Testing decisions above all. For changes-requested or qa-failed, read the latest review or QA comment: each point in it is a test to make red, and a QA failure gives its repro.
2. **Build test-first.** Invoke the `tdd` skill and work red → green, one tracer bullet at a time. The seams in the spec's Plan were agreed with the user during planning: they are the pre-agreed seams the tdd skill asks for. When a behaviour cannot be observed at any of them, use the highest existing seam that observes it and say so in the PR body.
3. Run the typecheck and the test file you are in often, and the whole suite before each commit. After each commit, run `psdd take <issue>` again: it keeps your claim fresh, so a long step is not taken for abandoned.
4. **Review pass.** Read your whole diff the way the review step will: every acceptance criterion (or review/QA point) met and nothing beyond it, the repo's documented standards, and the smells in `skills/review/SMELLS.md`. Refactor here, with the suite green after each change.
5. Push. For a slice, open the PR if it does not exist yet:
   `gh pr create --base <story branch> --head <slice branch> --title "<title>" --body "Part of #<story>. Slice #<slice>."`

Done when every acceptance criterion (or every review/QA point) has a passing test at an agreed seam, and the typecheck, the full suite and CI are green. Finish with `psdd done <issue>`.
