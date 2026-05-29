// useMailItem reads the current Outlook mail item into MailItemData. The pure
// Office→data mappers live in ./mailItem (already 100% tested); this file covers
// the HOOK orchestration: the no-item error, the compose-item rejection, the
// loading/error state machine, and the autoRead-once effect.
//
// readMailBodyText (./mailBody) is mocked so the body read is deterministic and
// no real Office.body.getAsync is needed. The Office namespace only exists in
// Outlook, so we stub globalThis.Office.context.mailbox.item per test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

import { useMailItem } from "./useMailItem";

const readMailBodyText = vi.fn<() => Promise<string>>();
vi.mock("./mailBody", () => ({
  readMailBodyText: () => readMailBodyText(),
}));

type StubMailbox = {
  item?: unknown;
  userProfile?: { emailAddress?: string };
  convertToRestId?: (id: string, version: unknown) => string;
};

// Install a stub Office namespace whose mailbox.item is whatever the test wants
// (undefined to hit the no-item path, a compose-shaped item to hit the reject,
// or a read item for the happy path). convertToRestId echoes the id so the
// extractMailData result is assertable.
function installOffice(mailbox: StubMailbox): void {
  (globalThis as unknown as { Office: unknown }).Office = {
    MailboxEnums: { RestVersion: { v2_0: "v2.0" } },
    context: {
      mailbox: {
        userProfile: { emailAddress: "me@fenchem.com" },
        convertToRestId: (id: string) => `REST(${id})`,
        ...mailbox,
      },
    },
  };
}

const READ_ITEM = {
  subject: "Quarterly quote",
  from: { emailAddress: "client@acme.com" },
  to: [{ emailAddress: "rep@fenchem.com" }],
  cc: [{ emailAddress: "cc@fenchem.com" }],
  dateTimeCreated: new Date("2026-05-27T00:00:00Z"),
  internetMessageId: "<msg@acme.com>",
  itemId: "EWS-1",
  conversationId: "conv-1",
};

beforeEach(() => {
  readMailBodyText.mockReset();
  readMailBodyText.mockResolvedValue("the body");
});

afterEach(() => {
  delete (globalThis as unknown as { Office?: unknown }).Office;
  vi.restoreAllMocks();
});

describe("useMailItem", () => {
  it("sets the no-item error and leaves mailItem null when no message is selected", async () => {
    installOffice({ item: undefined });
    const { result } = renderHook(() => useMailItem());

    await act(async () => {
      await result.current.readCurrentItem();
    });

    expect(result.current.error).toBe(
      "No mail item selected (not inside Outlook, or no message open)",
    );
    expect(result.current.mailItem).toBeNull();
    expect(result.current.loading).toBe(false);
    // The body read must not even be attempted when there is no item.
    expect(readMailBodyText).not.toHaveBeenCalled();
  });

  it("sets the compose-item error and does NOT read the body for a compose/reply window", async () => {
    // A compose item exposes subject as an async object with getAsync.
    installOffice({ item: { subject: { getAsync: () => {} } } });
    const { result } = renderHook(() => useMailItem());

    await act(async () => {
      await result.current.readCurrentItem();
    });

    expect(result.current.error).toContain("open a received message in the reading pane");
    expect(result.current.mailItem).toBeNull();
    expect(readMailBodyText).not.toHaveBeenCalled();
  });

  it("populates mailItem from a read item plus the awaited body on the happy path", async () => {
    installOffice({ item: READ_ITEM });
    const { result } = renderHook(() => useMailItem());

    await act(async () => {
      await result.current.readCurrentItem();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.mailItem).toEqual({
      subject: "Quarterly quote",
      from: "client@acme.com",
      to: ["rep@fenchem.com"],
      cc: ["cc@fenchem.com"],
      body: "the body",
      dateTimeCreated: new Date("2026-05-27T00:00:00Z"),
      internetMessageId: "<msg@acme.com>",
      itemId: "REST(EWS-1)",
      conversationId: "conv-1",
      userEmail: "me@fenchem.com",
    });
    expect(readMailBodyText).toHaveBeenCalledTimes(1);
  });

  it("sets the error when the body read rejects and keeps mailItem null", async () => {
    installOffice({ item: READ_ITEM });
    readMailBodyText.mockRejectedValueOnce(new Error("getAsync failed"));
    const { result } = renderHook(() => useMailItem());

    await act(async () => {
      await result.current.readCurrentItem();
    });

    expect(result.current.error).toBe("getAsync failed");
    expect(result.current.mailItem).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("reports 'Unknown error' when a non-Error value is thrown", async () => {
    installOffice({ item: READ_ITEM });
    readMailBodyText.mockRejectedValueOnce("just a string");
    const { result } = renderHook(() => useMailItem());

    await act(async () => {
      await result.current.readCurrentItem();
    });

    expect(result.current.error).toBe("Unknown error");
  });

  it("clears a prior error before re-reading on a second readCurrentItem call", async () => {
    installOffice({ item: undefined });
    const { result } = renderHook(() => useMailItem());

    // First read fails (no item) and sets the error.
    await act(async () => {
      await result.current.readCurrentItem();
    });
    expect(result.current.error).not.toBeNull();

    // Now an item is present; the second read must clear the old error first
    // (setError(null) at the start) and then succeed.
    installOffice({ item: READ_ITEM });
    await act(async () => {
      await result.current.readCurrentItem();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.mailItem?.subject).toBe("Quarterly quote");
  });

  it("toggles loading true while in-flight and false after the read settles", async () => {
    installOffice({ item: READ_ITEM });
    // Defer the body resolution so we can observe loading=true mid-flight.
    let resolveBody: (v: string) => void = () => {};
    readMailBodyText.mockImplementationOnce(
      () => new Promise<string>((res) => (resolveBody = res)),
    );
    const { result } = renderHook(() => useMailItem());

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.readCurrentItem();
    });
    // loading flips to true synchronously at the start of the read.
    expect(result.current.loading).toBe(true);

    await act(async () => {
      resolveBody("the body");
      await pending;
    });
    expect(result.current.loading).toBe(false);
  });

  it("autoRead=true triggers exactly one read on mount and a re-render does not re-read", async () => {
    installOffice({ item: READ_ITEM });
    const { result, rerender } = renderHook(() => useMailItem(true));

    await waitFor(() => expect(result.current.mailItem).not.toBeNull());
    expect(readMailBodyText).toHaveBeenCalledTimes(1);

    // didAutoRead.current is now true; a re-render must not fire a second read.
    rerender();
    await waitFor(() => expect(result.current.mailItem?.subject).toBe("Quarterly quote"));
    expect(readMailBodyText).toHaveBeenCalledTimes(1);
  });

  it("autoRead=false does not auto-read on mount", async () => {
    installOffice({ item: READ_ITEM });
    const { result } = renderHook(() => useMailItem(false));

    // Give any stray effect a tick to (not) run.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.mailItem).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(readMailBodyText).not.toHaveBeenCalled();
  });

  it("autoRead defaults to false (no auto-read when called with no argument)", async () => {
    installOffice({ item: READ_ITEM });
    const { result } = renderHook(() => useMailItem());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.mailItem).toBeNull();
    expect(readMailBodyText).not.toHaveBeenCalled();
  });
});
