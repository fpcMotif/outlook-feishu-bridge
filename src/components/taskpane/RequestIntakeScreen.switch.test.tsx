// Regression for the pinned-pane email-switch leak (FH1). In a pinned task pane
// Outlook keeps RequestIntakeScreen mounted while the user moves between messages
// and useMailItem re-reads via ItemChanged. Before the conversation-scoped key,
// the intake reducer state (notes, screen, selections, uploads) leaked across the
// switch — worst case: a request submitted for conversation A showed as already
// synced when viewing an unrelated conversation B. These tests assert a clean slate
// on conversation change and preservation across sibling messages in one thread.
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useRequestSync", () => ({
  useRequestSync: () => ({
    sync: vi.fn(() => Promise.resolve({ recordId: "rec1" })),
    correct: vi.fn(() => Promise.resolve({ recordId: "rec1" })),
    existingSync: null,
  }),
}));

vi.mock("../../hooks/useSelfForward", () => ({
  useSelfForward: () => ({ sendNote: vi.fn(() => Promise.resolve({ ok: true })) }),
}));

vi.mock("../../hooks/useAttachmentStaging", () => ({
  useAttachmentStaging: () => ({
    generateUploadUrl: vi.fn().mockResolvedValue("https://up/test"),
    uploadBytes: vi.fn().mockResolvedValue({ storageId: "st_test" }),
  }),
}));

vi.mock("../../hooks/useCoworkerSearch", () => {
  const coworkers = [
    { openId: "ou_jenny", name: "Jenny Xu" },
    { openId: "ou_michael", name: "Michael Chen" },
  ];
  return {
    useCoworkerSearch: () =>
      vi.fn((query: string) =>
        Promise.resolve(
          coworkers.filter((c) => c.name.toLowerCase().includes(query.toLowerCase())),
        ),
      ),
  };
});

vi.mock("../../hooks/useCustomerSearch", () => ({
  useCustomerSearch: () => ({
    directory: { status: "ready", records: [] },
    search: vi.fn(() => Promise.resolve([])),
    matchEmail: vi.fn(() => Promise.resolve(null)),
    triggerRefresh: vi.fn(),
  }),
}));

vi.mock("./useAttachmentSync", () => ({
  useAttachmentSync: () => vi.fn(() => Promise.resolve({ sources: [], failed: [] })),
}));

import { RequestIntakeScreen } from "./RequestIntakeScreen";
import type { MailItemData } from "../../office/useMailItem";

const NOTE = "Need a quarterly L-Carnitine quote.";

const BASE: MailItemData = {
  subject: "Inquiry - bulk pricing",
  from: "m.hoffmann@bayerpharma.de",
  to: ["jenny.xu@fenchem.com"],
  cc: [],
  body: "We need quarterly pricing.",
  dateTimeCreated: new Date("2026-05-27T00:00:00Z"),
  internetMessageId: "<msg-1@bayerpharma.de>",
  itemId: "item-1",
  conversationId: "conv-1",
  userEmail: "jenny.xu@fenchem.com",
  attachments: [],
};

function screenFor(mailItem: MailItemData) {
  return (
    <RequestIntakeScreen
      isLoggedIn
      mailItem={mailItem}
      sessionId="test-session"
      onLogin={vi.fn()}
      onLoginFallback={vi.fn()}
      usePreviewCoworkers
    />
  );
}

function fillNote() {
  fireEvent.change(screen.getByPlaceholderText(/Describe your requirements/i), {
    target: { value: NOTE },
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("RequestIntakeScreen pinned-pane email switch", () => {
  it("starts a clean slate when the conversation changes", () => {
    const { rerender } = render(screenFor(BASE));
    fillNote();
    expect(screen.getByDisplayValue(NOTE)).toBeInTheDocument();

    // Switch to an unrelated conversation (different conversationId).
    rerender(
      screenFor({
        ...BASE,
        subject: "Different deal",
        from: "buyer@othercorp.com",
        internetMessageId: "<msg-9@othercorp.com>",
        itemId: "item-9",
        conversationId: "conv-2",
      }),
    );

    expect(screen.queryByDisplayValue(NOTE)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Describe your requirements/i)).toHaveValue("");
  });

  it("starts a clean slate even when the new conversation has the same sender", () => {
    // The old mailFrom-only reset missed this: same sender => guard never fired.
    const { rerender } = render(screenFor(BASE));
    fillNote();
    expect(screen.getByDisplayValue(NOTE)).toBeInTheDocument();

    rerender(
      screenFor({
        ...BASE,
        internetMessageId: "<msg-2@bayerpharma.de>",
        itemId: "item-2",
        conversationId: "conv-2", // different conversation, identical sender
      }),
    );

    expect(screen.queryByDisplayValue(NOTE)).not.toBeInTheDocument();
  });

  it("starts a clean slate for the same conversation in a different mailbox", () => {
    const { rerender } = render(screenFor(BASE));
    fillNote();
    expect(screen.getByDisplayValue(NOTE)).toBeInTheDocument();

    rerender(
      screenFor({
        ...BASE,
        userEmail: "michael.chen@fenchem.com",
      }),
    );

    expect(screen.queryByDisplayValue(NOTE)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Describe your requirements/i)).toHaveValue("");
  });

  it("restores the latest draft when switching back to a conversation page", () => {
    const { rerender } = render(screenFor(BASE));
    fillNote();

    rerender(
      screenFor({
        ...BASE,
        internetMessageId: "<msg-9@othercorp.com>",
        itemId: "item-9",
        conversationId: "conv-2",
      }),
    );
    expect(screen.queryByDisplayValue(NOTE)).not.toBeInTheDocument();

    rerender(screenFor(BASE));

    expect(screen.getByDisplayValue(NOTE)).toBeInTheDocument();
  });

  it("restores an explicitly changed sales pick when switching back", async () => {
    const { rerender } = render(screenFor(BASE));

    fireEvent.change(screen.getByLabelText("Search Feishu sales"), {
      target: { value: "Michael" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Michael Chen/i }));
    expect(screen.getByText("Michael Chen")).toBeInTheDocument();

    rerender(
      screenFor({
        ...BASE,
        internetMessageId: "<msg-9@othercorp.com>",
        itemId: "item-9",
        conversationId: "conv-2",
      }),
    );
    expect(screen.queryByText("Michael Chen")).not.toBeInTheDocument();
    expect(screen.getByText("Pick a sale")).toBeInTheDocument();

    rerender(screenFor(BASE));

    expect(screen.getByText("Michael Chen")).toBeInTheDocument();
  });

  it("preserves the in-progress request across sibling messages in one thread", () => {
    const { rerender } = render(screenFor(BASE));
    fillNote();
    expect(screen.getByDisplayValue(NOTE)).toBeInTheDocument();

    // Sibling message: same conversationId, different message ids.
    rerender(
      screenFor({
        ...BASE,
        subject: "Re: Inquiry - bulk pricing",
        internetMessageId: "<msg-2@bayerpharma.de>",
        itemId: "item-2",
      }),
    );

    expect(screen.getByDisplayValue(NOTE)).toBeInTheDocument();
  });
});
