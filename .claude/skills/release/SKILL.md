---
name: release
description: Release a new norn version from main, with a version bump, changelog, tag and GitHub release.
disable-model-invocation: true
argument-hint: "[version]"
---

Release norn from `main`. `$ARGUMENTS` is the version, if given. norn is not on npm: projects install it from a git tag (`github:PruszynskiJakub/ai-engine#vX.Y.Z`), so the tag is what ships. npm builds nothing on install, so the tag points at a release commit that carries the built `dist/bin.js`; `main` never does.

The user merges every PR. Ask them to, give the link, and wait for "merged". PRs merge with merge commits.

## Steps

1. **Ready.** Every PR meant for this release is merged into `main` (`gh pr list` shows none of them open), and `## [Unreleased]` in `CHANGELOG.md` on `origin/main` has entries. Done when both hold.
2. **Version.** Pick it from the Unreleased sections. While norn is 0.x, a release with only `### Fixed` is a patch (0.2.2 → 0.2.3); `### Added`, `### Changed` or `### Removed` make it a minor (0.3.0 → 0.4.0). `$ARGUMENTS` overrides this. Tell the user the version and why. Done when they agree.
3. **Branch.** In a new worktree, branch `release-X.Y.Z` from a freshly fetched `origin/main`.
4. **Bump.** Done when `git diff` shows exactly these four changes, and nothing else:
   - `npm version X.Y.Z --no-git-tag-version` (`package.json` and `package-lock.json`).
   - `CHANGELOG.md`: add `## [X.Y.Z] - <today>` under `## [Unreleased]`, so the entries move under it and Unreleased is left empty.
   - `CHANGELOG.md` links at the bottom: `[Unreleased]` compares `vX.Y.Z...HEAD`, and a new `[X.Y.Z]` line compares the previous tag with `vX.Y.Z`.
   - `README.md`: every `#v<previous>` install tag becomes `#vX.Y.Z`. `grep -n "#v" README.md` finds them all.
5. **Check.** `npm ci`, `npm run check` and `npm run build` all pass. A failure stops the release: report it to the user.
6. **PR.** Commit as `Release X.Y.Z` and push the branch. Open a PR titled `Release X.Y.Z`, with a body of one line naming the release's main changes and ending "See CHANGELOG." Ask the user to merge it.
7. **Tag.** Fetch, and find the merge commit of the release PR on `origin/main` (`gh pr view <n> --json mergeCommit`). In the release worktree, check out that commit detached, run `npm ci` and `npm run build`, then `git add -f dist/bin.js` and commit it as `Build norn X.Y.Z`: the release commit, on no branch. Create the annotated tag `vX.Y.Z` with the message `norn X.Y.Z` on the release commit, then push the tag. Done when `git ls-tree -r vX.Y.Z --name-only` lists `dist/bin.js` and `origin/main` does not.
8. **GitHub release.** `gh release create vX.Y.Z --verify-tag --title "norn X.Y.Z" --notes-file <file>`. The notes are the `## [X.Y.Z]` section of `CHANGELOG.md`, without its heading. Write them to a file in the scratchpad.
9. **Verify.** `gh release list` shows `norn X.Y.Z` as Latest, and `git ls-remote --tags origin vX.Y.Z` returns the tag. Remove the release worktree. Report to the user: the version, the release link, the install line `npm install -D github:PruszynskiJakub/ai-engine#vX.Y.Z`, and that projects run `npx norn init` after upgrading to get the new skills.
