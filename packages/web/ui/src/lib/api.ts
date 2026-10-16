import type { DashboardState } from "../../../src/contract.ts";

async function answer(res: Response): Promise<DashboardState> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as DashboardState;
}

/** The server's cached state; cheap, so the page asks often. */
export async function fetchState(): Promise<DashboardState> {
  return answer(await fetch("/api/state", { cache: "no-store" }));
}

/** Asks the server to read GitHub now; it answers with the state after that read. */
export async function refreshState(): Promise<DashboardState> {
  return answer(await fetch("/api/refresh", { method: "POST" }));
}
