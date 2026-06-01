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
