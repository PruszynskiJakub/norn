---
name: auto-qa
description: Check a change from the user's side, criterion by criterion, and collect the evidence for each, with a repro for every failure. Use when an agent QAs a slice or a story.
---

# Auto QA

You QA on your own and collect the evidence. A person may QA after you; your pack is where they start.

1. Pull the branch and run the full test suite.
2. Read who verifies what: the acceptance criteria of the slice (for a story: every Behaviour item in the spec) and the verifier in the slice body. When the body says a person must look at something, it says why; that reason marks what only a person can check.
3. Check every other criterion as a user would: run the app, the command, the request, never the tests. For each, record what you ran, what you saw, and the evidence: a screenshot, a log, the command's output. Save evidence files under names that say which criterion they belong to.
4. For each failure, capture a **repro**: the one command or the shortest user steps that show it, with expected and observed results. Make it as tight as you can: implementation turns it into a red test.
5. For what only a person can check, prepare what you can: how to run it, a URL, screenshots up to the point you could not pass. List it as left for a person.

Never pass a criterion you could not check: it is either left for a person, with the reason, or something you could not check, with why.

Redact every secret in what you record and in every evidence file: write `<REDACTED>` in its place, and crop or blur it in screenshots.

Done when every criterion has a result: passed with its evidence, failed with its repro, or left for a person or unchecked with the reason. The result is the evidence pack, one line per criterion, plus the evidence files; it is a fail if any criterion failed.
