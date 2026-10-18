import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type DeliverEvent,
  deadRuns,
  deliver,
  liveRuns,
  herdrDriver,
  lockDelivery,
  readRecord,
  renderDeliverEvent,
  renderNext,
  runPrompt,
  type SupervisorStart,
  supervise,
  writeRecord,
} from "@norn/cli";
import type { AttemptEnd } from "@norn/core";
import { type FakePane, setup } from "@norn/testing";

const HERDR = { HERDR_ENV: "1" };

/** Story #123 in implementation, with slices #131.. in `state`, under herdr, in a root of its own. */
function story(slices: { n: number; state: string }[]) {
  const w = setup();
  w.workspace.root = mkdtempSync(join(tmpdir(), "norn-deliver-"));
  w.workspace.env = HERDR;
  w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
  w.github.branches.add("123-rate-limiting");
  for (const s of slices) {
    w.github.seedIssue({ number: s.n, title: `Slice ${s.n}`, labels: ["type:slice", "mode:hil", s.state] });
    w.github.parents.set(s.n, 123);
  }
  return w;
}

type W = ReturnType<typeof story>;

/**
 * Supervisors run in this process, against the fake herdr, and each agent is
 * scripted: it takes its issue as the run's session and does what `act`
 * says for the state it found, then goes idle.
 */
function inProcessRuns(w: W, act: (n: number, state: string, as: (...argv: string[]) => Promise<unknown>) => Promise<void>) {
  const running = new Set<number>();
  let most = 0;
  const done: Promise<unknown>[] = [];
  w.runs.onSupervisor = (s: SupervisorStart) => {
    running.add(s.issue);
    most = Math.max(most, running.size);
    done.push(
      (async () => {
        const ctx = { ...(await w.ctx()), session: s.session, runs: w.deps.runs };
        const driver = herdrDriver({ herdr: w.herdr.run, root: w.workspace.root, issue: s.issue, agent: { kind: "claude", args: [] }, graceMs: 0, pauseMs: 0 });
        await supervise(ctx, s, { driver, tickMs: 5, prompt: runPrompt, log: () => {} });
        running.delete(s.issue);
      })(),
    );
    return process.pid;
  };
  w.herdr.onPrompt = async (pane: FakePane) => {
    const n = Number(pane.env.NORN_RUN);
    const as = w.as(pane.env.NORN_SESSION);
    await as("take", String(n));
    const state = w.github.labels(n).find((l) => !l.startsWith("type:") && !l.startsWith("mode:") && l !== "in-progress") ?? "";
    await act(n, state, as);
    pane.agent!.status = "idle";
  };
  return { most: () => most, settled: () => Promise.all(done) };
}

async function deliverIt(w: W, story = 123) {
  const events: DeliverEvent[] = [];
  const r = await deliver({ ...(await w.ctx()), runs: w.deps.runs }, story, { pollMs: 5, nextEveryMs: 50, print: (e) => events.push(e) });
  return { r, events, lines: events.map(renderDeliverEvent) };
}

describe("norn run and norn deliver need herdr", () => {
  test("outside herdr both refuse and say why", async () => {
    const w = story([{ n: 131, state: "needs-review" }]);
    w.workspace.env = {};

    for (const cmd of ["run", "deliver"]) {
      const res = await w.norn(cmd, cmd === "run" ? "131" : "123");
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toContain(`norn ${cmd} starts each agent in a herdr pane, where you can watch it and step in, so it runs only inside herdr.`);
    }
    expect(w.runs.supervisors).toEqual([]);
  });

  test("they need the issue number", async () => {
    const w = story([]);
    expect(await w.norn("run")).toMatchObject({ exitCode: 2, stdout: "Give the issue number explicitly:\n  norn run <issue> [--agent <name>]" });
    expect(await w.norn("deliver")).toMatchObject({ exitCode: 2, stdout: "Give the issue number explicitly:\n  norn deliver <story>" });
  });
});

