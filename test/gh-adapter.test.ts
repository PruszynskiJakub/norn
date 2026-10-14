import { describe, expect, test } from "vitest";
import { GhGitHub, type Exec } from "../src/gh.js";

interface Call {
  args: string[];
  input?: unknown;
}

/** Scripted gh: each handler sees the call and returns a response or undefined to fall through. */
function scripted(handler: (c: Call) => { code?: number; stdout?: unknown; stderr?: string } | undefined) {
  const calls: Call[] = [];
  const exec: Exec = async (args, input) => {
    const call = { args, input: input === undefined ? undefined : JSON.parse(input) };
    calls.push(call);
    const r = handler(call);
    if (!r) throw new Error(`unexpected gh ${args.join(" ")}`);
    const stdout = typeof r.stdout === "string" ? r.stdout : JSON.stringify(r.stdout ?? "");
    return { code: r.code ?? 0, stdout, stderr: r.stderr ?? "" };
  };
  return { exec, calls };
}

const path = (c: Call) => c.args.find((a) => a.startsWith("repos/")) ?? c.args[1];
const method = (c: Call) => c.args[c.args.indexOf("-X") + 1];

describe("GhGitHub claims", () => {
  test("a claim is a commit recording holder, session and time, behind refs/psdd/claims/<issue>", async () => {
    const { exec, calls } = scripted((c) => {
      if (path(c).endsWith("/git/trees")) return { stdout: { sha: "tree1" } };
      if (path(c).endsWith("/git/commits")) return { stdout: { sha: "commit1" } };
      if (path(c).endsWith("/git/refs")) return { stdout: { ref: "refs/psdd/claims/131" } };
    });
    const gh = new GhGitHub(exec);

    const ok = await gh.createClaim(131, { holder: "alice", session: "s1", since: "2026-10-13T14:02:00.000Z" });

    expect(ok).toBe(true);
    const commit = calls.find((c) => path(c).endsWith("/git/commits"))!;
    expect(commit.input).toMatchObject({ tree: "tree1", parents: [] });
    expect(JSON.parse((commit.input as { message: string }).message)).toEqual({
      holder: "alice",
      session: "s1",
      since: "2026-10-13T14:02:00.000Z",
    });
    const ref = calls.find((c) => path(c).endsWith("/git/refs"))!;
    expect(method(ref)).toBe("POST");
    expect(path(ref)).toBe("repos/{owner}/{repo}/git/refs");
    expect(ref.input).toEqual({ ref: "refs/psdd/claims/131", sha: "commit1" });
  });

  test("a 422 on ref creation means someone else holds the claim", async () => {
    const { exec } = scripted((c) => {
      if (path(c).endsWith("/git/trees")) return { stdout: { sha: "t" } };
      if (path(c).endsWith("/git/commits")) return { stdout: { sha: "c" } };
      if (path(c).endsWith("/git/refs")) return { code: 1, stderr: "gh: Reference already exists (HTTP 422)" };
    });
    expect(await new GhGitHub(exec).createClaim(131, { holder: "a", session: "s", since: "x" })).toBe(false);
  });

  test("other failures are errors, not lost claims", async () => {
    const { exec } = scripted((c) => {
      if (path(c).endsWith("/git/trees")) return { stdout: { sha: "t" } };
      if (path(c).endsWith("/git/commits")) return { stdout: { sha: "c" } };
      if (path(c).endsWith("/git/refs")) return { code: 1, stderr: "gh: Bad credentials (HTTP 401)" };
    });
    await expect(new GhGitHub(exec).createClaim(131, { holder: "a", session: "s", since: "x" })).rejects.toThrow("HTTP 401");
  });

  test("replaceClaim loses when the ref is gone", async () => {
    const { exec } = scripted((c) => {
      if (path(c).endsWith("/git/trees")) return { stdout: { sha: "t" } };
      if (path(c).endsWith("/git/commits")) return { stdout: { sha: "c" } };
      if (path(c).endsWith("/git/refs/psdd/claims/131")) return { code: 1, stderr: "gh: Reference does not exist (HTTP 422)" };
    });
    expect(await new GhGitHub(exec).replaceClaim(131, "mine1", { holder: "a", session: "s", since: "x" })).toBe(false);
  });

  test("readClaim follows the ref to its commit; a missing ref is no claim", async () => {
    const { exec } = scripted((c) => {
      if (path(c) === "repos/{owner}/{repo}/git/ref/psdd/claims/131") return { stdout: { object: { sha: "c1" } } };
      if (path(c) === "repos/{owner}/{repo}/git/commits/c1")
        return { stdout: { message: JSON.stringify({ holder: "a", session: "s", since: "t" }) } };
      if (path(c) === "repos/{owner}/{repo}/git/ref/psdd/claims/132") return { code: 1, stderr: "Not Found (HTTP 404)" };
    });
    const gh = new GhGitHub(exec);
    expect(await gh.readClaim(131)).toEqual({ holder: "a", session: "s", since: "t", sha: "c1" });
    expect(await gh.readClaim(132)).toBeNull();
  });

  test("replaceClaim makes a child of the commit read and moves the ref without force", async () => {
    const { exec, calls } = scripted((c) => {
      if (path(c).endsWith("/git/trees")) return { stdout: { sha: "t3" } };
      if (path(c).endsWith("/git/commits")) return { stdout: { sha: "c3" } };
      if (path(c).endsWith("/git/refs/psdd/claims/131")) return { stdout: { ref: "refs/psdd/claims/131" } };
    });

    expect(await new GhGitHub(exec).replaceClaim(131, "stale1", { holder: "b", session: "s2", since: "x" })).toBe(true);

    expect(calls.find((c) => path(c).endsWith("/git/commits"))!.input).toMatchObject({ parents: ["stale1"] });
    const ref = calls.find((c) => path(c).endsWith("/git/refs/psdd/claims/131"))!;
    expect(method(ref)).toBe("PATCH");
    expect(ref.input).toEqual({ sha: "c3", force: false });
  });

  test("replaceClaim loses when the ref has moved since it was read", async () => {
    const { exec } = scripted((c) => {
      if (path(c).endsWith("/git/trees")) return { stdout: { sha: "t" } };
      if (path(c).endsWith("/git/commits")) return { stdout: { sha: "c" } };
      if (path(c).endsWith("/git/refs/psdd/claims/131")) return { code: 1, stderr: "gh: Update is not a fast forward (HTTP 422)" };
    });
    expect(await new GhGitHub(exec).replaceClaim(131, "stale1", { holder: "b", session: "s2", since: "x" })).toBe(false);
  });
});

