import { spawn } from "node:child_process";
import type { ClaimRecord, GitHub, Issue, PullRequest } from "./github.js";

export type Exec = (args: string[], input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Runs the user's own `gh`. */
export const execGh: Exec = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });

export class GhError extends Error {
  constructor(
    public args: string[],
    public stderr: string,
  ) {
    super(`gh ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  get status(): number | null {
    const m = /HTTP (\d{3})/.exec(this.stderr);
    return m ? Number(m[1]) : null;
  }
}

const REPO = "repos/{owner}/{repo}";

interface RestIssue {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason?: string | null;
  labels: { name: string }[];
  assignees: { login: string }[];
}

function toIssue(r: RestIssue): Issue {
  const issue: Issue = {
    number: r.number,
    title: r.title,
    state: r.state,
    labels: r.labels.map((l) => l.name),
    assignees: r.assignees.map((a) => a.login),
  };
  if (r.state_reason === "completed" || r.state_reason === "not_planned") issue.stateReason = r.state_reason;
  return issue;
}

/** GitHub adapter over `gh`, acting as the logged-in user in the current repo. */
export class GhGitHub implements GitHub {
  constructor(private exec: Exec = execGh) {}

  private async gh(args: string[], input?: string): Promise<string> {
    const r = await this.exec(args, input);
    if (r.code !== 0) throw new GhError(args, r.stderr);
    return r.stdout;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const args = ["api", "-X", method, path];
    if (body !== undefined) args.push("--input", "-");
    const out = await this.gh(args, body === undefined ? undefined : JSON.stringify(body));
    return (out.trim() ? JSON.parse(out) : null) as T;
  }

  /** Like api, but a 404 gives null. */
  private async find<T>(path: string): Promise<T | null> {
    try {
      return await this.api<T>("GET", path);
    } catch (e) {
      if (e instanceof GhError && e.status === 404) return null;
      throw e;
    }
  }

  private async rawIssue(n: number) {
    return this.api<RestIssue>("GET", `${REPO}/issues/${n}`);
  }

  async currentUser() {
    return (await this.api<{ login: string }>("GET", "user")).login;
  }
  async repoUrl() {
    return (await this.api<{ html_url: string }>("GET", REPO)).html_url;
  }
  async defaultBranch() {
    return (await this.api<{ default_branch: string }>("GET", REPO)).default_branch;
  }
  async getIssue(n: number) {
    return toIssue(await this.rawIssue(n));
  }
  async addLabels(n: number, labels: string[]) {
    await this.api("POST", `${REPO}/issues/${n}/labels`, { labels });
  }
  async removeLabels(n: number, labels: string[]) {
    for (const l of labels) {
      try {
        await this.api("DELETE", `${REPO}/issues/${n}/labels/${encodeURIComponent(l)}`);
      } catch (e) {
        if (!(e instanceof GhError && e.status === 404)) throw e;
      }
    }
  }
  async assign(n: number, users: string[]) {
    await this.api("POST", `${REPO}/issues/${n}/assignees`, { assignees: users });
  }
  async comment(n: number, body: string) {
    await this.api("POST", `${REPO}/issues/${n}/comments`, { body });
  }
  async listComments(n: number) {
    return (await this.paginate<{ body: string }>(`${REPO}/issues/${n}/comments`)).map((c) => c.body);
  }
  async closeIssue(n: number, reason: "completed" | "not_planned") {
    await this.api("PATCH", `${REPO}/issues/${n}`, { state: "closed", state_reason: reason });
  }
  async createIssue(input: { title: string; body: string; labels: string[]; assignees: string[] }) {
    return toIssue(await this.api<RestIssue>("POST", `${REPO}/issues`, input));
  }
  async addSubIssue(parent: number, child: number) {
    const { id } = await this.rawIssue(child);
    await this.api("POST", `${REPO}/issues/${parent}/sub_issues`, { sub_issue_id: id });
  }
  async subIssues(parent: number) {
    return (await this.paginate<RestIssue>(`${REPO}/issues/${parent}/sub_issues`)).map(toIssue);
  }
  async parentOf(child: number) {
    const p = await this.find<RestIssue>(`${REPO}/issues/${child}/parent`);
    return p ? p.number : null;
  }
  async addBlockedBy(n: number, blocker: number) {
    const { id } = await this.rawIssue(blocker);
    await this.api("POST", `${REPO}/issues/${n}/dependencies/blocked_by`, { issue_id: id });
  }
  async blockedBy(n: number) {
    return (await this.paginate<RestIssue>(`${REPO}/issues/${n}/dependencies/blocked_by`)).map(toIssue);
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const out = await this.gh(["api", "--paginate", "--slurp", path]);
    return (JSON.parse(out) as T[][]).flat();
  }

  async ensureLabels(labels: { name: string; color: string; description: string }[]) {
    for (const l of labels) {
      await this.gh(["label", "create", l.name, "--color", l.color, "--description", l.description, "--force"]);
    }
  }

  async branchExists(name: string) {
    return (await this.find(`${REPO}/git/ref/heads/${name}`)) !== null;
  }
  async createBranch(name: string, from: string) {
    const head = await this.api<{ object: { sha: string } }>("GET", `${REPO}/git/ref/heads/${from}`);
    await this.api("POST", `${REPO}/git/refs`, { ref: `refs/heads/${name}`, sha: head.object.sha });
  }
  async findPullRequest(head: string): Promise<PullRequest | null> {
    const out = await this.gh([
      "pr", "list", "--head", head, "--state", "all", "--limit", "1",
      "--json", "number,headRefName,baseRefName,state,body",
    ]);
    const [pr] = JSON.parse(out) as { number: number; headRefName: string; baseRefName: string; state: string; body: string }[];
    if (!pr) return null;
    return {
      number: pr.number,
      head: pr.headRefName,
      base: pr.baseRefName,
      state: pr.state.toLowerCase() as PullRequest["state"],
      body: pr.body,
    };
  }
  async createPullRequest(input: { head: string; base: string; title: string; body: string }) {
    const pr = await this.api<{ number: number }>("POST", `${REPO}/pulls`, input);
    return { number: pr.number, head: input.head, base: input.base, state: "open" as const, body: input.body };
  }

  /** A parentless commit whose message and claim.json are the record. */
  private async claimCommit(record: ClaimRecord) {
    const content = JSON.stringify(record);
    const tree = await this.api<{ sha: string }>("POST", `${REPO}/git/trees`, {
      tree: [{ path: "claim.json", mode: "100644", type: "blob", content }],
    });
    const commit = await this.api<{ sha: string }>("POST", `${REPO}/git/commits`, {
      message: content,
      tree: tree.sha,
      parents: [],
    });
    return commit.sha;
  }
  async createClaim(n: number, record: ClaimRecord) {
    const sha = await this.claimCommit(record);
    try {
      await this.api("POST", `${REPO}/git/refs`, { ref: `refs/psdd/claims/${n}`, sha });
      return true;
    } catch (e) {
      if (e instanceof GhError && e.status === 422) return false;
      throw e;
    }
  }
  async refreshClaim(n: number, record: ClaimRecord) {
    const sha = await this.claimCommit(record);
    await this.api("PATCH", `${REPO}/git/refs/psdd/claims/${n}`, { sha, force: true });
  }
  async readClaim(n: number) {
    const ref = await this.find<{ object: { sha: string } }>(`${REPO}/git/ref/psdd/claims/${n}`);
    if (!ref) return null;
    const commit = await this.api<{ message: string }>("GET", `${REPO}/git/commits/${ref.object.sha}`);
    return JSON.parse(commit.message) as ClaimRecord;
  }
  async deleteClaim(n: number) {
    try {
      await this.api("DELETE", `${REPO}/git/refs/psdd/claims/${n}`);
    } catch (e) {
      if (!(e instanceof GhError && (e.status === 404 || e.status === 422))) throw e;
    }
  }
}
