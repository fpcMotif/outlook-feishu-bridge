import { render, screen } from "@testing-library/react";
import { useAction, useQuery } from "convex/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { rememberRequestSyncSnapshot } from "../../hooks/requestSyncSnapshot";
import type { MailItemData } from "../../office/useMailItem";

vi.mock("convex/react", () => ({
  useAction: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("../../hooks/useAttachmentStaging", () => ({
  useAttachmentStaging: () => ({
    generateUploadUrl: vi.fn().mockResolvedValue("https://up/test"),
    uploadBytes: vi.fn().mockResolvedValue({ storageId: "st_test" }),
  }),
}));

vi.mock("../../hooks/useCoworkerSearch", () => ({
  useCoworkerSearch: () => vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../hooks/useCustomerSearch", () => ({
  useCustomerSearch: () => ({
    directory: { status: "ready", records: [] },
    search: vi.fn(() => Promise.resolve([])),
    matchEmail: vi.fn(() => Promise.resolve(null)),
    triggerRefresh: vi.fn(),
  }),
}));

vi.mock("./useAttachmentSync", () => ({
  useAttachmentSync: () => vi.fn(() => Promise.resolve({ attachments: [], failed: [] })),
}));

const mockUseAction = vi.mocked(useAction);
const mockUseQuery = vi.mocked(useQuery);
// useQuery returns undefined until Convex resolves (the still-loading frame).
const QUERY_LOADING = undefined as ReturnType<typeof useQuery>;

const originalMail: MailItemData = {
  subject: "Inquiry - bulk L-Carnitine",
  from: "m.hoffmann@bayerpharma.de",
  to: ["jenny.xu@fenchem.com"],
  cc: [],
  body: "We need quarterly pricing.",
  dateTimeCreated: new Date("2026-05-27T00:00:00Z"),
  internetMessageId: "<same-message@bayerpharma.de>",
  itemId: "item-1",
  conversationId: "conv-original",
  userEmail: "jenny.xu@fenchem.com",
  attachments: [],
};

import { RequestIntakeScreen } from "./RequestIntakeScreen";
import { clearIntakeDraftCache } from "./intakeDraftCache";

function renderLoggedIn(mailItem: MailItemData) {
  render(
    <RequestIntakeScreen
      isLoggedIn
      mailItem={mailItem}
      sessionId="test-session"
      onLogin={vi.fn()}
      onLoginFallback={vi.fn()}
    />,
  );
}

describe("RequestIntakeScreen already-synced fast reopen", () => {
  beforeEach(() => {
    clearIntakeDraftCache();
    localStorage.clear();
    vi.restoreAllMocks();
    mockUseAction.mockReturnValue(
      vi.fn(() => Promise.resolve({ status: "pending", recordId: null, detailUrl: null })) as
        unknown as ReturnType<typeof useAction>,
    );
    // This reproduces the slow path: Convex has not answered yet.
    mockUseQuery.mockReturnValue(QUERY_LOADING);
  });

  it("shows Already synced immediately when only internetMessageId still matches", () => {
    rememberRequestSyncSnapshot(originalMail, {
      recordId: "rec_existing",
      detailUrl: "https://feishu.cn/base/app?table=tbl&record=rec_existing",
      coworkerCount: 1,
      syncedAt: Date.now() - 60_000,
    });

    renderLoggedIn({
      ...originalMail,
      conversationId: "conv-reopened-by-outlook",
    });

    expect(screen.getByRole("heading", { name: /^Already synced$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open in Feishu/i })).toHaveAttribute(
      "href",
      "https://feishu.cn/base/app?table=tbl&record=rec_existing",
    );
    expect(screen.queryByRole("heading", { name: /Syncing to Feishu Base/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sync with/i })).not.toBeInTheDocument();
  });
});
