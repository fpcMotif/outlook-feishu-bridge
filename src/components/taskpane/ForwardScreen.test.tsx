import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ForwardScreen } from "./ForwardScreen";

describe("ForwardScreen login gate", () => {
  it("keeps the Feishu login surface separate from the request builder", () => {
    render(
      <ForwardScreen
        isLoggedIn={false}
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );

    expect(screen.getByText("Connect your Feishu account")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Quotation/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Start a request above/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the request builder without the login prompt after sign-in", () => {
    render(
      <ForwardScreen
        isLoggedIn
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );

    expect(screen.queryByText("Connect your Feishu account")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quotation/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Start a request above/i }),
    ).toBeInTheDocument();
  });
});
