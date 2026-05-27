import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ForwardScreen } from "./ForwardScreen";

function renderForwardScreen(
  isLoggedIn: boolean,
  clientEmail = "m.hoffmann@bayerpharma.de",
) {
  render(
    <ForwardScreen
      isLoggedIn={isLoggedIn}
      clientEmail={clientEmail}
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
});

describe("ForwardScreen request details", () => {
  it("marks filled request cards as selected", () => {
    renderForwardScreen(true);

    fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });

    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("moves filled requests into Act II coworker selection before submit", () => {
    renderForwardScreen(true);
    fillQuotationAndContinue();

    expect(screen.getByText("Client & coworker")).toBeInTheDocument();
    expect(screen.getByText("Client email")).toBeInTheDocument();
    expect(screen.getByDisplayValue("m.hoffmann@bayerpharma.de")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Feishu coworker" })).toBeInTheDocument();
    expect(screen.queryByText("Need a quarterly L-Carnitine quote.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Jenny Xu/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Choose a Feishu coworker/i }),
    ).toBeDisabled();
  });

  it("lets users confirm and update the retrieved client email", () => {
    renderForwardScreen(true);
    fillQuotationAndContinue();

    fireEvent.change(screen.getByLabelText("Client email"), {
      target: { value: "updated.client@example.com" },
    });

    expect(screen.getByDisplayValue("updated.client@example.com")).toBeInTheDocument();
  });

  it("keeps coworker selection on cards without selected tags", () => {
    renderForwardScreen(true);
    fillQuotationAndContinue();

    fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/i }));

    expect(screen.getByRole("button", { name: /Submit to 1 coworker/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove coworker/i })).not.toBeInTheDocument();
  });
});

describe("ForwardScreen sync flow", () => {
  it("shows Act IV while syncing before the success screen", () => {
    vi.useFakeTimers();
    renderForwardScreen(true);
    fillQuotationAndContinue();

    fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/i }));
    fireEvent.click(screen.getByRole("button", { name: /Submit to 1 coworker/i }));

    expect(
      screen.getByRole("heading", { name: /Syncing to Feishu Bitable/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Sync progress/i })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3700);
    });

    expect(screen.getByRole("heading", { name: /Synced to Feishu/i })).toBeInTheDocument();
    vi.useRealTimers();
  });
});
