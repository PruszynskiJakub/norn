import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { byTime, type Ctx, type Observation, observe } from "@norn/core";
import type { DashboardIdentity, DashboardState, PollFailure } from "./contract.js";
import { ICON_SVG } from "./icon.js";
import type { UiAssets } from "./ui-assets.js";

export interface DashboardDeps {
  ctx: Ctx;
  /** The main checkout's root, so a second launch for it finds this one. */
  root: string;
  intervalMs: number;
  /** The built UI; null serves a page saying it is missing. */
  assets: UiAssets | null;
  /** Runs fn after ms; returns a cancel. Tests run polls by hand. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Sorts a failed read for what the user can do. */
  failure: (e: unknown) => PollFailure;
}

export interface Dashboard {
  url: string;
  port: number;
  /** Resolves when no read of GitHub is running. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export type Served =
  | { kind: "started"; dashboard: Dashboard }
  /** A dashboard of the same checkout answers on the port. */
  | { kind: "already-running"; url: string }
  /** The port asked for outright is taken. */
  | { kind: "port-taken"; port: number };

/** How many ports past the default a dashboard tries before giving up. */
const PORTS_TRIED = 20;
/**
 * Each poll reads from a little before the last one: an item GitHub stamps
 * just before a read can show up only after it. Events read twice are one.
 */
const OVERLAP_MS = 60_000;

/**
 * Starts the dashboard on 127.0.0.1: the page, GET /api/state, POST
 * /api/refresh and GET /api/identity, with one poller whose cache every tab
 * shares. A taken port moves to the next one unless it was asked for
 * outright; a dashboard of the same checkout on it is answered instead.
 */
export async function serveDashboard(deps: DashboardDeps, at: { port: number; explicit: boolean }): Promise<Served> {
  const poller = new Poller(deps);
  const server = createServer((req, res) => {
    handle(req, res, deps, poller).catch((e) => {
      res.writeHead(500, { "content-type": "text/plain" }).end(String(e));
    });
  });
  const tries = at.explicit || at.port === 0 ? 1 : PORTS_TRIED;
  for (let port = at.port; port < at.port + tries; port++) {
    const bound = await listen(server, port);
    if (bound !== null) {
      const url = `http://127.0.0.1:${bound}`;
      poller.start();
      return {
        kind: "started",
        dashboard: {
          url,
          port: bound,
          idle: () => poller.idle(),
          close: async () => {
            poller.stop();
            await poller.idle();
            await new Promise<void>((r) => server.close(() => r()));
          },
        },
      };
    }
    const running = `http://127.0.0.1:${port}`;
    if (await sameCheckout(running, deps.root)) return { kind: "already-running", url: running };
    if (at.explicit) return { kind: "port-taken", port };
  }
  return { kind: "port-taken", port: at.port };
}

/** The port bound, or null when it is in use. */
function listen(server: Server, port: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const failed = (e: NodeJS.ErrnoException) => {
      server.off("listening", bound);
      if (e.code === "EADDRINUSE" || e.code === "EACCES") resolve(null);
      else reject(e);
    };
    const bound = () => {
      server.off("error", failed);
      resolve((server.address() as { port: number }).port);
    };
    server.once("error", failed);
    server.once("listening", bound);
    // Localhost only: the dashboard shows the developer's work as their own gh sees it.
    server.listen(port, "127.0.0.1");
  });
}

