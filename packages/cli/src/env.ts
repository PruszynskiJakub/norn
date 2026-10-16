/**
 * Identifies the session holding claims. norn keeps no state, so it comes from the environment.
 * The last fallback is the host and the main checkout's root, never the current directory:
 * an agent moves between checkouts and worktrees within one session.
 */
export function sessionId(env: Record<string, string | undefined>, hostname: string, repoRoot: string): string {
  if (env.NORN_SESSION) return env.NORN_SESSION;
  if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID;
  if (env.HERDR_PANE_ID) return `herdr:${env.HERDR_PANE_ID}`;
  return `${hostname}:${repoRoot}`;
}
