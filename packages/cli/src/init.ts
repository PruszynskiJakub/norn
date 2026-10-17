import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
  compareVersions,
  type ConfigProblem,
  DEFAULT_TEAM_CONFIG,
  ENGINE_FLAGS,
  flowLabels,
  nornLabel,
  repositoryFlows,
  type GitHub,
  isVersion,
  type LabelDefinition,
  LOCAL_CONFIG,
  type LoadedFlow,
  TEAM_CONFIG,
} from "@norn/core";
import { join } from "node:path";
import { SKILLS_DIR } from "./install-skills.js";

/** Skills norn briefings name. */
export const SKILLS = [
  "norn-triage",
  "norn-refine",
  "norn-clarify",
  "norn-plan",
  "norn-slice",
  "norn-implement",
  "norn-review",
  "norn-auto-qa",
  "norn-qa",
  "norn-merge",
  "norn-resolve",
  "norn-drive",
  "norn-deliver",
  "norn-tdd",
  "norn-interview",
  "norn-codebase-design",
] as const;

/** The labels of the engine's own flags, which every flow shares. */
const FLAG_LABELS: Record<(typeof ENGINE_FLAGS)[number], [string, string]> = {
  "in-progress": ["fef2c0", "Someone holds the claim, mirrored from the git-ref claim"],
  "needs-human": ["e11d21", "A person is needed; cleared with the norn-resolve skill"],
  "mode:afk": ["bfdadc", "QA by an agent only"],
  "mode:hil": ["bfdadc", "QA by an agent, then by a person"],
};

/** The labels norn needs: those of the valid flows in effect, then the engine's flags. */
export function labelDefinitions(flows: LoadedFlow[]): LabelDefinition[] {
  const valid = flows.flatMap((l) => (l.ok ? [{ name: l.name, flow: l.flow }] : []));
  return [...flowLabels(valid), ...ENGINE_FLAGS.map((name) => nornLabel(name, ...FLAG_LABELS[name]))];
}

export interface InitDeps {
  github: GitHub;
  cwd: string;
  /** Returns the names of the skills it updated. */
  installSkills: (cwd: string) => Promise<string[]>;
  /** The running norn's version, recorded as the team's nornVersion. */
  version: string;
}

export interface InitResult {
  ok: true;
  kind: "initialized";
  /** How many skills are installed, and which of them this run updated. */
  skills: number;
  updated: string[];
  /** The files given the agent instructions: AGENTS.md, CLAUDE.md or both. */
  instructed: string[];
  labels: number;
  /** How this run changed the team's nornVersion; null when it was already the running version. */
  version: { from: string | null; to: string } | null;
}

/** The skill install left out skills norn briefings name. */
export interface MissingSkills {
  kind: "missing-skills";
  missing: string[];
}

/** The repository was set up with a newer norn than the one running init. */
export interface InitWouldDowngrade {
  kind: "init-would-downgrade";
  running: string;
  repo: string;
}

type InitRefusal = MissingSkills | InitWouldDowngrade | { kind: "config-invalid"; problems: ConfigProblem[] };

export async function init({ github, cwd, installSkills, version }: InitDeps): Promise<InitResult | { ok: false; refusal: InitRefusal }> {
  const teamConfig = join(cwd, TEAM_CONFIG);
  const team = readTeamConfig(teamConfig);
  if (!team.ok) return team;
  const from = typeof team.settings?.nornVersion === "string" ? team.settings.nornVersion : null;
  // Older skills over newer ones would quietly roll the whole team back.
  if (from !== null && isVersion(from) && compareVersions(from, version) > 0) {
    return { ok: false, refusal: { kind: "init-would-downgrade", running: version, repo: from } };
  }

  const updated = await installSkills(cwd);
  const skillsDir = join(cwd, SKILLS_DIR);
  const installed = existsSync(skillsDir) ? readdirSync(skillsDir).filter((d) => existsSync(join(skillsDir, d, "SKILL.md"))) : [];
  const missing = SKILLS.filter((s) => !installed.includes(s));
  if (missing.length) return { ok: false, refusal: { kind: "missing-skills", missing } };

  const linkDir = join(cwd, ".claude", "skills");
  mkdirSync(linkDir, { recursive: true });
  for (const name of installed) {
    const link = join(linkDir, name);
    // A link from an older norn points into skills/; it moves to .agents/skills/, anything else is the project's.
    if (exists(link) && !(lstatSync(link).isSymbolicLink() && readlinkSync(link) === join("..", "..", "skills", name))) continue;
    rmSync(link, { force: true });
    symlinkSync(join("..", "..", SKILLS_DIR, name), link, "dir");
  }

  const specs = join(cwd, ".agents", "specs");
  mkdirSync(specs, { recursive: true });
  if (readdirSync(specs).length === 0) writeFileSync(join(specs, ".gitkeep"), "");

  const baseBranch = typeof team.settings?.baseBranch === "string" ? team.settings.baseBranch : await github.defaultBranch();
  if (team.settings === null) {
    const config = { nornVersion: version, ...DEFAULT_TEAM_CONFIG, baseBranch };
    writeFileSync(teamConfig, `${JSON.stringify(config, null, 2)}\n`);
  } else if (from !== version) {
    // Only the version changes; an existing key keeps its place, a new one goes first.
    const config = "nornVersion" in team.settings ? { ...team.settings, nornVersion: version } : { nornVersion: version, ...team.settings };
    writeFileSync(teamConfig, `${JSON.stringify(config, null, 2)}\n`);
  }
  ensureGitignored(cwd, [".agents/worktrees/", LOCAL_CONFIG]);
  const instructed = writeAgentInstructions(cwd);

  // The flows on the base branch decide the states; an invalid one is left for norn doctor to report.
  const labels = labelDefinitions(await repositoryFlows({ github, config: { baseBranch } }));
  await github.ensureLabels(labels);

  return {
    ok: true,
    kind: "initialized",
    skills: installed.length,
    updated,
    instructed,
    labels: labels.length,
    version: from === version ? null : { from, to: version },
  };
}

