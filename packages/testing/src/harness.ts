import { type Deps, renderNotification, run, type SupervisorStart } from "@norn/cli";
import type { DashboardLaunch, DashboardOptions } from "@norn/web";
import { type Ctx, loadConfig } from "@norn/core";
import { FakeGitHub } from "./fake-github.js";
import { FakeHerdr } from "./fake-herdr.js";
import { FakeWorkspace } from "./fake-workspace.js";

export function setup(opts: { now?: string; session?: string; user?: string; version?: string } = {}) {
  const github = new FakeGitHub(opts.user ?? "alice");
  github.clock = () => now;
  const workspace = new FakeWorkspace();
  const notifications: { channel: string; title: string; body: string }[] = [];
  let now = new Date(opts.now ?? "2026-10-13T12:00:00Z");
  /** Nonces handed out in turn; tests push the ones they expect. */
  const nonces: string[] = [];
  let made = 0;
  /** What norn dashboard asked to start, and what the start answers. */
  const launches: DashboardOptions[] = [];
  const dashboard = { answer: null as DashboardLaunch | null };
  const herdr = new FakeHerdr();
  /** What norn run and norn deliver did on the machine; tests set what a supervisor start does and what a shell command exits with. */
  const runs = {
    supervisors: [] as SupervisorStart[],
    shell: [] as string[],
    shellExit: 0,
    printed: [] as string[],
    /** Starting a supervisor; by default it is recorded and given this process's pid, so its run counts as live. */
    onSupervisor: (_s: SupervisorStart): number => process.pid,
  };
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
    dashboard: async (opts) => {
      launches.push(opts);
      return dashboard.answer ?? { kind: "started", url: `http://127.0.0.1:${opts.port}`, port: opts.port, opened: opts.open };
    },
    version: opts.version ?? "1.4.2",
    bundledSkills: "/nonexistent",
    checkoutProblem: null,
    runs: {
      herdr: herdr.run,
      shell: async (command) => {
        runs.shell.push(command);
        return runs.shellExit;
      },
      startSupervisor: async (s) => {
        runs.supervisors.push(s);
        return runs.onSupervisor(s);
      },
      print: (line) => runs.printed.push(line),
      norn: "/opt/norn/dist/bin.js",
    },
  };
  return {
    github,
    workspace,
    notifications,
    nonces,
    herdr,
    runs,
    deps,
    launches,
    set launchAnswer(a: DashboardLaunch) {
      dashboard.answer = a;
    },
    setNow(iso: string) {
      now = new Date(iso);
    },
    /** What core operations are called with: the deps plus the configuration norn would load. */
    async ctx(): Promise<Ctx> {
      const loaded = await loadConfig(workspace);
      if (!loaded.ok) throw new Error("the test's configuration does not load");
      return { ...deps, config: loaded.config, slugs: new Map() };
    },
    async norn(...argv: string[]) {
      return run(argv, deps);
    },
    withProject(cwd: string, installSkills: (cwd: string) => Promise<string[]>) {
      return (...argv: string[]) => run(argv, { ...deps, cwd, installSkills });
    },
    /** norn with some of its dependencies replaced, e.g. a project directory and the bundled skills. */
    withDeps(overrides: Partial<Deps>) {
      return (...argv: string[]) => run(argv, { ...deps, ...overrides });
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
