export const DEV_DARK_STORAGE_KEY = "dev-dark-mode";

export function readDevDarkMode(): boolean {
  return localStorage.getItem(DEV_DARK_STORAGE_KEY) === "1";
}

export function applyDevDarkMode(on: boolean): void {
  document.documentElement.classList.toggle("dark", on);
}

/** Apply persisted dev dark mode before React paints (DEV only). */
export function initDevDarkModeFromStorage(): void {
  applyDevDarkMode(readDevDarkMode());
}

export function persistDevDarkMode(on: boolean): void {
  localStorage.setItem(DEV_DARK_STORAGE_KEY, on ? "1" : "0");
}
