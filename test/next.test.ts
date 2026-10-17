import { describe, expect, test } from "vitest";
import { setup } from "@norn/testing";

/** The documented example: story #123 with 5 slices, 2 merged. */
function prdExample() {
  const w = setup();
  const gh = w.github;
  gh.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
  gh.seedIssue({ number: 125, title: "Config", state: "closed", labels: ["type:slice", "mode:afk"] });
  gh.seedIssue({ number: 126, title: "Errors", state: "closed", labels: ["type:slice", "mode:afk"] });
  gh.seedIssue({ number: 127, title: "Redis store", labels: ["type:slice", "mode:afk", "merge-queue"] });
  gh.seedIssue({ number: 128, title: "Limit headers", labels: ["type:slice", "mode:afk", "needs-review"] });
  gh.seedIssue({ number: 129, title: "Dashboard", labels: ["type:slice", "mode:hil", "needs-human-qa"] });
  gh.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
  gh.seedIssue({ number: 132, title: "Docs", labels: ["type:slice", "mode:afk", "blocked"] });
  for (const s of [125, 126, 131, 128, 127, 132, 129]) gh.parents.set(s, 123);
  gh.blockers.set(131, [125]);
  gh.blockers.set(132, [131]);
  gh.branches.add("123-rate-limiting");
  return w;
}

describe("norn next", () => {
  test("lists what can start now and what is waiting, as in the docs", async () => {
    const w = prdExample();

    const res = await w.norn("next", "123");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(
      [
        'Story #123 "Rate limiting" is in implementation. 2 of 7 slices are merged',
        "into 123-rate-limiting.",
        "",
        "You can start 3 items now. They are independent, so run them in parallel, at",
        "most 2 at a time, each in its own fresh subagent, told to work in the item's",
        "worktree:",
        "",
        '  - Slice #131 "Per-key limits" is in ready-for-agent: Ready for an agent.',
        "    Worktree: /repo/.agents/worktrees/123-rate-limiting-131",
        "    Start it with: norn take 131",
        '  - Slice #128 "Limit headers" is in needs-review: Waiting for review.',
        "    Worktree: /repo/.agents/worktrees/123-rate-limiting-128",
        "    Start it with: norn take 128",
        '  - Slice #127 "Redis store" is in merge-queue: Queued to merge.',
        "    Worktree: /repo/.agents/worktrees/123-rate-limiting-127",
        "    Start it with: norn take 127",
        "",
        "Waiting, nothing to do for you:",
        "  - #132 is blocked by #131.",
        "  - #129 needs human QA (mode:hil). Do not take it.",
        "",
        "Each phase gets a new agent. Then run norn wait 123: it ends when something new can start.",
      ].join("\n"),
    );
  });

  test("a slice held by another session is waiting, not startable", async () => {
    const w = prdExample();
    w.setNow("2026-10-13T14:02:00Z");
    await w.asTeammate("bob", "other")("take", "131");

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain("You can start 2 items now.");
    expect(res.stdout).toContain("  - #131 is held by another session (since 14:02).");
  });

  test("a slice held by another session of yours says so", async () => {
    const w = prdExample();
    w.setNow("2026-10-13T14:02:00Z");
    await w.as("other")("take", "131");

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain("  - #131 is held by another session of yours (since 14:02).");
  });

  test("a story in phase 1 offers the story itself, marked as attended", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-refinement"] });

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain('Story #123 "Rate limiting" is in needs-refinement.');
    expect(res.stdout).toContain("You can start 1 item now, with the user:");
    expect(res.stdout).toContain("refinement (attended: the user takes part)");
    expect(res.stdout).toContain("Start it with: norn take 123");
  });

  test("a story waiting for its owner to merge has nothing to start", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "merge-queue"], assignees: ["bob"] });

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain("nothing left that you can do.");
    expect(res.stdout).toContain("#123 waits for its owner (@bob) to merge the story PR into main.");
  });

  test("the owner merges the story PR into the configured baseBranch", async () => {
    const w = setup();
    w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ baseBranch: "develop" }));
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "merge-queue"], assignees: ["bob"] });

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain("#123 waits for its owner (@bob) to merge the story PR into develop.");
  });

  test("blocked labels are brought in line with native relations", async () => {
    const w = prdExample();
    w.github.issues.get(131)!.state = "closed";

    const res = await w.norn("next", "123");

    expect(w.github.labels(132)).toContain("ready-for-agent");
    expect(res.stdout).toContain('Slice #132 "Docs" is in ready-for-agent: Ready for an agent.');
  });

  test("refuses a number that is not a story", async () => {
    const w = prdExample();
    const res = await w.norn("next", "131");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("#131 is a slice of #123. Run norn next 123");
  });
});

