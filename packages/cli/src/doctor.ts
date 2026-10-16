import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  checkFlowsNamed,
  FLOWS_DIR,
  type FlowError,
  flowFileNames,
  flowLabels,
  sliceType,
  flowStatesOf,
  renamedTo,
  repositoryFlows,
  parseFlow,
  type LoadedFlow,
  isNornLabel,
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
export type CheckId = "gh" | "git" | "base-branch" | "permission" | "labels" | "flows" | "config" | "version" | "skills" | "agent-instructions" | "provider";

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
  | FlowsFact
  | { kind: "config"; problems: ConfigProblem[]; warnings: ConfigWarning[] }
  | { kind: "version"; running: string; repo: string | null; match: VersionMatch | null }
  /** `drifted` is null when the skills come from NORN_SKILLS_SOURCE and are not compared. */
  | { kind: "skills"; total: number; missing: string[]; unlinked: string[]; drifted: string[] | null }
  | { kind: "agent-instructions"; files: string[] }
  | { kind: "provider"; provider: Provider; unsetVariable: string | null };

/**
 * What the flows check found: the flows in effect by name; the invalid ones on the base branch, and in the checkout's
 * working copy where it differs; the type of the slices each valid flow makes; skills a valid flow names that are not
 * installed; the labels the working copy's valid flows need that the repository lacks (the labels check covers the
 * flows in effect); and the open issues the working copy's flows would orphan, in a state they drop without renaming it.
 */
export interface FlowsFact {
  kind: "flows";
  baseBranch: string;
  names: string[];
  invalid: { flow: string; local: boolean; errors: FlowError[] }[];
  slices: { flow: string; local: boolean; type: string }[];
  missingSkills: { skill: string; flow: string; local: boolean; state: string }[];
  missingLabels: { label: string; flow: string }[];
  orphans: { flow: string; issue: number; state: string }[];
}

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

/** A read that worked, or the gh-error fact of one that failed. */
type Attempt<T> = { ok: true; value: T } | { ok: false; fact: CheckFact };

/** What a check works on, or a check it needs that did not pass, so it is skipped; a read that failed instead carries its fact. */
type Ready<T> = Attempt<T> | { ok: false; needs: CheckId };

