# Example spec

A short spec written to the standard of the refine skill, for an imagined task tracker. A real story usually has more Behaviour items; the point is their shape.

```markdown
# Archive finished projects (#212)

## Problem
A team lead who has run a tracker for a year sees every project they ever made in the project picker,
finished ones included. Finding a live project means scrolling past dozens of dead ones, and new
members pick finished projects by mistake and file tasks nobody will read.

## Solution
A project owner can archive a project. An archived project leaves the picker and the project list,
keeps all its tasks readable, and can be restored. Nothing is deleted.

## Behaviour

1. As a project owner, I want to archive a project, so that it stops cluttering the picker.
   Example: owner opens "Website 2024" → Settings → Archive → confirms → the project is gone from the picker.
2. As a project owner, I want to be warned when the project still has open tasks, so that I do not bury live work.
   Example: archiving a project with 3 open tasks → "3 tasks are still open. Archive anyway?" with Cancel as the default.
3. As a member, I want archived projects left out of the project list, so that I only see live ones.
   Example: the list shows 12 projects; after one is archived it shows 11.
4. As a member, I want to see archived projects on request, so that I can still find old work.
   Example: "Show archived" → the archived project appears, greyed, with "Archived 3 May by Ana".
5. As a member, I want an archived project's tasks to stay readable but not editable, so that history is kept as it was.
   Example: opening a task in an archived project shows it with no Edit button and a banner "This project is archived".
6. As a member who follows a link to a task in an archived project, I want it to open, so that old links keep working.
   Example: a link from last year's chat opens the task with the archived banner.
7. As a project owner, I want to restore an archived project, so that I can undo a mistake.
   Example: "Show archived" → "Website 2024" → Restore → it is back in the picker with its tasks editable.
8. As a member who is not the owner, I want no Archive action, so that I cannot archive a project by accident.
   Example: a member opens Settings of a project they do not own → there is no Archive button.
9. As a project owner, I want archiving to fail visibly when it cannot be saved, so that I know the project is still live.
   Example: the server is unreachable → "Could not archive. Try again." and the project stays in the picker.

## Out of scope
- Deleting projects — archiving is the reversible answer; deletion is its own story.
- Archiving automatically after inactivity — the owner decides; no rules engine.
- Archiving single tasks — tasks already have Closed.

## Open questions

1. Should archived projects count against the plan's project limit? (bears on Behaviour 1, 7)
   Options: count them / do not count them. Recommended: do not count them, because archiving is how teams make room.
   Who: Marta (billing)

## Plan
Written by the `norn-plan` skill.
```

What makes it work:

- Problem names who has it, when, and what it costs; it does not say "there is no archive button".
- Every Behaviour item is one observable behaviour with its own example. The warning (2), the failure (9) and the permission edge (8) are items in their own right.
- Out of scope says why, so nobody builds deletion "while they are at it".
- The open question can be put to Marta as it stands: options, recommendation, and what it bears on.
- No file, table or function is named.
