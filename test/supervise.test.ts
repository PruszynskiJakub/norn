import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Ctx, RUN_MARK } from "@norn/core";
import { cleanEnv, herdrDriver, paneEnv, type RunEvent, readRecord, runAgent, runPrompt, supervise, supervisorEnv, type Wake } from "@norn/cli";
import { processDriver, setup } from "@norn/testing";

const SESSION = "run-131-ab12";
// A new issue: norn take claims it for triage, as a run's agent would any step.
const issue = { number: 131, title: "Per-key limits" };

/** A run of #131 under the fake herdr, with clocks short enough for a test. */
async function herdrRun(rules: Partial<Ctx["config"]["run"]> = {}) {
  const w = setup({ session: SESSION });
  w.workspace.root = mkdtempSync(join(tmpdir(), "norn-run-"));
  w.github.seedIssue(issue);
  const ctx = { ...(await w.ctx()), runs: w.deps.runs };
  ctx.config.run = { ...ctx.config.run, stallAfterMs: 10_000, timeoutMs: 10_000, maxAttempts: 3, ...rules };
  ctx.config.notifications = "herdr";
  const worktree = join(w.workspace.root, ".agents/worktrees/131-per-key-limits");
  const driver = herdrDriver({
    herdr: (args) => w.herdr.run(args),
    root: w.workspace.root,
    issue: 131,
    agent: { kind: "claude", args: ["--model", "opus"] },
    graceMs: 0,
    pauseMs: 0,
  });
  const events: RunEvent[] = [];
  const go = (env: Record<string, string> = {}) =>
    supervise(
      ctx,
      { issue: 131, story: 131, session: SESSION, agent: "claude", worktree, log: "" },
      {
        driver,
        tickMs: 5,
        env,
        prompt: runPrompt,
        log: (e) => events.push(e),
      },
    );
  // What the run's own agent does as the run's session: take the issue, or finish its step.
  const agent = {
    take: () => w.as(SESSION)("take", "131"),
    finish: () => w.as(SESSION)("done", "131", "story"),
  };
  const wakeDir = join(w.workspace.root, ".agents/runs/wakes");
  const wake = () => JSON.parse(readFileSync(join(wakeDir, readdirSync(wakeDir).filter((f) => f.endsWith(".json"))[0]), "utf8")) as Wake;
  const runComments = () => w.github.comments(131).filter((c) => c.startsWith(RUN_MARK));
  return { w, herdr: w.herdr, ctx, worktree, go, agent, wake, runComments, events };
}

