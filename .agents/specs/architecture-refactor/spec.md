# Architecture refactor: one core, typed results, protected layering

Covers #56, #53, #52, #54 and #55 (without ADRs). Enables #57 and #65, which stay out of scope.

## Problem Statement

psdd is a CLI today, but it is heading for more front ends: evals, a CI runner, a dispatcher, a dashboard, maybe an MCP server. The code is not ready to be shared by them:

- All modules sit flat in one source folder (~3.1k lines). The ports-and-adapters shape exists (GitHub port → `gh` adapter, Workspace port → local git/herdr worktrees, Notify port → OS/herdr notifier) but nothing shows or protects it, and any module can import any other.
- Core logic speaks prose. Transitions, follow-ups, blocked-sync and best-effort steps return finished CLI sentences, and `--json` is bolted on at the CLI. Any front end other than the CLI would have to parse sentences.
- The package installs from a git tag by running a build on the user's machine, which will not survive a move to multiple internal packages.
- There is no formatter, no linter and no CI: style and correctness are held by review alone.
- The domain words (story, slice, step, claim, briefing, outcome, needs-human, fix round) are defined nowhere canonical, and there are no written coding standards, so psdd's own `review` skill has nothing to check against.

## Solution

A series of small, behaviour-preserving PRs, each green on its own, in this order:

