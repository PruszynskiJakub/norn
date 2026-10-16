import { describe, expect, test } from "vitest";
import { done, observe, take } from "@norn/core";
import { setup } from "@norn/testing";

/** alice's story #10 in implementation: #11 ready, #12 blocked by #11 in mode:hil. */
function story() {
  const w = setup({ now: "2026-10-13T12:00:00Z" });
  const gh = w.github;
  gh.seedIssue({ number: 10, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
  gh.seedIssue({ number: 11, title: "Redis store", labels: ["type:slice", "mode:afk", "ready-for-agent"], assignees: ["alice"] });
  gh.seedIssue({ number: 12, title: "Per-key limits", labels: ["type:slice", "mode:hil", "blocked"], assignees: ["alice"] });
  gh.parents.set(11, 10);
  gh.parents.set(12, 10);
  gh.blockers.set(12, [11]);
  return w;
}

describe("observe: the board", () => {
  test("shows my story with its slices: state, mode, blockers, holder and fix rounds", async () => {
    const w = story();
    await w.norn("take", "11");
    await w.norn("done", "11");
    await w.as("reviewer")("take", "11");
    await w.as("reviewer")("done", "11", "request-changes", "Add a test");
    w.setNow("2026-10-13T12:30:00Z");
    await w.norn("take", "11");

    const res = await observe(await w.ctx(), {});

    expect(res.kind).toBe("observation");
    expect(res.me).toBe("alice");
    expect(res.board).toHaveLength(1);
    const [s] = res.board;
    expect(s).toMatchObject({
      number: 10,
      title: "Rate limiting",
      url: "https://github.com/acme/app/issues/10",
      status: "open",
      states: ["implementation"],
      owner: "alice",
      branch: "10-rate-limiting",
      humanQa: true,
    });
    expect(s.slices).toEqual([
      {
        number: 11,
        title: "Redis store",
        url: "https://github.com/acme/app/issues/11",
        status: "open",
        states: ["implementation"],
        labels: ["type:slice", "mode:afk", "implementation", "in-progress"],
        mode: "afk",
        blockedBy: [],
        holder: { login: "alice", session: "session-1", since: "2026-10-13T12:30:00.000Z", stale: false },
        fixRounds: 1,
        maxFixRounds: 3,
        needsHuman: false,
        needsHumanReason: null,
        humanQa: false,
        latestEvidence: null,
        closedAt: null,
      },
      expect.objectContaining({ number: 12, states: ["blocked"], mode: "hil", blockedBy: [11], holder: null, fixRounds: 0, humanQa: true }),
    ]);
  });
});

describe("observe: whose work", () => {
  test("a teammate's story shows only while one of my sessions holds an item of it", async () => {
    const w = story();
    w.github.seedIssue({ number: 20, title: "Bob's", labels: ["type:story", "implementation"], assignees: ["bob"] });
    w.github.seedIssue({ number: 21, title: "Bob's slice", labels: ["type:slice", "mode:afk", "ready-for-agent"], assignees: ["bob"] });
    w.github.parents.set(21, 20);
    w.github.seedIssue({ number: 30, title: "Carol's", labels: ["type:story", "implementation"], assignees: ["carol"] });
    expect((await observe(await w.ctx(), {})).board.map((s) => s.number)).toEqual([10]);

    await w.norn("take", "21");

    expect((await observe(await w.ctx(), {})).board.map((s) => s.number)).toEqual([10, 20]);
  });

  test("my stories closed in the last 7 days stay; older ones drop off", async () => {
    const w = story();
    w.github.seedIssue({ number: 40, title: "Old", labels: ["type:story"], assignees: ["alice"] });
    w.github.seedIssue({ number: 41, title: "Recent", labels: ["type:story"], assignees: ["alice"] });
    w.setNow("2026-10-05T12:00:00Z");
    await w.github.closeIssue(40, "completed");
    w.setNow("2026-10-07T12:00:00Z");
    await w.github.closeIssue(41, "completed");

    w.setNow("2026-10-13T12:00:00Z");
    const res = await observe(await w.ctx(), {});

    expect(res.board.map((s) => [s.number, s.status, s.closedAt])).toEqual([
      [10, "open", null],
      [41, "merged", "2026-10-07T12:00:00.000Z"],
    ]);
  });
});

describe("observe: waiting for me", () => {
  test("lists my items in needs-human or needs-human-qa with the command that picks them up", async () => {
    const w = story();
    w.github.seedIssue({ number: 13, title: "Docs", labels: ["type:slice", "mode:hil", "needs-qa"], assignees: ["alice"] });
    w.github.parents.set(13, 10);
    w.setNow("2026-10-13T12:05:00Z");
    await w.norn("take", "13");
    await w.norn("done", "13", "pass", "All criteria pass");
    w.setNow("2026-10-13T12:10:00Z");
    await w.norn("take", "11");
    await w.norn("escalate", "11", "Which store?");
    // A teammate's story I hold an item of: theirs to act on, not mine.
    w.github.seedIssue({ number: 20, title: "Bob's", labels: ["type:story", "needs-review", "needs-human"], assignees: ["bob"] });
    await w.as("other")("take", "20");
    w.github.claims.set(20, { holder: "alice", session: "other", since: "2026-10-13T12:10:00Z" });

    const res = await observe(await w.ctx(), {});

    expect(res.waiting).toEqual([
      {
        issue: 11,
        story: 10,
        title: "Redis store",
        kind: "needs-human",
        reason: 'escalated: "Which store?"',
        since: "2026-10-13T12:10:00.000Z",
        command: "norn-drive 11",
      },
      { issue: 13, story: 10, title: "Docs", kind: "needs-human-qa", reason: null, since: "2026-10-13T12:05:00.000Z", command: "norn-drive 13" },
    ]);
  });
});

describe("observe: outcomes and their remarks", () => {
  test("each outcome is an event with its note and evidence as norn wrote them", async () => {
    const w = story();
    const at = (t: string) => w.setNow(`2026-10-13T${t}:00Z`);
    const ctx = await w.ctx();
    at("12:01");
    await take(ctx, 11, { takeover: false });
    await done(ctx, 11, {});
    at("12:02");
    await take(ctx, 11, { takeover: false });
    await done(ctx, 11, { word: "request-changes", note: "1. **Add a test**\n2. Rename `x`" });
    at("12:03");
    await take(ctx, 11, { takeover: false });
    await done(ctx, 11, { note: "Fixed both" });
    at("12:04");
    await take(ctx, 11, { takeover: false });
    await done(ctx, 11, { word: "approve" });
    at("12:05");
    w.workspace.evidence.set("/tmp/qa", [
      { path: "shot.png", content: Buffer.from("png") },
      { path: "logs/run.txt", content: Buffer.from("ok") },
    ]);
    await take(ctx, 11, { takeover: false });
    await done(ctx, 11, { word: "pass", note: "- [x] stores keys", evidenceDir: "/tmp/qa" });

    const res = await observe(await w.ctx(), {});

    const outcomes = res.feed.filter((e) => e.kind === "outcome");
    expect(outcomes.map((e) => [e.at.slice(11, 16), e.step, e.outcome, e.fixRound, e.note])).toEqual([
      ["12:05", "agent QA", "pass", null, "- [x] stores keys"],
      ["12:04", "review", "approve", null, null],
      ["12:03", "implementation", "done", 1, "Fixed both"],
      ["12:02", "review", "request-changes", 1, "1. **Add a test**\n2. Rename `x`"],
      ["12:01", "implementation", "done", null, null],
    ]);
    const evidence = { branch: "norn/qa/11", sha: w.github.pushed[0].sha, files: ["shot.png", "logs/run.txt"] };
    expect(outcomes[0]).toMatchObject({
      issue: 11,
      story: 10,
      actor: "alice",
      from: "needs-qa",
      to: "merge-queue",
      maxFixRounds: 3,
      evidence,
      url: expect.stringMatching(/^https:\/\/github\.com\/acme\/app\/issues\/11#issuecomment-\d+$/),
    });
    expect(res.feed.filter((e) => e.kind === "qa-evidence")).toEqual([expect.objectContaining({ issue: 11, evidence, url: outcomes[0].url })]);
    expect(res.board[0].slices[0].latestEvidence).toEqual(evidence);
  });
});

describe("observe: the feed", () => {
  /** A story sliced and its first slice taken to merged, one step a minute, with a teammate's comment between. */
  async function history() {
    const w = setup({ now: "2026-10-13T12:00:00Z" });
    w.github.seedIssue({ number: 10, title: "Rate limiting", labels: ["type:story", "needs-slicing"], assignees: ["alice"] });
    let minute = 0;
    const tick = () => w.setNow(new Date(Date.parse("2026-10-13T12:00:00Z") + ++minute * 60_000).toISOString());
    const step = async (...argv: string[]) => {
      tick();
      const r = await w.norn(...argv);
      if (r.exitCode !== 0) throw new Error(r.stdout);
    };
    await step("take", "10");
    await step("add-slice", "10", "Redis store", "--mode", "afk");
    await step("add-slice", "10", "Limits", "--mode", "hil", "--blocked-by", "1000");
    await step("done", "10");
    await step("take", "1000");
    await step("done", "1000");
    tick();
    await w.github.createPullRequest({ head: "10-rate-limiting-1000", base: "10-rate-limiting", title: "Redis store", body: "Part of #10. Slice #1000." });
    await step("take", "1000");
    await step("escalate", "1000", "Which store?");
    tick();
    w.github.user = "bob";
    await w.github.comment(1000, "Use Redis");
    w.github.user = "alice";
    await step("take", "1000");
    await step("done", "1000");
    await step("take", "1000");
    await step("done", "1000", "approve");
    await step("take", "1000");
    await step("done", "1000", "pass", "All good");
    tick();
    w.github.mergePullRequest(1002);
    await step("take", "1000");
    await step("done", "1000");
    return w;
  }

  test("tells the story's history in norn's terms, each event with who did it and where", async () => {
    const w = await history();

    const res = await observe(await w.ctx(), {});

    const said = [...res.feed].reverse().map((e) => {
      const what =
        e.kind === "outcome"
          ? `${e.step}: ${e.outcome}`
          : e.kind === "step"
            ? `${e.from} → ${e.to}`
            : e.kind === "pr"
              ? `${e.target} PR #${e.pr} ${e.action}`
              : e.kind === "needs-human"
                ? `${e.action} ${e.reason ?? ""}`.trim()
                : e.kind === "other-activity"
                  ? e.detail
                  : "action" in e
                    ? e.action
                    : e.kind;
      return `${e.at.slice(14, 16)} #${e.issue} ${e.kind} ${what} @${e.actor}`;
    });
    expect(said).toEqual([
      "02 #1000 slice created @alice",
      "03 #1001 slice created @alice",
      "04 #10 outcome slicing: done @alice",
      "05 #1000 step ready-for-agent → implementation @alice",
      "06 #1000 outcome implementation: done @alice",
      "07 #1000 pr slice PR #1002 opened @alice",
      '09 #1000 needs-human raised escalated: "Which store?" @alice',
      "10 #1000 other-activity IssueComment @bob",
      "12 #1000 needs-human resolved @alice",
      "14 #1000 outcome review: approve @alice",
      "16 #1000 outcome agent QA: pass @alice",
      "17 #1000 pr slice PR #1002 merged @alice",
      "19 #1000 outcome merge: done @alice",
      "19 #1001 slice unblocked @alice",
    ]);
    for (const e of res.feed) expect(e.story).toBe(10);
    const comment = res.feed.find((e) => e.kind === "other-activity")!;
    expect(comment.url).toMatch(/issues\/1000#issuecomment-\d+$/);
    expect(res.feed.find((e) => e.kind === "pr")!.url).toBe("https://github.com/acme/app/pull/1002");
  });

  test("with since, only what happened after it", async () => {
    const w = await history();

    const res = await observe(await w.ctx(), { since: "2026-10-13T12:16:30.000Z" });

    expect(res.feed.map((e) => e.kind)).toEqual(["slice", "outcome", "pr"]);
  });

  test("a label change norn does not know is other activity, with its label", async () => {
    const w = story();
    w.github.user = "bob";
    await w.github.addLabels(10, ["priority:high"]);
    w.github.record(10, { kind: "other", at: "2026-10-13T12:00:00.000Z", actor: "bob", url: null, detail: "RenamedTitleEvent" });
    w.github.user = "alice";

    const res = await observe(await w.ctx(), {});

    expect(res.feed).toEqual([
      expect.objectContaining({ kind: "other-activity", detail: "RenamedTitleEvent", actor: "bob" }),
      expect.objectContaining({
        kind: "other-activity",
        detail: "LabeledEvent",
        label: "priority:high",
        actor: "bob",
        url: "https://github.com/acme/app/issues/10",
      }),
    ]);
  });
});

describe("observe: claims", () => {
  test("claims are seen taken, released and gone stale by comparing reads; before the first, none are made up", async () => {
    const w = story();
    await w.norn("take", "11");
    const first = await observe(await w.ctx(), {});
    expect(first.feed.filter((e) => e.kind === "claim")).toEqual([]);
    expect(first.claims).toEqual([{ issue: 11, sha: expect.any(String), login: "alice", session: "session-1", since: "2026-10-13T12:00:00.000Z" }]);

    w.setNow("2026-10-13T12:05:00Z");
    await w.norn("release", "11");
    await w.github.removeLabels(12, ["blocked"]);
    await w.github.addLabels(12, ["ready-for-agent"]);
    await w.as("s2")("take", "12");
    w.setNow("2026-10-13T12:06:00Z");
    const second = await observe(await w.ctx(), { since: first.at, previous: first });

    const claims = (o: typeof second) =>
      o.feed.filter((e) => e.kind === "claim").map((e) => e.kind === "claim" && [e.action, e.issue, e.session, e.at, e.actor]);
    expect(claims(second)).toEqual([
      ["released", 11, "session-1", "2026-10-13T12:06:00.000Z", "alice"],
      ["taken", 12, "s2", "2026-10-13T12:05:00.000Z", "alice"],
    ]);

    w.setNow("2026-10-13T14:10:00Z");
    const third = await observe(await w.ctx(), { since: second.at, previous: second });

    expect(claims(third)).toEqual([["stale", 12, "s2", "2026-10-13T14:05:00.000Z", "alice"]]);
    expect(third.board[0].slices[1].holder).toMatchObject({ session: "s2", stale: true });
  });
});

describe("observe: the story PR", () => {
  test("is opened when the last slice merges, and merging it on GitHub closes the story", async () => {
    const w = setup({ now: "2026-10-13T12:00:00Z" });
    w.github.seedIssue({ number: 40, title: "Last", labels: ["type:story", "implementation"], assignees: ["alice"] });
    w.github.seedIssue({ number: 41, title: "Only", labels: ["type:slice", "mode:afk", "merge-queue"], assignees: ["alice"] });
    w.github.parents.set(41, 40);
    w.github.branches.add("40-last");
    w.github.prs.push({ number: 70, head: "40-last-41", base: "40-last", state: "merged" });
    await w.norn("take", "41");
    await w.norn("done", "41");
    w.setNow("2026-10-13T13:00:00Z");
    w.github.mergePullRequest(1000);
    await w.github.closeIssue(40, "completed");

    const res = await observe(await w.ctx(), {});

    expect(res.feed.filter((e) => e.issue === 40).map((e) => [e.kind, "action" in e ? e.action : e.kind === "step" ? e.to : "", e.at.slice(11, 16)])).toEqual([
      ["step", "closed", "13:00"],
      ["pr", "merged", "13:00"],
      ["step", "needs-review", "12:00"],
      ["pr", "opened", "12:00"],
    ]);
    expect(res.feed.find((e) => e.kind === "pr")).toMatchObject({ target: "story", pr: 1000 });
  });
});

describe("observe: review fixes", () => {
  test("outcomes norn wrote in the same words each get their own fix round", async () => {
    const w = story();
    const ctx = await w.ctx();
    for (const note of ["A", "B"]) {
      await take(ctx, 11, { takeover: false });
      await done(ctx, 11, {});
      await take(ctx, 11, { takeover: false });
      await done(ctx, 11, { word: "request-changes", note });
    }
    await take(ctx, 11, { takeover: false });
    await done(ctx, 11, {});

    const res = await observe(await w.ctx(), {});

    const implemented = res.feed.filter((e) => e.kind === "outcome" && e.step === "implementation");
    expect(implemented.map((e) => e.kind === "outcome" && e.fixRound)).toEqual([2, 1, null]);
  });

  test("a claim that went stale before the last read is no new event", async () => {
    const w = story();
    await w.norn("take", "11");
    w.setNow("2026-10-13T14:00:30Z");
    const first = await observe(await w.ctx(), {});

    w.setNow("2026-10-13T14:02:00Z");
    const second = await observe(await w.ctx(), { since: "2026-10-13T13:59:30.000Z", previous: first });

    expect(second.feed.filter((e) => e.kind === "claim")).toEqual([]);
  });
});
