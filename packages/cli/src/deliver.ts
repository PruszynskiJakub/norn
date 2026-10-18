import { type Ctx, type NextReport, next, type Refusal } from "@norn/core";
import { deadRuns, type DeliveryLock, liveRuns, lockDelivery, markGone, takeWakes, unlockDelivery, type Wake } from "./run-records.js";
import { type RunHost, type RunRefusal, startRun, stopOrphan } from "./supervise.js";

/**
 * norn deliver <story>: the delivery loop as code, not an agent. It asks
 * norn next, starts a run for each item an agent can do, up to the free
 * slots, waits for a run to finish, and asks again, until nothing runs here
 * and nothing can start: then only people can move the story on, or it is
 * closed. GitHub stays the record, so a deliver started again carries on.
 */

export interface Delivered {
  ok: true;
  kind: "delivered";
  story: number;
  report: NextReport;
}

export type DeliverRefusal = { kind: "delivery-running"; story: number; lock: DeliveryLock };

/** Something the loop did, printed as it happens. */
export type DeliverEvent =
  | { kind: "delivering"; story: number }
  | { kind: "run-started"; issue: number; step: string; agent: string; session: string }
  | { kind: "run-refused"; issue: number; step: string; refusal: RunRefusal | Refusal }
  | { kind: "woke"; wake: Wake }
  | { kind: "supervisor-gone"; issue: number; pid: number; pane: string | null }
  | { kind: "stopping" };

export interface DeliverOptions {
  /** How often to look at this machine's runs. */
  pollMs?: number;
  /** How often to ask GitHub even without a wake, e.g. for a person's step done elsewhere. */
  nextEveryMs?: number;
  /** The process that holds the delivery lock. */
  pid?: number;
  print: (event: DeliverEvent) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function deliver(
  ctx: Ctx & { runs: RunHost },
  story: number,
  opts: DeliverOptions,
): Promise<Delivered | { ok: false; refusal: DeliverRefusal | Refusal }> {
  const root = ctx.workspace.root;
  const pid = opts.pid ?? process.pid;
  const lock = lockDelivery(root, story, pid, ctx.now());
  if (!lock.ok) return { ok: false, refusal: { kind: "delivery-running", story, lock: lock.held } };
  try {
    return await loop(ctx, story, opts);
  } finally {
    unlockDelivery(root, story, pid);
  }
}

async function loop(ctx: Ctx & { runs: RunHost }, story: number, opts: DeliverOptions): Promise<Delivered | { ok: false; refusal: Refusal }> {
  const root = ctx.workspace.root;
  const pollMs = opts.pollMs ?? 3000;
  const nextEveryMs = opts.nextEveryMs ?? 120_000;
  const print = opts.print;
  let lastNext = 0;
  let ask = true;
  let lastLive = new Set<number>();
  print({ kind: "delivering", story });
  for (;;) {
    for (const wake of takeWakes(root, story)) {
      print({ kind: "woke", wake });
      ask = true;
    }
    for (const r of deadRuns(root, story)) {
      // Its agent may still work in its pane, and its claim runs out with its lease: then the item is offered again.
      await stopOrphan(ctx.runs.herdr, r);
      markGone(root, r);
      print({ kind: "supervisor-gone", issue: r.issue, pid: r.pid, pane: r.pane });
      ask = true;
    }
    // A run that ended, however it ended, may have freed a slot or moved its item on.
    const nowLive = new Set(liveRuns(root, story).map((r) => r.issue));
    if ([...lastLive].some((n) => !nowLive.has(n))) ask = true;
    lastLive = nowLive;
    if (ask || Date.now() - lastNext >= nextEveryMs) {
      ask = false;
      lastNext = Date.now();
      // Taken before asking: a run that ends while norn next reads GitHub leaves a report that still shows it at work.
      const liveBefore = nowLive;
      const answer = await next(ctx, story);
      if (!answer.ok) return answer;
      const { report } = answer;
      const live = new Set(liveRuns(root, story).map((r) => r.issue));
      if ([...liveBefore].some((n) => !live.has(n))) ask = true;
      lastLive = live;
      const running = new Set([...liveBefore, ...live]);
      // A run counts against the slots from its start, before its agent's take makes it a claim of yours.
      const busy = new Set([...running, ...report.waiting.flatMap((w) => (w.reason === "held" && w.holder.mine ? [w.issue] : []))]);
      let slots = Math.max(0, ctx.config.maxParallel - busy.size);
      let started = 0;
      for (const item of report.closed ? [] : report.start) {
        if (item.attended || running.has(item.issue) || slots === 0) continue;
        const r = await startRun(ctx, item.issue);
        if (r.ok) {
          started++;
          slots--;
          print({ kind: "run-started", issue: item.issue, step: item.step, agent: r.agent, session: r.session });
        } else print({ kind: "run-refused", issue: item.issue, step: item.step, refusal: r.refusal });
      }
      if (started === 0 && running.size === 0) {
        print({ kind: "stopping" });
        return { ok: true, kind: "delivered", story, report };
      }
    }
    await sleep(pollMs);
  }
}
