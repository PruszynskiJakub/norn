import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

const TEAM = ".agents/psdd.config.json";
const LOCAL = ".agents/psdd.config.local.json";

function storyIn(state: string) {
  const w = setup();
  w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", state] });
  return w;
}

describe("configuration", () => {
  test("the team baseBranch is where story worktrees start", async () => {
    const w = storyIn("needs-plan");
    w.workspace.files.set(TEAM, JSON.stringify({ baseBranch: "develop" }));

    const res = await w.psdd("take", "123");

    expect(res.stdout).toContain(
      "git -C /repo fetch origin develop && git -C /repo worktree add --no-track /repo/.agents/worktrees/123-rate-limiting -b 123-rate-limiting origin/develop",
    );
  });

  test("the local provider wins over the team file", async () => {
    const w = storyIn("needs-plan");
    w.workspace.env = { HERDR_ENV: "1", CLAUDECODE: "1" };
    w.workspace.files.set(TEAM, JSON.stringify({ worktrees: { provider: "git" } }));
    w.workspace.files.set(LOCAL, JSON.stringify({ worktrees: { provider: "herdr" } }));

    const res = await w.psdd("take", "123");

    expect(res.stdout).toContain(
      "  git -C /repo fetch origin main && git -C /repo branch --no-track 123-rate-limiting origin/main && herdr worktree create --cwd /repo --branch 123-rate-limiting --path /repo/.agents/worktrees/123-rate-limiting --no-focus",
    );
  });

  test("auto detects herdr before Claude Code", async () => {
    const w = storyIn("needs-plan");
    w.workspace.env = { HERDR_ENV: "1", CLAUDECODE: "1" };
    expect((await w.psdd("take", "123")).stdout).toContain("herdr worktree create");
  });

  test("auto falls back to plain git", async () => {
    const w = storyIn("needs-plan");
    w.workspace.env = {};
    expect((await w.psdd("take", "123")).stdout).toContain("worktree add");
  });

  test("provider herdr without HERDR_ENV is refused before anything is claimed", async () => {
    const w = storyIn("needs-plan");
    w.workspace.env = { CLAUDECODE: "1" };
    w.workspace.files.set(LOCAL, JSON.stringify({ worktrees: { provider: "herdr" } }));

    const res = await w.psdd("take", "123");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("The worktree provider is herdr, but HERDR_ENV is not set.");
    expect(res.stdout).toContain("Start from a herdr pane, or switch the provider in .agents/psdd.config.local.json.");
    expect(w.github.claim(123)).toBeNull();
  });

  test("provider claude-code outside Claude Code is refused", async () => {
    const w = storyIn("needs-plan");
    w.workspace.env = {};
    w.workspace.files.set(LOCAL, JSON.stringify({ worktrees: { provider: "claude-code" } }));
    const res = await w.psdd("next", "123");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("The worktree provider is claude-code, but CLAUDECODE is not set.");
  });

  test("claims.staleAfter sets when a claim counts as abandoned", async () => {
    const w = storyIn("needs-plan");
    w.workspace.files.set(TEAM, JSON.stringify({ claims: { staleAfter: "30m" } }));
    w.setNow("2026-10-13T10:00:00Z");
    await w.as("crashed")("take", "123");
    w.setNow("2026-10-13T10:31:00Z");

    expect((await w.psdd("take", "123")).exitCode).toBe(0);
  });

  test.each([
    [{ claims: { staleAfter: "10m" } }, "claims.staleAfter"],
    [{ deliver: { maxFixRounds: 5 } }, "deliver.maxFixRounds"],
  ])("%j in the local file is ignored with a warning: it binds the whole team", async (local, key) => {
    const w = storyIn("needs-plan");
    w.workspace.files.set(LOCAL, JSON.stringify(local));
    const res = await w.psdd("take", "123");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`psdd warning:\n  ${LOCAL}: ${key} is shared by the team, so psdd ignores it here; set it in ${TEAM}`);
    expect(res.stdout).toContain("You now hold story #123");
  });

  test("a local claims.staleAfter does not change when a teammate's claim is stale", async () => {
    const w = storyIn("needs-plan");
    w.workspace.files.set(LOCAL, JSON.stringify({ claims: { staleAfter: "15m" } }));
    w.setNow("2026-10-13T10:00:00Z");
    await w.as("teammate")("take", "123");
    w.setNow("2026-10-13T10:20:00Z");

    expect((await w.psdd("take", "123")).exitCode).toBe(1);
  });

  test("with --json the warning is a field, not part of the message", async () => {
    const w = storyIn("needs-plan");
    w.workspace.files.set(LOCAL, JSON.stringify({ deliver: { maxFixRounds: 5 } }));
    const body = JSON.parse((await w.psdd("status", "123", "--json")).stdout);
    expect(body.ok).toBe(true);
    expect(body.warnings).toEqual([`${LOCAL}: deliver.maxFixRounds is shared by the team, so psdd ignores it here; set it in ${TEAM}`]);
    expect(body.message).not.toContain("warning");
  });

  test("deliver.maxParallel stays a per-developer setting", async () => {
    const w = storyIn("needs-plan");
    w.workspace.files.set(LOCAL, JSON.stringify({ deliver: { maxParallel: 4 } }));
    const res = await w.psdd("take", "123");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain("warning");
  });

  test("claims.staleAfter below 10m is raised to 10m with a warning", async () => {
    const w = storyIn("needs-plan");
    w.workspace.files.set(TEAM, JSON.stringify({ claims: { staleAfter: "0s" } }));
    w.setNow("2026-10-13T10:00:00Z");
    const first = await w.as("teammate")("take", "123");
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain(`${TEAM}: claims.staleAfter 0s is below the 10m minimum, so psdd uses 10m`);

    w.setNow("2026-10-13T10:09:00Z");
    expect((await w.psdd("take", "123")).exitCode).toBe(1);
    w.setNow("2026-10-13T10:11:00Z");
    expect((await w.psdd("take", "123")).exitCode).toBe(0);
  });

  test("a config the CLI cannot read is refused with the file and the problem", async () => {
    const w = storyIn("needs-plan");
    w.workspace.files.set(TEAM, JSON.stringify({ worktrees: { provider: "tmux" } }));
    const res = await w.psdd("take", "123");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(`${TEAM}: worktrees.provider must be one of auto, herdr, claude-code, git`);
  });

  test("labels are not configurable", async () => {
    const w = storyIn("needs-plan");
    w.workspace.files.set(TEAM, JSON.stringify({ labels: { "needs-plan": "planning" } }));
    const res = await w.psdd("take", "123");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(`${TEAM}: unknown setting "labels"`);
  });
});