describe("a run's supervisor", () => {
  test("starts the agent in its own pane of the worktree, as the run's session, and settles from GitHub", async () => {
    const r = await herdrRun();
    r.herdr.onPrompt = async (pane) => {
      await r.agent.take();
      await r.agent.finish();
      pane.agent!.status = "done";
    };

    expect(await r.go()).toEqual({ kind: "finished" });

    const [pane] = r.herdr.allPanes();
    expect(pane.cwd).toBe(r.worktree);
    expect(pane.label).toBe("norn-131");
    expect(pane.env).toEqual({ NORN_SESSION: SESSION, NORN_RUN: "131" });
    expect(r.herdr.called("worktree", "open")).toEqual([["worktree", "open", "--cwd", r.w.workspace.root, "--path", r.worktree, "--no-focus"]]);
    expect(r.herdr.called("agent", "start")).toEqual([["agent", "start", "norn-131", "--kind", "claude", "--pane", pane.id, "--", "--model", "opus"]]);
    expect(pane.prompts).toEqual([expect.stringContaining("Run norn take 131, follow its briefing to the end")]);
    expect(pane.prompts[0]).toContain("Never end your turn while you hold the claim");
    expect(r.wake()).toMatchObject({ issue: 131, settled: { kind: "finished" }, attempts: 1 });
    expect(r.runComments()).toEqual([]);
    // A finished step's pane is closed; what it showed stays in the attempt's log.
    expect(pane.closed).toBe(true);
    expect(readRecord(r.w.workspace.root, 131)).toMatchObject({ state: "finished", pane: pane.id, session: SESSION });
  });

  test("records the agent's pane as soon as it exists, before the agent is ready", async () => {
    const r = await herdrRun();
    let recorded: string | null | undefined;
    r.herdr.onPrompt = async (pane) => {
      await r.agent.take();
      await r.agent.finish();
      pane.agent!.status = "done";
    };
    const run = r.herdr.run;
    r.herdr.run = async (args) => {
      // While herdr starts the agent, the run's record already names its pane.
      if (args[0] === "agent" && args[1] === "start") recorded = readRecord(r.w.workspace.root, 131)?.pane;
      return run(args);
    };

    await r.go();

    expect(recorded).toBe(r.herdr.allPanes()[0].id);
  });

  test("passes run.env into the agent's pane, reading a $NAME value from its own environment", async () => {
    const r = await herdrRun({ env: { GH_TOKEN: "$NORN_AGENT_TOKEN", MODE: "ci", UNSET: "$NOT_THERE" } });
    r.herdr.onPrompt = async (pane) => {
      await r.agent.take();
      await r.agent.finish();
      pane.agent!.status = "done";
    };

    await r.go({ NORN_AGENT_TOKEN: "github_pat_x" });

    expect(r.herdr.allPanes()[0].env).toEqual({ GH_TOKEN: "github_pat_x", MODE: "ci", NORN_SESSION: SESSION, NORN_RUN: "131" });
  });

  test("a working agent whose screen does not change for stallAfter is stopped with Ctrl-C and its pane closed, then started afresh", async () => {
    const r = await herdrRun({ stallAfterMs: 60, maxAttempts: 2 });
    let prompts = 0;
    r.herdr.onPrompt = async (pane) => {
      prompts++;
      await r.agent.take();
      if (prompts === 1) pane.agent!.status = "working";
      else {
        await r.agent.finish();
        pane.agent!.status = "done";
      }
    };

    await r.go();

    const [first, second] = r.herdr.allPanes();
    expect(first.keys).toEqual(["ctrl+c", "ctrl+c"]);
    expect(first.closed).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(second.prompts[0]).toContain("Your previous attempt at this step ended without finishing it (stalled: its screen did not change for");
    expect(r.runComments()).toEqual([expect.stringMatching(/^norn: run — attempt 1 of 2: stalled: its screen did not change for /)]);
    expect(r.wake().settled).toEqual({ kind: "finished" });
  });

  test("an agent whose screen keeps changing is not stalled, but is stopped at the timeout", async () => {
    const r = await herdrRun({ stallAfterMs: 60, timeoutMs: 150, maxAttempts: 1 });
    r.herdr.onPrompt = async (pane) => {
      await r.agent.take();
      pane.agent!.status = "working";
      const t = setInterval(() => {
        pane.screen += ".";
      }, 10);
      setTimeout(() => clearInterval(t), 1000);
    };

    expect(await r.go()).toMatchObject({ kind: "escalated", end: { kind: "timed-out" } });
    expect(r.runComments()).toEqual([expect.stringMatching(/attempt 1 of 1: timed out after /)]);
  });

  test("a blocked agent pauses the stall and timeout clocks and notifies the user once", async () => {
    const r = await herdrRun({ stallAfterMs: 40, timeoutMs: 80 });
    r.herdr.onPrompt = async (pane) => {
      await r.agent.take();
      pane.agent!.status = "blocked";
      setTimeout(async () => {
        await r.agent.finish();
        pane.agent!.status = "done";
      }, 250);
    };

    await r.go();

    expect(readRecord(r.w.workspace.root, 131)?.attempts).toEqual([
      expect.objectContaining({ settled: "finished", end: { kind: "stopped-early", state: "done" } }),
    ]);
    expect(r.runComments()).toEqual([]);
    expect(r.w.notifications).toEqual([
      { channel: "herdr", title: "norn: #131 needs you", body: expect.stringContaining(`Its agent waits for you in herdr pane ${r.herdr.allPanes()[0].id}.`) },
    ]);
  });

  test("an agent blocked longer than blockedAfter needs a human: the issue is escalated and the pane left as it is", async () => {
    const r = await herdrRun({ blockedAfterMs: 60 });
    r.herdr.onPrompt = async (pane) => {
      await r.agent.take();
      pane.agent!.status = "blocked";
    };

    expect(await r.go()).toMatchObject({ kind: "escalated", attempts: 1, end: { kind: "blocked" } });

    const [pane] = r.herdr.allPanes();
    expect(pane.closed).toBe(false);
    expect(pane.keys).toEqual([]);
    expect(r.w.github.labels(131)).toContain("needs-human");
  });

  test("an agent that goes idle holding the claim counts as an attempt and is prompted again in the same pane", async () => {
    const r = await herdrRun();
    let prompts = 0;
    r.herdr.onPrompt = async (pane) => {
      prompts++;
      await r.agent.take();
      if (prompts === 2) await r.agent.finish();
      pane.agent!.status = "idle";
    };

    await r.go();

    const panes = r.herdr.allPanes();
    expect(panes).toHaveLength(1);
    expect(r.herdr.called("agent", "start")).toHaveLength(1);
    expect(panes[0].prompts[1]).toContain("Your previous attempt at this step ended without finishing it (the agent stopped (idle)");
    expect(r.runComments()).toEqual([expect.stringMatching(/^norn: run — attempt 1 of 3: the agent stopped \(idle\) without finishing its step/)]);
    expect(r.wake().settled).toEqual({ kind: "finished" });
  });

  test("an agent that keeps stopping early is escalated once the budget is spent, and its pane is left for a person", async () => {
    const r = await herdrRun({ maxAttempts: 2 });
    r.herdr.onPrompt = async (pane) => {
      await r.agent.take();
      pane.agent!.status = "done";
    };

    await r.go();

    const [pane] = r.herdr.allPanes();
    expect(pane.prompts).toHaveLength(2);
    expect(pane.closed).toBe(false);
    expect(r.wake()).toMatchObject({ settled: { kind: "escalated", attempts: 2 }, attempts: 2 });
    expect(r.w.github.labels(131)).toContain("needs-human");
  });

  test("a pane that goes away is a failed attempt: a fresh agent starts in a new pane", async () => {
    const r = await herdrRun();
    let prompts = 0;
    r.herdr.onPrompt = async (pane) => {
      prompts++;
      await r.agent.take();
      if (prompts === 1) {
        pane.agent!.status = "working";
        setTimeout(() => r.herdr.closePane(pane.id), 20);
      } else {
        await r.agent.finish();
        pane.agent!.status = "done";
      }
    };

    await r.go();

    expect(r.herdr.called("agent", "start")).toHaveLength(2);
    expect(r.runComments()).toEqual([expect.stringMatching(/^norn: run — attempt 1 of 3: the agent's herdr pane went away/)]);
    expect(r.wake().settled).toEqual({ kind: "finished" });
  });

  test("unknown is not settled on: the run waits for GitHub, and the stall rule still applies", async () => {
    const r = await herdrRun({ stallAfterMs: 60, maxAttempts: 1 });
    r.herdr.onPrompt = async (pane) => {
      await r.agent.take();
      pane.agent!.status = "unknown";
    };

    await r.go();

    expect(r.runComments()).toEqual([expect.stringMatching(/^norn: run — attempt 1 of 1: stalled/)]);
    expect(r.wake().settled.kind).toBe("escalated");
  });

  test("an agent name taken by a live agent elsewhere gets the run's own suffix", async () => {
    const r = await herdrRun();
    r.herdr.addAgent("norn-131");
    r.herdr.onPrompt = async (pane) => {
      await r.agent.take();
      await r.agent.finish();
      pane.agent!.status = "done";
    };

    await r.go();

    expect(r.herdr.called("agent", "start")[0][2]).toBe("norn-131-ab12");
  });

  test("an agent kind herdr does not know fails each attempt without a pane left behind, then escalates", async () => {
    const r = await herdrRun({ maxAttempts: 2 });
    const driver = herdrDriver({ herdr: r.herdr.run, root: r.w.workspace.root, issue: 131, agent: { kind: "cluade", args: [] }, graceMs: 0, pauseMs: 0 });

    const settled = await supervise(
      r.ctx,
      { issue: 131, story: 131, session: SESSION, agent: "cluade", worktree: r.worktree, log: "" },
      {
        driver,
        tickMs: 5,
        prompt: runPrompt,
        log: () => {},
      },
    );

    expect(settled).toMatchObject({ kind: "escalated", end: { kind: "not-started" } });
    expect(r.herdr.allPanes().every((p) => p.closed)).toBe(true);
    expect(r.runComments()[0]).toContain("the agent could not start: herdr agent start failed: unsupported interactive agent kind: cluade");
  });
});

describe("a run and its claim", () => {
  test("another session's stale claim before the agent's take is not lost: the agent takes it over and the run goes on", async () => {
    const r = await herdrRun();
    await r.w.github.createClaim(131, { holder: "alice", session: "frozen-run", since: "2026-10-13T09:00:00Z", leaseMs: 600_000 });
    r.herdr.onPrompt = async (pane) => {
      await new Promise((ok) => setTimeout(ok, 30));
      await r.agent.take();
      await r.agent.finish();
      pane.agent!.status = "done";
    };

    expect(await r.go()).toEqual({ kind: "finished" });
  });

  test("released by its agent without moving the issue is not finished: norn take moved it, and that is where it was", async () => {
    const r = await herdrRun({ maxAttempts: 1 });
    r.herdr.onPrompt = async (pane) => {
      // norn take moves a new issue into triage; the agent then gives up without a transition.
      await r.agent.take();
      await r.w.as(SESSION)("release", "131");
      pane.agent!.status = "idle";
    };

    expect(await r.go()).toMatchObject({ kind: "escalated" });
  });

  test("a run whose claim another session took after its lease ran out stops its agent and records lost", async () => {
    const r = await herdrRun({ leaseMs: 1000 });
    r.herdr.onPrompt = async (pane) => {
      await r.agent.take();
      pane.agent!.status = "working";
      setTimeout(async () => {
        // The machine slept: the lease ran out, and another machine's run took the issue over.
        await r.w.github.deleteClaim(131);
        await r.w.github.createClaim(131, { holder: "alice", session: "run-131-other", since: "2026-10-13T12:20:00Z" });
      }, 30);
    };

    expect(await r.go()).toMatchObject({ kind: "lost", session: "run-131-other" });

    const [pane] = r.herdr.allPanes();
    expect(pane.closed).toBe(true);
    expect(r.runComments()).toEqual([]);
    expect(r.events).toContainEqual({ kind: "stopping", why: { kind: "lost-claim" } });
  });

  test("renews the claim with the run's lease while the agent works", async () => {
    const r = await herdrRun();
    r.herdr.onPrompt = async (pane) => {
      await r.agent.take();
      pane.agent!.status = "working";
      setTimeout(async () => {
        expect(r.w.github.claim(131)).toMatchObject({ session: SESSION, leaseMs: 600_000 });
        await r.agent.finish();
        pane.agent!.status = "done";
      }, 40);
    };

    expect(await r.go()).toEqual({ kind: "finished" });
    expect(r.events).toContainEqual({ kind: "taken" });
  });
});

describe("a run and GitHub failing", () => {
  test("a GitHub call that fails while settling is tried again, not the end of the run", async () => {
    const r = await herdrRun();
    let blip = false;
    r.herdr.onPrompt = async (pane) => {
      await r.agent.take();
      await r.agent.finish();
      blip = true;
      pane.agent!.status = "done";
    };
    const listComments = r.w.github.listComments.bind(r.w.github);
    r.w.github.listComments = async (n: number) => {
      // Settling's read fails once, as a network blip would.
      if (blip) {
        blip = false;
        throw new Error("gh: connection reset");
      }
      return listComments(n);
    };

    const settled = await supervise(
      r.ctx,
      { issue: 131, story: 131, session: SESSION, agent: "claude", worktree: r.worktree, log: "" },
      {
        driver: herdrDriver({ herdr: r.herdr.run, root: r.w.workspace.root, issue: 131, agent: { kind: "claude", args: [] }, graceMs: 0, pauseMs: 0 }),
        tickMs: 5,
        retryMs: [1],
        prompt: runPrompt,
        log: (e) => r.events.push(e),
      },
    );

    expect(settled).toEqual({ kind: "finished" });
    expect(r.events).toContainEqual({ kind: "tick-failed", detail: "gh: connection reset" });
  });
});

describe("a run with a scripted process for its agent", () => {
  test("an agent that exits without finishing its step is retried, then escalated", async () => {
    const w = setup({ session: SESSION });
    w.workspace.root = mkdtempSync(join(tmpdir(), "norn-process-"));
    w.github.seedIssue(issue);
    const ctx = { ...(await w.ctx()), runs: w.deps.runs };
    ctx.config.run = { ...ctx.config.run, maxAttempts: 2 };

    const settled = await supervise(
      ctx,
      { issue: 131, story: 131, session: SESSION, agent: "fake", worktree: w.workspace.root, log: "" },
      {
        driver: processDriver(() => 'echo "$NORN_SESSION"; exit 3'),
        tickMs: 5,
        prompt: runPrompt,
        log: () => {},
      },
    );

    expect(settled).toMatchObject({ kind: "escalated", attempts: 2 });
    expect(w.github.comments(131).filter((c) => c.startsWith(RUN_MARK))).toEqual([
      "norn: run — attempt 1 of 2: the agent exited 3 without finishing its step, after 0m",
      "norn: run — attempt 2 of 2: the agent exited 3 without finishing its step, after 0m",
    ]);
    expect(readFileSync(join(w.workspace.root, ".agents/runs/131/attempt-1.log"), "utf8")).toBe(`${SESSION}\n`);
  });

  test("a hung agent is stopped at the stall, its whole process group killed", async () => {
    const w = setup({ session: SESSION });
    w.workspace.root = mkdtempSync(join(tmpdir(), "norn-process-"));
    w.github.seedIssue(issue);
    const ctx = { ...(await w.ctx()), runs: w.deps.runs };
    ctx.config.run = { ...ctx.config.run, maxAttempts: 1, stallAfterMs: 100 };

    const settled = await supervise(
      ctx,
      { issue: 131, story: 131, session: SESSION, agent: "fake", worktree: w.workspace.root, log: "" },
      {
        driver: processDriver(() => "sleep 30"),
        tickMs: 10,
        prompt: runPrompt,
        log: () => {},
      },
    );

    expect(settled).toMatchObject({ kind: "escalated", end: { kind: "stalled" } });
  });
});

describe("a run's environment", () => {
  test("the supervisor keeps herdr's socket; neither it nor the agent gets the caller's pane, agent tool or session", () => {
    const env = { PATH: "/bin", HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s.sock", HERDR_PANE_ID: "w1:p1", NORN_SESSION: "me", CLAUDECODE: "1" };
    expect(supervisorEnv(env)).toEqual({ PATH: "/bin", HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s.sock" });
    expect(cleanEnv(env)).toEqual({ PATH: "/bin" });
  });

  test("run.env values are literal, or $NAME read from the environment, and left out when unset", () => {
    expect(paneEnv({ A: "x", B: "$TOKEN", C: "$MISSING", D: "a$b" }, { TOKEN: "t" })).toEqual({ A: "x", B: "t", D: "a$b" });
  });

  test("an agent's herdr kind comes from run.agents, else from its name", () => {
    const agents = { opus: { kind: "claude", args: ["--model", "opus"] } };
    expect(runAgent(agents, "opus")).toEqual({ kind: "claude", args: ["--model", "opus"] });
    expect(runAgent(agents, "codex")).toEqual({ kind: "codex", args: [] });
  });
});