describe("--json", () => {
  test("norn next --json gives the same facts for scripts", async () => {
    const w = prdExample();
    const res = await w.norn("next", "123", "--json");
    const report = JSON.parse(res.stdout);
    expect(report.slices).toEqual({ total: 7, merged: 2 });
    expect(report.start.map((s: { issue: number; skill: string }) => [s.issue, s.skill])).toEqual([
      [131, "norn-implement"],
      [128, "norn-review"],
      [127, "norn-merge"],
    ]);
    expect(report.waiting.map((x: { issue: number; reason: string }) => [x.issue, x.reason])).toEqual([
      [132, "blocked"],
      [129, "human-qa"],
    ]);
  });

  test("take and done --json report the issue, step and outcome", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7, title: "Rate limiting" });

    const take = JSON.parse((await w.norn("take", "7", "--json")).stdout);
    expect(take).toMatchObject({ ok: true, issue: 7, step: "triage", skill: "norn-triage", attended: true });
    expect(take.outcomes).toEqual(["story", "reject"]);

    const done = JSON.parse((await w.norn("done", "7", "story", "--json")).stdout);
    expect(done).toMatchObject({ ok: true, issue: 7, to: "needs-refinement" });
  });

  test("refusals are JSON too, with the instruction", async () => {
    const w = setup();
    w.github.seedIssue({ number: 7 });
    const res = await w.norn("done", "7", "--json");
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: false, refusal: expect.stringContaining("norn take 7") });
  });
});

