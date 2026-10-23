import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SKILLS } from "@norn/cli";
import { setup } from "@norn/testing";

/**
 * Pins the exact text and --json output of every command, refusals included,
 * so a change to how norn builds its answers cannot change what it prints.
 */

type World = ReturnType<typeof setup>;

interface Scenario {
  name: string;
  arrange?: (w: World) => unknown;
  argv: string[];
  /** Runs the command somewhere other than the default harness, e.g. in a project directory for init. */
  via?: (w: World) => (...argv: string[]) => ReturnType<World["norn"]>;
}

/** Story #123 in implementation with slices in most states, and branches on GitHub. */
function story(w: World) {
  const gh = w.github;
  gh.seedIssue({ number: 123, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
  gh.seedIssue({ number: 127, title: "Redis store", labels: ["type:slice", "mode:afk", "merge-queue"] });
  gh.seedIssue({ number: 128, title: "Limit headers", labels: ["type:slice", "mode:hil", "needs-review"] });
  gh.seedIssue({ number: 131, title: "Per-key limits", labels: ["type:slice", "mode:afk", "blocked"] });
  gh.seedIssue({ number: 132, title: "Docs", labels: ["type:slice", "mode:afk", "ready-for-agent"] });
  gh.seedIssue({ number: 133, title: "Metrics", labels: ["type:slice", "mode:hil", "needs-human-qa"] });
  gh.seedIssue({ number: 134, title: "Old", state: "closed", stateReason: "completed", labels: ["type:slice", "mode:afk"] });
  for (const s of [127, 128, 131, 132, 133, 134]) gh.parents.set(s, 123);
  gh.blockers.set(131, [127]);
  gh.commentsByIssue.set(123, ["norn: needs-slicing → implementation\n\nnorn: slug rate-limiting"]);
  gh.branches.add("123-rate-limiting");
}

function slicing(w: World) {
  w.github.seedIssue({ number: 50, title: "Search", labels: ["type:story", "needs-slicing"], assignees: ["alice"] });
}

/** #50 in slicing, whose session asked a person with escalate --wait. */
async function waiting(w: World) {
  slicing(w);
  await w.norn("take", "50");
  await w.norn("escalate", "50", "Two slices or three?", "--wait");
}

function provider(w: World, env: Record<string, string>) {
  w.workspace.env = env;
}

const scenarios: Scenario[] = [
  // Dispatch
  { name: "usage", argv: [] },
  { name: "unknown command", argv: ["frobnicate"] },
  { name: "missing issue number", argv: ["take"] },
  // Node words most JSON errors differently from version to version; this one reads the same on every Node from 20 on.
  { name: "bad config", arrange: (w) => w.workspace.files.set(".agents/norn.config.json", "nope"), argv: ["status", "1"] },
  {
    name: "config problems",
    arrange: (w) => {
      w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ foo: 1, notifications: "os", deliver: { maxParallel: 0 } }));
      w.workspace.files.set(".agents/norn.config.local.json", JSON.stringify({ worktrees: { provider: "tmux" } }));
    },
    argv: ["status", "1"],
  },
  {
    name: "config warnings before the answer",
    arrange: (w) => {
      w.github.seedIssue({ number: 1, title: "A story", labels: ["type:story", "needs-plan"] });
      w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ nornVersion: "1.4.2", claims: { staleAfter: "1m" } }));
      w.workspace.files.set(".agents/norn.config.local.json", JSON.stringify({ deliver: { maxFixRounds: 2 } }));
    },
    argv: ["status", "1"],
  },
  {
    name: "provider refusal",
    arrange: (w) => w.workspace.files.set(".agents/norn.config.local.json", JSON.stringify({ worktrees: { provider: "herdr" } })),
    argv: ["next", "1"],
  },

  // init
  {
    name: "init",
    argv: ["init"],
    via: (w) => {
      const cwd = mkdtempSync(join(tmpdir(), "norn-char-"));
      return w.withProject(cwd, async (dir) => {
        for (const name of SKILLS) {
          mkdirSync(join(dir, ".agents", "skills", name), { recursive: true });
          writeFileSync(join(dir, ".agents", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
        }
        return ["norn-drive"];
      });
    },
  },
  // doctor and the version
  { name: "doctor with problems", argv: ["doctor"] },
  { name: "doctor without gh", arrange: (w) => (w.github.ghAuthState = { kind: "missing" }), argv: ["doctor"] },
  {
    name: "incompatible version",
    arrange: (w) => w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ nornVersion: "2.0.0" })),
    argv: ["status", "1"],
  },
  { name: "version", argv: ["--version"] },
  {
    name: "init with missing skills",
    argv: ["init"],
    via: (w) => w.withProject(mkdtempSync(join(tmpdir(), "norn-char-")), async () => []),
  },

  // flows
  { name: "flows export", argv: ["flows", "export", "story"], via: (w) => w.withDeps({ cwd: mkdtempSync(join(tmpdir(), "norn-char-")) }) },
  {
    name: "flows export over an existing file",
    argv: ["flows", "export", "slice"],
    via: (w) => {
      const cwd = mkdtempSync(join(tmpdir(), "norn-char-"));
      mkdirSync(join(cwd, ".agents", "flows"), { recursive: true });
      writeFileSync(join(cwd, ".agents", "flows", "slice.json"), "{}\n");
      return w.withDeps({ cwd });
    },
  },
  { name: "flows export of a flow that is not built in", argv: ["flows", "export", "bug"] },
  { name: "flows without export", argv: ["flows"] },

  // status
  {
    name: "status of a story with slices",
    arrange: (w) => {
      story(w);
      w.github.issues.get(128)?.labels.push("needs-human");
      w.github.claims.set(128, { holder: "bob", session: "s", since: "2026-10-13T09:00:00Z" });
      w.github.claims.set(132, { holder: "bob", session: "s", since: "2026-10-13T11:30:00Z" });
    },
    argv: ["status", "123"],
  },
  { name: "status of a story without slices", arrange: slicing, argv: ["status", "50"] },
  {
    name: "status with two state labels",
    arrange: (w) => w.github.seedIssue({ number: 9, title: "Twice", labels: ["type:story", "needs-plan", "needs-slicing"] }),
    argv: ["status", "9"],
  },

  // next
  { name: "next on a slice", arrange: story, argv: ["next", "127"] },
  { name: "next on a new issue", arrange: (w) => w.github.seedIssue({ number: 5, title: "New" }), argv: ["next", "5"] },
  { name: "next on a story in implementation (claude-code)", arrange: story, argv: ["next", "123"] },
  {
    name: "next on a story in implementation (herdr)",
    arrange: (w) => {
      story(w);
      provider(w, { HERDR_ENV: "1" });
      w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting-132");
      w.workspace.checkedOut.set("123-rate-limiting-127", "/elsewhere");
    },
    argv: ["next", "123"],
  },
  {
    name: "next on a story in implementation (git)",
    arrange: (w) => {
      story(w);
      provider(w, {});
      w.github.claims.set(128, { holder: "alice", session: "other", since: "2026-10-13T11:00:00Z" });
    },
    argv: ["next", "123"],
  },
  {
    name: "next with every slot taken",
    arrange: (w) => {
      story(w);
      w.workspace.files.set(".agents/norn.config.json", JSON.stringify({ nornVersion: "1.4.2", deliver: { maxParallel: 1 } }));
      w.github.claims.set(128, { holder: "alice", session: "other", since: "2026-10-13T11:00:00Z" });
    },
    argv: ["next", "123"],
  },
  {
    name: "next with nothing left",
    arrange: (w) => {
      w.github.seedIssue({ number: 20, title: "Waits", labels: ["type:story", "implementation"] });
      w.github.seedIssue({ number: 21, title: "Needs a person", labels: ["type:slice", "mode:afk", "needs-review", "needs-human"] });
      w.github.seedIssue({ number: 22, title: "Blocked", labels: ["type:slice", "mode:afk", "blocked"] });
      w.github.seedIssue({ number: 23, title: "Human QA", labels: ["type:slice", "mode:hil", "needs-human-qa"] });
      for (const s of [21, 22, 23]) w.github.parents.set(s, 20);
      w.github.blockers.set(22, [21]);
      w.github.commentsByIssue.set(21, ['norn: needs-review → needs-review\n\nnorn: needs-human — escalated: "flaky"']);
      w.github.branches.add("20-waits");
    },
    argv: ["next", "20"],
  },
  {
    name: "next with nothing left under herdr",
    arrange: (w) => {
      provider(w, { HERDR_ENV: "1" });
      w.github.seedIssue({ number: 20, title: "Waits", labels: ["type:story", "implementation"] });
      w.github.seedIssue({ number: 23, title: "Human QA", labels: ["type:slice", "mode:hil", "needs-human-qa"] });
      w.github.seedIssue({ number: 24, title: "Held QA", labels: ["type:slice", "mode:hil", "needs-human-qa"] });
      w.github.parents.set(23, 20);
      w.github.parents.set(24, 20);
      w.github.claims.set(24, { holder: "bob", session: "s", since: "2026-10-13T11:00:00Z" });
      w.github.branches.add("20-waits");
    },
    argv: ["next", "20"],
  },
  {
    name: "next on a story in merge-queue",
    arrange: (w) => w.github.seedIssue({ number: 30, title: "Ship", labels: ["type:story", "merge-queue"], assignees: ["alice"] }),
    argv: ["next", "30"],
  },
  {
    name: "next closes a merged story",
    arrange: (w) => {
      w.github.seedIssue({ number: 30, title: "Ship", labels: ["type:story", "merge-queue"], assignees: ["alice"] });
      w.github.prs.push({ number: 99, head: "30-ship", base: "main", state: "merged" });
    },
    argv: ["next", "30"],
  },
  {
    name: "next on a story closed as not planned",
    arrange: (w) => w.github.seedIssue({ number: 31, title: "Nope", state: "closed", stateReason: "not_planned", labels: ["type:story"] }),
    argv: ["next", "31"],
  },
  {
    name: "next on a story in refinement",
    arrange: (w) => w.github.seedIssue({ number: 32, title: "Refine me", labels: ["type:story", "needs-refinement"] }),
    argv: ["next", "32"],
  },
  {
    name: "next on a story in refinement under herdr",
    arrange: (w) => {
      provider(w, { HERDR_ENV: "1" });
      w.github.seedIssue({ number: 32, title: "Refine me", labels: ["type:story", "needs-refinement"] });
    },
    argv: ["next", "32"],
  },
  {
    name: "next creates the story branch and moves a merged story on",
    arrange: (w) => {
      w.github.seedIssue({ number: 40, title: "All done", labels: ["type:story", "implementation"] });
      w.github.seedIssue({ number: 41, title: "Only", state: "closed", stateReason: "completed", labels: ["type:slice", "mode:afk"] });
      w.github.parents.set(41, 40);
    },
    argv: ["next", "40"],
  },
  {
    name: "next when the story branch cannot be made",
    arrange: (w) => {
      w.github.seedIssue({ number: 40, title: "No base", labels: ["type:story", "implementation"] });
      w.github.branches.delete("main");
    },
    argv: ["next", "40"],
  },

  // take
  { name: "take a new issue", arrange: (w) => w.github.seedIssue({ number: 7, title: "Rate limiting" }), argv: ["take", "7"] },
  {
    name: "take a closed issue",
    arrange: (w) => w.github.seedIssue({ number: 7, title: "Gone", state: "closed", labels: ["type:story"] }),
    argv: ["take", "7"],
  },
  { name: "take a story in implementation", arrange: story, argv: ["take", "123"] },
  {
    name: "take a story in merge-queue",
    arrange: (w) => w.github.seedIssue({ number: 30, title: "Ship", labels: ["type:story", "merge-queue"], assignees: ["alice"] }),
    argv: ["take", "30"],
  },
  { name: "take a blocked slice", arrange: story, argv: ["take", "131"] },
  {
    name: "take an issue with two states",
    arrange: (w) => w.github.seedIssue({ number: 9, title: "Twice", labels: ["type:story", "needs-plan", "needs-slicing"] }),
    argv: ["take", "9"],
  },
  {
    name: "take a slice held by another session",
    arrange: (w) => {
      story(w);
      w.github.claims.set(132, { holder: "bob", session: "s", since: "2026-10-13T11:30:00Z" });
    },
    argv: ["take", "132"],
  },
  {
    name: "take an issue held by another session of yours",
    arrange: (w) => {
      slicing(w);
      w.github.claims.set(50, { holder: "alice", session: "s", since: "2026-10-13T11:30:00Z" });
    },
    argv: ["take", "50"],
  },
  {
    name: "take over a teammate's issue",
    arrange: (w) => {
      slicing(w);
      w.github.claims.set(50, { holder: "bob", session: "s", since: "2026-10-13T11:30:00Z" });
    },
    argv: ["take", "50", "--takeover"],
  },
  {
    name: "take over a stale claim",
    arrange: (w) => {
      slicing(w);
      w.github.claims.set(50, { holder: "bob", session: "s", since: "2026-10-13T08:00:00Z" });
      w.workspace.worktrees.add(".agents/worktrees/50-search");
    },
    argv: ["take", "50"],
  },
  {
    name: "take again while holding",
    arrange: async (w) => {
      slicing(w);
      await w.norn("take", "50");
    },
    argv: ["take", "50"],
  },
  {
    name: "take again with a dirty worktree",
    arrange: async (w) => {
      story(w);
      w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting-132");
      w.github.branches.add("123-rate-limiting-132");
      await w.norn("take", "132");
      w.workspace.dirty.add(".agents/worktrees/123-rate-limiting-132");
    },
    argv: ["take", "132"],
  },
  { name: "take a ready slice", arrange: story, argv: ["take", "132"] },
  {
    name: "take a slice outside a story",
    arrange: (w) => w.github.seedIssue({ number: 66, title: "Orphan", labels: ["type:slice", "mode:afk", "ready-for-agent"] }),
    argv: ["take", "66"],
  },
  {
    name: "take a slice with a dirty worktree",
    arrange: (w) => {
      story(w);
      w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting-132");
      w.workspace.dirty.add(".agents/worktrees/123-rate-limiting-132");
      w.github.branches.add("123-rate-limiting-132");
    },
    argv: ["take", "132"],
  },
  {
    name: "take a slice checked out elsewhere",
    arrange: (w) => {
      story(w);
      w.workspace.checkedOut.set("123-rate-limiting-132", "/elsewhere");
    },
    argv: ["take", "132"],
  },
  { name: "take a slice for review", arrange: story, argv: ["take", "128"] },
  { name: "take a slice for merge", arrange: story, argv: ["take", "127"] },
  { name: "take a slice for human QA", arrange: story, argv: ["take", "133"] },
  {
    name: "take a slice for agent QA (afk)",
    arrange: (w) => {
      story(w);
      w.github.seedIssue({ number: 60, title: "QA me", labels: ["type:slice", "mode:afk", "needs-qa"] });
      w.github.parents.set(60, 123);
    },
    argv: ["take", "60"],
  },
  {
    name: "take a story for agent QA",
    arrange: (w) => w.github.seedIssue({ number: 61, title: "QA story", labels: ["type:story", "needs-qa"] }),
    argv: ["take", "61"],
  },
  {
    name: "take a story in rework",
    arrange: (w) => w.github.seedIssue({ number: 62, title: "Fix story", labels: ["type:story", "changes-requested"] }),
    argv: ["take", "62"],
  },
  { name: "take a story for slicing", arrange: slicing, argv: ["take", "50"] },
  {
    name: "take a story for planning under git",
    arrange: (w) => {
      provider(w, {});
      w.github.seedIssue({ number: 63, title: "Plan it", labels: ["type:story", "needs-plan"] });
      w.workspace.localBranches.add("63-plan-it");
    },
    argv: ["take", "63"],
  },
  {
    name: "take a story needing a human",
    arrange: (w) => w.github.seedIssue({ number: 64, title: "Stuck", labels: ["type:story", "needs-clarification", "needs-human"] }),
    argv: ["take", "64"],
  },

  // done
  { name: "done without the claim", arrange: slicing, argv: ["done", "50"] },
  {
    name: "done on another session's claim",
    arrange: (w) => {
      slicing(w);
      w.github.claims.set(50, { holder: "bob", session: "s", since: "2026-10-13T11:30:00Z" });
    },
    argv: ["done", "50"],
  },
  {
    name: "done without an outcome",
    arrange: async (w) => {
      w.github.seedIssue({ number: 7, title: "New" });
      await w.norn("take", "7");
    },
    argv: ["done", "7"],
  },
  {
    name: "done with an unknown outcome",
    arrange: async (w) => {
      w.github.seedIssue({ number: 60, title: "QA me", labels: ["type:slice", "mode:afk", "needs-qa"] });
      await w.norn("take", "60");
    },
    argv: ["done", "60", "maybe"],
  },
  {
    name: "done without the note",
    arrange: async (w) => {
      w.github.seedIssue({ number: 60, title: "QA me", labels: ["type:slice", "mode:afk", "needs-qa"] });
      await w.norn("take", "60");
    },
    argv: ["done", "60", "fail"],
  },
  {
    name: "done with a note file that is missing",
    arrange: async (w) => {
      w.github.seedIssue({ number: 7, title: "New" });
      await w.norn("take", "7");
    },
    argv: ["done", "7", "reject", "--note-file", "nope.md"],
  },
  {
    name: "done with a note and a note file",
    arrange: async (w) => {
      w.github.seedIssue({ number: 7, title: "New" });
      w.workspace.notes.set("note.md", "Out of scope");
      await w.norn("take", "7");
    },
    argv: ["done", "7", "reject", "Out of scope", "--note-file", "note.md"],
  },
  {
    name: "done with evidence on a step that takes none",
    arrange: async (w) => {
      w.github.seedIssue({ number: 7, title: "New" });
      await w.norn("take", "7");
    },
    argv: ["done", "7", "story", "--evidence", "out"],
  },
  ...(["missing", "empty", "big"] as const).map(
    (kind): Scenario => ({
      name: `done with evidence that is ${kind}`,
      arrange: async (w) => {
        w.github.seedIssue({ number: 60, title: "QA me", labels: ["type:slice", "mode:afk", "needs-qa"] });
        if (kind === "empty") w.workspace.evidence.set("out", []);
        if (kind === "big") w.workspace.evidence.set("out", [{ path: "huge.log", content: Buffer.alloc(26 * 1024 * 1024) }]);
        await w.norn("take", "60");
      },
      argv: ["done", "60", "pass", "ok", "--evidence", "out"],
    }),
  ),
  {
    name: "done with evidence",
    arrange: async (w) => {
      story(w);
      w.github.seedIssue({ number: 60, title: "QA me", labels: ["type:slice", "mode:afk", "needs-qa"] });
      w.github.parents.set(60, 123);
      w.workspace.evidence.set("out", [
        { path: "shot.png", content: Buffer.from("png") },
        { path: "run.log", content: Buffer.from("log") },
      ]);
      await w.norn("take", "60");
    },
    argv: ["done", "60", "pass", "all good", "--evidence", "out"],
  },
  {
    name: "done slicing without slices",
    arrange: async (w) => {
      slicing(w);
      await w.norn("take", "50");
    },
    argv: ["done", "50"],
  },
  {
    name: "done slicing creates the story branch",
    arrange: async (w) => {
      slicing(w);
      await w.norn("take", "50");
      await w.norn("add-slice", "50", "First", "--mode", "afk");
    },
    argv: ["done", "50"],
  },
  {
    name: "done slicing without the base branch",
    arrange: async (w) => {
      slicing(w);
      await w.norn("take", "50");
      await w.norn("add-slice", "50", "First", "--mode", "afk");
      w.github.branches.delete("main");
    },
    argv: ["done", "50"],
  },
  ...(
    [
      ["no PR", null],
      ["an open PR", { base: "123-rate-limiting", state: "open" }],
      ["a PR into main", { base: "main", state: "open" }],
      ["a PR merged into main", { base: "main", state: "merged" }],
    ] as const
  ).map(
    ([what, pr]): Scenario => ({
      name: `done merge with ${what}`,
      arrange: async (w) => {
        story(w);
        if (pr) w.github.prs.push({ number: 70, head: "123-rate-limiting-127", ...pr });
        await w.norn("take", "127");
      },
      argv: ["done", "127"],
    }),
  ),
  {
    name: "done merge of a slice outside a story",
    arrange: async (w) => {
      w.github.seedIssue({ number: 80, title: "Orphan", labels: ["type:slice", "mode:afk", "merge-queue"] });
      await w.norn("take", "80");
    },
    argv: ["done", "80"],
  },
  {
    name: "done merge unblocks and keeps the worktree for tidy",
    arrange: async (w) => {
      story(w);
      w.github.prs.push({ number: 70, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "merged" });
      w.workspace.worktrees.add(".agents/worktrees/123-rate-limiting-127");
      await w.norn("take", "127");
    },
    argv: ["done", "127"],
  },
  {
    name: "done merge of the last slice moves the story on",
    arrange: async (w) => {
      w.github.seedIssue({ number: 40, title: "Last", labels: ["type:story", "implementation"] });
      w.github.seedIssue({ number: 41, title: "Only", labels: ["type:slice", "mode:afk", "merge-queue"] });
      w.github.parents.set(41, 40);
      w.github.branches.add("40-last");
      w.github.prs.push({ number: 70, head: "40-last-41", base: "40-last", state: "merged" });
      await w.norn("take", "41");
    },
    argv: ["done", "41"],
  },
  {
    name: "done when a follow-up fails",
    arrange: async (w) => {
      w.github.seedIssue({ number: 40, title: "Last", labels: ["type:story", "implementation"] });
      w.github.seedIssue({ number: 41, title: "Only", labels: ["type:slice", "mode:afk", "merge-queue"] });
      w.github.parents.set(41, 40);
      w.github.branches.add("40-last");
      w.github.prs.push({ number: 70, head: "40-last-41", base: "40-last", state: "merged" });
      await w.norn("take", "41");
      w.github.createPullRequest = async () => {
        throw new Error("HTTP 502");
      };
    },
    argv: ["done", "41"],
  },
  {
    name: "done triage story",
    arrange: async (w) => {
      w.github.seedIssue({ number: 7, title: "New" });
      await w.norn("take", "7");
    },
    argv: ["done", "7", "story"],
  },
  {
    name: "done triage reject",
    arrange: async (w) => {
      w.github.seedIssue({ number: 7, title: "New" });
      await w.norn("take", "7");
    },
    argv: ["done", "7", "reject", "duplicate of #3"],
  },
  {
    name: "done agent QA pass on a hil slice notifies",
    arrange: async (w) => {
      story(w);
      w.github.seedIssue({ number: 65, title: "Hil", labels: ["type:slice", "mode:hil", "needs-qa"] });
      w.github.parents.set(65, 123);
      await w.norn("take", "65");
    },
    argv: ["done", "65", "pass", "checked"],
  },
  {
    name: "done review hits the fix-round limit",
    arrange: async (w) => {
      story(w);
      w.github.commentsByIssue.set(128, [
        "norn: needs-review → changes-requested (request-changes)",
        "norn: needs-review → changes-requested (request-changes)",
        "norn: needs-review → changes-requested (request-changes)",
      ]);
      await w.norn("take", "128");
    },
    argv: ["done", "128", "request-changes", "still broken"],
  },
  {
    name: "done review requests changes",
    arrange: async (w) => {
      story(w);
      await w.norn("take", "128");
    },
    argv: ["done", "128", "request-changes", "fix the header"],
  },
  {
    name: "done resolving needs-human",
    arrange: async (w) => {
      w.github.seedIssue({ number: 64, title: "Stuck", labels: ["type:story", "needs-clarification", "needs-human"] });
      await w.norn("take", "64");
    },
    argv: ["done", "64"],
  },

  // escalate
  { name: "escalate without a reason", arrange: slicing, argv: ["escalate", "50"] },
  { name: "escalate without the claim", arrange: slicing, argv: ["escalate", "50", "why"] },
  {
    name: "escalate",
    arrange: async (w) => {
      slicing(w);
      await w.norn("take", "50");
    },
    argv: ["escalate", "50", "the spec\ncontradicts itself"],
  },
  {
    name: "escalate --wait",
    arrange: async (w) => {
      slicing(w);
      await w.norn("take", "50");
    },
    argv: ["escalate", "50", "Two slices or three?", "--wait"],
  },
  { name: "done while waiting on a person", arrange: waiting, argv: ["done", "50"] },

  // resume
  { name: "resume without an answer", arrange: waiting, argv: ["resume", "50"] },
  {
    name: "resume when nothing waits",
    arrange: async (w) => {
      slicing(w);
      await w.norn("take", "50");
    },
    argv: ["resume", "50", "Three"],
  },
  { name: "resume", arrange: waiting, argv: ["resume", "50", "Three"] },

  // release
  { name: "release without the claim", arrange: slicing, argv: ["release", "50"] },
  {
    name: "release",
    arrange: async (w) => {
      slicing(w);
      await w.norn("take", "50");
    },
    argv: ["release", "50"],
  },

  // add-slice
  { name: "add-slice without a mode", arrange: slicing, argv: ["add-slice", "50", "Title"] },
  { name: "add-slice without the claim", arrange: slicing, argv: ["add-slice", "50", "Title", "--mode", "afk"] },
  {
    name: "add-slice outside slicing",
    arrange: async (w) => {
      w.github.seedIssue({ number: 32, title: "Refine me", labels: ["type:story", "needs-refinement"] });
      await w.norn("take", "32");
    },
    argv: ["add-slice", "32", "Title", "--mode", "afk"],
  },
  {
    name: "add-slice",
    arrange: async (w) => {
      slicing(w);
      await w.norn("take", "50");
    },
    argv: ["add-slice", "50", "First", "--mode", "hil"],
  },
  {
    name: "add-slice blocked by others",
    arrange: async (w) => {
      slicing(w);
      w.github.seedIssue({ number: 51, title: "Before" });
      w.github.seedIssue({ number: 52, title: "Done before", state: "closed" });
      await w.norn("take", "50");
    },
    argv: ["add-slice", "50", "Second", "--mode", "afk", "--blocked-by", "51", "--blocked-by", "52"],
  },

  // tidy
  { name: "tidy with nothing to do", argv: ["tidy"] },
  {
    name: "tidy",
    arrange: (w) => {
      story(w);
      w.github.issues.get(127)!.state = "closed";
      w.github.issues.get(128)!.state = "closed";
      w.github.prs.push({ number: 70, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "merged" });
      w.github.prs.push({ number: 71, head: "123-rate-limiting-128", base: "123-rate-limiting", state: "merged" });
      for (const b of ["123-rate-limiting-127", "123-rate-limiting-128"]) {
        w.github.branches.add(b);
        w.workspace.localBranches.add(b);
        w.workspace.worktrees.add(`.agents/worktrees/${b}`);
      }
      w.workspace.dirty.add(".agents/worktrees/123-rate-limiting-128");
      w.github.branches.add("norn/qa/127");
      w.github.claims.set(127, { holder: "bob", session: "s", since: "2026-10-13T11:30:00Z" });
      w.workspace.fetchRemote = async () => {
        throw new Error("offline");
      };
      w.github.deleteBranch = async (b) => {
        if (b === "norn/qa/127") throw new Error("protected");
        w.github.branches.delete(b);
      };
    },
    argv: ["tidy"],
  },
  {
    name: "tidy dry run",
    arrange: (w) => {
      story(w);
      w.github.issues.get(127)!.state = "closed";
      w.github.prs.push({ number: 70, head: "123-rate-limiting-127", base: "123-rate-limiting", state: "merged" });
      w.github.branches.add("123-rate-limiting-127");
    },
    argv: ["tidy", "--dry-run"],
  },
];

describe("output of every command, text and --json", () => {
  test.each(scenarios.map((s) => [s.name, s] as const))("%s", async (_name, s) => {
    for (const json of [false, true]) {
      const w = setup();
      await s.arrange?.(w);
      const norn = s.via ? s.via(w) : w.norn;
      const res = await norn(...s.argv, ...(json ? ["--json"] : []));
      expect(`exit ${res.exitCode}\n${res.stdout}`).toMatchSnapshot(json ? "json" : "text");
    }
  });
});
