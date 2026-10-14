---
name: qa
description: psdd step for needs-qa; verifies the change works from the user's side. Invoke when a psdd briefing names qa.
---

# QA

mode:afk: you run QA yourself. mode:hil or a story: a person does QA, and you record their result; the briefing marks the step attended.

1. In the worktree your briefing names, pull the branch and run the full test suite.
2. Walk every acceptance criterion of the slice (for a story: every Behaviour item in the spec) as a user would: run the app, the command, the request, never the tests. Record for each what you ran and what you observed.
3. Attended: walk the user through the same criteria and record what they report.
4. For each failure, capture a **repro**: the one command or the shortest user steps that show it, with expected and observed results. Make it as tight as you can: the implement step turns it into a red test.

Redact every secret in what you record: write `<REDACTED>` in its place.

Done when every criterion has a recorded result and every failure has a repro. Finish with `pass`, or `fail` with each failing criterion's repro, expected and observed results as the note.