1. **Tooling (#56).** Biome formats and lints; `npm run check` runs typecheck, Biome and the tests; a GitHub Actions workflow runs it on every PR and on pushes to `main`.
2. **Typed results (#53), in today's flat layout.** Core operations return typed data; the CLI gains a single text renderer and a JSON renderer over it. CLI output — text and `--json` — stays byte-identical.
3. **Packages (#52).** Files move into npm workspaces (`core`, `github-gh`, `workspace-local`, `cli`, `testing`); `cli` is bundled into one self-contained executable; release tags carry the built bundle so installing from a tag needs no build.
4. **Boundary test (#54).** A test fails on any import that breaks the layering.
5. **Docs (#55).** `CONTEXT.md` (canonical glossary) and `CODING_STANDARDS.md` (checkable rules).

For users nothing changes: same commands, same output, same install command (`npm install -D github:…#<tag>`), faster install and no `allowScripts` warning.

## User Stories

1. As a psdd user, I want every command's text output unchanged after the refactor, so that my habits and any scripts reading it keep working.
2. As a psdd user, I want `--json` output byte-identical to today, so that anything parsing it keeps working.
3. As a psdd user, I want to keep installing psdd with the same `npm install -D github:…#<tag>` command, so that upgrading needs no new instructions.
4. As a psdd user, I want installing from a tag to skip building, so that the install is fast and needs no dev dependencies.
5. As a psdd user on npm 11, I want the `allowScripts` warning gone, so that installing psdd doesn't look suspicious or need an extra approval.
6. As a psdd user, I want the skills shipped exactly as before, so that `psdd init` behaves the same.
7. As a psdd maintainer, I want a formatter configured to today's style, so that formatting is never a review topic and the first run barely changes anything.
8. As a psdd maintainer, I want lint rules against floating promises, unused imports and default exports, so that the mistakes that matter in this codebase are caught mechanically.
9. As a psdd maintainer, I want any disabled lint rule disabled centrally with a stated reason, so that exceptions are visible and deliberate.
10. As a psdd maintainer, I want one `npm run check` command that runs typecheck, lint and tests, so that I know a change is ready with one command.
11. As a psdd maintainer, I want CI to run that check on every PR and every push to `main`, so that nothing lands red.
12. As a psdd maintainer, I want CI to install the built package in a throwaway project and run it, so that a broken bundle or release layout is caught before a user hits it.
13. As a psdd maintainer, I want characterization tests pinning the text and `--json` output of every command before the logic changes, so that the typed-results refactor provably changes nothing visible.
14. As a front-end author (MCP, dashboard, runner, dispatcher), I want core operations to return typed results, so that I never parse sentences.
15. As a front-end author, I want follow-ups reported as typed events (e.g. story branch created, follow-up failed with what and how to retry), so that I can show or act on each one my own way.
16. As a front-end author, I want refusals typed with a kind and their facts, so that I can tell "not claimed" from "wrong step" without string matching.
17. As a front-end author, I want the briefing as a structure (step, skill, location, instructions, finish commands), so that I can present or forward it without reformatting prose.
18. As a front-end author, I want text that comes from outside psdd (gh errors, user notes) passed through as an opaque detail, so that I know which strings psdd owns and which it doesn't.
19. As a psdd maintainer, I want all wording in one CLI renderer, so that changing a sentence touches one place.
20. As a psdd maintainer, I want the renderer to fail the typecheck when a new result or event variant has no wording, so that nothing silently prints blank.
21. As a psdd maintainer, I want the JSON renderer built from the text renderer and the result data, so that the two outputs can never drift apart.
22. As a psdd maintainer, I want the code split into `core`, `github-gh`, `workspace-local`, `cli` and `testing` packages, so that the architecture is visible from the folder tree.
23. As a psdd maintainer, I want `core` to contain the state machine, transitions, claims, slug, location, briefing, next, status, tidy, config and the ports, so that all process logic lives in one I/O-free place.
24. As a psdd maintainer, I want the CLI-only concerns (argument parsing, environment, init, skill installation, rendering, the executable) in `cli`, so that the core never knows it is behind a terminal.
25. As a psdd maintainer, I want the fakes and the test harness in a `testing` package, so that unit tests and future evals share one set of fakes.
26. As a psdd maintainer, I want the file move to be a pure move with the suite green, so that the PR is reviewable and bisectable.
27. As a psdd maintainer, I want tests to stay in one top-level test folder importing packages by name, so that the move PR doesn't also reshuffle 30 test files.
28. As a psdd maintainer, I want a test that fails when `core` imports an internal package or any Node module other than `node:path`, so that the core stays portable.
29. As a psdd maintainer, I want a test that fails when an adapter imports anything but `core`, so that adapters stay independent.
30. As a psdd maintainer, I want only the CLI (and later front ends) to wire adapters, so that wiring lives at the edge.
31. As a psdd maintainer, I want the `testing` package importable only from tests, so that fakes never leak into the product.
32. As a psdd maintainer, I want each package's declared dependencies to be the allowlist the boundary test checks, and unused declarations flagged, so that there is one honest source of truth.
33. As a psdd maintainer, I want a boundary violation reported as file → specifier → rule broken, so that fixing it needs no investigation.
34. As a psdd maintainer, I want the release process to build the bundle and commit it on the release tag only, so that `main` stays free of build output.
35. As anyone reading the code, I want a `CONTEXT.md` with one definition per domain term and how they relate, so that the vocabulary is unambiguous.
36. As the PRD author, I want the PRD to keep owning vision and way of working and to link to `CONTEXT.md` for definitions, so that the two never disagree.
37. As the `review` skill running on psdd itself, I want a short, checkable `CODING_STANDARDS.md`, so that "the repo's documented standards" exist to check against.
38. As a future contributor, I want the coding standards to state that only renderers produce wording, so that prose doesn't creep back into the core.
39. As the author of #57 and #65, I want `packages/testing` and the GitHub port in their own packages, so that a fake `gh` CLI and an Octokit adapter slot in without further restructuring.

## Implementation Decisions

### Order and delivery

- One PR per step, in the order #56 → #53 → #52 → #54 → #55. Each PR is behaviour-preserving and green on its own.
- #53 goes before #52 so logic changes and file moves never share a PR, and so the move happens after the core has stopped speaking prose.

### Tooling and CI (#56)

- Biome is the single formatter and linter. The formatter matches today's style (double quotes, semicolons, current line width) so the first run is close to a no-op.
- Linter: Biome's recommended set plus no floating promises, no unused imports, no default exports. All violations are fixed in the same PR. A rule that fights the codebase is disabled in the Biome config with a one-line reason, never per file.
- `noFloatingPromises` is a nursery rule; if it proves unreliable it is dropped and the gap is noted in the coding standards. No typescript-eslint just for it.
- `npm run check` runs typecheck, Biome and the tests.
- A new GitHub Actions workflow runs `npm run check` on PRs and on pushes to `main`, on Node 20 (matching `engines`). From #52 on it also installs the built tree in a temp project and runs `psdd --help`.

### Typed results (#53)

- Before any logic changes, characterization tests pin text and `--json` output for every command whose output isn't already pinned.
- Every core operation returns data: `NextResult`, `TakeResult`, `DoneResult`, `StatusResult`, `TidyResult`, and the same for add-slice, escalate, release and init where they live in core.
- Everything psdd itself says becomes a variant of a discriminated union on `kind`: results, follow-up events (e.g. `{ kind: "story-branch-created", branch }`, `{ kind: "follow-up-failed", what, retry }`) and refusals (e.g. `{ kind: "not-claimed", issue }`). The helpers that today return `string[]` (follow-ups, best-effort, blocked-sync, story promotion, branch ensuring) return events instead.
- Text from outside psdd — `gh` stderr, user notes — rides inside a variant as an opaque `detail: string`, never parsed.
- The briefing becomes a structure: step, skill, location, instructions, finish commands. The skill instructions inside it stay strings: they are content, not formatting.
- Configuration warnings become typed too, rendered once before the answer as today.
- The CLI owns exactly one text renderer: an exhaustive `switch` on `kind` per result type, with a `never` check so a variant without wording fails the typecheck.
- The JSON renderer reproduces today's shape exactly: `{ ok: true, ...data, message }` / `{ ok: false, refusal }` (+ `warnings`), where `message` and `refusal` come from the text renderer and `data` is picked from the result. `--json` does not grow; new front ends consume result types as a library, not CLI output.
- The text helpers split: wording helpers move next to the renderer; helpers the core uses for logic (e.g. slug normalisation) stay in core.

### Packages (#52)

- npm workspaces under `packages/`, named `@psdd/core`, `@psdd/github-gh`, `@psdd/workspace-local`, `@psdd/cli`, `@psdd/testing`. All `"private": true`, version `0.0.0`; only the root `psdd` package carries the real version.
- Internal packages are consumed as TypeScript source; `tsc -b` typechecks across them.
- Module map:
  - **core** — state machine, transitions, claims, slug, location, briefing, next, status, tidy, config (it already reads through the Workspace port), the ports (GitHub, Workspace, Notify), the logic part of the text helpers.
  - **github-gh** — the GitHub port over the `gh` CLI.
  - **workspace-local** — local git/herdr/claude-code worktrees and the OS/herdr notifier (the notifier borrows the workspace's command runner; both live here).
  - **cli** — executable entry, command dispatch, argument parsing, environment, init, skill installation, the renderers, the wording part of the text helpers.
  - **testing** — FakeGitHub, FakeWorkspace, the harness.
- init and skill installation stay in `cli` and keep using the filesystem directly; routing them through ports would be new design, not a move.
- `skills/` stays top level: content, copied by init.
- Tests stay in one top-level test folder and import packages by name.
- `core` may import `node:path` (pure string manipulation) and no other `node:*` module.
- esbuild, from a small build script, bundles `cli` into one self-contained ESM `bin.js` targeting node20 with `node:*` external. Workspace packages are inlined. Typechecking stays separate.
- Distribution: release tags carry the built bundle; `main` keeps it gitignored. The release process builds, force-adds the bundle in a release commit and tags it. The root package drops its `prepare` script. Consequence, accepted: installing from a branch or SHA no longer works.
- This PR moves files only. No behaviour change; the suite stays green.

### Boundary test (#54)

- A vitest test lands right after the move. It reads every static import, `export … from` and dynamic `import()` in each package's sources with the TypeScript compiler API (`ts.preProcessFile`), with no new dependency.
- Rules:
  - `core` imports no internal package, and no `node:*` except `node:path`.
  - Adapters (`github-gh`, `workspace-local`) import only `core`.
  - Only front ends (`cli`; later runner, dispatcher, web, mcp) wire adapters.
  - `testing` is imported only from tests (later also evals).
  - Every internal import is declared in the importer's `package.json` dependencies; a declared internal dependency never imported is flagged.
- Failures name `file → specifier: rule broken`. dependency-cruiser is the fallback only if the rules outgrow this.

### Docs (#55)

- `PRD.html` stays the living document for vision and way of working; no technical detail.
- `CONTEXT.md` is canonical for domain definitions: one definition per term (story, slice, step, claim, briefing, outcome, needs-human, fix round, …) and how they relate. The PRD uses the terms and links here instead of redefining them; a new concept in the PRD adds its entry here in the same change.
- `CODING_STANDARDS.md`, short and checkable: package rules (pointing at the boundary test), best-effort follow-ups vs refusals, only renderers produce wording, testing at seams with the fakes, naming, comment style, what the CLI may print, the PRD/CONTEXT rule above, and the floating-promises gap if that rule was dropped.
- `README.md` stays user-facing and links to these documents.

## Testing Decisions

- A good test exercises external behaviour at the highest seam available: what a user sees from a command, or what a front end gets from a core operation. Tests don't reach into module internals and survive moving files and renaming private functions.
- **Seam 1 — the CLI entry, `run(argv, deps)`, through the shared harness.** The main seam; nearly every existing test uses it against FakeGitHub and FakeWorkspace. Characterization tests pin byte-identical text and `--json` output per command before #53, and every PR in the series keeps them green. After #52 the harness imports `@psdd/cli` and its fakes from `@psdd/testing`; otherwise unchanged.
- **Seam 2 — core operations called with a `Ctx`.** The one new seam, created by #53, and the API future front ends will call. Tests assert typed results and events without any wording. Kept few, aimed at variants the CLI tests can't easily reach (e.g. each follow-up-failed path).
- **Adapter tests** (gh adapter, local workspace, notifier) stay at the port boundary as today.
- **Static checks, not runtime seams:** the boundary test (#54); the CI install smoke test of the built bundle.
- Prior art: the harness-driven suites (lifecycle, story/slice flow, take, next, status, tidy, review-qa) for seam 1; the gh adapter and local workspace tests for adapters; the existing `--json` assertions in config, next, status and similar tests for output pinning.

## Out of Scope

- #57 fake `gh` CLI and #65 Octokit GitHub adapter: enabled by `packages/testing` and the separate GitHub port, built later.
- ADRs: deferred. The decisions are recorded in this spec until ADRs are written.
- Publishing to GitHub Packages or npm, standalone binaries, Homebrew (#30–#32): distribution is a later decision. The bundle built here feeds #30.
- Splitting tests per package.
- Any change to CLI text output, `--json` shape, command set or skills.
- Routing init or skill installation through ports.
- Richer machine-readable output from the CLI.

## Further Notes

- The only user-visible changes are a faster install from a tag, no build step and no `allowScripts` warning; installing from a branch or SHA stops working.
- The release skill must be updated with the build-and-commit-bundle step when #52 lands.
- If something outside this repo ever needs `@psdd/core` as a library, publish it to GitHub Packages rather than npm (from #52).
