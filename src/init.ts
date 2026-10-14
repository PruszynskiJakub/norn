import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { DEFAULT_TEAM_CONFIG, LOCAL_CONFIG, TEAM_CONFIG } from "./config.js";
import { join } from "node:path";
import type { GitHub } from "./github.js";
import { FLAGS, STATES } from "./machine.js";

/** Skills psdd briefings name. */
export const SKILLS = ["triage", "refine", "clarify", "plan", "slice", "tdd", "review", "qa", "merge", "resolve"] as const;

const DESCRIPTIONS: Record<string, [string, string]> = {
  "needs-refinement": ["c5def5", "Triaged; the spec is being refined"],
  "needs-clarification": ["fbca04", "Refinement found questions or unknowns"],
  "needs-plan": ["c5def5", "All questions answered; plan goes into the spec"],
  "needs-slicing": ["c5def5", "Plan done; slices to be created"],
  blocked: ["b60205", "Has an open native blocked-by relation"],
  "ready-for-agent": ["0e8a16", "Unblocked, can be picked up"],
  implementation: ["1d76db", "Story: slices in progress. Slice: tdd"],
  "needs-review": ["5319e7", "Code review of the slice PR or the story PR"],
  "changes-requested": ["d93f0b", "Review asked for changes"],
  "needs-qa": ["5319e7", "QA by agent (mode:afk) or human (mode:hil)"],
  "qa-failed": ["d93f0b", "QA found problems"],
  "merge-queue": ["0e8a16", "Implementation done, review has no requests, QA approved"],
  "type:story": ["ededed", "psdd story state machine"],
  "type:slice": ["ededed", "psdd slice state machine"],
  "in-progress": ["fef2c0", "Someone holds the claim (mirror of the git-ref claim)"],
  "needs-human": ["e11d21", "A person is needed; cleared with the resolve skill"],
  "mode:afk": ["bfdadc", "QA by an agent running tests"],
  "mode:hil": ["bfdadc", "QA by a human"],
};

export function labelDefinitions() {
  return [...STATES, ...FLAGS].map((name) => ({ name, color: DESCRIPTIONS[name][0], description: DESCRIPTIONS[name][1] }));
}

export interface InitDeps {
  github: GitHub;
  cwd: string;
  installSkills: (cwd: string) => Promise<void>;
}

export async function init({ github, cwd, installSkills }: InitDeps): Promise<{ ok: boolean; lines: string[] }> {
  await installSkills(cwd);
  const skillsDir = join(cwd, "skills");
  const installed = existsSync(skillsDir) ? readdirSync(skillsDir).filter((d) => existsSync(join(skillsDir, d, "SKILL.md"))) : [];
  const missing = SKILLS.filter((s) => !installed.includes(s));
  if (missing.length) {
    return {
      ok: false,
      lines: [`Missing skills: ${missing.join(", ")}. The skill install did not provide them into skills/.`, "Fix the install and run psdd init again."],
    };
  }

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
  if (!existsSync(teamConfig)) writeFileSync(teamConfig, JSON.stringify(DEFAULT_TEAM_CONFIG, null, 2) + "\n");
  ensureGitignored(cwd, [".agents/worktrees/", LOCAL_CONFIG]);

  await github.ensureLabels(labelDefinitions());

  return {
    ok: true,
    lines: [
      "psdd is set up in this project:",
      `  - ${installed.length} skills in skills/, linked into .claude/skills/`,
      "  - .agents/specs/ for story specs",
      `  - ${TEAM_CONFIG} with the team settings (each developer can override in ${LOCAL_CONFIG})`,
      "  - .agents/worktrees/ and the local config in .gitignore",
      `  - ${labelDefinitions().length} labels on the repository`,
      "",
      "Commit skills/, .claude/skills/, .agents/ and .gitignore. Then start a story with: psdd next <story>",
    ],
  };
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
  writeFileSync(file, text + missing.map((e) => e + "\n").join(""));
}
