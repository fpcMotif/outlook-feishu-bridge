import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MailItemData } from "../../office/useMailItem";
import { RequestIntakeScreen } from "./RequestIntakeScreen";
import { resetIntakeUploadCaches } from "./uploadIntakeFile";

vi.mock("./RequestIntakeSyncBridge", () => ({
  RequestIntakeSyncBridge: ({ mailKey }: { mailKey: string }) => (
    <div data-testid="sync-bridge">{mailKey}</div>
  ),
}));

vi.mock("./RequestIntakeScreenCore", () => ({
  RequestIntakeScreenCore: ({ mailItem }: { mailItem: MailItemData }) => (
    <div data-testid="screen-core">{mailItem.conversationId}</div>
  ),
}));

vi.mock("./requestIntakeSyncApi", () => ({
  loggedOutRequestIntakeSyncApi: {},
}));

vi.mock("./uploadIntakeFile", () => ({
  resetIntakeUploadCaches: vi.fn(),
}));

const mockResetIntakeUploadCaches = vi.mocked(resetIntakeUploadCaches);

const MAIL_ITEM: MailItemData = {
  subject: "Inquiry",
  from: "client@example.com",
  to: ["sales@fenchem.com"],
  cc: [],
  body: "Need pricing.",
  dateTimeCreated: new Date("2026-06-01T00:00:00Z"),
  internetMessageId: "<message@example.com>",
  itemId: "item-1",
  conversationId: "conversation-1",
  userEmail: "sales@fenchem.com",
  attachments: [],
};

describe("RequestIntakeScreen mail key", () => {
  it("rekeys by mailbox plus conversation without bulk-clearing upload caches", async () => {
    const { rerender } = render(
      <RequestIntakeScreen
        isLoggedIn
        mailItem={MAIL_ITEM}
        sessionId="session-1"
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );

    expect(screen.getByTestId("sync-bridge")).toHaveTextContent(
      /conv:sales@fenchem\.com\s+conversation-1/,
    );
    expect(mockResetIntakeUploadCaches).not.toHaveBeenCalled();

    rerender(
      <RequestIntakeScreen
        isLoggedIn
        mailItem={{ ...MAIL_ITEM, conversationId: "conversation-2" }}
        sessionId="session-1"
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );

    expect(screen.getByTestId("sync-bridge")).toHaveTextContent(
      /conv:sales@fenchem\.com\s+conversation-2/,
    );
    await waitFor(() => expect(mockResetIntakeUploadCaches).not.toHaveBeenCalled());
  });
});
