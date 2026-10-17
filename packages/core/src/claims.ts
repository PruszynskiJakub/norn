import type { ClaimRecord, ClaimSpace, GitHub, Pane } from "./github.js";
import type { Workspace } from "./workspace.js";

/** The herdr pane this session runs in, on this machine; null outside herdr. */
export function paneOf(ctx: { workspace: Pick<Workspace, "env">; machine: string }): Pane | null {
  const id = ctx.workspace.env.HERDR_PANE_ID;
  return ctx.workspace.env.HERDR_ENV === "1" && id ? { id, machine: ctx.machine } : null;
}

/** A claim of this session's, taken now by `holder`, naming its herdr pane when it runs in one. */
export function claimRecord(ctx: { session: string; now: () => Date; workspace: Pick<Workspace, "env">; machine: string }, holder: string): ClaimRecord {
  const pane = paneOf(ctx);
  return { holder, session: ctx.session, since: ctx.now().toISOString(), ...(pane ? { pane } : {}) };
}

export type Acquire = { ok: true; tookOver?: ClaimRecord; ownTakeover?: boolean; reacquired?: boolean } | { ok: false; held: ClaimRecord | null };

/**
 * Claim an issue via its git ref. Ref creation is the atomic step: whoever
 * creates it wins. A claim this session already holds is refreshed to a new
 * `since`, and a claim older than staleAfterMs is taken over; both only
 * while the ref still points at the commit read, so neither can overwrite a
 * claim another session took in between. With `takeover`, a fresh claim of
 * another session of the same holder is taken over too: the person says that
 * session has stopped. `space` is the ref namespace, claims by default; a
 * delivery lock is taken by the same rules.
 */
export async function acquire(
  github: GitHub,
  n: number,
  record: ClaimRecord,
  now: Date,
  staleAfterMs: number,
  opts: { takeover?: boolean; space?: ClaimSpace } = {},
): Promise<Acquire> {
  const space = opts.space ?? "claims";
  if (await github.createClaim(n, record, space)) return { ok: true };
  const held = await github.readClaim(n, space);
  if (!held) return lost(github, n, record, space);
  if (held.session === record.session) {
    if (await github.replaceClaim(n, held.sha, record, space)) return { ok: true, reacquired: true };
    return lost(github, n, record, space);
  }
  const stale = isStale(held, now, staleAfterMs);
  if (stale || (opts.takeover && held.holder === record.holder)) {
    const { sha: _sha, ...was } = held;
    if (await github.replaceClaim(n, held.sha, record, space)) return stale ? { ok: true, tookOver: was } : { ok: true, tookOver: was, ownTakeover: true };
    return lost(github, n, record, space);
  }
  return { ok: false, held: strip(held) };
}

/**
 * The ref changed under us. If someone holds it now, that is the answer;
 * if it is gone (released in between), try once more to create it.
 */
async function lost(github: GitHub, n: number, record: ClaimRecord, space: ClaimSpace): Promise<Acquire> {
  const now = await github.readClaim(n, space);
  if (now) return { ok: false, held: strip(now) };
  return (await github.createClaim(n, record, space)) ? { ok: true } : { ok: false, held: strip(await github.readClaim(n, space)) };
}

function strip(claim: (ClaimRecord & { sha?: string }) | null): ClaimRecord | null {
  if (!claim) return null;
  const { sha: _sha, ...record } = claim;
  return record;
}

export function isStale(claim: ClaimRecord, now: Date, staleAfterMs: number) {
  return now.getTime() - new Date(claim.since).getTime() > staleAfterMs;
}
