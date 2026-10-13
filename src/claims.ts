import type { ClaimRecord, GitHub } from "./github.js";

export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export type Acquire = { ok: true } | { ok: false; held: ClaimRecord | null };

/**
 * Claim an issue via its git ref. Ref creation is the atomic step: whoever
 * creates it wins. A claim older than STALE_AFTER_MS is deleted and retried once.
 */
export async function acquire(github: GitHub, n: number, record: ClaimRecord, now: Date): Promise<Acquire> {
  if (await github.createClaim(n, record)) return { ok: true };
  const held = await github.readClaim(n);
  if (held && isStale(held, now)) {
    await github.deleteClaim(n);
    if (await github.createClaim(n, record)) return { ok: true };
    return { ok: false, held: await github.readClaim(n) };
  }
  return { ok: false, held };
}

export function isStale(claim: ClaimRecord, now: Date) {
  return now.getTime() - new Date(claim.since).getTime() > STALE_AFTER_MS;
}
