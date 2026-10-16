import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { DEFAULT_TEAM_CONFIG, LOCAL_CONFIG, TEAM_CONFIG } from "./config.js";
import { join } from "node:path";
import type { GitHub } from "./github.js";
import { FLAGS, STATES } from "./machine.js";

/** Skills psdd briefings name. */
export const SKILLS = [
  "triage",
  "refine",
  "clarify",
  "plan",
  "slice",
  "implement",
  "review",
  "auto-qa",
  "qa",
  "merge",
  "resolve",
  "drive",
  "deliver",
  "tdd",
  "interview",
  "codebase-design",
] as const;

const DESCRIPTIONS: Record<string, [string, string]> = {
  "needs-refinement": ["c5def5", "Triaged; the spec is being refined"],
  "needs-clarification": ["fbca04", "Refinement found questions or unknowns"],
  "needs-plan": ["c5def5", "All questions answered; plan goes into the spec"],
  "needs-slicing": ["c5def5", "Plan done; slices to be created"],
  blocked: ["b60205", "Has an open native blocked-by relation"],
  "ready-for-agent": ["0e8a16", "Unblocked, can be picked up"],
  implementation: ["1d76db", "Story: slices in progress. Slice: implement"],
  "needs-review": ["5319e7", "Code review of the slice PR or the story PR"],
  "changes-requested": ["d93f0b", "Review asked for changes"],
  "needs-qa": ["5319e7", "QA by an agent, with evidence"],
  "needs-human-qa": ["e99695", "QA by a person, after the agent's"],
  "qa-failed": ["d93f0b", "QA found problems"],
  "merge-queue": ["0e8a16", "Implementation done, review has no requests, QA passed"],
  "type:story": ["ededed", "psdd story state machine"],
  "type:slice": ["ededed", "psdd slice state machine"],
  "in-progress": ["fef2c0", "Someone holds the claim (mirror of the git-ref claim)"],
  "needs-human": ["e11d21", "A person is needed; cleared with the resolve skill"],
  "mode:afk": ["bfdadc", "QA by an agent only"],
  "mode:hil": ["bfdadc", "QA by an agent, then by a person"],
};

export function labelDefinitions() {
  return [...STATES, ...FLAGS].map((name) => ({ name, color: DESCRIPTIONS[name][0], description: DESCRIPTIONS[name][1] }));
}

export interface InitDeps {
  github: GitHub;
  cwd: string;
  /** Returns the names of the skills it updated. */
  installSkills: (cwd: string) => Promise<string[]>;
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
}

/** The skill install left out skills psdd briefings name. */
export interface MissingSkills {
  kind: "missing-skills";
  missing: string[];
}

export async function init({ github, cwd, installSkills }: InitDeps): Promise<InitResult | { ok: false; refusal: MissingSkills }> {
  const updated = await installSkills(cwd);
  const skillsDir = join(cwd, "skills");
  const installed = existsSync(skillsDir) ? readdirSync(skillsDir).filter((d) => existsSync(join(skillsDir, d, "SKILL.md"))) : [];
  const missing = SKILLS.filter((s) => !installed.includes(s));
  if (missing.length) return { ok: false, refusal: { kind: "missing-skills", missing } };

  const linkDir = join(cwd, ".claude", "skills");
  mkdirSync(linkDir, { recursive: true });
  for (const name of installed) {
    const link = join(linkDir, name);
    if (exists(link)) continue;
    symlinkSync(join("..", "..", "skills", name), link, "dir");
  }

  const specs = join(cwd, ".agents", "specs");
  mkdirSync(specs, { recursive: true });
  if (readdirSync(specs).length === 0) writeFileSync(join(specs, ".gitkeep"), "");

  const teamConfig = join(cwd, TEAM_CONFIG);
  if (!existsSync(teamConfig)) {
    const config = { ...DEFAULT_TEAM_CONFIG, baseBranch: await github.defaultBranch() };
    writeFileSync(teamConfig, `${JSON.stringify(config, null, 2)}\n`);
  }
  ensureGitignored(cwd, [".agents/worktrees/", LOCAL_CONFIG]);
  const instructed = writeAgentInstructions(cwd);

  await github.ensureLabels(labelDefinitions());

  return { ok: true, kind: "initialized", skills: installed.length, updated, instructed, labels: labelDefinitions().length };
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

const START = "<!-- psdd:start -->";
const END = "<!-- psdd:end -->";

/** What an agent in this project needs to know to find the process. */
export const AGENT_INSTRUCTIONS = [
  START,
  "## psdd",
  "",
  "This repository runs its work through psdd. GitHub labels, relations, comments and branches hold the state, and only psdd changes them.",
  "",
  "- To work on an issue, use the drive skill: `drive <issue>`. It takes the issue through the attended steps with the user.",
  "- To run a sliced story unattended, use the deliver skill: `deliver <story>`.",
  "- Without the skills: `psdd next <issue>` says what can be done now, and `psdd take <issue>` claims an item and gives the briefing to follow to the end. Use `npx psdd` if `psdd` is not on the PATH.",
  "- Never change psdd's labels, claims or branches by hand.",
  END,
].join("\n");

/**
 * Writes AGENT_INSTRUCTIONS into each of AGENTS.md and CLAUDE.md that exists,
 * replacing an earlier psdd block; with neither, creates AGENTS.md and a CLAUDE.md
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
