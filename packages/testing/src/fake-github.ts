import {
  type ClaimRecord,
  type ClaimSpace,
  type FileToPush,
  type GhAuth,
  type GitHub,
  type Issue,
  isNornComment,
  type LinkedPullRequest,
  type MergeAttempt,
  type ObservedIssue,
  type Permission,
  type PullRequest,
  type PullRequestReadiness,
  type TimelineItem,
  type Work,
  type WorkQuery,
} from "@norn/core";

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
  /** Every issue's timeline, oldest first, recorded as norn and tests change issues. */
  timelines = new Map<number, Recorded[]>();
  closedAt = new Map<number, string>();
  /** What the fake knows of a PR beyond PullRequest: when it opened and merged, and who did it. */
  prMeta = new Map<number, { createdAt: string; mergedAt: string | null; author: string; mergedBy: string | null }>();
  private commentIds = 0;

  private at() {
    return this.clock().toISOString();
  }
  /** Adds an item to an issue's timeline, e.g. activity norn does not recognise. */
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
  async openIssues(label: string) {
    return [...this.issues.values()].filter((i) => i.state === "open" && i.labels.includes(label)).map((i) => structuredClone(i));
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
  async repositoryLabels() {
    return [...this.labelDefs].map(([name, l]) => ({ name, ...l }));
  }
  /** Files on GitHub by ref, then path: what readFileAt reads. Tests seed them with seedFile. */
  files = new Map<string, Map<string, string>>();
  /** Puts a file on a branch, as if it were committed and pushed there; the branch is created if missing. */
  seedFile(path: string, content: string, ref = this.defaultBranchName) {
    if (!this.files.has(ref)) this.files.set(ref, new Map());
    this.files.get(ref)!.set(path, content);
    this.branches.add(ref);
  }
  /** A flow at .agents/flows/<name>.json on a branch: an object is written as JSON, a string as it is. */
  seedFlow(name: string, flow: unknown, ref = this.defaultBranchName) {
    this.seedFile(`.agents/flows/${name}.json`, typeof flow === "string" ? flow : JSON.stringify(flow, null, 2), ref);
  }
  async readFileAt(path: string, ref: string) {
    return this.files.get(ref)?.get(path) ?? null;
  }
  async listFilesAt(dir: string, ref: string) {
    const prefix = `${dir.replace(/\/+$/, "")}/`;
    return [...(this.files.get(ref)?.keys() ?? [])]
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .map((p) => p.slice(prefix.length))
      .sort();
  }
  /** gh's state; when logged in, only to the hosts in ghHosts. */
  ghAuthState: GhAuth = { kind: "logged-in" };
  ghHosts = ["github.com"];
  async ghAuth(host: string): Promise<GhAuth> {
    if (this.ghAuthState.kind !== "logged-in") return this.ghAuthState;
    return { kind: this.ghHosts.includes(host) ? "logged-in" : "logged-out" };
  }
  permissionLevel: Permission = "write";
  async permission() {
    return this.permissionLevel;
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
  /** What each PR's readiness reads as beyond its defaults: mergeable, up to date, no checks, head at headSha or head-<number>. */
  readiness = new Map<number, Partial<PullRequestReadiness>>();
  /** A refusal GitHub gives when norn merges the PR, e.g. for branch protection. */
  mergeRefusals = new Map<number, string>();
  /** Runs when norn reads a PR's readiness, to stage a race: a push landing after the read. */
  afterReadiness: ((number: number) => void) | null = null;
  /** The merges norn made: the PR and the head it merged at. */
  merges: { number: number; headSha: string }[] = [];
  private headOf(pr: PullRequest) {
    return this.readiness.get(pr.number)?.headSha ?? pr.headSha ?? `head-${pr.number}`;
  }
  async pullRequestReadiness(number: number): Promise<PullRequestReadiness> {
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`fake: no PR #${number}`);
    const readiness = {
      mergeable: "mergeable" as const,
      behind: false,
      checks: [],
      ...structuredClone(this.readiness.get(number) ?? {}),
      headSha: this.headOf(pr),
    };
    this.afterReadiness?.(number);
    return readiness;
  }
  async mergeAtHead(number: number, headSha: string): Promise<MergeAttempt> {
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`fake: no PR #${number}`);
    if (pr.state !== "open") return { merged: false, detail: "Pull request is not open" };
    if (this.headOf(pr) !== headSha) return { merged: false, detail: "Head branch was modified. Review and try the merge again." };
    const refusal = this.mergeRefusals.get(number);
    if (refusal) return { merged: false, detail: refusal };
    this.merges.push({ number, headSha });
    this.mergePullRequest(number);
    return { merged: true };
  }
  /** Moves a PR's head to a new commit, as a push does. */
  pushTo(number: number, headSha: string) {
    this.readiness.set(number, { ...(this.readiness.get(number) ?? {}), headSha });
  }

  /** The commit each claim ref points at. */
  claimShas = new Map<number, string>();
  /** Delivery locks, refs/norn/deliveries/<story>, and the commit each points at. */
  deliveries = new Map<number, ClaimRecord>();
  deliveryShas = new Map<number, string>();
  private commits = 0;
  private space(space: ClaimSpace) {
    return space === "claims" ? { records: this.claims, shas: this.claimShas } : { records: this.deliveries, shas: this.deliveryShas };
  }
  private point(n: number, record: ClaimRecord, space: ClaimSpace) {
    const { records, shas } = this.space(space);
    records.set(n, structuredClone(record));
    shas.set(n, `${space === "claims" ? "claim" : "delivery"}${++this.commits}`);
  }
  delivery(n: number) {
    return this.deliveries.get(n) ?? null;
  }
  async createClaim(n: number, record: ClaimRecord, space: ClaimSpace = "claims") {
    if (this.space(space).records.has(n)) return false;
    this.point(n, record, space);
    return true;
  }
  /** Runs before replaceClaim checks the ref, to stage a race: another session moving or deleting it. */
  beforeReplace: ((n: number) => void) | null = null;
  async replaceClaim(n: number, fromSha: string, record: ClaimRecord, space: ClaimSpace = "claims") {
    this.beforeReplace?.(n);
    const { records, shas } = this.space(space);
    if (!records.has(n) || (shas.get(n) ?? "seeded") !== fromSha) return false;
    this.point(n, record, space);
    return true;
  }
  async readClaim(n: number, space: ClaimSpace = "claims") {
    const { records, shas } = this.space(space);
    const claim = records.get(n);
    return claim ? { ...structuredClone(claim), sha: shas.get(n) ?? "seeded" } : null;
  }
  async listClaims(space: ClaimSpace = "claims") {
    return [...this.space(space).records.keys()];
  }
  async deleteClaim(n: number, space: ClaimSpace = "claims") {
    const { records, shas } = this.space(space);
    records.delete(n);
    shas.delete(n);
  }

  /** How often observeWork was called. */
  observed = 0;
  async observeWork(query: WorkQuery): Promise<Work> {
    this.observed++;
    const repoUrl = await this.repoUrl();
    const claims = [...this.claims].map(([issue, record]) => ({ issue, sha: this.claimShas.get(issue) ?? "seeded", record: { ...record } }));
    const typed = (n: number | undefined) => n !== undefined && (this.issues.get(n)?.labels.some((l) => l.startsWith("type:")) ?? false);
    const topLevel = (n: number) => typed(n) && !typed(this.parents.get(n));
    const storyOf = (n: number) => (topLevel(n) ? n : (this.parents.get(n) ?? null));
    const held = new Set(claims.filter((c) => c.record.holder === query.user).map((c) => storyOf(c.issue)));
    const stories = [...this.issues.values()].filter((i) => {
      if (!topLevel(i.number)) return false;
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
      nornComments: timeline.flatMap((t) => (t.kind === "comment" && isNornComment(t.body) ? [{ body: t.body, at: t.at, actor: t.actor, url: t.url }] : [])),
      pullRequests,
      timeline: timeline
        .filter((t) => since === null || t.at > since)
        .map((t) => (t.kind === "comment" ? { ...t, body: isNornComment(t.body) ? t.body : null } : { ...t })),
    };
  }
}
