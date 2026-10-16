import { describe, expect, test } from "vitest";
import { type Exec, GhError, GhGitHub, ghFailure } from "@psdd/github-gh";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

const page = <T>(nodes: T[], next: string | null = null) => ({ pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes });

function item(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `I_${n}`,
    number: n,
    title: `Issue ${n}`,
    url: `https://github.com/acme/app/issues/${n}`,
    state: "OPEN",
    stateReason: null,
    closedAt: null,
    repository: { url: "https://github.com/acme/app" },
    labels: page([{ name: "type:slice" }, { name: "needs-review" }]),
    blockedBy: page([]),
    timelineItems: page([]),
    ...over,
  };
}

const comment = (at: string, body: string, login = "alice") => ({
  __typename: "IssueComment",
  createdAt: at,
  author: { login },
  url: `https://github.com/acme/app/issues/10#c-${at}`,
  body,
});

/** Scripted gh and git: `gh` answers each GraphQL call by what its query asks for. */
function scripted(answer: (query: string, vars: Record<string, string>) => unknown, lsRemote = `${SHA}\trefs/psdd/claims/11\n`) {
  const calls: { args: string[]; query: string; vars: Record<string, string> }[] = [];
  const gh: Exec = async (args) => {
    const vars: Record<string, string> = {};
    let query = "";
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== "-f" && args[i] !== "-F") continue;
      const [k, ...v] = args[++i].split("=");
      if (k === "query") query = v.join("=");
      else vars[k] = v.join("=");
    }
    calls.push({ args, query, vars });
    return { code: 0, stdout: JSON.stringify(answer(query, vars)), stderr: "" };
  };
  const gitCalls: string[][] = [];
  const git: Exec = async (args) => {
    gitCalls.push(args);
    return { code: 0, stdout: lsRemote, stderr: "" };
  };
  return { github: new GhGitHub(gh, git), calls, gitCalls };
}

const repo = (over: Record<string, unknown> = {}) => ({
  data: { repository: { url: "https://github.com/acme/app", open: page([]), closed: page([]), ...over } },
});

const QUERY = { user: "alice", closedSince: "2026-10-06T12:00:00.000Z", since: null };

