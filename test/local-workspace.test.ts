import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LocalWorkspace, type Run } from "../src/local-workspace.js";

function scripted(handler: (cmd: string, args: string[]) => { code?: number; stdout?: string } | undefined) {
  const calls: string[] = [];
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    const r = handler(cmd, args);
    if (!r) throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: "" };
  };
  return { run, calls };
}

describe("LocalWorkspace", () => {
  test("worktreeExists looks the path up in git's worktree list", async () => {
    const { run } = scripted(() => ({
      stdout: "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/.agents/worktrees/123-x\nHEAD def\n",
    }));
    const ws = new LocalWorkspace("/repo", {}, run);
    expect(await ws.worktreeExists(".agents/worktrees/123-x")).toBe(true);
    expect(await ws.worktreeExists(".agents/worktrees/124-y")).toBe(false);
  });

  test("branchCheckedOutAt finds the worktree whose entry has the branch", async () => {
    const { run } = scripted(() => ({
      stdout: "worktree /repo\nHEAD abc\nbranch refs/heads/123-x\n\nworktree /repo/.agents/worktrees/124-y\nHEAD def\nbranch refs/heads/124-y\n\nworktree /tmp/d\nHEAD 012\ndetached\n",
    }));
    const ws = new LocalWorkspace("/repo", {}, run);
    expect(await ws.branchCheckedOutAt("123-x")).toBe("/repo");
    expect(await ws.branchCheckedOutAt("124-y")).toBe("/repo/.agents/worktrees/124-y");
    expect(await ws.branchCheckedOutAt("123-x-1")).toBeNull();
  });

  test("localBranchExists asks git for the branch ref", async () => {
    const { run, calls } = scripted((_, args) => ({ code: args.includes("refs/heads/123-x") ? 0 : 1 }));
    const ws = new LocalWorkspace("/repo", {}, run);
    expect(await ws.localBranchExists("123-x")).toBe(true);
    expect(await ws.localBranchExists("nope")).toBe(false);
    expect(calls[0]).toBe("git -C /repo show-ref --verify --quiet refs/heads/123-x");
  });

  test("git and claude-code remove with git worktree remove", async () => {
    const { run, calls } = scripted(() => ({}));
    await new LocalWorkspace("/repo", {}, run).removeWorktree(".agents/worktrees/123-x", "claude-code");
    expect(calls).toEqual(["git -C /repo worktree remove --force /repo/.agents/worktrees/123-x"]);
  });

  test("herdr removes the worktree's workspace by its id", async () => {
    const list = JSON.stringify({
      result: { worktrees: [{ path: "/repo/.agents/worktrees/123-x", open_workspace_id: "w9" }] },
    });
    const { run, calls } = scripted((cmd) => (cmd === "herdr" ? { stdout: list } : undefined));
    await new LocalWorkspace("/repo", {}, run).removeWorktree(".agents/worktrees/123-x", "herdr");
    expect(calls).toEqual(["herdr worktree list --cwd /repo", "herdr worktree remove --workspace w9 --force"]);
  });

  test("herdr falls back to git when the worktree has no open workspace", async () => {
    const list = JSON.stringify({ result: { worktrees: [{ path: "/repo/.agents/worktrees/123-x", open_workspace_id: null }] } });
    const { run, calls } = scripted((cmd) => (cmd === "herdr" ? { stdout: list } : {}));
    await new LocalWorkspace("/repo", {}, run).removeWorktree(".agents/worktrees/123-x", "herdr");
    expect(calls.at(-1)).toBe("git -C /repo worktree remove --force /repo/.agents/worktrees/123-x");
  });

  test("readFile reads relative to the repository root; missing files are null", async () => {
    const root = mkdtempSync(join(tmpdir(), "psdd-ws-"));
    mkdirSync(join(root, ".agents"));
    writeFileSync(join(root, ".agents", "psdd.config.json"), "{}");
    const ws = new LocalWorkspace(root, {}, scripted(() => ({})).run);
    expect(await ws.readFile(".agents/psdd.config.json")).toBe("{}");
    expect(await ws.readFile(".agents/psdd.config.local.json")).toBeNull();
  });

  test("the root is the main checkout, even when run from a worktree", async () => {
    const { run } = scripted(() => ({ stdout: "/repo/.git\n" }));
    expect(await LocalWorkspace.findRoot("/repo/.agents/worktrees/123-x", run)).toBe("/repo");
  });
});
