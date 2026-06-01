import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCustomerSearchPreload } from "./useCustomerSearchPreload";
import { useCustomerDirectory } from "./useCustomerDirectory";

import * as convexReact from "convex/react";

vi.mock("convex/react", () => ({
  useAction: vi.fn(),
}));

vi.mock("./useCustomerDirectory", () => ({
  useCustomerDirectory: vi.fn(),
}));

const mockUseAction = vi.mocked(convexReact.useAction);
const mockUseCustomerDirectory = vi.mocked(useCustomerDirectory);

describe("useCustomerSearchPreload", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUseCustomerDirectory.mockReturnValue({
      state: { status: "ready", records: [] },
      refresh: vi.fn(),
    });
  });

  it("skips the legacy server action for one-character queries", async () => {
    const legacyAction = vi.fn(async () => ({
      records: [{ recordId: "rec_acme", name: "Acme", owner: null }],
    }));
    mockUseAction.mockReturnValue(legacyAction);

    const { result } = renderHook(() => useCustomerSearchPreload(true));

    await expect(result.current.search(" a ")).resolves.toEqual([]);

    expect(legacyAction).not.toHaveBeenCalled();
  });

  it("coalesces duplicate in-flight legacy server searches", async () => {
    let resolveAction!: (value: { records: { recordId: string; name: string; owner: null }[] }) => void;
    const pendingAction = new Promise<{ records: { recordId: string; name: string; owner: null }[] }>(
      (resolve) => {
        resolveAction = resolve;
      },
    );
    const legacyAction = vi.fn(() => pendingAction);
    mockUseAction.mockReturnValue(legacyAction);

    const { result } = renderHook(() => useCustomerSearchPreload(true));

    const p1 = result.current.search("acme");
    const p2 = result.current.search(" acme ");

    expect(legacyAction).toHaveBeenCalledTimes(1);

    resolveAction({ records: [{ recordId: "rec_acme", name: "Acme", owner: null }] });

    await expect(Promise.all([p1, p2])).resolves.toEqual([
      [{ recordId: "rec_acme", name: "Acme", owner: null }],
      [{ recordId: "rec_acme", name: "Acme", owner: null }],
    ]);
  });

  it("shares one in-flight legacy search across owner filters", async () => {
    let resolveAction!: (value: {
      records: { recordId: string; name: string; owner: { openId: string; name: string } | null }[];
    }) => void;
    const pendingAction = new Promise<{
      records: { recordId: string; name: string; owner: { openId: string; name: string } | null }[];
    }>((resolve) => {
      resolveAction = resolve;
    });
    const legacyAction = vi.fn(() => pendingAction);
    mockUseAction.mockReturnValue(legacyAction);

    const { result } = renderHook(() => useCustomerSearchPreload(true));

    const all = result.current.search("acme");
    const mine = result.current.search("acme", { mineFor: "ou_me" });

    expect(legacyAction).toHaveBeenCalledTimes(1);

    resolveAction({
      records: [
        { recordId: "rec_mine", name: "Mine", owner: { openId: "ou_me", name: "Me" } },
        { recordId: "rec_other", name: "Other", owner: { openId: "ou_other", name: "Other" } },
      ],
    });

    await expect(Promise.all([all, mine])).resolves.toEqual([
      [
        { recordId: "rec_mine", name: "Mine", owner: { openId: "ou_me", name: "Me" } },
        { recordId: "rec_other", name: "Other", owner: { openId: "ou_other", name: "Other" } },
      ],
      [{ recordId: "rec_mine", name: "Mine", owner: { openId: "ou_me", name: "Me" } }],
    ]);
  });

  it("still uses the legacy server action once the query is specific", async () => {
    const legacyAction = vi.fn(async () => ({
      records: [{ recordId: "rec_acme", name: "Acme", owner: null }],
    }));
    mockUseAction.mockReturnValue(legacyAction);

    const { result } = renderHook(() => useCustomerSearchPreload(true));

    await expect(result.current.search("ac")).resolves.toEqual([
      { recordId: "rec_acme", name: "Acme", owner: null },
    ]);

    expect(legacyAction).toHaveBeenCalledWith({ query: "ac" });
  });
});
