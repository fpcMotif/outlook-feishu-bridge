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
  expect(screen.queryByText("Bitable preview")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
}

describe("ForwardScreen login gate", () => {
  it("keeps the Feishu login surface separate from the request builder", () => {
    renderForwardScreen(false);

    expect(screen.getByText("Connect to Feishu")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Quotation/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Start a request above/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the request builder without the login prompt after sign-in", () => {
    renderForwardScreen(true);

    expect(screen.queryByText("Connect to Feishu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quotation/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Start a request above/i }),
    ).toBeInTheDocument();
  });

  it("moves filled requests into coworker selection before submit", () => {
    renderForwardScreen(true);
    fillQuotationAndContinue();

    expect(screen.getByText("Forward to")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Select Feishu/i })).toBeInTheDocument();
    expect(screen.getByText("Quotation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Jenny Xu/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Choose a Feishu coworker/i }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/i }));

    expect(screen.getByText("Bitable preview")).toBeInTheDocument();
    expect(screen.getByText("Recipient")).toBeInTheDocument();
    expect(screen.getAllByText("Need a quarterly L-Carnitine quote.")).toHaveLength(2);
  });
});
