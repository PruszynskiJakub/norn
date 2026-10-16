import type { BoardStory, FeedEvent, WaitingItem } from "@psdd/core";

/** Why the last read of GitHub failed, as far as psdd can tell. */
export type PollFailure = "auth" | "rate-limit" | "network" | "other";

/**
 * What GET /api/state answers: the core read model as it is, plus the
 * server's own facts. The UI renders it and words everything itself.
 */
export interface DashboardState {
  /** loading until the first read of the history finishes, whether it worked or not. */
  status: "loading" | "ready";
  /** The developer's login; null before the first good read. */
  me: string | null;
  repoUrl: string | null;
  board: BoardStory[];
  waiting: WaitingItem[];
  /** Newest first. */
  feed: FeedEvent[];
  /** When the last good read finished, ISO; null before one. */
  lastUpdated: string | null;
  /** The last read failed; the data above is from the last good one. `detail` is the error as GitHub or gh gave it. */
  lastError: { at: string; reason: PollFailure; detail: string } | null;
  /** How often the server reads GitHub. */
  intervalMs: number;
  /** When the server reads GitHub next, ISO; null while a read runs. */
  nextPoll: string | null;
  /** The local time the state was served at, ISO, so the UI words "N ago" against the server's clock. */
  now: string;
}

/** What GET /api/identity answers, so a second launch can find a running dashboard of the same repository. */
export interface DashboardIdentity {
  app: "psdd-dashboard";
  /** The main checkout's root on this machine. */
  root: string;
}
