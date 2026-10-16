import type { ClaimRecord, FileToPush, GitHub, Issue, PullRequest } from "@psdd/core";

export class FakeGitHub implements GitHub {
  issues = new Map<number, Issue>();
  claims = new Map<number, ClaimRecord>();
  commentsByIssue = new Map<number, string[]>();
  parents = new Map<number, number>();
  blockers = new Map<number, number[]>();
  branches = new Set<string>(["main"]);
  prs: PullRequest[] = [];
  private nextNumber = 1000;

  constructor(public user: string) {}

  seedIssue(i: Partial<Issue> & { number: number }): Issue {
    const issue: Issue = { title: `Issue ${i.number}`, state: "open", labels: [], assignees: [], ...i };
    this.issues.set(issue.number, issue);
    return issue;
  }

  labels(n: number) {
    return this.mustGet(n).labels;
  }
  subIssueNumbers(parent: number) {
    return [...this.parents].filter(([, p]) => p === parent).map(([c]) => c);
  }
  blockerNumbers(n: number) {
    return this.blockers.get(n) ?? [];
  }
  comments(n: number) {
    return this.commentsByIssue.get(n) ?? [];
  }
  claim(n: number) {
    return this.claims.get(n) ?? null;
  }

  private mustGet(n: number) {
    const i = this.issues.get(n);
    if (!i) throw new Error(`fake: no issue #${n}`);
    return i;
  }

  async currentUser() {
    return this.user;
  }
  async repoUrl() {
    return "https://github.com/acme/app";
  }
  defaultBranchName = "main";
  async defaultBranch() {
    return this.defaultBranchName;
  }
  async getIssue(n: number) {
    return structuredClone(this.mustGet(n));
  }
  async addLabels(n: number, labels: string[]) {
    const i = this.mustGet(n);
    for (const l of labels) if (!i.labels.includes(l)) i.labels.push(l);
  }
  async removeLabels(n: number, labels: string[]) {
    const i = this.mustGet(n);
    i.labels = i.labels.filter((l) => !labels.includes(l));
  }
  async assign(n: number, users: string[]) {
    const i = this.mustGet(n);
    for (const u of users) if (!i.assignees.includes(u)) i.assignees.push(u);
  }
  async comment(n: number, body: string) {
    this.mustGet(n);
    this.commentsByIssue.set(n, [...this.comments(n), body]);
  }
  async listComments(n: number) {
    return [...this.comments(n)];
  }
  async closeIssue(n: number, reason: "completed" | "not_planned") {
    const i = this.mustGet(n);
    i.state = "closed";
    i.stateReason = reason;
  }
  async createIssue(input: { title: string; body: string; labels: string[]; assignees: string[] }) {
    const issue = this.seedIssue({ number: this.nextNumber++, ...structuredClone(input) });
    this.bodies.set(issue.number, input.body);
    return structuredClone(issue);
  }
  bodies = new Map<number, string>();
  async addSubIssue(parent: number, child: number) {
    this.mustGet(parent);
    this.mustGet(child);
    this.parents.set(child, parent);
  }
  async subIssues(parent: number) {
    return this.subIssueNumbers(parent).map((n) => structuredClone(this.mustGet(n)));
  }
  async parentOf(child: number) {
    return this.parents.get(child) ?? null;
  }
  async addBlockedBy(n: number, blocker: number) {
    this.mustGet(n);
    this.mustGet(blocker);
    this.blockers.set(n, [...this.blockerNumbers(n), blocker]);
  }
  async blockedBy(n: number) {
    return this.blockerNumbers(n).map((b) => structuredClone(this.mustGet(b)));
  }
  labelDefs = new Map<string, { color: string; description: string }>();
  async ensureLabels(labels: { name: string; color: string; description: string }[]) {
    for (const l of labels) this.labelDefs.set(l.name, { color: l.color, description: l.description });
  }
  async branchExists(name: string) {
    return this.branches.has(name);
  }
  async listBranches(prefix: string) {
    return [...this.branches].filter((b) => b.startsWith(prefix));
  }
  async deleteBranch(name: string) {
    this.branches.delete(name);
  }
  /** Commits pushed with pushFiles, oldest first. */
  pushed: { branch: string; sha: string; parent: string | null; files: FileToPush[]; message: string }[] = [];
  async pushFiles(branch: string, files: FileToPush[], message: string) {
    const parent = this.pushed.filter((p) => p.branch === branch).at(-1)?.sha ?? null;
    const sha = `evidence${this.pushed.length + 1}`.padEnd(40, "0");
    this.pushed.push({ branch, sha, parent, files, message });
    this.branches.add(branch);
    return sha;
  }
  async createBranch(name: string, from: string) {
    if (!this.branches.has(from)) throw new Error(`fake: no branch ${from}`);
    if (this.branches.has(name)) throw new Error(`fake: branch ${name} exists`);
    this.branches.add(name);
  }
  async findPullRequest(head: string) {
    return structuredClone(this.prs.filter((p) => p.head === head).at(-1) ?? null);
  }
  async createPullRequest(input: { head: string; base: string; title: string; body: string }) {
    const pr: PullRequest = { number: this.nextNumber++, head: input.head, base: input.base, state: "open", body: input.body };
    this.prs.push(pr);
    return structuredClone(pr);
  }
  /** The commit each claim ref points at. */
  claimShas = new Map<number, string>();
  private commits = 0;
  private point(n: number, record: ClaimRecord) {
    this.claims.set(n, { holder: record.holder, session: record.session, since: record.since });
    this.claimShas.set(n, `claim${++this.commits}`);
  }
  async createClaim(n: number, record: ClaimRecord) {
    if (this.claims.has(n)) return false;
    this.point(n, record);
    return true;
  }
  /** Runs before replaceClaim checks the ref, to stage a race: another session moving or deleting it. */
  beforeReplace: ((n: number) => void) | null = null;
  async replaceClaim(n: number, fromSha: string, record: ClaimRecord) {
    this.beforeReplace?.(n);
    if (!this.claims.has(n) || (this.claimShas.get(n) ?? "seeded") !== fromSha) return false;
    this.point(n, record);
    return true;
  }
  async readClaim(n: number) {
    const claim = this.claims.get(n);
    return claim ? { ...claim, sha: this.claimShas.get(n) ?? "seeded" } : null;
  }
  async listClaims() {
    return [...this.claims.keys()];
  }
  async deleteClaim(n: number) {
    this.claims.delete(n);
    this.claimShas.delete(n);
  }
}
