import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useMailItem } from "./useMailItem";

type BodyResult =
  | { status: "succeeded"; value: string }
  | { status: "failed"; error: { message: string } };
type BodyCallback = (result: BodyResult) => void;
type TestReadItem = {
  subject: string;
  from: { emailAddress: string };
  to: { emailAddress: string }[];
  cc: { emailAddress: string }[];
  dateTimeCreated: Date;
  internetMessageId: string;
  itemId: string;
  conversationId: string;
  attachments: {
    id: string;
    name: string;
    attachmentType: string;
    size: number;
    isInline: boolean;
  }[];
  body: { getAsync: (coercion: string, cb: BodyCallback) => void };
};

function mailItem(
  getBody: (coercion: string, cb: BodyCallback) => void,
  overrides: Partial<TestReadItem> = {},
): TestReadItem {
  return {
    subject: "Inquiry",
    from: { emailAddress: "client@example.com" },
    to: [{ emailAddress: "rep@fenchem.com" }],
    cc: [],
    dateTimeCreated: new Date("2026-06-04T00:00:00Z"),
    internetMessageId: "<msg@example.com>",
    itemId: "ews-1",
    conversationId: "conv-1",
    attachments: [
      { id: "a1", name: "quote.pdf", attachmentType: "file", size: 12, isInline: false },
    ],
    body: { getAsync: getBody },
    ...overrides,
  };
}

function installOffice(
  getBody: (coercion: string, cb: BodyCallback) => void,
  opts: {
    item?: TestReadItem;
    addHandlerAsync?: (eventType: string, handler: () => void) => void;
    removeHandlerAsync?: (eventType: string) => void;
  } = {},
) {
  const mailbox = {
    userProfile: { emailAddress: "rep@fenchem.com" },
    convertToRestId: (id: string) => `REST(${id})`,
    item: opts.item ?? mailItem(getBody),
    addHandlerAsync: opts.addHandlerAsync,
    removeHandlerAsync: opts.removeHandlerAsync,
  };
  (globalThis as unknown as { Office: unknown }).Office = {
    EventType: { ItemChanged: "ItemChanged" },
    CoercionType: { Text: "text" },
    AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
    MailboxEnums: { RestVersion: { v2_0: "v2.0" } },
    context: {
      requirements: {
        isSetSupported: () => true,
      },
      mailbox,
    },
  };
  return mailbox;
}

afterEach(() => {
  delete (globalThis as unknown as { Office?: unknown }).Office;
  vi.restoreAllMocks();
});

describe("useMailItem", () => {
  it("publishes mail metadata before the background body read resolves", async () => {
    let bodyCallback: BodyCallback | null = null;
    installOffice((_coercion, cb) => {
      bodyCallback = cb;
    });

    const { result } = renderHook(() => useMailItem(true));

    await waitFor(() => {
      expect(result.current.mailItem).toMatchObject({
        subject: "Inquiry",
        from: "client@example.com",
        body: "",
        attachments: [{ id: "a1", name: "quote.pdf" }],
      });
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    // The body placeholder must be flagged pending so the submit gate can block
    // Sync until the real body lands (prevents an empty body reaching the Base row).
    expect(result.current.mailItem?.bodyPending).toBe(true);
    expect(bodyCallback).not.toBeNull();

    await act(async () => {
      bodyCallback?.({ status: "succeeded", value: "Full body text" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.mailItem?.body).toBe("Full body text");
    });
    expect(result.current.mailItem?.bodyPending).toBe(false);
  });

  it("keeps metadata available when the background body read fails", async () => {
    let bodyCallback: BodyCallback | null = null;
    installOffice((_coercion, cb) => {
      bodyCallback = cb;
    });

    const { result } = renderHook(() => useMailItem(true));

    await waitFor(() => {
      expect(result.current.mailItem?.subject).toBe("Inquiry");
    });

    await act(async () => {
      bodyCallback?.({ status: "failed", error: { message: "permission denied" } });
      await Promise.resolve();
    });

    expect(result.current.mailItem?.body).toBe("");
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    // A failed body read must still clear bodyPending so Sync is not blocked forever.
    expect(result.current.mailItem?.bodyPending).toBe(false);
  });

  it("re-reads the selected message when a pinned Outlook task pane gets ItemChanged", async () => {
    let itemChanged: (() => void) | null = null;
    const addHandlerAsync = vi.fn((_eventType: string, handler: () => void) => {
      itemChanged = handler;
    });
    const removeHandlerAsync = vi.fn();
    const getBody = (_coercion: string, cb: BodyCallback) => {
      cb({ status: "succeeded", value: "Body text" });
    };
    const mailbox = installOffice(getBody, { addHandlerAsync, removeHandlerAsync });

    const { result, unmount } = renderHook(() => useMailItem(true));

    await waitFor(() => {
      expect(result.current.mailItem?.subject).toBe("Inquiry");
    });
    expect(addHandlerAsync).toHaveBeenCalledWith(
      "ItemChanged",
      expect.any(Function),
      expect.any(Function),
    );

    await act(async () => {
      mailbox.item = mailItem(getBody, {
        subject: "New inquiry",
        internetMessageId: "<msg-2@example.com>",
        itemId: "ews-2",
        conversationId: "conv-2",
        attachments: [
          { id: "a2", name: "new-spec.xlsx", attachmentType: "file", size: 24, isInline: false },
        ],
      });
      itemChanged?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.mailItem).toMatchObject({
        subject: "New inquiry",
        internetMessageId: "<msg-2@example.com>",
        itemId: "REST(ews-2)",
        conversationId: "conv-2",
        attachments: [{ id: "a2", name: "new-spec.xlsx" }],
      });
    });

    unmount();

    expect(removeHandlerAsync).toHaveBeenCalledWith("ItemChanged");
  });
});
