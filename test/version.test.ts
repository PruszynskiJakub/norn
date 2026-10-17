import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SKILLS } from "@norn/cli";
import { setup } from "@norn/testing";

const TEAM = ".agents/norn.config.json";
const LOCAL = ".agents/norn.config.local.json";

/** Story #123 ready to take, with norn 1.4.2 running and the team file given. */
function repo(team: Record<string, unknown> | null, version = "1.4.2") {
  const w = setup({ version });
  w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan"] });
  if (team) w.workspace.files.set(TEAM, JSON.stringify(team));
  return w;
}

describe("nornVersion in the configuration", () => {
  test("in the local file it is refused: one developer cannot override the team's version", async () => {
    const w = repo({ nornVersion: "1.4.2" });
    w.workspace.files.set(LOCAL, JSON.stringify({ nornVersion: "1.4.2" }));

    const res = await w.norn("take", "123");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(`${LOCAL}: nornVersion is the team's; norn init sets it in ${TEAM}`);
    expect(w.github.claim(123)).toBeNull();
  });

  test.each(["1.4", "v1.4.2", "1.4.2-beta", "^1.4.2", 142])("%j is not a plain x.y.z, so it is a config problem", async (value) => {
    const w = repo({ nornVersion: value });
    const res = await w.norn("status", "123");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(`${TEAM}: nornVersion must be a plain version such as 1.2.3`);
  });

  test("a team file without it warns, and the command still runs", async () => {
    const w = repo({ baseBranch: "main" });

    const res = await w.norn("take", "123");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`norn warning:\n  ${TEAM}: nornVersion is not set; run norn init to record the norn version this repository uses`);
    expect(res.stdout).toContain("You now hold story #123");
  });

  test("with no team file at all there is no version warning", async () => {
    const res = await repo(null).norn("status", "123");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain("warning");
  });
});

describe("the running norn against the repository's nornVersion", () => {
  test("the same version or only a patch apart says nothing", async () => {
    for (const nornVersion of ["1.4.2", "1.4.0", "1.4.9"]) {
      const res = await repo({ nornVersion }).norn("status", "123");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain("warning");
    }
  });

  test("a newer compatible norn warns to run norn init", async () => {
    const res = await repo({ nornVersion: "1.2.0" }).norn("take", "123");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(
      `norn warning:\n  ${TEAM}: nornVersion is 1.2.0 and your norn is 1.4.2; run norn init to update the skills and nornVersion for the team`,
    );
  });

  test("an older compatible norn warns to upgrade it", async () => {
    const res = await repo({ nornVersion: "1.6.0" }).norn("take", "123");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(
      `norn warning:\n  ${TEAM}: nornVersion is 1.6.0 and your norn is 1.4.2; upgrade norn with npm install -D github:PruszynskiJakub/norn#v1.6.0`,
    );
  });

  test("with --json the version warning is in warnings", async () => {
    const body = JSON.parse((await repo({ nornVersion: "1.2.0" }).norn("status", "123", "--json")).stdout);
    expect(body.ok).toBe(true);
    expect(body.warnings).toEqual([`${TEAM}: nornVersion is 1.2.0 and your norn is 1.4.2; run norn init to update the skills and nornVersion for the team`]);
  });

  test("an older norn with another major version is refused before anything is claimed", async () => {
    const w = repo({ nornVersion: "2.0.0" });

    const res = await w.norn("take", "123");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe(
      [
        "This repository uses norn 2.0.0, which your norn 1.4.2 cannot work with.",
        "Upgrade norn: npm install -D github:PruszynskiJakub/norn#v2.0.0",
        "Then run norn doctor for a full check of the setup.",
      ].join("\n"),
    );
    expect(w.github.claim(123)).toBeNull();
  });

  test("a newer norn with another major version is refused, and says to run norn init", async () => {
    const res = await repo({ nornVersion: "0.9.0" }).norn("take", "123");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe(
      [
        "This repository uses norn 0.9.0, which your norn 1.4.2 cannot work with.",
        "Run norn init to bring the repository to 1.4.2 and commit the change, or install norn 0.9.0.",
        "Then run norn doctor for a full check of the setup.",
      ].join("\n"),
    );
  });

  test("while the major version is 0, a different minor version is incompatible", async () => {
    expect((await repo({ nornVersion: "0.8.0" }, "0.7.0").norn("status", "123")).exitCode).toBe(1);
    expect((await repo({ nornVersion: "0.6.5" }, "0.7.0").norn("status", "123")).exitCode).toBe(1);
    expect((await repo({ nornVersion: "0.7.3" }, "0.7.0").norn("status", "123")).stdout).not.toContain("warning");
  });

  test.each([["status", "123"], ["take", "123"], ["next", "123"], ["release", "123"], ["escalate", "123", "why"], ["tidy"], ["dashboard"]])(
    "norn %s refuses on an incompatible version",
    async (...argv) => {
      const w = repo({ nornVersion: "2.0.0" });
      const res = await w.norn(...argv);
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toContain("cannot work with");
      expect(w.launches).toEqual([]);
    },
  );

  test("--json carries the refusal", async () => {
    const body = JSON.parse((await repo({ nornVersion: "2.0.0" }).norn("status", "123", "--json")).stdout);
    expect(body.ok).toBe(false);
    expect(body.refusal).toContain("This repository uses norn 2.0.0");
  });
});

