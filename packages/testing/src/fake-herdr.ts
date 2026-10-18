/** An agent in a fake pane; tests set its status as the agent's work goes. */
export interface FakeAgent {
  name: string;
  kind: string;
  args: string[];
  status: "idle" | "working" | "blocked" | "done" | "unknown";
}

export interface FakePane {
  id: string;
  workspace: string;
  cwd: string;
  label: string;
  env: Record<string, string>;
  agent: FakeAgent | null;
  /** What the pane shows; a test changes it to show activity. */
  screen: string;
  prompts: string[];
  keys: string[];
  closed: boolean;
}

type Answer = { ok: true; result: unknown } | { ok: false; code: string; message: string };

/** Kinds herdr 0.9.3 starts; any other is refused as herdr's argument parser would. */
const KINDS = ["claude", "codex", "gemini", "opencode", "cursor", "amp", "copilot"];

/**
 * The herdr CLI in memory, answering the commands norn's herdr driver uses with
 * herdr's JSON shapes and error codes. `run` is the injected command runner.
 */
export class FakeHerdr {
  calls: string[][] = [];
  private panes = new Map<string, FakePane>();
  private workspaces = new Map<string, string>();
  private made = 0;
  /** Agents live elsewhere in the session, holding names. */
  private elsewhere = new Set<string>();
  /** What the agent does with a prompt; tests script it, e.g. take the item and set its status. */
  onPrompt: (pane: FakePane, text: string) => void | Promise<void> = () => {};

  allPanes() {
    return [...this.panes.values()];
  }

  called(...prefix: string[]) {
    return this.calls.filter((c) => prefix.every((p, i) => c[i] === p));
  }

  addAgent(name: string) {
    this.elsewhere.add(name);
  }

  /** A person closes the pane, or its process dies with it. */
  closePane(id: string) {
    const p = this.panes.get(id);
    if (p) {
      p.closed = true;
      p.agent = null;
    }
  }

  run = async (args: string[]): Promise<Answer> => {
    this.calls.push(args);
    const [group, cmd, ...rest] = args;
    const flag = (name: string) => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const envs = () => Object.fromEntries(rest.flatMap((a, i) => (rest[i - 1] === "--env" ? [a.split(/=(.*)/s).slice(0, 2)] : [])));
    const err = (code: string, message = code): Answer => ({ ok: false, code, message });
    const live = (target: string) => {
      const p = this.panes.get(target) ?? [...this.panes.values()].find((x) => x.agent?.name === target);
      return p && !p.closed ? p : undefined;
    };
    const newPane = (workspace: string, cwd: string): FakePane => {
      const pane: FakePane = {
        id: `${workspace}:p${++this.made}`,
        workspace,
        cwd,
        label: flag("--label") ?? "",
        env: envs(),
        agent: null,
        screen: "$ ",
        prompts: [],
        keys: [],
        closed: false,
      };
      this.panes.set(pane.id, pane);
      return pane;
    };
    const paneInfo = (p: FakePane) => ({ pane_id: p.id, workspace_id: p.workspace, cwd: p.cwd, agent_status: p.agent?.status ?? "unknown" });
    const key = `${group} ${cmd}`;
    switch (key) {
      case "worktree open": {
        const path = flag("--path") ?? "";
        const id = this.workspaces.get(path) ?? `w${this.workspaces.size + 1}`;
        this.workspaces.set(path, id);
        return { ok: true, result: { type: "worktree_opened", workspace: { workspace_id: id } } };
      }
      case "tab create": {
        const pane = newPane(flag("--workspace") ?? "", flag("--cwd") ?? "");
        return { ok: true, result: { type: "tab_created", root_pane: paneInfo(pane) } };
      }
      case "workspace create": {
        const pane = newPane(`w${this.workspaces.size + 100}`, flag("--cwd") ?? "");
        return { ok: true, result: { type: "workspace_created", root_pane: paneInfo(pane) } };
      }
      case "agent start": {
        const [name] = rest;
        const p = live(flag("--pane") ?? "");
        if (!p) return err("pane_not_found");
        if (!KINDS.includes(flag("--kind") ?? "")) return err("failed", `invalid value '${flag("--kind")}' for '--kind <KIND>'`);
        if (this.elsewhere.has(name) || live(name)) return err("agent_name_taken");
        const dash = rest.indexOf("--");
        p.agent = { name, kind: flag("--kind") ?? "", args: dash >= 0 ? rest.slice(dash + 1) : [], status: "idle" };
        return { ok: true, result: { type: "agent_started" } };
      }
      case "agent get": {
        const [target] = rest;
        if (this.elsewhere.has(target)) return { ok: true, result: { type: "agent_info", agent: { name: target, agent_status: "idle" } } };
        const p = live(target);
        if (!p?.agent) return err("agent_not_found", `agent target ${target} not found`);
        return { ok: true, result: { type: "agent_info", agent: { ...paneInfo(p), name: p.agent.name, agent: p.agent.kind } } };
      }
      case "agent prompt": {
        const [target, text] = rest;
        const p = live(target);
        if (!p?.agent) return err("agent_not_found");
        if (p.agent.status === "blocked") return err("agent_blocked");
        p.prompts.push(text);
        await this.onPrompt(p, text);
        return { ok: true, result: { type: "agent_prompted" } };
      }
      case "agent send-keys": {
        const [target, ...keys] = rest;
        const p = live(target);
        if (!p?.agent) return err("agent_not_found");
        p.keys.push(...keys);
        return { ok: true, result: null };
      }
      case "pane get": {
        const p = live(rest[0]);
        return p ? { ok: true, result: { type: "pane_info", pane: paneInfo(p) } } : err("pane_not_found");
      }
      case "pane read": {
        const p = live(rest[0]);
        return p ? { ok: true, result: p.screen } : err("pane_not_found");
      }
      case "pane close": {
        const p = live(rest[0]);
        if (!p) return err("pane_not_found");
        this.closePane(p.id);
        return { ok: true, result: { type: "ok" } };
      }
      default:
        return err("unknown_command", `the fake herdr does not know ${key}`);
    }
  };
}
