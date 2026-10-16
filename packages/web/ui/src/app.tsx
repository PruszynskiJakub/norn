import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardState } from "../../src/contract.ts";
import { Detail, Progress } from "./components/detail.tsx";
import { Feed } from "./components/feed.tsx";
import { Hero } from "./components/overview.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import { Button } from "./components/ui/button.tsx";
import { Skeleton, Skeletons } from "./components/ui/skeleton.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { fetchState, refreshState } from "./lib/api.ts";
import { type Theme, applyTheme, initialTheme, saveTheme } from "./lib/theme.ts";
import { cn } from "./lib/utils.ts";
import { allItems } from "./model.ts";
import { type View, ViewContext } from "./view.ts";
import { FEED, SERVER_GONE, failureNotice, pollHint, stateSentence, updatedLabel } from "./wording.ts";

/** The server's cache is cheap to read, so the page asks often and shows a poll as soon as it lands. */
const POLL_MS = 10_000;
/** How often "updated N ago" and the holders' durations are reworded. */
const TICK_MS = 15_000;

const EMPTY: DashboardState = {
  status: "loading",
  me: null,
  repoUrl: null,
  board: [],
  waiting: [],
  feed: [],
  lastUpdated: null,
  lastError: null,
  intervalMs: 120_000,
  nextPoll: null,
  now: new Date().toISOString(),
};

function useDashboardState() {
  const [state, setState] = useState<DashboardState>(EMPTY);
  // The server's clock minus the browser's, so "N ago" matches the times the server reports.
  const [offset, setOffset] = useState(0);
  const [serverGone, setServerGone] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);

  const take = useCallback((s: DashboardState) => {
    setState(s);
    setOffset(Date.parse(s.now) - Date.now());
    setServerGone(false);
  }, []);

  const poll = useCallback(async () => {
    // A slow answer would otherwise race the next poll and overwrite newer state.
    if (busy.current) return;
    busy.current = true;
    try {
      take(await fetchState());
    } catch {
      setServerGone(true);
    } finally {
      busy.current = false;
    }
  }, [take]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      take(await refreshState());
    } catch {
      setServerGone(true);
    } finally {
      setRefreshing(false);
    }
  }, [take]);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  return { state, offset, serverGone, refreshing, refresh };
}

function useNow(offset: number): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return Date.now() + offset;
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => initialTheme().theme);
  useEffect(() => {
    const first = initialTheme();
    applyTheme(first.chosen ? first.theme : null);
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
    saveTheme(next);
  };
  return toggle;
}

export function App() {
  const { state, offset, serverGone, refreshing, refresh } = useDashboardState();
  const now = useNow(offset);
  const toggleTheme = useTheme();
  const [selectedNumber, setSelected] = useState<number | null>(null);

  const items = useMemo(() => allItems(state.board), [state.board]);
  const byNumber = useMemo(() => new Map(items.map((x) => [x.number, x])), [items]);
  // An item that left the board (unassigned, or out of the 7-day window) is no longer selectable.
  const selected = selectedNumber === null ? null : (byNumber.get(selectedNumber) ?? null);
  const select = useCallback((n: number | null) => setSelected((cur) => (n === null || cur === n ? null : n)), []);

  const view: View = { state, items, item: (n) => byNumber.get(n), now, selected, select };
  const loading = state.status === "loading";
  const notice = serverGone ? SERVER_GONE : state.lastError ? failureNotice(state.lastError, state.lastUpdated) : null;
  const reading = refreshing || (state.status === "ready" && state.nextPoll === null);

  return (
    <ViewContext.Provider value={view}>
      <div className="grid grid-cols-1 min-[1000px]:h-screen min-[1000px]:grid-cols-[264px_1fr_340px]">
        <aside className="px-3 pt-5 pb-6 min-[1000px]:overflow-y-auto min-[1000px]:border-border min-[1000px]:border-r min-[1000px]:pb-24">
          <Sidebar loading={loading} />
        </aside>
        <main className="px-4 pt-5 pb-16 min-[1000px]:overflow-y-auto min-[1000px]:px-10 min-[1000px]:pt-7 min-[1000px]:pb-28">
          <div className="mx-auto max-w-[720px]">
            <div className="mb-7 flex min-h-[30px] items-center gap-1.5">
              <span className="flex-1 text-[13px] text-faint">
                {selected && (
                  <>
                    <button
                      type="button"
                      className="border-0 bg-transparent p-0 text-muted-foreground hover:underline hover:underline-offset-3"
                      onClick={() => select(null)}
                    >
                      {FEED.overview}
                    </button>{" "}
                    / #{selected.number}
                  </>
                )}
              </span>
              {loading && !state.lastError ? (
                <span className="text-[13px] text-muted-foreground">
                  <Spinner /> {FEED.loading}
                </span>
              ) : (
                <Button onClick={() => void refresh()} disabled={refreshing} title={pollHint(state.intervalMs)}>
                  {reading ? (
                    <>
                      <Spinner /> {FEED.refreshing}
                    </>
                  ) : (
                    <>{updatedLabel(state.lastUpdated, now)} ↻</>
                  )}
                </Button>
              )}
              <Button onClick={toggleTheme} title={FEED.theme} aria-label={FEED.theme}>
                ◐
              </Button>
              <img src="/favicon.svg" alt="norn" width={28} height={28} className="ml-1.5 rounded-[7px]" />
            </div>
            {notice && (
              <p role="status" className="-mt-1 mb-5 text-[13px] text-warn">
                {notice}
              </p>
            )}
            {loading ? (
              <>
                <Skeleton height={34} />
                <Skeletons count={3} height={76} />
                <Skeletons count={6} height={40} />
              </>
            ) : (
              <div className={cn(notice && "opacity-55")}>
                {selected ? (
                  <>
                    <h1 className="mt-0 mb-1 font-semibold text-[24px] leading-[1.3] tracking-[-0.02em]">{selected.title}</h1>
                    <p className="mt-0 mb-7 text-muted-foreground">{stateSentence(selected)}</p>
                  </>
                ) : (
                  <>
                    <Hero />
                    <div className="mt-10 mb-7 h-px bg-border" />
                  </>
                )}
                <Feed />
              </div>
            )}
          </div>
        </main>
        <section
          aria-label="Details"
          className={cn(
            "border-border border-t bg-card px-4 pt-7 pb-16 min-[1000px]:overflow-y-auto min-[1000px]:border-t-0 min-[1000px]:border-l min-[1000px]:px-6 min-[1000px]:pb-28",
            !loading && notice && "[&>*]:opacity-55",
          )}
        >
          {loading ? <Skeletons count={6} height={30} /> : selected ? <Detail key={selected.number} x={selected} /> : <Progress />}
        </section>
      </div>
    </ViewContext.Provider>
  );
}
