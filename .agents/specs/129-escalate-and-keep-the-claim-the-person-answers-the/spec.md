# Escalate and keep the claim: the person answers, the same agent carries on (#129)

## Problem

When an agent needs a person, norn offers one way out: `norn escalate`. It sets needs-human, comments the reason, notifies the person and deletes the claim, so the agent has to stop. The answer then reaches nobody who has the context: the person resolves the issue with the resolve step, and the next agent to take the step starts cold.

So agents avoid escalating for a question one sentence would answer. They ask in their own session and end the turn instead, where norn cannot see it. Measured on 2026-10-22 with Claude Code under herdr, a question in plain text and an AskUserQuestion with previews both looked `idle`: the person never heard about the question, and nothing in norn said an agent was waiting.

## Solution

Escalating becomes the cheap, normal way to ask. `norn escalate <issue> "question" --wait` does everything escalate does today, but the session keeps its claim, marked as waiting on a person. The person answers in the agent's own session; the agent records the answer with `norn resume <issue> "answer"` and carries on in the same step with its context intact. What needs you lists waiting escalations first, with the question, how long it has waited and how to reach the agent. Briefings for unattended steps tell agents to ask this way and never end a turn on a question. Without `--wait`, escalate stays as it is.

## Behaviour

1. As an agent in a step, I want `norn escalate <issue> "question" --wait` to set needs-human, comment the question and notify the person exactly as escalate does today, so that the person hears about it the same way.
   Example: an agent implementing #42 runs `norn escalate 42 "Keep the old flag as an alias?" --wait` → #42 gets needs-human, loses in-progress, a comment carries the question, the person is notified.
2. As an agent, I want my claim kept after `escalate --wait`, marked as waiting on a person, so that I can carry on in the same step once answered.
   Example: after the call above, the claim on #42 is still held by the same session, marked waiting.
3. As an agent, I want a waiting claim never to go stale by age, so that nobody takes the item over while the person is still to answer.
   Example: #42 has waited 5h with a 2h stale limit → another session's `norn take 42` is refused as held, not taken over.
4. As an agent, I want `norn resume <issue> "answer"` to end the wait, so that I continue the step with the answer recorded.
   Example: the person says "yes, keep it as an alias" in the agent's session → the agent runs `norn resume 42 "Yes, keep the old flag as an alias"` → the answer is commented on #42 under the question, needs-human is cleared, in-progress is back, the claim is a fresh, normal claim, and the agent goes on with the same briefing without a new `norn take`.
5. As a person, I want `resume` to require the answer text, so that the issue always records what was decided.
   Example: `norn resume 42` with no answer → refused, saying the answer is required.
6. As an agent, I want `resume` to be refused when my claim is not waiting, or when I do not hold the claim, so that it cannot clear a needs-human that is not mine.
   Example: `norn resume 42` from a session holding a normal claim on #42 → refused, nothing waits.
7. As an agent, I want `norn done`, another `norn escalate`, and `norn take` from my own session to be refused while I wait, saying to resume first, so that a step cannot finish on an unrecorded answer and the wait is never cleared silently.
   Example: `norn done 42 implemented` while waiting → refused: "#42 waits on a person: run norn resume 42 "<answer>" first".
8. As an agent, or a person in its session, I want `norn release` to be allowed while waiting, so that I can give the item up; it then stays needs-human for the resolve step, as after a plain escalate.
   Example: `norn release 42` while waiting → claim gone, #42 keeps needs-human, `norn next` offers resolving it.
9. As a person whose waiting session died, I want `norn take <issue> --takeover` to free it as it frees any of my stopped sessions, so that the item is not locked forever; it then is in the ordinary resolving needs-human step.
   Example: the pane holding #42 was closed → `norn take 42 --takeover` → the person holds #42 in its resolve step.
10. As a person, I want no expiry on a waiting claim, so that an agent genuinely still waiting is never pushed off its item. A waiting claim held by someone else can be freed only by that person.
11. As a person, I want `norn next`, `norn status` and the dashboard to list waiting escalations apart from other needs-human items and first among what needs me, so that I answer the agents that wait before anything else.
12. As a person, I want each waiting escalation shown with the full question, how long it has waited, the agent's worktree and, under herdr, the `herdr agent focus norn-<issue>` command (with a copy button on the dashboard), so that I can go straight to the agent.
   Example: `norn next 40` lists "#42 waits on you, an agent asked (25m): Keep the old flag as an alias? — worktree …/42-…, herdr agent focus norn-42".
