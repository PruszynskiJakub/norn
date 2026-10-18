import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { AttemptEnd, Settlement } from "@norn/core";

/**
 * What this machine knows of its runs, in .agents/runs/: a record per run,
 * the wakes finished runs leave for norn deliver, and the delivery lock.
 * Whether a step is done lives on GitHub; these only say which supervisor
 * processes run here, and where their agents are.
 */

export const RUNS_DIR = ".agents/runs";

export interface RunRecord {
  issue: number;
  story: number;
  /** The run's own norn session, which its agents work as. */
  session: string;
  agent: string;
  worktree: string;
  /** The supervisor's process. */
  pid: number;
  /** The herdr pane of the current attempt's agent; null before it has one. */
  pane: string | null;
  startedAt: string;
  state: "running" | Exclude<Settlement["kind"], "retry">;
  attempts: { startedAt: string; end: AttemptEnd; minutes: number; settled: Settlement["kind"] }[];
  finishedAt?: string;
}

/** What a finished run tells the norn deliver waiting on its story. */
export interface Wake {
  issue: number;
  story: number;
  session: string;
  settled: Exclude<Settlement, { kind: "retry" }>;
  attempts: number;
  minutes: number;
  at: string;
}

/** Who delivers a story on this machine. */
export interface DeliveryLock {
  story: number;
  pid: number;
  since: string;
}

const runDir = (root: string, n: number) => join(root, RUNS_DIR, String(n));
const wakeDir = (root: string) => join(root, RUNS_DIR, "wakes");
const lockFile = (root: string, story: number) => join(root, RUNS_DIR, `deliver-${story}.json`);

/** The run's own directory, for its record and its logs. */
export function runDirFor(root: string, n: number) {
  ensureRunsDir(root);
  mkdirSync(runDir(root, n), { recursive: true });
  return runDir(root, n);
}

function ensureRunsDir(root: string) {
  mkdirSync(wakeDir(root), { recursive: true });
  // Run state is this machine's own; it is never committed.
  const ignore = join(root, RUNS_DIR, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
}

export function readRecord(root: string, n: number): RunRecord | null {
  return readJson<RunRecord>(join(runDir(root, n), "run.json"));
}

export function writeRecord(root: string, r: RunRecord) {
  writeFileSync(join(runDirFor(root, r.issue), "run.json"), `${JSON.stringify(r, null, 2)}\n`);
}

/** Whether a process lives on this machine. */
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it lives, under another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function records(root: string, story: number): RunRecord[] {
  const dir = join(root, RUNS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => /^\d+$/.test(d))
    .map((d) => readRecord(root, Number(d)))
    .filter((r): r is RunRecord => r !== null && r.story === story && r.state === "running");
}

/** Runs of the story whose supervisor still lives on this machine. */
export function liveRuns(root: string, story: number): RunRecord[] {
  return records(root, story).filter((r) => alive(r.pid));
}

/** Runs of the story recorded as running whose supervisor is gone: it crashed, was killed, or the machine restarted. */
export function deadRuns(root: string, story: number): RunRecord[] {
  return records(root, story).filter((r) => !alive(r.pid));
}

/** Marks a dead run as over, so it is reported once. */
export function markGone(root: string, r: RunRecord) {
  writeRecord(root, { ...r, state: "lost", finishedAt: new Date().toISOString() });
}

export function writeWake(root: string, wake: Wake) {
  ensureRunsDir(root);
  writeFileSync(join(wakeDir(root), `${Date.now()}-${wake.issue}.json`), `${JSON.stringify(wake, null, 2)}\n`);
}

/** The story's wakes not yet read, oldest first. Reading one renames it, so it stays for a person to look at. */
export function takeWakes(root: string, story: number): Wake[] {
  const dir = wakeDir(root);
  if (!existsSync(dir)) return [];
  const out: Wake[] = [];
  for (const f of readdirSync(dir)
    .filter((f) => /^\d+-\d+\.json$/.test(f))
    .sort()) {
    const path = join(dir, f);
    const wake = readJson<Wake>(path);
    if (wake?.story !== story) continue;
    out.push(wake);
    renameSync(path, path.replace(/\.json$/, ".read.json"));
  }
  return out;
}

/**
 * Takes the story's delivery lock for `pid`, so only one norn deliver runs
 * on it on this machine. A lock whose process is gone is taken over. The
 * file is created exclusively, so of two starting at once only one wins.
 */
export function lockDelivery(root: string, story: number, pid: number, now: Date): { ok: true } | { ok: false; held: DeliveryLock } {
  ensureRunsDir(root);
  const path = lockFile(root, story);
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify({ story, pid, since: now.toISOString() } satisfies DeliveryLock));
      closeSync(fd);
      return { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = readJson<DeliveryLock>(path);
      if (held && held.pid !== pid && alive(held.pid)) return { ok: false, held };
      rmSync(path, { force: true });
    }
  }
  return { ok: false, held: readJson<DeliveryLock>(path) ?? { story, pid: 0, since: now.toISOString() } };
}

export function unlockDelivery(root: string, story: number, pid: number) {
  const path = lockFile(root, story);
  if (readJson<DeliveryLock>(path)?.pid === pid) rmSync(path, { force: true });
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
