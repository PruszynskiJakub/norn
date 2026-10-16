import { spawn } from "node:child_process";
import type { ClaimRecord, FileToPush, GhAuth, GitHub, Issue, Permission, PullRequest, WorkQuery } from "@norn/core";
import { observeWork } from "./observe-work.js";

export type Exec = (args: string[], input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const spawnExec =
  (program: string): Exec =>
  (args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.end(input ?? "");
    });

/** Runs git in the current checkout. */
export const execGit: Exec = spawnExec("git");

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

/** Why a read of GitHub failed, as far as gh's and git's errors tell. */
export type GhFailure = "auth" | "rate-limit" | "network" | "other";

/** Sorts a failed read for what the user can do about it. Anything unrecognised is other. */
export function ghFailure(e: unknown): GhFailure {
  const text = e instanceof GhError ? e.stderr : e instanceof Error ? e.message : String(e);
  const status = e instanceof GhError ? e.status : null;
  if (status === 401 || /gh auth login|authentication|Bad credentials/i.test(text)) return "auth";
  if (/rate limit/i.test(text) || status === 429) return "rate-limit";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|could not resolve|connection|network/i.test(text)) return "network";
  return "other";
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
  /** API URL of the issue's repository, e.g. https://api.github.com/repos/acme/app. */
  repository_url?: string;
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
  constructor(
    private exec: Exec = execGh,
    private git: Exec = execGit,
  ) {}

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
    // Sub-issues may live in other repositories; their numbers mean nothing here.
    const all = await this.paginate<RestIssue>(`${REPO}/issues/${parent}/sub_issues`);
    if (all.length === 0) return [];
    const { url } = await this.api<{ url: string }>("GET", REPO);
    return all.filter((r) => !r.repository_url || r.repository_url === url).map(toIssue);
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

  /**
   * Every element of a paged list. `--jq '.[]'` prints one compact JSON value
   * per line across all pages; unlike `--slurp` (gh 2.48+), it works on the
   * older gh that distributions ship.
   */
  private async paginate<T>(path: string): Promise<T[]> {
    const out = await this.gh(["api", "--paginate", "--jq", ".[]", path]);
    return out
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as T);
  }

  async ensureLabels(labels: { name: string; color: string; description: string }[]) {
    for (const l of labels) {
      await this.gh(["label", "create", l.name, "--color", l.color, "--description", l.description, "--force"]);
    }
  }

  async labelNames() {
    return (await this.paginate<{ name: string }>(`${REPO}/labels`)).map((l) => l.name);
  }

  async ghAuth(host: string): Promise<GhAuth> {
    let r: Awaited<ReturnType<Exec>>;
    try {
      r = await this.exec(["auth", "status", "--hostname", host]);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      throw e;
    }
    return { kind: r.code === 0 ? "logged-in" : "logged-out" };
  }
  async permission(): Promise<Permission> {
    const out = (await this.gh(["repo", "view", "--json", "viewerPermission", "--jq", ".viewerPermission"])).trim().toLowerCase();
    // GitHub answers null for a repository the user cannot see at all.
    return (["admin", "maintain", "write", "triage", "read"] as const).find((p) => p === out) ?? "none";
  }

  async branchExists(name: string) {
    return (await this.find(`${REPO}/git/ref/heads/${name}`)) !== null;
  }
  async listBranches(prefix: string) {
    // matching-refs matches by prefix; a trailing slash is left off and checked here.
    const refs = await this.paginate<{ ref: string }>(`${REPO}/git/matching-refs/${`heads/${prefix}`.replace(/\/+$/, "")}`);
    return refs.map((r) => r.ref.slice("refs/heads/".length)).filter((b) => b.startsWith(prefix));
  }
  async deleteBranch(name: string) {
    try {
      await this.api("DELETE", `${REPO}/git/refs/heads/${name}`);
    } catch (e) {
      if (!(e instanceof GhError && (e.status === 404 || e.status === 422))) throw e;
    }
  }
  async pushFiles(branch: string, files: FileToPush[], message: string) {
    const tree: { path: string; mode: string; type: string; sha: string }[] = [];
    for (const f of files) {
      const blob = await this.api<{ sha: string }>("POST", `${REPO}/git/blobs`, { content: f.content.toString("base64"), encoding: "base64" });
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const t = await this.api<{ sha: string }>("POST", `${REPO}/git/trees`, { tree });
    const head = await this.find<{ object: { sha: string } }>(`${REPO}/git/ref/heads/${branch}`);
    const commit = await this.api<{ sha: string }>("POST", `${REPO}/git/commits`, {
      message,
      tree: t.sha,
      parents: head ? [head.object.sha] : [],
    });
    if (head) await this.api("PATCH", `${REPO}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
    else await this.api("POST", `${REPO}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    return commit.sha;
  }
  async createBranch(name: string, from: string) {
    const head = await this.api<{ object: { sha: string } }>("GET", `${REPO}/git/ref/heads/${from}`);
    await this.api("POST", `${REPO}/git/refs`, { ref: `refs/heads/${name}`, sha: head.object.sha });
  }
  async findPullRequest(head: string): Promise<PullRequest | null> {
    const out = await this.gh([
      "pr",
      "list",
      "--head",
      head,
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "number,headRefName,baseRefName,state,body,headRefOid",
    ]);
    const [pr] = JSON.parse(out) as { number: number; headRefName: string; baseRefName: string; state: string; body: string; headRefOid?: string }[];
    if (!pr) return null;
    return {
      number: pr.number,
      head: pr.headRefName,
      base: pr.baseRefName,
      state: pr.state.toLowerCase() as PullRequest["state"],
      body: pr.body,
      ...(pr.headRefOid ? { headSha: pr.headRefOid } : {}),
    };
  }
  async createPullRequest(input: { head: string; base: string; title: string; body: string }) {
    const pr = await this.api<{ number: number }>("POST", `${REPO}/pulls`, input);
    return { number: pr.number, head: input.head, base: input.base, state: "open" as const, body: input.body };
  }

  /** A commit whose message and claim.json are the record; parentless for a new claim. */
  private async claimCommit(record: ClaimRecord, parents: string[] = []) {
    const content = JSON.stringify(record);
    const tree = await this.api<{ sha: string }>("POST", `${REPO}/git/trees`, {
      tree: [{ path: "claim.json", mode: "100644", type: "blob", content }],
    });
    const commit = await this.api<{ sha: string }>("POST", `${REPO}/git/commits`, {
      message: content,
      tree: tree.sha,
      parents,
    });
    return commit.sha;
  }
  async replaceClaim(n: number, fromSha: string, record: ClaimRecord) {
    const sha = await this.claimCommit(record, [fromSha]);
    try {
      // Not forced: GitHub only moves the ref if the new commit descends from where it points now.
      await this.api("PATCH", `${REPO}/git/refs/norn/claims/${n}`, { sha, force: false });
      return true;
    } catch (e) {
      if (e instanceof GhError && e.status === 422) return false;
      throw e;
    }
  }
  async createClaim(n: number, record: ClaimRecord) {
    const sha = await this.claimCommit(record);
    try {
      await this.api("POST", `${REPO}/git/refs`, { ref: `refs/norn/claims/${n}`, sha });
      return true;
    } catch (e) {
      if (e instanceof GhError && e.status === 422) return false;
      throw e;
    }
  }
  async readClaim(n: number) {
    const ref = await this.find<{ object: { sha: string } }>(`${REPO}/git/ref/norn/claims/${n}`);
    if (!ref) return null;
    const commit = await this.api<{ message: string }>("GET", `${REPO}/git/commits/${ref.object.sha}`);
    return { ...(JSON.parse(commit.message) as ClaimRecord), sha: ref.object.sha };
  }
  async listClaims() {
    const refs = await this.paginate<{ ref: string }>(`${REPO}/git/matching-refs/norn/claims`);
    return refs
      .map((r) => /^refs\/norn\/claims\/(\d+)$/.exec(r.ref))
      .filter((m) => m !== null)
      .map((m) => Number(m[1]));
  }
  async deleteClaim(n: number) {
    try {
      await this.api("DELETE", `${REPO}/git/refs/norn/claims/${n}`);
    } catch (e) {
      if (!(e instanceof GhError && (e.status === 404 || e.status === 422))) throw e;
    }
  }

  async observeWork(query: WorkQuery) {
    const graphql = async (text: string, vars: Record<string, string | number | null>) => {
      // gh fills {owner} and {repo} from the current repository.
      const args = ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${text}`];
      for (const [k, v] of Object.entries(vars)) if (v !== null) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
      return JSON.parse(await this.gh(args));
    };
    const lsRemote = async () => {
      // Free against the API limit, unlike listing the refs through it.
      const args = ["ls-remote", "origin", "refs/norn/claims/*"];
      const r = await this.git(args);
      if (r.code !== 0) throw new GhError(["(git)", ...args], r.stderr);
      return r.stdout;
    };
    return observeWork(graphql, lsRemote, query);
  }
}
