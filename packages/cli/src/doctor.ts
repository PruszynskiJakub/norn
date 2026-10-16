import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  flowsInEffect,
  type LoadedFlow,
  STATES,
  type ConfigProblem,
  type ConfigWarning,
  type GhAuth,
  type GitHub,
  loadConfig,
  type Permission,
  type Provider,
  providerRefusal,
  type VersionMatch,
  versionMatch,
  type Workspace,
} from "@norn/core";
import { filesWithAgentInstructions, labelDefinitions, SKILLS } from "./init.js";
import { sameTree } from "./install-skills.js";

/** The checks norn doctor makes, in the order it reports them. */
export type CheckId = "gh" | "git" | "base-branch" | "permission" | "labels" | "config" | "version" | "skills" | "agent-instructions" | "provider";

/** Only `fail` makes doctor exit 1; `skipped` means a check it depends on did not pass. */
export type CheckLevel = "ok" | "warning" | "fail" | "skipped";

/** What a check found, for the renderer to word. */
export type CheckFact =
  | { kind: "skipped"; needs: CheckId }
  /** A gh call failed; `detail` is its error. */
  | { kind: "gh-error"; detail: string }
  | { kind: "gh"; host: string; auth: GhAuth }
  /** `detail` says why norn found no checkout here. */
  | { kind: "not-a-checkout"; detail: string }
  | { kind: "no-origin" }
  | { kind: "origin"; origin: string; host: string | null; onGitHub: boolean }
  | { kind: "base-branch"; branch: string; exists: boolean; defaultBranch: string | null }
  | { kind: "permission"; permission: Permission }
  /** `unused` are labels that look like norn's, a type or a state some flow had, that no flow in effect uses. */
  | { kind: "labels"; total: number; missing: string[]; unused: string[] }
  | { kind: "config"; problems: ConfigProblem[]; warnings: ConfigWarning[] }
  | { kind: "version"; running: string; repo: string | null; match: VersionMatch | null }
  /** `drifted` is null when the skills come from NORN_SKILLS_SOURCE and are not compared. */
  | { kind: "skills"; total: number; missing: string[]; unlinked: string[]; drifted: string[] | null }
  | { kind: "agent-instructions"; files: string[] }
  | { kind: "provider"; provider: Provider; unsetVariable: string | null };

export interface DoctorCheck {
  id: CheckId;
  level: CheckLevel;
  fact: CheckFact;
}

export interface DoctorResult {
  ok: true;
  kind: "doctor";
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  github: GitHub;
  workspace: Workspace;
  /** The repository's root, where skills/ and the agent instructions live. */
  cwd: string;
  version: string;
  /** The skills bundled with the running norn, to compare the installed ones with. */
  bundledSkills: string;
  /** Why norn is not in a checkout it can work in; null when it is. */
  checkoutProblem: string | null;
}

const WRITE: Permission[] = ["admin", "maintain", "write"];

export function doctorFailed(r: DoctorResult): boolean {
  return r.checks.some((c) => c.level === "fail");
}

/** Runs a GitHub read, turning a failure into a gh-error fact so doctor itself never fails. */
async function attempt<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; fact: CheckFact }> {
  try {
    return { ok: true, value: await read() };
  } catch (e) {
    return { ok: false, fact: { kind: "gh-error", detail: e instanceof Error ? e.message : String(e) } };
  }
}