/** The team file's settings, null when there is none; refused when init could not rewrite it safely. */
function readTeamConfig(
  file: string,
): { ok: true; settings: Record<string, unknown> | null } | { ok: false; refusal: { kind: "config-invalid"; problems: ConfigProblem[] } } {
  if (!existsSync(file)) return { ok: true, settings: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, refusal: { kind: "config-invalid", problems: [{ kind: "invalid-json", file: TEAM_CONFIG, detail: (e as Error).message }] } };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, refusal: { kind: "config-invalid", problems: [{ kind: "not-an-object", file: TEAM_CONFIG }] } };
  }
  return { ok: true, settings: raw as Record<string, unknown> };
}

function exists(p: string) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function ensureGitignored(cwd: string, entries: string[]) {
  const file = join(cwd, ".gitignore");
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const present = new Set(text.split("\n").map((l) => l.trim()));
  const missing = entries.filter((e) => !present.has(e));
  if (!missing.length) return;
  if (text && !text.endsWith("\n")) text += "\n";
  writeFileSync(file, text + missing.map((e) => `${e}\n`).join(""));
}

const START = "<!-- norn:start -->";
const END = "<!-- norn:end -->";

/** What an agent in this project needs to know to find the process. */
export const AGENT_INSTRUCTIONS = [
  START,
  "## norn",
  "",
  "This repository runs its work through norn. GitHub labels, relations, comments and branches hold the state, and only norn changes them.",
  "",
  "- To work on an issue, use the norn-drive skill: `norn-drive <issue>`. It takes the issue through the attended steps with the user.",
  "- To run a sliced story unattended, use the norn-deliver skill: `norn-deliver <story>`.",
  "- Without the skills: `norn next <issue>` says what can be done now, and `norn take <issue>` claims an item and gives the briefing to follow to the end. Use `npx norn` if `norn` is not on the PATH.",
  "- Never change norn's labels, claims or branches by hand.",
  END,
].join("\n");

/** Which of AGENTS.md and CLAUDE.md hold the norn block. */
export function filesWithAgentInstructions(cwd: string): string[] {
  return ["AGENTS.md", "CLAUDE.md"].filter((name) => {
    const file = join(cwd, name);
    return existsSync(file) && readFileSync(file, "utf8").includes(START);
  });
}

/**
 * Writes AGENT_INSTRUCTIONS into each of AGENTS.md and CLAUDE.md that exists,
 * replacing an earlier norn block; with neither, creates AGENTS.md and a CLAUDE.md
 * that imports it. A CLAUDE.md that imports AGENTS.md is left alone.
 */
function writeAgentInstructions(cwd: string): string[] {
  const agents = join(cwd, "AGENTS.md");
  const claude = join(cwd, "CLAUDE.md");
  if (!existsSync(agents) && !existsSync(claude)) {
    writeFileSync(agents, `${AGENT_INSTRUCTIONS}\n`);
    writeFileSync(claude, "@AGENTS.md\n");
    return ["AGENTS.md", "CLAUDE.md"];
  }
  const written: string[] = [];
  for (const [name, file] of [
    ["AGENTS.md", agents],
    ["CLAUDE.md", claude],
  ] as const) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (name === "CLAUDE.md" && existsSync(agents) && /^@AGENTS\.md\s*$/m.test(text)) continue;
    const start = text.indexOf(START);
    const end = text.indexOf(END, start);
    const next =
      start !== -1 && end !== -1
        ? text.slice(0, start) + AGENT_INSTRUCTIONS + text.slice(end + END.length)
        : `${(text ? text.replace(/\n*$/, "\n\n") : "") + AGENT_INSTRUCTIONS}\n`;
    writeFileSync(file, next);
    written.push(name);
  }
  return written;
}
