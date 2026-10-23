import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LocalWorkspace, type Run } from "@norn/workspace-local";
import { isWithin, samePath } from "@norn/core";

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
  test("listWorktrees gives each worktree's path and branch, detached ones without", async () => {
    const { run } = scripted(() => ({
      stdout:
        "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/.agents/worktrees/123-x\nHEAD def\nbranch refs/heads/123-x\n\nworktree /tmp/d\nHEAD 012\ndetached\n\n",
    }));
    expect(await new LocalWorkspace("/repo", {}, run).listWorktrees()).toEqual([
      { path: "/repo", branch: "main" },
      { path: "/repo/.agents/worktrees/123-x", branch: "123-x" },
      { path: "/tmp/d", branch: null },
    ]);
  });

  test("hasUnpushedCommits counts the branch's commits on no remote-tracking branch", async () => {
    const { run, calls } = scripted((_, args) => ({ stdout: args.includes("refs/heads/ahead") ? "2\n" : "0\n" }));
    const ws = new LocalWorkspace("/repo", {}, run);
    expect(await ws.hasUnpushedCommits("ahead")).toBe(true);
    expect(await ws.hasUnpushedCommits("pushed")).toBe(false);
    expect(calls[0]).toBe("git -C /repo rev-list --count refs/heads/ahead --not --remotes");
  });

  test("readEvidence reads every file under the directory, relative to where norn runs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "norn-evidence-"));
    mkdirSync(join(cwd, "qa", "logs"), { recursive: true });
    writeFileSync(join(cwd, "qa", "shot.png"), "png");
    writeFileSync(join(cwd, "qa", "logs", "run.txt"), "ok");
    const ws = new LocalWorkspace("/repo", {}, scripted(() => ({})).run, cwd);
    const files = await ws.readEvidence("qa");
    expect(files?.map((f) => [f.path, f.content.toString()])).toEqual([
      ["logs/run.txt", "ok"],
      ["shot.png", "png"],
    ]);
    expect(await ws.readEvidence("missing")).toBeNull();
    expect(await ws.readEvidence("qa/shot.png")).toBeNull();
  });

  test("readNote reads a file relative to where norn runs, and no directory or missing file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "norn-note-"));
    mkdirSync(join(cwd, "qa"));
    writeFileSync(join(cwd, "note.md"), "line 1\n`npm test` $HOME\n");
    const ws = new LocalWorkspace("/repo", {}, scripted(() => ({})).run, cwd);
    expect(await ws.readNote("note.md")).toBe("line 1\n`npm test` $HOME\n");
    expect(await ws.readNote(join(cwd, "note.md"))).toBe("line 1\n`npm test` $HOME\n");
    expect(await ws.readNote("qa")).toBeNull();
    expect(await ws.readNote("missing.md")).toBeNull();
  });

  test("worktreeExists looks the path up in git's worktree list", async () => {
    const { run } = scripted(() => ({
      stdout: "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/.agents/worktrees/123-x\nHEAD def\n",
    }));
    const ws = new LocalWorkspace("/repo", {}, run);
    expect(await ws.worktreeExists(".agents/worktrees/123-x")).toBe(true);
    expect(await ws.worktreeExists(".agents/worktrees/124-y")).toBe(false);
  });

  test("worktreeDirty asks git status in the worktree", async () => {
    const { run, calls } = scripted((_, args) => ({ stdout: args[1].endsWith("dirty") ? "?? notes.txt\n" : "" }));
    const ws = new LocalWorkspace("/repo", {}, run);
    expect(await ws.worktreeDirty(".agents/worktrees/dirty")).toBe(true);
    expect(await ws.worktreeDirty(".agents/worktrees/clean")).toBe(false);
    expect(calls[0]).toBe("git -C /repo/.agents/worktrees/dirty status --porcelain");
  });

  test("branchCheckedOutAt finds the worktree whose entry has the branch", async () => {
    const { run } = scripted(() => ({
      stdout:
        "worktree /repo\nHEAD abc\nbranch refs/heads/123-x\n\nworktree /repo/.agents/worktrees/124-y\nHEAD def\nbranch refs/heads/124-y\n\nworktree /tmp/d\nHEAD 012\ndetached\n",
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

  test("originUrl is the origin remote's URL; none without one", async () => {
    let has = true;
    const { run, calls } = scripted(() => (has ? { stdout: "git@github.com:acme/app.git\n" } : { code: 2 }));
    const ws = new LocalWorkspace("/repo", {}, run);

    expect(await ws.originUrl()).toBe("git@github.com:acme/app.git");
    expect(calls[0]).toBe("git -C /repo remote get-url origin");
    has = false;
    expect(await ws.originUrl()).toBeNull();
  });

  test("readFile reads relative to the repository root; missing files are null", async () => {
    const root = mkdtempSync(join(tmpdir(), "norn-ws-"));
    mkdirSync(join(root, ".agents"));
    writeFileSync(join(root, ".agents", "norn.config.json"), "{}");
    const ws = new LocalWorkspace(root, {}, scripted(() => ({})).run);
    expect(await ws.readFile(".agents/norn.config.json")).toBe("{}");
    expect(await ws.readFile(".agents/norn.config.local.json")).toBeNull();
  });

  /** git as seen from a directory: rev-parse prints git-dir, common dir and toplevel; core.worktree as configured. */
  function repoAt(gitDir: string, commonDir: string, toplevel: string, coreWorktree?: string) {
    return scripted((_, args) => {
      if (args.includes("rev-parse")) return { stdout: `${gitDir}\n${commonDir}\n${toplevel}\n` };
      if (args.includes("core.worktree")) return coreWorktree ? { stdout: `${coreWorktree}\n` } : { code: 1 };
    }).run;
  }

  test("in the main checkout, the root is its toplevel", async () => {
    expect(await LocalWorkspace.findRoot("/repo/src", repoAt("/repo/.git", "/repo/.git", "/repo"))).toBe("/repo");
  });

  test("the root is the main checkout, even when run from a worktree", async () => {
    const run = repoAt("/repo/.git/worktrees/123-x", "/repo/.git", "/repo/.agents/worktrees/123-x");
    expect(await LocalWorkspace.findRoot("/repo/.agents/worktrees/123-x", run)).toBe("/repo");
  });

  test("a submodule's root is its checkout, not the superproject's .git/modules", async () => {
    expect(await LocalWorkspace.findRoot("/super/app", repoAt("/super/.git/modules/app", "/super/.git/modules/app", "/super/app"))).toBe("/super/app");
    const fromWorktree = repoAt("/super/.git/modules/app/worktrees/x", "/super/.git/modules/app", "/super/app-x", "../../../app");
    expect(await LocalWorkspace.findRoot("/super/app-x", fromWorktree)).toBe("/super/app");
  });

  test("a repo cloned with --separate-git-dir uses its toplevel; from a linked worktree it cannot be found and says so", async () => {
    expect(await LocalWorkspace.findRoot("/sep", repoAt("/elsewhere/sep.git", "/elsewhere/sep.git", "/sep"))).toBe("/sep");
    const fromWorktree = repoAt("/elsewhere/sep.git/worktrees/x", "/elsewhere/sep.git", "/sep-x");
    await expect(LocalWorkspace.findRoot("/sep-x", fromWorktree)).rejects.toThrow("Run norn from the main checkout.");
  });
});

describe("comparing paths", () => {
  test("git's C:/ form and Node's C:\\ form are the same path on Windows", () => {
    expect(samePath("C:/Users/me/app/.agents/worktrees/7-x", "C:\\Users\\me\\app\\.agents\\worktrees\\7-x", "win32")).toBe(true);
    expect(samePath("c:/Users/me/app/", "C:\\Users\\me\\app", "win32")).toBe(true);
    expect(samePath("/repo/a", "/repo/b", "linux")).toBe(false);
  });

  test("isWithin knows a path inside a worktree, and not a sibling with the same prefix", () => {
    expect(isWithin("C:\\r\\.agents\\worktrees\\7-x\\src", "C:/r/.agents/worktrees/7-x", "win32")).toBe(true);
    expect(isWithin("/r/.agents/worktrees/7-x-12", "/r/.agents/worktrees/7-x", "linux")).toBe(false);
  });
});