/** The host of a git remote URL, in the scp form (git@host:path) or as a URL. */
export function remoteHost(url: string): string | null {
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(url);
  if (scp) return scp[1];
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * norn doctor: checks the whole setup and reports every check, with what
 * fixes it. Read-only, and it never refuses: a check that cannot run is
 * skipped, naming the check it needs.
 */
export async function doctor(d: DoctorDeps): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const add = (id: CheckId, level: CheckLevel, fact: CheckFact) => {
    checks.push({ id, level, fact });
    return level === "ok" || level === "warning";
  };
  const skip = (id: CheckId, needs: CheckId) => add(id, "skipped", { kind: "skipped", needs });

  const inCheckout = d.checkoutProblem === null;
  const origin = inCheckout ? await d.workspace.originUrl() : null;
  const host = origin === null ? null : remoteHost(origin);

  // gh decides which hosts are GitHub: github.com, or an Enterprise host it is logged in to.
  let ghHost = host ?? "github.com";
  let auth = await attempt(() => d.github.ghAuth(ghHost));
  let onGitHub = host === "github.com";
  if (host !== null && host !== "github.com") {
    // Without a working gh there is no telling, and the gh check already fails for it.
    onGitHub = !auth.ok || auth.value.kind !== "logged-out";
    if (!onGitHub && auth.ok && auth.value.kind === "logged-out") {
      ghHost = "github.com";
      auth = await attempt(() => d.github.ghAuth(ghHost));
    }
  }
  const ghOk = !auth.ok
    ? add("gh", "fail", auth.fact)
    : add("gh", auth.value.kind === "logged-in" ? "ok" : "fail", { kind: "gh", host: ghHost, auth: auth.value });

  const gitOk = !inCheckout
    ? add("git", "fail", { kind: "not-a-checkout", detail: d.checkoutProblem ?? "" })
    : origin === null
      ? add("git", "fail", { kind: "no-origin" })
      : add("git", onGitHub ? "ok" : "fail", { kind: "origin", origin, host, onGitHub });
  const needsForGitHub: CheckId | null = !ghOk ? "gh" : !gitOk ? "git" : null;

  const loaded = inCheckout ? await loadConfig(d.workspace) : null;
  const config: Config | null = loaded?.ok ? loaded.config : null;
  const needsForConfig: CheckId | null = !inCheckout ? "git" : config ? null : "config";

  if (needsForGitHub || needsForConfig) skip("base-branch", (needsForGitHub ?? needsForConfig) as CheckId);
  else {
    const branch = (config as Config).baseBranch;
    const exists = await attempt(() => d.github.branchExists(branch));
    if (!exists.ok) add("base-branch", "fail", exists.fact);
    else {
      const defaultBranch = exists.value ? null : await d.github.defaultBranch().catch(() => null);
      add("base-branch", exists.value ? "ok" : "fail", { kind: "base-branch", branch, exists: exists.value, defaultBranch });
    }
  }

  if (needsForGitHub) skip("permission", needsForGitHub);
  else {
    const permission = await attempt(() => d.github.permission());
    if (!permission.ok) add("permission", "fail", permission.fact);
    else add("permission", WRITE.includes(permission.value) ? "ok" : "fail", { kind: "permission", permission: permission.value });
  }

  // The flows in effect, read from the base branch on GitHub, as norn commands read them.
  const inEffect = needsForGitHub || needsForConfig ? null : await attempt(() => flowsInEffect({ github: d.github, config: config as Config }));

  if (needsForGitHub || needsForConfig) skip("labels", (needsForGitHub ?? needsForConfig) as CheckId);
  else {
    const names = await attempt(() => d.github.labelNames());
    if (!names.ok) add("labels", "fail", names.fact);
    else if (!inEffect?.ok) add("labels", "fail", (inEffect as { fact: CheckFact }).fact);
    else {
      const wanted = labelDefinitions(inEffect.value).map((l) => l.name);
      const missing = wanted.filter((l) => !names.value.includes(l));
      const unused = names.value.filter((l) => !wanted.includes(l) && looksLikeNorns(l, inEffect.value));
      add("labels", missing.length ? "fail" : unused.length ? "warning" : "ok", { kind: "labels", total: wanted.length, missing, unused });
    }
  }

  if (!loaded) skip("config", "git");
  else if (!loaded.ok) add("config", "fail", { kind: "config", problems: loaded.refusal.problems, warnings: [] });
  else add("config", loaded.warnings.length ? "warning" : "ok", { kind: "config", problems: [], warnings: loaded.warnings });

  if (needsForConfig) skip("version", needsForConfig);
  else {
    const repo = (config as Config).nornVersion;
    const match = repo === null ? null : versionMatch(d.version, repo);
    const level = match === null ? "warning" : match.kind === "same" || match.kind === "patch" ? "ok" : match.compatible ? "warning" : "fail";
    add("version", level, { kind: "version", running: d.version, repo, match });
  }

  if (!inCheckout) skip("skills", "git");
  else {
    const fact = skills(d);
    add("skills", fact.missing.length || fact.unlinked.length ? "fail" : fact.drifted?.length ? "warning" : "ok", fact);
  }

  if (!inCheckout) skip("agent-instructions", "git");
  else {
    const files = filesWithAgentInstructions(d.cwd);
    add("agent-instructions", files.length ? "ok" : "fail", { kind: "agent-instructions", files });
  }

  if (needsForConfig) skip("provider", needsForConfig);
  else {
    const c = config as Config;
    const mismatch = providerRefusal(c, d.workspace.env);
    add("provider", mismatch ? "fail" : "ok", { kind: "provider", provider: c.provider, unsetVariable: mismatch?.variable ?? null });
  }

  return { ok: true, kind: "doctor", checks };
}

/** Whether a label is one norn may have made: a type, a state of a built-in flow, or a state a flow renamed. */
function looksLikeNorns(label: string, flows: LoadedFlow[]): boolean {
  if (label.startsWith("type:") || (STATES as readonly string[]).includes(label)) return true;
  return flows.some((l) => l.ok && Object.hasOwn(l.flow.renamed ?? {}, label));
}

/** The skills norn briefings name: in skills/, linked from .claude/skills/, and the same as the bundled ones. */
function skills(d: DoctorDeps): Extract<CheckFact, { kind: "skills" }> {
  const dir = join(d.cwd, "skills");
  const missing = SKILLS.filter((s) => !existsSync(join(dir, s, "SKILL.md")));
  // Following the link, so one that points nowhere counts as unlinked; a missing skill is named once, as missing.
  const unlinked = SKILLS.filter((s) => !missing.includes(s) && !existsSync(join(d.cwd, ".claude", "skills", s, "SKILL.md")));
  // A source the team chose owns its skills; differing from the bundled ones is the point.
  const drifted = d.workspace.env.NORN_SKILLS_SOURCE
    ? null
    : SKILLS.filter((s) => !missing.includes(s) && existsSync(join(d.bundledSkills, s)) && !sameTree(join(d.bundledSkills, s), join(dir, s)));
  return { kind: "skills", total: SKILLS.length, missing, unlinked, drifted };
}