describe("next names how to start fresh agents for the worktree tool", () => {
  test("herdr: a branch checked out elsewhere is named instead of a create command", async () => {
    const w = prdExample();
    w.workspace.env = { HERDR_ENV: "1" };
    w.workspace.checkedOut.set("123-rate-limiting-131", "/repo");

    const res = await w.norn("next", "123");
    const s131 = res.stdout.slice(res.stdout.indexOf("Slice #131"), res.stdout.indexOf("Slice #128"));

    expect(s131).toContain("    Branch 123-rate-limiting-131 is checked out at /repo; work there or switch that checkout to another branch.");
    expect(s131).not.toContain("Create the worktree");
  });

  test("herdr: create the worktree if missing, then a new herdr agent in its pane", async () => {
    const w = prdExample();
    w.workspace.env = { HERDR_ENV: "1" };
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting-128");

    const res = await w.norn("next", "123");

    expect(res.stdout.replace(/\s+/g, " ")).toContain("each as a new herdr agent in the item's worktree pane:");
    expect(res.stdout).toContain(
      "    Create the worktree: git -C /repo fetch origin 123-rate-limiting && git -C /repo branch --no-track 123-rate-limiting-131 origin/123-rate-limiting && herdr worktree create --cwd /repo --branch 123-rate-limiting-131 --path /repo/.agents/worktrees/123-rate-limiting-131 --no-focus",
    );
    expect(res.stdout).toContain(
      "    Start an agent: herdr agent start norn-131-implementation --kind claude --pane <pane of /repo/.agents/worktrees/123-rate-limiting-131>",
    );
    expect(res.stdout).toContain(
      '    Then prompt it: herdr agent prompt norn-131-implementation "Work in /repo/.agents/worktrees/123-rate-limiting-131. Run norn take 131, follow its briefing to the end, and finish with the norn command it gives."',
    );
    const s128 = res.stdout.slice(res.stdout.indexOf("#128"), res.stdout.indexOf("#127"));
    expect(s128).not.toContain("Create the worktree");
  });

  test("herdr: each phase's agent is named for its step, and an earlier phase's agent in the pane is stopped first", async () => {
    const w = setup();
    w.workspace.env = { HERDR_ENV: "1" };
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 3, title: "List tasks", labels: ["type:slice", "mode:afk", "merge-queue"] });
    w.github.parents.set(3, 123);
    w.github.branches.add("123-rate-limiting");
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting-3");
    w.workspace.agents = [{ pane: "w3Y:p2", name: "norn-3-review", activity: "idle", cwd: "/repo/.agents/worktrees/123-rate-limiting-3" }];

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain(
      [
        "    Its pane still runs an earlier agent. Stop it first: herdr agent prompt norn-3-review /exit",
        "    Start an agent: herdr agent start norn-3-merge --kind claude --pane w3Y:p2",
        '    Then prompt it: herdr agent prompt norn-3-merge "Work in /repo/.agents/worktrees/123-rate-limiting-3. Run norn take 3, follow its briefing to the end, and finish with the norn command it gives."',
      ].join("\n"),
    );
    expect(JSON.parse((await w.norn("next", "123", "--json")).stdout).start[0]).toMatchObject({
      agent: "norn-3-merge",
      earlier: { pane: "w3Y:p2", name: "norn-3-review", activity: "idle" },
    });
  });

  test("herdr: an agent in another worktree's pane is not this item's", async () => {
    const w = setup();
    w.workspace.env = { HERDR_ENV: "1" };
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 3, title: "List tasks", labels: ["type:slice", "mode:afk", "merge-queue"] });
    w.github.parents.set(3, 123);
    w.github.branches.add("123-rate-limiting");
    w.workspace.agents = [{ pane: "w4:p1", name: "norn-30-review", activity: "idle", cwd: "/repo/.agents/worktrees/123-rate-limiting-30" }];

    const res = await w.norn("next", "123");

    expect(res.stdout).not.toContain("Stop it first");
    expect(res.stdout).toContain("herdr agent start norn-3-merge --kind claude --pane <pane of /repo/.agents/worktrees/123-rate-limiting-3>");
  });

  test("herdr: an attended step is handed to an agent in the worktree, which drives the story", async () => {
    const w = setup();
    w.workspace.env = { HERDR_ENV: "1" };
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-refinement"] });

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain("    Create the worktree: ");
    expect(res.stdout).toContain(
      [
        "    Hand the story to an agent in its worktree, which drives it on with the user:",
        "      herdr agent start norn-123-refinement --kind claude --pane <pane of /repo/.agents/worktrees/123-rate-limiting>",
        '      herdr agent prompt norn-123-refinement "norn-drive 123"',
        "      herdr agent focus norn-123-refinement",
      ].join("\n"),
    );
    expect(res.stdout).not.toContain("Start an agent:");
  });

  test("herdr: inside the worktree, an attended step is taken in this session", async () => {
    const w = setup();
    w.workspace.env = { HERDR_ENV: "1" };
    w.workspace.cwd = "/repo/.agents/worktrees/123-rate-limiting";
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting");
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-plan"] });

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain("    You are in its worktree: take it in this session.");
    expect(res.stdout).not.toContain("herdr agent");
    expect(JSON.parse((await w.norn("next", "123", "--json")).stdout).start[0]).toMatchObject({ issue: 123, here: true });
  });

  test("herdr: an item for a person is handed to an agent in its worktree if the user does it now", async () => {
    const w = prdExample();
    w.workspace.env = { HERDR_ENV: "1" };

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain(
      [
        "  - #129 needs human QA (mode:hil). Do not take it.",
        "    If the user does it now, hand it to an agent in its worktree:",
        "      Create the worktree: git -C /repo fetch origin 123-rate-limiting && git -C /repo branch --no-track 123-rate-limiting-129 origin/123-rate-limiting && herdr worktree create --cwd /repo --branch 123-rate-limiting-129 --path /repo/.agents/worktrees/123-rate-limiting-129 --no-focus",
        "      herdr agent start norn-129-human-qa --kind claude --pane <pane of /repo/.agents/worktrees/123-rate-limiting-129>",
        '      herdr agent prompt norn-129-human-qa "norn-drive 129"',
        "      herdr agent focus norn-129-human-qa",
      ].join("\n"),
    );
    expect(JSON.parse((await w.norn("next", "123", "--json")).stdout).waiting[1]).toMatchObject({
      issue: 129,
      reason: "human-qa",
      worktree: "/repo/.agents/worktrees/123-rate-limiting-129",
      here: false,
    });
  });

  test("herdr: inside its worktree, an item for a person is taken in this session if the user does it now", async () => {
    const w = prdExample();
    w.workspace.env = { HERDR_ENV: "1" };
    w.workspace.cwd = "/repo/.agents/worktrees/123-rate-limiting-129";
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting-129");

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain(
      ["  - #129 needs human QA (mode:hil).", "    You are in its worktree: if the user does it now, take it in this session."].join("\n"),
    );
    expect(res.stdout).not.toContain("herdr agent start norn-129");
  });

  test("herdr: when nothing is left, the hand-off is listed with the item that waits for a human", async () => {
    const w = setup();
    w.workspace.env = { HERDR_ENV: "1" };
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "changes-requested", "needs-human"] });
    w.github.parents.set(131, 123);
    w.github.branches.add("123-rate-limiting");
    w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting-131");
    w.github.commentsByIssue.set(131, ['norn: needs-human — escalated: "Redis client times out in tests" (3 fix rounds reached)']);

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain(
      [
        "Waiting for a human:",
        '  - #131 needs a human: escalated: "Redis client times out in tests" (3 fix rounds reached).',
        "    If the user does it now, hand it to an agent in its worktree:",
        "      herdr agent start norn-131-resolve --kind claude --pane <pane of /repo/.agents/worktrees/123-rate-limiting-131>",
        '      herdr agent prompt norn-131-resolve "norn-drive 131"',
        "      herdr agent focus norn-131-resolve",
        "Stop here and report to the user.",
      ].join("\n"),
    );
  });

  test("herdr: a story waiting for its owner to merge gets no hand-off", async () => {
    const w = setup();
    w.workspace.env = { HERDR_ENV: "1" };
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "merge-queue"], assignees: ["bob"] });

    const res = await w.norn("next", "123");

    expect(res.stdout).not.toContain("herdr agent");
  });

  test("plain git: a new agent session started in the worktree", async () => {
    const w = prdExample();
    w.workspace.env = {};
    const res = await w.norn("next", "123");
    expect(res.stdout.replace(/\s+/g, " ")).toContain("each in a new agent session started in the item's worktree:");
    expect(res.stdout).toContain("    Start an agent in /repo/.agents/worktrees/123-rate-limiting-131 with NORN_SESSION=norn-131-n1 set.");
    expect(res.stdout).toContain("NORN_SESSION=norn-128-n2");
    // The session starts in the worktree, so it is made first, as under herdr.
    expect(res.stdout).toContain(
      "    Create the worktree: git -C /repo fetch origin 123-rate-limiting && git -C /repo worktree add --no-track /repo/.agents/worktrees/123-rate-limiting-131 -b 123-rate-limiting-131 origin/123-rate-limiting",
    );
    w.nonces.push("f00d");
    expect(JSON.parse((await w.norn("next", "123", "--json")).stdout).start[0]).toMatchObject({ issue: 131, session: "norn-131-f00d" });
  });

  test("plain git: a new agent on an item whose claim went stale is a takeover, not the old holder", async () => {
    const w = setup();
    w.workspace.env = {};
    w.github.seedIssue({ number: 10, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.seedIssue({ number: 12, title: "Per-key limits", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
    w.github.parents.set(12, 10);
    w.github.branches.add("10-rate-limiting");
    w.setNow("2026-10-13T08:00:00Z");
    await w.as("norn-12-aaaa")("take", "12");
    w.workspace.worktrees.add(".agents/worktrees/10-rate-limiting-12");
    w.setNow("2026-10-13T12:00:00Z");

    w.nonces.push("bbbb");
    const next = await w.norn("next", "10");
    expect(next.stdout).toContain("with NORN_SESSION=norn-12-bbbb set.");

    const res = await w.as("norn-12-bbbb")("take", "12");

    expect(res.stdout).toContain("The previous holder's claim was stale (since 08:00); its worktree is kept");
    expect(res.stdout).not.toContain("You already held");
    expect(w.github.claim(12)).toMatchObject({ session: "norn-12-bbbb" });
  });

  test("under Claude Code no NORN_SESSION is given: the Claude Code session id names the session", async () => {
    const w = prdExample();
    const res = await w.norn("next", "123");
    expect(res.stdout).not.toContain("NORN_SESSION");
  });

  test("--json carries each item's branch and worktree", async () => {
    const w = prdExample();
    const report = JSON.parse((await w.norn("next", "123", "--json")).stdout);
    expect(report.start[0]).toMatchObject({
      issue: 131,
      branch: "123-rate-limiting-131",
      worktree: "/repo/.agents/worktrees/123-rate-limiting-131",
    });
    expect(report.provider).toBe("claude-code");
  });
});

describe("parallel limit", () => {
  const flat = (s: string) => s.replace(/\s+/g, " ");

  test("next tells the orchestrator to run at most deliver.maxParallel items at once", async () => {
    const w = prdExample();
    expect(flat((await w.norn("next", "123")).stdout)).toContain("run them in parallel, at most 2 at a time,");
  });

  test("the limit comes from the config", async () => {
    const w = prdExample();
    w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ deliver: { maxParallel: 3 } }));
    const res = await w.norn("next", "123");
    expect(flat(res.stdout)).toContain("at most 3 at a time");
    expect(JSON.parse((await w.norn("next", "123", "--json")).stdout).maxParallel).toBe(3);
  });
});

