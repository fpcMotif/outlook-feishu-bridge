/* eslint-disable require-unicode-regexp */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal mocks so the logged-in intake tree renders without real Convex/Office.
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
    { openId: "ou_michael", name: "Michael Chen", avatarUrl: "https://example.test/m.png" },
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
  useAttachmentSync: () =>
    vi.fn(() => Promise.resolve({ attachments: [], failed: [] })),
}));

import { RequestIntakeScreen } from "./RequestIntakeScreen";
import { resetSalesDefaultForTests } from "./scheduleSalesDefault";
import {
  buildUploadDraftKey,
  resetUploadDrafts,
  snapshotUploadDraft,
} from "./uploadDraftCache";
import type { UploadedFile } from "./intakeReducer";
import type { MailItemData } from "../../office/useMailItem";

const completedUpload = (name: string): UploadedFile => ({
  id: `up_${name}`,
  file: new File([new Uint8Array(8)], name, { type: "application/pdf" }),
  rejection: null,
  selected: true,
  status: "complete",
  progress: 100,
  storageId: `st_${name}`,
  uploadError: null,
});

const USER = {
  openId: "ou_rep",
  userName: "Rep",
  avatarUrl: "https://example.test/rep.png",
};

const BASE: MailItemData = {
  subject: "Inquiry",
  from: "m.hoffmann@bayerpharma.de",
  to: ["rep@fenchem.com"],
  cc: [],
  body: "",
  dateTimeCreated: new Date("2026-05-27T00:00:00Z"),
  internetMessageId: "<msg-a@bayerpharma.de>",
  itemId: "item-a",
  conversationId: "conv-A",
  userEmail: "rep@fenchem.com",
  attachments: [],
};

function screenFor(mailItem: MailItemData) {
  return (
    <RequestIntakeScreen
      isLoggedIn
      mailItem={mailItem}
      sessionId="test-session"
      user={USER}
      onLogin={vi.fn()}
      onLoginFallback={vi.fn()}
    />
  );
}

const noteField = () =>
  screen.getByPlaceholderText(/Describe your requirements/i) as HTMLTextAreaElement;

beforeEach(() => {
  // Keep the first-load Sales delay so the auto-default does not fire mid-test and
  // collapse the SalesPicker dropdown (the flag is module-global, ADR-0025).
  resetSalesDefaultForTests();
  resetUploadDrafts();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("RequestIntakeScreen — pinned-pane email switch", () => {
  it("wipes the in-progress request when the conversation (thread) changes", () => {
    const { rerender } = render(screenFor(BASE));
    fireEvent.change(noteField(), { target: { value: "Need a quarterly quote." } });
    expect(noteField().value).toBe("Need a quarterly quote.");

    // Switch to a DIFFERENT conversation -> remount -> clean slate for the new mail.
    rerender(
      screenFor({
        ...BASE,
        conversationId: "conv-B",
        internetMessageId: "<msg-b@acme.com>",
        itemId: "item-b",
        from: "buyer@acme.com",
      }),
    );

    expect(noteField().value).toBe("");
  });

  it("keeps the in-progress request when navigating WITHIN the same thread", () => {
    const { rerender } = render(screenFor(BASE));
    fireEvent.change(noteField(), { target: { value: "Need a quarterly quote." } });

    // Sibling message, SAME conversationId -> no remount -> request survives.
    rerender(
      screenFor({
        ...BASE,
        internetMessageId: "<msg-a2@bayerpharma.de>",
        itemId: "item-a2",
      }),
    );

    expect(noteField().value).toBe("Need a quarterly quote.");
  });

  it("keeps a reassigned Sales when navigating WITHIN the same thread (conversation-scoped, ADR-0025)", async () => {
    const salesRow = () => document.querySelector('[data-sales-row="true"]');
    const { rerender } = render(screenFor(BASE));

    // Reassign Sales to a colleague for this conversation.
    fireEvent.change(screen.getByLabelText("Search Feishu sales"), {
      target: { value: "Michael" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Michael Chen/i }));
    expect(salesRow()).toHaveTextContent("Michael Chen");

    // Sibling message, SAME conversationId -> no remount -> the reassignment
    // survives (reading a reply must not silently discard it before sync).
    rerender(
      screenFor({
        ...BASE,
        internetMessageId: "<msg-a2@bayerpharma.de>",
        itemId: "item-a2",
      }),
    );

    expect(salesRow()).toHaveTextContent("Michael Chen");
  });

  // The attachment row strips the extension for display but keeps the full name
  // as the element's aria-label — assert on that (robust against the display).
  const uploadRow = (name: string) => document.querySelector(`[aria-label="${name}"]`);

  it("restores a cached upload draft on return to the conversation (no re-upload)", () => {
    const key = buildUploadDraftKey("ou_rep", BASE.userEmail, BASE.conversationId);
    snapshotUploadDraft(key, [completedUpload("report.pdf")]);

    const { rerender } = render(screenFor(BASE));
    // restore-on-mount: the cached upload reappears as a complete row.
    expect(uploadRow("report.pdf")).not.toBeNull();

    // Leave to a DIFFERENT conversation -> remount -> the row is gone from view.
    rerender(
      screenFor({
        ...BASE,
        conversationId: "conv-B",
        internetMessageId: "<b@acme.com>",
        itemId: "item-b",
        from: "buyer@acme.com",
      }),
    );
    expect(uploadRow("report.pdf")).toBeNull();

    // Return -> the draft is re-snapshotted on leave and restored on return.
    rerender(screenFor(BASE));
    expect(uploadRow("report.pdf")).not.toBeNull();
  });

  it("does NOT restore another Feishu account's draft on the same mailbox (openId isolation)", () => {
    const key = buildUploadDraftKey("ou_rep", BASE.userEmail, BASE.conversationId);
    snapshotUploadDraft(key, [completedUpload("secret.pdf")]);

    // A DIFFERENT Feishu user (openId) on the same Outlook mailbox + conversation.
    render(
      <RequestIntakeScreen
        isLoggedIn
        mailItem={BASE}
        sessionId="test-session"
        user={{ openId: "ou_other", userName: "Other", avatarUrl: "https://example.test/o.png" }}
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );

    expect(uploadRow("secret.pdf")).toBeNull();
  });
});
