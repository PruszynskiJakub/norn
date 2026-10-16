import { createContext, useContext } from "react";
import type { DashboardState } from "../../src/contract.ts";
import type { Item } from "./model.ts";

/** What every pane reads: the state, the items by number, the clock and the selection. */
export interface View {
  state: DashboardState;
  items: Item[];
  item: (n: number) => Item | undefined;
  /** The server's clock now: its `now` plus the time since the state arrived. */
  now: number;
  selected: Item | null;
  /** Selects an item, or clears the selection when it is already selected or null; either way back on the board. */
  select: (n: number | null) => void;
  /** Which page the middle shows: the board and its feed, or the repository's flows. */
  page: Page;
  showFlows: () => void;
}

export type Page = "board" | "flows";

export const ViewContext = createContext<View | null>(null);

export function useView(): View {
  const v = useContext(ViewContext);
  if (!v) throw new Error("useView outside ViewContext");
  return v;
}
