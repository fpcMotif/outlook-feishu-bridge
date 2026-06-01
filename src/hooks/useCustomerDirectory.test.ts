import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetCustomerDirectory, useCustomerDirectory } from "./useCustomerDirectory";

import * as convexReact from "convex/react";

vi.mock("convex/react", () => ({
  useAction: vi.fn(),
}));

const mockUseAction = vi.mocked(convexReact.useAction);

describe("useCustomerDirectory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetCustomerDirectory();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  });

  it("throttles repeated manual refreshes after the directory is ready", async () => {
    const listCustomers = vi.fn(async () => ({ records: [] }));
    mockUseAction.mockReturnValue(listCustomers);

    const { result } = renderHook(() => useCustomerDirectory(true));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(listCustomers).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refresh();
      result.current.refresh();
    });

    await waitFor(() => expect(listCustomers).toHaveBeenCalledTimes(2));

    act(() => {
      result.current.refresh();
    });

    await Promise.resolve();

    expect(listCustomers).toHaveBeenCalledTimes(2);
  });
});
