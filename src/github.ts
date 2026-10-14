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

/**
 * Everything psdd needs from GitHub. The real adapter shells out to the
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

  branchExists(name: string): Promise<boolean>;
  /** Create branch `name` at the head of `from`. */
  createBranch(name: string, from: string): Promise<void>;
  /** The most recent PR from `head`, if any. */
  findPullRequest(head: string): Promise<PullRequest | null>;
  createPullRequest(input: { head: string; base: string; title: string; body: string }): Promise<PullRequest>;

  /** Atomically create refs/psdd/claims/<issue>. False when it already exists. */
  createClaim(number: number, record: ClaimRecord): Promise<boolean>;
  /** Points the existing claim ref at a new record, e.g. a later `since`. */
  refreshClaim(number: number, record: ClaimRecord): Promise<void>;
  /**
   * Replaces a stale claim, but only while its ref still points at `staleSha`:
   * the new claim commit is a child of the stale one and the ref moves without
   * force, so of two sessions taking over at once only one wins. False when
   * the ref has moved or is gone.
   */
  takeOverClaim(number: number, staleSha: string, record: ClaimRecord): Promise<boolean>;
  readClaim(number: number): Promise<HeldClaim | null>;
  deleteClaim(number: number): Promise<void>;
}
