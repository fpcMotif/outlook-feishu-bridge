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

vi.mock("../../hooks/useCoworkerSearch", () => {
  const coworkers = [
    { openId: "ou_jenny", name: "Jenny Xu" },
    { openId: "ou_michael", name: "Michael Chen" },
    { openId: "ou_sales_ops", name: "Sales Ops" },
    { openId: "ou_wei", name: "Wei Liang" },
  ];
  return {
    useCoworkerSearch: () =>
      vi.fn((query: string) =>
        Promise.resolve(coworkers.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))),
      ),
  };
});

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

function fillQuotation() {
  fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
  fireEvent.change(screen.getByPlaceholderText(/Describe your requirements/i), {
    target: { value: "Need a quarterly L-Carnitine quote." },
  });
}

async function searchCoworker(name: string) {
  fireEvent.change(screen.getByLabelText("Search Feishu coworkers"), {
    target: { value: name },
  });
  return await screen.findByRole("button", { name: new RegExp(name, "i") });
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

  it("shows request details and client/coworker controls together after sign-in", () => {
    renderRequestIntakeScreen(true);

    expect(screen.queryByText("Connect to Feishu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quotation/i })).toBeInTheDocument();
    expect(screen.getByText("Client email")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Feishu coworker" })).toBeInTheDocument();
    expect(screen.getByText("Search by name to choose a Feishu coworker")).toBeInTheDocument();
    expect(screen.queryByText(/Recent & suggested/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Start a request above/i }),
    ).toBeDisabled();
  });
});

describe("RequestIntakeScreen request details", () => {
  it("marks filled request cards as selected", () => {
    renderRequestIntakeScreen(true);

    fillQuotation();

    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("keeps request details and client/coworker selection on one screen before submit", () => {
    renderRequestIntakeScreen(true);
    fillQuotation();

    expect(screen.getByText("Client & coworker")).toBeInTheDocument();
    expect(screen.getByText("Client email")).toBeInTheDocument();
    expect(screen.getByDisplayValue("m.hoffmann@bayerpharma.de")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Feishu coworker" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Need a quarterly L-Carnitine quote.")).toBeInTheDocument();
    expect(screen.queryByText(/Recent & suggested/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Choose exactly one Feishu coworker/i }),
    ).toBeDisabled();
  });

  it("lets users confirm and update the retrieved client email", () => {
    renderRequestIntakeScreen(true);
    fillQuotation();

    fireEvent.change(screen.getByLabelText("Client email"), {
      target: { value: "updated.client@example.com" },
    });

    expect(screen.getByDisplayValue("updated.client@example.com")).toBeInTheDocument();
  });
});

describe("RequestIntakeScreen coworker selection", () => {
  it("allows exactly one coworker and replaces the selection on the cards", async () => {
    renderRequestIntakeScreen(true);
    fillQuotation();

    const jenny = await searchCoworker("Jenny");
    fireEvent.click(jenny);
    expect(jenny).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Sync with Jenny Xu/i })).toBeInTheDocument();

    const michael = await searchCoworker("Michael");
    fireEvent.click(michael);
    expect(michael).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Sync with Michael Chen/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove coworker/i })).not.toBeInTheDocument();
  });
});

describe("RequestIntakeScreen sync flow", () => {
  it("shows Act IV while syncing, then the success screen once sync resolves", async () => {
    renderRequestIntakeScreen(true);
    fillQuotation();

    fireEvent.click(await searchCoworker("Jenny"));
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
