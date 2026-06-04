import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useMailItem } from "./useMailItem";

type BodyResult =
  | { status: "succeeded"; value: string }
  | { status: "failed"; error: { message: string } };
type BodyCallback = (result: BodyResult) => void;

function installOffice(getBody: (coercion: string, cb: BodyCallback) => void) {
  (globalThis as unknown as { Office: unknown }).Office = {
    CoercionType: { Text: "text" },
    AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
    MailboxEnums: { RestVersion: { v2_0: "v2.0" } },
    context: {
      requirements: {
        isSetSupported: () => true,
      },
      mailbox: {
        userProfile: { emailAddress: "rep@fenchem.com" },
        convertToRestId: (id: string) => `REST(${id})`,
        item: {
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
        },
      },
    },
  };
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
    expect(bodyCallback).not.toBeNull();

    await act(async () => {
      bodyCallback?.({ status: "succeeded", value: "Full body text" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.mailItem?.body).toBe("Full body text");
    });
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
  });
});
