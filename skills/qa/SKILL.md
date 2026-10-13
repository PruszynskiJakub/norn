---
name: qa
description: psdd step for needs-qa; verifies the change works from the user's side. Invoke when a psdd briefing names qa.
---

# QA

mode:afk: you run QA yourself. mode:hil or a story: a person does QA, and you record their result; the briefing marks the step attended.

1. Check out the branch from your briefing and run the full test suite.
2. Walk every Behaviour example in the spec that this issue covers, as a user would: run the app, the command, the request. Record what you saw for each.
3. Attended: walk the user through the same examples and record what they report.
4. Done when every covered example has a recorded result. Finish with `pass`, or `fail` with the failing examples and what was observed as the note.
