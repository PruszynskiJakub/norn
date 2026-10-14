import type { ClaimRecord, GitHub } from "./github.js";

export type Acquire =
  | { ok: true; tookOver?: ClaimRecord; reacquired?: boolean }
  | { ok: false; held: ClaimRecord | null };

/**
 * Claim an issue via its git ref. Ref creation is the atomic step: whoever
 * creates it wins. A claim this session already holds is refreshed to a new
 * `since`. A claim older than STALE_AFTER_MS is deleted and retried once.
 */
export async function acquire(github: GitHub, n: number, record: ClaimRecord, now: Date, staleAfterMs: number): Promise<Acquire> {
  if (await github.createClaim(n, record)) return { ok: true };
  const held = await github.readClaim(n);
  if (held && held.session === record.session) {
    await github.refreshClaim(n, record);
    return { ok: true, reacquired: true };
  }
  if (held && isStale(held, now, staleAfterMs)) {
    await github.deleteClaim(n);
    if (await github.createClaim(n, record)) return { ok: true, tookOver: held };
    return { ok: false, held: await github.readClaim(n) };
  }
  return { ok: false, held };
}

export function isStale(claim: ClaimRecord, now: Date, staleAfterMs: number) {
  return now.getTime() - new Date(claim.since).getTime() > staleAfterMs;
}
