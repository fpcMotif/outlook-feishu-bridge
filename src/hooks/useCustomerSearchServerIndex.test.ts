import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCustomerSearchServerIndex } from "./useCustomerSearchServerIndex";

import * as convexReact from "convex/react";

vi.mock("convex/react", () => ({
  useAction: vi.fn(),
  useConvex: vi.fn(),
}));

const mockUseAction = vi.mocked(convexReact.useAction);
const mockUseConvex = vi.mocked(convexReact.useConvex);

describe("useCustomerSearchServerIndex", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    mockUseConvex.mockReturnValue({ query: vi.fn() } as never);
  });

  it("throttles repeated mirror refresh kicks from rapid picker opens", () => {
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchAndCacheMiss = vi.fn();
    mockUseAction.mockReturnValueOnce(kick).mockReturnValueOnce(searchAndCacheMiss);

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    act(() => {
      result.current.triggerRefresh();
      result.current.triggerRefresh();
    });

    expect(kick).toHaveBeenCalledTimes(1);
  });
});
