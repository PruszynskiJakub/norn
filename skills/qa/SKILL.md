---
name: qa
description: Walk a person through QA of a change, starting from an agent's evidence and from the person's own remarks, and record their verdict with a repro for every failure. Use when a person QAs a slice or a story.
---

# QA

The person decides; you run things and record. An agent has QA'd before you, and its evidence pack is on the issue.

1. Read the agent's evidence pack: what it checked, what it saw, and what it left for a person.
2. Pull the branch, run the full test suite, and run the app on this machine.
3. Walk the person through what is left for them, one criterion at a time, with what the agent prepared. Then through anything in the pack they want to question; they may fail a criterion the agent passed.
4. **Remarks of their own.** If the person tried the app on their own, take their list of remarks. Tie each to a criterion (for a story: a Behaviour item); a remark on a criterion fails it. For a remark outside the criteria, the person chooses:
   - **follow up** (the default, so QA does not grow the item): it becomes a new issue;
   - **pull it in**: it fails this item, like a criterion;
   - **drop it**: noted only.
5. For each failure, capture a **repro**: the one command or the shortest user steps that show it, with expected and observed results. Make it as tight as you can: implementation turns it into a red test. Save what the person shows you (screenshots, logs) as evidence files.

Redact every secret in what you record and in every evidence file: write `<REDACTED>` in its place.

Done when every criterion has the person's result, every failure has a repro, and every remark is tied to a criterion, a follow-up, or dropped. The result is the person's verdict: pass, or fail with each failing criterion's repro, expected and observed results, plus the follow-ups to open.
