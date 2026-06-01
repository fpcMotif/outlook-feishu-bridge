import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { DEV_DARK_STORAGE_KEY } from "@/lib/devDarkMode";

import { DevThemeToggle } from "./DevThemeToggle";

describe("DevThemeToggle", () => {
  beforeEach(() => {
    localStorage.removeItem(DEV_DARK_STORAGE_KEY);
    document.documentElement.classList.remove("dark");
  });

  it("toggles the dark class and aria-label on click", () => {
    render(<DevThemeToggle />);

    const button = screen.getByRole("button", { name: "Switch to dark mode" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).not.toHaveTextContent("Light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    fireEvent.click(button);

    const lightButton = screen.getByRole("button", { name: "Switch to light mode" });
    expect(lightButton).toHaveAttribute("aria-pressed", "true");
    expect(lightButton).not.toHaveTextContent("Dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(DEV_DARK_STORAGE_KEY)).toBe("1");

    fireEvent.click(lightButton);

    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(DEV_DARK_STORAGE_KEY)).toBe("0");
  });
});
