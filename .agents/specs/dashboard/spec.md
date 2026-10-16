# Local dashboard: observe your psdd work on GitHub

A local, read-only first step towards #69. Builds on the architecture refactor (#56, #53, #52, #54, #55) and starts only after it lands. #70 (actions) stays out of scope.

## Problem Statement

Once `drive` hands a story to `deliver`, agents work on the developer's behalf for hours: claiming slices, implementing, reviewing, running QA, merging, raising needs-human. The only window into that is `psdd status <story>`, a one-story snapshot in the terminal, plus whatever notifications arrive. A developer can't see at a glance what's running, what's stuck, what's waiting for them, or what happened while they weren't looking. They end up clicking through GitHub issues, labels and comments to rebuild a story's history. The remote dashboard (#69) would answer this, but it's late in M7 and needs a server adapter (#65), an identity decision (#64) and hosting.

## Solution

`psdd dashboard` starts a small web server on localhost and opens the browser. The page is an observability layer over the developer's own psdd work in the current repository:

- **Board** at the top: each of the developer's stories with its slices by step, who holds each and whether that claim is stale, fix rounds used out of `deliver.maxFixRounds`, and a "waiting for me" strip of needs-human and needs-human-qa items.
- **Activity feed** in the centre: a reverse-chronological stream of what happened, in psdd's own words (step transitions, outcomes, fix rounds, needs-human, QA evidence, PRs, claims). Selecting a story or slice filters the feed to its history.

It reads GitHub only, as the developer, with their own `gh`, the same way every psdd command does. It changes nothing, keeps no state of its own and costs almost nothing against the rate limit: each poll is one GraphQL query plus a `git ls-remote`. It runs in the foreground until Ctrl-C. The views and the core read model are built so that #69 can reuse them behind a server adapter.

## User Stories

1. As a developer, I want to run `psdd dashboard` in a repository and get a web page, so that I can watch my psdd work without composing `gh` queries.
2. As a developer, I want the browser to open automatically, so that one command takes me to the page.
3. As a developer, I want `--no-open`, so that I can start it on a machine or session where opening a browser makes no sense.
4. As a developer, I want the dashboard on a fixed default port, so that I can bookmark the URL.
5. As a developer, I want it to fall back to the next free port when the default is taken, and say which one it chose, so that a busy port doesn't stop me.
6. As a developer, I want an explicit `--port` that's taken to fail clearly, so that I'm never silently moved off a port I asked for.
7. As a developer, I want a second `psdd dashboard` for the same repository to print the running instance's URL instead of starting another, so that I don't double the polling.
8. As a developer, I want it to run in the foreground and stop on Ctrl-C, so that there is no daemon to find and kill.
9. As a developer, I want the server bound to localhost only, so that nobody on my network can read my work through it.
10. As a developer, I want to set my preferred port and interval in my local config, so that I don't type flags every time and don't impose them on my team.
11. As a developer, I want the dashboard to show only the current repository, so that it matches every other psdd command and its config.
12. As a developer, I want it to show the stories assigned to me plus any item my sessions hold, so that I see what's happening on my behalf and not the whole team's noise.
13. As a developer, I want a board of my stories with their slices grouped by step, so that I can see at a glance where each story stands.
14. As a developer, I want each item to show who holds it and since when, so that I know which agent is on it.
15. As a developer, I want stale claims marked, so that I can spot an agent that stopped.
16. As a developer, I want each item's fix rounds shown against `deliver.maxFixRounds`, so that I see an item heading for needs-human before it gets there.
17. As a developer, I want blocked slices to show what blocks them, so that I understand why nothing is moving.
18. As a developer, I want `mode:hil` and `mode:afk` visible on items, so that I know which ones will need my QA.
19. As a developer, I want a "waiting for me" strip listing my needs-human and needs-human-qa items, so that I never miss what's blocked on me.
20. As a developer, I want each waiting item to show the `drive <issue>` command, so that I can act on it in my agent straight away.
21. As a developer, I want an activity feed of what happened across my stories, newest first, so that I can catch up after being away.
22. As a developer, I want feed entries in psdd's terms (e.g. "implementing → needs-review", "review: changes-requested, fix round 2/3"), so that I don't have to decode raw label changes.
23. As a developer, I want needs-human raised and resolved to appear in the feed, so that I see when and why an item escalated.
24. As a developer, I want QA evidence posted to appear in the feed with a link to it, so that I can open the evidence directly.
25. As a developer, I want slices being created and unblocked to appear in the feed, so that I follow how a story was split and released.
26. As a developer, I want story and slice PRs opened and merged to appear in the feed, so that I see code landing.
27. As a developer, I want claims taken, released and gone stale to appear in the feed, so that I see agents come and go.
28. As a developer, I want each feed entry to show who did it, so that I can tell my own actions, my agents' actions and teammates' actions apart.
29. As a developer, I want activity psdd doesn't recognise (an ordinary comment, say) shown as a muted "other activity" line with a link, so that nothing is hidden but noise doesn't dominate.
30. As a developer, I want every entry and item to link to its GitHub issue, PR or comment, so that I can go to the source in one click.
31. As a developer, I want to select a story or slice and have the feed filter to its history, so that I can read one item's story end to end.
32. As a developer, I want the full history of my open stories loaded when the dashboard starts, so that every open story's feed is complete.
33. As a developer, I want stories of mine that closed in the last 7 days included, so that a just-merged story doesn't vanish from view.
34. As a developer, I want a loading state while the initial history loads, so that I know it's working.
35. As a developer, I want the data refreshed every 2 minutes by default, so that it stays current without my doing anything.
36. As a developer, I want a refresh button, so that I can see the result of something I just did right away.
37. As a developer, I want the page to show when it was last updated, so that I know how fresh what I'm looking at is.
38. As a developer, I want to change the poll interval, with a sensible floor, so that I can watch a deliver run more closely without hammering GitHub.
39. As a developer, I want several open tabs to share one poller, so that tabs don't multiply API usage.
40. As a developer, I want each poll to cost a few GraphQL points and no REST requests per item, so that the dashboard doesn't compete with my agents for the rate limit.
41. As a developer, I want claims read through `git ls-remote`, so that watching who holds what costs nothing against the API limit.
42. As a developer, I want a GitHub failure (rate limit, network, expired `gh` auth) shown on the page with what to do, while the last good data stays visible, so that a hiccup doesn't blank the dashboard.
43. As a developer, I want the dashboard to look modern and be easy to read, with light and dark mode, so that I enjoy keeping it open.
44. As a developer, I want the dashboard to come with psdd with nothing extra to install, so that it works as soon as psdd does.
45. As a developer, I want the dashboard to make no changes anywhere, so that I can leave it open without worrying about side effects.
46. As a developer, I want it to know that claim history before it started is unavailable and show only the current holders, so that it never invents events.
47. As the author of #69, I want the read model (board and feed as typed data) in `core` behind a GitHub port method, so that the remote dashboard gets the same data from an Octokit adapter.
48. As the author of #69, I want the UI built against a JSON contract and not against the local server, so that the same views can be served remotely.
49. As a front-end author, I want feed events as a discriminated union on `kind`, so that I can render or act on each without parsing text.
50. As a psdd maintainer, I want the dashboard as its own front-end package that wires adapters itself, so that it follows the layering the boundary test enforces.
51. As a psdd maintainer, I want `psdd dashboard` in the CLI to be a thin launcher, so that the CLI doesn't grow a web server.
52. As a psdd maintainer, I want React, Tailwind and shadcn/ui to be build-time dependencies only, so that psdd still has no runtime dependencies.
53. As a psdd maintainer, I want the built UI embedded in the bundled executable, so that there are no asset files to locate at runtime.
54. As a psdd maintainer, I want the GitHub-to-feed translation tested against the fake GitHub, so that label and timeline edge cases are pinned without the network.
55. As a psdd maintainer, I want the release smoke test to check that the bundle contains and serves the UI, so that a missing asset is caught before a user hits it.

## Implementation Decisions

### Position and sequencing

- `psdd dashboard` is the local first step towards #69: local, read-only, run as the developer with their own `gh`. It doesn't replace #69.
- Implementation starts after the architecture refactor lands. It relies on typed results (#53), the package layout (#52) and the boundary rules (#54), and doesn't touch the pre-refactor layout.
- #51's roadmap gains an entry for this work.

### Scope of data

- The current repository only, the same as every other command.
- "My work" means the open stories assigned to the developer, plus any item a claim held by one of the developer's sessions points at, plus their stories closed in the last 7 days. Slices come with their story.
- GitHub data only. Local sessions, worktrees and `deliver.maxParallel` slots are not shown.

### Core read model

- A new GitHub port method returns everything the dashboard needs in one call: the developer's psdd stories in the window, their slices (sub-issues), labels, assignees, blockers, linked PRs, and timeline items and comments since a given time. The exact name and shape are decided at implementation. It returns data, not prose.
- A new core read operation (something like `observe`) takes a `Ctx`, an optional `since` and the previous claim snapshot. It returns:
  - **Board**: per story, its state, owner, branch and slices. Per item: step, mode, blockers, holder and since, stale flag, fix rounds used and `maxFixRounds`, needs-human.
  - **Waiting for me**: needs-human and needs-human-qa items owned by the developer, each with its `drive <issue>` command.
  - **Feed**: `FeedEvent[]`, newest first.
- `FeedEvent` is a discriminated union on `kind`. Every variant carries the issue, the time, the actor and a GitHub URL. Variants:
  - step transition (from, to)
  - outcome (step, outcome, fix round and budget where relevant)
  - needs-human raised or resolved
  - QA evidence posted
  - slice created or unblocked
  - PR opened or merged (story or slice)
  - claim taken, released or gone stale
  - `other-activity`, a fallback for anything unrecognised, carrying an opaque `detail`
- Translating raw GitHub timeline items into feed events is pure core logic, kept next to the state machine and its label vocabulary.
- Claim events come from comparing the current claim snapshot with the previous one. Before the first poll only current holders are known, and no earlier claim events are invented. Posting claim comments from `take` or `release` would change the process, so it's not done.

### Adapter

- `github-gh` implements the new port method with a single `gh api graphql` query (paginated where needed) and reads claims with `git ls-remote origin 'refs/psdd/claims/*'`.
- `FakeGitHub` implements the same method from its in-memory issues, timeline and claims.
- A later Octokit adapter (#65) implements the same method for #69.

### Web package

- A new front-end package `@psdd/web`. It wires `github-gh` itself, as `cli` does, and the boundary test allows it to.
- **Server:** `node:http`, bound to `127.0.0.1`.
  - Endpoints: the page and its assets, `GET /api/state` (board, waiting-for-me, feed, last updated, last error), a refresh trigger, and an identity endpoint naming psdd and the repository so a second launch can detect a running instance.
  - One poller and one in-memory cache per server, shared by all tabs.
  - Initial backfill as described above, then incremental polls since the last one.
  - A failed poll keeps the last good state and reports the error.
- **UI:**
  - React, Tailwind and shadcn/ui components (cards, badges, tables, tabs, tooltips, scroll areas, a sheet for item detail), with light and dark mode from shadcn's tokens.
  - Built by Vite into one JS and one CSS asset and embedded as strings in the bundled executable. These libraries are dev or build dependencies only.
  - The browser polls `/api/state` and offers a refresh button and an "updated N ago" label.
- The JSON contract of `/api/state` is the typed core read model serialised as-is. Its wording comes from a web-side renderer, in line with "only renderers produce wording".

### Command

- `psdd dashboard [--port <n>] [--interval <duration>] [--no-open]`
  - It runs in the foreground, prints the URL and stops on Ctrl-C.
  - Default port: 4477. If it's taken, the next free port is used and announced. If an explicit `--port` is taken, the command fails.
  - If the chosen port answers the identity endpoint for the same repository, the command prints that URL and exits.
  - It opens the default browser unless `--no-open` is given.
  - Default interval is 2 minutes, with a floor of 30 seconds. A lower value is raised to the floor with a warning.
- Per-developer config in `.agents/psdd.config.local.json`: `dashboard.port` and `dashboard.interval`. The team file doesn't carry them.
- In `cli`, the command is a thin launcher: it parses flags, reads config and starts the `@psdd/web` server through an injected dependency.

## Testing Decisions

- A good test exercises external behaviour at the highest seam: what a front end gets from a core operation, what a browser gets from the server, what a user sees from the command. Tests don't reach into module internals.
- **Seam 1: the core read operation called with a `Ctx` against `FakeGitHub` (the main seam).**
  - Board contents, ownership filtering (assigned to me or held by my session), stale flags, fix-round counts and blockers.
  - The "waiting for me" strip.
  - Each `FeedEvent` variant from scripted timeline items, plus the `other-activity` fallback and actor attribution.
  - The 7-day closed-story window.
  - Claim events from comparing snapshots, and their absence before the first poll.
- **Seam 2: the `@psdd/web` HTTP API, started in-process against the fakes with an injected clock.**
  - `/api/state` shape, cache sharing across requests, polling on the interval, the refresh trigger, the identity endpoint, and keeping the last good state on a failed poll.
  - Port fallback and the "already running" check.
  - These tests stay few.
- **Seam 3: the adapter boundary.**
  - The `github-gh` implementation of the new port method against a scripted `gh`: the GraphQL request and response mapping, pagination, and `ls-remote` output parsing.
- **Seam 4: `psdd dashboard` through the existing CLI harness** (`run(argv, deps)`) with the server start injected.
  - Flags, config keys, the interval floor warning and the "already running" message.
- No React component tests. The UI is a pure rendering of `/api/state`. The CI install smoke test checks that the bundle serves the page and its assets.
- Prior art: the status tests and other harness-driven suites (seam 4 and expectations for board contents), the core-operation tests added by #53 (seam 1), the gh adapter tests (seam 3), and `FakeGitHub` and `FakeWorkspace` in the testing package.

## Out of Scope

- Actions of any kind, such as passing or failing QA, resolving, retrying or starting delivery (#70).
- The remote, hosted dashboard with GitHub sign-in (#69).
- More than one repository in one dashboard, and cross-repo stories (#41).
- The whole team's work. Only the developer's own work is shown.
- Local signals: running herdr panes or Claude Code sessions, worktree state, parallel slots.
- Browser or desktop notifications from the dashboard. psdd's existing notifications cover these.
- Claim history from before the dashboard started, and any process change (such as claim comments) to provide it.
- History longer than open stories plus 7 days of closed ones, persisted history, and metrics or trends (#48).
- Live log streaming and rendered QA evidence packs (#69).
- Server-Sent Events or other push to the browser.

## Further Notes

- GraphQL is rate-limited by points, not requests. A poll here should cost a few points out of 5,000 per hour, and `ls-remote` costs nothing against the API limit, so even the 30-second floor stays negligible next to the agents' own usage (#44).
- The release process gains the Vite UI build before bundling the CLI.
- The read model and the UI are built to move to #69 unchanged: only the adapter (Octokit) and the server (hosted, with sign-in) differ.
