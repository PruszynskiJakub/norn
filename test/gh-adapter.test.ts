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

  test("readClaim follows the ref to its commit; a missing ref is no claim", async () => {
    const { exec } = scripted((c) => {
      if (path(c) === "repos/{owner}/{repo}/git/ref/psdd/claims/131") return { stdout: { object: { sha: "c1" } } };
      if (path(c) === "repos/{owner}/{repo}/git/commits/c1")
        return { stdout: { message: JSON.stringify({ holder: "a", session: "s", since: "t" }) } };
      if (path(c) === "repos/{owner}/{repo}/git/ref/psdd/claims/132") return { code: 1, stderr: "Not Found (HTTP 404)" };
    });
    const gh = new GhGitHub(exec);
    expect(await gh.readClaim(131)).toEqual({ holder: "a", session: "s", since: "t" });
    expect(await gh.readClaim(132)).toBeNull();
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
      stdout: [{ number: 50, headRefName: "slice/127-x", baseRefName: "story/123-y", state: "MERGED", body: "b" }],
    }));
    expect(await new GhGitHub(exec).findPullRequest("slice/127-x")).toEqual({
      number: 50,
      head: "slice/127-x",
      base: "story/123-y",
      state: "merged",
      body: "b",
    });
    expect(calls[0].args.slice(0, 2)).toEqual(["pr", "list"]);
  });
});
