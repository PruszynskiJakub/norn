---
name: triage
description: psdd step for a new, unlabeled issue; verifies it and prepares the accept-or-reject call. Invoke when a psdd briefing names triage.
---

# Triage

Attended: the user decides. You prepare the call.

1. **Gather context.** Read the issue with `gh issue view <issue> --comments` and explore the code it touches. Run two checks:
   - **Redundancy**: search the code for an existing implementation of the request by domain concept, not just the issue's wording. Note where you looked.
   - **Prior issues**: `gh issue list --state all --search "<concept>"` for an open duplicate, or a closed-as-not-planned issue that resembles this one.
2. **Verify the claim.** For a bug, reproduce it from the reporter's steps. For an enhancement, confirm the status quo it builds on. The result is one of: confirmed (with the code path), failed, or not enough detail to tell.
3. **Recommend.** Give the user a few lines: the problem, who it affects, what verification found, whether it is already built or duplicated, and your recommendation with its reason. Wait for their call.
4. On accept, post what triage established (verification result, code path, related issues) with `gh issue comment`, so refinement starts from it instead of redoing it.

Done when the user has decided. Finish with `accept`, or `reject` with the reason as the note. psdd posts the note, so write it for the reporter: for already built, say where it lives; for a duplicate, link it; otherwise a short, polite explanation.
