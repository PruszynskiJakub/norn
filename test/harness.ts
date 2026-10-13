import { run, type Deps } from "../src/cli.js";
import { FakeGitHub } from "./fake-github.js";

export function setup(opts: { now?: string; session?: string; user?: string } = {}) {
  const github = new FakeGitHub(opts.user ?? "alice");
  let now = new Date(opts.now ?? "2026-10-13T12:00:00Z");
  const deps: Deps = {
    github,
    now: () => now,
    session: opts.session ?? "session-1",
    headSha: async () => "abc123",
    cwd: "/nonexistent",
    installSkills: async () => {
      throw new Error("not in this test");
    },
  };
  return {
    github,
    setNow(iso: string) {
      now = new Date(iso);
    },
    async psdd(...argv: string[]) {
      return run(argv, deps);
    },
    withProject(cwd: string, installSkills: (cwd: string) => Promise<void>) {
      return (...argv: string[]) => run(argv, { ...deps, cwd, installSkills });
    },
    as(session: string) {
      return (...argv: string[]) => run(argv, { ...deps, session });
    },
  };
}