describe("norn run", () => {
  test("makes the item's worktree, then starts its supervisor as a session of its own and records the run", async () => {
    const w = story([{ n: 131, state: "needs-review" }]);
    w.nonces.push("ab12");

    const res = await w.norn("run", "131", "--agent", "codex");

    expect(res.exitCode).toBe(0);
    const worktree = join(w.workspace.root, ".agents/worktrees/123-rate-limiting-131");
    expect(w.runs.shell).toEqual([
      expect.stringContaining(`herdr worktree create --cwd ${w.workspace.root} --branch 123-rate-limiting-131 --path ${worktree}`),
    ]);
    expect(w.runs.supervisors).toEqual([
      { issue: 131, story: 123, session: "run-131-ab12", agent: "codex", worktree, log: join(w.workspace.root, ".agents/runs/131/supervisor.log") },
    ]);
    expect(readRecord(w.workspace.root, 131)).toMatchObject({ session: "run-131-ab12", pid: process.pid, state: "running" });
    expect(readFileSync(join(w.workspace.root, ".agents/runs/.gitignore"), "utf8")).toBe("*\n");
    expect(res.stdout).toContain(`Started a run of #131 (review) with codex: session run-131-ab12, supervisor pid ${process.pid}.`);
  });

  test("starts run.agent when given none", async () => {
    const w = story([{ n: 131, state: "needs-review" }]);
    w.workspace.files.set(".agents/norn.config.local.json", JSON.stringify({ run: { agent: "opus", agents: { opus: { kind: "claude" } } } }));

    await w.norn("run", "131");

    expect(w.runs.supervisors[0].agent).toBe("opus");
  });

  test("refuses an item that already has a live run on this machine", async () => {
    const w = story([{ n: 131, state: "needs-review" }]);
    await w.norn("run", "131");

    const res = await w.norn("run", "131");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#131 already has a run on this machine");
    expect(w.runs.supervisors).toHaveLength(1);
  });

  test("refuses an attended step, an item that waits, and one whose worktree cannot be made", async () => {
    const w = story([
      { n: 131, state: "needs-human-qa" },
      { n: 132, state: "needs-review" },
    ]);
    w.github.seedIssue({ number: 140, title: "Spec", labels: ["type:story", "needs-refinement"] });

    expect((await w.norn("run", "131")).stdout).toContain("#131 cannot be run now: it needs human QA (mode:hil).\nSee norn next 123.");
    expect((await w.norn("run", "140")).stdout).toContain("#140 cannot be run now: its step, refinement, is attended");
    w.runs.shellExit = 1;
    const res = await w.norn("run", "132");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#132 cannot be run now: its worktree could not be created with: ");
    expect(w.runs.supervisors).toEqual([]);
  });

  test("--json gives the run", async () => {
    const w = story([{ n: 131, state: "needs-review" }]);
    w.nonces.push("ab12");

    const json = JSON.parse((await w.norn("run", "131", "--json")).stdout);

    expect(json).toMatchObject({ ok: true, issue: 131, story: 123, step: "review", agent: "claude", session: "run-131-ab12" });
  });
});

describe("norn deliver's progress lines", () => {
  test("an escalated run says its agent is left in its pane only when it is there", () => {
    const woke = (end: AttemptEnd) =>
      renderDeliverEvent({
        kind: "woke",
        wake: {
          issue: 131,
          story: 123,
          session: "run-131-a",
          settled: { kind: "escalated", attempts: 3, end },
          attempts: 3,
          minutes: 12,
          at: "2026-10-13T12:00:00Z",
        },
      });

    expect(woke({ kind: "stopped-early", state: "idle" })).toBe(
      "#131 (3 attempts, 12m): it needs a human after 3 attempts; the last: the agent stopped (idle) without finishing its step. Its agent is left in its pane.",
    );
    expect(woke({ kind: "not-started", detail: "no such agent" })).not.toContain("left in its pane");
    expect(woke({ kind: "stalled", afterMs: 600_000 })).not.toContain("left in its pane");
  });
});

