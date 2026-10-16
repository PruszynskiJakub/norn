import type { Provider, Workspace } from "@norn/core";

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
  /** Worktrees with uncommitted changes. */
  dirty = new Set<string>();
  async worktreeDirty(rel: string) {
    return this.dirty.has(rel);
  }
  async removeWorktree(rel: string, provider: Provider) {
    this.worktrees.delete(rel);
    this.removed.push({ path: rel, provider });
  }
  async listWorktrees() {
    const main = { path: this.root, branch: [...this.checkedOut].find(([, p]) => p === this.root)?.[0] ?? "main" };
    // A worktree at .agents/worktrees/<branch> has that branch checked out.
    return [main, ...[...this.worktrees].map((rel) => ({ path: `${this.root}/${rel}`, branch: rel.split("/").at(-1) ?? null }))];
  }
  async listLocalBranches() {
    return [...this.localBranches];
  }
  /** Local branch → the commit it points at; a branch without one here points at "local-<branch>". */
  heads = new Map<string, string>();
  async branchHead(branch: string) {
    return this.localBranches.has(branch) ? (this.heads.get(branch) ?? `local-${branch}`) : null;
  }
  /** Local branches with commits not on GitHub. */
  unpushed = new Set<string>();
  async hasUnpushedCommits(branch: string) {
    return this.unpushed.has(branch);
  }
  deletedBranches: string[] = [];
  async deleteLocalBranch(branch: string) {
    this.localBranches.delete(branch);
    this.deletedBranches.push(branch);
  }
  fetched = 0;
  async fetchRemote() {
    this.fetched++;
  }
  /** Evidence directories by the path norn is given. */
  evidence = new Map<string, { path: string; content: Buffer }[]>();
  async readEvidence(dir: string) {
    return this.evidence.get(dir) ?? null;
  }
}