describe("GhGitHub.observeWork", () => {
  test("reads the stories, their slices and the claim records in one GraphQL query, and the claim refs with git ls-remote", async () => {
    const psdd = "psdd: needs-review → changes-requested (request-changes)\n\nAdd a test";
    const slice = item(11, {
      blockedBy: page([{ number: 12, state: "CLOSED" }]),
      timelineItems: page([
        { __typename: "LabeledEvent", createdAt: "2026-10-13T12:00:00Z", actor: { login: "alice" }, label: { name: "changes-requested" } },
        comment("2026-10-13T12:00:01Z", psdd),
        comment("2026-10-13T12:05:00Z", "Looks odd to me", "bob"),
        {
          __typename: "CrossReferencedEvent",
          source: {
            number: 70,
            url: "https://github.com/acme/app/pull/70",
            headRefName: "10-x-11",
            baseRefName: "10-x",
            state: "MERGED",
            createdAt: "2026-10-13T11:00:00Z",
            mergedAt: "2026-10-13T13:00:00Z",
            author: { login: "alice" },
            mergedBy: null,
          },
        },
        { __typename: "CrossReferencedEvent", source: {} },
        { __typename: "RenamedTitleEvent", createdAt: "2026-10-13T12:06:00Z", actor: null },
      ]),
    });
    const elsewhere = item(99, { repository: { url: "https://github.com/acme/other" } });
    const story = item(10, { labels: page([{ name: "type:story" }, { name: "implementation" }]), subIssues: page([slice, elsewhere]) });
    const { github, calls, gitCalls } = scripted(() =>
      repo({ open: page([story]), c0: { message: JSON.stringify({ holder: "alice", session: "s1", since: "2026-10-13T12:00:00Z" }) } }),
    );

    const work = await github.observeWork(QUERY);

    expect(gitCalls).toEqual([["ls-remote", "origin", "refs/psdd/claims/*"]]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 6)).toEqual(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}"]);
    expect(calls[0].vars).toEqual({ owner: "{owner}", name: "{repo}", user: "alice", closedSince: "2026-10-06T12:00:00.000Z" });
    expect(calls[0].query).toContain(`c0: object(oid: "${SHA}") { ... on Commit { message } }`);
    expect(work.repoUrl).toBe("https://github.com/acme/app");
    expect(work.claims).toEqual([{ issue: 11, sha: SHA, record: { holder: "alice", session: "s1", since: "2026-10-13T12:00:00Z" } }]);
    expect(work.stories.map((s) => [s.number, s.subIssues.map((i) => i.number)])).toEqual([[10, [11]]]);
    expect(work.stories[0].subIssues[0]).toEqual({
      number: 11,
      title: "Issue 11",
      state: "open",
      labels: ["type:slice", "needs-review"],
      assignees: [],
      url: "https://github.com/acme/app/issues/11",
      closedAt: null,
      blockedBy: [{ number: 12, state: "closed" }],
      psddComments: [{ body: psdd, at: "2026-10-13T12:00:01Z", actor: "alice", url: "https://github.com/acme/app/issues/10#c-2026-10-13T12:00:01Z" }],
      pullRequests: [
        {
          number: 70,
          url: "https://github.com/acme/app/pull/70",
          head: "10-x-11",
          base: "10-x",
          state: "merged",
          createdAt: "2026-10-13T11:00:00Z",
          mergedAt: "2026-10-13T13:00:00Z",
          author: "alice",
          mergedBy: null,
        },
      ],
      timeline: [
        { kind: "labeled", label: "changes-requested", at: "2026-10-13T12:00:00Z", actor: "alice" },
        { kind: "comment", at: "2026-10-13T12:00:01Z", actor: "alice", url: "https://github.com/acme/app/issues/10#c-2026-10-13T12:00:01Z", body: psdd },
        { kind: "comment", at: "2026-10-13T12:05:00Z", actor: "bob", url: "https://github.com/acme/app/issues/10#c-2026-10-13T12:05:00Z", body: null },
        { kind: "other", at: "2026-10-13T12:06:00Z", actor: null, url: null, detail: "RenamedTitleEvent" },
      ],
    });
  });

  test("with since, the timeline holds only later items while psdd's comments stay whole", async () => {
    const story = item(10, {
      labels: page([{ name: "type:story" }]),
      timelineItems: page([
        comment("2026-10-13T12:00:00Z", "psdd: slug x"),
        { __typename: "ClosedEvent", createdAt: "2026-10-13T13:00:00Z", actor: { login: "alice" } },
      ]),
      subIssues: page([]),
    });
    const { github } = scripted(() => repo({ open: page([story]) }), "");

    const [s] = (await github.observeWork({ ...QUERY, since: "2026-10-13T12:30:00Z" })).stories;

    expect(s.timeline).toEqual([{ kind: "closed", at: "2026-10-13T13:00:00Z", actor: "alice" }]);
    expect(s.psddComments.map((c) => c.body)).toEqual(["psdd: slug x"]);
  });

  test("follows every page: stories, sub-issues and timelines", async () => {
    const { github, calls } = scripted((query, vars) => {
      if (query.includes("subIssues(first: 20, after: $after)")) return { data: { node: { subIssues: page([item(13)]) } } };
      if (query.includes("timelineItems(first: 100, after: $after")) {
        return { data: { node: { timelineItems: page([{ __typename: "ClosedEvent", createdAt: "2026-10-13T13:00:00Z", actor: null }]) } } };
      }
      if (vars.openAfter === "s1") return repo({ open: page([item(20, { labels: page([{ name: "type:story" }]), subIssues: page([]) })]) });
      return repo({
        open: page([item(10, { labels: page([{ name: "type:story" }]), subIssues: page([item(11, { timelineItems: page([], "t1") })], "p1") })], "s1"),
      });
    }, "");

    const work = await github.observeWork(QUERY);

    expect(work.stories.map((s) => [s.number, s.subIssues.map((i) => i.number)])).toEqual([
      [10, [11, 13]],
      [20, []],
    ]);
    expect(work.stories[0].subIssues[0].timeline).toEqual([{ kind: "closed", at: "2026-10-13T13:00:00Z", actor: null }]);
    expect(calls.map((c) => c.vars.openAfter ?? c.vars.after ?? "-")).toEqual(["-", "s1", "p1", "t1"]);
  });

  test("a claim of mine on an item outside my stories brings its story in", async () => {
    const lines = `${SHA}\trefs/psdd/claims/31\n${OTHER}\trefs/psdd/claims/41\nffff\trefs/heads/main\n`;
    const bobs = item(30, { labels: page([{ name: "type:story" }]), assignees: page([{ login: "bob" }]), subIssues: page([item(31)]) });
    const { github, calls } = scripted((query) => {
      if (query.includes("x0: issue(number: 31)")) return { data: { repository: { x0: { ...item(31), parent: bobs } } } };
      return repo({
        c0: { message: JSON.stringify({ holder: "alice", session: "s1", since: "2026-10-13T12:00:00Z" }) },
        c1: { message: JSON.stringify({ holder: "bob", session: "s9", since: "2026-10-13T12:00:00Z" }) },
      });
    }, lines);

    const work = await github.observeWork(QUERY);

    expect(work.claims.map((c) => [c.issue, c.record?.holder])).toEqual([
      [31, "alice"],
      [41, "bob"],
    ]);
    expect(calls).toHaveLength(2);
    expect(work.stories.map((s) => [s.number, s.assignees, s.subIssues.map((i) => i.number)])).toEqual([[30, ["bob"], [31]]]);
  });
});

describe("ghFailure", () => {
  test("sorts a failed read by what the user can do about it", () => {
    expect(ghFailure(new GhError(["api"], "gh: Bad credentials (HTTP 401)"))).toBe("auth");
    expect(ghFailure(new GhError(["api"], "To get started with GitHub CLI, please run:  gh auth login"))).toBe("auth");
    expect(ghFailure(new GhError(["api"], "GraphQL: API rate limit exceeded for user ID 1"))).toBe("rate-limit");
    expect(ghFailure(new GhError(["api"], "error connecting to api.github.com\ncheck your internet connection"))).toBe("network");
    expect(ghFailure(new GhError(["api"], "GraphQL: Something went wrong"))).toBe("other");
  });
});
