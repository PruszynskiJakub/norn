import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { type AgentActivity, isWithin, type PaneActivity, type PaneAgent, type Provider, samePath, type Workspace } from "@norn/core";

/** Runs a command; `env` is added to this process's environment. */
export type Run = (cmd: string, args: string[], env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runCommand: Run = (cmd, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** An agent as herdr agent list prints it. */
interface HerdrAgent {
  pane_id: string;
  name?: string;
  agent_status?: string;
  cwd?: string;
  foreground_cwd?: string;
  state_change_seq?: number;
}

const HERDR_STATUS: Record<string, AgentActivity> = { working: "working", idle: "idle", done: "done", blocked: "blocked" };

/** norn cannot tell which checkout to work in. A refusal for the user, not a crash. */
export class RootError extends Error {}

/** The developer's machine, via git and herdr. */
export class LocalWorkspace implements Workspace {
  constructor(
    public root: string,
    public env: Record<string, string | undefined>,
    private run: Run = runCommand,
    public cwd: string = root,
    private clock: () => number = Date.now,
  ) {}

  /**
   * When this process first saw each pane's agent in the state it is in now. herdr says what an agent does but not
   * since when, so a long-running norn wait measures it itself.
   */
  private seen = new Map<string, { key: string; at: number }>();

  /** The agents herdr runs on this machine; null when norn does not run under herdr or herdr does not answer. */
  private async herdrAgents(): Promise<HerdrAgent[] | null> {
    if (this.env.HERDR_ENV !== "1") return null;
    let r: Awaited<ReturnType<Run>>;
    try {
      r = await this.run("herdr", ["agent", "list"]);
    } catch {
      return null;
    }
    if (r.code !== 0) return null;
    try {
      return (JSON.parse(r.stdout) as { result: { agents: HerdrAgent[] } }).result.agents;
    } catch {
      return null;
    }
  }

  async agentsIn(dir: string): Promise<PaneAgent[]> {
    const agents = (await this.herdrAgents()) ?? [];
    // The foreground directory is where the agent works now; cwd is where its pane started.
    return agents
      .filter((a) => [a.foreground_cwd, a.cwd].some((d) => d !== undefined && isWithin(d, dir)))
      .map((a) => ({ pane: a.pane_id, name: a.name ?? null, activity: HERDR_STATUS[a.agent_status ?? ""] ?? "unknown" }));
  }

  async agentActivity(pane: string): Promise<PaneActivity> {
    const agents = await this.herdrAgents();
    if (!agents) return { activity: "unknown", forMs: 0 };
    const agent = agents.find((a) => a.pane_id === pane);
    const activity = agent ? (HERDR_STATUS[agent.agent_status ?? ""] ?? "unknown") : "gone";
    // herdr counts every change of an agent's state, so a new count is a new state even when it reads the same.
    const key = `${activity}:${agent?.state_change_seq ?? ""}`;
    const now = this.clock();
    const was = this.seen.get(pane);
    if (was?.key !== key) this.seen.set(pane, { key, at: now });
    return { activity, forMs: was?.key === key ? now - was.at : 0 };
  }

  /**
   * The main checkout's root, also from inside a linked worktree. The parent of
   * the git directory is only right for an ordinary .git: a submodule's lives in
   * the superproject's .git/modules and records its checkout as core.worktree.
   * git worktree list names the git directory itself in those layouts, so it
   * cannot be used either.
   */
  static async findRoot(cwd: string, run: Run = runCommand): Promise<string> {
    const r = await run("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"]);
    if (r.code !== 0) throw new RootError(`Not inside a git repository's checkout: ${cwd}`);
    const [gitDir, commonDir, toplevel] = r.stdout.trim().split("\n");
    if (gitDir === commonDir) return toplevel;
    const configured = await run("git", ["--git-dir", commonDir, "config", "--get", "core.worktree"]);
    if (configured.code === 0 && configured.stdout.trim()) return resolve(commonDir, configured.stdout.trim());
    if (basename(commonDir) === ".git") return dirname(commonDir);
    throw new RootError(`Cannot find the main checkout of ${commonDir} from this worktree. Run norn from the main checkout.`);
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

  async worktreeDirty(rel: string) {
    return (await this.must("git", ["-C", join(this.root, rel), "status", "--porcelain"])).trim() !== "";
  }

  async localBranchExists(branch: string) {
    return (await this.run("git", ["-C", this.root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  }

  async listWorktrees() {
    const out = await this.must("git", ["-C", this.root, "worktree", "list", "--porcelain"]);
    return out
      .split("\n\n")
      .map((entry) => entry.split("\n"))
      .filter((lines) => lines[0]?.startsWith("worktree "))
      .map((lines) => ({
        path: lines[0].slice("worktree ".length),
        branch: lines.find((l) => l.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length) ?? null,
      }));
  }

  async listLocalBranches() {
    const out = await this.must("git", ["-C", this.root, "for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
    return out.split("\n").filter(Boolean);
  }

  async branchHead(branch: string) {
    const r = await this.run("git", ["-C", this.root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async hasUnpushedCommits(branch: string) {
    const out = await this.must("git", ["-C", this.root, "rev-list", "--count", `refs/heads/${branch}`, "--not", "--remotes"]);
    return Number(out.trim()) > 0;
  }

  async deleteLocalBranch(branch: string) {
    await this.must("git", ["-C", this.root, "branch", "-D", branch]);
  }

  async originUrl() {
    const r = await this.run("git", ["-C", this.root, "remote", "get-url", "origin"]);
    return r.code === 0 ? r.stdout.trim() || null : null;
  }
  async fetchRemote() {
    await this.must("git", ["-C", this.root, "fetch", "--prune", "origin"]);
  }

  async readEvidence(dir: string) {
    const abs = resolve(this.cwd, dir);
    try {
      if (!(await stat(abs)).isDirectory()) return null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const files: { path: string; content: Buffer }[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) files.push({ path: relative(abs, full).split(sep).join("/"), content: await readFile(full) });
      }
    };
    await walk(abs);
    return files.sort((a, b) => a.path.localeCompare(b.path));
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