describe("norn deliver", () => {
  test("with only people's work left it stops at once and ends with norn next's report", async () => {
    const w = story([{ n: 129, state: "needs-human-qa" }]);

    const { r, lines } = await deliverIt(w);

    expect(r.ok && r.kind).toBe("delivered");
    expect(w.runs.supervisors).toEqual([]);
    expect(lines.at(-1)).toBe("Nothing runs and nothing can start.");
  });

  test("runs each step an agent can do, a new run per step, until only people can move the story on", async () => {
    const w = story([
      { n: 131, state: "needs-review" },
      { n: 132, state: "needs-review" },
    ]);
    const runs = inProcessRuns(w, async (n, state, as) => {
      if (state === "needs-review") await as("done", String(n), "approve");
      else await as("escalate", String(n), "the QA needs a device only a person has");
    });

    const { r, lines } = await deliverIt(w);
    await runs.settled();

    expect(r.ok).toBe(true);
    // A review run and then a QA run for each slice.
    expect(w.runs.supervisors.map((s) => s.issue).sort()).toEqual([131, 131, 132, 132]);
    for (const n of [131, 132]) expect(w.github.labels(n)).toEqual(expect.arrayContaining(["needs-qa", "needs-human"]));
    expect(lines.filter((l) => l.includes("its agent finished the step"))).toHaveLength(2);
    expect(lines.filter((l) => l.includes("its agent handed the step to a person with norn escalate"))).toHaveLength(2);
    expect(lines.at(-1)).toBe("Nothing runs and nothing can start.");
  });

  test("starts no more runs at once than deliver.maxParallel", async () => {
    const w = story([
      { n: 131, state: "needs-review" },
      { n: 132, state: "needs-review" },
      { n: 133, state: "needs-review" },
    ]);
    const runs = inProcessRuns(w, async (n, _state, as) => {
      await new Promise((ok) => setTimeout(ok, 20));
      await as("escalate", String(n), "stop here");
    });

    await deliverIt(w);
    await runs.settled();

    expect(w.runs.supervisors).toHaveLength(3);
    expect(runs.most()).toBe(2);
  });

  test("started again while runs go on, it starts no second run of an item that has one", async () => {
    const w = story([{ n: 131, state: "needs-review" }]);
    // The run of an earlier deliver, still live, whose agent has not taken the item yet.
    writeRecord(w.workspace.root, {
      issue: 131,
      story: 123,
      session: "run-131-old",
      agent: "claude",
      worktree: w.workspace.root,
      pid: process.pid,
      pane: null,
      startedAt: "2026-10-13T12:00:00Z",
      state: "running",
      attempts: [],
    });
    // That run escalates its item and ends, leaving no wake for this deliver.
    setTimeout(async () => {
      await w.github.addLabels(131, ["needs-human"]);
      writeRecord(w.workspace.root, { ...readRecord(w.workspace.root, 131)!, state: "escalated" });
    }, 50);

    await deliverIt(w);

    expect(w.runs.supervisors).toEqual([]);
  });

  test("a run that ends while norn next reads GitHub is not taken for one at work elsewhere: deliver asks again", async () => {
    const w = story([{ n: 131, state: "needs-review" }]);
    w.nonces.push("ab12");
    writeRecord(w.workspace.root, {
      issue: 131,
      story: 123,
      session: "run-131-old",
      agent: "claude",
      worktree: w.workspace.root,
      pid: process.pid,
      pane: null,
      startedAt: "2026-10-13T12:00:00Z",
      state: "running",
      attempts: [],
    });
    await w.github.createClaim(131, { holder: "alice", session: "run-131-old", since: "2026-10-13T12:00:00Z", leaseMs: 600_000 });
    // The run escalates and ends just after norn next has read its claim.
    const readClaim = w.github.readClaim.bind(w.github);
    let ended = false;
    w.github.readClaim = async (n: number) => {
      const claim = await readClaim(n);
      if (n === 131 && !ended && claim) {
        ended = true;
        await w.github.addLabels(131, ["needs-human"]);
        await w.github.deleteClaim(131);
        writeRecord(w.workspace.root, { ...readRecord(w.workspace.root, 131)!, state: "escalated" });
      }
      return claim;
    };

    const { r } = await deliverIt(w);

    expect(r.ok && renderNext(r.report)).toContain("#131 needs a human");
    expect(w.runs.supervisors).toEqual([]);
  });

  test("a run whose supervisor died has its agent stopped and is reported once; deliver waits out its lease", async () => {
    const w = story([{ n: 131, state: "needs-review" }]);
    await w.herdr.run(["tab", "create", "--workspace", "w1", "--cwd", w.workspace.root, "--label", "norn-131"]);
    const [pane] = w.herdr.allPanes();
    await w.herdr.run(["agent", "start", "norn-131", "--kind", "claude", "--pane", pane.id]);
    await w.github.createClaim(131, { holder: "alice", session: "run-131-old", since: "2026-10-13T12:00:00Z", leaseMs: 600_000 });
    writeRecord(w.workspace.root, {
      issue: 131,
      story: 123,
      session: "run-131-old",
      agent: "claude",
      worktree: w.workspace.root,
      // No such process: the supervisor is gone.
      pid: 2 ** 22 + 7,
      pane: pane.id,
      startedAt: "2026-10-13T12:00:00Z",
      state: "running",
      attempts: [],
    });

    // While deliver waits for the lease, a person takes the item over and escalates it.
    let released = 0;
    setTimeout(async () => {
      await w.github.deleteClaim(131);
      await w.github.addLabels(131, ["needs-human"]);
      released = Date.now();
    }, 1500);

    const { lines } = await deliverIt(w);

    expect(released).toBeGreaterThan(0);

    expect(pane.closed).toBe(true);
    expect(lines.filter((l) => l.includes("its run's supervisor (pid"))).toEqual([
      `#131: its run's supervisor (pid ${2 ** 22 + 7}) is gone, so its agent in herdr pane ${pane.id} is stopped. The item is offered again once its lease runs out.`,
    ]);
    expect(readRecord(w.workspace.root, 131)?.state).toBe("lost");
    expect(w.runs.supervisors).toEqual([]);
  });

  test("a running record whose pid lives but whose supervisor has not beaten for long is of a process that reused the pid", async () => {
    const w = story([{ n: 129, state: "needs-human-qa" }]);
    const record = {
      issue: 131,
      story: 123,
      session: "run-131-old",
      agent: "claude",
      worktree: w.workspace.root,
      pid: process.pid,
      pane: null,
      startedAt: "2026-10-13T12:00:00Z",
      state: "running" as const,
      attempts: [],
    };
    writeRecord(w.workspace.root, { ...record, beatAt: new Date(Date.now() - 31 * 60_000).toISOString() });
    expect(liveRuns(w.workspace.root, 123)).toEqual([]);
    expect(deadRuns(w.workspace.root, 123)).toHaveLength(1);
    writeRecord(w.workspace.root, { ...record, beatAt: new Date().toISOString() });
    expect(liveRuns(w.workspace.root, 123)).toHaveLength(1);
  });

  test("a delivery lock being written, unreadable for a moment, is not taken over", async () => {
    const w = story([]);
    mkdirSync(join(w.workspace.root, ".agents/runs"), { recursive: true });
    writeFileSync(join(w.workspace.root, ".agents/runs/deliver-123.json"), "");

    expect(lockDelivery(w.workspace.root, 123, process.pid, new Date())).toMatchObject({ ok: false });
  });

  test("only one norn deliver runs on a story on this machine", async () => {
    const w = story([{ n: 131, state: "needs-review" }]);
    // process.ppid stands for another norn deliver that is alive.
    lockDelivery(w.workspace.root, 123, process.ppid, new Date());

    const res = await w.norn("deliver", "123");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(`#123 is already being delivered on this machine, by the norn deliver with pid ${process.ppid}`);
  });

  test("a lock left by a deliver that is gone is taken over, and given up at the end", async () => {
    const w = story([{ n: 129, state: "needs-human-qa" }]);
    lockDelivery(w.workspace.root, 123, 2 ** 22 + 7, new Date());

    const res = await w.norn("deliver", "123");

    expect(res.exitCode).toBe(0);
    expect(existsSync(join(w.workspace.root, ".agents/runs/deliver-123.json"))).toBe(false);
  });
});

