export interface Issue {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
  stateReason?: "completed" | "not_planned";
}

export interface PullRequest {
  number: number;
  head: string;
  base: string;
  state: "open" | "closed" | "merged";
  body?: string;
  /** The commit the PR's head pointed at last, e.g. when it merged. */
  headSha?: string;
}

/** A file to push, by its path inside the commit. */
export interface FileToPush {
  path: string;
  content: Buffer;
}

/** What a claim ref's commit records. */
export interface ClaimRecord {
  holder: string;
  session: string;
  /** ISO timestamp */
  since: string;
}

/** A claim as read back: its record and the commit its ref points at. */
export interface HeldClaim extends ClaimRecord {
  sha: string;
}

/** Whether the user's gh is installed and logged in to a host. */
export type GhAuth = { kind: "missing" } | { kind: "logged-out" } | { kind: "logged-in" };

/** The user's role on the repository, as GitHub names them. */
export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

/**
 * Everything norn needs from GitHub. The real adapter shells out to the
 * user's own `gh`; tests use an in-memory fake.
 */
export interface GitHub {
  currentUser(): Promise<string>;
  /** e.g. https://github.com/acme/app */
  repoUrl(): Promise<string>;
  /** The repository's default branch, e.g. main. */
  defaultBranch(): Promise<string>;
  getIssue(number: number): Promise<Issue>;
  addLabels(number: number, labels: string[]): Promise<void>;
  removeLabels(number: number, labels: string[]): Promise<void>;
  assign(number: number, users: string[]): Promise<void>;
  comment(number: number, body: string): Promise<void>;
  /** Comment bodies, oldest first. */
  listComments(number: number): Promise<string[]>;
  closeIssue(number: number, reason: "completed" | "not_planned"): Promise<void>;
  createIssue(input: { title: string; body: string; labels: string[]; assignees: string[] }): Promise<Issue>;

  /** Native sub-issues. */
  addSubIssue(parent: number, child: number): Promise<void>;
  /** Native sub-issues in this repository, of any kind; see slicesOf for the story's slices. */
  subIssues(parent: number): Promise<Issue[]>;
  parentOf(child: number): Promise<number | null>;

  /** Native "blocked by" relations; returns blockers open or closed. */
  addBlockedBy(number: number, blocker: number): Promise<void>;
  blockedBy(number: number): Promise<Issue[]>;

  /** Create or update labels. */
  ensureLabels(labels: { name: string; color: string; description: string }[]): Promise<void>;
  /** The names of the labels on the repository. */
  labelNames(): Promise<string[]>;

  /** The text of a file at a ref (branch, tag or commit), e.g. .agents/flows/bug.json on main; null when it is not there. Read-only. */
  readFileAt(path: string, ref: string): Promise<string | null>;

  /** Whether gh is installed and logged in to `host`, e.g. github.com. Read-only, for norn doctor. */
  ghAuth(host: string): Promise<GhAuth>;
  /** The user's role on the repository. */
  permission(): Promise<Permission>;

  branchExists(name: string): Promise<boolean>;
  /** Branches on GitHub whose name starts with `prefix`. */
  listBranches(prefix: string): Promise<string[]>;
  /** Deletes a branch on GitHub; one that is already gone is no error. */
  deleteBranch(name: string): Promise<void>;
  /**
   * Commits exactly these files onto `branch`, creating it when missing; the
   * commit's parent is the branch's head, so earlier commits stay reachable.
   * Returns the new commit's sha.
   */
  pushFiles(branch: string, files: FileToPush[], message: string): Promise<string>;
  /** Create branch `name` at the head of `from`. */
  createBranch(name: string, from: string): Promise<void>;
  /** The most recent PR from `head`, if any. */
  findPullRequest(head: string): Promise<PullRequest | null>;
  createPullRequest(input: { head: string; base: string; title: string; body: string }): Promise<PullRequest>;

  /** Atomically create refs/norn/claims/<issue>. False when it already exists. */
  createClaim(number: number, record: ClaimRecord): Promise<boolean>;
  /**
   * Points the claim ref at a new record, but only while it still points at
   * `fromSha`: the new claim commit is a child of that one and the ref moves
   * without force. Used both to refresh your own claim and to take over a
   * stale one, so neither can overwrite a claim that changed in between.
   * False when the ref has moved or is gone.
   */
  replaceClaim(number: number, fromSha: string, record: ClaimRecord): Promise<boolean>;
  readClaim(number: number): Promise<HeldClaim | null>;
  /** Issue numbers that have a claim ref. */
  listClaims(): Promise<number[]>;
  deleteClaim(number: number): Promise<void>;

  /**
   * The developer's norn work in one read, for the dashboard: their stories with
   * slices, labels, blockers, linked PRs, norn's comments and the timeline since
   * `since`, and the claims. Read-only and cheap: one query, plus the claim refs.
   */
  observeWork(query: WorkQuery): Promise<Work>;
}

/** What observeWork asks for: one developer's norn work in this repository. */
export interface WorkQuery {
  /** The developer's GitHub login. */
  user: string;
  /** Closed stories count when they closed at or after this ISO time. */
  closedSince: string;
  /** Timeline items after this ISO time; null for the whole history. */
  since: string | null;
}

/** An item on an issue's timeline, as GitHub records it. `actor` is a login, null for a deleted account. */
export type TimelineItem =
  | { kind: "labeled" | "unlabeled"; label: string; at: string; actor: string | null }
  /** `body` only for norn's own comments (see isNornComment); null for anyone else's. */
  | { kind: "comment"; at: string; actor: string | null; url: string; body: string | null }
  | { kind: "closed" | "reopened"; at: string; actor: string | null }
  | { kind: "sub-issue-added"; child: number; at: string; actor: string | null }
  /** Anything else; `detail` names it as GitHub does, e.g. RenamedTitleEvent. */
  | { kind: "other"; at: string; actor: string | null; url: string | null; detail: string };

/** A comment norn wrote, with its body. Oldest first on ObservedIssue. */
export interface NornComment {
  body: string;
  at: string;
  actor: string | null;
  url: string;
}

/** A pull request that mentions an issue, as it is now. */
export interface LinkedPullRequest {
  number: number;
  url: string;
  head: string;
  base: string;
  state: "open" | "closed" | "merged";
  createdAt: string;
  mergedAt: string | null;
  author: string | null;
  mergedBy: string | null;
}

/** An issue with everything the dashboard reads from it. */
export interface ObservedIssue extends Issue {
  url: string;
  closedAt: string | null;
  /** Every blocker, open or closed. */
  blockedBy: { number: number; state: "open" | "closed" }[];
  /** norn's comments over the whole history: transitions, markers and notes. */
  nornComments: NornComment[];
  pullRequests: LinkedPullRequest[];
  /** Timeline items after the query's `since`, oldest first. */
  timeline: TimelineItem[];
}

export interface ObservedStory extends ObservedIssue {
  /** Its sub-issues in this repository, of any kind. */
  subIssues: ObservedIssue[];
}

/** A claim ref as read back; `record` is null when its commit could not be read as a claim. */
export interface ClaimRef {
  issue: number;
  sha: string;
  record: ClaimRecord | null;
}

/** One read of a developer's work: their stories and every claim in the repository. */
export interface Work {
  repoUrl: string;
  /**
   * Stories assigned to the user, open or closed since `closedSince`, plus the
   * story of any item a claim of the user's points at.
   */
  stories: ObservedStory[];
  claims: ClaimRef[];
}
