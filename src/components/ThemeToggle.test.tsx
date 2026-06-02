import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LEGACY_DEV_DARK_KEY, THEME_STORAGE_KEY } from "@/lib/theme";

import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    localStorage.removeItem(LEGACY_DEV_DARK_KEY);
    document.documentElement.classList.remove("dark");
  });
  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });

  it("toggles the dark class, aria state, and persists the theme on click", () => {
    render(<ThemeToggle />);

    const button = screen.getByRole("button", { name: "Switch to dark mode" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("id", "theme-toggle");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    fireEvent.click(button);

    const lightButton = screen.getByRole("button", { name: "Switch to light mode" });
    expect(lightButton).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    fireEvent.click(lightButton);

    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("starts dark when the theme is already persisted dark", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("migrates the legacy dev-dark-mode preference on first mount", () => {
    localStorage.setItem(LEGACY_DEV_DARK_KEY, "1");
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
