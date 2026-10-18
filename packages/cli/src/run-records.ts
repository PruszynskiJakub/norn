import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
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
  /** When the supervisor last showed it lives; a record of a pid that lives but has not beaten for long is of another process that reused the pid. */
  beatAt?: string;
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

/** A supervisor beats on every tick; this long without a beat, a live pid is another process's after a restart. */
export const BEAT_LOST_MS = 30 * 60_000;

/** Whether a run's supervisor still lives on this machine: its process is there, and it is the supervisor's. */
export function supervisorLives(r: RunRecord, now = Date.now()) {
  return alive(r.pid) && (!r.beatAt || now - new Date(r.beatAt).getTime() < BEAT_LOST_MS);
}

/** Runs of the story whose supervisor still lives on this machine. */
export function liveRuns(root: string, story: number): RunRecord[] {
  return records(root, story).filter((r) => supervisorLives(r));
}

/** Runs of the story recorded as running whose supervisor is gone: it crashed, was killed, or the machine restarted. */
export function deadRuns(root: string, story: number): RunRecord[] {
  return records(root, story).filter((r) => !supervisorLives(r));
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
      const text = readText(path);
      const held = text === null ? null : parse<DeliveryLock>(text);
      if (held && held.pid !== pid && alive(held.pid)) return { ok: false, held };
      // Unreadable: another deliver may be writing it this instant, unless it is old.
      if (!held && text !== null && Date.now() - mtime(path) < 10_000) return { ok: false, held: { story, pid: 0, since: now.toISOString() } };
      // Taken over only if it is still the stale lock read, so of two taking it over, the second leaves the first's lock alone.
      if (readText(path) === text) rmSync(path, { force: true });
    }
  }
  return { ok: false, held: readJson<DeliveryLock>(path) ?? { story, pid: 0, since: now.toISOString() } };
}

export function unlockDelivery(root: string, story: number, pid: number) {
  const path = lockFile(root, story);
  if (readJson<DeliveryLock>(path)?.pid === pid) rmSync(path, { force: true });
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function mtime(path: string) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
