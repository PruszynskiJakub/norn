import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { type DashboardState, serveDashboard } from "@norn/web";
import { setup } from "@norn/testing";

/** The dashboard over the fakes, with polls run by hand: each scheduled poll waits in `due` until the test runs it. */
async function dashboard(opts: { port?: number; explicit?: boolean; root?: string; w?: ReturnType<typeof setup> } = {}) {
  const w = opts.w ?? setup({ now: "2026-10-13T12:00:00Z" });
  if (!opts.w) {
    w.github.seedIssue({ number: 10, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
    w.github.seedIssue({ number: 11, title: "Redis store", labels: ["type:slice", "mode:afk", "ready-for-agent"], assignees: ["alice"] });
    w.github.parents.set(11, 10);
  }
  const due: { fn: () => void; ms: number }[] = [];
  const started = await serveDashboard(
    {
      ctx: await w.ctx(),
      root: opts.root ?? "/repo",
      intervalMs: 120_000,
      assets: { js: "console.log('ui')", css: "body{}" },
      schedule: (fn, ms) => {
        const entry = { fn, ms };
        due.push(entry);
        return () => due.splice(due.indexOf(entry), 1);
      },
      failure: () => "rate-limit",
    },
    { port: opts.port ?? 0, explicit: opts.explicit ?? false },
  );
  if (started.kind === "started") open.push(started.dashboard);
  return { w, started, due };
}

const open: { close(): Promise<void> }[] = [];
const blockers: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.close()));
  await Promise.all(blockers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A free port with something else listening on it: not a dashboard, it hangs up on every connection. */
async function taken(): Promise<number> {
  const s = createServer((c) => c.destroy());
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  blockers.push(s);
  return (s.address() as { port: number }).port;
}

async function started(d: Awaited<ReturnType<typeof dashboard>>) {
  if (d.started.kind !== "started") throw new Error(`not started: ${d.started.kind}`);
  return d.started.dashboard;
}

const state = async (url: string) => (await (await fetch(`${url}/api/state`)).json()) as DashboardState;

describe("the dashboard server", () => {
  test("serves the page and its assets on 127.0.0.1", async () => {
    const d = await started(await dashboard());

    expect(d.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await fetch(d.url);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain('<script type="module" src="/assets/app.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/assets/app.css">');
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
    const icon = await fetch(`${d.url}/favicon.svg`);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(await icon.text()).toContain('aria-label="Norn"');
    const js = await fetch(`${d.url}/assets/app.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toBe("console.log('ui')");
    expect((await fetch(`${d.url}/assets/app.css`)).headers.get("content-type")).toContain("text/css");
    expect((await fetch(`${d.url}/assets/app.js`, { method: "HEAD" })).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${d.url}/nope`)).status).toBe(404);
  });

  test("answers the read model from one shared poll, loading until the first finishes", async () => {
    const d = await dashboard();
    const s = await started(d);
    const first = await state(s.url);
    if (first.status === "loading") await s.idle();

    const a = await state(s.url);
    const b = await state(s.url);

    expect(a).toMatchObject({ status: "ready", me: "alice", repoUrl: "https://github.com/acme/app", lastError: null, intervalMs: 120_000 });
    expect(a.board.map((x) => x.number)).toEqual([10]);
    expect(a.lastUpdated).toBe("2026-10-13T12:00:00.000Z");
    expect(a.nextPoll).toBe("2026-10-13T12:02:00.000Z");
    expect(b).toEqual(a);
    expect(d.w.github.observed).toBe(1);
    expect(d.due.map((x) => x.ms)).toEqual([120_000]);
  });

  test("answers the repository's flows, valid or with their errors, and each issue's flow", async () => {
    const w = setup({ now: "2026-10-13T12:00:00Z" });
    const bug = {
      description: "A defect.",
      start: "reproducing",
      workspace: "none",
      states: {
        reproducing: { skill: "bug-repro", attended: true, description: "Waiting for a repro", outcomes: { fixed: { to: "closed", means: "fixed" } } },
      },
    };
    w.github.seedFlow("bug", bug);
    w.github.seedFlow("chore", { description: "Broken.", start: "nowhere", workspace: "none", states: {} });
    w.github.seedIssue({ number: 10, title: "Rate limiting", labels: ["type:story", "implementation"], assignees: ["alice"] });
    w.github.seedIssue({ number: 11, title: "Redis store", labels: ["type:slice", "mode:afk", "ready-for-agent"], assignees: ["alice"] });
    w.github.parents.set(11, 10);
    w.github.seedIssue({ number: 40, title: "Crash", labels: ["type:bug", "reproducing"], assignees: ["alice"] });
    const s = await started(await dashboard({ w }));
    await s.idle();

    const now = await state(s.url);

    expect(now.flows.map((f) => [f.name, f.ok])).toEqual([
      ["story", true],
      ["slice", true],
      ["bug", true],
      ["chore", false],
    ]);
    expect(now.flows.find((f) => f.name === "bug")).toEqual({ ok: true, name: "bug", flow: bug, source: "repository" });
    expect(now.flows.find((f) => f.name === "chore")).toEqual({
      ok: false,
      name: "chore",
      errors: [{ kind: "start-unknown", start: "nowhere" }],
      source: "repository",
    });
    expect(now.board.map((x) => [x.number, x.flow, x.states, x.slices.map((i) => [i.number, i.flow])])).toEqual([
      [10, "story", ["implementation"], [[11, "slice"]]],
      [40, "bug", ["reproducing"], []],
    ]);
  });

  test("answers the label colour and description of each kind of state, as norn creates labels without a colour of their own", async () => {
    const s = await started(await dashboard());
    await s.idle();

    const now = await state(s.url);

    expect(now.stateLabelDefaults).toEqual({
      gate: { color: "e99695", description: "a person checks the work here" },
      attended: { color: "c5def5", description: "a person takes part in this step" },
      agent: { color: "bfd4f2", description: "an agent runs this step unattended" },
    });
  });

  test("says where each flow comes from: built into norn, a built-in one the repository overrides, or the repository's own", async () => {
    const w = setup({ now: "2026-10-13T12:00:00Z" });
    w.github.seedFlow("slice", { description: "Broken.", start: "nowhere", workspace: "none", states: {} });
    w.github.seedFlow("bug", {
      description: "A defect.",
      start: "reproducing",
      workspace: "none",
      states: { reproducing: { skill: "bug-repro", attended: true, outcomes: { fixed: { to: "closed", means: "fixed" } } } },
    });
    const s = await started(await dashboard({ w }));
    await s.idle();

    const now = await state(s.url);

    expect(now.flows.map((f) => [f.name, f.source, f.ok])).toEqual([
      ["story", "built-in", true],
      ["slice", "overridden", false],
      ["bug", "repository", true],
    ]);
  });

  test("polls on the interval, adding what happened since to the feed", async () => {
    const d = await dashboard();
    const s = await started(d);
    await s.idle();
    d.w.setNow("2026-10-13T12:02:00Z");
    d.w.github.prs.push({ number: 70, head: "10-rate-limiting-11", base: "10-rate-limiting", state: "open" });
    await d.w.norn("take", "11");
    await d.w.norn("done", "11");

    d.due.shift()!.fn();
    await s.idle();

    const now = await state(s.url);
    expect(d.w.github.observed).toBe(2);
    expect(now.lastUpdated).toBe("2026-10-13T12:02:00.000Z");
    expect(now.feed.map((e) => e.kind)).toEqual(["outcome", "step"]);
    expect(now.board[0].slices[0].states).toEqual(["needs-review"]);
    expect(d.due.map((x) => x.ms)).toEqual([120_000]);
  });

  test("refresh reads GitHub now and answers the new state", async () => {
    const d = await dashboard();
    const s = await started(d);
    await s.idle();
    d.w.setNow("2026-10-13T12:01:00Z");
    await d.w.norn("take", "11");

    const res = await fetch(`${s.url}/api/refresh`, { method: "POST" });

    expect(res.status).toBe(200);
    const after = (await res.json()) as DashboardState;
    expect(after.board[0].slices[0].holder).toMatchObject({ session: "session-1" });
    expect(d.w.github.observed).toBe(2);
    expect(d.due).toHaveLength(1);
  });

  test("a failed poll keeps the last good state and says why", async () => {
    const d = await dashboard();
    const s = await started(d);
    await s.idle();
    d.w.setNow("2026-10-13T12:02:00Z");
    d.w.github.observeWork = async () => {
      throw new Error("API rate limit exceeded");
    };

    const after = (await (await fetch(`${s.url}/api/refresh`, { method: "POST" })).json()) as DashboardState;

    expect(after.board.map((x) => x.number)).toEqual([10]);
    expect(after.lastUpdated).toBe("2026-10-13T12:00:00.000Z");
    expect(after.lastError).toEqual({ at: "2026-10-13T12:02:00.000Z", reason: "rate-limit", detail: "API rate limit exceeded" });
  });

  test("names norn and the checkout on the identity endpoint", async () => {
    const s = await started(await dashboard({ root: "/work/app" }));

    expect(await (await fetch(`${s.url}/api/identity`)).json()).toEqual({ app: "norn-dashboard", root: "/work/app" });
  });
});

describe("choosing the port", () => {
  test("a taken port moves to the next free one", async () => {
    const port = await taken();

    const s = await started(await dashboard({ port }));

    expect(s.port).toBeGreaterThan(port);
  });

  test("an explicit port that is taken fails", async () => {
    const port = await taken();

    const d = await dashboard({ port, explicit: true });

    expect(d.started).toEqual({ kind: "port-taken", port });
  });

  test("a dashboard of the same checkout already on the port is the answer, not a second one", async () => {
    const first = await started(await dashboard({ root: "/work/app" }));

    const second = await dashboard({ port: first.port, root: "/work/app" });
    const other = await dashboard({ port: first.port, root: "/work/other" });

    expect(second.started).toEqual({ kind: "already-running", url: first.url });
    expect(other.started.kind).toBe("started");
  });
});
