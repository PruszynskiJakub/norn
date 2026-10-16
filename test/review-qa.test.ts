import { describe, expect, test } from "vitest";
import { setup } from "./harness.js";

function issue(labels: string[], number = 131) {
  const w = setup();
  w.github.seedIssue({ number, title: "Per-key limits", labels });
  return w;
}

describe("review", () => {
  test.each([
    [["type:slice", "mode:afk"], "approve", ["mode:afk", "needs-qa", "type:slice"]],
    [["type:slice", "mode:afk"], "request-changes", ["changes-requested", "mode:afk", "type:slice"]],
    [["type:story"], "request-changes", ["changes-requested", "type:story"]],
  ])("%j in needs-review finished with %s", async (labels, word, after) => {
    const w = issue([...labels, "needs-review"]);
    const take = await w.psdd("take", "131");
    expect(take.stdout).toContain("Invoke the skill: review");

    const res = await w.psdd("done", "131", word, "Review notes");

    expect(res.exitCode).toBe(0);
    expect(w.github.labels(131).sort()).toEqual(after);
    expect(w.github.comments(131).at(-1)).toContain("Review notes");
  });

  test.each([
    [
      ["type:slice", "mode:hil"],
      ["mode:hil", "needs-qa", "type:slice"],
    ],
    [["type:story"], ["needs-qa", "type:story"]],
  ])("approving %j always goes to QA by an agent first, with no needs-human", async (labels, after) => {
    const w = issue([...labels, "needs-review"]);
    await w.psdd("take", "131");
    await w.psdd("done", "131", "approve");
    expect(w.github.labels(131).sort()).toEqual(after);
  });
});

describe("agent QA (needs-qa)", () => {
  test.each([
    [["type:slice", "mode:afk"], "pass", "merge-queue"],
    [["type:slice", "mode:afk"], "fail", "qa-failed"],
    [["type:slice", "mode:hil"], "pass", "needs-human-qa"],
    [["type:slice", "mode:hil"], "fail", "qa-failed"],
    [["type:story"], "pass", "needs-human-qa"],
    [["type:story"], "fail", "qa-failed"],
  ])("%j, %s → %s", async (labels, word, to) => {
    const w = issue([...labels, "needs-qa"]);
    const take = await w.psdd("take", "131");
    expect(take.stdout).toContain("Invoke the skill: auto-qa");
    expect(take.stdout).not.toContain("attended");

    const res = await w.psdd("done", "131", word, "Behaviour 1: ran it, saw it");

    expect(res.exitCode).toBe(0);
    expect(w.github.labels(131).sort()).toEqual([...labels, to].sort());
    expect(w.github.comments(131).at(-1)).toContain("Behaviour 1: ran it, saw it");
  });

  test("the note is the evidence pack, so it is required", async () => {
    const w = issue(["type:slice", "mode:afk", "needs-qa"]);
    await w.psdd("take", "131");
    const res = await w.psdd("done", "131", "pass");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('psdd done 131 pass "evidence" [--evidence <dir>]');
  });

  test("an afk slice's briefing says what cannot be checked is escalated, never passed", async () => {
    const w = issue(["type:slice", "mode:afk", "needs-qa"]);
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.parents.set(131, 123);
    const take = await w.psdd("take", "131");
    expect(take.stdout).toContain('A criterion you cannot check is never passed: run psdd escalate 131 "reason".');
    expect(take.stdout).toContain('psdd done 131 pass "evidence" [--evidence <dir>]');
  });

  test("a hil slice's briefing says to list what is left for a person", async () => {
    const w = issue(["type:slice", "mode:hil", "needs-qa"]);
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.parents.set(131, 123);
    const take = await w.psdd("take", "131");
    expect(take.stdout).toContain("A person QAs this after you.");
    expect(take.stdout).not.toContain("A criterion you cannot check is never passed");
  });
});

describe("QA by a person (needs-human-qa)", () => {
  test.each([
    [["type:slice", "mode:hil"], "pass", "merge-queue"],
    [["type:slice", "mode:hil"], "fail", "qa-failed"],
    [["type:story"], "pass", "merge-queue"],
    [["type:story"], "fail", "qa-failed"],
  ])("%j, %s → %s", async (labels, word, to) => {
    const w = issue([...labels, "needs-human-qa"]);
    const take = await w.psdd("take", "131");
    expect(take.stdout).toContain("Invoke the skill: qa");
    expect(take.stdout.replace(/\s+/g, " ")).toContain("This step is attended");

    await w.psdd("done", "131", word, "QA notes");

    expect(w.github.labels(131).sort()).toEqual([...labels, to].sort());
  });

  test("the briefing starts from the agent's evidence and makes remarks outside the criteria follow-ups", async () => {
    const w = issue(["type:slice", "mode:hil", "needs-human-qa"]);
    w.github.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"] });
    w.github.parents.set(131, 123);
    const take = await w.psdd("take", "131");
    expect(take.stdout).toContain("Start from the agent's QA comment on #131");
    expect(take.stdout).toContain("follow up (the default): gh issue create");
  });

  test("needs-human on an item in QA is an escalation, cleared by resolve; the state stays", async () => {
    const w = issue(["type:slice", "mode:hil", "needs-human-qa", "needs-human"]);
    const take = await w.psdd("take", "131");
    expect(take.stdout).toContain("Invoke the skill: resolve");
    await w.psdd("done", "131");
    expect(w.github.labels(131).sort()).toEqual(["mode:hil", "needs-human-qa", "type:slice"]);
  });
});

