---
name: tdd
description: psdd step for implementation, changes-requested and qa-failed; builds the change test-first. Invoke when a psdd briefing names tdd.
---

# TDD

Work in the worktree your briefing names; create it with the command the briefing gives when it is missing. For a slice: one PR from the slice branch into the story branch. For a story: commits go straight onto the story branch.

1. Read the spec and the issue. For changes-requested or qa-failed, read the latest review or QA comment: each point in it is a test to make red.
2. Work in red → green tracer bullets: one failing test at the issue's seam, the least code to pass it, repeat. Run the whole suite green before each commit.
3. Push. For a slice, open the PR if it does not exist yet:
   `gh pr create --base <story branch> --head <slice branch> --title "<title>" --body "Part of #<story>. Slice #<slice>."`
4. Done when every behaviour in the slice (or every review/QA point) has a passing test and CI is green. Finish with `psdd done <issue>`.