describe("norn tidy under herdr", () => {
  test("closes the tabs runs left behind, keeping a live run's, an escalation's and another repository's", async () => {
    const w = story([]);
    const root = w.workspace.root;
    w.github.seedIssue({ number: 131, title: "Done", labels: [], state: "closed" });
    w.github.seedIssue({ number: 132, title: "Escalated", labels: ["type:slice", "needs-review", "needs-human"] });
    w.github.seedIssue({ number: 133, title: "Running", labels: ["type:slice", "needs-review"] });
    w.github.seedIssue({ number: 134, title: "Resolved", labels: ["type:slice", "needs-review"] });
    const tab = async (cwd: string, label: string) => {
      const ws = await w.herdr.run(["worktree", "open", "--cwd", cwd, "--path", `${cwd}/wt-${label}`, "--no-focus"]);
      const id = (ws as { result: { workspace: { workspace_id: string } } }).result.workspace.workspace_id;
      await w.herdr.run(["tab", "create", "--workspace", id, "--cwd", cwd, "--label", label]);
    };
    for (const label of ["norn-131", "norn-132", "norn-133", "norn-134-ab12", "1", "norn-deliver-123"]) await tab(root, label);
    await tab("/elsewhere", "norn-131");
    writeRecord(root, {
      issue: 133,
      story: 123,
      session: "run-133-a",
      agent: "claude",
      worktree: root,
      pid: process.pid,
      pane: null,
      startedAt: "2026-10-13T12:00:00Z",
      state: "running",
      attempts: [],
    });

    const dry = await w.norn("tidy", "--dry-run");
    expect(w.herdr.allPanes().filter((p) => p.closed)).toEqual([]);
    expect(dry.stdout).toContain("left by a run of #131");

    const res = await w.norn("tidy");

    expect(res.stdout).toContain("norn tidy removed:");
    const open = w.herdr
      .allPanes()
      .filter((p) => !p.closed)
      .map((p) => `${p.label}${p.cwd === "/elsewhere" ? " elsewhere" : ""}`);
    expect(open.sort()).toEqual(["1", "norn-131 elsewhere", "norn-132", "norn-133", "norn-deliver-123"]);
  });
});