describe("work a person holds", () => {
  test("an item for a person that a session holds is listed as held, with no hand-off", async () => {
    const w = prdExample();
    w.workspace.env = { HERDR_ENV: "1" };
    w.setNow("2026-10-13T14:02:00Z");
    await w.as("drive-main-pane")("take", "129");

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain("  - #129 needs human QA (mode:hil), held by another session of yours (since 14:02). Do not take it.");
    expect(res.stdout).not.toContain("norn-129");
    expect(JSON.parse((await w.norn("next", "123", "--json")).stdout).waiting[1]).toMatchObject({
      issue: 129,
      reason: "human-qa",
      heldBy: "another session of yours (since 14:02)",
    });
  });

  test("an escalation a session holds is listed as held too", async () => {
    const w = prdExample();
    w.github.issues.get(131)!.labels.push("needs-human");
    w.setNow("2026-10-13T14:02:00Z");
    await w.asTeammate("bob", "bobs")("take", "131");

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain("  - #131 needs a human: see its latest comment, held by another session (since 14:02). Do not take it.");
  });
});

describe("running agents count against the parallel limit", () => {
  function fourReady() {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    for (const n of [131, 132, 133, 134]) {
      w.github.seedIssue({ number: n, title: `Slice ${n}`, labels: ["type:slice", "mode:afk", "ready-for-agent"] });
      w.github.parents.set(n, 123);
    }
    w.github.branches.add("123-rate-limiting");
    w.setNow("2026-10-13T14:02:00Z");
    return w;
  }

  test("with the limit reached by your running agents, nothing more is started", async () => {
    const w = fourReady();
    await w.as("agent-131")("take", "131");
    await w.as("agent-132")("take", "132");

    const res = await w.as("orchestrator-b")("next", "123");

    expect(res.stdout).toContain(
      [
        "2 items are ready, but 2 of your agents are running, the limit of",
        "deliver.maxParallel. Run norn wait 123: it ends when one has finished and",
        "something new can start.",
        "",
        '  - Slice #133 "Slice 133" is in ready-for-agent: Ready for an agent.',
        '  - Slice #134 "Slice 134" is in ready-for-agent: Ready for an agent.',
      ].join("\n"),
    );
    expect(res.stdout).not.toContain("Start it with");
    expect(JSON.parse((await w.norn("next", "123", "--json")).stdout)).toMatchObject({ running: 2, slots: 0 });
  });

  test("with one of your agents running, only the free slots are offered", async () => {
    const w = fourReady();
    await w.as("agent-131")("take", "131");

    const res = await w.norn("next", "123");

    expect(res.stdout.replace(/\s+/g, " ")).toContain(
      "You can start 3 items now. They are independent, so run them in parallel, at most 1 at a time (1 of your agents is running, the limit is 2),",
    );
  });

  test("a teammate's agents and a person's work do not use your slots", async () => {
    const w = fourReady();
    await w.asTeammate("bob", "bobs")("take", "131");
    w.github.seedIssue({ number: 129, title: "Dashboard", labels: ["type:slice", "mode:hil", "needs-human-qa"] });
    w.github.parents.set(129, 123);
    await w.as("drive")("take", "129");

    const res = await w.norn("next", "123");

    expect(res.stdout.replace(/\s+/g, " ")).toContain("You can start 3 items now. They are independent, so run them in parallel, at most 2 at a time,");
  });

  test("attended steps are not limited", async () => {
    const w = setup();
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "needs-refinement"] });
    w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ deliver: { maxParallel: 1 } }));
    w.github.seedIssue({ number: 7, title: "Other", labels: ["type:slice", "mode:afk", "ready-for-agent"] });

    const res = await w.norn("next", "123");

    expect(res.stdout).toContain("You can start 1 item now, with the user:");
  });
});