describe("GhGitHub paged lists", () => {
  test("lists are read with --paginate --jq '.[]', one JSON value per line across pages, without --slurp", async () => {
    const { exec, calls } = scripted((c) => {
      if (path(c) === "repos/{owner}/{repo}/issues/131/comments") {
        return { stdout: [JSON.stringify({ body: "first\nline two" }), JSON.stringify({ body: "second" }), ""].join("\n") };
      }
    });

    expect(await new GhGitHub(exec).listComments(131)).toEqual(["first\nline two", "second"]);
    expect(calls[0].args).toEqual(["api", "--paginate", "--jq", ".[]", "repos/{owner}/{repo}/issues/131/comments"]);
    expect(calls[0].args).not.toContain("--slurp");
  });

  test("an empty list prints nothing and reads as no items", async () => {
    const { exec } = scripted(() => ({ stdout: "" }));
    expect(await new GhGitHub(exec).subIssues(123)).toEqual([]);
  });

  test("sub-issues from another repository are left out", async () => {
    const issue = (number: number, repo: string) => ({ id: number, number, title: "t", state: "open", labels: [], assignees: [], repository_url: `https://api.github.com/repos/${repo}` });
    const { exec } = scripted((c) => {
      if (c.args.includes("--paginate")) return { stdout: [issue(131, "acme/app"), issue(7, "acme/other")].map((i) => JSON.stringify(i)).join("\n") };
      if (path(c) === "repos/{owner}/{repo}") return { stdout: { url: "https://api.github.com/repos/acme/app" } };
    });
    expect((await new GhGitHub(exec).subIssues(123)).map((i) => i.number)).toEqual([131]);
  });
});

describe("GhGitHub issues", () => {
  test("getIssue maps the REST issue", async () => {
    const { exec } = scripted(() => ({
      stdout: {
        number: 131,
        title: "Per-key limits",
        state: "closed",
        state_reason: "completed",
        labels: [{ name: "type:slice" }, { name: "mode:afk" }],
        assignees: [{ login: "alice" }],
      },
    }));
    expect(await new GhGitHub(exec).getIssue(131)).toEqual({
      number: 131,
      title: "Per-key limits",
      state: "closed",
      stateReason: "completed",
      labels: ["type:slice", "mode:afk"],
      assignees: ["alice"],
    });
  });

  test("native blocked-by and sub-issue relations are made with the other issue's id, not its number", async () => {
    const { exec, calls } = scripted((c) => {
      if (method(c) === "POST") return { stdout: {} };
      if (path(c) === "repos/{owner}/{repo}/issues/127") return { stdout: { id: 9127, number: 127, title: "", state: "open", labels: [], assignees: [] } };
    });
    const gh = new GhGitHub(exec);

    await gh.addBlockedBy(131, 127);
    await gh.addSubIssue(123, 127);

    const posts = calls.filter((c) => method(c) === "POST");
    expect(posts.map((c) => [path(c), c.input])).toEqual([
      ["repos/{owner}/{repo}/issues/131/dependencies/blocked_by", { issue_id: 9127 }],
      ["repos/{owner}/{repo}/issues/123/sub_issues", { sub_issue_id: 9127 }],
    ]);
  });

  test("parentOf is null when the issue has no parent", async () => {
    const { exec } = scripted(() => ({ code: 1, stderr: "Not Found (HTTP 404)" }));
    expect(await new GhGitHub(exec).parentOf(5)).toBeNull();
  });

  test("removing a label the issue does not have is not an error", async () => {
    const { exec, calls } = scripted(() => ({ code: 1, stderr: "Label does not exist (HTTP 404)" }));
    await new GhGitHub(exec).removeLabels(5, ["in-progress"]);
    expect(path(calls[0])).toBe("repos/{owner}/{repo}/issues/5/labels/in-progress");
  });

  test("findPullRequest maps gh pr state", async () => {
    const { exec, calls } = scripted(() => ({
      stdout: [{ number: 50, headRefName: "123-rate-limiting-127", baseRefName: "123-rate-limiting", state: "MERGED", body: "b" }],
    }));
    expect(await new GhGitHub(exec).findPullRequest("123-rate-limiting-127")).toEqual({
      number: 50,
      head: "123-rate-limiting-127",
      base: "123-rate-limiting",
      state: "merged",
      body: "b",
    });
    expect(calls[0].args.slice(0, 2)).toEqual(["pr", "list"]);
  });
});