13. As a person, I want a waiting escalation shown without a take or resolve command, and never as free or stale, so that I am not led to start a second session on it.
14. As a person, I want the notification of a waiting escalation to carry the question and how to reach the agent, so that I can answer from the notification.
15. As a person, I want the answer given in the agent's session only; if I wrote it on the issue, I tell the agent, and it runs `resume` with that text, so that every answer is recorded the same way.
16. As a person, I want briefings for unattended steps, and the deliver skill, to say: when you need a person, `norn escalate <issue> "question" --wait` and wait in this session; never end a turn on a question, so that agents ask where norn sees it.
17. As a person, I want briefings for attended steps unchanged, so that an agent with the user present simply asks; `--wait` still works there.
18. As a person, I want `norn escalate` without `--wait` to behave exactly as in 0.10.1, and to stay in every briefing for "something is wrong and I cannot go on", so that giving an item up still works.

## Out of scope

- Liveness of an agent still working in the background (a heartbeat).
- Owning the agent's process, a runner or orchestrator.
- Picking up an answer given as a GitHub comment by polling or waking the agent.
- References to `norn heartbeat` in #130–#132: the user tidies them.

## Open questions

## Plan

### Seams

1. **The norn command line over the testing harness** (fake GitHub, fake notifier, fake workspace, driven as `norn <command>`). Observes Behaviour 1–10 (escalate `--wait`, `resume`, the refusals while waiting, release, takeover, a waiting claim never going stale), 11–14 for `next` and `status` in text and `--json` and the notification, and 16–18 through the briefings `take` prints. Prior art: the escalate, release and resolving needs-human tests, and the take, next, status, notifications and briefing-process tests.
2. **The dashboard's read model (`observe`)**. Observes Behaviour 11–12 for the dashboard: waiting escalations first, with the question, since when, the worktree and the focus command. Prior art: "lists my items in needs-human or needs-human-qa with the command that picks them up".

Beside them, the gh adapter's existing claim round-trip tests gain one case: the waiting marker survives the claim commit. The dashboard's copy button (the UI has no tests; it reuses the existing copy-command component) and the norn-deliver skill text are checked in QA, not by tests. Behaviour 15 is how the person and the agent work; `resume` covers its part.

### Prefactoring

None. Staleness is already decided in one place from the claim record, every claim-gated command already passes one held check, and next, observe and the notifications already have a variant per waiting reason, so the change is one more of each.

### Implementation decisions

- **The claim record** gains an optional `waiting: { question, since }`. `escalate --wait` replaces the session's claim with one that carries it; `resume` replaces it with a fresh claim without it. Claims without the field read as before, so existing claims stay valid.
- **Staleness**: the claim module's stale check treats a waiting claim as never stale, so `take`, `next`, `observe` and the dashboard feed's claim events agree on it. `--takeover` by the same holder works on a waiting claim as on any of their stopped sessions; the fresh claim it writes has no `waiting`, which leaves the item in the ordinary resolving needs-human step.
- **The held check** refuses `done`, `escalate` and a `take` from the same session while the claim waits, saying to run `norn resume <issue> "<answer>"` first. `release` and `resume` pass it. `resume` is refused when the session does not hold the claim, when the claim is not waiting, and without the answer text.
- **`resume`** comments a transition `norn: <state> → <state> (needs-human answered)` with the answer in its own paragraph, removes needs-human, adds in-progress back and refreshes the claim without `waiting`. The step and its briefing are unchanged.
- **`escalate --wait`** sets needs-human, removes in-progress and writes the usual needs-human comment with the reason worded `asked: "<question>"` (the full question in its own paragraph when it has line breaks, as today), so every reader of needs-human reasons keeps working.
- **A new waiting kind, `agent-asks`**, in `next`'s report and in the dashboard's waiting list: the issue, the question (from the claim), when it was asked, the holder, the worktree and, under herdr only, `herdr agent focus norn-<issue>`; other providers show the worktree only. It counts as for a person and sorts first, is listed although a session holds it, carries no take, resolve or hand-off command, and is never shown as free or stale. `--json` exposes it as `reason: "agent-asks"`. Delivery's story-waiting notification includes `agent-asks` items, unlike other held items.
- **Notifications**: a new `agent-asks` kind with the question, the issue's URL and how to reach the agent; the front end words it, as for the other kinds.
- **Briefings**: briefings of unattended steps add the line to escalate with `--wait` and wait in the session, and never end a turn on a question; briefings of attended steps are unchanged. Plain `escalate` stays in every briefing.
- **Alongside the code**: the commands reference gains `escalate --wait` and `resume`; the glossary's Claim and Escalation entries are updated and a waiting claim (an agent asks) gets an entry; the norn-deliver skill source gains the rule.

### Testing decisions

A good test drives norn as a user or agent would, through one of the two seams, and checks what they observe: labels, comments, the claim, stdout and `--json`, notifications sent, and the dashboard read model. No test reaches into internals. GitHub, the notifier and the workspace are the system boundaries and are the harness's fakes; time comes from the harness's clock, so staleness and "waited 25m" are tested by setting it.
