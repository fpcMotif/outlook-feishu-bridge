/* eslint-disable require-unicode-regexp */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useRequestSync", () => ({
  useRequestSync: () => ({
    sync: vi.fn(() => Promise.resolve({ recordId: "rec1" })),
    correct: vi.fn(() => Promise.resolve({ recordId: "rec1" })),
  }),
}));

vi.mock("../../hooks/useSelfForward", () => ({
  useSelfForward: () => ({ sendNote: vi.fn(() => Promise.resolve({ ok: true })) }),
}));

vi.mock("../../hooks/useCoworkerSearch", () => ({
  useCoworkerSearch: () => vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../hooks/useCustomerSearch", () => ({
  useCustomerSearch: () => ({
    directory: { status: "ready", records: [] },
    search: vi.fn(() => Promise.resolve([])),
  }),
}));

import { RequestIntakeScreen } from "./RequestIntakeScreen";
import type { MailItemData } from "../../office/useMailItem";

const SAMPLE: MailItemData = {
  subject: "Inquiry - bulk pricing",
  from: "m.hoffmann@bayerpharma.de",
  to: ["jenny.xu@fenchem.com"],
  cc: [],
  body: "We need quarterly pricing.",
  dateTimeCreated: new Date("2026-05-27T00:00:00Z"),
  internetMessageId: "<x@bayerpharma.de>",
  itemId: "item-1",
  conversationId: "conv-1",
  userEmail: "jenny.xu@fenchem.com",
  attachments: [],
};

function renderRequestIntakeScreen(
  isLoggedIn: boolean,
  clientEmail = "m.hoffmann@bayerpharma.de",
) {
  render(
    <RequestIntakeScreen
      isLoggedIn={isLoggedIn}
      mailItem={{ ...SAMPLE, from: clientEmail }}
      sessionId="test-session"
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

beforeEach(() => {
  localStorage.clear();
});

describe("RequestIntakeScreen login gate", () => {
  it("keeps the Feishu login surface separate from the request builder", () => {
    renderRequestIntakeScreen(false);

    expect(screen.getByText("Connect to Feishu")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Quotation/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Start a request above/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the request builder without the login prompt after sign-in", () => {
    renderRequestIntakeScreen(true);

    expect(screen.queryByText("Connect to Feishu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quotation/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Start a request above/i }),
    ).toBeInTheDocument();
  });
});

describe("RequestIntakeScreen request details", () => {
  it("marks filled request cards as selected", () => {
    renderRequestIntakeScreen(true);

    fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });

    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("moves filled requests into Act II coworker selection before submit", () => {
    renderRequestIntakeScreen(true);
    fillQuotationAndContinue();

    expect(screen.getByText("Client & coworker")).toBeInTheDocument();
    expect(screen.getByText("Client email")).toBeInTheDocument();
    expect(screen.getByDisplayValue("m.hoffmann@bayerpharma.de")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Feishu coworker" })).toBeInTheDocument();
    expect(screen.queryByText("Need a quarterly L-Carnitine quote.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Jenny Xu/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Choose exactly one Feishu coworker/i }),
    ).toBeDisabled();
  });

  it("lets users confirm and update the retrieved client email", () => {
    renderRequestIntakeScreen(true);
    fillQuotationAndContinue();

    fireEvent.change(screen.getByLabelText("Client email"), {
      target: { value: "updated.client@example.com" },
    });

    expect(screen.getByDisplayValue("updated.client@example.com")).toBeInTheDocument();
  });

});

describe("RequestIntakeScreen coworker selection", () => {
  it("allows exactly one coworker and replaces the selection on the cards", () => {
    renderRequestIntakeScreen(true);
    fillQuotationAndContinue();

    const jenny = screen.getByRole("button", { name: /Jenny Xu/i });
    fireEvent.click(jenny);
    expect(jenny).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Sync with Jenny Xu/i })).toBeInTheDocument();

    const michael = screen.getByRole("button", { name: /Michael Chen/i });
    fireEvent.click(michael);
    expect(jenny).toHaveAttribute("aria-pressed", "false");
    expect(michael).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Sync with Michael Chen/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove coworker/i })).not.toBeInTheDocument();
  });
});

describe("RequestIntakeScreen sync flow", () => {
  it("shows Act IV while syncing, then the success screen once sync resolves", async () => {
    renderRequestIntakeScreen(true);
    fillQuotationAndContinue();

    fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/i }));
    fireEvent.click(screen.getByRole("button", { name: /Sync with Jenny Xu/i }));

    expect(
      screen.getByRole("heading", { name: /Syncing to Feishu Bitable/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Sync progress/i })).toBeInTheDocument();

    expect(
      await screen.findByRole("heading", { name: /Synced to Feishu/i }),
    ).toBeInTheDocument();
  });
});
