/* eslint-disable max-lines-per-function */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSync = vi.fn((_payload: unknown) => Promise.resolve({ recordId: "recTEST" }));
const mockCorrect = vi.fn((_payload: unknown) => Promise.resolve({ recordId: "recTEST" }));
vi.mock("../../hooks/useRequestSync", () => ({
  useRequestSync: () => ({ sync: mockSync, correct: mockCorrect }),
}));
vi.mock("../../hooks/useCoworkerSearch", () => ({
  useCoworkerSearch: () => vi.fn(() => Promise.resolve([])),
}));
const BAYER = {
  recordId: "rec_bayer",
  name: "Bayer Pharma",
  domain: "bayerpharma.de",
  owner: null,
};
const STOCKMEIER = {
  recordId: "rec_stock",
  name: "STOCKMEIER Chemie GmbH & Co. KG",
  domain: "stockmeier.com",
  owner: null,
};
vi.mock("../../hooks/useCustomerSearch", () => ({
  useCustomerSearch: () => ({
    directory: { status: "ready", records: [BAYER, STOCKMEIER] },
    search: vi.fn(() => Promise.resolve([])),
  }),
}));

import { RequestIntakeScreen } from "./RequestIntakeScreen";
import type { MailItemData } from "../../office/useMailItem";

const SAMPLE: MailItemData = {
  subject: "Inquiry - bulk L-Carnitine",
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

function renderScreen(
  user?: { openId: string; userName?: string; avatarUrl?: string },
) {
  render(
    <RequestIntakeScreen
      isLoggedIn={true}
      mailItem={SAMPLE}
      sessionId="test-session"
      user={user}
      onLogin={vi.fn()}
      onLoginFallback={vi.fn()}
    />,
  );
}

describe("RequestIntakeScreen sync wiring", () => {
  beforeEach(() => {
    mockSync.mockClear();
    mockCorrect.mockClear();
    localStorage.clear();
  });

  it("calls sync once with the request, coworker, and client email on submit", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/i }));
    fireEvent.click(screen.getByRole("button", { name: /Sync with Jenny Xu/i }));

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(mockSync.mock.calls[0][0]).toMatchObject({
      clientEmail: "m.hoffmann@bayerpharma.de",
      subject: "Inquiry - bulk L-Carnitine",
      from: "m.hoffmann@bayerpharma.de",
      requestSelections: [
        { requestType: "Quotation", note: "Need a quarterly L-Carnitine quote." },
      ],
      selectedCoworkers: [{ openId: "ou_jenny", name: "Jenny Xu" }],
    });
  });

  // Customer-matching wiring (ADR-0013): when the directory contains a row
  // whose 域名 equals the sender's domain, sync rides with selectedCustomer
  // set so the backend writes the right Client DuplexLink instead of falling
  // back to the legacy domain-search-per-write.
  it("passes the auto-matched Customer through to sync when the directory has a domain hit", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/i }));
    fireEvent.click(screen.getByRole("button", { name: /Sync with Jenny Xu/i }));

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(mockSync.mock.calls[0][0]).toMatchObject({
      selectedCustomer: { recordId: "rec_bayer", name: "Bayer Pharma" },
    });
  });

  // Override wins over auto-match (ADR-0013): tapping Change → typing →
  // picking a different Customer changes which selectedCustomer rides to sync.
  it("uses the user's Customer override instead of the auto-match when one is picked", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    fireEvent.click(screen.getByRole("button", { name: /change/i }));
    fireEvent.change(screen.getByRole("searchbox", { name: /search customers/i }), {
      target: { value: "stock" },
    });
    fireEvent.click(screen.getByRole("button", { name: /STOCKMEIER Chemie/i }));

    fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/i }));
    fireEvent.click(screen.getByRole("button", { name: /Sync with Jenny Xu/i }));

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(mockSync.mock.calls[0][0]).toMatchObject({
      selectedCustomer: { recordId: "rec_stock", name: STOCKMEIER.name },
    });
  });

  // ADR-0014: the signed-in Feishu user (the Initiator) rides on every sync
  // call so the backend can write the `Sales` User column. Distinct from the
  // assignee Coworker — the salesperson who clicked Sync vs the one who'll
  // handle the request.
  it("passes the signed-in user as the Initiator on sync", async () => {
    renderScreen({ openId: "ou_jenny_initiator", userName: "Jenny Xu" });
    fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/i }));
    fireEvent.click(screen.getByRole("button", { name: /Sync with Jenny Xu/i }));

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(mockSync.mock.calls[0][0]).toMatchObject({
      initiator: { openId: "ou_jenny_initiator", name: "Jenny Xu" },
    });
  });

  it("shows an error and not the success screen when sync rejects", async () => {
    mockSync.mockImplementationOnce(() => Promise.reject(new Error("Bitable unavailable")));
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/i }));
    fireEvent.click(screen.getByRole("button", { name: /Sync with Jenny Xu/i }));

    expect(await screen.findByRole("heading", { name: /Sync failed/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /Synced to Feishu/i }),
    ).not.toBeInTheDocument();
  });
});
