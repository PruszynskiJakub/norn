import type { Provider, Workspace } from "../src/workspace.js";

export class FakeWorkspace implements Workspace {
  root = "/repo";
  cwd = "/repo";
  env: Record<string, string | undefined> = { CLAUDECODE: "1" };
  files = new Map<string, string>();
  worktrees = new Set<string>();
  localBranches = new Set<string>(["main"]);
  removed: { path: string; provider: Provider }[] = [];

  async readFile(rel: string) {
    return this.files.get(rel) ?? null;
  }
  async worktreeExists(rel: string) {
    return this.worktrees.has(rel);
  }
  /** Branch → absolute path of the checkout that has it checked out. */
  checkedOut = new Map<string, string>();
  async branchCheckedOutAt(branch: string) {
    return this.checkedOut.get(branch) ?? null;
  }
  async localBranchExists(branch: string) {
    return this.localBranches.has(branch);
  }
  async removeWorktree(rel: string, provider: Provider) {
    this.worktrees.delete(rel);
    this.removed.push({ path: rel, provider });
  }
}
