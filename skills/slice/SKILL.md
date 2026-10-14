---
name: slice
description: psdd step for a story in needs-slicing; breaks the spec into tracer-bullet slice issues with their blocking edges. Invoke when a psdd briefing names slice.
---

# Slice

Attended: agree the breakdown with the user before creating anything.

1. Read the spec from your briefing, Plan included, and explore the code it touches.
2. **Draft tracer bullets.** Break the work into slices. Each slice:
   - cuts a narrow but complete path through every layer it touches, tests included: vertical, never one layer;
   - is verifiable on its own and leaves the story branch green;
   - fits one fresh context window;
   - names the Behaviour items it makes work.

   The Plan's prefactoring goes first. Give each slice its **blocking edges**: the slices that must merge before it can start. Slices with no blockers run in parallel, so keep an edge only where one slice genuinely gates another.

   **Wide refactors are the exception.** A single mechanical change whose blast radius fans across the codebase (rename a column, retype a shared symbol) cannot land green as one vertical slice. Sequence it as **expand–contract**: expand (add the new form beside the old), then migrate call sites in batches sized by blast radius, each blocked by the expand, then contract (delete the old form) blocked by every batch.
3. **Mode.** `afk` when tests at the agreed seams verify the slice. `hil` when a person must look at it (UI, judgement, external access); say why in the body.
4. **Quiz the user.** Present the breakdown as a numbered list: title, mode, blocked by, and what it delivers end to end. Ask whether the granularity is right, whether each blocking edge is real, and whether any slice should merge or split. Iterate until the user approves.
5. **Create** the slices in dependency order, so blockers exist before the slices they block:

   ```
   psdd add-slice <story> "title" --mode afk|hil [--blocked-by <slice>]...
   ```

   Then give each its body with `gh issue edit <slice> --body`, in the layout below.
6. Push the story branch from the story worktree, so slice PRs can target it.

Done when every Behaviour item is covered by a slice and every slice has its body. Finish with `psdd done <story>`.

## Slice body

```markdown
Slice of #<story>. Spec: <spec path>

## What to build
The end-to-end behaviour this slice makes work, from the user's side.

## Acceptance criteria
- [ ] Behaviour <n>: <the observable result, checkable at an agreed seam>

## Blocked by
- #<slice>, or "None (can start immediately)"
```

Behaviour and interfaces, not file paths: the slice may wait while the code moves.
