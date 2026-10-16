import { describe, expect, test } from "vitest";
import { createWorktreeCommand, type Location } from "@psdd/core";

const slice: Location = {
  branch: "123-rate-limiting-131",
  base: "123-rate-limiting",
  worktree: ".agents/worktrees/123-rate-limiting-131",
  story: { number: 123, title: "Rate limiting", state: "open", labels: [], assignees: [] },
  slug: "rate-limiting",
};
const path = "/repo/.agents/worktrees/123-rate-limiting-131";

describe("herdr worktree commands", () => {
  test("a branch only on GitHub is fetched and checked out with its commits, not made anew from the base", () => {
    expect(createWorktreeCommand("herdr", slice, "/repo", { local: false, remote: true })).toBe(
      `git -C /repo fetch origin 123-rate-limiting 123-rate-limiting-131 && herdr worktree create --cwd /repo --branch 123-rate-limiting-131 --base origin/123-rate-limiting-131 --path ${path} --no-focus`,
    );
  });

  test("a new branch is made with git without tracking the base, then handed to herdr", () => {
    expect(createWorktreeCommand("herdr", slice, "/repo", { local: false, remote: false })).toBe(
      `git -C /repo fetch origin 123-rate-limiting && git -C /repo branch --no-track 123-rate-limiting-131 origin/123-rate-limiting && herdr worktree create --cwd /repo --branch 123-rate-limiting-131 --path ${path} --no-focus`,
    );
  });

  test("a local branch gets no --base, which herdr ignores for it", () => {
    expect(createWorktreeCommand("herdr", slice, "/repo", { local: true, remote: false })).toBe(
      `herdr worktree create --cwd /repo --branch 123-rate-limiting-131 --path ${path} --no-focus`,
    );
  });

  test("a local branch also on GitHub is fast-forwarded inside the new worktree", () => {
    expect(createWorktreeCommand("herdr", slice, "/repo", { local: true, remote: true })).toBe(
      `git -C /repo fetch origin 123-rate-limiting-131 && herdr worktree create --cwd /repo --branch 123-rate-limiting-131 --path ${path} --no-focus && git -C ${path} merge --ff-only origin/123-rate-limiting-131`,
    );
  });
});

describe("git worktree commands for a local branch", () => {
  test("also on GitHub: fast-forwarded from origin inside the new worktree, keeping local commits", () => {
    expect(createWorktreeCommand("git", slice, "/repo", { local: true, remote: true })).toBe(
      `git -C /repo fetch origin 123-rate-limiting-131 && git -C /repo worktree add ${path} 123-rate-limiting-131 && git -C ${path} merge --ff-only origin/123-rate-limiting-131`,
    );
  });

  test("only local: no fetch, which would fail without the branch on GitHub", () => {
    expect(createWorktreeCommand("claude-code", slice, "/repo", { local: true, remote: false })).toBe(
      `git -C /repo worktree add ${path} 123-rate-limiting-131`,
    );
  });
});

describe("printed commands are shell-quoted", () => {
  test("a checkout under a path with a space or a quote is single-quoted, plain words are not", () => {
    const root = "/Users/Jane O'Doe/app";
    const wt = `'/Users/Jane O'\\''Doe/app/.agents/worktrees/123-rate-limiting-131'`;
    expect(createWorktreeCommand("git", slice, root, { local: false, remote: false })).toBe(
      `git -C '/Users/Jane O'\\''Doe/app' fetch origin 123-rate-limiting && git -C '/Users/Jane O'\\''Doe/app' worktree add --no-track ${wt} -b 123-rate-limiting-131 origin/123-rate-limiting`,
    );
    expect(createWorktreeCommand("herdr", slice, root, { local: true, remote: false })).toBe(
      `herdr worktree create --cwd '/Users/Jane O'\\''Doe/app' --branch 123-rate-limiting-131 --path ${wt} --no-focus`,
    );
  });
});
