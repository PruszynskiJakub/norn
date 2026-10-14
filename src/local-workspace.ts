import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { samePath, type Provider, type Workspace } from "./workspace.js";

export type Run = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runCommand: Run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** The developer's machine, via git and herdr. */
export class LocalWorkspace implements Workspace {
  constructor(
    public root: string,
    public env: Record<string, string | undefined>,
    private run: Run = runCommand,
    public cwd: string = root,
  ) {}

  /** The main checkout's root, also from inside a linked worktree. */
  static async findRoot(cwd: string, run: Run = runCommand): Promise<string> {
    const r = await run("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (r.code !== 0) throw new Error(`Not inside a git repository: ${cwd}`);
    return dirname(r.stdout.trim());
  }

  private async must(cmd: string, args: string[]) {
    const r = await this.run(cmd, args);
    if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout;
  }

  async readFile(rel: string) {
    try {
      return await readFile(join(this.root, rel), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async worktreeExists(rel: string) {
    const out = await this.must("git", ["-C", this.root, "worktree", "list", "--porcelain"]);
    const path = join(this.root, rel);
    return out.split("\n").some((l) => l.startsWith("worktree ") && samePath(l.slice("worktree ".length), path));
  }

  async branchCheckedOutAt(branch: string) {
    const out = await this.must("git", ["-C", this.root, "worktree", "list", "--porcelain"]);
    // Porcelain entries are blank-line separated: "worktree <path>", "HEAD <sha>", "branch refs/heads/<b>".
    for (const entry of out.split("\n\n")) {
      const lines = entry.split("\n");
      if (lines.includes(`branch refs/heads/${branch}`)) {
        return lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length) ?? null;
      }
    }
    return null;
  }

  async localBranchExists(branch: string) {
    return (await this.run("git", ["-C", this.root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  }

  async removeWorktree(rel: string, provider: Provider) {
    const path = join(this.root, rel);
    if (provider === "herdr") {
      const list = JSON.parse(await this.must("herdr", ["worktree", "list", "--cwd", this.root])) as {
        result: { worktrees: { path: string; open_workspace_id?: string | null }[] };
      };
      const id = list.result.worktrees.find((w) => samePath(w.path, path))?.open_workspace_id;
      if (id) {
        await this.must("herdr", ["worktree", "remove", "--workspace", id, "--force"]);
        return;
      }
    }
    await this.must("git", ["-C", this.root, "worktree", "remove", "--force", path]);
  }
}
