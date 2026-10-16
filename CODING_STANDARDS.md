# Coding standards

Rules for norn's code, each one checkable in a review. `npm run check` (typecheck, Biome, tests) enforces what can be enforced mechanically; the rest is for the reviewer. Domain words mean what [`CONTEXT.md`](CONTEXT.md) says.

## Packages

1. The code lives in `packages/`: `core` (process logic and the ports), the adapters `github-gh` and `workspace-local`, the front ends `cli` and `web` (the dashboard), and `testing`.
2. `core` imports no other package and no `node:` module except `node:path`. It does no I/O of its own: everything goes through the GitHub, Workspace and Notify ports.
3. An adapter imports only `@norn/core`. Only a front end (`cli`, `web`) wires adapters to the core.
4. `@norn/testing` is imported only from tests.
5. Every `@norn/*` import is declared in the importing package's `package.json`, and every declared one is used. A relative import never leaves its package.

Rules 2–5 are enforced by `test/boundaries.test.ts`.

## Results, refusals and wording

6. A core operation returns data: a result, or `{ ok: false, refusal }`. Results, events and refusals are discriminated unions on `kind` with kebab-case values, carrying facts (numbers, branch names, timestamps), not sentences.
7. Only renderers produce wording. Everything norn prints is written in `packages/cli/src/render-text.ts`; `--json` is built from it by `render-json.ts`. The dashboard serves the core's read model as JSON, and its UI words it in `packages/web/ui/src/wording.ts`. Notifications are typed too: core sends a `Notification` through the Notify port, and the front end words it. Core composes text only for GitHub (comments and the markers norn reads back) and the skill instructions inside a briefing, which are content the briefing carries.
8. A renderer switches exhaustively on `kind` and ends in a `never` check, so a variant without wording fails the typecheck.
9. Text that comes from outside norn (a `gh` error, a user's note, a reason read back from a comment) travels as an opaque `detail` (or a named field like `why`) and is never parsed.
10. A refusal comes before any change to GitHub. It says why, and what to do instead.
11. After a transition, follow-ups are best effort: each runs through `bestEffort`, never throws, and a failure becomes a `follow-up-failed` event naming what failed and the `norn next` that retries it. Follow-ups are idempotent, since `norn next` repeats them.
12. A label change adds the new state label before removing the old one, so a failure in between never leaves an issue without a state.

## The CLI

13. The CLI prints one answer to stdout: configuration warnings first, then the result or refusal. Prose is written as instructions to the agent.
14. Exit codes: 0 for a result, 1 for a refusal, 2 for a usage error. The one exception is `norn doctor`, which always answers but exits 1 when a check fails, so CI notices.
15. The `--json` shape is fixed: `{ ok: true, ...data, message }` or `{ ok: false, refusal }`, plus `warnings`. New front ends use the core's result types as a library instead of growing it. The exceptions: `norn doctor --json` gives `{ ok, checks }`, with the config warnings as a check, and `norn --version` prints the bare version.

## Testing

16. Test at the highest seam that reaches the behaviour: a command through the harness (`setup()` from `@norn/testing`, running `run(argv, deps)` against `FakeGitHub` and `FakeWorkspace`); a core operation with `ctx()` for variants the CLI cannot easily reach; an adapter at its port.
17. Tests use the shared fakes, never mocks of norn's own modules, and do not reach into module internals.
18. The characterization snapshots in `test/__snapshots__/` change only when the output is meant to change, and the change is reviewed line by line.

## Style

19. Biome formats and lints. A rule that fights the codebase is turned off in `biome.jsonc` with a one-line reason; a single deliberate exception is a `biome-ignore` comment with its reason, never a file-wide one.
20. Named exports only, no default exports (enforced).
21. No floating promises: await every promise or return it (enforced by Biome's nursery `noFloatingPromises`, which does not see every promise from a library; await those deliberately).
22. Files are kebab-case. Names use the domain terms from `CONTEXT.md` and avoid the words it lists under _Avoid_.
23. Comments say why, not what: a constraint, a failure mode, a GitHub quirk. They are full sentences. Exported types and functions get a `/** */` line when their name does not say it all. No commented-out code.

## Documents

24. `docs/` holds the principles and the way of working; `CONTEXT.md` holds the definitions. The docs use the terms and link to `CONTEXT.md` rather than redefining them, and a new concept in the docs adds its entry to `CONTEXT.md` in the same change. A change to the process or the commands updates the matching page in `docs/` in the same change.
25. A user-visible change gets a `CHANGELOG.md` entry under `## [Unreleased]`.
