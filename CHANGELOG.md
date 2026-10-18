# Changelog

All notable changes to norn are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and norn uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `norn deliver <story>`: the delivery loop as code, under herdr. It starts a run for each item an agent can do, up to `deliver.maxParallel`, starts the next step's run when one ends, and stops with `norn next`'s report when nothing runs and nothing can start. One per story on a machine; started again, it carries on from GitHub. See [norn deliver](docs/commands.md#norn-deliver).
- `norn run <issue> [--agent <name>]`: a supervised run of one item's step. A supervisor process starts the agent in a `norn-<issue>` tab of the worktree's herdr workspace as a session of its own, renews the claim's lease while it lives, stops it when its pane stalls or it times out, prompts it again or starts a fresh one after an attempt that did not finish the step, and escalates after `run.maxAttempts` or when the agent waits on a person longer than `run.blockedAfter`. Whether a step finished comes from GitHub only. See [norn run](docs/commands.md#norn-run).
- The `run` settings: `agent`, `agents` (herdr agent kind and arguments by name), `env` (local only, e.g. a token scoped to the repository), `lease`, `stallAfter`, `timeout`, `blockedAfter` and `maxAttempts`. See [Runs](docs/configuration.md#runs) and [Sandboxing agents](docs/configuration.md#sandboxing-agents).
- A claim may carry its own lease, which the staleness check honours, so a run that froze gives its item up after `run.lease` instead of `claims.staleAfter`.
- `norn doctor`'s `runs` check says whether `norn run` and `norn deliver` can start agents here, and warns when `run.agents` turns an agent's permission checks off.

### Changed

- Under herdr, `norn next` names `norn run <issue>` for each item an agent can do, and `norn deliver <story>` for all of them, instead of the `herdr agent start` and `herdr agent prompt` commands to start agents by hand.
- The `norn-deliver` skill under herdr starts `norn deliver` in a tab of its own instead of orchestrating agents itself.

## [0.10.1] - 2026-10-17

### Fixed

- `norn --help` and `-h` print the usage outside a git repository too, instead of refusing with `Not inside a git repository's checkout`.

## [0.10.0] - 2026-10-17

### Changed

- `norn init` installs norn's skills into `.agents/skills/` instead of `skills/`, and links them from `.claude/skills/` there, so a project's own `skills/` is never touched. `norn doctor`'s `skills` check looks for them there. To upgrade, run `norn init`: it installs the skills into `.agents/skills/` and moves the `.claude/skills/` links it made to them. Then delete the `norn-*` skills from `skills/` and commit.

## [0.9.0] - 2026-10-17

### Added

- Repository flows: a repository can define a process of its own in `.agents/flows/<name>.json`, and an issue labelled `type:<name>` runs it through `norn take` and `norn done`. norn reads flows from the base branch on GitHub, briefs each state's skill and outcomes, gives the issue a branch and a PR into the base branch with `"workspace": "own"`, creates a missing state label on the first transition into it, and refuses a broken flow, with what is wrong, for the issues of its type only. Stories and slices keep the built-in process. See [Repository flows](docs/flows.md).
- Triage offers the repository's flows: next to `story` and `reject`, each flow is an outcome named after it, with its description. `norn done <issue> <flow>` adds `type:<flow>` and moves the issue to the flow's start. A flow with `"triage": false` is not offered.
- Flows changed under issues in progress: `norn take` and `norn next` move an issue in a state the flow's `renamed` map names to its new state, with a transition comment, and hand an issue in a state its flow no longer has to a person through `needs-human`, with a comment naming the state and the flow, and notify the user; resolving it moves the issue into the state the person picks. `take` answers the hand-over as what it did (exit 0, `--json` `{ ok: true, issue, state, flow }`), not as a refusal, since it changed the issue.
- Behaviours in flows: a state opts into `opensPR` (the briefing opens or updates the issue's PR, later states see the PR and its diff), `countsFixRounds` (rework is briefed, and `deliver.maxFixRounds` turns the issue into `needs-human`) and `humanGate` (a person QAs it, with the QA evidence and remarks wording, and is notified). A state lists them as `"behaviours": { "opensPR": {} }`, each with its parameters.
- `norn next <issue>` works on an issue of a repository flow: a human gate waits for a person, any other state is offered to start, attended or not as the state says.
- Strict flow validation: a flow is also refused when a state can never reach `closed` or `not-planned`, when a state uses a behaviour this norn does not know (for example one of a newer norn), when `opensPR` is used without `"workspace": "own"`, and when the flow is named `reject`. `norn next` shows the issues of a broken flow as blocked by it, waiting for a person, with what is wrong.
- Slices run the built-in `slice` flow, in the format of a repository flow, with three new pieces: the `parent` workspace (a branch off the parent issue's branch and one PR into it), `mergesSlice` (`norn done` requires the PR merged into the parent's branch, then the parent moves on) and `syncsBlocked` (an issue waits in the state while it has open blockers and is released to the state the behaviour names). Repository flows can use all three. An outcome's `meansSkipped` says what it means when the issue's mode skips the state it leads to.
- Stories run the built-in `story` flow, in the format of a repository flow, with four new behaviours repository flows can use too: `writesSpec` (the issue's own spec, briefed and linked), `slices` (`norn add-slice` works only in that state and labels each slice with the type it names; leaving the state needs a slice), `waitsForSlices` (entering it creates the issue's branch on GitHub; once every slice is merged norn opens the issue's PR and moves it on) and `waitsForMerge` (the owner merges the PR; `norn next` closes the issue once it is merged). Triage's `story` outcome comes from the flow, and `norn next` runs any flow with slices as it runs a story.
- A repository can replace the built-in `story` or `slice` flow with its own `.agents/flows/story.json` or `slice.json`, used in place of the built-in one with nothing merged from it. `norn flows export <name>` writes a built-in flow there as a starting copy, and refuses when the file exists.
- Mode-conditional states in flows: a state with `"when": "hil"` (or `"afk"`) and a `passThrough` outcome runs only in that mode. For an issue in the other mode, `norn done` follows the pass-through at once and writes one transition comment to where the issue lands, saying which states were skipped and why. A `when` state without a valid `passThrough`, or one whose skipping leaves a state that can never end in some mode, makes its flow invalid.
- The dashboard reads the flows. It shows your issues of every flow, not only stories, and the read model carries the repository's flows, valid or with their errors, and each issue's flow. An issue's state is worded by its state's `description` (its name without one), its pipeline is the path from the flow's `start` following each state's first outcome (a `when` state shows only in its mode), and a state label's colour comes from its `color` or its kind: attended, agent or human gate. A human gate is your QA and a `syncsBlocked` state shows as blocked, whatever their names. An issue of an invalid flow shows as stopped by it. Each read reads the flows again, so a merged change shows at the next poll.
- A read-only Flows page in the dashboard lists every flow of the repository, marked built-in, overridden or the repository's own, and valid or invalid with its errors, and draws each valid flow as a graph of its states and outcome arrows, with each state's behaviours and `when` mode. The read model says where each flow comes from (`source`).
- `norn doctor` checks the flows: a new `flows` check validates the flows on the base branch and every flow file in your working copy that differs from it, names the skills a flow uses that are not installed, and lists the open issues your local flow edits would orphan. Its `labels` check takes norn's labels from the flows and warns about labels no flow uses, without deleting them.
- norn publishes the flow format as a JSON Schema, `schema/flow.schema.json`, in the npm package and on GitHub: point a flow's `$schema` at it for completion and checks in your editor.
- A flows page in the docs, [Flows](docs/flows.md): the format, the behaviours, the workspace modes, `when`, overrides, labels, validation and changing a flow under issues in progress.
- `norn done` checks the PR of a flow with `opensPR`: it refuses to leave the state that opens the PR before the PR exists, and to close the issue before the PR is merged, so an issue can no longer close with its PR open, or as done with no PR at all, e.g. when its mode skips the person's check. Closing it as `not-planned` needs no PR. The bug example in the flows docs gains the merge step it needs.
- `norn --help`, and `--help` or `-h` after any command, prints the list of commands and runs nothing; `norn dashboard --help` no longer starts the dashboard.
- `norn doctor`'s `flows` check fails on a JSON file in `.agents/flows/` whose name cannot name a type, e.g. `Bug.json`, which norn skipped without a word.

### Changed

- norn calls an issue by its type, the flow it runs: `norn status`, `next`, `take`, `done` and their events, refusals and notifications say `Bug #20` or `Epic #13` and the epic PR, instead of `Story` or `Issue`, and a slice's briefing names its parent the same way, e.g. `(epic #13)`. `norn status` on an issue whose flow has no slices no longer says `No slices yet`, and shows a branch only when the flow gives it one. `--json` carries the type as `flow`.
- `norn done` says when an outcome's `needsHuman` sets `needs-human`, with its reason; the fix-round limit names the state the issue would have gone back to, not `implement`. `norn next` and the notification list such an issue as `needs a human:`, also when nothing else is left.
- A rework step with `opensPR` names the PR already open and its diff instead of saying to open one, and a fix step after a `waitsForSlices` wait names the issue's PR, by number, and its diff.
- Flow validation: an outcome with `"notify": true` must lead into an attended state or a human gate, as a person and an agent would otherwise both be sent to the step; a misspelt behaviour is named with the one it is closest to instead of being blamed on a newer norn; and a flow its behaviours name that does not exist is reported with the flow's other errors, not only once they are fixed.
- `norn doctor` words every flow problem as a sentence, e.g. `The parameter to of the behaviour syncsBlocked of the state waiting must be a state of the flow.` instead of a field path, lists several problems one per line, and no longer warns that no flow uses a label your working copy's flow files use. `--json` flow errors locate a field as `at` instead of a dotted `path`.
- The refusal for a missing note names the outcome and the note, e.g. `The outcome cannot-reproduce needs a note: the attempts.`
- Labels a flow needs are created before norn first puts them on an issue: triage creates `type:<flow>` for the flow it gives an issue, and `norn add-slice` creates the slice's type and start state, each with its colour and description instead of GitHub's grey, undescribed default.
- `norn add-slice` names the state the slice starts in, its flow's start (`ready-for-agent` for the built-in slice), and `norn next` names the state a story moves on to once every slice is merged, as its flow's `waitsForSlices` says, instead of always `needs-review`.
- Every label norn creates has a description ending in `(norn)`, and the type label reads `Runs the <flow> flow (norn)`. `norn doctor` counts a label as norn's by that mark, a `type:` prefix or a flow's `renamed`, so it now also lists the label of a state a repository flow removed. Run `norn init` to mark the labels of the flows in effect.
- `norn doctor`'s `flows` check names the type of the slices each flow makes, and warns about the labels your local flow edits need that the repository does not have yet.
- The dashboard words a feed outcome from its flow: the step's name and the outcome's word, e.g. "Review: request-changes", "Your QA: pass", "Implementation done, fix round 2", with "Your QA" at any human gate. Its Remarks filter and its colours come from what the state does in its flow (evidence or a human gate is QA, opening the PR or fixing what was sent back is implementing, sending work back for fixes is review), so a custom flow's steps are sorted as the built-in ones are. Feed outcomes in the read model carry their issue's `flow`.
- `norn next` words every item to start by its state and the state's `description` in its flow, e.g. `Slice #131 "Per-key limits" is in ready-for-agent: Ready for an agent.`, or the step's name for a state without one, instead of fixed phrases for the built-in states only; `--json` start items carry the `description`.
- `norn init` creates the labels of every valid flow on the base branch: each state, with its colour and description or a default for its kind (a human gate, attended or agent), and `type:<flow>` for each flow, described as `norn <flow> flow`.
- **Breaking:** a flow file with a field the format does not have, a colour that is not hex, or a behaviour parameter the behaviour does not take is now invalid, as the JSON Schema says, instead of the field being ignored.
- The built-in states' descriptions, and so their labels' descriptions as `norn init` creates them, are now the dashboard's wording, e.g. "Waiting for review" for `needs-review`: one description says what a state means wherever norn shows it.
- A slice's pipeline on the dashboard names its steps as the flow does, e.g. "implementation" and "agent QA" for "build" and "QA", and a slice in `mode:hil` shows QA by a person as a step of its own.
- An afk slice that passes agent QA now says on its transition comment that QA by a person was skipped: `norn: needs-qa → merge-queue (pass)` is followed by `Skipped needs-human-qa in mode:afk: it runs in mode:hil only.`
- A slice with no `mode:` label now gets QA by a person after the agent's, as every state with `when` runs for an issue with no mode.
- In a flow, a rework briefing now reads "the latest review or QA comment on #N lists what to fix", and a human gate's briefing starts from the agent's QA comment, as for slices.
- `norn-deliver` stops at a human gate, where a person checks the work, rather than at a named state; the skill and the docs say so.
- **Breaking:** an outcome's `notify` is `true` or `false`; it no longer names who is notified (`story` or `mode:hil`). norn words the notice from the issue's flow, or from the mode of a state with `when`, either `mode:afk` or `mode:hil`, so a custom flow's human gate says `needs human QA (bug)` instead of `(type:bug)`. The built-in `story` flow drops its `notify`, which its human gate already gives it.
- **Breaking:** `norn next --json` names the issue it is about `issue` instead of `story`, since it works on an issue of any flow, and a waiting item of a broken flow has the reason `flow-invalid`, the same name as the refusal, instead of `invalid-flow`.
- **Breaking:** triage's outcome `accept` is now `story`: `norn done <issue> story` makes the issue a story in `needs-refinement`. `accept` is gone, with no alias, because triage now chooses the issue's type and `story` is one type among the flows.

## [0.8.0] - 2026-10-16

### Added

- `norn doctor` checks the whole setup at once: `gh` and its login, the git checkout and `origin`, `baseBranch` on GitHub, your write access, the labels, the config, the norn version, the skills, the agent instructions and the worktree provider. It lists every check with the command that fixes it, changes nothing, and exits 1 only when a check fails, so CI can run it. `--json` gives `{ ok, checks }`. It runs outside a checkout too, and says so.
- The team config records the norn version that last set the repository up, as `nornVersion`. `norn init` writes it, and on an existing repository changes it and nothing else. Every other command compares it with your norn: silent on a patch difference, a warning on a compatible one, and a refusal on an incompatible one (another major version, or another minor version while the major is 0). `norn init` refuses when your norn is older than the repository's. After upgrading, run `npx norn init` and commit `.agents/norn.config.json` with the skills.
- `norn --version` prints the running version.

### Changed

- When a `gh` call fails, and after `norn init`, norn points to `norn doctor` for a full check.

- The repository is renamed from `ai-engine` to `norn`. Install with `npm install -D github:PruszynskiJakub/norn#<tag>`; GitHub redirects the old name, so existing installs keep working, but update the URL in your `package.json` and run `git remote set-url origin git@github.com:PruszynskiJakub/norn.git` in a clone.

## [0.7.0] - 2026-10-16

### Changed

- Every bundled skill is prefixed with `norn-`, so the skills are easy to tell apart from a project's own: `norn-drive <issue>`, `norn-deliver <story>`, and `norn-triage` through `norn-resolve` and `norn-tdd`. Briefings, `norn next`, the herdr hand-off prompts, the dashboard and the `AGENTS.md` section use the new names. After upgrading, run `npx norn init`, then delete the old unprefixed skill directories from `skills/` and their links from `.claude/skills/`.
- `norn-drive` and `norn-deliver` carry an argument hint, so your agent shows what each takes as you type it: `norn-drive` takes any issue, story or slice; `norn-deliver` takes a story.
- The dashboard shows the norn icon at the top of the sidebar, next to the norn name, instead of at the right of the top bar.

## [0.6.1] - 2026-10-16

### Changed

- The README is rewritten for someone new to norn, and the reference moves to `docs/`: how norn works (principles, assumptions, labels, flows as Mermaid diagrams, claims and delivery), commands, configuration and a sandbox tutorial. `PRD.html` is folded into these pages and removed. `CONTRIBUTING.md` and `SECURITY.md` are new.

### Fixed

- `norn next` on a story in merge-queue says the owner merges the story PR into the configured `baseBranch`, instead of always saying `main`.

## [0.6.0] - 2026-10-16

### Changed

- psdd is renamed to norn. The command is `npx norn`, and everything it writes uses the new name: `norn:` comments on issues, `refs/norn/claims/<issue>`, the `norn/qa/<issue>` evidence branches, `.agents/norn.config.json` and `.agents/norn.config.local.json`, `NORN_SESSION` and `NORN_SKILLS_SOURCE`, and the `<!-- norn:start -->` section in `AGENTS.md` and `CLAUDE.md`. It is a clean break: norn reads none of the old names. Finish or restart stories that are in flight under psdd. After upgrading, rename the config files, run `npx norn init`, and delete the old `<!-- psdd:start -->` section from `AGENTS.md` and `CLAUDE.md`.
- The dashboard shows the norn icon as its favicon and at the right of its top bar. Its colours follow the icon: navy and gold, with gold marking an agent at work.

### Fixed

- The dashboard heading reads "Nothing needs you right now" when nothing does, instead of "Nothing need you right now".

## [0.5.1] - 2026-10-16

### Fixed

- The dashboard shows a selected story's or slice's labels as GitHub has them, under its title; `needs-human` and `needs-human-qa` stand out in colour.

## [0.5.0] - 2026-10-16

### Added

- `psdd dashboard [--port <n>] [--interval <duration>] [--no-open]` serves a read-only page on `127.0.0.1` over your psdd work in this repository: your stories with their slices, what needs you with its `drive <issue>` command, what is worth a look (stale claims, items one fix round from `deliver.maxFixRounds`), and a feed of what happened in psdd's terms, with the agents' implement, review and QA remarks inline and QA remarks linked to their evidence on `psdd/qa/<issue>`. It reads GitHub as you every 2 minutes (at least 30s), one GraphQL query plus `git ls-remote` per read, shared by every open tab; it changes nothing. The default port 4477 moves to the next free one when taken, an explicit `--port` that is taken fails, and a second launch for the same checkout prints the running dashboard's URL. `dashboard.port` and `dashboard.interval` go in `.agents/psdd.config.local.json`; in the team file they are refused. The UI is embedded in the CLI, so there is nothing extra to install.

### Changed

- Release tags carry the built CLI, so installing psdd from a tag no longer builds it and npm 11 no longer warns about its `prepare` script. Only release tags can be installed now; a branch or commit of the repository has no built CLI.

## [0.4.0] - 2026-10-15

### Changed

- Under herdr, an item waiting for a person (`needs-human-qa` or `needs-human`) is done in its own worktree's pane, like every other step. `psdd next` lists, with the item, how to hand it to an agent there if the user does it now (`herdr agent start`, `prompt "drive <item>"`, `focus`), or, inside that worktree, to take it in this session; `--json` carries the item's `worktree` and `here`. `drive` follows it instead of taking the item in the pane it was started from. Delivery still stops on these items, and other worktree providers are unchanged.
- An item for a person that a session holds is listed by `psdd next` as held by it (`heldBy` in `--json`), with no hand-off, so no second agent is sent to it. When only such work is left, delivery stops without notifying the user about it; items no one holds are still notified.
- `psdd next` counts your agents already running on the story against `deliver.maxParallel` and offers only the free slots (`running` and `slots` in `--json`). At the limit it lists the ready items and says to wait. A teammate's agents and a person's work do not count.
- `deliver` goes on with its loop after the user runs `drive` in the same session, and `drive` does not offer `deliver` again from a session already running it.

## [0.3.0] - 2026-10-15

### Added

- QA has two steps. In `needs-qa` an agent runs the new `auto-qa` skill on every slice and story: it checks each criterion it can from the user's side and collects the evidence. A failure goes straight to `qa-failed` and counts as a fix round. A `mode:afk` slice that passes goes to `merge-queue`; a `mode:hil` slice and every story go to the new state `needs-human-qa`, where a person runs `qa` with their agent, starting from the agent's evidence and from any remarks of their own. Remarks outside the criteria become follow-up issues unless the person pulls them in or drops them. psdd notifies the user when an item reaches `needs-human-qa`, and `psdd next` lists it as "needs human QA". `psdd init` adds the label and the skill.
- `psdd done <issue> <outcome> "note" --evidence <dir>` on a QA step pushes the files in `<dir>` to the branch `psdd/qa/<issue>` and embeds them in the QA comment at that commit, so each round's comment keeps its own evidence. The agent's QA note is its evidence pack and is required.
- `psdd tidy [--dry-run]` removes what belongs to closed issues: QA evidence branches, worktrees, merged slice and story branches (locally and on GitHub), and claim refs. A worktree or branch with uncommitted or unpushed work, and the worktree psdd runs in, are named instead. `deliver` runs it when it starts and stops, `drive` when a story is closed.

### Changed

- Review approval no longer sets needs-human for a `mode:hil` slice or a story: they go to QA by an agent first. needs-human now always means an escalation, cleared with `resolve`, in every state.
- `psdd next` no longer removes worktrees; `psdd tidy` does.
- The slice body has a Verifier section: an agent, or an agent then a person, with what only the person can check and why.

### Upgrading

- An item waiting in `needs-qa` with needs-human for a person's QA from an earlier version is briefed as `resolve`. To give it the new person's QA step instead, run `gh issue edit <issue> --add-label needs-human-qa --remove-label needs-qa,needs-human`. Run `npx psdd init` to get the new label and skills.

## [0.2.3] - 2026-10-14

### Fixed

- Under herdr, `psdd next` lists the `herdr agent prompt` command for each item an agent runs unattended, with the prompt filled in, next to `herdr agent start`. `deliver` runs both as listed. Before, the orchestrator wrote the prompt command itself, and could pass `--timeout` without `--wait`, which herdr rejects: the agent started but never got its prompt.

## [0.2.2] - 2026-10-14

### Fixed

- `psdd init` updates the project's skills to the installed psdd version. Before, it only copied skills that were missing, so after an upgrade projects kept running the old `drive` and `deliver`. It names the skills it replaced; `git diff skills/` shows the changes. With `PSDD_SKILLS_SOURCE` set, skills already in place are kept.

## [0.2.1] - 2026-10-14

### Fixed

- `drive` no longer does an attended step in the main checkout after taking over a stopped session. It takes over and releases the item, then goes back to `psdd next`, so under herdr the story is still handed to an agent in its worktree. The hand-off reuses an agent already in the worktree's pane.
- The `take` briefing says when the worktree has uncommitted changes, e.g. from an earlier session that stopped partway.

## [0.2.0] - 2026-10-14

### Added

- `psdd take <issue> --takeover` takes over a claim held by another session of yours before it goes stale, e.g. after closing an agent partway through refinement. Without the flag, take says the claim is yours and names the command; `psdd next` lists such items as "held by another session of yours". A teammate's claim is never taken. `drive` asks whether the other session is still running and then resumes or drops the step; `deliver` never uses the flag.

### Fixed

- Under herdr, an attended story step no longer leaves an empty worktree workspace while the work goes on in the main checkout. `psdd next` tells `drive` to hand the story to a new agent in the worktree's pane (`herdr agent start`, then `prompt "drive <story>"` and `focus`), and inside that worktree it says to take the step in this session. Attended items are listed as started with the user, not by a fresh agent.

## [0.1.3] - 2026-10-14

### Added

- The `drive` skill: `drive <issue>` takes an issue through its attended steps with the user, from triage to slicing, then offers `deliver`.
- `psdd init` writes a psdd section into `AGENTS.md` and `CLAUDE.md` (creating `AGENTS.md` and a `CLAUDE.md` that imports it when neither exists), so agents find the process without being told.

## [0.1.2] - 2026-10-14

### Added

- psdd builds itself when installed from git (`npm install -D github:PruszynskiJakub/ai-engine#<tag>`).

## [0.1.1] - 2026-10-14

### Changed

- `claims.staleAfter` and `deliver.maxFixRounds` are read from the team config only. In the local config they are ignored with a warning (in `--json`, a `warnings` field), and a team `staleAfter` below `10m` is raised to `10m` with a warning. Commands still run.
- Branch, worktree and spec names come from a slug recorded once on the story, not from its current title.
- Spec links point at the story branch, not the local HEAD.

### Fixed

- A multi-line review or QA note no longer stops the fix budget from resetting after a person resolves the escalation.
- A failed label change no longer leaves an issue without a state; `psdd next` lists an issue with no state label as waiting for a person. An issue left with two state labels is refused by `take` and listed by `psdd next` and `psdd status` for a person to fix, instead of being briefed as its old step.
- Two sessions taking over the same stale claim can no longer both hold it, and refreshing your own claim can no longer overwrite another session's takeover. A takeover that finds the claim already released takes it instead of reporting it held.
- `psdd done` on a merge refuses a slice PR that does not target the story branch.
- Lists are read without `gh api --slurp`, so gh older than 2.48 works.
- Printed commands are shell-quoted, including the slice title in the briefing's `gh pr create`; worktree paths compare correctly on Windows; the main checkout is found from anywhere in a submodule. In a `--separate-git-dir` clone or a bare repository with worktrees, psdd runs from the main checkout only, and elsewhere says so instead of crashing.
- An existing worktree is brought up to date in the briefing; a slice relabelled by `take` is still briefed as rework.
- `psdd next` no longer says the user was notified when notifications are off, gives the create command under plain git, clears state labels from closed issues, keeps worktrees with uncommitted changes, ignores sub-issues that are not slices, and closes a story whose PR merged into a non-default base.
- The resolve step's comment says `needs-human resolved`.
- A story whose title has no ASCII letters or digits records its slug once, not on every comment.
- The deliver skill no longer says the user was notified when notifications are off.
- Windows notifications pass their text through the environment, so quotes in it cannot break out of the script.

## [0.1.0] - 2026-10-14

First release.

### Added

- `psdd` CLI that runs work through the SDD process. GitHub labels, native relations, comments and branches are its only state.
- Commands: `init`, `next`, `take`, `done`, `add-slice`, `escalate`, `release` and `status`, with `--json` output for scripts.
- Claims held as git refs `refs/psdd/claims/<issue>`, refreshed by taking again and taken over once stale (default 2h).
- One worktree per story and slice under `.agents/worktrees/<branch>`, created through herdr, Claude Code or plain git.
- `psdd next` keeps `blocked` and `ready-for-agent` labels in line with native relations, catches up on failed follow-ups and removes worktrees of closed slices and merged stories.
- Team config in `.agents/psdd.config.json`, overridable per developer in the gitignored `.agents/psdd.config.local.json`.
- `deliver` skill that runs a story unattended until it needs a human, with a fix-round limit (`deliver.maxFixRounds`) that escalates to needs-human.
- Local notifications through herdr or the OS when an issue needs a human or nothing is left to do.
- Bundled skills, one per step (triage, refine, clarify, plan, slice, implement, review, qa, merge, resolve, deliver), plus the reference skills `interview`, `codebase-design` and `tdd`, installed by `psdd init`.

[Unreleased]: https://github.com/PruszynskiJakub/norn/compare/v0.10.1...HEAD
[0.10.1]: https://github.com/PruszynskiJakub/norn/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/PruszynskiJakub/norn/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/PruszynskiJakub/norn/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/PruszynskiJakub/norn/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/PruszynskiJakub/norn/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/PruszynskiJakub/norn/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/PruszynskiJakub/norn/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/PruszynskiJakub/norn/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/PruszynskiJakub/norn/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/PruszynskiJakub/norn/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/PruszynskiJakub/norn/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/PruszynskiJakub/norn/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/PruszynskiJakub/norn/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/PruszynskiJakub/norn/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/PruszynskiJakub/norn/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/PruszynskiJakub/norn/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/PruszynskiJakub/norn/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/PruszynskiJakub/norn/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/PruszynskiJakub/norn/releases/tag/v0.1.0
