// User-facing light/dark theme (ADR-0020). Promoted from the dev-only dark
// toggle: a single source of truth for reading, applying, and persisting the
// theme, applied before first paint from `main.tsx`.

export const THEME_STORAGE_KEY = "theme";
// The dev-only predecessor key; read once for a transparent migration so a dev
// who had dark mode on does not get reset to light.
export const LEGACY_DEV_DARK_KEY = "dev-dark-mode";

export type Theme = "light" | "dark";

function prefersDark(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
}

/**
 * Resolve the active theme. Precedence: explicit stored `theme` → one-time
 * migration of the legacy `dev-dark-mode` value → the OS `prefers-color-scheme`.
 */
export function readTheme(): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;

  const legacy = localStorage.getItem(LEGACY_DEV_DARK_KEY);
  if (legacy === "1") return "dark";
  if (legacy === "0") return "light";

  return prefersDark() ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function persistTheme(theme: Theme): void {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

/** Apply the resolved theme before React paints. Called unconditionally at boot. */
export function initThemeFromStorage(): void {
  applyTheme(readTheme());
}
