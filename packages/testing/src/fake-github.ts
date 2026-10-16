import {
  type ClaimRecord,
  type FileToPush,
  type GitHub,
  type Issue,
  isShepherdComment,
  type LinkedPullRequest,
  type ObservedIssue,
  type PullRequest,
  type TimelineItem,
  type Work,
  type WorkQuery,
} from "@shepherd/core";

/** A timeline item as the fake records it: comments keep their body whoever wrote them. */
type Recorded = TimelineItem extends infer T ? (T extends { kind: "comment" } ? Omit<T, "body"> & { body: string } : T) : never;

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

  /** The time GitHub stamps on what happens; the harness points it at its own clock. */
  clock: () => Date = () => new Date("2026-10-13T12:00:00Z");
  /** Every issue's timeline, oldest first, recorded as shepherd and tests change issues. */
  timelines = new Map<number, Recorded[]>();
  closedAt = new Map<number, string>();
  /** What the fake knows of a PR beyond PullRequest: when it opened and merged, and who did it. */
  prMeta = new Map<number, { createdAt: string; mergedAt: string | null; author: string; mergedBy: string | null }>();
  private commentIds = 0;

  private at() {
    return this.clock().toISOString();
  }
  /** Adds an item to an issue's timeline, e.g. activity shepherd does not recognise. */
  record(n: number, item: Recorded) {
    this.timelines.set(n, [...(this.timelines.get(n) ?? []), item]);
  }
  /** Merges a PR as `by`, now. */
  mergePullRequest(number: number, by = this.user) {
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`fake: no PR #${number}`);
    pr.state = "merged";
    const meta = this.prMeta.get(number);
    this.prMeta.set(number, { createdAt: meta?.createdAt ?? this.at(), author: meta?.author ?? by, mergedAt: this.at(), mergedBy: by });
  }

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
    for (const l of labels) {
      if (i.labels.includes(l)) continue;
      i.labels.push(l);
      this.record(n, { kind: "labeled", label: l, at: this.at(), actor: this.user });
    }
  }
  async removeLabels(n: number, labels: string[]) {
    const i = this.mustGet(n);
    // GitHub records only labels that were there.
    for (const l of i.labels.filter((l) => labels.includes(l))) this.record(n, { kind: "unlabeled", label: l, at: this.at(), actor: this.user });
    i.labels = i.labels.filter((l) => !labels.includes(l));
  }
  async assign(n: number, users: string[]) {
    const i = this.mustGet(n);
    for (const u of users) if (!i.assignees.includes(u)) i.assignees.push(u);
  }
  async comment(n: number, body: string) {
    this.mustGet(n);
    this.commentsByIssue.set(n, [...this.comments(n), body]);
    const url = `${await this.repoUrl()}/issues/${n}#issuecomment-${++this.commentIds}`;
    this.record(n, { kind: "comment", at: this.at(), actor: this.user, url, body });
  }
  async listComments(n: number) {
    return [...this.comments(n)];
  }
  async closeIssue(n: number, reason: "completed" | "not_planned") {
    const i = this.mustGet(n);
    i.state = "closed";
    i.stateReason = reason;
    this.closedAt.set(n, this.at());
    this.record(n, { kind: "closed", at: this.at(), actor: this.user });
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
    this.record(parent, { kind: "sub-issue-added", child, at: this.at(), actor: this.user });
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
    this.prMeta.set(pr.number, { createdAt: this.at(), mergedAt: null, author: this.user, mergedBy: null });
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

  /** How often observeWork was called. */
  observed = 0;
  async observeWork(query: WorkQuery): Promise<Work> {
    this.observed++;
    const repoUrl = await this.repoUrl();
    const claims = [...this.claims].map(([issue, record]) => ({ issue, sha: this.claimShas.get(issue) ?? "seeded", record: { ...record } }));
    const storyOf = (n: number) => (this.mustGet(n).labels.includes("type:slice") ? (this.parents.get(n) ?? null) : n);
    const held = new Set(claims.filter((c) => c.record.holder === query.user).map((c) => storyOf(c.issue)));
    const stories = [...this.issues.values()].filter((i) => {
      if (!i.labels.includes("type:story")) return false;
      if (held.has(i.number)) return true;
      if (!i.assignees.includes(query.user)) return false;
      return i.state === "open" || (this.closedAt.get(i.number) ?? "") >= query.closedSince;
    });
    return {
      repoUrl,
      claims,
      stories: stories.map((s) => ({
        ...this.observed1(s.number, query.since, repoUrl),
        subIssues: this.subIssueNumbers(s.number).map((c) => this.observed1(c, query.since, repoUrl)),
      })),
    };
  }

  private observed1(n: number, since: string | null, repoUrl: string): ObservedIssue {
    const timeline = this.timelines.get(n) ?? [];
    const mentions = new RegExp(`#${n}\\b`);
    const pullRequests: LinkedPullRequest[] = this.prs
      .filter((p) => mentions.test(p.body ?? ""))
      .map((p) => {
        const meta = this.prMeta.get(p.number);
        return {
          number: p.number,
          url: `${repoUrl}/pull/${p.number}`,
          head: p.head,
          base: p.base,
          state: p.state,
          createdAt: meta?.createdAt ?? this.at(),
          mergedAt: meta?.mergedAt ?? null,
          author: meta?.author ?? null,
          mergedBy: meta?.mergedBy ?? null,
        };
      });
    return {
      ...structuredClone(this.mustGet(n)),
      url: `${repoUrl}/issues/${n}`,
      closedAt: this.closedAt.get(n) ?? null,
      blockedBy: this.blockerNumbers(n).map((b) => ({ number: b, state: this.mustGet(b).state })),
      shepherdComments: timeline.flatMap((t) =>
        t.kind === "comment" && isShepherdComment(t.body) ? [{ body: t.body, at: t.at, actor: t.actor, url: t.url }] : [],
      ),
      pullRequests,
      timeline: timeline
        .filter((t) => since === null || t.at > since)
        .map((t) => (t.kind === "comment" ? { ...t, body: isShepherdComment(t.body) ? t.body : null } : { ...t })),
    };
  }
}