async function sameCheckout(url: string, root: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/identity`, { signal: AbortSignal.timeout(1500) });
    const id = (await res.json()) as Partial<DashboardIdentity>;
    return id.app === "norn-dashboard" && id.root === root;
  } catch {
    return false;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: DashboardDeps, poller: Poller) {
  const path = (req.url ?? "/").split("?")[0];
  // HEAD gets GET's headers; node leaves out the body itself.
  const get = req.method === "GET" || req.method === "HEAD";
  const json = (body: unknown) =>
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
  if (get && path === "/api/state") return json(poller.state());
  if (req.method === "POST" && path === "/api/refresh") {
    await poller.refresh();
    return json(poller.state());
  }
  if (get && path === "/api/identity") return json({ app: "norn-dashboard", root: deps.root } satisfies DashboardIdentity);
  if (get && path === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(deps.assets));
  if (get && path === "/favicon.svg") return res.writeHead(200, { "content-type": "image/svg+xml" }).end(ICON_SVG);
  if (get && deps.assets && path === "/assets/app.js") {
    return res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(deps.assets.js);
  }
  if (get && deps.assets && path === "/assets/app.css") {
    return res.writeHead(200, { "content-type": "text/css; charset=utf-8" }).end(deps.assets.css);
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
}

function page(assets: UiAssets | null) {
  const body = assets
    ? '<div id="root"></div>\n<script type="module" src="/assets/app.js"></script>'
    : "<p>The dashboard UI is not built. Run <code>npm run build</code> and start it again.</p>";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>norn dashboard</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${assets ? '<link rel="stylesheet" href="/assets/app.css">' : ""}
</head>
<body>
${body}
</body>
</html>
`;
}

/** Reads GitHub on the interval and keeps the last good read; a read asked for while one runs joins it. */
class Poller {
  private last: Observation | null = null;
  private feed: Observation["feed"] = [];
  private lastError: DashboardState["lastError"] = null;
  private loading = true;
  private running: Promise<void> | null = null;
  private cancel: (() => void) | null = null;
  private nextAt: string | null = null;
  private stopped = false;

  constructor(private deps: DashboardDeps) {}

  start() {
    void this.refresh();
  }

  stop() {
    this.stopped = true;
    this.cancel?.();
  }

  idle() {
    return this.running ?? Promise.resolve();
  }

  refresh(): Promise<void> {
    this.running ??= this.poll().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async poll() {
    this.cancel?.();
    this.cancel = null;
    this.nextAt = null;
    const { ctx } = this.deps;
    try {
      const prev = this.last;
      const since = prev ? new Date(Date.parse(prev.at) - OVERLAP_MS).toISOString() : null;
      const now = await observe(ctx, { since, previous: prev });
      const items = new Set(now.board.flatMap((s) => [s.number, ...s.slices.map((i) => i.number)]));
      const seen = new Set(now.feed.map((e) => e.id));
      // Events of items that left the board go with them.
      this.feed = byTime([...now.feed, ...this.feed.filter((e) => !seen.has(e.id))]).filter((e) => items.has(e.issue));
      this.last = now;
      this.lastError = null;
    } catch (e) {
      this.lastError = { at: ctx.now().toISOString(), reason: this.deps.failure(e), detail: e instanceof Error ? e.message : String(e) };
    }
    this.loading = false;
    if (this.stopped) return;
    const schedule = this.deps.schedule ?? ((fn, ms) => clearer(setTimeout(fn, ms)));
    this.cancel = schedule(() => void this.refresh(), this.deps.intervalMs);
    this.nextAt = new Date(ctx.now().getTime() + this.deps.intervalMs).toISOString();
  }

  state(): DashboardState {
    const { last } = this;
    return {
      status: this.loading ? "loading" : "ready",
      me: last?.me ?? null,
      repoUrl: last?.repoUrl ?? null,
      board: last?.board ?? [],
      waiting: last?.waiting ?? [],
      feed: this.feed,
      lastUpdated: last?.at ?? null,
      lastError: this.lastError,
      intervalMs: this.deps.intervalMs,
      nextPoll: this.nextAt,
      now: this.deps.ctx.now().toISOString(),
    };
  }
}

function clearer(timer: NodeJS.Timeout) {
  // An idle dashboard waiting for its next poll should not be what keeps the process alive; the server is.
  timer.unref();
  return () => clearTimeout(timer);
}
