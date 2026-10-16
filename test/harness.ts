import { run, type Deps } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { renderNotification } from "../src/render-text.js";
import type { Ctx } from "../src/transitions.js";
import { FakeGitHub } from "./fake-github.js";
import { FakeWorkspace } from "./fake-workspace.js";

export function setup(opts: { now?: string; session?: string; user?: string } = {}) {
  const github = new FakeGitHub(opts.user ?? "alice");
  const workspace = new FakeWorkspace();
  const notifications: { channel: string; title: string; body: string }[] = [];
  let now = new Date(opts.now ?? "2026-10-13T12:00:00Z");
  /** Nonces handed out in turn; tests push the ones they expect. */
  const nonces: string[] = [];
  let made = 0;
  const deps: Deps = {
    github,
    workspace,
    now: () => now,
    session: opts.session ?? "session-1",
    nonce: () => nonces.shift() ?? `n${++made}`,
    // Recorded as the CLI words them, as the user would see them.
    notify: async (channel, notification) => {
      notifications.push({ channel, ...renderNotification(notification) });
    },
    cwd: "/nonexistent",
    installSkills: async () => {
      throw new Error("not in this test");
    },
  };
  return {
    github,
    workspace,
    notifications,
    nonces,
    setNow(iso: string) {
      now = new Date(iso);
    },
    /** What core operations are called with: the deps plus the configuration psdd would load. */
    async ctx(): Promise<Ctx> {
      const loaded = await loadConfig(workspace);
      if (!loaded.ok) throw new Error("the test's configuration does not load");
      return { ...deps, config: loaded.config, slugs: new Map() };
    },
    async psdd(...argv: string[]) {
      return run(argv, deps);
    },
    withProject(cwd: string, installSkills: (cwd: string) => Promise<string[]>) {
      return (...argv: string[]) => run(argv, { ...deps, cwd, installSkills });
    },
    withNotify(notify: Deps["notify"]) {
      return (...argv: string[]) => run(argv, { ...deps, notify });
    },
    as(session: string) {
      return (...argv: string[]) => run(argv, { ...deps, session });
    },
    /** A teammate: another GitHub user, in a session of their own. */
    asTeammate(user: string, session: string) {
      return async (...argv: string[]) => {
        const me = github.user;
        github.user = user;
        try {
          return await run(argv, { ...deps, session });
        } finally {
          github.user = me;
        }
      };
    },
  };
}
