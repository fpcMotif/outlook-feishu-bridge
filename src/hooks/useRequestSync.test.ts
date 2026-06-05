import { act, renderHook, waitFor } from "@testing-library/react";
import { useAction, useQuery } from "convex/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  readRequestSyncSnapshot,
  rememberRequestSyncSnapshot,
} from "./requestSyncSnapshot";
import { useRequestSync } from "./useRequestSync";

vi.mock("convex/react", () => ({
  useAction: vi.fn(),
  useQuery: vi.fn(),
}));

const mockUseAction = vi.mocked(useAction);
const mockUseQuery = vi.mocked(useQuery);

const identity = {
  userEmail: "jenny.xu@fenchem.com",
  conversationId: "conv-1",
  internetMessageId: "<x@bayerpharma.de>",
};

type MockAction = ReturnType<typeof vi.fn>;

function installActions(
  syncAction: MockAction = vi.fn(async (_args: unknown) => ({
    status: "pending" as const,
    recordId: null,
    detailUrl: null,
  })),
) {
  const correctAction = vi.fn(async () => ({ recordId: "rec_correct", detailUrl: null }));
  let actionIndex = 0;
  mockUseAction.mockImplementation(() => {
    const action = actionIndex % 2 === 0 ? syncAction : correctAction;
    actionIndex += 1;
    return action as unknown as ReturnType<typeof useAction>;
  });
  return { syncAction, correctAction };
}

describe("useRequestSync", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    installActions();
  });

  it("returns the cached synced row while the Convex lookup is still loading", () => {
    rememberRequestSyncSnapshot(identity, {
      recordId: "rec_cached",
      detailUrl: "https://feishu.cn/base/rec_cached",
      coworkerCount: 1,
      syncedAt: Date.now() - 60_000,
    });
    mockUseQuery.mockReturnValue(undefined);

    const { result } = renderHook(() => useRequestSync(identity));

    expect(result.current.existingSync).toMatchObject({
      status: "synced",
      recordId: "rec_cached",
      detailUrl: "https://feishu.cn/base/rec_cached",
    });
  });

  it("returns the cached synced row when only the internetMessageId matches", () => {
    rememberRequestSyncSnapshot(identity, {
      recordId: "rec_cached",
      detailUrl: "https://feishu.cn/base/rec_cached",
    });
    mockUseQuery.mockReturnValue(undefined);

    const { result } = renderHook(() =>
      useRequestSync({
        ...identity,
        conversationId: "conv-reopened",
      }),
    );

    expect(result.current.existingSync).toMatchObject({
      status: "synced",
      recordId: "rec_cached",
      detailUrl: "https://feishu.cn/base/rec_cached",
    });
  });

  it("clears the cached row when the authoritative Convex lookup returns null", async () => {
    rememberRequestSyncSnapshot(identity, { recordId: "rec_cached", detailUrl: null });
    mockUseQuery.mockReturnValue(null);

    const { result } = renderHook(() => useRequestSync(identity));

    expect(result.current.existingSync).toBeNull();
    await waitFor(() => {
      expect(readRequestSyncSnapshot(identity)).toBeNull();
    });
  });

  it("stores an authoritative synced lookup for instant reopen", async () => {
    mockUseQuery.mockReturnValue({
      status: "synced",
      recordId: "rec_authoritative",
      detailUrl: "https://feishu.cn/base/rec_authoritative",
      coworkerCount: 1,
      syncedAt: Date.now(),
      error: null,
    });

    renderHook(() => useRequestSync(identity));

    await waitFor(() => {
      expect(readRequestSyncSnapshot(identity)).toMatchObject({
        status: "synced",
        recordId: "rec_authoritative",
      });
    });
  });

  it("stores a synced action result under the submitted Outlook identity", async () => {
    const { syncAction } = installActions(
      vi.fn(async () => ({
        status: "synced" as const,
        recordId: "rec_action",
        detailUrl: "https://feishu.cn/base/rec_action",
      })),
    );
    mockUseQuery.mockReturnValue(null);
    const { result } = renderHook(() => useRequestSync(identity));

    await act(async () => {
      await result.current.sync({
        ...identity,
      } as Parameters<typeof result.current.sync>[0]);
    });

    expect(syncAction).toHaveBeenCalledWith(identity);
    expect(readRequestSyncSnapshot(identity)).toMatchObject({
      status: "synced",
      recordId: "rec_action",
      detailUrl: "https://feishu.cn/base/rec_action",
    });
    expect(
      readRequestSyncSnapshot({
        ...identity,
        conversationId: "conv-reopened",
      }),
    ).toMatchObject({
      status: "synced",
      recordId: "rec_action",
    });
  });
});
