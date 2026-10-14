---
name: triage
description: Verify a new issue and prepare the accept-or-reject call for the user. Use when triaging an issue.
---

# Triage

The user decides. You prepare the call.

1. **Gather context.** Read the issue and its comments, and explore the code it touches. Run two checks:
   - **Redundancy**: search the code for an existing implementation of the request by domain concept, not just the issue's wording. Note where you looked.
   - **Prior issues**: search all issues, open and closed, for a duplicate or for a rejected request that resembles this one.
2. **Verify the claim.** For a bug, reproduce it from the reporter's steps. For an enhancement, confirm the status quo it builds on. The result is one of: confirmed (with the code path), failed, or not enough detail to tell.
3. **Recommend.** Give the user a few lines: the problem, who it affects, what verification found, whether it is already built or duplicated, and your recommendation with its reason. Wait for their call.

Done when the user has decided. The result is the decision, plus:

- on accept, what triage established (verification result, code path, related issues), so refinement starts from it;
- on reject, the reason written for the reporter: for already built, where it lives; for a duplicate, a link to it; otherwise a short, polite explanation.
