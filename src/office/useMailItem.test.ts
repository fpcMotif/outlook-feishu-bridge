/* eslint-disable max-lines-per-function, require-await */
import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readMailBodyText } from "./mailBody";
import { useMailItem } from "./useMailItem";

vi.mock("./mailBody", () => ({
  readMailBodyText: vi.fn(),
}));

const mockBody = vi.mocked(readMailBodyText);

type Handler = () => void;

function installOffice(opts: {
  addHandlerAsync?: (eventType: string, handler: Handler) => void;
  removeHandlerAsync?: ReturnType<typeof vi.fn>;
}) {
  const item = {
    subject: "s",
    from: { emailAddress: "f@x.com" },
    to: [],
    cc: [],
    dateTimeCreated: null,
    internetMessageId: "",
    itemId: "i",
    conversationId: "",
    attachments: [],
  };
  (globalThis as unknown as { Office: unknown }).Office = {
    EventType: { ItemChanged: "olkItemSelectedChanged" },
    context: {
      mailbox: {
        item,
        addHandlerAsync: opts.addHandlerAsync,
        removeHandlerAsync: opts.removeHandlerAsync,
        userProfile: { emailAddress: "" },
      },
      requirements: { isSetSupported: () => true },
    },
  };
}

beforeEach(() => {
  mockBody.mockReset();
  mockBody.mockResolvedValue("body");
});

afterEach(() => {
  delete (globalThis as unknown as { Office?: unknown }).Office;
  vi.restoreAllMocks();
});

describe("useMailItem autoRead + ItemChanged", () => {
  it("registers an ItemChanged handler when autoRead=true and re-reads on change", async () => {
    let handler: Handler | null = null;
    installOffice({
      addHandlerAsync: (_event, h) => {
        handler = h;
      },
      removeHandlerAsync: vi.fn(),
    });

    await act(async () => {
      renderHook(() => useMailItem(true));
    });

    expect(mockBody).toHaveBeenCalledTimes(1);
    expect(handler).toBeTypeOf("function");

    await act(async () => {
      handler?.();
    });
    expect(mockBody).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes the ItemChanged handler on unmount", async () => {
    const removeHandlerAsync = vi.fn();
    installOffice({
      addHandlerAsync: vi.fn(),
      removeHandlerAsync,
    });

    const { unmount } = renderHook(() => useMailItem(true));
    await act(async () => {});
    unmount();
    expect(removeHandlerAsync).toHaveBeenCalled();
  });

  it("does not subscribe when autoRead is false", () => {
    const addHandlerAsync = vi.fn();
    installOffice({ addHandlerAsync, removeHandlerAsync: vi.fn() });

    renderHook(() => useMailItem(false));
    expect(addHandlerAsync).not.toHaveBeenCalled();
  });
});
