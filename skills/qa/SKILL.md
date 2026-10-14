---
name: qa
description: Verify a change works from the user's side, criterion by criterion, with a repro for every failure. Use when QA-ing a slice or a story.
---

# QA

You run QA yourself, or, when a person does it, you walk them through and record what they report.

1. Pull the branch and run the full test suite.
2. Walk every acceptance criterion of the slice (for a story: every Behaviour item in the spec) as a user would: run the app, the command, the request, never the tests. Record for each what you ran and what you observed.
3. With a person doing QA: walk them through the same criteria and record what they report.
4. For each failure, capture a **repro**: the one command or the shortest user steps that show it, with expected and observed results. Make it as tight as you can: implementation turns it into a red test.

Redact every secret in what you record: write `<REDACTED>` in its place.

Done when every criterion has a recorded result and every failure has a repro. The result is pass, or fail with each failing criterion's repro, expected and observed results.
