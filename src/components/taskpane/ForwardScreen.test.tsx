import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ForwardScreen } from "./ForwardScreen";

function renderForwardScreen(isLoggedIn: boolean) {
  render(
    <ForwardScreen
      isLoggedIn={isLoggedIn}
      onLogin={vi.fn()}
      onLoginFallback={vi.fn()}
    />,
  );
}

function fillQuotationAndContinue() {
  fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Need a quarterly L-Carnitine quote." },
  });
  fireEvent.click(screen.getByRole("button", { name: /Continue to Act II/i }));
}

describe("ForwardScreen login gate", () => {
  it("keeps the Feishu login surface separate from the request builder", () => {
    renderForwardScreen(false);

    expect(screen.getByText("Connect your Feishu account")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Quotation/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Start a request above/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the request builder without the login prompt after sign-in", () => {
    renderForwardScreen(true);

    expect(screen.queryByText("Connect your Feishu account")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quotation/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Start a request above/i }),
    ).toBeInTheDocument();
  });

  it("moves filled requests into Act II coworker selection before submit", () => {
    renderForwardScreen(true);
    fillQuotationAndContinue();

    expect(screen.getByText("Act II")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Select Feishu/i })).toBeInTheDocument();
    expect(screen.getByText("Quotation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Jenny Xu/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Choose a Feishu coworker/i }),
    ).toBeDisabled();
  });
});
