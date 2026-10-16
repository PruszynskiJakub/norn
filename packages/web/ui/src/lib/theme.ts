export type Theme = "light" | "dark";

const KEY = "shepherd-dashboard-theme";

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The theme the developer chose last, else the system's. Storage can be unavailable, e.g. in a private window. */
export function initialTheme(): { theme: Theme; chosen: boolean } {
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return { theme: saved, chosen: true };
  } catch {
    // Fall through to the system preference.
  }
  return { theme: systemTheme(), chosen: false };
}

/** Sets .dark or .light on <html>; with neither, the stylesheet follows the system. */
export function applyTheme(theme: Theme | null): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
}

export function saveTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // The choice then lasts only for this page.
  }
}
