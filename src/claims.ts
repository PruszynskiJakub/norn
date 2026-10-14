import type { ClaimRecord, GitHub } from "./github.js";

export type Acquire =
  | { ok: true; tookOver?: ClaimRecord; reacquired?: boolean }
  | { ok: false; held: ClaimRecord | null };

/**
 * Claim an issue via its git ref. Ref creation is the atomic step: whoever
 * creates it wins. A claim this session already holds is refreshed to a new
 * `since`. A claim older than staleAfterMs is taken over, but only while its
 * ref still points at the stale commit, so two sessions taking over at once
 * cannot both win.
 */
export async function acquire(github: GitHub, n: number, record: ClaimRecord, now: Date, staleAfterMs: number): Promise<Acquire> {
  if (await github.createClaim(n, record)) return { ok: true };
  const held = await github.readClaim(n);
  // Released between the two calls: try once more to create it.
  if (!held) return (await github.createClaim(n, record)) ? { ok: true } : { ok: false, held: await github.readClaim(n) };
  if (held.session === record.session) {
    await github.refreshClaim(n, record);
    return { ok: true, reacquired: true };
  }
  if (isStale(held, now, staleAfterMs)) {
    const { sha: _sha, ...was } = held;
    if (await github.takeOverClaim(n, held.sha, record)) return { ok: true, tookOver: was };
    return { ok: false, held: await github.readClaim(n) };
  }
  return { ok: false, held };
}

export function isStale(claim: ClaimRecord, now: Date, staleAfterMs: number) {
  return now.getTime() - new Date(claim.since).getTime() > staleAfterMs;
}
