import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConnectCard } from "./ConnectCard";

describe("ConnectCard", () => {
  it("renders the official Feishu brand mark in the connect visual", () => {
    const { container } = render(
      <ConnectCard onLogin={vi.fn()} onLoginFallback={vi.fn()} />,
    );

    expect(screen.getByRole("region", { name: /Feishu sign in/i })).toBeInTheDocument();
    const brandBlue = container.querySelector('[fill="#3370FF"]');
    expect(brandBlue).toBeTruthy();
    expect(container.querySelector(".bg-primary.size-14")).toBeNull();
  });

  it("turns the primary login action into a disabled checking state", () => {
    const onLogin = vi.fn();
    const onLoginFallback = vi.fn();
    render(
      <ConnectCard
        onLogin={onLogin}
        onLoginFallback={onLoginFallback}
        isCheckingSession
      />,
    );

    expect(screen.queryByText(/Restoring session/i)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Checking Feishu/i);
    expect(screen.getByRole("button", { name: /Checking Feishu/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Use backup login/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Checking Feishu/i })).toHaveClass(
      "disabled:bg-muted",
      "disabled:text-muted-foreground",
      "disabled:shadow-none",
    );
  });
});
