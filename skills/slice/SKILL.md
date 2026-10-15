---
name: slice
description: Break a planned spec into tracer-bullet slices, each with its blocking edges, verifier and acceptance criteria. Use when turning a spec into issues.
---

# Slice

Agree the breakdown with the user before creating anything.

1. Read the spec, Plan included, and explore the code it touches.
2. **Draft tracer bullets.** Break the work into slices. Each slice:
   - cuts a narrow but complete path through every layer it touches, tests included: vertical, never one layer;
   - is verifiable on its own and leaves the codebase green;
   - fits one fresh context window;
   - names the Behaviour items it makes work.

   The Plan's prefactoring goes first. Give each slice its **blocking edges**: the slices that must merge before it can start. Slices with no blockers run in parallel, so keep an edge only where one slice genuinely gates another.

   **Wide refactors are the exception.** A single mechanical change whose blast radius fans across the codebase (rename a column, retype a shared symbol) cannot land green as one vertical slice. Sequence it as **expand–contract**: expand (add the new form beside the old), then migrate call sites in batches sized by blast radius, each blocked by the expand, then contract (delete the old form) blocked by every batch.
3. **Verifier.** An agent always QAs each slice from the user's side. Decide whether a person must also look at it (UI, judgement, external access); if so, say why in the body. That reason is all a person checks; the agent checks everything else.
4. **Quiz the user.** Present the breakdown as a numbered list: title, verifier, blocked by, and what it delivers end to end. Ask whether the granularity is right, whether each blocking edge is real, and whether any slice should merge or split. Iterate until the user approves.
5. **Create** the slices as issues in dependency order, so blockers exist before the slices they block, each with its body in the layout below.

Done when every Behaviour item is covered by a slice and every slice exists with its body.

## Slice body

```markdown
Slice of #<story>. Spec: <spec path>

## What to build
The end-to-end behaviour this slice makes work, from the user's side.

## Acceptance criteria
- [ ] Behaviour <n>: <the observable result, checkable at an agreed seam>

## Verifier
An agent, or: an agent, then a person, because <what only a person can check, and why>.

## Blocked by
- #<slice>, or "None (can start immediately)"
```

Behaviour and interfaces, not file paths: the slice may wait while the code moves.
