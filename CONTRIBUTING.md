# Contributing to norn

Thanks for helping. This page covers setting up, the checks a change must pass, and how a release is cut.

## Set up

You need Node 20+, git and `gh`.

```sh
git clone https://github.com/PruszynskiJakub/ai-engine.git
cd ai-engine
npm ci
npm run check
```

## Checks

```sh
npm run check     # typecheck, Biome and the tests; CI runs it on every PR
npm test          # vitest, against an in-memory GitHub and a scripted gh
npm run format    # apply Biome's fixes
npm run build     # builds the dashboard UI and bundles it with the CLI into dist/bin.js
```

CI also installs the built package into a throwaway project and runs it.

To try your build, run `node dist/bin.js <command>` inside a repository set up for norn.

## The code

The code is npm workspaces under `packages/`:

| Package | Role |
| --- | --- |
| `core` | The process: state machine, transitions, claims, briefings. No I/O of its own |
| `github-gh` | The GitHub adapter, through your `gh` |
| `workspace-local` | The local adapter: files, git, worktrees, notifications |
| `cli` | The `norn` command and its wording |
| `web` | The dashboard's server, and its React UI in `web/ui` |
| `testing` | The fakes and the test harness |

[`CODING_STANDARDS.md`](CODING_STANDARDS.md) has the rules for the code, and [`CONTEXT.md`](CONTEXT.md) defines the domain terms. Use the terms as `CONTEXT.md` defines them; a new concept adds its entry there in the same change.

## Making a change

- Keep a PR to one change, with tests at the seams (see [`CODING_STANDARDS.md`](CODING_STANDARDS.md#testing)).
- A user-visible change gets an entry under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md), in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form.
- A change to the process or the commands updates the matching page in [`docs/`](docs/) in the same PR.

## Cutting a release

norn is installed from release tags, which carry the built CLI; `dist/` is not committed on `main`.

1. In a PR, bump `version` in `package.json` (and `package-lock.json`), move the `Unreleased` entries in `CHANGELOG.md` under the new version with today's date, and update the version in the README's install command, its release badge and `docs/tutorial.md`.
2. After it merges, build on `main` and commit the bundle on a detached commit, then tag that commit:

   ```sh
   git switch --detach origin/main
   npm ci && npm run build
   git add -f dist/bin.js && git commit -m "Build norn <version>"
   git tag -a v<version> -m "norn <version>"
   git push origin v<version>
   ```

3. Check that `npm install -D github:PruszynskiJakub/ai-engine#v<version>` works in a throwaway project.
