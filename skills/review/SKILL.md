---
name: review
description: psdd step for needs-review; reviews the slice PR or the story PR. Invoke when a psdd briefing names review.
---

# Review

1. Read the PR from your briefing with `gh pr view` and `gh pr diff`, and the spec it implements.
2. Check every behaviour the issue promises against the code and its tests, plus correctness, test quality at the seams, and fit with the surrounding code.
3. Write each request as a concrete, checkable point: file, problem, expected result.
4. Done when every changed file is read. Finish with `approve`, or `request-changes` with the points as the note. psdd posts the note as a comment.
