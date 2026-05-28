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

import { ForwardScreen } from "./ForwardScreen";
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

function renderScreen() {
  render(
    <ForwardScreen
      isLoggedIn={true}
      mailItem={SAMPLE}
      sessionId="test-session"
      onLogin={vi.fn()}
      onLoginFallback={vi.fn()}
    />,
  );
}

describe("ForwardScreen sync wiring", () => {
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
