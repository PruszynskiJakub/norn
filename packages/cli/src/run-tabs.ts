import { type Ctx, samePath } from "@norn/core";
import { dig, type Herdr } from "./herdr.js";
import { readRecord, supervisorLives } from "./run-records.js";

/** A run's herdr tab, `norn-<issue>` or `norn-<issue>-<nonce>`, that norn tidy closes. */
export interface RunTab {
  tab: string;
  issue: number;
}

const RUN_TAB = /^norn-(\d+)(-[0-9a-f]+)?$/;

/**
 * The run tabs in this repository's herdr workspaces that nothing needs any
 * more: no live run on this machine owns them, and their issue does not wait
 * on a person, who would find the escalated run's agent there. Tabs in a
 * worktree norn tidy removes go with its workspace; these are the others, e.g.
 * of a step worked in the main checkout, or of an escalation since resolved.
 */
export async function leftoverRunTabs(ctx: Ctx, herdr: Herdr): Promise<RunTab[]> {
  const root = ctx.workspace.root;
  const listed = await herdr(["workspace", "list"]);
  if (!listed.ok) return [];
  const workspaces = ((dig(listed.result, "workspaces") ?? []) as unknown[]).filter((w) => {
    const repo = dig(w, "worktree", "repo_root");
    return typeof repo === "string" && samePath(repo, root);
  });
  const out: RunTab[] = [];
  for (const w of workspaces) {
    const tabs = await herdr(["tab", "list", "--workspace", String(dig(w, "workspace_id"))]);
    if (!tabs.ok) continue;
    for (const t of (dig(tabs.result, "tabs") ?? []) as unknown[]) {
      const match = RUN_TAB.exec(String(dig(t, "label")));
      if (!match) continue;
      const issue = Number(match[1]);
      const record = readRecord(root, issue);
      if (record?.state === "running" && supervisorLives(record)) continue;
      const i = await ctx.github.getIssue(issue);
      if (i.state === "open" && i.labels.includes("needs-human")) continue;
      out.push({ tab: String(dig(t, "tab_id")), issue });
    }
  }
  return out;
}

export async function closeRunTabs(herdr: Herdr, tabs: RunTab[]): Promise<RunTab[]> {
  const closed: RunTab[] = [];
  for (const t of tabs) if ((await herdr(["tab", "close", t.tab])).ok) closed.push(t);
  return closed;
}
