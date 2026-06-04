import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LoginScreen } from "./LoginScreen";

describe("LoginScreen", () => {
  it("uses theme semantic tokens for shell and eyebrow label", () => {
    const { container } = render(
      <LoginScreen onLogin={vi.fn()} onLoginFallback={vi.fn()} />,
    );

    const shell = container.firstElementChild;
    expect(shell).toHaveClass("bg-background", "text-foreground");
    expect(shell).not.toHaveAttribute("style");

    const eyebrow = screen.getByText(/Outlook handoff/i);
    expect(eyebrow).toHaveClass("text-muted-foreground");
    expect(eyebrow).not.toHaveClass("text-accent-foreground");
  });
});