describe("QA evidence", () => {
  const files = [
    { path: "behaviour-1.png", content: Buffer.from("png") },
    { path: "logs/run 1.txt", content: Buffer.from("ok") },
  ];

  test("--evidence pushes the files to psdd/qa/<issue> and embeds them in the comment at that commit", async () => {
    const w = issue(["type:slice", "mode:afk", "needs-qa"]);
    w.workspace.evidence.set("qa-out", files);
    await w.psdd("take", "131");

    const res = await w.psdd("done", "131", "pass", "Behaviour 1: passed, see the screenshot", "--evidence", "qa-out");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Pushed 2 evidence files to psdd/qa/131 and embedded them in the comment.");
    const [push] = w.github.pushed;
    expect(push).toMatchObject({ branch: "psdd/qa/131", parent: null });
    expect(push.files.map((f) => f.path)).toEqual(["behaviour-1.png", "logs/run 1.txt"]);
    const comment = w.github.comments(131).at(-1)!;
    expect(comment).toContain(`Evidence (psdd/qa/131 at ${push.sha.slice(0, 7)}):`);
    expect(comment).toContain(`![behaviour-1.png](https://github.com/acme/app/blob/${push.sha}/behaviour-1.png?raw=true)`);
    expect(comment).toContain(`- [logs/run 1.txt](https://github.com/acme/app/blob/${push.sha}/logs/run%201.txt)`);
    expect(w.github.labels(131)).toContain("merge-queue");
  });

  test("each round's evidence is a new commit on top of the last, so earlier comments keep theirs", async () => {
    const w = issue(["type:slice", "mode:hil", "needs-qa"]);
    w.workspace.evidence.set("qa-out", files);
    await w.psdd("take", "131");
    await w.psdd("done", "131", "pass", "agent pack", "--evidence", "qa-out");
    await w.psdd("take", "131");
    await w.psdd("done", "131", "fail", "the person's repro", "--evidence", "qa-out");

    const [first, second] = w.github.pushed;
    expect(second.parent).toBe(first.sha);
    expect(w.github.comments(131).at(-1)).toContain(`/blob/${second.sha}/`);
    expect(w.github.labels(131)).toContain("qa-failed");
  });

  test("a missing or empty directory is refused before any change", async () => {
    const w = issue(["type:slice", "mode:afk", "needs-qa"]);
    w.workspace.evidence.set("empty", []);
    await w.psdd("take", "131");

    const missing = await w.psdd("done", "131", "pass", "notes", "--evidence", "nope");
    const empty = await w.psdd("done", "131", "pass", "notes", "--evidence", "empty");

    expect(missing.stdout).toContain("nope is not a directory.");
    expect(empty.stdout).toContain("empty is empty.");
    expect(w.github.labels(131)).toContain("needs-qa");
    expect(w.github.claim(131)).not.toBeNull();
  });

  test("--evidence is refused outside the QA steps", async () => {
    const w = issue(["type:slice", "mode:afk", "needs-review"]);
    w.workspace.evidence.set("qa-out", files);
    await w.psdd("take", "131");
    const res = await w.psdd("done", "131", "approve", "--evidence", "qa-out");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("--evidence is for QA steps; review takes none.");
    expect(w.github.pushed).toEqual([]);
  });
});

describe("story fixes", () => {
  test.each(["changes-requested", "qa-failed"])("a story in %s is fixed on the story branch with implement, then goes back to needs-review", async (state) => {
    const w = issue(["type:story", state], 123);
    w.github.issues.get(123)!.title = "Rate limiting";
    const take = await w.psdd("take", "123");
    expect(take.stdout).toContain("Invoke the skill: implement");
    expect(take.stdout).toContain("123-rate-limiting");
    expect(w.github.labels(123)).toContain(state);

    await w.psdd("done", "123");

    expect(w.github.labels(123).sort()).toEqual(["needs-review", "type:story"]);
  });
});
