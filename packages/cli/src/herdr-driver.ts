import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { RunAgent } from "@norn/core";
import type { AgentAttempt, AgentDriver, AgentEnd, AgentLook } from "./agent-driver.js";
import { dig, type Herdr } from "./herdr.js";

/**
 * The herdr driver: each agent runs interactively in a tab of its own in the
 * worktree's herdr workspace, so a person can watch it and step in. herdr
 * guesses what the agent is doing (idle, working, blocked, done, unknown)
 * from its screen, so norn takes that only as a sign of life: whether the
 * step finished always comes from GitHub.
 */

interface Options {
  herdr: Herdr;
  /** The main checkout, whose workspace group the worktree's workspace joins. */
  root: string;
  issue: number;
  agent: RunAgent;
  /** After a prompt, how long an agent that never showed work may sit idle before its turn counts as ended. */
  graceMs?: number;
  /** Between the Ctrl-C presses that quit an agent. */
  pauseMs?: number;
}

/** A state must be seen this many polls in a row before it ends a turn, so one misread never does. */
const CONFIRM = 2;

/** Quits the agent in a pane and closes the pane: Ctrl-C twice, the first interrupting its turn, the second quitting it. */
export async function closePane(herdr: Herdr, pane: string, pauseMs = 1000) {
  await herdr(["agent", "send-keys", pane, "ctrl+c"]);
  await sleep(pauseMs);
  await herdr(["agent", "send-keys", pane, "ctrl+c"]);
  await herdr(["pane", "close", pane]);
}

/**
 * Makes the agent's tab the one its workspace shows, where herdr would leave
 * the shell tab it opened the worktree with. Focusing a tab focuses its
 * workspace too, so the workspace the person was in gets its focus back,
 * unless it is this one.
 */
async function showTab(herdr: Herdr, workspace: string, tab: unknown) {
  if (typeof tab !== "string") return;
  const listed = await herdr(["workspace", "list"]);
  const focused = listed.ok ? ((dig(listed.result, "workspaces") ?? []) as unknown[]).find((w) => dig(w, "focused") === true) : undefined;
  const back = dig(focused, "active_tab_id");
  await herdr(["tab", "focus", tab]);
  if (typeof back === "string" && dig(focused, "workspace_id") !== workspace) await herdr(["tab", "focus", back]);
}

export function herdrDriver(o: Options): AgentDriver {
  const { herdr } = o;
  return {
    async start({ prompt, worktree, session, env, log, onPane }) {
      const label = `norn-${o.issue}`;
      const vars = Object.entries({ ...env, NORN_SESSION: session, NORN_RUN: String(o.issue) }).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
      // The worktree's own workspace, which herdr opens once and finds again after.
      const opened = await herdr(["worktree", "open", "--cwd", o.root, "--path", worktree, "--no-focus"]);
      const workspace = opened.ok ? dig(opened.result, "workspace", "workspace_id") : undefined;
      // The run's session is in the tab's environment from the start, so every norn command the agent runs is the run's.
      const made =
        typeof workspace === "string"
          ? await herdr(["tab", "create", "--workspace", workspace, "--cwd", worktree, "--label", label, ...vars, "--no-focus"])
          : await herdr(["workspace", "create", "--cwd", worktree, "--label", label, ...vars, "--no-focus"]);
      const pane = made.ok ? dig(made.result, "root_pane", "pane_id") : undefined;
      if (typeof pane !== "string") return notStarted(`herdr could not make a pane in ${worktree}: ${made.ok ? "no pane in its answer" : made.message}`);
      onPane?.(pane);
      if (typeof workspace === "string" && made.ok)
        await showTab(herdr, workspace, dig(made.result, "tab", "tab_id") ?? dig(made.result, "root_pane", "tab_id"));
      // Agent names are unique in the herdr session, and an earlier run may have left a norn-<issue> for a person.
      const name = (await herdr(["agent", "get", label])).ok ? `${label}-${session.split("-").at(-1)}`.slice(0, 32) : label;
      const started = await herdr(["agent", "start", name, "--kind", o.agent.kind, "--pane", pane, ...(o.agent.args.length ? ["--", ...o.agent.args] : [])]);
      // agent_not_ready: it started, but waits, e.g. at a trust dialog; the prompt is sent once it takes one.
      if (!started.ok && started.code !== "agent_not_ready") {
        await herdr(["pane", "close", pane]);
        return notStarted(`herdr agent start failed: ${started.message}`);
      }
      const attempt = new PaneAttempt(o, pane, log, prompt);
      await attempt.sendPending();
      return attempt;
    },
  };
}

