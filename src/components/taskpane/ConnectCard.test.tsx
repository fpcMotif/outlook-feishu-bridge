// ConnectCard behavior — the signed-out hero card that prompts the salesperson
// to connect to Feishu. It offers two entry points: the primary OAuth flow
// ("Continue with Feishu") and a backup email-code dialog flow ("Use backup
// login"). The card is purely presentational; it just fires the two callbacks.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConnectCard } from "./ConnectCard";

describe("ConnectCard", () => {
  it("renders the connect heading and explanatory copy", () => {
    render(<ConnectCard onLogin={vi.fn()} onLoginFallback={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /connect to feishu/i })).toBeInTheDocument();
    expect(screen.getByText(/structured feishu bitable row/i)).toBeInTheDocument();
  });

  it("calls onLogin (and not the fallback) when the primary 'Continue with Feishu' button is clicked", () => {
    const onLogin = vi.fn();
    const onLoginFallback = vi.fn();
    render(<ConnectCard onLogin={onLogin} onLoginFallback={onLoginFallback} />);

    fireEvent.click(screen.getByRole("button", { name: /continue with feishu/i }));

    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(onLoginFallback).not.toHaveBeenCalled();
  });

  it("calls onLoginFallback (and not the primary login) when the backup login button is clicked", () => {
    const onLogin = vi.fn();
    const onLoginFallback = vi.fn();
    render(<ConnectCard onLogin={onLogin} onLoginFallback={onLoginFallback} />);

    fireEvent.click(screen.getByRole("button", { name: /use backup login/i }));

    expect(onLoginFallback).toHaveBeenCalledTimes(1);
    expect(onLogin).not.toHaveBeenCalled();
  });
});