describe("norn --version", () => {
  test("prints the running version and nothing else", async () => {
    const res = await repo(null).norn("--version");
    expect(res).toEqual({ exitCode: 0, stdout: "1.4.2" });
  });

  test("works before any configuration is read", async () => {
    const w = repo(null);
    w.workspace.files.set(TEAM, "nope");
    expect(await w.norn("--version")).toEqual({ exitCode: 0, stdout: "1.4.2" });
  });
});

function project(version = "1.4.2") {
  const w = setup({ version });
  const cwd = mkdtempSync(join(tmpdir(), "norn-version-"));
  const installs: string[] = [];
  const norn = w.withProject(cwd, async (dir) => {
    installs.push(dir);
    for (const name of SKILLS) {
      mkdirSync(join(dir, ".agents", "skills", name), { recursive: true });
      writeFileSync(join(dir, ".agents", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    return ["norn-drive"];
  });
  const teamFile = join(cwd, TEAM);
  const writeTeam = (text: string) => {
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    writeFileSync(teamFile, text);
  };
  return { w, cwd, installs, norn, teamFile, writeTeam, readTeam: () => readFileSync(teamFile, "utf8") };
}

describe("norn init and nornVersion", () => {
  test("a new team file records the running version", async () => {
    const { norn, readTeam } = project();

    const res = await norn("init");

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(readTeam()).nornVersion).toBe("1.4.2");
    expect(res.stdout).toContain("  - nornVersion set to 1.4.2");
  });

  test("an older version is bumped, every other setting kept, and reported next to the updated skills", async () => {
    const { norn, writeTeam, readTeam } = project();
    writeTeam(JSON.stringify({ baseBranch: "develop", nornVersion: "1.2.0", worktrees: { provider: "herdr" }, deliver: { maxParallel: 5 } }));

    const res = await norn("init");

    expect(JSON.parse(readTeam())).toEqual({ baseBranch: "develop", nornVersion: "1.4.2", worktrees: { provider: "herdr" }, deliver: { maxParallel: 5 } });
    expect(res.stdout).toContain(
      ["  - updated to this norn version: norn-drive (git diff .agents/skills/ shows the changes)", `  - nornVersion 1.2.0 → 1.4.2 in ${TEAM}`].join("\n"),
    );
  });

  test("a team file without nornVersion gets it, and nothing else changes", async () => {
    const { norn, writeTeam, readTeam } = project();
    writeTeam('{ "baseBranch": "develop", "claims": { "staleAfter": "3h" } }\n');

    const res = await norn("init");

    expect(JSON.parse(readTeam())).toEqual({ nornVersion: "1.4.2", baseBranch: "develop", claims: { staleAfter: "3h" } });
    expect(res.stdout).toContain(`  - nornVersion set to 1.4.2 in ${TEAM}`);
  });

  test("at the same version the team file is left exactly as it is", async () => {
    const { norn, writeTeam, readTeam } = project();
    writeTeam('{"nornVersion":"1.4.2",   "baseBranch": "develop"}');

    const res = await norn("init");

    expect(readTeam()).toBe('{"nornVersion":"1.4.2",   "baseBranch": "develop"}');
    expect(res.stdout).not.toContain("nornVersion");
  });

  test("an older norn than the repository's is refused before anything is changed", async () => {
    const { w, norn, writeTeam, readTeam, installs, cwd } = project();
    writeTeam(JSON.stringify({ nornVersion: "1.4.3" }));

    const res = await norn("init");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe(
      [
        "This repository is set up with norn 1.4.3, newer than your norn 1.4.2. norn init would roll its skills back.",
        "Upgrade norn: npm install -D github:PruszynskiJakub/norn#v1.4.3, then run norn init again.",
      ].join("\n"),
    );
    expect(installs).toEqual([]);
    expect(readTeam()).toBe(JSON.stringify({ nornVersion: "1.4.3" }));
    expect(w.github.labelDefs.size).toBe(0);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
  });

  test("a team file init cannot read is refused before anything is changed", async () => {
    const { norn, writeTeam, installs } = project();
    writeTeam("{ nope");

    const res = await norn("init");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(`${TEAM}: not valid JSON`);
    expect(installs).toEqual([]);
  });

  test("it ends by suggesting norn doctor", async () => {
    const { norn } = project();
    const res = await norn("init");
    expect(res.stdout.split("\n").at(-1)).toBe("Run norn doctor to check what init cannot set up: gh, your access to the repository, the worktree provider.");
  });
});
