/** Identifies the session holding claims. psdd keeps no state, so it comes from the environment. */
export function sessionId(env: Record<string, string | undefined>, hostname: string, cwd: string): string {
  return env.PSDD_SESSION || env.CLAUDE_CODE_SESSION_ID || `${hostname}:${cwd}`;
}