function notStarted(detail: string): AgentAttempt {
  const end = Promise.resolve<AgentEnd>({ kind: "not-started", detail });
  return {
    pane: null,
    ended: () => end,
    look: async () => ({ activityAt: Date.now(), blocked: false }),
    nudge: async () => false,
    stop: async () => {},
  };
}

class PaneAttempt implements AgentAttempt {
  private turn = deferred<AgentEnd>();
  private pending: string | null;
  private promptedAt = Date.now();
  private seenWorking = false;
  private activityAt = Date.now();
  private screen = "";
  private idleSeen = 0;
  private goneSeen = 0;
  private gone = false;
  private readonly graceMs: number;
  private readonly pauseMs: number;

  constructor(
    private o: Options,
    readonly pane: string,
    private log: string,
    prompt: string,
  ) {
    this.pending = prompt;
    this.graceMs = o.graceMs ?? 30_000;
    this.pauseMs = o.pauseMs ?? 1000;
  }

  ended() {
    return this.turn.promise;
  }

  async look(): Promise<AgentLook> {
    const quiet = { activityAt: this.activityAt, blocked: false };
    if (this.turn.settled) return quiet;
    if (await this.sendPending()) return quiet;
    const got = await this.o.herdr(["agent", "get", this.pane]);
    if (!got.ok) {
      // Gone only when herdr says so on consecutive polls; a failing socket is no news about the agent.
      if (got.code !== "agent_not_found" || ++this.goneSeen < CONFIRM) return quiet;
      const paneThere = (await this.o.herdr(["pane", "get", this.pane])).ok;
      this.gone = !paneThere;
      await this.end({ kind: "gone", what: paneThere ? "agent" : "pane" });
      return quiet;
    }
    this.goneSeen = 0;
    await this.watchScreen();
    const state = String(dig(got.result, "agent", "agent_status"));
    if (state === "blocked") {
      this.idleSeen = 0;
      return { activityAt: this.activityAt, blocked: true };
    }
    if (state === "idle" || state === "done") {
      // Right after a prompt the agent may not have picked it up yet.
      if ((this.seenWorking || Date.now() - this.promptedAt >= this.graceMs) && ++this.idleSeen >= CONFIRM) await this.end({ kind: "stopped-early", state });
      return { activityAt: this.activityAt, blocked: false };
    }
    this.idleSeen = 0;
    if (state === "working") this.seenWorking = true;
    // unknown: herdr cannot tell what the agent does. Nothing ends on it; the stall and timeout rules still apply.
    return { activityAt: this.activityAt, blocked: false };
  }

  async nudge(text: string) {
    if (this.gone || !this.turn.settled) return false;
    const r = await this.o.herdr(["agent", "prompt", this.pane, text]);
    if (!r.ok) return false;
    this.turn = deferred();
    this.promptedAt = Date.now();
    this.activityAt = Date.now();
    this.seenWorking = false;
    this.idleSeen = 0;
    this.goneSeen = 0;
    return true;
  }

  async stop() {
    if (this.gone) return;
    await this.saveScreen();
    await closePane(this.o.herdr, this.pane, this.pauseMs);
    this.gone = true;
    this.turn.resolve({ kind: "gone", what: "pane" });
  }

  /** Sends the prompt the agent has not had yet, e.g. while a dialog held it; true once sent. */
  async sendPending() {
    if (!this.pending) return false;
    const r = await this.o.herdr(["agent", "prompt", this.pane, this.pending]);
    if (!r.ok) return false;
    this.pending = null;
    this.promptedAt = Date.now();
    this.activityAt = Date.now();
    return true;
  }

  private async watchScreen() {
    const read = await this.o.herdr(["pane", "read", this.pane, "--source", "recent-unwrapped", "--lines", "200"]);
    if (!read.ok) return;
    const hash = createHash("sha1").update(String(read.result)).digest("hex");
    if (hash !== this.screen) {
      this.screen = hash;
      this.activityAt = Date.now();
    }
  }

  /** What the pane showed goes into the attempt's log, for whoever looks into the run later. */
  private async saveScreen() {
    const read = await this.o.herdr(["pane", "read", this.pane, "--source", "recent-unwrapped", "--lines", "2000"]);
    if (!read.ok) return;
    try {
      appendFileSync(this.log, `--- ${new Date().toISOString()} herdr pane ${this.pane}\n${String(read.result)}\n`);
    } catch {}
  }

  private async end(end: AgentEnd) {
    if (end.kind !== "gone") await this.saveScreen();
    this.turn.resolve(end);
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const d = {
    settled: false,
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve: (v: T) => {
      if (d.settled) return;
      d.settled = true;
      resolve(v);
    },
  };
  return d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