/** Runs a GitHub read, turning a failure into a gh-error fact so doctor itself never fails. */
async function attempt<T>(read: () => Promise<T>): Promise<Attempt<T>> {
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
  // The checks on the configuration need it read; those on GitHub need gh and the checkout first.
  const withConfig: Ready<Config> = loaded?.ok ? { ok: true, value: loaded.config } : { ok: false, needs: inCheckout ? "config" : "git" };
  const withRepo: Ready<Config> = needsForGitHub ? { ok: false, needs: needsForGitHub } : withConfig;

  if (!withRepo.ok) skip("base-branch", withRepo.needs);
  else {
    const branch = withRepo.value.baseBranch;
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
  const inEffect: Ready<{ config: Config; flows: LoadedFlow[] }> = !withRepo.ok
    ? withRepo
    : await attempt(async () => ({ config: withRepo.value, flows: await repositoryFlows({ github: d.github, config: withRepo.value }) }));

  if (!inEffect.ok && "needs" in inEffect) skip("labels", inEffect.needs);
  else {
    const onRepo = await attempt(() => d.github.repositoryLabels());
    if (!onRepo.ok) add("labels", "fail", onRepo.fact);
    else if (!inEffect.ok) add("labels", "fail", inEffect.fact);
    else {
      const wanted = labelDefinitions(inEffect.value.flows).map((l) => l.name);
      const missing = wanted.filter((name) => !onRepo.value.some((l) => l.name === name));
      const unused = onRepo.value.filter((l) => !wanted.includes(l.name) && isNorns(l, inEffect.value.flows)).map((l) => l.name);
      add("labels", missing.length ? "fail" : unused.length ? "warning" : "ok", { kind: "labels", total: wanted.length, missing, unused });
    }
  }

  if (!inEffect.ok && "needs" in inEffect) skip("flows", inEffect.needs);
  else if (!inEffect.ok) add("flows", "fail", inEffect.fact);
  else {
    const { config, flows: loaded } = inEffect.value;
    const fact = await attempt(() => flows(d, config, loaded));
    if (!fact.ok) add("flows", "fail", fact.fact);
    else {
      const f = fact.value;
      add("flows", f.invalid.length || f.missingSkills.length ? "fail" : f.orphans.length || f.missingLabels.length ? "warning" : "ok", f);
    }
  }

  if (!loaded) skip("config", "git");
  else if (!loaded.ok) add("config", "fail", { kind: "config", problems: loaded.refusal.problems, warnings: [] });
  else add("config", loaded.warnings.length ? "warning" : "ok", { kind: "config", problems: [], warnings: loaded.warnings });

  if (!withConfig.ok) skip("version", withConfig.needs);
  else {
    const repo = withConfig.value.nornVersion;
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

  if (!withConfig.ok) skip("provider", withConfig.needs);
  else {
    const c = withConfig.value;
    const mismatch = providerRefusal(c, d.workspace.env);
    add("provider", mismatch ? "fail" : "ok", { kind: "provider", provider: c.provider, unsetVariable: mismatch?.variable ?? null });
  }

  return { ok: true, kind: "doctor", checks };
}

/**
 * Checks the flows in effect and the checkout's flow files that differ from the base branch, as the team would have
 * them once merged. Reads only: the files, and the open issues of a flow whose working copy drops states.
 */
async function flows(d: DoctorDeps, config: Config, inEffect: LoadedFlow[]): Promise<FlowsFact> {
  const remoteText = (name: string) => d.github.readFileAt(`${FLOWS_DIR}/${name}.json`, config.baseBranch);
  const dir = join(d.cwd, FLOWS_DIR);
  const localNames = existsSync(dir) ? flowFileNames(readdirSync(dir)) : [];
  const local: LoadedFlow[] = [];
  for (const name of localNames) {
    const text = readFileSync(join(dir, `${name}.json`), "utf8");
    if (text === (await remoteText(name))) continue;
    // Once merged, a flow the working copy names may come from the working copy or the base branch.
    const exists = async (other: string) => localNames.includes(other) || (await remoteText(other)) !== null;
    local.push(await checkFlowsNamed(parseFlow(name, text), exists));
  }
  const all = [...inEffect.map((l) => ({ l, local: false })), ...local.map((l) => ({ l, local: true }))];

  const invalid = all.flatMap(({ l, local }) => (l.ok ? [] : [{ flow: l.name, local, errors: l.errors }]));

  // norn's own skills are the skills check's.
  const installed = (skill: string) =>
    (SKILLS as readonly string[]).includes(skill) ||
    existsSync(join(d.cwd, "skills", skill, "SKILL.md")) ||
    existsSync(join(d.cwd, ".claude", "skills", skill, "SKILL.md"));
  const missingSkills: FlowsFact["missingSkills"] = [];
  for (const { l, local } of all) {
    if (!l.ok) continue;
    for (const [state, s] of Object.entries(l.flow.states)) {
      const named = missingSkills.some((m) => m.skill === s.skill && m.flow === l.name && m.local === local);
      if (!installed(s.skill) && !named) missingSkills.push({ skill: s.skill, flow: l.name, local, state });
    }
  }

  const slices = all.flatMap(({ l, local }) => {
    const type = l.ok ? sliceType(l.flow) : null;
    return type === null ? [] : [{ flow: l.name, local, type }];
  });

  const onRepo = (await d.github.repositoryLabels()).map((l) => l.name);
  const missingLabels: FlowsFact["missingLabels"] = [];
  for (const l of local) {
    if (!l.ok) continue;
    for (const { name } of flowLabels([l])) if (!onRepo.includes(name)) missingLabels.push({ label: name, flow: l.name });
  }

  const orphans: FlowsFact["orphans"] = [];
  for (const after of local) {
    const before = inEffect.find((l) => l.name === after.name);
    if (!after.ok || !before?.ok) continue;
    // As take would: a state renamed is followed, any other state the flow dropped sends the issue to needs-human.
    const kept = (state: string) => Object.hasOwn(after.flow.states, state) || renamedTo(after.flow, state) !== null;
    const removed = Object.keys(before.flow.states).filter((state) => !kept(state));
    if (!removed.length) continue;
    for (const issue of await d.github.openIssues(`type:${after.name}`)) {
      const state = removed.find((s) => issue.labels.includes(s));
      if (state && flowStatesOf(issue, after.flow).length === 0) orphans.push({ flow: after.name, issue: issue.number, state });
    }
  }

  return { kind: "flows", baseBranch: config.baseBranch, names: inEffect.map((l) => l.name), invalid, slices, missingSkills, missingLabels, orphans };
}

/**
 * Whether a label is norn's: norn marked it when it created it (see LABEL_MARK), it is a type, whose prefix is norn's,
 * or a flow's renamed map names it as an old state.
 */
function isNorns(label: { name: string; description: string }, flows: LoadedFlow[]): boolean {
  if (isNornLabel(label) || label.name.startsWith("type:")) return true;
  return flows.some((l) => l.ok && renamedTo(l.flow, label.name) !== null);
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
